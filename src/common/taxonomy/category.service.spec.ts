import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { CategoryService } from './category.service';
import { CANONICAL_CATEGORIES, UNCATEGORIZED_KEY } from './category-taxonomy';

describe('CategoryService', () => {
  let service: CategoryService;

  beforeEach(() => {
    service = new CategoryService();
  });

  describe('normalize', () => {
    it('passes through an already-canonical key unchanged', () => {
      expect(service.normalize('fitness')).toBe('fitness');
      expect(service.normalize('home-services')).toBe('home-services');
    });

    it('fixes the casing drift actually found in production', () => {
      // The single ACTIVE offer was stored as 'Shopping'; one business too.
      expect(service.normalize('Shopping')).toBe('shopping');
    });

    it('resolves display names to their key', () => {
      expect(service.normalize('Fitness & Gym')).toBe('fitness');
      expect(service.normalize('Dining & Food')).toBe('dining');
      expect(service.normalize('Co-Working & Stays')).toBe('coworking');
      expect(service.normalize('Events & Entertainment')).toBe('entertainment');
    });

    it('tolerates surrounding whitespace and mixed case', () => {
      expect(service.normalize('  FITNESS  ')).toBe('fitness');
      expect(service.normalize(' Tour Packages ')).toBe('tours');
    });

    it('treats "and" and "&" as equivalent', () => {
      expect(service.normalize('fitness and gym')).toBe('fitness');
      expect(service.normalize('Beauty & Spa')).toBe('beauty');
      expect(service.normalize('beauty and spa')).toBe('beauty');
    });

    it('resolves colloquial aliases merchants actually type', () => {
      expect(service.normalize('gym')).toBe('fitness');
      expect(service.normalize('Restaurant')).toBe('dining');
      expect(service.normalize('travel')).toBe('tours');
      expect(service.normalize('salon')).toBe('beauty');
    });

    // The AI Offer Collector's source-site category text arrives as
    // slash-joined human labels ("Restaurants/Buffets", "Spa/Salon"), not
    // Pairley's own taxonomy — these two were the actual "Unknown
    // category" values logged in production on 2026-08-12, blocking 8 of
    // 11 offers in one Publish Selected run.
    it('resolves the AI Offer Collector\'s slash-joined category labels', () => {
      expect(service.normalize('Restaurants/Buffets')).toBe('dining');
      expect(service.normalize('Spa/Salon')).toBe('beauty');
      expect(service.normalize('Fitness/Gym')).toBe('fitness');
      expect(service.normalize('Shopping/Retail')).toBe('shopping');
      expect(service.normalize('Travel/Tours')).toBe('tours');
      expect(service.normalize('Education/Training')).toBe('education');
    });

    it('resolves the standalone forms making up the slash-joined labels above', () => {
      expect(service.normalize('Buffet')).toBe('dining');
      expect(service.normalize('Cafe')).toBe('dining');
    });

    // The remaining categories from the same mapping request already
    // resolved before this fix, via the generic key/display-name matching
    // above rather than a literal alias — asserted here so the full
    // mapping table has one test each, not just the ones that needed a
    // code change.
    it('already resolved the rest of the requested mapping table via existing generic matching', () => {
      expect(service.normalize('Entertainment')).toBe('entertainment');
      expect(service.normalize('Subscription')).toBe('subscriptions');
      expect(service.normalize('Adventure')).toBe('adventure');
      expect(service.normalize('Home Services')).toBe('home-services');
      expect(service.normalize('Healthcare')).toBe('healthcare');
      expect(service.normalize('Coworking')).toBe('coworking');
    });

    it('slugifies multi-word names into their hyphenated key', () => {
      expect(service.normalize('Home Services')).toBe('home-services');
    });

    it('maps the out-of-taxonomy "General" literal onto uncategorized', () => {
      // auth.service.ts defaulted 8 live businesses to this value.
      expect(service.normalize('General')).toBe(UNCATEGORIZED_KEY);
    });

    it('returns null rather than guessing at an unknown value', () => {
      expect(service.normalize('quantum-widgets')).toBeNull();
      expect(service.normalize('asdfgh')).toBeNull();
    });

    it('returns null for empty and nullish input', () => {
      expect(service.normalize('')).toBeNull();
      expect(service.normalize('   ')).toBeNull();
      expect(service.normalize(null)).toBeNull();
      expect(service.normalize(undefined)).toBeNull();
    });
  });

  describe('normalizeForStorage', () => {
    it('falls back to uncategorized for empty input — a legitimate state', () => {
      expect(service.normalizeForStorage('')).toBe(UNCATEGORIZED_KEY);
      expect(service.normalizeForStorage(null)).toBe(UNCATEGORIZED_KEY);
      expect(service.normalizeForStorage(undefined)).toBe(UNCATEGORIZED_KEY);
    });

    it('rejects an unrecognised non-empty value instead of silently storing it', () => {
      // Quietly dumping this into `general` would corrupt aggregation
      // later with no signal that anything went wrong.
      expect(() => service.normalizeForStorage('quantum-widgets')).toThrow(
        BadRequestException,
      );
    });

    it('names the valid categories in the rejection message', () => {
      try {
        service.normalizeForStorage('quantum-widgets');
        fail('should have thrown');
      } catch (e) {
        expect((e as BadRequestException).message).toContain('fitness');
        expect((e as BadRequestException).message).toContain('quantum-widgets');
      }
    });

    it('normalises rather than rejecting a recoverable value', () => {
      expect(service.normalizeForStorage('Shopping')).toBe('shopping');
    });
  });

  describe('aggregation eligibility', () => {
    it('excludes uncategorized from Market Price Intelligence', () => {
      // Averaging prices across "everything we could not classify" would
      // produce a meaningless market rate.
      expect(service.isAggregatable(UNCATEGORIZED_KEY)).toBe(false);
      expect(service.listAggregatable().map((c) => c.key)).not.toContain(
        UNCATEGORIZED_KEY,
      );
    });

    it('includes every real category', () => {
      expect(service.isAggregatable('fitness')).toBe(true);
      expect(service.listAggregatable()).toHaveLength(
        CANONICAL_CATEGORIES.length - 1,
      );
    });

    it('reports an unknown key as not aggregatable rather than throwing', () => {
      expect(service.isAggregatable('nope')).toBe(false);
    });
  });

  describe('taxonomy integrity', () => {
    it('has no duplicate keys', () => {
      const keys = CANONICAL_CATEGORIES.map((c) => c.key);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('keeps every key URL-safe, since keys appear in query strings', () => {
      for (const c of CANONICAL_CATEGORIES) {
        expect(c.key).toMatch(/^[a-z0-9-]+$/);
      }
    });

    it('excludes uncategorized from pickers but keeps it storable', () => {
      expect(service.listSelectable().map((c) => c.key)).not.toContain(
        UNCATEGORIZED_KEY,
      );
      expect(service.isValid(UNCATEGORIZED_KEY)).toBe(true);
    });
  });

  // The frontend owns presentation (icon/colour/gradient) keyed by the
  // same strings this service validates. Nothing at runtime couples them,
  // so this test is the coupling: if either list gains or renames a
  // category without the other, it fails here rather than silently
  // producing offers the UI cannot render an icon for.
  describe('frontend taxonomy parity', () => {
    const frontendCategoriesPath = path.resolve(
      __dirname,
      '../../../../../Pairley Web and Mobile App/src/data/categories.js',
    );

    const readFrontendKeys = (): string[] | null => {
      if (!fs.existsSync(frontendCategoriesPath)) return null;
      const src = fs.readFileSync(frontendCategoriesPath, 'utf-8');
      return [...src.matchAll(/^\s*id:\s*'([^']+)'/gm)].map((m) => m[1]);
    };

    it('covers every category the frontend can render', () => {
      const frontendKeys = readFrontendKeys();
      if (!frontendKeys) {
        // The frontend repo is a sibling checkout, not a dependency —
        // skip rather than fail when only the backend is checked out.
        console.warn('Frontend categories.js not found — parity check skipped');
        return;
      }
      const backendKeys = CANONICAL_CATEGORIES.map((c) => c.key);
      const missing = frontendKeys.filter((k) => !backendKeys.includes(k));
      expect(missing).toEqual([]);
    });

    it('adds nothing selectable the frontend cannot render', () => {
      const frontendKeys = readFrontendKeys();
      if (!frontendKeys) return;
      const orphans = CANONICAL_CATEGORIES.filter(
        (c) => c.selectable && !frontendKeys.includes(c.key),
      ).map((c) => c.key);
      expect(orphans).toEqual([]);
    });
  });
});
