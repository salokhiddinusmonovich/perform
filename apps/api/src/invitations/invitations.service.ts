import { Injectable } from '@nestjs/common';
import type { Role } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth.context';
import { OPEN_INVITATION } from '../auth/memberships';
import { notFound } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';

export interface InvitationView {
  companyId: string;
  companyName: string;
  role: Role;
  invitedAt: Date;
}

/**
 * Invitations to join a company, seen by the invited person. A company that adds someone
 * who already has an account can only invite them (see Membership.acceptedAt).
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(auth: AuthContext): Promise<InvitationView[]> {
    const rows = await this.prisma.membership.findMany({
      where: { userId: auth.user.id, ...OPEN_INVITATION },
      include: { company: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((m) => ({ companyId: m.companyId, companyName: m.company.name, role: m.role, invitedAt: m.createdAt }));
  }

  async accept(auth: AuthContext, companyId: string) {
    await this.answer(auth, companyId, 'accepted');
  }

  async decline(auth: AuthContext, companyId: string) {
    await this.answer(auth, companyId, 'declined');
  }

  private async answer(auth: AuthContext, companyId: string, answer: 'accepted' | 'declined') {
    await this.prisma.$transaction(async (tx) => {
      const invitation = await tx.membership.findFirst({
        where: { userId: auth.user.id, companyId, ...OPEN_INVITATION },
      });
      if (!invitation) throw notFound('invitation.notFound');
      const now = new Date();
      await tx.membership.update({
        where: { userId_companyId: { userId: auth.user.id, companyId } },
        data: answer === 'accepted' ? { acceptedAt: now } : { declinedAt: now },
      });
      await this.audit.record(
        {
          action: answer === 'accepted' ? 'member.invitationAccepted' : 'member.invitationDeclined',
          companyId,
          auth,
          entityType: 'User',
          entityId: auth.user.id,
          data: { role: invitation.role },
        },
        tx,
      );
    });
  }
}
