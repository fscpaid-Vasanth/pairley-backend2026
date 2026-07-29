import { ConfigService } from '@nestjs/config';

const mockExistsSync = jest.fn();
const mockReadFileSync = jest.fn();
// Full module mock, not jest.spyOn(fs, ...) — under this project's Node/TS
// module interop, `fs`'s named exports are non-configurable, so spyOn
// can't redefine them even once ("Cannot redefine property: existsSync").
// Replacing the whole module before it's ever required sidesteps that.
jest.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}));

const mockCert = jest.fn().mockReturnValue({ __mockCredential: true });
const mockInitializeApp = jest.fn();
const mockGetApps = jest.fn().mockReturnValue([]);
const mockSave = jest.fn();
const mockDownload = jest.fn();
const mockGetMetadata = jest.fn();
const mockBucketExists = jest.fn();
const mockFile = jest.fn().mockImplementation(() => ({
  save: mockSave,
  download: mockDownload,
  getMetadata: mockGetMetadata,
}));
const mockBucket = jest.fn().mockImplementation(() => ({
  file: mockFile,
  exists: mockBucketExists,
}));
const mockGetStorage = jest.fn().mockReturnValue({ bucket: mockBucket });

jest.mock('firebase-admin/app', () => ({
  initializeApp: mockInitializeApp,
  getApps: mockGetApps,
  cert: mockCert,
}));
jest.mock('firebase-admin/storage', () => ({
  getStorage: mockGetStorage,
}));

import { FirebaseStorageProvider } from './firebase-storage.provider';

// Storage Migration Phase 1 — mirrors the pre-existing precedent from
// notification.service.ts: a firebase-service-account.json read from the
// project root. Mocked here via fs spies rather than a real file on disk,
// exactly like there being no real S3 credentials in the S3 provider spec.
describe('FirebaseStorageProvider', () => {
  const makeConfig = (overrides: Record<string, string> = {}) =>
    ({
      get: jest.fn((key: string, def?: any) => {
        const values: Record<string, string> = {
          FIREBASE_STORAGE_BUCKET: 'pairley2026-4706e.firebasestorage.app',
          ...overrides,
        };
        return values[key] ?? def;
      }),
    }) as unknown as ConfigService;

  let provider: FirebaseStorageProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new FirebaseStorageProvider(makeConfig());
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ project_id: 'pairley2026-4706e' }));
  });

  it('put() initializes the app once from the service account file, uploads with a download token, and returns a real Firebase download URL', async () => {
    mockSave.mockResolvedValue(undefined);

    const url = await provider.put(Buffer.from('hello'), 'businesses/shops', '123-shop.png', 'image/png');

    expect(mockInitializeApp).toHaveBeenCalledTimes(1);
    expect(mockCert).toHaveBeenCalledWith({ project_id: 'pairley2026-4706e' });
    expect(mockFile).toHaveBeenCalledWith('businesses/shops/123-shop.png');
    expect(mockSave).toHaveBeenCalledTimes(1);
    const [buffer, opts] = mockSave.mock.calls[0];
    expect(buffer).toEqual(Buffer.from('hello'));
    expect(opts.metadata.contentType).toBe('image/png');
    expect(opts.metadata.metadata.firebaseStorageDownloadTokens).toEqual(expect.any(String));

    expect(url).toMatch(
      /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/pairley2026-4706e\.firebasestorage\.app\/o\/businesses%2Fshops%2F123-shop\.png\?alt=media&token=.+$/,
    );
  });

  it('put() only initializes the Firebase app once across multiple calls on the same instance', async () => {
    mockSave.mockResolvedValue(undefined);
    await provider.put(Buffer.from('a'), 'folder', 'a.png', 'image/png');
    await provider.put(Buffer.from('b'), 'folder', 'b.png', 'image/png');
    expect(mockInitializeApp).toHaveBeenCalledTimes(1);
  });

  it('put() throws a clear error when neither the env var nor the file is available', async () => {
    mockExistsSync.mockReturnValue(false);
    await expect(
      provider.put(Buffer.from('x'), 'folder', 'name.png', 'image/png'),
    ).rejects.toThrow(/No Firebase credentials found/);
  });

  describe('credential source: FIREBASE_SERVICE_ACCOUNT_JSON env var', () => {
    it('accepts the service account as a raw JSON string, taking priority over the file', async () => {
      const envProvider = new FirebaseStorageProvider(
        makeConfig({ FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: 'from-env' }) }),
      );
      mockSave.mockResolvedValue(undefined);

      await envProvider.put(Buffer.from('x'), 'folder', 'name.png', 'image/png');

      expect(mockCert).toHaveBeenCalledWith({ project_id: 'from-env' });
      expect(mockExistsSync).not.toHaveBeenCalled();
    });

    it('accepts the service account as base64-encoded JSON (avoids .env private_key newline issues)', async () => {
      const encoded = Buffer.from(JSON.stringify({ project_id: 'from-env-b64' })).toString('base64');
      const envProvider = new FirebaseStorageProvider(
        makeConfig({ FIREBASE_SERVICE_ACCOUNT_JSON: encoded }),
      );
      mockSave.mockResolvedValue(undefined);

      await envProvider.put(Buffer.from('x'), 'folder', 'name.png', 'image/png');

      expect(mockCert).toHaveBeenCalledWith({ project_id: 'from-env-b64' });
    });

    it('throws a clear error when the env var is set but is neither valid JSON nor valid base64 JSON', async () => {
      const envProvider = new FirebaseStorageProvider(
        makeConfig({ FIREBASE_SERVICE_ACCOUNT_JSON: 'not json and not base64 json either' }),
      );
      await expect(
        envProvider.put(Buffer.from('x'), 'folder', 'name.png', 'image/png'),
      ).rejects.toThrow(/neither valid JSON nor valid base64-encoded JSON/);
    });
  });

  it('put() throws a clear error when the underlying save() call fails', async () => {
    mockSave.mockRejectedValue(new Error('permission-denied'));
    await expect(
      provider.put(Buffer.from('x'), 'folder', 'name.png', 'image/png'),
    ).rejects.toThrow('Firebase Storage upload failed: permission-denied');
  });

  it('get() downloads the object and reads its content type from metadata', async () => {
    mockDownload.mockResolvedValue([Buffer.from('file-bytes')]);
    mockGetMetadata.mockResolvedValue([{ contentType: 'application/pdf' }]);

    const result = await provider.get('claim-evidence/1-evidence.pdf');

    expect(mockFile).toHaveBeenCalledWith('claim-evidence/1-evidence.pdf');
    expect(result).toEqual({ buffer: Buffer.from('file-bytes'), contentType: 'application/pdf' });
  });

  it('get() resolves a full Firebase download URL back down to its object key', async () => {
    mockDownload.mockResolvedValue([Buffer.from('bytes')]);
    mockGetMetadata.mockResolvedValue([{ contentType: 'image/png' }]);

    const fullUrl =
      'https://firebasestorage.googleapis.com/v0/b/pairley2026-4706e.firebasestorage.app/o/businesses%2Fshops%2F123-shop.png?alt=media&token=abc-123';
    await provider.get(fullUrl);

    expect(mockFile).toHaveBeenCalledWith('businesses/shops/123-shop.png');
  });

  it('get() falls back to image/png when metadata has no contentType', async () => {
    mockDownload.mockResolvedValue([Buffer.from('x')]);
    mockGetMetadata.mockResolvedValue([{}]);
    const result = await provider.get('some/key.bin');
    expect(result.contentType).toBe('image/png');
  });

  it('get() throws a clear error when the download fails', async () => {
    mockDownload.mockRejectedValue(new Error('object-not-found'));
    mockGetMetadata.mockResolvedValue([{}]);
    await expect(provider.get('missing/key.png')).rejects.toThrow(
      'Firebase Storage fetch failed: object-not-found',
    );
  });

  it('health() returns ok:true when the bucket exists', async () => {
    mockBucketExists.mockResolvedValue([true]);
    const result = await provider.health();
    expect(result).toEqual({ ok: true });
  });

  it('health() returns ok:false when the bucket does not exist, without throwing', async () => {
    mockBucketExists.mockResolvedValue([false]);
    const result = await provider.health();
    expect(result).toEqual({
      ok: false,
      error: 'Bucket pairley2026-4706e.firebasestorage.app does not exist',
    });
  });

  it('health() returns ok:false with the error message when the check itself throws', async () => {
    mockBucketExists.mockRejectedValue(new Error('network error'));
    const result = await provider.health();
    expect(result).toEqual({ ok: false, error: 'network error' });
  });
});
