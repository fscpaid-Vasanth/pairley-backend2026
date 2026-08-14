import { DashboardService } from './dashboard.service';

// No pre-existing spec file for this service — scoped narrowly to
// listLeads(), the new lead-generation-revision endpoint, rather than
// retrofitting coverage for the rest of DashboardService.
describe('DashboardService.listLeads', () => {
  let prisma: { lead: { findMany: jest.Mock } };
  let service: DashboardService;

  beforeEach(() => {
    prisma = { lead: { findMany: jest.fn().mockResolvedValue([]) } };
    service = new DashboardService(prisma as any, {} as any);
  });

  it('lists every lead platform-wide, newest first, with no filter by default', async () => {
    await service.listLeads();
    expect(prisma.lead.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {},
        orderBy: { created_at: 'desc' },
      }),
    );
  });

  it('filters by status when given', async () => {
    await service.listLeads('NEW');
    expect(prisma.lead.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'NEW' } }),
    );
  });

  // The exact field list the admin lead dashboard needs — customer
  // name/mobile, offer, merchant, date, status — all denormalized directly
  // on Lead, so this select is a straight list rather than a join.
  it('selects exactly the fields the admin lead dashboard displays', async () => {
    await service.listLeads();
    const call = prisma.lead.findMany.mock.calls[0][0];
    expect(call.select).toEqual({
      id: true,
      customer_id: true,
      customer_name: true,
      customer_mobile: true,
      offer_id: true,
      offer_name: true,
      shop_id: true,
      shop_name: true,
      status: true,
      source: true,
      created_at: true,
    });
  });
});

// 2026-08-13 — Shop Onboardings must show only businesses a real human took
// action on, never a business the AI Offer Collector's own pipeline spun up
// on its own that nobody has claimed yet. See ai-offers-from-online plan.
describe('DashboardService — Shop Onboardings excludes unclaimed AI businesses', () => {
  let prisma: any;
  let service: DashboardService;

  beforeEach(() => {
    prisma = {
      business: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      customer: { count: jest.fn().mockResolvedValue(0) },
      offer: { count: jest.fn().mockResolvedValue(0) },
      subscription: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }) },
    };
    service = new DashboardService(prisma as any, {} as any);
  });

  it('listBusinesses excludes AI-created, still-UNCLAIMED businesses by default', async () => {
    await service.listBusinesses();
    const where = prisma.business.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ NOT: { created_by_ai: true, business_status: 'UNCLAIMED' } });
  });

  it('listBusinesses combines the exclusion with an explicit status filter', async () => {
    await service.listBusinesses('PENDING');
    const where = prisma.business.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      NOT: { created_by_ai: true, business_status: 'UNCLAIMED' },
      verification_status: 'PENDING',
    });
  });

  it('getAdminMetrics.pendingApprovals excludes AI-created UNCLAIMED businesses from the count', async () => {
    await service.getAdminMetrics();
    const pendingCall = prisma.business.count.mock.calls.find(
      (c: any) => c[0]?.where?.verification_status === 'PENDING',
    );
    expect(pendingCall[0].where).toEqual({
      verification_status: 'PENDING',
      NOT: { created_by_ai: true, business_status: 'UNCLAIMED' },
    });
  });
});
