import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ErrorState } from '@/components/error-state';
import { FormActions, FormError } from '@/components/form';
import { LoadingState } from '@/components/loading-state';
import { MonthPicker } from '@/components/month-picker';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useFormat } from '@/hooks/use-format';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { RULE_SETS_KEY, useRuleSets } from '@/lib/rule-sets';

interface Use {
  fromYear: number;
  fromMonth: number;
  ruleSet: { id: string; name: string | null } | null;
  setBy: { fullName: string };
  setAt: string;
}

const NONE = 'none';

/** Which rule set a site or firm uses, from a month on (AGENTS.md: Pay rule sets). */
export function RuleSetUseDialog({
  owner,
  name,
  canChange,
  onClose,
}: {
  owner: { kind: 'sites' | 'firms'; id: string };
  name: string;
  canChange: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const queryClient = useQueryClient();
  const base = `/${owner.kind}/${owner.id}/rule-set`;
  const key = ['rule-set-uses', owner.id];
  const uses = useQuery({ queryKey: key, queryFn: () => api.get<Use[]>(base) });
  const sets = useRuleSets();
  const [from, setFrom] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  });
  const [choice, setChoice] = useState(NONE);
  const [formError, setFormError] = useState<string>();
  const [removing, setRemoving] = useState<Use | null>(null);

  const noneLabel = owner.kind === 'firms' ? t('ruleSets.noneFirm') : t('ruleSets.noneSite');
  const refresh = () =>
    Promise.all([queryClient.invalidateQueries({ queryKey: key }), queryClient.invalidateQueries({ queryKey: RULE_SETS_KEY })]);

  const save = useMutation({
    mutationFn: () => api.put(`${base}/${from.year}/${from.month}`, { ruleSetId: choice === NONE ? null : choice }),
    onSuccess: async () => {
      setFormError(undefined);
      toast.success(t('common.saved'));
      await refresh();
    },
    onError: (error) => setFormError(errorMessage(t, error)),
  });

  const selectable = sets.data?.filter((s) => s.name !== null && s.isActive) ?? [];

  return (
    <Dialog open onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('ruleSets.useTitle', { name })}</DialogTitle>
          <DialogDescription>{t('ruleSets.useDescription')}</DialogDescription>
        </DialogHeader>
        {uses.isPending || sets.isPending ? (
          <LoadingState />
        ) : uses.isError || sets.isError ? (
          <ErrorState onRetry={() => void refresh()} />
        ) : (
          <div className="space-y-6">
            {uses.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">{noneLabel}</p>
            ) : (
              <ul className="divide-y divide-border">
                {uses.data.map((u) => (
                  <li key={`${u.fromYear}-${u.fromMonth}`} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div className="font-medium">{u.ruleSet?.name ?? noneLabel}</div>
                      <div className="text-sm text-muted-foreground">
                        {t('ruleSets.fromMonth', { month: format.month(u.fromYear, u.fromMonth) })} · {u.setBy.fullName}
                      </div>
                    </div>
                    {canChange && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('ruleSets.removeUse', { month: format.month(u.fromYear, u.fromMonth) })}
                        onClick={() => setRemoving(u)}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canChange && (
              <form
                className="space-y-4"
                noValidate
                onSubmit={(e) => {
                  e.preventDefault();
                  save.mutate();
                }}
              >
                <FormError message={formError} />
                <div className="space-y-1.5">
                  <Label>{t('payRules.appliesFrom')}</Label>
                  <MonthPicker value={from} onChange={setFrom} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rule-set-choice">{t('ruleSets.ruleSet')}</Label>
                  <Select value={choice} onValueChange={setChoice}>
                    <SelectTrigger id="rule-set-choice" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>{noneLabel}</SelectItem>
                      {selectable.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-sm text-muted-foreground">
                    <Link to="/settings/rule-sets" className="underline underline-offset-4">
                      {t('ruleSets.manageLink')}
                    </Link>
                  </p>
                </div>
                <FormActions submitLabel={t('common.save')} pending={save.isPending} onCancel={onClose} />
              </form>
            )}
          </div>
        )}
        <ConfirmDialog
          open={removing !== null}
          onOpenChange={(open) => !open && setRemoving(null)}
          title={t('ruleSets.confirmRemoveUse.title')}
          description={
            removing
              ? t('ruleSets.confirmRemoveUse.description', {
                  name,
                  month: format.month(removing.fromYear, removing.fromMonth),
                })
              : ''
          }
          confirmLabel={t('ruleSets.confirmRemoveUse.confirm')}
          destructive
          onConfirm={async () => {
            if (!removing) return;
            await api.delete(`${base}/${removing.fromYear}/${removing.fromMonth}`);
            toast.success(t('common.saved'));
            await refresh();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
