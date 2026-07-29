import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import {
  BannerInput,
  BannerLayout,
  buildBannerLayout,
  charsThatFit,
  wrapLines,
} from './bannerLayout';

const MARGIN = 64;
const TITLE_FONT = 60;
const TITLE_MAX_LINES = 2;
const BODY_FONT = 30;
const BODY_MAX_LINES = 4;
/** Baseline of the big offer price, measured up from the bottom edge. */
const PRICE_BASELINE_OFFSET = 262;
/** Clear space kept between the last body line and the price. */
const BODY_PRICE_GAP = 46;

/**
 * Module 14 Phase 3B — composes a Pairley banner.
 *
 * Deliberately thin: every decision (escaping, truncation, price maths, badge
 * and logo policy) already happened in bannerLayout.ts. This file only turns
 * a resolved layout into pixels, so there is nothing here that needs an image
 * to test.
 *
 * Composition, not generation. `sharp` rasterises an SVG template over an
 * optional hero image. That gives pixel-exact text, identical branding on
 * every offer, no per-image cost, and regeneration fast enough to run on an
 * admin edit.
 */

const CATEGORY_PALETTE: Record<string, { from: string; to: string; icon: string }> = {
  dining: { from: '#F97316', to: '#B91C1C', icon: '🍽' },
  fitness: { from: '#10B981', to: '#065F46', icon: '💪' },
  beauty: { from: '#EC4899', to: '#9D174D', icon: '💅' },
  entertainment: { from: '#8B5CF6', to: '#5B21B6', icon: '🎬' },
  travel: { from: '#0EA5E9', to: '#0C4A6E', icon: '✈' },
  shopping: { from: '#5B12D6', to: '#3B0A8C', icon: '🛍' },
  services: { from: '#64748B', to: '#1E293B', icon: '🔧' },
  education: { from: '#F59E0B', to: '#92400E', icon: '📚' },
  health: { from: '#14B8A6', to: '#115E59', icon: '⚕' },
  automotive: { from: '#475569', to: '#0F172A', icon: '🚗' },
  electronics: { from: '#3B82F6', to: '#1E3A8A', icon: '💻' },
  groceries: { from: '#84CC16', to: '#3F6212', icon: '🛒' },
};

const DEFAULT_PALETTE = CATEGORY_PALETTE.shopping;

export interface RenderedBanner {
  buffer: Buffer;
  width: number;
  height: number;
  /** True when a merchant hero image was composited in. */
  usedHeroImage: boolean;
}

@Injectable()
export class BannerRenderService {
  private readonly logger = new Logger(BannerRenderService.name);

  async render(input: BannerInput): Promise<RenderedBanner> {
    const layout = buildBannerLayout(input);
    const palette = CATEGORY_PALETTE[layout.categoryKey] ?? DEFAULT_PALETTE;

    // The base plate is always a category gradient, so a banner renders
    // correctly even with no merchant imagery at all — the common case for a
    // freshly imported listing.
    let base = sharp({
      create: {
        width: layout.width,
        height: layout.height,
        channels: 4,
        background: { r: 12, g: 8, b: 28, alpha: 1 },
      },
    }).png();

    let usedHeroImage = false;
    const hero = await this.loadHero(layout);
    if (hero) {
      base = sharp(hero).png();
      usedHeroImage = true;
    }

    const svg = Buffer.from(this.buildSvg(layout, palette, usedHeroImage));

    const buffer = await base
      .composite([{ input: svg, top: 0, left: 0 }])
      .png()
      .toBuffer();

    return {
      buffer,
      width: layout.width,
      height: layout.height,
      usedHeroImage,
    };
  }

  /**
   * Fetches and crops the hero image to the banner frame. Any failure —
   * unreachable host, unsupported format, oversized file — returns null so
   * the banner still renders on the gradient plate. A missing photo must
   * never be the reason an offer has no banner.
   */
  private async loadHero(layout: BannerLayout): Promise<Buffer | null> {
    if (!layout.heroImageUrl) return null;
    try {
      const response = await fetch(layout.heroImageUrl, {
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return null;

      const bytes = Buffer.from(await response.arrayBuffer());
      return await sharp(bytes)
        .resize(layout.width, layout.height, { fit: 'cover', position: 'attention' })
        .modulate({ brightness: 0.62 }) // keep overlaid text legible
        .png()
        .toBuffer();
    } catch (err) {
      this.logger.warn(
        `Hero image unusable for banner (${layout.heroImageUrl}): ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return null;
    }
  }

  private buildSvg(
    layout: BannerLayout,
    palette: { from: string; to: string; icon: string },
    hasHero: boolean,
  ): string {
    const { width: W, height: H } = layout;

    // Over a photo the plate becomes a scrim so text stays readable; without
    // one it's the banner's whole visual identity.
    const plate = hasHero
      ? `<rect width="${W}" height="${H}" fill="url(#scrim)"/>`
      : `<rect width="${W}" height="${H}" fill="url(#grad)"/>
         <circle cx="${W * 0.82}" cy="${H * 0.18}" r="${W * 0.30}" fill="#ffffff" opacity="0.06"/>
         <circle cx="${W * 0.14}" cy="${H * 0.86}" r="${W * 0.24}" fill="#ffffff" opacity="0.05"/>`;

    const badge = layout.badgeLabel
      ? `<g transform="translate(64, 64)">
           <rect rx="26" ry="26" width="${Math.max(240, layout.badgeLabel.length * 15)}" height="52" fill="#ffffff" opacity="0.16"/>
           <text x="26" y="34" font-size="24" font-weight="700" fill="#ffffff" font-family="sans-serif">${layout.badgeLabel}</text>
         </g>`
      : '';

    const discount = layout.discountLabel
      ? `<g transform="translate(${W - 260}, 56)">
           <rect rx="20" ry="20" width="196" height="86" fill="#FACC15"/>
           <text x="98" y="58" font-size="40" font-weight="900" fill="#1F1300" text-anchor="middle" font-family="sans-serif">${layout.discountLabel}</text>
         </g>`
      : '';

    const original = layout.originalPriceLabel
      ? `<text x="${64 + this.textWidth(layout.offerPriceLabel, 76) + 28}" y="${H - PRICE_BASELINE_OFFSET - 6}" font-size="34" fill="#E5E7EB" opacity="0.75" font-family="sans-serif" text-decoration="line-through">${layout.originalPriceLabel}</text>`
      : '';

    const savings = layout.savingsLabel
      ? `<text x="64" y="${H - 218}" font-size="30" font-weight="700" fill="#4ADE80" font-family="sans-serif">${layout.savingsLabel}</text>`
      : '';

    const group = layout.groupLabel
      ? `<g transform="translate(64, ${H - 190})">
           <rect rx="18" ry="18" width="${Math.max(230, layout.groupLabel.length * 14)}" height="46" fill="#ffffff" opacity="0.14"/>
           <text x="22" y="31" font-size="24" font-weight="700" fill="#ffffff" font-family="sans-serif">👥 ${layout.groupLabel}</text>
         </g>`
      : '';

    const location = layout.location
      ? `<text x="64" y="188" font-size="26" fill="#E5E7EB" opacity="0.85" font-family="sans-serif">📍 ${layout.location}</text>`
      : '';

    // Every text block is wrapped against the real available width rather
    // than a guessed character count — the first version overflowed the
    // canvas on long titles and on body copy, which was only visible by
    // rendering a banner and looking at it.
    const usableWidth = W - MARGIN * 2;

    const titleLines = wrapLines(
      layout.title,
      charsThatFit(usableWidth, TITLE_FONT),
      TITLE_MAX_LINES,
    );
    const titleTop = H * 0.40;
    const titleSvg = titleLines
      .map(
        (line, i) =>
          `<text x="${MARGIN}" y="${titleTop + i * (TITLE_FONT + 8)}" font-size="${TITLE_FONT}" font-weight="900" fill="#ffffff" font-family="sans-serif">${line}</text>`,
      )
      .join('\n  ');

    const headlineY = titleTop + titleLines.length * (TITLE_FONT + 8) + 20;
    const bodyY = headlineY + 56;

    // The price block sits at a fixed offset from the bottom, so a two-line
    // title pushes the body down into it. Cap the body by the space that is
    // actually left rather than by a constant — a fourth line of copy is
    // worth far less than a legible price.
    const bodyLineHeight = BODY_FONT + 12;
    const bodyBottomLimit = H - PRICE_BASELINE_OFFSET - BODY_PRICE_GAP;
    const bodyLinesAvailable = Math.floor(
      (bodyBottomLimit - bodyY) / bodyLineHeight,
    );
    const bodyMaxLines = Math.max(
      1,
      Math.min(BODY_MAX_LINES, bodyLinesAvailable),
    );

    const bodySvg = wrapLines(
      layout.body,
      charsThatFit(usableWidth, BODY_FONT),
      bodyMaxLines,
    )
      .map(
        (line, i) =>
          `<text x="${MARGIN}" y="${bodyY + i * (BODY_FONT + 12)}" font-size="${BODY_FONT}" fill="#F3F4F6" opacity="0.92" font-family="sans-serif">${line}</text>`,
      )
      .join('\n  ');

    return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${palette.from}"/>
      <stop offset="100%" stop-color="${palette.to}"/>
    </linearGradient>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0.55"/>
      <stop offset="55%" stop-color="#000000" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.88"/>
    </linearGradient>
  </defs>

  ${plate}
  ${badge}
  ${discount}

  <text x="${MARGIN}" y="150" font-size="34" font-weight="800" fill="#ffffff" font-family="sans-serif">${palette.icon} ${layout.businessName}</text>
  ${location}

  ${titleSvg}
  <text x="${MARGIN}" y="${headlineY}" font-size="38" font-weight="700" fill="#FDE68A" font-family="sans-serif">${layout.headline}</text>

  ${bodySvg}

  <text x="64" y="${H - PRICE_BASELINE_OFFSET}" font-size="76" font-weight="900" fill="#ffffff" font-family="sans-serif">${layout.offerPriceLabel}</text>
  ${original}
  ${savings}
  ${group}

  <g transform="translate(64, ${H - 120})">
    <rect rx="30" ry="30" width="330" height="72" fill="#ffffff"/>
    <text x="165" y="47" font-size="30" font-weight="900" fill="#3B0A8C" text-anchor="middle" font-family="sans-serif">${layout.ctaLabel}</text>
  </g>

  <text x="${W - 64}" y="${H - 72}" font-size="28" font-weight="800" fill="#ffffff" opacity="0.85" text-anchor="end" font-family="sans-serif">Pairley</text>
  <text x="${W - 64}" y="${H - 40}" font-size="20" fill="#ffffff" opacity="0.55" text-anchor="end" font-family="sans-serif">${layout.offerTypeLabel}</text>
</svg>`;
  }

  /** Rough advance width, only used to place the struck-through price. */
  private textWidth(text: string, fontSize: number): number {
    return text.length * fontSize * 0.58;
  }
}
