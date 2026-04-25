import { describe, expect, it } from 'vitest';
import { buildDeterministicQuestionValidation, runLengthAudit, stemIsInterrogative, validateQuestionDraft, validateSourceQuoteShape } from '@/lib/pipeline/question-validation';
import { hasEvidenceAnchorSupport, verifyEvidenceSpan } from '@/lib/pipeline/validation';

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
    expect(result.issues).toContain('Explanation is too short to teach why the correct answer is right and the top distractor is wrong.');
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

  it('flags explanation-answer mismatches when the explanation points to a different option', () => {
    const validation = buildDeterministicQuestionValidation(
      {
        pdf_id: 'pdf-1',
        concept_id: 'concept-1',
        user_id: 'user-1',
        level: 2,
        stem: 'In the context of atherosclerosis, which mechanism is primarily responsible for destabilization and rupture of plaques?',
        options: [
          'Acute Plaque Change',
          'Matrix Metalloproteinases (MMPs)',
          'Endothelial Injury',
          'Lipid Accumulation',
        ],
        answer: 2,
        explanation: 'MMP activity directly affects plaque stability by degrading structural components. Matrix metalloproteinases (MMPs) degrade extracellular matrix components, which can lead to plaque destabilization and rupture. Key distinction: extracellular matrix degradation drives plaque destabilization.',
        source_quote: 'Collagen turnover is controlled by metalloproteinases (MMPs) within the atheromatous plaque.',
        evidence_start: 0,
        evidence_end: 0,
        chunk_id: null,
        evidence_match_type: null,
        decision_target: 'mechanism',
        deciding_clue: 'extracellular matrix degradation',
        most_tempting_distractor: 'Acute Plaque Change',
        why_tempting: 'it is closely related to plaque rupture',
        why_fails: 'it describes the outcome rather than the mechanism',
        option_set_flags: null,
        flagged: false,
        flag_reason: null,
      },
      'Atherosclerotic plaque destabilization',
      'Collagen turnover is controlled by metalloproteinases (MMPs) within the atheromatous plaque.',
    );

    expect(validation.issues).toContain(
      'Explanation appears to justify a different answer choice than the keyed correct answer (Matrix Metalloproteinases (MMPs)).',
    );
  });

  it('does not flag small noun-phrase option length differences as a tell', () => {
    const [audit] = runLengthAudit([
      {
        pdf_id: 'pdf-1',
        concept_id: 'concept-1',
        user_id: 'user-1',
        level: 1,
        stem: 'Which vascular property best explains venous blood storage?',
        options: ['Compliance', 'Distensibility', 'Resistance', 'Tone', 'Pressure'],
        answer: 0,
        explanation: 'Compliance is correct because it reflects stored volume per pressure rise, whereas distensibility is fractional change. Key distinction: storage per pressure rise points to compliance.',
        option_explanations: null,
        source_quote: 'Compliance is the total quantity of blood that can be stored per mm Hg pressure rise.',
        evidence_start: 0,
        evidence_end: 0,
        chunk_id: null,
        evidence_match_type: null,
        decision_target: 'definition',
        deciding_clue: 'stored volume per pressure rise',
        most_tempting_distractor: 'Distensibility',
        why_tempting: 'both are pressure-volume properties',
        why_fails: 'distensibility is fractional change rather than total storage',
        option_set_flags: null,
        flagged: false,
        flag_reason: null,
      },
    ]);

    expect(audit?.status).toBe('PASS');
  });

  it('accepts 20-29 character fuzzy evidence matches', () => {
    const result = verifyEvidenceSpan(
      'Reduced venous return occurs',
      0,
      0,
      'Reduced venous returns occur during acute hypovolemia.',
    );

    expect(result.ok).toBe(true);
    expect(result.evidenceMatchType).toBe('fuzzy');
  });

  it('counts 3-letter acronyms as evidence anchors', () => {
    expect(hasEvidenceAnchorSupport('CHF causes RV strain', 'RV strain can develop in CHF')).toBe(true);
  });

  it('marks explanation-answer mismatches as retriable during draft generation', () => {
    const result = validateQuestionDraft(
      {
        conceptId: 'concept-1',
        conceptName: 'Atherosclerotic Plaque Destabilization',
        level: 2,
        question: 'In the context of atherosclerosis, which mechanism is primarily responsible for destabilization and rupture of plaques?',
        options: [
          'Acute Plaque Change',
          'Matrix Metalloproteinases (MMPs)',
          'Endothelial Injury',
          'Lipid Accumulation',
        ],
        correctAnswer: 2,
        explanation: 'MMP activity directly affects plaque stability by degrading structural components. Matrix metalloproteinases (MMPs) degrade extracellular matrix components, which can lead to plaque destabilization and rupture. Key distinction: extracellular matrix degradation drives plaque destabilization.',
        sourceQuote: 'Collagen turnover is controlled by metalloproteinases (MMPs) within the atheromatous plaque.',
        decisionTarget: 'mechanism',
        decidingClue: 'extracellular matrix degradation',
        mostTemptingDistractor: 'Acute Plaque Change',
        whyTempting: 'it is closely related to plaque rupture',
        whyFails: 'it describes the outcome rather than the mechanism',
      },
      {
        conceptId: 'concept-1',
        conceptName: 'Atherosclerotic Plaque Destabilization',
        expectedLevel: 2,
        evidenceCorpus: 'Collagen turnover is controlled by metalloproteinases (MMPs) within the atheromatous plaque.',
      },
    );

    expect(result.ok).toBe(false);
    expect(result.shouldRetry).toBe(true);
    expect(result.issues).toContain(
      'Explanation appears to justify a different answer choice than the keyed correct answer (Matrix Metalloproteinases (MMPs)).',
    );
  });

  it('rejects declarative stems that are not phrased as questions', () => {
    expect(
      stemIsInterrogative('Understanding his daily water intake is crucial for managing his hydration status.'),
    ).toBe(false);
  });

  it('accepts question-mark terminated stems', () => {
    expect(
      stemIsInterrogative('Which hormone is most responsible for increasing water reabsorption?'),
    ).toBe(true);
  });

  it('accepts interrogative leads even without a trailing question mark', () => {
    expect(
      stemIsInterrogative('Which of the following best explains the rise in ADH secretion'),
    ).toBe(true);
  });

  it('accepts trailing citations after the question mark', () => {
    expect(
      stemIsInterrogative('Which hormone most directly increases collecting duct water permeability via ADH? (Chapter 25)'),
    ).toBe(true);
  });

  it('rejects source quotes longer than 35 words as a paragraph stitch', () => {
    // 38-word run-on quote with semicolons and abbreviations that the
    // sentence-terminator regex (looking for .!? followed by whitespace)
    // would otherwise let through.
    const longQuote =
      'Membranous nephropathy is characterized by diffuse thickening of the glomerular capillary wall, with subepithelial deposits of IgG and complement, often associated with circulating autoantibodies directed against the M-type phospholipase A2 receptor expressed on the surface of podocytes throughout the renal cortex';
    const issue = validateSourceQuoteShape(longQuote);
    expect(issue).toBeTruthy();
    expect(issue).toMatch(/too long/i);
  });

  it('accepts source quotes at the 35-word ceiling', () => {
    // A 30-word, single-sentence body-text quote — should pass.
    const okQuote =
      'In acute glomerulonephritis the glomerular tuft becomes hypercellular due to infiltrating leukocytes and proliferating endothelial and mesangial cells, producing the characteristic hematuria and red-cell casts seen on urinalysis.';
    expect(validateSourceQuoteShape(okQuote)).toBeNull();
  });

  it('rejects truncated source quotes that start with a hyphen fragment', () => {
    const truncated = '- ing of the bladder are periodic acute increases in pressure that last from a few seconds to more than 1 minute.';
    const issue = validateSourceQuoteShape(truncated);
    expect(issue).toBeTruthy();
    expect(issue).toMatch(/fragment/i);
  });

  it('rejects source quotes that start with a lowercase letter', () => {
    const lowercase = 'the collecting ducts respond to antidiuretic hormone and regulate final urine concentration.';
    const issue = validateSourceQuoteShape(lowercase);
    expect(issue).toBeTruthy();
    expect(issue).toMatch(/fragment/i);
  });

  it('flags options with artificial descriptor suffixes', () => {
    const { issues } = buildDeterministicQuestionValidation(
      {
        pdf_id: 'pdf-1',
        concept_id: 'concept-1',
        user_id: 'user-1',
        level: 2,
        stem: 'Which substance is used to estimate glomerular filtration rate?',
        options: [
          'Sodium Ion Concentration Level',
          'Erythropoietin Hormone Level',
          'Amino Acid Metabolite Levels',
          'Creatinine Concentration Measurement',
        ],
        answer: 3,
        explanation: 'Creatinine Concentration Measurement is correct because creatinine is freely filtered. Sodium Ion Concentration Level is incorrect.',
        source_quote: 'Creatinine is freely filtered and not reabsorbed by the kidneys.',
        evidence_start: 0,
        evidence_end: 63,
        chunk_id: null,
        evidence_match_type: null,
        decision_target: 'mechanism',
        deciding_clue: 'freely filtered and not reabsorbed',
        most_tempting_distractor: 'Sodium Ion Concentration Level',
        why_tempting: 'both relate to kidney function',
        why_fails: 'sodium is reabsorbed, not a filtration marker',
        option_set_flags: null,
        flagged: false,
        flag_reason: null,
      },
      'Creatinine',
      'Creatinine is freely filtered and not reabsorbed by the kidneys.',
    );
    expect(issues.some(i => /descriptor suffix/i.test(i))).toBe(true);
  });

  it('flags option sets padded with generic mechanism/process labels', () => {
    const { issues } = buildDeterministicQuestionValidation(
      {
        pdf_id: 'pdf-1',
        concept_id: 'concept-1',
        user_id: 'user-1',
        level: 2,
        stem: 'A patient develops dilute urine despite high plasma osmolality. What best explains the abnormal water handling?',
        options: [
          'Fluid Exchange Mechanism',
          'Electrolyte Regulation Process',
          'Osmotic Pressure Regulation',
          'Antidiuretic Hormone Deficiency',
        ],
        answer: 3,
        explanation: 'Antidiuretic Hormone Deficiency is correct because loss of ADH signaling prevents normal water retention. Osmotic Pressure Regulation is tempting because osmotic gradients affect water movement, but it does not explain the hormone-dependent concentrating defect.',
        source_quote: 'Antidiuretic hormone increases the water permeability of the collecting ducts and helps conserve body water.',
        evidence_start: 0,
        evidence_end: 97,
        chunk_id: null,
        evidence_match_type: null,
        decision_target: 'mechanism',
        deciding_clue: 'increases the water permeability',
        most_tempting_distractor: 'Osmotic Pressure Regulation',
        why_tempting: 'both involve water movement',
        why_fails: 'it does not explain the hormone-dependent defect',
        option_set_flags: null,
        flagged: false,
        flag_reason: null,
      },
      'Antidiuretic Hormone',
      'Antidiuretic hormone increases the water permeability of the collecting ducts and helps conserve body water.',
    );
    expect(issues.some(i => /generic labels/i.test(i))).toBe(true);
  });

  it('flags low-value generic stem frames in accepted-question validation', () => {
    const { issues } = buildDeterministicQuestionValidation(
      {
        pdf_id: 'pdf-1',
        concept_id: 'concept-1',
        user_id: 'user-1',
        level: 1,
        stem: 'Which anatomical structure comprises about 20% of body weight and includes interstitial fluid and plasma?',
        options: [
          'Intracellular Fluid',
          'Extracellular Fluid',
          'Blood Volume',
          'Lymphatic System',
          'Capillary Membranes',
        ],
        answer: 1,
        explanation: 'Extracellular Fluid is correct because it includes plasma and interstitial fluid. Intracellular Fluid is tempting because it is another major body-fluid compartment, but it is inside cells rather than outside them.',
        source_quote: 'The extracellular fluid compartment includes plasma and interstitial fluid and accounts for about 20 percent of body weight.',
        evidence_start: 0,
        evidence_end: 112,
        chunk_id: null,
        evidence_match_type: null,
        decision_target: 'definition',
        deciding_clue: 'includes plasma and interstitial fluid',
        most_tempting_distractor: 'Intracellular Fluid',
        why_tempting: 'both are major body-fluid compartments',
        why_fails: 'it is inside cells rather than outside them',
        option_set_flags: null,
        flagged: false,
        flag_reason: null,
      },
      'Extracellular Fluid',
      'The extracellular fluid compartment includes plasma and interstitial fluid and accounts for about 20 percent of body weight.',
    );
    expect(issues.some(i => /low-value template/i.test(i))).toBe(true);
  });

  it('flags options that mix anatomical structures with physiological mechanisms', () => {
    const { issues } = buildDeterministicQuestionValidation(
      {
        pdf_id: 'pdf-1',
        concept_id: 'concept-1',
        user_id: 'user-1',
        level: 2,
        stem: 'Which process is primarily responsible for removing waste from the blood?',
        options: [
          'Glomerulus',
          'Tubular Secretion',
          'Renal Cortex',
          'Filtration',
        ],
        answer: 3,
        explanation: 'Filtration removes waste. Glomerulus is anatomy, not a process.',
        source_quote: 'Glomerular filtration removes waste products from the blood into the tubule.',
        evidence_start: 0,
        evidence_end: 74,
        chunk_id: null,
        evidence_match_type: null,
        decision_target: 'mechanism',
        deciding_clue: 'removes waste products',
        most_tempting_distractor: 'Glomerulus',
        why_tempting: 'site of filtration',
        why_fails: 'it is an anatomical structure, not a process',
        option_set_flags: null,
        flagged: false,
        flag_reason: null,
      },
      'Filtration',
      'Glomerular filtration removes waste products from the blood into the tubule.',
    );
    expect(issues.some(i => /mix anatomical/i.test(i))).toBe(true);
  });
});
