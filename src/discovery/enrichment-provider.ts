import { OfferType } from '@prisma/client';

// Per-field explainability (Decision 6) — every suggestion carries what was
// suggested, what it's replacing, how confident the provider is, and why.
// Persisted verbatim into Offer.enrichment_metadata so the audit trail
// survives even if the underlying offer/business data later changes.
export interface EnrichmentSuggestion<T> {
  suggested: T;
  original: T | null;
  confidence: number; // 0-1
  rationale: string;
}

export interface EnrichmentInput {
  title: string;
  description: string;
  currentCategory: string;
  currentOfferType: OfferType;
}

// Matches the "EnrichmentResult v1" contract from the STEP 1 architecture
// review — keeping this shape stable across provider swaps is the whole
// point of the abstraction below.
export interface EnrichmentResult {
  category: EnrichmentSuggestion<string>;
  offerType: EnrichmentSuggestion<OfferType>;
  merchantType: EnrichmentSuggestion<string>;
  tags: EnrichmentSuggestion<string[]>;
  keywords: EnrichmentSuggestion<string[]>;
}

// Provider-agnostic contract (Decision 1 — staged approach). Today's only
// implementation is RuleBasedEnrichmentProvider (deterministic, no AI/LLM —
// Phase 3 scope). A future real-LLM provider (OpenAI, per your stated
// preference for Phase "2" of the enrichment staging) plugs in behind this
// exact same interface — EnrichmentService and everything upstream of it
// never changes, only discovery.module.ts's provider binding does.
export abstract class EnrichmentProvider {
  abstract enrich(input: EnrichmentInput): Promise<EnrichmentResult>;
}
