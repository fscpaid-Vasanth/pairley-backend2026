import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import {
  IsString,
  IsOptional,
  IsObject,
  IsIn,
  IsInt,
  Min,
  MaxLength,
} from 'class-validator';
import { GroupChatService } from './group-chat.service';
import type { GroupMessageType } from './groupChatMessageTypes';
import { QUICK_REPLIES, POLL_TEMPLATES } from './groupChatMessageTypes';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, Role } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

// Only the four structured types a client may originate — free-form TEXT
// is permanently disabled for V1 (see GroupChatService.sendMessage()) and
// has no DTO of its own any more; the POST messages route below takes no
// body at all. class-validator only confirms the shape here;
// renderGroupMessage() in groupChatMessageTypes.ts is the real
// payload-content enforcement point — in particular, for QUICK_REPLY, a
// client-supplied `text` inside payload is silently ignored there in favor
// of the server-side catalog, so this DTO's IsObject() shape check is
// intentionally as far as validation goes here.
class SendStructuredGroupMessageDto {
  @IsIn(['DATE_TIME', 'LOCATION', 'POLL', 'QUICK_REPLY'])
  type: GroupMessageType;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}

class VotePollDto {
  @IsInt()
  @Min(0)
  optionIndex: number;
}

class ReportDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

// Anonymous Customer-to-Customer Offer Group Chat — see GroupChatService
// for the full participant-model rationale. Every route here is
// Role.CUSTOMER only; the merchant-facing aggregate lives on the
// separate GroupChatBusinessController below, which never touches
// message content.
@Controller('offers/:offerId/group')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.CUSTOMER)
export class GroupChatController {
  constructor(private readonly groupChatService: GroupChatService) {}

  @Post('join')
  async join(@CurrentUser() user: any, @Param('offerId') offerId: string) {
    return this.groupChatService.ensureMembership(offerId, user.sub);
  }

  @Get('messages')
  async getMessages(
    @CurrentUser() user: any,
    @Param('offerId') offerId: string,
  ) {
    return this.groupChatService.getMessages(offerId, user.sub);
  }

  // Static, global catalog — not offer-specific, but kept under this
  // offer-scoped path for routing consistency with the rest of the
  // controller. The frontend renders these as buttons; a client can never
  // submit anything but the id of one of these.
  @Get('quick-replies')
  getQuickReplies() {
    return QUICK_REPLIES;
  }

  // Static, global catalog — same rationale as quick-replies above. The
  // frontend renders these as a template picker, then an option
  // checklist (or, for LOCATION, the existing location-picker flow); a
  // client can only ever submit a templateId + optionIds/locations, never
  // a question or option text — see groupChatMessageTypes.ts's
  // resolvePollPayload() for the actual enforcement.
  @Get('poll-templates')
  getPollTemplates() {
    return POLL_TEMPLATES;
  }

  // Free-form TEXT messaging is permanently disabled for V1 — see
  // GroupChatService.sendMessage(). The route stays wired (rather than
  // removed) specifically so a direct API call bypassing the removed UI
  // composer still gets a real 403, not a 404.
  @Post('messages')
  async sendMessage() {
    return this.groupChatService.sendMessage();
  }

  // Kept as a separate route from POST messages (free text) rather than
  // overloading that endpoint with an optional type — the existing
  // { text } contract stays completely stable regardless of anything
  // added here.
  @Post('messages/structured')
  async sendStructuredMessage(
    @CurrentUser() user: any,
    @Param('offerId') offerId: string,
    @Body() body: SendStructuredGroupMessageDto,
  ) {
    return this.groupChatService.sendStructuredMessage(
      offerId,
      user.sub,
      body.type,
      body.payload,
    );
  }

  @Post('messages/:messageId/vote')
  async votePoll(
    @CurrentUser() user: any,
    @Param('offerId') offerId: string,
    @Param('messageId') messageId: string,
    @Body() body: VotePollDto,
  ) {
    return this.groupChatService.votePoll(
      offerId,
      user.sub,
      messageId,
      body.optionIndex,
    );
  }

  @Post('messages/:messageId/report')
  async reportMessage(
    @CurrentUser() user: any,
    @Param('offerId') offerId: string,
    @Param('messageId') messageId: string,
    @Body() body: ReportDto,
  ) {
    return this.groupChatService.reportMessage(
      offerId,
      user.sub,
      messageId,
      body.reason,
    );
  }

  @Post('members/:memberId/report')
  async reportMember(
    @CurrentUser() user: any,
    @Param('offerId') offerId: string,
    @Param('memberId') memberId: string,
    @Body() body: ReportDto,
  ) {
    return this.groupChatService.reportMember(
      offerId,
      user.sub,
      memberId,
      body.reason,
    );
  }

  @Post('members/:memberId/block')
  async blockMember(
    @CurrentUser() user: any,
    @Param('offerId') offerId: string,
    @Param('memberId') memberId: string,
  ) {
    return this.groupChatService.blockMember(offerId, user.sub, memberId);
  }

  @Delete('members/:memberId/block')
  async unblockMember(
    @CurrentUser() user: any,
    @Param('offerId') offerId: string,
    @Param('memberId') memberId: string,
  ) {
    return this.groupChatService.unblockMember(offerId, user.sub, memberId);
  }
}

// Merchant-facing aggregate demand view. Deliberately a completely
// separate controller (not a role-override on GroupChatController) so
// there is no shared route surface at all between merchant and customer
// access — see GroupChatService.getBusinessGroupSummary()'s comment for
// why this can never leak message content.
@Controller('group-chat')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.BUSINESS)
export class GroupChatBusinessController {
  constructor(private readonly groupChatService: GroupChatService) {}

  @Get('summary')
  async summary(@CurrentUser() user: any) {
    return this.groupChatService.getBusinessGroupSummary(user.sub);
  }
}
