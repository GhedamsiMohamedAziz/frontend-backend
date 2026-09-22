'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Plus } from 'lucide-react';
import {
  createQualityGate,
  deleteQualityGate,
  getProject,
  getQualityGates,
  updateQualityGate,
  type ApiRequestError,
  type QualityGateRow,
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

export default function QualityGatesSettingsPage({
  params,
}: {
  params: Promise<{ org: string; project: string }>;
}): React.ReactElement {
  const { org, project } = use(params);
  const t = useTranslate();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const detail = useQuery({
    queryKey: ['project', org, project],
    queryFn: () => getProject(org, project),
    retry: false,
  });
  const canManage = detail.data?.capabilities.includes('gate:manage') ?? false;

  const gates = useQuery({
    queryKey: ['quality-gates', org, project],
    queryFn: () => getQualityGates(org, project),
    retry: false,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['quality-gates', org, project] });

  const remove = useMutation({
    mutationFn: (id: string) => deleteQualityGate(org, project, id),
    onSuccess: invalidate,
  });

  const toggle = useMutation({
    mutationFn: (gate: QualityGateRow) =>
      updateQualityGate(org, project, gate.id, { enabled: !gate.enabled }),
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
          <h1 className="text-2xl font-semibold">{t('gates.title')}</h1>
          {canManage ? (
            <Button className="ml-auto" onClick={() => setCreating((open) => !open)}>
              <Plus className="h-4 w-4" aria-hidden />
              {t('gates.new')}
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

        {gates.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : gates.isError ? (
          <EmptyState title={t('common.error')} body={(gates.error as Error).message} />
        ) : gates.data.length === 0 ? (
          <EmptyState title={t('gates.empty.title')} body={t('gates.empty.body')} />
        ) : (
          <ul className="space-y-3">
            {gates.data.map((gate) => (
              <li key={gate.id}>
                <Card className="space-y-2">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-medium">{gate.name}</span>
                    <Badge tone={gate.enabled ? 'pass' : 'neutral'}>
                      {gate.enabled ? t('common.enabled') : t('common.disabled')}
                    </Badge>
                    {canManage ? (
                      <span className="ml-auto flex items-center gap-2">
                        <Button variant="ghost" onClick={() => toggle.mutate(gate)}>
                          {gate.enabled ? t('common.disable') : t('common.enable')}
                        </Button>
                        <ConfirmButton
                          label={t('common.delete')}
                          confirmLabel={t('common.confirm')}
                          onConfirm={() => remove.mutate(gate.id)}
                        />
                      </span>
                    ) : null}
                  </div>
                  <p className="text-sm text-[var(--color-ink-muted)]">
                    {gate.rules.minPassRate !== undefined
                      ? `${t('gates.minPassRate')}: ${Math.round(gate.rules.minPassRate * 100)}`
                      : null}
                    {gate.rules.minPassRate !== undefined && gate.rules.maxFailed !== undefined
                      ? ' · '
                      : null}
                    {gate.rules.maxFailed !== undefined
                      ? `${t('gates.maxFailed')}: ${gate.rules.maxFailed}`
                      : null}
                  </p>
                  <p className="font-mono text-xs text-[var(--color-ink-muted)]">
                    {t('gates.branches')}: {gate.appliesToBranches.join(', ')}
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
  onDone,
}: {
  org: string;
  project: string;
  onDone: () => void;
}): React.ReactElement {
  const t = useTranslate();
  const [name, setName] = useState('');
  // Percent in the form, fraction on the wire: 98 reads better than 0.98.
  const [minPassRate, setMinPassRate] = useState('');
  const [maxFailed, setMaxFailed] = useState('');
  const [branches, setBranches] = useState('main');
  const [enabled, setEnabled] = useState(true);

  const create = useMutation({
    mutationFn: () =>
      createQualityGate(org, project, {
        name,
        rules: {
          ...(minPassRate === '' ? {} : { minPassRate: Number(minPassRate) / 100 }),
          ...(maxFailed === '' ? {} : { maxFailed: Number(maxFailed) }),
        },
        appliesToBranches: branches
          .split(',')
          .map((branch) => branch.trim())
          .filter(Boolean),
        enabled,
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

        <Field label={t('gates.minPassRate')}>
          <input
            className={fieldClass}
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={minPassRate}
            onChange={(event) => setMinPassRate(event.target.value)}
          />
        </Field>

        <Field label={t('gates.maxFailed')}>
          <input
            className={fieldClass}
            type="number"
            min={0}
            step={1}
            value={maxFailed}
            onChange={(event) => setMaxFailed(event.target.value)}
          />
        </Field>

        <Field label={t('gates.branches')} hint={t('gates.branchesHint')}>
          <input
            className={fieldClass}
            value={branches}
            onChange={(event) => setBranches(event.target.value)}
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
