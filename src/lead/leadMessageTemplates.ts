import { BadRequestException } from '@nestjs/common';

// Module 13 Phase 2 — Deal Coordination Assistant. Replaces free-text lead
// chat with a whitelisted catalog of structured messages: the customer and
// merchant pick from predefined coordination prompts (or a date/time /
// location picker), never type arbitrary text. Enforced here, not just in
// the UI — POST /leads/:id/messages only ever accepts a `templateKey` from
// this catalog, so a direct API call can't smuggle in free text either.
//
// Presented to the user as four guided-workflow sections, in this fixed
// order: Quick Actions (always visible, no tab switching), Schedule Meeting
// (a standing date+time widget, not a click-to-reveal prompt), Share
// Location, Offer Status. The frontend renders these generically from
// GET /leads/message-templates — Quick Actions/Location/Offer Status are
// plain chip lists, Schedule is the one section with dedicated UI (a
// date+time picker) because it's the one interaction that needs structured
// input beyond a fixed string.
//
// Extensibility: adding a new template — e.g. PAYMENT_CONFIRMATION — is one
// new entry in LEAD_MESSAGE_TEMPLATES below, with its own analyticsEvents.
// No schema change for a fixed-text template, no controller change, and the
// frontend picks it up automatically. Only a template needing a genuinely
// new *kind* of structured input (beyond date+time or lat/lng) would need a
// new frontend interaction pattern.

export type LeadMessageCategory = 'QUICK_ACTIONS' | 'SCHEDULE' | 'LOCATION' | 'OFFER_STATUS';
export type LeadMessageType = 'STATEMENT' | 'SCHEDULE' | 'LOCATION';

interface FixedTemplate {
  category: LeadMessageCategory;
  label: string;
  messageType: LeadMessageType;
  requiresPayload: false;
  text: string;
  // Analytics events logged (fire-and-forget) each time this template is
  // sent — see LeadInteractionEvent / LeadService.sendMessage. A template
  // can map to more than one event (e.g. one schedule send is both a "date
  // shared" and a "time shared" event).
  analyticsEvents: string[];
}

interface DynamicTemplate {
  category: LeadMessageCategory;
  label: string;
  messageType: LeadMessageType;
  requiresPayload: true;
  // Returns an error string when the payload is invalid, null when it's fine.
  validatePayload: (payload: unknown) => string | null;
  render: (payload: any) => string;
  analyticsEvents: string[];
}

type LeadMessageTemplateDef = FixedTemplate | DynamicTemplate;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 'YYYY-MM-DD' -> '29 Jul 2026'
function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// 24h 'HH:MM' -> '5:30 PM'
function formatTime(timeStr: string): string {
  const [hStr, mStr] = timeStr.split(':');
  let h = Number(hStr);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${mStr} ${ampm}`;
}

// JS silently rolls over an out-of-range calendar date (new Date(2026, 1, 30)
// becomes March 2, not NaN) — a plain getTime()/isNaN check would accept
// "29 Feb 2026" or "31 Apr 2026" and silently render the wrong date in a
// coordination message. Round-tripping through UTC and comparing the parts
// back catches this.
function isValidCalendarDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function validateSchedulePayload(payload: unknown): string | null {
  const p = payload as { date?: unknown; time?: unknown } | null | undefined;
  if (!p || typeof p.date !== 'string' || typeof p.time !== 'string') {
    return 'A date and time are required.';
  }
  if (!DATE_RE.test(p.date) || !TIME_RE.test(p.time)) {
    return 'Date must be YYYY-MM-DD and time must be 24h HH:MM.';
  }
  const [y, m, d] = p.date.split('-').map(Number);
  if (!isValidCalendarDate(y, m, d)) {
    return 'That is not a valid calendar date.';
  }
  return null;
}

function validateLiveLocationPayload(payload: unknown): string | null {
  const p = payload as { lat?: unknown; lng?: unknown } | null | undefined;
  if (
    !p ||
    typeof p.lat !== 'number' ||
    typeof p.lng !== 'number' ||
    Math.abs(p.lat) > 90 ||
    Math.abs(p.lng) > 180
  ) {
    return 'A valid lat/lng is required to share live location.';
  }
  return null;
}

export const LEAD_MESSAGE_TEMPLATES: Record<string, LeadMessageTemplateDef> = {
  // Section 1 — Quick Actions. Always visible, no tab switching.
  MEETING_WHEN: {
    category: 'QUICK_ACTIONS', messageType: 'STATEMENT', requiresPayload: false,
    label: '📅 When shall we meet?', text: '📅 When shall we meet?',
    analyticsEvents: ['MEETING_REQUESTED'],
  },
  MEETING_COUNTER: {
    category: 'QUICK_ACTIONS', messageType: 'STATEMENT', requiresPayload: false,
    label: '🏪 Shall we meet at the shop counter?', text: '🏪 Shall we meet at the shop counter?',
    analyticsEvents: ['MEETING_REQUESTED'],
  },
  MEETING_ARRIVED: {
    category: 'QUICK_ACTIONS', messageType: 'STATEMENT', requiresPayload: false,
    label: '🚗 I have reached the shop.', text: '🚗 I have reached the shop.',
    analyticsEvents: ['MEETING_CONFIRMED'],
  },
  MEETING_LATE: {
    category: 'QUICK_ACTIONS', messageType: 'STATEMENT', requiresPayload: false,
    label: '⏳ I am running late.', text: '⏳ I am running late.',
    analyticsEvents: ['RUNNING_LATE'],
  },
  CONFIRM_THANKS: {
    category: 'QUICK_ACTIONS', messageType: 'STATEMENT', requiresPayload: false,
    label: '👍 Thank you.', text: '👍 Thank you.',
    analyticsEvents: ['ACKNOWLEDGED'],
  },
  CONFIRM_LOOKING_FORWARD: {
    category: 'QUICK_ACTIONS', messageType: 'STATEMENT', requiresPayload: false,
    label: '😊 Looking forward to meeting.', text: '😊 Looking forward to meeting.',
    analyticsEvents: ['ACKNOWLEDGED'],
  },

  // Section 2 — Schedule Meeting. One canonical phrasing; the frontend
  // renders this as a standing date+time widget, not a clickable prompt.
  SCHEDULE_AVAILABLE_ON: {
    category: 'SCHEDULE', messageType: 'SCHEDULE', requiresPayload: true,
    label: '📅 I will be available on...',
    validatePayload: validateSchedulePayload,
    render: (p) => `📅 I will be available on ${formatDate(p.date)} at ${formatTime(p.time)}`,
    analyticsEvents: ['DATE_SHARED', 'TIME_SHARED'],
  },

  // Section 3 — Share Location.
  LOCATION_SHOP_COUNTER: {
    category: 'LOCATION', messageType: 'LOCATION', requiresPayload: false,
    label: '📍 Shop Counter', text: '📍 Meeting Location: Shop Counter',
    analyticsEvents: ['LOCATION_SHARED'],
  },
  LOCATION_SHOP_ENTRANCE: {
    category: 'LOCATION', messageType: 'LOCATION', requiresPayload: false,
    label: '📍 Shop Entrance', text: '📍 Meeting Location: Shop Entrance',
    analyticsEvents: ['LOCATION_SHARED'],
  },
  LOCATION_PARKING_AREA: {
    category: 'LOCATION', messageType: 'LOCATION', requiresPayload: false,
    label: '📍 Parking Area', text: '📍 Meeting Location: Parking Area',
    analyticsEvents: ['LOCATION_SHARED'],
  },
  LOCATION_LIVE: {
    category: 'LOCATION', messageType: 'LOCATION', requiresPayload: true,
    label: '📍 Share Live Location',
    validatePayload: validateLiveLocationPayload,
    render: () => '📍 Live Location Shared',
    analyticsEvents: ['LOCATION_SHARED'],
  },

  // Section 4 — Offer Status. New in this revision — deal-progress
  // signals, useful once a merchant is juggling many interested customers.
  OFFER_COLLECTED: {
    category: 'OFFER_STATUS', messageType: 'STATEMENT', requiresPayload: false,
    label: '✅ I have collected the offer.', text: '✅ I have collected the offer.',
    analyticsEvents: ['OFFER_COLLECTED'],
  },
  OFFER_REDEEMED: {
    category: 'OFFER_STATUS', messageType: 'STATEMENT', requiresPayload: false,
    label: '✅ Offer redeemed successfully.', text: '✅ Offer redeemed successfully.',
    analyticsEvents: ['OFFER_REDEEMED'],
  },
  VISIT_CANCELLED: {
    category: 'OFFER_STATUS', messageType: 'STATEMENT', requiresPayload: false,
    label: '❌ Unable to visit today.', text: '❌ Unable to visit today.',
    analyticsEvents: ['VISIT_CANCELLED'],
  },
  RESCHEDULE_REQUEST: {
    category: 'OFFER_STATUS', messageType: 'STATEMENT', requiresPayload: false,
    label: '🔄 Can we reschedule?', text: '🔄 Can we reschedule?',
    analyticsEvents: ['RESCHEDULED'],
  },
};

const CATEGORY_ORDER: LeadMessageCategory[] = ['QUICK_ACTIONS', 'SCHEDULE', 'LOCATION', 'OFFER_STATUS'];

/**
 * The catalog shape sent to the frontend — no functions (validate/render
 * aren't serializable and shouldn't run client-side anyway; the backend is
 * the enforcement point) and no analyticsEvents (a backend/analytics
 * concern the client has no reason to know about). Grouped by category in
 * the fixed section order above.
 */
export function getPublicTemplateCatalog() {
  const byCategory = new Map<LeadMessageCategory, any[]>();
  for (const [key, def] of Object.entries(LEAD_MESSAGE_TEMPLATES)) {
    const item = { key, label: def.label, messageType: def.messageType, requiresPayload: def.requiresPayload };
    if (!byCategory.has(def.category)) byCategory.set(def.category, []);
    byCategory.get(def.category)!.push(item);
  }
  return CATEGORY_ORDER.map((category) => ({ category, items: byCategory.get(category) || [] }));
}

/**
 * Resolves a templateKey (+ payload, when the template requires one) into
 * the fields to persist on LeadMessage. Throws BadRequestException for an
 * unknown key or an invalid/missing payload — this is the whole enforcement
 * point that replaces free text: nothing reaches the database that isn't
 * either a fixed catalog string or a validated date/time or lat/lng.
 */
export function renderLeadMessage(
  templateKey: string,
  payload?: unknown,
): { message_type: LeadMessageType; text: string; payload: unknown | null } {
  const template = LEAD_MESSAGE_TEMPLATES[templateKey];
  if (!template) {
    throw new BadRequestException(`Unknown message template: ${templateKey}`);
  }
  if (!template.requiresPayload) {
    return { message_type: template.messageType, text: template.text, payload: null };
  }
  const error = template.validatePayload(payload);
  if (error) {
    throw new BadRequestException(error);
  }
  return { message_type: template.messageType, text: template.render(payload), payload: payload ?? null };
}

/**
 * Which analytics event_type rows to log for a message that was already
 * successfully rendered (i.e. templateKey is known-valid by this point —
 * called after renderLeadMessage, never before). Returns [] rather than
 * throwing for an unknown key, since logging is best-effort and should
 * never be the reason a send fails.
 */
export function getAnalyticsEvents(templateKey: string): string[] {
  return LEAD_MESSAGE_TEMPLATES[templateKey]?.analyticsEvents ?? [];
}
