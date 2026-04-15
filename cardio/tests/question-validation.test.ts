import { describe, expect, it } from 'vitest';
import { buildDeterministicQuestionValidation, validateQuestionDraft } from '@/lib/pipeline/question-validation';

describe('question validation', () => {
  it('rejects level 1 drafts with 4 options and missing conceptId', () => {
    const result = validateQuestionDraft(
      {
        conceptName: 'Myenteric Plexus',
        level: 1,
        question: 'Which finding best matches the myenteric plexus?',
        options: ['Controls peristalsis', 'Controls secretion', 'Forms villi', 'Produces intrinsic factor'],
        correctAnswer: 0,
        explanation: 'Controls peristalsis because it coordinates gut motility. Key distinction: motility not secretion.',
        sourceQuote: 'The myenteric plexus lies between muscle layers and regulates motility.',
        decisionTarget: 'distinguishing feature',
        decidingClue: 'regulates motility',
        mostTemptingDistractor: 'Controls secretion',
        whyTempting: 'both are enteric plexus functions',
        whyFails: 'secretion is the Meissner plexus role',
      },
      {
        conceptId: 'concept-1',
        conceptName: 'Myenteric Plexus',
        expectedLevel: 1,
        evidenceCorpus: 'The myenteric plexus lies between muscle layers and regulates motility.',
      },
    );

    expect(result.ok).toBe(false);
    expect(result.shouldRetry).toBe(true);
    expect(result.issues).toContain('Draft is missing conceptId for the requested generation slot.');
    expect(result.issues).toContain('Level 1 questions must have exactly 5 answer choices.');
  });

  it('requires mostTemptingDistractor to match a real wrong option', () => {
    const validation = buildDeterministicQuestionValidation(
      {
        pdf_id: 'pdf-1',
        concept_id: 'concept-1',
        user_id: 'user-1',
        level: 2,
        stem: 'Why does achalasia cause dysphagia to both solids and liquids from the onset?',
        options: [
          'Loss of inhibitory myenteric neurons abolishes LES relaxation',
          'Fibrosis of the lower esophagus prevents food passage',
          'Excess acetylcholine triggers immediate mast-cell release',
          'Autoimmune destruction of salivary glands impairs bolus formation',
        ],
        answer: 0,
        explanation: 'Loss of inhibitory myenteric neurons causes impaired LES relaxation, whereas fibrosis causes progressive solids-first dysphagia. Key distinction: aperistalsis with equal solids/liquids points to inhibitory neuron loss.',
        source_quote: 'Selective loss of inhibitory myenteric neurons causes aperistalsis and failure of LES relaxation in achalasia.',
        evidence_start: 0,
        evidence_end: 0,
        chunk_id: null,
        evidence_match_type: null,
        decision_target: 'mechanism',
        deciding_clue: 'aperistalsis with equal solids and liquids',
        most_tempting_distractor: 'Diffuse esophageal spasm',
        why_tempting: 'both are motility disorders',
        why_fails: 'spasm is intermittent and does not cause persistent failure of LES relaxation',
        option_set_flags: null,
        flagged: false,
        flag_reason: null,
      },
      'Achalasia',
      'Selective loss of inhibitory myenteric neurons causes aperistalsis and failure of LES relaxation in achalasia.',
    );

    expect(validation.issues).toContain('Most tempting distractor must match one of the incorrect answer choices exactly.');
    expect(validation.evidenceOk).toBe(true);
  });
});
