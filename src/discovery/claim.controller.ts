import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { ClaimRequestService } from './claim-request.service';

class RequestClaimDto {
  @IsString()
  @IsNotEmpty()
  business_id: string;

  @IsString()
  @IsNotEmpty()
  mobile: string;

  // Module 12 Phase 1 — both optional so a client that hasn't updated yet
  // (or a merchant who genuinely has no evidence handy) still gets the
  // exact pre-Module-12 behavior: a bare claim with no name/evidence.
  @IsOptional()
  @IsString()
  claimant_name?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  evidence?: string[];
}

class VerifyOtpDto {
  @IsString()
  @IsNotEmpty()
  claimToken: string;

  @IsString()
  @IsNotEmpty()
  code: string;
}

class ClaimTokenDto {
  @IsString()
  @IsNotEmpty()
  claimToken: string;
}

// Public, unauthenticated by design — this is how a merchant with no
// account yet starts proving ownership of an AI-imported business. No auth
// guards here; every safety property (single-use, expiry, retry limits,
// audit) lives in ClaimRequestService, not in route-level auth.
//
// Module 12 Phase 1 — Decision 2: rate-limited, but deliberately scoped to
// just these two routes rather than registered globally (no APP_GUARD) —
// this is the one controller in the whole backend with zero auth gate, and
// the one with a real per-request SMS cost (otp/send), so it's the one
// that actually needs it; every other route already sits behind
// JwtAuthGuard/RolesGuard.
@Controller('business/claim')
export class ClaimController {
  constructor(private readonly claimRequestService: ClaimRequestService) {}

  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 600_000 } }) // 5 per 10 min per IP
  @Post('request')
  request(@Body() body: RequestClaimDto) {
    return this.claimRequestService.requestClaim(
      body.business_id,
      body.mobile,
      body.claimant_name,
      body.evidence,
    );
  }

  @Get('status/:token')
  status(@Param('token') token: string) {
    return this.claimRequestService.getStatusByToken(token);
  }

  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 3, ttl: 600_000 } }) // 3 per 10 min per IP — real SMS cost per send
  @Post('otp/send')
  sendOtp(@Body() body: ClaimTokenDto) {
    return this.claimRequestService.sendOtp(body.claimToken);
  }

  @Post('otp/verify')
  verifyOtp(@Body() body: VerifyOtpDto) {
    return this.claimRequestService.verifyOtpAndTransfer(
      body.claimToken,
      body.code,
    );
  }
}
