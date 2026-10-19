import { ROLES, type Role } from '@puantaj/schemas';
import { useTranslation } from 'react-i18next';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface RoleSelectProps {
  id: string;
  value: Role | undefined;
  onChange: (role: Role) => void;
  /** Roles the current user may not grant (e.g. OWNER for admins) */
  disabledRoles?: Role[];
  invalid?: boolean;
}

/** Role picker. Pair it with `roleHint()` as the field hint to explain the chosen role. */
export function RoleSelect({ id, value, onChange, disabledRoles = [], invalid }: RoleSelectProps) {
  const { t } = useTranslation();
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Role)}>
      <SelectTrigger id={id} className="w-full" aria-invalid={invalid || undefined}>
        <SelectValue placeholder={t('roles.choose')} />
      </SelectTrigger>
      <SelectContent>
        {ROLES.map((role) => (
          <SelectItem key={role} value={role} disabled={disabledRoles.includes(role)}>
            {t(`roles.${role}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** One-line explanation of what a role may do. */
export function useRoleHint() {
  const { t } = useTranslation();
  return (role: Role | undefined) => (role ? t(`roles.hint.${role}`) : undefined);
}
