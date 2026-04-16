import { describe, expect, it } from 'vitest';
import { alignSourceQuoteToEvidence } from '@/lib/pipeline/generation';

describe('alignSourceQuoteToEvidence', () => {
  it('replaces a paraphrased sourceQuote with the closest evidence sentence', () => {
    const raw = {
      sourceQuote: 'Critical for maintaining blood pressure during stress or blood loss; elicits nerve signals to constrict veins.',
    };
    const evidence = [
      'The sympathetic nervous system is critical for maintaining blood pressure during stress or blood loss.',
      'It elicits nerve signals to constrict veins and shift blood toward the heart.',
    ].join(' ');

    const aligned = alignSourceQuoteToEvidence(raw, evidence);

    expect(aligned.sourceQuote).toBe('The sympathetic nervous system is critical for maintaining blood pressure during stress or blood loss.');
  });
});
