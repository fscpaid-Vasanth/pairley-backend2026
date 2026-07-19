import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFiles,
  Query,
  Res,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { BusinessService } from './business.service';
import { AuthService } from '../auth/auth.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, Role } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { StorageService } from '../common/services/storage.service';
import * as path from 'path';
import {
  IsString,
  IsOptional,
  IsEmail,
  IsIn,
  IsNumber,
  IsObject,
  Min,
  Max,
} from 'class-validator';

// Deliberately excludes mobile, password_hash, business_status, source,
// created_by_ai, claimed_at, claimed_by, verification_status, subscription_id
// — with the global ValidationPipe's forbidNonWhitelisted, sending any of
// those to this endpoint now fails validation instead of being silently
// accepted and stripped downstream. logo/cover_image/gallery_images are
// deliberately not here either — those go through the dedicated media
// upload endpoints below, not this JSON profile update.
class UpdateBusinessProfileDto {
  @IsString() @IsOptional() business_name?: string;
  @IsString() @IsOptional() business_type?: string;
  @IsString() @IsOptional() category?: string;
  @IsEmail() @IsOptional() email?: string;
  @IsString() @IsOptional() address?: string;
  @IsString() @IsOptional() city?: string;
  @IsString() @IsOptional() state?: string;
  @IsString() @IsOptional() pincode?: string;
  @IsString() @IsOptional() mall_name?: string;
  @IsString() @IsOptional() gst_number?: string;
  @IsString() @IsOptional() notification_mobiles?: string;
  @IsString() @IsOptional() description?: string;
  @IsString() @IsOptional() website?: string;
  @IsString() @IsOptional() instagram?: string;
  @IsString() @IsOptional() facebook?: string;
  @IsString() @IsOptional() whatsapp?: string;
  @IsString() @IsOptional() support_number?: string;
  @IsObject() @IsOptional() store_timing?: Record<
    string,
    { open?: string; close?: string; isClosed?: boolean }
  >;
  @IsNumber() @Min(-90) @Max(90) @IsOptional() geo_lat?: number;
  @IsNumber() @Min(-180) @Max(180) @IsOptional() geo_lng?: number;
  @IsIn(['MANUAL', 'AUTOMATIC']) @IsOptional() lead_acceptance_mode?:
    | 'MANUAL'
    | 'AUTOMATIC';
}

@Controller('business')
export class BusinessController {
  constructor(
    private readonly businessService: BusinessService,
    private readonly authService: AuthService,
    private readonly storageService: StorageService,
  ) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @Get('document-preview')
  async getDocumentPreview(
    @Query('url') url: string,
    @Query('download') download: string,
    @Res() res: any,
  ) {
    if (!url) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ message: 'URL query parameter is required' });
    }

    try {
      let key = '';
      if (url.startsWith('http://') || url.startsWith('https://')) {
        try {
          const parsedUrl = new URL(url);
          if (parsedUrl.hostname.includes('.amazonaws.com')) {
            key = parsedUrl.pathname.substring(1);
          } else {
            return res.redirect(url);
          }
        } catch (e) {
          return res
            .status(HttpStatus.BAD_REQUEST)
            .json({ message: 'Invalid URL format' });
        }
      } else if (url.startsWith('/uploads/')) {
        key = url.replace(/^\/uploads\//, '');
      } else {
        key = url;
      }

      // Sanitize key to prevent path traversal
      const normalizedPath = path.normalize(key).replace(/^(\.\.(\/|\\))+/, '');

      const { buffer, contentType } =
        await this.storageService.getFile(normalizedPath);
      res.setHeader('Content-Type', contentType);

      if (download === 'true') {
        const filename = path.basename(normalizedPath);
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${filename}"`,
        );
      }

      return res.send(buffer);
    } catch (error) {
      return res
        .status(HttpStatus.NOT_FOUND)
        .json({ message: error.message || 'File not found' });
    }
  }

  @Post('register')
  async register(@Body() body: any) {
    // Map /business/register directly to the general registration handler with Business role
    return this.authService.register({ ...body, role: 'Business' });
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.BUSINESS)
  @Get('profile')
  async getProfile(@CurrentUser() user: any) {
    return this.businessService.getProfile(user.sub);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.BUSINESS)
  @Put('profile')
  async updateProfile(
    @CurrentUser() user: any,
    @Body() body: UpdateBusinessProfileDto,
  ) {
    return this.businessService.updateProfile(user.sub, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.BUSINESS)
  @Post('upload-documents')
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'shop_photo', maxCount: 1 },
      { name: 'aadhaar', maxCount: 1 },
      { name: 'pan', maxCount: 1 },
      { name: 'gst', maxCount: 1 },
    ]),
  )
  async uploadDocuments(
    @CurrentUser() user: any,
    @UploadedFiles()
    files: {
      shop_photo?: Express.Multer.File[];
      aadhaar?: Express.Multer.File[];
      pan?: Express.Multer.File[];
      gst?: Express.Multer.File[];
    },
  ) {
    return this.businessService.uploadDocuments(user.sub, files);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.BUSINESS)
  @Post('media')
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'logo', maxCount: 1 },
      { name: 'cover_image', maxCount: 1 },
      { name: 'gallery', maxCount: 10 },
    ]),
  )
  async uploadMedia(
    @CurrentUser() user: any,
    @UploadedFiles()
    files: {
      logo?: Express.Multer.File[];
      cover_image?: Express.Multer.File[];
      gallery?: Express.Multer.File[];
    },
  ) {
    return this.businessService.uploadMedia(user.sub, files);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.BUSINESS)
  @Delete('media/gallery')
  async removeGalleryImage(
    @CurrentUser() user: any,
    @Query('url') url: string,
  ) {
    if (!url) {
      throw new BadRequestException('url query parameter is required');
    }
    return this.businessService.removeGalleryImage(user.sub, url);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.BUSINESS)
  @Get('subscription')
  async getSubscription(@CurrentUser() user: any) {
    return this.businessService.getSubscription(user.sub);
  }
}
