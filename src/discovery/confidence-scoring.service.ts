import { Injectable } from '@nestjs/common';
import { ExtractedFields } from './content-extraction.service';

// Rule-based only (Module 9 decision — no ML model at this stage). Each
// field's presence contributes a fixed weight; a fully-populated extraction
// scores 1.0, a title-only extraction scores low. Nothing acts on this score
// yet — Phase 3's review queue is where it starts informing admin review,
// and no code path auto-promotes on it in Module 9 at all.
const WEIGHTS = { title: 0.4, description: 0.25, price: 0.25, image: 0.1 };

@Injectable()
export class ConfidenceScoringService {
  score(fields: ExtractedFields): number {
    let total = 0;
    if (fields.title) total += WEIGHTS.title;
    if (fields.description) total += WEIGHTS.description;
    if (fields.price !== null) total += WEIGHTS.price;
    if (fields.image) total += WEIGHTS.image;
    return Math.round(total * 100) / 100;
  }
}
