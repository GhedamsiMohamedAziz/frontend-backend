import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import {
  buildErrorSignature,
  configurationFingerprint,
  hashApiToken,
  testCaseFingerprint,
} from '@eyesonbug/shared/node';
import type { ResultStatus, RunStatus } from '@eyesonbug/shared';
import * as schema from '../src/schema/index';
import { loadEnv, migrationUrl } from './env';
import { ERROR_CATALOG, PROJECTS, BRANCHES, COMMIT_MESSAGES, TEAMS } from './seed-data';
import type { ErrorKey, TestSpec } from './seed-data';

loadEnv();

/**
 * Deterministic demo data.
 *
 * Seeded from a fixed constant so every developer, and CI, sees the same
 * world — the same test flakes, the same feature regressed on the same day.
 * A demo dataset you cannot talk about ("is your run 12 my run 12?") is much
 * less useful than one you can.
 */
const rng = mulberry32(0x0eb0_0b5e);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
const jitter = (base: number, spread = 0.25): number =>
  Math.max(1, Math.round(base * (1 - spread + rng() * spread * 2)));

const DAY_MS = 86_400_000;
const NOW = new Date();
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);

/** The day the seeded regression landed, so "new failures" has an answer. */
const REGRESSION_DAY = 8;

const pool = new Pool({ connectionString: migrationUrl(), max: 4 });
const db = drizzle(pool, { schema, casing: 'snake_case' });

type Db = typeof db;

async function main(): Promise<void> {
  const started = Date.now();
  console.log('▸ resetting seeded data');
  await truncateAll();

  console.log('▸ organizations, users, teams');
  const acme = await seedOrganization('acme-retail', 'Acme Retail');
  const northwind = await seedOrganization('northwind', 'Northwind Traders');

  const summary = { runs: 0, results: 0, testCases: 0, signatures: 0, triaged: 0 };

  for (const spec of PROJECTS) {
    const counts = await seedProject(acme, spec);
    summary.runs += counts.runs;
    summary.results += counts.results;
    summary.testCases += counts.testCases;
    summary.signatures += counts.signatures;
    summary.triaged += counts.triaged;
  }

  // A second tenant with its own data. It exists so cross-tenant isolation is
  // something you can *see* in the UI and assert in a test, rather than a
  // property nobody exercises until it is violated in production.
  const northwindCounts = await seedProject(northwind, {
    ...PROJECTS[0]!,
    slug: 'northwind-shop',
    name: 'Northwind Shop E2E',
    repo: 'northwind/shop',
    runCount: 6,
  });
  summary.runs += northwindCounts.runs;
  summary.results += northwindCounts.results;

  console.log('');
  console.log('✓ seed complete in %dms', Date.now() - started);
  console.table(summary);
  console.log('');
  console.log('  Sign in at http://localhost:3000 as one of:');
  console.log('    demo@eyesonbug.dev     org owner, admin everywhere');
  console.log('    qa@eyesonbug.dev       QA on every Acme project');
  console.log('    viewer@eyesonbug.dev   read-only');
  console.log('    outsider@northwind.dev Northwind only — sees none of Acme');
  console.log('');
  console.log('  Ingest token (Storefront): eob_seed_storefront_devtoken');
  console.log('');
  console.log('  Note: attachment rows reference object keys that do not exist in');
  console.log('  MinIO yet. Real artifacts arrive with the reporter in M1.');

  await pool.end();
}

async function truncateAll(): Promise<void> {
  // Partitions are truncated through their parent, so exclude them or the
  // statement names the same physical table twice.
  const { rows } = await pool.query<{ list: string | null }>(`
    SELECT string_agg(format('%I.%I', schemaname, tablename), ', ') AS list
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN (SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid)
  `);
  const list = rows[0]?.list;
  if (list) await pool.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

interface Org {
  id: string;
  slug: string;
  teamIds: Record<string, string>;
  userIds: Record<string, string>;
}

async function seedOrganization(slug: string, name: string): Promise<Org> {
  const [org] = await db
    .insert(schema.organizations)
    .values({ slug, name, plan: 'pro' })
    .returning({ id: schema.organizations.id });
  const organizationId = org!.id;

  const isAcme = slug === 'acme-retail';
  const people = isAcme
    ? [
        {
          email: 'demo@eyesonbug.dev',
          name: 'Demo Owner',
          login: 'demo-owner',
          role: 'owner' as const,
        },
        {
          email: 'qa@eyesonbug.dev',
          name: 'Quinn Alvarez',
          login: 'quinn-qa',
          role: 'member' as const,
        },
        {
          email: 'dev@eyesonbug.dev',
          name: 'Dev Okafor',
          login: 'dev-okafor',
          role: 'member' as const,
        },
        {
          email: 'viewer@eyesonbug.dev',
          name: 'Pat Moreau',
          login: 'pat-pm',
          role: 'member' as const,
        },
      ]
    : [
        {
          email: 'outsider@northwind.dev',
          name: 'Nora Bright',
          login: 'nora-nw',
          role: 'owner' as const,
        },
      ];

  const userIds: Record<string, string> = {};
  for (const person of people) {
    const [user] = await db
      .insert(schema.users)
      .values({
        email: person.email,
        name: person.name,
        githubLogin: person.login,
        githubUserId: Math.floor(rng() * 9_000_000) + 1_000_000,
        avatarUrl: `https://avatars.githubusercontent.com/u/${Math.floor(rng() * 999999)}?v=4`,
        locale: person.email.includes('viewer') ? 'fr' : 'en',
      })
      .returning({ id: schema.users.id });
    userIds[person.email] = user!.id;
    await db
      .insert(schema.orgMemberships)
      .values({ organizationId, userId: user!.id, role: person.role });
  }

  const teamIds: Record<string, string> = {};
  for (const team of TEAMS) {
    const [row] = await db
      .insert(schema.teams)
      .values({
        organizationId,
        slug: team,
        name: team.charAt(0).toUpperCase() + team.slice(1),
      })
      .returning({ id: schema.teams.id });
    teamIds[team] = row!.id;
  }

  return { id: organizationId, slug, teamIds, userIds };
}

interface ProjectCounts {
  runs: number;
  results: number;
  testCases: number;
  signatures: number;
  triaged: number;
}

async function seedProject(org: Org, spec: (typeof PROJECTS)[number]): Promise<ProjectCounts> {
  console.log(`▸ project ${org.slug}/${spec.slug}`);

  const [projectRow] = await db
    .insert(schema.projects)
    .values({
      organizationId: org.id,
      slug: spec.slug,
      name: spec.name,
      repoFullName: spec.repo,
      defaultBranch: 'main',
    })
    .returning({ id: schema.projects.id });
  const projectId = projectRow!.id;

  await seedProjectMembers(org, projectId);

  const [staging] = await db
    .insert(schema.environments)
    .values([
      {
        organizationId: org.id,
        projectId,
        name: 'staging',
        baseUrl: 'https://staging.example.com',
      },
      {
        organizationId: org.id,
        projectId,
        name: 'production',
        baseUrl: 'https://www.example.com',
        isProduction: true,
      },
    ])
    .returning({ id: schema.environments.id });

  await db.insert(schema.apiTokens).values({
    organizationId: org.id,
    projectId,
    name: 'CI (seeded)',
    tokenHash: hashApiToken(`eob_seed_${spec.slug}_devtoken`),
    tokenPrefix: `eob_seed`,
    scopes: ['ingest:write'],
    createdByUserId: Object.values(org.userIds)[0]!,
  });

  await db.insert(schema.retentionPolicies).values([
    { organizationId: org.id, projectId, artifactKind: 'video', keepDays: 30 },
    { organizationId: org.id, projectId, artifactKind: 'trace', keepDays: 30 },
    { organizationId: org.id, projectId, artifactKind: 'screenshot', keepDays: 90 },
    { organizationId: org.id, projectId, artifactKind: 'log', keepDays: 365 },
    { organizationId: org.id, projectId, artifactKind: 'har', keepDays: 30 },
  ]);

  // ─── Taxonomy ───────────────────────────────────────────────────────────
  const featureIds: Record<string, string> = {};
  for (const feature of spec.features) {
    const [row] = await db
      .insert(schema.features)
      .values({
        organizationId: org.id,
        projectId,
        key: feature.key,
        name: feature.name,
        source: 'gherkin',
        ownerTeamId: org.teamIds[feature.team] ?? null,
      })
      .returning({ id: schema.features.id });
    featureIds[feature.key] = row!.id;
  }

  const tagNames = [...new Set(spec.tests.flatMap((t) => t.tags ?? []))];
  const tagIds: Record<string, string> = {};
  for (const name of tagNames) {
    const [row] = await db
      .insert(schema.tags)
      .values({ organizationId: org.id, projectId, name })
      .returning({ id: schema.tags.id });
    tagIds[name] = row!.id;
  }

  const suiteNames = [...new Set(spec.tests.map((t) => t.file))];
  const suiteIds: Record<string, string> = {};
  for (const path of suiteNames) {
    const [row] = await db
      .insert(schema.suites)
      .values({ organizationId: org.id, projectId, name: path, path })
      .returning({ id: schema.suites.id });
    suiteIds[path] = row!.id;
  }

  interface SeededTest {
    id: string;
    spec: TestSpec;
  }

  const tests: SeededTest[] = [];
  for (const test of spec.tests) {
    const fullTitle = `${test.feature} > ${test.title}`;
    const fingerprint = testCaseFingerprint({
      projectId,
      filePath: test.file,
      fullTitle,
      params: test.params ?? {},
    });
    const feature = spec.features.find((f) => f.key === test.feature)!;
    const [row] = await db
      .insert(schema.testCases)
      .values({
        organizationId: org.id,
        projectId,
        fingerprint,
        suiteId: suiteIds[test.file]!,
        featureId: featureIds[test.feature]!,
        filePath: test.file,
        title: test.title,
        fullTitle,
        params: test.params ?? {},
        ownerTeamId: org.teamIds[feature.team] ?? null,
        firstSeenAt: daysAgo(90),
        lastSeenAt: NOW,
        // One quarantined test, so the UI has a real example of the state.
        quarantinedAt:
          test.profile === 'broken' && test.title.includes('Apple Pay') ? daysAgo(4) : null,
        quarantineReason:
          test.profile === 'broken' && test.title.includes('Apple Pay')
            ? 'Apple Pay sandbox unavailable in CI — tracked in ACME-4417'
            : null,
      })
      .returning({ id: schema.testCases.id });
    tests.push({ id: row!.id, spec: test });

    for (const tag of test.tags ?? []) {
      await db
        .insert(schema.testCaseTags)
        .values({ organizationId: org.id, testCaseId: row!.id, tagId: tagIds[tag]! });
    }
  }

  // ─── Configuration matrix ───────────────────────────────────────────────
  interface SeededConfig {
    id: string;
    browser: string;
    locale: string;
  }
  const configs: SeededConfig[] = [];
  for (const browser of spec.browsers) {
    for (const locale of spec.locales) {
      const cell = {
        browser,
        os: 'linux',
        osVersion: 'ubuntu-24.04',
        locale,
        viewport: '1280x720',
      };
      const [row] = await db
        .insert(schema.configurations)
        .values({
          organizationId: org.id,
          projectId,
          fingerprint: configurationFingerprint(projectId, cell),
          browser,
          browserVersion:
            browser === 'chromium' ? '131.0' : browser === 'firefox' ? '133.0' : '18.2',
          os: 'linux',
          osVersion: 'ubuntu-24.04',
          viewport: '1280x720',
          locale,
          dimensions: {},
          firstSeenAt: daysAgo(90),
        })
        .returning({ id: schema.configurations.id });
      configs.push({ id: row!.id, browser, locale });
    }
  }

  // ─── Runs ───────────────────────────────────────────────────────────────
  const signatureIds = new Map<string, string>();
  const counts: ProjectCounts = {
    runs: 0,
    results: 0,
    testCases: tests.length,
    signatures: 0,
    triaged: 0,
  };

  interface ResultFact {
    testCaseId: string;
    configId: string;
    status: ResultStatus;
    durationMs: number;
    startedAt: Date;
    featureId: string;
  }
  const facts: ResultFact[] = [];

  for (let i = 0; i < spec.runCount; i += 1) {
    const ageDays = ((spec.runCount - i) * 30) / spec.runCount;
    const startedAt = daysAgo(ageDays);
    const branch = pick(BRANCHES);
    const runNumber = i + 1;

    const resultRows: (typeof schema.testResults.$inferInsert)[] = [];
    const stepRows: (typeof schema.steps.$inferInsert)[] = [];
    const attachmentRows: (typeof schema.attachments.$inferInsert)[] = [];
    const totals = { total: 0, passed: 0, failed: 0, skipped: 0, broken: 0, flaky: 0, running: 0 };

    const [runRow] = await db
      .insert(schema.runs)
      .values({
        organizationId: org.id,
        projectId,
        number: runNumber,
        status: 'running',
        trigger: i === spec.runCount - 1 ? 'manual' : pick(['push', 'schedule', 'pull_request']),
        branch,
        commitSha: randomUUID().replace(/-/g, '').slice(0, 40),
        commitMessage: pick(COMMIT_MESSAGES),
        commitAuthor: pick(['Quinn Alvarez', 'Dev Okafor', 'Sam Iyer']),
        buildVersion: `2026.09.${runNumber}`,
        environmentId: staging!.id,
        githubWorkflowRunId: 12_000_000_000 + runNumber,
        githubWorkflowName: 'E2E',
        triggeredByUserId: org.userIds['qa@eyesonbug.dev'] ?? Object.values(org.userIds)[0]!,
        queuedAt: new Date(startedAt.getTime() - 40_000),
        startedAt,
      })
      .returning({ id: schema.runs.id });
    const runId = runRow!.id;

    // Shard the matrix across the configurations this run exercised. Older
    // runs cover fewer cells, which is what makes matrix-coverage gaps real.
    const activeConfigs = i < 3 ? configs.slice(0, Math.max(1, configs.length - 3)) : configs;

    for (const [shardIndex, config] of activeConfigs.entries()) {
      const [rcRow] = await db
        .insert(schema.runConfigurations)
        .values({
          organizationId: org.id,
          projectId,
          runId,
          configurationId: config.id,
          status: 'running',
          shardIndex,
          shardTotal: activeConfigs.length,
          githubJobId: 40_000_000_000 + runNumber * 100 + shardIndex,
          startedAt,
        })
        .returning({ id: schema.runConfigurations.id });
      const runConfigurationId = rcRow!.id;

      for (const test of tests) {
        const outcome = decideOutcome(test.spec, ageDays, config.locale);
        const resultStartedAt = new Date(startedAt.getTime() + Math.floor(rng() * 240_000));

        for (const attempt of outcome.attempts) {
          const resultId = randomUUID();
          const signature = attempt.errorKey
            ? await ensureSignature(
                org.id,
                projectId,
                attempt.errorKey,
                signatureIds,
                resultStartedAt,
              )
            : null;

          resultRows.push({
            id: resultId,
            organizationId: org.id,
            projectId,
            runId,
            runConfigurationId,
            testCaseId: test.id,
            status: attempt.status,
            retryIndex: attempt.retryIndex,
            isFinalAttempt: attempt.isFinal,
            durationMs: attempt.durationMs,
            startedAt: resultStartedAt,
            finishedAt: new Date(resultStartedAt.getTime() + attempt.durationMs),
            errorType: attempt.errorKey ? ERROR_CATALOG[attempt.errorKey].type : null,
            errorMessage: attempt.errorKey ? ERROR_CATALOG[attempt.errorKey].message : null,
            stackTrace: attempt.errorKey ? ERROR_CATALOG[attempt.errorKey].stack : null,
            normalizedStack: signature?.normalizedStackHead ?? null,
            errorSignatureId: signature?.id ?? null,
            wasQuarantined: test.spec.title.includes('Apple Pay'),
            workerId: `worker-${shardIndex}`,
          });

          if (attempt.isFinal) {
            totals.total += 1;
            if (attempt.status === 'passed') totals.passed += 1;
            else if (attempt.status === 'failed') totals.failed += 1;
            else if (attempt.status === 'skipped') totals.skipped += 1;
            else if (attempt.status === 'broken') totals.broken += 1;
            else if (attempt.status === 'flaky') totals.flaky += 1;

            facts.push({
              testCaseId: test.id,
              configId: config.id,
              status: attempt.status,
              durationMs: attempt.durationMs,
              startedAt: resultStartedAt,
              featureId: featureIds[test.spec.feature]!,
            });
          }

          // Steps and artifacts only where someone would actually look: the
          // failures, and everything in the most recent run.
          const detailed = attempt.status !== 'passed' || i === spec.runCount - 1;
          if (detailed && attempt.status !== 'skipped') {
            stepRows.push(
              ...buildSteps(org.id, projectId, resultId, attempt.status, resultStartedAt),
            );
          }
          if (attempt.status === 'failed' || attempt.status === 'broken') {
            attachmentRows.push(...buildAttachments(org.id, projectId, resultId, resultStartedAt));
          }
        }
      }

      await db
        .update(schema.runConfigurations)
        .set({
          status: 'passed',
          finishedAt: new Date(startedAt.getTime() + 600_000),
        })
        .where(sql`${schema.runConfigurations.id} = ${runConfigurationId}`);
    }

    await insertChunked(db, schema.testResults, resultRows);
    await insertChunked(db, schema.steps, stepRows);
    await insertChunked(db, schema.attachments, attachmentRows);

    const status: RunStatus =
      totals.failed + totals.broken > 0 ? 'failed' : totals.total === 0 ? 'errored' : 'passed';
    const durationMs = 480_000 + Math.floor(rng() * 420_000);

    await db
      .update(schema.runs)
      .set({
        status,
        totals,
        finishedAt: new Date(startedAt.getTime() + durationMs),
        durationMs,
      })
      .where(sql`${schema.runs.id} = ${runId}`);

    counts.runs += 1;
    counts.results += resultRows.length;
  }

  await db
    .update(schema.projects)
    .set({ runCounter: spec.runCount })
    .where(sql`${schema.projects.id} = ${projectId}`);

  counts.signatures = signatureIds.size;
  counts.triaged = await seedTriage(org, projectId, signatureIds);
  await seedRollups(org.id, projectId, facts);
  await seedSavedViews(org, projectId);

  return counts;
}

async function seedProjectMembers(org: Org, projectId: string): Promise<void> {
  const roles: Array<[string, 'admin' | 'maintainer' | 'qa' | 'viewer']> = [
    ['qa@eyesonbug.dev', 'qa'],
    ['dev@eyesonbug.dev', 'maintainer'],
    ['viewer@eyesonbug.dev', 'viewer'],
  ];
  for (const [email, role] of roles) {
    const userId = org.userIds[email];
    if (!userId) continue;
    await db
      .insert(schema.projectMemberships)
      .values({ organizationId: org.id, projectId, userId, role });
  }
}

interface Attempt {
  status: ResultStatus;
  durationMs: number;
  retryIndex: number;
  isFinal: boolean;
  errorKey: ErrorKey | null;
}

/**
 * Turn a test's profile into concrete attempts for one run.
 *
 * Retries produce two rows rather than one mutated row: the record of a retry
 * *is* the flakiness evidence, and collapsing it would make the signal
 * unreconstructable later.
 */
function decideOutcome(spec: TestSpec, ageDays: number, locale: string): { attempts: Attempt[] } {
  const errorKey = errorFor(spec);
  const duration = () => jitter(spec.baseDurationMs);

  switch (spec.profile) {
    case 'skipped':
      return {
        attempts: [
          { status: 'skipped', durationMs: 0, retryIndex: 0, isFinal: true, errorKey: null },
        ],
      };

    case 'broken':
      return {
        attempts: [
          { status: 'broken', durationMs: duration(), retryIndex: 0, isFinal: true, errorKey },
        ],
      };

    case 'regressed': {
      // Green until the regression landed, red since. This is what makes
      // "new failures since last run" and run comparison meaningful.
      const failing = ageDays < REGRESSION_DAY;
      // The de-DE search regression is locale-specific, so the matrix heatmap
      // shows a stripe rather than a solid block.
      const localeScoped = spec.params?.['query'] === 'schuhe';
      if (failing && (!localeScoped || locale === 'de-DE')) {
        return {
          attempts: [
            { status: 'failed', durationMs: duration(), retryIndex: 0, isFinal: true, errorKey },
          ],
        };
      }
      return {
        attempts: [
          {
            status: 'passed',
            durationMs: duration(),
            retryIndex: 0,
            isFinal: true,
            errorKey: null,
          },
        ],
      };
    }

    case 'flaky': {
      if (rng() < 0.22) {
        const first = duration();
        return {
          attempts: [
            { status: 'failed', durationMs: first, retryIndex: 0, isFinal: false, errorKey },
            {
              status: 'flaky',
              durationMs: duration(),
              retryIndex: 1,
              isFinal: true,
              errorKey: null,
            },
          ],
        };
      }
      return {
        attempts: [
          {
            status: 'passed',
            durationMs: duration(),
            retryIndex: 0,
            isFinal: true,
            errorKey: null,
          },
        ],
      };
    }

    case 'slow': {
      // Duration creeps up over the window, so the regression report has one.
      const growth = 1 + (30 - ageDays) * 0.02;
      return {
        attempts: [
          {
            status: 'passed',
            durationMs: jitter(Math.round(spec.baseDurationMs * growth), 0.12),
            retryIndex: 0,
            isFinal: true,
            errorKey: null,
          },
        ],
      };
    }

    case 'stable':
    default: {
      if (rng() < 0.015) {
        return {
          attempts: [
            { status: 'failed', durationMs: duration(), retryIndex: 0, isFinal: true, errorKey },
          ],
        };
      }
      return {
        attempts: [
          {
            status: 'passed',
            durationMs: duration(),
            retryIndex: 0,
            isFinal: true,
            errorKey: null,
          },
        ],
      };
    }
  }
}

/**
 * Errors are assigned by feature, not at random, so distinct tests that fail
 * for the same reason share a signature. That is the whole point of clustering:
 * "9 tests failed with the same timeout on /checkout" must be one decision.
 */
function errorFor(spec: TestSpec): ErrorKey {
  if (spec.title.includes('localized prices')) return 'priceMismatch';
  if (spec.profile === 'flaky') return 'flakyToast';
  if (spec.feature.startsWith('checkout') || spec.feature === 'payments') return 'checkoutTimeout';
  if (spec.feature === 'cart' || spec.feature === 'orders') return 'staleSession';
  if (spec.feature === 'search') return 'searchEmpty';
  return 'flakyToast';
}

async function ensureSignature(
  organizationId: string,
  projectId: string,
  key: ErrorKey,
  cache: Map<string, string>,
  seenAt: Date,
): Promise<{ id: string; normalizedStackHead: string }> {
  const source = ERROR_CATALOG[key];
  const signature = buildErrorSignature(projectId, {
    errorType: source.type,
    message: source.message,
    stack: source.stack,
  });

  const cached = cache.get(signature.hash);
  if (cached) return { id: cached, normalizedStackHead: signature.normalizedStackHead };

  const [row] = await db
    .insert(schema.errorSignatures)
    .values({
      organizationId,
      projectId,
      hash: signature.hash,
      errorType: signature.errorType,
      normalizedMessage: signature.normalizedMessage,
      normalizedStackHead: signature.normalizedStackHead,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      occurrenceCount: 0,
    })
    .onConflictDoUpdate({
      target: [schema.errorSignatures.projectId, schema.errorSignatures.hash],
      set: { lastSeenAt: seenAt },
    })
    .returning({ id: schema.errorSignatures.id });

  cache.set(signature.hash, row!.id);
  return { id: row!.id, normalizedStackHead: signature.normalizedStackHead };
}

function buildSteps(
  organizationId: string,
  projectId: string,
  testResultId: string,
  status: ResultStatus,
  startedAt: Date,
): (typeof schema.steps.$inferInsert)[] {
  const plan: Array<['given' | 'when' | 'then', string]> = [
    ['given', 'the user is signed in'],
    ['when', 'the user opens the cart'],
    ['when', 'the user proceeds to checkout'],
    ['then', 'the order confirmation is shown'],
  ];
  const failAt = status === 'passed' || status === 'flaky' ? -1 : plan.length - 1;

  return plan.map(([keyword, title], index) => ({
    organizationId,
    projectId,
    testResultId,
    path: `s${index + 1}`,
    position: index,
    keyword,
    title,
    status: index === failAt ? 'failed' : index > failAt && failAt >= 0 ? 'skipped' : 'passed',
    durationMs: jitter(900),
    startedAt: new Date(startedAt.getTime() + index * 1200),
  }));
}

function buildAttachments(
  organizationId: string,
  projectId: string,
  testResultId: string,
  createdAt: Date,
): (typeof schema.attachments.$inferInsert)[] {
  const base = `${projectId}/${testResultId}`;
  return [
    {
      organizationId,
      projectId,
      testResultId,
      kind: 'screenshot' as const,
      s3Key: `${base}/failure.png`,
      contentType: 'image/png',
      sizeBytes: 148_320,
      sha256: 'a'.repeat(64),
      width: 1280,
      height: 720,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 90 * DAY_MS),
    },
    {
      organizationId,
      projectId,
      testResultId,
      kind: 'video' as const,
      s3Key: `${base}/video.webm`,
      contentType: 'video/webm',
      sizeBytes: 3_942_100,
      sha256: 'b'.repeat(64),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 30 * DAY_MS),
    },
    {
      organizationId,
      projectId,
      testResultId,
      kind: 'trace' as const,
      s3Key: `${base}/trace.zip`,
      contentType: 'application/zip',
      sizeBytes: 1_204_880,
      sha256: 'c'.repeat(64),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 30 * DAY_MS),
    },
  ];
}

/**
 * Triage decisions, each with its frozen context (ADR-009).
 *
 * Some clusters are deliberately left untriaged so the inbox is not empty on
 * first load, and one decision is superseded so the "decisions are appended,
 * never overwritten" property is visible in the data.
 */
async function seedTriage(
  org: Org,
  projectId: string,
  signatureIds: Map<string, string>,
): Promise<number> {
  const ids = [...signatureIds.values()];
  if (ids.length === 0) return 0;

  const triager = org.userIds['qa@eyesonbug.dev'] ?? Object.values(org.userIds)[0]!;
  const assignee = org.userIds['dev@eyesonbug.dev'] ?? triager;

  const [issue] = await db
    .insert(schema.knownIssues)
    .values({
      organizationId: org.id,
      projectId,
      title: 'Checkout submit button intermittently unresponsive on staging',
      tracker: 'github',
      externalKey: 'acme-retail/storefront#4417',
      externalUrl: 'https://github.com/acme-retail/storefront/issues/4417',
      status: 'open',
      createdByUserId: triager,
      createdAt: daysAgo(7),
    })
    .returning({ id: schema.knownIssues.id });

  const decisions: Array<{
    signatureId: string;
    category: 'product_bug' | 'test_bug' | 'environment' | 'flaky' | 'known_issue';
    comment: string;
    resolution?: 'fixed' | 'wont_fix';
    knownIssueId?: string;
    daysAgoTriaged: number;
  }> = [
    {
      signatureId: ids[0]!,
      category: 'product_bug',
      comment:
        'Reproduced manually on staging. The submit handler races the cart revalidation request.',
      knownIssueId: issue!.id,
      daysAgoTriaged: 6,
    },
    {
      signatureId: ids[1] ?? ids[0]!,
      category: 'test_bug',
      comment: 'The assertion hardcodes a full stop; fr-FR formats with a comma. Fix the test.',
      resolution: 'fixed',
      daysAgoTriaged: 5,
    },
    {
      signatureId: ids[2] ?? ids[0]!,
      category: 'environment',
      comment: 'Staging was redeployed mid-run and refused connections for ~4 minutes.',
      resolution: 'wont_fix',
      daysAgoTriaged: 3,
    },
  ];

  let count = 0;
  for (const decision of decisions) {
    const triagedAt = daysAgo(decision.daysAgoTriaged);
    const [row] = await db
      .insert(schema.triages)
      .values({
        organizationId: org.id,
        projectId,
        errorSignatureId: decision.signatureId,
        category: decision.category,
        assigneeUserId: assignee,
        comment: decision.comment,
        knownIssueId: decision.knownIssueId ?? null,
        source: 'human',
        confidence: null,
        triagedByUserId: triager,
        triagedAt,
        resolution: decision.resolution ?? null,
        resolvedAt: decision.resolution ? daysAgo(decision.daysAgoTriaged - 1) : null,
      })
      .returning({ id: schema.triages.id });

    // The labelled example. Written with the decision, never recomputed.
    await db.insert(schema.triageContexts).values({
      triageId: row!.id,
      organizationId: org.id,
      projectId,
      schemaVersion: 1,
      payload: {
        error: { type: 'TimeoutError', normalized_message: '<normalized at decision time>' },
        test: { fingerprint: '<frozen>', feature: 'checkout', owner_team: 'payments' },
        config: { browser: 'chromium', os: 'linux', locale: 'en-US', environment: 'staging' },
        run: { branch: 'main', trigger: 'push', build_version: '2026.09.21' },
        history: { last_30_statuses: 'PPPPPPPPPPPPPPPPPPPPPPFFFFFFFF', flakiness_score: 0.08 },
        cluster: { sibling_count: 9, features_affected: ['checkout'] },
        evidence: { log_tail: '<frozen>', screenshot_keys: ['<frozen>'] },
      },
      createdAt: triagedAt,
    });

    if (decision.knownIssueId) {
      await db.insert(schema.knownIssueSignatures).values({
        organizationId: org.id,
        knownIssueId: decision.knownIssueId,
        errorSignatureId: decision.signatureId,
      });
      await db
        .update(schema.errorSignatures)
        .set({ knownIssueId: decision.knownIssueId })
        .where(sql`${schema.errorSignatures.id} = ${decision.signatureId}`);
    }
    count += 1;
  }

  return count;
}

async function seedSavedViews(org: Org, projectId: string): Promise<void> {
  await db.insert(schema.savedViews).values([
    {
      organizationId: org.id,
      projectId,
      userId: null,
      name: 'Failing on main',
      scope: 'history',
      filters: { branch: ['main'], status: ['failed'] },
      isShared: true,
    },
    {
      organizationId: org.id,
      projectId,
      userId: null,
      name: 'French locale only',
      scope: 'history',
      filters: { locale: ['fr-FR'] },
      isShared: true,
    },
  ]);
}

/**
 * Rollups computed from the facts we just generated (ADR-010).
 *
 * The worker will own this incrementally from M4; doing it here means the
 * metrics screens have something true to render from day one, and it exercises
 * the rollup shape while the schema is still cheap to change.
 */
async function seedRollups(
  organizationId: string,
  projectId: string,
  facts: Array<{
    testCaseId: string;
    configId: string;
    status: ResultStatus;
    durationMs: number;
    startedAt: Date;
    featureId: string;
  }>,
): Promise<void> {
  const cutoff = daysAgo(14).getTime();

  const byTest = new Map<string, typeof facts>();
  for (const fact of facts) {
    if (fact.startedAt.getTime() < cutoff) continue;
    const bucket = byTest.get(fact.testCaseId) ?? [];
    bucket.push(fact);
    byTest.set(fact.testCaseId, bucket);
  }

  const statsRows: (typeof schema.testCaseStats.$inferInsert)[] = [];
  for (const [testCaseId, bucket] of byTest) {
    const durations = bucket.map((f) => f.durationMs).sort((a, b) => a - b);
    const passed = bucket.filter((f) => f.status === 'passed').length;
    const failed = bucket.filter((f) => f.status === 'failed' || f.status === 'broken').length;
    const skipped = bucket.filter((f) => f.status === 'skipped').length;
    const flaky = bucket.filter((f) => f.status === 'flaky').length;
    const scored = passed + failed + flaky;

    statsRows.push({
      testCaseId,
      window: '14d',
      organizationId,
      projectId,
      runs: bucket.length,
      passed,
      failed,
      skipped,
      flakyTransitions: flaky,
      flakinessScore: scored > 0 ? (flaky / scored).toFixed(4) : '0',
      p50DurationMs: percentile(durations, 0.5),
      p95DurationMs: percentile(durations, 0.95),
      lastFailureAt: lastWhen(bucket, (f) => f.status === 'failed' || f.status === 'broken'),
      lastPassedAt: lastWhen(bucket, (f) => f.status === 'passed'),
    });
  }
  await insertChunked(db, schema.testCaseStats, statsRows);

  // Daily totals, sliced by feature. The NULL-feature row is the "all" slice.
  const daily = new Map<string, typeof facts>();
  for (const fact of facts) {
    for (const featureKey of [fact.featureId, 'ALL']) {
      const day = fact.startedAt.toISOString().slice(0, 10);
      const key = `${day}|${featureKey}`;
      const bucket = daily.get(key) ?? [];
      bucket.push(fact);
      daily.set(key, bucket);
    }
  }

  const dailyRows: (typeof schema.dailyProjectMetrics.$inferInsert)[] = [];
  for (const [key, bucket] of daily) {
    const [day, featureKey] = key.split('|') as [string, string];
    const durations = bucket.map((f) => f.durationMs).sort((a, b) => a - b);
    dailyRows.push({
      organizationId,
      projectId,
      day,
      featureId: featureKey === 'ALL' ? null : featureKey,
      configurationId: null,
      environmentId: null,
      total: bucket.length,
      passed: bucket.filter((f) => f.status === 'passed').length,
      failed: bucket.filter((f) => f.status === 'failed' || f.status === 'broken').length,
      skipped: bucket.filter((f) => f.status === 'skipped').length,
      flaky: bucket.filter((f) => f.status === 'flaky').length,
      durationP50Ms: percentile(durations, 0.5),
      durationP95Ms: percentile(durations, 0.95),
    });
  }
  await insertChunked(db, schema.dailyProjectMetrics, dailyRows);

  // Matrix coverage: which feature × configuration cells have ever run.
  const coverage = new Map<string, { lastRunAt: Date; status: ResultStatus; count: number }>();
  for (const fact of facts) {
    const key = `${fact.featureId}|${fact.configId}`;
    const current = coverage.get(key);
    if (!current || fact.startedAt > current.lastRunAt) {
      coverage.set(key, {
        lastRunAt: fact.startedAt,
        status: fact.status,
        count: (current?.count ?? 0) + 1,
      });
    } else {
      current.count += 1;
    }
  }

  await insertChunked(
    db,
    schema.matrixCoverage,
    [...coverage].map(([key, value]) => {
      const [featureId, configurationId] = key.split('|') as [string, string];
      return {
        organizationId,
        projectId,
        featureId,
        configurationId,
        lastRunAt: value.lastRunAt,
        lastStatus: value.status,
        runCount: value.count,
      };
    }),
  );
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[index] ?? null;
}

function lastWhen<T extends { startedAt: Date }>(
  items: T[],
  predicate: (item: T) => boolean,
): Date | null {
  let latest: Date | null = null;
  for (const item of items) {
    if (predicate(item) && (!latest || item.startedAt > latest)) latest = item.startedAt;
  }
  return latest;
}

/** Postgres caps a statement at 65535 bind parameters, so wide rows chunk small. */
async function insertChunked<T extends Record<string, unknown>>(
  database: Db,
  table: Parameters<Db['insert']>[0],
  rows: T[],
  size = 500,
): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    if (chunk.length === 0) continue;
    await database.insert(table).values(chunk as never);
  }
}

main().catch((error: unknown) => {
  console.error('✗ seed failed');
  console.error(error);
  process.exit(1);
});
