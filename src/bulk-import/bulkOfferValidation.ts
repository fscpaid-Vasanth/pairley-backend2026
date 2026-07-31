import { OfferType } from '@prisma/client';
import {
  BulkOfferRowInput,
  BulkOfferValidationResult,
} from './bulkOfferRow.types';

/**
 * Bulk Offer Import — row validation. Pure and side-effect free, same
 * discipline as offerVisibility.ts and costSplitBanner.ts: every rule here
 * is a deterministic function of the row's own fields, never a database
 * call or an AI judgement. Reused verbatim by the preview step and the
 * publish step (see BulkImportService), so they can never disagree about
 * which rows are usable — there is exactly one place this decision is made.
 */

const MOBILE_PATTERN = /^\d{10,15}$/; // matches claim-request.service.ts's own pattern
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PINCODE_PATTERN = /^\d{6}$/; // Business.pincode is required and non-nullable — India PIN codes are 6 digits

// Absorbed from MODULE15_MERCHANT_OFFER_VALIDATION.md's production audit —
// the same threshold that flagged both real bad-data offers found there
// with zero false positives against the rest of the dataset. A warning, not
// a rejection: a genuine clearance sale can legitimately be this steep.
const SUSPICIOUS_DISCOUNT_PERCENT = 70;

const OFFER_TYPE_VALUES = new Set<string>(Object.values(OfferType));

function normalizeOfferType(raw: string): string | null {
  const key = raw
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  return OFFER_TYPE_VALUES.has(key) ? key : null;
}

function parsePositiveNumber(raw: string): number | null {
  const n = Number(String(raw).replace(/,/g, '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseDate(raw: string): Date | null {
  if (!raw || !raw.trim()) return null;
  const d = new Date(raw.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

function cleanDigits(raw: string): string {
  return (raw || '').replace(/\D/g, '');
}

/**
 * Validates one row in isolation — no knowledge of other rows in the batch
 * or of existing database state. Cross-row duplicate detection (two rows
 * in the same sheet describing the same offer) and merchant-matching
 * against existing businesses are separate, deliberately: this function
 * answers "is this row internally coherent", not "is this row new".
 */
export function validateBulkOfferRow(
  row: BulkOfferRowInput,
): BulkOfferValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!row.merchantName?.trim()) errors.push('Merchant Name is required');
  if (!row.category?.trim()) errors.push('Category is required');
  if (!row.offerTitle?.trim()) errors.push('Offer Title is required');
  if (!row.address?.trim()) errors.push('Address is required');
  if (!row.city?.trim()) errors.push('City is required');
  if (!row.state?.trim()) errors.push('State is required');

  if (!row.pincode?.trim()) {
    errors.push('Pincode is required');
  } else if (!PINCODE_PATTERN.test(row.pincode.trim())) {
    errors.push('Pincode must be 6 digits');
  }

  const offerType = row.offerType?.trim()
    ? normalizeOfferType(row.offerType)
    : null;
  if (!row.offerType?.trim()) {
    errors.push('Offer Type is required');
  } else if (!offerType) {
    errors.push(`Offer Type "${row.offerType}" is not a recognised offer type`);
  }

  const originalPrice = parsePositiveNumber(row.originalPrice);
  if (!row.originalPrice?.trim()) errors.push('Original Price is required');
  else if (originalPrice === null)
    errors.push('Original Price must be a positive number');

  const offerPrice = parsePositiveNumber(row.offerPrice);
  if (!row.offerPrice?.trim()) errors.push('Offer Price is required');
  else if (offerPrice === null)
    errors.push('Offer Price must be a positive number');

  if (originalPrice !== null && offerPrice !== null) {
    if (offerPrice >= originalPrice) {
      errors.push('Offer Price must be lower than Original Price');
    } else {
      const discountPercent = (1 - offerPrice / originalPrice) * 100;
      if (discountPercent >= SUSPICIOUS_DISCOUNT_PERCENT) {
        warnings.push(
          `Discount is ${Math.round(discountPercent)}% — unusually steep, double-check the prices`,
        );
      }
    }
  }

  let minParticipants: number | null = null;
  if (!row.minParticipants?.trim()) {
    errors.push('Minimum Participants is required');
  } else {
    const n = Number(row.minParticipants.trim());
    if (!Number.isInteger(n) || n < 1) {
      errors.push('Minimum Participants must be a whole number of at least 1');
    } else {
      minParticipants = n;
    }
  }

  const validFrom = parseDate(row.validFrom);
  if (!row.validFrom?.trim()) errors.push('Valid From is required');
  else if (!validFrom) errors.push('Valid From is not a valid date');

  const validUntil = parseDate(row.validUntil);
  if (!row.validUntil?.trim()) errors.push('Valid Until is required');
  else if (!validUntil) errors.push('Valid Until is not a valid date');

  if (validFrom && validUntil && validUntil <= validFrom) {
    errors.push('Valid Until must be after Valid From');
  }

  const contactDigits = cleanDigits(row.contactNumber);
  if (!row.contactNumber?.trim()) {
    errors.push('Contact Number is required');
  } else if (!MOBILE_PATTERN.test(contactDigits)) {
    errors.push('Contact Number must be 10-15 digits');
  }

  let whatsappDigits: string | null = null;
  if (row.whatsappNumber?.trim()) {
    whatsappDigits = cleanDigits(row.whatsappNumber);
    if (!MOBILE_PATTERN.test(whatsappDigits)) {
      errors.push('WhatsApp Number must be 10-15 digits');
    }
  }

  if (row.email?.trim() && !EMAIL_PATTERN.test(row.email.trim())) {
    errors.push('Email is not a valid email address');
  }

  // Latitude/longitude are optional together, but a lone half is worse than
  // neither — it would silently place a pin at (0, lng) or (lat, 0).
  const hasLat = !!row.latitude?.trim();
  const hasLng = !!row.longitude?.trim();
  let geoLat: number | null = null;
  let geoLng: number | null = null;
  if (hasLat || hasLng) {
    if (hasLat !== hasLng) {
      errors.push('Latitude and Longitude must both be provided, or neither');
    } else {
      const lat = Number(row.latitude.trim());
      const lng = Number(row.longitude.trim());
      const latValid = Number.isFinite(lat) && lat >= -90 && lat <= 90;
      const lngValid = Number.isFinite(lng) && lng >= -180 && lng <= 180;
      if (!latValid || !lngValid) {
        errors.push('Latitude/Longitude are out of range');
      } else {
        geoLat = lat;
        geoLng = lng;
      }
    }
  }

  if (errors.length > 0) {
    return { status: 'INVALID', errors, warnings };
  }

  return {
    status: 'VALID',
    errors: [],
    warnings,
    normalized: {
      merchantName: row.merchantName.trim(),
      category: row.category.trim(),
      title: row.offerTitle.trim(),
      description: row.offerDescription?.trim() || '',
      offerType: offerType as string,
      originalPrice: originalPrice as number,
      offerPrice: offerPrice as number,
      requiredPeople: minParticipants as number,
      startDate: validFrom as Date,
      endDate: validUntil as Date,
      mobile: contactDigits,
      whatsapp: whatsappDigits,
      email: row.email?.trim() || null,
      website: row.website?.trim() || null,
      address: row.address.trim(),
      city: row.city.trim(),
      state: row.state.trim(),
      pincode: row.pincode.trim(),
      geoLat,
      geoLng,
      googleMapsLink: row.googleMapsLink?.trim() || null,
      terms: row.terms?.trim() || null,
    },
  };
}

/**
 * Flags rows within the SAME upload that describe the same offer — a
 * separate pass from validateBulkOfferRow because it needs the whole batch
 * in view, not just one row. Runs only over rows that already passed
 * per-row validation (an INVALID row is already excluded on its own
 * merits, no need to also compare it against its neighbours). Keys on
 * merchant + city + title, case/whitespace-normalized — the same signal a
 * human skimming the sheet would use to notice "wait, didn't I just see
 * this?"
 */
export function findDuplicateRowIndexes(
  validRows: { rowNo: number; normalized: NormalizedBulkOfferLike }[],
): Set<number> {
  const seen = new Map<string, number>();
  const duplicates = new Set<number>();
  for (const { rowNo, normalized } of validRows) {
    const key = [normalized.merchantName, normalized.city, normalized.title]
      .map((s) => s.trim().toLowerCase())
      .join('|');
    if (seen.has(key)) {
      duplicates.add(rowNo);
    } else {
      seen.set(key, rowNo);
    }
  }
  return duplicates;
}

// Structural subset of NormalizedBulkOffer — findDuplicateRowIndexes only
// needs these three fields, so it doesn't force every caller to construct a
// full NormalizedBulkOffer just to check for duplicates.
interface NormalizedBulkOfferLike {
  merchantName: string;
  city: string;
  title: string;
}
