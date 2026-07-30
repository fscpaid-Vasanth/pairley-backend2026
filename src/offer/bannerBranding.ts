import { BusinessStatus } from '@prisma/client';

/**
 * Module 14 Phase 3C — merchant banner branding preference.
 *
 * A claimed merchant may choose whether their banners lead with Pairley's
 * identity (Mode A, the default) or their own (Mode B). The underlying
 * template is unchanged either way — this only shifts palette, logo
 * prominence, hero emphasis and CTA styling, so there is one template
 * system rather than two.
 *
 * Pure and side-effect free, same discipline as the rest of the banner
 * content layer.
 */

export type BrandingMode = 'PAIRLEY' | 'MERCHANT';

/** Pairley's own identity — the default, and the floor everything falls
 *  back to when merchant branding can't be honoured. */
export const PAIRLEY_BRAND = {
  primary: '#5B12D6',
  primaryDark: '#3B0A8C',
  accent: '#22C55E',
  onPrimary: '#FFFFFF',
} as const;

export interface BannerBranding {
  mode: BrandingMode;
  /**
   * Why this mode is in effect. Non-null whenever the requested mode was
   * *not* honoured, so the admin UI can explain a downgrade instead of
   * silently showing something the merchant didn't pick.
   */
  downgradeReason: string | null;
  /** Every colour below is a validated #RRGGBB string — see normalizeHexColor. */
  primaryColor: string;
  /** primaryColor adjusted so it is legible as text on a white card. */
  textColor: string;
  /** Readable text/graphics drawn *on top of* a primaryColor fill. */
  onPrimaryColor: string;
  primaryDarkColor: string;
  accentColor: string;
  ctaBackground: string;
  ctaTextColor: string;
  /** Readable text on the dark CTA bar. */
  onPrimaryDarkColor: string;
  /**
   * The CTA bar's second, emphasised line. Under Pairley branding this is
   * the brand green on deep purple, which reads well. Under merchant
   * branding the accent and the bar are derived from the *same* colour, so
   * an accent-coloured line would be near-invisible against it — verified
   * by rendering. In that case it falls back to the readable text colour
   * rather than a tint that technically differs but can't be read.
   */
  onPrimaryDarkAccentColor: string;
  /** Merchant branding gives the photo more of the canvas. */
  heroEmphasis: 'standard' | 'elevated';
  /**
   * 'none' for an unclaimed business (a logo is a trademark — see
   * bannerLayout.ts's decideLogo, which enforces the same rule on the
   * logo URL itself), 'standard' under Pairley branding, 'prominent'
   * when the merchant has asked to lead with their own identity.
   */
  logoProminence: 'none' | 'standard' | 'prominent';
}

/**
 * Strict #RRGGBB / #RGB validation.
 *
 * This value is merchant-supplied and ends up inside an SVG `fill`
 * attribute. Escaping alone isn't the right defence for a colour — there
 * is exactly one legal shape for it, so anything else is rejected outright
 * rather than sanitised and hoped for. Returns null for anything that
 * isn't unambiguously a hex colour.
 */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed)) return null;

  // Expand #RGB to #RRGGBB so downstream code only ever handles one form.
  if (trimmed.length === 4) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  return trimmed.toUpperCase();
}

/** Darkens a validated hex colour, for the gradient's far stop. */
export function darkenHex(hex: string, amount = 0.35): string {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return PAIRLEY_BRAND.primaryDark;

  const scale = Math.min(1, Math.max(0, 1 - amount));
  const channel = (offset: number) => {
    const value = parseInt(normalized.slice(offset, offset + 2), 16);
    return Math.round(value * scale)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`.toUpperCase();
}

/** WCAG relative luminance of a validated hex colour, 0–1. */
export function relativeLuminance(hex: string): number {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return 0;
  const srgb = [1, 3, 5].map((offset) => {
    const value = parseInt(normalized.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

/**
 * The brand colour, darkened until it is actually readable as *text on a
 * white card*.
 *
 * A colour that works beautifully as a solid fill (with light text on top)
 * can be illegible as text on white — a pale brand yellow rendered the
 * headline, the "You Pay" figure and the merchant name nearly invisible,
 * found by rendering a light-coloured brand. Luminance ≤ 0.18 is the point
 * at which text clears a 4.5:1 contrast ratio against white.
 */
export function readableOnLight(hex: string): string {
  let candidate = normalizeHexColor(hex);
  if (!candidate) return PAIRLEY_BRAND.primary;

  // Bounded loop: each pass removes 18% of each channel, so this converges
  // quickly and can never spin.
  for (let i = 0; i < 12 && relativeLuminance(candidate) > 0.18; i++) {
    candidate = darkenHex(candidate, 0.18);
  }
  return candidate;
}

/**
 * Relative luminance (WCAG), used to pick readable CTA text. A merchant
 * whose brand colour is a pale yellow needs dark CTA text; one with a deep
 * navy needs white. Guessing wrong here makes the most important element
 * on the banner unreadable.
 */
export function readableTextOn(backgroundHex: string): string {
  const normalized = normalizeHexColor(backgroundHex);
  if (!normalized) return '#FFFFFF';

  const srgb = [1, 3, 5].map((offset) => {
    const value = parseInt(normalized.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
  // 0.45 sits between the contrast crossovers for white and near-black
  // text, so each is chosen where it genuinely reads better.
  return luminance > 0.45 ? '#101010' : '#FFFFFF';
}

export interface BrandingInput {
  requestedMode?: string | null;
  businessStatus?: string | null;
  brandColor?: string | null;
  /** Whether a usable logo URL exists at all. */
  hasLogo?: boolean;
}

/**
 * Resolves the branding actually applied to a banner.
 *
 * Merchant branding is honoured only when *all* of these hold:
 *  - the merchant asked for it,
 *  - the business is CLAIMED — an unclaimed, AI-discovered business has
 *    made no such request and gets no implied endorsement, and
 *  - a valid brand colour exists to actually brand with.
 *
 * Any failure downgrades to Pairley branding with a stated reason, rather
 * than half-applying merchant styling.
 */
export function resolveBranding(input: BrandingInput): BannerBranding {
  const isClaimed = input.businessStatus === BusinessStatus.CLAIMED;
  const wantsMerchant = input.requestedMode === 'MERCHANT';
  const brandColor = normalizeHexColor(input.brandColor);

  const pairleyBranding = (downgradeReason: string | null): BannerBranding => ({
    mode: 'PAIRLEY',
    downgradeReason,
    primaryColor: PAIRLEY_BRAND.primary,
    textColor: readableOnLight(PAIRLEY_BRAND.primary),
    onPrimaryColor: readableTextOn(PAIRLEY_BRAND.primary),
    primaryDarkColor: PAIRLEY_BRAND.primaryDark,
    accentColor: PAIRLEY_BRAND.accent,
    ctaBackground: PAIRLEY_BRAND.accent,
    ctaTextColor: PAIRLEY_BRAND.onPrimary,
    onPrimaryDarkColor: readableTextOn(PAIRLEY_BRAND.primaryDark),
    onPrimaryDarkAccentColor: PAIRLEY_BRAND.accent,
    heroEmphasis: 'standard',
    // Even under Pairley branding a claimed merchant's logo may appear —
    // it just doesn't lead. An unclaimed business shows none at all.
    logoProminence: isClaimed && input.hasLogo ? 'standard' : 'none',
  });

  if (!wantsMerchant) return pairleyBranding(null);

  if (!isClaimed) {
    return pairleyBranding(
      'Merchant branding applies once the business claims its Pairley listing.',
    );
  }
  if (!brandColor) {
    return pairleyBranding(
      'Add a brand colour to use merchant branding on banners.',
    );
  }

  const primaryDarkColor = darkenHex(brandColor);
  const onPrimaryDarkColor = readableTextOn(primaryDarkColor);

  return {
    mode: 'MERCHANT',
    downgradeReason: null,
    primaryColor: brandColor,
    textColor: readableOnLight(brandColor),
    onPrimaryColor: readableTextOn(brandColor),
    primaryDarkColor,
    accentColor: brandColor,
    ctaBackground: brandColor,
    ctaTextColor: readableTextOn(brandColor),
    onPrimaryDarkColor,
    // Deliberately not the accent: it and the bar come from one colour, so
    // an accent line would be unreadable against it.
    onPrimaryDarkAccentColor: onPrimaryDarkColor,
    heroEmphasis: 'elevated',
    logoProminence: input.hasLogo ? 'prominent' : 'standard',
  };
}
