import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, MoreHorizontal, Plus, Scale, Shapes } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { Field, FormActions, FormError, MonthField } from '@/components/form';
import { LoadingState } from '@/components/loading-state';
import { PageHeader } from '@/components/page-header';
import { RequireAccess } from '@/components/require-access';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
  inForceAndLater,
  orderedOptionIds,
  RULE_SETS_KEY,
  usePayCategories,
  useRuleSets,
  useRuleSetVariants,
  useUsedByLabel,
  type PayCategoriesItem,
  type RuleSetVariantItem,
} from '@/lib/rule-sets';

interface YearMonth {
  year: number;
  month: number;
}

const monthIndex = (year: number, month: number) => year * 12 + month - 1;

/** The set's combination with exactly these options, if it has been added. */
const variantOf = (variants: readonly RuleSetVariantItem[], optionIds: readonly string[]) =>
  variants.find((v) => v.options.length === optionIds.length && optionIds.every((id) => v.options.some((o) => o.optionId === id)));

/**
 * A rule set (AGENTS.md: Pay rule sets): the rules of each combination of the company's pay
 * categories, for the categories in force now and those chosen from a later month. Owners and
 * admins add and change them; accountants look.
 */
export function RuleSetPage() {
  const { t } = useTranslation();
  const { ruleSetId } = useParams<{ ruleSetId: string }>();
  const set = useRuleSets().data?.find((s) => s.id === ruleSetId);
  const users = useUsedByLabel(set);
  return (
    <>
      <PageHeader
        title={set ? t('ruleSetCategories.title', { name: set.name }) : t('ruleSets.title')}
        description={users ? t('ruleSets.usedBy', { names: users }) : t('ruleSets.notUsed')}
      />
      <RequireAccess allowed={canViewPayRules}>{(me) => <CombinationsView me={me} ruleSetId={ruleSetId!} />}</RequireAccess>
    </>
  );
}

function CombinationsView({ me, ruleSetId }: { me: Me; ruleSetId: string }) {
  const { t } = useTranslation();
  const payCategories = usePayCategories();
  const variants = useRuleSetVariants(ruleSetId);
  const categories = useWorkerCategories();

  if (payCategories.isPending || variants.isPending || categories.isPending) return <LoadingState />;
  if (payCategories.isError || variants.isError || categories.isError) {
    return <ErrorState onRetry={() => Promise.all([payCategories.refetch(), variants.refetch(), categories.refetch()])} />;
  }

  const { inForce, later } = inForceAndLater(payCategories.data, currentMonth());
  const live = [...(inForce ? [inForce] : []), ...later];
  // Each kind of choice once, from its first month.
  const kinds = [...new Map(live.map((c) => [[...c.categoryIds].sort().join(','), c])).values()];

  if (kinds.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Shapes}
          title={t('ruleSetCategories.noPayCategoriesTitle')}
          description={t('ruleSetCategories.noPayCategoriesDescription')}
          action={
            <Button variant="outline" asChild>
              <Link to="/settings/pay-rules">{t('payRules.title')}</Link>
            </Button>
          }
        />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {kinds.map((choice) => (
        <Combinations
          key={choice.categoryIds.join(',')}
          ruleSetId={ruleSetId}
          choice={choice}
          categories={categories.data}
          variants={variants.data}
          manages={canManageCompany(me)}
        />
      ))}
    </div>
  );
}

/** Every combination of the pay categories' options, with its rules or the lack of them. */
function Combinations({
  ruleSetId,
  choice,
  categories,
  variants,
  manages,
}: {
  ruleSetId: string;
  choice: PayCategoriesItem;
  categories: readonly WorkerCategoryItem[];
  variants: readonly RuleSetVariantItem[];
  manages: boolean;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const [adding, setAdding] = useState<string[] | null>(null);
  // In the order of their names, as every page shows a combination.
  const choiceCategories = categories.filter((c) => choice.categoryIds.includes(c.id));
  const combinations = choiceCategories.reduce<string[][]>((acc, c) => acc.flatMap((prefix) => c.options.map((o) => [...prefix, o.id])), [[]]);
  const missing = combinations.filter((ids) => !variantOf(variants, ids)?.rulesFrom).length;

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">
          {t('ruleSetCategories.combinationsTitle', { categories: choiceCategories.map((c) => c.name).join(' × ') })}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('ruleSets.fromMonth', { month: format.month(choice.fromYear, choice.fromMonth) })}.{' '}
          {missing > 0 ? t('ruleSetCategories.missing', { count: missing }) : t('ruleSetCategories.combinationsHint')}
        </p>
      </div>
      <Card>
        <CardContent className="divide-y p-0">
          {combinations.map((ids) => {
            const variant = variantOf(variants, ids);
            const closed = ids.some((id) => categories.flatMap((c) => c.options).find((o) => o.id === id)?.isActive === false);
            const label = combinationLabel(categories, ids);
            const base = variant && `/settings/rule-sets/${ruleSetId}/combinations/${variant.id}`;
            return (
              <div key={ids.join(',')} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  {variant?.rulesFrom ? (
                    <Link to={`${base}/pay-rules`} className="font-medium underline-offset-4 hover:underline">
                      {label}
                    </Link>
                  ) : (
                    <span className="font-medium">{label}</span>
                  )}
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
          choice={choice}
          categories={categories}
          existing={variantOf(variants, adding) ?? null}
          onClose={() => setAdding(null)}
        />
      )}
    </section>
  );
}

/** "Start from an empty form" in the add-rules dialog; can't be mistaken for a path. */
const EMPTY = 'empty';

/**
 * Gives a combination its first rules: an empty form, or a copy of the rules of a month of
 * another combination, of this rule set or any other. Then opens them to fill in or change
 * what differs.
 */
function CopyRulesDialog({
  ruleSetId,
  optionIds,
  label,
  choice,
  categories,
  existing,
  onClose,
}: {
  ruleSetId: string;
  optionIds: string[];
  label: string;
  choice: PayCategoriesItem;
  categories: readonly WorkerCategoryItem[];
  existing: RuleSetVariantItem | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sets = useRuleSets().data ?? [];
  // This set first, then the others by name.
  const ordered = [...sets].sort((a, b) => (a.id === ruleSetId ? -1 : b.id === ruleSetId ? 1 : a.name.localeCompare(b.name)));
  const variantsOfSets = useQueries({
    queries: ordered.map((s) => ({
      queryKey: [...RULE_SETS_KEY, s.id, 'variants'],
      queryFn: () => api.get<RuleSetVariantItem[]>(`/rule-sets/${s.id}/variants`),
    })),
  });
  // Every combination with rules, grouped by its set.
  const sources = ordered
    .map((s, i) => ({
      set: s,
      combinations: (variantsOfSets[i].data ?? [])
        .filter((v) => v.rulesFrom && v.id !== existing?.id)
        .map((v) => ({ path: `/rule-sets/${v.id}/pay-rules`, label: combinationLabel(categories, orderedOptionIds(categories, v)) })),
    }))
    .filter((g) => g.combinations.length > 0);
  const [from, setFrom] = useState<YearMonth>({ year: choice.fromYear, month: choice.fromMonth });
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
        rules = version.rules;
      }
      const id = existing?.id ?? (await api.post<{ id: string }>(`/rule-sets/${ruleSetId}/variants`, { optionIds })).id;
      if (rules) await api.put(`/rule-sets/${id}/pay-rules/${from.year}/${from.month}`, rules);
      return { id, copied: rules !== null };
    },
    onSuccess: async ({ id, copied }) => {
      await queryClient.invalidateQueries({ queryKey: RULE_SETS_KEY });
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
                {sources.map((g) => (
                  <SelectGroup key={g.set.id}>
                    <SelectLabel>{t('ruleSetCategories.copyFrom', { name: g.set.name })}</SelectLabel>
                    {g.combinations.map((c) => (
                      <SelectItem key={c.path} value={c.path}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
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
