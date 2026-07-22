import { TextExtractionService } from './text-extraction.service';

describe('TextExtractionService', () => {
  let service: TextExtractionService;

  beforeEach(() => {
    service = new TextExtractionService();
  });

  it('uses the first substantial line as the title', () => {
    const result = service.extract(
      'Diwali Mega Sale\nUpto 50% off on all items\nValid till 31st Oct',
    );
    expect(result.title).toBe('Diwali Mega Sale');
  });

  it('joins the remaining lines into the description', () => {
    const result = service.extract(
      'Diwali Mega Sale\nUpto 50% off on all items\nValid till 31st Oct',
    );
    expect(result.description).toBe(
      'Upto 50% off on all items Valid till 31st Oct',
    );
  });

  it('extracts a ₹-prefixed price from anywhere in the text', () => {
    const result = service.extract('Combo Offer\nBuy 2 Get 3 free\nOnly ₹499');
    expect(result.price).toBe(499);
  });

  it('extracts an Rs.-prefixed price with commas', () => {
    const result = service.extract(
      'Festival Special\nFlat discount\nRs. 1,999 only',
    );
    expect(result.price).toBe(1999);
  });

  it('always returns a null image — the uploaded file itself is the image, not something derived from text', () => {
    const result = service.extract('Some Offer\nDetails here\n₹100');
    expect(result.image).toBeNull();
  });

  it('returns nulls for empty or whitespace-only OCR output', () => {
    const result = service.extract('   \n\n  ');
    expect(result).toEqual({
      title: null,
      description: null,
      image: null,
      price: null,
    });
  });

  it('skips lines that are purely numeric/symbolic when picking a title', () => {
    const result = service.extract(
      '12345\n---\nReal Offer Title\nMore details',
    );
    expect(result.title).toBe('Real Offer Title');
  });

  it('truncates an unusually long title line', () => {
    const longLine = 'A'.repeat(150);
    const result = service.extract(longLine);
    expect(result.title?.length).toBeLessThanOrEqual(101); // 100 chars + ellipsis
    expect(result.title?.endsWith('…')).toBe(true);
  });

  it('returns a null description when nothing remains after the title line', () => {
    const result = service.extract('Only One Line Here');
    expect(result.description).toBeNull();
  });
});
