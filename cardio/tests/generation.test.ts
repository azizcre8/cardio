import { describe, expect, it } from 'vitest';
import { alignSourceQuoteToEvidence, buildPressureVolumePropertyDraft, inferEvidenceProvenance, repairDraftForValidation, rewriteDefinitionStyleDraft } from '@/lib/pipeline/generation';

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

  it('re-aligns decidingClue after replacing the source quote and fixes obvious concept answer drift', () => {
    const repaired = repairDraftForValidation(
      {
        conceptName: 'Thrombotic Microangiopathies',
        explanation: 'Thrombotic microangiopathies are characterized by microangiopathic hemolytic anemia and thrombocytopenia. Acute Tubular Injury/Necrosis does not typically present with these hematological findings.',
        options: [
          'Acute Tubular Injury/Necrosis',
          'Thrombotic Microangiopathies',
          'Anti-GBM Nephritis',
          'Chronic Glomerulonephritis',
        ],
        correctAnswer: 2,
        sourceQuote: 'Clinical manifestations of renal disease can be grouped into reasonably well-defined syndromes.',
        decidingClue: 'microangiopathic hemolytic anemia and thrombocytopenia',
      },
      [
        'Clinical manifestations of renal disease can be grouped into reasonably well-defined syndromes.',
        'Thrombotic microangiopathies are characterized by microangiopathic hemolytic anemia, thrombocytopenia, and acute kidney injury.',
      ].join(' '),
    );

    expect(repaired.correctAnswer).toBe(1);
    expect(repaired.sourceQuote).toBe('Thrombotic microangiopathies are characterized by microangiopathic hemolytic anemia, thrombocytopenia, and acute kidney injury.');
    expect(repaired.decidingClue).toBe('microangiopathic hemolytic anemia');
  });

  it('rewrites definition-style drafts with length-parity distractors before long parenthetical options', () => {
    const rewritten = rewriteDefinitionStyleDraft(
      {
        question: 'Which of the following best describes podocin?',
        options: [
          'The slit diaphragm protein mutated in steroid-resistant nephrotic syndrome',
          'The filtration barrier layer mutated in Alport syndrome',
          'The actin-binding podocyte protein linked to FSGS',
          'The supporting mesangial cell population in the glomerulus',
          'The risk gene associated with collapsing glomerulopathy',
        ],
        correctAnswer: 2,
        decisionTarget: 'definition',
        decidingClue: 'localized to the slit diaphragm',
        mostTemptingDistractor: 'Glomerular Basement Membrane (GBM)',
      },
      {
        conceptId: 'concept-1',
        conceptName: 'Podocin',
        category: 'Protein',
        importance: 'high',
        level: 1,
        coverageDomain: 'definition_recall',
        chunkIds: [],
        pageEstimate: '12',
        keyFacts: ['localized to the slit diaphragm'],
        clinicalRelevance: '',
        associations: [],
      },
      [
        { id: 'concept-1', name: 'Podocin', category: 'Protein', importance: 'high', keyFacts: [], clinicalRelevance: '', associations: [], pageEstimate: '12', coverageDomain: 'definition_recall', chunk_ids: [] },
        { id: 'concept-2', name: 'Podocytes', category: 'Cell', importance: 'high', keyFacts: [], clinicalRelevance: '', associations: [], pageEstimate: '12', coverageDomain: 'definition_recall', chunk_ids: [] },
        { id: 'concept-3', name: 'Mesangial Cells', category: 'Cell', importance: 'medium', keyFacts: [], clinicalRelevance: '', associations: [], pageEstimate: '12', coverageDomain: 'definition_recall', chunk_ids: [] },
        { id: 'concept-4', name: 'APOL1 Gene', category: 'Gene', importance: 'medium', keyFacts: [], clinicalRelevance: '', associations: [], pageEstimate: '12', coverageDomain: 'definition_recall', chunk_ids: [] },
        { id: 'concept-5', name: 'Glomerular Basement Membrane (GBM)', category: 'Structure', importance: 'medium', keyFacts: [], clinicalRelevance: '', associations: [], pageEstimate: '12', coverageDomain: 'definition_recall', chunk_ids: [] },
      ],
      [],
    );

    expect(rewritten.options).toEqual([
      'Podocytes',
      'Mesangial Cells',
      'Podocin',
      'APOL1 Gene',
      'Glomerular Basement Membrane (GBM)',
    ]);
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
