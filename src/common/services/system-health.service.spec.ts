import { SystemHealthService } from './system-health.service';

// Storage Migration Phase 1 — covers the new storageProvider/storageError
// fields this service now adds to its response, and confirms the existing
// status/checks fields (consumed by both the public and admin health
// routes) are untouched.
describe('SystemHealthService', () => {
  const makeService = ({
    databaseOk,
    storageResult,
  }: {
    databaseOk: boolean;
    storageResult: {
      ok: boolean;
      mode: 'mock' | 's3' | 'firebase';
      error?: string;
    };
  }) => {
    const health = {
      check: jest
        .fn()
        .mockImplementation(() =>
          databaseOk
            ? Promise.resolve({})
            : Promise.reject(new Error('db down')),
        ),
    };
    const prismaHealth = { pingCheck: jest.fn() };
    const prismaService = {};
    const storageService = {
      checkHealth: jest.fn().mockResolvedValue(storageResult),
    };
    const notificationService = {
      getFcmStatus: jest
        .fn()
        .mockResolvedValue({ mode: 'mock', credentialSource: 'none' }),
    };
    const whatsappService = {
      getStatus: jest.fn().mockReturnValue({
        configured: false,
        phoneNumberIdSet: false,
        tokenSet: false,
      }),
    };

    return new SystemHealthService(
      health as any,
      prismaHealth as any,
      prismaService as any,
      storageService as any,
      notificationService as any,
      whatsappService as any,
    );
  };

  it('reports status "ok" and storageProvider "s3" when both database and storage are healthy', async () => {
    const service = makeService({
      databaseOk: true,
      storageResult: { ok: true, mode: 's3' },
    });
    const result = await service.check();

    expect(result.status).toBe('ok');
    expect(result.checks).toEqual({ database: 'ok', storage: 'ok' });
    expect(result.storageProvider).toBe('s3');
    expect(result.storageError).toBeUndefined();
  });

  it('reports storageProvider "firebase" and status "degraded" with the underlying error when Firebase storage is unreachable', async () => {
    const service = makeService({
      databaseOk: true,
      storageResult: {
        ok: false,
        mode: 'firebase',
        error: 'firebase-service-account.json not found',
      },
    });
    const result = await service.check();

    expect(result.status).toBe('degraded');
    expect(result.checks.storage).toBe('unreachable');
    expect(result.storageProvider).toBe('firebase');
    expect(result.storageError).toBe('firebase-service-account.json not found');
  });

  it('reports status "down" when the database check fails, regardless of storage', async () => {
    const service = makeService({
      databaseOk: false,
      storageResult: { ok: true, mode: 's3' },
    });
    const result = await service.check();

    expect(result.status).toBe('down');
    expect(result.checks.database).toBe('down');
  });

  it('omits storageError entirely (not even as undefined key noise) when storage is healthy', async () => {
    const service = makeService({
      databaseOk: true,
      storageResult: { ok: true, mode: 'mock' },
    });
    const result = await service.check();

    expect('storageError' in result).toBe(false);
  });

  it('surfaces the notifications block from NotificationService.getFcmStatus() unchanged', async () => {
    const service = makeService({
      databaseOk: true,
      storageResult: { ok: true, mode: 'firebase' },
    });
    const result = await service.check();

    expect(result.notifications).toEqual({
      mode: 'mock',
      credentialSource: 'none',
    });
  });

  it('surfaces the whatsapp block from WhatsappService.getStatus() unchanged', async () => {
    const service = makeService({
      databaseOk: true,
      storageResult: { ok: true, mode: 'firebase' },
    });
    const result = await service.check();

    expect(result.whatsapp).toEqual({
      configured: false,
      phoneNumberIdSet: false,
      tokenSet: false,
    });
  });
});
