import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Body,
  UseGuards,
  Query,
} from '@nestjs/common';
import { CustomerService } from './customer.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, Role } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  IsNotEmpty,
  IsString,
  IsEmail,
  IsOptional,
  IsDateString,
  IsBoolean,
} from 'class-validator';

class SaveOfferDto {
  @IsString()
  @IsNotEmpty()
  offerId: string;
}

// Whitelist for customer-editable profile fields — previously this endpoint
// took `@Body() body: any` with only a 5-field deny-list at the service
// layer, the weakest-guarded profile-update endpoint in the codebase.
// Matches the UpdateBusinessProfileDto pattern established in Module 1/2.
class UpdateCustomerProfileDto {
  @IsString() @IsOptional() name?: string;
  @IsEmail() @IsOptional() email?: string;
  @IsString() @IsOptional() city?: string;
  @IsString() @IsOptional() state?: string;
  @IsString() @IsOptional() address?: string;
  @IsString() @IsOptional() pincode?: string;
  @IsString() @IsOptional() profile_photo?: string;
  @IsString() @IsOptional() gender?: string;
  @IsDateString() @IsOptional() date_of_birth?: string;
  @IsOptional() age?: number;
  @IsBoolean() @IsOptional() notify_email?: boolean;
  @IsBoolean() @IsOptional() notify_push?: boolean;
  @IsBoolean() @IsOptional() notify_matching?: boolean;
}

@Controller('customers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.CUSTOMER)
export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  @Get('profile')
  async getProfile(@CurrentUser() user: any) {
    return this.customerService.getProfile(user.sub);
  }

  @Put('profile')
  async updateProfile(
    @CurrentUser() user: any,
    @Body() body: UpdateCustomerProfileDto,
  ) {
    return this.customerService.updateProfile(user.sub, body);
  }

  @Get('history')
  async getHistory(@CurrentUser() user: any) {
    return this.customerService.getHistory(user.sub);
  }

  @Get('saved-offers')
  async getSavedOffers(@CurrentUser() user: any) {
    return this.customerService.getSavedOffers(user.sub);
  }

  @Post('save-offer')
  async saveOffer(@CurrentUser() user: any, @Body() body: SaveOfferDto) {
    return this.customerService.saveOffer(user.sub, body.offerId);
  }

  @Delete('save-offer')
  async unsaveOffer(
    @CurrentUser() user: any,
    @Query('offerId') offerId: string,
  ) {
    return this.customerService.unsaveOffer(user.sub, offerId);
  }
}
