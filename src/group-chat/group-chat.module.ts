import { Module } from '@nestjs/common';
import { GroupChatService } from './group-chat.service';
import {
  GroupChatController,
  GroupChatBusinessController,
} from './group-chat.controller';
import { AuthModule } from '../auth/auth.module';

// PrismaModule and CommonModule (which provides NotificationService) are
// both @Global(), so AuthModule (for JwtAuthGuard's JwtService) is the
// only import needed — mirrors LeadModule's import list.
@Module({
  imports: [AuthModule],
  controllers: [GroupChatController, GroupChatBusinessController],
  providers: [GroupChatService],
  exports: [GroupChatService],
})
export class GroupChatModule {}
