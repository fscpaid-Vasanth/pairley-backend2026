import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IsNotEmpty, IsString } from 'class-validator';
import { ClaimRequestService } from './claim-request.service';

class RequestClaimDto {
  @IsString()
  @IsNotEmpty()
  business_id: string;

  @IsString()
  @IsNotEmpty()
  mobile: string;
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
// account yet starts proving ownership of an AI-imported business. No
// guards here; every safety property (single-use, expiry, retry limits,
// audit) lives in ClaimRequestService, not in route-level auth.
@Controller('business/claim')
export class ClaimController {
  constructor(private readonly claimRequestService: ClaimRequestService) {}

  @Post('request')
  request(@Body() body: RequestClaimDto) {
    return this.claimRequestService.requestClaim(body.business_id, body.mobile);
  }

  @Get('status/:token')
  status(@Param('token') token: string) {
    return this.claimRequestService.getStatusByToken(token);
  }

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
