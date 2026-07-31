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
