import { ConfigService } from '@nestjs/config';

const mockGetAccessToken = jest.fn().mockResolvedValue('mock-access-token');
const mockGoogleAuth = jest.fn().mockImplementation(() => ({
  getAccessToken: mockGetAccessToken,
}));
jest.mock('google-auth-library', () => ({
  GoogleAuth: mockGoogleAuth,
}));

import { NotificationService } from './notification.service';

const SERVICE_ACCOUNT = {
  project_id: 'pairley2026-4706e',
  client_email: 'fcm@pairley2026-4706e.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nmock\n-----END PRIVATE KEY-----',
};

// FCM v1 error-response shape: { error: { status, message, details: [{ '@type': ..., errorCode }] } }
const fcmError = (status: string, errorCode?: string) => ({
  ok: false,
  status: 400,
  json: async () => ({
    error: {
      status,
      message: `mock ${status}`,
      details: errorCode ? [{ errorCode }] : [],
    },
  }),
});
const fcmOk = () => ({ ok: true, status: 200, json: async () => ({}) });

describe('NotificationService', () => {
  let notificationCreate: jest.Mock;
  let pushTokenFindMany: jest.Mock;
  let pushTokenDelete: jest.Mock;
  let prisma: {
    notification: { create: jest.Mock };
    pushToken: { findMany: jest.Mock; delete: jest.Mock };
  };
  let fetchMock: jest.Mock;

  const makeConfig = (overrides: Record<string, any> = {}) =>
    ({
      get: jest.fn((key: string, def?: any) => {
        const values: Record<string, any> = {
          USE_MOCK_NOTIFICATIONS: false,
          ...overrides,
        };
        return key in values ? values[key] : def;
      }),
    }) as unknown as ConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccessToken.mockResolvedValue('mock-access-token');

    notificationCreate = jest.fn().mockResolvedValue({ id: 'notif-1' });
    pushTokenFindMany = jest.fn().mockResolvedValue([]);
    pushTokenDelete = jest.fn().mockResolvedValue({});
    prisma = {
      notification: { create: notificationCreate },
      pushToken: { findMany: pushTokenFindMany, delete: pushTokenDelete },
    };

    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  describe('sendNotification — DB write vs push isolation', () => {
    it('creates a Notification row and returns true when mock mode is on, without ever calling fetch', async () => {
      const service = new NotificationService(
        makeConfig({ USE_MOCK_NOTIFICATIONS: true }),
        prisma as any,
      );
      const result = await service.sendNotification(
        'user-1',
        'Title',
        'Body',
        'NEW_LEAD',
      );

      expect(result).toBe(true);
      expect(notificationCreate).toHaveBeenCalledWith({
        data: {
          user_id: 'user-1',
          title: 'Title',
          message: 'Body',
          notification_type: 'NEW_LEAD',
          related_id: null, // no relatedId passed — defaults to null
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('persists an optional relatedId for deep-linking (e.g. Anonymous Group Chat notifications)', async () => {
      const service = new NotificationService(
        makeConfig({ USE_MOCK_NOTIFICATIONS: true }),
        prisma as any,
      );
      await service.sendNotification(
        'user-1',
        'Someone joined your group chat',
        'A new member just joined.',
        'GROUP_MEMBER_JOINED',
        'offer-42',
      );

      expect(notificationCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ related_id: 'offer-42' }),
      });
    });

    it('returns false and never calls fetch when the DB write itself fails', async () => {
      notificationCreate.mockRejectedValue(new Error('db down'));
      const service = new NotificationService(makeConfig(), prisma as any);

      const result = await service.sendNotification(
        'user-1',
        'Title',
        'Body',
        'NEW_LEAD',
      );

      expect(result).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('still returns true when no FCM credential is configured — a push failure must never mask the notification record', async () => {
      const service = new NotificationService(
        makeConfig({ FIREBASE_SERVICE_ACCOUNT_JSON: '' }),
        prisma as any,
      );
      // No local firebase-service-account.json exists in this test's cwd,
      // and the env var is empty — loadServiceAccount() returns null.
      const result = await service.sendNotification(
        'user-1',
        'Title',
        'Body',
        'NEW_LEAD',
      );

      expect(result).toBe(true);
      expect(notificationCreate).toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('_sendFcmPush — credential + project ID derivation', () => {
    it('reads the credential from FIREBASE_SERVICE_ACCOUNT_JSON and derives the FCM project ID from it, ignoring a stale FIREBASE_PROJECT_ID', async () => {
      pushTokenFindMany.mockResolvedValue([
        { id: 'pt-1', token: 'device-token-1', platform: 'web' },
      ]);
      fetchMock.mockResolvedValue(fcmOk());

      const service = new NotificationService(
        makeConfig({
          FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(SERVICE_ACCOUNT),
          FIREBASE_PROJECT_ID: 'stale-wrong-project',
        }),
        prisma as any,
      );
      await service.sendNotification('user-1', 'Title', 'Body', 'NEW_LEAD');

      expect(fetchMock).toHaveBeenCalledWith(
        `https://fcm.googleapis.com/v1/projects/${SERVICE_ACCOUNT.project_id}/messages:send`,
        expect.any(Object),
      );
    });

    it('accepts a base64-encoded FIREBASE_SERVICE_ACCOUNT_JSON', async () => {
      pushTokenFindMany.mockResolvedValue([
        { id: 'pt-1', token: 'device-token-1', platform: 'web' },
      ]);
      fetchMock.mockResolvedValue(fcmOk());

      const base64Creds = Buffer.from(
        JSON.stringify(SERVICE_ACCOUNT),
      ).toString('base64');
      const service = new NotificationService(
        makeConfig({ FIREBASE_SERVICE_ACCOUNT_JSON: base64Creds }),
        prisma as any,
      );
      await service.sendNotification('user-1', 'Title', 'Body', 'NEW_LEAD');

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('_sendFcmPush — retry + dead-token cleanup', () => {
    const configWithCreds = () =>
      makeConfig({ FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(SERVICE_ACCOUNT) });

    it('delivers on the first attempt without retrying', async () => {
      pushTokenFindMany.mockResolvedValue([
        { id: 'pt-1', token: 'good-token', platform: 'android' },
      ]);
      fetchMock.mockResolvedValue(fcmOk());

      const service = new NotificationService(configWithCreds(), prisma as any);
      await service.sendNotification('user-1', 'Title', 'Body', 'NEW_LEAD');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(pushTokenDelete).not.toHaveBeenCalled();
    });

    it('retries a transient UNAVAILABLE error and succeeds on the 3rd attempt', async () => {
      pushTokenFindMany.mockResolvedValue([
        { id: 'pt-1', token: 'flaky-token', platform: 'ios' },
      ]);
      fetchMock
        .mockResolvedValueOnce(fcmError('UNAVAILABLE'))
        .mockResolvedValueOnce(fcmError('UNAVAILABLE'))
        .mockResolvedValueOnce(fcmOk());

      const service = new NotificationService(configWithCreds(), prisma as any);
      await service.sendNotification('user-1', 'Title', 'Body', 'NEW_LEAD');

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(pushTokenDelete).not.toHaveBeenCalled();
    });

    it('gives up after exhausting retries on a persistent transient error, without deleting the token', async () => {
      pushTokenFindMany.mockResolvedValue([
        { id: 'pt-1', token: 'always-unavailable', platform: 'ios' },
      ]);
      fetchMock.mockResolvedValue(fcmError('UNAVAILABLE'));

      const service = new NotificationService(configWithCreds(), prisma as any);
      await service.sendNotification('user-1', 'Title', 'Body', 'NEW_LEAD');

      expect(fetchMock).toHaveBeenCalledTimes(3); // 1 initial + 2 retries, then give up
      expect(pushTokenDelete).not.toHaveBeenCalled();
    });

    it('deletes the PushToken row on a permanent UNREGISTERED error, without retrying', async () => {
      pushTokenFindMany.mockResolvedValue([
        { id: 'pt-dead', token: 'uninstalled-app-token', platform: 'android' },
      ]);
      fetchMock.mockResolvedValue(fcmError('UNREGISTERED'));

      const service = new NotificationService(configWithCreds(), prisma as any);
      await service.sendNotification('user-1', 'Title', 'Body', 'NEW_LEAD');

      expect(fetchMock).toHaveBeenCalledTimes(1); // permanent — no retry
      expect(pushTokenDelete).toHaveBeenCalledWith({ where: { id: 'pt-dead' } });
    });

    it('sends independently to multiple tokens — one dead token does not block delivery to a good one', async () => {
      pushTokenFindMany.mockResolvedValue([
        { id: 'pt-dead', token: 'dead-token', platform: 'android' },
        { id: 'pt-good', token: 'good-token', platform: 'web' },
      ]);
      fetchMock.mockImplementation((_url: string, opts: any) => {
        const body = JSON.parse(opts.body);
        if (body.message.token === 'dead-token') {
          return Promise.resolve(fcmError('UNREGISTERED'));
        }
        return Promise.resolve(fcmOk());
      });

      const service = new NotificationService(configWithCreds(), prisma as any);
      await service.sendNotification('user-1', 'Title', 'Body', 'NEW_LEAD');

      expect(pushTokenDelete).toHaveBeenCalledWith({ where: { id: 'pt-dead' } });
      expect(pushTokenDelete).toHaveBeenCalledTimes(1); // the good token stays
    });
  });

  describe('getFcmStatus', () => {
    it('reports mock mode without touching credentials', async () => {
      const service = new NotificationService(
        makeConfig({ USE_MOCK_NOTIFICATIONS: true }),
        prisma as any,
      );
      const status = await service.getFcmStatus();
      expect(status).toEqual({ mode: 'mock', credentialSource: 'none' });
    });

    it('reports live mode, credentialSource "env", and the derived project ID when a credential is configured', async () => {
      const service = new NotificationService(
        makeConfig({ FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(SERVICE_ACCOUNT) }),
        prisma as any,
      );
      const status = await service.getFcmStatus();
      expect(status).toEqual({
        mode: 'live',
        credentialSource: 'env',
        projectId: SERVICE_ACCOUNT.project_id,
      });
    });

    it('reports credentialSource "none" and no projectId when live mode has no credential at all', async () => {
      const service = new NotificationService(
        makeConfig({ FIREBASE_SERVICE_ACCOUNT_JSON: '' }),
        prisma as any,
      );
      const status = await service.getFcmStatus();
      expect(status).toEqual({ mode: 'live', credentialSource: 'none' });
    });
  });
});
