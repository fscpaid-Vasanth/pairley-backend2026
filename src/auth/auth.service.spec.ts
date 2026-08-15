import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { CategoryService } from '../common/taxonomy/category.service';
import { PrismaService } from '../prisma/prisma.service';
import { OtpService } from '../common/services/otp.service';
import { StorageService } from '../common/services/storage.service';
import { NotificationService } from '../common/services/notification.service';
import { GoogleTokenVerifierService } from './google-token-verifier.service';

// GoogleTokenVerifierService is always provided as a jest mock below (its
// real implementation is never instantiated in this file), but auth.service
// ts still statically imports it for DI metadata, which would otherwise pull
// in the real firebase-admin/auth module — and transitively jose's
// ESM-only webapi build, which Jest/ts-jest cannot parse. Same convention
// firebase-storage.provider.spec.ts already uses for firebase-admin/app
// and firebase-admin/storage.
jest.mock('firebase-admin/app', () => ({
  initializeApp: jest.fn(),
  getApps: jest.fn().mockReturnValue([]),
  cert: jest.fn(),
}));
jest.mock('firebase-admin/auth', () => ({
  getAuth: jest.fn(),
}));

/**
 * Regression coverage for the OTP verification security fix: no code should
 * verify successfully unless it matches a real, unexpired OtpVerification
 * record. Guards specifically against the previously-removed hardcoded
 * '123456'/'1234' bypass ever being reintroduced.
 */
describe('AuthService.verifyOtp', () => {
  let service: AuthService;
  let prisma: {
    otpVerification: {
      findFirst: jest.Mock;
      deleteMany: jest.Mock;
      update: jest.Mock;
    };
    customer: { findUnique: jest.Mock };
    business: { findUnique: jest.Mock };
  };

  const makeConfig = (values: Record<string, any> = {}) =>
    ({
      get: jest.fn((key: string, def?: any) =>
        key in values ? values[key] : def,
      ),
    }) as unknown as ConfigService;

  const buildService = async (configValues: Record<string, any> = {}) => {
    prisma = {
      otpVerification: {
        findFirst: jest.fn(),
        deleteMany: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      customer: { findUnique: jest.fn().mockResolvedValue(null) },
      business: { findUnique: jest.fn().mockResolvedValue(null) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: JwtService,
          useValue: { sign: jest.fn().mockReturnValue('signed-jwt') },
        },
        {
          provide: OtpService,
          useValue: {
            generateOtp: jest.fn(),
            sendOtp: jest.fn(),
            useMock: true,
          },
        },
        { provide: StorageService, useValue: {} },
        {
          provide: NotificationService,
          useValue: { sendNotification: jest.fn() },
        },
        { provide: ConfigService, useValue: makeConfig(configValues) },
        // Real instance — CategoryService is pure, dependency-free and
        // covered by its own spec, so the genuine normalisation runs here.
        CategoryService,
        // Not exercised by this describe block's tests (none call
        // googleUpsert) — present only because AuthService now requires it.
        {
          provide: GoogleTokenVerifierService,
          useValue: { verifyIdToken: jest.fn() },
        },
      ],
    }).compile();

    return module.get(AuthService);
  };

  beforeEach(async () => {
    // Default config (no MERCHANT_OTP_MODE set) — every existing test in
    // this file exercises the real-OTP path, unaffected by the pilot flag.
    service = await buildService();
  });

  it('rejects a code with no matching OtpVerification record', async () => {
    prisma.otpVerification.findFirst.mockResolvedValue(null);
    await expect(service.verifyOtp('9999999999', '111111')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects the legacy hardcoded bypass codes when they do not match a stored record', async () => {
    prisma.otpVerification.findFirst.mockResolvedValue(null);
    await expect(service.verifyOtp('9999999999', '123456')).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.verifyOtp('9999999999', '1234')).rejects.toThrow(
      BadRequestException,
    );
  });

  // '1234' is now a plain member of the real 4-digit OTP space (same shape
  // as any other code) — it must succeed or fail purely on whether it
  // matches the record actually issued for this request, never as a special
  // case in either direction.
  it('"1234" is rejected like any other wrong guess when it is not the stored code', async () => {
    prisma.otpVerification.findFirst.mockImplementation(({ where }) =>
      Promise.resolve(
        'code' in where
          ? null
          : {
              id: 'otp-1',
              mobile: '9999999999',
              code: '5093',
              attempts: 0,
              expires_at: new Date(Date.now() + 60_000),
              created_at: new Date(),
            },
      ),
    );
    await expect(service.verifyOtp('9999999999', '1234')).rejects.toThrow(
      'Invalid OTP code',
    );
  });

  it('"1234" succeeds when it genuinely is the code that was generated and stored for this request', async () => {
    prisma.otpVerification.findFirst.mockResolvedValue({
      id: 'otp-1',
      mobile: '9999999999',
      code: '1234',
      attempts: 0,
      expires_at: new Date(Date.now() + 60_000),
      created_at: new Date(),
    });

    const result = await service.verifyOtp('9999999999', '1234');

    expect(result.exists).toBe(false);
    expect(prisma.otpVerification.deleteMany).toHaveBeenCalledWith({
      where: { mobile: '9999999999' },
    });
  });

  it('rejects an expired OTP record even if the code matches', async () => {
    prisma.otpVerification.findFirst.mockResolvedValue({
      id: 'otp-1',
      mobile: '9999999999',
      code: '482913',
      attempts: 0,
      expires_at: new Date(Date.now() - 60_000),
      created_at: new Date(),
    });
    await expect(service.verifyOtp('9999999999', '482913')).rejects.toThrow(
      'OTP code has expired',
    );
  });

  it('accepts a real, unexpired OTP record and consumes it', async () => {
    prisma.otpVerification.findFirst.mockResolvedValue({
      id: 'otp-1',
      mobile: '9999999999',
      code: '482913',
      attempts: 0,
      expires_at: new Date(Date.now() + 60_000),
      created_at: new Date(),
    });

    const result = await service.verifyOtp('9999999999', '482913');

    expect(result.exists).toBe(false);
    expect(prisma.otpVerification.deleteMany).toHaveBeenCalledWith({
      where: { mobile: '9999999999' },
    });
  });

  // Brute-force lockout — this is the actual security fix. Previously this
  // endpoint had no attempt limiting at all: a 6-digit OTP (1,000,000
  // combinations) could be guessed without any backend resistance.
  describe('brute-force lockout', () => {
    it('increments the attempt counter on a wrong code', async () => {
      // The real query differs by call: verifyOtp first looks up the
      // latest OTP by {mobile} alone (to check the lockout), then
      // separately by {mobile, code} (to check the guess itself). A plain
      // mockResolvedValue can't distinguish the two, so this simulates the
      // real DB's behaviour — a wrong code genuinely finds no row.
      const latestOtp = {
        id: 'otp-1',
        mobile: '9999999999',
        code: '482913',
        attempts: 2,
        expires_at: new Date(Date.now() + 60_000),
        created_at: new Date(),
      };
      prisma.otpVerification.findFirst.mockImplementation(({ where }) =>
        Promise.resolve('code' in where ? null : latestOtp),
      );

      await expect(
        service.verifyOtp('9999999999', '000000'),
      ).rejects.toThrow('Invalid OTP code');

      expect(prisma.otpVerification.update).toHaveBeenCalledWith({
        where: { id: 'otp-1' },
        data: { attempts: { increment: 1 } },
      });
    });

    it('increments the attempt counter on an expired-but-correct code too', async () => {
      prisma.otpVerification.findFirst.mockResolvedValue({
        id: 'otp-1',
        mobile: '9999999999',
        code: '482913',
        attempts: 1,
        expires_at: new Date(Date.now() - 60_000),
        created_at: new Date(),
      });

      await expect(
        service.verifyOtp('9999999999', '482913'),
      ).rejects.toThrow('OTP code has expired');

      expect(prisma.otpVerification.update).toHaveBeenCalledWith({
        where: { id: 'otp-1' },
        data: { attempts: { increment: 1 } },
      });
    });

    it('locks out once MAX_OTP_ATTEMPTS is reached, before even checking the code', async () => {
      prisma.otpVerification.findFirst.mockResolvedValue({
        id: 'otp-1',
        mobile: '9999999999',
        code: '482913',
        attempts: 5,
        expires_at: new Date(Date.now() + 60_000),
        created_at: new Date(),
      });

      // The correct code, submitted after the 5th failure — must still be
      // rejected, and rejected for a different, clearer reason than "wrong
      // code", so the caller knows a fresh OTP is required.
      await expect(
        service.verifyOtp('9999999999', '482913'),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.verifyOtp('9999999999', '482913'),
      ).rejects.toThrow('Too many failed attempts');
    });

    it('clears the locked-out OTP so the next sendOtp starts clean', async () => {
      prisma.otpVerification.findFirst.mockResolvedValue({
        id: 'otp-1',
        mobile: '9999999999',
        code: '482913',
        attempts: 5,
        expires_at: new Date(Date.now() + 60_000),
        created_at: new Date(),
      });

      await expect(
        service.verifyOtp('9999999999', '482913'),
      ).rejects.toThrow(ForbiddenException);

      expect(prisma.otpVerification.deleteMany).toHaveBeenCalledWith({
        where: { mobile: '9999999999' },
      });
    });

    it('does not lock out a mobile that has never requested an OTP', async () => {
      prisma.otpVerification.findFirst.mockResolvedValue(null);
      await expect(
        service.verifyOtp('9999999999', '000000'),
      ).rejects.toThrow('Invalid OTP code');
      expect(prisma.otpVerification.update).not.toHaveBeenCalled();
    });
  });
});

/**
 * Merchant Onboarding Pilot — MERCHANT_OTP_MODE=test. Scoped strictly to
 * role: 'Business'; every case here also proves role: 'Customer' (or no
 * role) is completely unaffected, and that an unset/'production' flag
 * value is the safe default (real OTP flow, matching every test above).
 */
describe('AuthService — Merchant OTP pilot bypass', () => {
  let service: AuthService;
  let prisma: {
    otpVerification: {
      findFirst: jest.Mock;
      deleteMany: jest.Mock;
      create: jest.Mock;
    };
    customer: { findUnique: jest.Mock };
    business: { findUnique: jest.Mock };
  };

  const makeConfig = (values: Record<string, any> = {}) =>
    ({
      get: jest.fn((key: string, def?: any) =>
        key in values ? values[key] : def,
      ),
    }) as unknown as ConfigService;

  const buildService = async (configValues: Record<string, any>) => {
    prisma = {
      otpVerification: {
        findFirst: jest.fn(),
        deleteMany: jest.fn(),
        create: jest.fn().mockResolvedValue({}),
      },
      customer: { findUnique: jest.fn().mockResolvedValue(null) },
      business: { findUnique: jest.fn().mockResolvedValue(null) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: JwtService,
          useValue: { sign: jest.fn().mockReturnValue('signed-jwt') },
        },
        {
          provide: OtpService,
          useValue: {
            generateOtp: jest.fn().mockReturnValue('482913'),
            sendOtp: jest.fn().mockResolvedValue({ success: true }),
            useMock: true,
          },
        },
        { provide: StorageService, useValue: {} },
        {
          provide: NotificationService,
          useValue: { sendNotification: jest.fn() },
        },
        { provide: ConfigService, useValue: makeConfig(configValues) },
        // Real instance — CategoryService is pure, dependency-free and
        // covered by its own spec, so the genuine normalisation runs here.
        CategoryService,
        // Not exercised by this describe block's tests (none call
        // googleUpsert) — present only because AuthService now requires it.
        {
          provide: GoogleTokenVerifierService,
          useValue: { verifyIdToken: jest.fn() },
        },
      ],
    }).compile();

    return module.get(AuthService);
  };

  it('sendOtp skips the DB/SMS path entirely for role: Business when MERCHANT_OTP_MODE=test', async () => {
    service = await buildService({
      MERCHANT_OTP_MODE: 'test',
      MERCHANT_DEFAULT_OTP: '1234',
    });
    const result = await service.sendOtp('9000000001', 'Business');

    expect(result).toEqual({
      success: true,
      message: 'OTP sent successfully',
      otpLength: 4,
    });
    expect(prisma.otpVerification.create).not.toHaveBeenCalled();
  });

  it('sendOtp takes the real path for role: Customer even when MERCHANT_OTP_MODE=test', async () => {
    service = await buildService({ MERCHANT_OTP_MODE: 'test' });
    await service.sendOtp('9000000002', 'Customer');
    expect(prisma.otpVerification.create).toHaveBeenCalledTimes(1);
  });

  it('verifyOtp accepts MERCHANT_DEFAULT_OTP for role: Business without touching OtpVerification', async () => {
    service = await buildService({
      MERCHANT_OTP_MODE: 'test',
      MERCHANT_DEFAULT_OTP: '1234',
    });
    const result = await service.verifyOtp('9000000001', '1234', 'Business');

    expect(result.exists).toBe(false); // no business/customer row seeded — still proves the code was accepted
    expect(prisma.otpVerification.findFirst).not.toHaveBeenCalled();
  });

  it('verifyOtp rejects any code other than the fixed pilot code for role: Business', async () => {
    service = await buildService({
      MERCHANT_OTP_MODE: 'test',
      MERCHANT_DEFAULT_OTP: '1234',
    });
    await expect(
      service.verifyOtp('9000000001', '9999', 'Business'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.verifyOtp('9000000001', '1234a', 'Business'),
    ).rejects.toThrow(BadRequestException);
  });

  it('verifyOtp still requires the real OTP flow for role: Customer even when MERCHANT_OTP_MODE=test', async () => {
    service = await buildService({
      MERCHANT_OTP_MODE: 'test',
      MERCHANT_DEFAULT_OTP: '1234',
    });
    prisma.otpVerification.findFirst.mockResolvedValue(null);
    await expect(
      service.verifyOtp('9000000002', '1234', 'Customer'),
    ).rejects.toThrow(BadRequestException);
  });

  it('verifyOtp still requires the real OTP flow for role: Business when MERCHANT_OTP_MODE is unset (safe default)', async () => {
    service = await buildService({});
    prisma.otpVerification.findFirst.mockResolvedValue(null);
    await expect(
      service.verifyOtp('9000000001', '1234', 'Business'),
    ).rejects.toThrow(BadRequestException);
  });

  it('verifyOtp still requires the real OTP flow for role: Business when MERCHANT_OTP_MODE=production explicitly', async () => {
    service = await buildService({
      MERCHANT_OTP_MODE: 'production',
      MERCHANT_DEFAULT_OTP: '1234',
    });
    prisma.otpVerification.findFirst.mockResolvedValue(null);
    await expect(
      service.verifyOtp('9000000001', '1234', 'Business'),
    ).rejects.toThrow(BadRequestException);
  });

  it('honors a custom MERCHANT_DEFAULT_OTP value over an arbitrary guess', async () => {
    service = await buildService({
      MERCHANT_OTP_MODE: 'test',
      MERCHANT_DEFAULT_OTP: '5678',
    });
    await expect(
      service.verifyOtp('9000000001', '1234', 'Business'),
    ).rejects.toThrow(BadRequestException);
    const result = await service.verifyOtp('9000000001', '5678', 'Business');
    expect(result.exists).toBe(false);
  });

  // The pilot's own fixed code must never be '1234' by default — now that
  // real OTPs are also 4 digits, a hardcoded '1234' bypass would be
  // indistinguishable from a genuinely-generated one. See merchantDefaultOtp().
  it('the unset MERCHANT_DEFAULT_OTP default is not "1234" — a raw "1234" guess fails against it', async () => {
    service = await buildService({ MERCHANT_OTP_MODE: 'test' });
    await expect(
      service.verifyOtp('9000000001', '1234', 'Business'),
    ).rejects.toThrow(BadRequestException);
    // The real (undocumented-to-the-guesser) default succeeds, proving the
    // pilot bypass still works end-to-end with its new fixed code.
    const result = await service.verifyOtp('9000000001', '7654', 'Business');
    expect(result.exists).toBe(false);
  });
});

/**
 * sendOtp() — real (non-pilot) flow. Confirms each call, including a resend,
 * generates and stores a fresh 4-digit code rather than reusing/caching one.
 */
describe('AuthService.sendOtp — real OTP flow', () => {
  let service: AuthService;
  let prisma: {
    otpVerification: { create: jest.Mock };
  };
  let otpService: { generateOtp: jest.Mock; sendOtp: jest.Mock };

  const makeConfig = () =>
    ({ get: jest.fn((_key: string, def?: any) => def) }) as unknown as ConfigService;

  beforeEach(async () => {
    prisma = { otpVerification: { create: jest.fn().mockResolvedValue({}) } };
    otpService = {
      generateOtp: jest.fn(),
      sendOtp: jest.fn().mockResolvedValue({ success: true }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: JwtService,
          useValue: { sign: jest.fn().mockReturnValue('signed-jwt') },
        },
        { provide: OtpService, useValue: otpService },
        { provide: StorageService, useValue: {} },
        {
          provide: NotificationService,
          useValue: { sendNotification: jest.fn() },
        },
        { provide: ConfigService, useValue: makeConfig() },
        CategoryService,
        {
          provide: GoogleTokenVerifierService,
          useValue: { verifyIdToken: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  it('stores the freshly generated 4-digit code from OtpService', async () => {
    otpService.generateOtp.mockReturnValue('9042');
    await service.sendOtp('9000000001', 'Customer');

    expect(prisma.otpVerification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          mobile: '9000000001',
          code: '9042',
        }),
      }),
    );
  });

  it('resend (a second sendOtp call) generates and stores a new code, not the same one', async () => {
    otpService.generateOtp
      .mockReturnValueOnce('9042')
      .mockReturnValueOnce('1730');

    await service.sendOtp('9000000001', 'Customer');
    await service.sendOtp('9000000001', 'Customer'); // resend

    expect(otpService.generateOtp).toHaveBeenCalledTimes(2);
    expect(prisma.otpVerification.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: expect.objectContaining({ code: '9042' }) }),
    );
    expect(prisma.otpVerification.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: expect.objectContaining({ code: '1730' }) }),
    );
  });
});

/**
 * Launch-audit Critical finding: POST /auth/google previously trusted the
 * request body's `email` field as identity proof and used it to look up /
 * log in to any existing account — a full account-takeover-by-email
 * vulnerability, since nothing tied the caller to a real Google sign-in.
 * These tests lock in that the verified Firebase ID token's own email claim
 * is now the only thing ever used for account lookup, never the body.
 */
describe('AuthService.googleUpsert — account takeover fix', () => {
  let service: AuthService;
  let prisma: {
    customer: { findUnique: jest.Mock; update: jest.Mock };
    business: { findUnique: jest.Mock; update: jest.Mock };
  };
  let verifyIdToken: jest.Mock;

  const buildService = async () => {
    prisma = {
      customer: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
      business: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    };
    verifyIdToken = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: JwtService,
          useValue: { sign: jest.fn().mockReturnValue('signed-jwt') },
        },
        { provide: OtpService, useValue: {} },
        { provide: StorageService, useValue: {} },
        {
          provide: NotificationService,
          useValue: { sendNotification: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((_key: string, def?: any) => def) },
        },
        CategoryService,
        { provide: GoogleTokenVerifierService, useValue: { verifyIdToken } },
      ],
    }).compile();

    return module.get(AuthService);
  };

  beforeEach(async () => {
    service = await buildService();
  });

  it('rejects the request outright when idToken verification fails, before any DB lookup', async () => {
    verifyIdToken.mockRejectedValue(new UnauthorizedException('Invalid or expired Google credential'));

    await expect(
      service.googleUpsert({
        idToken: 'forged-or-missing',
        name: 'Attacker',
        email: 'victim@pairley-qa.internal',
        role: 'Customer',
      }),
    ).rejects.toThrow(UnauthorizedException);

    expect(prisma.customer.findUnique).not.toHaveBeenCalled();
  });

  it('looks up the account using the verified token email, ignoring a spoofed body email', async () => {
    verifyIdToken.mockResolvedValue({
      email: 'real-owner@pairley-qa.internal',
      uid: 'firebase-uid-123',
    });
    prisma.customer.findUnique.mockResolvedValue({
      id: 'cust-1',
      email: 'real-owner@pairley-qa.internal',
      mobile: '9000011111',
    });

    const result = await service.googleUpsert({
      idToken: 'genuine-token-for-real-owner',
      name: 'Someone',
      // The attempted spoof: claims to be a totally different account.
      email: 'victim@pairley-qa.internal',
      role: 'Customer',
    });

    expect(prisma.customer.findUnique).toHaveBeenCalledWith({
      where: { email: 'real-owner@pairley-qa.internal' },
    });
    expect(result.exists).toBe(true);
    expect(result.user.id).toBe('cust-1');
  });
});
