import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LeadStatus } from '@prisma/client';

@Injectable()
export class LeadService {
  constructor(private prisma: PrismaService) {}

  // Scoped directly by the caller's own business id (JWT sub) — same
  // ownership pattern as OfferService.getInterestedCustomers(), no separate
  // guard needed since the query itself can't return another business's rows.
  async getLeads(
    businessId: string,
    filters: { offerId?: string; status?: string },
  ) {
    const where: { shop_id: string; offer_id?: string; status?: LeadStatus } = {
      shop_id: businessId,
    };
    if (filters.offerId) {
      where.offer_id = filters.offerId;
    }
    if (filters.status) {
      where.status = filters.status as LeadStatus;
    }

    return this.prisma.lead.findMany({
      where,
      orderBy: { created_at: 'desc' },
    });
  }

  async getLead(businessId: string, leadId: string) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) {
      throw new NotFoundException('Lead not found');
    }
    if (lead.shop_id !== businessId) {
      throw new ForbiddenException('You do not own this lead');
    }
    return lead;
  }

  // Fetch-then-compare ownership — same pattern as
  // OfferService.updateInterestStatus() for the equivalent legacy action.
  async updateLeadStatus(
    businessId: string,
    leadId: string,
    status: LeadStatus,
  ) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) {
      throw new NotFoundException('Lead not found');
    }
    if (lead.shop_id !== businessId) {
      throw new ForbiddenException('You do not own this lead');
    }

    return this.prisma.lead.update({
      where: { id: leadId },
      data: { status },
    });
  }
}
