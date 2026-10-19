import { CircleCheck, CircleDashed, CircleX, Info, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * Status colours mean the same thing on every page (AGENTS.md):
 * success = ok/worked, danger = absent/error, warning = pending, info = leave/info.
 * The icon and the label make the status readable without colour.
 */
export type StatusTone = 'success' | 'danger' | 'warning' | 'info' | 'neutral';

const TONES: Record<StatusTone, { icon: LucideIcon; className: string }> = {
  success: { icon: CircleCheck, className: 'bg-success text-success-foreground' },
  danger: { icon: CircleX, className: 'bg-destructive text-destructive-foreground' },
  warning: { icon: TriangleAlert, className: 'bg-warning text-warning-foreground' },
  info: { icon: Info, className: 'bg-info text-info-foreground' },
  neutral: { icon: CircleDashed, className: 'bg-muted text-muted-foreground' },
};

interface StatusBadgeProps {
  tone: StatusTone;
  children: ReactNode;
}

export function StatusBadge({ tone, children }: StatusBadgeProps) {
  const { icon: Icon, className } = TONES[tone];
  return (
    <Badge className={cn('gap-1 border-transparent', className)}>
      <Icon aria-hidden />
      {children}
    </Badge>
  );
}
