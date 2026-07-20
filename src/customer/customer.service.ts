import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CustomerService {
  constructor(private prisma: PrismaService) {}

  async getProfile(customerId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
    });
    if (!customer) {
      throw new NotFoundException('Customer not found');
    }
    return customer;
  }

  async updateProfile(customerId: string, data: any) {
    const {
      id,
      mobile,
      created_at,
      updated_at,
      verification_status,
      ...updates
    } = data;
    if (updates.date_of_birth) {
      updates.date_of_birth = new Date(updates.date_of_birth);
    }
    if (updates.age) {
      updates.age = parseInt(updates.age);
    }
    return this.prisma.customer.update({
      where: { id: customerId },
      data: updates,
    });
  }

  async getHistory(customerId: string) {
    return this.prisma.offerInterest.findMany({
      where: { customer_id: customerId },
      include: {
        offer: {
          include: {
            business: {
              select: {
                business_name: true,
                mobile: true,
                city: true,
              },
            },
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  async getSavedOffers(customerId: string) {
    const saved = await this.prisma.savedOffer.findMany({
      where: { customer_id: customerId },
      include: {
        offer: {
          include: {
            business: {
              select: {
                business_name: true,
              },
            },
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });
    return saved.map((s) => s.offer);
  }

  async saveOffer(customerId: string, offerId: string) {
    // Check if offer exists
    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
    });
    if (!offer) {
      throw new NotFoundException('Offer not found');
    }

    // Check if already saved
    const existing = await this.prisma.savedOffer.findUnique({
      where: {
        customer_id_offer_id: {
          customer_id: customerId,
          offer_id: offerId,
        },
      },
    });

    if (existing) {
      return { success: true, message: 'Offer already saved' };
    }

    await this.prisma.savedOffer.create({
      data: {
        customer_id: customerId,
        offer_id: offerId,
      },
    });

    return { success: true, message: 'Offer saved successfully' };
  }

  async unsaveOffer(customerId: string, offerId: string) {
    try {
      await this.prisma.savedOffer.delete({
        where: {
          customer_id_offer_id: {
            customer_id: customerId,
            offer_id: offerId,
          },
        },
      });
      return { success: true, message: 'Offer unsaved successfully' };
    } catch (error) {
      throw new NotFoundException('Saved offer record not found');
    }
  }
}
