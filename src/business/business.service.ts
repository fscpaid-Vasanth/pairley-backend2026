import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/services/storage.service';
import {
  WhatsappService,
  resolveLeadWhatsappNumber,
} from '../whatsapp/whatsapp.service';

@Injectable()
export class BusinessService {
  constructor(
    private prisma: PrismaService,
    private storageService: StorageService,
    private whatsappService: WhatsappService,
  ) {}

  async getProfile(businessId: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      include: {
        subscriptions: {
          orderBy: { created_at: 'desc' },
          take: 1,
        },
      },
    });
    if (!business) {
      throw new NotFoundException('Business profile not found');
    }
    return business;
  }

  async updateProfile(businessId: string, data: any) {
    // business_status/source/created_by_ai/claimed_at/claimed_by are admin- or
    // claim-flow-only — never self-editable via this endpoint. mobile has its
    // own dedicated OTP-based change flow (not this one). Both are also
    // enforced by UpdateBusinessProfileDto's whitelist at the controller
    // layer — this destructure is a second, defense-in-depth layer in case
    // this service is ever called from elsewhere.
    const {
      id,
      mobile,
      email,
      created_at,
      updated_at,
      verification_status,
      subscription_id,
      password_hash,
      business_status,
      source,
      created_by_ai,
      claimed_at,
      claimed_by,
      logo,
      cover_image,
      gallery_images,
      ...updates
    } = data;

    if (email) {
      const normalizedEmail = email.trim().toLowerCase();
      // Must be unique across all three role tables, not just Business —
      // login() resolves by email across Admin/Business/Customer, so a
      // collision with any of them can produce broken or ambiguous login
      // behavior for whichever account matches first.
      const [existingBusiness, existingAdmin, existingCustomer] =
        await Promise.all([
          this.prisma.business.findUnique({
            where: { email: normalizedEmail },
          }),
          this.prisma.admin.findUnique({ where: { email: normalizedEmail } }),
          this.prisma.customer.findUnique({
            where: { email: normalizedEmail },
          }),
        ]);
      if (
        (existingBusiness && existingBusiness.id !== businessId) ||
        existingAdmin ||
        existingCustomer
      ) {
        throw new BadRequestException(
          'This email is already in use by another account',
        );
      }
      updates.email = normalizedEmail;
    }

    return this.prisma.business.update({
      where: { id: businessId },
      data: updates,
    });
  }

  // ── Module 8: WhatsApp lead-alert number + verification ──────────────

  async getWhatsappStatus(businessId: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: {
        mobile: true,
        lead_whatsapp_number: true,
        lead_whatsapp_verified: true,
        notify_whatsapp: true,
      },
    });
    if (!business) {
      throw new NotFoundException('Business profile not found');
    }
    return {
      ...resolveLeadWhatsappNumber(business),
      notify_whatsapp: business.notify_whatsapp,
    };
  }

  async setLeadWhatsappNumber(
    businessId: string,
    number: string | null | undefined,
  ) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { mobile: true },
    });
    if (!business) {
      throw new NotFoundException('Business profile not found');
    }

    const trimmed = number?.trim();

    // Empty/unset, or explicitly set back to the registered mobile — revert
    // to the default, which is treated as verified automatically (no OTP
    // needed, it was already OTP-verified at registration).
    if (!trimmed || trimmed === business.mobile) {
      const updated = await this.prisma.business.update({
        where: { id: businessId },
        data: { lead_whatsapp_number: null, lead_whatsapp_verified: false },
        select: {
          mobile: true,
          lead_whatsapp_number: true,
          lead_whatsapp_verified: true,
        },
      });
      return { ...resolveLeadWhatsappNumber(updated), otpSent: false };
    }

    if (!/^\d{10,15}$/.test(trimmed)) {
      throw new BadRequestException('WhatsApp number must be 10-15 digits');
    }

    await this.prisma.business.update({
      where: { id: businessId },
      data: { lead_whatsapp_number: trimmed, lead_whatsapp_verified: false },
    });

    const code = Math.floor(Math.random() * 1_000_000)
      .toString()
      .padStart(6, '0');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await this.prisma.otpVerification.create({
      data: { mobile: trimmed, code, expires_at: expiresAt },
    });

    const phoneNumberId = this.whatsappService.getSenderPhoneNumberId();
    let otpSent = false;
    if (phoneNumberId) {
      const result = await this.whatsappService.sendTextMessage(
        trimmed,
        phoneNumberId,
        `Your Pairley WhatsApp verification code is ${code}. It expires in 5 minutes.`,
      );
      otpSent = result.success;
    }

    return { number: trimmed, verified: false, isDefault: false, otpSent };
  }

  async verifyLeadWhatsappNumber(businessId: string, code: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: {
        mobile: true,
        lead_whatsapp_number: true,
        lead_whatsapp_verified: true,
      },
    });
    if (!business) {
      throw new NotFoundException('Business profile not found');
    }
    if (!business.lead_whatsapp_number) {
      throw new BadRequestException('No pending WhatsApp number to verify');
    }

    const record = await this.prisma.otpVerification.findFirst({
      where: { mobile: business.lead_whatsapp_number, code },
      orderBy: { created_at: 'desc' },
    });
    if (!record) {
      throw new BadRequestException('Invalid verification code');
    }
    if (new Date() > record.expires_at) {
      throw new BadRequestException('Verification code has expired');
    }
    await this.prisma.otpVerification.deleteMany({
      where: { mobile: business.lead_whatsapp_number },
    });

    const updated = await this.prisma.business.update({
      where: { id: businessId },
      data: { lead_whatsapp_verified: true },
      select: {
        mobile: true,
        lead_whatsapp_number: true,
        lead_whatsapp_verified: true,
      },
    });
    return resolveLeadWhatsappNumber(updated);
  }

  async uploadMedia(
    businessId: string,
    files: {
      logo?: Express.Multer.File[];
      cover_image?: Express.Multer.File[];
      gallery?: Express.Multer.File[];
    },
  ) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
    });
    if (!business) {
      throw new NotFoundException('Business not found');
    }

    const updateData: any = {};

    if (files.logo && files.logo.length > 0) {
      updateData.logo = await this.storageService.uploadFile(
        files.logo[0],
        'businesses/logo',
      );
    }

    if (files.cover_image && files.cover_image.length > 0) {
      updateData.cover_image = await this.storageService.uploadFile(
        files.cover_image[0],
        'businesses/cover',
      );
    }

    if (files.gallery && files.gallery.length > 0) {
      const uploaded = await Promise.all(
        files.gallery.map((file) =>
          this.storageService.uploadFile(file, 'businesses/gallery'),
        ),
      );
      // Append to the existing gallery rather than replacing it, so repeated
      // upload calls over time accumulate images instead of overwriting.
      updateData.gallery_images = [...business.gallery_images, ...uploaded];
    }

    if (Object.keys(updateData).length === 0) {
      throw new BadRequestException('No files provided');
    }

    return this.prisma.business.update({
      where: { id: businessId },
      data: updateData,
    });
  }

  async removeGalleryImage(businessId: string, url: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
    });
    if (!business) {
      throw new NotFoundException('Business not found');
    }
    return this.prisma.business.update({
      where: { id: businessId },
      data: {
        gallery_images: business.gallery_images.filter((img) => img !== url),
      },
    });
  }

  async uploadDocuments(
    businessId: string,
    files: {
      shop_photo?: Express.Multer.File[];
      aadhaar?: Express.Multer.File[];
      pan?: Express.Multer.File[];
      gst?: Express.Multer.File[];
    },
  ) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
    });
    if (!business) {
      throw new NotFoundException('Business not found');
    }

    const updateData: any = {};

    if (files.shop_photo && files.shop_photo.length > 0) {
      updateData.shop_photo = await this.storageService.uploadFile(
        files.shop_photo[0],
        'shops',
      );
    }

    if (files.aadhaar && files.aadhaar.length > 0) {
      // Module 12 Phase 1 — fixed: this was writing the uploaded file's
      // URL into aadhaar_number (the text ID-number field), not
      // aadhaar_photo (the document-image field) — googleUpsert() in
      // auth.service.ts always used the correct field; this call site
      // didn't. aadhaar_number is left untouched here — it's a separate,
      // merchant-entered text value with no relation to the uploaded file.
      updateData.aadhaar_photo = await this.storageService.uploadFile(
        files.aadhaar[0],
        'documents',
      );
    }

    if (files.pan && files.pan.length > 0) {
      // Same fix as aadhaar above.
      updateData.pan_photo = await this.storageService.uploadFile(
        files.pan[0],
        'documents',
      );
    }

    if (files.gst && files.gst.length > 0) {
      updateData.gst_number = await this.storageService.uploadFile(
        files.gst[0],
        'documents',
      );
    }

    return this.prisma.business.update({
      where: { id: businessId },
      data: updateData,
    });
  }

  async getSubscription(businessId: string) {
    const sub = await this.prisma.subscription.findFirst({
      where: { business_id: businessId },
      orderBy: { created_at: 'desc' },
    });

    if (!sub) {
      return { status: 'None', plan_name: null, expiry_date: null };
    }

    return sub;
  }
}
