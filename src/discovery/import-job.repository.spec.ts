import { ImportJobStatus, Source } from '@prisma/client';
import { ImportJobRepository } from './import-job.repository';
import { PrismaService } from '../prisma/prisma.service';

describe('ImportJobRepository', () => {
  let findMany: jest.Mock;
  let repo: ImportJobRepository;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([]);
    repo = new ImportJobRepository({
      importJob: { findMany },
    } as unknown as PrismaService);
  });

  describe('findJobs (Module 10 Phase 3 — bounded polling)', () => {
    it('defaults to a limit of 20 when none is given', async () => {
      await repo.findJobs();
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 20 }),
      );
    });

    it('honors an explicit, in-range limit', async () => {
      await repo.findJobs({ limit: 5 });
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5 }),
      );
    });

    it('clamps a limit above 100 down to 100', async () => {
      await repo.findJobs({ limit: 500 });
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });

    it('clamps a negative limit up to 1', async () => {
      await repo.findJobs({ limit: -5 });
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 1 }),
      );
    });

    it('still filters by status when provided alongside a limit', async () => {
      await repo.findJobs({ status: ImportJobStatus.FAILED, limit: 5 });
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: ImportJobStatus.FAILED },
          take: 5,
        }),
      );
    });
  });

  it('createJob defaults sourceType to WEBSITE', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'job-1' });
    const repoWithCreate = new ImportJobRepository({
      importJob: { create },
    } as unknown as PrismaService);
    await repoWithCreate.createJob('https://example.com/');
    expect(create).toHaveBeenCalledWith({
      data: { source_url: 'https://example.com/', source_type: Source.WEBSITE },
    });
  });
});
