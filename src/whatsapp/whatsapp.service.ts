import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface WhatsAppSendResult {
  success: boolean;
  error?: string;
  messageId?: string;
}

// Meta Cloud API's /messages response shape — narrow, typed cast target for
// response.json() (which fetch types as Promise<any>) so send-result
// handling below doesn't propagate unsafe-any.
interface MetaSendResponse {
  messages?: { id?: string }[];
}

// Business's effective lead-alert WhatsApp number/verification state.
// When a merchant hasn't set an explicit lead_whatsapp_number, their
// already OTP-verified registration `mobile` is used and treated as
// verified — see the Business model's schema comment (Module 8).
export function resolveLeadWhatsappNumber(business: {
  mobile: string | null;
  lead_whatsapp_number: string | null;
  lead_whatsapp_verified: boolean;
}): { number: string | null; verified: boolean; isDefault: boolean } {
  if (!business.lead_whatsapp_number) {
    return {
      number: business.mobile,
      verified: !!business.mobile,
      isDefault: true,
    };
  }
  return {
    number: business.lead_whatsapp_number,
    verified: business.lead_whatsapp_verified,
    isDefault: false,
  };
}

export interface InboundWhatsAppMessage {
  from: string; // Sender's WhatsApp number (international format, e.g. "919876543210")
  id: string; // Message ID
  timestamp: string;
  type: string; // "text" | "image" | "interactive" | "button" etc.
  text?: { body: string };
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description: string };
  };
}

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly apiVersion = 'v20.0';

  constructor(private readonly configService: ConfigService) {}

  /**
   * Central event dispatcher — parses Meta's webhook payload
   */
  async handleIncomingEvent(payload: any): Promise<void> {
    if (payload.object !== 'whatsapp_business_account') {
      this.logger.warn('Received non-WhatsApp webhook payload');
      return;
    }

    const entries = payload.entry ?? [];
    for (const entry of entries) {
      const changes = entry.changes ?? [];
      for (const change of changes) {
        if (change.field === 'messages') {
          await this.processMessagesValue(change.value);
        }
      }
    }
  }

  private async processMessagesValue(value: any): Promise<void> {
    // Use the configured phone number ID as the sender
    const phoneNumberId =
      value.metadata?.phone_number_id ||
      this.configService.get<string>('WHATSAPP_PHONE_NUMBER_ID');

    // Handle incoming messages
    const messages: InboundWhatsAppMessage[] = value.messages ?? [];
    for (const message of messages) {
      await this.handleMessage(message, phoneNumberId);
    }

    // Handle status updates (delivered, read, failed)
    const statuses = value.statuses ?? [];
    for (const status of statuses) {
      this.logger.log(
        `📋 Message status update | id=${status.id} | status=${status.status} | recipient=${status.recipient_id}`,
      );
    }
  }

  private async handleMessage(
    message: InboundWhatsAppMessage,
    phoneNumberId: string,
  ): Promise<void> {
    this.logger.log(
      `📩 Message from ${message.from} | type=${message.type} | id=${message.id}`,
    );

    // Route by message type
    switch (message.type) {
      case 'text':
        await this.handleTextMessage(message, phoneNumberId);
        break;
      case 'interactive':
        await this.handleInteractiveMessage(message, phoneNumberId);
        break;
      default:
        this.logger.log(`Unhandled message type: ${message.type}`);
    }
  }

  private async handleTextMessage(
    message: InboundWhatsAppMessage,
    phoneNumberId: string,
  ): Promise<void> {
    const text = message.text?.body?.toLowerCase().trim() ?? '';
    this.logger.log(`💬 Text message: "${text}" from ${message.from}`);

    // Auto-reply: "deals" → send available deals info
    if (text.includes('deals') || text.includes('offer')) {
      await this.sendTextMessage(
        message.from,
        phoneNumberId,
        `🛍 *Pairley Deals*\n\nHi! Welcome to Pairley — India's hyperlocal group buying platform.\n\n` +
          `To browse deals near you, visit:\n` +
          `👉 https://pairley.com\n\n` +
          `Reply *JOIN* to get notified about new deals in your area.`,
      );
    }
    // "join" → acknowledgement
    else if (text.includes('join') || text.includes('register')) {
      await this.sendTextMessage(
        message.from,
        phoneNumberId,
        `✅ *You're in!*\n\nWe'll notify you about exclusive group deals near you.\n\n` +
          `Download the Pairley app for the best experience:\n` +
          `📱 https://pairley.com/download`,
      );
    }
    // Default help reply
    else {
      await this.sendTextMessage(
        message.from,
        phoneNumberId,
        `👋 Hi! I'm *Pairley Bot*.\n\nReply with:\n` +
          `• *DEALS* — See group deals near you\n` +
          `• *JOIN* — Get deal notifications\n` +
          `• *HELP* — Support\n\n` +
          `Or visit https://pairley.com`,
      );
    }
  }

  private async handleInteractiveMessage(
    message: InboundWhatsAppMessage,
    phoneNumberId: string,
  ): Promise<void> {
    const reply =
      message.interactive?.button_reply || message.interactive?.list_reply;
    if (!reply) return;

    this.logger.log(
      `🖱 Interactive reply: id=${reply.id} title="${reply.title}" from ${message.from}`,
    );

    // Handle button/list replies based on id
    await this.sendTextMessage(
      message.from,
      phoneNumberId,
      `✅ Got it! Processing your request: *${reply.title}*`,
    );
  }

  // The number Pairley's own WhatsApp Business account sends from —
  // configured once, not merchant-specific.
  getSenderPhoneNumberId(): string | undefined {
    return this.configService.get<string>('WHATSAPP_PHONE_NUMBER_ID');
  }

  /**
   * Send a plain text message via WhatsApp Cloud API. Returns a result
   * instead of throwing — callers (OTP send, lead alerts) need to log
   * SENT/FAILED without a failure ever propagating up and blocking
   * whatever triggered the send (e.g. lead creation).
   */
  async sendTextMessage(
    to: string,
    phoneNumberId: string,
    text: string,
  ): Promise<WhatsAppSendResult> {
    // Use API token (app-level) first, then access token as fallback
    const token =
      this.configService.get<string>('WHATSAPP_API_TOKEN') ||
      this.configService.get<string>('WHATSAPP_ACCESS_TOKEN');
    if (!token) {
      this.logger.warn('No WhatsApp token configured — skipping send');
      return { success: false, error: 'No WhatsApp token configured' };
    }

    const url = `https://graph.facebook.com/${this.apiVersion}/${phoneNumberId}/messages`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { preview_url: false, body: text },
        }),
      });

      if (!response.ok) {
        const err: unknown = await response.json();
        const errorMsg = JSON.stringify(err);
        this.logger.error(`Failed to send WhatsApp message: ${errorMsg}`);
        return { success: false, error: errorMsg };
      }

      const data = (await response.json()) as MetaSendResponse;
      const messageId = data.messages?.[0]?.id;
      this.logger.log(`✅ WhatsApp message sent | message_id=${messageId}`);
      return { success: true, messageId };
    } catch (error) {
      this.logger.error('Error sending WhatsApp message:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send a template message (for deal notifications, OTP, etc.)
   */
  async sendTemplateMessage(
    to: string,
    phoneNumberId: string,
    templateName: string,
    languageCode: string = 'en',
    components: any[] = [],
  ): Promise<WhatsAppSendResult> {
    const token =
      this.configService.get<string>('WHATSAPP_API_TOKEN') ||
      this.configService.get<string>('WHATSAPP_ACCESS_TOKEN');
    if (!token) {
      this.logger.warn('No WhatsApp token configured — skipping send');
      return { success: false, error: 'No WhatsApp token configured' };
    }

    const url = `https://graph.facebook.com/${this.apiVersion}/${phoneNumberId}/messages`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: templateName,
            language: { code: languageCode },
            components,
          },
        }),
      });

      if (!response.ok) {
        const err: unknown = await response.json();
        const errorMsg = JSON.stringify(err);
        this.logger.error(`Failed to send template: ${errorMsg}`);
        return { success: false, error: errorMsg };
      }

      const data = (await response.json()) as MetaSendResponse;
      const messageId = data.messages?.[0]?.id;
      this.logger.log(`✅ WhatsApp template "${templateName}" sent to ${to}`);
      return { success: true, messageId };
    } catch (error) {
      this.logger.error('Error sending WhatsApp template:', error);
      return { success: false, error: error.message };
    }
  }
}
