import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import * as fs from 'fs';
import * as path from 'path';
// Static import (not `await import(...)`) — same reasoning as
// firebase-storage.provider.ts: dynamic import() is untestable under this
// project's Jest/ts-jest setup ("A dynamic import callback was invoked
// without --experimental-vm-modules"), with no runtime behavior difference,
// since credential loading/GoogleAuth construction still only happen
// lazily in getFcmAuth(), on first real send.
import { GoogleAuth } from 'google-auth-library';

// FCM error statuses/codes that mean the token itself is dead (uninstalled
// app, expired registration, wrong sender) — permanent, never worth
// retrying. Anything else caught by TRANSIENT_STATUSES is a transport-level
// hiccup (FCM overloaded, our own network blip) and gets a short bounded
// retry instead.
const PERMANENT_TOKEN_STATUSES = new Set([
  'UNREGISTERED',
  'NOT_FOUND',
  'INVALID_ARGUMENT',
  'SENDER_ID_MISMATCH',
]);
const TRANSIENT_STATUSES = new Set([
  'UNAVAILABLE',
  'INTERNAL',
  'RESOURCE_EXHAUSTED',
  'QUOTA_EXCEEDED',
]);
const MAX_SEND_ATTEMPTS = 3; // 1 initial + 2 retries
const RETRY_BACKOFF_MS = 300; // linear: 300ms, 600ms

export interface FcmStatus {
  mode: 'mock' | 'live';
  credentialSource: 'env' | 'file' | 'none';
  projectId?: string;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly useMock: boolean;
  private cachedAuth: { auth: any; projectId: string } | null = null;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    const mockNotifVal = this.configService.get<any>(
      'USE_MOCK_NOTIFICATIONS',
      true,
    );
    this.useMock = mockNotifVal === true || mockNotifVal === 'true';
  }

  async sendNotification(
    userId: string,
    title: string,
    message: string,
    notificationType: string,
    // Optional deep-link target (e.g. an offer_id) — additive/trailing so
    // every existing call site is unaffected. Added for the Anonymous
    // Group Chat's "someone joined" notification, but generic to any
    // future notification type that needs one.
    relatedId?: string,
  ): Promise<boolean> {
    try {
      // 1. Create DB entry for the user — this is the durable record of
      // "was this user notified" and must succeed independently of
      // whether the push transport below works.
      await this.prisma.notification.create({
        data: {
          user_id: userId,
          title,
          message,
          notification_type: notificationType,
          related_id: relatedId ?? null,
        },
      });
    } catch (error) {
      this.logger.error(`Failed to store notification: ${error.message}`);
      return false;
    }

    // 2. Query registered push tokens for the user
    const userTokens = await this.prisma.pushToken
      .findMany({ where: { user_id: userId } })
      .catch((error) => {
        this.logger.error(
          `[FCM] Failed to load push tokens for user ${userId}: ${error.message}`,
        );
        return [] as any[];
      });

    // 3. Send Push Notification via Firebase Cloud Messaging — deliberately
    // isolated from the return value below. A push/credential failure must
    // never mask the fact that the Notification row above was already
    // committed.
    if (this.useMock) {
      this.logger.log(
        `[MOCK FCM] Push notification sent to user ${userId}: "${title}" - ${message} (Tokens targeted: ${userTokens.length})`,
      );
    } else {
      await this._sendFcmPush(
        userId,
        title,
        message,
        notificationType,
        userTokens,
      ).catch((err) => {
        this.logger.error(`[FCM] Push exception: ${err.message}`);
      });
    }
    return true;
  }

  // Side-effect-free — reports what a real send would use without sending
  // anything, for GET /admin/system-health (see SystemHealthService).
  async getFcmStatus(): Promise<FcmStatus> {
    if (this.useMock) {
      return { mode: 'mock', credentialSource: this.credentialSource() };
    }
    const fcmAuth = await this.getFcmAuth();
    return {
      mode: 'live',
      credentialSource: this.credentialSource(),
      ...(fcmAuth ? { projectId: fcmAuth.projectId } : {}),
    };
  }

  private credentialSource(): 'env' | 'file' | 'none' {
    if (this.configService.get<string>('FIREBASE_SERVICE_ACCOUNT_JSON', '')) {
      return 'env';
    }
    if (
      fs.existsSync(path.join(process.cwd(), 'firebase-service-account.json'))
    ) {
      return 'file';
    }
    return 'none';
  }

  // Two supported ways to provide credentials, checked in this order —
  // mirrors firebase-storage.provider.ts's loadServiceAccount() exactly,
  // so Storage and FCM never diverge on how they authenticate to the same
  // Firebase project:
  //  1. FIREBASE_SERVICE_ACCOUNT_JSON env var — raw JSON or base64-encoded.
  //  2. firebase-service-account.json file at the project root.
  // Unlike the storage provider, this returns null (not throw) on failure —
  // a missing/invalid FCM credential must never break sendNotification's
  // DB-write responsibility, which every caller relies on via .catch(()=>{}).
  private loadServiceAccount(): Record<string, unknown> | null {
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
          this.logger.error(
            '[FCM] FIREBASE_SERVICE_ACCOUNT_JSON is set but is neither valid JSON nor valid base64-encoded JSON',
          );
          return null;
        }
      }
    }

    const serviceAccountPath = path.join(
      process.cwd(),
      'firebase-service-account.json',
    );
    if (!fs.existsSync(serviceAccountPath)) {
      this.logger.warn(
        '[FCM] No Firebase credentials found (FIREBASE_SERVICE_ACCOUNT_JSON unset, no local firebase-service-account.json) — push disabled.',
      );
      return null;
    }
    return JSON.parse(fs.readFileSync(serviceAccountPath, 'utf-8'));
  }

  // Lazy + cached, mirrors ensureBucket()'s pattern in
  // firebase-storage.provider.ts. Derives the FCM project ID from the
  // credential's own project_id field rather than a separately-configured
  // FIREBASE_PROJECT_ID env var — that var has drifted stale before (it
  // pointed at a different Firebase project than the one Storage actually
  // uses) and this eliminates that entire class of mismatch.
  private async getFcmAuth(): Promise<{
    auth: GoogleAuth;
    projectId: string;
  } | null> {
    if (this.cachedAuth) return this.cachedAuth;

    const serviceAccount = this.loadServiceAccount();
    if (!serviceAccount) return null;

    const projectId = (serviceAccount as any).project_id;
    if (!projectId) {
      this.logger.error('[FCM] Loaded service account has no project_id field.');
      return null;
    }

    const auth = new GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
    });

    this.cachedAuth = { auth, projectId };
    return this.cachedAuth;
  }

  private async _sendFcmPush(
    userId: string,
    title: string,
    body: string,
    notificationType: string,
    tokens: any[],
  ): Promise<void> {
    const fcmAuth = await this.getFcmAuth();
    if (!fcmAuth) return; // already logged by loadServiceAccount/getFcmAuth

    let accessToken: string | null | undefined;
    try {
      accessToken = await fcmAuth.auth.getAccessToken();
    } catch (err) {
      this.logger.error(`[FCM] Failed to obtain access token: ${err.message}`);
      return;
    }
    if (!accessToken) {
      this.logger.warn('[FCM] Could not get FCM access token.');
      return;
    }

    const fcmUrl = `https://fcm.googleapis.com/v1/projects/${fcmAuth.projectId}/messages:send`;

    this.logger.log(
      `[FCM] dispatch userId=${userId} type=${notificationType} tokenCount=${tokens.length}`,
    );

    if (tokens.length > 0) {
      // Independent per-token sends via allSettled — one bad or slow token
      // never blocks delivery to the others.
      await Promise.allSettled(
        tokens.map((t) =>
          this.sendToToken(
            fcmUrl,
            accessToken as string,
            t,
            title,
            body,
            userId,
            notificationType,
          ),
        ),
      );
      return;
    }

    // No registered tokens for this user — fall back to a per-user topic.
    // Kept only for parity with prior behavior; nothing subscribes
    // client-side to per-user topics today, so this commonly no-ops.
    await this.sendToTarget(
      fcmUrl,
      accessToken as string,
      { topic: `user_${userId}` },
      title,
      body,
      userId,
      notificationType,
      `topic user_${userId}`,
    );
  }

  private async sendToToken(
    fcmUrl: string,
    accessToken: string,
    tokenRow: any,
    title: string,
    body: string,
    userId: string,
    notificationType: string,
  ): Promise<void> {
    const permanentlyFailed = await this.sendToTarget(
      fcmUrl,
      accessToken,
      { token: tokenRow.token },
      title,
      body,
      userId,
      notificationType,
      `token ${tokenRow.id} (platform=${tokenRow.platform})`,
    );
    if (permanentlyFailed) {
      await this.prisma.pushToken
        .delete({ where: { id: tokenRow.id } })
        .catch(() => {});
      this.logger.warn(
        `[FCM] Removed dead push token ${tokenRow.id} for user ${userId}`,
      );
    }
  }

  // Sends one FCM message with a short bounded retry on transient errors
  // (FCM v1's error.status: UNAVAILABLE/INTERNAL/RESOURCE_EXHAUSTED/
  // QUOTA_EXCEEDED). Returns true only when the target failed for a
  // permanent, token-specific reason (UNREGISTERED/NOT_FOUND/
  // INVALID_ARGUMENT/SENDER_ID_MISMATCH) — the caller uses that to decide
  // whether to delete the underlying PushToken row. No queue, no persisted
  // retry state — everything happens synchronously within this call.
  private async sendToTarget(
    fcmUrl: string,
    accessToken: string,
    target: { token: string } | { topic: string },
    title: string,
    body: string,
    userId: string,
    notificationType: string,
    logLabel: string,
  ): Promise<boolean> {
    const payload = {
      message: {
        ...target,
        notification: { title, body },
        data: { userId, notificationType },
      },
    };

    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await fetch(fcmUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
      } catch (err: any) {
        this.logger.error(
          `[FCM] send failed target=${logLabel} attempt=${attempt}/${MAX_SEND_ATTEMPTS} networkError=${err.message}`,
        );
        if (attempt === MAX_SEND_ATTEMPTS) return false;
        await this.delay(RETRY_BACKOFF_MS * attempt);
        continue;
      }

      if (response.ok) {
        this.logger.log(
          `[FCM] delivered target=${logLabel} type=${notificationType} attempt=${attempt}`,
        );
        return false;
      }

      const errBody: any = await response.json().catch(() => ({}));
      const status = errBody?.error?.status;
      const errorCode = errBody?.error?.details?.find(
        (d: any) => d?.errorCode,
      )?.errorCode;
      this.logger.error(
        `[FCM] send failed target=${logLabel} attempt=${attempt}/${MAX_SEND_ATTEMPTS} httpStatus=${response.status} status=${status} errorCode=${errorCode} message=${errBody?.error?.message}`,
      );

      if (
        PERMANENT_TOKEN_STATUSES.has(status) ||
        PERMANENT_TOKEN_STATUSES.has(errorCode)
      ) {
        return true;
      }
      if (!TRANSIENT_STATUSES.has(status) || attempt === MAX_SEND_ATTEMPTS) {
        return false;
      }
      await this.delay(RETRY_BACKOFF_MS * attempt);
    }
    return false;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
