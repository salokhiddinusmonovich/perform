import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Must name exactly what will be affected, e.g. "Worker ALIYEV ALI will be deactivated." */
  description: string;
  confirmLabel: string;
  /** Red confirm button for actions that remove or lock data. */
  destructive?: boolean;
  /**
   * May be async; the dialog stays disabled until it settles. On success it closes.
   * On failure it stays open and shows the standard error toast.
   */
  onConfirm: () => unknown;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = false,
  onConfirm,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);

  async function confirm() {
    setPending(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (error) {
      console.error(error);
      toast.error(t('states.actionFailed'));
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t('common.cancel')}</AlertDialogCancel>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={confirm}
            disabled={pending}
            aria-busy={pending}
          >
            {pending ? t('common.loading') : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
