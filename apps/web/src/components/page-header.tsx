import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

interface PageHeaderProps {
  title: string;
  description?: string;
  /** Primary and secondary actions, rendered on the right (below the title on phones). */
  actions?: ReactNode;
}

/** Title area every page starts with. Also sets the browser tab title. */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  const { t } = useTranslation();

  useEffect(() => {
    document.title = `${title} · ${t('app.name')}`;
  }, [title, t]);

  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 sm:justify-end">{actions}</div>}
    </div>
  );
}
