import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
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

  beforeEach(async () => {
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
      ],
    }).compile();

    service = module.get(AuthService);
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
