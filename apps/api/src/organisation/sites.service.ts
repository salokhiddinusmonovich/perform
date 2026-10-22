import { Injectable } from '@nestjs/common';
import type { Prisma, Role } from '@prisma/client';
import type { Site, Team, UpdateSite, UpdateTeam } from '@puantaj/schemas';
import { AuditService, diff } from '../audit/audit.service';
import type { CompanyAuthContext } from '../auth/auth.context';
import { USABLE_MEMBERSHIP } from '../auth/memberships';
import { badRequest, conflict, forbidden, notFound } from '../common/api-error';
import { currentOn, todayIn } from '../common/dates';
import { PrismaService } from '../prisma/prisma.service';
import { assertManagesSite, isCompanyManager, visibleSites, visibleTeams } from './access';

export interface StaffView {
  userId: string;
  fullName: string;
  role: Role;
}

export interface TeamView {
  id: string;
  siteId: string;
  name: string;
  department: string | null;
  isActive: boolean;
  foremen: StaffView[];
  /** Workers placed in this team today */
  workerCount: number;
}

export interface SiteView {
  id: string;
  name: string;
  code: string | null;
  address: string | null;
  isActive: boolean;
  /** Project managers and timekeepers assigned to the site */
  staff: StaffView[];
  teams: TeamView[];
  /** Workers placed on this site today */
  workerCount: number;
}

type Tx = Prisma.TransactionClient;

/**
 * Sites and their teams, and who works on them: project managers and timekeepers per
 * site, foremen per team. Owners and admins create sites and assign project managers;
 * project managers manage teams and assign timekeepers and foremen on their own sites.
 */
@Injectable()
export class SitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(auth: CompanyAuthContext): Promise<SiteView[]> {
    const today = todayIn(auth.company.timezone);
    const member = { select: { membership: { select: { userId: true, role: true, user: { select: { fullName: true } } } } } };
    const sites = await this.prisma.site.findMany({
      where: visibleSites(auth),
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: {
        members: member,
        teams: { where: visibleTeams(auth), orderBy: [{ isActive: 'desc' }, { name: 'asc' }], include: { foremen: member } },
      },
    });
    const placed = await this.prisma.assignment.groupBy({
      by: ['siteId', 'teamId'],
      where: { companyId: auth.company.id, ...currentOn(today) },
      _count: { _all: true },
    });
    const staff = (rows: { membership: { userId: string; role: Role; user: { fullName: string } } }[]) =>
      rows
        .map((r) => ({ userId: r.membership.userId, fullName: r.membership.user.fullName, role: r.membership.role }))
        .sort((a, b) => a.fullName.localeCompare(b.fullName));
    return sites.map((s) => ({
      id: s.id,
      name: s.name,
      code: s.code,
      address: s.address,
      isActive: s.isActive,
      staff: staff(s.members),
      teams: s.teams.map((t) => ({
        id: t.id,
        siteId: t.siteId,
        name: t.name,
        department: t.department,
        isActive: t.isActive,
        foremen: staff(t.foremen),
        workerCount: placed.filter((p) => p.teamId === t.id).reduce((n, p) => n + p._count._all, 0),
      })),
      workerCount: placed.filter((p) => p.siteId === s.id).reduce((n, p) => n + p._count._all, 0),
    }));
  }

  async createSite(auth: CompanyAuthContext, input: Site): Promise<{ id: string }> {
    if (!isCompanyManager(auth)) throw forbidden();
    const companyId = auth.company.id;
    return this.prisma.$transaction(async (tx) => {
      if (await tx.site.findFirst({ where: { companyId, name: input.name } })) throw conflict('site.nameTaken');
      const site = await tx.site.create({ data: { companyId, ...input } });
      await this.record(tx, auth, 'site.create', 'Site', site.id, { ...input });
      return { id: site.id };
    });
  }

  async updateSite(auth: CompanyAuthContext, id: string, input: UpdateSite): Promise<void> {
    if (!isCompanyManager(auth)) throw forbidden();
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.site.findFirst({ where: { id, companyId } });
      if (!before) throw notFound('site.notFound');
      if (input.name && input.name !== before.name && (await tx.site.findFirst({ where: { companyId, name: input.name } }))) {
        throw conflict('site.nameTaken');
      }
      if (input.isActive === false && before.isActive) {
        const today = todayIn(auth.company.timezone);
        if (await tx.assignment.count({ where: { siteId: id, ...currentOn(today) } })) throw conflict('site.hasWorkers');
      }
      await tx.site.update({ where: { id }, data: input });
      await this.record(tx, auth, 'site.update', 'Site', id, diff(before, input));
    });
  }

  async createTeam(auth: CompanyAuthContext, input: Team): Promise<{ id: string }> {
    const companyId = auth.company.id;
    return this.prisma.$transaction(async (tx) => {
      const site = await tx.site.findFirst({ where: { AND: [visibleSites(auth), { id: input.siteId }] } });
      if (!site) throw notFound('site.notFound');
      assertManagesSite(auth, site.id);
      if (!site.isActive) throw conflict('site.inactive');
      if (await tx.team.findFirst({ where: { siteId: site.id, name: input.name } })) throw conflict('team.nameTaken');
      const team = await tx.team.create({ data: { companyId, ...input } });
      await this.record(tx, auth, 'team.create', 'Team', team.id, { ...input });
      return { id: team.id };
    });
  }

  async updateTeam(auth: CompanyAuthContext, id: string, input: UpdateTeam): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.team.findFirst({ where: { AND: [visibleTeams(auth), { id }] } });
      if (!before) throw notFound('team.notFound');
      assertManagesSite(auth, before.siteId);
      if (
        input.name &&
        input.name !== before.name &&
        (await tx.team.findFirst({ where: { siteId: before.siteId, name: input.name } }))
      ) {
        throw conflict('team.nameTaken');
      }
      if (input.isActive === false && before.isActive) {
        const today = todayIn(auth.company.timezone);
        if (await tx.assignment.count({ where: { teamId: id, ...currentOn(today) } })) throw conflict('team.hasWorkers');
      }
      await tx.team.update({ where: { id }, data: input });
      await this.record(tx, auth, 'team.update', 'Team', id, diff(before, input));
    });
  }

  /**
   * Assigns a project manager or timekeeper to a site. Owners and admins assign both;
   * a project manager assigns timekeepers on their own sites.
   */
  async addSiteStaff(auth: CompanyAuthContext, siteId: string, userId: string): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const site = await tx.site.findFirst({ where: { AND: [visibleSites(auth), { id: siteId }] } });
      if (!site) throw notFound('site.notFound');
      const member = await this.usableMember(tx, companyId, userId);
      this.assertMayAssign(auth, site.id, member.role, ['PROJECT_MANAGER', 'TIMEKEEPER']);
      const key = { userId_companyId_siteId: { userId, companyId, siteId } };
      if (await tx.memberSite.findUnique({ where: key })) return;
      await tx.memberSite.create({ data: { userId, companyId, siteId } });
      await this.record(tx, auth, 'site.staffAdd', 'Site', siteId, { userId, role: member.role });
    });
  }

  async removeSiteStaff(auth: CompanyAuthContext, siteId: string, userId: string): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const site = await tx.site.findFirst({ where: { AND: [visibleSites(auth), { id: siteId }] } });
      if (!site) throw notFound('site.notFound');
      const row = await tx.memberSite.findUnique({
        where: { userId_companyId_siteId: { userId, companyId, siteId } },
        include: { membership: true },
      });
      if (!row) throw notFound('member.notFound');
      this.assertMayAssign(auth, site.id, row.membership.role, ['PROJECT_MANAGER', 'TIMEKEEPER']);
      await tx.memberSite.delete({ where: { userId_companyId_siteId: { userId, companyId, siteId } } });
      await this.record(tx, auth, 'site.staffRemove', 'Site', siteId, { userId, role: row.membership.role });
    });
  }

  /** Makes a foreman the leader of a team (a foreman may lead several). */
  async addForeman(auth: CompanyAuthContext, teamId: string, userId: string): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const team = await tx.team.findFirst({ where: { AND: [visibleTeams(auth), { id: teamId }] } });
      if (!team) throw notFound('team.notFound');
      const member = await this.usableMember(tx, companyId, userId);
      this.assertMayAssign(auth, team.siteId, member.role, ['FOREMAN']);
      const key = { userId_companyId_teamId: { userId, companyId, teamId } };
      if (await tx.memberTeam.findUnique({ where: key })) return;
      await tx.memberTeam.create({ data: { userId, companyId, teamId } });
      await this.record(tx, auth, 'team.foremanAdd', 'Team', teamId, { userId });
    });
  }

  async removeForeman(auth: CompanyAuthContext, teamId: string, userId: string): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const team = await tx.team.findFirst({ where: { AND: [visibleTeams(auth), { id: teamId }] } });
      if (!team) throw notFound('team.notFound');
      assertManagesSite(auth, team.siteId);
      const key = { userId_companyId_teamId: { userId, companyId, teamId } };
      if (!(await tx.memberTeam.findUnique({ where: key }))) throw notFound('member.notFound');
      await tx.memberTeam.delete({ where: key });
      await this.record(tx, auth, 'team.foremanRemove', 'Team', teamId, { userId });
    });
  }

  /**
   * Members the caller may assign: project managers, timekeepers and foremen for owners
   * and admins; timekeepers and foremen for a project manager. Names only.
   */
  async staffCandidates(auth: CompanyAuthContext): Promise<StaffView[]> {
    const roles: Role[] = isCompanyManager(auth) ? ['PROJECT_MANAGER', 'TIMEKEEPER', 'FOREMAN'] : ['TIMEKEEPER', 'FOREMAN'];
    const rows = await this.prisma.membership.findMany({
      where: { companyId: auth.company.id, role: { in: roles }, ...USABLE_MEMBERSHIP },
      include: { user: { select: { fullName: true } } },
      orderBy: { user: { fullName: 'asc' } },
    });
    return rows.map((m) => ({ userId: m.userId, fullName: m.user.fullName, role: m.role }));
  }

  /** A member who can work in the company now (active, accepted). */
  private async usableMember(tx: Tx, companyId: string, userId: string) {
    const member = await tx.membership.findFirst({ where: { userId, companyId, ...USABLE_MEMBERSHIP } });
    if (!member) throw notFound('member.notFound');
    return member;
  }

  /**
   * The member's role must be one assigned this way (`allowed`). Owners and admins assign
   * anyone; a project manager only timekeepers and foremen, on their own sites.
   */
  private assertMayAssign(auth: CompanyAuthContext, siteId: string, role: Role, allowed: Role[]): void {
    if (!allowed.includes(role)) throw badRequest('staff.wrongRole');
    if (isCompanyManager(auth)) return;
    if (role === 'PROJECT_MANAGER') throw forbidden();
    assertManagesSite(auth, siteId);
  }

  private record(tx: Tx, auth: CompanyAuthContext, action: string, entityType: string, entityId: string, data: Prisma.InputJsonObject) {
    return this.audit.record(
      { action, companyId: auth.company.id, auth, entityType, entityId, data },
      tx,
    );
  }
}
