import { BadRequestException, Injectable } from '@nestjs/common';
import {
  CANONICAL_CATEGORIES,
  CATEGORY_ALIASES,
  CanonicalCategory,
  UNCATEGORIZED_KEY,
} from './category-taxonomy';

// Resolves any inbound category string to a canonical taxonomy key.
//
// Every write path that persists a category must run it through here
// first. Before this existed, Offer.category accumulated a mix of
// canonical keys ('fitness'), display names ('Shopping') and an
// out-of-taxonomy literal ('General') — which meant any GROUP BY category
// silently split one market into several. The frontend masked this with a
// .toLowerCase() on read (DealsPage.jsx), so the data looked fine while
// every backend aggregate would have been wrong.
//
// Registered in the @Global() CommonModule, so it injects anywhere with
// no module wiring.
@Injectable()
export class CategoryService {
  private readonly byKey = new Map<string, CanonicalCategory>(
    CANONICAL_CATEGORIES.map((c) => [c.key, c]),
  );
  private readonly byDisplayName = new Map<string, CanonicalCategory>(
    CANONICAL_CATEGORIES.map((c) => [c.displayName.toLowerCase(), c]),
  );

  /** Every category, including non-selectable ones. */
  listAll(): readonly CanonicalCategory[] {
    return CANONICAL_CATEGORIES;
  }

  /** Categories a merchant or admin may actually pick. */
  listSelectable(): CanonicalCategory[] {
    return CANONICAL_CATEGORIES.filter((c) => c.selectable);
  }

  /** Categories eligible for Market Price Intelligence aggregation. */
  listAggregatable(): CanonicalCategory[] {
    return CANONICAL_CATEGORIES.filter((c) => c.aggregatable);
  }

  isValid(key: string): boolean {
    return this.byKey.has(key);
  }

  isAggregatable(key: string): boolean {
    return this.byKey.get(key)?.aggregatable ?? false;
  }

  displayNameFor(key: string): string | null {
    return this.byKey.get(key)?.displayName ?? null;
  }

  /**
   * Best-effort resolution to a canonical key. Returns null when the input
   * cannot be confidently mapped — callers decide whether that is a
   * validation error or a fall back to `general`.
   *
   * Resolution order, first match wins:
   *   1. exact canonical key            'fitness'
   *   2. case/space-insensitive key     'Fitness', ' FITNESS '
   *   3. display name                   'Fitness & Gym'
   *   4. explicit alias                 'gym'
   *   5. slugified form                 'Home Services' -> 'home-services'
   */
  normalize(raw: string | null | undefined): string | null {
    if (raw === null || raw === undefined) return null;

    const trimmed = raw.trim();
    if (trimmed === '') return null;

    if (this.byKey.has(trimmed)) return trimmed;

    const lower = trimmed.toLowerCase();
    if (this.byKey.has(lower)) return lower;

    const byName = this.byDisplayName.get(lower);
    if (byName) return byName.key;

    // Normalise separators before alias lookup so 'Fitness & Gym',
    // 'fitness and gym' and 'fitness  &  gym' all collapse to one form.
    const collapsed = lower.replace(/\s*&\s*/g, ' and ').replace(/\s+/g, ' ');
    if (CATEGORY_ALIASES[collapsed]) return CATEGORY_ALIASES[collapsed];
    if (CATEGORY_ALIASES[lower]) return CATEGORY_ALIASES[lower];

    const slug = lower
      .replace(/\s*&\s*/g, '-')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (this.byKey.has(slug)) return slug;
    if (CATEGORY_ALIASES[slug]) return CATEGORY_ALIASES[slug];

    return null;
  }

  /**
   * Write-path helper. Empty input becomes `general` (a legitimate
   * "not known yet" state for placeholder businesses and image-first
   * drafts). A non-empty value that cannot be resolved is a genuine
   * client error and is rejected rather than silently dumped into
   * `general`, which would quietly corrupt aggregation later.
   */
  normalizeForStorage(raw: string | null | undefined): string {
    if (raw === null || raw === undefined || raw.trim() === '') {
      return UNCATEGORIZED_KEY;
    }
    const key = this.normalize(raw);
    if (!key) {
      throw new BadRequestException(
        `Unknown category "${raw}". Valid categories: ${this.listSelectable()
          .map((c) => c.key)
          .join(', ')}`,
      );
    }
    return key;
  }
}
