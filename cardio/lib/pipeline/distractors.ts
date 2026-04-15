/**
 * Hardcoded confusion-constrained distractor candidates.
 * Verbatim port from medical-study-app-v2.html (buildConfusionCandidates).
 * Supplements (not replaces) the LLM-generated confusion map.
 */

import type { ConfusionTarget, DistractorCandidate, GenerationSlot } from '@/types';
import { env } from '@/lib/env';

export interface ConceptLike {
  id?: string;
  name: string;
  category: string;
  coverageDomain?: string;
  aliases?: string[];
}

/** Returns up to 6 distractor candidates based on known medical confusion patterns. */
export function buildConfusionCandidates(concept: ConceptLike): string[] {
  const enableConfusion = env.flags.confusionDistractors;
  if (!enableConfusion) return [];

  const name = (concept.name || '').toLowerCase();
  const candidates: string[] = [];

  // Category 1: Beta-blocker vs CCB vs ACE-inhibitor confusion
  if (/beta.?blocker|metoprolol|atenolol|carvedilol|propranolol/.test(name))
    candidates.push('calcium channel blocker (CCB)', 'ACE inhibitor', 'ARB');
  if (/calcium channel|amlodipine|nifedipine|diltiazem|verapamil/.test(name))
    candidates.push('beta-blocker', 'ACE inhibitor', 'nitrate');

  // Category 2: ACE inhibitor vs ARB
  if (/ace inhibitor|lisinopril|enalapril|ramipril/.test(name))
    candidates.push('ARB (angiotensin receptor blocker)', 'direct renin inhibitor');
  if (/\barb\b|losartan|valsartan|irbesartan/.test(name))
    candidates.push('ACE inhibitor', 'aldosterone antagonist');

  // Category 3: Type I vs Type II hypersensitivity
  if (/type i|type 1|ige.mediat|anaphyl|immediate hypersens/.test(name))
    candidates.push('Type II hypersensitivity (cytotoxic)', 'Type III hypersensitivity (immune complex)', 'Type IV hypersensitivity (delayed)');
  if (/type ii|type 2|cytotoxic hypersens/.test(name))
    candidates.push('Type I hypersensitivity (IgE-mediated)', 'Type III (immune complex)');
  if (/type iii|type 3|immune complex/.test(name))
    candidates.push('Type II hypersensitivity', 'Type IV (delayed-type)');
  if (/type iv|type 4|delayed.type|cell.mediat/.test(name))
    candidates.push('Type I (IgE-mediated)', 'Type II (cytotoxic)');

  // Category 4: Sympathetic vs Parasympathetic effects
  if (/sympathetic|adrenergic|alpha.?1|beta.?1|beta.?2/.test(name))
    candidates.push('parasympathetic (cholinergic) effect', 'muscarinic antagonist effect');
  if (/parasympathetic|cholinergic|muscarinic|vagal/.test(name))
    candidates.push('sympathetic (adrenergic) effect', 'nicotinic receptor effect');

  // Category 5: MOA confusion — bacteriostatic vs bactericidal
  if (/bacteriostatic|tetracycline|macrolide|chloramphenicol|clindamycin/.test(name))
    candidates.push('bactericidal mechanism', 'cell wall synthesis inhibitor');
  if (/bactericidal|penicillin|cephalosporin|aminoglycoside|fluoroquinolone/.test(name))
    candidates.push('bacteriostatic mechanism', 'protein synthesis inhibitor (30S)', 'protein synthesis inhibitor (50S)');

  // Category 6: Nephrotic vs Nephritic syndrome
  if (/nephrotic/.test(name))
    candidates.push('nephritic syndrome', 'rapidly progressive GN');
  if (/nephritic/.test(name))
    candidates.push('nephrotic syndrome', 'chronic kidney disease');

  // Category 7: Upper vs Lower motor neuron signs
  if (/upper motor neuron|umn/.test(name))
    candidates.push('lower motor neuron (LMN) lesion', 'cerebellar lesion');
  if (/lower motor neuron|lmn/.test(name))
    candidates.push('upper motor neuron (UMN) lesion', 'neuromuscular junction disorder');

  // Category 8: Metabolic acidosis vs alkalosis gap types
  if (/metabolic acidosis/.test(name))
    candidates.push('metabolic alkalosis', 'respiratory acidosis', 'anion-gap vs non-anion-gap distinction');
  if (/metabolic alkalosis/.test(name))
    candidates.push('metabolic acidosis', 'respiratory alkalosis');

  // Category 9: Enzyme / receptor isoform confusion
  if (/cox.?1|cox.?2|cyclooxygenase/.test(name))
    candidates.push('COX-1 (constitutive, GI-protective)', 'COX-2 (inducible, inflammatory)');
  if (/p450|cyp3a4|cyp2d6|cyp2c19/.test(name))
    candidates.push('phase I metabolism (oxidation)', 'phase II metabolism (conjugation)');

  // Category 10: Microbiology — gram-positive vs gram-negative
  if (/gram.?positive|streptococ|staphylococ/.test(name))
    candidates.push('gram-negative organism', 'anaerobe', 'acid-fast organism');
  if (/gram.?negative|e\.?coli|klebsiella|pseudomonas/.test(name))
    candidates.push('gram-positive organism', 'atypical organism (no cell wall)');

  // Deduplicate and cap at 6
  return Array.from(new Set(candidates)).slice(0, 6);
}

function normalizeLabel(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function inferSharedFeature(slot: GenerationSlot, candidateName: string): string {
  if (/mechanism|pathway|physiology/i.test(slot.category) || /mechanism|causal/i.test(slot.coverageDomain)) {
    return 'same mechanistic comparison class';
  }
  if (/drug|pharmacology/i.test(slot.category)) {
    return 'same therapeutic/pharmacologic comparison class';
  }
  if (/condition|presentation|complication|association/i.test(slot.category)) {
    return 'same clinical differential neighborhood';
  }
  return `${slot.category.toLowerCase()} comparison class shared with ${candidateName}`;
}

function inferDifferentiator(slot: GenerationSlot, candidateName: string, reason?: string): string {
  if (reason) return reason;
  if (/mechanism|pathway|physiology/i.test(slot.category) || /mechanism|causal/i.test(slot.coverageDomain)) {
    return `the deciding clue separates ${slot.conceptName} from ${candidateName} at the mechanism level`;
  }
  if (/drug|pharmacology/i.test(slot.category)) {
    return `the stem must distinguish ${slot.conceptName} from ${candidateName} by indication, adverse effect, or mechanism`;
  }
  return `the stem must distinguish ${slot.conceptName} from ${candidateName} using one clinically meaningful feature`;
}

function pushCandidate(
  out: DistractorCandidate[],
  seen: Set<string>,
  candidate: DistractorCandidate,
): void {
  const key = normalizeLabel(candidate.text);
  if (!key) return;
  if (seen.has(key)) {
    const existing = out.find(item => normalizeLabel(item.text) === key);
    if (existing && candidate.reasonType === 'confusion_pair' && existing.reasonType !== 'confusion_pair') {
      existing.reasonType = 'confusion_pair';
      existing.sharedFeature = candidate.sharedFeature;
      existing.differentiator = candidate.differentiator;
      existing.evidenceSnippet = candidate.evidenceSnippet ?? existing.evidenceSnippet;
    }
    return;
  }
  seen.add(key);
  out.push(candidate);
}

export function buildDistractorCandidatePool(
  slot: GenerationSlot,
  allConcepts: ConceptLike[],
  confusionTargets: ConfusionTarget[],
  _neighborSnippets: string[],
): DistractorCandidate[] {
  const enablePool = env.flags.distractorCandidatePool;
  const out: DistractorCandidate[] = [];
  const seen = new Set<string>([normalizeLabel(slot.conceptName)]);
  const slotName = normalizeLabel(slot.conceptName);

  if (!enablePool) return [];

  const sameCategoryPeers = allConcepts.filter(concept =>
    concept.name !== slot.conceptName &&
    concept.category === slot.category,
  );

  sameCategoryPeers.forEach(peer => {
    pushCandidate(out, seen, {
      text: peer.name,
      sourceConcept: peer.name,
      category: peer.category,
      reasonType: 'same_category_peer',
      sharedFeature: inferSharedFeature(slot, peer.name),
      differentiator: inferDifferentiator(slot, peer.name),
    });
  });

  confusionTargets.forEach(target => {
    pushCandidate(out, seen, {
      text: target.concept,
      sourceConcept: target.concept,
      category: slot.category,
      reasonType: 'confusion_pair',
      sharedFeature: target.reason || inferSharedFeature(slot, target.concept),
      differentiator: inferDifferentiator(slot, target.concept, target.differentiator ?? target.reason),
    });
  });

  const associationPeers = allConcepts.filter(concept =>
    concept.name !== slot.conceptName &&
    (slot.associations ?? []).some(assoc => normalizeLabel(concept.name).includes(normalizeLabel(assoc))),
  );
  associationPeers.forEach(peer => {
    pushCandidate(out, seen, {
      text: peer.name,
      sourceConcept: peer.name,
      category: peer.category,
      reasonType: 'association',
      sharedFeature: 'closely associated chapter concept',
      differentiator: inferDifferentiator(slot, peer.name),
    });
  });

  if (out.length < 4) {
    buildConfusionCandidates({ name: slot.conceptName, category: slot.category }).forEach(candidateText => {
      pushCandidate(out, seen, {
        text: candidateText,
        sourceConcept: candidateText,
        category: slot.category,
        reasonType: 'hardcoded_fallback',
        sharedFeature: inferSharedFeature(slot, candidateText),
        differentiator: inferDifferentiator(slot, candidateText),
      });
    });
  }

  // Keep the pool focused on genuinely distinct candidates; the writer can use 3-5.
  return out
    .filter(candidate => normalizeLabel(candidate.text) !== slotName)
    .slice(0, 8);
}

export function formatDistractorCandidatePool(candidates: DistractorCandidate[]): string {
  if (!candidates.length) return '';
  return candidates.map((candidate, idx) => {
    const evidence = candidate.evidenceSnippet ? ` | evidence="${candidate.evidenceSnippet}"` : '';
    return `${idx + 1}. ${candidate.text} | source=${candidate.sourceConcept} | type=${candidate.reasonType} | shared="${candidate.sharedFeature}" | differentiate="${candidate.differentiator}"${evidence}`;
  }).join('\n');
}
