import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { BulkImportService } from './bulk-import.service';

// Small enough that a tick finishes well within the 5-second interval even
// for a large batch, so ticks never pile up; large enough that a
// 10,000-row batch clears in well under a minute of ticks.
const CHUNK_SIZE = 200;

/**
 * Bulk Offer Import — background processing for the two genuinely slow,
 * write-heavy stages: creating a DRAFT business+offer per valid row, and
 * later flipping each to ACTIVE. Both are safe to defer to ticks because
 * the data they need (BulkImportRow.normalized) is already durably
 * persisted — unlike Bulk Image Upload, which processes synchronously
 * within its own request for the reasons documented in
 * bulk-image-import.service.ts.
 *
 * Same @nestjs/schedule cron pattern as OfferExpiryScheduler — no new
 * queue dependency. `processing` guards against overlapping ticks if one
 * takes longer than the interval (e.g. several large batches in flight
 * at once).
 */
@Injectable()
export class BulkImportScheduler {
  private readonly logger = new Logger(BulkImportScheduler.name);
  private processing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bulkImportService: BulkImportService,
  ) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  async tick() {
    if (this.processing) return;
    this.processing = true;
    try {
      await this.processCreatingBatches();
      await this.processPublishingBatches();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Bulk import scheduler tick failed: ${message}`);
    } finally {
      this.processing = false;
    }
  }

  private async processCreatingBatches() {
    const batches = await this.prisma.bulkImportBatch.findMany({
      where: { status: 'CREATING' },
      select: { id: true },
    });

    for (const batch of batches) {
      const rows = await this.prisma.bulkImportRow.findMany({
        where: { batch_id: batch.id, status: 'VALID' },
        take: CHUNK_SIZE,
        select: { id: true },
      });

      if (rows.length === 0) {
        await this.prisma.bulkImportBatch.update({
          where: { id: batch.id },
          data: { status: 'CREATED', completed_at: new Date() },
        });
        this.logger.log(
          `Bulk import batch ${batch.id} finished creating drafts`,
        );
        continue;
      }

      for (const row of rows) {
        await this.bulkImportService.createDraftForRow(row.id);
      }
    }
  }

  private async processPublishingBatches() {
    const batches = await this.prisma.bulkImportBatch.findMany({
      where: { status: 'PUBLISHING' },
      select: { id: true },
    });

    for (const batch of batches) {
      const rows = await this.prisma.bulkImportRow.findMany({
        where: { batch_id: batch.id, status: 'CREATED' },
        take: CHUNK_SIZE,
        select: { id: true },
      });

      if (rows.length === 0) {
        await this.prisma.bulkImportBatch.update({
          where: { id: batch.id },
          data: { status: 'COMPLETED', completed_at: new Date() },
        });
        this.logger.log(`Bulk import batch ${batch.id} finished publishing`);
        continue;
      }

      for (const row of rows) {
        await this.bulkImportService.publishRow(row.id);
      }
    }
  }
}
