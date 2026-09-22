'use client';

import { useState } from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...classes: Array<string | false | null | undefined>): string =>
  twMerge(clsx(classes));

export function Card({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      className={cn(
        'rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-5',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'brand' | 'pass' | 'fail';
}): React.ReactElement {
  const tones = {
    neutral: 'border-[var(--color-border)] text-[var(--color-ink-muted)]',
    brand: 'border-[var(--color-brand)] text-[var(--color-brand)]',
    pass: 'border-[var(--color-pass)] text-[var(--color-pass)]',
    fail: 'border-[var(--color-fail)] text-[var(--color-fail)]',
  } as const;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

/**
 * Skeletons reserve the exact space the loaded content will take, so nothing
 * shifts when data arrives — the spec calls out "no layout shift" explicitly.
 */
export function Skeleton({ className }: { className?: string }): React.ReactElement {
  return (
    <div
      aria-hidden
      className={cn('bg-[var(--color-border)]/60 animate-pulse rounded-md', className)}
    />
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-[var(--color-border)] px-6 py-12 text-center">
      {icon ? <div className="text-[var(--color-ink-muted)]">{icon}</div> : null}
      <h3 className="text-base font-semibold">{title}</h3>
      {/* Empty states teach: they say what the thing is for, not just that it is empty. */}
      <p className="max-w-md text-sm text-[var(--color-ink-muted)]">{body}</p>
      {action}
    </div>
  );
}

export function Button({
  children,
  variant = 'primary',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost';
}): React.ReactElement {
  const variants = {
    primary:
      'bg-[var(--color-brand)] text-[var(--color-brand-ink)] hover:opacity-90 disabled:opacity-50',
    ghost:
      'border border-[var(--color-border)] hover:bg-[var(--color-border)]/40 disabled:opacity-50',
  } as const;

  return (
    <button
      {...props}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-opacity',
        variants[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

/** The input/select shape used by every form in the app. */
export const fieldClass =
  'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm';

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-[var(--color-ink-muted)]">{hint}</span> : null}
    </label>
  );
}

/**
 * Destructive actions confirm in place: a second click on the same button,
 * rather than a `window.confirm` dialog the browser styles and screen readers
 * announce out of context.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
}): React.ReactElement {
  const [armed, setArmed] = useState(false);

  return (
    <Button
      variant="ghost"
      disabled={disabled}
      className={armed ? 'border-[var(--color-fail)] text-[var(--color-fail)]' : undefined}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
      onBlur={() => setArmed(false)}
    >
      {armed ? confirmLabel : label}
    </Button>
  );
}
