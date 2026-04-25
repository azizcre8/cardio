import type { Question } from '@/types';

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'at', 'from', 'into',
  'during', 'including', 'until', 'against', 'among', 'throughout', 'despite', 'towards', 'upon', 'about',
  'over', 'under', 'after', 'before', 'between', 'without', 'within', 'along', 'following', 'across', 'behind',
  'beyond', 'plus', 'except', 'up', 'out', 'around', 'down', 'off', 'above', 'near', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'which', 'what', 'how', 'why', 'when', 'where', 'who', 'whom', 'this', 'that', 'these',
  'those', 'his', 'her', 'their', 'its', 'your', 'our', 'best', 'most', 'likely', 'following',
]);

type AuditedQuestion = Omit<Question, 'id' | 'created_at'>;

export interface DedupDrop {
  droppedConceptId: string;
  droppedStem: string;
  keptConceptId: string;
  keptStem: string;
  reason: 'fingerprint' | 'embedding';
}

export interface DedupResult {
  kept: AuditedQuestion[];
  dropped: DedupDrop[];
}

function tokenizeStem(stem: string): string[] {
  return stem
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token && !STOP_WORDS.has(token));
}

export function buildStemFingerprint(stem: string): string {
  return tokenizeStem(stem).slice(0, 12).join(' ');
}

function importanceWeight(importance: string | null | undefined): number {
  if (importance === 'high') return 3;
  if (importance === 'medium') return 2;
  return 1;
}

function compareQuestions(
  left: AuditedQuestion,
  right: AuditedQuestion,
  conceptImportance: Record<string, string>,
): number {
  const leftImportance = importanceWeight(left.concept_id ? conceptImportance[left.concept_id] : undefined);
  const rightImportance = importanceWeight(right.concept_id ? conceptImportance[right.concept_id] : undefined);
  if (leftImportance !== rightImportance) return rightImportance - leftImportance;

  const leftChunk = left.chunk_id ?? '';
  const rightChunk = right.chunk_id ?? '';
  return leftChunk.localeCompare(rightChunk);
}

export async function dedupQuestions(
  questions: AuditedQuestion[],
  conceptImportance: Record<string, string>,
): Promise<DedupResult> {
  if (questions.length < 2) return { kept: questions, dropped: [] };

  const fingerprints = questions.map(question => buildStemFingerprint(question.stem));
  const tokens = fingerprints.map(fingerprint => fingerprint.split(/\s+/).filter(Boolean));
  const candidatePairs: Array<{ left: number; right: number }> = [];
  const pairKey = new Set<string>();

  for (let left = 0; left < questions.length; left++) {
    for (let right = left + 1; right < questions.length; right++) {
      const sharedCount = tokens[left]!.filter(token => tokens[right]!.includes(token)).length;
      if (fingerprints[left] === fingerprints[right] || sharedCount >= 6) {
        const key = `${left}:${right}`;
        if (!pairKey.has(key)) {
          pairKey.add(key);
          candidatePairs.push({ left, right });
        }
      }
    }
  }

  if (!candidatePairs.length) return { kept: questions, dropped: [] };

  const droppedIndices = new Set<number>();
  const dropped: DedupDrop[] = [];

  for (const pair of candidatePairs) {
    if (droppedIndices.has(pair.left) || droppedIndices.has(pair.right)) continue;

    const exactFingerprint = fingerprints[pair.left] === fingerprints[pair.right];
    if (!exactFingerprint) continue;

    const winner = compareQuestions(questions[pair.left]!, questions[pair.right]!, conceptImportance) <= 0
      ? pair.left
      : pair.right;
    const loser = winner === pair.left ? pair.right : pair.left;
    droppedIndices.add(loser);
    dropped.push({
      droppedConceptId: questions[loser]!.concept_id ?? '',
      droppedStem: questions[loser]!.stem,
      keptConceptId: questions[winner]!.concept_id ?? '',
      keptStem: questions[winner]!.stem,
      reason: 'fingerprint',
    });
  }

  return {
    kept: questions.filter((_, idx) => !droppedIndices.has(idx)),
    dropped,
  };
}
