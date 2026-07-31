import {
  Controller,
  Get,
  Post,
  Param,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Role, Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { BulkImportService } from './bulk-import.service';
import { BulkImageImportService } from './bulk-image-import.service';

// 25MB matches sheetFileValidation's own ceiling for the offer sheet.
const SHEET_UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;
// 15MB per image, matching FileValidationService's existing ceiling for
// every other image upload path in the app.
const IMAGE_UPLOAD_LIMIT_BYTES = 15 * 1024 * 1024;
const MAX_IMAGE_FILES_PER_REQUEST = 500;
// 250MB matches bulk-image-import.service.ts's own ZIP size ceiling.
const ZIP_UPLOAD_LIMIT_BYTES = 250 * 1024 * 1024;

/**
 * Bulk Offer Import — the Diwali-launch replacement for the AI Discovery
 * Tool. Thin by design, same discipline as banner.controller.ts before it:
 * every decision lives in BulkImportService / BulkImageImportService /
 * bulkOfferValidation.ts, this file only maps HTTP to those. Admin-only
 * throughout — no merchant or customer ever reaches this surface.
 */
@Controller('admin/bulk-import')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class BulkImportController {
  constructor(
    private readonly bulkImportService: BulkImportService,
    private readonly bulkImageImportService: BulkImageImportService,
  ) {}

  @Get('history')
  listHistory() {
    return this.bulkImportService.listHistory();
  }

  @Get(':id')
  getBatch(@Param('id') id: string) {
    return this.bulkImportService.getBatch(id);
  }

  @Get(':id/preview')
  getPreview(@Param('id') id: string) {
    return this.bulkImportService.getPreview(id);
  }

  @Get(':id/errors')
  getErrorRows(@Param('id') id: string) {
    return this.bulkImportService.getErrorRows(id);
  }

  @Post()
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: SHEET_UPLOAD_LIMIT_BYTES } }),
  )
  async uploadSheet(
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() admin: { sub: string },
  ) {
    if (!file) throw new BadRequestException('No file provided');
    return this.bulkImportService.createBatch(
      file,
      admin?.sub ?? 'unknown-admin',
    );
  }

  @Post(':id/create-drafts')
  createDrafts(@Param('id') id: string) {
    return this.bulkImportService.startCreatingDrafts(id);
  }

  @Post(':id/publish')
  publish(@Param('id') id: string) {
    return this.bulkImportService.startPublishing(id);
  }

  @Post(':id/images')
  @UseInterceptors(
    FilesInterceptor('files', MAX_IMAGE_FILES_PER_REQUEST, {
      limits: { fileSize: IMAGE_UPLOAD_LIMIT_BYTES },
    }),
  )
  async uploadImages(
    @Param('id') id: string,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files provided');
    }
    await this.bulkImageImportService.uploadImageFiles(id, files);
    return this.bulkImportService.getBatch(id);
  }

  @Post(':id/images/zip')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: ZIP_UPLOAD_LIMIT_BYTES } }),
  )
  async uploadImageZip(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    await this.bulkImageImportService.uploadImageZip(id, file);
    return this.bulkImportService.getBatch(id);
  }
}
