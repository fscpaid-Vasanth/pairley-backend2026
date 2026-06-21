import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../common/services/notification.service';
import { OtpService } from '../common/services/otp.service';
import { OfferType, OfferStatus, InterestStatus, SubscriptionStatus, VerificationStatus } from '@prisma/client';

@Injectable()
export class OfferService {
  constructor(
    private prisma: PrismaService,
    private notificationService: NotificationService,
    private otpService: OtpService
  ) {}

  async createOffer(businessId: string, data: any) {
    // 1. Verify business is verified
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      include: { subscriptions: true }
    });

    if (!business) {
      throw new NotFoundException('Business profile not found');
    }

    if (business.verification_status !== VerificationStatus.APPROVED) {
      throw new ForbiddenException('Your business account has not been approved by the administrator yet.');
    }

    // 2. Verify business has active subscription
    const activeSub = business.subscriptions.find(
      (sub) => sub.status === SubscriptionStatus.ACTIVE && new Date() < sub.expiry_date
    );

    if (!activeSub) {
      throw new ForbiddenException('An active subscription is required to publish offers.');
    }

    // 3. Create the offer
    return this.prisma.offer.create({
      data: {
        business_id: businessId,
        title: data.title,
        description: data.description,
        offer_type: data.offer_type as OfferType,
        category: data.category,
        original_price: parseFloat(data.original_price),
        offer_price: parseFloat(data.offer_price),
        required_people: parseInt(data.required_people),
        start_date: new Date(data.start_date),
        end_date: new Date(data.end_date),
        offer_image: data.offer_image || null,
        facility_images: data.facility_images || [],
        facility_details: data.facility_details || null,
        status: OfferStatus.ACTIVE, // Published directly as active for validated business
      },
    });
  }

  async updateOffer(businessId: string, offerId: string, data: any) {
    const offer = await this.prisma.offer.findUnique({ where: { id: offerId } });
    if (!offer) {
      throw new NotFoundException('Offer not found');
    }

    if (offer.business_id !== businessId) {
      throw new ForbiddenException('You do not own this offer');
    }

    const { id, business_id, created_at, updated_at, ...updates } = data;

    if (updates.original_price) updates.original_price = parseFloat(updates.original_price);
    if (updates.offer_price) updates.offer_price = parseFloat(updates.offer_price);
    if (updates.required_people) updates.required_people = parseInt(updates.required_people);
    if (updates.start_date) updates.start_date = new Date(updates.start_date);
    if (updates.end_date) updates.end_date = new Date(updates.end_date);
    if (updates.offer_type) updates.offer_type = updates.offer_type as OfferType;
    if (updates.status) updates.status = updates.status as OfferStatus;

    return this.prisma.offer.update({
      where: { id: offerId },
      data: updates,
    });
  }

  async deleteOffer(businessId: string, offerId: string) {
    const offer = await this.prisma.offer.findUnique({ where: { id: offerId } });
    if (!offer) {
      throw new NotFoundException('Offer not found');
    }

    if (offer.business_id !== businessId) {
      throw new ForbiddenException('You do not own this offer');
    }

    await this.prisma.offer.delete({ where: { id: offerId } });
    return { success: true, message: 'Offer deleted successfully' };
  }

  async listOffers(filters: { category?: string; businessId?: string; search?: string; status?: string; mall?: string }) {
    const whereClause: any = {};

    if (filters.category) {
      whereClause.category = filters.category;
    }
    if (filters.businessId) {
      whereClause.business_id = filters.businessId;
    }
    if (filters.status && filters.status !== 'ALL') {
      whereClause.status = filters.status as OfferStatus;
    } else if (!filters.status) {
      whereClause.status = OfferStatus.ACTIVE; // Active by default
    }

    if (filters.mall) {
      whereClause.business = {
        mall_name: filters.mall
      };
    }

    if (filters.search) {
      whereClause.OR = [
        { title: { contains: filters.search, mode: 'insensitive' } },
        { description: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    return this.prisma.offer.findMany({
      where: whereClause,
      include: {
        business: {
          select: {
            business_name: true,
            city: true,
            shop_photo: true,
            mall_name: true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  async getDetails(id: string) {
    const offer = await this.prisma.offer.findUnique({
      where: { id },
      include: {
        business: {
          select: {
            id: true,
            business_name: true,
            owner_name: true,
            mobile: true,
            email: true,
            address: true,
            city: true,
            state: true,
            shop_photo: true,
          },
        },
        interests: {
          include: {
            customer: {
              select: {
                id: true,
                name: true,
                mobile: true,
                email: true,
                city: true,
              },
            },
          },
        },
      },
    });

    if (!offer) {
      throw new NotFoundException('Offer not found');
    }

    return offer;
  }

  async getOffersByCategory(category: string) {
    return this.listOffers({ category });
  }

  async expressInterest(customerId: string, offerId: string) {
    // 1. Fetch offer details
    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
      include: { interests: true },
    });

    if (!offer) {
      throw new NotFoundException('Offer not found');
    }

    if (offer.status !== OfferStatus.ACTIVE) {
      throw new BadRequestException('This offer is not active');
    }

    // 2. Check if already joined
    const existing = await this.prisma.offerInterest.findUnique({
      where: {
        offer_id_customer_id: {
          offer_id: offerId,
          customer_id: customerId,
        },
      },
    });

    if (existing) {
      return { success: true, message: 'Already expressed interest in this offer', interest: existing };
    }

    // 3. Create interest
    const interest = await this.prisma.offerInterest.create({
      data: {
        offer_id: offerId,
        customer_id: customerId,
        status: InterestStatus.INTERESTED,
      },
    });

    // 4. Update offer joined_people count based on actual unique record count in DB
    const actualCount = await this.prisma.offerInterest.count({
      where: { offer_id: offerId }
    });

    const updatedOffer = await this.prisma.offer.update({
      where: { id: offerId },
      data: {
        joined_people: actualCount,
      },
      include: {
        interests: {
          include: { customer: true },
        },
        business: true,
      },
    });

    const currentInterest = updatedOffer.interests.find((i) => i.customer_id === customerId);
    const customerName = currentInterest?.customer?.name || 'A customer';
    const customerMobile = currentInterest?.customer?.mobile || '';
    const customerCity = currentInterest?.customer?.city || '';

    // Notify business owner about a partner joining
    await this.notificationService.sendNotification(
      updatedOffer.business_id,
      'Partner Joined Deal',
      `A new customer joined your offer: "${updatedOffer.title}"!\nName: ${customerName}\nContact: ${customerMobile}\nCity: ${customerCity}\nTotal joined: ${updatedOffer.joined_people}`,
      'Partner Joined'
    );

    // Send immediate SMS alert to shop owner's notification mobiles (up to 3)
    const interestSmsMsg = `Pairley Interest Alert! Customer ${customerName} (${customerMobile}) from ${customerCity} showed interest in your deal "${updatedOffer.title}".`;
    const notifMobiles = (updatedOffer.business.notification_mobiles || '')
      .split(',')
      .map((num) => num.trim())
      .filter((num) => /^\d{10}$/.test(num));

    if (notifMobiles.length === 0 && updatedOffer.business.mobile) {
      notifMobiles.push(updatedOffer.business.mobile);
    }

    for (const contact of notifMobiles.slice(0, 3)) {
      try {
        await this.otpService.sendSms(contact, interestSmsMsg);
      } catch (smsErr) {
        console.error(`Failed to send interest SMS to ${contact}:`, smsErr);
      }
    }

    // 5. Check if required target is reached
    if (updatedOffer.joined_people >= updatedOffer.required_people) {
      // Transition all interests for this offer to READY_TO_BUY
      await this.prisma.offerInterest.updateMany({
        where: { offer_id: offerId, status: InterestStatus.INTERESTED },
        data: { status: InterestStatus.READY_TO_BUY },
      });

      // Update offer status to CLOSED (meaning capacity reached)
      await this.prisma.offer.update({
        where: { id: offerId },
        data: { status: OfferStatus.CLOSED },
      });

      // Notify business owner (in-app/push)
      await this.notificationService.sendNotification(
        updatedOffer.business_id,
        'Offer Target Achieved!',
        `Your offer "${updatedOffer.title}" has reached the required participation of ${updatedOffer.required_people} people. You can now contact the ready buyers.`,
        'Offer Completed'
      );

      // Notify all customers who joined (in-app/push + SMS)
      const customerSmsMsg = `Pairley Match! Your deal for "${updatedOffer.title}" is completed. The business will contact you soon.`;
      for (const i of updatedOffer.interests) {
        try {
          await this.notificationService.sendNotification(
            i.customer_id,
            'Group Deal Completed!',
            `The deal for "${updatedOffer.title}" is ready! The business will contact you soon.`,
            'Offer Completed'
          );
        } catch (notifErr) {
          console.error(`Failed to send match completion in-app notification to customer ${i.customer_id}:`, notifErr);
        }
        if (i.customer.mobile) {
          try {
            await this.otpService.sendSms(i.customer.mobile, customerSmsMsg);
          } catch (smsErr) {
            console.error(`Failed to send match completion SMS to customer ${i.customer.mobile}:`, smsErr);
          }
        }
      }

      // Dispatch details to merchant notification mobile numbers
      const merchantContacts = (updatedOffer.business.notification_mobiles || '')
        .split(',')
        .map((num) => num.trim())
        .filter((num) => /^\d{10}$/.test(num));

      // Fallback to primary business number if no custom contacts saved
      if (merchantContacts.length === 0 && updatedOffer.business.mobile) {
        merchantContacts.push(updatedOffer.business.mobile);
      }

      if (merchantContacts.length > 0) {
        const buyersList = updatedOffer.interests
          .map((i, index) => `${index + 1}. ${i.customer.name} (${i.customer.mobile})`)
          .join(', ');
        const merchantSmsMsg = `Pairley Match Alert! Offer '${updatedOffer.title}' has matched. Buyers: ${buyersList}.`;

        for (const contact of merchantContacts.slice(0, 3)) { // Limit to up to 3 numbers
          try {
            await this.otpService.sendSms(contact, merchantSmsMsg);
          } catch (smsErr) {
            console.error(`Failed to send match completion SMS to merchant ${contact}:`, smsErr);
          }
        }
      }
    }

    return { success: true, message: 'Expressed interest successfully', interest };
  }

  async declareReadyToBuy(customerId: string, offerId: string) {
    const interest = await this.prisma.offerInterest.findUnique({
      where: {
        offer_id_customer_id: {
          offer_id: offerId,
          customer_id: customerId,
        },
      },
    });

    if (!interest) {
      throw new NotFoundException('You have not expressed interest in this offer yet');
    }

    const updatedInterest = await this.prisma.offerInterest.update({
      where: { id: interest.id },
      data: { status: InterestStatus.READY_TO_BUY },
    });

    return { success: true, message: 'Ready to buy status set successfully', interest: updatedInterest };
  }

  async getInterestedCustomers(businessId: string) {
    // Fetch all offers owned by this business, and list their interest lists
    return this.prisma.offer.findMany({
      where: { business_id: businessId },
      include: {
        interests: {
          include: {
            customer: {
              select: {
                id: true,
                name: true,
                mobile: true,
                email: true,
                city: true,
              },
            },
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  async updateInterestStatus(businessId: string, interestId: string, status: string) {
    const interest = await this.prisma.offerInterest.findUnique({
      where: { id: interestId },
      include: { offer: true },
    });

    if (!interest) {
      throw new NotFoundException('Interest record not found');
    }

    if (interest.offer.business_id !== businessId) {
      throw new ForbiddenException('You do not own the offer associated with this interest');
    }

    const updated = await this.prisma.offerInterest.update({
      where: { id: interestId },
      data: { status: status as any },
    });

    return { success: true, interest: updated };
  }

  async sendCoBuyMessage(customerId: string, dealId: string, data: any) {
    const interest = await this.prisma.offerInterest.findUnique({
      where: {
        offer_id_customer_id: {
          offer_id: dealId,
          customer_id: customerId,
        },
      },
    });

    if (!interest) {
      throw new BadRequestException('You must show interest in this deal to send messages.');
    }

    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId }
    });
    const senderName = customer?.name || 'Anonymous Buyer';

    const msg = await this.prisma.coBuyMessage.create({
      data: {
        deal_id: dealId,
        sender_id: customerId,
        sender_name: senderName,
        text: data.text,
        is_schedule_card: data.is_schedule_card ?? false,
        day: data.day || null,
        time_slot: data.time_slot || null,
        is_system: data.is_system ?? false,
      },
    });

    return msg;
  }

  async getCoBuyMessages(dealId: string) {
    return this.prisma.coBuyMessage.findMany({
      where: { deal_id: dealId },
      orderBy: { created_at: 'asc' },
    });
  }
}

