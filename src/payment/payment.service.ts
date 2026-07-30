import { Injectable } from '@nestjs/common';
import { PaymentService as CommonPaymentService } from '../common/services/payment.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PaymentModuleService {
  constructor(
    private commonPaymentService: CommonPaymentService,
    private prisma: PrismaService,
  ) {}

  async createOrder(amount: number, receipt: string) {
    return this.commonPaymentService.createOrder(amount, 'INR', receipt);
  }

  async verify(paymentId: string, orderId: string, signature: string) {
    const success = await this.commonPaymentService.verifySignature(
      paymentId,
      orderId,
      signature,
    );
    return { success };
  }

  async getHistory(businessId: string) {
    return this.prisma.subscription.findMany({
      where: {
        business_id: businessId,
        payment_reference: { not: null },
      },
      select: {
        id: true,
        plan_name: true,
        amount: true,
        start_date: true,
        payment_reference: true,
        status: true,
      },
      orderBy: { created_at: 'desc' },
    });
  }
}
