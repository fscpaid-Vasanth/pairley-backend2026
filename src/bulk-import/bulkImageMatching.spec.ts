import {
  parseImageFilename,
  decideImageMapping,
  SUPPORTED_IMAGE_EXTENSIONS,
} from './bulkImageMatching';

describe('parseImageFilename', () => {
  it('parses a bare hero filename as slot 0', () => {
    expect(parseImageFilename('OFF000123.jpg')).toEqual({
      kind: 'MATCHED',
      code: 123,
      slot: 0,
    });
  });

  it('parses a gallery filename with its slot number', () => {
    expect(parseImageFilename('OFF000123_1.jpg')).toEqual({
      kind: 'MATCHED',
      code: 123,
      slot: 1,
    });
    expect(parseImageFilename('OFF000123_2.png')).toEqual({
      kind: 'MATCHED',
      code: 123,
      slot: 2,
    });
  });

  it('is case-insensitive on the OFF prefix and extension', () => {
    expect(parseImageFilename('off000123.JPG')).toEqual({
      kind: 'MATCHED',
      code: 123,
      slot: 0,
    });
  });

  it('does not require zero-padding', () => {
    expect(parseImageFilename('OFF123.jpg')).toEqual({
      kind: 'MATCHED',
      code: 123,
      slot: 0,
    });
  });

  it.each(SUPPORTED_IMAGE_EXTENSIONS)('accepts .%s', (ext) => {
    expect(parseImageFilename(`OFF000001.${ext}`).kind).toBe('MATCHED');
  });

  it.each([
    'random-photo.jpg',
    'OFF.jpg',
    'OFF000123.gif',
    'OFF000123.bmp',
    'OFF000123',
    'OFFabc.jpg',
    '000123.jpg',
  ])('rejects %s as an unrecognised filename', (name) => {
    expect(parseImageFilename(name)).toEqual({ kind: 'INVALID_FILENAME' });
  });
});

describe('decideImageMapping', () => {
  const offerCodeToId = new Map([
    [123, 'offer-a'],
    [456, 'offer-b'],
  ]);

  it('maps a hero image to the matching offer', () => {
    expect(
      decideImageMapping('OFF000123.jpg', offerCodeToId, new Set()),
    ).toEqual({
      status: 'MAPPED',
      offerId: 'offer-a',
      slot: 0,
      code: 123,
    });
  });

  it('maps a gallery image to the matching offer and slot', () => {
    expect(
      decideImageMapping('OFF000123_2.jpg', offerCodeToId, new Set()),
    ).toEqual({
      status: 'MAPPED',
      offerId: 'offer-a',
      slot: 2,
      code: 123,
    });
  });

  it('reports a code with no matching offer in this batch', () => {
    expect(
      decideImageMapping('OFF000999.jpg', offerCodeToId, new Set()),
    ).toEqual({
      status: 'MISSING_OFFER',
      code: 999,
      slot: 0,
    });
  });

  it('reports a slot already claimed by an earlier file', () => {
    const taken = new Set(['offer-a:0']);
    expect(decideImageMapping('OFF000123.jpg', offerCodeToId, taken)).toEqual({
      status: 'DUPLICATE',
      offerId: 'offer-a',
      slot: 0,
      code: 123,
    });
  });

  it('does not confuse the same slot number on two different offers', () => {
    const taken = new Set(['offer-a:0']);
    expect(decideImageMapping('OFF000456.jpg', offerCodeToId, taken)).toEqual({
      status: 'MAPPED',
      offerId: 'offer-b',
      slot: 0,
      code: 456,
    });
  });

  it('reports an unrecognised filename regardless of the offer set', () => {
    expect(decideImageMapping('random.jpg', offerCodeToId, new Set())).toEqual({
      status: 'INVALID_FILE',
    });
  });

  // The core safety property: a code that belongs to a DIFFERENT batch's
  // offer must never match here, since offerCodeToId is scoped by the
  // caller to only this batch's own offers.
  it('never matches a code outside the batch-scoped map, even if it exists elsewhere', () => {
    const scoped = new Map([[123, 'offer-a']]); // batch B's offers only
    expect(decideImageMapping('OFF000456.jpg', scoped, new Set())).toEqual({
      status: 'MISSING_OFFER',
      code: 456,
      slot: 0,
    });
  });
});
