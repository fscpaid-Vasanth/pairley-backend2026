import {
  Injectable,
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
  OnModuleInit,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { OtpService } from '../common/services/otp.service';
import { VerificationStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private otpService: OtpService,
  ) {}

  async onModuleInit() {
    try {
      // Seed default admin account if it doesn't exist
      const adminCount = await this.prisma.admin.count();
      if (adminCount === 0) {
        const passwordHash = await bcrypt.hash('admin123', 10);
        await this.prisma.admin.create({
          data: {
            email: 'admin@pairley.com',
            password_hash: passwordHash,
            name: 'Super Admin',
          },
        });
        console.log('seeded default admin: admin@pairley.com / admin123');
      }
    } catch (error) {
      console.warn('Database is offline. Default admin seeding skipped.');
    }
  }

  async sendOtp(mobile: string) {
    const code = this.otpService.generateOtp();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes validity

    // Store in DB
    await this.prisma.otpVerification.create({
      data: {
        mobile,
        code,
        expires_at: expiresAt,
      },
    });

    const success = await this.otpService.sendOtp(mobile, code);
    if (!success) {
      throw new BadRequestException('Failed to send OTP. Please try again.');
    }

    return { success: true, message: 'OTP sent successfully' };
  }

  async verifyOtp(mobile: string, code: string) {
    let isVerified = false;

    if (this.otpService.useMock && (code === '1234' || code === '123456')) {
      isVerified = true;
    } else {
      const record = await this.prisma.otpVerification.findFirst({
        where: { mobile, code },
        orderBy: { created_at: 'desc' },
      });

      if (record) {
        if (new Date() > record.expires_at) {
          throw new BadRequestException('OTP code has expired');
        }
        isVerified = true;
        await this.prisma.otpVerification.deleteMany({ where: { mobile } });
      }
    }

    if (!isVerified) {
      throw new BadRequestException('Invalid OTP code');
    }

    // Check if customer or business owner exists with this mobile
    const customer = await this.prisma.customer.findUnique({
      where: { mobile },
    });
    const business = await this.prisma.business.findUnique({
      where: { mobile },
    });

    if (customer) {
      const token = this.generateToken(
        customer.id,
        customer.mobile,
        'Customer',
      );
      return { exists: true, role: 'Customer', token, user: customer };
    }

    if (business) {
      const token = this.generateToken(
        business.id,
        business.mobile,
        'Business',
      );
      return { exists: true, role: 'Business', token, user: business };
    }

    return {
      exists: false,
      message: 'OTP verified successfully. Please proceed to register.',
    };
  }

  async register(data: any) {
    const { role, mobile, email, name, ...extra } = data;
    const normalizedEmail = email?.trim().toLowerCase() || null;

    if (role === 'Customer') {
      const existingCustomer = await this.prisma.customer.findUnique({
        where: { mobile },
      });
      if (existingCustomer) {
        throw new BadRequestException(
          'Customer already registered with this mobile number',
        );
      }

      const customer = await this.prisma.customer.create({
        data: {
          name,
          mobile,
          email: normalizedEmail,
          password_hash: extra.password
            ? await bcrypt.hash(extra.password, 10)
            : null,
          gender: extra.gender || null,
          date_of_birth: extra.date_of_birth
            ? new Date(extra.date_of_birth)
            : null,
          age: extra.age ? parseInt(extra.age) : null,
          city: extra.city || null,
          state: extra.state || null,
          profile_photo: extra.profile_photo || null,
          referral_code: extra.referral_code || null,
          verification_status: VerificationStatus.VERIFIED, // verified automatically after OTP registration
        },
      });

      const token = this.generateToken(
        customer.id,
        customer.mobile,
        'Customer',
      );
      return { token, user: customer, role: 'Customer' };
    } else if (role === 'Business') {
      const existingBusiness = await this.prisma.business.findUnique({
        where: { mobile },
      });
      if (existingBusiness) {
        throw new BadRequestException(
          'Business owner already registered with this mobile number',
        );
      }

      const passwordHash = extra.password
        ? await bcrypt.hash(extra.password, 10)
        : null;

      const business = await this.prisma.business.create({
        data: {
          owner_name: name,
          business_name: extra.business_name || `${name}'s Shop`,
          business_type: extra.business_type || 'Retail',
          category: extra.category || 'General',
          mobile,
          email: normalizedEmail || '',
          password_hash: passwordHash,
          address: extra.address || '',
          city: extra.city || '',
          state: extra.state || '',
          pincode: extra.pincode || '',
          aadhaar_number: extra.aadhaar_number || null,
          pan_number: extra.pan_number || null,
          gst_number: extra.gst_number || null,
          shop_photo: extra.shop_photo || null,
          verification_status: VerificationStatus.PENDING, // needs admin approval
        },
      });

      const token = this.generateToken(
        business.id,
        business.mobile,
        'Business',
      );
      return { token, user: business, role: 'Business' };
    } else {
      throw new BadRequestException('Invalid registration role');
    }
  }

  async googleUpsert(data: any) {
    const { role, mobile, email, name, ...extra } = data;

    if (role === 'Customer') {
      // Check if customer already exists by mobile (Google UID mapped mobile)
      let customer = await this.prisma.customer.findUnique({
        where: { mobile },
      });

      if (!customer && email) {
        // Also try lookup by email for returning users
        customer = await this.prisma.customer.findUnique({ where: { email } });
      }

      if (customer) {
        // Returning user — just issue a new JWT token (login flow)
        const token = this.generateToken(
          customer.id,
          customer.mobile,
          'Customer',
        );
        return { token, user: customer, role: 'Customer' };
      }

      // New user — register
      customer = await this.prisma.customer.create({
        data: {
          name,
          mobile,
          email: email || null,
          gender: extra.gender || 'Other',
          city: extra.city || null,
          profile_photo: extra.profile_photo || null,
          verification_status: VerificationStatus.VERIFIED,
        },
      });
      const token = this.generateToken(
        customer.id,
        customer.mobile,
        'Customer',
      );
      return { token, user: customer, role: 'Customer' };
    } else if (role === 'Business') {
      let business = await this.prisma.business.findUnique({
        where: { mobile },
      });

      if (!business && email) {
        try {
          business = await this.prisma.business.findUnique({
            where: { email },
          });
        } catch (_) {}
      }

      if (business) {
        const token = this.generateToken(
          business.id,
          business.mobile,
          'Business',
        );
        return { token, user: business, role: 'Business' };
      }

      business = await this.prisma.business.create({
        data: {
          owner_name: name,
          business_name: extra.business_name || `${name}'s Shop`,
          business_type: extra.business_type || 'Retail',
          category: extra.category || 'General',
          mobile,
          email: email || '',
          address: extra.address || '',
          city: extra.city || '',
          state: extra.state || '',
          pincode: extra.pincode || '',
          shop_photo: extra.profile_photo || null,
          verification_status: VerificationStatus.PENDING,
        },
      });
      const token = this.generateToken(
        business.id,
        business.mobile,
        'Business',
      );
      return { token, user: business, role: 'Business' };
    } else {
      throw new BadRequestException('Invalid role for Google authentication');
    }
  }

  async login(identifier: string, password: string) {
    const normalizedIdentifier = identifier.trim();

    // 1. Try to find in admins
    const admin = normalizedIdentifier.includes('@')
      ? await this.prisma.admin.findUnique({
          where: { email: normalizedIdentifier.toLowerCase() },
        })
      : null;
    if (admin) {
      const match = await bcrypt.compare(password, admin.password_hash);
      if (!match) {
        throw new UnauthorizedException('Invalid admin credentials');
      }
      const token = this.generateToken(admin.id, '', 'Admin', admin.email);
      return {
        token,
        user: { id: admin.id, name: admin.name, email: admin.email },
        role: 'Admin',
      };
    }

    // 2. Try to find in businesses
    const business = normalizedIdentifier.includes('@')
      ? await this.prisma.business.findUnique({
          where: { email: normalizedIdentifier.toLowerCase() },
        })
      : await this.prisma.business.findUnique({
          where: { mobile: normalizedIdentifier },
        });
    if (business && business.password_hash) {
      const match = await bcrypt.compare(password, business.password_hash);
      if (!match) {
        throw new UnauthorizedException('Invalid business credentials');
      }
      const token = this.generateToken(
        business.id,
        business.mobile,
        'Business',
      );
      return { token, user: business, role: 'Business' };
    }

    // 3. Try to find in customers by mobile or email
    const customer = normalizedIdentifier.includes('@')
      ? await this.prisma.customer.findUnique({
          where: { email: normalizedIdentifier.toLowerCase() },
        })
      : await this.prisma.customer.findUnique({
          where: { mobile: normalizedIdentifier },
        });
    if (customer && !customer.password_hash) {
      throw new UnauthorizedException(
        'This account uses OTP login. Tap Login with OTP.',
      );
    }
    if (customer?.password_hash) {
      const match = await bcrypt.compare(password, customer.password_hash);
      if (!match) {
        throw new UnauthorizedException('Invalid customer credentials');
      }
      const token = this.generateToken(
        customer.id,
        customer.mobile,
        'Customer',
      );
      return { token, user: customer, role: 'Customer' };
    }

    throw new UnauthorizedException('Invalid login credentials');
  }

  async getProfile(userId: string, role: string) {
    if (role === 'Customer') {
      const customer = await this.prisma.customer.findUnique({
        where: { id: userId },
      });
      if (!customer) throw new NotFoundException('Customer profile not found');
      return customer;
    } else if (role === 'Business') {
      const business = await this.prisma.business.findUnique({
        where: { id: userId },
        include: { subscriptions: true },
      });
      if (!business) throw new NotFoundException('Business profile not found');
      return business;
    } else if (role === 'Admin') {
      const admin = await this.prisma.admin.findUnique({
        where: { id: userId },
      });
      if (!admin) throw new NotFoundException('Admin profile not found');
      return admin;
    }
    throw new BadRequestException('Invalid user role');
  }

  async updateProfile(userId: string, role: string, updates: any) {
    // Filter out restricted fields
    const {
      id,
      mobile,
      created_at,
      updated_at,
      verification_status,
      subscription_id,
      password_hash,
      ...validUpdates
    } = updates;

    if (role === 'Customer') {
      if (validUpdates.password) {
        validUpdates.password_hash = await bcrypt.hash(
          validUpdates.password,
          10,
        );
        delete validUpdates.password;
      }
      if (validUpdates.date_of_birth) {
        validUpdates.date_of_birth = new Date(validUpdates.date_of_birth);
      }
      if (validUpdates.age) {
        validUpdates.age = parseInt(validUpdates.age);
      }
      return this.prisma.customer.update({
        where: { id: userId },
        data: validUpdates,
      });
    } else if (role === 'Business') {
      if (validUpdates.password) {
        validUpdates.password_hash = await bcrypt.hash(
          validUpdates.password,
          10,
        );
        delete validUpdates.password;
      }
      return this.prisma.business.update({
        where: { id: userId },
        data: validUpdates,
      });
    } else if (role === 'Admin') {
      if (validUpdates.password) {
        validUpdates.password_hash = await bcrypt.hash(
          validUpdates.password,
          10,
        );
        delete validUpdates.password;
      }
      return this.prisma.admin.update({
        where: { id: userId },
        data: validUpdates,
      });
    }
    throw new BadRequestException('Invalid user role');
  }

  async deleteAccount(userId: string, role: string) {
    if (role === 'Customer') {
      await this.prisma.customer.delete({ where: { id: userId } });
      return {
        success: true,
        message: 'Customer account deleted successfully',
      };
    } else if (role === 'Business') {
      await this.prisma.business.delete({ where: { id: userId } });
      return {
        success: true,
        message: 'Business account deleted successfully',
      };
    } else if (role === 'Admin') {
      throw new BadRequestException(
        'Admin accounts cannot be deleted directly',
      );
    }
    throw new BadRequestException('Invalid user role');
  }

  private generateToken(
    id: string,
    mobile: string,
    role: string,
    email?: string,
  ) {
    return this.jwtService.sign({
      sub: id,
      mobile,
      role,
      email: email || '',
    });
  }
}
