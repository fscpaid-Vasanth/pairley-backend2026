import { Injectable, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { ImportJobStatus, Source } from '@prisma/client';
import { ImportJobRepository } from './import-job.repository';
import { UrlFetchService, UrlFetchError } from './url-fetch.service';
import { ContentExtractionService } from './content-extraction.service';
import { ConfidenceScoringService } from './confidence-scoring.service';

// Reasons that represent routine, expected outcomes (a bad URL, an
// unreachable or slow site, a blocked SSRF target) — logged as a warning
// and stored on the job, but not sent to Sentry. Anything else reaching the
// catch block below is treated as unexpected and reported, following the
// Module 7 lesson that fire-and-forget capture silently drops events —
// explicit captureException + flush is used here for the same reason.
const KNOWN_FAILURE_REASONS = new Set([
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
]);

// Coordinates the four discovery services through one ImportJob's lifecycle
// (QUEUED -> PROCESSING -> DONE/FAILED). Owns no fetch/extraction/scoring
// logic itself — that separation is the point (each concern independently
// testable and replaceable, e.g. when a real LLM standardization step
// replaces ContentExtractionService's internals in a later module).
@Injectable()
export class ImportOrchestrationService {
  private readonly logger = new Logger(ImportOrchestrationService.name);

  constructor(
    private readonly importJobRepo: ImportJobRepository,
    private readonly urlFetchService: UrlFetchService,
    private readonly contentExtractionService: ContentExtractionService,
    private readonly confidenceScoringService: ConfidenceScoringService,
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

      const done = await this.importJobRepo.updateJobStatus(
        job.id,
        ImportJobStatus.DONE,
        {
          extracted_fields: {
            ...fields,
            final_url: finalUrl,
            confidence_score: confidence,
          },
        },
      );
      this.logger.log(`Import job ${job.id} done — confidence=${confidence}`);
      return done;
    } catch (err) {
      const reason =
        err instanceof UrlFetchError ? err.reason : 'UNKNOWN_ERROR';
      const message =
        err instanceof Error ? err.message : 'Unknown import error';

      if (!KNOWN_FAILURE_REASONS.has(reason)) {
        Sentry.captureException(err, {
          tags: { module: 'discovery', importJobId: job.id, reason },
        });
        await Sentry.flush(2000);
        this.logger.error(
          `Import job ${job.id} failed unexpectedly: ${message}`,
          err instanceof Error ? err.stack : undefined,
        );
      } else {
        this.logger.warn(`Import job ${job.id} failed (${reason}): ${message}`);
      }

      const failed = await this.importJobRepo.updateJobStatus(
        job.id,
        ImportJobStatus.FAILED,
        {
          error: `${reason}: ${message}`,
        },
      );
      return failed;
    }
  }
}
