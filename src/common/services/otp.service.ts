import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  public readonly useMock: boolean;
  private readonly apiKey: string;
  private readonly senderId: string;
  private readonly templateId: string;
  private readonly smsTemplateId: string;

  constructor(private configService: ConfigService) {
    const mockOtpVal = this.configService.get<any>('USE_MOCK_OTP', true);
    this.useMock = mockOtpVal === true || mockOtpVal === 'true';

    this.apiKey = this.configService.get<string>('MSG91_API_KEY', '');
    this.senderId = this.configService.get<string>('MSG91_SENDER_ID', 'PAIRLY');
    this.templateId = this.configService.get<string>('MSG91_TEMPLATE_ID', '');
    this.smsTemplateId = this.configService.get<string>('MSG91_SMS_TEMPLATE_ID', '');
  }

  async sendOtp(mobile: string, code: string): Promise<boolean> {
    if (this.useMock) {
      this.logger.log(`[MOCK OTP] Sending OTP ${code} to mobile number ${mobile}`);
      return true;
    }

    try {
      const formattedMobile = mobile.startsWith('91') ? mobile : `91${mobile}`;
      const url = `https://control.msg91.com/api/v5/otp?template_id=${this.templateId}&mobile=${formattedMobile}&otp=${code}`;

      this.logger.log(`[MSG91] Sending OTP to ${formattedMobile}, template: ${this.templateId}`);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'authkey': this.apiKey,
        },
      });

      const result = await response.json() as { type?: string; message?: string; request_id?: string };

      if (result.type === 'success' || result.request_id) {
        this.logger.log(`[MSG91] OTP sent successfully to ${formattedMobile}, request_id: ${result.request_id || 'N/A'}`);
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

    // If no SMS template configured, fall back to the OTP SendOTP API with a custom message log
    const smsTemplate = this.smsTemplateId || this.templateId;
    if (!smsTemplate) {
      this.logger.warn(`[MSG91 SMS] No SMS template configured. Skipping SMS to ${formattedMobile}`);
      return false;
    }

    try {
      const url = 'https://control.msg91.com/api/v5/flow/';
      const payload = {
        template_id: smsTemplate,
        short_url: '0',
        recipients: [
          {
            mobiles: formattedMobile,
            var1: message,
          },
        ],
      };

      this.logger.log(`[MSG91 SMS] Sending to ${formattedMobile}, template: ${smsTemplate}`);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'authkey': this.apiKey,
        },
        body: JSON.stringify(payload),
      });

      const result = await response.json();
      this.logger.log(`[MSG91 SMS] Sent to ${formattedMobile}, status: ${JSON.stringify(result)}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to send SMS via MSG91: ${error.message}`);
      return false;
    }
  }

  generateOtp(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }
}
