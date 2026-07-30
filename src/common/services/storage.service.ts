import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { CLOUD_STORAGE_PROVIDER } from './storage-providers/cloud-storage-provider.interface';
import type { CloudStorageProvider } from './storage-providers/cloud-storage-provider.interface';
import { S3StorageProvider } from './storage-providers/s3-storage.provider';
import { FirebaseStorageProvider } from './storage-providers/firebase-storage.provider';

// Storage Migration Phase 1 — StorageService is now a thin facade. Its
// public API (uploadFile/uploadBase64/getFile/checkHealth) is byte-for-
// byte unchanged from before this migration — every one of its 9 callers
// across the app (auth, business, offer, claim-request, import-
// orchestration, system-health) needs zero changes, since none of them
// ever depended on *how* the "real" branch talks to a cloud provider, only
// on this method contract.
//
// What changed: the "not mock" branch used to hardcode the AWS SDK inline.
// It now delegates to whichever CloudStorageProvider was bound at
// module-build time (see common.module.ts's STORAGE_PROVIDER factory) —
// S3StorageProvider today, FirebaseStorageProvider available behind the
// STORAGE_PROVIDER=firebase flag, selected once at startup, not per-call.
// The USE_MOCK_STORAGE local-disk fallback is untouched — mock mode never
// touches the injected provider at all.
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly useMock: boolean;
  private readonly uploadDir = path.join(process.cwd(), 'uploads');

  constructor(
    private configService: ConfigService,
    @Inject(CLOUD_STORAGE_PROVIDER)
    private readonly provider: CloudStorageProvider,
    // Always both available, independent of which one STORAGE_PROVIDER
    // currently selects as `provider` above (used for writes and for
    // plain getFile()/checkHealth()). getFileByUrl() below needs to reach
    // *either* one directly — an S3 URL created before a STORAGE_PROVIDER
    // flip must still read correctly after the flip, and vice versa.
    private readonly s3Provider: S3StorageProvider,
    private readonly firebaseProvider: FirebaseStorageProvider,
  ) {
    const mockStorageVal = this.configService.get<any>(
      'USE_MOCK_STORAGE',
      true,
    );
    this.useMock = mockStorageVal === true || mockStorageVal === 'true';

    if (this.useMock && !fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  async uploadFile(file: Express.Multer.File, folder: string): Promise<string> {
    const fileName = `${Date.now()}-${path.basename(file.originalname)}`;

    if (this.useMock) {
      const destination = path.join(this.uploadDir, folder);
      if (!fs.existsSync(destination)) {
        fs.mkdirSync(destination, { recursive: true });
      }

      const filePath = path.join(destination, fileName);
      fs.writeFileSync(filePath, file.buffer);
      this.logger.log(
        `[MOCK STORAGE] Uploaded file ${file.originalname} locally to ${filePath}`,
      );
      return `/uploads/${folder}/${fileName}`;
    }

    return this.provider.put(file.buffer, folder, fileName, file.mimetype);
  }

  async uploadBase64(
    base64Str: string,
    folder: string,
    originalName: string,
  ): Promise<string> {
    if (!base64Str || !base64Str.startsWith('data:')) {
      return base64Str; // Return as-is if it's already a URL or invalid
    }

    try {
      const match = base64Str.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) {
        throw new Error('Invalid base64 format');
      }

      const mimetype = match[1];
      const buffer = Buffer.from(match[2], 'base64');

      // Construct a mock Express.Multer.File object
      const file: any = {
        buffer,
        originalname:
          originalName || `uploaded-file.${mimetype.split('/')[1] || 'png'}`,
        mimetype,
      };

      return this.uploadFile(file, folder);
    } catch (err) {
      this.logger.error(`Failed to upload base64: ${err.message}`);
      return '';
    }
  }

  // Best-effort, side-effect-free reachability check for /api/health — a
  // HEAD on the bucket itself (no object read/write), short-circuited to
  // "ok" in mock mode since there's no real cloud storage to check. Never
  // throws; callers treat a false result as "degraded," not as blocking
  // health.
  async checkHealth(): Promise<{
    ok: boolean;
    mode: 'mock' | 's3' | 'firebase';
    error?: string;
  }> {
    if (this.useMock) {
      return { ok: true, mode: 'mock' };
    }
    const mode = this.configService.get<string>('STORAGE_PROVIDER', 's3');
    const result = await this.provider.health();
    return { ...result, mode: mode === 'firebase' ? 'firebase' : 's3' };
  }

  async getFile(key: string): Promise<{ buffer: Buffer; contentType: string }> {
    if (this.useMock) {
      const filePath = path.join(this.uploadDir, key);
      if (!fs.existsSync(filePath)) {
        throw new Error('File not found');
      }
      const buffer = fs.readFileSync(filePath);
      const ext = path.extname(key).toLowerCase();
      let contentType = 'image/png';
      if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
      else if (ext === '.pdf') contentType = 'application/pdf';
      return { buffer, contentType };
    }

    return this.provider.get(key);
  }

  // Storage Migration Phase 1 (compatibility follow-up) — the admin
  // document-preview proxy's read path. Unlike every other method here,
  // this one is deliberately provider-aware by URL shape rather than by
  // the currently-active STORAGE_PROVIDER: during the migration window,
  // old records hold S3 URLs and new records hold Firebase URLs
  // regardless of which provider is "active" for writes right now, and an
  // admin needs to be able to preview either kind at any time. `getFile()`
  // above stays exactly as it was — single-provider, used by every other
  // caller — this is additive, not a replacement.
  async getFileByUrl(
    url: string,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    // Same path-traversal guard the controller used to apply itself before
    // this method existed — moved here since callers no longer see the
    // raw extracted key to sanitize on their own. Applied to the bare-key
    // and S3 branches, where the key is a substring of admin-supplied
    // input; not needed on the Firebase branch, where the key only ever
    // comes from a URL this app generated itself in put() (see
    // FirebaseStorageProvider's own resolveKey()).
    //
    // path.posix, not the OS-dependent path.normalize/path.join used
    // elsewhere in this file: object storage keys (S3, Firebase) are
    // always forward-slash strings regardless of what OS the server
    // process runs on. The original pre-migration code used the
    // OS-dependent form here too — harmless in production (Render is
    // Linux, where the two are identical) but a real bug waiting to
    // happen anywhere else, and one the new unit tests below caught
    // immediately on this Windows dev machine.
    const sanitize = (key: string) =>
      path.posix.normalize(key).replace(/^(\.\.\/)+/, '');

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      const key = url.startsWith('/uploads/')
        ? url.replace(/^\/uploads\//, '')
        : url;
      return this.getFile(sanitize(key));
    }

    const parsedUrl = new URL(url);
    if (parsedUrl.hostname.includes('.amazonaws.com')) {
      return this.s3Provider.get(sanitize(parsedUrl.pathname.substring(1)));
    }
    if (
      parsedUrl.hostname === 'firebasestorage.googleapis.com' ||
      parsedUrl.hostname.endsWith('.firebasestorage.app')
    ) {
      return this.firebaseProvider.get(url);
    }

    throw new Error(`Unrecognized storage URL: ${url}`);
  }
}
