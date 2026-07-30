import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { SubscriptionService } from './subscription.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, Role } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { IsNotEmpty, IsString } from 'class-validator';

class SubscribeDto {
  @IsString()
  @IsNotEmpty()
  planName: string;

  @IsString()
  @IsNotEmpty()
  paymentReference: string;
}

class RenewDto {
  @IsString()
  @IsNotEmpty()
  paymentReference: string;
}

@Controller('subscription')
export class SubscriptionController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  @Get('plans')
  async getPlans() {
    return this.subscriptionService.getPlans();
  }

  @Post('subscribe')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.BUSINESS)
  async subscribe(@CurrentUser() user: any, @Body() body: SubscribeDto) {
    return this.subscriptionService.subscribe(
      user.sub,
      body.planName,
      body.paymentReference,
    );
  }

  @Post('renew')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.BUSINESS)
  async renew(@CurrentUser() user: any, @Body() body: RenewDto) {
    return this.subscriptionService.renew(user.sub, body.paymentReference);
  }

  @Get('history')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.BUSINESS)
  async getHistory(@CurrentUser() user: any) {
    return this.subscriptionService.getHistory(user.sub);
  }

  @Get('current')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.BUSINESS)
  async getCurrent(@CurrentUser() user: any) {
    return this.subscriptionService.getCurrent(user.sub);
  }
}
