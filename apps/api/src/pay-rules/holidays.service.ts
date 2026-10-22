import { Injectable } from '@nestjs/common';
import type { HolidayKind, Prisma } from '@prisma/client';
import {
  missingMovingHolidays,
  uzbekistanFixedHolidays,
  type FixedHoliday,
  type MovingHoliday,
} from '@puantaj/payroll';
import type { Holiday } from '@puantaj/schemas';
import { AuditService, diff } from '../audit/audit.service';
import type { CompanyAuthContext } from '../auth/auth.context';
import { conflict, notFound } from '../common/api-error';
import { dayToDate, isoDay, monthOfDay } from '../common/dates';
import { PrismaService } from '../prisma/prisma.service';
import { assertMonthsOpen } from './months';


export interface HolidayView {
  id: string;
  date: string;
  kind: HolidayKind;
  name: string | null;
}

export interface HolidayYearView {
  year: number;
  /** Uzbekistan's fixed-date public holidays, shipped with the app (not editable). */
  fixed: FixedHoliday[];
  entered: HolidayView[];
  /** Moving holidays not entered yet: the year's working days are wrong until they are. */
  missingMovingHolidays: MovingHoliday[];
}

const MOVING: readonly HolidayKind[] = ['RAMAZON_HAYIT', 'QURBON_HAYIT'];

const yearRange = (year: number) => ({ gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) });

/**
 * Holidays the company enters (Settings): moving public holidays, extra days off,
 * company days off and swapped working days. Changing one changes the working days
 * of its month, so locked months are refused.
 */
@Injectable()
export class HolidaysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async year(companyId: string, year: number): Promise<HolidayYearView> {
    const rows = await this.prisma.holiday.findMany({
      where: { companyId, date: yearRange(year) },
      orderBy: { date: 'asc' },
    });
    const entered = rows.map((h) => ({ id: h.id, date: isoDay(h.date), kind: h.kind, name: h.name }));
    return {
      year,
      fixed: uzbekistanFixedHolidays(year),
      entered,
      missingMovingHolidays: missingMovingHolidays(entered.map((h) => h.kind)),
    };
  }

  async create(auth: CompanyAuthContext, input: Holiday): Promise<{ id: string }> {
    const companyId = auth.company.id;
    return this.prisma.$transaction(async (tx) => {
      await this.check(tx, companyId, input, null);
      const holiday = await tx.holiday.create({
        data: { companyId, date: dayToDate(input.date), kind: input.kind, name: input.name },
      });
      await this.audit.record(
        {
          action: 'holiday.create',
          companyId,
          actorUserId: auth.user.id,
          entityType: 'Holiday',
          entityId: holiday.id,
          data: { ...input },
          ip: auth.ip,
        },
        tx,
      );
      return { id: holiday.id };
    });
  }

  async update(auth: CompanyAuthContext, id: string, input: Holiday): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.holiday.findFirst({ where: { id, companyId } });
      if (!before) throw notFound('holiday.notFound');
      // Moving a holiday changes both months.
      await assertMonthsOpen(tx, companyId, monthOfDay(isoDay(before.date)));
      await this.check(tx, companyId, input, id);
      await tx.holiday.update({
        where: { id },
        data: { date: dayToDate(input.date), kind: input.kind, name: input.name },
      });
      await this.audit.record(
        {
          action: 'holiday.update',
          companyId,
          actorUserId: auth.user.id,
          entityType: 'Holiday',
          entityId: id,
          data: diff({ date: isoDay(before.date), kind: before.kind, name: before.name }, input),
          ip: auth.ip,
        },
        tx,
      );
    });
  }

  async remove(auth: CompanyAuthContext, id: string): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.holiday.findFirst({ where: { id, companyId } });
      if (!before) throw notFound('holiday.notFound');
      await assertMonthsOpen(tx, companyId, monthOfDay(isoDay(before.date)));
      await tx.holiday.delete({ where: { id } });
      await this.audit.record(
        {
          action: 'holiday.delete',
          companyId,
          actorUserId: auth.user.id,
          entityType: 'Holiday',
          entityId: id,
          data: { date: isoDay(before.date), kind: before.kind, name: before.name },
          ip: auth.ip,
        },
        tx,
      );
    });
  }

  /** Rules every entered holiday follows; `id` is the holiday being changed, if any. */
  private async check(
    tx: Prisma.TransactionClient,
    companyId: string,
    input: Holiday,
    id: string | null,
  ): Promise<void> {
    await assertMonthsOpen(tx, companyId, monthOfDay(input.date));
    // A fixed holiday is already a day off, and can't be swapped into a working day here.
    if (uzbekistanFixedHolidays(monthOfDay(input.date).year).some((h) => h.date === input.date)) {
      throw conflict('holiday.fixedDate');
    }
    const sameDay = await tx.holiday.findFirst({ where: { companyId, date: dayToDate(input.date), NOT: id ? { id } : undefined } });
    if (sameDay) throw conflict('holiday.dateTaken');
    // Ramazon Hayit and Qurbon Hayit are one day each a year; extra days off are PUBLIC_EXTRA.
    if (MOVING.includes(input.kind)) {
      const sameKind = await tx.holiday.findFirst({
        where: { companyId, kind: input.kind, date: yearRange(monthOfDay(input.date).year), NOT: id ? { id } : undefined },
      });
      if (sameKind) throw conflict('holiday.movingAlreadyEntered');
    }
  }
}
