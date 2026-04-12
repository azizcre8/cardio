/**
 * Evidence span validation — verbatim port from medical-study-app-v2.html.
 */

export interface EvidenceVerifyResult {
  ok: boolean;
  reason?: string;
  offsetCorrected?: boolean;
}

/** Verifies that sourceQuote actually appears in chunkText. */
export function verifyEvidenceSpan(
  sourceQuote:  string,
  evidenceStart: number,
  evidenceEnd:   number,
  chunkText:    string,
): EvidenceVerifyResult {
  if (!sourceQuote || sourceQuote === 'UNGROUNDED' || sourceQuote.length < 15)
    return { ok: false, reason: 'missing_or_too_short' };
  if (!chunkText)
    return { ok: false, reason: 'no_chunk_text' };

  const extracted = chunkText.slice(evidenceStart, evidenceEnd);
  if (extracted === sourceQuote) return { ok: true };

  // Fallback: quote appears somewhere in chunk even if offsets are wrong
  if (chunkText.includes(sourceQuote.trim())) return { ok: true, offsetCorrected: true };

  return { ok: false, reason: 'not_found_in_chunk' };
}
