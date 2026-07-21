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
      >
    >,
  ) {
    return this.prisma.importJob.update({
      where: { id },
      data: { status, ...patch },
    });
  }

  findJobs(filters?: { status?: ImportJobStatus }) {
    return this.prisma.importJob.findMany({
      where: filters?.status ? { status: filters.status } : undefined,
      orderBy: { created_at: 'desc' },
    });
  }

  findJobById(id: string) {
    return this.prisma.importJob.findUnique({ where: { id } });
  }
}
