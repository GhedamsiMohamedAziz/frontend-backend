import { resolveConfig } from './config';
import { upload } from './upload';

const HELP = `
eyesonbug — send acceptance test results to EyesOnBug

Usage:
  eyesonbug upload [options]

Options:
  --report <path>       Test report to upload (default: playwright-report.json)
  --url <url>           EyesOnBug API URL (env: EYESONBUG_URL)
  --token <token>       Project ingest token (env: EYESONBUG_TOKEN)
  --root <path>         Repository root, for repo-relative test paths (default: git root)
  --branch <name>       Override the detected branch
  --commit <sha>        Override the detected commit
  --build <version>     Build or version label
  --environment <name>  Environment the tests ran against (e.g. staging)
  --trigger <kind>      manual | schedule | push | pull_request | api
  --idempotency-key <k> Override the retry key (default: derived from the CI run)
  --no-wait             Return as soon as the upload is accepted
  --timeout <ms>        How long to wait for processing (default: 60000)
  -h, --help            Show this help

Most options are detected from the environment. In GitHub Actions, setting
EYESONBUG_TOKEN is usually the only thing required.
`.trim();

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === '-h' || command === '--help' || command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  if (command !== 'upload') {
    process.stderr.write(`Unknown command "${command}".\n\n${HELP}\n`);
    process.exitCode = 1;
    return;
  }

  const flags = parseFlags(rest);
  if (flags.help || flags.h) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  const config = resolveConfig(flags);
  const result = await upload(config, (message) => process.stdout.write(`  ${message}\n`));

  process.stdout.write(`\n  ${result.url}\n\n`);

  // Uploading results is reporting, not gatekeeping. A failed *run* must not
  // fail the upload step, or a red suite would look like a broken pipeline and
  // the quality gate (M3) would have nothing to report on.
}

main().catch((error: unknown) => {
  process.stderr.write(`\neyesonbug: ${(error as Error).message}\n\n`);
  process.exitCode = 1;
});
