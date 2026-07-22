import { ConfidenceScoringService } from './confidence-scoring.service';

describe('ConfidenceScoringService', () => {
  const service = new ConfidenceScoringService();

  it('scores a fully-populated extraction at 1.0', () => {
    expect(
      service.score({
        title: 'Sale',
        description: 'Big sale',
        image: 'x.jpg',
        price: 500,
      }),
    ).toBe(1);
  });

  it('scores an empty extraction at 0', () => {
    expect(
      service.score({
        title: null,
        description: null,
        image: null,
        price: null,
      }),
    ).toBe(0);
  });

  it('scores title-only lower than a fuller extraction', () => {
    const titleOnly = service.score({
      title: 'Sale',
      description: null,
      image: null,
      price: null,
    });
    const titleAndPrice = service.score({
      title: 'Sale',
      description: null,
      image: null,
      price: 500,
    });
    expect(titleOnly).toBeLessThan(titleAndPrice);
    expect(titleOnly).toBe(0.4);
  });

  it('treats a price of 0 as present (not falsy-absent)', () => {
    const withZeroPrice = service.score({
      title: null,
      description: null,
      image: null,
      price: 0,
    });
    expect(withZeroPrice).toBe(0.25);
  });

  describe('OCR confidence blending (Module 10)', () => {
    const fields = {
      title: 'Sale',
      description: 'Big sale',
      image: null,
      price: 500,
    };
    // fieldScore for `fields` above = title(0.4) + description(0.25) + price(0.25) = 0.9

    it('is unaffected when no OCR confidence is supplied — exact Module 9 behavior', () => {
      expect(service.score(fields)).toBe(0.9);
    });

    it('blends a high OCR confidence upward only slightly when field score is already high', () => {
      const blended = service.score(fields, 1);
      expect(blended).toBe(Math.round((0.9 * 0.7 + 1 * 0.3) * 100) / 100);
    });

    it('pulls the score down when OCR confidence is low, even with complete fields', () => {
      const blended = service.score(fields, 0.1);
      expect(blended).toBeLessThan(0.9);
      expect(blended).toBe(Math.round((0.9 * 0.7 + 0.1 * 0.3) * 100) / 100);
    });

    it('blends correctly for a sparse extraction with a mid-range OCR confidence', () => {
      const sparse = {
        title: 'X',
        description: null,
        image: null,
        price: null,
      };
      const blended = service.score(sparse, 0.5);
      expect(blended).toBe(Math.round((0.4 * 0.7 + 0.5 * 0.3) * 100) / 100);
    });
  });
});
