import {
  rankHeroImages,
  selectHeroImage,
  scoreCandidate,
  resolutionScore,
  aspectScore,
  exposureScore,
  computeSuitabilityScore,
  ROLE_ORDER,
  ImageCandidate,
} from './heroImageRanking';

const CTX = { targetAspect: 1, minWidth: 800 };

const good = (over: Partial<ImageCandidate> = {}): ImageCandidate => ({
  url: 'https://x/img.jpg',
  role: 'PRODUCT',
  width: 1600,
  height: 1600,
  brightness: 0.45,
  contrast: 0.2,
  watermarkSuspected: false,
  focus: 0.7,
  ...over,
});

describe('heroImageRanking (Module 14 Phase 3C)', () => {
  describe('resolutionScore', () => {
    it('rewards images at or above the target width', () => {
      expect(resolutionScore(1600, 800).score).toBe(20);
      expect(resolutionScore(800, 800).score).toBe(20);
    });

    it('tapers between half and full target width', () => {
      const mid = resolutionScore(600, 800).score;
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThan(20);
    });

    // Upscaling a thumbnail to 1080px is the most visible failure of all.
    it('heavily penalises an image under half the target width', () => {
      expect(resolutionScore(200, 800).score).toBeLessThan(0);
      expect(resolutionScore(200, 800).reason).toMatch(/blurred/i);
    });

    it('treats unknown resolution as neutral, not bad', () => {
      expect(resolutionScore(null, 800).score).toBe(0);
      expect(resolutionScore(undefined, 800).score).toBe(0);
      expect(resolutionScore(0, 800).score).toBe(0);
    });
  });

  describe('aspectScore', () => {
    it('rewards a shape close to the banner', () => {
      expect(aspectScore(1000, 1000, 1).score).toBe(15);
    });

    it('penalises a wildly different shape', () => {
      expect(aspectScore(3000, 500, 1).score).toBeLessThan(0);
      expect(aspectScore(3000, 500, 1).reason).toMatch(/crop/i);
    });

    it('is symmetric — very tall is as bad as very wide', () => {
      expect(aspectScore(500, 3000, 1).score).toBe(
        aspectScore(3000, 500, 1).score,
      );
    });

    it('is neutral when dimensions are unknown', () => {
      expect(aspectScore(null, null, 1).score).toBe(0);
      expect(aspectScore(1000, 1000, 0).score).toBe(0);
    });
  });

  describe('exposureScore', () => {
    // Banner text is overlaid, so exposure is a legibility question.
    it('penalises a very bright image because overlaid text stops being readable', () => {
      const result = exposureScore(0.95, 0.2);
      expect(result.score).toBeLessThan(0);
      expect(result.reason).toMatch(/bright/i);
    });

    it('penalises a very dark image', () => {
      expect(exposureScore(0.05, 0.2).score).toBeLessThan(0);
    });

    it('rewards mid-range exposure with healthy contrast', () => {
      expect(exposureScore(0.45, 0.2).score).toBeGreaterThan(0);
    });

    it('penalises a flat, washed-out image', () => {
      expect(exposureScore(0.45, 0.02).score).toBeLessThan(
        exposureScore(0.45, 0.2).score,
      );
    });

    it('is neutral when nothing was measured', () => {
      expect(exposureScore(null, null).score).toBe(0);
    });
  });

  describe('role tiers', () => {
    it('prefers a better role when quality is equal', () => {
      const ranked = rankHeroImages(
        [
          good({ role: 'EXTERIOR', url: 'a' }),
          good({ role: 'OFFICIAL_BANNER', url: 'b' }),
        ],
        CTX,
      );
      expect(ranked[0].candidate.url).toBe('b');
    });

    it('ranks all roles in the documented order when quality is identical', () => {
      const ranked = rankHeroImages(
        ROLE_ORDER.map((role) => good({ role, url: role })),
        CTX,
      );
      expect(ranked.map((r) => r.candidate.role)).toEqual(ROLE_ORDER);
    });

    // The whole reason for quality-awareness: source order alone is wrong.
    it('lets a strong lower-tier image beat a poor one tier above it', () => {
      const ranked = rankHeroImages(
        [
          good({
            role: 'PRODUCT',
            url: 'tiny-watermarked',
            width: 200,
            height: 200,
            watermarkSuspected: true,
          }),
          good({ role: 'INTERIOR', url: 'clean-large' }),
        ],
        CTX,
      );
      expect(ranked[0].candidate.url).toBe('clean-large');
    });

    // But quality must not overturn several tiers — a good official banner
    // should still win against an excellent storefront photo.
    it('does not let quality overturn a large role gap', () => {
      const ranked = rankHeroImages(
        [
          good({
            role: 'OFFICIAL_BANNER',
            url: 'banner',
            width: 900,
            height: 900,
            focus: 0.4,
          }),
          good({
            role: 'EXTERIOR',
            url: 'exterior',
            width: 3000,
            height: 3000,
            focus: 1,
          }),
        ],
        CTX,
      );
      expect(ranked[0].candidate.url).toBe('banner');
    });
  });

  describe('penalties', () => {
    it('demotes a watermarked image sharply', () => {
      const clean = scoreCandidate(good(), CTX).score;
      const marked = scoreCandidate(
        good({ watermarkSuspected: true }),
        CTX,
      ).score;
      expect(marked).toBeLessThan(clean - 25);
      expect(
        scoreCandidate(good({ watermarkSuspected: true }), CTX).reasons,
      ).toContain('Possible watermark');
    });

    it('collects a human-readable reason for each problem', () => {
      const result = scoreCandidate(
        good({
          width: 150,
          height: 900,
          brightness: 0.97,
          watermarkSuspected: true,
        }),
        CTX,
      );
      expect(result.reasons.length).toBeGreaterThanOrEqual(3);
    });
  });

  // Module 14 Phase 3C follow-up — watermarkSuspected is a manual-only
  // tri-state signal (see the field's doc comment). No automatic detector
  // exists, so the ranking engine must react only to an explicit `true`.
  describe('tri-state watermarkSuspected (manual signal only)', () => {
    it('applies no penalty when not assessed (null/undefined)', () => {
      const nullScore = scoreCandidate(
        good({ watermarkSuspected: null }),
        CTX,
      ).score;
      const undefinedScore = scoreCandidate(
        good({ watermarkSuspected: undefined }),
        CTX,
      ).score;
      const baseline = scoreCandidate(good(), CTX).score;
      expect(nullScore).toBe(baseline);
      expect(undefinedScore).toBe(baseline);
    });

    // An explicit "confirmed clean" is not itself a quality signal — it
    // just means the penalty definitely does not apply, same as unassessed.
    it('applies no penalty and no bonus when explicitly confirmed clean (false)', () => {
      const confirmedClean = scoreCandidate(
        good({ watermarkSuspected: false }),
        CTX,
      );
      const baseline = scoreCandidate(good(), CTX);
      expect(confirmedClean.score).toBe(baseline.score);
      expect(confirmedClean.reasons).toEqual(baseline.reasons);
    });

    it('penalises only an explicit true', () => {
      const flagged = scoreCandidate(good({ watermarkSuspected: true }), CTX);
      const baseline = scoreCandidate(good(), CTX);
      expect(flagged.score).toBeLessThan(baseline.score);
    });

    it('a confirmed-clean flag does not force an admin review', () => {
      const result = selectHeroImage(
        [good({ watermarkSuspected: false })],
        CTX,
      );
      expect(result.needsReview).toBe(false);
    });
  });

  describe('computeSuitabilityScore', () => {
    it('scores a strong image near the top of the range', () => {
      const result = computeSuitabilityScore(
        good({
          width: 1600,
          height: 1600,
          brightness: 0.45,
          contrast: 0.2,
          focus: 0.9,
        }),
        CTX,
      );
      expect(result.total).toBeGreaterThan(80);
      expect(result.total).toBeLessThanOrEqual(100);
    });

    it('scores a weak image near the bottom of the range', () => {
      const result = computeSuitabilityScore(
        good({
          width: 150,
          height: 900,
          brightness: 0.98,
          contrast: 0.01,
          focus: 0.05,
        }),
        CTX,
      );
      expect(result.total).toBeLessThan(30);
    });

    it('never leaves the 0–100 range, at the extremes or in between', () => {
      const cases: Partial<ImageCandidate>[] = [
        {},
        { width: 0, height: 0 },
        { width: 10000, height: 1, brightness: 2, contrast: -5, focus: 99 },
        {
          width: null,
          height: null,
          brightness: null,
          contrast: null,
          focus: null,
        },
      ];
      cases.forEach((over) => {
        const result = computeSuitabilityScore(good(over), CTX);
        expect(result.total).toBeGreaterThanOrEqual(0);
        expect(result.total).toBeLessThanOrEqual(100);
      });
    });

    it('sums the breakdown to the total, so the number is never unexplained', () => {
      const result = computeSuitabilityScore(good(), CTX);
      const sum =
        result.breakdown.resolution +
        result.breakdown.sharpness +
        result.breakdown.exposure +
        result.breakdown.aspectFit +
        result.breakdown.orientationMatch;
      expect(Math.round(sum)).toBe(result.total);
    });

    it('gives an unknown-everything candidate a mid-range score rather than 0 or 100', () => {
      const result = computeSuitabilityScore(
        good({
          width: null,
          height: null,
          brightness: null,
          contrast: null,
          focus: null,
        }),
        CTX,
      );
      expect(result.total).toBeGreaterThan(20);
      expect(result.total).toBeLessThan(70);
    });

    it('rewards an orientation match independently of numeric aspect fit', () => {
      const square = computeSuitabilityScore(
        good({ width: 1000, height: 1000 }),
        {
          targetAspect: 1,
        },
      );
      const wideLandscape = computeSuitabilityScore(
        good({ width: 3000, height: 1000 }),
        {
          targetAspect: 1,
        },
      );
      expect(square.breakdown.orientationMatch).toBeGreaterThan(
        wideLandscape.breakdown.orientationMatch,
      );
    });

    // watermarkSuspected deliberately has no place in the suitability score
    // — it's a manual editorial signal, not a measured quality dimension.
    it('is unaffected by watermarkSuspected', () => {
      const clean = computeSuitabilityScore(
        good({ watermarkSuspected: false }),
        CTX,
      );
      const flagged = computeSuitabilityScore(
        good({ watermarkSuspected: true }),
        CTX,
      );
      expect(flagged.total).toBe(clean.total);
    });

    it('is attached to every ranked image', () => {
      const ranked = rankHeroImages([good()], CTX);
      expect(ranked[0].suitability.total).toBeGreaterThanOrEqual(0);
      expect(ranked[0].suitability.breakdown).toBeDefined();
    });
  });

  describe('confidence', () => {
    it('is high for a clear winner', () => {
      const ranked = rankHeroImages(
        [
          good({ role: 'OFFICIAL_BANNER', url: 'a' }),
          good({ role: 'PLACEHOLDER', url: 'b' }),
        ],
        CTX,
      );
      expect(ranked[0].confidence).toBeGreaterThan(0.9);
    });

    // The case the spec explicitly asked to surface.
    it('is low when two candidates score alike', () => {
      const ranked = rankHeroImages(
        [good({ url: 'a' }), good({ url: 'b' })],
        CTX,
      );
      expect(ranked[0].confidence).toBeLessThan(0.6);
    });

    it('is high for a sole candidate — there is nothing to confuse it with', () => {
      expect(rankHeroImages([good()], CTX)[0].confidence).toBeGreaterThan(0.8);
    });
  });

  describe('selectHeroImage', () => {
    it('picks the winner and reports no review needed for a clean choice', () => {
      const result = selectHeroImage(
        [
          good({ role: 'OFFICIAL_BANNER', url: 'a' }),
          good({ role: 'PLACEHOLDER', url: 'b', width: 300, height: 300 }),
        ],
        CTX,
      );
      expect(result.selected?.candidate.url).toBe('a');
      expect(result.needsReview).toBe(false);
    });

    it('flags for review when the top candidates are close', () => {
      const result = selectHeroImage(
        [good({ url: 'a' }), good({ url: 'b' })],
        CTX,
      );
      expect(result.needsReview).toBe(true);
      expect(result.reviewReason).toMatch(/similar/i);
    });

    it('flags for review when only a placeholder is available', () => {
      const result = selectHeroImage([good({ role: 'PLACEHOLDER' })], CTX);
      expect(result.needsReview).toBe(true);
      expect(result.reviewReason).toMatch(/placeholder/i);
    });

    it('flags for review when the winner itself has a quality problem', () => {
      const result = selectHeroImage(
        [good({ role: 'OFFICIAL_BANNER', width: 200, height: 200 })],
        CTX,
      );
      expect(result.needsReview).toBe(true);
      expect(result.reviewReason).toMatch(/blurred|resolution/i);
    });

    it('handles an empty or junk candidate list without throwing', () => {
      [[], null, undefined].forEach((input) => {
        const result = selectHeroImage(input as never, CTX);
        expect(result.selected).toBeNull();
        expect(result.needsReview).toBe(true);
      });
    });

    it('ignores candidates with no url', () => {
      const result = selectHeroImage(
        [{ url: '', role: 'OFFICIAL_BANNER' }, good({ url: 'real' })],
        CTX,
      );
      expect(result.selected?.candidate.url).toBe('real');
    });

    it('is deterministic for identical input', () => {
      const input = [good({ url: 'a' }), good({ url: 'b', role: 'INTERIOR' })];
      expect(rankHeroImages(input, CTX).map((r) => r.candidate.url)).toEqual(
        rankHeroImages(input, CTX).map((r) => r.candidate.url),
      );
    });
  });
});
