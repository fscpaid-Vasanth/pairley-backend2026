import {
  Controller,
  Post,
  Body,
  Get,
  Put,
  Delete,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  IsNotEmpty,
  IsString,
  IsEmail,
  IsOptional,
  IsIn,
  Length,
} from 'class-validator';

const REGISTRATION_ROLES = ['Customer', 'Business'] as const;

class SendOtpDto {
  @IsString()
  @IsNotEmpty()
  @Length(10, 15)
  mobile: string;

  // Optional — only used to scope the MERCHANT_OTP_MODE pilot bypass to the
  // Business flow. Customer/admin callers omit this and are completely
  // unaffected either way.
  @IsIn(REGISTRATION_ROLES)
  @IsOptional()
  role?: 'Customer' | 'Business';
}

class VerifyOtpDto {
  @IsString()
  @IsNotEmpty()
  @Length(10, 15)
  mobile: string;

  @IsString()
  @IsNotEmpty()
  @Length(4, 6)
  code: string;

  @IsIn(REGISTRATION_ROLES)
  @IsOptional()
  role?: 'Customer' | 'Business';
}

class RegisterDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  @Length(10, 15)
  mobile: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsIn(REGISTRATION_ROLES)
  role: 'Customer' | 'Business';

  // Extra optional customer fields
  @IsString()
  @IsOptional()
  gender?: string;

  @IsString()
  @IsOptional()
  date_of_birth?: string;

  @IsOptional()
  age?: string | number;

  @IsString()
  @IsOptional()
  referral_code?: string;

  // Extra optional business fields
  @IsString()
  @IsOptional()
  business_name?: string;

  @IsString()
  @IsOptional()
  business_type?: string;

  @IsString()
  @IsOptional()
  category?: string;

  @IsString()
  @IsOptional()
  address?: string;

  @IsString()
  @IsOptional()
  city?: string;

  @IsString()
  @IsOptional()
  state?: string;

  @IsString()
  @IsOptional()
  pincode?: string;

  @IsString()
  @IsOptional()
  aadhaar_number?: string;

  @IsString()
  @IsOptional()
  pan_number?: string;

  @IsString()
  @IsOptional()
  gst_number?: string;

  @IsString()
  @IsOptional()
  password?: string;

  @IsString()
  @IsOptional()
  profile_photo?: string;

  @IsString()
  @IsOptional()
  google_uid?: string;

  @IsString()
  @IsOptional()
  mall_name?: string;
}

class GoogleAuthDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsIn(REGISTRATION_ROLES)
  role: 'Customer' | 'Business';

  @IsString()
  @IsOptional()
  mobile?: string;

  @IsString()
  @IsOptional()
  city?: string;

  @IsString()
  @IsOptional()
  business_name?: string;

  @IsString()
  @IsOptional()
  business_type?: string;

  @IsString()
  @IsOptional()
  google_uid?: string;

  @IsString()
  @IsOptional()
  profile_photo?: string;

  @IsString()
  @IsOptional()
  category?: string;

  @IsString()
  @IsOptional()
  address?: string;

  @IsString()
  @IsOptional()
  state?: string;

  @IsString()
  @IsOptional()
  pincode?: string;

  @IsString()
  @IsOptional()
  aadhaar_number?: string;

  @IsString()
  @IsOptional()
  gst_number?: string;

  @IsString()
  @IsOptional()
  pan_number?: string;

  @IsString()
  @IsOptional()
  shop_photo?: string;

  @IsString()
  @IsOptional()
  aadhaar_photo?: string;

  @IsString()
  @IsOptional()
  pan_photo?: string;

  @IsString()
  @IsOptional()
  mall_name?: string;
}

class LoginDto {
  @IsString()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  password_hash: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Same rate — 3 per 10 min per IP — as claim.controller.ts's otp/send:
  // real SMS cost per send, and no reason this flow should tolerate more
  // automated abuse than the claim flow already refuses to.
  @Post('send-otp')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 3, ttl: 600_000 } })
  async sendOtp(@Body() body: SendOtpDto) {
    return this.authService.sendOtp(body.mobile, body.role);
  }

  // Defense in depth alongside AuthService.verifyOtp()'s new per-mobile
  // attempt lockout (5 wrong guesses locks out that OTP entirely,
  // regardless of IP) — this catches an attacker spreading guesses across
  // many mobiles from one IP, which the per-mobile counter alone can't.
  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 600_000 } })
  async verifyOtp(@Body() body: VerifyOtpDto) {
    return this.authService.verifyOtp(body.mobile, body.code, body.role);
  }

  @Post('register')
  async register(@Body() body: RegisterDto) {
    return this.authService.register(body);
  }

  // Password login had no brute-force defense of any kind — unlike OTP,
  // there is no per-account attempt counter here (that would need a schema
  // change on both Customer and Business), so this IP-scoped throttle is
  // the primary mitigation, not a backstop.
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 600_000 } })
  async login(@Body() body: LoginDto) {
    return this.authService.login(body.email, body.password_hash);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout() {
    return { success: true, message: 'Logged out successfully' };
  }

  @Post('google')
  @HttpCode(HttpStatus.OK)
  async googleAuth(@Body() body: GoogleAuthDto) {
    return this.authService.googleUpsert(body);
  }

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  async getProfile(@CurrentUser() user: any) {
    return this.authService.getProfile(user.sub, user.role);
  }

  @UseGuards(JwtAuthGuard)
  @Put('profile')
  async updateProfile(@CurrentUser() user: any, @Body() body: any) {
    return this.authService.updateProfile(user.sub, user.role, body);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('account')
  async deleteAccount(@CurrentUser() user: any) {
    return this.authService.deleteAccount(user.sub, user.role);
  }
}
