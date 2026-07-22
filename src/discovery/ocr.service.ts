import { Injectable, Logger } from '@nestjs/common';
import { createWorker } from 'tesseract.js';

export interface OcrResult {
  text: string;
  confidence: number; // 0-1, normalized from Tesseract's native 0-100 scale
}

// Module 10 Phase 1 — deliberately the *only* file in this codebase that
// imports tesseract.js on the backend. Every caller depends on this
// interface, never on Tesseract's own API — swapping to AWS Textract later
// (per the approved Decision 1: start with tesseract.js, no new
// credentials/cost, migrate only if production accuracy proves
// insufficient) means rewriting this one file's internals, nothing else.
// A worker is created per call rather than pooled — admin-initiated,
// low-volume usage doesn't justify the complexity of a persistent worker
// pool, and a fresh worker avoids any cross-call state leaking between
// unrelated uploads.
@Injectable()
export class OcrService {
  private readonly logger = new Logger(OcrService.name);

  async extractText(buffer: Buffer): Promise<OcrResult> {
    const worker = await createWorker('eng');
    try {
      const {
        data: { text, confidence },
      } = await worker.recognize(buffer);
      this.logger.log(
        `OCR complete — confidence=${confidence}, text length=${text.length}`,
      );
      return { text, confidence: confidence / 100 };
    } finally {
      await worker.terminate();
    }
  }
}
