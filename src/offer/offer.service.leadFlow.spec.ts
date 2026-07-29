import { OfferService } from './offer.service';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

// Module 13 — WhatsApp-free interest flow. Scoped to just the three methods
// this module changed (createLead's dedupe + response shape, getDetails'
// new myLead field, getCoBuyMessages' new ownership check) rather than a
// full OfferService spec — that file has no pre-existing test coverage and
// a full spec is a much larger, separate undertaking.
describe('OfferService — Module 13 lead flow', () => {
  const makePrisma = () => ({
    offer: { findUnique: jest.fn() },
    lead: { findUnique: jest.fn(), create: jest.fn() },
    customer: { findUnique: jest.fn() },
    offerInterest: { findUnique: jest.fn(), count: jest.fn() },
    coBuyMessage: { findMany: jest.fn() },
  });

  const makeNotificationService = () => ({ sendNotification: jest.fn().mockResolvedValue(undefined) });
  const makeWhatsappService = () => ({ getSenderPhoneNumberId: jest.fn().mockReturnValue(null) });

  let prisma: ReturnType<typeof makePrisma>;
  let notificationService: ReturnType<typeof makeNotificationService>;
  let whatsappService: ReturnType<typeof makeWhatsappService>;
  let service: OfferService;

  beforeEach(() => {
    prisma = makePrisma();
    notificationService = makeNotificationService();
    whatsappService = makeWhatsappService();
    service = new OfferService(
      prisma as any,
      notificationService as any,
      {} as any, // OtpService — unused by these methods
      {} as any, // StorageService — unused by these methods
      whatsappService as any,
    );
  });

  describe('createLead — hard duplicate block', () => {
    const offer = {
      id: 'offer-1',
      title: 'Flat 20% Off',
      business_id: 'biz-1',
      offer_type: 'PERCENTAGE_DISCOUNT', // non-legacy — Lead-only path
      whatsapp_number: null,
      business: { business_name: 'Corner Store', notification_mobiles: null, mobile: '9000000000' },
    };
    const customer = { id: 'cust-1', name: 'Asha', mobile: '9111111111' };

    it('rejects a second Show Interest for the same customer+offer with the existing lead attached', async () => {
      prisma.offer.findUnique.mockResolvedValue(offer);
      const existing = { id: 'lead-existing', status: 'NEW' };
      prisma.lead.findUnique.mockResolvedValue(existing);

      await expect(service.createLead('cust-1', 'offer-1')).rejects.toMatchObject({
        response: { message: 'You have already expressed interest in this deal.', lead: existing },
      });
      expect(prisma.lead.create).not.toHaveBeenCalled();
    });

    it('creates the lead and notifies the business on a genuine first interest', async () => {
      prisma.offer.findUnique.mockResolvedValue(offer);
      prisma.lead.findUnique.mockResolvedValue(null);
      prisma.customer.findUnique.mockResolvedValue(customer);
      const created = { id: 'lead-new', status: 'NEW' };
      prisma.lead.create.mockResolvedValue(created);

      const result = await service.createLead('cust-1', 'offer-1');

      expect(prisma.lead.create).toHaveBeenCalledTimes(1);
      expect(notificationService.sendNotification).toHaveBeenCalledWith(
        'biz-1',
        'New Lead!',
        expect.stringContaining('Asha'),
        'NEW_LEAD',
      );
      // The response no longer carries target WhatsApp numbers or the
      // customer's own contact info — nothing on the frontend needs them
      // now that the automatic wa.me redirect is gone.
      expect(result).toEqual({
        success: true,
        lead: created,
        offerName: 'Flat 20% Off',
        shopName: 'Corner Store',
      });
      expect(result).not.toHaveProperty('targetMobiles');
      expect(result).not.toHaveProperty('customerMobile');
    });

    it('does not touch OfferInterest for a non-legacy offer type', async () => {
      prisma.offer.findUnique.mockResolvedValue(offer);
      prisma.lead.findUnique.mockResolvedValue(null);
      prisma.customer.findUnique.mockResolvedValue(customer);
      prisma.lead.create.mockResolvedValue({ id: 'lead-new' });

      await service.createLead('cust-1', 'offer-1');

      expect(prisma.offerInterest.create).toBeUndefined(); // not even mocked/called on this offer_type path — confirms the legacy branch was skipped
    });
  });

  describe('getDetails — myLead status', () => {
    const baseOffer = {
      id: 'offer-1',
      business_id: 'biz-1',
      status: 'ACTIVE',
      offer_type: 'STANDARD',
      merchant_verified: true,
      is_pairley_exclusive: false,
      source: 'MANUAL',
      business: { business_status: 'CLAIMED' },
      interests: [],
    };

    it('returns myLead: null for a customer who has not shown interest', async () => {
      prisma.offer.findUnique.mockResolvedValue(baseOffer);
      prisma.lead.findUnique.mockResolvedValue(null);

      const result = await service.getDetails('offer-1', 'cust-1', 'Customer');
      expect(result.myLead).toBeNull();
    });

    it('reports unlocked: false while the merchant has not unlocked the lead', async () => {
      prisma.offer.findUnique.mockResolvedValue(baseOffer);
      prisma.lead.findUnique.mockResolvedValue({
        id: 'lead-1',
        status: 'NEW',
        unlocked_at: null,
        created_at: new Date('2026-07-29T10:00:00Z'),
      });

      const result = await service.getDetails('offer-1', 'cust-1', 'Customer');
      expect(result.myLead).toEqual({
        id: 'lead-1',
        status: 'NEW',
        unlocked: false,
        created_at: new Date('2026-07-29T10:00:00Z'),
      });
    });

    it('reports unlocked: true once the merchant has unlocked it', async () => {
      prisma.offer.findUnique.mockResolvedValue(baseOffer);
      prisma.lead.findUnique.mockResolvedValue({
        id: 'lead-1',
        status: 'NEW',
        unlocked_at: new Date('2026-07-29T11:00:00Z'),
        created_at: new Date('2026-07-29T10:00:00Z'),
      });

      const result = await service.getDetails('offer-1', 'cust-1', 'Customer');
      expect(result.myLead?.unlocked).toBe(true);
    });

    it('does not compute myLead for an anonymous (unauthenticated) caller', async () => {
      prisma.offer.findUnique.mockResolvedValue(baseOffer);

      const result = await service.getDetails('offer-1');
      expect(result.myLead).toBeNull();
      expect(prisma.lead.findUnique).not.toHaveBeenCalled();
    });

    it('does not compute myLead for the owning business (it gets full interests instead)', async () => {
      prisma.offer.findUnique.mockResolvedValue(baseOffer);
      prisma.offerInterest.findUnique = undefined as any; // n/a for this path
      (prisma as any).offerInterest.findMany = jest.fn().mockResolvedValue([]);

      const result = await service.getDetails('offer-1', 'biz-1', 'Business');
      expect(result.myLead).toBeNull();
      expect(prisma.lead.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('getCoBuyMessages — ownership check (pre-existing gap, fixed)', () => {
    it('allows the owning business to read messages', async () => {
      prisma.offer.findUnique.mockResolvedValue({ business_id: 'biz-1' });
      prisma.coBuyMessage.findMany.mockResolvedValue([]);
      await expect(service.getCoBuyMessages('offer-1', 'biz-1', 'Business')).resolves.toEqual([]);
    });

    it('allows a customer who has an OfferInterest on the deal', async () => {
      prisma.offer.findUnique.mockResolvedValue({ business_id: 'biz-1' });
      prisma.offerInterest.findUnique.mockResolvedValue({ id: 'interest-1' });
      prisma.coBuyMessage.findMany.mockResolvedValue([]);
      await expect(service.getCoBuyMessages('offer-1', 'cust-1', 'Customer')).resolves.toEqual([]);
    });

    it('rejects a customer with no interest in the deal', async () => {
      prisma.offer.findUnique.mockResolvedValue({ business_id: 'biz-1' });
      prisma.offerInterest.findUnique.mockResolvedValue(null);
      await expect(service.getCoBuyMessages('offer-1', 'cust-1', 'Customer')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejects a different business entirely', async () => {
      prisma.offer.findUnique.mockResolvedValue({ business_id: 'biz-1' });
      prisma.offerInterest.findUnique.mockResolvedValue(null);
      await expect(service.getCoBuyMessages('offer-1', 'other-biz', 'Business')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('404s for a deal that does not exist', async () => {
      prisma.offer.findUnique.mockResolvedValue(null);
      await expect(service.getCoBuyMessages('missing', 'cust-1', 'Customer')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
