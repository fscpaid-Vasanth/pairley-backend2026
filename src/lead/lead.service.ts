import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LeadStatus } from '@prisma/client';
import { renderLeadMessage, getPublicTemplateCatalog, getAnalyticsEvents } from './leadMessageTemplates';

@Injectable()
export class LeadService {
  constructor(private prisma: PrismaService) {}

  // Module 13 — identity stays hidden until the merchant explicitly unlocks
  // a lead (Phase 1: free, manual, no quota — see MERCHANT_LEAD_UNLOCK.md).
  // Applied to every client-facing lead read (list + single) so there's one
  // place this rule lives; unlockLead/assertLeadAccess below deliberately
  // read the raw, unmasked row via prisma directly since they need the real
  // fields to do their own job.
  private maskLead<
    T extends {
      unlocked_at: Date | null;
      customer_name: string;
      customer_mobile: string;
    },
  >(lead: T): Omit<T, 'customer_name' | 'customer_mobile'> & {
    customer_name: string;
    customer_mobile: string | null;
  } {
    if (lead.unlocked_at) return lead;
    return { ...lead, customer_name: 'Anonymous Customer', customer_mobile: null };
  }

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

    const leads = await this.prisma.lead.findMany({
      where,
      orderBy: { created_at: 'desc' },
    });

    // Module 8 — attach each lead's WhatsApp alert delivery status. No
    // @relation between Lead and WhatsAppMessage by design (both are
    // standalone logs, see their schema comments), so this is a batched
    // second query + in-memory join rather than an `include`.
    if (leads.length > 0) {
      const messages = await this.prisma.whatsAppMessage.findMany({
        where: { related_lead_id: { in: leads.map((l) => l.id) } },
      });
      const statusByLeadId = new Map(
        messages.map((m) => [m.related_lead_id, m.status]),
      );
      return leads.map((lead) =>
        this.maskLead({
          ...lead,
          whatsappStatus: statusByLeadId.get(lead.id) ?? null,
        }),
      );
    }

    return leads.map((lead) => this.maskLead(lead));
  }

  async getLead(businessId: string, leadId: string) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) {
      throw new NotFoundException('Lead not found');
    }
    if (lead.shop_id !== businessId) {
      throw new ForbiddenException('You do not own this lead');
    }
    return this.maskLead(lead);
  }

  // Module 13 — Phase 1 unlock rule: free, manual, one-way (no re-lock).
  // Idempotent — clicking an already-unlocked lead's button again is a
  // no-op, not an error, since the frontend can't always know the current
  // state with certainty (e.g. two tabs open).
  async unlockLead(businessId: string, leadId: string) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) {
      throw new NotFoundException('Lead not found');
    }
    if (lead.shop_id !== businessId) {
      throw new ForbiddenException('You do not own this lead');
    }
    if (lead.unlocked_at) {
      return lead;
    }
    return this.prisma.lead.update({
      where: { id: leadId },
      data: { unlocked_at: new Date() },
    });
  }

  // Module 13 — anonymous 1:1 chat, gated to exactly the two parties on this
  // Lead. Shared by both the customer-side and business-side chat
  // controllers below (see LeadController), since the access rule is
  // identical modulo which id/role is being checked.
  private async assertLeadAccess(
    leadId: string,
    callerId: string,
    callerRole: string,
  ) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) {
      throw new NotFoundException('Lead not found');
    }
    const isCustomer = callerRole === 'Customer' && lead.customer_id === callerId;
    const isBusiness = callerRole === 'Business' && lead.shop_id === callerId;
    if (!isCustomer && !isBusiness) {
      throw new ForbiddenException(
        'You do not have access to this conversation',
      );
    }
    return lead;
  }

  async getMessages(leadId: string, callerId: string, callerRole: string) {
    await this.assertLeadAccess(leadId, callerId, callerRole);
    return this.prisma.leadMessage.findMany({
      where: { lead_id: leadId },
      orderBy: { created_at: 'asc' },
    });
  }

  // No lead-specific access check — this is just the catalog of what can be
  // sent, not the messages themselves, and both roles need it before they
  // even have a lead open (e.g. to render the composer for the first time).
  getMessageTemplates() {
    return getPublicTemplateCatalog();
  }

  // Module 13 Phase 2 — Deal Coordination Assistant. Free text is gone: the
  // only way a message reaches the database is via a templateKey resolved
  // against LEAD_MESSAGE_TEMPLATES (see leadMessageTemplates.ts), which
  // either has fixed text or validates a structured payload (date+time,
  // lat+lng). This is the actual enforcement point — a direct API call with
  // arbitrary `text` in the body is rejected the same as the UI rejecting
  // typing, not just hidden client-side.
  async sendMessage(
    leadId: string,
    callerId: string,
    callerRole: string,
    templateKey: string,
    payload?: unknown,
  ) {
    await this.assertLeadAccess(leadId, callerId, callerRole);
    const rendered = renderLeadMessage(templateKey, payload);
    const senderRole = callerRole === 'Business' ? 'BUSINESS' : 'CUSTOMER';

    const message = await this.prisma.leadMessage.create({
      data: {
        lead_id: leadId,
        sender_role: senderRole,
        message_type: rendered.message_type,
        text: rendered.text,
        ...(rendered.payload ? { payload: rendered.payload as any } : {}),
      },
    });

    // Fire-and-forget durable analytics log — never blocks or fails the
    // send. One row per event the template maps to (a schedule send is
    // both DATE_SHARED and TIME_SHARED, for instance).
    const events = getAnalyticsEvents(templateKey);
    if (events.length > 0) {
      this.prisma.leadInteractionEvent
        .createMany({
          data: events.map((event_type) => ({
            lead_id: leadId,
            sender_role: senderRole,
            template_key: templateKey,
            event_type,
          })),
        })
        .catch(() => {});
    }

    return message;
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

    const updated = await this.prisma.lead.update({
      where: { id: leadId },
      data: { status },
    });
    // Masked for the same reason getLead()/getLeads() are — otherwise a
    // status change would leak unlocked contact info as a side channel.
    return this.maskLead(updated);
  }
}
