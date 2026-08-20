import { GroupChatService } from './group-chat.service';
import {
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';

// Anonymous Customer-to-Customer Offer Group Chat. Covers: eligibility
// (Lead-gated, universal across offer types — not the legacy
// OfferInterest table), membership (separate from eligibility — a
// customer must have actually joined, not merely be eligible), the
// "someone else joined" notification excluding the new joiner, offer
// expiry gating sends but not reads, message length/emptiness
// validation, and blocking excluding a member's messages from the
// blocker's own feed only.
describe('GroupChatService', () => {
  const OFFER_ID = 'offer-1';
  const CUSTOMER_A = 'cust-a';
  const CUSTOMER_B = 'cust-b';

  const makeOffer = (overrides = {}) => ({
    id: OFFER_ID,
    title: 'Glow Together: Buy 2 Get 3rd',
    status: 'ACTIVE',
    end_date: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
  });

  const makeLead = (customerId: string) => ({
    id: `lead-${customerId}`,
    customer_id: customerId,
    offer_id: OFFER_ID,
  });

  const makeMember = (customerId: string, memberNumber: number) => ({
    id: `member-${customerId}`,
    offer_id: OFFER_ID,
    customer_id: customerId,
    member_number: memberNumber,
    joined_at: new Date(),
  });

  const makePrisma = () => ({
    offer: { findUnique: jest.fn(), findMany: jest.fn() },
    lead: { findUnique: jest.fn() },
    offerGroupMember: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
    offerGroupCounter: { upsert: jest.fn() },
    offerGroupMessage: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    offerGroupReport: { create: jest.fn() },
    offerGroupBlock: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    offerGroupPollVote: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn(),
    },
  });

  const makeNotificationService = () => ({
    sendNotification: jest.fn().mockResolvedValue(true),
  });

  let prisma: ReturnType<typeof makePrisma>;
  let notificationService: ReturnType<typeof makeNotificationService>;
  let service: GroupChatService;

  beforeEach(() => {
    prisma = makePrisma();
    notificationService = makeNotificationService();
    service = new GroupChatService(prisma as any, notificationService as any);
  });

  describe('ensureMembership — eligibility and join', () => {
    it('rejects a customer with no Lead for this offer', async () => {
      prisma.offer.findUnique.mockResolvedValue(makeOffer());
      prisma.lead.findUnique.mockResolvedValue(null);

      await expect(
        service.ensureMembership(OFFER_ID, CUSTOMER_A),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.offerGroupMember.create).not.toHaveBeenCalled();
    });

    it('404s on a non-existent offer, before checking eligibility', async () => {
      prisma.offer.findUnique.mockResolvedValue(null);

      await expect(
        service.ensureMembership(OFFER_ID, CUSTOMER_A),
      ).rejects.toThrow(NotFoundException);
    });

    it('creates the first member with a sequential member_number and an announcement message', async () => {
      prisma.offer.findUnique.mockResolvedValue(makeOffer());
      prisma.lead.findUnique.mockResolvedValue(makeLead(CUSTOMER_A));
      prisma.offerGroupMember.findUnique.mockResolvedValue(null);
      prisma.offerGroupCounter.upsert.mockResolvedValue({
        offer_id: OFFER_ID,
        seq: 101,
      });
      const created = makeMember(CUSTOMER_A, 101);
      prisma.offerGroupMember.create.mockResolvedValue(created);
      prisma.offerGroupMember.findMany.mockResolvedValue([]); // no other members yet

      const result = await service.ensureMembership(OFFER_ID, CUSTOMER_A);

      expect(result).toEqual({ member: created, isNew: true });
      expect(prisma.offerGroupMember.create).toHaveBeenCalledWith({
        data: {
          offer_id: OFFER_ID,
          customer_id: CUSTOMER_A,
          member_number: 101,
        },
      });
      expect(prisma.offerGroupMessage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          offer_id: OFFER_ID,
          member_id: created.id,
          member_number: 101,
          text: 'Pairley Member 101 joined the chat.',
          is_system: true,
        }),
      });
    });

    it('is idempotent — a second join call returns the existing membership with isNew: false, no new message or notification', async () => {
      const existing = makeMember(CUSTOMER_A, 101);
      prisma.offer.findUnique.mockResolvedValue(makeOffer());
      prisma.lead.findUnique.mockResolvedValue(makeLead(CUSTOMER_A));
      prisma.offerGroupMember.findUnique.mockResolvedValue(existing);

      const result = await service.ensureMembership(OFFER_ID, CUSTOMER_A);

      expect(result).toEqual({ member: existing, isNew: false });
      expect(prisma.offerGroupMember.create).not.toHaveBeenCalled();
      expect(prisma.offerGroupMessage.create).not.toHaveBeenCalled();
      expect(notificationService.sendNotification).not.toHaveBeenCalled();
    });

    it('notifies existing members but never the new joiner', async () => {
      prisma.offer.findUnique.mockResolvedValue(makeOffer());
      prisma.lead.findUnique.mockResolvedValue(makeLead(CUSTOMER_B));
      prisma.offerGroupMember.findUnique.mockResolvedValue(null);
      prisma.offerGroupCounter.upsert.mockResolvedValue({
        offer_id: OFFER_ID,
        seq: 102,
      });
      const newMember = makeMember(CUSTOMER_B, 102);
      prisma.offerGroupMember.create.mockResolvedValue(newMember);
      const existingMember = makeMember(CUSTOMER_A, 101);
      prisma.offerGroupMember.findMany.mockResolvedValue([existingMember]);

      await service.ensureMembership(OFFER_ID, CUSTOMER_B);
      // notifyOtherMembers is fire-and-forget — flush microtasks.
      await new Promise((r) => setImmediate(r));

      expect(prisma.offerGroupMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { offer_id: OFFER_ID, id: { not: newMember.id } },
        }),
      );
      expect(notificationService.sendNotification).toHaveBeenCalledTimes(1);
      const [notifiedUserId, , , notifType] =
        notificationService.sendNotification.mock.calls[0];
      expect(notifiedUserId).toBe(CUSTOMER_A); // the existing member, not CUSTOMER_B
      expect(notifType).toBe('GROUP_MEMBER_JOINED');
    });

    it('treats a concurrent double-join (P2002 unique violation) as success, returning the winning row', async () => {
      prisma.offer.findUnique.mockResolvedValue(makeOffer());
      prisma.lead.findUnique.mockResolvedValue(makeLead(CUSTOMER_A));
      prisma.offerGroupMember.findUnique
        .mockResolvedValueOnce(null) // first check: not a member yet
        .mockResolvedValueOnce(makeMember(CUSTOMER_A, 101)); // re-fetch after the race
      prisma.offerGroupCounter.upsert.mockResolvedValue({
        offer_id: OFFER_ID,
        seq: 101,
      });
      const raceError: any = new Error('Unique constraint failed');
      raceError.code = 'P2002';
      prisma.offerGroupMember.create.mockRejectedValue(raceError);

      const result = await service.ensureMembership(OFFER_ID, CUSTOMER_A);

      expect(result.isNew).toBe(false);
      expect(result.member.member_number).toBe(101);
    });
  });

  describe('membership gate — eligible but never joined', () => {
    it('rejects getMessages for a customer with a Lead but no OfferGroupMember row', async () => {
      prisma.offerGroupMember.findUnique.mockResolvedValue(null);
      await expect(service.getMessages(OFFER_ID, CUSTOMER_A)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // V1 product decision: free-form TEXT messaging is permanently disabled.
  // sendMessage() must reject every call unconditionally — regardless of
  // membership, offer state, or content — since the capability itself no
  // longer exists at the backend, not merely hidden in the UI.
  describe('sendMessage — permanently disabled (structured-only V1 chat)', () => {
    it('rejects with 403 without touching membership, offer, or message tables', async () => {
      await expect(service.sendMessage()).rejects.toThrow(ForbiddenException);
      expect(prisma.offerGroupMember.findUnique).not.toHaveBeenCalled();
      expect(prisma.offer.findUnique).not.toHaveBeenCalled();
      expect(prisma.offerGroupMessage.create).not.toHaveBeenCalled();
    });

    it('rejects even for a real member on an open offer, regardless of content', async () => {
      prisma.offer.findUnique.mockResolvedValue(makeOffer());
      prisma.offerGroupMember.findUnique.mockResolvedValue(
        makeMember(CUSTOMER_A, 101),
      );
      await expect(service.sendMessage()).rejects.toThrow(
        'Free-text messaging is no longer available in this chat. Use Date & Time, Location, or Poll to coordinate with the group.',
      );
    });

    // getMessages() does NOT gate on offer-open — closed offers stay
    // readable, only sending is blocked.
    it('getMessages still succeeds for an expired offer', async () => {
      prisma.offerGroupMember.findUnique.mockResolvedValue(
        makeMember(CUSTOMER_A, 101),
      );
      prisma.offerGroupMessage.findMany.mockResolvedValue([{ id: 'msg-1' }]);
      const result = await service.getMessages(OFFER_ID, CUSTOMER_A);
      expect(result).toEqual([{ id: 'msg-1', isMine: false }]);
    });
  });

  // A direct API call bypassing the removed composer must be rejected the
  // exact same way as any other caller — the sanitization tests below cover
  // what happens to TEXT rows that already exist in the database.
  describe('getMessages — legacy TEXT sanitization', () => {
    beforeEach(() => {
      prisma.offerGroupMember.findUnique.mockResolvedValue(
        makeMember(CUSTOMER_A, 101),
      );
    });

    it('replaces a historical non-system TEXT message with a neutral placeholder, never the original content', async () => {
      prisma.offerGroupMessage.findMany.mockResolvedValue([
        {
          id: 'msg-1',
          type: 'TEXT',
          is_system: false,
          text: 'call me at 9876543210',
          member_id: 'member-cust-a',
        },
      ]);
      const [result] = await service.getMessages(OFFER_ID, CUSTOMER_A);
      expect(result.text).toBe('This message type is no longer supported.');
      expect(result.text).not.toContain('9876543210');
    });

    it('leaves the backend-generated system join announcement untouched', async () => {
      prisma.offerGroupMessage.findMany.mockResolvedValue([
        {
          id: 'msg-1',
          type: 'TEXT',
          is_system: true,
          text: 'Pairley Member 101 joined the chat.',
          member_id: 'member-cust-a',
        },
      ]);
      const [result] = await service.getMessages(OFFER_ID, CUSTOMER_A);
      expect(result.text).toBe('Pairley Member 101 joined the chat.');
    });

    it('leaves structured DATE_TIME/LOCATION/POLL text untouched', async () => {
      prisma.offerGroupMessage.findMany.mockResolvedValue([
        {
          id: 'msg-1',
          type: 'DATE_TIME',
          is_system: false,
          text: '📅 Proposed: 22 Aug 2026 at 6:30 PM',
          member_id: 'member-cust-a',
        },
      ]);
      const [result] = await service.getMessages(OFFER_ID, CUSTOMER_A);
      expect(result.text).toBe('📅 Proposed: 22 Aug 2026 at 6:30 PM');
    });
  });

  describe('blocking — per-viewer mute', () => {
    it("excludes a blocked member's messages only from the blocker's own feed", async () => {
      prisma.offerGroupMember.findUnique.mockResolvedValue(
        makeMember(CUSTOMER_A, 101),
      );
      prisma.offerGroupBlock.findMany.mockResolvedValue([
        { blocked_member_id: 'member-cust-b' },
      ]);
      prisma.offerGroupMessage.findMany.mockResolvedValue([]);

      await service.getMessages(OFFER_ID, CUSTOMER_A);

      expect(prisma.offerGroupMessage.findMany).toHaveBeenCalledWith({
        where: {
          offer_id: OFFER_ID,
          member_id: { notIn: ['member-cust-b'] },
        },
        orderBy: { created_at: 'asc' },
      });
    });

    it('rejects blocking yourself', async () => {
      const self = makeMember(CUSTOMER_A, 101);
      prisma.offerGroupMember.findUnique.mockResolvedValue(self);
      await expect(
        service.blockMember(OFFER_ID, CUSTOMER_A, self.id),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('reporting — never exposes reporter identity to the target', () => {
    it('records a message report without notifying or otherwise touching the target', async () => {
      prisma.offerGroupMember.findUnique.mockResolvedValue(
        makeMember(CUSTOMER_A, 101),
      );
      prisma.offerGroupMessage.findUnique.mockResolvedValue({
        id: 'msg-1',
        offer_id: OFFER_ID,
        member_id: 'member-cust-b',
      });
      prisma.offerGroupReport.create.mockResolvedValue({});

      const result = await service.reportMessage(
        OFFER_ID,
        CUSTOMER_A,
        'msg-1',
        'inappropriate',
      );

      expect(result).toEqual({ success: true });
      expect(prisma.offerGroupReport.create).toHaveBeenCalledWith({
        data: {
          offer_id: OFFER_ID,
          reporter_member_id: 'member-cust-a',
          target_member_id: 'member-cust-b',
          message_id: 'msg-1',
          reason: 'inappropriate',
        },
      });
      expect(notificationService.sendNotification).not.toHaveBeenCalled();
    });
  });

  describe('getBusinessGroupSummary — merchant aggregate only', () => {
    it('never queries OfferGroupMessage and returns counts only', async () => {
      prisma.offer.findMany.mockResolvedValue([{ id: OFFER_ID }]);
      const now = new Date();
      const today = new Date(now);
      today.setHours(12, 0, 0, 0);
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      prisma.offerGroupMember.findMany.mockResolvedValue([
        { offer_id: OFFER_ID, joined_at: today },
        { offer_id: OFFER_ID, joined_at: yesterday },
      ]);

      const summary = await service.getBusinessGroupSummary('biz-1');

      expect(summary[OFFER_ID]).toEqual({ activeMembers: 2, todayGrowth: 1 });
      expect((prisma as any).offerGroupMessage.findMany).not.toHaveBeenCalled();
    });

    it('returns an empty summary for a business with no offers', async () => {
      prisma.offer.findMany.mockResolvedValue([]);
      const summary = await service.getBusinessGroupSummary('biz-empty');
      expect(summary).toEqual({});
    });
  });

  describe('sendStructuredMessage — same gates as sendMessage, structured payloads', () => {
    beforeEach(() => {
      prisma.offerGroupMember.findUnique.mockResolvedValue(
        makeMember(CUSTOMER_A, 101),
      );
    });

    it('rejects a caller who is eligible but never joined (same membership gate as sendMessage)', async () => {
      prisma.offerGroupMember.findUnique.mockResolvedValue(null);
      await expect(
        service.sendStructuredMessage(OFFER_ID, CUSTOMER_A, 'POLL', {
          templateId: 'DATE',
          optionIds: ['SATURDAY', 'SUNDAY'],
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects sending once the offer has expired (same gate as sendMessage)', async () => {
      prisma.offer.findUnique.mockResolvedValue(
        makeOffer({ status: 'EXPIRED' }),
      );
      await expect(
        service.sendStructuredMessage(OFFER_ID, CUSTOMER_A, 'DATE_TIME', {
          date: '2026-07-29',
          time: '10:00',
        }),
      ).rejects.toThrow('This group chat is read-only — the offer has ended.');
    });

    it('rejects an invalid payload via renderGroupMessage — never reaches the DB write', async () => {
      prisma.offer.findUnique.mockResolvedValue(makeOffer());
      await expect(
        service.sendStructuredMessage(OFFER_ID, CUSTOMER_A, 'DATE_TIME', {
          date: 'not-a-date',
          time: '10:00',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.offerGroupMessage.create).not.toHaveBeenCalled();
    });

    it('creates a message with the backend-rendered type/text/payload, never client-supplied text', async () => {
      prisma.offer.findUnique.mockResolvedValue(makeOffer());
      prisma.offerGroupMessage.create.mockResolvedValue({ id: 'msg-1' });

      await service.sendStructuredMessage(OFFER_ID, CUSTOMER_A, 'LOCATION', {
        lat: 12.9,
        lng: 77.6,
        label: 'Forum Mall',
        source: 'CURRENT',
      });

      expect(prisma.offerGroupMessage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          offer_id: OFFER_ID,
          member_id: 'member-cust-a',
          type: 'LOCATION',
          text: '📍 Forum Mall',
          payload: {
            lat: 12.9,
            lng: 77.6,
            label: 'Forum Mall',
            source: 'CURRENT',
          },
        }),
      });
    });

    it('creates a QUICK_REPLY message using the catalog text for a valid replyId', async () => {
      prisma.offer.findUnique.mockResolvedValue(makeOffer());
      prisma.offerGroupMessage.create.mockResolvedValue({ id: 'msg-1' });

      await service.sendStructuredMessage(OFFER_ID, CUSTOMER_A, 'QUICK_REPLY', {
        replyId: 'SATURDAY_WORKS',
      });

      expect(prisma.offerGroupMessage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          offer_id: OFFER_ID,
          member_id: 'member-cust-a',
          type: 'QUICK_REPLY',
          text: 'Saturday works for me.',
          payload: {
            replyId: 'SATURDAY_WORKS',
            text: 'Saturday works for me.',
          },
        }),
      });
    });

    it('rejects an unknown replyId with 400, never reaching the DB write', async () => {
      prisma.offer.findUnique.mockResolvedValue(makeOffer());
      await expect(
        service.sendStructuredMessage(OFFER_ID, CUSTOMER_A, 'QUICK_REPLY', {
          replyId: 'NOT_A_REAL_ID',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.offerGroupMessage.create).not.toHaveBeenCalled();
    });

    // The actual anti-bypass proof: even a direct API call supplying
    // arbitrary text alongside a valid replyId never gets that text stored
    // — only the catalog's own text for that id is ever written.
    it('cannot smuggle arbitrary text through QUICK_REPLY — catalog text always wins', async () => {
      prisma.offer.findUnique.mockResolvedValue(makeOffer());
      prisma.offerGroupMessage.create.mockResolvedValue({ id: 'msg-1' });

      await service.sendStructuredMessage(OFFER_ID, CUSTOMER_A, 'QUICK_REPLY', {
        replyId: 'SATURDAY_WORKS',
        text: 'Call me at 9876543210',
      });

      const call = prisma.offerGroupMessage.create.mock.calls[0][0];
      expect(call.data.text).toBe('Saturday works for me.');
      expect(call.data.text).not.toContain('9876543210');
    });

    // sendMessage() (the disabled free-text path) is entirely separate from
    // sendStructuredMessage() and must stay rejected regardless of what
    // structured sends succeed — confirms disabling one didn't accidentally
    // touch the other's gates or behavior.
    it('sendMessage stays permanently disabled alongside a working sendStructuredMessage()', async () => {
      prisma.offer.findUnique.mockResolvedValue(makeOffer());
      prisma.offerGroupMessage.create.mockResolvedValue({ id: 'msg-1' });

      await service.sendStructuredMessage(OFFER_ID, CUSTOMER_A, 'DATE_TIME', {
        date: '2026-08-22',
        time: '18:30',
      });
      expect(prisma.offerGroupMessage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ type: 'DATE_TIME' }),
      });

      await expect(service.sendMessage()).rejects.toThrow(ForbiddenException);
    });
  });

  describe('votePoll', () => {
    const POLL_MESSAGE = {
      id: 'poll-1',
      offer_id: OFFER_ID,
      type: 'POLL',
      payload: {
        templateId: 'DATE',
        question: 'When should we go?',
        options: ['Saturday', 'Sunday'],
        optionIds: ['SATURDAY', 'SUNDAY'],
      },
    };

    beforeEach(() => {
      prisma.offerGroupMember.findUnique.mockResolvedValue(
        makeMember(CUSTOMER_A, 101),
      );
      prisma.offer.findUnique.mockResolvedValue(makeOffer());
    });

    it('rejects voting on a non-existent message', async () => {
      prisma.offerGroupMessage.findUnique.mockResolvedValue(null);
      await expect(
        service.votePoll(OFFER_ID, CUSTOMER_A, 'poll-1', 0),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects voting on a message that is not a poll', async () => {
      prisma.offerGroupMessage.findUnique.mockResolvedValue({
        ...POLL_MESSAGE,
        type: 'TEXT',
      });
      await expect(
        service.votePoll(OFFER_ID, CUSTOMER_A, 'poll-1', 0),
      ).rejects.toThrow('This message is not a poll.');
    });

    it('rejects an out-of-range option index', async () => {
      prisma.offerGroupMessage.findUnique.mockResolvedValue(POLL_MESSAGE);
      await expect(
        service.votePoll(OFFER_ID, CUSTOMER_A, 'poll-1', 5),
      ).rejects.toThrow('Invalid poll option.');
      await expect(
        service.votePoll(OFFER_ID, CUSTOMER_A, 'poll-1', -1),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects voting once the offer has expired (voting is a form of sending)', async () => {
      prisma.offer.findUnique.mockResolvedValue(
        makeOffer({ status: 'CLOSED' }),
      );
      prisma.offerGroupMessage.findUnique.mockResolvedValue(POLL_MESSAGE);
      await expect(
        service.votePoll(OFFER_ID, CUSTOMER_A, 'poll-1', 0),
      ).rejects.toThrow('This group chat is read-only — the offer has ended.');
    });

    it('upserts the vote, keyed on [message_id, member_id] — allows changing a vote', async () => {
      prisma.offerGroupMessage.findUnique.mockResolvedValue(POLL_MESSAGE);
      prisma.offerGroupPollVote.upsert.mockResolvedValue({});

      const result = await service.votePoll(OFFER_ID, CUSTOMER_A, 'poll-1', 1);

      expect(result).toEqual({ success: true });
      expect(prisma.offerGroupPollVote.upsert).toHaveBeenCalledWith({
        where: {
          message_id_member_id: {
            message_id: 'poll-1',
            member_id: 'member-cust-a',
          },
        },
        create: {
          message_id: 'poll-1',
          member_id: 'member-cust-a',
          option_index: 1,
        },
        update: { option_index: 1 },
      });
    });
  });

  describe('getMessages — poll tally attachment', () => {
    beforeEach(() => {
      prisma.offerGroupMember.findUnique.mockResolvedValue(
        makeMember(CUSTOMER_A, 101),
      );
    });

    it('leaves non-poll structured message content untouched, only adding isMine', async () => {
      prisma.offerGroupMessage.findMany.mockResolvedValue([
        {
          id: 'msg-1',
          type: 'DATE_TIME',
          text: '📅 Proposed: 22 Aug 2026 at 6:30 PM',
          member_id: 'member-cust-a',
        },
      ]);
      const result = await service.getMessages(OFFER_ID, CUSTOMER_A);
      expect(result).toEqual([
        {
          id: 'msg-1',
          type: 'DATE_TIME',
          text: '📅 Proposed: 22 Aug 2026 at 6:30 PM',
          member_id: 'member-cust-a',
          isMine: true,
        },
      ]);
      expect(prisma.offerGroupPollVote.groupBy).not.toHaveBeenCalled();
    });

    // Directly reproduces the reported "every message shows as YOU"
    // scenario with two real, distinct members reading the same feed —
    // each caller's own membership row (resolved server-side from their
    // own JWT via assertMembership(), never a client-supplied id) must
    // produce the opposite isMine flag for the same two messages.
    it('computes isMine independently and correctly for two different callers reading the same messages', async () => {
      const messages = [
        {
          id: 'msg-a',
          type: 'TEXT',
          text: 'from A',
          member_id: 'member-cust-a',
        },
        {
          id: 'msg-b',
          type: 'TEXT',
          text: 'from B',
          member_id: 'member-cust-b',
        },
      ];
      prisma.offerGroupMessage.findMany.mockResolvedValue(messages);

      prisma.offerGroupMember.findUnique.mockResolvedValueOnce(
        makeMember(CUSTOMER_A, 101),
      );
      const asA = await service.getMessages(OFFER_ID, CUSTOMER_A);
      expect(asA.map((m: any) => m.isMine)).toEqual([true, false]);

      prisma.offerGroupMember.findUnique.mockResolvedValueOnce(
        makeMember(CUSTOMER_B, 102),
      );
      const asB = await service.getMessages(OFFER_ID, CUSTOMER_B);
      expect(asB.map((m: any) => m.isMine)).toEqual([false, true]);
    });

    it('attaches zero-filled tallies and myVote:null when nobody has voted yet', async () => {
      prisma.offerGroupMessage.findMany.mockResolvedValue([
        {
          id: 'poll-1',
          type: 'POLL',
          member_id: 'member-cust-b',
          payload: {
            templateId: 'DATE',
            question: 'Q',
            options: ['A', 'B', 'C'],
          },
        },
      ]);
      prisma.offerGroupPollVote.groupBy.mockResolvedValue([]);
      prisma.offerGroupPollVote.findMany.mockResolvedValue([]);

      const [result] = await service.getMessages(OFFER_ID, CUSTOMER_A);

      expect(result.tallies).toEqual([0, 0, 0]);
      expect(result.myVote).toBeNull();
      // Ownership flag must survive the poll-tally spread untouched — a
      // poll created by someone else is still not "mine" just because I
      // voted on it.
      expect(result.isMine).toBe(false);
    });

    it("attaches real tallies per option index and the caller's own vote", async () => {
      prisma.offerGroupMessage.findMany.mockResolvedValue([
        {
          id: 'poll-1',
          type: 'POLL',
          payload: {
            templateId: 'DATE',
            question: 'Q',
            options: ['A', 'B', 'C'],
          },
        },
      ]);
      prisma.offerGroupPollVote.groupBy.mockResolvedValue([
        { message_id: 'poll-1', option_index: 0, _count: 3 },
        { message_id: 'poll-1', option_index: 2, _count: 1 },
      ]);
      prisma.offerGroupPollVote.findMany.mockResolvedValue([
        { message_id: 'poll-1', option_index: 0 },
      ]);

      const [result] = await service.getMessages(OFFER_ID, CUSTOMER_A);

      expect(result.tallies).toEqual([3, 0, 1]);
      expect(result.myVote).toBe(0);
    });

    it('does not disturb the existing blocked-member filter', async () => {
      prisma.offerGroupBlock.findMany.mockResolvedValue([
        { blocked_member_id: 'member-cust-b' },
      ]);
      prisma.offerGroupMessage.findMany.mockResolvedValue([]);

      await service.getMessages(OFFER_ID, CUSTOMER_A);

      expect(prisma.offerGroupMessage.findMany).toHaveBeenCalledWith({
        where: {
          offer_id: OFFER_ID,
          member_id: { notIn: ['member-cust-b'] },
        },
        orderBy: { created_at: 'asc' },
      });
    });

    // A poll created under the pre-template contract (no templateId in its
    // payload) must never expose its original, possibly personal,
    // question/options — mirrors the legacy TEXT sanitization above.
    it('sanitizes a pre-template legacy POLL, never exposing its original question/options', async () => {
      prisma.offerGroupMessage.findMany.mockResolvedValue([
        {
          id: 'legacy-poll-1',
          type: 'POLL',
          member_id: 'member-cust-a',
          text: '📊 Call me at 9876543210 or vote below',
          payload: {
            question: 'Call me at 9876543210 or vote below',
            options: ['spec143@gmail.com', 'Saturday'],
          },
        },
      ]);
      const [result] = await service.getMessages(OFFER_ID, CUSTOMER_A);
      expect(result.text).toBe('This poll is no longer available.');
      expect(result.payload).toBeNull();
      expect(JSON.stringify(result)).not.toContain('9876543210');
      expect(JSON.stringify(result)).not.toContain('spec143@gmail.com');
    });

    it('leaves a template-based POLL (has payload.templateId) fully untouched', async () => {
      prisma.offerGroupMessage.findMany.mockResolvedValue([
        {
          id: 'poll-1',
          type: 'POLL',
          member_id: 'member-cust-a',
          text: '📊 When should we go?',
          payload: {
            templateId: 'DATE',
            question: 'When should we go?',
            options: ['Saturday', 'Sunday'],
            optionIds: ['SATURDAY', 'SUNDAY'],
          },
        },
      ]);
      const [result] = await service.getMessages(OFFER_ID, CUSTOMER_A);
      expect(result.text).toBe('📊 When should we go?');
      expect(result.payload).toEqual({
        templateId: 'DATE',
        question: 'When should we go?',
        options: ['Saturday', 'Sunday'],
        optionIds: ['SATURDAY', 'SUNDAY'],
      });
    });
  });
});
