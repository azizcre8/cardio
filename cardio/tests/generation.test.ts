import { describe, expect, it } from 'vitest';
import { alignSourceQuoteToEvidence, buildPressureVolumePropertyDraft, inferEvidenceProvenance, repairDraftForValidation } from '@/lib/pipeline/generation';

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

  it('leaves explanation text unchanged when metadata is present', () => {
    const repaired = repairDraftForValidation(
      {
        explanation: 'Venous constriction preserves venous return during hemorrhage.',
        options: [
          'Increased arterial compliance',
          'Venous constriction',
          'Reduced skeletal muscle tone',
          'Lower heart rate',
        ],
        correctAnswer: 1,
        decidingClue: 'venous constriction preserves venous return',
        mostTemptingDistractor: 'Increased arterial compliance',
        whyTempting: 'both affect hemodynamics',
        whyFails: 'arterial compliance does not directly preserve venous return during blood loss',
      },
      '',
    );

    expect(String(repaired.explanation)).toBe('Venous constriction preserves venous return during hemorrhage.');
  });

  it('maps a paraphrased mostTemptingDistractor onto the closest real wrong option', () => {
    const repaired = repairDraftForValidation(
      {
        options: [
          'Compliance',
          'Distensibility',
          'Resistance',
          'Vascular tone',
          'Pulse pressure',
        ],
        correctAnswer: 1,
        mostTemptingDistractor: 'Vascular compliance',
      },
      '',
    );

    expect(repaired.mostTemptingDistractor).toBe('Compliance');
  });

  it('builds a deterministic distensibility draft with named concept options', () => {
    const draft = buildPressureVolumePropertyDraft(
      {
        conceptId: 'concept-1',
        conceptName: 'Vascular Distensibility',
        category: 'Physiological Concept',
        importance: 'high',
        level: 1,
        coverageDomain: 'pressure_volume_quantitative',
        chunkIds: [],
        pageEstimate: '183',
        keyFacts: [],
        clinicalRelevance: '',
        associations: ['Vascular Compliance'],
      },
      'Vascular distensibility is expressed ordinarily as the fractional increase in volume for each millimeter of mercury rise in pressure.',
    );

    expect(draft).not.toBeNull();
    expect(draft?.correctAnswer).toBe(1);
    expect(draft?.options).toEqual(['Compliance', 'Distensibility', 'Resistance', 'Vascular tone', 'Pulse pressure']);
  });

  it('infers chunk provenance for a verified source quote', () => {
    const provenance = inferEvidenceProvenance(
      'Selective loss of inhibitory myenteric neurons causes aperistalsis and failure of LES relaxation in achalasia.',
      [{
        id: 'chunk-1',
        pdf_id: 'pdf-1',
        text: 'Selective loss of inhibitory myenteric neurons causes aperistalsis and failure of LES relaxation in achalasia.',
        start_page: 1,
        end_page: 1,
        headers: [],
        word_count: 14,
        embedding: [],
      }],
    );

    expect(provenance.chunkId).toBe('chunk-1');
    expect(provenance.evidenceStart).toBe(0);
    expect(provenance.evidenceEnd).toBeGreaterThan(20);
  });
});
