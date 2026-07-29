import { BusinessController } from './business.controller';
import { BusinessService } from './business.service';
import { AuthService } from '../auth/auth.service';
import { StorageService } from '../common/services/storage.service';

// Storage Migration Phase 1 (compatibility follow-up) — the admin
// document-preview proxy is the one controller-level change in this
// follow-up, so it gets direct coverage even though this repo doesn't
// otherwise have a business.controller.spec.ts. Scoped to just
// getDocumentPreview, not a full controller suite.
describe('BusinessController.getDocumentPreview', () => {
  let storageService: { getFileByUrl: jest.Mock };
  let controller: BusinessController;

  const makeRes = () => {
    const res: any = {
      statusCode: null,
      headers: {},
      status: jest.fn().mockImplementation(function (this: any, code: number) {
        this.statusCode = code;
        return this;
      }),
      json: jest.fn().mockImplementation(function (this: any, body: any) {
        this.body = body;
        return this;
      }),
      redirect: jest.fn(),
      setHeader: jest.fn().mockImplementation(function (this: any, key: string, value: string) {
        this.headers[key] = value;
      }),
      send: jest.fn().mockImplementation(function (this: any, body: any) {
        this.body = body;
        return this;
      }),
    };
    return res;
  };

  beforeEach(() => {
    storageService = {
      getFileByUrl: jest
        .fn()
        .mockResolvedValue({ buffer: Buffer.from('file-bytes'), contentType: 'image/jpeg' }),
    };
    controller = new BusinessController(
      {} as unknown as BusinessService,
      {} as unknown as AuthService,
      storageService as unknown as StorageService,
    );
  });

  it('proxies an S3 URL through getFileByUrl and streams the bytes', async () => {
    const res = makeRes();
    await controller.getDocumentPreview(
      'https://pairley-storage.s3.ap-south-1.amazonaws.com/businesses/documents/123-aadhaar.jpg',
      undefined as any,
      res,
    );

    expect(storageService.getFileByUrl).toHaveBeenCalledWith(
      'https://pairley-storage.s3.ap-south-1.amazonaws.com/businesses/documents/123-aadhaar.jpg',
    );
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.headers['Content-Type']).toBe('image/jpeg');
    expect(res.send).toHaveBeenCalledWith(Buffer.from('file-bytes'));
  });

  it('proxies a Firebase Storage download URL through getFileByUrl (the new capability)', async () => {
    const res = makeRes();
    const firebaseUrl =
      'https://firebasestorage.googleapis.com/v0/b/pairley2026-4706e.firebasestorage.app/o/claim-evidence%2F1-evidence.pdf?alt=media&token=abc';

    await controller.getDocumentPreview(firebaseUrl, undefined as any, res);

    expect(storageService.getFileByUrl).toHaveBeenCalledWith(firebaseUrl);
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith(Buffer.from('file-bytes'));
  });

  it('recognizes a bare *.firebasestorage.app hostname too', async () => {
    const res = makeRes();
    await controller.getDocumentPreview(
      'https://pairley2026-4706e.firebasestorage.app/some/key.png',
      undefined as any,
      res,
    );
    expect(storageService.getFileByUrl).toHaveBeenCalledTimes(1);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('still redirects (does not proxy) a URL that is neither S3 nor Firebase Storage', async () => {
    const res = makeRes();
    await controller.getDocumentPreview('https://example.com/some/external/page', undefined as any, res);

    expect(res.redirect).toHaveBeenCalledWith('https://example.com/some/external/page');
    expect(storageService.getFileByUrl).not.toHaveBeenCalled();
  });

  it('still redirects a WEBSITE-sourced original_import_url exactly as before', async () => {
    const res = makeRes();
    await controller.getDocumentPreview('https://some-merchant-website.example/menu.jpg', undefined as any, res);
    expect(res.redirect).toHaveBeenCalledWith('https://some-merchant-website.example/menu.jpg');
  });

  it('sets Content-Disposition with a filename derived from an S3 URL when download=true', async () => {
    const res = makeRes();
    await controller.getDocumentPreview(
      'https://pairley-storage.s3.ap-south-1.amazonaws.com/businesses/documents/123-aadhaar.jpg',
      'true',
      res,
    );
    expect(res.headers['Content-Disposition']).toBe('attachment; filename="123-aadhaar.jpg"');
  });

  it('sets Content-Disposition with a filename derived from an encoded Firebase URL when download=true', async () => {
    const res = makeRes();
    const firebaseUrl =
      'https://firebasestorage.googleapis.com/v0/b/pairley2026-4706e.firebasestorage.app/o/businesses%2Fdocuments%2F123-shop.png?alt=media&token=abc';
    await controller.getDocumentPreview(firebaseUrl, 'true', res);
    expect(res.headers['Content-Disposition']).toBe('attachment; filename="123-shop.png"');
  });

  it('returns 400 when no url is provided', async () => {
    const res = makeRes();
    await controller.getDocumentPreview('', undefined as any, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(storageService.getFileByUrl).not.toHaveBeenCalled();
  });

  it('returns 404 with the underlying error message when getFileByUrl fails', async () => {
    storageService.getFileByUrl.mockRejectedValue(new Error('Firebase Storage fetch failed: object-not-found'));
    const res = makeRes();
    await controller.getDocumentPreview(
      'https://pairley-storage.s3.ap-south-1.amazonaws.com/missing/key.jpg',
      undefined as any,
      res,
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Firebase Storage fetch failed: object-not-found' });
  });
});
