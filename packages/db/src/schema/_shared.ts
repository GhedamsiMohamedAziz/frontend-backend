import { sql } from 'drizzle-orm';
import { pgEnum, timestamp, uuid } from 'drizzle-orm/pg-core';
import {
  ATTACHMENT_KINDS,
  FEATURE_SOURCES,
  ISSUE_TRACKERS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENTS,
  ORG_ROLES,
  PROJECT_ROLES,
  RERUN_KINDS,
  RESULT_STATUSES,
  RUN_STATUSES,
  RUN_TRIGGERS,
  STATS_WINDOWS,
  STEP_KEYWORDS,
  STEP_STATUSES,
  THEMES,
  TRIAGE_CATEGORIES,
  TRIAGE_RESOLUTIONS,
  TRIAGE_SOURCES,
  UI_LOCALES,
} from '@eyesonbug/shared';

/**
 * Postgres enums are generated from the same const tuples the API validates
 * against, so the database and the Zod schemas cannot drift apart.
 */
export const orgRoleEnum = pgEnum('org_role', ORG_ROLES);
export const projectRoleEnum = pgEnum('project_role', PROJECT_ROLES);
export const runStatusEnum = pgEnum('run_status', RUN_STATUSES);
export const runTriggerEnum = pgEnum('run_trigger', RUN_TRIGGERS);
export const resultStatusEnum = pgEnum('result_status', RESULT_STATUSES);
export const stepStatusEnum = pgEnum('step_status', STEP_STATUSES);
export const stepKeywordEnum = pgEnum('step_keyword', STEP_KEYWORDS);
export const attachmentKindEnum = pgEnum('attachment_kind', ATTACHMENT_KINDS);
export const triageCategoryEnum = pgEnum('triage_category', TRIAGE_CATEGORIES);
export const triageSourceEnum = pgEnum('triage_source', TRIAGE_SOURCES);
export const triageResolutionEnum = pgEnum('triage_resolution', TRIAGE_RESOLUTIONS);
export const featureSourceEnum = pgEnum('feature_source', FEATURE_SOURCES);
export const issueTrackerEnum = pgEnum('issue_tracker', ISSUE_TRACKERS);
export const rerunKindEnum = pgEnum('rerun_kind', RERUN_KINDS);
export const notificationEventEnum = pgEnum('notification_event', NOTIFICATION_EVENTS);
export const notificationChannelEnum = pgEnum('notification_channel', NOTIFICATION_CHANNELS);
export const statsWindowEnum = pgEnum('stats_window', STATS_WINDOWS);
export const uiLocaleEnum = pgEnum('ui_locale', UI_LOCALES);
export const themeEnum = pgEnum('theme', THEMES);

/**
 * uuid v7, generated in the database (see `docker/init/01-init.sql`).
 * Time-sortable keys keep inserts at the right edge of the B-tree, which
 * matters when a single run writes 20k rows.
 */
export const primaryId = () =>
  uuid()
    .primaryKey()
    .default(sql`uuid_generate_v7()`);

export const idDefault = () => uuid().default(sql`uuid_generate_v7()`);

export const createdAt = () => timestamp({ withTimezone: true }).defaultNow().notNull();
export const updatedAt = () => timestamp({ withTimezone: true }).defaultNow().notNull();
export const ts = () => timestamp({ withTimezone: true });
