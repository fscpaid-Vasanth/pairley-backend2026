import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import {
  BusinessStatus,
  Prisma,
  Source,
  OfferStatus,
  OfferType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/services/storage.service';
import { validateSheetFile } from './sheetFileValidation';
import { parseOfferRows } from './bulkOfferParsers';
import {
  validateBulkOfferRow,
  findDuplicateRowIndexes,
} from './bulkOfferValidation';
import { BulkOfferRowInput, NormalizedBulkOffer } from './bulkOfferRow.types';

const UPLOAD_FOLDER = 'bulk-import';

// Postgres can bind at most 65535 parameters per statement; a single Offer
// insert uses ~25 columns, so this stays comfortably inside that limit even
// for a 10,000-row batch split into chunks — createMany() batches these
// automatically, but chunking the JS-side loop keeps memory bounded too.
const INSERT_CHUNK_SIZE = 1000;

@Injectable()
export class BulkImportService {
  private readonly logger = new Logger(BulkImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Stage 1 — upload, parse, and validate. Fully synchronous: parsing and
   * validateBulkOfferRow are both pure/in-memory (no network calls, unlike
   * the old AI pipeline's OCR/crawling), so even 10,000 rows resolve in
   * well under a second of CPU time. The only I/O here is one file upload
   * and two batched queries — nothing that needs a background scheduler.
   * Draft creation (createDraftsForBatch) is what's actually slow, since it
   * writes a Business+Offer per row — that's what the scheduler is for.
   */
  async createBatch(file: Express.Multer.File, adminId: string) {
    const format = validateSheetFile(file); // throws FileImportError on a bad file — let it propagate, the controller maps it to 400
    const fileUrl = await this.storage.uploadFile(file, UPLOAD_FOLDER);

    let rows: BulkOfferRowInput[];
    try {
      rows = await parseOfferRows(file.buffer, format);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown parse error';
      this.logger.warn(`Bulk import file failed to parse: ${message}`);
      return this.prisma.bulkImportBatch.create({
        data: {
          file_name: file.originalname,
          file_url: fileUrl,
          uploaded_by: adminId,
          status: 'FAILED',
          error: `Could not read this file as ${format.toUpperCase()}: ${message}`,
        },
      });
    }

    if (rows.length === 0) {
      return this.prisma.bulkImportBatch.create({
        data: {
          file_name: file.originalname,
          file_url: fileUrl,
          uploaded_by: adminId,
          status: 'FAILED',
          error: 'The file has no data rows (only a header, or is empty)',
        },
      });
    }

    const perRow = rows.map((row) => ({
      row,
      result: validateBulkOfferRow(row),
    }));

    // Duplicate-row detection, scoped to rows that individually validated —
    // an already-INVALID row doesn't also need a duplicate verdict.
    const validEntries = perRow.filter(
      (
        e,
      ): e is {
        row: BulkOfferRowInput;
        result: {
          status: 'VALID';
          errors: [];
          warnings: string[];
          normalized: NormalizedBulkOffer;
        };
      } => e.result.status === 'VALID',
    );
    const duplicateRowNos = findDuplicateRowIndexes(
      validEntries.map((e) => ({
        rowNo: e.row.rowNo,
        normalized: e.result.normalized,
      })),
    );

    // Existing-business matching, batched — one query for every phone
    // number in the batch, not one query per row.
    const phones = [
      ...new Set(validEntries.map((e) => e.result.normalized.mobile)),
    ];
    const existingBusinesses = phones.length
      ? await this.prisma.business.findMany({
          where: { mobile: { in: phones } },
          select: { id: true, mobile: true },
        })
      : [];
    const phoneToBusinessId = new Map(
      existingBusinesses
        .filter((b) => b.mobile)
        .map((b) => [b.mobile as string, b.id]),
    );

    let validCount = 0;
    let invalidCount = 0;
    let duplicateCount = 0;

    const rowInputs = perRow.map(({ row, result }) => {
      const isDuplicate =
        result.status === 'VALID' && duplicateRowNos.has(row.rowNo);
      const finalStatus = isDuplicate ? 'DUPLICATE' : result.status;

      if (finalStatus === 'VALID') validCount++;
      else if (finalStatus === 'DUPLICATE') duplicateCount++;
      else invalidCount++;

      const matchedBusinessId =
        finalStatus === 'VALID' && result.normalized
          ? (phoneToBusinessId.get(result.normalized.mobile) ?? null)
          : null;

      return {
        row_no: row.rowNo,
        raw_data: row as unknown as Prisma.InputJsonValue,
        normalized:
          finalStatus === 'VALID' && result.normalized
            ? (result.normalized as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        status: finalStatus,
        errors: isDuplicate
          ? ['Duplicate of another row in this upload']
          : result.errors,
        warnings: result.warnings,
        matched_business_id: matchedBusinessId,
      };
    });

    const batch = await this.prisma.bulkImportBatch.create({
      data: {
        file_name: file.originalname,
        file_url: fileUrl,
        uploaded_by: adminId,
        status: 'VALIDATED',
        total_rows: rows.length,
        valid_rows: validCount,
        invalid_rows: invalidCount,
        duplicate_rows: duplicateCount,
        started_at: new Date(),
        completed_at: new Date(),
      },
    });

    for (let i = 0; i < rowInputs.length; i += INSERT_CHUNK_SIZE) {
      const chunk = rowInputs.slice(i, i + INSERT_CHUNK_SIZE);
      await this.prisma.bulkImportRow.createMany({
        data: chunk.map((r) => ({ ...r, batch_id: batch.id })),
      });
    }

    this.logger.log(
      `Bulk import batch ${batch.id} validated — ${validCount} valid, ${invalidCount} invalid, ${duplicateCount} duplicate of ${rows.length} rows`,
    );

    return batch;
  }

  async getBatch(batchId: string) {
    const batch = await this.prisma.bulkImportBatch.findUnique({
      where: { id: batchId },
    });
    if (!batch) throw new NotFoundException('Import batch not found');
    return batch;
  }

  /** Everything the Preview screen needs, computed from the already-persisted rows — no re-validation. */
  async getPreview(batchId: string) {
    const batch = await this.getBatch(batchId);
    const validRows = await this.prisma.bulkImportRow.findMany({
      where: { batch_id: batchId, status: 'VALID' },
      select: { normalized: true },
    });
    const merchantKeys = new Set(
      validRows.map((r) => {
        const n = r.normalized as unknown as NormalizedBulkOffer | null;
        return n ? `${n.mobile}` : '';
      }),
    );
    const rowsWithWarnings = await this.prisma.bulkImportRow.count({
      where: { batch_id: batchId, warnings: { isEmpty: false } },
    });

    return {
      batch,
      totalOffers: batch.total_rows,
      validOffers: batch.valid_rows,
      invalidOffers: batch.invalid_rows,
      duplicateOffers: batch.duplicate_rows,
      distinctMerchants: merchantKeys.size,
      rowsWithWarnings,
    };
  }

  /** INVALID/DUPLICATE rows with their reasons — the frontend renders this as a downloadable CSV. */
  async getErrorRows(batchId: string) {
    await this.getBatch(batchId);
    return this.prisma.bulkImportRow.findMany({
      where: { batch_id: batchId, status: { in: ['INVALID', 'DUPLICATE'] } },
      select: { row_no: true, raw_data: true, status: true, errors: true },
      orderBy: { row_no: 'asc' },
    });
  }

  async listHistory() {
    return this.prisma.bulkImportBatch.findMany({
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        file_name: true,
        uploaded_by: true,
        status: true,
        total_rows: true,
        valid_rows: true,
        invalid_rows: true,
        duplicate_rows: true,
        published_rows: true,
        total_images: true,
        mapped_images: true,
        failed_images: true,
        started_at: true,
        completed_at: true,
        created_at: true,
      },
    });
  }

  /** Admin action: begin creating DRAFT business+offer records for every VALID row. Processed by BulkImportScheduler. */
  async startCreatingDrafts(batchId: string) {
    const batch = await this.getBatch(batchId);
    if (batch.status !== 'VALIDATED') {
      throw new BadRequestException(
        `Cannot create drafts from status ${batch.status} — the batch must be VALIDATED first`,
      );
    }
    return this.prisma.bulkImportBatch.update({
      where: { id: batchId },
      data: { status: 'CREATING', started_at: new Date() },
    });
  }

  /**
   * Called by the scheduler, once per VALID row still missing a
   * created_offer_id. Business find-or-create by phone (the same signal
   * already used for the Preview's duplicate count, so what the admin saw
   * matches what actually happens) + Offer create as DRAFT, in one
   * transaction so a mid-write failure never leaves an orphaned business.
   */
  async createDraftForRow(rowId: string): Promise<void> {
    const row = await this.prisma.bulkImportRow.findUnique({
      where: { id: rowId },
    });
    if (!row || row.status !== 'VALID' || !row.normalized) return;

    const data = row.normalized as unknown as NormalizedBulkOffer;

    try {
      const offerId = await this.prisma.$transaction(async (tx) => {
        let businessId = row.matched_business_id;

        if (!businessId) {
          const business = await tx.business.create({
            data: {
              owner_name: data.merchantName,
              business_name: data.merchantName,
              // No separate "Business Type" column exists in the sheet —
              // category is the closest available signal, and a more
              // meaningful default than a generic constant for every row.
              business_type: data.category,
              category: data.category,
              mobile: data.mobile,
              email: data.email,
              address: data.address,
              city: data.city,
              state: data.state,
              pincode: data.pincode,
              website: data.website,
              geo_lat: data.geoLat,
              geo_lng: data.geoLng,
              // Lead-generation revision: bulk-imported merchants stay
              // UNCLAIMED, exactly like every other imported/undiscovered
              // business — no special "admin has vouched for this" status
              // anymore now that customer contact is never revealed
              // regardless of business status. The real owner claims it
              // through the existing OTP flow like any other UNCLAIMED
              // business.
              business_status: BusinessStatus.UNCLAIMED,
              source: Source.ADMIN,
            },
          });
          businessId = business.id;
        }

        const offerType = data.offerType as OfferType;
        const offer = await tx.offer.create({
          data: {
            business_id: businessId,
            title: data.title,
            description: data.description,
            offer_type: offerType,
            category: data.category,
            original_price: data.originalPrice,
            offer_price: data.offerPrice,
            required_people: data.requiredPeople,
            start_date: data.startDate,
            end_date: data.endDate,
            whatsapp_number: data.whatsapp,
            geo_lat: data.geoLat,
            geo_lng: data.geoLng,
            status: OfferStatus.DRAFT,
            source: Source.ADMIN,
          },
        });

        await tx.bulkImportRow.update({
          where: { id: row.id },
          data: {
            status: 'CREATED',
            matched_business_id: businessId,
            created_offer_id: offer.id,
          },
        });

        return offer.id;
      });

      await this.prisma.bulkImportBatch.update({
        where: { id: row.batch_id },
        data: { created_rows: { increment: 1 } },
      });
      this.logger.debug(
        `Bulk import row ${row.id} -> offer ${offerId} created`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await this.prisma.bulkImportRow.update({
        where: { id: row.id },
        data: {
          status: 'FAILED',
          errors: { push: `Create failed: ${message}` },
        },
      });
      this.logger.error(
        `Bulk import row ${row.id} failed to create: ${message}`,
      );
    }
  }

  /** Admin action: flip every CREATED offer in this batch from DRAFT to ACTIVE. Processed by BulkImportScheduler. */
  async startPublishing(batchId: string) {
    const batch = await this.getBatch(batchId);
    if (batch.status !== 'CREATED') {
      throw new BadRequestException(
        `Cannot publish from status ${batch.status} — offers must finish being created first`,
      );
    }
    return this.prisma.bulkImportBatch.update({
      where: { id: batchId },
      data: { status: 'PUBLISHING' },
    });
  }

  /** Called by the scheduler, once per CREATED row with an offer still in DRAFT. */
  async publishRow(rowId: string): Promise<void> {
    const row = await this.prisma.bulkImportRow.findUnique({
      where: { id: rowId },
    });
    if (!row || row.status !== 'CREATED' || !row.created_offer_id) return;

    try {
      await this.prisma.offer.update({
        where: { id: row.created_offer_id },
        data: { status: OfferStatus.ACTIVE },
      });
      await this.prisma.bulkImportRow.update({
        where: { id: row.id },
        data: { status: 'PUBLISHED' },
      });
      await this.prisma.bulkImportBatch.update({
        where: { id: row.batch_id },
        data: { published_rows: { increment: 1 } },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await this.prisma.bulkImportRow.update({
        where: { id: row.id },
        data: {
          status: 'FAILED',
          errors: { push: `Publish failed: ${message}` },
        },
      });
      this.logger.error(
        `Bulk import row ${row.id} failed to publish: ${message}`,
      );
    }
  }
}
