import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// MSG91's own SLA is well under this; 15s is generous headroom before we
// give up and let the customer retry rather than leaving them on a spinner.
const OTP_SEND_TIMEOUT_MS = 15_000;

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
    this.smsTemplateId = this.configService.get<string>(
      'MSG91_SMS_TEMPLATE_ID',
      '',
    );
  }

  async sendOtp(
    mobile: string,
    code: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (this.useMock) {
      this.logger.log(
        `[MOCK OTP] Sending OTP ${code} to mobile number ${mobile}`,
      );
      return { success: true };
    }

    try {
      const formattedMobile = mobile.startsWith('91') ? mobile : `91${mobile}`;
      const url = `https://control.msg91.com/api/v5/otp?template_id=${this.templateId}&mobile=${formattedMobile}&otp=${code}&sender=${this.senderId}`;

      this.logger.log(
        `[MSG91] Sending OTP to ${formattedMobile}, template: ${this.templateId}, sender: ${this.senderId}`,
      );

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authkey: this.apiKey,
        },
        // Without this, a hung MSG91 endpoint would leave the whole
        // /auth/send-otp request hanging indefinitely (bounded only by
        // whatever timeout the platform happens to enforce), leaving the
        // customer stuck on a spinner rather than getting a clear,
        // fast "try again" — the two other network-call sites in this
        // service and elsewhere in the backend already use this same
        // AbortSignal.timeout() pattern for exactly this reason.
        signal: AbortSignal.timeout(OTP_SEND_TIMEOUT_MS),
      });

      const result = (await response.json()) as {
        type?: string;
        message?: string;
        request_id?: string;
        code?: string | number;
      };

      if (result.type === 'success' || result.request_id) {
        this.logger.log(
          `[MSG91] OTP sent successfully to ${formattedMobile}, request_id: ${result.request_id || 'N/A'}`,
        );
        return { success: true };
      }

      this.logger.error(`[MSG91] OTP send failed: ${JSON.stringify(result)}`);
      const errorMsg = this.getMsg91ErrorMessage(result);
      return { success: false, error: errorMsg };
    } catch (error) {
      // AbortSignal.timeout() rejects with a DOMException named
      // "TimeoutError" — distinguished here so the customer sees an
      // actionable "the OTP provider is slow, try again" instead of the
      // generic network-error message, without ever leaking MSG91-internal
      // details (URL, template ID, raw error object).
      if (error.name === 'TimeoutError') {
        this.logger.error(
          `MSG91 OTP send timed out after ${OTP_SEND_TIMEOUT_MS}ms`,
        );
        return {
          success: false,
          error:
            'OTP provider is taking too long to respond. Please try again.',
        };
      }
      this.logger.error(`Failed to send OTP via MSG91: ${error.message}`);
      return {
        success: false,
        error: `Network/API connection error: ${error.message}`,
      };
    }
  }

  private getMsg91ErrorMessage(result: any): string {
    if (!result)
      return 'Unknown error occurred while contacting the OTP provider';

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
    if (
      lowerMsg.includes('mobile') ||
      lowerMsg.includes('phone') ||
      lowerMsg.includes('number')
    ) {
      if (lowerMsg.includes('missing'))
        return `${errorMap['101']} (MSG91 Details: ${message})`;
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
    if (
      lowerMsg.includes('ip') &&
      (lowerMsg.includes('whitelist') || lowerMsg.includes('blacklist'))
    ) {
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
      this.logger.log(
        `[MOCK SMS] Sending SMS to ${formattedMobile}: "${message}"`,
      );
      return true;
    }

    // If no SMS template configured, fall back to mock logging to prevent matching transaction crashes
    if (!this.smsTemplateId) {
      this.logger.warn(
        `[MOCK MSG91 SMS] MSG91_SMS_TEMPLATE_ID is not configured. Mocking SMS to ${formattedMobile}: "${message}"`,
      );
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

      this.logger.log(
        `[MSG91 SMS] Sending to ${formattedMobile}, template: ${smsTemplate}`,
      );

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authkey: this.apiKey,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(OTP_SEND_TIMEOUT_MS),
      });

      const result = await response.json();
      this.logger.log(
        `[MSG91 SMS] Sent to ${formattedMobile}, status: ${JSON.stringify(result)}`,
      );
      return true;
    } catch (error) {
      if (error.name === 'TimeoutError') {
        this.logger.error(
          `MSG91 SMS send timed out after ${OTP_SEND_TIMEOUT_MS}ms`,
        );
        return false;
      }
      this.logger.error(`Failed to send SMS via MSG91: ${error.message}`);
      return false;
    }
  }

  generateOtp(): string {
    // 4-digit code, uniformly random across 0000-9999. Sent to MSG91's
    // existing approved template ("Your PAIRLEY verification code is
    // ##OTP##...") unchanged — the template has no fixed digit-count
    // expectation, it just substitutes whatever string is passed as `code`.
    return Math.floor(Math.random() * 10_000)
      .toString()
      .padStart(4, '0');
  }
}
