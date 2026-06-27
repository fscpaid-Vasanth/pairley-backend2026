import { Controller, Post, Get, Put, Body, UseGuards, Param } from '@nestjs/common';
import { SupportService } from './support.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { IsNotEmpty, IsString, IsOptional } from 'class-validator';

class CreateTicketDto {
  @IsString()
  @IsNotEmpty()
  subject: string;

  @IsString()
  @IsNotEmpty()
  description: string;
}

class CreatePublicTicketDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsOptional()
  orderId?: string;

  @IsString()
  @IsNotEmpty()
  category: string;

  @IsString()
  @IsNotEmpty()
  description: string;
}

class CreateChatSessionDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  email: string;
}

class SendChatMessageDto {
  @IsString()
  @IsNotEmpty()
  ticketId: string;

  @IsString()
  @IsNotEmpty()
  sender: string; // 'user' or 'support'

  @IsString()
  @IsNotEmpty()
  text: string;
}

class ReplyTicketDto {
  @IsString()
  @IsNotEmpty()
  ticketId: string;

  @IsString()
  @IsNotEmpty()
  status: string;

  @IsString()
  @IsOptional()
  replyMessage?: string;
}

@Controller('support')
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  @Post('create-ticket')
  @UseGuards(JwtAuthGuard)
  async createTicket(@CurrentUser() user: any, @Body() body: CreateTicketDto) {
    return this.supportService.createTicket(user.sub, body);
  }

  @Post('public-ticket')
  async createPublicTicket(@Body() body: CreatePublicTicketDto) {
    return this.supportService.createPublicTicket(body);
  }

  @Post('chat-session')
  async createChatSession(@Body() body: CreateChatSessionDto) {
    return this.supportService.createChatSession(body);
  }

  @Post('chat-send')
  async sendChatMessage(@Body() body: SendChatMessageDto) {
    return this.supportService.sendChatMessage(body);
  }

  @Get('ticket/:id')
  async getTicketById(@Param('id') id: string) {
    return this.supportService.getTicketById(id);
  }

  @Get('tickets')
  @UseGuards(JwtAuthGuard)
  async getTickets(@CurrentUser() user: any) {
    return this.supportService.getTickets(user.sub, user.role);
  }

  @Put('reply')
  @UseGuards(JwtAuthGuard)
  async updateTicket(@CurrentUser() user: any, @Body() body: ReplyTicketDto) {
    return this.supportService.updateTicketStatus(user.sub, user.role, body.ticketId, body.status, body.replyMessage);
  }
}
