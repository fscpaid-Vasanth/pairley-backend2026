import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  public readonly useMock: boolean;
  private readonly apiKey: string;
  private readonly senderId: string;
  private readonly templateId: string;

  constructor(private configService: ConfigService) {
    const mockOtpVal = this.configService.get<any>('USE_MOCK_OTP', true);
    this.useMock = mockOtpVal === true || mockOtpVal === 'true';
    
    this.apiKey = this.configService.get<string>('MSG91_API_KEY', '');
    this.senderId = this.configService.get<string>('MSG91_SENDER_ID', 'PRLY');
    this.templateId = this.configService.get<string>('MSG91_TEMPLATE_ID', '');
  }

  async sendOtp(mobile: string, code: string): Promise<boolean> {
    if (this.useMock) {
      this.logger.log(`[MOCK OTP] Sending OTP ${code} to mobile number ${mobile}`);
      return true;
    }

    try {
      // Real MSG91 v5 OTP API call
      const url = `https://api.msg91.com/api/v5/otp?template_id=${this.templateId}&mobile=91${mobile}&authkey=${this.apiKey}&otp=${code}&sender=${this.senderId}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      const result = await response.json() as { type?: string; message?: string };

      if (result.type === 'success') {
        this.logger.log(`[MSG91] OTP sent successfully to 91${mobile}`);
        return true;
      }

      this.logger.error(`[MSG91] OTP send failed: ${JSON.stringify(result)}`);
      return false;
    } catch (error) {
      this.logger.error(`Failed to send OTP via MSG91: ${error.message}`);
      return false;
    }
  }

  async sendSms(mobile: string, message: string): Promise<boolean> {
    const formattedMobile = mobile.startsWith('91') ? mobile : `91${mobile}`;
    if (this.useMock) {
      this.logger.log(`[MOCK SMS] Sending SMS to ${formattedMobile}: "${message}"`);
      return true;
    }

    try {
      const url = 'https://control.msg91.com/api/v5/sms/send';
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'authkey': this.apiKey,
        },
        body: JSON.stringify({
          route: '4',
          sender: this.senderId || 'PRLY',
          sms: [
            {
              message,
              to: [formattedMobile],
            },
          ],
        }),
      });

      const result = await response.json();
      this.logger.log(`[MSG91 SMS] Sent status: ${JSON.stringify(result)}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to send SMS via MSG91: ${error.message}`);
      return false;
    }
  }

  generateOtp(): string {
    // Return a 6-digit random number
    return Math.floor(100000 + Math.random() * 900000).toString();
  }
}
