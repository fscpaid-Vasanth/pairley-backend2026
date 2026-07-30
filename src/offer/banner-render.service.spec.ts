import sharp from 'sharp';
import { BannerRenderService } from './banner-render.service';
import { StorageService } from '../common/services/storage.service';

const originalFetch = global.fetch;

const BASE_INPUT = {
  title: 'Weekend Buffet',
  offerType: 'BOGO',
  originalPrice: 1200,
  offerPrice: 600,
  requiredPeople: 2,
  category: 'dining',
  businessName: 'The Big Barbeque',
  businessStatus: 'UNCLAIMED',
  city: 'Chennai',
  source: 'WEBSITE',
};

async function samplePng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 400,
      height: 400,
      channels: 3,
      background: { r: 90, g: 120, b: 200 },
    },
  })
    .png()
    .toBuffer();
}

describe('BannerRenderService (Module 14 Phase 3B/3C)', () => {
  let storage: { getFileByUrl: jest.Mock };
  let service: BannerRenderService;

  beforeEach(() => {
    storage = { getFileByUrl: jest.fn() };
    service = new BannerRenderService(storage as unknown as StorageService);
    global.fetch = jest.fn();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('renders successfully with no hero image at all', async () => {
    const result = await service.render(BASE_INPUT);
    expect(result.usedHeroImage).toBe(false);
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(storage.getFileByUrl).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // The real bug found during live verification: our own S3-stored images
  // 403 on a plain fetch (no public GetObject), so a hero image sourced from
  // our own storage — an admin's uploaded replacement, or a poster/PDF
  // import's cover image — must go through the authenticated read path,
  // exactly like the admin document-preview proxy does for the same reason.
  describe('routes by URL origin', () => {
    it('reads an S3-hosted hero through the authenticated StorageService path, not fetch', async () => {
      const png = await samplePng();
      storage.getFileByUrl.mockResolvedValue({
        buffer: png,
        contentType: 'image/png',
      });

      const result = await service.render({
        ...BASE_INPUT,
        heroImageUrl:
          'https://pairley-storage.s3.ap-south-1.amazonaws.com/banners/x.png',
      });

      expect(storage.getFileByUrl).toHaveBeenCalledWith(
        'https://pairley-storage.s3.ap-south-1.amazonaws.com/banners/x.png',
      );
      expect(global.fetch).not.toHaveBeenCalled();
      expect(result.usedHeroImage).toBe(true);
    });

    it('reads a Firebase-hosted hero through the authenticated path too', async () => {
      const png = await samplePng();
      storage.getFileByUrl.mockResolvedValue({
        buffer: png,
        contentType: 'image/png',
      });

      await service.render({
        ...BASE_INPUT,
        heroImageUrl:
          'https://firebasestorage.googleapis.com/v0/b/pairley/o/x.png',
      });

      expect(storage.getFileByUrl).toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('reads a genuinely external hero (a merchant’s own site) via plain fetch', async () => {
      const png = await samplePng();
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        arrayBuffer: () =>
          png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
      });

      const result = await service.render({
        ...BASE_INPUT,
        heroImageUrl: 'https://specgym.in/photos/gym.jpg',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://specgym.in/photos/gym.jpg',
        expect.any(Object),
      );
      expect(storage.getFileByUrl).not.toHaveBeenCalled();
      expect(result.usedHeroImage).toBe(true);
    });
  });

  describe('a missing photo never blocks the banner', () => {
    it('falls back to the gradient plate when the storage read fails', async () => {
      storage.getFileByUrl.mockRejectedValue(new Error('AccessDenied'));
      const result = await service.render({
        ...BASE_INPUT,
        heroImageUrl: 'https://x.amazonaws.com/banners/missing.png',
      });
      expect(result.usedHeroImage).toBe(false);
      expect(result.buffer.length).toBeGreaterThan(0);
    });

    it('falls back to the gradient plate when the external fetch fails', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await service.render({
        ...BASE_INPUT,
        heroImageUrl: 'https://x/y.jpg',
      });
      expect(result.usedHeroImage).toBe(false);
    });

    it('falls back when the external fetch returns a non-OK status', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 404 });
      const result = await service.render({
        ...BASE_INPUT,
        heroImageUrl: 'https://x/404.jpg',
      });
      expect(result.usedHeroImage).toBe(false);
    });

    it('falls back when the fetched/read bytes are not a decodable image', async () => {
      storage.getFileByUrl.mockResolvedValue({
        buffer: Buffer.from('not an image'),
        contentType: 'image/png',
      });
      const result = await service.render({
        ...BASE_INPUT,
        heroImageUrl: 'https://x.amazonaws.com/banners/corrupt.png',
      });
      expect(result.usedHeroImage).toBe(false);
      expect(result.buffer.length).toBeGreaterThan(0);
    });
  });

  it('produces a PNG of the requested banner dimensions', async () => {
    const result = await service.render(BASE_INPUT);
    expect(result.width).toBe(1080);
    expect(result.height).toBe(1080);
    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1080);
    expect(meta.format).toBe('png');
  });

  it('renders every template without throwing', async () => {
    for (const templateId of ['A', 'B', 'C', 'D', 'E']) {
      const result = await service.render({ ...BASE_INPUT, templateId });
      expect(result.buffer.length).toBeGreaterThan(0);
    }
  });
});
