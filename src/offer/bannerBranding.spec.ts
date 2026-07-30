import { BusinessStatus } from '@prisma/client';
import {
  resolveBranding,
  normalizeHexColor,
  darkenHex,
  readableTextOn,
  readableOnLight,
  relativeLuminance,
  PAIRLEY_BRAND,
} from './bannerBranding';

describe('bannerBranding (Module 14 Phase 3C — merchant branding preference)', () => {
  describe('normalizeHexColor', () => {
    it('accepts #RRGGBB and normalises case', () => {
      expect(normalizeHexColor('#ff6600')).toBe('#FF6600');
      expect(normalizeHexColor('  #A1B2C3  ')).toBe('#A1B2C3');
    });

    it('expands #RGB shorthand so downstream code sees one form only', () => {
      expect(normalizeHexColor('#f60')).toBe('#FF6600');
      expect(normalizeHexColor('#abc')).toBe('#AABBCC');
    });

    // This value reaches an SVG `fill` attribute. A colour has exactly one
    // legal shape, so anything else is rejected outright rather than
    // sanitised — the safest possible handling of merchant-supplied input.
    it('rejects anything that is not unambiguously a hex colour', () => {
      [
        'red',
        'rgb(255,0,0)',
        '#12345',
        '#1234567',
        'ff6600',
        '#gggggg',
        'red" onload="alert(1)',
        '#fff" /><script>alert(1)</script>',
        'url(#x)',
        '',
        '   ',
      ].forEach((value) => {
        expect(normalizeHexColor(value)).toBeNull();
      });
    });

    it('rejects non-string input', () => {
      [null, undefined, 42, {}, [], true].forEach((value) => {
        expect(normalizeHexColor(value)).toBeNull();
      });
    });
  });

  describe('darkenHex', () => {
    it('produces a darker shade of the same colour', () => {
      expect(darkenHex('#FF6600')).toBe('#A64200');
    });

    it('leaves black at black rather than going out of range', () => {
      expect(darkenHex('#000000')).toBe('#000000');
    });

    it('falls back to the Pairley dark for an invalid colour', () => {
      expect(darkenHex('not-a-colour')).toBe(PAIRLEY_BRAND.primaryDark);
    });
  });

  describe('readableTextOn', () => {
    // Getting this wrong makes the CTA — the single most important element
    // on the banner — unreadable.
    it('uses dark text on a light brand colour', () => {
      expect(readableTextOn('#FFFFFF')).toBe('#101010');
      expect(readableTextOn('#FDE68A')).toBe('#101010');
    });

    it('uses white text on a dark brand colour', () => {
      expect(readableTextOn('#000000')).toBe('#FFFFFF');
      expect(readableTextOn('#5B12D6')).toBe('#FFFFFF');
    });

    it('defaults to white for an invalid colour', () => {
      expect(readableTextOn('nonsense')).toBe('#FFFFFF');
    });
  });

  describe('readableOnLight', () => {
    // A colour that works as a solid fill can be illegible as text on a
    // white card — a pale brand yellow made the headline, the price figure
    // and the merchant name nearly invisible. Found by rendering.
    it('darkens a pale colour until it clears contrast against white', () => {
      const adjusted = readableOnLight('#FDE68A');
      expect(relativeLuminance(adjusted)).toBeLessThanOrEqual(0.18);
    });

    it('leaves an already-dark colour usable', () => {
      expect(relativeLuminance(readableOnLight('#5B12D6'))).toBeLessThanOrEqual(
        0.18,
      );
    });

    it('always returns a valid hex, including for junk input', () => {
      ['#FFFFFF', '#000000', 'nonsense', ''].forEach((value) => {
        expect(readableOnLight(value)).toMatch(/^#[0-9A-F]{6}$/);
      });
    });

    it('terminates on pure white rather than looping', () => {
      expect(relativeLuminance(readableOnLight('#FFFFFF'))).toBeLessThanOrEqual(
        0.18,
      );
    });
  });

  describe('resolveBranding', () => {
    const claimedMerchant = {
      requestedMode: 'MERCHANT',
      businessStatus: BusinessStatus.CLAIMED,
      brandColor: '#FF6600',
      hasLogo: true,
    };

    it('defaults to Pairley branding when nothing is requested', () => {
      const branding = resolveBranding({
        businessStatus: BusinessStatus.CLAIMED,
      });
      expect(branding.mode).toBe('PAIRLEY');
      expect(branding.primaryColor).toBe(PAIRLEY_BRAND.primary);
      expect(branding.downgradeReason).toBeNull();
    });

    it('applies merchant branding for a claimed business with a valid colour', () => {
      const branding = resolveBranding(claimedMerchant);
      expect(branding.mode).toBe('MERCHANT');
      expect(branding.primaryColor).toBe('#FF6600');
      expect(branding.ctaBackground).toBe('#FF6600');
      expect(branding.heroEmphasis).toBe('elevated');
      expect(branding.logoProminence).toBe('prominent');
      expect(branding.downgradeReason).toBeNull();
    });

    // The same principle that already withholds an unclaimed merchant's
    // logo: they never asked to be branded on Pairley.
    it('refuses merchant branding for an unclaimed business, with a stated reason', () => {
      const branding = resolveBranding({
        ...claimedMerchant,
        businessStatus: BusinessStatus.UNCLAIMED,
      });
      expect(branding.mode).toBe('PAIRLEY');
      expect(branding.downgradeReason).toMatch(/claims its Pairley listing/i);
      expect(branding.logoProminence).toBe('none');
    });

    it('refuses merchant branding with no usable brand colour, rather than half-applying it', () => {
      const branding = resolveBranding({
        ...claimedMerchant,
        brandColor: null,
      });
      expect(branding.mode).toBe('PAIRLEY');
      expect(branding.downgradeReason).toMatch(/brand colour/i);
    });

    it('refuses merchant branding when the colour is invalid, not just missing', () => {
      const branding = resolveBranding({
        ...claimedMerchant,
        brandColor: 'red" onload="alert(1)',
      });
      expect(branding.mode).toBe('PAIRLEY');
      expect(branding.primaryColor).toBe(PAIRLEY_BRAND.primary);
    });

    it('shows a claimed merchant’s logo at standard prominence under Pairley branding', () => {
      const branding = resolveBranding({
        businessStatus: BusinessStatus.CLAIMED,
        hasLogo: true,
      });
      expect(branding.logoProminence).toBe('standard');
    });

    it('never shows an unclaimed business’s logo, in either mode', () => {
      ['PAIRLEY', 'MERCHANT'].forEach((requestedMode) => {
        const branding = resolveBranding({
          requestedMode,
          businessStatus: BusinessStatus.UNCLAIMED,
          brandColor: '#FF6600',
          hasLogo: true,
        });
        expect(branding.logoProminence).toBe('none');
      });
    });

    it('falls back to standard logo prominence when a merchant has no logo', () => {
      const branding = resolveBranding({ ...claimedMerchant, hasLogo: false });
      expect(branding.mode).toBe('MERCHANT');
      expect(branding.logoProminence).toBe('standard');
    });

    it('always returns validated hex colours, whatever the input', () => {
      const HEX = /^#[0-9A-F]{6}$/;
      [
        {},
        {
          requestedMode: 'MERCHANT',
          businessStatus: BusinessStatus.CLAIMED,
          brandColor: 'junk',
        },
        {
          requestedMode: 'NOT_A_MODE',
          businessStatus: null,
          brandColor: undefined,
        },
      ].forEach((input) => {
        const branding = resolveBranding(input);
        [
          branding.primaryColor,
          branding.primaryDarkColor,
          branding.accentColor,
          branding.ctaBackground,
          branding.ctaTextColor,
          branding.textColor,
          branding.onPrimaryColor,
          branding.onPrimaryDarkColor,
          branding.onPrimaryDarkAccentColor,
        ].forEach((colour) => expect(colour).toMatch(HEX));
      });
    });
  });
});
