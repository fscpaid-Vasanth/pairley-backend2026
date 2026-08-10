import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ArrayNotEmpty, IsArray, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';
import { AiOfferFromOnlineStatus } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Role, Roles } from '../common/decorators/roles.decorator';
import { AiOffersFromOnlineService } from './ai-offers-from-online.service';

const FIELD_MAX_LEN = 2000;
const BANNER_UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;
const STATUSES = Object.values(AiOfferFromOnlineStatus);

class ImportExportedOfferDto {
  @IsString() @MaxLength(200) collectorOfferId!: string;
  @IsString() @MaxLength(FIELD_MAX_LEN) merchantName!: string;
  @IsOptional() @IsString() @MaxLength(50) mobile?: string;
  @IsOptional() @IsString() @MaxLength(50) whatsapp?: string;
  @IsOptional() @IsString() @MaxLength(200) category?: string;
  @IsString() @MaxLength(500) address!: string;
  @IsOptional() @IsString() @MaxLength(200) city?: string;
  @IsString() @MaxLength(FIELD_MAX_LEN) offerTitle!: string;
  @IsOptional() @IsString() @MaxLength(FIELD_MAX_LEN) description?: string;
  @IsOptional() originalPrice?: string;
  // Required by architecture, but typed optional here because it arrives as
  // a multipart string — the service does the real presence check so the
  // refusal message can explain *why* a price is mandatory.
  @IsOptional() offerPrice?: string;
  @IsOptional() @IsString() validityStart?: string;
  @IsOptional() @IsString() validityEnd?: string;
  @IsOptional() @IsString() @MaxLength(FIELD_MAX_LEN) terms?: string;
  @IsOptional() @IsString() @MaxLength(1000) sourceUrl?: string;
  @IsOptional() @IsString() @MaxLength(100) sourceType?: string;
  // Arrives as a JSON string over multipart — parsed in the controller.
  @IsOptional() @IsString() fieldProvenance?: string;
}

class MatchBusinessDto {
  @IsString() businessId!: string;
}

class CorrectOfferDto {
  @IsOptional() @IsString() @MaxLength(FIELD_MAX_LEN) merchantName?: string;
  @IsOptional() @IsString() @MaxLength(50) mobile?: string;
  @IsOptional() @IsString() @MaxLength(50) whatsapp?: string;
  @IsOptional() @IsString() @MaxLength(200) category?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() @MaxLength(200) city?: string;
  @IsOptional() @IsString() @MaxLength(FIELD_MAX_LEN) offerTitle?: string;
  @IsOptional() @IsString() @MaxLength(FIELD_MAX_LEN) description?: string;
  @IsOptional() @IsNumber() originalPrice?: number;
  @IsOptional() @IsNumber() offerPrice?: number;
  @IsOptional() @IsString() @MaxLength(FIELD_MAX_LEN) terms?: string;
}

class PublishSelectedDto {
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) ids!: string[];
}

class RejectOfferDto {
  @IsOptional() @IsString() @MaxLength(FIELD_MAX_LEN) reason?: string;
}

/**
 * "AI Offers From Online" — the Pairley Admin queue of offers exported from
 * the standalone AI Offer Collector, each arriving with the exact banner a
 * human already approved over there. Admin-only throughout, same guard
 * stack as Offer Publisher and Claim Requests. Nothing here becomes a real
 * Business/Offer without an explicit admin decision.
 */
@Controller('admin/ai-offers-from-online')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AiOffersFromOnlineController {
  constructor(private readonly service: AiOffersFromOnlineService) {}

  /**
   * "Export to Pairley" lands here. The Collector authenticates as a real
   * Pairley admin user's bearer JWT — the same credential/direction it
   * already uses for Offer Publisher's businesses/search — never a machine
   * credential, and never the reverse direction (Pairley never calls the
   * Collector).
   */
  @Post('import')
  @UseInterceptors(FileInterceptor('banner', { limits: { fileSize: BANNER_UPLOAD_LIMIT_BYTES } }))
  async importExportedOffer(@Body() body: ImportExportedOfferDto, @UploadedFile() banner: Express.Multer.File | undefined) {
    let fieldProvenance: Record<string, string> | undefined;
    if (body.fieldProvenance) {
      try {
        fieldProvenance = JSON.parse(body.fieldProvenance);
      } catch {
        throw new BadRequestException('fieldProvenance must be valid JSON');
      }
    }
    return this.service.importExportedOffer(
      {
        collectorOfferId: body.collectorOfferId,
        merchantName: body.merchantName,
        mobile: body.mobile,
        whatsapp: body.whatsapp,
        category: body.category,
        address: body.address,
        city: body.city,
        offerTitle: body.offerTitle,
        description: body.description,
        originalPrice: body.originalPrice !== undefined ? Number(body.originalPrice) : undefined,
        offerPrice: body.offerPrice !== undefined ? Number(body.offerPrice) : undefined,
        validityStart: body.validityStart,
        validityEnd: body.validityEnd,
        terms: body.terms,
        sourceUrl: body.sourceUrl,
        sourceType: body.sourceType,
        fieldProvenance,
      },
      banner,
    );
  }

  @Get()
  list(@Query('status') status?: string) {
    const parsed = status && STATUSES.includes(status as AiOfferFromOnlineStatus) ? (status as AiOfferFromOnlineStatus) : undefined;
    return this.service.list(parsed);
  }

  @Get('businesses/search')
  searchBusinesses(@Query('q') q: string) {
    return this.service.searchBusinesses(q);
  }

  /** Publish Selected — bulk, each offer processed independently. */
  @Post('publish-selected')
  publishSelected(@Body() body: PublishSelectedDto) {
    return this.service.publishSelected(body.ids);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Put(':id/match-business')
  matchBusiness(@Param('id') id: string, @Body() body: MatchBusinessDto) {
    return this.service.matchBusiness(id, body.businessId);
  }

  @Put(':id/create-merchant')
  createMerchant(@Param('id') id: string) {
    return this.service.createMerchant(id);
  }

  @Patch(':id')
  correct(@Param('id') id: string, @Body() body: CorrectOfferDto) {
    return this.service.correct(id, body);
  }

  @Post(':id/publish')
  publish(@Param('id') id: string) {
    return this.service.publish(id);
  }

  @Post(':id/reject')
  reject(@Param('id') id: string, @Body() body: RejectOfferDto) {
    return this.service.reject(id, body.reason);
  }
}
