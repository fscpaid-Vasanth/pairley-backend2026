import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Query,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFiles,
  BadRequestException,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { OfferService } from './offer.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, Role } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  IsNotEmpty,
  IsString,
  IsNumberString,
  IsOptional,
  IsIn,
  IsNumber,
  Min,
  Max,
} from 'class-validator';

// Legacy values kept for backward compatibility; STANDARD is the new default.
// See prisma/schema.prisma's OfferType enum comment for the full split.
const OFFER_TYPES = [
  'BOGO',
  'BOGT',
  'GROUP_DISCOUNT',
  'BULK_PURCHASE',
  'MEMBERSHIP_CAMPAIGN',
  'PACKAGE_DEAL',
  'STANDARD',
  'BUY_X_GET_Y',
  'FLAT_DISCOUNT',
  'PERCENTAGE_DISCOUNT',
  'CASHBACK',
  'COMBO',
  'SEASONAL',
  'FESTIVAL',
  'FLASH_DEAL',
  'LIMITED_QUANTITY',
  'LIMITED_TIME',
] as const;

// Statuses a merchant may set directly via PUT /offers/:id/status. CLOSED is
// system-set only (legacy matching capacity reached); ARCHIVED is set via the
// dedicated archive action, not this endpoint, to keep the two concerns
// separate at the API surface even though both ultimately write `status`.
const MERCHANT_SETTABLE_STATUSES = ['ACTIVE', 'PAUSED', 'DRAFT'] as const;

class CreateOfferDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsNotEmpty()
  description: string;

  @IsIn(OFFER_TYPES)
  offer_type: string;

  @IsString()
  @IsNotEmpty()
  category: string;

  @IsNumberString()
  original_price: string;

  @IsNumberString()
  offer_price: string;

  @IsNumberString()
  required_people: string;

  @IsString()
  @IsNotEmpty()
  start_date: string;

  @IsString()
  @IsNotEmpty()
  end_date: string;

  // Legacy fields — still accepted for backward compatibility with any
  // caller still using them, but new code should use cover_image/
  // gallery_images below instead.
  @IsString()
  @IsOptional()
  offer_image?: string;

  @IsOptional()
  facility_images?: string[];

  @IsString()
  @IsOptional()
  facility_details?: string;

  @IsString()
  @IsOptional()
  whatsapp_number?: string;

  // Module 3 media model
  @IsString()
  @IsOptional()
  cover_image?: string;

  @IsOptional()
  gallery_images?: string[];

  // Location override — omit to inherit the business's own geo_lat/geo_lng
  @IsNumber()
  @Min(-90)
  @Max(90)
  @IsOptional()
  geo_lat?: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  @IsOptional()
  geo_lng?: number;
}

// Deliberately excludes business_id, created_at, updated_at, source,
// confidence_score, imported_at, review_required, original_import_url,
// original_import_source, merchant_verified, is_pairley_exclusive, and
// status (status changes go through PUT /offers/:id/status instead) — all
// admin/AI/system-only, never merchant-editable via this endpoint.
class UpdateOfferDto {
  @IsString() @IsOptional() title?: string;
  @IsString() @IsOptional() description?: string;
  @IsIn(OFFER_TYPES) @IsOptional() offer_type?: string;
  @IsString() @IsOptional() category?: string;
  @IsNumberString() @IsOptional() original_price?: string;
  @IsNumberString() @IsOptional() offer_price?: string;
  @IsNumberString() @IsOptional() required_people?: string;
  @IsString() @IsOptional() start_date?: string;
  @IsString() @IsOptional() end_date?: string;
  @IsString() @IsOptional() whatsapp_number?: string;
  @IsString() @IsOptional() cover_image?: string;
  @IsOptional() gallery_images?: string[];
  @IsNumber() @Min(-90) @Max(90) @IsOptional() geo_lat?: number;
  @IsNumber() @Min(-180) @Max(180) @IsOptional() geo_lng?: number;
}

class UpdateOfferStatusDto {
  @IsIn(MERCHANT_SETTABLE_STATUSES)
  status: string;
}

class InterestDto {
  @IsString()
  @IsNotEmpty()
  offerId: string;
}

@Controller('offers')
export class OfferController {
  constructor(private readonly offerService: OfferService) {}

  @Post('create')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.BUSINESS)
  async createOffer(@CurrentUser() user: any, @Body() body: CreateOfferDto) {
    return this.offerService.createOffer(user.sub, body);
  }

  @Put('update/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.BUSINESS)
  async updateOffer(
    @CurrentUser() user: any,
    @Param('id') offerId: string,
    @Body() body: UpdateOfferDto,
  ) {
    return this.offerService.updateOffer(user.sub, offerId, body);
  }

  @Put(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.BUSINESS)
  async updateOfferStatus(
    @CurrentUser() user: any,
    @Param('id') offerId: string,
    @Body() body: UpdateOfferStatusDto,
  ) {
    return this.offerService.updateOfferStatus(user.sub, offerId, body.status);
  }

  @Post(':id/media')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.BUSINESS)
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'cover_image', maxCount: 1 },
      { name: 'gallery', maxCount: 10 },
    ]),
  )
  async uploadOfferMedia(
    @CurrentUser() user: any,
    @Param('id') offerId: string,
    @UploadedFiles()
    files: {
      cover_image?: Express.Multer.File[];
      gallery?: Express.Multer.File[];
    },
  ) {
    return this.offerService.uploadOfferMedia(user.sub, offerId, files);
  }

  @Delete(':id/media/gallery')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.BUSINESS)
  async removeOfferGalleryImage(
    @CurrentUser() user: any,
    @Param('id') offerId: string,
    @Query('url') url: string,
  ) {
    if (!url) {
      throw new BadRequestException('url query parameter is required');
    }
    return this.offerService.removeOfferGalleryImage(user.sub, offerId, url);
  }

  @Delete('delete/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.BUSINESS)
  async deleteOffer(@CurrentUser() user: any, @Param('id') offerId: string) {
    return this.offerService.deleteOffer(user.sub, offerId);
  }

  @Get('list')
  async listOffers(
    @Query('category') category?: string,
    @Query('businessId') businessId?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('mall') mall?: string,
  ) {
    return this.offerService.listOffers({
      category,
      businessId,
      search,
      status,
      mall,
    });
  }

  // Public detail route — interested-customer PII (interests[].customer) is
  // only included in the response when the caller is authenticated as the
  // offer's own business. Anonymous/other callers get everything except that.
  @Get('details/:id')
  @UseGuards(OptionalJwtAuthGuard)
  async getDetails(@Param('id') id: string, @CurrentUser() user: any) {
    return this.offerService.getDetails(id, user?.sub);
  }

  @Get('category/:category')
  async getByCategory(@Param('category') category: string) {
    return this.offerService.getOffersByCategory(category);
  }

  @Post('interest')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CUSTOMER)
  async expressInterest(@CurrentUser() user: any, @Body() body: InterestDto) {
    return this.offerService.expressInterest(user.sub, body.offerId);
  }

  @Post('lead')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CUSTOMER)
  async createLead(@CurrentUser() user: any, @Body() body: InterestDto) {
    return this.offerService.createLead(user.sub, body.offerId);
  }

  @Post('ready-to-buy')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CUSTOMER)
  async declareReadyToBuy(@CurrentUser() user: any, @Body() body: InterestDto) {
    return this.offerService.declareReadyToBuy(user.sub, body.offerId);
  }

  @Get('interested-customers')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.BUSINESS)
  async getInterestedCustomers(@CurrentUser() user: any) {
    return this.offerService.getInterestedCustomers(user.sub);
  }

  @Put('interest/:id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.BUSINESS)
  async updateInterestStatus(
    @CurrentUser() user: any,
    @Param('id') interestId: string,
    @Body('status') status: string,
  ) {
    return this.offerService.updateInterestStatus(user.sub, interestId, status);
  }

  @Post('chat/:dealId')
  @UseGuards(JwtAuthGuard)
  async sendCoBuyMessage(
    @CurrentUser() user: any,
    @Param('dealId') dealId: string,
    @Body() body: any,
  ) {
    return this.offerService.sendCoBuyMessage(user.sub, dealId, body);
  }

  @Get('chat/:dealId')
  @UseGuards(JwtAuthGuard)
  async getCoBuyMessages(@Param('dealId') dealId: string) {
    return this.offerService.getCoBuyMessages(dealId);
  }
}
