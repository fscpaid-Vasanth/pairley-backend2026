import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Patch,
  Query,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Role, Roles } from '../common/decorators/roles.decorator';
import { OfferPublisherService } from './offer-publisher.service';

const SHEET_ROW_MAX_LEN = 2000;

// 15MB matches FileValidationService's own ceiling for every other image
// upload path in this app.
const IMAGE_UPLOAD_LIMIT_BYTES = 15 * 1024 * 1024;
const MAX_IMAGE_FILES_PER_REQUEST = 500;
// 250MB matches bulk-import's own ZIP size ceiling.
const ZIP_UPLOAD_LIMIT_BYTES = 250 * 1024 * 1024;

class UpdateDraftDto {
  @IsOptional() @IsString() @MaxLength(SHEET_ROW_MAX_LEN) merchantName?: string;
  @IsOptional() @IsString() @MaxLength(20) mobile?: string;
  @IsOptional() @IsString() @MaxLength(20) whatsapp?: string;
  @IsOptional() @IsString() @MaxLength(200) email?: string;
  @IsOptional() @IsString() @MaxLength(200) city?: string;
  @IsOptional() @IsString() @MaxLength(200) area?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() @MaxLength(100) state?: string;
  @IsOptional() @IsString() @MaxLength(20) pincode?: string;
  @IsOptional() @IsString() @MaxLength(1000) googleMapsLink?: string;
  @IsOptional() @IsString() @MaxLength(200) category?: string;
  @IsOptional() @IsString() @MaxLength(SHEET_ROW_MAX_LEN) title?: string;
  @IsOptional() @IsString() @MaxLength(SHEET_ROW_MAX_LEN) description?: string;
  @IsOptional() @IsNumber() originalPrice?: number;
  @IsOptional() @IsNumber() offerPrice?: number;
  @IsOptional() @IsNumber() minParticipants?: number;
  @IsOptional() @IsString() startDate?: string;
  @IsOptional() @IsString() endDate?: string;
  @IsOptional() @IsString() @MaxLength(SHEET_ROW_MAX_LEN) terms?: string;
}

class RejectDraftDto {
  @IsOptional() @IsString() @MaxLength(SHEET_ROW_MAX_LEN) reason?: string;
}

/**
 * Offer Publisher — the image-first, single-offer admin publishing flow
 * that replaced spreadsheet bulk-import. Admin-only throughout, same as
 * bulk-import before it: no merchant or customer ever reaches this surface.
 */
@Controller('admin/offer-publisher')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class OfferPublisherController {
  constructor(private readonly offerPublisherService: OfferPublisherService) {}

  @Post('drafts')
  @UseInterceptors(
    FilesInterceptor('files', MAX_IMAGE_FILES_PER_REQUEST, {
      limits: { fileSize: IMAGE_UPLOAD_LIMIT_BYTES },
    }),
  )
  async createDrafts(
    @UploadedFiles() files: Express.Multer.File[] | undefined,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files provided');
    }
    return this.offerPublisherService.createDraftsFromFiles(files);
  }

  @Post('drafts/zip')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: ZIP_UPLOAD_LIMIT_BYTES } }),
  )
  async createDraftsFromZip(
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    return this.offerPublisherService.createDraftsFromZip(file);
  }

  @Get('drafts')
  async listDrafts(@Query('ids') ids?: string) {
    const idList = (ids || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return this.offerPublisherService.listDrafts(idList);
  }

  @Get('businesses/search')
  async searchBusinesses(@Query('q') q: string) {
    return this.offerPublisherService.searchBusinesses(q);
  }

  @Get('drafts/:id')
  async getDraft(@Param('id') id: string) {
    return this.offerPublisherService.getDraft(id);
  }

  @Patch('drafts/:id')
  async updateDraft(@Param('id') id: string, @Body() body: UpdateDraftDto) {
    return this.offerPublisherService.updateDraft(id, body);
  }

  @Post('drafts/:id/gallery')
  @UseInterceptors(
    FilesInterceptor('files', 20, {
      limits: { fileSize: IMAGE_UPLOAD_LIMIT_BYTES },
    }),
  )
  async addGalleryImage(
    @Param('id') id: string,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files provided');
    }
    return this.offerPublisherService.addGalleryImage(id, files);
  }

  @Delete('drafts/:id/gallery')
  async removeGalleryImage(@Param('id') id: string, @Query('url') url: string) {
    if (!url) throw new BadRequestException('url query parameter is required');
    return this.offerPublisherService.removeGalleryImage(id, url);
  }

  @Delete('drafts/:id')
  async deleteDraft(@Param('id') id: string) {
    await this.offerPublisherService.deleteDraft(id);
    return { deleted: true };
  }

  @Post('drafts/:id/approve')
  async approve(@Param('id') id: string) {
    return this.offerPublisherService.approveDraft(id);
  }

  @Post('drafts/:id/reject')
  async reject(@Param('id') id: string, @Body() body: RejectDraftDto) {
    return this.offerPublisherService.rejectDraft(id, body.reason);
  }

  @Post('drafts/:id/publish')
  async publish(@Param('id') id: string) {
    return this.offerPublisherService.publishDraft(id);
  }
}
