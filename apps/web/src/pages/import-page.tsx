import {
  BLANK_CELL_READINGS,
  EMPLOYMENT_TYPES,
  HOURS_IMPORT_REQUIRED,
  IMPORT_FIELDS,
  WORKER_IMPORT_REQUIRED,
  type BlankCellReading,
  type EmploymentType,
  type ImportField,
  type ImportMapping,
  type YearMonth,
} from '@puantaj/schemas';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { FileSpreadsheet, Info, RefreshCw, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable } from '@/components/data-table';
import { Field } from '@/components/form';
import { LoadingState } from '@/components/loading-state';
import { MonthSwitcher } from '@/components/month-switcher';
import { PageHeader } from '@/components/page-header';
import { RequireAccess } from '@/components/require-access';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useFormat } from '@/hooks/use-format';
import { canEnterMonthlyHours, canManageCompany, type Me } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import {
  importHours,
  importWorkers,
  previewImport,
  type ImportPreview,
  type ImportProblem,
  type ImportRequest,
  type ImportWorkerChange,
} from '@/lib/imports';
import { WORKERS_KEY } from '@/lib/organisation';
import { currentMonth, PAYROLL_KEY } from '@/lib/payroll';

/** Select value for "this field has no column in the file". */
const NONE = '__none';

export function ImportPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('import.title')} description={t('import.description')} />
      <RequireAccess allowed={canEnterMonthlyHours}>{(me) => <ImportView me={me} />}</RequireAccess>
    </>
  );
}

function ImportView({ me }: { me: Me }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [month, setMonth] = useState<YearMonth>(currentMonth);
  const [file, setFile] = useState<File | null>(null);
  const [sheet, setSheet] = useState<string | undefined>(undefined);
  /** The mapping shown; changed by the user until they check the file again with it */
  const [mapping, setMapping] = useState<ImportMapping | undefined>(undefined);
  const [changed, setChanged] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [confirm, setConfirm] = useState<'workers' | 'hours' | null>(null);

  const check = useMutation({
    mutationFn: (request: ImportRequest) => previewImport(request),
    onSuccess: (data) => {
      setPreview(data);
      setMapping(data.mapping);
      setChanged(false);
    },
    onError: (error) => {
      setPreview(null);
      toast.error(errorMessage(t, error));
    },
  });

  const request = (overrides: Partial<ImportRequest> = {}): ImportRequest | null => {
    const f = overrides.file ?? file;
    return f ? { file: f, month, sheet, mapping, ...overrides } : null;
  };
  const run = (overrides: Partial<ImportRequest> = {}) => {
    const r = request(overrides);
    if (r) check.mutate(r);
  };

  const choose = (f: File | null) => {
    setFile(f);
    setSheet(undefined);
    setPreview(null);
    if (f) run({ file: f, sheet: undefined, mapping: undefined });
  };

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: WORKERS_KEY }),
      queryClient.invalidateQueries({ queryKey: PAYROLL_KEY }),
    ]);
    run();
  };

  const departments = me.activeCompany?.departments ?? false;
  const firms = me.activeCompany?.firms ?? false;
  const fields = IMPORT_FIELDS.filter((f) => (f !== 'department' || departments) && (f !== 'firm' || firms));
  const ready = preview !== null && !changed && !check.isPending;

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-4">
            <Field id="import-month" label={t('common.month')}>
              <MonthSwitcher
                value={month}
                onChange={(m) => {
                  setMonth(m);
                  const r = request();
                  if (r) check.mutate({ ...r, month: m });
                }}
              />
            </Field>
            <div className="min-w-64 flex-1">
              <Field id="import-file" label={t('import.file')} hint={t('import.fileHint')}>
                <Input
                  id="import-file"
                  type="file"
                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={(e) => choose(e.target.files?.[0] ?? null)}
                />
              </Field>
            </div>
            {preview && preview.sheetNames.length > 1 && (
              <Field id="import-sheet" label={t('import.sheet')}>
                <Select
                  value={preview.sheet ?? undefined}
                  onValueChange={(s) => {
                    setSheet(s);
                    run({ sheet: s });
                  }}
                >
                  <SelectTrigger id="import-sheet" className="min-w-48">
                    <SelectValue placeholder={t('import.chooseSheet')} />
                  </SelectTrigger>
                  <SelectContent>
                    {preview.sheetNames.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          </div>
          {!file && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <FileSpreadsheet className="size-4" aria-hidden />
              {t('import.chooseFile')}
            </p>
          )}
        </CardContent>
      </Card>

      {check.isPending && !preview && <LoadingState />}

      {preview && mapping && (
        <>
          {preview.locked && (
            <Alert variant="warning">
              <TriangleAlert aria-hidden />
              <AlertTitle>{t('import.lockedTitle')}</AlertTitle>
              <AlertDescription>{t('import.lockedDescription')}</AlertDescription>
            </Alert>
          )}

          {preview.sheet && (
            <MappingCard
              preview={preview}
              fields={fields}
              mapping={mapping}
              changed={changed}
              pending={check.isPending}
              onChange={(next) => {
                setMapping(next);
                setChanged(true);
              }}
              onCheck={() => run()}
            />
          )}

          <Card>
            <CardHeader>
              <CardTitle>{t('import.workersTitle')}</CardTitle>
              <CardDescription>{t('import.workersDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <StatusBadge tone="neutral">{t('import.rows', { count: preview.workers.rows })}</StatusBadge>
                <StatusBadge tone={preview.workers.new > 0 ? 'info' : 'neutral'}>
                  {t('import.newWorkers', { count: preview.workers.new })}
                </StatusBadge>
                <StatusBadge tone="success">{t('import.existingWorkers', { count: preview.workers.existing })}</StatusBadge>
              </div>
              <Problems problems={preview.workers.problems} />
              {preview.workers.notes.length > 0 && <Problems problems={preview.workers.notes} notes />}
              {preview.workers.changes.length > 0 && (
                <Changes changes={preview.workers.changes} currency={me.activeCompany?.currency ?? 'UZS'} />
              )}
              {canManageCompany(me) ? (
                <div className="flex justify-end">
                  <Button
                    disabled={!ready || preview.workers.problems.length > 0 || preview.workers.new === 0}
                    onClick={() => setConfirm('workers')}
                  >
                    {t('import.addWorkers', { count: preview.workers.new })}
                  </Button>
                </div>
              ) : (
                preview.workers.new > 0 && <p className="text-sm text-muted-foreground">{t('import.workersByAdmin')}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('import.hoursTitle')}</CardTitle>
              <CardDescription>{t('import.hoursDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <StatusBadge tone={preview.hours.workers > 0 ? 'info' : 'neutral'}>
                  {t('import.workerMonths', { count: preview.hours.workers })}
                </StatusBadge>
                {preview.hours.replaces > 0 && (
                  <StatusBadge tone="warning">{t('import.replaces', { count: preview.hours.replaces })}</StatusBadge>
                )}
                {preview.hours.overwritesEdits > 0 && (
                  <StatusBadge tone="warning">{t('import.overwritesEdits', { count: preview.hours.overwritesEdits })}</StatusBadge>
                )}
              </div>
              <Problems problems={preview.hours.problems} />
              {preview.hours.notes.length > 0 && <Problems problems={preview.hours.notes} notes />}
              <div className="flex justify-end">
                <Button
                  disabled={!ready || preview.locked || preview.hours.problems.length > 0 || preview.hours.workers === 0}
                  onClick={() => setConfirm('hours')}
                >
                  {t('import.importHours', { count: preview.hours.workers })}
                </Button>
              </div>
              {preview.earlier.length > 0 && <Earlier earlier={preview.earlier} />}
            </CardContent>
          </Card>

          <ConfirmDialog
            open={confirm === 'workers'}
            onOpenChange={(open) => !open && setConfirm(null)}
            title={t('import.addWorkersTitle')}
            description={t('import.addWorkersConfirm', { count: preview.workers.new, file: preview.fileName })}
            confirmLabel={t('import.addWorkers', { count: preview.workers.new })}
            onConfirm={async () => {
              const done = await importWorkers(request()!);
              toast.success(t('import.workersAdded', { count: done.created }));
              await refresh();
            }}
          />
          <ConfirmDialog
            open={confirm === 'hours'}
            onOpenChange={(open) => !open && setConfirm(null)}
            title={t('import.importHoursTitle')}
            description={[
              preview.hours.replaces > 0
                ? t('import.importHoursReplaceConfirm', {
                    count: preview.hours.workers,
                    replaces: preview.hours.replaces,
                    file: preview.fileName,
                  })
                : t('import.importHoursConfirm', { count: preview.hours.workers, file: preview.fileName }),
              ...(preview.hours.overwritesEdits > 0
                ? [t('import.overwritesEditsConfirm', { count: preview.hours.overwritesEdits })]
                : []),
            ].join(' ')}
            confirmLabel={t('import.importHours', { count: preview.hours.workers })}
            onConfirm={async () => {
              const done = await importHours(request()!);
              toast.success(t('import.hoursImported', { count: done.workers }));
              await refresh();
            }}
          />
        </>
      )}
    </div>
  );
}

function MappingCard({
  preview,
  fields,
  mapping,
  changed,
  pending,
  onChange,
  onCheck,
}: {
  preview: ImportPreview;
  fields: readonly ImportField[];
  mapping: ImportMapping;
  changed: boolean;
  pending: boolean;
  onChange: (mapping: ImportMapping) => void;
  onCheck: () => void;
}) {
  const { t } = useTranslation();
  const required = new Set<ImportField>([...WORKER_IMPORT_REQUIRED, ...HOURS_IMPORT_REQUIRED]);
  const setColumn = (field: ImportField, header: string) => {
    const columns = { ...mapping.columns };
    if (header === NONE) delete columns[field];
    else columns[field] = header;
    onChange({ ...mapping, columns });
  };
  const setValue = (value: string, type: EmploymentType) =>
    onChange({ ...mapping, values: { employmentType: { ...mapping.values.employmentType, [value]: type } } });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('import.columnsTitle')}</CardTitle>
        <CardDescription>
          {t('import.columnsDescription', { row: preview.headerRow, days: preview.days.length })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {preview.mappingSaved && !changed && (
          <Alert>
            <Info aria-hidden />
            <AlertDescription>{t('import.mappingSaved')}</AlertDescription>
          </Alert>
        )}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {fields.map((field) => {
            const id = `import-column-${field}`;
            return (
              <Field
                key={field}
                id={id}
                label={required.has(field) ? t('import.requiredField', { field: t(`import.fields.${field}`) }) : t(`import.fields.${field}`)}
              >
                <Select value={mapping.columns[field] ?? NONE} onValueChange={(v) => setColumn(field, v)}>
                  <SelectTrigger id={id} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t('import.notInFile')}</SelectItem>
                    {preview.headers.map((h) => (
                      <SelectItem key={h} value={h}>
                        {h}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            );
          })}
        </div>
        {mapping.columns.employmentType !== undefined && preview.values.employmentType.length > 0 && (
          <section className="space-y-3 border-t pt-4">
            <div>
              <h3 className="font-semibold">{t('import.valuesTitle')}</h3>
              <p className="text-sm text-muted-foreground">{t('import.valuesDescription')}</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {preview.values.employmentType.map((value) => {
                const id = `import-value-${value}`;
                return (
                  <Field key={value} id={id} label={value}>
                    <Select
                      value={mapping.values.employmentType[value] ?? undefined}
                      onValueChange={(v) => setValue(value, v as EmploymentType)}
                    >
                      <SelectTrigger id={id} className="w-full">
                        <SelectValue placeholder={t('workers.chooseEmploymentType')} />
                      </SelectTrigger>
                      <SelectContent>
                        {EMPLOYMENT_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            {t(`workers.employment.${type}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                );
              })}
            </div>
          </section>
        )}
        <section className="space-y-3 border-t pt-4">
          <Field id="import-blank-cells" label={t('import.blankCells')} hint={t('import.blankCellsHint')}>
            <Select
              value={mapping.blankCells}
              onValueChange={(v) => onChange({ ...mapping, blankCells: v as BlankCellReading })}
            >
              <SelectTrigger id="import-blank-cells" className="w-full sm:w-96">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BLANK_CELL_READINGS.map((reading) => (
                  <SelectItem key={reading} value={reading}>
                    {t(`import.blankCellReadings.${reading}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </section>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {changed && <p className="text-sm text-muted-foreground">{t('import.checkAgainHint')}</p>}
          <Button variant={changed ? 'default' : 'outline'} onClick={onCheck} disabled={pending}>
            <RefreshCw aria-hidden />
            {t('import.checkAgain')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** A problem as the user reads it: what is wrong, with the field, the file's value and the days. */
function useProblemText() {
  const { t } = useTranslation();
  return (p: ImportProblem) => {
    const field = p.field ? t(`import.fields.${p.field}`) : '';
    const message = p.code.startsWith('validation.') ? t(p.code) : t(`errors.${p.code}`, { field, value: p.value ?? '' });
    return [
      p.field && !message.includes(field) ? `${field}: ${message}` : message,
      p.value !== undefined && p.value !== '' && !message.includes(p.value) ? t('import.fileValue', { value: p.value }) : null,
      p.days && p.days.length > 0 ? t('import.days', { days: p.days.join(', ') }) : null,
    ]
      .filter(Boolean)
      .join(' · ');
  };
}

/** Problem rows, or with `notes` what the import read differently from the file's columns (never blocking). */
function Problems({ problems, notes = false }: { problems: ImportProblem[]; notes?: boolean }) {
  const { t } = useTranslation();
  const text = useProblemText();
  const columns = useMemo<ColumnDef<ImportProblem, unknown>[]>(
    () => [
      {
        id: 'row',
        accessorFn: (p) => p.row ?? 0,
        header: t('import.row'),
        cell: ({ row }) => <span className="tabular-nums">{row.original.row ?? t('import.wholeFile')}</span>,
      },
      {
        id: 'worker',
        accessorFn: (p) => [p.employeeNumber, p.name].filter(Boolean).join(' '),
        header: t('import.worker'),
        cell: ({ row }) => (
          <div className="min-w-36">
            <div className="font-medium">{row.original.name ?? '—'}</div>
            {row.original.employeeNumber && (
              <div className="text-sm text-muted-foreground">
                {t('workers.employeeNumberShort', { number: row.original.employeeNumber })}
              </div>
            )}
          </div>
        ),
      },
      {
        id: 'problem',
        accessorFn: (p) => text(p),
        header: notes ? t('import.note') : t('import.problem'),
        enableSorting: false,
        cell: ({ row }) => <div className="min-w-56">{text(row.original)}</div>,
      },
    ],
    [t, text, notes],
  );
  if (problems.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm">
        <StatusBadge tone="success">{t('import.noProblems')}</StatusBadge>
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {notes ? (
        <div>
          <StatusBadge tone="info">{t('import.noteCount', { count: problems.length })}</StatusBadge>
          <p className="mt-1 text-sm text-muted-foreground">{t('import.notesDescription')}</p>
        </div>
      ) : (
        <StatusBadge tone="danger">{t('import.problemCount', { count: problems.length })}</StatusBadge>
      )}
      <DataTable columns={columns} data={problems} searchable />
    </div>
  );
}

function Changes({ changes, currency }: { changes: ImportWorkerChange[]; currency: string }) {
  const { t } = useTranslation();
  const format = useFormat();
  const columns = useMemo<ColumnDef<ImportWorkerChange, unknown>[]>(() => {
    const show = (c: ImportWorkerChange, value: string | null) =>
      value === null
        ? '—'
        : c.field === 'leftOn'
          ? format.date(value)
          : c.field === 'salary'
            ? format.money(value, currency)
            : value;
    return [
      {
        id: 'worker',
        accessorFn: (c) => `${c.employeeNumber} ${c.name}`,
        header: t('import.worker'),
        cell: ({ row }) => (
          <div className="min-w-36">
            <div className="font-medium">{row.original.name}</div>
            <div className="text-sm text-muted-foreground">
              {t('workers.employeeNumberShort', { number: row.original.employeeNumber })}
            </div>
          </div>
        ),
      },
      {
        id: 'field',
        accessorFn: (c) => t(`import.fields.${c.field}`),
        header: t('import.field'),
      },
      { id: 'app', header: t('import.inApp'), enableSorting: false, cell: ({ row }) => show(row.original, row.original.app) },
      { id: 'file', header: t('import.inFile'), enableSorting: false, cell: ({ row }) => show(row.original, row.original.file) },
    ];
  }, [t, format, currency]);
  return (
    <section className="space-y-2">
      <div>
        <h3 className="font-semibold">{t('import.changesTitle')}</h3>
        <p className="text-sm text-muted-foreground">{t('import.changesDescription')}</p>
      </div>
      <DataTable columns={columns} data={changes} searchable />
    </section>
  );
}

function Earlier({ earlier }: { earlier: ImportPreview['earlier'] }) {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <section className="space-y-2 border-t pt-4">
      <h3 className="font-semibold">{t('import.earlierTitle')}</h3>
      <ul className="space-y-1 text-sm">
        {earlier.map((e) => (
          <li key={e.id}>
            {t('import.earlierLine', {
              file: e.fileName,
              when: `${format.date(e.createdAt)} ${format.time(e.createdAt)}`,
              who: e.createdBy.fullName,
              count: e.workers,
            })}
          </li>
        ))}
      </ul>
    </section>
  );
}
