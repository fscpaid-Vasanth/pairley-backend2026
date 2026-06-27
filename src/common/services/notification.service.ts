import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly useMock: boolean;
  private readonly projectId: string;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService
  ) {
    const mockNotifVal = this.configService.get<any>('USE_MOCK_NOTIFICATIONS', true);
    this.useMock = mockNotifVal === true || mockNotifVal === 'true';
    
    this.projectId = this.configService.get<string>('FIREBASE_PROJECT_ID', '');
  }

  async sendNotification(
    userId: string,
    title: string,
    message: string,
    notificationType: string
  ): Promise<boolean> {
    try {
      // 1. Create DB entry for the user
      await this.prisma.notification.create({
        data: {
          user_id: userId,
          title,
          message,
          notification_type: notificationType,
        },
      });

      // 2. Query registered push tokens for the user
      const userTokens = await this.prisma.pushToken.findMany({
        where: { user_id: userId },
      });

      // 3. Write simulated push delivery log
      this._writeToPushLog(userId, title, message, notificationType, userTokens);

      // 4. Send Push Notification via Firebase Cloud Messaging
      if (this.useMock) {
        this.logger.log(`[MOCK FCM] Push notification sent to user ${userId}: "${title}" - ${message} (Tokens targeted: ${userTokens.length})`);
        return true;
      }

      // 5. Real FCM v1 HTTP API push
      await this._sendFcmPush(userId, title, message, notificationType, userTokens);
      return true;
    } catch (error) {
      this.logger.error(`Failed to send/store notification: ${error.message}`);
      return false;
    }
  }

  private _writeToPushLog(userId: string, title: string, message: string, notificationType: string, tokens: any[]) {
    try {
      const logDir = path.join(process.cwd(), 'scratch');
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      const logPath = path.join(logDir, 'push_delivery_log.json');
      let logs: any[] = [];
      if (fs.existsSync(logPath)) {
        try {
          logs = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
        } catch {}
      }
      logs.push({
        timestamp: new Date().toISOString(),
        userId,
        title,
        message,
        notificationType,
        targetsCount: tokens.length,
        targets: tokens.map(t => ({ token: t.token, platform: t.platform })),
      });
      fs.writeFileSync(logPath, JSON.stringify(logs, null, 2));
    } catch (err) {
      this.logger.warn(`Failed to write push log: ${err.message}`);
    }
  }

  private async _sendFcmPush(
    userId: string,
    title: string,
    body: string,
    notificationType: string,
    tokens: any[]
  ): Promise<void> {
    try {
      // Load Firebase service account credentials
      const serviceAccountPath = path.join(process.cwd(), 'firebase-service-account.json');
      if (!fs.existsSync(serviceAccountPath)) {
        this.logger.warn('[FCM] firebase-service-account.json not found. Skipping push.');
        return;
      }

      const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf-8'));

      // Get OAuth2 access token via Google auth
      const { GoogleAuth } = await import('google-auth-library');
      const auth = new GoogleAuth({
        credentials: serviceAccount,
        scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
      });

      const accessToken = await auth.getAccessToken();
      if (!accessToken) {
        this.logger.warn('[FCM] Could not get FCM access token.');
        return;
      }

      const fcmUrl = `https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`;

      // If user has specific tokens, send to them individually. Otherwise, fallback to topic.
      if (tokens.length > 0) {
        for (const t of tokens) {
          const payload = {
            message: {
              token: t.token,
              notification: { title, body },
              data: { userId, notificationType },
            },
          };

          const response = await fetch(fcmUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
          });

          if (!response.ok) {
            const err = await response.text();
            this.logger.error(`[FCM] Push token send failed: ${err}`);
          }
        }
        this.logger.log(`[FCM] Sent pushes to ${tokens.length} registered tokens for user ${userId}`);
      } else {
        // FCM HTTP v1 API — topic-based push (user ID as topic for simplicity)
        const payload = {
          message: {
            topic: `user_${userId}`,
            notification: { title, body },
            data: { userId, notificationType },
          },
        };

        const response = await fetch(fcmUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const err = await response.text();
          this.logger.error(`[FCM] Topic Push failed: ${err}`);
        } else {
          this.logger.log(`[FCM] Topic Push sent to user_${userId}: "${title}"`);
        }
      }
    } catch (err) {
      this.logger.error(`[FCM] Push exception: ${err.message}`);
    }
  }
}

