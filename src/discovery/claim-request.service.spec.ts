import { BusinessStatus, ClaimRequestStatus } from '@prisma/client';
import { ClaimRequestService } from './claim-request.service';
import { PrismaService } from '../prisma/prisma.service';
import { OtpService } from '../common/services/otp.service';
import { JwtService } from '@nestjs/jwt';
import { StorageService } from '../common/services/storage.service';
import { FileValidationService } from './file-validation.service';

// A minimal real JPEG signature (FF D8 FF) followed by a few bytes — passes
// FileValidationService's magic-byte check without needing a full valid image.
const VALID_JPEG_BASE64 =
  'data:image/jpeg;base64,' +
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]).toString(
    'base64',
  );
const NOT_A_JPEG_BASE64 =
  'data:image/jpeg;base64,' +
  Buffer.from('this is not an image').toString('base64');

describe('ClaimRequestService', () => {
  let businessFindUnique: jest.Mock;
  let businessUpdate: jest.Mock;
  let claimRequestFindUnique: jest.Mock;
  let claimRequestFindFirst: jest.Mock;
  let claimRequestCreate: jest.Mock;
  let claimRequestUpdate: jest.Mock;
  let claimRequestFindMany: jest.Mock;
  let otpVerificationCreate: jest.Mock;
  let otpVerificationFindFirst: jest.Mock;
  let otpVerificationDeleteMany: jest.Mock;
  let prisma: {
    business: { findUnique: jest.Mock; update: jest.Mock };
    claimRequest: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      findMany: jest.Mock;
    };
    otpVerification: {
      create: jest.Mock;
      findFirst: jest.Mock;
      deleteMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let otpService: { generateOtp: jest.Mock; sendOtp: jest.Mock };
  let jwtService: { sign: jest.Mock };
  let storageService: { uploadBase64: jest.Mock };
  let fileValidationService: FileValidationService;
  let service: ClaimRequestService;

  const unclaimedBusiness = {
    id: 'business-1',
    business_status: BusinessStatus.UNCLAIMED,
    mobile: null,
    email: null,
  };

  const futureExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const pastExpiry = new Date(Date.now() - 1000);

  const approvedClaim = {
    id: 'claim-1',
    business_id: 'business-1',
    mobile: '9876543210',
    claim_token: 'token-abc',
    status: ClaimRequestStatus.ADMIN_APPROVED,
    token_expires_at: futureExpiry,
    otp_attempts: 0,
    business: { business_name: 'Test Shop' },
  };

  beforeEach(() => {
    businessFindUnique = jest.fn().mockResolvedValue(unclaimedBusiness);
    businessUpdate = jest
      .fn()
      .mockImplementation(({ data }) =>
        Promise.resolve({ ...unclaimedBusiness, ...data }),
      );
    claimRequestFindUnique = jest.fn();
    claimRequestFindFirst = jest.fn().mockResolvedValue(null);
    claimRequestCreate = jest.fn().mockImplementation(({ data }) =>
      Promise.resolve({
        id: 'claim-new',
        status: ClaimRequestStatus.PENDING_ADMIN_REVIEW,
        token_expires_at: futureExpiry,
        ...data,
      }),
    );
    claimRequestUpdate = jest
      .fn()
      .mockImplementation(({ data }) =>
        Promise.resolve({ ...approvedClaim, ...data }),
      );
    claimRequestFindMany = jest.fn().mockResolvedValue([]);
    otpVerificationCreate = jest.fn().mockResolvedValue({});
    otpVerificationFindFirst = jest.fn();
    otpVerificationDeleteMany = jest.fn().mockResolvedValue({ count: 1 });

    prisma = {
      business: { findUnique: businessFindUnique, update: businessUpdate },
      claimRequest: {
        findUnique: claimRequestFindUnique,
        findFirst: claimRequestFindFirst,
        create: claimRequestCreate,
        update: claimRequestUpdate,
        findMany: claimRequestFindMany,
      },
      otpVerification: {
        create: otpVerificationCreate,
        findFirst: otpVerificationFindFirst,
        deleteMany: otpVerificationDeleteMany,
      },
      $transaction: jest
        .fn()
        .mockImplementation((callback: (tx: unknown) => unknown) => {
          const tx = {
            business: { update: businessUpdate },
            claimRequest: { update: claimRequestUpdate },
            otpVerification: { deleteMany: otpVerificationDeleteMany },
          };
          return callback(tx);
        }),
    };

    otpService = {
      generateOtp: jest.fn().mockReturnValue('123456'),
      sendOtp: jest.fn().mockResolvedValue({ success: true }),
    };
    jwtService = { sign: jest.fn().mockReturnValue('signed-jwt') };
    storageService = {
      uploadBase64: jest
        .fn()
        .mockImplementation((_dataUri: string, folder: string, name: string) =>
          Promise.resolve(`https://s3.example.com/${folder}/${name}`),
        ),
    };
    // Real instance, not a mock — FileValidationService is a small, pure,
    // already-well-tested-on-its-own service (Module 10); using the real
    // thing here exercises the actual magic-byte checks against the test
    // fixtures above, same reasoning as NormalizationService in the
    // orchestration spec.
    fileValidationService = new FileValidationService();

    service = new ClaimRequestService(
      prisma as unknown as PrismaService,
      otpService as unknown as OtpService,
      jwtService as unknown as JwtService,
      storageService as unknown as StorageService,
      fileValidationService,
    );
  });

  describe('requestClaim', () => {
    it('creates a claim request with a non-guessable token for an UNCLAIMED business', async () => {
      const result = await service.requestClaim('business-1', '9876543210');
      expect(result.claimToken).toHaveLength(64); // 32 bytes hex-encoded
      expect(result.status).toBe(ClaimRequestStatus.PENDING_ADMIN_REVIEW);
      expect(claimRequestCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            business_id: 'business-1',
            mobile: '9876543210',
          }) as unknown,
        }),
      );
    });

    it('rejects a malformed mobile number', async () => {
      await expect(
        service.requestClaim('business-1', 'not-a-number'),
      ).rejects.toThrow('10-15 digits');
    });

    it('rejects a request for a business that does not exist', async () => {
      businessFindUnique.mockResolvedValue(null);
      await expect(
        service.requestClaim('missing', '9876543210'),
      ).rejects.toThrow('Business not found');
    });

    it('rejects a request for an already-CLAIMED business', async () => {
      businessFindUnique.mockResolvedValue({
        ...unclaimedBusiness,
        business_status: BusinessStatus.CLAIMED,
      });
      await expect(
        service.requestClaim('business-1', '9876543210'),
      ).rejects.toThrow('already been claimed');
    });

    it('rejects a mobile number already registered to a different business', async () => {
      businessFindUnique
        .mockResolvedValueOnce(unclaimedBusiness)
        .mockResolvedValueOnce({ id: 'other-business' });
      await expect(
        service.requestClaim('business-1', '9876543210'),
      ).rejects.toThrow('already registered to another business');
    });

    it('rejects a duplicate claim attempt when one is already active for the business', async () => {
      claimRequestFindFirst.mockResolvedValue({
        id: 'existing-claim',
        status: ClaimRequestStatus.PENDING_ADMIN_REVIEW,
      });
      await expect(
        service.requestClaim('business-1', '9876543210'),
      ).rejects.toThrow('already in progress');
    });

    describe('with evidence (Module 12 Phase 1)', () => {
      it('has no claimant_name/evidence_urls when neither is supplied — unchanged Module 9 behavior', async () => {
        await service.requestClaim('business-1', '9876543210');
        expect(claimRequestCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              claimant_name: null,
              evidence_urls: [],
            }) as unknown,
          }),
        );
        expect(storageService.uploadBase64).not.toHaveBeenCalled();
      });

      it('validates, uploads, and stores claimant_name + evidence_urls when supplied', async () => {
        await service.requestClaim('business-1', '9876543210', 'Priya Sharma', [
          VALID_JPEG_BASE64,
        ]);
        expect(storageService.uploadBase64).toHaveBeenCalledTimes(1);
        expect(claimRequestCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              claimant_name: 'Priya Sharma',
              evidence_urls: [
                'https://s3.example.com/claim-evidence/evidence-1.jpeg',
              ],
            }) as unknown,
          }),
        );
      });

      it('rejects evidence that fails the magic-byte signature check', async () => {
        await expect(
          service.requestClaim('business-1', '9876543210', 'Priya Sharma', [
            NOT_A_JPEG_BASE64,
          ]),
        ).rejects.toThrow('Evidence rejected');
        expect(storageService.uploadBase64).not.toHaveBeenCalled();
        expect(claimRequestCreate).not.toHaveBeenCalled();
      });

      it('rejects a malformed (non-data-URI) evidence entry', async () => {
        await expect(
          service.requestClaim('business-1', '9876543210', 'Priya Sharma', [
            'not-a-data-uri',
          ]),
        ).rejects.toThrow('base64 data URI');
      });

      it('rejects more than the maximum allowed evidence files', async () => {
        const tooMany = Array(6).fill(VALID_JPEG_BASE64);
        await expect(
          service.requestClaim(
            'business-1',
            '9876543210',
            'Priya Sharma',
            tooMany,
          ),
        ).rejects.toThrow('at most 5 evidence files');
        expect(storageService.uploadBase64).not.toHaveBeenCalled();
      });

      it('validates evidence before ever touching the database — reject-before-processing', async () => {
        await expect(
          service.requestClaim('business-1', '9876543210', 'Priya Sharma', [
            NOT_A_JPEG_BASE64,
          ]),
        ).rejects.toThrow();
        expect(businessFindUnique).not.toHaveBeenCalled();
      });
    });
  });

  describe('getRequestDetail (Module 12 Phase 1)', () => {
    it('returns the full claim including business and evidence', async () => {
      claimRequestFindUnique.mockResolvedValue({
        ...approvedClaim,
        claimant_name: 'Priya Sharma',
        evidence_urls: [
          'https://s3.example.com/claim-evidence/evidence-1.jpeg',
        ],
      });
      const result = await service.getRequestDetail('claim-1');
      expect(result.claimant_name).toBe('Priya Sharma');
      expect(result.evidence_urls).toEqual([
        'https://s3.example.com/claim-evidence/evidence-1.jpeg',
      ]);
    });

    it('throws NotFound for a missing claim', async () => {
      claimRequestFindUnique.mockResolvedValue(null);
      await expect(service.getRequestDetail('missing')).rejects.toThrow(
        'Claim request not found',
      );
    });
  });

  describe('getStatusByToken', () => {
    it('throws NotFound for an invalid/unknown token', async () => {
      claimRequestFindUnique.mockResolvedValue(null);
      await expect(service.getStatusByToken('bogus-token')).rejects.toThrow(
        'Claim request not found',
      );
    });

    it('lazily transitions an expired token to EXPIRED', async () => {
      claimRequestFindUnique.mockResolvedValue({
        ...approvedClaim,
        token_expires_at: pastExpiry,
      });
      const result = await service.getStatusByToken('token-abc');
      expect(result.status).toBe(ClaimRequestStatus.EXPIRED);
      expect(claimRequestUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: ClaimRequestStatus.EXPIRED,
          }) as unknown,
        }),
      );
    });
  });

  describe('approve / reject', () => {
    it('approve() transitions PENDING_ADMIN_REVIEW -> ADMIN_APPROVED with reviewer audit fields', async () => {
      claimRequestFindUnique.mockResolvedValue({
        ...approvedClaim,
        status: ClaimRequestStatus.PENDING_ADMIN_REVIEW,
      });
      await service.approve('claim-1', 'admin-42');
      expect(claimRequestUpdate).toHaveBeenCalledWith({
        where: { id: 'claim-1' },
        data: expect.objectContaining({
          status: ClaimRequestStatus.ADMIN_APPROVED,
          reviewed_by: 'admin-42',
        }) as unknown,
      });
    });

    it('approve() rejects a request that is not PENDING_ADMIN_REVIEW', async () => {
      claimRequestFindUnique.mockResolvedValue(approvedClaim); // already ADMIN_APPROVED
      await expect(service.approve('claim-1', 'admin-42')).rejects.toThrow(
        'Cannot approve',
      );
    });

    it('reject() records the admin id and an optional reason', async () => {
      claimRequestFindUnique.mockResolvedValue({
        ...approvedClaim,
        status: ClaimRequestStatus.PENDING_ADMIN_REVIEW,
      });
      await service.reject('claim-1', 'admin-7', 'Looks fraudulent');
      expect(claimRequestUpdate).toHaveBeenCalledWith({
        where: { id: 'claim-1' },
        data: expect.objectContaining({
          status: ClaimRequestStatus.ADMIN_REJECTED,
          reviewed_by: 'admin-7',
          rejection_reason: 'Looks fraudulent',
        }) as unknown,
      });
    });
  });

  describe('sendOtp', () => {
    it('sends an OTP only when the claim is ADMIN_APPROVED', async () => {
      claimRequestFindUnique.mockResolvedValue(approvedClaim);
      const result = await service.sendOtp('token-abc');
      expect(result.success).toBe(true);
      expect(otpService.sendOtp).toHaveBeenCalledWith('9876543210', '123456');
    });

    it('rejects sending an OTP for a request still PENDING_ADMIN_REVIEW', async () => {
      claimRequestFindUnique.mockResolvedValue({
        ...approvedClaim,
        status: ClaimRequestStatus.PENDING_ADMIN_REVIEW,
      });
      await expect(service.sendOtp('token-abc')).rejects.toThrow('not ready');
    });

    it('rejects sending an OTP for an expired claim link', async () => {
      claimRequestFindUnique.mockResolvedValue({
        ...approvedClaim,
        token_expires_at: pastExpiry,
      });
      await expect(service.sendOtp('token-abc')).rejects.toThrow('expired');
    });
  });

  describe('verifyOtpAndTransfer', () => {
    beforeEach(() => {
      claimRequestFindUnique.mockResolvedValue(approvedClaim);
    });

    it('rejects an invalid OTP and increments the attempt counter', async () => {
      otpVerificationFindFirst.mockResolvedValue(null);
      await expect(
        service.verifyOtpAndTransfer('token-abc', '000000'),
      ).rejects.toThrow('Invalid OTP code');
      expect(claimRequestUpdate).toHaveBeenCalledWith({
        where: { id: 'claim-1' },
        data: { otp_attempts: { increment: 1 } },
      });
    });

    it('rejects an expired OTP', async () => {
      otpVerificationFindFirst.mockResolvedValue({
        code: '123456',
        expires_at: pastExpiry,
      });
      await expect(
        service.verifyOtpAndTransfer('token-abc', '123456'),
      ).rejects.toThrow('OTP code has expired');
    });

    it('blocks further attempts once the retry limit is reached, expiring the claim', async () => {
      claimRequestFindUnique.mockResolvedValue({
        ...approvedClaim,
        otp_attempts: 5,
      });
      await expect(
        service.verifyOtpAndTransfer('token-abc', '123456'),
      ).rejects.toThrow('Too many failed attempts');
      expect(claimRequestUpdate).toHaveBeenCalledWith({
        where: { id: 'claim-1' },
        data: expect.objectContaining({
          status: ClaimRequestStatus.EXPIRED,
        }) as unknown,
      });
    });

    it('performs an atomic ownership transfer and issues a JWT only after it commits', async () => {
      otpVerificationFindFirst.mockResolvedValue({
        code: '123456',
        expires_at: new Date(Date.now() + 60_000),
      });

      const result = await service.verifyOtpAndTransfer('token-abc', '123456');

      expect(businessUpdate).toHaveBeenCalledWith({
        where: { id: 'business-1' },
        data: expect.objectContaining({
          business_status: BusinessStatus.CLAIMED,
          mobile: '9876543210',
          claimed_by: 'claim-1',
        }) as unknown,
      });
      expect(claimRequestUpdate).toHaveBeenCalledWith({
        where: { id: 'claim-1' },
        data: expect.objectContaining({
          status: ClaimRequestStatus.COMPLETED,
        }) as unknown,
      });
      expect(otpVerificationDeleteMany).toHaveBeenCalledWith({
        where: { mobile: '9876543210' },
      });
      expect(jwtService.sign).toHaveBeenCalledTimes(1);
      expect(result.token).toBe('signed-jwt');
      expect(result.role).toBe('Business');
    });

    it('blocks the transfer if the business was claimed by someone else in the interim', async () => {
      otpVerificationFindFirst.mockResolvedValue({
        code: '123456',
        expires_at: new Date(Date.now() + 60_000),
      });
      businessFindUnique.mockResolvedValue({
        ...unclaimedBusiness,
        business_status: BusinessStatus.CLAIMED,
      });

      await expect(
        service.verifyOtpAndTransfer('token-abc', '123456'),
      ).rejects.toThrow('already been claimed');
      expect(jwtService.sign).not.toHaveBeenCalled();
    });

    it('blocks the transfer if the mobile was claimed by a different business in the interim', async () => {
      otpVerificationFindFirst.mockResolvedValue({
        code: '123456',
        expires_at: new Date(Date.now() + 60_000),
      });
      businessFindUnique
        .mockResolvedValueOnce(unclaimedBusiness) // the business being claimed
        .mockResolvedValueOnce({ id: 'a-different-business' }); // mobile-uniqueness re-check

      await expect(
        service.verifyOtpAndTransfer('token-abc', '123456'),
      ).rejects.toThrow('already registered to another business');
      expect(jwtService.sign).not.toHaveBeenCalled();
    });
  });
});
