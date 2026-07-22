import { ImportJobStatus } from '@prisma/client';
import * as Sentry from '@sentry/nestjs';
import { ImportOrchestrationService } from './import-orchestration.service';
import { UrlFetchError, UrlFetchService } from './url-fetch.service';
import { ImportJobRepository } from './import-job.repository';
import { ContentExtractionService } from './content-extraction.service';
import { CandidateOfferService } from './candidate-offer.service';

jest.mock('@sentry/nestjs', () => ({
  captureException: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));

const captureExceptionMock = jest.mocked(Sentry.captureException);
const flushMock = jest.mocked(Sentry.flush);

describe('ImportOrchestrationService', () => {
  let importJobRepo: {
    createJob: jest.Mock;
    updateJobStatus: jest.Mock;
  };
  let urlFetchService: { fetchHtml: jest.Mock };
  let contentExtractionService: { extract: jest.Mock };
  let confidenceScoringService: { score: jest.Mock };
  let candidateOfferService: { createCandidate: jest.Mock };
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
    confidenceScoringService = { score: jest.fn() };
    candidateOfferService = {
      createCandidate: jest.fn().mockResolvedValue({
        business: { id: 'business-1' },
        offer: { id: 'offer-1' },
        warnings: ['No price detected'],
      }),
    };

    service = new ImportOrchestrationService(
      importJobRepo as unknown as ImportJobRepository,
      urlFetchService as unknown as UrlFetchService,
      contentExtractionService as unknown as ContentExtractionService,
      confidenceScoringService,
      candidateOfferService as unknown as CandidateOfferService,
    );
  });

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
    expect(result.status).toBe(ImportJobStatus.DONE);
    expect(result.extracted_fields).toMatchObject({ candidate_created: false });
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
