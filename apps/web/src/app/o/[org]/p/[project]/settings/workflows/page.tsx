'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Play, Plus } from 'lucide-react';
import type { WorkflowInput } from '@eyesonbug/shared';
import {
  createWorkflowConfig,
  deleteWorkflowConfig,
  dispatchWorkflowConfig,
  getGithubRepos,
  getGithubWorkflows,
  getProject,
  getWorkflowConfigs,
  updateWorkflowConfig,
  type ApiRequestError,
  type WorkflowConfigRow,
} from '@/lib/api';
import { useTranslate } from '@/lib/i18n';
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

/** `error.details` is a string[] of per-input complaints on a 400. */
function detailsOf(error: unknown): string[] {
  const details = (error as ApiRequestError | null)?.details;
  return Array.isArray(details) ? details.filter((d): d is string => typeof d === 'string') : [];
}

export default function WorkflowsSettingsPage({
  params,
}: {
  params: Promise<{ org: string; project: string }>;
}): React.ReactElement {
  const { org, project } = use(params);
  const t = useTranslate();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [launching, setLaunching] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['project', org, project],
    queryFn: () => getProject(org, project),
    retry: false,
  });
  const capabilities = detail.data?.capabilities ?? [];
  const canManage = capabilities.includes('workflow:manage');
  const canTrigger = capabilities.includes('run:trigger');

  const configs = useQuery({
    queryKey: ['workflow-configs', org, project],
    queryFn: () => getWorkflowConfigs(org, project),
    retry: false,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['workflow-configs', org, project] });

  const remove = useMutation({
    mutationFn: (id: string) => deleteWorkflowConfig(org, project, id),
    onSuccess: invalidate,
  });

  const toggle = useMutation({
    mutationFn: (config: WorkflowConfigRow) =>
      updateWorkflowConfig(org, project, config.id, { enabled: !config.enabled }),
    onSuccess: invalidate,
  });

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
          <h1 className="text-2xl font-semibold">{t('workflows.title')}</h1>
          {canManage ? (
            <Button className="ml-auto" onClick={() => setCreating((open) => !open)}>
              <Plus className="h-4 w-4" aria-hidden />
              {t('workflows.new')}
            </Button>
          ) : null}
        </div>

        {creating ? (
          <CreateForm
            org={org}
            project={project}
            onDone={() => {
              setCreating(false);
              void invalidate();
            }}
          />
        ) : null}

        {configs.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : configs.isError ? (
          <EmptyState title={t('common.error')} body={(configs.error as Error).message} />
        ) : configs.data.length === 0 ? (
          <EmptyState title={t('workflows.empty.title')} body={t('workflows.empty.body')} />
        ) : (
          <ul className="space-y-3">
            {configs.data.map((config) => (
              <li key={config.id}>
                <Card className="space-y-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-medium">{config.name}</span>
                    <code className="text-xs text-[var(--color-ink-muted)]">
                      {config.repoFullName}/{config.workflowFile}@{config.ref}
                    </code>
                    <Badge tone={config.enabled ? 'pass' : 'neutral'}>
                      {config.enabled ? t('common.enabled') : t('common.disabled')}
                    </Badge>

                    <span className="ml-auto flex items-center gap-2">
                      {canTrigger && config.enabled ? (
                        <Button
                          onClick={() =>
                            setLaunching((open) => (open === config.id ? null : config.id))
                          }
                        >
                          <Play className="h-4 w-4" aria-hidden />
                          {t('workflows.run')}
                        </Button>
                      ) : null}
                      {canManage ? (
                        <>
                          <Button variant="ghost" onClick={() => toggle.mutate(config)}>
                            {config.enabled ? t('common.disable') : t('common.enable')}
                          </Button>
                          <ConfirmButton
                            label={t('common.delete')}
                            confirmLabel={t('common.confirm')}
                            onConfirm={() => remove.mutate(config.id)}
                          />
                        </>
                      ) : null}
                    </span>
                  </div>

                  {launching === config.id ? (
                    <Launcher
                      org={org}
                      project={project}
                      config={config}
                      onClose={() => setLaunching(null)}
                    />
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  );
}

/**
 * The launcher form is generated from the workflow's own
 * `workflow_dispatch.inputs`, so it cannot drift from the workflow it runs.
 */
function Launcher({
  org,
  project,
  config,
  onClose,
}: {
  org: string;
  project: string;
  config: WorkflowConfigRow;
  onClose: () => void;
}): React.ReactElement {
  const t = useTranslate();
  const router = useRouter();
  const schema = Object.entries(config.inputsSchema);

  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      schema.map(([name, input]) => [
        name,
        config.defaultInputs[name] ?? (input.default !== undefined ? String(input.default) : ''),
      ]),
    ),
  );
  const [ref, setRef] = useState(config.ref);

  const dispatch = useMutation({
    mutationFn: () => dispatchWorkflowConfig(org, project, config.id, { inputs: values, ref }),
    onSuccess: ({ runId }) => router.push(`/o/${org}/p/${project}/runs/${runId}`),
  });

  const details = detailsOf(dispatch.error);

  return (
    <form
      className="space-y-3 border-t border-[var(--color-border)] pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        dispatch.mutate();
      }}
    >
      <Field label={t('workflows.ref')}>
        <input
          className={fieldClass}
          value={ref}
          onChange={(event) => setRef(event.target.value)}
          required
        />
      </Field>

      {schema.length === 0 ? (
        <p className="text-sm text-[var(--color-ink-muted)]">{t('workflows.noInputs')}</p>
      ) : (
        schema.map(([name, input]) => (
          <InputField
            key={name}
            name={name}
            input={input}
            value={values[name] ?? ''}
            onChange={(next) => setValues((current) => ({ ...current, [name]: next }))}
          />
        ))
      )}

      {dispatch.error ? (
        <div className="space-y-1 text-sm text-[var(--color-fail)]">
          <p>{(dispatch.error as Error).message}</p>
          {details.map((line) => (
            <p key={line} className="text-xs">
              {line}
            </p>
          ))}
        </div>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" disabled={dispatch.isPending}>
          {t('workflows.launch')}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

function InputField({
  name,
  input,
  value,
  onChange,
}: {
  name: string;
  input: WorkflowInput;
  value: string;
  onChange: (next: string) => void;
}): React.ReactElement {
  if (input.type === 'boolean') {
    // GitHub takes every input as a string, booleans included.
    return (
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value === 'true'}
          onChange={(event) => onChange(event.target.checked ? 'true' : 'false')}
        />
        <span className="font-medium">{name}</span>
        {input.description ? (
          <span className="text-xs text-[var(--color-ink-muted)]">{input.description}</span>
        ) : null}
      </label>
    );
  }

  return (
    <Field label={name} hint={input.description}>
      {input.type === 'choice' ? (
        <select
          className={fieldClass}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required={input.required}
        >
          <option value="" />
          {(input.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          className={fieldClass}
          type={input.type === 'number' ? 'number' : 'text'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required={input.required}
        />
      )}
    </Field>
  );
}

function CreateForm({
  org,
  project,
  onDone,
}: {
  org: string;
  project: string;
  onDone: () => void;
}): React.ReactElement {
  const t = useTranslate();
  const [name, setName] = useState('');
  const [repoFullName, setRepoFullName] = useState('');
  const [workflowFile, setWorkflowFile] = useState('');
  const [ref, setRef] = useState('');
  const [enabled, setEnabled] = useState(true);

  const repos = useQuery({
    queryKey: ['github-repos', org],
    queryFn: () => getGithubRepos(org),
    retry: false,
  });

  const workflows = useQuery({
    queryKey: ['github-workflows', org, repoFullName],
    queryFn: () => getGithubWorkflows(org, repoFullName),
    enabled: repoFullName !== '',
    retry: false,
  });

  const create = useMutation({
    mutationFn: () =>
      createWorkflowConfig(org, project, {
        name,
        repoFullName,
        workflowFile,
        ref,
        defaultInputs: {},
        enabled,
      }),
    onSuccess: onDone,
  });

  const error = (repos.error ?? workflows.error ?? create.error) as ApiRequestError | null;

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

        <Field label={t('workflows.repo')}>
          <select
            className={fieldClass}
            value={repoFullName}
            onChange={(event) => {
              setRepoFullName(event.target.value);
              setWorkflowFile('');
              // The repository's default branch is the ref anyone means.
              setRef(
                repos.data?.find((repo) => repo.fullName === event.target.value)?.defaultBranch ??
                  '',
              );
            }}
            required
          >
            <option value="" />
            {repos.data?.map((repo) => (
              <option key={repo.fullName} value={repo.fullName}>
                {repo.fullName}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t('workflows.workflow')}>
          <select
            className={fieldClass}
            value={workflowFile}
            onChange={(event) => setWorkflowFile(event.target.value)}
            required
            disabled={repoFullName === ''}
          >
            <option value="" />
            {workflows.data?.map((workflow) => (
              <option key={workflow.id} value={workflow.file}>
                {workflow.name} ({workflow.file})
              </option>
            ))}
          </select>
        </Field>

        <Field label={t('workflows.ref')}>
          <input
            className={fieldClass}
            value={ref}
            onChange={(event) => setRef(event.target.value)}
            required
          />
        </Field>

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
