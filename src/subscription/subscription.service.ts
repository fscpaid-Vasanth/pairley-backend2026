import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentService } from '../common/services/payment.service';
import { SubscriptionStatus } from '@prisma/client';

@Injectable()
export class SubscriptionService {
  private readonly plans = [
    {
      name: 'Basic',
      amount: 199,
      durationDays: 30,
      description: 'Basic tier for single shops',
    },
    {
      name: 'Premium',
      amount: 999,
      durationDays: 30,
      description: 'Premium tier for multi-shop support & priority visibility',
    },
  ];

  constructor(
    private prisma: PrismaService,
    private paymentService: PaymentService,
  ) {}

  async getPlans() {
    return this.plans;
  }

  async subscribe(
    businessId: string,
    planName: string,
    paymentReference: string,
  ) {
    const plan = this.plans.find(
      (p) => p.name.toLowerCase() === planName.toLowerCase(),
    );
    if (!plan) {
      throw new BadRequestException('Invalid subscription plan name');
    }

    // 1. Verify payment with Razorpay
    const paymentVerified = await this.paymentService.verifySignature(
      paymentReference,
      'mock_order_id',
      'mock_signature',
    );

    if (!paymentVerified) {
      throw new BadRequestException('Payment verification failed');
    }

    // 2. Set dates
    const startDate = new Date();
    const expiryDate = new Date();
    expiryDate.setDate(startDate.getDate() + plan.durationDays);

    // 3. Create Subscription
    const subscription = await this.prisma.subscription.create({
      data: {
        business_id: businessId,
        plan_name: plan.name,
        amount: plan.amount,
        start_date: startDate,
        expiry_date: expiryDate,
        status: SubscriptionStatus.ACTIVE,
        payment_reference: paymentReference,
      },
    });

    // 4. Update the business subscription reference
    await this.prisma.business.update({
      where: { id: businessId },
      data: {
        subscription_id: subscription.id,
      },
    });

    return subscription;
  }

  async renew(businessId: string, paymentReference: string) {
    // 1. Find last active or expired subscription
    const currentSub = await this.prisma.subscription.findFirst({
      where: { business_id: businessId },
      orderBy: { created_at: 'desc' },
    });

    if (!currentSub) {
      throw new BadRequestException(
        'No subscription found to renew. Please purchase a new subscription first.',
      );
    }

    const plan = this.plans.find(
      (p) => p.name.toLowerCase() === currentSub.plan_name.toLowerCase(),
    );
    if (!plan) {
      throw new BadRequestException('Unknown plan on current subscription');
    }

    // 2. Verify payment
    const paymentVerified = await this.paymentService.verifySignature(
      paymentReference,
      'mock_order_id',
      'mock_signature',
    );

    if (!paymentVerified) {
      throw new BadRequestException('Payment verification failed');
    }

    // 3. Calculate new dates
    const isCurrentlyActive =
      currentSub.status === SubscriptionStatus.ACTIVE &&
      new Date() < currentSub.expiry_date;
    const startDate = isCurrentlyActive
      ? new Date(currentSub.expiry_date)
      : new Date();
    const expiryDate = new Date(startDate);
    expiryDate.setDate(startDate.getDate() + plan.durationDays);

    // 4. Create new subscription record
    const subscription = await this.prisma.subscription.create({
      data: {
        business_id: businessId,
        plan_name: plan.name,
        amount: plan.amount,
        start_date: startDate,
        expiry_date: expiryDate,
        status: SubscriptionStatus.ACTIVE,
        payment_reference: paymentReference,
      },
    });

    // 5. Update business model
    await this.prisma.business.update({
      where: { id: businessId },
      data: {
        subscription_id: subscription.id,
      },
    });

    return subscription;
  }

  async getHistory(businessId: string) {
    return this.prisma.subscription.findMany({
      where: { business_id: businessId },
      orderBy: { created_at: 'desc' },
    });
  }

  async getCurrent(businessId: string) {
    const sub = await this.prisma.subscription.findFirst({
      where: { business_id: businessId },
      orderBy: { created_at: 'desc' },
    });

    if (!sub) {
      return { status: 'None', plan_name: null, expiry_date: null };
    }

    const isActive =
      sub.status === SubscriptionStatus.ACTIVE && new Date() < sub.expiry_date;
    return {
      ...sub,
      isActive,
    };
  }
}
