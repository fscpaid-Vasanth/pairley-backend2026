import { BadRequestException } from '@nestjs/common';

// Anonymous Customer-to-Customer Offer Group Chat — structured message
// types (DATE_TIME, LOCATION, POLL, QUICK_REPLY). Free-form TEXT is
// permanently disabled (see GroupChatService.sendMessage()); TEXT remains
// only as a legacy type for pre-existing rows, sanitized before ever
// reaching the frontend (see GroupChatService.getMessages()). Deliberately
// NOT imported/shared with src/lead/leadMessageTemplates.ts — GroupChatService
// is already established as intentionally independent from LeadService (a
// different, unrelated 1:1 customer<->merchant chat), so the date/time
// validation logic below is a deliberate duplication of that file's
// approach, not a dependency on it.
//
// renderGroupMessage() is the single enforcement point: the backend is the
// only source of truth for a structured message's display text — a
// direct API call can never smuggle in client-formatted text for a
// DATE_TIME/LOCATION/POLL message the way free TEXT allows arbitrary
// (but length-capped) content.

export type GroupMessageType =
  | 'TEXT'
  | 'DATE_TIME'
  | 'LOCATION'
  | 'POLL'
  | 'QUICK_REPLY';

export interface RenderedGroupMessage {
  type: GroupMessageType;
  text: string;
  payload: Record<string, unknown> | null;
}

export interface QuickReplyOption {
  id: string;
  text: string;
}

// V1 product decision: free-form text messaging is permanently disabled
// (see GroupChatService.sendMessage()), but customers still need a way to
// actually coordinate beyond Date & Time / Location / Poll. This catalog is
// the ONLY source of truth for what a customer can say — the frontend
// renders these as tap-to-send buttons, never a text field, and a client
// can only ever submit a replyId, never freeform text. Adding a new phrase
// means adding a row here, not opening up arbitrary input.
export const QUICK_REPLIES: QuickReplyOption[] = [
  { id: 'ANYONE_SATURDAY', text: 'Anyone planning Saturday?' },
  { id: 'GROUP_SIZE', text: 'How many people do we need?' },
  { id: 'WEEKEND_INTEREST', text: 'Anyone interested this weekend?' },
  { id: 'REDEEM_TIME', text: 'When are you planning to redeem?' },
  { id: 'KORAMANGALA', text: 'Anyone joining from Koramangala?' },
  { id: 'INTERESTED', text: "I'm interested in this." },
  { id: 'TWO_PEOPLE', text: "I'm interested for 2 people." },
  { id: 'SATURDAY_WORKS', text: 'Saturday works for me.' },
  { id: 'SUNDAY_WORKS', text: 'Sunday works for me.' },
  { id: 'WAIT_MORE', text: "Let's wait for more members." },
];

const QUICK_REPLY_BY_ID = new Map(QUICK_REPLIES.map((q) => [q.id, q]));

// Secondary safety net, not the primary defense — the primary defense is
// architectural (POLL_TEMPLATES/QUICK_REPLIES never accept free text at
// all). This exists for the one remaining path that DOES carry text
// derived from an external source: a LOCATION label (normally
// reverse-geocoded by Google, but validateLocationPayload never checked
// its *content* before now — a direct API call could submit
// label: "call me 9876543210" and it would have gone straight through).
const PII_PATTERNS: RegExp[] = [
  // Indian mobile numbers, with or without +91
  /(?:\+?91[-\s]?)?[6-9]\d{9}\b/,
  // Email addresses
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  // URLs / bare domains
  /https?:\/\/\S+/i,
  /\b[a-z0-9-]+\.(com|in|net|org|io|me|co)\b/i,
  // WhatsApp / Telegram deep links
  /wa\.me\/|whatsapp\.com|t\.me\//i,
  // Social handles / profile links
  /@[a-zA-Z0-9_]{3,}/,
  /instagram\.com|facebook\.com|twitter\.com|x\.com/i,
  // Contact-solicitation phrases
  /\b(call me|whatsapp me|message me|contact me|dm me)\b/i,
];

// Any 7+ digit run (after stripping separators) reads as a phone number —
// catches spaced-out or hyphenated numbers the Indian-mobile regex above
// misses (e.g. an international number, or "99 62 04 51 43").
function hasLongDigitRun(text: string): boolean {
  return /\d[\d\s-]{6,}\d/.test(text) && text.replace(/\D/g, '').length >= 7;
}

function containsSuspiciousPII(text: string): boolean {
  return PII_PATTERNS.some((re) => re.test(text)) || hasLongDigitRun(text);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

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
// becomes March 2, not NaN) — round-tripping through UTC and comparing the
// parts back catches "29 Feb 2026" / "31 Apr 2026" instead of silently
// rendering the wrong date in a coordination message. Same technique as
// leadMessageTemplates.ts's isValidCalendarDate().
function isValidCalendarDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

// No timezone field — matches leadMessageTemplates.ts's exact existing
// precedent for date/time payloads. This app has no per-user timezone
// concept anywhere else; adding one here would be a new, unsupported
// convention rather than a gap this specific feature should solve alone.
function validateDateTimePayload(payload: unknown): string | null {
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

const MAX_LABEL_LENGTH = 200;
// Strips control characters (incl. newlines) from a client-supplied label
// before it's ever used verbatim in a message's display text — group chat
// members are anonymous peers, not a high-trust merchant/customer pair, so
// unlike LeadMessage's payload this can't be treated as inert metadata.
// Intentionally matching control characters to strip them, not a
// mistaken char-class.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/g;

function sanitizeLabel(label: string): string {
  return label.replace(CONTROL_CHARS_RE, '').trim().slice(0, MAX_LABEL_LENGTH);
}

function validateLocationPayload(payload: unknown): string | null {
  const p = payload as
    | { lat?: unknown; lng?: unknown; label?: unknown; source?: unknown }
    | null
    | undefined;
  if (
    !p ||
    typeof p.lat !== 'number' ||
    typeof p.lng !== 'number' ||
    Math.abs(p.lat) > 90 ||
    Math.abs(p.lng) > 180
  ) {
    return 'A valid lat/lng is required to share a location.';
  }
  if (typeof p.label !== 'string' || !p.label.trim()) {
    return 'A location label is required.';
  }
  if (p.source !== 'CURRENT' && p.source !== 'MAP_PICK') {
    return "source must be 'CURRENT' or 'MAP_PICK'.";
  }
  // Defense-in-depth: the UI only ever auto-fills this from reverse
  // geocoding, but a direct API call could submit anything as `label`.
  if (containsSuspiciousPII(p.label)) {
    return 'That location label is not allowed.';
  }
  return null;
}

export interface PollTemplateOption {
  id: string;
  text: string;
}

export interface PollTemplate {
  id: string;
  question: string;
  // null only for LOCATION — its options are dynamic, customer-picked
  // locations (validated via validateLocationPayload), not a fixed catalog
  // like every other template.
  options: PollTemplateOption[] | null;
}

// V1 product decision, same rationale as QUICK_REPLIES: customers can no
// longer type a poll question or option — every poll is built from this
// server-side catalog. A customer picks a template, then picks 2-6 of
// its predefined options (or, for LOCATION, shares 2-6 structured
// locations via the same Current Location/Pick on Map mechanism already
// used for standalone LOCATION messages). Adding a new poll shape means
// adding a template here, not opening up free text.
export const POLL_TEMPLATES: PollTemplate[] = [
  {
    id: 'DATE',
    question: 'When should we go?',
    options: [
      { id: 'TODAY', text: 'Today' },
      { id: 'TOMORROW', text: 'Tomorrow' },
      { id: 'SATURDAY', text: 'Saturday' },
      { id: 'SUNDAY', text: 'Sunday' },
    ],
  },
  {
    id: 'TIME',
    question: 'What time works best?',
    options: [
      { id: 'MORNING', text: 'Morning' },
      { id: 'AFTERNOON', text: 'Afternoon' },
      { id: 'EVENING', text: 'Evening' },
    ],
  },
  {
    id: 'GROUP_SIZE',
    question: 'How many people are joining?',
    options: [
      { id: 'TWO', text: '2 people' },
      { id: 'THREE', text: '3 people' },
      { id: 'FOUR', text: '4 people' },
      { id: 'FIVE_PLUS', text: '5+ people' },
    ],
  },
  {
    id: 'REDEMPTION',
    question: 'When are you planning to redeem?',
    options: [
      { id: 'THIS_WEEK', text: 'This week' },
      { id: 'THIS_WEEKEND', text: 'This weekend' },
      { id: 'NEXT_WEEK', text: 'Next week' },
      { id: 'LATER', text: 'Later' },
    ],
  },
  {
    id: 'LOCATION',
    question: 'Which location works?',
    options: null,
  },
];

const POLL_TEMPLATE_BY_ID = new Map(POLL_TEMPLATES.map((t) => [t.id, t]));

const MIN_POLL_OPTIONS = 2;
const MAX_POLL_OPTIONS = 6;

interface ResolvedPoll {
  templateId: string;
  question: string;
  options: string[];
  optionIds?: string[];
  locations?: Array<{
    lat: number;
    lng: number;
    label: string;
    source: string;
  }>;
}

// Validates AND resolves in one pass (unlike the other validate*Payload
// functions above) because the two are inseparable here: which options
// exist depends entirely on which template was selected. Throws directly
// rather than returning an error string, matching how deep this needs to
// branch. The resolved `options`/`question` are what the rest of the
// system (attachPollTallies, votePoll, PollCard) already expects — this
// is the only place that changed, not the voting/tally pipeline.
function resolvePollPayload(payload: unknown): ResolvedPoll {
  const p = payload as
    | { templateId?: unknown; optionIds?: unknown; options?: unknown }
    | null
    | undefined;
  if (!p || typeof p.templateId !== 'string') {
    throw new BadRequestException('A poll template is required.');
  }
  const template = POLL_TEMPLATE_BY_ID.get(p.templateId);
  if (!template) {
    throw new BadRequestException('Unknown poll template.');
  }

  if (template.options === null) {
    // LOCATION — options are structured location shares, not catalog ids.
    if (!Array.isArray(p.options)) {
      throw new BadRequestException(
        `A poll needs between ${MIN_POLL_OPTIONS} and ${MAX_POLL_OPTIONS} locations.`,
      );
    }
    const entries = p.options;
    if (
      entries.length < MIN_POLL_OPTIONS ||
      entries.length > MAX_POLL_OPTIONS
    ) {
      throw new BadRequestException(
        `A poll needs between ${MIN_POLL_OPTIONS} and ${MAX_POLL_OPTIONS} locations.`,
      );
    }
    const locations = entries.map((entry) => {
      const error = validateLocationPayload(entry);
      if (error) throw new BadRequestException(error);
      const e = entry as {
        lat: number;
        lng: number;
        label: string;
        source: 'CURRENT' | 'MAP_PICK';
      };
      return {
        lat: e.lat,
        lng: e.lng,
        label: sanitizeLabel(e.label) || 'Shared location',
        source: e.source,
      };
    });
    return {
      templateId: template.id,
      question: template.question,
      options: locations.map((l) => l.label),
      locations,
    };
  }

  // Static templates — options are selected by id from the fixed catalog,
  // never client-supplied text.
  if (!Array.isArray(p.optionIds)) {
    throw new BadRequestException('Poll options are required.');
  }
  const optionIds = p.optionIds;
  if (
    optionIds.length < MIN_POLL_OPTIONS ||
    optionIds.length > MAX_POLL_OPTIONS
  ) {
    throw new BadRequestException(
      `A poll needs between ${MIN_POLL_OPTIONS} and ${MAX_POLL_OPTIONS} options.`,
    );
  }
  if (new Set(optionIds).size !== optionIds.length) {
    throw new BadRequestException('Duplicate poll options are not allowed.');
  }
  for (const id of optionIds) {
    if (typeof id !== 'string' || !template.options.some((o) => o.id === id)) {
      throw new BadRequestException('Unknown poll option.');
    }
  }
  const resolvedIds = optionIds as string[];
  // Canonical template order, restricted to the selected ids — not
  // client-submitted order, so the same selection always renders
  // identically regardless of how the client sent it.
  const selected = template.options.filter((o) => resolvedIds.includes(o.id));
  return {
    templateId: template.id,
    question: template.question,
    options: selected.map((o) => o.text),
    optionIds: selected.map((o) => o.id),
  };
}

// A client may only ever supply a replyId — any client-provided `text` in
// the payload is ignored entirely by renderGroupMessage() below, never
// trusted or echoed back. This is the actual anti-bypass mechanism: even a
// direct API call cannot smuggle arbitrary text through this type, since
// the returned text always comes from QUICK_REPLY_BY_ID.get(replyId), not
// from the request body.
function validateQuickReplyPayload(payload: unknown): string | null {
  const p = payload as { replyId?: unknown } | null | undefined;
  if (
    !p ||
    typeof p.replyId !== 'string' ||
    !QUICK_REPLY_BY_ID.has(p.replyId)
  ) {
    return 'Unknown quick reply.';
  }
  return null;
}

// Single enforcement point — mirrors renderLeadMessage(). Throws
// BadRequestException on any invalid payload; the caller (GroupChatService)
// never trusts client-supplied `text` for a structured type — only what
// this function renders ever reaches the database.
export function renderGroupMessage(
  type: string,
  payload: unknown,
): RenderedGroupMessage {
  switch (type) {
    case 'DATE_TIME': {
      const error = validateDateTimePayload(payload);
      if (error) throw new BadRequestException(error);
      const p = payload as { date: string; time: string };
      return {
        type: 'DATE_TIME',
        text: `📅 Proposed: ${formatDate(p.date)} at ${formatTime(p.time)}`,
        payload: { date: p.date, time: p.time },
      };
    }
    case 'LOCATION': {
      const error = validateLocationPayload(payload);
      if (error) throw new BadRequestException(error);
      const p = payload as {
        lat: number;
        lng: number;
        label: string;
        source: 'CURRENT' | 'MAP_PICK';
      };
      const label = sanitizeLabel(p.label) || 'Shared location';
      return {
        type: 'LOCATION',
        text: `📍 ${label}`,
        payload: { lat: p.lat, lng: p.lng, label, source: p.source },
      };
    }
    case 'POLL': {
      const resolved = resolvePollPayload(payload);
      return {
        type: 'POLL',
        text: `📊 ${resolved.question}`,
        payload: {
          templateId: resolved.templateId,
          question: resolved.question,
          options: resolved.options,
          ...(resolved.optionIds ? { optionIds: resolved.optionIds } : {}),
          ...(resolved.locations ? { locations: resolved.locations } : {}),
        },
      };
    }
    case 'QUICK_REPLY': {
      const error = validateQuickReplyPayload(payload);
      if (error) throw new BadRequestException(error);
      const p = payload as { replyId: string };
      // Never falls through past the .has() check in
      // validateQuickReplyPayload, so this is always defined.
      const option = QUICK_REPLY_BY_ID.get(p.replyId)!;
      return {
        type: 'QUICK_REPLY',
        text: option.text,
        payload: { replyId: option.id, text: option.text },
      };
    }
    default:
      throw new BadRequestException(
        `Unsupported structured message type: ${String(type)}`,
      );
  }
}
