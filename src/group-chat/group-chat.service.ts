import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../common/services/notification.service';
import { OfferStatus } from '@prisma/client';
import { renderGroupMessage, GroupMessageType } from './groupChatMessageTypes';

const MEMBER_NUMBER_START = 100; // first assigned member_number is 101

// V1 product decision: free-form TEXT messaging is permanently disabled —
// the group chat is a structured-coordination tool only (DATE_TIME/
// LOCATION/POLL), never a general social chat, to avoid customers sharing
// phone numbers/addresses/real names with strangers. Historical TEXT rows
// from before this change stay in the database (audit/history), but their
// content is never exposed to the customer-facing API — see getMessages()'s
// sanitization below, which replaces it with this neutral placeholder.
const TEXT_MESSAGING_DISABLED_MESSAGE =
  'Free-text messaging is no longer available in this chat. Use Date & Time, Location, or Poll to coordinate with the group.';
const LEGACY_TEXT_PLACEHOLDER = 'This message type is no longer supported.';
// A poll created under the pre-template contract ({question, options} as
// free text) — every current poll payload carries templateId, so its
// absence unambiguously identifies a legacy row. Sanitized the same way
// as legacy TEXT: never expose the original question/options, which may
// contain customer-typed personal info.
const LEGACY_POLL_PLACEHOLDER = 'This poll is no longer available.';

// Anonymous Customer-to-Customer Offer Group Chat. One offer = one group
// of every customer who has shown interest (a Lead row) in that offer.
// Deliberately separate from OfferService.sendCoBuyMessage()/
// getCoBuyMessages() (a different, narrower, legacy 2-person BOGO-pair
// coordination tool gated on OfferInterest, not every offer type, and
// which lets the business owner read messages) and from LeadService's
// LeadMessage thread (an anonymous 1:1 CUSTOMER<->MERCHANT chat — the
// opposite participant model). The merchant is never a participant here;
// see getBusinessGroupSummary(), which never selects a message text
// column at all.
@Injectable()
export class GroupChatService {
  constructor(
    private prisma: PrismaService,
    private notificationService: NotificationService,
  ) {}

  private async loadOfferOrThrow(offerId: string) {
    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
      select: { id: true, title: true, status: true, end_date: true },
    });
    if (!offer) {
      throw new NotFoundException('Offer not found');
    }
    return offer;
  }

  // Eligibility gate — the ONLY place that decides "does this caller have
  // any right to this offer's group at all." Requires an existing Lead
  // row keyed by the caller's own JWT id (never a client-supplied id).
  // Lead is the universal Show Interest record for every offer type,
  // unlike the legacy OfferInterest table the old co-buy chat gates on.
  private async assertEligible(offerId: string, customerId: string) {
    const lead = await this.prisma.lead.findUnique({
      where: {
        customer_id_offer_id: { customer_id: customerId, offer_id: offerId },
      },
    });
    if (!lead) {
      throw new ForbiddenException(
        'You must show interest in this offer to join its group chat.',
      );
    }
    return lead;
  }

  // Membership gate — requires an existing OfferGroupMember row (created
  // only via ensureMembership). A customer who is eligible (has a Lead)
  // but never actually opened the chat still cannot read/write/report.
  private async assertMembership(offerId: string, customerId: string) {
    const member = await this.prisma.offerGroupMember.findUnique({
      where: {
        offer_id_customer_id: { offer_id: offerId, customer_id: customerId },
      },
    });
    if (!member) {
      throw new ForbiddenException(
        "You have not joined this offer's group chat yet.",
      );
    }
    return member;
  }

  // Gates *sending* only — an already-closed offer's chat stays readable
  // (existing messages are never deleted), matching the product rule that
  // the group becomes read-only, not hidden, once the offer ends. Checked
  // directly against end_date (not just cached status) as defense-in-depth
  // against the hourly OfferExpiryScheduler sweep's lag window, mirroring
  // the same belt-and-suspenders pattern already used in
  // OfferService.listOffers().
  private assertOfferOpen(offer: {
    status: OfferStatus;
    end_date: Date;
  }): void {
    if (offer.status !== OfferStatus.ACTIVE || new Date() > offer.end_date) {
      throw new ForbiddenException(
        'This group chat is read-only — the offer has ended.',
      );
    }
  }

  // Idempotent "join." First successful call for a given (offerId,
  // customerId) creates the OfferGroupMember row with an atomically
  // -incremented member_number, writes an is_system announcement message,
  // and fires one Notification per EXISTING member (never the new
  // joiner). Repeat calls just return the existing membership, no side
  // effects. Allowed even if the offer has since closed, so a customer
  // who showed interest before expiry can still open the (read-only)
  // chat afterward.
  async ensureMembership(offerId: string, customerId: string) {
    const offer = await this.loadOfferOrThrow(offerId);
    await this.assertEligible(offerId, customerId);

    const existing = await this.prisma.offerGroupMember.findUnique({
      where: {
        offer_id_customer_id: { offer_id: offerId, customer_id: customerId },
      },
    });
    if (existing) {
      return { member: existing, isNew: false };
    }

    let member;
    try {
      const counter = await this.prisma.offerGroupCounter.upsert({
        where: { offer_id: offerId },
        create: { offer_id: offerId, seq: MEMBER_NUMBER_START + 1 },
        update: { seq: { increment: 1 } },
      });
      member = await this.prisma.offerGroupMember.create({
        data: {
          offer_id: offerId,
          customer_id: customerId,
          member_number: counter.seq,
        },
      });
    } catch (error) {
      // Concurrent double-join for the same customer (e.g. a double-
      // click) — @@unique([offer_id, customer_id]) rejects the second
      // insert. Treat it as success and return whichever row won the
      // race, rather than surfacing a raw constraint-violation error.
      if (error?.code === 'P2002') {
        const raced = await this.prisma.offerGroupMember.findUnique({
          where: {
            offer_id_customer_id: {
              offer_id: offerId,
              customer_id: customerId,
            },
          },
        });
        if (raced) return { member: raced, isNew: false };
      }
      throw error;
    }

    await this.prisma.offerGroupMessage.create({
      data: {
        offer_id: offerId,
        member_id: member.id,
        member_number: member.member_number,
        text: `Pairley Member ${member.member_number} joined the chat.`,
        is_system: true,
      },
    });

    this.notifyOtherMembers(offerId, member.id, offer.title).catch(() => {});

    return { member, isNew: true };
  }

  private async notifyOtherMembers(
    offerId: string,
    newMemberId: string,
    offerTitle: string,
  ) {
    const others = await this.prisma.offerGroupMember.findMany({
      where: { offer_id: offerId, id: { not: newMemberId } },
      select: { customer_id: true },
    });
    await Promise.allSettled(
      others.map((m) =>
        this.notificationService.sendNotification(
          m.customer_id,
          'Someone joined your group chat',
          `A new member just joined the anonymous group chat for "${offerTitle}."`,
          'GROUP_MEMBER_JOINED',
          offerId,
        ),
      ),
    );
  }

  async getMessages(offerId: string, customerId: string) {
    const member = await this.assertMembership(offerId, customerId);

    const blocks = await this.prisma.offerGroupBlock.findMany({
      where: { offer_id: offerId, blocker_member_id: member.id },
      select: { blocked_member_id: true },
    });
    const blockedIds = blocks.map((b) => b.blocked_member_id);

    const messages = await this.prisma.offerGroupMessage.findMany({
      where: {
        offer_id: offerId,
        ...(blockedIds.length > 0 ? { member_id: { notIn: blockedIds } } : {}),
      },
      orderBy: { created_at: 'asc' },
    });

    // Server-computed ownership flag, derived from the caller's own JWT-
    // resolved membership row — never a client-supplied id. The frontend
    // should render off this rather than comparing member_id itself, so a
    // client-side state bug can never misattribute a message's sender.
    //
    // Also sanitizes any pre-existing free-text TEXT message here — never
    // exposing its original content to the customer-facing API. Only
    // non-system TEXT rows are affected: the is_system join announcement
    // ("Pairley Member 101 joined the chat.") is backend-generated, never
    // contains customer-supplied content, and must keep displaying as-is.
    //
    // Likewise sanitizes any pre-template-catalog POLL row (identified by
    // the absence of payload.templateId, which every current poll always
    // has) — its payload is cleared too, not just its text, so the
    // frontend can never attempt to render its old free-text options.
    const withOwnership = messages.map((msg) => {
      const isLegacyText = msg.type === 'TEXT' && !msg.is_system;
      const isLegacyPoll =
        msg.type === 'POLL' &&
        !(
          msg.payload &&
          typeof msg.payload === 'object' &&
          'templateId' in (msg.payload as Record<string, unknown>)
        );
      return {
        ...msg,
        text: isLegacyText
          ? LEGACY_TEXT_PLACEHOLDER
          : isLegacyPoll
            ? LEGACY_POLL_PLACEHOLDER
            : msg.text,
        payload: isLegacyPoll ? null : msg.payload,
        isMine: msg.member_id === member.id,
      };
    });

    return this.attachPollTallies(withOwnership, member.id);
  }

  // Computed at read time via groupBy, not denormalized — vote counts are
  // bounded by group size (no scale concern for a per-offer chat), and a
  // denormalized counter would need extra bookkeeping the moment
  // votePoll() allows a member to change their vote (decrement the old
  // bucket, increment the new one, atomically). One extra indexed groupBy
  // per read is simpler and has no meaningful cost at this scale.
  private async attachPollTallies(
    messages: Array<{ id: string; type: string }>,
    callerMemberId: string,
  ) {
    const pollIds = messages.filter((m) => m.type === 'POLL').map((m) => m.id);
    if (pollIds.length === 0) return messages;

    const [tallyRows, myVotes] = await Promise.all([
      this.prisma.offerGroupPollVote.groupBy({
        by: ['message_id', 'option_index'],
        where: { message_id: { in: pollIds } },
        _count: true,
      }),
      this.prisma.offerGroupPollVote.findMany({
        where: { message_id: { in: pollIds }, member_id: callerMemberId },
        select: { message_id: true, option_index: true },
      }),
    ]);

    const myVoteByMessage = new Map(
      myVotes.map((v) => [v.message_id, v.option_index]),
    );

    return messages.map((msg: any) => {
      if (msg.type !== 'POLL') return msg;
      // Zero-filled by option count first — an option with zero votes must
      // read as 0, never a sparse-array hole `undefined` the frontend
      // would have to special-case.
      const optionCount = Array.isArray(msg.payload?.options)
        ? msg.payload.options.length
        : 0;
      const tallies: number[] = new Array(optionCount).fill(0);
      for (const row of tallyRows) {
        if (row.message_id !== msg.id) continue;
        tallies[row.option_index] = row._count;
      }
      return {
        ...msg,
        tallies,
        myVote: myVoteByMessage.has(msg.id)
          ? myVoteByMessage.get(msg.id)
          : null,
      };
    });
  }

  // Free-form TEXT messaging is permanently disabled for V1 — see
  // TEXT_MESSAGING_DISABLED_MESSAGE. Rejects unconditionally, before any
  // membership/offer lookup or DB write: this is a blanket policy
  // rejection that applies regardless of who's asking or the offer's
  // state, not a per-request validation outcome. A direct API call bypassing
  // the UI gets this exact same 403 — the capability does not exist at the
  // backend, not merely hidden in the composer.
  sendMessage(): Promise<never> {
    return Promise.reject(
      new ForbiddenException(TEXT_MESSAGING_DISABLED_MESSAGE),
    );
  }

  // Same gate sequence as sendMessage() (assertMembership -> assertOfferOpen)
  // — a separate method rather than an optional-type branch inside
  // sendMessage(), so the existing free-text contract (POST messages,
  // { text }) stays completely untouched and stable. renderGroupMessage()
  // is the only place that decides what `text`/`payload` actually get
  // stored — this method never trusts a client-supplied display string for
  // a structured type.
  async sendStructuredMessage(
    offerId: string,
    customerId: string,
    type: GroupMessageType,
    payload: unknown,
  ) {
    const member = await this.assertMembership(offerId, customerId);
    const offer = await this.loadOfferOrThrow(offerId);
    this.assertOfferOpen(offer);

    const rendered = renderGroupMessage(type, payload);

    return this.prisma.offerGroupMessage.create({
      data: {
        offer_id: offerId,
        member_id: member.id,
        member_number: member.member_number,
        type: rendered.type,
        text: rendered.text,
        // Matches lead.service.ts's identical `as any` cast for the same
        // Prisma Json-field typing gap (Record<string,unknown> isn't
        // directly assignable to InputJsonValue).
        ...(rendered.payload ? { payload: rendered.payload as any } : {}),
      },
    });
  }

  // Voting is a form of "sending" — same membership + offer-open gates as
  // sendMessage()/sendStructuredMessage(). Upsert (not create-only)
  // deliberately allows a member to change their vote; there's no stated
  // requirement against it, and re-voting is the natural expectation for a
  // "which day works" coordination poll.
  async votePoll(
    offerId: string,
    customerId: string,
    messageId: string,
    optionIndex: number,
  ) {
    const member = await this.assertMembership(offerId, customerId);
    const offer = await this.loadOfferOrThrow(offerId);
    this.assertOfferOpen(offer);

    const message = await this.prisma.offerGroupMessage.findUnique({
      where: { id: messageId },
    });
    if (!message || message.offer_id !== offerId) {
      throw new NotFoundException('Poll message not found');
    }
    if (message.type !== 'POLL') {
      throw new BadRequestException('This message is not a poll.');
    }
    const options = Array.isArray((message.payload as any)?.options)
      ? ((message.payload as any).options as unknown[])
      : [];
    if (
      !Number.isInteger(optionIndex) ||
      optionIndex < 0 ||
      optionIndex >= options.length
    ) {
      throw new BadRequestException('Invalid poll option.');
    }

    await this.prisma.offerGroupPollVote.upsert({
      where: {
        message_id_member_id: { message_id: messageId, member_id: member.id },
      },
      create: {
        message_id: messageId,
        member_id: member.id,
        option_index: optionIndex,
      },
      update: { option_index: optionIndex },
    });

    return { success: true };
  }

  async reportMessage(
    offerId: string,
    customerId: string,
    messageId: string,
    reason?: string,
  ) {
    const member = await this.assertMembership(offerId, customerId);
    const message = await this.prisma.offerGroupMessage.findUnique({
      where: { id: messageId },
    });
    if (!message || message.offer_id !== offerId) {
      throw new NotFoundException('Message not found');
    }
    // Never expose the reporter's identity to the reported member — this
    // row is admin-review-only, no notification/visibility to the target.
    await this.prisma.offerGroupReport.create({
      data: {
        offer_id: offerId,
        reporter_member_id: member.id,
        target_member_id: message.member_id,
        message_id: message.id,
        reason: reason || null,
      },
    });
    return { success: true };
  }

  async reportMember(
    offerId: string,
    customerId: string,
    targetMemberId: string,
    reason?: string,
  ) {
    const member = await this.assertMembership(offerId, customerId);
    const target = await this.prisma.offerGroupMember.findUnique({
      where: { id: targetMemberId },
    });
    if (!target || target.offer_id !== offerId) {
      throw new NotFoundException('Member not found');
    }
    await this.prisma.offerGroupReport.create({
      data: {
        offer_id: offerId,
        reporter_member_id: member.id,
        target_member_id: targetMemberId,
        reason: reason || null,
      },
    });
    return { success: true };
  }

  async blockMember(
    offerId: string,
    customerId: string,
    targetMemberId: string,
  ) {
    const member = await this.assertMembership(offerId, customerId);
    if (targetMemberId === member.id) {
      throw new BadRequestException('You cannot block yourself.');
    }
    const target = await this.prisma.offerGroupMember.findUnique({
      where: { id: targetMemberId },
    });
    if (!target || target.offer_id !== offerId) {
      throw new NotFoundException('Member not found');
    }
    // Per-viewer mute, not a platform ban — only excludes the blocked
    // member's messages from the blocker's own feed (see getMessages()).
    await this.prisma.offerGroupBlock.upsert({
      where: {
        offer_id_blocker_member_id_blocked_member_id: {
          offer_id: offerId,
          blocker_member_id: member.id,
          blocked_member_id: targetMemberId,
        },
      },
      create: {
        offer_id: offerId,
        blocker_member_id: member.id,
        blocked_member_id: targetMemberId,
      },
      update: {},
    });
    return { success: true };
  }

  async unblockMember(
    offerId: string,
    customerId: string,
    targetMemberId: string,
  ) {
    const member = await this.assertMembership(offerId, customerId);
    await this.prisma.offerGroupBlock.deleteMany({
      where: {
        offer_id: offerId,
        blocker_member_id: member.id,
        blocked_member_id: targetMemberId,
      },
    });
    return { success: true };
  }

  // Merchant-facing aggregate ONLY. Deliberately never queries
  // OfferGroupMessage or selects a text column anywhere in this method —
  // "merchant sees counts, never content" is structural here, not a
  // permission check that could later be misconfigured. businessId always
  // comes from the caller's own JWT (user.sub), never a client-supplied
  // id — see GroupChatBusinessController.
  async getBusinessGroupSummary(
    businessId: string,
  ): Promise<Record<string, { activeMembers: number; todayGrowth: number }>> {
    const offers = await this.prisma.offer.findMany({
      where: { business_id: businessId },
      select: { id: true },
    });
    const offerIds = offers.map((o) => o.id);

    const summary: Record<
      string,
      { activeMembers: number; todayGrowth: number }
    > = {};
    for (const offerId of offerIds) {
      summary[offerId] = { activeMembers: 0, todayGrowth: 0 };
    }
    if (offerIds.length === 0) return summary;

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const members = await this.prisma.offerGroupMember.findMany({
      where: { offer_id: { in: offerIds } },
      select: { offer_id: true, joined_at: true },
    });

    for (const m of members) {
      summary[m.offer_id].activeMembers += 1;
      if (m.joined_at >= startOfToday) {
        summary[m.offer_id].todayGrowth += 1;
      }
    }
    return summary;
  }
}
