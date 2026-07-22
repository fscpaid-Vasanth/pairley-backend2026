import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'crypto';
import { BusinessStatus, ClaimRequestStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OtpService } from '../common/services/otp.service';
import { StorageService } from '../common/services/storage.service';
import { FileValidationService } from './file-validation.service';
import { FileImportError } from './file-import.errors';

const TOKEN_VALIDITY_DAYS = 7;
const OTP_VALIDITY_MINUTES = 5;
const MAX_OTP_ATTEMPTS = 5;
const MOBILE_PATTERN = /^\d{10,15}$/;
// A generous but bounded cap — evidence is a handful of documents/photos
// (registration certificate, storefront photo, ID, etc.), not an
// open-ended upload surface. Prevents one claim from becoming a large,
// costly batch upload.
const MAX_EVIDENCE_FILES = 5;
const EVIDENCE_UPLOAD_FOLDER = 'claim-evidence';
const DATA_URI_PATTERN = /^data:([^;]+);base64,(.+)$/;

// Module 9 Phase 4 — admin-assisted claim flow, per the explicit decision:
// merchant requests -> admin reviews -> OTP verification -> atomic
// ownership transfer -> dashboard access. No fully self-service path exists
// (deliberately — see Module 9 STEP 1 Decision 2).
// Module 12 Phase 1 — evidence-based claims. The state machine is
// unchanged; requestClaim() now additionally collects and validates
// verification evidence, so the admin's review step (still mandatory,
// still the only path to ADMIN_APPROVED) has something real to look at
// instead of nothing but a mobile number. This service owns the whole
// state machine; the two controllers (public ClaimController, admin
// ClaimAdminController) are thin wrappers with no business logic of their
// own, matching the separation-of-concerns pattern from Phases 2-3.
@Injectable()
export class ClaimRequestService {
  private readonly logger = new Logger(ClaimRequestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly otpService: OtpService,
    private readonly jwtService: JwtService,
    private readonly storageService: StorageService,
    private readonly fileValidationService: FileValidationService,
  ) {}

  async requestClaim(
    businessId: string,
    mobile: string,
    claimantName?: string,
    evidence?: string[],
  ) {
    if (!MOBILE_PATTERN.test(mobile)) {
      throw new BadRequestException('Mobile number must be 10-15 digits');
    }
    if (evidence && evidence.length > MAX_EVIDENCE_FILES) {
      throw new BadRequestException(
        `A claim can include at most ${MAX_EVIDENCE_FILES} evidence files`,
      );
    }

    // Validate before touching the database at all — reject-before-processing,
    // same discipline as Module 10's file-import pipeline. Uploading only
    // happens after every file in the batch has passed validation, so a
    // claim never ends up with some evidence uploaded and some silently
    // dropped because a later file in the array failed.
    const evidenceBuffers = (evidence ?? []).map((dataUri) =>
      this.parseAndValidateEvidence(dataUri),
    );

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
    });
    if (!business) {
      throw new NotFoundException('Business not found');
    }
    if (business.business_status !== BusinessStatus.UNCLAIMED) {
      throw new BadRequestException('This business has already been claimed');
    }

    // A mobile already tied to a different (already-registered) business
    // would collide at the final transfer step's unique constraint — catch
    // it early with a clear message instead of a raw DB error later.
    const conflictingBusiness = await this.prisma.business.findUnique({
      where: { mobile },
    });
    if (conflictingBusiness && conflictingBusiness.id !== businessId) {
      throw new BadRequestException(
        'This mobile number is already registered to another business',
      );
    }

    const existingActive = await this.prisma.claimRequest.findFirst({
      where: {
        business_id: businessId,
        status: {
          in: [
            ClaimRequestStatus.PENDING_ADMIN_REVIEW,
            ClaimRequestStatus.ADMIN_APPROVED,
          ],
        },
      },
    });
    if (existingActive) {
      throw new BadRequestException(
        'A claim request is already in progress for this business',
      );
    }

    // Uploaded last, after every other cheap/synchronous check has already
    // passed — no point paying for S3 writes on a request that was always
    // going to be rejected for an unrelated reason (business already
    // claimed, duplicate active claim, etc.).
    const evidenceUrls = await Promise.all(
      evidenceBuffers.map(({ buffer, mimetype }, i) =>
        this.storageService.uploadBase64(
          `data:${mimetype};base64,${buffer.toString('base64')}`,
          EVIDENCE_UPLOAD_FOLDER,
          this.fileValidationService.sanitizeFilename(
            `evidence-${i + 1}.${mimetype.split('/')[1] || 'bin'}`,
          ),
        ),
      ),
    );

    const claimToken = randomBytes(32).toString('hex');
    const tokenExpiresAt = new Date(
      Date.now() + TOKEN_VALIDITY_DAYS * 24 * 60 * 60 * 1000,
    );

    const claim = await this.prisma.claimRequest.create({
      data: {
        business_id: businessId,
        mobile,
        claim_token: claimToken,
        token_expires_at: tokenExpiresAt,
        claimant_name: claimantName || null,
        evidence_urls: evidenceUrls,
      },
    });

    this.logger.log(
      `Claim request ${claim.id} created for business ${businessId}`,
    );
    return {
      claimToken,
      status: claim.status,
      expiresAt: claim.token_expires_at,
      message: 'Your claim request has been submitted for admin review.',
    };
  }

  async getStatusByToken(claimToken: string) {
    const claim = await this.findByTokenOrThrow(claimToken);
    const current = await this.expireIfPastDeadline(claim);
    return {
      status: current.status,
      businessName: claim.businessName,
      expiresAt: current.token_expires_at,
    };
  }

  async listRequests(status?: ClaimRequestStatus) {
    return this.prisma.claimRequest.findMany({
      where: status ? { status } : undefined,
      include: {
        business: { select: { business_name: true, category: true } },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  // Module 12 Phase 1 — a single-request detail fetch for the admin review
  // UI (Phase 3 builds the actual evidence viewer against this). Kept
  // separate from listRequests() rather than bloating every row of every
  // page with the full business record, same reasoning as
  // ReviewQueueService.getCandidate() vs listCandidates() in Module 11.
  async getRequestDetail(id: string) {
    const claim = await this.prisma.claimRequest.findUnique({
      where: { id },
      include: { business: true },
    });
    if (!claim) {
      throw new NotFoundException('Claim request not found');
    }
    return claim;
  }

  async approve(claimRequestId: string, adminId: string) {
    const claim = await this.findByIdOrThrow(claimRequestId);
    const current = await this.expireIfPastDeadline(claim);
    if (current.status !== ClaimRequestStatus.PENDING_ADMIN_REVIEW) {
      throw new BadRequestException(
        `Cannot approve a request in status ${current.status}`,
      );
    }

    const updated = await this.prisma.claimRequest.update({
      where: { id: claimRequestId },
      data: {
        status: ClaimRequestStatus.ADMIN_APPROVED,
        reviewed_by: adminId,
        reviewed_at: new Date(),
      },
    });
    this.logger.log(
      `Claim request ${claimRequestId} approved by admin ${adminId}`,
    );
    return updated;
  }

  async reject(claimRequestId: string, adminId: string, reason?: string) {
    const claim = await this.findByIdOrThrow(claimRequestId);
    const rejectableStatuses: ClaimRequestStatus[] = [
      ClaimRequestStatus.PENDING_ADMIN_REVIEW,
      ClaimRequestStatus.ADMIN_APPROVED,
    ];
    if (!rejectableStatuses.includes(claim.status)) {
      throw new BadRequestException(
        `Cannot reject a request in status ${claim.status}`,
      );
    }

    const updated = await this.prisma.claimRequest.update({
      where: { id: claimRequestId },
      data: {
        status: ClaimRequestStatus.ADMIN_REJECTED,
        reviewed_by: adminId,
        reviewed_at: new Date(),
        rejection_reason: reason,
      },
    });
    this.logger.log(
      `Claim request ${claimRequestId} rejected by admin ${adminId}${reason ? `: ${reason}` : ''}`,
    );
    return updated;
  }

  async sendOtp(claimToken: string) {
    const claim = await this.assertUsableAndApproved(claimToken);

    const code = this.otpService.generateOtp();
    const expiresAt = new Date(Date.now() + OTP_VALIDITY_MINUTES * 60 * 1000);
    await this.prisma.otpVerification.create({
      data: { mobile: claim.mobile, code, expires_at: expiresAt },
    });

    const result = await this.otpService.sendOtp(claim.mobile, code);
    if (!result.success) {
      throw new BadRequestException(
        result.error || 'Failed to send OTP. Please try again.',
      );
    }
    this.logger.log(`OTP sent for claim request ${claim.id}`);
    return { success: true, message: 'OTP sent successfully' };
  }

  async verifyOtpAndTransfer(claimToken: string, code: string) {
    const claim = await this.assertUsableAndApproved(claimToken);

    if (claim.otp_attempts >= MAX_OTP_ATTEMPTS) {
      await this.prisma.claimRequest.update({
        where: { id: claim.id },
        data: {
          status: ClaimRequestStatus.EXPIRED,
          rejection_reason: 'Too many failed OTP attempts',
        },
      });
      this.logger.warn(
        `Claim request ${claim.id} expired after exceeding OTP attempt limit`,
      );
      throw new ForbiddenException(
        'Too many failed attempts. Please submit a new claim request.',
      );
    }

    const record = await this.prisma.otpVerification.findFirst({
      where: { mobile: claim.mobile, code },
      orderBy: { created_at: 'desc' },
    });

    if (!record || new Date() > record.expires_at) {
      await this.prisma.claimRequest.update({
        where: { id: claim.id },
        data: { otp_attempts: { increment: 1 } },
      });
      this.logger.warn(
        `Claim request ${claim.id} — invalid/expired OTP attempt`,
      );
      throw new BadRequestException(
        !record ? 'Invalid OTP code' : 'OTP code has expired',
      );
    }

    // Re-check invariants right before the transfer — defense in depth
    // against a conflict that appeared after the original request (e.g.
    // the mobile got claimed by someone else via a separate flow in the
    // interim).
    const business = await this.prisma.business.findUnique({
      where: { id: claim.business_id },
    });
    if (!business) {
      throw new NotFoundException('Business no longer exists');
    }
    if (business.business_status !== BusinessStatus.UNCLAIMED) {
      throw new BadRequestException('This business has already been claimed');
    }
    const conflictingBusiness = await this.prisma.business.findUnique({
      where: { mobile: claim.mobile },
    });
    if (conflictingBusiness && conflictingBusiness.id !== business.id) {
      throw new BadRequestException(
        'This mobile number is already registered to another business',
      );
    }

    const now = new Date();
    const updatedBusiness = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.business.update({
        where: { id: business.id },
        data: {
          business_status: BusinessStatus.CLAIMED,
          mobile: claim.mobile,
          claimed_at: now,
          claimed_by: claim.id,
        },
      });
      await tx.claimRequest.update({
        where: { id: claim.id },
        data: { status: ClaimRequestStatus.COMPLETED, completed_at: now },
      });
      // Replay protection: the OTP code can never be used again once
      // consumed, matching the delete-after-use pattern already used by
      // auth.service.ts's verifyOtp() and business.service.ts's WhatsApp-
      // number verification.
      await tx.otpVerification.deleteMany({ where: { mobile: claim.mobile } });
      return updated;
    });

    this.logger.log(
      `Claim request ${claim.id} completed — business ${business.id} ownership transferred`,
    );

    // JWT is issued only after the transaction above has committed
    // successfully, per the explicit requirement — never issued on a
    // partial/failed transfer.
    const token = this.jwtService.sign({
      sub: updatedBusiness.id,
      mobile: updatedBusiness.mobile || '',
      role: 'Business',
      email: updatedBusiness.email || '',
    });

    return { token, user: updatedBusiness, role: 'Business' };
  }

  // Reuses FileValidationService's exact magic-byte/mimetype/size checks
  // (Module 10's standard) against the decoded buffer — the client-declared
  // mimetype in the data URI is never trusted alone. Throws BadRequestException
  // (not FileImportError) since claim evidence has no ImportJob to attach a
  // machine-readable reason to; the human message is enough here.
  private parseAndValidateEvidence(dataUri: string): {
    buffer: Buffer;
    mimetype: string;
  } {
    const match = dataUri.match(DATA_URI_PATTERN);
    if (!match) {
      throw new BadRequestException(
        'Evidence must be a base64 data URI (data:<mimetype>;base64,<data>)',
      );
    }
    const mimetype = match[1];
    const buffer = Buffer.from(match[2], 'base64');
    try {
      this.fileValidationService.validate({
        mimetype,
        size: buffer.length,
        buffer,
      });
    } catch (err) {
      if (err instanceof FileImportError) {
        throw new BadRequestException(`Evidence rejected: ${err.message}`);
      }
      throw err;
    }
    return { buffer, mimetype };
  }

  private async findByTokenOrThrow(claimToken: string) {
    const claim = await this.prisma.claimRequest.findUnique({
      where: { claim_token: claimToken },
      include: { business: { select: { business_name: true } } },
    });
    if (!claim) {
      throw new NotFoundException('Claim request not found');
    }
    return { ...claim, businessName: claim.business.business_name };
  }

  private async findByIdOrThrow(id: string) {
    const claim = await this.prisma.claimRequest.findUnique({ where: { id } });
    if (!claim) {
      throw new NotFoundException('Claim request not found');
    }
    return claim;
  }

  private async expireIfPastDeadline<
    T extends {
      id: string;
      status: ClaimRequestStatus;
      token_expires_at: Date;
    },
  >(claim: T): Promise<T> {
    const isTerminal =
      claim.status === ClaimRequestStatus.COMPLETED ||
      claim.status === ClaimRequestStatus.ADMIN_REJECTED ||
      claim.status === ClaimRequestStatus.EXPIRED;
    if (isTerminal || claim.token_expires_at > new Date()) {
      return claim;
    }
    await this.prisma.claimRequest.update({
      where: { id: claim.id },
      data: { status: ClaimRequestStatus.EXPIRED },
    });
    return { ...claim, status: ClaimRequestStatus.EXPIRED };
  }

  private async assertUsableAndApproved(claimToken: string) {
    const claim = await this.findByTokenOrThrow(claimToken);
    const current = await this.expireIfPastDeadline(claim);
    if (current.status !== ClaimRequestStatus.ADMIN_APPROVED) {
      throw new BadRequestException(
        current.status === ClaimRequestStatus.EXPIRED
          ? 'This claim link has expired'
          : `This claim request is not ready (status: ${current.status})`,
      );
    }
    return current;
  }
}
