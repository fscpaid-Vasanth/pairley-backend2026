/**
 * Bulk Offer Import — the format-agnostic shapes every input adapter
 * produces and every downstream stage (validation, create, publish)
 * consumes.
 *
 * Deliberately decoupled from "Excel" or "CSV": a parser adapter's only job
 * is turning one input format into `BulkOfferRowInput[]` — plain strings,
 * no coercion, no business rules. Everything that decides whether a row is
 * usable lives in `bulkOfferValidation.ts`, which never knows or cares
 * whether the row came from a spreadsheet, a JSON body, or a future REST
 * upload endpoint. Adding CSV/XLSX support today and JSON/REST/merchant
 * self-upload later means adding adapters, never touching validation.
 */

/** One offer row, exactly as read from the sheet — raw strings, untyped. */
export interface BulkOfferRowInput {
  rowNo: number;
  merchantName: string;
  category: string;
  offerTitle: string;
  offerDescription: string;
  offerType: string;
  originalPrice: string;
  offerPrice: string;
  minParticipants: string;
  validFrom: string;
  validUntil: string;
  contactNumber: string;
  whatsappNumber: string;
  email: string;
  website: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  latitude: string;
  longitude: string;
  googleMapsLink: string;
  terms: string;
  status: string;
  /** The original row, keyed by column header — for the downloadable error report. */
  raw: Record<string, unknown>;
}

/** The typed, business-rule-checked form of a row that passed validation. */
export interface NormalizedBulkOffer {
  merchantName: string;
  category: string;
  title: string;
  description: string;
  offerType: string; // validated against the OfferType enum, not re-typed here to avoid an extra @prisma/client import in a pure-logic file
  originalPrice: number;
  offerPrice: number;
  requiredPeople: number;
  startDate: Date;
  endDate: Date;
  mobile: string;
  whatsapp: string | null;
  email: string | null;
  website: string | null;
  address: string;
  city: string;
  state: string;
  pincode: string;
  geoLat: number | null;
  geoLng: number | null;
  googleMapsLink: string | null;
  terms: string | null;
}

export type BulkOfferRowStatus = 'VALID' | 'INVALID' | 'DUPLICATE';

export interface BulkOfferValidationResult {
  status: BulkOfferRowStatus;
  /** Blocking problems — present only when status is INVALID or DUPLICATE. */
  errors: string[];
  /** Non-blocking flags on an otherwise VALID row (e.g. an unusually large discount). */
  warnings: string[];
  /** Present only when status is VALID. */
  normalized?: NormalizedBulkOffer;
}
