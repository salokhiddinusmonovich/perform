import type { PayLine } from '@puantaj/payroll';
import type { useTranslation } from 'react-i18next';
import type { useFormat } from '@/hooks/use-format';
import type { WorkerCategoryItem } from './organisation';
import type { PayrollPart, PayrollPayOut, PayrollProblem, PayrollWorker } from './payroll';

// The words of a payslip, shared by the payslip window and the Excel export, so both say the same.

export type Translate = ReturnType<typeof useTranslation>['t'];
export type Formatters = ReturnType<typeof useFormat>;

/** One amount of a payslip, as the payslip window lists it. */
export function payLineText(line: PayLine, t: Translate, format: Formatters, currency: string): string {
  switch (line.type) {
    case 'HOURS':
      return t('payroll.lines.hours', {
        kind: t(`payroll.hourKinds.${line.kind}`),
        hours: format.number(line.hours),
        multiplier: format.number(line.multiplier),
      });
    case 'ABSENCE':
      return line.paid
        ? t('payroll.lines.absencePaid', {
            absence: t(`payroll.absences.${line.absence}`),
            count: line.days,
            hours: format.number(line.hoursPerDay),
          })
        : t('payroll.lines.absenceUnpaid', { absence: t(`payroll.absences.${line.absence}`), count: line.days });
    case 'TRAVEL_PER_DAY':
      return line.route
        ? t('payroll.lines.travelPerDay', { route: line.route, count: line.days, amount: format.money(line.amountPerDay, currency) })
        : t('payroll.lines.travelNoRoute', { count: line.days });
    case 'TRAVEL_MONTHLY':
      return t('payroll.lines.travelMonthly');
  }
}

/** The site a line is charged to, with the day its placement starts when that is inside the month. */
export function placeText(part: PayrollPart, key: string, t: Translate, format: Formatters): string {
  const p = part.places[key];
  if (!p) return key;
  return p.from ? `${p.siteName} (${t('monthlyHours.fromDay', { date: format.date(p.from) })})` : p.siteName;
}

/** A part's rules, combination, days and shift, e.g. "Under the rules of “Site A” · Direkt + Expat · 1.03 – 15.03". */
export function partHeading(part: PayrollPart, t: Translate, format: Formatters): string {
  return [
    part.ruleSetName ? t('payroll.ruleSetRules', { name: part.ruleSetName }) : t('payroll.defaultRules'),
    part.combination?.map((c) => c.optionName).join(' + '),
    part.days && t('monthlyHours.fromUntil', { from: format.date(part.days.from), until: format.date(part.days.until) }),
    part.shift && t('workers.shiftWithHours', { name: part.shift.name, hours: format.number(part.shift.normalHoursPerDay) }),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** How a part's hourly rate was worked out. */
export function hourlyRateText(part: PayrollPart, t: Translate, format: Formatters, currency: string): string {
  const rate = part.result.hourlyRate;
  const text = t('payroll.hourlyRate', {
    salary: format.money(rate.monthlySalary, currency),
    days: rate.workingDays.effective,
    hours: format.number(rate.normalHoursPerDay),
    rate: format.money(rate.rounded, currency),
  });
  return rate.workingDays.override !== null
    ? `${text} ${t('payroll.workingDaysOverridden', { calculated: rate.workingDays.calculated })}`
    : text;
}

/** From earned pay to the amount to pay out: the adjustments and the one rounding, each signed. */
export function payOutLines(
  payOut: PayrollPayOut,
  t: Translate,
  format: Formatters,
  currency: string,
): { key: string; label: string; note: string | null; amount: string }[] {
  return [
    ...payOut.adjustments.map((a) => ({ key: a.id, label: t(`adjustments.types.${a.type}`), note: a.note, amount: a.amount })),
    ...(payOut.rounding
      ? [
          {
            key: 'rounding',
            label: t('payroll.lines.rounding', { step: format.money(payOut.rounding.step, currency) }),
            note: null,
            amount: payOut.rounding.amount,
          },
        ]
      : []),
  ];
}

/** The worker's positions of the month, e.g. "Plumber (1.03 – 15.03), Electrician (16.03 – 31.03)"; empty when none is set. */
export function positionsText(worker: Pick<PayrollWorker, 'positions'>, t: Translate, format: Formatters): string {
  const positions = worker.positions ?? [];
  if (!positions.some((p) => p.name)) return '';
  if (positions.length === 1) return positions[0].name!;
  return positions
    .map((p) =>
      t('payroll.positionDays', {
        position: p.name ?? t('workers.noPosition'),
        days: t('monthlyHours.fromUntil', { from: format.date(p.from), until: format.date(p.until) }),
      }),
    )
    .join(', ');
}

/** Why a worker can't be paid: the sentence, and the details some problems list under it. */
export function problemText(
  problem: PayrollProblem,
  t: Translate,
  format: Formatters,
  categories: readonly WorkerCategoryItem[],
): { text: string; details: string[] } {
  const text = (value: string, details: string[] = []) => ({ text: value, details });
  switch (problem.code) {
    case 'noSalary':
      return text(problem.firmName ? t('payroll.problems.noSalaryInFirm', { firm: problem.firmName }) : t('payroll.problems.noSalary'));
    case 'placementWithoutHours':
      return text(
        problem.until
          ? t('payroll.problems.daysWithoutHours', { site: problem.siteName, from: format.date(problem.from), until: format.date(problem.until) })
          : t('payroll.problems.placementWithoutHours', { site: problem.siteName, date: format.date(problem.from) }),
      );
    case 'noRules':
      return text(t('payroll.problems.noRules', { sites: problem.siteNames.join(', ') }));
    case 'noPayCategories':
      return text(t('payroll.problems.noPayCategories', { rules: problem.ruleSetName }));
    case 'categoryNotSet':
      return text(
        t('payroll.problems.categoryNotSet', {
          rules: problem.ruleSetName,
          categories: problem.categoryIds.map((id) => categories.find((c) => c.id === id)?.name ?? '').join(', '),
        }),
      );
    case 'noCategoryRules':
      return text(
        t('payroll.problems.noCategoryRules', {
          rules: problem.ruleSetName,
          // In the order of their categories by name, as every page shows a combination.
          options: categories
            .flatMap((c) => c.options)
            .filter((o) => problem.optionIds.includes(o.id))
            .map((o) => o.name)
            .join(' + '),
        }),
      );
    case 'totalsInvalid':
      return text(
        t('payroll.problems.totalsInvalid'),
        problem.issues.map(
          (issue) => `${issue.siteName ?? t('payroll.allPlacements')}: ${t(`payroll.totalsProblems.${issue.problem}`)}`,
        ),
      );
    case 'invalidHours':
      return text(t('payroll.problems.invalidHours'), [problem.detail]);
    default:
      return text(t(`payroll.problems.${problem.code}`));
  }
}
