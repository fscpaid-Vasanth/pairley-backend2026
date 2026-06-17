import { PrismaClient, OfferType, OfferStatus, VerificationStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';

dotenv.config();

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/pairley';
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('Starting database seeding...');

  // 1. Clean up existing data in order
  console.log('Cleaning up existing data...');
  try {
    await prisma.offerInterest.deleteMany({});
    await prisma.offer.deleteMany({});
    await prisma.business.deleteMany({});
    await prisma.customer.deleteMany({});
    await prisma.admin.deleteMany({});
  } catch (err) {
    console.log('Tables empty or not initialized. Skipping delete phase.');
  }

  const passwordHash = await bcrypt.hash('password123', 10);

  // 2. Seed Admin
  console.log('Seeding admin...');
  await prisma.admin.create({
    data: {
      email: 'admin@pairley.com',
      password_hash: passwordHash,
      name: 'Super Admin',
    },
  });

  // 3. Seed Customers
  console.log('Seeding customers...');
  const arjun = await prisma.customer.create({
    data: {
      id: 'cust-001',
      name: 'Arjun Mehta',
      email: 'arjun.mehta@email.com',
      mobile: '9876543210',
      password_hash: passwordHash,
      gender: 'Male',
      city: 'Mumbai',
      verification_status: VerificationStatus.VERIFIED,
    },
  });

  const priya = await prisma.customer.create({
    data: {
      id: 'cust-002',
      name: 'Priya Sharma',
      email: 'priya.sharma@email.com',
      mobile: '8765432109',
      password_hash: passwordHash,
      gender: 'Female',
      city: 'Delhi',
      verification_status: VerificationStatus.VERIFIED,
    },
  });

  const rahul = await prisma.customer.create({
    data: {
      id: 'cust-003',
      name: 'Rahul Krishnan',
      email: 'rahul.k@email.com',
      mobile: '7654321098',
      password_hash: passwordHash,
      city: 'Bangalore',
      verification_status: VerificationStatus.VERIFIED,
    },
  });

  const sneha = await prisma.customer.create({
    data: {
      id: 'cust-004',
      name: 'Sneha Patel',
      email: 'sneha.p@email.com',
      mobile: '6543210987',
      password_hash: passwordHash,
      gender: 'Female',
      city: 'Ahmedabad',
      verification_status: VerificationStatus.VERIFIED,
    },
  });

  const vikram = await prisma.customer.create({
    data: {
      id: 'cust-005',
      name: 'Vikram Singh',
      email: 'vikram.s@email.com',
      mobile: '5432109876',
      password_hash: passwordHash,
      city: 'Chennai',
      verification_status: VerificationStatus.VERIFIED,
    },
  });

  // 4. Seed Businesses
  console.log('Seeding businesses...');
  const techzone = await prisma.business.create({
    data: {
      id: 'biz-001',
      owner_name: 'Rajesh Kumar',
      business_name: 'TechZone Electronics',
      business_type: 'shopping',
      category: 'shopping',
      email: 'rajesh@techzone.in',
      mobile: '9876511111',
      password_hash: passwordHash,
      address: 'Shop 22, Cyber Plaza, Sector 62',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400001',
      verification_status: VerificationStatus.APPROVED,
    },
  });

  const wanderlust = await prisma.business.create({
    data: {
      id: 'biz-002',
      owner_name: 'Meera Nair',
      business_name: 'Wanderlust Travels',
      business_type: 'tours',
      category: 'tours',
      email: 'meera@wanderlust.in',
      mobile: '8765422222',
      password_hash: passwordHash,
      address: '45 Lotus Lane, Beach Road',
      city: 'Kochi',
      state: 'Kerala',
      pincode: '682001',
      verification_status: VerificationStatus.APPROVED,
    },
  });

  const spiceroute = await prisma.business.create({
    data: {
      id: 'biz-003',
      owner_name: 'Amit Sharma',
      business_name: 'Spice Route Restaurant',
      business_type: 'dining',
      category: 'dining',
      email: 'amit@spiceroute.in',
      mobile: '7654333333',
      password_hash: passwordHash,
      address: 'FC Road, Near Deccan Gymkhana',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411004',
      verification_status: VerificationStatus.APPROVED,
    },
  });

  const glowup = await prisma.business.create({
    data: {
      id: 'biz-004',
      owner_name: 'Kavitha Reddy',
      business_name: 'GlowUp Salon & Spa',
      business_type: 'beauty',
      category: 'beauty',
      email: 'kavitha@glowup.in',
      mobile: '6543244444',
      password_hash: passwordHash,
      address: 'Jubilee Hills Road No. 36',
      city: 'Hyderabad',
      state: 'Telangana',
      pincode: '500033',
      verification_status: VerificationStatus.APPROVED,
    },
  });

  const fitlife = await prisma.business.create({
    data: {
      id: 'biz-005',
      owner_name: 'Suresh Kumar',
      business_name: 'FitLife Gym',
      business_type: 'fitness',
      category: 'fitness',
      email: 'suresh@fitlife.in',
      mobile: '5432155555',
      password_hash: passwordHash,
      address: 'Indiranagar 100 Feet Road',
      city: 'Bangalore',
      state: 'Karnataka',
      pincode: '560038',
      verification_status: VerificationStatus.APPROVED,
    },
  });

  // 5. Seed Offers (Deals)
  console.log('Seeding offers...');
  const dateStart = new Date();
  const dateEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days later

  const deal1 = await prisma.offer.create({
    data: {
      id: 'deal-001',
      business_id: techzone.id,
      title: 'Samsung Galaxy Buds FE — Buy 1 Get 1',
      description: 'Premium wireless earbuds with Active Noise Cancellation. Crystal clear sound quality with all-day battery life. Find your pair partner and save 50%!',
      offer_type: OfferType.BOGO,
      category: 'shopping',
      original_price: 6999,
      offer_price: 3499,
      required_people: 2,
      joined_people: 1,
      start_date: dateStart,
      end_date: dateEnd,
      offer_image: 'https://images.unsplash.com/photo-1590658268037-6bf12f032f55?w=600&h=400&fit=crop',
      status: OfferStatus.ACTIVE,
    },
  });

  const deal2 = await prisma.offer.create({
    data: {
      id: 'deal-002',
      business_id: techzone.id,
      title: 'Nike Air Max 270 — BOGO Pair Deal',
      description: 'Iconic Air Max comfort meets modern style. Available in all sizes. Pair up with someone who loves the same style and split the cost!',
      offer_type: OfferType.BOGO,
      category: 'shopping',
      original_price: 12995,
      offer_price: 6497,
      required_people: 2,
      joined_people: 0,
      start_date: dateStart,
      end_date: dateEnd,
      offer_image: 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=600&h=400&fit=crop',
      status: OfferStatus.ACTIVE,
    },
  });

  const deal3 = await prisma.offer.create({
    data: {
      id: 'deal-003',
      business_id: glowup.id,
      title: 'Luxury Spa Day — Couples BOGO Package',
      description: 'Full body massage, facial, and steam session for 90 minutes. Get the ultimate relaxation experience at half the price when you pair up!',
      offer_type: OfferType.BOGO,
      category: 'beauty',
      original_price: 4500,
      offer_price: 2250,
      required_people: 2,
      joined_people: 1,
      start_date: dateStart,
      end_date: dateEnd,
      offer_image: 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=600&h=400&fit=crop',
      status: OfferStatus.ACTIVE,
    },
  });

  const deal4 = await prisma.offer.create({
    data: {
      id: 'deal-004',
      business_id: spiceroute.id,
      title: 'Pizza Paradise — Buy 1 Get 1 Free',
      description: 'Two large gourmet pizzas with premium toppings. Choose from 20+ varieties. Perfect for sharing the deal with a fellow pizza lover!',
      offer_type: OfferType.BOGO,
      category: 'dining',
      original_price: 1299,
      offer_price: 649,
      required_people: 2,
      joined_people: 2,
      start_date: dateStart,
      end_date: dateEnd,
      offer_image: 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=600&h=400&fit=crop',
      status: OfferStatus.ACTIVE,
    },
  });

  const deal5 = await prisma.offer.create({
    data: {
      id: 'deal-005',
      business_id: fitlife.id,
      title: 'Annual Gym Membership — Pair & Save',
      description: '12-month gym membership with access to all equipment, group classes, and a personal trainer session. Pair up to get 50% off!',
      offer_type: OfferType.BOGO,
      category: 'fitness',
      original_price: 24000,
      offer_price: 12000,
      required_people: 2,
      joined_people: 1,
      start_date: dateStart,
      end_date: dateEnd,
      offer_image: 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=600&h=400&fit=crop',
      status: OfferStatus.ACTIVE,
    },
  });

  const deal6 = await prisma.offer.create({
    data: {
      id: 'deal-006',
      business_id: wanderlust.id,
      title: 'Manali Adventure Trip — Group Discount',
      description: '5 Days / 4 Nights trek and sightseeing tour in Manali. Includes accommodation, meals, adventure activities, and transport. Join the group to unlock tiers!',
      offer_type: OfferType.GROUP_DISCOUNT,
      category: 'tours',
      original_price: 15000,
      offer_price: 9999,
      required_people: 15,
      joined_people: 8,
      start_date: dateStart,
      end_date: dateEnd,
      offer_image: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=600&h=400&fit=crop',
      status: OfferStatus.ACTIVE,
    },
  });

  // 6. Seed Offer Interests
  console.log('Seeding offer interests...');
  // Arjun is interested in buds FE (deal-001)
  await prisma.offerInterest.create({
    data: {
      offer_id: deal1.id,
      customer_id: arjun.id,
      status: 'INTERESTED',
    },
  });

  // Priya is interested in Spa Day (deal-003)
  await prisma.offerInterest.create({
    data: {
      offer_id: deal3.id,
      customer_id: priya.id,
      status: 'INTERESTED',
    },
  });

  // Rahul is interested in Pizza (deal-004) and completed matching with Sneha
  await prisma.offerInterest.create({
    data: {
      offer_id: deal4.id,
      customer_id: rahul.id,
      status: 'COMPLETED',
    },
  });

  await prisma.offerInterest.create({
    data: {
      offer_id: deal4.id,
      customer_id: sneha.id,
      status: 'COMPLETED',
    },
  });

  console.log('Database seeding finished successfully!');
}

main()
  .catch((e) => {
    console.error('Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
