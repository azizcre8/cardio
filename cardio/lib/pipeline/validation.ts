/**
 * Evidence span validation.
 * Upgraded: 3-tier matching (exact → normalized → fuzzy).
 * Offsets are now optional/legacy — sourceQuote is the primary artifact.
 */

const ENABLE_FUZZY_EVIDENCE_MATCH = process.env.ENABLE_FUZZY_EVIDENCE_MATCH !== 'false';

export interface EvidenceVerifyResult {
  ok: boolean;
  evidenceMatchType: 'exact' | 'normalized' | 'fuzzy' | 'none';
  evidenceMatchedText?: string;
  evidenceConfidence?: number;
  reason?: string;
}

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

  // 3. Fuzzy match (sliding window)
  if (ENABLE_FUZZY_EVIDENCE_MATCH && sourceQuote.length >= 30) {
    const result = fuzzyMatchQuote(normQuote, normChunk);
    if (result.ratio >= 0.82)
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

function fuzzyMatchQuote(normQuote: string, normChunk: string): { ratio: number; matchedText: string } {
  const qLen = normQuote.length;
  if (qLen < 20 || normChunk.length < qLen) return { ratio: 0, matchedText: '' };
  const step = Math.max(1, Math.floor(qLen * 0.15));
  let best = 0, bestText = '';
  for (let i = 0; i <= normChunk.length - qLen; i += step) {
    const window = normChunk.slice(i, i + qLen + Math.floor(qLen * 0.1));
    const r = charOverlapRatio(normQuote, window);
    if (r > best) { best = r; bestText = window; }
  }
  return { ratio: best, matchedText: bestText };
}

function charOverlapRatio(a: string, b: string): number {
  const shorter = a.length <= b.length ? a : b;
  const longer  = a.length <= b.length ? b : a;
  let matches = 0;
  let pos = 0;
  for (const ch of shorter) {
    const idx = longer.indexOf(ch, pos);
    if (idx !== -1) { matches++; pos = idx + 1; }
  }
  return matches / shorter.length;
}
