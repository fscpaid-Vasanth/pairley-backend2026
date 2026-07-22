import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ImportJobStatus, Prisma, Source } from '@prisma/client';

// Module 9 Phase 1 — pure data-access layer for ImportJob. No fetch/
// extraction logic lives here (that's Phase 2); this only establishes
// create/update/read so later phases have somewhere to write to from day one.
@Injectable()
export class ImportJobRepository {
  constructor(private prisma: PrismaService) {}

  createJob(sourceUrl: string, sourceType: Source = Source.WEBSITE) {
    return this.prisma.importJob.create({
      data: { source_url: sourceUrl, source_type: sourceType },
    });
  }

  updateJobStatus(
    id: string,
    status: ImportJobStatus,
    patch?: Partial<
      Pick<
        Prisma.ImportJobUpdateInput,
        | 'error'
        | 'extracted_fields'
        | 'created_business_id'
        | 'created_offer_id'
        | 'source_url'
        | 'source_type'
      >
    >,
  ) {
    return this.prisma.importJob.update({
      where: { id },
      data: { status, ...patch },
    });
  }

  // Module 10 Phase 3 — the admin "Recent Imports" panel polls this
  // repeatedly while a job is in flight; an unbounded result set would grow
  // with total import volume forever, so a default/max limit keeps every
  // poll cheap regardless of how many imports have ever been run.
  findJobs(filters?: { status?: ImportJobStatus; limit?: number }) {
    const limit = Math.min(100, Math.max(1, filters?.limit || 20));
    return this.prisma.importJob.findMany({
      where: filters?.status ? { status: filters.status } : undefined,
      orderBy: { created_at: 'desc' },
      take: limit,
    });
  }

  findJobById(id: string) {
    return this.prisma.importJob.findUnique({ where: { id } });
  }
}
