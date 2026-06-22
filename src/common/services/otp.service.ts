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

  async sendOtp(mobile: string, code: string): Promise<{ success: boolean; error?: string }> {
    if (this.useMock) {
      this.logger.log(`[MOCK OTP] Sending OTP ${code} to mobile number ${mobile}`);
      return { success: true };
    }

    try {
      const formattedMobile = mobile.startsWith('91') ? mobile : `91${mobile}`;
      const url = `https://control.msg91.com/api/v5/otp?template_id=${this.templateId}&mobile=${formattedMobile}&otp=${code}&sender=${this.senderId}`;

      this.logger.log(`[MSG91] Sending OTP to ${formattedMobile}, template: ${this.templateId}, sender: ${this.senderId}`);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'authkey': this.apiKey,
        },
      });

      const result = await response.json() as { type?: string; message?: string; request_id?: string; code?: string | number };

      if (result.type === 'success' || result.request_id) {
        this.logger.log(`[MSG91] OTP sent successfully to ${formattedMobile}, request_id: ${result.request_id || 'N/A'}`);
        return { success: true };
      }

      this.logger.error(`[MSG91] OTP send failed: ${JSON.stringify(result)}`);
      const errorMsg = this.getMsg91ErrorMessage(result);
      return { success: false, error: errorMsg };
    } catch (error) {
      this.logger.error(`Failed to send OTP via MSG91: ${error.message}`);
      return { success: false, error: `Network/API connection error: ${error.message}` };
    }
  }

  private getMsg91ErrorMessage(result: any): string {
    if (!result) return 'Unknown error occurred while contacting the OTP provider';
    
    const code = String(result.code || '').trim();
    const message = String(result.message || '').trim();
    
    const errorMap: Record<string, string> = {
      '101': 'Missing mobile number',
      '102': 'Missing message content',
      '105': 'Missing password',
      '201': 'Invalid username or password',
      '202': 'Invalid mobile number format (must be 10-15 digits)',
      '203': 'Invalid Sender ID or missing DLT Entity ID',
      '204': 'SMS sending permission not enabled for this Authkey',
      '207': 'Invalid MSG91 authentication key (Authkey)',
      '208': 'IP address is blacklisted (not whitelisted)',
      '209': 'Default route not found',
      '210': 'Route could not be determined',
      '301': 'Insufficient balance / SMS credits in MSG91 account',
      '302': 'Expired user account',
      '303': 'Banned user account',
      '306': 'Route currently unavailable (e.g. time restrictions)',
      '307': 'Incorrect scheduled time',
      '308': 'Campaign name exceeds character limit',
      '310': 'SMS is too long',
      '311': 'Duplicate request (same OTP sent within 10 seconds)',
      '400': 'Template ID is missing, incorrect, or archived',
      '401': 'Flow / Template not yet approved or incorrect template config',
      '418': 'IP is not whitelisted',
      '601': 'Internal system error (MSG91 side)',
    };

    if (code && errorMap[code]) {
      return `${errorMap[code]} (Code: ${code})`;
    }

    if (errorMap[message]) {
      return `${errorMap[message]} (Code: ${message})`;
    }

    const lowerMsg = message.toLowerCase();
    if (lowerMsg.includes('authkey') || lowerMsg.includes('auth key')) {
      return `${errorMap['207']} (MSG91 Details: ${message})`;
    }
    if (lowerMsg.includes('mobile') || lowerMsg.includes('phone') || lowerMsg.includes('number')) {
      if (lowerMsg.includes('missing')) return `${errorMap['101']} (MSG91 Details: ${message})`;
      return `${errorMap['202']} (MSG91 Details: ${message})`;
    }
    if (lowerMsg.includes('template')) {
      return `${errorMap['400']} (MSG91 Details: ${message})`;
    }
    if (lowerMsg.includes('balance') || lowerMsg.includes('credit')) {
      return `${errorMap['301']} (MSG91 Details: ${message})`;
    }
    if (lowerMsg.includes('sender')) {
      return `${errorMap['203']} (MSG91 Details: ${message})`;
    }
    if (lowerMsg.includes('ip') && (lowerMsg.includes('whitelist') || lowerMsg.includes('blacklist'))) {
      return `${errorMap['208']} (MSG91 Details: ${message})`;
    }
    if (lowerMsg.includes('duplicate')) {
      return `${errorMap['311']} (MSG91 Details: ${message})`;
    }

    return message || 'OTP send failed (unknown MSG91 error)';
  }

  async sendSms(mobile: string, message: string): Promise<boolean> {
    const formattedMobile = mobile.startsWith('91') ? mobile : `91${mobile}`;
    if (this.useMock) {
      this.logger.log(`[MOCK SMS] Sending SMS to ${formattedMobile}: "${message}"`);
      return true;
    }

    // If no SMS template configured, fall back to mock logging to prevent matching transaction crashes
    if (!this.smsTemplateId) {
      this.logger.warn(`[MOCK MSG91 SMS] MSG91_SMS_TEMPLATE_ID is not configured. Mocking SMS to ${formattedMobile}: "${message}"`);
      return true;
    }
    const smsTemplate = this.smsTemplateId;

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
