'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Plus } from 'lucide-react';
import {
  createSchedule,
  deleteSchedule,
  getProject,
  getSchedules,
  getWorkflowConfigs,
  updateSchedule,
  type ApiRequestError,
  type ScheduleRow,
  type WorkflowConfigRow,
} from '@/lib/api';
import { useLocale, useTranslate } from '@/lib/i18n';
import { AppShell } from '@/components/app-shell';
import {
  Badge,
  Button,
  Card,
  ConfirmButton,
  EmptyState,
  Field,
  Skeleton,
  fieldClass,
} from '@/components/ui';

/**
 * Every zone the browser knows, as a datalist. Old engines lack
 * `supportedValuesOf`, and the field stays a plain text input for them.
 */
const TIMEZONES: string[] =
  typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];

export default function SchedulesSettingsPage({
  params,
}: {
  params: Promise<{ org: string; project: string }>;
}): React.ReactElement {
  const { org, project } = use(params);
  const t = useTranslate();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const detail = useQuery({
    queryKey: ['project', org, project],
    queryFn: () => getProject(org, project),
    retry: false,
  });
  const canManage = detail.data?.capabilities.includes('schedule:manage') ?? false;

  const configs = useQuery({
    queryKey: ['workflow-configs', org, project],
    queryFn: () => getWorkflowConfigs(org, project),
    retry: false,
  });

  const schedules = useQuery({
    queryKey: ['schedules', org, project],
    queryFn: () => getSchedules(org, project),
    retry: false,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['schedules', org, project] });

  const remove = useMutation({
    mutationFn: (id: string) => deleteSchedule(org, project, id),
    onSuccess: invalidate,
  });

  const toggle = useMutation({
    mutationFn: (schedule: ScheduleRow) =>
      updateSchedule(org, project, schedule.id, { enabled: !schedule.enabled }),
    onSuccess: invalidate,
  });

  const formatDate = (value: string | null): string =>
    value ? new Date(value).toLocaleString(locale) : t('common.never');

  const templateName = (id: string): string =>
    configs.data?.find((config) => config.id === id)?.name ?? id;

  return (
    <AppShell>
      <div className="space-y-6">
        <Link
          href={`/o/${org}/p/${project}`}
          className="inline-flex items-center gap-1 text-sm text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
          {t('settings.title')}
        </Link>

        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{t('schedules.title')}</h1>
          {canManage ? (
            <Button
              className="ml-auto"
              onClick={() => setCreating((open) => !open)}
              disabled={(configs.data?.length ?? 0) === 0}
            >
              <Plus className="h-4 w-4" aria-hidden />
              {t('schedules.new')}
            </Button>
          ) : null}
        </div>

        {canManage && configs.isSuccess && configs.data.length === 0 ? (
          <p className="text-sm text-[var(--color-ink-muted)]">{t('schedules.needTemplate')}</p>
        ) : null}

        {creating ? (
          <CreateForm
            org={org}
            project={project}
            configs={configs.data ?? []}
            onDone={() => {
              setCreating(false);
              void invalidate();
            }}
          />
        ) : null}

        {schedules.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : schedules.isError ? (
          <EmptyState title={t('common.error')} body={(schedules.error as Error).message} />
        ) : schedules.data.length === 0 ? (
          <EmptyState title={t('schedules.empty.title')} body={t('schedules.empty.body')} />
        ) : (
          <ul className="space-y-3">
            {schedules.data.map((schedule) => (
              <li key={schedule.id}>
                <Card className="space-y-2">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-medium">{schedule.name}</span>
                    <code className="text-xs text-[var(--color-ink-muted)]">
                      {schedule.cron} · {schedule.timezone}
                    </code>
                    <Badge tone={schedule.enabled ? 'pass' : 'neutral'}>
                      {schedule.enabled ? t('common.enabled') : t('common.disabled')}
                    </Badge>
                    {canManage ? (
                      <span className="ml-auto flex items-center gap-2">
                        <Button variant="ghost" onClick={() => toggle.mutate(schedule)}>
                          {schedule.enabled ? t('common.disable') : t('common.enable')}
                        </Button>
                        <ConfirmButton
                          label={t('common.delete')}
                          confirmLabel={t('common.confirm')}
                          onConfirm={() => remove.mutate(schedule.id)}
                        />
                      </span>
                    ) : null}
                  </div>
                  <p className="text-sm text-[var(--color-ink-muted)]">
                    {t('schedules.template')}: {templateName(schedule.workflowConfigId)}
                  </p>
                  <p className="text-xs text-[var(--color-ink-muted)]">
                    {t('schedules.nextRun')}: {formatDate(schedule.nextRunAt)} ·{' '}
                    {t('schedules.lastRun')}: {formatDate(schedule.lastRunAt)}
                  </p>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  );
}

function CreateForm({
  org,
  project,
  configs,
  onDone,
}: {
  org: string;
  project: string;
  configs: WorkflowConfigRow[];
  onDone: () => void;
}): React.ReactElement {
  const t = useTranslate();
  const [name, setName] = useState('');
  const [workflowConfigId, setWorkflowConfigId] = useState(configs[0]?.id ?? '');
  const [cron, setCron] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [enabled, setEnabled] = useState(true);
  // piggy: a flat key/value list, not a generated form. The launcher already
  // generates one from the workflow; a schedule only overrides a few values.
  const [inputs, setInputs] = useState<Array<{ key: string; value: string }>>([]);

  const create = useMutation({
    mutationFn: () =>
      createSchedule(org, project, {
        name,
        workflowConfigId,
        cron,
        timezone,
        enabled,
        inputs: Object.fromEntries(
          inputs.filter((pair) => pair.key.trim() !== '').map((pair) => [pair.key, pair.value]),
        ),
      }),
    onSuccess: onDone,
  });

  const error = create.error as ApiRequestError | null;

  return (
    <Card>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <Field label={t('common.name')}>
          <input
            className={fieldClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </Field>

        <Field label={t('schedules.template')}>
          <select
            className={fieldClass}
            value={workflowConfigId}
            onChange={(event) => setWorkflowConfigId(event.target.value)}
            required
          >
            {configs.map((config) => (
              <option key={config.id} value={config.id}>
                {config.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t('schedules.cron')}>
          <input
            className={fieldClass}
            value={cron}
            placeholder="0 2 * * *"
            onChange={(event) => setCron(event.target.value)}
            required
          />
        </Field>

        <Field label={t('schedules.timezone')}>
          <input
            className={fieldClass}
            value={timezone}
            list="timezones"
            onChange={(event) => setTimezone(event.target.value)}
            required
          />
        </Field>
        <datalist id="timezones">
          {TIMEZONES.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>

        <div className="space-y-2">
          <span className="text-sm font-medium">{t('schedules.inputs')}</span>
          {inputs.map((pair, index) => (
            <div key={index} className="flex gap-2">
              <input
                className={fieldClass}
                aria-label={t('common.key')}
                placeholder={t('common.key')}
                value={pair.key}
                onChange={(event) =>
                  setInputs((current) =>
                    current.map((item, i) =>
                      i === index ? { ...item, key: event.target.value } : item,
                    ),
                  )
                }
              />
              <input
                className={fieldClass}
                aria-label={t('common.value')}
                placeholder={t('common.value')}
                value={pair.value}
                onChange={(event) =>
                  setInputs((current) =>
                    current.map((item, i) =>
                      i === index ? { ...item, value: event.target.value } : item,
                    ),
                  )
                }
              />
              <Button
                type="button"
                variant="ghost"
                onClick={() => setInputs((current) => current.filter((_, i) => i !== index))}
              >
                {t('common.remove')}
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="ghost"
            onClick={() => setInputs((current) => [...current, { key: '', value: '' }])}
          >
            {t('common.add')}
          </Button>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          {t('common.enabled')}
        </label>

        {error ? <p className="text-sm text-[var(--color-fail)]">{error.message}</p> : null}

        <div className="flex gap-2">
          <Button type="submit" disabled={create.isPending}>
            {t('common.create')}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
