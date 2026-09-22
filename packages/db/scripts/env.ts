import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from 'dotenv';

/**
 * Load the monorepo's single root `.env`, wherever the script was invoked from.
 * One env file for the whole workspace: a per-package copy is one more thing to
 * keep in sync and one more way for the API and the migrator to disagree about
 * which database they are talking to.
 */
export function loadEnv(): void {
  let dir = process.cwd();
  for (;;) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      config({ path: candidate });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // No .env: fall back to the process environment, which is how CI runs.
  config();
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function migrationUrl(): string {
  return (
    process.env.DATABASE_MIGRATION_URL ?? 'postgres://eyesonbug:eyesonbug@localhost:5432/eyesonbug'
  );
}

export function appUrl(): string {
  return (
    process.env.DATABASE_URL ?? 'postgres://eyesonbug_app:eyesonbug_app@localhost:5432/eyesonbug'
  );
}
