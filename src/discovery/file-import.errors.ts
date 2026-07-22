// Shared across the file-import pipeline (FileValidationService,
// PdfTextService, ImportOrchestrationService) the same way UrlFetchError
// is shared across the website-import pipeline: a machine-readable
// `reason` alongside the human message, so the orchestration layer can
// categorize known/expected failures without string-matching.
export class FileImportError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(message);
    this.name = 'FileImportError';
  }
}
