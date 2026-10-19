import { Check, Copy, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface TemporaryPasswordDialogProps {
  /** null = closed */
  password: string | null;
  /** Whose password it is, e.g. their name and phone */
  forWhom: string;
  onClose: () => void;
}

/**
 * Shows a one-time password exactly once. The app never stores it in readable form,
 * so the admin must pass it on now; the person must change it at first login.
 */
export function TemporaryPasswordDialog({ password, forWhom, onClose }: TemporaryPasswordDialogProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      // Clipboard blocked: the password is still visible to copy by hand.
    }
  }

  return (
    <Dialog
      open={password !== null}
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false);
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-5" aria-hidden />
            {t('tempPassword.title')}
          </DialogTitle>
          <DialogDescription>{t('tempPassword.description', { name: forWhom })}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <code
            className="flex-1 rounded-md border bg-muted px-3 py-2 text-center font-mono text-lg tracking-wider select-all"
            translate="no"
          >
            {password}
          </code>
          <Button variant="outline" size="icon" onClick={copy} aria-label={t('tempPassword.copy')}>
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{t('tempPassword.warning')}</p>
        <DialogFooter>
          <Button onClick={onClose}>{t('tempPassword.done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
