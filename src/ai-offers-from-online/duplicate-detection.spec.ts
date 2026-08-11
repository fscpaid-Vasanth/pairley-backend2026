import { classifyMechanic, isLikelyOfferSpecificUrl, mechanicsEqual, normalizeUrl, titleJaccard } from './duplicate-detection';

describe('normalizeUrl', () => {
  it('strips protocol, www, query string, fragment and trailing slash', () => {
    expect(normalizeUrl('https://www.Shapesgym.com/offers/annual-membership-50-off/?utm=x#top')).toBe(
      'shapesgym.com/offers/annual-membership-50-off',
    );
    expect(normalizeUrl('http://shapesgym.com/offers/annual-membership-50-off')).toBe(
      'shapesgym.com/offers/annual-membership-50-off',
    );
  });

  it('returns null for a missing or unparseable URL', () => {
    expect(normalizeUrl(null)).toBeNull();
    expect(normalizeUrl(undefined)).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });
});

describe('isLikelyOfferSpecificUrl', () => {
  it('treats an Instagram profile URL as NOT offer-specific', () => {
    expect(isLikelyOfferSpecificUrl('https://www.instagram.com/shapesgym/')).toBe(false);
    expect(isLikelyOfferSpecificUrl('https://instagram.com/shapesgym')).toBe(false);
  });

  it('treats an Instagram post/reel URL as offer-specific', () => {
    expect(isLikelyOfferSpecificUrl('https://www.instagram.com/p/Cxyz123abc/')).toBe(true);
    expect(isLikelyOfferSpecificUrl('https://www.instagram.com/reel/Cxyz123abc/')).toBe(true);
  });

  it('treats a Facebook page URL as NOT offer-specific, but a specific post as offer-specific', () => {
    expect(isLikelyOfferSpecificUrl('https://www.facebook.com/shapesgym')).toBe(false);
    expect(isLikelyOfferSpecificUrl('https://www.facebook.com/shapesgym/posts/1234567890')).toBe(true);
  });

  it('treats a bare merchant homepage as NOT offer-specific', () => {
    expect(isLikelyOfferSpecificUrl('https://shapesgym.com')).toBe(false);
    expect(isLikelyOfferSpecificUrl('https://shapesgym.com/')).toBe(false);
  });

  it('treats a generic listing/category page as NOT offer-specific', () => {
    expect(isLikelyOfferSpecificUrl('https://shapesgym.com/offers')).toBe(false);
    expect(isLikelyOfferSpecificUrl('https://aggregator.com/deals')).toBe(false);
  });

  it('treats a specific-looking merchant page (long slug or numeric id) as offer-specific', () => {
    expect(isLikelyOfferSpecificUrl('https://shapesgym.com/offers/annual-membership-50-off')).toBe(true);
    expect(isLikelyOfferSpecificUrl('https://aggregator.com/deals/123456')).toBe(true);
  });

  it('is uncertain-safe: an unrecognized shape returns false rather than guessing true', () => {
    expect(isLikelyOfferSpecificUrl(null)).toBe(false);
    expect(isLikelyOfferSpecificUrl('not a url')).toBe(false);
  });
});

describe('classifyMechanic', () => {
  it('classifies FLAT_PRICE from a real original->offer price pair', () => {
    const result = classifyMechanic('Annual Membership', 999, 499);
    expect(result.type).toBe('FLAT_PRICE');
    expect(result.originalPrice).toBe(999);
    expect(result.offerPrice).toBe(499);
  });

  it('classifies PERCENTAGE_OFF from stated text when no price pair is given', () => {
    const result = classifyMechanic('Flat 50% OFF Annual Membership', null, null);
    expect(result.type).toBe('PERCENTAGE_OFF');
    expect(result.percent).toBe(50);
  });

  it('classifies BOGO and BOGT distinctly', () => {
    expect(classifyMechanic('Buy One Get One Free on all pastries', null, null).type).toBe('BOGO');
    expect(classifyMechanic('Buy 2 Pairs, Get Your 3rd Free', null, null).type).toBe('BOGT');
  });

  it('classifies FREE_BENEFIT when only "free" is present with no BOGO/BOGT/percent pattern', () => {
    expect(classifyMechanic('Sign up today and get one month free', null, null).type).toBe('FREE_BENEFIT');
  });

  it('classifies OTHER when nothing recognizable is present', () => {
    expect(classifyMechanic('Student Rate ₹1,299/month', null, null).type).toBe('OTHER');
  });
});

describe('mechanicsEqual', () => {
  it('FLAT_PRICE: within 2% on both prices is equal', () => {
    const a = classifyMechanic('', 999, 499);
    const b = classifyMechanic('', 999, 505); // ~1.2% off 499
    expect(mechanicsEqual(a, b)).toBe(true);
  });

  it('FLAT_PRICE: more than 2% different is not equal', () => {
    const a = classifyMechanic('', 999, 499);
    const b = classifyMechanic('', 999, 599); // ~20% different
    expect(mechanicsEqual(a, b)).toBe(false);
  });

  it('PERCENTAGE_OFF: within 2 points is equal, more than 2 points is not', () => {
    const fifty = classifyMechanic('50% off', null, null);
    const fiftyOne = classifyMechanic('51% off', null, null);
    const sixty = classifyMechanic('60% off', null, null);
    expect(mechanicsEqual(fifty, fiftyOne)).toBe(true);
    expect(mechanicsEqual(fifty, sixty)).toBe(false);
  });

  it('BOGO/BOGT/FREE_BENEFIT: type equality alone is sufficient', () => {
    const a = classifyMechanic('Buy One Get One Free', null, null);
    const b = classifyMechanic('BOGO on all items', null, null);
    expect(mechanicsEqual(a, b)).toBe(true);
  });

  it('OTHER never equals anything, including another OTHER', () => {
    const a = classifyMechanic('Student Rate ₹1,299/month', null, null);
    const b = classifyMechanic('Personal Training Sessions', null, null);
    expect(a.type).toBe('OTHER');
    expect(b.type).toBe('OTHER');
    expect(mechanicsEqual(a, b)).toBe(false);
  });

  it('different mechanic types never match', () => {
    const percent = classifyMechanic('50% off', null, null);
    const bogo = classifyMechanic('Buy One Get One Free', null, null);
    expect(mechanicsEqual(percent, bogo)).toBe(false);
  });
});

describe('titleJaccard', () => {
  it('is 1.0 for identical titles (case/whitespace-insensitive)', () => {
    expect(titleJaccard('Flat 50% OFF Annual Membership', 'flat   50% off annual membership')).toBe(1);
  });

  it('is 0 for completely disjoint titles', () => {
    expect(titleJaccard('Flat 50% OFF Annual Membership', 'Buy One Get One Pastries')).toBe(0);
  });

  it('is partial for overlapping-but-different titles', () => {
    const score = titleJaccard('Shapes Gym Flat 50% OFF Annual Membership', 'Shapes Gym Student Rate Monthly');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.5);
  });
});
