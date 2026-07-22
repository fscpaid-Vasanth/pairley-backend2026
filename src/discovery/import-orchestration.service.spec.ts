import { ImportJobStatus, Source } from '@prisma/client';
import * as Sentry from '@sentry/nestjs';
import { ImportOrchestrationService } from './import-orchestration.service';
import { UrlFetchError, UrlFetchService } from './url-fetch.service';
import { ImportJobRepository } from './import-job.repository';
import { ContentExtractionService } from './content-extraction.service';
import { TextExtractionService } from './text-extraction.service';
import { CandidateOfferService } from './candidate-offer.service';
import { NormalizationService } from './normalization.service';
import { DuplicateDetectionService } from './duplicate-detection.service';
import { FileImportError } from './file-import.errors';
import { ImagePreprocessingService } from './image-preprocessing.service';
import { OcrService } from './ocr.service';
import { StorageService } from '../common/services/storage.service';

jest.mock('@sentry/nestjs', () => ({
  captureException: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));

const captureExceptionMock = jest.mocked(Sentry.captureException);
const flushMock = jest.mocked(Sentry.flush);

// Lets a fire-and-forget background chain (importFromFile's OCR/PDF
// continuation) run to completion before assertions, without depending on
// a specific number of microtask ticks.
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

describe('ImportOrchestrationService', () => {
  let importJobRepo: { createJob: jest.Mock; updateJobStatus: jest.Mock };
  let urlFetchService: { fetchHtml: jest.Mock };
  let contentExtractionService: { extract: jest.Mock };
  let textExtractionService: { extract: jest.Mock };
  let confidenceScoringService: { score: jest.Mock };
  let candidateOfferService: { createCandidate: jest.Mock };
  let normalizationService: NormalizationService;
  let duplicateDetectionService: { detectAndFlag: jest.Mock };
  let fileValidationService: {
    validate: jest.Mock;
    sanitizeFilename: jest.Mock;
  };
  let storageService: { uploadFile: jest.Mock };
  let pdfTextService: { extractText: jest.Mock };
  let imagePreprocessingService: { resizeIfNeeded: jest.Mock };
  let ocrService: { extractText: jest.Mock };
  let service: ImportOrchestrationService;

  const job = {
    id: 'job-1',
    status: ImportJobStatus.QUEUED,
    source_url: 'http://example.com',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    importJobRepo = {
      createJob: jest.fn().mockResolvedValue(job),
      updateJobStatus: jest
        .fn()
        .mockImplementation(
          (
            _id: string,
            status: ImportJobStatus,
            patch: Record<string, unknown>,
          ) => Promise.resolve({ ...job, status, ...patch }),
        ),
    };
    urlFetchService = { fetchHtml: jest.fn() };
    contentExtractionService = { extract: jest.fn() };
    textExtractionService = { extract: jest.fn() };
    confidenceScoringService = { score: jest.fn() };
    candidateOfferService = {
      createCandidate: jest.fn().mockResolvedValue({
        business: { id: 'business-1' },
        offer: { id: 'offer-1' },
        warnings: ['No price detected'],
      }),
    };
    // Real instance, not a mock — NormalizationService is a small, pure,
    // deterministically-tested-on-its-own service; using the real thing
    // here keeps these orchestration tests focused on wiring/sequencing
    // while still exercising real normalize() output.
    normalizationService = new NormalizationService();
    duplicateDetectionService = {
      detectAndFlag: jest.fn().mockResolvedValue(undefined),
    };
    fileValidationService = {
      validate: jest.fn(),
      sanitizeFilename: jest.fn().mockImplementation((name: string) => name),
    };
    storageService = {
      uploadFile: jest
        .fn()
        .mockResolvedValue('https://s3.example.com/discovery/poster.jpg'),
    };
    pdfTextService = { extractText: jest.fn() };
    imagePreprocessingService = {
      resizeIfNeeded: jest
        .fn()
        .mockImplementation((buf: Buffer) => Promise.resolve(buf)),
    };
    ocrService = { extractText: jest.fn() };

    service = new ImportOrchestrationService(
      importJobRepo as unknown as ImportJobRepository,
      urlFetchService as unknown as UrlFetchService,
      contentExtractionService as unknown as ContentExtractionService,
      textExtractionService as unknown as TextExtractionService,
      confidenceScoringService,
      candidateOfferService as unknown as CandidateOfferService,
      normalizationService,
      duplicateDetectionService as unknown as DuplicateDetectionService,
      fileValidationService,
      storageService as unknown as StorageService,
      pdfTextService,
      imagePreprocessingService as unknown as ImagePreprocessingService,
      ocrService as unknown as OcrService,
    );
  });

  describe('importFromWebsite (Module 9 — regression)', () => {
    it('transitions QUEUED -> PROCESSING -> DONE and creates a review candidate on a successful import with a title', async () => {
      urlFetchService.fetchHtml.mockResolvedValue({
        html: '<title>X</title>',
        finalUrl: 'http://example.com',
      });
      contentExtractionService.extract.mockReturnValue({
        title: 'X',
        description: null,
        image: null,
        price: null,
      });
      confidenceScoringService.score.mockReturnValue(0.4);

      const result = await service.importFromWebsite('http://example.com');

      expect(importJobRepo.createJob).toHaveBeenCalledWith(
        'http://example.com',
        'WEBSITE',
      );
      expect(importJobRepo.updateJobStatus).toHaveBeenNthCalledWith(
        1,
        job.id,
        ImportJobStatus.PROCESSING,
      );
      expect(candidateOfferService.createCandidate).toHaveBeenCalledWith({
        sourceUrl: 'http://example.com',
        sourceType: 'WEBSITE',
        fields: { title: 'X', description: null, image: null, price: null },
        confidence: 0.4,
        normalized: {
          original_price: null,
          offer_price: null,
          offer_type: 'STANDARD',
          validity_end: null,
        },
      });

      const donePatch = {
        extracted_fields: expect.objectContaining({
          title: 'X',
          confidence_score: 0.4,
          candidate_created: true,
        }) as unknown,
        created_offer_id: 'offer-1',
        created_business_id: 'business-1',
      };
      expect(importJobRepo.updateJobStatus).toHaveBeenNthCalledWith(
        2,
        job.id,
        ImportJobStatus.DONE,
        donePatch,
      );
      expect(result.status).toBe(ImportJobStatus.DONE);
      expect(result.extracted_fields).toMatchObject({
        title: 'X',
        confidence_score: 0.4,
      });
      expect(duplicateDetectionService.detectAndFlag).toHaveBeenCalledWith(
        { id: 'offer-1' },
        { id: 'business-1' },
      );
    });

    it('does not create a candidate when extraction found no title', async () => {
      urlFetchService.fetchHtml.mockResolvedValue({
        html: '<p>nothing useful here</p>',
        finalUrl: 'http://example.com',
      });
      contentExtractionService.extract.mockReturnValue({
        title: null,
        description: null,
        image: null,
        price: null,
      });
      confidenceScoringService.score.mockReturnValue(0);

      const result = await service.importFromWebsite('http://example.com');

      expect(candidateOfferService.createCandidate).not.toHaveBeenCalled();
      expect(duplicateDetectionService.detectAndFlag).not.toHaveBeenCalled();
      expect(result.status).toBe(ImportJobStatus.DONE);
      expect(result.extracted_fields).toMatchObject({
        candidate_created: false,
      });
    });

    it('transitions to FAILED on a known/expected failure (e.g. SSRF block) without calling Sentry', async () => {
      urlFetchService.fetchHtml.mockRejectedValue(
        new UrlFetchError('Blocked target IP', 'SSRF_BLOCKED'),
      );

      const result = await service.importFromWebsite(
        'http://internal.example.com',
      );

      expect(importJobRepo.updateJobStatus).toHaveBeenNthCalledWith(
        1,
        job.id,
        ImportJobStatus.PROCESSING,
      );
      const failedPatch = {
        error: expect.stringContaining('SSRF_BLOCKED') as unknown,
      };
      expect(importJobRepo.updateJobStatus).toHaveBeenNthCalledWith(
        2,
        job.id,
        ImportJobStatus.FAILED,
        failedPatch,
      );
      expect(result.status).toBe(ImportJobStatus.FAILED);
      expect(result.error).toContain('SSRF_BLOCKED');
      expect(captureExceptionMock).not.toHaveBeenCalled();
    });

    it('transitions to FAILED and reports to Sentry on an unexpected error', async () => {
      urlFetchService.fetchHtml.mockResolvedValue({
        html: '<title>X</title>',
        finalUrl: 'http://example.com',
      });
      contentExtractionService.extract.mockImplementation(() => {
        throw new Error('unexpected bug in extraction');
      });

      const result = await service.importFromWebsite('http://example.com');

      expect(result.status).toBe(ImportJobStatus.FAILED);
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
      expect(flushMock).toHaveBeenCalledTimes(1);
    });

    it('transitions to FAILED and reports to Sentry when candidate creation itself fails unexpectedly', async () => {
      urlFetchService.fetchHtml.mockResolvedValue({
        html: '<title>X</title>',
        finalUrl: 'http://example.com',
      });
      contentExtractionService.extract.mockReturnValue({
        title: 'X',
        description: null,
        image: null,
        price: null,
      });
      confidenceScoringService.score.mockReturnValue(0.4);
      candidateOfferService.createCandidate.mockRejectedValue(
        new Error('db write failed'),
      );

      const result = await service.importFromWebsite('http://example.com');

      expect(result.status).toBe(ImportJobStatus.FAILED);
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    });

    it('records a meaningful error message distinguishing the failure reason', async () => {
      urlFetchService.fetchHtml.mockRejectedValue(
        new UrlFetchError('Request timed out', 'TIMEOUT'),
      );
      const result = await service.importFromWebsite('http://slow.example.com');
      expect(result.error).toBe('TIMEOUT: Request timed out');
    });
  });

  describe('importFromFile (Module 10 Phase 2)', () => {
    const fileParams = {
      buffer: Buffer.from('fake-image-bytes'),
      mimetype: 'image/jpeg',
      originalFilename: 'poster.jpg',
    };

    it('validates and uploads synchronously, returning a PROCESSING job before OCR/extraction complete', async () => {
      // Never resolves within this test — proves importFromFile doesn't
      // wait for it.
      ocrService.extractText.mockReturnValue(new Promise(() => {}));

      const result = await service.importFromFile(fileParams);

      expect(fileValidationService.validate).toHaveBeenCalledWith({
        mimetype: 'image/jpeg',
        size: fileParams.buffer.length,
        buffer: fileParams.buffer,
      });
      expect(storageService.uploadFile).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(ImportJobStatus.PROCESSING);
      expect(result.source_url).toBe(
        'https://s3.example.com/discovery/poster.jpg',
      );
    });

    it('completes the background OCR pipeline and reaches DONE with a candidate', async () => {
      ocrService.extractText.mockResolvedValue({
        text: 'Diwali Sale ₹499',
        confidence: 0.82,
      });
      textExtractionService.extract.mockReturnValue({
        title: 'Diwali Sale',
        description: null,
        image: null,
        price: 499,
      });
      confidenceScoringService.score.mockReturnValue(0.7);

      await service.importFromFile(fileParams);
      await flushMicrotasks();

      expect(imagePreprocessingService.resizeIfNeeded).toHaveBeenCalledWith(
        fileParams.buffer,
      );
      expect(confidenceScoringService.score).toHaveBeenCalledWith(
        { title: 'Diwali Sale', description: null, image: null, price: 499 },
        0.82,
      );
      expect(candidateOfferService.createCandidate).toHaveBeenCalledWith({
        sourceUrl: 'https://s3.example.com/discovery/poster.jpg',
        sourceType: Source.POSTER,
        fields: {
          title: 'Diwali Sale',
          description: null,
          image: null,
          price: 499,
        },
        confidence: 0.7,
        normalized: {
          original_price: 499,
          offer_price: 499,
          offer_type: 'STANDARD',
          validity_end: null,
        },
      });
      expect(importJobRepo.updateJobStatus).toHaveBeenCalledWith(
        job.id,
        ImportJobStatus.DONE,
        expect.objectContaining({ created_offer_id: 'offer-1' }) as unknown,
      );
      expect(duplicateDetectionService.detectAndFlag).toHaveBeenCalledWith(
        { id: 'offer-1' },
        { id: 'business-1' },
      );
    });

    it('corrects the job source_type from its POSTER placeholder to PDF once the mimetype is known', async () => {
      pdfTextService.extractText.mockResolvedValue(
        'Menu Special — Combo for ₹299',
      );
      textExtractionService.extract.mockReturnValue({
        title: 'Menu Special',
        description: null,
        image: null,
        price: 299,
      });
      confidenceScoringService.score.mockReturnValue(0.5);

      await service.importFromFile({
        ...fileParams,
        mimetype: 'application/pdf',
      });

      expect(importJobRepo.updateJobStatus).toHaveBeenCalledWith(
        job.id,
        ImportJobStatus.PROCESSING,
        expect.objectContaining({ source_type: Source.PDF }) as unknown,
      );
    });

    it('routes application/pdf through PdfTextService instead of OCR', async () => {
      pdfTextService.extractText.mockResolvedValue(
        'Menu Special — Combo for ₹299',
      );
      textExtractionService.extract.mockReturnValue({
        title: 'Menu Special',
        description: null,
        image: null,
        price: 299,
      });
      confidenceScoringService.score.mockReturnValue(0.5);

      await service.importFromFile({
        ...fileParams,
        mimetype: 'application/pdf',
      });
      await flushMicrotasks();

      expect(pdfTextService.extractText).toHaveBeenCalledWith(
        fileParams.buffer,
      );
      expect(ocrService.extractText).not.toHaveBeenCalled();
      // No OCR confidence for the PDF-text path — score() called with fields only.
      expect(confidenceScoringService.score).toHaveBeenCalledWith(
        { title: 'Menu Special', description: null, image: null, price: 299 },
        undefined,
      );
      expect(candidateOfferService.createCandidate).toHaveBeenCalledWith(
        expect.objectContaining({ sourceType: Source.PDF }) as unknown,
      );
    });

    it('fails fast with INVALID_FILE_TYPE when validation rejects, without ever calling storage', async () => {
      fileValidationService.validate.mockImplementation(() => {
        throw new FileImportError(
          'Unsupported file type: text/plain',
          'INVALID_FILE_TYPE',
        );
      });

      const result = await service.importFromFile({
        ...fileParams,
        mimetype: 'text/plain',
      });

      expect(storageService.uploadFile).not.toHaveBeenCalled();
      expect(result.status).toBe(ImportJobStatus.FAILED);
      expect(result.error).toContain('INVALID_FILE_TYPE');
      expect(captureExceptionMock).not.toHaveBeenCalled();
    });

    it('fails with STORAGE_FAILED when the upload itself throws, without calling OCR', async () => {
      storageService.uploadFile.mockRejectedValue(new Error('S3 unreachable'));

      const result = await service.importFromFile(fileParams);

      expect(ocrService.extractText).not.toHaveBeenCalled();
      expect(result.status).toBe(ImportJobStatus.FAILED);
      expect(result.error).toContain('STORAGE_FAILED');
    });

    it('fails the job asynchronously with OCR_FAILED when OCR throws in the background', async () => {
      ocrService.extractText.mockRejectedValue(new Error('corrupt image'));

      await service.importFromFile(fileParams);
      await flushMicrotasks();

      expect(importJobRepo.updateJobStatus).toHaveBeenCalledWith(
        job.id,
        ImportJobStatus.FAILED,
        expect.objectContaining({
          error: expect.stringContaining('OCR_FAILED') as unknown,
        }) as unknown,
      );
      expect(candidateOfferService.createCandidate).not.toHaveBeenCalled();
    });

    it('fails the job asynchronously with UNSUPPORTED_SCANNED_PDF without calling Sentry (known/expected)', async () => {
      pdfTextService.extractText.mockRejectedValue(
        new FileImportError(
          'PDF has no extractable text layer',
          'UNSUPPORTED_SCANNED_PDF',
        ),
      );

      await service.importFromFile({
        ...fileParams,
        mimetype: 'application/pdf',
      });
      await flushMicrotasks();

      expect(importJobRepo.updateJobStatus).toHaveBeenCalledWith(
        job.id,
        ImportJobStatus.FAILED,
        expect.objectContaining({
          error: expect.stringContaining('UNSUPPORTED_SCANNED_PDF') as unknown,
        }) as unknown,
      );
      expect(captureExceptionMock).not.toHaveBeenCalled();
    });

    it('does not create a candidate when the OCR/PDF text yields no title', async () => {
      ocrService.extractText.mockResolvedValue({
        text: 'unreadable garbage',
        confidence: 0.1,
      });
      textExtractionService.extract.mockReturnValue({
        title: null,
        description: null,
        image: null,
        price: null,
      });
      confidenceScoringService.score.mockReturnValue(0.05);

      await service.importFromFile(fileParams);
      await flushMicrotasks();

      expect(candidateOfferService.createCandidate).not.toHaveBeenCalled();
      expect(importJobRepo.updateJobStatus).toHaveBeenCalledWith(
        job.id,
        ImportJobStatus.DONE,
        expect.objectContaining({
          extracted_fields: expect.objectContaining({
            candidate_created: false,
          }) as unknown,
        }) as unknown,
      );
    });
  });
});
