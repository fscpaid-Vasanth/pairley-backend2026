import { Injectable } from '@nestjs/common';
import { ExtractedFields } from './content-extraction.service';

const MIN_TITLE_LENGTH = 3;
const MAX_TITLE_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 300;

// Deterministic, rule-based extraction only — no LLM/AI inference, same
// discipline as ContentExtractionService. Sibling to that service rather
// than a modification of it: OCR'd/PDF plain text has no tags/meta fields
// to key off of, so the heuristics here are necessarily different (first
// substantial line as title, remaining lines as description) even though
// the output shape (ExtractedFields) and the price regex are identical.
// `image` is always null here — for a poster/PDF import, the *uploaded
// file itself* becomes the offer's cover image at the candidate-creation
// layer (Phase 3), not something derived from the extracted text.
@Injectable()
export class TextExtractionService {
  extract(rawText: string): ExtractedFields {
    const lines = rawText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const title = this.extractTitle(lines);
    const description = this.extractDescription(lines, title);
    const price = this.extractPrice(rawText);

    return { title, description, image: null, price };
  }

  private extractTitle(lines: string[]): string | null {
    const candidate = lines.find(
      (line) => line.length >= MIN_TITLE_LENGTH && /[a-zA-Z]/.test(line),
    );
    if (!candidate) return null;
    return candidate.length > MAX_TITLE_LENGTH
      ? `${candidate.slice(0, MAX_TITLE_LENGTH).trim()}…`
      : candidate;
  }

  private extractDescription(
    lines: string[],
    title: string | null,
  ): string | null {
    const remaining = lines.filter((line) => line !== title);
    if (remaining.length === 0) return null;
    const joined = remaining.join(' ').trim();
    if (!joined) return null;
    return joined.length > MAX_DESCRIPTION_LENGTH
      ? `${joined.slice(0, MAX_DESCRIPTION_LENGTH).trim()}…`
      : joined;
  }

  // Identical pattern to ContentExtractionService.extractPrice() — OCR/PDF
  // text needs no tag-stripping first, since there are no tags.
  private extractPrice(text: string): number | null {
    const match = text.match(/(?:₹|Rs\.?|INR)\s?([\d,]+(?:\.\d{1,2})?)/i);
    if (!match) return null;
    const numeric = Number(match[1].replace(/,/g, ''));
    return Number.isFinite(numeric) ? numeric : null;
  }
}
