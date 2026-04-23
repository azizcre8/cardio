import type { Question } from '@/types';
import { callOpenAI, parseJSON, OPENAI_MODEL } from './generation';
import type { OpenAICostTracker } from '@/lib/openai-cost';

export type EvalScore = {
  stemQuality: number;
  distractorCompetitiveness: number;
  explanationDepth: number;
  evidenceGrounding: number;
};

export type EvalResult = {
  generatedId: string;
  referenceId: string;
  scores: EvalScore;
  rationale: string;
};

const EVAL_PROMPT = (ref: any, gen: Question): string => `
You are evaluating a generated medical question against a reference question on 4 dimensions.

REFERENCE QUESTION:
Stem: ${ref.stem}
Options: ${ref.options.map((o: any, i: number) => `${String.fromCharCode(65 + i)}) ${o}`).join('\n')}
Correct: ${ref.correct}
Explanation: ${ref.explanation}

GENERATED QUESTION:
Stem: ${gen.stem}
Options: ${gen.options.map((o, i) => `${String.fromCharCode(65 + i)}) ${o}`).join('\n')}
Correct: ${String.fromCharCode(65 + (gen.correctOptionIndex ?? 0))}
Explanation: ${gen.explanation}

Score each dimension on a scale of 1–5:

1. **Stem Quality** (1=incoherent, 5=clear, level-appropriate, tests intended concept)
   - Does the stem clearly test a single concept?
   - Is it at the right Bloom's level for this question?
   - Are distractors plausible given the stem wording?

2. **Distractor Competitiveness** (1=trivial, 5=each distractor is a common misconception)
   - Would a student uncertain about the concept find each distractor tempting?
   - Are distractors similar in quality/plausibility?
   - Is the correct answer not an outlier in length or style?

3. **Explanation Depth** (1=restates answer, 5=teaches why correct answer is right AND why distractors are wrong)
   - Does it identify the deciding clue from the source material?
   - Does it explain common misconceptions?
   - Is it 2–3 sentences?

4. **Evidence Grounding** (1=no source quote, 5=source quote is exact AND directly proves the answer)
   - Is the source quote verbatim from the reference material?
   - Does the quote actually justify the correct answer?

Output JSON:
{
  "stemQuality": <1-5>,
  "distractorCompetitiveness": <1-5>,
  "explanationDepth": <1-5>,
  "evidenceGrounding": <1-5>,
  "rationale": "<brief note on most critical strength/weakness>"
}
`;

export async function evalQuestion(
  refEntry: any,
  generated: Question,
  onCost?: OpenAICostTracker,
): Promise<EvalScore & { rationale: string }> {
  const prompt = EVAL_PROMPT(refEntry, generated);
  const { text } = await callOpenAI(prompt, 1024, OPENAI_MODEL, onCost, { temperature: 0 });
  const result = parseJSON(text) as EvalScore & { rationale: string };
  return result;
}

export function aggregateScores(results: EvalResult[]): { avg: EvalScore; perAxis: Record<string, number> } {
  const axes = ['stemQuality', 'distractorCompetitiveness', 'explanationDepth', 'evidenceGrounding'] as const;
  const sums = Object.fromEntries(axes.map(a => [a, 0]));
  for (const r of results) {
    for (const axis of axes) {
      sums[axis] += r.scores[axis];
    }
  }
  const count = Math.max(results.length, 1);
  const avg: EvalScore = {
    stemQuality: sums.stemQuality / count,
    distractorCompetitiveness: sums.distractorCompetitiveness / count,
    explanationDepth: sums.explanationDepth / count,
    evidenceGrounding: sums.evidenceGrounding / count,
  };
  return {
    avg,
    perAxis: {
      'Stem Quality': avg.stemQuality,
      'Distractor Competitiveness': avg.distractorCompetitiveness,
      'Explanation Depth': avg.explanationDepth,
      'Evidence Grounding': avg.evidenceGrounding,
    },
  };
}
