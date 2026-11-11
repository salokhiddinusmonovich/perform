import { zodResolver } from '@hookform/resolvers/zod';
import { payRoundingSchema, type PayRounding, type PayRoundingInput } from '@puantaj/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, Pencil } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useForm, type FieldError } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ErrorState } from '@/components/error-state';
import { Field, fieldControlProps, FormActions, FormError, MonthField } from '@/components/form';
import { FromMonthList } from '@/components/from-month-list';
import { LoadingState } from '@/components/loading-state';
import { PageHeader } from '@/components/page-header';
import { RequireAccess } from '@/components/require-access';
import { RuleSetUseDialog, ruleSetUsesKey } from '@/components/rule-set-use-dialog';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useFormat } from '@/hooks/use-format';
import { api } from '@/lib/api';
import { canManageCompany, canViewPayRules, type Me } from '@/lib/auth';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { useWorkerCategories, type WorkerCategoryItem } from '@/lib/organisation';
import { currentMonth } from '@/lib/payroll';
import { inForceAndLater, PAY_CATEGORIES_KEY, usePayCategories, type FromMonth, type PayCategoriesItem } from '@/lib/rule-sets';

interface CompanyUse extends FromMonth {
  ruleSet: { id: string; name: string };
}

interface RoundingItem extends FromMonth {
  step: string;
}

const ROUNDING_KEY = ['pay-rounding'] as const;
const COMPANY = { kind: 'company' } as const;

/** "No second category"; can't be mistaken for a category's id. */
const NONE = 'none';

/**
 * How the company pays (AGENTS.md: Pay rule sets): the worker categories its rules go by, the
 * rule set it uses, and the rounding step, each from a month on. Owners and admins change them;
 * accountants look.
 */
export function CompanyPayPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('payRules.title')} description={t('payRules.description')} />
      <RequireAccess allowed={canViewPayRules}>{(me) => <CompanyPayView me={me} />}</RequireAccess>
    </>
  );
}

function CompanyPayView({ me }: { me: Me }) {
  const { t } = useTranslation();
  const format = useFormat();
  const manages = canManageCompany(me);
  const currency = me.activeCompany!.currency; // guaranteed by canViewPayRules
  const categories = useWorkerCategories();
  const payCategories = usePayCategories();
  const uses = useQuery({ queryKey: ruleSetUsesKey(COMPANY), queryFn: () => api.get<CompanyUse[]>('/company/rule-set') });
  const rounding = useQuery({ queryKey: ROUNDING_KEY, queryFn: () => api.get<RoundingItem[]>('/pay-rounding') });
  const [open, setOpen] = useState<'categories' | 'ruleSet' | 'rounding' | null>(null);

  const queries = [categories, payCategories, uses, rounding];
  if (queries.some((q) => q.isPending)) return <LoadingState />;
  if (queries.some((q) => q.isError)) return <ErrorState onRetry={() => Promise.all(queries.map((q) => q.refetch()))} />;

  const namesOf = (ids: readonly string[]) => categoryNames(categories.data!, ids);

  return (
    <div className="space-y-6">
      <ChoiceCard
        title={t('payRules.categoriesTitle')}
        description={t('payRules.categoriesHint')}
        rows={payCategories.data!}
        label={(c) => namesOf(c.categoryIds)}
        missing={t('payRules.categoriesMissing')}
        manages={manages}
        onOpen={() => setOpen('categories')}
      />
      <ChoiceCard
        title={t('payRules.ruleSetTitle')}
        description={t('payRules.ruleSetHint')}
        rows={uses.data!}
        label={(u) => (
          <Link to={`/settings/rule-sets/${u.ruleSet.id}`} className="underline-offset-4 hover:underline">
            {u.ruleSet.name}
          </Link>
        )}
        missing={t('payRules.ruleSetMissing')}
        manages={manages}
        onOpen={() => setOpen('ruleSet')}
      />
      <ChoiceCard
        title={t('payRules.rounding')}
        description={t('payRules.roundingHint')}
        rows={rounding.data!}
        label={(r) => format.money(r.step, currency)}
        missing={t('payRules.roundingMissing')}
        manages={manages}
        onOpen={() => setOpen('rounding')}
      />

      {open === 'categories' && (
        <PayCategoriesDialog
          categories={categories.data!}
          choices={payCategories.data!}
          canChange={manages}
          onClose={() => setOpen(null)}
        />
      )}
      {open === 'ruleSet' && (
        <RuleSetUseDialog owner={COMPANY} name={t('ruleSets.company')} canChange={manages} onClose={() => setOpen(null)} />
      )}
      {open === 'rounding' && (
        <RoundingDialog steps={rounding.data!} currency={currency} canChange={manages} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}

function categoryNames(categories: readonly WorkerCategoryItem[], ids: readonly string[]) {
  return ids.map((id) => categories.find((c) => c.id === id)?.name ?? '').join(' × ');
}

/** One of the company's choices from a month: the one in force now, the later ones, and the way to change them. */
function ChoiceCard<T extends FromMonth>({
  title,
  description,
  rows,
  label,
  missing,
  manages,
  onOpen,
}: {
  title: string;
  description: string;
  rows: readonly T[];
  label: (row: T) => ReactNode;
  /** Said when nothing is in force this month */
  missing: string;
  manages: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const now = currentMonth();
  const { inForce, later } = inForceAndLater(rows, now);
  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        <Button variant={manages ? 'default' : 'outline'} onClick={onOpen}>
          {manages ? <Pencil aria-hidden /> : <History aria-hidden />}
          {manages ? t('payRules.changeChoice') : t('payRules.history')}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm text-muted-foreground">{t('payRules.inForceIn', { month: format.month(now.year, now.month) })}</p>
        {inForce ? (
          <p>
            <span className="font-medium">{label(inForce)}</span>{' '}
            <span className="text-sm text-muted-foreground">
              {t('payRules.since', { month: format.month(inForce.fromYear, inForce.fromMonth) })}
            </span>
          </p>
        ) : (
          <StatusBadge tone="warning">{missing}</StatusBadge>
        )}
        {later.map((row) => (
          <p key={`${row.fromYear}-${row.fromMonth}`} className="text-sm">
            {t('ruleSets.fromMonth', { month: format.month(row.fromYear, row.fromMonth) })}: {label(row)}
          </p>
        ))}
      </CardContent>
    </Card>
  );
}

/** The company's pay categories: their history, and one or two categories from a month. */
function PayCategoriesDialog({
  categories,
  choices,
  canChange,
  onClose,
}: {
  categories: readonly WorkerCategoryItem[];
  choices: readonly PayCategoriesItem[];
  canChange: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const queryClient = useQueryClient();
  const [from, setFrom] = useState(currentMonth);
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState(NONE);
  const [firstError, setFirstError] = useState<FieldError>();
  const [formError, setFormError] = useState<string>();
  const [removing, setRemoving] = useState<PayCategoriesItem | null>(null);
  const active = categories.filter((c) => c.isActive);
  const refresh = () => queryClient.invalidateQueries({ queryKey: PAY_CATEGORIES_KEY });

  const save = useMutation({
    mutationFn: () => api.put(`/pay-categories/${from.year}/${from.month}`, { categoryIds: [first, second].filter((id) => id && id !== NONE) }),
    onSuccess: async () => {
      setFormError(undefined);
      toast.success(t('common.saved'));
      await refresh();
    },
    onError: (error) => setFormError(errorMessage(t, error)),
  });

  return (
    <Dialog open onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('payRules.categoriesTitle')}</DialogTitle>
          <DialogDescription>{t('payRules.categoriesDialogDescription')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-6">
          <FromMonthList
            items={choices}
            label={(c) => categoryNames(categories, c.categoryIds)}
            empty={t('payRules.categoriesMissing')}
            onRemove={canChange ? setRemoving : undefined}
          />
          {canChange && (
            <form
              className="space-y-4"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                setFormError(undefined);
                if (!first) {
                  setFirstError({ type: 'required', message: 'validation.required' });
                  return;
                }
                save.mutate();
              }}
            >
              <FormError message={formError} />
              <MonthField legend={t('payRules.appliesFrom')} value={from} onChange={setFrom} hint={t('payRules.categoriesFromHint')} />
              <Field id="pay-category-first" label={t('payRules.firstCategory')} error={firstError}>
                <Select
                  value={first}
                  onValueChange={(v) => {
                    setFirst(v);
                    setFirstError(undefined);
                    if (v === second) setSecond(NONE);
                  }}
                >
                  <SelectTrigger id="pay-category-first" className="w-full" aria-invalid={firstError ? true : undefined}>
                    <SelectValue placeholder={t('payRules.chooseCategory')} />
                  </SelectTrigger>
                  <SelectContent>
                    {active.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {first && (
                <Field id="pay-category-second" label={t('payRules.secondCategory')}>
                  <Select value={second} onValueChange={setSecond}>
                    <SelectTrigger id="pay-category-second" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>{t('payRules.noSecondCategory')}</SelectItem>
                      {active
                        .filter((c) => c.id !== first)
                        .map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
              {active.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  <Link to="/worker-categories" className="underline underline-offset-4">
                    {t('payRules.addCategoriesFirst')}
                  </Link>
                </p>
              )}
              <FormActions submitLabel={t('common.save')} pending={save.isPending} onCancel={onClose} />
            </form>
          )}
        </div>
        <ConfirmDialog
          open={removing !== null}
          onOpenChange={(next) => !next && setRemoving(null)}
          title={t('ruleSets.confirmRemoveUse.title')}
          description={removing ? t('payRules.confirmRemoveCategories', { month: format.month(removing.fromYear, removing.fromMonth) }) : ''}
          confirmLabel={t('ruleSets.confirmRemoveUse.confirm')}
          destructive
          onConfirm={async () => {
            if (!removing) return;
            await api.delete(`/pay-categories/${removing.fromYear}/${removing.fromMonth}`);
            toast.success(t('common.saved'));
            await refresh();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/** The company's rounding step: its history, and a step from a month. */
function RoundingDialog({
  steps,
  currency,
  canChange,
  onClose,
}: {
  steps: readonly RoundingItem[];
  currency: string;
  canChange: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const queryClient = useQueryClient();
  const [from, setFrom] = useState(currentMonth);
  const [formError, setFormError] = useState<string>();
  const [removing, setRemoving] = useState<RoundingItem | null>(null);
  const { inForce } = inForceAndLater(steps, currentMonth());
  const form = useForm<PayRoundingInput, unknown, PayRounding>({
    resolver: zodResolver(payRoundingSchema),
    defaultValues: { step: inForce?.step ?? '1000' },
  });
  const { errors } = form.formState;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ROUNDING_KEY });

  const save = useMutation({
    mutationFn: (values: PayRounding) => api.put(`/pay-rounding/${from.year}/${from.month}`, values),
    onSuccess: async () => {
      setFormError(undefined);
      toast.success(t('common.saved'));
      await refresh();
    },
    onError: (error) => {
      if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(t, error));
    },
  });

  return (
    <Dialog open onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('payRules.rounding')}</DialogTitle>
          <DialogDescription>{t('payRules.roundingHint')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-6">
          <FromMonthList
            items={steps}
            label={(r) => format.money(r.step, currency)}
            empty={t('payRules.roundingMissing')}
            onRemove={canChange ? setRemoving : undefined}
          />
          {canChange && (
            <form
              className="space-y-4"
              noValidate
              onSubmit={form.handleSubmit((values) => {
                setFormError(undefined);
                save.mutate(values);
              })}
            >
              <FormError message={formError} />
              <MonthField legend={t('payRules.appliesFrom')} value={from} onChange={setFrom} hint={t('payRules.appliesFromHint')} />
              <Field id="rounding-step" label={t('payRules.roundingStep', { currency })} error={errors.step}>
                <Input {...fieldControlProps('rounding-step', errors.step)} {...form.register('step')} inputMode="decimal" autoComplete="off" />
              </Field>
              <FormActions submitLabel={t('common.save')} pending={save.isPending} onCancel={onClose} />
            </form>
          )}
        </div>
        <ConfirmDialog
          open={removing !== null}
          onOpenChange={(next) => !next && setRemoving(null)}
          title={t('ruleSets.confirmRemoveUse.title')}
          description={removing ? t('payRules.confirmRemoveRounding', { month: format.month(removing.fromYear, removing.fromMonth) }) : ''}
          confirmLabel={t('ruleSets.confirmRemoveUse.confirm')}
          destructive
          onConfirm={async () => {
            if (!removing) return;
            await api.delete(`/pay-rounding/${removing.fromYear}/${removing.fromMonth}`);
            toast.success(t('common.saved'));
            await refresh();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
