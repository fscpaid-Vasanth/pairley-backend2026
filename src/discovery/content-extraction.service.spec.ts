import { ContentExtractionService } from './content-extraction.service';

describe('ContentExtractionService', () => {
  const service = new ContentExtractionService();

  it('extracts title, description, image, and price from a well-formed page', () => {
    const html = `
      <html><head>
        <title>Diwali Sale &amp; Offers</title>
        <meta name="description" content="Flat 20% off storewide">
        <meta property="og:image" content="https://example.com/banner.jpg">
      </head><body>
        <p>Original price: ₹1,500 only this week!</p>
      </body></html>
    `;

    expect(service.extract(html)).toEqual({
      title: 'Diwali Sale & Offers',
      description: 'Flat 20% off storewide',
      image: 'https://example.com/banner.jpg',
      price: 1500,
    });
  });

  it('falls back to og:description when a plain description meta is absent', () => {
    const html = `<title>Shop</title><meta property="og:description" content="Best deals in town">`;
    expect(service.extract(html).description).toBe('Best deals in town');
  });

  it('handles content/name attribute ordering as well as name/content', () => {
    const html = `<meta content="Reversed order works too" name="description">`;
    expect(service.extract(html).description).toBe('Reversed order works too');
  });

  it('recognizes Rs. and INR price formats, not just ₹', () => {
    expect(service.extract('<p>Rs. 999 flat</p>').price).toBe(999);
    expect(service.extract('<p>INR 2,499.50 only</p>').price).toBe(2499.5);
  });

  it('returns null fields when nothing is found, rather than throwing', () => {
    expect(
      service.extract('<html><body>No structured data here</body></html>'),
    ).toEqual({
      title: null,
      description: null,
      image: null,
      price: null,
    });
  });

  it('ignores prices/text inside script and style tags', () => {
    const html = `<script>var price = "₹99999";</script><style>.a{content:"₹88888"}</style><p>Real price ₹500</p>`;
    expect(service.extract(html).price).toBe(500);
  });
});
