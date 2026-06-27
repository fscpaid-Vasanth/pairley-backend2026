import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../common/services/notification.service';
import { OfferStatus, InterestStatus, VerificationStatus, SubscriptionStatus } from '@prisma/client';

@Injectable()
export class DashboardService {
  constructor(
    private prisma: PrismaService,
    private notificationService: NotificationService
  ) {}

  // ==========================================
  // BUSINESS DASHBOARD METRICS
  // ==========================================
  async getBusinessMetrics(businessId: string) {
    const activeOffers = await this.prisma.offer.count({
      where: { business_id: businessId, status: OfferStatus.ACTIVE },
    });

    const offerInterests = await this.prisma.offerInterest.findMany({
      where: { offer: { business_id: businessId } },
      select: { status: true },
    });

    const interestedCount = offerInterests.filter((i) => i.status === InterestStatus.INTERESTED).length;
    const readyToBuyCount = offerInterests.filter((i) => i.status === InterestStatus.READY_TO_BUY).length;
    const completedCount = offerInterests.filter((i) => i.status === InterestStatus.COMPLETED).length;

    // Subscription status
    const currentSub = await this.prisma.subscription.findFirst({
      where: { business_id: businessId },
      orderBy: { created_at: 'desc' },
    });

    const subscriptionStatus = currentSub
      ? {
          plan_name: currentSub.plan_name,
          expiry_date: currentSub.expiry_date,
          isActive: currentSub.status === SubscriptionStatus.ACTIVE && new Date() < currentSub.expiry_date,
        }
      : { plan_name: null, expiry_date: null, isActive: false };

    // Offer Performance (Top performing offer based on joined_people)
    const topOffer = await this.prisma.offer.findFirst({
      where: { business_id: businessId },
      orderBy: { joined_people: 'desc' },
    });

    return {
      activeOffers,
      interestedCustomers: interestedCount,
      readyToBuyCustomers: readyToBuyCount,
      completedDeals: completedCount,
      subscriptionStatus,
      topPerformingOffer: topOffer || null,
    };
  }

  // ==========================================
  // ADMIN DASHBOARD METRICS
  // ==========================================
  async getAdminMetrics() {
    const totalCustomers = await this.prisma.customer.count();
    const totalBusinesses = await this.prisma.business.count();
    
    const verifiedBusinesses = await this.prisma.business.count({
      where: { verification_status: VerificationStatus.APPROVED },
    });
    const pendingApprovals = await this.prisma.business.count({
      where: { verification_status: VerificationStatus.PENDING },
    });

    const activeOffers = await this.prisma.offer.count({
      where: { status: OfferStatus.ACTIVE },
    });

    const completedDeals = await this.prisma.offer.count({
      where: { status: OfferStatus.CLOSED },
    });

    // Subscriptions revenue
    const revenueSum = await this.prisma.subscription.aggregate({
      where: { status: SubscriptionStatus.ACTIVE },
      _sum: { amount: true },
    });

    // Monthly revenue
    const now = new Date();
    const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthlyRevenueSum = await this.prisma.subscription.aggregate({
      where: {
        status: SubscriptionStatus.ACTIVE,
        created_at: { gte: firstDayOfMonth },
      },
      _sum: { amount: true },
    });

    return {
      totalCustomers,
      totalBusinesses,
      verifiedBusinesses,
      pendingApprovals,
      activeOffers,
      completedDeals,
      subscriptionRevenue: revenueSum._sum.amount || 0,
      monthlyRevenue: monthlyRevenueSum._sum.amount || 0,
    };
  }

  // ==========================================
  // ADMIN FEATURES
  // ==========================================

  // Business verification / approval
  async verifyBusiness(businessId: string, status: string) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) {
      throw new NotFoundException('Business owner not found');
    }

    const updated = await this.prisma.business.update({
      where: { id: businessId },
      data: { verification_status: status as VerificationStatus },
    });

    // Notify business owner about onboarding status change
    const isApproved = status === 'APPROVED' || status === 'VERIFIED';
    await this.notificationService.sendNotification(
      businessId,
      isApproved ? 'Store Onboarding Approved!' : 'Store Onboarding Updated',
      isApproved
        ? `Congratulations! Your store onboarding request for "${updated.business_name}" was APPROVED by the administrator. You can now post live BOGO and Group deals!`
        : `Your store onboarding status has been updated to: ${status}.`,
      'ONBOARDING_STATUS'
    ).catch(() => {});

    return updated;
  }

  // List businesses
  async listBusinesses(status?: string) {
    const where: any = {};
    if (status) {
      where.verification_status = status as VerificationStatus;
    }
    return this.prisma.business.findMany({
      where,
      include: {
        subscriptions: {
          orderBy: { created_at: 'desc' },
          take: 1,
        },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  // List customers
  async listCustomers() {
    return this.prisma.customer.findMany({
      orderBy: { created_at: 'desc' },
    });
  }

  // Offer moderation
  async moderateOffer(offerId: string, status: string) {
    const offer = await this.prisma.offer.findUnique({ where: { id: offerId } });
    if (!offer) {
      throw new NotFoundException('Offer not found');
    }

    return this.prisma.offer.update({
      where: { id: offerId },
      data: { status: status as OfferStatus },
    });
  }

  // List support tickets
  async listSupportTickets(status?: string) {
    const where: any = {};
    if (status) {
      where.status = status;
    }
    return this.prisma.supportTicket.findMany({
      where,
      orderBy: { created_at: 'desc' },
    });
  }

  // List subscriptions
  async listSubscriptions() {
    return this.prisma.subscription.findMany({
      include: {
        business: {
          select: {
            business_name: true,
            owner_name: true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  // Category summary
  async getCategories() {
    const offers = await this.prisma.offer.findMany({
      select: { category: true },
      distinct: ['category'],
    });
    return offers.map((o) => o.category);
  }
}
