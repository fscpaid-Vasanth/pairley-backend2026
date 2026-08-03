import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { initializeApp, getApps, cert } from 'firebase-admin/app';

// Launch-audit finding: POST /auth/google previously trusted the caller's
// own request body for `email` (and used it to look up / log in to any
// existing Customer or Business account) with no proof the caller actually
// owns that email — a complete account-takeover-by-email vulnerability.
// This service verifies the Firebase ID token the client SDK's real
// signInWithPopup/signInWithCredential flow already produces, so AuthService
// can trust the *token's* email claim instead of the request body's.
//
// Credential loading mirrors FirebaseStorageProvider.loadServiceAccount()
// exactly (same env var, same file fallback, same two encodings) — see that
// file's comment for why. Duplicated rather than shared: this codebase's
// existing convention (storage provider, FCM notification service) is for
// each Firebase-consuming service to load its own credential independently,
// not to share a single init helper.
@Injectable()
export class GoogleTokenVerifierService {
  private readonly logger = new Logger(GoogleTokenVerifierService.name);

  constructor(private readonly configService: ConfigService) {}

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
        'No Firebase credentials found — set FIREBASE_SERVICE_ACCOUNT_JSON or place firebase-service-account.json at the project root',
      );
    }
    return JSON.parse(fs.readFileSync(serviceAccountPath, 'utf-8'));
  }

  private ensureApp() {
    if (!getApps().length) {
      const serviceAccount = this.loadServiceAccount();
      initializeApp({ credential: cert(serviceAccount) });
    }
  }

  // Returns the verified email/uid from a genuine Firebase ID token, or
  // throws UnauthorizedException — never falls back to trusting caller-
  // supplied identity fields.
  async verifyIdToken(
    idToken: string,
  ): Promise<{ email: string; uid: string }> {
    if (!idToken || typeof idToken !== 'string') {
      throw new UnauthorizedException('Missing Google credential');
    }

    try {
      this.ensureApp();
      // Dynamic, not static — firebase-admin/auth transitively pulls in
      // jose's ESM-only "webapi" build (via jwks-rsa), which Jest/ts-jest
      // cannot parse. A static top-level import forces every spec file that
      // merely references this class for DI (e.g. auth.service.spec.ts) to
      // load that broken chain even though the real method is never called
      // there. Deferring the import to here means it's only ever touched by
      // an actual invocation, never by module load.
      const { getAuth } = await import('firebase-admin/auth');
      const decoded = await getAuth().verifyIdToken(idToken);
      if (!decoded.email) {
        throw new UnauthorizedException(
          'Google account has no verified email',
        );
      }
      return { email: decoded.email, uid: decoded.uid };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      this.logger.warn(`Google ID token verification failed: ${error.message}`);
      throw new UnauthorizedException('Invalid or expired Google credential');
    }
  }
}
