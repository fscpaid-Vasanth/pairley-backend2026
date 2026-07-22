import { Injectable } from '@nestjs/common';
import { OfferType } from '@prisma/client';
import { ExtractedFields } from './content-extraction.service';

export interface NormalizedFields {
  // null means "nothing usable found" — CandidateOfferService applies the
  // same `?? 0` fallback it already applies to the plain extracted price,
  // so behavior is unchanged when normalization finds no discount signal.
  original_price: number | null;
  offer_price: number | null;
  // Always has a value — STANDARD is the safe fallback when no keyword
  // matches, identical to what every candidate got before this module.
  offer_type: OfferType;
  // null means "use the existing default" (now -> now+30 days) — this is
  // a best-effort signal, never a hard requirement.
  validity_end: Date | null;
}

const MAX_VALID_PCT_OFF = 99;
const MIN_VALID_PCT_OFF = 1;
const MAX_VALIDITY_YEARS_OUT = 2;
const MAX_VALIDITY_DAYS_IN_PAST = 7; // tolerates "today"/timezone edge cases

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

// Deterministic, rule-based only — no LLM/AI inference, same discipline as
// ContentExtractionService/TextExtractionService. Sits between extraction
// and CandidateOfferService: takes the ExtractedFields extraction already
// produced (plus the raw underlying text it preserved) and derives a
// richer, still-deterministic set of fields extraction didn't attempt —
// an actual discount split (today, original_price always equals
// offer_price), an offer_type classification (today, always STANDARD),
// and a best-effort validity end date (today, always a hardcoded 30 days).
// Every output here is a *suggestion CandidateOfferService may use*, with
// the exact prior behavior as the fallback whenever nothing is confidently
// detected — this module changes what's possible, not what happens when
// source content gives no better signal.
@Injectable()
export class NormalizationService {
  normalize(fields: ExtractedFields): NormalizedFields {
    const text = fields.rawText ?? '';

    return {
      ...this.normalizePrice(text, fields.price),
      offer_type: this.classifyOfferType(text),
      validity_end: this.extractValidityEnd(text),
    };
  }

  // Three discount phrasings, checked most-explicit-first. Whichever
  // matches, the single price extraction already found is treated as the
  // OFFER (final/discounted) price when any discount signal is present —
  // a consistent, documented convention rather than guessing per-pattern,
  // since posters/pages overwhelmingly lead with the price a customer
  // actually pays. Falls back to today's exact behavior (both prices equal
  // the single found price, or both null) when no signal is found.
  private normalizePrice(
    text: string,
    foundPrice: number | null,
  ): { original_price: number | null; offer_price: number | null } {
    const wasNowMatch = text.match(
      /was\s*(?:₹|Rs\.?|INR)\s?([\d,]+(?:\.\d{1,2})?)[\s\S]{0,25}?now\s*(?:₹|Rs\.?|INR)\s?([\d,]+(?:\.\d{1,2})?)/i,
    );
    if (wasNowMatch) {
      const original = this.parseAmount(wasNowMatch[1]);
      const offer = this.parseAmount(wasNowMatch[2]);
      if (original !== null && offer !== null && offer < original) {
        return { original_price: original, offer_price: offer };
      }
    }

    const pctMatch = text.match(
      /(\d{1,3})\s*(?:%|percent)\s*(?:off|discount)/i,
    );
    if (pctMatch && foundPrice !== null) {
      const pct = Number(pctMatch[1]);
      if (pct >= MIN_VALID_PCT_OFF && pct <= MAX_VALID_PCT_OFF) {
        const original = Math.round((foundPrice / (1 - pct / 100)) * 100) / 100;
        return { original_price: original, offer_price: foundPrice };
      }
    }

    const flatMatch = text.match(
      /flat\s*(?:₹|Rs\.?|INR)\s?([\d,]+(?:\.\d{1,2})?)\s*off/i,
    );
    if (flatMatch && foundPrice !== null) {
      const flatAmount = this.parseAmount(flatMatch[1]);
      if (flatAmount !== null && flatAmount > 0) {
        return {
          original_price: Math.round((foundPrice + flatAmount) * 100) / 100,
          offer_price: foundPrice,
        };
      }
    }

    return { original_price: foundPrice, offer_price: foundPrice };
  }

  private parseAmount(raw: string): number | null {
    const numeric = Number(raw.replace(/,/g, ''));
    return Number.isFinite(numeric) ? numeric : null;
  }

  // Ordered, first-match-wins. Covers the clearest/most common phrasings
  // for each of the 17 OfferType values; anything ambiguous falls through
  // to STANDARD — the same safe default every candidate got before this
  // module, and the admin corrects it during review either way.
  private classifyOfferType(text: string): OfferType {
    const rules: Array<[RegExp, OfferType]> = [
      [
        /buy\s*1\s*get\s*1|\bbogo\b|buy\s+one\s+get\s+one\s+free/i,
        OfferType.BOGO,
      ],
      [/buy\s*1\s*get\s*2|buy\s+one\s+get\s+two/i, OfferType.BOGT],
      [/cashback/i, OfferType.CASHBACK],
      [
        /membership|annual\s+plan|subscription\s+plan/i,
        OfferType.MEMBERSHIP_CAMPAIGN,
      ],
      [/\bbulk\b|wholesale/i, OfferType.BULK_PURCHASE],
      [/group\s+of\s+\d+|group\s+discount/i, OfferType.GROUP_DISCOUNT],
      [/package\s+deal|\bbundle\b/i, OfferType.PACKAGE_DEAL],
      [/flash\s+sale|today\s+only|\bhours?\s+only\b/i, OfferType.FLASH_DEAL],
      [
        /only\s+\d+\s+(?:left|units|pieces|pcs)|limited\s+stock|while\s+stocks?\s+last/i,
        OfferType.LIMITED_QUANTITY,
      ],
      [/limited\s+time|ends\s+soon|\bhurry\b/i, OfferType.LIMITED_TIME],
      [
        /diwali|holi|christmas|new\s+year|festival|eid|navratri/i,
        OfferType.FESTIVAL,
      ],
      [/\bsummer\b|\bwinter\b|\bmonsoon\b|seasonal/i, OfferType.SEASONAL],
      [/flat\s*(?:₹|rs\.?|inr)?\s*[\d,]+\s*off/i, OfferType.FLAT_DISCOUNT],
      [/\d{1,3}\s*(?:%|percent)\s*off/i, OfferType.PERCENTAGE_DISCOUNT],
      [/\bcombo\b/i, OfferType.COMBO],
      [/buy\s*\d+\s*get\s*\d+/i, OfferType.BUY_X_GET_Y],
    ];
    for (const [pattern, type] of rules) {
      if (pattern.test(text)) return type;
    }
    return OfferType.STANDARD;
  }

  // Deliberately conservative: only ever extracts an END date, never a
  // start date (posters/pages advertise when an offer ends far more often
  // than when it started). Any parse that fails basic sanity checks
  // (invalid date, too far in the past, implausibly far in the future)
  // returns null so the caller falls back to the existing default window —
  // under-detecting is the safe failure mode here, not over-detecting.
  private extractValidityEnd(text: string): Date | null {
    const match = text.match(
      /(?:valid\s*(?:till|until|thru|through)|offer\s*ends?|ends?\s*(?:on)?)\s*[:-]?\s*(\d{1,2})(?:st|nd|rd|th)?[\s/-]([a-zA-Z]+|\d{1,2})[\s/-]?(\d{2,4})?/i,
    );
    if (!match) return null;

    const day = Number(match[1]);
    const monthRaw = match[2].toLowerCase();
    const month = MONTHS[monthRaw] ?? Number(monthRaw) - 1;
    const now = new Date();
    let year = match[3] ? Number(match[3]) : now.getFullYear();
    if (match[3] && year < 100) year += 2000;

    if (
      !Number.isInteger(day) ||
      day < 1 ||
      day > 31 ||
      !Number.isInteger(month) ||
      month < 0 ||
      month > 11
    ) {
      return null;
    }

    let candidate = new Date(year, month, day, 23, 59, 59);
    if (Number.isNaN(candidate.getTime())) return null;

    // No year was written (e.g. "valid till 31 Aug") and that date has
    // already passed this year — assume next year rather than treating it
    // as expired-on-arrival.
    if (!match[3]) {
      const daysInPast =
        (now.getTime() - candidate.getTime()) / (24 * 60 * 60 * 1000);
      if (daysInPast > MAX_VALIDITY_DAYS_IN_PAST) {
        candidate = new Date(year + 1, month, day, 23, 59, 59);
      }
    }

    const daysInPast =
      (now.getTime() - candidate.getTime()) / (24 * 60 * 60 * 1000);
    const maxFuture = new Date(now);
    maxFuture.setFullYear(maxFuture.getFullYear() + MAX_VALIDITY_YEARS_OUT);
    if (daysInPast > MAX_VALIDITY_DAYS_IN_PAST || candidate > maxFuture) {
      return null;
    }

    return candidate;
  }
}
