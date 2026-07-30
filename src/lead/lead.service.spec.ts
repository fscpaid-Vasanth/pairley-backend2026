import { LeadService } from './lead.service';
import {
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';

// Module 13 — WhatsApp-free interest flow. Covers the three behaviors that
// didn't exist before this module: identity masking until a merchant
// explicitly unlocks a lead, the unlock action itself (ownership + idempotency),
// and the anonymous 1:1 lead chat's access control (exactly the customer and
// business on that one Lead, nobody else — including a different business
// or a different customer, not just "any Business role").
describe('LeadService', () => {
  const makeLead = (overrides = {}) => ({
    id: 'lead-1',
    customer_id: 'cust-1',
    customer_name: 'Priya Sharma',
    customer_mobile: '9876543210',
    offer_id: 'offer-1',
    offer_name: '6 Month Membership',
    shop_id: 'biz-1',
    shop_name: 'FitLife Gym',
    created_at: new Date('2026-07-29T10:00:00Z'),
    updated_at: new Date('2026-07-29T10:00:00Z'),
    status: 'NEW',
    unlocked_at: null,
    ...overrides,
  });

  const makePrisma = () => ({
    lead: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    whatsAppMessage: { findMany: jest.fn().mockResolvedValue([]) },
    leadMessage: {
      findMany: jest.fn(),
      create: jest.fn(),
    },
    leadInteractionEvent: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  });

  let prisma: ReturnType<typeof makePrisma>;
  let service: LeadService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new LeadService(prisma as any);
  });

  describe('identity masking — getLeads / getLead / updateLeadStatus', () => {
    it('masks name and mobile on getLeads for a locked lead', async () => {
      prisma.lead.findMany.mockResolvedValue([makeLead()]);
      const [result] = await service.getLeads('biz-1', {});
      expect(result.customer_name).toBe('Anonymous Customer');
      expect(result.customer_mobile).toBeNull();
    });

    it('leaves an unlocked lead fully visible on getLeads', async () => {
      prisma.lead.findMany.mockResolvedValue([
        makeLead({ unlocked_at: new Date('2026-07-29T11:00:00Z') }),
      ]);
      const [result] = await service.getLeads('biz-1', {});
      expect(result.customer_name).toBe('Priya Sharma');
      expect(result.customer_mobile).toBe('9876543210');
    });

    it('masks a locked lead on getLead (single fetch)', async () => {
      prisma.lead.findUnique.mockResolvedValue(makeLead());
      const result = await service.getLead('biz-1', 'lead-1');
      expect(result.customer_mobile).toBeNull();
    });

    it('rejects getLead for a business that does not own the lead', async () => {
      prisma.lead.findUnique.mockResolvedValue(
        makeLead({ shop_id: 'other-biz' }),
      );
      await expect(service.getLead('biz-1', 'lead-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('masks the lead returned by updateLeadStatus so a status change cannot leak contact info', async () => {
      prisma.lead.findUnique.mockResolvedValue(makeLead());
      prisma.lead.update.mockResolvedValue(makeLead({ status: 'CONTACTED' }));
      const result = await service.updateLeadStatus(
        'biz-1',
        'lead-1',
        'CONTACTED',
      );
      expect(result.customer_mobile).toBeNull();
      expect(result.status).toBe('CONTACTED');
    });
  });

  describe('unlockLead', () => {
    it('sets unlocked_at for the owning business', async () => {
      prisma.lead.findUnique.mockResolvedValue(makeLead());
      prisma.lead.update.mockResolvedValue(
        makeLead({ unlocked_at: new Date() }),
      );
      await service.unlockLead('biz-1', 'lead-1');
      expect(prisma.lead.update).toHaveBeenCalledWith({
        where: { id: 'lead-1' },
        data: { unlocked_at: expect.any(Date) },
      });
    });

    it('is idempotent — an already-unlocked lead is not re-written', async () => {
      const already = makeLead({
        unlocked_at: new Date('2026-07-29T09:00:00Z'),
      });
      prisma.lead.findUnique.mockResolvedValue(already);
      const result = await service.unlockLead('biz-1', 'lead-1');
      expect(prisma.lead.update).not.toHaveBeenCalled();
      expect(result).toBe(already);
    });

    it('rejects unlocking a lead owned by a different business', async () => {
      prisma.lead.findUnique.mockResolvedValue(
        makeLead({ shop_id: 'other-biz' }),
      );
      await expect(service.unlockLead('biz-1', 'lead-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.lead.update).not.toHaveBeenCalled();
    });

    it('404s for a lead id that does not exist', async () => {
      prisma.lead.findUnique.mockResolvedValue(null);
      await expect(service.unlockLead('biz-1', 'missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('anonymous lead chat — access control', () => {
    it("lets the lead's own customer read messages", async () => {
      prisma.lead.findUnique.mockResolvedValue(makeLead());
      prisma.leadMessage.findMany.mockResolvedValue([]);
      await expect(
        service.getMessages('lead-1', 'cust-1', 'Customer'),
      ).resolves.toEqual([]);
    });

    it("lets the lead's own business read messages", async () => {
      prisma.lead.findUnique.mockResolvedValue(makeLead());
      prisma.leadMessage.findMany.mockResolvedValue([]);
      await expect(
        service.getMessages('lead-1', 'biz-1', 'Business'),
      ).resolves.toEqual([]);
    });

    it('rejects a different customer entirely', async () => {
      prisma.lead.findUnique.mockResolvedValue(makeLead());
      await expect(
        service.getMessages('lead-1', 'someone-else', 'Customer'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects a different business — the core case: Role.BUSINESS alone is not enough', async () => {
      prisma.lead.findUnique.mockResolvedValue(makeLead());
      await expect(
        service.getMessages('lead-1', 'other-biz', 'Business'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects an Admin caller too — this thread has exactly two parties, not three', async () => {
      prisma.lead.findUnique.mockResolvedValue(makeLead());
      await expect(
        service.getMessages('lead-1', 'admin-1', 'Admin'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('404s for a nonexistent lead rather than leaking a 403', async () => {
      prisma.lead.findUnique.mockResolvedValue(null);
      await expect(
        service.getMessages('missing', 'cust-1', 'Customer'),
      ).rejects.toThrow(NotFoundException);
    });

    // Module 13 Phase 2 — sendMessage now only accepts a whitelisted
    // templateKey (see leadMessageTemplates.spec.ts for the full catalog
    // renderer coverage); these tests cover the service-level wiring —
    // role tagging, unknown-key rejection, and payload pass-through — not
    // the catalog contents themselves.
    it('tags a customer-sent message sender_role CUSTOMER and stores the rendered text', async () => {
      prisma.lead.findUnique.mockResolvedValue(makeLead());
      prisma.leadMessage.create.mockResolvedValue({ id: 'msg-1' });
      await service.sendMessage('lead-1', 'cust-1', 'Customer', 'MEETING_WHEN');
      expect(prisma.leadMessage.create).toHaveBeenCalledWith({
        data: {
          lead_id: 'lead-1',
          sender_role: 'CUSTOMER',
          message_type: 'STATEMENT',
          text: '📅 When shall we meet?',
        },
      });
    });

    it('tags a business-sent message sender_role BUSINESS', async () => {
      prisma.lead.findUnique.mockResolvedValue(makeLead());
      prisma.leadMessage.create.mockResolvedValue({ id: 'msg-2' });
      await service.sendMessage(
        'lead-1',
        'biz-1',
        'Business',
        'CONFIRM_THANKS',
      );
      expect(prisma.leadMessage.create).toHaveBeenCalledWith({
        data: {
          lead_id: 'lead-1',
          sender_role: 'BUSINESS',
          message_type: 'STATEMENT',
          text: '👍 Thank you.',
        },
      });
    });

    it('renders the SCHEDULE template and includes the payload', async () => {
      prisma.lead.findUnique.mockResolvedValue(makeLead());
      prisma.leadMessage.create.mockResolvedValue({ id: 'msg-3' });
      await service.sendMessage(
        'lead-1',
        'cust-1',
        'Customer',
        'SCHEDULE_AVAILABLE_ON',
        {
          date: '2026-07-29',
          time: '17:30',
        },
      );
      expect(prisma.leadMessage.create).toHaveBeenCalledWith({
        data: {
          lead_id: 'lead-1',
          sender_role: 'CUSTOMER',
          message_type: 'SCHEDULE',
          text: '📅 I will be available on 29 Jul 2026 at 5:30 PM',
          payload: { date: '2026-07-29', time: '17:30' },
        },
      });
    });

    it('rejects an unknown template key — free text can no longer reach the database', async () => {
      prisma.lead.findUnique.mockResolvedValue(makeLead());
      await expect(
        service.sendMessage(
          'lead-1',
          'cust-1',
          'Customer',
          'Is this still available?',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.leadMessage.create).not.toHaveBeenCalled();
    });

    it('rejects a SCHEDULE template with a missing/invalid payload', async () => {
      prisma.lead.findUnique.mockResolvedValue(makeLead());
      await expect(
        service.sendMessage(
          'lead-1',
          'cust-1',
          'Customer',
          'SCHEDULE_AVAILABLE_ON',
          undefined,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.leadMessage.create).not.toHaveBeenCalled();
    });

    // Module 13 Phase 2b — every send logs its analytics events, fire-and-
    // forget, keyed by the exact template sent.
    describe('analytics event logging', () => {
      it('logs a single event for a plain statement template', async () => {
        prisma.lead.findUnique.mockResolvedValue(makeLead());
        prisma.leadMessage.create.mockResolvedValue({ id: 'msg-4' });
        await service.sendMessage(
          'lead-1',
          'cust-1',
          'Customer',
          'MEETING_WHEN',
        );
        expect(prisma.leadInteractionEvent.createMany).toHaveBeenCalledWith({
          data: [
            {
              lead_id: 'lead-1',
              sender_role: 'CUSTOMER',
              template_key: 'MEETING_WHEN',
              event_type: 'MEETING_REQUESTED',
            },
          ],
        });
      });

      it('logs two events for a schedule send (date + time)', async () => {
        prisma.lead.findUnique.mockResolvedValue(makeLead());
        prisma.leadMessage.create.mockResolvedValue({ id: 'msg-5' });
        await service.sendMessage(
          'lead-1',
          'biz-1',
          'Business',
          'SCHEDULE_AVAILABLE_ON',
          {
            date: '2026-07-29',
            time: '17:30',
          },
        );
        expect(prisma.leadInteractionEvent.createMany).toHaveBeenCalledWith({
          data: [
            {
              lead_id: 'lead-1',
              sender_role: 'BUSINESS',
              template_key: 'SCHEDULE_AVAILABLE_ON',
              event_type: 'DATE_SHARED',
            },
            {
              lead_id: 'lead-1',
              sender_role: 'BUSINESS',
              template_key: 'SCHEDULE_AVAILABLE_ON',
              event_type: 'TIME_SHARED',
            },
          ],
        });
      });

      it('never blocks or fails the send if event logging itself rejects', async () => {
        prisma.lead.findUnique.mockResolvedValue(makeLead());
        prisma.leadMessage.create.mockResolvedValue({ id: 'msg-6' });
        prisma.leadInteractionEvent.createMany.mockRejectedValue(
          new Error('db down'),
        );
        await expect(
          service.sendMessage(
            'lead-1',
            'cust-1',
            'Customer',
            'OFFER_COLLECTED',
          ),
        ).resolves.toEqual({ id: 'msg-6' });
      });
    });

    it('rejects a message from someone who is not a party to the lead', async () => {
      prisma.lead.findUnique.mockResolvedValue(makeLead());
      await expect(
        service.sendMessage(
          'lead-1',
          'other-biz',
          'Business',
          'CONFIRM_THANKS',
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.leadMessage.create).not.toHaveBeenCalled();
    });
  });
});
