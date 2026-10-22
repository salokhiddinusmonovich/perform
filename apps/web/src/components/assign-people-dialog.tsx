import type { Role } from '@puantaj/schemas';
import { UserMinus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Field } from '@/components/form';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { errorMessage } from '@/lib/errors';

export interface Person {
  userId: string;
  fullName: string;
  role: Role;
}

interface AssignPeopleDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  /** People assigned now */
  assigned: Person[];
  /** People who may be added (already-assigned ones are left out here) */
  candidates: Person[];
  /** May this person be removed by the current user? */
  canRemove: (person: Person) => boolean;
  onAdd: (userId: string) => Promise<unknown>;
  onRemove: (userId: string) => Promise<unknown>;
}

/**
 * Who works on a site or leads a team: the list with remove buttons, and a picker to
 * add someone. The same dialog for site staff and team foremen.
 */
export function AssignPeopleDialog({
  open,
  onClose,
  title,
  description,
  assigned,
  candidates,
  canRemove,
  onAdd,
  onRemove,
}: AssignPeopleDialogProps) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState('');
  const [pending, setPending] = useState(false);
  const available = candidates.filter((c) => !assigned.some((a) => a.userId === c.userId));

  async function run(action: () => Promise<unknown>) {
    setPending(true);
    try {
      await action();
      toast.success(t('common.saved'));
    } catch (error) {
      toast.error(errorMessage(t, error));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !pending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {assigned.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('sites.nobodyAssigned')}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {assigned.map((person) => (
              <li key={person.userId} className="flex items-center justify-between gap-2 px-3 py-1.5">
                <div className="min-w-0">
                  <div className="truncate font-medium">{person.fullName}</div>
                  <div className="text-sm text-muted-foreground">{t(`roles.${person.role}`)}</div>
                </div>
                {canRemove(person) && (
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={pending}
                    onClick={() => run(() => onRemove(person.userId))}
                    aria-label={t('sites.removePerson', { name: person.fullName })}
                  >
                    <UserMinus aria-hidden />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (!picked) return;
            void run(async () => {
              await onAdd(picked);
              setPicked('');
            });
          }}
        >
          <div className="flex-1">
            <Field id="assign-person" label={t('sites.addPerson')} hint={available.length === 0 ? t('sites.noCandidates') : undefined}>
              <Select value={picked} onValueChange={setPicked} disabled={available.length === 0}>
                <SelectTrigger id="assign-person" className="w-full">
                  <SelectValue placeholder={t('sites.choosePerson')} />
                </SelectTrigger>
                <SelectContent>
                  {available.map((person) => (
                    <SelectItem key={person.userId} value={person.userId}>
                      {person.fullName} · {t(`roles.${person.role}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Button type="submit" disabled={!picked || pending}>
            {t('sites.assign')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
