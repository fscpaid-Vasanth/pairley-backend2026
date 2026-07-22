import { Injectable } from '@nestjs/common';
import { ExtractedFields } from './content-extraction.service';

// Rule-based only (Module 9 decision — no ML model at this stage). Each
// field's presence contributes a fixed weight; a fully-populated extraction
// scores 1.0, a title-only extraction scores low. Nothing acts on this score
// yet — Phase 3's review queue is where it starts informing admin review,
// and no code path auto-promotes on it in Module 9 at all.
const WEIGHTS = { title: 0.4, description: 0.25, price: 0.25, image: 0.1 };

// Module 10 — an OCR/PDF-sourced candidate can additionally supply the
// engine's own confidence (0-1). Blended rather than replacing the
// field-completeness score: a garbled OCR read can still coincidentally
// match enough patterns to look "complete," so the engine's own signal
// needs real weight, not just a tiebreaker. Purely additive — omitting the
// second argument (every existing website-import call site) reproduces the
// exact Module 9 behavior unchanged.
const OCR_BLEND_WEIGHTS = { fieldScore: 0.7, ocrConfidence: 0.3 };

@Injectable()
export class ConfidenceScoringService {
  score(fields: ExtractedFields, ocrConfidence?: number): number {
    let total = 0;
    if (fields.title) total += WEIGHTS.title;
    if (fields.description) total += WEIGHTS.description;
    if (fields.price !== null) total += WEIGHTS.price;
    if (fields.image) total += WEIGHTS.image;

    if (ocrConfidence === undefined) {
      return Math.round(total * 100) / 100;
    }

    const blended =
      total * OCR_BLEND_WEIGHTS.fieldScore +
      ocrConfidence * OCR_BLEND_WEIGHTS.ocrConfidence;
    return Math.round(blended * 100) / 100;
  }
}
