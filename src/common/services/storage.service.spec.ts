import { StorageService } from './storage.service';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import type { CloudStorageProvider } from './storage-providers/cloud-storage-provider.interface';
import type { S3StorageProvider } from './storage-providers/s3-storage.provider';
import type { FirebaseStorageProvider } from './storage-providers/firebase-storage.provider';

// Storage Migration Phase 1 — covers the facade's two responsibilities:
// (1) mock mode is completely untouched by this migration (still writes
// to local disk, never touches the injected provider), and (2) "real"
// mode correctly delegates to whichever CloudStorageProvider was bound —
// this is the seam every one of StorageService's 9 real callers depends
// on staying correct, so it gets direct coverage even though none of
// those callers' own specs needed to change (they mock StorageService
// itself, not this class).
//
// Compatibility follow-up — getFileByUrl() is deliberately NOT the same
// seam: it's always given both concrete providers (not just whichever one
// STORAGE_PROVIDER currently selects), since the document-preview proxy
// needs to read an S3 URL or a Firebase URL correctly regardless of which
// one is "active" for new writes right now.
describe('StorageService', () => {
  const testUploadDir = path.join(process.cwd(), 'uploads');

  const makeConfig = (values: Record<string, any>) =>
    ({
      get: jest.fn((key: string, def?: any) => (key in values ? values[key] : def)),
    }) as unknown as ConfigService;

  const makeProvider = (): jest.Mocked<CloudStorageProvider> => ({
    put: jest.fn().mockResolvedValue('https://provider.example.com/folder/file.png'),
    get: jest.fn().mockResolvedValue({ buffer: Buffer.from('data'), contentType: 'image/png' }),
    health: jest.fn().mockResolvedValue({ ok: true }),
  });

  const makeS3Provider = () =>
    ({ get: jest.fn() }) as unknown as jest.Mocked<S3StorageProvider>;
  const makeFirebaseProvider = () =>
    ({ get: jest.fn() }) as unknown as jest.Mocked<FirebaseStorageProvider>;

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('mock mode (USE_MOCK_STORAGE=true) — unchanged by this migration', () => {
    let provider: jest.Mocked<CloudStorageProvider>;
    let service: StorageService;

    beforeEach(() => {
      provider = makeProvider();
      service = new StorageService(
        makeConfig({ USE_MOCK_STORAGE: true }),
        provider,
        makeS3Provider(),
        makeFirebaseProvider(),
      );
    });

    afterEach(() => {
      // Clean up any files this test wrote to the real local uploads dir.
      const testFolder = path.join(testUploadDir, 'phase1-spec-folder');
      if (fs.existsSync(testFolder)) {
        fs.rmSync(testFolder, { recursive: true, force: true });
      }
    });

    it('writes to local disk and never calls the injected provider', async () => {
      const file = {
        buffer: Buffer.from('hello'),
        originalname: 'test.png',
        mimetype: 'image/png',
      } as Express.Multer.File;

      const url = await service.uploadFile(file, 'phase1-spec-folder');

      expect(url).toMatch(/^\/uploads\/phase1-spec-folder\/\d+-test\.png$/);
      expect(provider.put).not.toHaveBeenCalled();
    });

    it('checkHealth reports mode "mock" without calling the provider', async () => {
      const result = await service.checkHealth();
      expect(result).toEqual({ ok: true, mode: 'mock' });
      expect(provider.health).not.toHaveBeenCalled();
    });
  });

  describe('cloud mode (USE_MOCK_STORAGE=false) — delegates to the injected provider', () => {
    let provider: jest.Mocked<CloudStorageProvider>;
    let s3Provider: jest.Mocked<S3StorageProvider>;
    let firebaseProvider: jest.Mocked<FirebaseStorageProvider>;
    let service: StorageService;

    beforeEach(() => {
      provider = makeProvider();
      s3Provider = makeS3Provider();
      firebaseProvider = makeFirebaseProvider();
      service = new StorageService(
        makeConfig({ USE_MOCK_STORAGE: false, STORAGE_PROVIDER: 's3' }),
        provider,
        s3Provider,
        firebaseProvider,
      );
    });

    it('uploadFile delegates to provider.put with the buffer, folder, timestamped name, and mimetype', async () => {
      const file = {
        buffer: Buffer.from('hello'),
        originalname: 'photo.jpg',
        mimetype: 'image/jpeg',
      } as Express.Multer.File;

      const url = await service.uploadFile(file, 'businesses/shops');

      expect(url).toBe('https://provider.example.com/folder/file.png');
      expect(provider.put).toHaveBeenCalledTimes(1);
      const [buffer, folder, fileName, contentType] = provider.put.mock.calls[0];
      expect(buffer).toEqual(file.buffer);
      expect(folder).toBe('businesses/shops');
      expect(fileName).toMatch(/^\d+-photo\.jpg$/);
      expect(contentType).toBe('image/jpeg');
    });

    it('uploadBase64 decodes the data URI then delegates through uploadFile to provider.put', async () => {
      const dataUri = `data:image/png;base64,${Buffer.from('pixel').toString('base64')}`;
      const url = await service.uploadBase64(dataUri, 'claim-evidence', 'evidence-1.png');

      expect(url).toBe('https://provider.example.com/folder/file.png');
      expect(provider.put).toHaveBeenCalledTimes(1);
      const [buffer, folder] = provider.put.mock.calls[0];
      expect(buffer).toEqual(Buffer.from('pixel'));
      expect(folder).toBe('claim-evidence');
    });

    it('uploadBase64 returns the input unchanged when it is not a data URI (already a URL)', async () => {
      const existingUrl = 'https://provider.example.com/already/uploaded.png';
      const result = await service.uploadBase64(existingUrl, 'folder', 'name.png');
      expect(result).toBe(existingUrl);
      expect(provider.put).not.toHaveBeenCalled();
    });

    it('getFile delegates to provider.get with the given key', async () => {
      const result = await service.getFile('businesses/shops/123-shop.png');
      expect(provider.get).toHaveBeenCalledWith('businesses/shops/123-shop.png');
      expect(result).toEqual({ buffer: Buffer.from('data'), contentType: 'image/png' });
    });

    it('checkHealth merges provider.health() with the configured mode', async () => {
      const result = await service.checkHealth();
      expect(provider.health).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ok: true, mode: 's3' });
    });

    it('checkHealth reports mode "firebase" when STORAGE_PROVIDER=firebase', async () => {
      const firebaseService = new StorageService(
        makeConfig({ USE_MOCK_STORAGE: false, STORAGE_PROVIDER: 'firebase' }),
        provider,
        s3Provider,
        firebaseProvider,
      );
      const result = await firebaseService.checkHealth();
      expect(result).toEqual({ ok: true, mode: 'firebase' });
    });

    it('checkHealth surfaces a provider failure without throwing', async () => {
      provider.health.mockResolvedValue({ ok: false, error: 'bucket unreachable' });
      const result = await service.checkHealth();
      expect(result).toEqual({ ok: false, error: 'bucket unreachable', mode: 's3' });
    });

    describe('getFileByUrl — the document-preview proxy read path', () => {
      it('routes an S3 URL to s3Provider.get with the extracted key, regardless of the active STORAGE_PROVIDER', async () => {
        s3Provider.get.mockResolvedValue({ buffer: Buffer.from('s3-bytes'), contentType: 'image/jpeg' });

        // Active provider is STORAGE_PROVIDER=firebase here — proves
        // routing is by URL shape, not by whichever provider is "active."
        const firebaseActiveService = new StorageService(
          makeConfig({ USE_MOCK_STORAGE: false, STORAGE_PROVIDER: 'firebase' }),
          provider,
          s3Provider,
          firebaseProvider,
        );

        const result = await firebaseActiveService.getFileByUrl(
          'https://pairley-storage.s3.ap-south-1.amazonaws.com/businesses/documents/123-aadhaar.jpg',
        );

        expect(s3Provider.get).toHaveBeenCalledWith('businesses/documents/123-aadhaar.jpg');
        expect(firebaseProvider.get).not.toHaveBeenCalled();
        expect(result).toEqual({ buffer: Buffer.from('s3-bytes'), contentType: 'image/jpeg' });
      });

      it('routes a Firebase download URL to firebaseProvider.get with the full URL, regardless of the active STORAGE_PROVIDER', async () => {
        firebaseProvider.get.mockResolvedValue({ buffer: Buffer.from('fb-bytes'), contentType: 'application/pdf' });
        const firebaseUrl =
          'https://firebasestorage.googleapis.com/v0/b/pairley2026-4706e.firebasestorage.app/o/claim-evidence%2F1-evidence.pdf?alt=media&token=abc';

        // Active provider is STORAGE_PROVIDER=s3 here (service's default
        // from beforeEach) — proves routing is by URL shape, not by
        // whichever provider is "active."
        const result = await service.getFileByUrl(firebaseUrl);

        expect(firebaseProvider.get).toHaveBeenCalledWith(firebaseUrl);
        expect(s3Provider.get).not.toHaveBeenCalled();
        expect(result).toEqual({ buffer: Buffer.from('fb-bytes'), contentType: 'application/pdf' });
      });

      it('also recognizes a bare *.firebasestorage.app hostname (not just firebasestorage.googleapis.com)', async () => {
        firebaseProvider.get.mockResolvedValue({ buffer: Buffer.from('x'), contentType: 'image/png' });
        await service.getFileByUrl('https://pairley2026-4706e.firebasestorage.app/some/key.png');
        expect(firebaseProvider.get).toHaveBeenCalledTimes(1);
      });

      it('falls back to the active provider via getFile() for a bare key (no scheme)', async () => {
        await service.getFileByUrl('businesses/documents/legacy-key.jpg');
        expect(provider.get).toHaveBeenCalledWith('businesses/documents/legacy-key.jpg');
      });

      it('strips the /uploads/ prefix before delegating, matching getFile()\'s own contract', async () => {
        await service.getFileByUrl('/uploads/businesses/shops/local-dev-file.png');
        expect(provider.get).toHaveBeenCalledWith('businesses/shops/local-dev-file.png');
      });

      it('sanitizes a path-traversal attempt in the bare-key branch', async () => {
        await service.getFileByUrl('../../etc/passwd');
        const calledWith = provider.get.mock.calls[0][0];
        expect(calledWith).not.toContain('..');
      });

      it('sanitizes a path-traversal attempt embedded in an S3 URL', async () => {
        s3Provider.get.mockResolvedValue({ buffer: Buffer.from('x'), contentType: 'image/png' });
        await service.getFileByUrl('https://pairley-storage.s3.ap-south-1.amazonaws.com/../../etc/passwd');
        const calledWith = s3Provider.get.mock.calls[0][0];
        expect(calledWith).not.toContain('..');
      });

      it('throws a clear error for a URL that is neither an S3 nor a Firebase Storage URL', async () => {
        await expect(
          service.getFileByUrl('https://example.com/some/external/page'),
        ).rejects.toThrow('Unrecognized storage URL');
      });
    });
  });
});
