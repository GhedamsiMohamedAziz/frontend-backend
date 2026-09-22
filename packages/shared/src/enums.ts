import { z } from 'zod';

/**
 * Domain vocabularies. Each is declared once as a const tuple so it can serve
 * three jobs at once: a Zod validator on the API boundary, a TypeScript union,
 * and an iterable the UI uses to build filter menus.
 */

export const ORG_ROLES = ['owner', 'admin', 'member'] as const;
export const orgRoleSchema = z.enum(ORG_ROLES);
export type OrgRole = z.infer<typeof orgRoleSchema>;

export const PROJECT_ROLES = ['admin', 'maintainer', 'qa', 'viewer'] as const;
export const projectRoleSchema = z.enum(PROJECT_ROLES);
export type ProjectRole = z.infer<typeof projectRoleSchema>;

/**
 * Project roles are strictly ordered, so a permission check is a comparison
 * rather than a set membership test. `admin` implies every lesser capability.
 */
export const PROJECT_ROLE_RANK: Readonly<Record<ProjectRole, number>> = {
  viewer: 0,
  qa: 1,
  maintainer: 2,
  admin: 3,
};

export const RUN_STATUSES = [
  'queued',
  'running',
  'passed',
  'failed',
  'cancelled',
  'errored',
] as const;
export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatusSchema>;

/** Statuses that mean the run is over and its totals are authoritative. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'passed',
  'failed',
  'cancelled',
  'errored',
];

export const RUN_TRIGGERS = ['manual', 'schedule', 'push', 'pull_request', 'api'] as const;
export const runTriggerSchema = z.enum(RUN_TRIGGERS);
export type RunTrigger = z.infer<typeof runTriggerSchema>;

/**
 * `running` is a real, stored state, not a UI nicety. Streaming ingestion sees
 * a test start and finish in separate batches, so the row has to exist between
 * the two — and once it exists, the live view can show what is executing now.
 */
export const RESULT_STATUSES = [
  'passed',
  'failed',
  'skipped',
  'broken',
  'flaky',
  'running',
] as const;
export const resultStatusSchema = z.enum(RESULT_STATUSES);
export type ResultStatus = z.infer<typeof resultStatusSchema>;

/** `skipped` is neither a success nor a failure; it is excluded from pass rate. */
export const FAILING_RESULT_STATUSES: readonly ResultStatus[] = ['failed', 'broken'];

export const STEP_STATUSES = ['passed', 'failed', 'skipped', 'broken'] as const;
export const stepStatusSchema = z.enum(STEP_STATUSES);
export type StepStatus = z.infer<typeof stepStatusSchema>;

export const STEP_KEYWORDS = ['given', 'when', 'then', 'and', 'but'] as const;
export const stepKeywordSchema = z.enum(STEP_KEYWORDS);
export type StepKeyword = z.infer<typeof stepKeywordSchema>;

export const ATTACHMENT_KINDS = ['screenshot', 'video', 'trace', 'log', 'har'] as const;
export const attachmentKindSchema = z.enum(ATTACHMENT_KINDS);
export type AttachmentKind = z.infer<typeof attachmentKindSchema>;

export const TRIAGE_CATEGORIES = [
  'product_bug',
  'test_bug',
  'environment',
  'flaky',
  'known_issue',
  'needs_investigation',
] as const;
export const triageCategorySchema = z.enum(TRIAGE_CATEGORIES);
export type TriageCategory = z.infer<typeof triageCategorySchema>;

export const TRIAGE_SOURCES = ['human', 'ai'] as const;
export const triageSourceSchema = z.enum(TRIAGE_SOURCES);
export type TriageSource = z.infer<typeof triageSourceSchema>;

export const TRIAGE_RESOLUTIONS = ['fixed', 'wont_fix', 'invalid', 'duplicate'] as const;
export const triageResolutionSchema = z.enum(TRIAGE_RESOLUTIONS);
export type TriageResolution = z.infer<typeof triageResolutionSchema>;

export const FEATURE_SOURCES = ['gherkin', 'annotation', 'path', 'manual'] as const;
export const featureSourceSchema = z.enum(FEATURE_SOURCES);
export type FeatureSource = z.infer<typeof featureSourceSchema>;

export const ISSUE_TRACKERS = ['github', 'jira'] as const;
export const issueTrackerSchema = z.enum(ISSUE_TRACKERS);
export type IssueTracker = z.infer<typeof issueTrackerSchema>;

export const RERUN_KINDS = ['failed', 'all'] as const;
export const rerunKindSchema = z.enum(RERUN_KINDS);
export type RerunKind = z.infer<typeof rerunKindSchema>;

export const NOTIFICATION_EVENTS = [
  'run_failed',
  'run_recovered',
  'new_flaky',
  'new_failure',
] as const;
export const notificationEventSchema = z.enum(NOTIFICATION_EVENTS);
export type NotificationEvent = z.infer<typeof notificationEventSchema>;

export const NOTIFICATION_CHANNELS = ['slack', 'teams', 'email'] as const;
export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

export const STATS_WINDOWS = ['7d', '14d', '30d'] as const;
export const statsWindowSchema = z.enum(STATS_WINDOWS);
export type StatsWindow = z.infer<typeof statsWindowSchema>;

export const UI_LOCALES = ['en', 'fr'] as const;
export const uiLocaleSchema = z.enum(UI_LOCALES);
/**
 * The language of the EyesOnBug interface. Deliberately distinct from the
 * `locale` dimension on a RunConfiguration, which is the locale the *tests*
 * ran under. Conflating the two is an easy and expensive mistake.
 */
export type UiLocale = z.infer<typeof uiLocaleSchema>;

export const THEMES = ['light', 'dark', 'system'] as const;
export const themeSchema = z.enum(THEMES);
export type Theme = z.infer<typeof themeSchema>;
