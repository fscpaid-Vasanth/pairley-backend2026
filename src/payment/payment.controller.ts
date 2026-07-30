import { Controller, Post, Get, Body, UseGuards } from '@nestjs/common';
import { PaymentModuleService } from './payment.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, Role } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { IsNotEmpty, IsNumber, IsString } from 'class-validator';

class CreateOrderDto {
  @IsNumber()
  @IsNotEmpty()
  amount: number;

  @IsString()
  @IsNotEmpty()
  receipt: string;
}

class VerifyPaymentDto {
  @IsString()
  @IsNotEmpty()
  paymentId: string;

  @IsString()
  @IsNotEmpty()
  orderId: string;

  @IsString()
  @IsNotEmpty()
  signature: string;
}

@Controller('payment')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.BUSINESS)
export class PaymentController {
  constructor(private readonly paymentModuleService: PaymentModuleService) {}

  @Post('create-order')
  async createOrder(@Body() body: CreateOrderDto) {
    return this.paymentModuleService.createOrder(body.amount, body.receipt);
  }

  @Post('verify')
  async verify(@Body() body: VerifyPaymentDto) {
    return this.paymentModuleService.verify(
      body.paymentId,
      body.orderId,
      body.signature,
    );
  }

  @Get('history')
  async getHistory(@CurrentUser() user: any) {
    return this.paymentModuleService.getHistory(user.sub);
  }
}
