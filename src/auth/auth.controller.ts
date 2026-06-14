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
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  IsNotEmpty,
  IsString,
  IsEmail,
  IsOptional,
  Length,
} from 'class-validator';

class SendOtpDto {
  @IsString()
  @IsNotEmpty()
  @Length(10, 15)
  mobile: string;
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

  @IsString()
  @IsNotEmpty()
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

  @Post('send-otp')
  @HttpCode(HttpStatus.OK)
  async sendOtp(@Body() body: SendOtpDto) {
    return this.authService.sendOtp(body.mobile);
  }

  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  async verifyOtp(@Body() body: VerifyOtpDto) {
    return this.authService.verifyOtp(body.mobile, body.code);
  }

  @Post('register')
  async register(@Body() body: RegisterDto) {
    return this.authService.register(body);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
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
  async googleAuth(@Body() body: RegisterDto) {
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
