import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SupportService } from './support.service';

// Security fix: GET /support/ticket/:id previously had no authorization
// check at all — any caller with any ticket ID, guest session or a real
// registered user's ticket, could read the full contents. Guest sessions
// (createChatSession/createPublicTicket — see their `user_id: 'guest'`
// sentinel) are deliberately left open to any caller holding the ticket's
// own UUID: that is the same secret-link trust model the claim-token flow
// already uses, and SupportPage.jsx's anonymous chat polling depends on it.
// A real user's ticket does not get that same free pass.
describe('SupportService.getTicketById', () => {
  const makePrisma = () => ({
    supportTicket: { findUnique: jest.fn() },
  });

  let prisma: ReturnType<typeof makePrisma>;
  let service: SupportService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new SupportService(prisma as any);
  });

  it('throws NotFoundException for a ticket that does not exist', async () => {
    prisma.supportTicket.findUnique.mockResolvedValue(null);
    await expect(service.getTicketById('missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  describe('guest tickets — accessible via the ticket ID alone', () => {
    const guestTicket = {
      id: 'ticket-1',
      user_id: 'guest',
      subject: '[CHAT] A Guest - CHAT-ABCD',
      description: '[Sender] A Guest (guest@example.com)\n...',
      status: 'OPEN',
    };

    it('returns the ticket with no caller identity at all (the anonymous chat-polling case)', async () => {
      prisma.supportTicket.findUnique.mockResolvedValue(guestTicket);
      const result = await service.getTicketById('ticket-1');
      expect(result).toBe(guestTicket);
    });

    it('returns the ticket even when called by an unrelated logged-in customer', async () => {
      prisma.supportTicket.findUnique.mockResolvedValue(guestTicket);
      const result = await service.getTicketById(
        'ticket-1',
        'some-other-customer-id',
        'Customer',
      );
      expect(result).toBe(guestTicket);
    });
  });

  describe('a real registered user\'s ticket — the actual security gap', () => {
    const realTicket = {
      id: 'ticket-2',
      user_id: 'customer-42',
      subject: 'Refund question',
      description: 'Where is my refund',
      status: 'OPEN',
    };

    it('denies an anonymous caller — this is the exact bug being fixed', async () => {
      prisma.supportTicket.findUnique.mockResolvedValue(realTicket);
      await expect(service.getTicketById('ticket-2')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('denies a different logged-in customer', async () => {
      prisma.supportTicket.findUnique.mockResolvedValue(realTicket);
      await expect(
        service.getTicketById('ticket-2', 'customer-99', 'Customer'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows the ticket\'s own owner', async () => {
      prisma.supportTicket.findUnique.mockResolvedValue(realTicket);
      const result = await service.getTicketById(
        'ticket-2',
        'customer-42',
        'Customer',
      );
      expect(result).toBe(realTicket);
    });

    it('allows an Admin regardless of ownership', async () => {
      prisma.supportTicket.findUnique.mockResolvedValue(realTicket);
      const result = await service.getTicketById(
        'ticket-2',
        'admin-1',
        'Admin',
      );
      expect(result).toBe(realTicket);
    });
  });
});
