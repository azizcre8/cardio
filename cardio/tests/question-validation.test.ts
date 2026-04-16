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

  it('accepts mostTemptingDistractor when only the answer label prefix differs', () => {
    const validation = buildDeterministicQuestionValidation(
      {
        pdf_id: 'pdf-1',
        concept_id: 'concept-1',
        user_id: 'user-1',
        level: 2,
        stem: 'Which mechanism best preserves blood pressure during acute blood loss?',
        options: [
          'Sympathetic Stimulation -> Increased cardiac output',
          'Sympathetic Stimulation -> Venous constriction',
          'Gravitational Pressure -> Redistribution of blood flow',
          'Sympathetic Inhibition -> Decreased heart rate',
        ],
        answer: 1,
        explanation: 'Sympathetic stimulation causes venous constriction, whereas increased cardiac output is secondary. Key distinction: venous constriction preserves venous return during acute blood loss.',
        source_quote: 'Critical for maintaining blood pressure during stress or blood loss; elicits nerve signals to constrict veins.',
        evidence_start: 0,
        evidence_end: 0,
        chunk_id: null,
        evidence_match_type: null,
        decision_target: 'mechanism',
        deciding_clue: 'venous constriction',
        most_tempting_distractor: 'C) Sympathetic Stimulation -> Increased cardiac output',
        why_tempting: 'increased cardiac output is another sympathetic response',
        why_fails: 'venous constriction is the more direct immediate pressure-preserving mechanism',
        option_set_flags: null,
        flagged: false,
        flag_reason: null,
      },
      'Sympathetic Stimulation',
      'Critical for maintaining blood pressure during stress or blood loss. The sympathetic nervous system elicits nerve signals to constrict veins.',
    );

    expect(validation.issues).not.toContain('Most tempting distractor must match one of the incorrect answer choices exactly.');
    expect(validation.evidenceOk).toBe(true);
  });

  it('marks deterministic validation failures as retriable during draft generation', () => {
    const result = validateQuestionDraft(
      {
        conceptId: 'concept-1',
        conceptName: 'Achalasia',
        level: 2,
        question: 'What mechanism best explains persistent dysphagia to solids and liquids in achalasia?',
        options: [
          'Loss of inhibitory myenteric neurons',
          'Fibrosis from chronic reflux',
          'Failure of salivary secretion',
          'External compression by aortic aneurysm',
        ],
        correctAnswer: 0,
        explanation: 'Loss of inhibitory myenteric neurons explains failed LES relaxation.',
        sourceQuote: 'Selective loss of inhibitory myenteric neurons causes aperistalsis and failure of LES relaxation in achalasia.',
        decisionTarget: 'mechanism',
        decidingClue: 'failed LES relaxation with aperistalsis',
        mostTemptingDistractor: 'Fibrosis from chronic reflux',
        whyTempting: 'both can cause dysphagia',
        whyFails: 'reflux fibrosis causes progressive solids-first dysphagia',
      },
      {
        conceptId: 'concept-1',
        conceptName: 'Achalasia',
        expectedLevel: 2,
        evidenceCorpus: 'Selective loss of inhibitory myenteric neurons causes aperistalsis and failure of LES relaxation in achalasia.',
      },
    );

    expect(result.ok).toBe(false);
    expect(result.shouldRetry).toBe(true);
    expect(result.issues).toContain('Explanation is missing the required "Key distinction" teaching sentence.');
  });

  it('rejects weakly grounded evidence when neither clue nor keyed answer is anchored', () => {
    const validation = buildDeterministicQuestionValidation(
      {
        pdf_id: 'pdf-1',
        concept_id: 'concept-1',
        user_id: 'user-1',
        level: 2,
        stem: 'Which blood pressure method best reduces observer bias?',
        options: [
          'Automated oscillometric method',
          'Direct needle puncture',
          'Venous pressure manometry',
          'Volume-pressure curve tracing',
        ],
        answer: 0,
        explanation: 'Automated oscillometric method because it reduces observer bias, whereas direct puncture is invasive. Key distinction: automation reduces observer bias.',
        source_quote: 'The sympathetic nervous system constricts veins during blood loss.',
        evidence_start: 0,
        evidence_end: 0,
        chunk_id: null,
        evidence_match_type: null,
        decision_target: 'comparison',
        deciding_clue: 'reduces observer bias',
        most_tempting_distractor: 'B) Direct needle puncture',
        why_tempting: 'both are medical measurement approaches',
        why_fails: 'direct puncture is invasive and not the routine noninvasive method',
        option_set_flags: null,
        flagged: false,
        flag_reason: null,
      },
      'Automated Oscillometric Method',
      'The sympathetic nervous system constricts veins during blood loss.',
    );

    expect(validation.issues).toContain('Deciding clue is not clearly supported by the quoted PDF evidence.');
  });

  it('does not require level 1 stems to literally include the concept name when the item is otherwise grounded', () => {
    const validation = buildDeterministicQuestionValidation(
      {
        pdf_id: 'pdf-1',
        concept_id: 'concept-1',
        user_id: 'user-1',
        level: 1,
        stem: 'The vascular property defined as the fractional increase in volume per mm Hg rise in pressure is which of the following?',
        options: [
          'Compliance',
          'Delayed compliance',
          'Distensibility',
          'Capacitance',
          'Pulse pressure',
        ],
        answer: 2,
        explanation: 'Distensibility is correct because it is the fractional increase in volume per mm Hg rise in pressure, whereas compliance refers to total stored volume per pressure rise. Key distinction: fractional change points to distensibility, not compliance.',
        source_quote: 'Vascular distensibility is expressed ordinarily as the fractional increase in volume for each millimeter of mercury rise in pressure.',
        evidence_start: 0,
        evidence_end: 0,
        chunk_id: null,
        evidence_match_type: null,
        decision_target: 'definition',
        deciding_clue: 'fractional increase in volume per mm Hg rise in pressure',
        most_tempting_distractor: 'Compliance',
        why_tempting: 'both are pressure-volume vessel properties',
        why_fails: 'compliance is total stored volume per pressure rise rather than fractional increase',
        option_set_flags: null,
        flagged: false,
        flag_reason: null,
      },
      'Vascular Distensibility',
      'Vascular distensibility is expressed ordinarily as the fractional increase in volume for each millimeter of mercury rise in pressure.',
    );

    expect(validation.issues).not.toContain('Level 1 stem may be under-specified relative to the intended concept and source material.');
    expect(validation.evidenceOk).toBe(true);
  });
});
