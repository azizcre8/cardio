/**
 * Data-driven distractor candidates from mined reference bank confusion pairs.
 * Replaces hardcoded regex blocks with learned patterns from 80+ reference questions.
 */

import type { ConfusionTarget, DistractorCandidate, GenerationSlot } from '@/types';
import { env } from '@/lib/env';
import fs from 'node:fs';
import path from 'node:path';

type ConfusionPairGroup = {
  topic: string;
  correct_concept: string;
  confusable_with: Array<{ concept: string; reason: string }>;
};

let confusionPairsCache: ConfusionPairGroup[] | null = null;

function loadConfusionPairs(): ConfusionPairGroup[] {
  if (confusionPairsCache) return confusionPairsCache;
  try {
    const dataPath = path.join(process.cwd(), 'data', 'confusion-pairs.json');
    if (fs.existsSync(dataPath)) {
      const raw = fs.readFileSync(dataPath, 'utf8');
      confusionPairsCache = JSON.parse(raw);
      return confusionPairsCache;
    }
  } catch (err) {
    console.warn(`Failed to load confusion-pairs.json: ${(err as Error).message}`);
  }
  return [];
}

export interface ConceptLike {
  id?: string;
  name: string;
  category: string;
  coverageDomain?: string;
  aliases?: string[];
}

export interface OptionLengthBalanceSignal {
  maxMinRatio: number;
  correctMedianRatio: number;
  correctLength: number;
  medianLength: number;
  isCorrectLongest: boolean;
  isCorrectShortest: boolean;
}

export function balanceOptionLengths(
  options: string[],
  correctIdx: number,
): OptionLengthBalanceSignal | null {
  if (!options.length || correctIdx < 0 || correctIdx >= options.length) return null;

  const lengths = options.map(option => option.trim().length);
  const nonZeroLengths = lengths.filter(length => length > 0);
  if (nonZeroLengths.length !== options.length) return null;

  const sortedLengths = [...lengths].sort((a, b) => a - b);
  const medianLength = sortedLengths[Math.floor(sortedLengths.length / 2)] ?? 0;
  const correctLength = lengths[correctIdx] ?? 0;
  const maxLength = sortedLengths[sortedLengths.length - 1] ?? 0;
  const minLength = sortedLengths[0] ?? 0;
  const maxMinRatio = minLength > 0 ? maxLength / minLength : Infinity;
  const correctMedianRatio = medianLength > 0 ? correctLength / medianLength : 1;
  const isCorrectLongest = correctLength === maxLength;
  const isCorrectShortest = correctLength === minLength;

  const correctOutlier =
    (isCorrectLongest && correctMedianRatio > 1.3) ||
    (isCorrectShortest && correctMedianRatio < 0.7);

  if (maxMinRatio > 1.6 || correctOutlier) {
    return {
      maxMinRatio,
      correctMedianRatio,
      correctLength,
      medianLength,
      isCorrectLongest,
      isCorrectShortest,
    };
  }

  return null;
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1];
      else dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function findBestTopicMatch(conceptName: string, groups: ConfusionPairGroup[]): ConfusionPairGroup | null {
  const normalized = conceptName.toLowerCase();
  let best: ConfusionPairGroup | null = null;
  let bestScore = Infinity;

  for (const group of groups) {
    const topicDist = levenshteinDistance(normalized, group.topic.toLowerCase());
    if (topicDist < bestScore) {
      bestScore = topicDist;
      best = group;
    }
  }

  return bestScore <= 5 ? best : null;
}

/** Returns up to 6 distractor candidates from mined reference bank confusion pairs. */
export function buildConfusionCandidates(concept: ConceptLike): string[] {
  const enableConfusion = env.flags.confusionDistractors;
  if (!enableConfusion) return [];

  const pairs = loadConfusionPairs();
  const match = findBestTopicMatch(concept.name, pairs);
  if (!match) return [];

  return match.confusable_with.slice(0, 6).map(c => c.concept);
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
