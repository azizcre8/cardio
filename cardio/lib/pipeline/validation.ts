/**
 * Evidence span validation.
 * Upgraded: 3-tier matching (exact → normalized → fuzzy).
 * Offsets are now optional/legacy — sourceQuote is the primary artifact.
 */

import { env } from '@/lib/env';

const ENABLE_FUZZY_EVIDENCE_MATCH = env.flags.fuzzyEvidenceMatch;

export interface EvidenceVerifyResult {
  ok: boolean;
  evidenceMatchType: 'exact' | 'normalized' | 'fuzzy' | 'none';
  evidenceMatchedText?: string;
  evidenceConfidence?: number;
  reason?: string;
}

const EVIDENCE_STOPWORDS = new Set([
  'which', 'their', 'there', 'these', 'those', 'because', 'during', 'through', 'between',
  'within', 'without', 'about', 'after', 'before', 'under', 'above', 'below', 'other',
  'into', 'from', 'that', 'this', 'with', 'have', 'been', 'they', 'them', 'than', 'then',
]);

/** Verifies that sourceQuote actually appears in chunkText.
 *  Returns matchType so callers can store it on the question. */
export function verifyEvidenceSpan(
  sourceQuote:   string,
  evidenceStart: number,
  evidenceEnd:   number,
  chunkText:     string,
): EvidenceVerifyResult {
  if (!sourceQuote || sourceQuote === 'UNGROUNDED' || sourceQuote.length < 15)
    return { ok: false, evidenceMatchType: 'none', reason: 'missing_or_too_short' };
  if (!chunkText)
    return { ok: false, evidenceMatchType: 'none', reason: 'no_chunk_text' };

  // 1. Exact match
  if (chunkText.includes(sourceQuote))
    return { ok: true, evidenceMatchType: 'exact', evidenceMatchedText: sourceQuote, evidenceConfidence: 1.0 };

  // 2. Normalized match (collapse whitespace, normalize quotes/dashes)
  const normQuote = normalizeStr(sourceQuote);
  const normChunk = normalizeStr(chunkText);
  if (normChunk.includes(normQuote))
    return { ok: true, evidenceMatchType: 'normalized', evidenceMatchedText: sourceQuote, evidenceConfidence: 0.9 };

  const clauseMatch = matchQuoteClauses(sourceQuote, normChunk);
  if (clauseMatch.ok) {
    return {
      ok: true,
      evidenceMatchType: 'normalized',
      evidenceMatchedText: clauseMatch.matchedText,
      evidenceConfidence: clauseMatch.confidence,
    };
  }

  // 3. Fuzzy match (word-bigram overlap)
  // Uses word-level bigram coverage rather than character-level subsequence matching.
  // Character-level matching produces false positives for medical text because
  // hallucinated quotes about the same topic share vocabulary (and therefore ~82%+
  // of their characters) with real passages even when the phrase was never in the PDF.
  if (ENABLE_FUZZY_EVIDENCE_MATCH && sourceQuote.length >= 20) {
    const result = fuzzyMatchQuote(normQuote, normChunk);
    if (result.ratio >= 0.60)
      return { ok: true, evidenceMatchType: 'fuzzy', evidenceMatchedText: result.matchedText, evidenceConfidence: result.ratio };
  }

  // 4. Legacy offset-based slice as last resort
  if (typeof evidenceStart === 'number' && typeof evidenceEnd === 'number' && evidenceEnd > evidenceStart) {
    const extracted = chunkText.slice(evidenceStart, evidenceEnd);
    if (extracted && normalizeStr(extracted) === normQuote)
      return { ok: true, evidenceMatchType: 'normalized', evidenceMatchedText: extracted, evidenceConfidence: 0.85 };
  }

  return { ok: false, evidenceMatchType: 'none', reason: 'not_found_in_chunk' };
}

function normalizeStr(s: string): string {
  return s
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2013\u2014\u2015]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?]+/g, m => m[0] ?? '')
    .toLowerCase()
    .trim();
}

function evidenceTokens(text: string): string[] {
  return normalizeStr(text)
    .split(' ')
    .filter(token => token.length >= 3 && !EVIDENCE_STOPWORDS.has(token));
}

export function hasEvidenceAnchorSupport(anchorText: string, evidenceText: string): boolean {
  const anchorTokens = new Set(evidenceTokens(anchorText));
  const evidenceTokenSet = new Set(evidenceTokens(evidenceText));
  if (!anchorTokens.size || !evidenceTokenSet.size) return false;

  let overlap = 0;
  for (const token of anchorTokens) {
    if (evidenceTokenSet.has(token)) overlap += 1;
  }

  return overlap >= 2 || overlap / anchorTokens.size >= 0.5;
}

// Tokenizes a normalized string into whole words (word-boundary aware, no subword matches).
function toWordTokens(text: string): string[] {
  return (text.match(/\b[a-z0-9'-]+\b/g) ?? []).filter(Boolean);
}

// Returns the set of content tokens (stopwords removed) for ratio weighting.
function contentTokens(tokens: string[]): string[] {
  return tokens.filter(t => t.length >= 3 && !EVIDENCE_STOPWORDS.has(t));
}

// Measures coverage of the quote's bigrams using a sliding window over the
// chunk's token array. Bigrams must appear contiguously in the source (not just
// anywhere in the chunk). Only content tokens count toward the ratio, so
// stopword-heavy generic phrases cannot inflate the score.
// Returns the best-matching source window as matchedText (not the quote).
function fuzzyMatchQuote(normQuote: string, normChunk: string): { ratio: number; matchedText: string } {
  const quoteTokens = toWordTokens(normQuote);
  const chunkTokens = toWordTokens(normChunk);

  if (quoteTokens.length < 4 || chunkTokens.length < quoteTokens.length) {
    return { ratio: 0, matchedText: '' };
  }

  // Build content bigrams from the quote (stopword-filtered).
  const contentQuoteTokens = contentTokens(quoteTokens);
  if (contentQuoteTokens.length < 2) return { ratio: 0, matchedText: '' };

  const quoteBigrams: Set<string> = new Set();
  for (let i = 0; i < contentQuoteTokens.length - 1; i += 1) {
    quoteBigrams.add(`${contentQuoteTokens[i]} ${contentQuoteTokens[i + 1]}`);
  }

  // Slide a window of quoteTokens.length over chunkTokens and score each position
  // by how many of the quote's content bigrams appear contiguously in that window.
  const winLen = quoteTokens.length;
  const step = Math.max(1, Math.floor(winLen * 0.25));
  let bestRatio = 0;
  let bestWindow = '';

  for (let start = 0; start <= chunkTokens.length - winLen; start += step) {
    const windowTokens = chunkTokens.slice(start, start + winLen);
    const contentWin = contentTokens(windowTokens);

    // Build bigrams within this window.
    let matches = 0;
    for (let i = 0; i < contentWin.length - 1; i += 1) {
      if (quoteBigrams.has(`${contentWin[i]} ${contentWin[i + 1]}`)) matches += 1;
    }

    const ratio = quoteBigrams.size > 0 ? matches / quoteBigrams.size : 0;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestWindow = windowTokens.join(' ');
    }
  }

  return { ratio: bestRatio, matchedText: bestRatio >= 0.60 ? bestWindow : '' };
}

function matchQuoteClauses(sourceQuote: string, normChunk: string): { ok: boolean; matchedText: string; confidence: number } {
  const rawClauses = sourceQuote
    .split(/[;•]/)
    .map(part => normalizeStr(part))
    .filter(part => part.length >= 12);

  if (rawClauses.length < 2) {
    return { ok: false, matchedText: '', confidence: 0 };
  }

  const matchedClauses = rawClauses.filter(clause => normChunk.includes(clause));
  const totalChars = rawClauses.reduce((sum, clause) => sum + clause.length, 0);
  const matchedChars = matchedClauses.reduce((sum, clause) => sum + clause.length, 0);
  const coverage = totalChars > 0 ? matchedChars / totalChars : 0;

  if (matchedClauses.length === rawClauses.length || coverage >= 0.85) {
    return {
      ok: true,
      matchedText: matchedClauses.join('; '),
      confidence: Math.max(0.84, Math.min(0.9, coverage)),
    };
  }

  return { ok: false, matchedText: '', confidence: 0 };
}

