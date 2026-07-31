import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import * as unzipper from 'unzipper';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/services/storage.service';
import { FileValidationService } from '../discovery/file-validation.service';
import { decideImageMapping, ImageMappingDecision } from './bulkImageMatching';

const IMAGE_UPLOAD_FOLDER = 'bulk-import/images';
const ZIP_UPLOAD_FOLDER = 'bulk-import/zips';

// A ZIP of a few thousand compressed JPEGs is realistically tens to a
// couple hundred MB — generous but bounded, so a request can't be used to
// exhaust server memory during extraction.
const MAX_ZIP_SIZE_BYTES = 250 * 1024 * 1024;

interface StagedFile {
  fileName: string;
  buffer: Buffer;
  mimetype: string;
}

/**
 * Bulk Image Upload.
 *
 * Deliberate scope note: this processes each file SYNCHRONOUSLY within the
 * upload request — the same pattern every other upload path in this
 * codebase already uses (business.service.ts, offer.service.ts's gallery
 * uploads) — rather than deferring the actual S3 PUT to a background
 * scheduler tick, unlike BulkImportService's offer creation/publish
 * stages. That's not an oversight: those stages defer real work to
 * background ticks because the data they need (a row's `normalized` JSON)
 * is already durably persisted, so a tick can pick up any row at any time.
 * An uploaded image's bytes are NOT durably persisted anywhere until they
 * reach S3 — there is no queue or staging store in this codebase to hand
 * them off to a later tick without either losing them on a server restart
 * or, equivalently, just uploading them now. "Background" here means what
 * it can honestly mean without a message-queue rewrite of the platform:
 * per-file progress (batch.mapped_images/failed_images) updates as the
 * request proceeds, so a client polling GET /admin/bulk-import/:id sees
 * live progress while the upload is still in flight. True crash-resume —
 * recovering after a server restart mid-upload — is not possible without
 * durable staging; the practical resume path is re-uploading the same ZIP
 * or files, which is safe to do: an already-MAPPED slot is never
 * overwritten (see decideImageMapping's DUPLICATE outcome), only a
 * previously FAILED/unattempted one is retried.
 */
@Injectable()
export class BulkImageImportService {
  private readonly logger = new Logger(BulkImageImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly fileValidation: FileValidationService,
  ) {}

  /** The offer_code -> offer_id map for this batch's already-created offers, plus every slot already filled. Both scoped to this batch only — see decideImageMapping's own safety note. */
  private async loadBatchImageContext(batchId: string) {
    const rows = await this.prisma.bulkImportRow.findMany({
      where: { batch_id: batchId, created_offer_id: { not: null } },
      select: { created_offer_id: true },
    });
    const offerIds = rows.map((r) => r.created_offer_id as string);
    const offers = offerIds.length
      ? await this.prisma.offer.findMany({
          where: { id: { in: offerIds } },
          select: { id: true, offer_code: true },
        })
      : [];
    const offerCodeToId = new Map(offers.map((o) => [o.offer_code, o.id]));

    // Only a genuinely MAPPED (uploaded) slot counts as taken — a FAILED or
    // never-attempted one stays open for a corrective re-upload.
    const mapped = await this.prisma.bulkImportImage.findMany({
      where: {
        batch_id: batchId,
        status: 'MAPPED',
        matched_offer_id: { not: null },
      },
      select: { matched_offer_id: true, slot: true },
    });
    const takenSlots = new Set(
      mapped.map((m) => `${m.matched_offer_id}:${m.slot}`),
    );

    return { offerCodeToId, takenSlots };
  }

  private async processOneFile(
    batchId: string,
    file: StagedFile,
    offerCodeToId: Map<number, string>,
    takenSlots: Set<string>,
  ): Promise<void> {
    const decision: ImageMappingDecision = decideImageMapping(
      file.fileName,
      offerCodeToId,
      takenSlots,
    );

    if (decision.status !== 'MAPPED') {
      await this.prisma.bulkImportImage.create({
        data: {
          batch_id: batchId,
          file_name: file.fileName,
          status: decision.status,
          parsed_code:
            decision.status === 'INVALID_FILE' ? null : decision.code,
          slot: decision.status === 'INVALID_FILE' ? null : decision.slot,
          matched_offer_id:
            decision.status === 'DUPLICATE' ? decision.offerId : null,
        },
      });
      await this.bumpCounter(batchId, 'failed_images');
      return;
    }

    try {
      this.fileValidation.validate({
        mimetype: file.mimetype,
        size: file.buffer.length,
        buffer: file.buffer,
      });
      if (file.mimetype === 'application/pdf') {
        throw new Error('PDF is not a supported image format');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid image file';
      await this.prisma.bulkImportImage.create({
        data: {
          batch_id: batchId,
          file_name: file.fileName,
          parsed_code: decision.code,
          slot: decision.slot,
          matched_offer_id: decision.offerId,
          status: 'FAILED',
          error: message,
        },
      });
      await this.bumpCounter(batchId, 'failed_images');
      return;
    }

    try {
      const url = await this.storage.uploadFile(
        {
          originalname: this.fileValidation.sanitizeFilename(file.fileName),
          buffer: file.buffer,
          mimetype: file.mimetype,
        } as Express.Multer.File,
        IMAGE_UPLOAD_FOLDER,
      );

      if (decision.slot === 0) {
        await this.prisma.offer.update({
          where: { id: decision.offerId },
          data: { cover_image: url },
        });
      } else {
        const offer = await this.prisma.offer.findUnique({
          where: { id: decision.offerId },
          select: { gallery_images: true },
        });
        await this.prisma.offer.update({
          where: { id: decision.offerId },
          data: { gallery_images: [...(offer?.gallery_images ?? []), url] },
        });
      }

      await this.prisma.bulkImportImage.create({
        data: {
          batch_id: batchId,
          file_name: file.fileName,
          slot: decision.slot,
          parsed_code: decision.code,
          matched_offer_id: decision.offerId,
          status: 'MAPPED',
        },
      });
      // Only reserved once genuinely filled — processing is sequential
      // (no concurrent writers to race), so a slot that failed above
      // correctly stays open for a subsequent, valid file in this same
      // upload to fill instead.
      takenSlots.add(`${decision.offerId}:${decision.slot}`);
      await this.bumpCounter(batchId, 'mapped_images');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      await this.prisma.bulkImportImage.create({
        data: {
          batch_id: batchId,
          file_name: file.fileName,
          slot: decision.slot,
          parsed_code: decision.code,
          matched_offer_id: decision.offerId,
          status: 'FAILED',
          error: message,
        },
      });
      await this.bumpCounter(batchId, 'failed_images');
      this.logger.error(
        `Bulk image upload failed for ${file.fileName}: ${message}`,
      );
    }
  }

  private async bumpCounter(
    batchId: string,
    field: 'mapped_images' | 'failed_images',
  ) {
    await this.prisma.bulkImportBatch.update({
      where: { id: batchId },
      data: { [field]: { increment: 1 }, total_images: { increment: 1 } },
    });
  }

  async uploadImageFiles(
    batchId: string,
    files: Express.Multer.File[],
  ): Promise<void> {
    await this.assertBatchReadyForImages(batchId);
    const { offerCodeToId, takenSlots } =
      await this.loadBatchImageContext(batchId);
    for (const file of files) {
      await this.processOneFile(
        batchId,
        {
          fileName: file.originalname,
          buffer: file.buffer,
          mimetype: file.mimetype,
        },
        offerCodeToId,
        takenSlots,
      );
    }
  }

  async uploadImageZip(
    batchId: string,
    zipFile: Express.Multer.File,
  ): Promise<void> {
    await this.assertBatchReadyForImages(batchId);
    if (zipFile.size > MAX_ZIP_SIZE_BYTES) {
      throw new BadRequestException(
        `ZIP exceeds the maximum allowed size of ${MAX_ZIP_SIZE_BYTES / (1024 * 1024)}MB`,
      );
    }

    // Keep the original archive too, for admin re-download/audit if a
    // batch of images needs revisiting later.
    await this.storage.uploadFile(zipFile, ZIP_UPLOAD_FOLDER);

    const { offerCodeToId, takenSlots } =
      await this.loadBatchImageContext(batchId);
    const directory = await unzipper.Open.buffer(zipFile.buffer);

    for (const entry of directory.files) {
      if (entry.type !== 'File') continue;
      // ZIP entries commonly carry a folder prefix (e.g. "images/OFF000123.jpg")
      // — only the basename is meaningful for matching.
      const fileName = entry.path.split('/').pop() ?? entry.path;
      if (!fileName) continue;

      const buffer = await entry.buffer();
      const mimetype = guessMimeType(fileName);
      await this.processOneFile(
        batchId,
        { fileName, buffer, mimetype },
        offerCodeToId,
        takenSlots,
      );
    }
  }

  private async assertBatchReadyForImages(batchId: string) {
    const batch = await this.prisma.bulkImportBatch.findUnique({
      where: { id: batchId },
    });
    if (!batch) throw new NotFoundException('Import batch not found');
    if (!['CREATED', 'PUBLISHING', 'COMPLETED'].includes(batch.status)) {
      throw new BadRequestException(
        `Cannot upload images until offers are created — batch is ${batch.status}`,
      );
    }
  }
}

function guessMimeType(fileName: string): string {
  const ext = fileName.toLowerCase().split('.').pop();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}
