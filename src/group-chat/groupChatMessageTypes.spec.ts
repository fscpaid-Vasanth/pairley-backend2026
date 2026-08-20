import { renderGroupMessage, QUICK_REPLIES } from './groupChatMessageTypes';
import { BadRequestException } from '@nestjs/common';

describe('renderGroupMessage', () => {
  describe('DATE_TIME', () => {
    it('renders a valid date/time payload', () => {
      const result = renderGroupMessage('DATE_TIME', {
        date: '2026-07-29',
        time: '17:30',
      });
      expect(result.type).toBe('DATE_TIME');
      expect(result.text).toBe('📅 Proposed: 29 Jul 2026 at 5:30 PM');
      expect(result.payload).toEqual({ date: '2026-07-29', time: '17:30' });
    });

    it('rejects a missing date or time', () => {
      expect(() =>
        renderGroupMessage('DATE_TIME', { date: '2026-07-29' }),
      ).toThrow(BadRequestException);
      expect(() => renderGroupMessage('DATE_TIME', {})).toThrow(
        BadRequestException,
      );
    });

    it('rejects a malformed date/time format', () => {
      expect(() =>
        renderGroupMessage('DATE_TIME', { date: '29-07-2026', time: '17:30' }),
      ).toThrow('Date must be YYYY-MM-DD and time must be 24h HH:MM.');
      expect(() =>
        renderGroupMessage('DATE_TIME', {
          date: '2026-07-29',
          time: '5:30 PM',
        }),
      ).toThrow(BadRequestException);
    });

    // JS silently rolls Feb 30 -> Mar 2 rather than throwing — this is the
    // exact bug isValidCalendarDate() exists to catch, mirroring
    // leadMessageTemplates.ts's identical protection.
    it('rejects a calendar-invalid date (Feb 30) despite matching the regex', () => {
      expect(() =>
        renderGroupMessage('DATE_TIME', { date: '2026-02-30', time: '10:00' }),
      ).toThrow('That is not a valid calendar date.');
    });
  });

  describe('LOCATION', () => {
    it('renders a valid location payload', () => {
      const result = renderGroupMessage('LOCATION', {
        lat: 12.9716,
        lng: 77.5946,
        label: 'Forum Mall, Koramangala',
        source: 'CURRENT',
      });
      expect(result.type).toBe('LOCATION');
      expect(result.text).toBe('📍 Forum Mall, Koramangala');
      expect(result.payload).toEqual({
        lat: 12.9716,
        lng: 77.5946,
        label: 'Forum Mall, Koramangala',
        source: 'CURRENT',
      });
    });

    it('rejects an out-of-range lat/lng', () => {
      expect(() =>
        renderGroupMessage('LOCATION', {
          lat: 200,
          lng: 77.5946,
          label: 'Nowhere',
          source: 'CURRENT',
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects a missing label', () => {
      expect(() =>
        renderGroupMessage('LOCATION', {
          lat: 12.9716,
          lng: 77.5946,
          source: 'CURRENT',
        }),
      ).toThrow('A location label is required.');
    });

    it("rejects a source other than 'CURRENT' or 'MAP_PICK'", () => {
      expect(() =>
        renderGroupMessage('LOCATION', {
          lat: 12.9716,
          lng: 77.5946,
          label: 'Somewhere',
          source: 'GUESS',
        }),
      ).toThrow(BadRequestException);
    });

    it('strips control characters from a client-supplied label and caps its length', () => {
      const result = renderGroupMessage('LOCATION', {
        lat: 12.9716,
        lng: 77.5946,
        label: 'Forum\nMall\x00Evil',
        source: 'MAP_PICK',
      });
      expect(result.payload!.label).toBe('ForumMallEvil');
    });

    it('accepts MAP_PICK as a valid source', () => {
      const result = renderGroupMessage('LOCATION', {
        lat: 12.9716,
        lng: 77.5946,
        label: 'Pinned Spot',
        source: 'MAP_PICK',
      });
      expect((result.payload as any).source).toBe('MAP_PICK');
    });
  });

  describe('POLL — template-based, no free text', () => {
    // 1. Valid DATE poll succeeds.
    it('renders a valid DATE poll using the template question and selected option text', () => {
      const result = renderGroupMessage('POLL', {
        templateId: 'DATE',
        optionIds: ['SATURDAY', 'SUNDAY'],
      });
      expect(result.type).toBe('POLL');
      expect(result.text).toBe('📊 When should we go?');
      expect(result.payload).toEqual({
        templateId: 'DATE',
        question: 'When should we go?',
        options: ['Saturday', 'Sunday'],
        optionIds: ['SATURDAY', 'SUNDAY'],
      });
    });

    // 2. Valid TIME poll succeeds.
    it('renders a valid TIME poll', () => {
      const result = renderGroupMessage('POLL', {
        templateId: 'TIME',
        optionIds: ['MORNING', 'EVENING'],
      });
      expect(result.text).toBe('📊 What time works best?');
      expect((result.payload as any).options).toEqual(['Morning', 'Evening']);
    });

    // 3. Valid GROUP SIZE poll succeeds.
    it('renders a valid GROUP_SIZE poll', () => {
      const result = renderGroupMessage('POLL', {
        templateId: 'GROUP_SIZE',
        optionIds: ['TWO', 'THREE', 'FOUR'],
      });
      expect(result.text).toBe('📊 How many people are joining?');
      expect((result.payload as any).options).toEqual([
        '2 people',
        '3 people',
        '4 people',
      ]);
    });

    // 4. Valid REDEMPTION poll succeeds.
    it('renders a valid REDEMPTION poll', () => {
      const result = renderGroupMessage('POLL', {
        templateId: 'REDEMPTION',
        optionIds: ['THIS_WEEK', 'THIS_WEEKEND'],
      });
      expect(result.text).toBe('📊 When are you planning to redeem?');
      expect((result.payload as any).options).toEqual([
        'This week',
        'This weekend',
      ]);
    });

    // 5. Valid LOCATION poll succeeds — options come from the same
    // structured mechanism as standalone LOCATION messages, never typed.
    it('renders a valid LOCATION poll from structured location entries', () => {
      const result = renderGroupMessage('POLL', {
        templateId: 'LOCATION',
        options: [
          { lat: 12.97, lng: 77.59, label: 'Forum Mall', source: 'CURRENT' },
          {
            lat: 12.93,
            lng: 77.61,
            label: 'Koramangala 5th Block',
            source: 'MAP_PICK',
          },
        ],
      });
      expect(result.text).toBe('📊 Which location works?');
      expect((result.payload as any).options).toEqual([
        'Forum Mall',
        'Koramangala 5th Block',
      ]);
      expect((result.payload as any).locations).toHaveLength(2);
      expect((result.payload as any).locations[0]).toEqual({
        lat: 12.97,
        lng: 77.59,
        label: 'Forum Mall',
        source: 'CURRENT',
      });
    });

    // 6. Invalid templateId returns 400.
    it('rejects an unknown templateId', () => {
      expect(() =>
        renderGroupMessage('POLL', {
          templateId: 'NOT_A_REAL_TEMPLATE',
          optionIds: ['A', 'B'],
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects a missing templateId', () => {
      expect(() =>
        renderGroupMessage('POLL', { optionIds: ['A', 'B'] }),
      ).toThrow('A poll template is required.');
    });

    // 7. Invalid optionId returns 400.
    it('rejects an optionId that does not belong to the selected template', () => {
      expect(() =>
        renderGroupMessage('POLL', {
          templateId: 'DATE',
          optionIds: ['SATURDAY', 'NOT_A_REAL_OPTION'],
        }),
      ).toThrow('Unknown poll option.');
    });

    it('rejects fewer than 2 selected options', () => {
      expect(() =>
        renderGroupMessage('POLL', {
          templateId: 'DATE',
          optionIds: ['SATURDAY'],
        }),
      ).toThrow('A poll needs between 2 and 6 options.');
    });

    it('rejects more than 6 selected options', () => {
      expect(() =>
        renderGroupMessage('POLL', {
          templateId: 'DATE',
          optionIds: [
            'TODAY',
            'TOMORROW',
            'SATURDAY',
            'SUNDAY',
            'TODAY',
            'TOMORROW',
            'SATURDAY',
          ],
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects duplicate optionIds', () => {
      expect(() =>
        renderGroupMessage('POLL', {
          templateId: 'DATE',
          optionIds: ['SATURDAY', 'SATURDAY'],
        }),
      ).toThrow('Duplicate poll options are not allowed.');
    });

    // 8. Arbitrary question is rejected — there is no `question` field a
    // client can submit for POLL any more; only templateId/optionIds are
    // ever read. Confirms a client-supplied question is silently ignored,
    // not merely unused.
    it('ignores a client-supplied question entirely — the template question always wins', () => {
      const result = renderGroupMessage('POLL', {
        templateId: 'DATE',
        optionIds: ['SATURDAY', 'SUNDAY'],
        question: 'Call me to discuss, 9876543210',
      });
      expect(result.text).toBe('📊 When should we go?');
      expect(result.text).not.toContain('9876543210');
    });

    // 9. Arbitrary option text is rejected.
    it('rejects an attempt to submit free-text options instead of optionIds', () => {
      expect(() =>
        renderGroupMessage('POLL', {
          templateId: 'DATE',
          optionIds: ['Saturday', 'Sunday'], // option TEXT, not real option IDs
        }),
      ).toThrow('Unknown poll option.');
    });

    // 10 / 11 / 12. Phone/email/WhatsApp payloads rejected — via the
    // LOCATION poll path, the one place any external text (a label) can
    // reach a poll at all.
    it('rejects a phone number smuggled into a LOCATION poll label', () => {
      expect(() =>
        renderGroupMessage('POLL', {
          templateId: 'LOCATION',
          options: [
            {
              lat: 12.97,
              lng: 77.59,
              label: 'Call me 9876543210',
              source: 'CURRENT',
            },
            {
              lat: 12.93,
              lng: 77.61,
              label: 'Koramangala',
              source: 'MAP_PICK',
            },
          ],
        }),
      ).toThrow('That location label is not allowed.');
    });

    it('rejects an email address smuggled into a LOCATION poll label', () => {
      expect(() =>
        renderGroupMessage('POLL', {
          templateId: 'LOCATION',
          options: [
            {
              lat: 12.97,
              lng: 77.59,
              label: 'spec143@gmail.com',
              source: 'CURRENT',
            },
            {
              lat: 12.93,
              lng: 77.61,
              label: 'Koramangala',
              source: 'MAP_PICK',
            },
          ],
        }),
      ).toThrow('That location label is not allowed.');
    });

    it('rejects a WhatsApp link smuggled into a LOCATION poll label', () => {
      expect(() =>
        renderGroupMessage('POLL', {
          templateId: 'LOCATION',
          options: [
            {
              lat: 12.97,
              lng: 77.59,
              label: 'wa.me/919876543210',
              source: 'CURRENT',
            },
            {
              lat: 12.93,
              lng: 77.61,
              label: 'Koramangala',
              source: 'MAP_PICK',
            },
          ],
        }),
      ).toThrow('That location label is not allowed.');
    });

    it('still allows legitimate Pairley coordination text through the PII filter', () => {
      const legit = [
        'Saturday',
        'Sunday',
        '6:00 PM',
        'Morning',
        'Koramangala',
        'Indiranagar',
        'Whitefield',
        '2 people',
        'This weekend',
        'Forum Mall, Koramangala',
      ];
      for (const label of legit) {
        expect(() =>
          renderGroupMessage('LOCATION', {
            lat: 12.97,
            lng: 77.59,
            label,
            source: 'CURRENT',
          }),
        ).not.toThrow();
      }
    });
  });

  describe('LOCATION — defense-in-depth PII guard on label', () => {
    it('rejects a phone number in a standalone LOCATION message label', () => {
      expect(() =>
        renderGroupMessage('LOCATION', {
          lat: 12.97,
          lng: 77.59,
          label: 'call me at 9876543210',
          source: 'CURRENT',
        }),
      ).toThrow('That location label is not allowed.');
    });

    it('rejects an Instagram handle in a standalone LOCATION message label', () => {
      expect(() =>
        renderGroupMessage('LOCATION', {
          lat: 12.97,
          lng: 77.59,
          label: '@my_insta_handle',
          source: 'CURRENT',
        }),
      ).toThrow('That location label is not allowed.');
    });
  });

  it('rejects an unsupported/unknown type', () => {
    expect(() => renderGroupMessage('IMAGE', {})).toThrow(BadRequestException);
    expect(() => renderGroupMessage('TEXT', {})).toThrow(BadRequestException); // TEXT never goes through this catalog
  });

  describe('QUICK_REPLY', () => {
    it('renders a valid replyId using the server-side catalog text', () => {
      const result = renderGroupMessage('QUICK_REPLY', {
        replyId: 'SATURDAY_WORKS',
      });
      expect(result.type).toBe('QUICK_REPLY');
      expect(result.text).toBe('Saturday works for me.');
      expect(result.payload).toEqual({
        replyId: 'SATURDAY_WORKS',
        text: 'Saturday works for me.',
      });
    });

    it('rejects an unknown replyId', () => {
      expect(() =>
        renderGroupMessage('QUICK_REPLY', { replyId: 'NOT_A_REAL_ID' }),
      ).toThrow(BadRequestException);
    });

    it('rejects a missing replyId', () => {
      expect(() => renderGroupMessage('QUICK_REPLY', {})).toThrow(
        'Unknown quick reply.',
      );
    });

    // The actual anti-bypass mechanism: a client-supplied `text` field is
    // never trusted or echoed — only the catalog's own text for the given
    // replyId can ever be stored, regardless of what the request body says.
    it('ignores client-supplied text and always uses the catalog value', () => {
      const result = renderGroupMessage('QUICK_REPLY', {
        replyId: 'SATURDAY_WORKS',
        text: 'Call me at 9876543210',
      });
      expect(result.text).toBe('Saturday works for me.');
      expect(result.text).not.toContain('9876543210');
    });

    it('every catalog entry renders correctly by its own id', () => {
      for (const option of QUICK_REPLIES) {
        const result = renderGroupMessage('QUICK_REPLY', {
          replyId: option.id,
        });
        expect(result.text).toBe(option.text);
      }
    });
  });
});
