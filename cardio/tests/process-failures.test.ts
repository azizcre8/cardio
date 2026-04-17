import { describe, expect, it } from 'vitest';
import { isOpenAIAuthError, summarizePipelineFailure } from '@/lib/pipeline/process-helpers';
import { runAuditAgent } from '@/lib/pipeline/audit';

describe('pipeline failure summaries', () => {
  it('detects invalid openai api key errors', () => {
    expect(isOpenAIAuthError(new Error('401 Incorrect API key provided: sk-xxxx'))).toBe(true);
    expect(isOpenAIAuthError(new Error('network timeout'))).toBe(false);
  });

  it('turns auth failures into a user-facing pipeline error', () => {
    expect(
      summarizePipelineFailure([
        '401 Incorrect API key provided: sk-xxxx',
      ]),
    ).toContain('OpenAI authentication failed');
  });

  it('fails closed when the model auditor call cannot complete', async () => {
    const verdicts = await runAuditAgent(
      [{
        pdf_id: 'pdf-1',
        concept_id: 'concept-1',
        user_id: 'user-1',
        level: 2,
        stem: 'Which mechanism best explains acute plaque rupture?',
        options: ['Lipid accumulation', 'Matrix degradation', 'Fibrous cap thickening', 'Adaptive vasodilation'],
        answer: 1,
        explanation: 'Matrix degradation weakens plaque stability, whereas fibrous cap thickening stabilizes plaques. Key distinction: extracellular matrix breakdown destabilizes plaques.',
        option_explanations: null,
        source_quote: 'Collagen turnover is controlled by metalloproteinases within the atheromatous plaque.',
        evidence_start: 0,
        evidence_end: 0,
        chunk_id: null,
        evidence_match_type: null,
        decision_target: 'mechanism',
        deciding_clue: 'extracellular matrix breakdown',
        most_tempting_distractor: 'Fibrous cap thickening',
        why_tempting: 'both involve plaque structure',
        why_fails: 'fibrous cap thickening stabilizes rather than destabilizes plaques',
        option_set_flags: null,
        flagged: false,
        flag_reason: null,
      }],
      [{ evidenceOk: true, optionFlags: [] }],
    );

    expect(verdicts[0]?.status).not.toBe('PASS');
  });
});
