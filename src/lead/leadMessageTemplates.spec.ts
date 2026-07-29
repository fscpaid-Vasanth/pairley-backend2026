import { BadRequestException } from '@nestjs/common';
import {
  LEAD_MESSAGE_TEMPLATES,
  getPublicTemplateCatalog,
  renderLeadMessage,
  getAnalyticsEvents,
} from './leadMessageTemplates';

// Module 13 Phase 2b — Deal Coordination Assistant, guided-workflow
// revision. This is the actual enforcement point that replaces free-text
// lead chat: renderLeadMessage() is the only path from client input to a
// LeadMessage row, so it must reject anything that isn't a whitelisted
// templateKey with a valid payload — not just the UI declining to show a
// text box.
describe('leadMessageTemplates', () => {
  describe('renderLeadMessage — fixed (no-payload) templates', () => {
    it('renders every Quick-Action/fixed-Location/Offer-Status key to its exact catalog text', () => {
      const fixedKeys = Object.entries(LEAD_MESSAGE_TEMPLATES)
        .filter(([, def]) => !def.requiresPayload)
        .map(([key]) => key);

      expect(fixedKeys.length).toBeGreaterThan(0);
      for (const key of fixedKeys) {
        const result = renderLeadMessage(key);
        expect(result.payload).toBeNull();
        expect(result.text.length).toBeGreaterThan(0);
      }
    });

    it('MEETING_WHEN renders the exact spec copy', () => {
      expect(renderLeadMessage('MEETING_WHEN')).toEqual({
        message_type: 'STATEMENT',
        text: '📅 When shall we meet?',
        payload: null,
      });
    });

    it('LOCATION_SHOP_COUNTER renders the exact spec copy', () => {
      expect(renderLeadMessage('LOCATION_SHOP_COUNTER')).toEqual({
        message_type: 'LOCATION',
        text: '📍 Meeting Location: Shop Counter',
        payload: null,
      });
    });

    it('every Offer Status template (new in this revision) renders its exact spec copy', () => {
      expect(renderLeadMessage('OFFER_COLLECTED').text).toBe('✅ I have collected the offer.');
      expect(renderLeadMessage('OFFER_REDEEMED').text).toBe('✅ Offer redeemed successfully.');
      expect(renderLeadMessage('VISIT_CANCELLED').text).toBe('❌ Unable to visit today.');
      expect(renderLeadMessage('RESCHEDULE_REQUEST').text).toBe('🔄 Can we reschedule?');
    });

    it('ignores any payload passed for a fixed template — it cannot be used to smuggle text', () => {
      const result = renderLeadMessage('CONFIRM_THANKS', { text: 'this is not the real message' });
      expect(result.text).toBe('👍 Thank you.');
    });
  });

  describe('renderLeadMessage — SCHEDULE template', () => {
    it('renders the exact "Schedule Meeting" phrasing from a {date, time} payload', () => {
      expect(
        renderLeadMessage('SCHEDULE_AVAILABLE_ON', { date: '2026-07-29', time: '17:30' }).text,
      ).toBe('📅 I will be available on 29 Jul 2026 at 5:30 PM');
    });

    it('formats midnight and noon correctly (12-hour boundary)', () => {
      expect(
        renderLeadMessage('SCHEDULE_AVAILABLE_ON', { date: '2026-01-01', time: '00:00' }).text,
      ).toContain('12:00 AM');
      expect(
        renderLeadMessage('SCHEDULE_AVAILABLE_ON', { date: '2026-01-01', time: '12:00' }).text,
      ).toContain('12:00 PM');
    });

    it('echoes the payload back for storage', () => {
      const payload = { date: '2026-07-29', time: '17:30' };
      expect(renderLeadMessage('SCHEDULE_AVAILABLE_ON', payload).payload).toEqual(payload);
    });

    it.each([
      ['missing payload entirely', undefined],
      ['missing time', { date: '2026-07-29' }],
      ['missing date', { time: '17:30' }],
      ['malformed date', { date: '29-07-2026', time: '17:30' }],
      ['malformed time (12h with AM/PM)', { date: '2026-07-29', time: '5:30 PM' }],
      ['out-of-range time', { date: '2026-07-29', time: '25:99' }],
      ['non-calendar date', { date: '2026-02-30', time: '17:30' }],
    ])('rejects %s', (_label, payload) => {
      expect(() => renderLeadMessage('SCHEDULE_AVAILABLE_ON', payload)).toThrow(BadRequestException);
    });
  });

  describe('renderLeadMessage — LOCATION_LIVE', () => {
    it('renders the fixed text and stores lat/lng in payload', () => {
      const result = renderLeadMessage('LOCATION_LIVE', { lat: 12.9716, lng: 77.5946 });
      expect(result.text).toBe('📍 Live Location Shared');
      expect(result.payload).toEqual({ lat: 12.9716, lng: 77.5946 });
    });

    it.each([
      ['missing payload', undefined],
      ['non-numeric lat', { lat: 'north', lng: 77.5946 }],
      ['lat out of range', { lat: 200, lng: 77.5946 }],
      ['lng out of range', { lat: 12.9716, lng: -200 }],
    ])('rejects %s', (_label, payload) => {
      expect(() => renderLeadMessage('LOCATION_LIVE', payload)).toThrow(BadRequestException);
    });
  });

  describe('renderLeadMessage — whitelist enforcement', () => {
    it('rejects a key that is not in the catalog at all — this is what blocks free text', () => {
      expect(() => renderLeadMessage('Hey, are you around today?')).toThrow(BadRequestException);
      expect(() => renderLeadMessage('')).toThrow(BadRequestException);
      expect(() => renderLeadMessage('meeting_when')).toThrow(BadRequestException); // case-sensitive, not a fuzzy match
    });
  });

  describe('getPublicTemplateCatalog', () => {
    it('groups every catalog entry under the four guided-workflow sections, in the requested order', () => {
      const catalog = getPublicTemplateCatalog();
      expect(catalog.map((c) => c.category)).toEqual([
        'QUICK_ACTIONS',
        'SCHEDULE',
        'LOCATION',
        'OFFER_STATUS',
      ]);
      const totalItems = catalog.reduce((sum, c) => sum + c.items.length, 0);
      expect(totalItems).toBe(Object.keys(LEAD_MESSAGE_TEMPLATES).length);
    });

    it('Quick Actions has no payload-requiring items — every item is immediately sendable, no tab switch needed', () => {
      const catalog = getPublicTemplateCatalog();
      const quickActions = catalog.find((c) => c.category === 'QUICK_ACTIONS');
      expect(quickActions.items.length).toBeGreaterThan(0);
      expect(quickActions.items.every((i) => i.requiresPayload === false)).toBe(true);
    });

    it('Offer Status (new section) has exactly the four deal-progress templates', () => {
      const catalog = getPublicTemplateCatalog();
      const offerStatus = catalog.find((c) => c.category === 'OFFER_STATUS');
      expect(offerStatus.items.map((i) => i.key).sort()).toEqual(
        ['OFFER_COLLECTED', 'OFFER_REDEEMED', 'RESCHEDULE_REQUEST', 'VISIT_CANCELLED'].sort(),
      );
    });

    it('never leaks the render/validatePayload/analyticsEvents internals to the client shape', () => {
      const catalog = getPublicTemplateCatalog();
      for (const { items } of catalog) {
        for (const item of items) {
          expect(item).not.toHaveProperty('render');
          expect(item).not.toHaveProperty('validatePayload');
          expect(item).not.toHaveProperty('analyticsEvents'); // backend/analytics concern only
          expect(item).not.toHaveProperty('text'); // fixed text is server-rendered on send, not needed up front
          expect(item).toHaveProperty('key');
          expect(item).toHaveProperty('label');
          expect(item).toHaveProperty('messageType');
          expect(item).toHaveProperty('requiresPayload');
        }
      }
    });

    it('flags exactly the SCHEDULE and LOCATION_LIVE templates as requiring a payload', () => {
      const catalog = getPublicTemplateCatalog();
      const flat = catalog.flatMap((c) => c.items);
      const needsPayload = flat.filter((i) => i.requiresPayload).map((i) => i.key).sort();
      expect(needsPayload).toEqual(['LOCATION_LIVE', 'SCHEDULE_AVAILABLE_ON'].sort());
    });
  });

  describe('getAnalyticsEvents', () => {
    it('every catalog entry maps to at least one analytics event — "log every structured interaction"', () => {
      for (const key of Object.keys(LEAD_MESSAGE_TEMPLATES)) {
        expect(getAnalyticsEvents(key).length).toBeGreaterThan(0);
      }
    });

    it('a schedule send maps to both DATE_SHARED and TIME_SHARED', () => {
      expect(getAnalyticsEvents('SCHEDULE_AVAILABLE_ON')).toEqual(['DATE_SHARED', 'TIME_SHARED']);
    });

    it('every location template maps to LOCATION_SHARED, fixed or live', () => {
      for (const key of ['LOCATION_SHOP_COUNTER', 'LOCATION_SHOP_ENTRANCE', 'LOCATION_PARKING_AREA', 'LOCATION_LIVE']) {
        expect(getAnalyticsEvents(key)).toEqual(['LOCATION_SHARED']);
      }
    });

    it('matches the requested example event names for the requested example templates', () => {
      expect(getAnalyticsEvents('MEETING_WHEN')).toEqual(['MEETING_REQUESTED']);
      expect(getAnalyticsEvents('MEETING_ARRIVED')).toEqual(['MEETING_CONFIRMED']);
      expect(getAnalyticsEvents('OFFER_COLLECTED')).toEqual(['OFFER_COLLECTED']);
      expect(getAnalyticsEvents('RESCHEDULE_REQUEST')).toEqual(['RESCHEDULED']);
    });

    it('returns an empty array (not a throw) for an unknown key — logging is best-effort', () => {
      expect(getAnalyticsEvents('NOT_A_REAL_KEY')).toEqual([]);
    });
  });
});
