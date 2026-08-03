import { OfferService } from './offer.service';

// Production incident, this session: GET /offers/list?status=ALL (the Deals
// Moderation admin page) took 15-18 seconds and worsened on repeat calls,
// even though the underlying SQL query itself ran in under a millisecond
// (confirmed via EXPLAIN ANALYZE) and the same query through Prisma's exact
// production adapter setup completed in under a second. The one concrete,
// fixable defect found during that investigation: this was the only caller
// of listOffers with no row cap at all — status=ALL fetched the entire
// offers table, unbounded, on every call. At today's ~20-row catalog
// that's invisible; at the "thousands of offers" volume the launch roadmap
// targets, an unbounded admin fetch is a real scaling failure waiting to
// happen regardless of today's mystery latency. This spec locks in the cap.
describe('OfferService.listOffers — pagination cap', () => {
  const makePrisma = () => ({
    offer: { findMany: jest.fn().mockResolvedValue([]) },
  });

  const makeService = (prisma: ReturnType<typeof makePrisma>) =>
    new OfferService(
      prisma as any,
      {} as any, // NotificationService — unused by listOffers
      {} as any, // OtpService
      {} as any, // StorageService
      {} as any, // WhatsappService
      { get: jest.fn() } as any, // ConfigService
      {} as any, // CategoryService — unused by listOffers
      {} as any, // FileValidationService — unused by listOffers
    );

  it('caps an unbounded request (status=ALL) at the default page size', async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);

    await service.listOffers({ status: 'ALL' });

    const call = prisma.offer.findMany.mock.calls[0][0];
    expect(call.take).toBe(100);
    expect(call.skip).toBe(0);
  });

  it('honours an explicit, in-range limit', async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);

    await service.listOffers({ status: 'ALL', limit: 25 });

    expect(prisma.offer.findMany.mock.calls[0][0].take).toBe(25);
  });

  it('never allows a caller-supplied limit past the hard ceiling', async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);

    await service.listOffers({ status: 'ALL', limit: 100000 });

    expect(prisma.offer.findMany.mock.calls[0][0].take).toBe(200);
  });

  it('rejects a zero or negative limit rather than requesting zero/negative rows', async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);

    await service.listOffers({ status: 'ALL', limit: 0 });
    expect(prisma.offer.findMany.mock.calls[0][0].take).toBe(1);

    await service.listOffers({ status: 'ALL', limit: -5 });
    expect(prisma.offer.findMany.mock.calls[1][0].take).toBe(1);
  });

  it('computes skip from page using the resolved page size', async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);

    await service.listOffers({ status: 'ALL', page: 3, limit: 20 });

    const call = prisma.offer.findMany.mock.calls[0][0];
    expect(call.take).toBe(20);
    expect(call.skip).toBe(40); // (page 3 - 1) * 20
  });

  it('treats page 0 or negative page the same as page 1', async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);

    await service.listOffers({ status: 'ALL', page: 0 });
    expect(prisma.offer.findMany.mock.calls[0][0].skip).toBe(0);

    await service.listOffers({ status: 'ALL', page: -3 });
    expect(prisma.offer.findMany.mock.calls[1][0].skip).toBe(0);
  });

  it('also caps the default (ACTIVE-only, no explicit status) call', async () => {
    // The cap applies universally, not only to the ALL branch — a category
    // page with no filters must be equally protected from unbounded growth.
    const prisma = makePrisma();
    const service = makeService(prisma);

    await service.listOffers({});

    expect(prisma.offer.findMany.mock.calls[0][0].take).toBe(100);
  });
});
