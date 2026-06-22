import { Controller, Get, Post, Put, Delete, Body, Query, Param, UseGuards } from '@nestjs/common';
import { OfferService } from './offer.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, Role } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { IsNotEmpty, IsString, IsNumberString, IsOptional } from 'class-validator';

class CreateOfferDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsNotEmpty()
  description: string;

  @IsString()
  @IsNotEmpty()
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
  async updateOffer(@CurrentUser() user: any, @Param('id') offerId: string, @Body() body: any) {
    return this.offerService.updateOffer(user.sub, offerId, body);
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
    @Query('mall') mall?: string
  ) {
    return this.offerService.listOffers({ category, businessId, search, status, mall });
  }

  @Get('details/:id')
  async getDetails(@Param('id') id: string) {
    return this.offerService.getDetails(id);
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
    @Body('status') status: string
  ) {
    return this.offerService.updateInterestStatus(user.sub, interestId, status);
  }

  @Post('chat/:dealId')
  @UseGuards(JwtAuthGuard)
  async sendCoBuyMessage(
    @CurrentUser() user: any,
    @Param('dealId') dealId: string,
    @Body() body: any
  ) {
    return this.offerService.sendCoBuyMessage(user.sub, dealId, body);
  }

  @Get('chat/:dealId')
  @UseGuards(JwtAuthGuard)
  async getCoBuyMessages(
    @Param('dealId') dealId: string
  ) {
    return this.offerService.getCoBuyMessages(dealId);
  }
}

