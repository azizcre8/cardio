/**
 * Phase 5b/6 — Question generation (Writer Agent) and normalization.
 * Verbatim prompt templates from medical-study-app-v2.html.
 *
 * callOpenAI replaces callGemini — uses OpenAI Node SDK with server-side key.
 * All prompt text is copied verbatim; zero content changes.
 */

import OpenAI from 'openai';
import type { Question, Concept, ChunkRecord, DensityConfig, ConfusionMap, BM25Index } from '@/types';
import { buildConfusionCandidates } from './distractors';
import { verifyEvidenceSpan } from './validation';
import { embedTexts } from './embeddings';
import { retrieveTopChunks } from './retrieval';

// ─── Constants (verbatim from HTML) ──────────────────────────────────────────

export const OPENAI_MODEL  = 'gpt-4o-mini';
export const WRITER_MODEL  = 'gpt-4o';
export const AUDITOR_MODEL = 'gpt-4o';

const RAG_TOP_K = 4;
const MAX_REVISE_ITERATIONS = 2;

const MODEL_PRICING: Record<string, { in: number; out: number }> = {
  'gpt-4o-mini': { in: 0.15,  out: 0.60  },
  'gpt-4o':      { in: 2.50,  out: 10.0  },
};

// ─── OpenAI client ────────────────────────────────────────────────────────────

function getOpenAI(): OpenAI {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── callOpenAI (replaces callGemini — same retry/rate-limit logic) ───────────

export async function callOpenAI(
  prompt:    string,
  maxTokens = 8192,
  model     = OPENAI_MODEL,
): Promise<{ text: string; costUSD: number }> {
  const openai = getOpenAI();
  let totalCost = 0;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.3,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error('Empty API response');

      if (response.usage) {
        const pricing = MODEL_PRICING[model] ?? MODEL_PRICING['gpt-4o']!;
        totalCost =
          (response.usage.prompt_tokens / 1e6) * pricing.in +
          (response.usage.completion_tokens / 1e6) * pricing.out;
      }

      return { text: content, costUSD: totalCost };
    } catch (err) {
      const e = err as { status?: number; message?: string };
      const msg = e.message ?? String(e);
      const isRateLimit = e.status === 429 || msg.toLowerCase().includes('rate limit');

      if (isRateLimit && attempt < 3) {
        const wait = 10_000 * (attempt + 1);
        console.warn(`Rate limit — waiting ${wait / 1000}s before retry…`);
        await sleep(wait);
        continue;
      }
      throw new Error(msg);
    }
  }

  throw new Error('callOpenAI: exhausted retries');
}

// ─── parseJSON — verbatim from HTML ──────────────────────────────────────────

export function parseJSON(text: string): unknown {
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const si = clean.indexOf('[');
  const oi = clean.indexOf('{');
  const s =
    si === -1 && oi === -1 ? -1 :
    si === -1 ? oi :
    oi === -1 ? si :
    Math.min(si, oi);

  if (s === -1) throw new Error('No JSON found in response');
  const slice = clean.slice(s);

  // Try 1: parse as-is
  try { return JSON.parse(slice); } catch (_) { /* fall through */ }

  // Try 2: repair truncated arrays — find last complete top-level object
  let lastGood = -1, depth = 0;
  let inStr = false, esc = false;
  for (let i = 0; i < slice.length; i++) {
    const ch = slice[i]!;
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) lastGood = i; }
  }

  if (lastGood > 0) {
    try {
      const wrapped =
        si !== oi && si === s
          ? '[' + slice.slice(0, lastGood + 1) + ']'
          : slice.slice(0, lastGood + 1);
      const r = JSON.parse(wrapped);
      if (Array.isArray(r) && r.length > 0) return r;
      if (r && typeof r === 'object') return r;
    } catch (_) { /* fall through */ }
  }

  throw new Error('Could not parse JSON from response');
}

// ─── cleanOptions — verbatim from HTML ───────────────────────────────────────

function cleanOptions(options: string[]): string[] {
  return options.map(opt => String(opt || '').replace(/^[A-Ea-e][.)]\s*/, '').trim());
}

// ─── normaliseQuestion — verbatim port ───────────────────────────────────────

export function normaliseQuestion(
  raw:     Record<string, unknown>,
  concept: { id: string; name: string; category: string; importance: string; coverageDomain?: string; pageEstimate?: string },
  level:   number,
  pdfId:   string,
  userId:  string,
): Omit<Question, 'id' | 'created_at'> | null {
  const resolvedLevel = parseInt(String(raw?.level)) || level;
  const allowedLen = resolvedLevel === 1 ? [4, 5] : [4];
  if (
    !raw?.question || !Array.isArray(raw.options) ||
    !allowedLen.includes((raw.options as unknown[]).length) ||
    typeof raw.correctAnswer !== 'number' ||
    (raw.correctAnswer as number) < 0 ||
    (raw.correctAnswer as number) >= (raw.options as unknown[]).length
  ) return null;

  let opts = cleanOptions([...(raw.options as string[])]);
  let ci = raw.correctAnswer as number;

  // Fisher-Yates shuffle on indices (verbatim from HTML)
  const n = opts.length;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [opts[i], opts[j]] = [opts[j]!, opts[i]!];
    if (ci === i) ci = j;
    else if (ci === j) ci = i;
  }

  return {
    pdf_id:              pdfId,
    concept_id:          concept.id,
    user_id:             userId,
    level:               (parseInt(String(raw.level)) || level) as Question['level'],
    stem:                raw.question as string,
    options:             opts,
    answer:              ci,
    explanation:         (raw.explanation as string) || '',
    option_explanations: null,
    source_quote:        typeof raw.sourceQuote === 'string' ? raw.sourceQuote as string : '',
    evidence_start:      typeof raw.evidenceStart === 'number' ? raw.evidenceStart as number : 0,
    evidence_end:        typeof raw.evidenceEnd === 'number' ? raw.evidenceEnd as number : 0,
    chunk_id:            null,
    flagged:             false,
    flag_reason:         null,
  };
}

// ─── generateCoverageQuestions — verbatim prompt ──────────────────────────────

interface ConceptSpec {
  id:            string;
  name:          string;
  category:      string;
  importance:    string;
  keyFacts:      string[];
  clinicalRelevance: string;
  associations:  string[];
  pageEstimate:  string;
  coverageDomain: string;
  chunk_ids:     string[];
}

export async function generateCoverageQuestions(
  batch:          ConceptSpec[],
  pdfId:          string,
  userId:         string,
  dc:             DensityConfig,
  allChunkRecords: ChunkRecord[],
  confusionMap:   ConfusionMap,
  bm25Index:      BM25Index | null,
): Promise<{ questions: Array<Omit<Question, 'id' | 'created_at'>>; costUSD: number }> {
  const all: Array<Omit<Question, 'id' | 'created_at'>> = [];
  let totalCost = 0;

  // ── RAG: embed concept queries and retrieve top-k source chunks per concept
  const hasEmbeddings = allChunkRecords.some(c => c.embedding && c.embedding.length > 0);
  let conceptChunks: ChunkRecord[][] = batch.map(() => []);

  if (hasEmbeddings) {
    try {
      const queries = batch.map(c =>
        `${c.name}: ${(c.keyFacts ?? []).slice(0, 3).join('. ')}`,
      );
      const queryVecs = await embedTexts(queries);

      for (let i = 0; i < queryVecs.length; i++) {
        const qVec = queryVecs[i]!;
        const c = batch[i]!;
        const queryText = queries[i]!;

        // Prefer known source chunks for this concept, then fill with similarity search
        const sourceIds = new Set(c.chunk_ids ?? []);
        const sourceChunks = allChunkRecords.filter(
          r => sourceIds.has(r.id) && r.embedding.length > 0,
        );
        const excluded = new Set(sourceChunks.map(r => r.id));
        const simChunks = await retrieveTopChunks(
          pdfId,
          qVec,
          queryText,
          bm25Index,
          allChunkRecords.filter(r => !excluded.has(r.id)),
          Math.max(0, RAG_TOP_K - sourceChunks.length),
        );
        conceptChunks[i] = [...sourceChunks, ...simChunks].slice(0, RAG_TOP_K);
      }
    } catch (e) {
      console.warn('RAG embedding failed for batch — falling back to no-RAG:', (e as Error).message);
      conceptChunks = batch.map(() => []);
    }
  }

  // Build per-concept specs with level requirements based on importance + density
  const specs = batch.map((c, i) => {
    const levels = dc.levels[c.importance as keyof typeof dc.levels] ?? [1, 2];
    const facts = [
      ...(c.keyFacts ?? []),
      c.clinicalRelevance ?? '',
      ...(c.associations ?? []).slice(0, 3),
    ].filter(Boolean).join('; ');

    const passages = conceptChunks[i]!.map(ch => {
      const pageRange =
        ch.start_page && ch.end_page && ch.start_page !== ch.end_page
          ? `pages ${ch.start_page}–${ch.end_page}`
          : `page ${ch.start_page ?? '?'}`;
      return `> "${ch.text.slice(0, 350).replace(/"/g, "'")}"  [${pageRange}]`;
    }).join('\n');

    return {
      name:           c.name,
      category:       c.category,
      importance:     c.importance,
      levels,
      facts,
      pageEstimate:   c.pageEstimate ?? '',
      passages,
      coverageDomain: c.coverageDomain ?? 'definition_recall',
    };
  });

  const specsText = specs.map((cs, i) => {
    const confusions = confusionMap[cs.name] ?? [];
    const confusionLine = confusions.length
      ? `Commonly confused with: ${confusions.join('; ')}. Prioritise these as distractors where clinically appropriate.`
      : '';
    const hardcodedCandidates = buildConfusionCandidates({ name: batch[i]!.name, category: batch[i]!.category });
    const candidateLine = hardcodedCandidates.length
      ? `Distractor candidates (use ≥1 when contextually appropriate): ${hardcodedCandidates.join('; ')}.`
      : '';

    return `
CONCEPT ${i + 1}: ${cs.name} [${cs.category}] [${cs.importance}-yield] [Pages: ${cs.pageEstimate || 'unknown'}] [Domain: ${cs.coverageDomain || 'definition_recall'}]
Key information: ${cs.facts}${cs.passages ? `\nSource passages from PDF:\n${cs.passages}` : ''}${confusionLine ? '\n' + confusionLine : ''}${candidateLine ? '\n' + candidateLine : ''}
Required question levels: ${cs.levels.map((l: number) => l === 1 ? 'L1=recall/definition' : l === 2 ? 'L2=mechanism/application' : 'L3=clinical vignette/comparison').join(', ')}`;
  }).join('\n');

  const prompt = `You are a medical board exam writer. Generate MCQ questions with MANDATORY per-concept coverage.
${specsText}

LEVEL STEM RULES (strictly enforced):
- Level 1: Recall only. Simple direct questions are acceptable.
- Level 2: MUST test mechanism, comparison, or "why/how" reasoning. NEVER write a Level 2 question that is just a definition or "what is the role/function of X" — that is Level 1. Level 2 must require the student to explain HOW something works, WHY a process occurs, or COMPARE two related concepts.
- Level 3: MUST be a clinical vignette. Format: "[Age]-year-old [male/female] presents with [specific symptoms]. Which of the following [best explains/is most likely/is the next best step]?" Every Level 3 question must have a patient with age, sex, and clinical presentation. Abstract stems at Level 3 are not allowed.

QUALITY RULES (strictly enforced):
1. Generate EXACTLY the required levels for every concept — no skipping, no merging
2. L1: direct recall but must require genuine knowledge, not just word-matching. CLASSIC ASSOCIATION RULE: if the concept has a pathognomonic sign, eponym, memorable drug-disease link, or classic boards triad, write that as the L1 question using a pattern-recognition format — e.g. "Which finding is pathognomonic for X?", "Which drug is classically associated with Y in neonates?", "What is the triad of Z?" These rapid-fire one-liners are heavily tested on boards. STEM VARIETY: do NOT start every L1 question with "What is..." — vary openers: "Which of the following best describes...", "A hallmark feature of X is...", "X is characterised by...", "Which finding is most associated with...", "A patient with X would most likely have...", "The defining histological feature of X is..."
3. L2: must test mechanism, pathophysiology, or clinical application — not surface recall
4. L3: must open with a brief patient scenario (age, presentation, key finding) then ask the question

OPTION COUNT RULES (strictly enforced):
5. Level 1 questions MUST have exactly 5 answer choices (A-E). Level 2 and Level 3 questions MUST have exactly 4 answer choices (A-D). This matches USMLE Step 1 format. correctAnswer is still a 0-based index (0=A, 1=B, 2=C, 3=D, 4=E for L1).

ANSWER POSITION RULES (strictly enforced):
6. Vary the position of the correct answer — do NOT consistently place it in position A or B. Distribute correct answers evenly across all positions.
7. All answer options must be approximately the same length. The correct answer must NOT be noticeably longer, more detailed, or more specific than the distractors. If you need to add detail to the correct answer, add equivalent detail to the distractors too.

TELL-SIGN RULES (strictly enforced — these allow guessing without medical knowledge):
11. LENGTH PARITY: Count the words in each option before finalizing. If the correct answer is more than 3 words longer than any distractor, trim it or expand the distractors to match.
12. STRUCTURAL PARITY: All options must use identical grammatical structure. If the correct answer is "[Mechanism] → [Effect]", every distractor must also be "[Mechanism] → [Effect]". Never mix bare noun phrases with full mechanistic phrases across options.
13. NO KEYWORD MIRRORING: If your correct answer contains a rare or specific term from the stem, at least 2 distractors must also contain that same term (applied incorrectly) — otherwise remove it from the correct answer.
14. SPECIFICITY MATCHING: If the correct answer names a specific pathway or receptor, distractors must also name specific (but wrong) pathways or receptors — not vague categories.
15. THE BLINDFOLD TEST: Before finalizing, ask yourself: "Could a smart test-taker eliminate 2 distractors using only test-taking strategy and no medical knowledge?" If yes, rewrite until the answer is no.

CONVERGENCE RULES (strictly enforced — these allow outlier elimination without medical knowledge):
16. THEME DIVERSITY: Each distractor must represent a distinctly different mechanism, pathway, or clinical concept. Never write 2 or more distractors that are variations of the same theme (e.g., three distractors all involving vasodilation, or three all involving inflammation).
17. NO SHARED DOMINANT WORDS: Scan all 4 options. If 3 or more options share a clinically significant word or root (e.g., "vasodilation," "fibrosis," "necrosis," "sodium"), rewrite until no single term dominates 3+ options. Common articles, prepositions, and conjunctions are exempt.
18. THE OUTLIER TEST: Before finalizing, ask: "Is one option the obvious odd-one-out based on theme alone?" If yes — whether that outlier is the correct answer or a distractor — rewrite until all 4 options feel like they belong to the same conceptual neighborhood without any single one standing apart.
19. CROSS-CONCEPT DISTRACTORS: Prefer distractors drawn from related but distinct concepts covered elsewhere in the same chapter. A distractor that is correct in a different context is far harder to eliminate than one invented purely as a foil.

20. NO DISTRACTOR CLUSTERING: Before finalizing, scan all distractors for shared keywords longer than 5 letters. If any word appears in 2 or more distractors but NOT in the correct answer, replace one of those distractors with a conceptually distinct alternative.
21. NO POLARITY CLUSTERING: Do not write distractors that all describe the same directional change (e.g., all "increased X," all "decreased Y") unless the correct answer also fits that pattern. Mixed polarities across options are required.

NEGATION STEM RULES (applies only to questions containing "NOT," "EXCEPT," or "LEAST likely"):
19. AVOID negation stems at Level 1. They test reading comprehension more than medical knowledge at the recall level. Only use negation stems at Level 2 or Level 3.
20. When writing a negation stem, ALL options except the correct answer (the one answer that is NOT true/applicable) must be definitively and unambiguously true statements about the concept. If you cannot verify that 3 out of 4 options are clearly true, do not use a negation stem — rewrite as a positive stem instead.
21. Never write a negation stem where the false option is false because of a minor technicality or ambiguous wording. The false option must be clearly and substantively wrong — a common misconception or a plausible-sounding but incorrect claim.
22. The explanation for a negation stem must explicitly confirm why each true option IS correct, then explain why the keyed answer is the exception.

DISTRACTOR RULES (strictly enforced):
8. Distractors must belong to the SAME conceptual category as the correct answer AND differ from the correct answer by exactly ONE clinically meaningful feature (mechanism, drug class, organism type, complication type, etc.). A distractor that is a different drug class, a different hypersensitivity type, or a different autonomic branch is far superior to a vague foil.
   - If the answer is a complication of HBV, ALL distractors must also be liver complications — not NAFLD or alcohol unless they are directly relevant.
   - If the answer is a drug mechanism, ALL distractors must be drug mechanisms in the same class or clinical context.
   - NEVER offer an answer the question stem itself rules out. If the stem says "viral hepatitis," do not list "alcoholic steatohepatitis" unless alcohol use is part of the scenario.
9. Each distractor must represent a genuine student misconception — something a knowledgeable student who hasn't fully mastered this concept would plausibly choose. If a distractor would only be chosen by someone who knows nothing, replace it. STRONGLY PREFER distractors from the "Commonly confused with" and "Distractor candidates" lines when they are provided — these represent validated confusion pairs on real board exams.
10. Never write near-duplicate questions within a batch.

COMPETITIVE DISTRACTOR RULES (strictly enforced):
- At least 2 distractors must be plausible enough that a partially-informed student (one who has studied but not mastered the concept) would seriously consider them. If you can only produce 1 genuinely tempting distractor, redesign the question.
- At least 1 distractor MUST be drawn from the "Commonly confused with" or "Distractor candidates" list if one is provided. Hallucinated confusion pairs are forbidden — use the supplied list or draw from related concepts explicitly named elsewhere in this prompt.
- No distractor may be instantly eliminable by a student who simply knows the organ system, physiological domain, or question type — every distractor must require genuine understanding of the specific concept to rule out.
- Trivial opposites (e.g., "increases X" vs "decreases X" when one is clearly wrong from the stem) are only acceptable if the student cannot determine direction without real knowledge.

ANSWER FORM VARIETY (strictly enforced across the batch):
- Do NOT default to "increases/decreases/no change" answer structures for consecutive questions in the batch.
- Vary answer forms across the batch: mechanism ("X occurs because…"), sequence ("The FIRST change is…"), comparison ("X differs from Y in that…"), exception ("Unlike other [class], X does NOT…"), cause-vs-effect ("X leads to Y by…"), location/function ("X is located in / responsible for…"), clinical implication ("This finding indicates…"), numeric/relative relationship ("X is approximately [N]x greater than Y when…").
- If you are writing more than 2 questions in the same batch that both ask about directional changes (increase/decrease), convert at least one to a mechanism, comparison, or clinical-implication form instead.

EXPLANATION RULES:
11. The "explanation" field MUST contain three parts in this order:
    - WHY CORRECT: One sentence stating why the correct answer is right (key mechanism or fact).
    - WHY WRONG: For EACH distractor, one clause explaining why it is wrong FOR THIS SPECIFIC QUESTION — not just that it is incorrect in general, but what specific feature of this question makes it wrong. Use contrast language: "whereas," "however," "unlike," "in contrast," "not because." You MUST name the most tempting distractor explicitly and explain both WHY it is tempting (what it has in common with the correct answer) AND WHY it fails here (what specific feature distinguishes the correct answer from it).
    - DISTINCTION: One final sentence stating the single deciding clue that separates the correct answer from the most tempting distractor. This must be actionable: a student reading it should know exactly what to look for on future similar questions.
    Example format: "[Correct answer] because [mechanism]. [Most tempting distractor] is tempting because [shared feature], but fails here because [specific distinguishing reason]; whereas [correct answer] requires [specific condition]. [Other distractor] applies only when [different context]. The key distinction is [X] vs [Y]: remember that [deciding clue]."
    FAIL CONDITIONS: Explanation fails if (a) it never addresses any specific distractor by name or content, (b) it only says "the others are incorrect" without contrastive reasoning, or (c) it could apply to a different question on the same concept without modification.
12. "sourceQuote": Copy this VERBATIM and EXACTLY from the source text provided in the passages above. It must be a substring that literally appears in the chunk text above — do not paraphrase, summarize, or invent. If no direct quote supports the correct answer, write the string UNGROUNDED.
    "evidenceStart": integer — character offset where sourceQuote begins in the chunk text provided above (0-based index into the passage text).
    "evidenceEnd": integer — character offset where sourceQuote ends in the chunk text provided above (exclusive, like String.slice).
13. The "pageEstimate" field: use only the starting page number from the concept spec as a plain integer (e.g. "12", never "~12–17" or ranges).

Return ONLY valid JSON array (no markdown, no code blocks).
L1 example (5 options, correctAnswer 0-based index 0–4):
[{"conceptName":"Pyloric Stenosis","level":1,"question":"Which physical exam finding is pathognomonic for hypertrophic pyloric stenosis?","options":["Olive-shaped mass in the epigastrium","Hyperactive bowel sounds in the RLQ","Rebound tenderness at McBurney's point","Succussion splash on abdominal auscultation","Dance's sign on palpation"],"correctAnswer":0,"explanation":"A palpable olive-shaped mass in the epigastrium represents the hypertrophied pylorus and is pathognomonic for HPS. The other findings are associated with different GI conditions.","sourceQuote":"Hypertrophic pyloric stenosis presents with a palpable, firm, olive-shaped mass in the epigastric region, representing the hypertrophied pyloric muscle.","evidenceStart":42,"evidenceEnd":178,"pageEstimate":"12"}]
L2/L3 example (4 options, correctAnswer 0-based index 0–3):
[{"conceptName":"Myenteric Plexus","level":2,"question":"Why does achalasia cause dysphagia to both solids and liquids equally?","options":["Loss of inhibitory myenteric neurons removes VIP/NO-mediated LES relaxation","Fibrosis of esophageal smooth muscle prevents peristaltic wave propagation","Excess ACh from overactive excitatory neurons causes sustained esophageal spasm","Autoimmune destruction of submucosal Meissner plexus blocks swallowing reflex"],"correctAnswer":0,"explanation":"Achalasia results from selective destruction of inhibitory myenteric neurons that release VIP and NO to relax the LES. Without inhibitory input, the LES fails to relax, causing aperistalsis and functional obstruction equally for liquids and solids.","sourceQuote":"Inhibitory neurons of the myenteric plexus release VIP and NO to relax the LES; selective loss of these neurons in achalasia causes aperistalsis and failure of LES relaxation.","evidenceStart":0,"evidenceEnd":148,"pageEstimate":"5"}]

correctAnswer is the 0-based index of the correct option. sourceQuote and pageEstimate are required for every question.`;

  try {
    const { text, costUSD } = await callOpenAI(prompt, 8192, OPENAI_MODEL);
    totalCost += costUSD;
    const qs = parseJSON(text);
    if (!Array.isArray(qs)) return { questions: all, costUSD: totalCost };

    (qs as Record<string, unknown>[])
      .filter(q =>
        q.question && Array.isArray(q.options) &&
        ((q.options as unknown[]).length === 4 || (parseInt(String(q.level)) === 1 && (q.options as unknown[]).length === 5)) &&
        typeof q.correctAnswer === 'number' &&
        (q.correctAnswer as number) >= 0 &&
        (q.correctAnswer as number) < (q.options as unknown[]).length &&
        q.level,
      )
      .forEach(q => {
        // Concept lookup — drop unmatched rather than mis-attribute to batch[0]
        const concept =
          batch.find(c => c.name.toLowerCase() === (String(q.conceptName ?? '')).toLowerCase()) ??
          batch.find(c => {
            const qn = String(q.conceptName ?? '').toLowerCase();
            const cn = c.name.toLowerCase();
            return cn.includes(qn) || qn.includes(cn);
          });
        if (!concept) return; // skip — do NOT fall back to batch[0]

        // Run evidence gating (P0.2) if enabled
        const enableGating = process.env.ENABLE_EVIDENCE_GATING !== 'false';
        let evidenceValid: boolean | null = null;
        if (enableGating && q.sourceQuote && q.sourceQuote !== 'UNGROUNDED') {
          const sourceChunk = conceptChunks[batch.indexOf(concept)]?.[0];
          if (sourceChunk) {
            const result = verifyEvidenceSpan(
              q.sourceQuote as string,
              q.evidenceStart as number,
              q.evidenceEnd as number,
              sourceChunk.text,
            );
            evidenceValid = result.ok;
          }
        }

        const normed = normaliseQuestion(
          { ...q, evidenceValid },
          concept,
          parseInt(String(q.level)) || 1,
          pdfId,
          userId,
        );
        if (normed) all.push(normed);
      });
  } catch (e) {
    console.warn('Q gen error:', (e as Error).message);
  }

  return { questions: all, costUSD: totalCost };
}

// ─── writerAgentGenerate — verbatim prompt ────────────────────────────────────

export async function writerAgentGenerate(
  concept:        ConceptSpec,
  level:          number,
  ragPassages:    string,
  confusionPairs: string,
): Promise<{ raw: Record<string, unknown>; costUSD: number }> {
  const levelLabel =
    level === 1 ? 'L1 — Recall / Definition' :
    level === 2 ? 'L2 — Mechanism / Application' :
                  'L3 — Clinical Vignette / Comparison';
  const facts = [
    ...(concept.keyFacts ?? []),
    concept.clinicalRelevance ?? '',
    ...(concept.associations ?? []).slice(0, 3),
  ].filter(Boolean).join('; ');

  const sourceSection = ragPassages
    ? `\nSOURCE PASSAGES FROM PDF (use to ground the question and sourceQuote):\n${ragPassages}\n`
    : '';
  const confusionSection = confusionPairs
    ? `\nKNOWN CONFUSION PAIRS — use these as distractors where appropriate:\n${confusionPairs}\n`
    : '';

  const prompt = `You are a specialist USMLE/COMLEX Writer Agent. Generate exactly ONE board-quality MCQ.

CONCEPT: ${concept.name} [${concept.category}] [${concept.importance}-yield]
Required level: ${levelLabel}
Key information: ${facts}${sourceSection}${confusionSection}

BOARD-STANDARD WRITING RULES (all mandatory):
1. The correct answer must be directly defensible from the key information or source passages above — no speculation.
2. All distractors must be from the SAME conceptual category as the correct answer (all drugs, all lab findings, all mechanisms, etc.).
3. Every distractor must represent a genuine near-miss — something a partially-informed student would plausibly choose.
4. The stem must be specific enough to answer BEFORE reading the options. Never write "Which is true about X" stems.
5. L3 must open with a patient scenario (age, presentation, key finding) then ask a reasoning question.
6. All options must be approximately the same length. The correct answer must NOT be longer or more detailed.
7. Vary the correct answer position — do NOT default to A or B.
8. The sourceQuote must be the single most relevant verbatim sentence (or close paraphrase) from the key information or source passages that directly proves the correct answer.
9. L1 questions MUST have exactly 5 options (A-E). L2/L3 questions MUST have exactly 4 options (A-D).

TELL-SIGN RULES (strictly enforced — these allow guessing without medical knowledge):
10. LENGTH PARITY: Count the words in each option before finalizing. If the correct answer is more than 3 words longer than any distractor, trim it or expand the distractors to match.
11. STRUCTURAL PARITY: All options must use identical grammatical structure. If the correct answer is "[Mechanism] → [Effect]", every distractor must also be "[Mechanism] → [Effect]". Never mix bare noun phrases with full mechanistic phrases across options.
12. NO KEYWORD MIRRORING: If your correct answer contains a rare or specific term from the stem, at least 2 distractors must also contain that same term (applied incorrectly) — otherwise remove it from the correct answer.
13. SPECIFICITY MATCHING: If the correct answer names a specific pathway or receptor, distractors must also name specific (but wrong) pathways or receptors — not vague categories.
14. THE BLINDFOLD TEST: Before finalizing, ask yourself: "Could a smart test-taker eliminate 2 distractors using only test-taking strategy and no medical knowledge?" If yes, rewrite until the answer is no.

CONVERGENCE RULES (strictly enforced — these allow outlier elimination without medical knowledge):
15. THEME DIVERSITY: Each distractor must represent a distinctly different mechanism, pathway, or clinical concept. Never write 2 or more distractors that are variations of the same theme (e.g., three distractors all involving vasodilation, or three all involving inflammation).
16. NO SHARED DOMINANT WORDS: Scan all 4 options. If 3 or more options share a clinically significant word or root (e.g., "vasodilation," "fibrosis," "necrosis," "sodium"), rewrite until no single term dominates 3+ options. Common articles, prepositions, and conjunctions are exempt.
17. THE OUTLIER TEST: Before finalizing, ask: "Is one option the obvious odd-one-out based on theme alone?" If yes — whether that outlier is the correct answer or a distractor — rewrite until all 4 options feel like they belong to the same conceptual neighborhood without any single one standing apart.
18. CROSS-CONCEPT DISTRACTORS: Prefer distractors drawn from related but distinct concepts covered elsewhere in the same chapter. A distractor that is correct in a different context is far harder to eliminate than one invented purely as a foil.

19. NO DISTRACTOR CLUSTERING: Before finalizing, scan all distractors for shared keywords longer than 5 letters. If any word appears in 2 or more distractors but NOT in the correct answer, replace one of those distractors with a conceptually distinct alternative.
20. NO POLARITY CLUSTERING: Do not write distractors that all describe the same directional change (e.g., all "increased X," all "decreased Y") unless the correct answer also fits that pattern. Mixed polarities across options are required.
21. THE OUTLIER TEST (structural): Before finalizing, ask yourself: "Does the correct answer stand out as the odd one out among the options — different word, different domain, different polarity?" If yes, redesign the distractor set so no single option is the obvious outlier.

NEGATION STEM RULES (applies only to questions containing "NOT," "EXCEPT," or "LEAST likely"):
18. AVOID negation stems at Level 1. They test reading comprehension more than medical knowledge at the recall level. Only use negation stems at Level 2 or Level 3.
19. When writing a negation stem, ALL options except the correct answer (the one answer that is NOT true/applicable) must be definitively and unambiguously true statements about the concept. If you cannot verify that 3 out of 4 options are clearly true, do not use a negation stem — rewrite as a positive stem instead.
20. Never write a negation stem where the false option is false because of a minor technicality or ambiguous wording. The false option must be clearly and substantively wrong — a common misconception or a plausible-sounding but incorrect claim.
21. The explanation for a negation stem must explicitly confirm why each true option IS correct, then explain why the keyed answer is the exception.

EXPLANATION RULES:
18. The "explanation" field MUST contain three parts in this order:
    - WHY CORRECT: One sentence stating why the correct answer is right (key mechanism or fact).
    - WHY WRONG: For each distractor, one clause explaining why it is wrong FOR THIS SPECIFIC QUESTION — not just that it is incorrect in general, but what specific feature of this question makes it wrong. Use contrast language: "whereas," "however," "unlike," "in contrast," "not because."
    - DISTINCTION: One final sentence stating the single most important conceptual distinction that separates the correct answer from the most tempting distractor.
    Example format: "[Correct answer] because [mechanism]. [Distractor A], however, applies only when [context]. [Distractor B] is incorrect here because [reason], whereas the correct answer requires [specific condition]. The key distinction is [X] vs [Y]."

Return a single JSON object only — no markdown, no prose:
L1: {"conceptName":"${concept.name}","level":${level},"question":"...","options":["...","...","...","...","..."],"correctAnswer":2,"explanation":"...","sourceQuote":"...","pageEstimate":"${concept.pageEstimate || ''}"}
L2/L3: {"conceptName":"${concept.name}","level":${level},"question":"...","options":["...","...","...","..."],"correctAnswer":2,"explanation":"...","sourceQuote":"...","pageEstimate":"${concept.pageEstimate || ''}"}`;

  const { text, costUSD } = await callOpenAI(prompt, 2048, WRITER_MODEL);
  const rawParsed = parseJSON(text);
  const raw = Array.isArray(rawParsed) ? rawParsed[0] : rawParsed;
  return { raw: raw as Record<string, unknown>, costUSD };
}

// ─── writerAgentRevise — verbatim prompt ─────────────────────────────────────

export async function writerAgentRevise(
  concept:     ConceptSpec,
  prevQuestion: { stem: string; options: string[]; answer: number; level: number; pageEstimate?: string },
  criterion:   string,
  critique:    string,
  ragPassages: string,
): Promise<{ raw: Record<string, unknown>; costUSD: number }> {
  const level = prevQuestion.level;
  const levelLabel =
    level === 1 ? 'L1 — Recall / Definition' :
    level === 2 ? 'L2 — Mechanism / Application' :
                  'L3 — Clinical Vignette / Comparison';
  const facts = [
    ...(concept.keyFacts ?? []),
    concept.clinicalRelevance ?? '',
    ...(concept.associations ?? []).slice(0, 3),
  ].filter(Boolean).join('; ');

  const sourceSection = ragPassages
    ? `\nSOURCE PASSAGES FROM PDF:\n${ragPassages}\n`
    : '';

  const prompt = `You are a specialist USMLE/COMLEX Writer Agent. Revise the question below based on the auditor's feedback.

CONCEPT: ${concept.name} [${concept.category}]
Required level: ${levelLabel}
Key information: ${facts}${sourceSection}

PREVIOUS VERSION (do NOT repeat its flaws):
Stem: ${prevQuestion.stem}
Options: ${prevQuestion.options.map((o, j) => `${j === prevQuestion.answer ? '★' : ''}${['A', 'B', 'C', 'D'][j]}) ${o}`).join(' | ')}

AUDITOR REJECTION — Criterion violated: ${criterion}
Specific fix required: "${critique}"

Address ONLY the named criterion. Keep everything else correct (same concept, same level, same category constraints). Apply all standard board rules: same-category distractors, equal option lengths, no length tells, stem answerable before options.

Return a single JSON object only — no markdown, no prose:
{"conceptName":"${concept.name}","level":${level},"question":"...","options":["...","...","...","..."],"correctAnswer":2,"explanation":"...","sourceQuote":"...","pageEstimate":"${concept.pageEstimate || ''}"}`;

  const { text, costUSD } = await callOpenAI(prompt, 2048, WRITER_MODEL);
  const rawParsed = parseJSON(text);
  const raw = Array.isArray(rawParsed) ? rawParsed[0] : rawParsed;
  return { raw: raw as Record<string, unknown>, costUSD };
}
