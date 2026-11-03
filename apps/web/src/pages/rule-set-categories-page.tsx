import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { CalendarCheck, MoreHorizontal, Pencil, Plus, Scale, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable } from '@/components/data-table';
import { ErrorState } from '@/components/error-state';
import { Field, FormActions, FormError, MonthField } from '@/components/form';
import { LoadingState } from '@/components/loading-state';
import { PageHeader } from '@/components/page-header';
import { RequireAccess } from '@/components/require-access';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useFormat } from '@/hooks/use-format';
import { api } from '@/lib/api';
import { canManageCompany, canViewPayRules, type Me } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import { useWorkerCategories, type WorkerCategoryItem } from '@/lib/organisation';
import { currentMonth } from '@/lib/payroll';
import {
  combinationLabel,
  RULE_SETS_KEY,
  useRuleSetLabel,
  useRuleSets,
  useRuleSetSplits,
  useRuleSetVariants,
  type RuleSetSplitItem,
  type RuleSetVariantItem,
} from '@/lib/rule-sets';

interface YearMonth {
  year: number;
  month: number;
}

const monthIndex = (year: number, month: number) => year * 12 + month - 1;

/** "No second category" in the split dialog; can't be mistaken for a category's id. */
const NONE = 'none';

/**
 * A rule set's rules by worker category (AGENTS.md: Rule sets split by categories): which
 * categories split it from which month, and the rules of each combination of their options.
 * Owners and admins change them; accountants look.
 */
export function RuleSetCategoriesPage() {
  const { t } = useTranslation();
  const { ruleSetId } = useParams<{ ruleSetId: string }>();
  const name = useRuleSetLabel(ruleSetId);
  return (
    <>
      <PageHeader title={t('ruleSetCategories.title', { name })} description={t('ruleSetCategories.description')} />
      <RequireAccess allowed={canViewPayRules}>{(me) => <CategoriesView me={me} ruleSetId={ruleSetId!} />}</RequireAccess>
    </>
  );
}

function CategoriesView({ me, ruleSetId }: { me: Me; ruleSetId: string }) {
  const { t } = useTranslation();
  const format = useFormat();
  const queryClient = useQueryClient();
  const manages = canManageCompany(me);
  const splits = useRuleSetSplits(ruleSetId);
  const variants = useRuleSetVariants(ruleSetId);
  const categories = useWorkerCategories();
  const [changing, setChanging] = useState(false);
  const [removing, setRemoving] = useState<RuleSetSplitItem | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: [...RULE_SETS_KEY, ruleSetId] });

  const all = categories.data ?? [];
  const namesOf = (ids: readonly string[]) =>
    ids.length > 0 ? ids.map((id) => all.find((c) => c.id === id)?.name ?? '').join(' × ') : t('ruleSetCategories.noSplit');

  const columns = useMemo<ColumnDef<RuleSetSplitItem, unknown>[]>(
    () => [
      {
        id: 'from',
        accessorFn: (s) => monthIndex(s.fromYear, s.fromMonth),
        header: t('payRules.from'),
        cell: ({ row }) => <span className="font-medium">{format.month(row.original.fromYear, row.original.fromMonth)}</span>,
      },
      {
        id: 'categories',
        header: t('ruleSetCategories.splitBy'),
        enableSorting: false,
        cell: ({ row }) => namesOf(row.original.categoryIds),
      },
      {
        id: 'setBy',
        header: t('payRules.setBy'),
        enableSorting: false,
        cell: ({ row }) => (
          <div className="min-w-32">
            <div>{row.original.setBy.fullName}</div>
            <div className="text-sm text-muted-foreground">{format.date(row.original.setAt)}</div>
          </div>
        ),
      },
      ...(manages
        ? [
            {
              id: 'actions',
              header: () => <span className="sr-only">{t('common.actions')}</span>,
              enableSorting: false,
              cell: ({ row }: { row: { original: RuleSetSplitItem } }) => (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('ruleSets.removeUse', { month: format.month(row.original.fromYear, row.original.fromMonth) })}
                  onClick={() => setRemoving(row.original)}
                >
                  <Trash2 aria-hidden />
                </Button>
              ),
            } satisfies ColumnDef<RuleSetSplitItem, unknown>,
          ]
        : []),
    ],
    // namesOf reads the categories, which change with categories.data
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, format, manages, categories.data],
  );

  if (splits.isPending || variants.isPending || categories.isPending) return <LoadingState />;
  if (splits.isError || variants.isError || categories.isError) {
    return <ErrorState onRetry={() => Promise.all([splits.refetch(), variants.refetch(), categories.refetch()])} />;
  }

  const now = currentMonth();
  const nowIndex = monthIndex(now.year, now.month);
  // Newest first: the split in force now, and the ones that start later.
  const inForce = splits.data.find((s) => monthIndex(s.fromYear, s.fromMonth) <= nowIndex);
  const later = splits.data.filter((s) => monthIndex(s.fromYear, s.fromMonth) > nowIndex).reverse();
  const live = [...(inForce ? [inForce] : []), ...later].filter((s) => s.categoryIds.length > 0);
  const kinds = [...new Map(live.map((s) => [s.categoryIds.join(','), s])).values()];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle>{t('payRules.inForce', { month: format.month(now.year, now.month) })}</CardTitle>
            <CardDescription>
              {inForce && inForce.categoryIds.length > 0
                ? t('ruleSetCategories.splitSince', {
                    categories: namesOf(inForce.categoryIds),
                    month: format.month(inForce.fromYear, inForce.fromMonth),
                  })
                : t('ruleSetCategories.notSplit')}
            </CardDescription>
            {later.map((s) => (
              <CardDescription key={monthIndex(s.fromYear, s.fromMonth)}>
                {t('ruleSets.fromMonth', { month: format.month(s.fromYear, s.fromMonth) })}: {namesOf(s.categoryIds)}
              </CardDescription>
            ))}
          </div>
          {manages && (
            <Button onClick={() => setChanging(true)}>
              <Pencil aria-hidden />
              {t('ruleSetCategories.changeSplit')}
            </Button>
          )}
        </CardHeader>
      </Card>

      {kinds.map((split) => (
        <Combinations
          key={split.categoryIds.join(',')}
          ruleSetId={ruleSetId}
          split={split}
          categories={all}
          variants={variants.data}
          manages={manages}
        />
      ))}

      {splits.data.length > 0 && (
        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">{t('payRules.history')}</h2>
            <p className="text-sm text-muted-foreground">{t('ruleSetCategories.historyHint')}</p>
          </div>
          <DataTable columns={columns} data={splits.data} />
        </section>
      )}

      {changing && (
        <SplitDialog
          ruleSetId={ruleSetId}
          categories={all.filter((c) => c.isActive)}
          onClose={() => setChanging(false)}
          onSaved={async () => {
            setChanging(false);
            toast.success(t('common.saved'));
            await refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t('ruleSets.confirmRemoveUse.title')}
        description={removing ? t('ruleSetCategories.confirmRemove', { month: format.month(removing.fromYear, removing.fromMonth) }) : ''}
        confirmLabel={t('ruleSets.confirmRemoveUse.confirm')}
        destructive
        onConfirm={async () => {
          if (!removing) return;
          await api.delete(`/rule-sets/${ruleSetId}/splits/${removing.fromYear}/${removing.fromMonth}`);
          toast.success(t('common.saved'));
          await refresh();
        }}
      />
    </div>
  );
}

/** Every combination of the split's options, with its rules or the lack of them. */
function Combinations({
  ruleSetId,
  split,
  categories,
  variants,
  manages,
}: {
  ruleSetId: string;
  split: RuleSetSplitItem;
  categories: readonly WorkerCategoryItem[];
  variants: readonly RuleSetVariantItem[];
  manages: boolean;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const [adding, setAdding] = useState<string[] | null>(null);
  // In the order of their names, as every page shows a combination.
  const splitCategories = categories.filter((c) => split.categoryIds.includes(c.id));
  const combinations = splitCategories.reduce<string[][]>(
    (acc, c) => acc.flatMap((prefix) => c.options.map((o) => [...prefix, o.id])),
    [[]],
  );
  const variantOf = (optionIds: readonly string[]) =>
    variants.find((v) => v.options.length === optionIds.length && optionIds.every((id) => v.options.some((o) => o.optionId === id)));
  const missing = combinations.filter((ids) => !variantOf(ids)?.rulesFrom).length;

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">{t('ruleSetCategories.combinationsTitle', { categories: splitCategories.map((c) => c.name).join(' × ') })}</h2>
        <p className="text-sm text-muted-foreground">
          {missing > 0 ? t('ruleSetCategories.missing', { count: missing }) : t('ruleSetCategories.combinationsHint')}
        </p>
      </div>
      <Card>
        <CardContent className="divide-y p-0">
          {combinations.map((ids) => {
            const variant = variantOf(ids);
            const closed = ids.some((id) => categories.flatMap((c) => c.options).find((o) => o.id === id)?.isActive === false);
            const label = combinationLabel(categories, ids);
            const base = variant && `/settings/rule-sets/${ruleSetId}/combinations/${variant.id}`;
            return (
              <div key={ids.join(',')} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{label}</span>
                  {closed && <StatusBadge tone="neutral">{t('workerCategories.closed')}</StatusBadge>}
                  {variant?.rulesFrom ? (
                    <span className="text-sm text-muted-foreground">
                      {t('ruleSets.fromMonth', { month: format.month(variant.rulesFrom.year, variant.rulesFrom.month) })}
                    </span>
                  ) : (
                    <StatusBadge tone="warning">{t('ruleSets.noRules')}</StatusBadge>
                  )}
                </div>
                {variant?.rulesFrom ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label={t('common.actionsFor', { name: label })}>
                        <MoreHorizontal aria-hidden />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild>
                        <Link to={`${base}/pay-rules`}>
                          <Scale aria-hidden />
                          {t('nav.payRules')}
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link to={`${base}/working-days`}>
                          <CalendarCheck aria-hidden />
                          {t('nav.workingDays')}
                        </Link>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                  manages && (
                    <Button variant="outline" onClick={() => setAdding(ids)}>
                      <Plus aria-hidden />
                      {t('ruleSetCategories.addRules')}
                    </Button>
                  )
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
      {adding && (
        <CopyRulesDialog
          ruleSetId={ruleSetId}
          optionIds={adding}
          label={combinationLabel(categories, adding)}
          split={split}
          combinations={combinations
            .map((ids) => ({ ids, variant: variantOf(ids) }))
            .filter((s) => s.variant?.rulesFrom)
            .map((s) => ({ path: `/rule-sets/${s.variant!.id}/pay-rules`, label: combinationLabel(categories, s.ids) }))}
          existing={variantOf(adding) ?? null}
          onClose={() => setAdding(null)}
        />
      )}
    </section>
  );
}

/** Chooses the categories (none, one or two) a set splits by from a month on. */
function SplitDialog({
  ruleSetId,
  categories,
  onClose,
  onSaved,
}: {
  ruleSetId: string;
  categories: readonly WorkerCategoryItem[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [from, setFrom] = useState<YearMonth>(currentMonth);
  const [first, setFirst] = useState(NONE);
  const [second, setSecond] = useState(NONE);
  const [formError, setFormError] = useState<string>();
  const save = useMutation({
    mutationFn: () =>
      api.put(`/rule-sets/${ruleSetId}/splits/${from.year}/${from.month}`, {
        categoryIds: [first, second].filter((id) => id !== NONE),
      }),
    onSuccess: onSaved,
    onError: (error) => setFormError(errorMessage(t, error)),
  });
  const select = (id: string, label: string, value: string, onChange: (v: string) => void, except: string | null) => (
    <Field id={id} label={label}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{t('ruleSetCategories.none')}</SelectItem>
          {categories
            .filter((c) => c.id !== except)
            .map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    </Field>
  );

  return (
    <Dialog open onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('ruleSetCategories.changeSplit')}</DialogTitle>
          <DialogDescription>{t('ruleSetCategories.splitDialogDescription')}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setFormError(undefined);
            save.mutate();
          }}
        >
          <FormError message={formError} />
          <MonthField legend={t('payRules.from')} value={from} onChange={setFrom} hint={t('ruleSetCategories.fromHint')} />
          {select('split-first', t('ruleSetCategories.firstCategory'), first, (v) => {
            setFirst(v);
            if (v === NONE || v === second) setSecond(NONE);
          }, null)}
          {first !== NONE && select('split-second', t('ruleSetCategories.secondCategory'), second, setSecond, first)}
          <FormActions submitLabel={t('common.save')} pending={save.isPending} onCancel={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Start from an empty form" in the add-rules dialog; can't be mistaken for a path. */
const EMPTY = 'empty';

/**
 * Gives a combination its first rules: an empty form, or a copy of another combination's or
 * any rule set's rules for a month. Then opens them to fill in or change what differs.
 */
function CopyRulesDialog({
  ruleSetId,
  optionIds,
  label,
  split,
  combinations,
  existing,
  onClose,
}: {
  ruleSetId: string;
  optionIds: string[];
  label: string;
  split: RuleSetSplitItem;
  /** This set's combinations with rules, by the path of their rules */
  combinations: { path: string; label: string }[];
  existing: RuleSetVariantItem | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sets = useRuleSets().data ?? [];
  // Every rule set's own rules, the company's first.
  const ownRules = [...sets]
    .filter((s) => s.rulesFrom)
    .sort((a, b) => (a.name === null ? -1 : b.name === null ? 1 : a.name.localeCompare(b.name)))
    .map((s) => ({
      path: s.name === null ? '/pay-rules' : `/rule-sets/${s.id}/pay-rules`,
      label: s.name ?? t('ruleSetCategories.defaultName'),
    }));
  const [from, setFrom] = useState<YearMonth>({ year: split.fromYear, month: split.fromMonth });
  const [source, setSource] = useState(EMPTY);
  const [formError, setFormError] = useState<string>();
  const save = useMutation({
    mutationFn: async () => {
      let rules: Record<string, unknown> | null = null;
      if (source !== EMPTY) {
        const versions = await api.get<{ fromYear: number; fromMonth: number; rules: Record<string, unknown> }[]>(source);
        const version = versions.find((v) => monthIndex(v.fromYear, v.fromMonth) <= monthIndex(from.year, from.month));
        if (!version) {
          // Newest first: the last is where they start.
          const first = versions.at(-1);
          throw new Error(
            first
              ? t('ruleSetCategories.sourceStartsLater', { month: format.month(first.fromYear, first.fromMonth) })
              : t('ruleSetCategories.sourceEmpty'),
          );
        }
        const { payRoundingStep: _, ...own } = version.rules;
        rules = own;
      }
      const id = existing?.id ?? (await api.post<{ id: string }>(`/rule-sets/${ruleSetId}/variants`, { optionIds })).id;
      if (rules) await api.put(`/rule-sets/${id}/pay-rules/${from.year}/${from.month}`, rules);
      return { id, copied: rules !== null };
    },
    onSuccess: async ({ id, copied }) => {
      await queryClient.invalidateQueries({ queryKey: [...RULE_SETS_KEY, ruleSetId] });
      if (copied) toast.success(t('ruleSetCategories.copied'));
      navigate(`/settings/rule-sets/${ruleSetId}/combinations/${id}/pay-rules`);
    },
    onError: (error) => setFormError(error instanceof Error && !('status' in error) ? error.message : errorMessage(t, error)),
  });

  return (
    <Dialog open onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('ruleSetCategories.addRulesFor', { combination: label })}</DialogTitle>
          <DialogDescription>{t('ruleSetCategories.copyDescription')}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setFormError(undefined);
            save.mutate();
          }}
        >
          <FormError message={formError} />
          <Field id="copy-source" label={t('ruleSetCategories.startWith')}>
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger id="copy-source" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={EMPTY}>{t('ruleSetCategories.emptyForm')}</SelectItem>
                {combinations.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>{t('ruleSetCategories.copyCombination')}</SelectLabel>
                    {combinations.map((s) => (
                      <SelectItem key={s.path} value={s.path}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
                {ownRules.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>{t('ruleSetCategories.copyRuleSet')}</SelectLabel>
                    {ownRules.map((s) => (
                      <SelectItem key={s.path} value={s.path}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
          </Field>
          {source !== EMPTY && (
            <MonthField legend={t('payRules.from')} value={from} onChange={setFrom} hint={t('ruleSetCategories.copyMonthHint')} />
          )}
          <FormActions
            submitLabel={source === EMPTY ? t('ruleSetCategories.openForm') : t('ruleSetCategories.copyAndOpen')}
            pending={save.isPending}
            onCancel={onClose}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}
