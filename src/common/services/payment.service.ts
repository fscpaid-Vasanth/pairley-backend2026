import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);
  private readonly useMock: boolean;

  constructor(private configService: ConfigService) {
    const mockPaymentVal = this.configService.get<any>('USE_MOCK_PAYMENT', true);
    this.useMock = mockPaymentVal === true || mockPaymentVal === 'true';
  }

  async createOrder(amount: number, currency = 'INR', receipt: string): Promise<any> {
    const orderId = `order_${Math.random().toString(36).substring(2, 15)}`;
    
    if (this.useMock) {
      this.logger.log(`[MOCK PAYMENT] Created Razorpay order ${orderId} for ₹${amount}`);
      return {
        id: orderId,
        entity: 'order',
        amount: amount * 100, // Razorpay amount is in paise
        amount_paid: 0,
        amount_due: amount * 100,
        currency,
        receipt,
        status: 'created',
        created_at: Math.floor(Date.now() / 1000),
      };
    }

    try {
      // Real Razorpay client integration goes here
      return { id: orderId, status: 'created' };
    } catch (error) {
      this.logger.error(`Failed to create Razorpay order: ${error.message}`);
      throw new Error(`Razorpay order creation failed: ${error.message}`);
    }
  }

  async verifySignature(paymentId: string, orderId: string, signature: string): Promise<boolean> {
    if (this.useMock) {
      this.logger.log(`[MOCK PAYMENT] Verified Razorpay signature for payment ${paymentId}`);
      return true;
    }

    try {
      // Real signature verification logic goes here using crypto hmac
      return true;
    } catch (error) {
      this.logger.error(`Failed to verify Razorpay signature: ${error.message}`);
      return false;
    }
  }
}
