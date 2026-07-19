import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/services/storage.service';

@Injectable()
export class BusinessService {
  constructor(
    private prisma: PrismaService,
    private storageService: StorageService,
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
      const [existingBusiness, existingAdmin, existingCustomer] = await Promise.all([
        this.prisma.business.findUnique({ where: { email: normalizedEmail } }),
        this.prisma.admin.findUnique({ where: { email: normalizedEmail } }),
        this.prisma.customer.findUnique({ where: { email: normalizedEmail } }),
      ]);
      if ((existingBusiness && existingBusiness.id !== businessId) || existingAdmin || existingCustomer) {
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
      // Aadhaar number and file URL
      updateData.aadhaar_number = await this.storageService.uploadFile(
        files.aadhaar[0],
        'documents',
      );
    }

    if (files.pan && files.pan.length > 0) {
      updateData.pan_number = await this.storageService.uploadFile(
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
