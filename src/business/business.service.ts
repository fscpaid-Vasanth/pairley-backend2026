import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/services/storage.service';

@Injectable()
export class BusinessService {
  constructor(
    private prisma: PrismaService,
    private storageService: StorageService
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
    // claim-flow-only — never self-editable via this endpoint. Same restriction
    // as auth.service.ts's updateProfile(), applied here since this is a second,
    // separate write path to the same Business row.
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
      ...updates
    } = data;
    return this.prisma.business.update({
      where: { id: businessId },
      data: updates,
    });
  }

  async uploadDocuments(
    businessId: string,
    files: {
      shop_photo?: Express.Multer.File[];
      aadhaar?: Express.Multer.File[];
      pan?: Express.Multer.File[];
      gst?: Express.Multer.File[];
    }
  ) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) {
      throw new NotFoundException('Business not found');
    }

    const updateData: any = {};

    if (files.shop_photo && files.shop_photo.length > 0) {
      updateData.shop_photo = await this.storageService.uploadFile(files.shop_photo[0], 'shops');
    }

    if (files.aadhaar && files.aadhaar.length > 0) {
      // Aadhaar number and file URL
      updateData.aadhaar_number = await this.storageService.uploadFile(files.aadhaar[0], 'documents');
    }

    if (files.pan && files.pan.length > 0) {
      updateData.pan_number = await this.storageService.uploadFile(files.pan[0], 'documents');
    }

    if (files.gst && files.gst.length > 0) {
      updateData.gst_number = await this.storageService.uploadFile(files.gst[0], 'documents');
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
