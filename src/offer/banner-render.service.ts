import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import QRCode from 'qrcode';
import {
  BannerInput,
  BannerLayout,
  buildBannerLayout,
  charsThatFit,
  wrapLines,
  escapeXml,
} from './bannerLayout';
import { buildDiscountBadgeText } from './costSplitBanner';
import { StorageService } from '../common/services/storage.service';

// The same recognized-storage-URL check `document-preview` uses to decide
// whether a URL needs an authenticated fetch. Duplicated rather than
// imported because it's a two-line hostname check with no shared module to
// pull from on the backend (the frontend's copy lives in adminFilePreview.js
// for the same reason, on the other side of the API boundary).
function isOwnStorageUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return (
      hostname.includes('.amazonaws.com') ||
      hostname === 'firebasestorage.googleapis.com'
    );
  } catch {
    return false;
  }
}

const MARGIN = 64;
const TITLE_FONT = 60;
const TITLE_MAX_LINES = 2;
const BODY_FONT = 30;
const BODY_MAX_LINES = 4;
const HEADLINE_FONT = 38;
const HEADLINE_MAX_LINES = 2;
/** Baseline of the big offer price, measured up from the bottom edge. */
const PRICE_BASELINE_OFFSET = 262;
/** Clear space kept between the last body line and the price. */
const BODY_PRICE_GAP = 46;

/**
 * Per-template geometry (Module 14 Phase 3C).
 *
 * Deliberately a small geometry table rather than five bespoke SVG builders:
 * the templates are **plumbing at this stage, not final designs**. Visual
 * fine-tuning is explicitly deferred until typography is verified on the
 * production renderer, because tuning five layouts against a font that may
 * still change means tuning them twice.
 *
 * `textLeftRatio`/`textWidthRatio` place the copy column; `heroMode` decides
 * whether the image is full-bleed behind the text or confined to a panel.
 */
interface TemplateGeometry {
  textLeftRatio: number;
  textWidthRatio: number;
  heroMode: 'full-bleed' | 'left-panel';
  titleTopRatio: number;
  accent: boolean;
}

const TEMPLATE_GEOMETRY: Record<string, TemplateGeometry> = {
  // Hero Spotlight — image behind everything, copy low, big badge.
  A: {
    textLeftRatio: 0.059,
    textWidthRatio: 0.88,
    heroMode: 'full-bleed',
    titleTopRatio: 0.4,
    accent: false,
  },
  // Split Detail — image confined left, all copy in the right column.
  B: {
    textLeftRatio: 0.5,
    textWidthRatio: 0.44,
    heroMode: 'left-panel',
    titleTopRatio: 0.3,
    accent: true,
  },
  // Premium Card — generous margins, copy sits lower, accent rule.
  C: {
    textLeftRatio: 0.075,
    textWidthRatio: 0.85,
    heroMode: 'full-bleed',
    titleTopRatio: 0.44,
    accent: true,
  },
  // Active — copy high and loud.
  D: {
    textLeftRatio: 0.059,
    textWidthRatio: 0.88,
    heroMode: 'full-bleed',
    titleTopRatio: 0.34,
    accent: false,
  },
  // Product Grid — product-forward, copy compact and low.
  E: {
    textLeftRatio: 0.059,
    textWidthRatio: 0.86,
    heroMode: 'full-bleed',
    titleTopRatio: 0.46,
    accent: false,
  },
};

const DEFAULT_GEOMETRY = TEMPLATE_GEOMETRY.A;

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

const CATEGORY_PALETTE: Record<
  string,
  { from: string; to: string; icon: string }
> = {
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

  constructor(private readonly storage: StorageService) {}

  async render(input: BannerInput): Promise<RenderedBanner> {
    const layout = buildBannerLayout(input);
    const palette = CATEGORY_PALETTE[layout.categoryKey] ?? DEFAULT_PALETTE;

    if (layout.templateId === 'F') {
      return this.renderCostSplit(layout, palette);
    }

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
    const hero = await this.loadHero(
      layout.heroImageUrl,
      layout.width,
      layout.height,
    );
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
   * Fetches and crops a hero image to `targetWidth`x`targetHeight`. Any
   * failure — unreachable host, unsupported format, oversized file —
   * returns null so the banner still renders without it. A-E use
   * this at the full canvas size (a full-bleed background); Template F uses
   * it at the size of its inset photo panel — see renderCostSplit(). The
   * darkening is skipped for the inset case (`dim`): F's photo sits on a
   * white card with its own scrim-free overlay, not text laid directly over
   * the image the way A-E do it.
   */
  private async loadHero(
    heroImageUrl: string | null,
    targetWidth: number,
    targetHeight: number,
    dim = true,
  ): Promise<Buffer | null> {
    if (!heroImageUrl) return null;
    try {
      // Real, production-verified bug: our own S3/Firebase-stored images
      // (an admin's uploaded replacement, or a poster/PDF import's cover
      // image) 403 on a plain unauthenticated fetch — the bucket has no
      // public GetObject. Every other admin-facing image preview in this
      // codebase (document-preview) already routes such URLs through
      // StorageService's authenticated read instead of a raw fetch; this
      // was the one path that didn't, and a banner would silently fall back
      // to the gradient plate — a real image that never renders is a far
      // worse failure than an unreachable one, since nothing about the
      // response even hints at why. An external URL (a merchant's own
      // public site) still uses plain fetch, exactly as before.
      const bytes = isOwnStorageUrl(heroImageUrl)
        ? (await this.storage.getFileByUrl(heroImageUrl)).buffer
        : await this.fetchExternal(heroImageUrl);
      if (!bytes) return null;

      let pipeline = sharp(bytes).resize(targetWidth, targetHeight, {
        fit: 'cover',
        position: 'attention',
      });
      if (dim) pipeline = pipeline.modulate({ brightness: 0.62 }); // keep overlaid text legible
      return await pipeline.png().toBuffer();
    } catch (err) {
      this.logger.warn(
        `Hero image unusable for banner (${heroImageUrl}): ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return null;
    }
  }

  private async fetchExternal(url: string): Promise<Buffer | null> {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Template F ("Cost-Split") — a different visual language from A-E on
   * purpose: a light card layout carrying the numeric You-Pay/Offer-Partner
   * math, a 3-step unlock diagram, an Offer Partner card, and a QR code
   * linking to the real deal page. The hero photo (when there is one) is a
   * small inset panel, not a full-bleed background, so it's composited via
   * an embedded base64 `<image>` inside the SVG rather than as the sharp
   * base layer A-E use — verified separately that librsvg actually
   * rasterises embedded base64 images and `clipPath` roundings (unlike
   * `@font-face`, which it silently ignores — see fonts.ts).
   */
  private async renderCostSplit(
    layout: BannerLayout,
    palette: { from: string; to: string; icon: string },
  ): Promise<RenderedBanner> {
    // Must match buildCostSplitSvg's heroHeight exactly, or the photo is
    // cropped to one aspect and drawn into a frame of another.
    const heroSize = {
      width: 520,
      height: layout.branding.heroEmphasis === 'elevated' ? 340 : 300,
    };
    const hero = await this.loadHero(
      layout.heroImageUrl,
      heroSize.width,
      heroSize.height,
      false,
    );

    const qrPng = layout.dealUrl
      ? await QRCode.toBuffer(layout.dealUrl, {
          type: 'png',
          margin: 1,
          width: 200,
          color: { dark: '#1F1300', light: '#FFFFFF' },
        }).catch((err: unknown) => {
          this.logger.warn(
            `QR generation failed for ${layout.dealUrl}: ${
              err instanceof Error ? err.message : 'unknown error'
            }`,
          );
          return null;
        })
      : null;

    // Only fetched when it will actually be drawn — a merchant who leads
    // with Pairley branding shouldn't cost a logo round trip per render.
    const logo =
      layout.branding.logoProminence === 'prominent'
        ? await this.loadHero(layout.logoUrl, 148, 148, false)
        : null;

    const svg = this.buildCostSplitSvg(layout, palette, hero, qrPng, logo);

    const buffer = await sharp({
      create: {
        width: layout.width,
        height: layout.height,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .png()
      .toBuffer();

    return {
      buffer,
      width: layout.width,
      height: layout.height,
      usedHeroImage: Boolean(hero),
    };
  }

  private buildCostSplitSvg(
    layout: BannerLayout,
    palette: { from: string; to: string; icon: string },
    heroBuffer: Buffer | null,
    qrBuffer: Buffer | null,
    logoBuffer: Buffer | null,
  ): string {
    const { width: W, height: H } = layout;
    const brand = layout.branding;
    const MARGIN_F = 56;
    const leftX = MARGIN_F;
    const leftWidth = 520;
    const rightX = 624;
    const rightWidth = 520;

    // Dynamic width, same reasoning as the A-E badge: a fixed-width pill
    // clipped both edges of a long label like "GROUP DISCOUNT DEAL" (found
    // by rendering and looking). Right-aligned to the hero image's right
    // edge so it stays anchored in place regardless of label length.
    const offerBadgeText = `${layout.offerTypeLabel.toUpperCase()} DEAL`;
    const offerBadgeWidth = Math.max(160, offerBadgeText.length * 11 + 40);
    const offerTypeBadge = `<g transform="translate(${W - MARGIN_F - offerBadgeWidth}, 24)">
      <rect width="${offerBadgeWidth}" height="44" rx="22" ry="22" fill="${brand.primaryColor}"/>
      <text x="${offerBadgeWidth / 2}" y="29" font-size="17" font-weight="800" fill="${brand.onPrimaryColor}" text-anchor="middle" font-family="sans-serif">${offerBadgeText}</text>
    </g>`;

    const heroTop = 130;
    // Merchant branding gives the photo more of the canvas — the merchant's
    // own imagery is the point of Mode B. The partner card and everything
    // below it are positioned off heroHeight, so they follow automatically.
    const heroHeight = brand.heroEmphasis === 'elevated' ? 340 : 300;
    const heroImg = heroBuffer
      ? `<defs><clipPath id="heroClip"><rect x="${rightX}" y="${heroTop}" width="${rightWidth}" height="${heroHeight}" rx="20" ry="20"/></clipPath></defs>
         <image x="${rightX}" y="${heroTop}" width="${rightWidth}" height="${heroHeight}" href="data:image/png;base64,${heroBuffer.toString('base64')}" clip-path="url(#heroClip)"/>`
      : `<rect x="${rightX}" y="${heroTop}" width="${rightWidth}" height="${heroHeight}" rx="20" ry="20" fill="url(#gradF)"/>
         <text x="${rightX + rightWidth / 2}" y="${heroTop + heroHeight / 2}" font-size="72" text-anchor="middle" font-family="sans-serif">${palette.icon}</text>`;

    // The discount badge overlays the photo's bottom-left corner, matching
    // the reference's circular "SAVE X%" callout. Two lines only, not
    // three — a third line at this radius has no usable width near the
    // circle's edge and overflowed straight through the partner card
    // below it (found by rendering and looking, not by inspection).
    // Wording comes from buildDiscountBadgeText so the caption and the
    // figure cannot drift apart again — see the note there.
    const badgeText = buildDiscountBadgeText(layout.discountLabel);
    const discountBadge = badgeText
      ? `<g transform="translate(${rightX + 34}, ${heroTop + heroHeight - 46})">
           <circle r="60" fill="${brand.primaryColor}"/>
           <circle r="60" fill="none" stroke="#ffffff" stroke-width="3" stroke-dasharray="4 5"/>
           <text x="0" y="-8" font-size="13" font-weight="700" fill="${brand.onPrimaryColor}" text-anchor="middle" font-family="sans-serif">${escapeXml(badgeText.caption)}</text>
           <text x="0" y="20" font-size="28" font-weight="900" fill="${brand.onPrimaryColor}" text-anchor="middle" font-family="sans-serif">${escapeXml(badgeText.value)}</text>
         </g>`
      : '';

    // --- Offer Partner card ------------------------------------------
    const partnerTop = heroTop + heroHeight + 24;
    // Logo prominence: 'prominent' gives the merchant's mark a real slot in
    // the partner card and shifts the text across to make room; 'standard'
    // and 'none' leave the card text-led. `logoBuffer` is null unless the
    // logo both exists and was readable — a failed logo fetch quietly falls
    // back to the text-only card rather than leaving an empty box.
    const showLogo = brand.logoProminence === 'prominent' && logoBuffer;
    const partnerTextX = showLogo ? rightX + 108 : rightX + 20;
    const logoMark = showLogo
      ? `<defs><clipPath id="logoClip"><rect x="${rightX + 18}" y="${partnerTop + 22}" width="74" height="74" rx="12" ry="12"/></clipPath></defs>
         <image x="${rightX + 18}" y="${partnerTop + 22}" width="74" height="74" href="data:image/png;base64,${logoBuffer.toString('base64')}" clip-path="url(#logoClip)"/>`
      : '';

    const partnerCard = `<g>
      <rect x="${rightX}" y="${partnerTop}" width="${rightWidth}" height="118" rx="16" ry="16" fill="#FFFFFF" stroke="#E5E7EB" stroke-width="1.5"/>
      ${logoMark}
      <text x="${partnerTextX}" y="${partnerTop + 28}" font-size="12" font-weight="800" fill="#16A34A" font-family="sans-serif">OFFER PARTNER</text>
      <text x="${partnerTextX}" y="${partnerTop + 58}" font-size="26" font-weight="900" fill="${brand.textColor}" font-family="sans-serif">${layout.businessName}</text>
      <text x="${partnerTextX}" y="${partnerTop + 84}" font-size="16" fill="#64748B" font-family="sans-serif">📍 ${layout.location || 'Location on request'}</text>
      ${
        layout.businessRatingLabel
          ? `<text x="${partnerTextX}" y="${partnerTop + 106}" font-size="15" font-weight="700" fill="#F59E0B" font-family="sans-serif">⭐ ${layout.businessRatingLabel}</text>`
          : ''
      }
    </g>`;

    // --- Why Pairley bullet pills --------------------------------------
    const bulletsTop = partnerTop + 118 + 18;
    const bulletRows = Math.ceil(layout.whyBullets.length / 2);
    const bulletsBottom = bulletsTop + bulletRows * 40;
    const whyBullets = layout.whyBullets
      .map((bullet, i) => {
        const bx = rightX + (i % 2) * 268;
        const by = bulletsTop + Math.floor(i / 2) * 40;
        return `<g transform="translate(${bx}, ${by})">
          <rect width="256" height="32" rx="16" ry="16" fill="#F0FDF4"/>
          <text x="14" y="21" font-size="13" font-weight="700" fill="#15803D" font-family="sans-serif">✓ ${bullet}</text>
        </g>`;
      })
      .join('\n');

    // --- Left column: title, headline, cost-split box -------------------
    const titleTop = 190;
    const titleLines = wrapLines(layout.title, charsThatFit(leftWidth, 50), 2);
    const titleSvg = titleLines
      .map(
        (line, i) =>
          `<text x="${leftX}" y="${titleTop + i * 58}" font-size="50" font-weight="900" fill="#0F172A" font-family="sans-serif">${line}</text>`,
      )
      .join('\n');

    const headlineTop = titleTop + titleLines.length * 58 + 14;
    const headlineLines = wrapLines(
      layout.headline,
      charsThatFit(leftWidth, 24),
      2,
    );
    const headlineSvg = headlineLines
      .map(
        (line, i) =>
          `<text x="${leftX}" y="${headlineTop + i * 30}" font-size="24" font-weight="600" fill="${brand.textColor}" font-family="sans-serif">${line}</text>`,
      )
      .join('\n');

    const costBoxTop = headlineTop + headlineLines.length * 30 + 24;
    const costBoxHeight = 190;
    const costBox = layout.costSplit
      ? this.buildCostSplitBox(
          layout.costSplit,
          brand,
          leftX,
          costBoxTop,
          leftWidth,
          costBoxHeight,
        )
      : '';

    // --- 3-step unlock diagram, full width -------------------------------
    // Driven by whichever column actually runs lower — found by rendering
    // an offer with no cost-split box (left column short) and one with 4
    // Why-Pairley bullets (right column taller than assumed): a fixed
    // floor left dead space in the first case and let the bullets' second
    // row collide with the divider line in the second.
    const leftColumnBottom =
      costBoxTop + (layout.costSplit ? costBoxHeight : 0);
    // The CTA bar is pinned to the bottom, so the steps block has a hard
    // ceiling on where it can start. Merchant branding's taller hero pushed
    // everything down far enough that the step body text rendered *under*
    // the bar — found by rendering, not by any assertion. Clamped here, and
    // the body line count adapts to whatever room is genuinely left.
    const STEP_TITLE_TO_BODY = 44;
    const STEP_BODY_LINE_HEIGHT = 19;
    const ctaBarTop = H - 110;
    const stepsMaxTop =
      ctaBarTop - (STEP_TITLE_TO_BODY + STEP_BODY_LINE_HEIGHT + 14);
    const stepsTop = Math.min(
      Math.max(leftColumnBottom + 40, bulletsBottom + 26, 560),
      stepsMaxTop,
    );
    const stepBodyLines = Math.max(
      1,
      Math.min(
        2,
        Math.floor(
          (ctaBarTop - 12 - (stepsTop + STEP_TITLE_TO_BODY)) /
            STEP_BODY_LINE_HEIGHT,
        ),
      ),
    );
    // Never allowed above the bullets — when stepsTop is clamped tight, a
    // fixed `stepsTop - 24` drew the rule straight through them (found by
    // rendering). Sitting it below the bullets is a guarantee, not a
    // coincidence of the current spacing constants.
    const dividerY = Math.max(stepsTop - 24, bulletsBottom + 8);

    const stepColumnWidth = (W - MARGIN_F * 2) / 3;
    const stepsSvg = layout.unlockSteps
      .map((step, i) => {
        const cx = MARGIN_F + stepColumnWidth * i;
        const bodyLines = wrapLines(
          step.body,
          charsThatFit(stepColumnWidth - 70, 14),
          stepBodyLines,
        );
        const bodySvg = bodyLines
          .map(
            (line, li) =>
              `<text x="${cx + 58}" y="${stepsTop + STEP_TITLE_TO_BODY + li * STEP_BODY_LINE_HEIGHT}" font-size="14" fill="#475569" font-family="sans-serif">${line}</text>`,
          )
          .join('\n');
        return `<g>
          <circle cx="${cx + 22}" cy="${stepsTop + 8}" r="22" fill="${brand.primaryColor}"/>
          <text x="${cx + 22}" y="${stepsTop + 15}" font-size="20" font-weight="900" fill="${brand.onPrimaryColor}" text-anchor="middle" font-family="sans-serif">${i + 1}</text>
          <text x="${cx + 58}" y="${stepsTop + 15}" font-size="19" font-weight="800" fill="#0F172A" font-family="sans-serif">${escapeXml(step.title)}</text>
          ${bodySvg}
        </g>`;
      })
      .join('\n');

    // --- Bottom CTA bar ---------------------------------------------------
    const barTop = ctaBarTop;
    const qrBox = qrBuffer
      ? `<g>
           <rect x="${W - 172}" y="${barTop + 12}" width="86" height="86" rx="10" ry="10" fill="#ffffff"/>
           <image x="${W - 165}" y="${barTop + 19}" width="72" height="72" href="data:image/png;base64,${qrBuffer.toString('base64')}"/>
           <text x="${W - 129}" y="${barTop + 104}" font-size="10" font-weight="700" fill="#ffffff" text-anchor="middle" font-family="sans-serif">SCAN TO VIEW DEAL</text>
         </g>`
      : '';
    const ctaButtonRight = qrBuffer ? W - 210 : W - 64;

    return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="gradF" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${palette.from}"/>
      <stop offset="100%" stop-color="${palette.to}"/>
    </linearGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="#FFFFFF"/>

  <text x="${MARGIN_F}" y="52" font-size="34" font-weight="900" fill="${brand.textColor}" font-family="sans-serif">🛒 Pairley</text>
  <text x="${MARGIN_F}" y="76" font-size="13" font-weight="600" fill="#94A3B8" font-family="sans-serif">The More We Join. The More We Unlock.</text>

  ${offerTypeBadge}

  ${titleSvg}
  ${headlineSvg}
  ${costBox}

  ${heroImg}
  ${discountBadge}
  ${partnerCard}
  ${whyBullets}

  <line x1="${MARGIN_F}" y1="${dividerY}" x2="${W - MARGIN_F}" y2="${dividerY}" stroke="#E5E7EB" stroke-width="1.5"/>
  ${stepsSvg}

  <rect x="0" y="${barTop}" width="${W}" height="110" fill="${brand.primaryDarkColor}"/>
  <text x="${MARGIN_F}" y="${barTop + 42}" font-size="18" font-weight="900" fill="${brand.onPrimaryDarkColor}" font-family="sans-serif">THE MORE WE JOIN,</text>
  <text x="${MARGIN_F}" y="${barTop + 66}" font-size="18" font-weight="900" fill="${brand.onPrimaryDarkAccentColor}" font-family="sans-serif">THE MORE WE UNLOCK!</text>

  <g transform="translate(${ctaButtonRight - 260}, ${barTop + 28})">
    <rect width="260" height="54" rx="27" ry="27" fill="${brand.ctaBackground}"/>
    <text x="130" y="35" font-size="19" font-weight="900" fill="${brand.ctaTextColor}" text-anchor="middle" font-family="sans-serif">SHOW INTEREST NOW →</text>
  </g>

  ${qrBox}
</svg>`;
  }

  private buildCostSplitBox(
    split: NonNullable<BannerLayout['costSplit']>,
    brand: BannerLayout['branding'],
    x: number,
    y: number,
    width: number,
    height: number,
  ): string {
    const colWidth = width / 3;
    return `<g>
      <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="18" ry="18" fill="#F5F3FF" stroke="#E9D5FF" stroke-width="1.5"/>
      <text x="${x + 20}" y="${y + 30}" font-size="13" font-weight="800" fill="${brand.textColor}" font-family="sans-serif">HOW YOU SAVE</text>

      <text x="${x + 20}" y="${y + 64}" font-size="13" font-weight="700" fill="#94A3B8" font-family="sans-serif">Actual Price</text>
      <text x="${x + 20}" y="${y + 92}" font-size="26" font-weight="800" fill="#94A3B8" text-decoration="line-through" font-family="sans-serif">${split.actualPriceLabel}</text>

      <text x="${x + 20 + colWidth}" y="${y + 64}" font-size="13" font-weight="700" fill="${brand.textColor}" font-family="sans-serif">You Pay</text>
      <text x="${x + 20 + colWidth}" y="${y + 92}" font-size="26" font-weight="900" fill="${brand.textColor}" font-family="sans-serif">${split.yourShareLabel}</text>

      <text x="${x + 20 + colWidth * 2}" y="${y + 64}" font-size="13" font-weight="700" fill="#16A34A" font-family="sans-serif">You Save</text>
      <text x="${x + 20 + colWidth * 2}" y="${y + 92}" font-size="26" font-weight="900" fill="#16A34A" font-family="sans-serif">${split.yourSavingLabel}</text>

      <line x1="${x + 18}" y1="${y + 112}" x2="${x + width - 18}" y2="${y + 112}" stroke="#E9D5FF" stroke-width="1.5"/>

      <text x="${x + 20}" y="${y + 142}" font-size="14" font-weight="700" fill="#334155" font-family="sans-serif">${escapeXml(split.groupSavingLead)} <tspan fill="#94A3B8" font-weight="700">(${escapeXml(split.groupSavingWorking)})</tspan></text>
      <text x="${x + 20}" y="${y + 174}" font-size="30" font-weight="900" fill="#0F172A" font-family="sans-serif">${split.groupSavingLabel} <tspan font-size="16" fill="#16A34A">Together!</tspan></text>
    </g>`;
  }

  private buildSvg(
    layout: BannerLayout,
    palette: { from: string; to: string; icon: string },
    hasHero: boolean,
  ): string {
    const { width: W, height: H } = layout;
    const brand = layout.branding;
    const geometry = TEMPLATE_GEOMETRY[layout.templateId] ?? DEFAULT_GEOMETRY;

    // Under merchant branding the gradient plate becomes the merchant's own
    // colour rather than the category palette. The category tint is a
    // *categorisation* signal, which is exactly what a merchant leading with
    // their own identity is asking to replace; under Pairley branding it
    // stays untouched, so A-E look exactly as they did before.
    const plateFrom =
      brand.mode === 'MERCHANT' ? brand.primaryColor : palette.from;
    const plateTo =
      brand.mode === 'MERCHANT' ? brand.primaryDarkColor : palette.to;
    const textLeft = Math.round(W * geometry.textLeftRatio);
    const usableWidth = Math.round(W * geometry.textWidthRatio);

    // Over a photo the plate becomes a scrim so text stays readable; without
    // one it's the banner's whole visual identity.
    const plate = hasHero
      ? `<rect width="${W}" height="${H}" fill="url(#scrim)"/>`
      : `<rect width="${W}" height="${H}" fill="url(#grad)"/>
         <circle cx="${W * 0.82}" cy="${H * 0.18}" r="${W * 0.3}" fill="#ffffff" opacity="0.06"/>
         <circle cx="${W * 0.14}" cy="${H * 0.86}" r="${W * 0.24}" fill="#ffffff" opacity="0.05"/>`;

    // The discount chip is pinned top-right; the badge must stop short of
    // it rather than sliding underneath, which it did on the narrow-column
    // template where textLeft is past the canvas midpoint.
    const discountChipLeft = layout.discountLabel ? W - 260 : W - MARGIN;
    const badgeMaxWidth = Math.max(120, discountChipLeft - textLeft - 24);
    const badgeWidth = Math.min(
      badgeMaxWidth,
      Math.max(240, layout.badgeLabel ? layout.badgeLabel.length * 15 : 0),
    );
    const badgeChars = Math.max(6, Math.floor((badgeWidth - 52) / 14));
    const badgeText = layout.badgeLabel
      ? layout.badgeLabel.length > badgeChars
        ? `${layout.badgeLabel.slice(0, badgeChars - 1)}…`
        : layout.badgeLabel
      : '';

    const badge = layout.badgeLabel
      ? `<g transform="translate(${textLeft}, 64)">
           <rect rx="26" ry="26" width="${badgeWidth}" height="52" fill="#ffffff" opacity="0.16"/>
           <text x="26" y="34" font-size="24" font-weight="700" fill="#ffffff" font-family="sans-serif">${badgeText}</text>
         </g>`
      : '';

    const discount = layout.discountLabel
      ? `<g transform="translate(${W - 260}, 56)">
           <rect rx="20" ry="20" width="196" height="86" fill="#FACC15"/>
           <text x="98" y="58" font-size="40" font-weight="900" fill="#1F1300" text-anchor="middle" font-family="sans-serif">${layout.discountLabel}</text>
         </g>`
      : '';

    const original = layout.originalPriceLabel
      ? `<text x="${textLeft + this.textWidth(layout.offerPriceLabel, 76) + 28}" y="${H - PRICE_BASELINE_OFFSET - 6}" font-size="34" fill="#E5E7EB" opacity="0.75" font-family="sans-serif" text-decoration="line-through">${layout.originalPriceLabel}</text>`
      : '';

    const savings = layout.savingsLabel
      ? `<text x="${textLeft}" y="${H - 218}" font-size="30" font-weight="700" fill="#4ADE80" font-family="sans-serif">${layout.savingsLabel}</text>`
      : '';

    const group = layout.groupLabel
      ? `<g transform="translate(${textLeft}, ${H - 190})">
           <rect rx="18" ry="18" width="${Math.max(230, layout.groupLabel.length * 14)}" height="46" fill="#ffffff" opacity="0.14"/>
           <text x="22" y="31" font-size="24" font-weight="700" fill="#ffffff" font-family="sans-serif">👥 ${layout.groupLabel}</text>
         </g>`
      : '';

    const location = layout.location
      ? `<text x="${textLeft}" y="188" font-size="26" fill="#E5E7EB" opacity="0.85" font-family="sans-serif">📍 ${layout.location}</text>`
      : '';

    // Every text block is wrapped against the real available width rather
    // than a guessed character count — the first version overflowed the
    // canvas on long titles and on body copy, which was only visible by
    // rendering a banner and looking at it.

    const titleLines = wrapLines(
      layout.title,
      charsThatFit(usableWidth, TITLE_FONT),
      TITLE_MAX_LINES,
    );
    const titleTop = H * geometry.titleTopRatio;
    const titleSvg = titleLines
      .map(
        (line, i) =>
          `<text x="${textLeft}" y="${titleTop + i * (TITLE_FONT + 8)}" font-size="${TITLE_FONT}" font-weight="900" fill="#ffffff" font-family="sans-serif">${line}</text>`,
      )
      .join('\n  ');

    // Template B confines the photo to a left panel; the others run it
    // full-bleed behind the copy.
    const heroPanel =
      geometry.heroMode === 'left-panel' && hasHero
        ? `<rect x="${Math.round(W * 0.46)}" y="0" width="${Math.round(W * 0.54)}" height="${H}" fill="#0B0620" opacity="0.88"/>`
        : '';

    const accentRule = geometry.accent
      ? `<rect x="${textLeft}" y="${titleTop - TITLE_FONT - 28}" width="88" height="6" rx="3" fill="#FACC15"/>`
      : '';

    const headlineY = titleTop + titleLines.length * (TITLE_FONT + 8) + 20;
    // Wrapped for the same reason the title and body are: a narrow template
    // column (B is 44% of the canvas) cannot hold a headline sized for the
    // full width, and an unwrapped <text> silently runs off the edge.
    const headlineLines = wrapLines(
      layout.headline,
      charsThatFit(usableWidth, HEADLINE_FONT),
      HEADLINE_MAX_LINES,
    );
    const headlineSvg = headlineLines
      .map(
        (line, i) =>
          `<text x="${textLeft}" y="${headlineY + i * (HEADLINE_FONT + 6)}" font-size="${HEADLINE_FONT}" font-weight="700" fill="#FDE68A" font-family="sans-serif">${line}</text>`,
      )
      .join('\n  ');
    const bodyY = headlineY + headlineLines.length * (HEADLINE_FONT + 6) + 22;

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
          `<text x="${textLeft}" y="${bodyY + i * (BODY_FONT + 12)}" font-size="${BODY_FONT}" fill="#F3F4F6" opacity="0.92" font-family="sans-serif">${line}</text>`,
      )
      .join('\n  ');

    return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${plateFrom}"/>
      <stop offset="100%" stop-color="${plateTo}"/>
    </linearGradient>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0.55"/>
      <stop offset="55%" stop-color="#000000" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.88"/>
    </linearGradient>
  </defs>

  ${plate}
  ${heroPanel}
  ${accentRule}
  ${badge}
  ${discount}

  <text x="${MARGIN}" y="150" font-size="34" font-weight="800" fill="#ffffff" font-family="sans-serif">${palette.icon} ${layout.businessName}</text>
  ${location}

  ${titleSvg}
  ${headlineSvg}

  ${bodySvg}

  <text x="${textLeft}" y="${H - PRICE_BASELINE_OFFSET}" font-size="76" font-weight="900" fill="#ffffff" font-family="sans-serif">${layout.offerPriceLabel}</text>
  ${original}
  ${savings}
  ${group}

  <g transform="translate(${textLeft}, ${H - 120})">
    <rect rx="30" ry="30" width="330" height="72" fill="#ffffff"/>
    <text x="165" y="47" font-size="30" font-weight="900" fill="${brand.primaryDarkColor}" text-anchor="middle" font-family="sans-serif">${layout.ctaLabel}</text>
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
