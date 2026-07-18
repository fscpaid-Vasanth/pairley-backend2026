import { Controller, Get, Put, Post, Body, UseGuards, UseInterceptors, UploadedFiles, Query, Res, HttpStatus } from '@nestjs/common';
import { BusinessService } from './business.service';
import { AuthService } from '../auth/auth.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, Role } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { StorageService } from '../common/services/storage.service';
import * as path from 'path';

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
  async getDocumentPreview(@Query('url') url: string, @Query('download') download: string, @Res() res: any) {
    if (!url) {
      return res.status(HttpStatus.BAD_REQUEST).json({ message: 'URL query parameter is required' });
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
          return res.status(HttpStatus.BAD_REQUEST).json({ message: 'Invalid URL format' });
        }
      } else if (url.startsWith('/uploads/')) {
        key = url.replace(/^\/uploads\//, '');
      } else {
        key = url;
      }

      // Sanitize key to prevent path traversal
      const normalizedPath = path.normalize(key).replace(/^(\.\.(\/|\\))+/, '');

      const { buffer, contentType } = await this.storageService.getFile(normalizedPath);
      res.setHeader('Content-Type', contentType);
      
      if (download === 'true') {
        const filename = path.basename(normalizedPath);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      }
      
      return res.send(buffer);
    } catch (error) {
      return res.status(HttpStatus.NOT_FOUND).json({ message: error.message || 'File not found' });
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
  async updateProfile(@CurrentUser() user: any, @Body() body: any) {
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
    ])
  )
  async uploadDocuments(
    @CurrentUser() user: any,
    @UploadedFiles()
    files: {
      shop_photo?: Express.Multer.File[];
      aadhaar?: Express.Multer.File[];
      pan?: Express.Multer.File[];
      gst?: Express.Multer.File[];
    }
  ) {
    return this.businessService.uploadDocuments(user.sub, files);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.BUSINESS)
  @Get('subscription')
  async getSubscription(@CurrentUser() user: any) {
    return this.businessService.getSubscription(user.sub);
  }
}
