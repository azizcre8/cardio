import type { Question } from '@/types';
import type { OpenAICostTracker } from '@/lib/openai-cost';
import { embedTexts } from './embeddings';

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

function cosineSimilarity(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return 0;

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }

  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
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
  onCost?: OpenAICostTracker,
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

  let vectors: number[][] = [];
  let useEmbeddingDedup = true;
  try {
    vectors = await embedTexts(questions.map(question => question.stem), onCost);
  } catch (error) {
    console.warn('dedupQuestions: embedTexts failed, falling back to fingerprint-only dedup:', error);
    useEmbeddingDedup = false;
  }
  const droppedIndices = new Set<number>();
  const dropped: DedupDrop[] = [];

  for (const pair of candidatePairs) {
    if (droppedIndices.has(pair.left) || droppedIndices.has(pair.right)) continue;

    const exactFingerprint = fingerprints[pair.left] === fingerprints[pair.right];
    const similarity = useEmbeddingDedup
      ? cosineSimilarity(vectors[pair.left] ?? [], vectors[pair.right] ?? [])
      : 0;

    // L1 entity-recall stems use a fixed template ("In the source passage,
    // which named concept is described by...") so two L1 stems for adjacent
    // concepts hit very high lexical overlap legitimately. Audit found L1
    // pairs at 0.82 and 0.79 cosine that were clearly redundant — the 0.92
    // ceiling let them through. Lower the threshold for L1-vs-L1 pairs to
    // 0.78, which the pathology audit shows is the right cut.
    // See reports/20a-audit.md "Highest-similarity repetitive pairs" for evidence.
    const bothL1 = questions[pair.left]!.level === 1 && questions[pair.right]!.level === 1;
    const threshold = bothL1 ? 0.78 : 0.92;
    if (!exactFingerprint && similarity < threshold) continue;

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
      reason: exactFingerprint ? 'fingerprint' : 'embedding',
    });
  }

  return {
    kept: questions.filter((_, idx) => !droppedIndices.has(idx)),
    dropped,
  };
}
