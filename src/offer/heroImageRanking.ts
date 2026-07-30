import { Orientation, classifyAspect } from './bannerTemplates';

/**
 * Module 14 Phase 3C — quality-aware hero image selection.
 *
 * Source order alone isn't enough: a merchant's official promotional banner
 * is the best *kind* of image, but a 200px watermarked thumbnail of one is
 * worse than a clean 1600px interior shot. So role sets the tier and
 * measured quality decides within (and can demote across) it.
 *
 * Pure and side-effect free. Probing an image for dimensions and luminance
 * belongs to the service that has `sharp`; everything here operates on the
 * numbers it produces, so the ranking rules are testable on their own.
 */

/** What the image *is*, in descending order of inherent suitability. */
export type ImageRole =
  | 'OFFICIAL_BANNER'
  | 'OFFER_HERO'
  | 'PRODUCT'
  | 'INTERIOR'
  | 'EXTERIOR'
  | 'CATEGORY_ILLUSTRATION'
  | 'PLACEHOLDER';

export const ROLE_ORDER: ImageRole[] = [
  'OFFICIAL_BANNER',
  'OFFER_HERO',
  'PRODUCT',
  'INTERIOR',
  'EXTERIOR',
  'CATEGORY_ILLUSTRATION',
  'PLACEHOLDER',
];

// Deliberately spaced so quality can move an image *within* a tier freely,
// and can overturn one tier of role difference but not several: a superb
// interior shot can beat a poor product photo, but never beats a good
// official banner.
const ROLE_SCORE: Record<ImageRole, number> = {
  OFFICIAL_BANNER: 100,
  OFFER_HERO: 85,
  PRODUCT: 70,
  INTERIOR: 55,
  EXTERIOR: 40,
  CATEGORY_ILLUSTRATION: 20,
  PLACEHOLDER: 5,
};

export interface ImageCandidate {
  url: string;
  role: ImageRole;
  /** Pixel dimensions, when probing succeeded. */
  width?: number | null;
  height?: number | null;
  /** Mean luminance, 0–1. */
  brightness?: number | null;
  /** Normalised standard deviation of luminance, 0–1. */
  contrast?: number | null;
  /**
   * A **manual** signal only — there is no reliable automatic watermark
   * detector (see `ImageAnalysisService.WATERMARK_DETECTION_STATUS` for why
   * one was tried and dropped). Three states, all meaningful:
   *   - `null`/`undefined` — not assessed. No effect on scoring.
   *   - `true`  — an admin flagged this image as watermarked. Penalised.
   *   - `false` — an admin explicitly confirmed it is clean. No effect on
   *     scoring (there is nothing to reward — absence of a problem isn't a
   *     quality signal), but it is preserved so the UI can show "checked".
   * The ranking engine never sets this itself and never infers `true` from
   * anything else.
   */
  watermarkSuspected?: boolean | null;
  /** Estimated subject focus / detail concentration, 0–1. */
  focus?: number | null;
}

/**
 * A transparent 0–100 quality read-out, independent of role. Two images of
 * the same role are frequently compared by an admin who has no way to see
 * the internal ranking score (which also folds in role weight and isn't
 * meant to be a human-facing number) — this is that comparison, in a shape
 * an admin can sanity-check at a glance, with the same underlying
 * measurements the ranking algorithm actually uses.
 */
export interface SuitabilityBreakdown {
  /** 0–30 */
  resolution: number;
  /** 0–25 — from the same blur measurement used elsewhere ("focus"). */
  sharpness: number;
  /** 0–20 — brightness and contrast, judged for overlaid-text legibility. */
  exposure: number;
  /** 0–15 — how closely the numeric aspect ratio matches the template. */
  aspectFit: number;
  /** 0–10 — whether the image's landscape/portrait/square bucket matches. */
  orientationMatch: number;
}

export interface SuitabilityScore {
  /** 0–100, rounded. Sum of the breakdown. */
  total: number;
  breakdown: SuitabilityBreakdown;
}

export interface RankingContext {
  /** width / height the chosen banner template wants. 1 = square. */
  targetAspect: number;
  /** Below this width an image will look soft at banner size. */
  minWidth?: number;
}

export interface RankedImage {
  candidate: ImageCandidate;
  score: number;
  /** 0–1. Low when the top candidates are hard to separate. */
  confidence: number;
  reasons: string[];
  /** Role-independent quality read-out — see SuitabilityScore. */
  suitability: SuitabilityScore;
}

export interface HeroSelection {
  selected: RankedImage | null;
  ranked: RankedImage[];
  /** True when an admin should look before publishing. */
  needsReview: boolean;
  reviewReason: string | null;
}

const DEFAULT_MIN_WIDTH = 800;

/** Clamp helper — every sub-score contributes within a bounded range. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Resolution: full marks at or above the target width, tapering below it,
 * and heavily penalised under half — upscaling a small image to a 1080px
 * banner is the most visible quality failure of the lot.
 */
export function resolutionScore(
  width: number | null | undefined,
  minWidth: number,
): { score: number; reason: string | null } {
  if (!width || !Number.isFinite(width) || width <= 0) {
    // Unknown is not the same as bad: probing may simply have failed.
    return { score: 0, reason: 'Resolution unknown' };
  }
  if (width >= minWidth) return { score: 20, reason: null };
  if (width >= minWidth * 0.5) {
    const ratio = (width - minWidth * 0.5) / (minWidth * 0.5);
    return { score: 10 * ratio, reason: 'Lower resolution than ideal' };
  }
  return {
    score: -25,
    reason: 'Too small — would look blurred at banner size',
  };
}

/**
 * Aspect fit. A hero is cropped to the banner frame, so what matters is how
 * much has to be thrown away: a wildly different ratio means a crop that
 * cuts the subject.
 */
export function aspectScore(
  width: number | null | undefined,
  height: number | null | undefined,
  targetAspect: number,
): { score: number; reason: string | null } {
  if (
    !width ||
    !height ||
    !Number.isFinite(targetAspect) ||
    targetAspect <= 0
  ) {
    return { score: 0, reason: null };
  }
  const aspect = width / height;
  const ratio =
    aspect > targetAspect ? aspect / targetAspect : targetAspect / aspect;

  if (ratio <= 1.15) return { score: 15, reason: null };
  if (ratio <= 1.6) return { score: 8, reason: null };
  if (ratio <= 2.4) return { score: 0, reason: 'Will need a noticeable crop' };
  return { score: -12, reason: 'Very different shape — heavy crop required' };
}

/**
 * Banner text is overlaid on the image, so a very bright picture makes white
 * text unreadable and a very dark one swallows the scrim. Mid-range wins.
 */
export function exposureScore(
  brightness: number | null | undefined,
  contrast: number | null | undefined,
): { score: number; reason: string | null } {
  let score = 0;
  let reason: string | null = null;

  if (typeof brightness === 'number' && Number.isFinite(brightness)) {
    if (brightness > 0.85) {
      score -= 10;
      reason = 'Very bright — overlaid text may be hard to read';
    } else if (brightness < 0.12) {
      score -= 8;
      reason = 'Very dark';
    } else if (brightness >= 0.25 && brightness <= 0.7) {
      score += 8;
    }
  }

  if (typeof contrast === 'number' && Number.isFinite(contrast)) {
    if (contrast < 0.06) {
      score -= 6;
      reason = reason ?? 'Very flat — looks washed out';
    } else if (contrast > 0.15) {
      score += 5;
    }
  }

  return { score, reason };
}

function resolutionSuitability(
  width: number | null | undefined,
  minWidth: number,
): number {
  if (!width || !Number.isFinite(width) || width <= 0) return 15; // unknown — half credit, not a penalty
  const ratio = width / minWidth;
  if (ratio >= 1) return 30;
  if (ratio >= 0.5) return 30 * ((ratio - 0.5) / 0.5);
  return 0;
}

function sharpnessSuitability(focus: number | null | undefined): number {
  if (typeof focus !== 'number' || !Number.isFinite(focus)) return 12.5; // unknown — half credit
  return clamp(focus, 0, 1) * 25;
}

function exposureSuitability(
  brightness: number | null | undefined,
  contrast: number | null | undefined,
): number {
  let score = 7; // both unknown — modest neutral baseline, not full marks
  if (typeof brightness === 'number' && Number.isFinite(brightness)) {
    if (brightness >= 0.25 && brightness <= 0.7) score = 14;
    else if (brightness > 0.85 || brightness < 0.12) score = 2;
    else score = 8;
  }
  if (typeof contrast === 'number' && Number.isFinite(contrast)) {
    if (contrast > 0.15) score += 6;
    else if (contrast < 0.06) score -= 4;
    else score += 3;
  }
  return clamp(score, 0, 20);
}

function aspectFitSuitability(
  width: number | null | undefined,
  height: number | null | undefined,
  targetAspect: number,
): number {
  if (
    !width ||
    !height ||
    !Number.isFinite(targetAspect) ||
    targetAspect <= 0
  ) {
    return 8; // unknown — half credit
  }
  const aspect = width / height;
  const ratio =
    aspect > targetAspect ? aspect / targetAspect : targetAspect / aspect;
  if (ratio <= 1.15) return 15;
  if (ratio <= 1.6) return 10;
  if (ratio <= 2.4) return 4;
  return 0;
}

function orientationMatchSuitability(
  width: number | null | undefined,
  height: number | null | undefined,
  targetAspect: number,
): number {
  const candidateOrientation: Orientation | null =
    width && height && width > 0 && height > 0
      ? classifyAspect(width / height)
      : null;
  if (!candidateOrientation) return 5; // unknown — half credit

  const targetOrientation =
    Number.isFinite(targetAspect) && targetAspect > 0
      ? classifyAspect(targetAspect)
      : null;
  if (!targetOrientation) return 5;

  return candidateOrientation === targetOrientation ? 10 : 0;
}

export function computeSuitabilityScore(
  candidate: ImageCandidate,
  context: RankingContext,
): SuitabilityScore {
  const minWidth = context.minWidth ?? DEFAULT_MIN_WIDTH;

  const breakdown: SuitabilityBreakdown = {
    resolution: round2(resolutionSuitability(candidate.width, minWidth)),
    sharpness: round2(sharpnessSuitability(candidate.focus)),
    exposure: round2(
      exposureSuitability(candidate.brightness, candidate.contrast),
    ),
    aspectFit: round2(
      aspectFitSuitability(
        candidate.width,
        candidate.height,
        context.targetAspect,
      ),
    ),
    orientationMatch: round2(
      orientationMatchSuitability(
        candidate.width,
        candidate.height,
        context.targetAspect,
      ),
    ),
  };

  const total = Math.round(
    breakdown.resolution +
      breakdown.sharpness +
      breakdown.exposure +
      breakdown.aspectFit +
      breakdown.orientationMatch,
  );

  return { total: clamp(total, 0, 100), breakdown };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function scoreCandidate(
  candidate: ImageCandidate,
  context: RankingContext,
): RankedImage {
  const minWidth = context.minWidth ?? DEFAULT_MIN_WIDTH;
  const reasons: string[] = [];

  const role = ROLE_SCORE[candidate.role] ?? 0;
  let score = role;

  const resolution = resolutionScore(candidate.width, minWidth);
  score += resolution.score;
  if (resolution.reason) reasons.push(resolution.reason);

  const aspect = aspectScore(
    candidate.width,
    candidate.height,
    context.targetAspect,
  );
  score += aspect.score;
  if (aspect.reason) reasons.push(aspect.reason);

  const exposure = exposureScore(candidate.brightness, candidate.contrast);
  score += exposure.score;
  if (exposure.reason) reasons.push(exposure.reason);

  // Manual signal only — see the field's doc comment. `false` (explicitly
  // confirmed clean) and `null`/`undefined` (not assessed) both leave score
  // and reasons untouched; only an explicit `true` penalises.
  if (candidate.watermarkSuspected === true) {
    score -= 30;
    reasons.push('Possible watermark');
  }

  if (typeof candidate.focus === 'number' && Number.isFinite(candidate.focus)) {
    score += clamp(candidate.focus, 0, 1) * 10;
  }

  return {
    candidate,
    score: Math.round(score * 100) / 100,
    confidence: 0, // filled in by rankHeroImages, which can see the field
    reasons,
    suitability: computeSuitabilityScore(candidate, context),
  };
}

/**
 * Confidence is about *separation*, not absolute quality: picking
 * automatically is only safe when the winner is clearly ahead. Two near-tied
 * candidates mean a human should glance at it, which is exactly the case the
 * spec asked to surface.
 */
function confidenceFromMargin(top: number, runnerUp: number | null): number {
  if (runnerUp === null) return 0.9; // sole candidate — nothing to confuse it with
  const margin = top - runnerUp;
  if (margin <= 0) return 0.3;
  if (margin >= 30) return 0.95;
  return clamp(0.3 + (margin / 30) * 0.65, 0.3, 0.95);
}

export function rankHeroImages(
  candidates: ImageCandidate[],
  context: RankingContext,
): RankedImage[] {
  const scored = (candidates ?? [])
    .filter(
      (candidate) =>
        candidate && typeof candidate.url === 'string' && candidate.url,
    )
    .map((candidate) => scoreCandidate(candidate, context));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Stable, explainable tiebreak rather than whatever order they arrived in.
    const roleDelta =
      ROLE_ORDER.indexOf(a.candidate.role) -
      ROLE_ORDER.indexOf(b.candidate.role);
    if (roleDelta !== 0) return roleDelta;
    return (b.candidate.width ?? 0) - (a.candidate.width ?? 0);
  });

  return scored.map((image, index) => ({
    ...image,
    confidence: confidenceFromMargin(
      image.score,
      index === 0 ? (scored[1]?.score ?? null) : image.score,
    ),
  }));
}

export function selectHeroImage(
  candidates: ImageCandidate[],
  context: RankingContext,
): HeroSelection {
  const ranked = rankHeroImages(candidates, context);
  const selected = ranked[0] ?? null;

  if (!selected) {
    return {
      selected: null,
      ranked,
      needsReview: true,
      reviewReason: 'No usable image found',
    };
  }

  if (selected.confidence < 0.6 && ranked.length > 1) {
    return {
      selected,
      ranked,
      needsReview: true,
      reviewReason: 'Several images scored similarly — confirm the best one',
    };
  }

  if (selected.candidate.role === 'PLACEHOLDER') {
    return {
      selected,
      ranked,
      needsReview: true,
      reviewReason:
        'Only a placeholder is available — consider adding an image',
    };
  }

  if (selected.reasons.length > 0) {
    return {
      selected,
      ranked,
      needsReview: true,
      reviewReason: selected.reasons[0],
    };
  }

  return { selected, ranked, needsReview: false, reviewReason: null };
}
