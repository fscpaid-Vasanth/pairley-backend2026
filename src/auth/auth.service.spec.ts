import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { OtpService } from '../common/services/otp.service';
import { StorageService } from '../common/services/storage.service';
import { NotificationService } from '../common/services/notification.service';

/**
 * Regression coverage for the OTP verification security fix: no code should
 * verify successfully unless it matches a real, unexpired OtpVerification
 * record. Guards specifically against the previously-removed hardcoded
 * '123456'/'1234' bypass ever being reintroduced.
 */
describe('AuthService.verifyOtp', () => {
  let service: AuthService;
  let prisma: {
    otpVerification: { findFirst: jest.Mock; deleteMany: jest.Mock };
    customer: { findUnique: jest.Mock };
    business: { findUnique: jest.Mock };
  };

  const makeConfig = (values: Record<string, any> = {}) =>
    ({
      get: jest.fn((key: string, def?: any) => (key in values ? values[key] : def)),
    }) as unknown as ConfigService;

  const buildService = async (configValues: Record<string, any> = {}) => {
    prisma = {
      otpVerification: { findFirst: jest.fn(), deleteMany: jest.fn() },
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

  it('rejects an expired OTP record even if the code matches', async () => {
    prisma.otpVerification.findFirst.mockResolvedValue({
      mobile: '9999999999',
      code: '482913',
      expires_at: new Date(Date.now() - 60_000),
      created_at: new Date(),
    });
    await expect(service.verifyOtp('9999999999', '482913')).rejects.toThrow(
      'OTP code has expired',
    );
  });

  it('accepts a real, unexpired OTP record and consumes it', async () => {
    prisma.otpVerification.findFirst.mockResolvedValue({
      mobile: '9999999999',
      code: '482913',
      expires_at: new Date(Date.now() + 60_000),
      created_at: new Date(),
    });

    const result = await service.verifyOtp('9999999999', '482913');

    expect(result.exists).toBe(false);
    expect(prisma.otpVerification.deleteMany).toHaveBeenCalledWith({
      where: { mobile: '9999999999' },
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
    otpVerification: { findFirst: jest.Mock; deleteMany: jest.Mock; create: jest.Mock };
    customer: { findUnique: jest.Mock };
    business: { findUnique: jest.Mock };
  };

  const makeConfig = (values: Record<string, any> = {}) =>
    ({
      get: jest.fn((key: string, def?: any) => (key in values ? values[key] : def)),
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
        { provide: JwtService, useValue: { sign: jest.fn().mockReturnValue('signed-jwt') } },
        {
          provide: OtpService,
          useValue: { generateOtp: jest.fn().mockReturnValue('482913'), sendOtp: jest.fn().mockResolvedValue({ success: true }), useMock: true },
        },
        { provide: StorageService, useValue: {} },
        { provide: NotificationService, useValue: { sendNotification: jest.fn() } },
        { provide: ConfigService, useValue: makeConfig(configValues) },
      ],
    }).compile();

    return module.get(AuthService);
  };

  it('sendOtp skips the DB/SMS path entirely for role: Business when MERCHANT_OTP_MODE=test', async () => {
    service = await buildService({ MERCHANT_OTP_MODE: 'test', MERCHANT_DEFAULT_OTP: '1234' });
    const result = await service.sendOtp('9000000001', 'Business');

    expect(result).toEqual({ success: true, message: 'OTP sent successfully', otpLength: 4 });
    expect(prisma.otpVerification.create).not.toHaveBeenCalled();
  });

  it('sendOtp takes the real path for role: Customer even when MERCHANT_OTP_MODE=test', async () => {
    service = await buildService({ MERCHANT_OTP_MODE: 'test' });
    await service.sendOtp('9000000002', 'Customer');
    expect(prisma.otpVerification.create).toHaveBeenCalledTimes(1);
  });

  it('verifyOtp accepts MERCHANT_DEFAULT_OTP for role: Business without touching OtpVerification', async () => {
    service = await buildService({ MERCHANT_OTP_MODE: 'test', MERCHANT_DEFAULT_OTP: '1234' });
    const result = await service.verifyOtp('9000000001', '1234', 'Business');

    expect(result.exists).toBe(false); // no business/customer row seeded — still proves the code was accepted
    expect(prisma.otpVerification.findFirst).not.toHaveBeenCalled();
  });

  it('verifyOtp rejects any code other than the fixed pilot code for role: Business', async () => {
    service = await buildService({ MERCHANT_OTP_MODE: 'test', MERCHANT_DEFAULT_OTP: '1234' });
    await expect(service.verifyOtp('9000000001', '9999', 'Business')).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.verifyOtp('9000000001', '1234a', 'Business')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('verifyOtp still requires the real OTP flow for role: Customer even when MERCHANT_OTP_MODE=test', async () => {
    service = await buildService({ MERCHANT_OTP_MODE: 'test', MERCHANT_DEFAULT_OTP: '1234' });
    prisma.otpVerification.findFirst.mockResolvedValue(null);
    await expect(service.verifyOtp('9000000002', '1234', 'Customer')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('verifyOtp still requires the real OTP flow for role: Business when MERCHANT_OTP_MODE is unset (safe default)', async () => {
    service = await buildService({});
    prisma.otpVerification.findFirst.mockResolvedValue(null);
    await expect(service.verifyOtp('9000000001', '1234', 'Business')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('verifyOtp still requires the real OTP flow for role: Business when MERCHANT_OTP_MODE=production explicitly', async () => {
    service = await buildService({ MERCHANT_OTP_MODE: 'production', MERCHANT_DEFAULT_OTP: '1234' });
    prisma.otpVerification.findFirst.mockResolvedValue(null);
    await expect(service.verifyOtp('9000000001', '1234', 'Business')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('honors a custom MERCHANT_DEFAULT_OTP value instead of the 1234 default', async () => {
    service = await buildService({ MERCHANT_OTP_MODE: 'test', MERCHANT_DEFAULT_OTP: '5678' });
    await expect(service.verifyOtp('9000000001', '1234', 'Business')).rejects.toThrow(
      BadRequestException,
    );
    const result = await service.verifyOtp('9000000001', '5678', 'Business');
    expect(result.exists).toBe(false);
  });
});
