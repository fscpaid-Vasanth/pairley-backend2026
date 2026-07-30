import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { CloudStorageProvider } from './cloud-storage-provider.interface';

// Storage Migration Phase 1 — Firebase Storage implementation of the same
// CloudStorageProvider seam S3StorageProvider fills. Reuses the exact
// credential file/pattern notification.service.ts already established for
// FCM (firebase-service-account.json at the project root, read lazily —
// see that file's "Load Firebase service account credentials" comment) so
// this doesn't introduce a second, different way of authenticating to the
// same Firebase project.
//
// URL shape: real Firebase Storage HTTPS download URLs
// (https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<key>?alt=media&
// token=<uuid>), not gs:// URIs — this is what lets a future "public tier"
// phase make an object fetchable by a plain <img src> purely by changing
// Storage Rules, with no code change here. Whether that URL actually
// resolves for an anonymous request is entirely up to Storage Rules, which
// Phase 1 intentionally leaves private-by-default (parity with today's
// private S3 bucket) — no business-module changes, no public/private split
// yet. See the Phase 1 completion report for why that split is deferred.
//
// Static imports (not `await import(...)`): same reasoning as
// S3StorageProvider — untestable under this project's `module: "nodenext"`
// Jest setup otherwise, with no runtime behavior difference (credential
// loading and app initialization still only happen lazily, in
// ensureBucket(), on first actual use — see below). Uses the modern
// modular firebase-admin API (`firebase-admin/app`, `firebase-admin/
// storage`) rather than the old `admin.credential.cert`/`admin.storage()`
// namespace style — the installed firebase-admin version's top-level
// package only exports the modular functions.
export class FirebaseStorageProvider implements CloudStorageProvider {
  private readonly logger = new Logger(FirebaseStorageProvider.name);
  private readonly bucketName: string;
  private readonly configService: ConfigService;
  private bucket: any = null;

  constructor(configService: ConfigService) {
    this.configService = configService;
    this.bucketName = configService.get<string>('FIREBASE_STORAGE_BUCKET', '');
  }

  // Two supported ways to provide credentials, checked in this order:
  //  1. FIREBASE_SERVICE_ACCOUNT_JSON env var — the whole service account
  //     JSON, either as a raw string or base64-encoded (base64 avoids the
  //     private_key field's embedded newlines tripping up .env parsers,
  //     which is the more common failure mode for env-var-based secrets).
  //  2. firebase-service-account.json file at the project root — same
  //     convention notification.service.ts already established for FCM.
  // Neither is ever committed (.gitignore covers the file; the env var
  // lives in .env, already gitignored). Local-only by design — this
  // provider never has network/CLI access to a secrets manager to fall
  // back to.
  private loadServiceAccount(): Record<string, unknown> {
    const fromEnv = this.configService.get<string>(
      'FIREBASE_SERVICE_ACCOUNT_JSON',
      '',
    );
    if (fromEnv) {
      try {
        return JSON.parse(fromEnv);
      } catch {
        try {
          return JSON.parse(Buffer.from(fromEnv, 'base64').toString('utf-8'));
        } catch {
          throw new Error(
            'FIREBASE_SERVICE_ACCOUNT_JSON is set but is neither valid JSON nor valid base64-encoded JSON',
          );
        }
      }
    }

    const serviceAccountPath = path.join(
      process.cwd(),
      'firebase-service-account.json',
    );
    if (!fs.existsSync(serviceAccountPath)) {
      throw new Error(
        'No Firebase credentials found — set FIREBASE_SERVICE_ACCOUNT_JSON or place firebase-service-account.json at the project root (required when STORAGE_PROVIDER=firebase)',
      );
    }
    return JSON.parse(fs.readFileSync(serviceAccountPath, 'utf-8'));
  }

  // Lazy on purpose — a misconfigured/missing credential only surfaces as
  // an error on an actual upload/read/health call, never as an app-boot
  // crash. Safe even when STORAGE_PROVIDER=firebase is set in an
  // environment that isn't ready for it yet.
  private ensureBucket() {
    if (this.bucket) return this.bucket;

    if (!getApps().length) {
      const serviceAccount = this.loadServiceAccount();
      initializeApp({
        credential: cert(serviceAccount),
        storageBucket: this.bucketName,
      });
    }

    this.bucket = getStorage().bucket(this.bucketName || undefined);
    return this.bucket;
  }

  // Extracts the object key from either a raw "folder/fileName" (what this
  // provider's own put() produces internally) or a full Firebase download
  // URL — defensive, since a future phase may pass a stored URL back in.
  private resolveKey(key: string): string {
    const marker = '/o/';
    const idx = key.indexOf(marker);
    if (idx === -1) return key;
    const afterMarker = key.slice(idx + marker.length);
    const withoutQuery = afterMarker.split('?')[0];
    return decodeURIComponent(withoutQuery);
  }

  async put(
    buffer: Buffer,
    folder: string,
    fileName: string,
    contentType: string,
  ): Promise<string> {
    try {
      const bucket = this.ensureBucket();
      const key = `${folder}/${fileName}`;
      const token = randomUUID();

      await bucket.file(key).save(buffer, {
        resumable: false,
        metadata: {
          contentType,
          metadata: { firebaseStorageDownloadTokens: token },
        },
      });

      const url = `https://firebasestorage.googleapis.com/v0/b/${this.bucketName}/o/${encodeURIComponent(key)}?alt=media&token=${token}`;
      this.logger.log(`[Firebase Storage] Uploaded file to: ${url}`);
      return url;
    } catch (error) {
      this.logger.error(
        `Failed to upload to Firebase Storage: ${error.message}`,
      );
      throw new Error(`Firebase Storage upload failed: ${error.message}`);
    }
  }

  async get(key: string): Promise<{ buffer: Buffer; contentType: string }> {
    try {
      const bucket = this.ensureBucket();
      const resolvedKey = this.resolveKey(key);
      const file = bucket.file(resolvedKey);

      const [buffer, [metadata]] = await Promise.all([
        file.download().then((r: [Buffer]) => r[0]),
        file.getMetadata(),
      ]);

      return {
        buffer,
        contentType: metadata.contentType || 'image/png',
      };
    } catch (error) {
      this.logger.error(
        `Failed to get file from Firebase Storage: ${error.message}`,
      );
      throw new Error(`Firebase Storage fetch failed: ${error.message}`);
    }
  }

  async health(): Promise<{ ok: boolean; error?: string }> {
    try {
      const bucket = this.ensureBucket();
      const [exists] = await bucket.exists();
      if (!exists) {
        return { ok: false, error: `Bucket ${this.bucketName} does not exist` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
}
