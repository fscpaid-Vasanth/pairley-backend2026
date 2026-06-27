import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SupportStatus } from '@prisma/client';
import * as nodemailer from 'nodemailer';

export interface CreatePublicTicketDto {
  name: string;
  email: string;
  orderId?: string;
  category: string;
  description: string;
}

export interface CreateChatSessionDto {
  name: string;
  email: string;
}

export interface SendChatMessageDto {
  ticketId: string;
  sender: string;
  text: string;
}

@Injectable()
export class SupportService {
  constructor(private prisma: PrismaService) {}

  private async sendTicketEmail(data: { name: string; email: string; orderId?: string; category: string; description: string; ref: string }) {
    const host = process.env.SMTP_HOST || '';
    const port = parseInt(process.env.SMTP_PORT || '587');
    const user = process.env.SMTP_USER || '';
    const pass = process.env.SMTP_PASS || '';

    const subject = `[SUPPORT TICKET] Reference: ${data.ref} - ${data.category.toUpperCase()}`;
    const text = `
New Help Desk Ticket Submitted:

Reference ID: ${data.ref}
Full Name: ${data.name}
Email Address: ${data.email}
Order Reference: ${data.orderId || 'None'}
Support Topic: ${data.category}

Message Description:
${data.description}

This is an automated copy of the ticket sent to support@pairley.com.
`;

    if (host && user && pass) {
      try {
        const transporter = nodemailer.createTransport({
          host,
          port,
          secure: port === 465,
          auth: { user, pass },
        });

        await transporter.sendMail({
          from: `"Pairley Support" <${user}>`,
          to: 'support@pairley.com',
          subject,
          text,
        });
        console.log(`Support ticket email sent successfully to support@pairley.com for ref: ${data.ref}`);
      } catch (err) {
        console.error(`Failed to send support email via SMTP:`, err);
      }
    } else {
      console.log(`[MOCK EMAIL DISPATCH] To: support@pairley.com\nSubject: ${subject}\nBody:\n${text}`);
    }
  }

  async createTicket(userId: string, data: { subject: string; description: string }) {
    return this.prisma.supportTicket.create({
      data: {
        user_id: userId,
        subject: data.subject,
        description: data.description,
        status: SupportStatus.OPEN,
      },
    });
  }

  async createPublicTicket(data: CreatePublicTicketDto) {
    const tktRef = `TKT-${Math.random().toString(16).substring(2, 6).toUpperCase()}`;
    const serializedDescription = `[Sender] ${data.name} (${data.email})\n[Topic] ${data.category}\n[Order] ${data.orderId || 'None'}\n\n[Message]\n${data.description}`;

    const ticket = await this.prisma.supportTicket.create({
      data: {
        user_id: 'guest',
        subject: `[${data.category.toUpperCase()}] ${data.name} - ${tktRef}`,
        description: serializedDescription,
        status: SupportStatus.OPEN,
      },
    });

    await this.sendTicketEmail({
      name: data.name,
      email: data.email,
      orderId: data.orderId,
      category: data.category,
      description: data.description,
      ref: tktRef
    });

    return { success: true, ticketId: ticket.id, ref: tktRef };
  }

  async createChatSession(data: CreateChatSessionDto) {
    const tktRef = `CHAT-${Math.random().toString(16).substring(2, 6).toUpperCase()}`;
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const serializedDescription = `[Sender] ${data.name} (${data.email})\n[Topic] Live Chat Support\n[Order] None\n[Messages]\nBot [${timeStr}]: Hello! I am Pairley Bot. 🤖 How can I assist you with your co-buying matches today?`;

    const ticket = await this.prisma.supportTicket.create({
      data: {
        user_id: 'guest',
        subject: `[CHAT] ${data.name} - ${tktRef}`,
        description: serializedDescription,
        status: SupportStatus.OPEN,
      },
    });

    return { success: true, ticketId: ticket.id, ref: tktRef };
  }

  async sendChatMessage(data: SendChatMessageDto) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: data.ticketId }
    });

    if (!ticket) {
      throw new NotFoundException('Support session not found');
    }

    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const senderLabel = data.sender === 'user' ? 'User' : 'Support';
    const updatedDescription = `${ticket.description}\n${senderLabel} [${timeStr}]: ${data.text}`;

    return this.prisma.supportTicket.update({
      where: { id: data.ticketId },
      data: {
        description: updatedDescription
      }
    });
  }

  async getTicketById(id: string) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id }
    });
    if (!ticket) {
      throw new NotFoundException('Ticket not found');
    }
    return ticket;
  }

  async getTickets(userId: string, role: string) {
    if (role === 'Admin') {
      return this.prisma.supportTicket.findMany({
        orderBy: { created_at: 'desc' },
      });
    }

    return this.prisma.supportTicket.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
    });
  }

  async updateTicketStatus(userId: string, role: string, ticketId: string, status: string, replyMessage?: string) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
    });

    if (!ticket) {
      throw new NotFoundException('Support ticket not found');
    }

    if (role !== 'Admin' && ticket.user_id !== userId) {
      throw new ForbiddenException('You do not have permission to modify this ticket');
    }

    const updatedData: any = {
      status: status as SupportStatus,
    };

    if (replyMessage) {
      const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (ticket.subject.startsWith('[CHAT]')) {
        updatedData.description = `${ticket.description}\nSupport [${timeStr}]: ${replyMessage}`;
      } else {
        updatedData.description = `${ticket.description}\n\n[Reply from ${role} at ${new Date().toLocaleString()}]: ${replyMessage}`;
      }
    }

    return this.prisma.supportTicket.update({
      where: { id: ticketId },
      data: updatedData,
    });
  }
}
