import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NotificationModuleService {
  constructor(private prisma: PrismaService) {}

  async getUserNotifications(userId: string) {
    return this.prisma.notification.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
    });
  }

  async markAsRead(userId: string, notificationId?: string) {
    if (notificationId) {
      const notif = await this.prisma.notification.findUnique({
        where: { id: notificationId },
      });

      if (!notif) {
        throw new NotFoundException('Notification not found');
      }

      if (notif.user_id !== userId) {
        throw new ForbiddenException('You do not own this notification');
      }

      return this.prisma.notification.update({
        where: { id: notificationId },
        data: { is_read: true },
      });
    }

    // Mark all as read
    await this.prisma.notification.updateMany({
      where: { user_id: userId, is_read: false },
      data: { is_read: true },
    });

    return { success: true, message: 'All notifications marked as read' };
  }

  async deleteNotification(userId: string, notificationId: string) {
    const notif = await this.prisma.notification.findUnique({
      where: { id: notificationId },
    });

    if (!notif) {
      throw new NotFoundException('Notification not found');
    }

    if (notif.user_id !== userId) {
      throw new ForbiddenException('You do not own this notification');
    }

    await this.prisma.notification.delete({
      where: { id: notificationId },
    });

    return { success: true, message: 'Notification deleted successfully' };
  }

  async registerPushToken(userId: string, token: string, platform: string) {
    return this.prisma.pushToken.upsert({
      where: { token },
      update: { user_id: userId, platform },
      create: { token, user_id: userId, platform },
    });
  }
}
