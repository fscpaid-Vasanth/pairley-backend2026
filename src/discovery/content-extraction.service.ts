import { Injectable } from '@nestjs/common';

export interface ExtractedFields {
  title: string | null;
  description: string | null;
  image: string | null;
  price: number | null;
  // Module 11 — the underlying text extraction ran against (visible HTML
  // text, or raw OCR/PDF text), preserved so NormalizationService can do
  // pattern-matching (discount phrasing, offer-type keywords, validity
  // dates) that the original title/description/price extraction didn't
  // attempt. Optional so any existing object literal built without it
  // (tests, older call sites) still satisfies this interface unchanged.
  rawText?: string;
}

// Deterministic, rule-based extraction only — no LLM/AI inference in Module
// 9 (explicit decision). Operates on raw HTML via a handful of targeted
// regexes rather than a general HTML parser; deliberately simple so it stays
// predictable and unit-testable. A real parser/LLM standardization step can
// replace this internals-only without changing the ExtractedFields shape
// consumers (ConfidenceScoringService, the future review queue) depend on.
@Injectable()
export class ContentExtractionService {
  extract(html: string): ExtractedFields {
    return {
      title: this.decodeEntities(
        this.firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
      ),
      description:
        this.decodeEntities(this.metaContent(html, 'description')) ??
        this.decodeEntities(this.metaContent(html, 'og:description')),
      image: this.metaContent(html, 'og:image'),
      price: this.extractPrice(html),
      rawText: this.visibleText(html),
    };
  }

  private visibleText(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private firstMatch(html: string, pattern: RegExp): string | null {
    const match = html.match(pattern);
    return match ? match[1].trim() : null;
  }

  private metaContent(html: string, name: string): string | null {
    // Handles both attribute orderings (name/content vs content/name), both
    // seen in the wild across real merchant sites.
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(
        `<meta[^>]+(?:name|property)=["']${escapedName}["'][^>]+content=["']([^"']*)["']`,
        'i',
      ),
      new RegExp(
        `<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${escapedName}["']`,
        'i',
      ),
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) return match[1].trim();
    }
    return null;
  }

  private extractPrice(html: string): number | null {
    const match = this.visibleText(html).match(
      /(?:₹|Rs\.?|INR)\s?([\d,]+(?:\.\d{1,2})?)/i,
    );
    if (!match) return null;
    const numeric = Number(match[1].replace(/,/g, ''));
    return Number.isFinite(numeric) ? numeric : null;
  }

  private decodeEntities(value: string | null): string | null {
    if (!value) return null;
    const decoded = value
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
    return decoded || null;
  }
}
