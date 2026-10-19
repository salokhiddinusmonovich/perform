import type { ReactNode } from 'react';
import type { FieldError } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

interface FieldProps {
  /** id of the control, so the label and error are linked to it */
  id: string;
  label: string;
  error?: FieldError;
  hint?: string;
  children: ReactNode;
}

/**
 * Label + control + hint/error, the same in every form. Error messages are
 * translation keys from @puantaj/schemas or the API (e.g. "validation.phoneInvalid").
 */
export function Field({ id, label, error, hint, children }: FieldProps) {
  const { t } = useTranslation();
  const message = error?.message ? t(error.message) : undefined;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {message ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {message}
        </p>
      ) : (
        hint && <p className="text-sm text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

/** Props to spread on a control inside <Field> for accessible error linking. */
export function fieldControlProps(id: string, error?: FieldError) {
  return {
    id,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? `${id}-error` : undefined,
  };
}

/** Form-level error (not tied to one field), e.g. wrong password. */
export function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {message}
    </p>
  );
}

interface FormActionsProps {
  submitLabel: string;
  pending: boolean;
  onCancel?: () => void;
  /** Single full-width button, for small standalone forms like login */
  fullWidth?: boolean;
}

/** Buttons at the end of every form: secondary left, primary right (AGENTS.md). */
export function FormActions({ submitLabel, pending, onCancel, fullWidth }: FormActionsProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
      {onCancel && (
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          {t('common.cancel')}
        </Button>
      )}
      <Button type="submit" disabled={pending} aria-busy={pending} className={cn(fullWidth && 'w-full')}>
        {pending ? t('common.saving') : submitLabel}
      </Button>
    </div>
  );
}
