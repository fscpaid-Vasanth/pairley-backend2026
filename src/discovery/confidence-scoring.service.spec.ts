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
});
