import { Injectable, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { ImportJobStatus, Source } from '@prisma/client';
import { ImportJobRepository } from './import-job.repository';
import { UrlFetchService, UrlFetchError } from './url-fetch.service';
import { ContentExtractionService } from './content-extraction.service';
import { TextExtractionService } from './text-extraction.service';
import { ConfidenceScoringService } from './confidence-scoring.service';
import { CandidateOfferService } from './candidate-offer.service';
import { NormalizationService } from './normalization.service';
import { DuplicateDetectionService } from './duplicate-detection.service';
import { FileValidationService } from './file-validation.service';
import { FileImportError } from './file-import.errors';
import { PdfTextService } from './pdf-text.service';
import { ImagePreprocessingService } from './image-preprocessing.service';
import { OcrService } from './ocr.service';
import { StorageService } from '../common/services/storage.service';

// Reasons that represent routine, expected outcomes — logged as a warning
// and stored on the job, but not sent to Sentry. Anything else reaching a
// catch block is treated as unexpected and reported, following the Module 7
// lesson that fire-and-forget capture silently drops events — explicit
// captureException + flush is used here for the same reason. Covers both
// the website-import pipeline (Module 9) and the file-import pipeline
// (Module 10 Phase 2).
const KNOWN_FAILURE_REASONS = new Set([
  // Website import (Module 9)
  'INVALID_URL',
  'INVALID_SCHEME',
  'SSRF_BLOCKED',
  'DNS_ERROR',
  'TIMEOUT',
  'NETWORK_ERROR',
  'HTTP_ERROR',
  'UNSUPPORTED_CONTENT_TYPE',
  'RESPONSE_TOO_LARGE',
  'REDIRECT_LIMIT',
  'REDIRECT_INVALID',
  // File import (Module 10 Phase 2)
  'INVALID_FILE_TYPE',
  'FILE_TOO_LARGE',
  'INVALID_FILE_SIGNATURE',
  'FILE_TYPE_MISMATCH',
  'STORAGE_FAILED',
  'PDF_PARSE_FAILED',
  'UNSUPPORTED_SCANNED_PDF',
  'OCR_FAILED',
]);

const UPLOAD_FOLDER = 'discovery';

// Coordinates the discovery services through one ImportJob's lifecycle
// (QUEUED -> PROCESSING -> DONE/FAILED). Owns no fetch/extraction/scoring
// logic itself — that separation is the point (each concern independently
// testable and replaceable).
@Injectable()
export class ImportOrchestrationService {
  private readonly logger = new Logger(ImportOrchestrationService.name);

  constructor(
    private readonly importJobRepo: ImportJobRepository,
    private readonly urlFetchService: UrlFetchService,
    private readonly contentExtractionService: ContentExtractionService,
    private readonly textExtractionService: TextExtractionService,
    private readonly confidenceScoringService: ConfidenceScoringService,
    private readonly candidateOfferService: CandidateOfferService,
    private readonly normalizationService: NormalizationService,
    private readonly duplicateDetectionService: DuplicateDetectionService,
    private readonly fileValidationService: FileValidationService,
    private readonly storageService: StorageService,
    private readonly pdfTextService: PdfTextService,
    private readonly imagePreprocessingService: ImagePreprocessingService,
    private readonly ocrService: OcrService,
  ) {}

  async importFromWebsite(sourceUrl: string) {
    const job = await this.importJobRepo.createJob(sourceUrl, Source.WEBSITE);
    this.logger.log(`Import job ${job.id} queued for ${sourceUrl}`);

    await this.importJobRepo.updateJobStatus(
      job.id,
      ImportJobStatus.PROCESSING,
    );
    this.logger.log(`Import job ${job.id} processing`);

    try {
      const { html, finalUrl } =
        await this.urlFetchService.fetchHtml(sourceUrl);
      const fields = this.contentExtractionService.extract(html);
      const confidence = this.confidenceScoringService.score(fields);

      // A candidate offer is only worth creating (and putting in front of
      // an admin) if extraction found at least a title — anything with
      // zero usable content isn't a reviewable "offer," just a failed
      // scrape. Everything else proceeds regardless of how low the
      // confidence is; that's exactly what the review queue is for.
      let candidateOfferId: string | undefined;
      let candidateBusinessId: string | undefined;
      let warnings: string[] = [];
      if (fields.title) {
        const candidate = await this.candidateOfferService.createCandidate({
          sourceUrl: finalUrl,
          sourceType: Source.WEBSITE,
          fields,
          confidence,
          normalized: this.normalizationService.normalize(fields),
        });
        candidateOfferId = candidate.offer.id;
        candidateBusinessId = candidate.business.id;
        warnings = candidate.warnings;
        await this.duplicateDetectionService.detectAndFlag(
          candidate.offer,
          candidate.business,
        );
      }

      const done = await this.importJobRepo.updateJobStatus(
        job.id,
        ImportJobStatus.DONE,
        {
          extracted_fields: {
            ...fields,
            final_url: finalUrl,
            confidence_score: confidence,
            candidate_created: Boolean(candidateOfferId),
            warnings,
          },
          ...(candidateOfferId ? { created_offer_id: candidateOfferId } : {}),
          ...(candidateBusinessId
            ? { created_business_id: candidateBusinessId }
            : {}),
        },
      );
      this.logger.log(
        `Import job ${job.id} done — confidence=${confidence}${candidateOfferId ? `, candidate offer=${candidateOfferId}` : ' (no candidate — no title extracted)'}`,
      );
      return done;
    } catch (err) {
      return this.handleFailure(job.id, err);
    }
  }

  // Module 10 Phase 2 — file (poster image / text-layer PDF) import.
  // Validation and upload happen synchronously here, so a bad file never
  // even reaches OCR ("reject unsupported formats before processing" —
  // Decision 1); the slow part (OCR / PDF text extraction) is deferred to
  // a fire-and-forget continuation, and this method returns as soon as the
  // upload completes (Decision 2). Every outcome — including validation
  // and storage failures — is recorded on a real ImportJob, matching the
  // website-import precedent where even fast/cheap validation failures
  // (INVALID_URL) go through the same job lifecycle rather than a bare
  // HTTP error with no audit trail.
  async importFromFile(params: {
    buffer: Buffer;
    mimetype: string;
    originalFilename: string;
  }) {
    const { buffer, mimetype, originalFilename } = params;
    const sanitizedName =
      this.fileValidationService.sanitizeFilename(originalFilename);

    // Placeholder until the real upload location is known — source_url is
    // non-nullable, and nothing reads this value as a real URL unless the
    // job fails before the update below runs.
    const job = await this.importJobRepo.createJob(
      `pending-upload://${sanitizedName}`,
      Source.POSTER,
    );
    this.logger.log(
      `Import job ${job.id} queued for uploaded file "${sanitizedName}"`,
    );
    await this.importJobRepo.updateJobStatus(
      job.id,
      ImportJobStatus.PROCESSING,
    );

    let sourceUrl: string;
    let sourceType: Source;
    try {
      this.fileValidationService.validate({
        mimetype,
        size: buffer.length,
        buffer,
      });
      sourceType = mimetype === 'application/pdf' ? Source.PDF : Source.POSTER;

      try {
        sourceUrl = await this.storageService.uploadFile(
          {
            buffer,
            originalname: sanitizedName,
            mimetype,
          } as Express.Multer.File,
          UPLOAD_FOLDER,
        );
      } catch (err) {
        throw new FileImportError(
          `Failed to store uploaded file: ${err instanceof Error ? err.message : 'unknown error'}`,
          'STORAGE_FAILED',
        );
      }
    } catch (err) {
      return this.handleFailure(job.id, err);
    }

    const uploaded = await this.importJobRepo.updateJobStatus(
      job.id,
      ImportJobStatus.PROCESSING,
      // The job was created with a POSTER placeholder before the real
      // mimetype was known (see the createJob call above) — correct it
      // here now that sourceType has been derived, so a PDF upload doesn't
      // permanently show as POSTER in the admin jobs list.
      { source_url: sourceUrl, source_type: sourceType },
    );
    this.logger.log(
      `Import job ${job.id} uploaded to ${sourceUrl} — OCR/extraction continuing in the background`,
    );

    // Fire-and-forget: intentionally not awaited, so the HTTP response
    // returns now rather than blocking for the OCR/PDF-parse duration.
    this.processFileContent(job.id, sourceUrl, sourceType, buffer).catch(
      (err) => {
        this.logger.error(
          `Unhandled error in background file-import processing for job ${job.id}`,
          err instanceof Error ? err.stack : undefined,
        );
      },
    );

    return uploaded;
  }

  private async processFileContent(
    jobId: string,
    sourceUrl: string,
    sourceType: Source,
    buffer: Buffer,
  ) {
    try {
      let rawText: string;
      let ocrConfidence: number | undefined;

      if (sourceType === Source.PDF) {
        rawText = await this.pdfTextService.extractText(buffer);
      } else {
        const preprocessed =
          await this.imagePreprocessingService.resizeIfNeeded(buffer);
        let ocrResult: { text: string; confidence: number };
        try {
          ocrResult = await this.ocrService.extractText(preprocessed);
        } catch (err) {
          throw new FileImportError(
            `OCR failed: ${err instanceof Error ? err.message : 'unknown error'}`,
            'OCR_FAILED',
          );
        }
        rawText = ocrResult.text;
        ocrConfidence = ocrResult.confidence;
      }

      const fields = this.textExtractionService.extract(rawText);
      const confidence = this.confidenceScoringService.score(
        fields,
        ocrConfidence,
      );

      let candidateOfferId: string | undefined;
      let candidateBusinessId: string | undefined;
      let warnings: string[] = [];
      if (fields.title) {
        const candidate = await this.candidateOfferService.createCandidate({
          sourceUrl,
          sourceType,
          fields,
          confidence,
          normalized: this.normalizationService.normalize(fields),
        });
        candidateOfferId = candidate.offer.id;
        candidateBusinessId = candidate.business.id;
        warnings = candidate.warnings;
        await this.duplicateDetectionService.detectAndFlag(
          candidate.offer,
          candidate.business,
        );
      }

      await this.importJobRepo.updateJobStatus(jobId, ImportJobStatus.DONE, {
        extracted_fields: {
          ...fields,
          ocr_confidence: ocrConfidence ?? null,
          confidence_score: confidence,
          candidate_created: Boolean(candidateOfferId),
          warnings,
        },
        ...(candidateOfferId ? { created_offer_id: candidateOfferId } : {}),
        ...(candidateBusinessId
          ? { created_business_id: candidateBusinessId }
          : {}),
      });
      this.logger.log(
        `Import job ${jobId} done — confidence=${confidence}${candidateOfferId ? `, candidate offer=${candidateOfferId}` : ' (no candidate — no title extracted)'}`,
      );
    } catch (err) {
      await this.handleFailure(jobId, err);
    }
  }

  private async handleFailure(jobId: string, err: unknown) {
    const reason =
      err instanceof UrlFetchError || err instanceof FileImportError
        ? err.reason
        : 'UNKNOWN_ERROR';
    const message = err instanceof Error ? err.message : 'Unknown import error';

    if (!KNOWN_FAILURE_REASONS.has(reason)) {
      Sentry.captureException(err, {
        tags: { module: 'discovery', importJobId: jobId, reason },
      });
      await Sentry.flush(2000);
      this.logger.error(
        `Import job ${jobId} failed unexpectedly: ${message}`,
        err instanceof Error ? err.stack : undefined,
      );
    } else {
      this.logger.warn(`Import job ${jobId} failed (${reason}): ${message}`);
    }

    return this.importJobRepo.updateJobStatus(jobId, ImportJobStatus.FAILED, {
      error: `${reason}: ${message}`,
    });
  }
}
