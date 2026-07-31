import { BulkImportScheduler } from './bulk-import.scheduler';

describe('BulkImportScheduler', () => {
  let prisma: {
    bulkImportBatch: { findMany: jest.Mock; update: jest.Mock };
    bulkImportRow: { findMany: jest.Mock };
  };
  let bulkImportService: {
    createDraftForRow: jest.Mock;
    publishRow: jest.Mock;
  };
  let scheduler: BulkImportScheduler;

  beforeEach(() => {
    prisma = {
      bulkImportBatch: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
      bulkImportRow: { findMany: jest.fn().mockResolvedValue([]) },
    };
    bulkImportService = {
      createDraftForRow: jest.fn().mockResolvedValue(undefined),
      publishRow: jest.fn().mockResolvedValue(undefined),
    };
    scheduler = new BulkImportScheduler(
      prisma as any,
      bulkImportService as any,
    );
  });

  it('processes a chunk of VALID rows for each CREATING batch', async () => {
    prisma.bulkImportBatch.findMany
      .mockResolvedValueOnce([{ id: 'batch-1' }]) // CREATING query
      .mockResolvedValueOnce([]); // PUBLISHING query
    prisma.bulkImportRow.findMany.mockResolvedValueOnce([
      { id: 'row-1' },
      { id: 'row-2' },
    ]);

    await scheduler.tick();

    expect(bulkImportService.createDraftForRow).toHaveBeenCalledWith('row-1');
    expect(bulkImportService.createDraftForRow).toHaveBeenCalledWith('row-2');
    expect(prisma.bulkImportBatch.update).not.toHaveBeenCalled();
  });

  it('flips a CREATING batch to CREATED once no VALID rows remain', async () => {
    prisma.bulkImportBatch.findMany
      .mockResolvedValueOnce([{ id: 'batch-1' }])
      .mockResolvedValueOnce([]);
    prisma.bulkImportRow.findMany.mockResolvedValueOnce([]); // nothing left to create

    await scheduler.tick();

    expect(bulkImportService.createDraftForRow).not.toHaveBeenCalled();
    expect(prisma.bulkImportBatch.update).toHaveBeenCalledWith({
      where: { id: 'batch-1' },
      data: expect.objectContaining({ status: 'CREATED' }),
    });
  });

  it('processes a chunk of CREATED rows for each PUBLISHING batch', async () => {
    prisma.bulkImportBatch.findMany
      .mockResolvedValueOnce([]) // CREATING query
      .mockResolvedValueOnce([{ id: 'batch-2' }]); // PUBLISHING query
    prisma.bulkImportRow.findMany.mockResolvedValueOnce([{ id: 'row-9' }]);

    await scheduler.tick();

    expect(bulkImportService.publishRow).toHaveBeenCalledWith('row-9');
  });

  it('flips a PUBLISHING batch to COMPLETED once no CREATED rows remain', async () => {
    prisma.bulkImportBatch.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'batch-2' }]);
    prisma.bulkImportRow.findMany.mockResolvedValueOnce([]);

    await scheduler.tick();

    expect(prisma.bulkImportBatch.update).toHaveBeenCalledWith({
      where: { id: 'batch-2' },
      data: expect.objectContaining({ status: 'COMPLETED' }),
    });
  });

  it('does not let overlapping ticks process the same batch twice', async () => {
    let resolveFirstQuery: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveFirstQuery = resolve;
    });
    prisma.bulkImportBatch.findMany.mockImplementationOnce(async () => {
      await gate;
      return [{ id: 'batch-1' }];
    });

    const firstTick = scheduler.tick();
    const secondTick = scheduler.tick(); // should return immediately, guarded by `processing`

    resolveFirstQuery!();
    await Promise.all([firstTick, secondTick]);

    // findMany is called twice per tick (CREATING, then PUBLISHING) — if
    // the second tick had also run, this would be 4 rather than 2.
    expect(prisma.bulkImportBatch.findMany).toHaveBeenCalledTimes(2);
  });

  it('logs rather than throws when a query fails mid-tick', async () => {
    prisma.bulkImportBatch.findMany.mockRejectedValueOnce(
      new Error('db unavailable'),
    );
    await expect(scheduler.tick()).resolves.toBeUndefined();
  });
});
