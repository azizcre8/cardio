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
    evidence_match_type: (raw.evidenceMatchType as Question['evidence_match_type']) ?? null,
    decision_target:     typeof raw.decisionTarget === 'string' ? raw.decisionTarget : null,
    deciding_clue:       typeof raw.decidingClue === 'string' ? raw.decidingClue : null,
    most_tempting_distractor: typeof raw.mostTemptingDistractor === 'string' ? raw.mostTemptingDistractor : null,
    why_tempting:        typeof raw.whyTempting === 'string' ? raw.whyTempting : null,
    why_fails:           typeof raw.whyFails === 'string' ? raw.whyFails : null,
    option_set_flags:    Array.isArray(raw.optionSetFlags) ? raw.optionSetFlags as string[] : null,
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

      // Negative RAG: retrieve chunks for top confusion neighbors to ground distractors
      if (process.env.ENABLE_NEGATIVE_RAG !== 'false') {
        try {
          const neighborQueries = batch.map(c => {
            const confusions = confusionMap[c.name] ?? [];
            return confusions.slice(0, 2).join('; ');
          });
          const hasNeighbors = neighborQueries.some(q => q.length > 0);
          if (hasNeighbors) {
            const neighborVecs = await embedTexts(neighborQueries.map((q, i) => q || batch[i]!.name));
            neighborVecs.forEach((nVec, i) => {
              if (!neighborQueries[i]) return;
              retrieveTopChunks(pdfId, nVec, neighborQueries[i]!, bm25Index, allChunkRecords, 2)
                .then(neighborChunks => {
                  (conceptChunks[i] as ChunkRecord[] & { _neighborPassages?: string[] })._neighborPassages =
                    neighborChunks.map(ch => ch.text.slice(0, 200));
                })
                .catch(() => { /* non-fatal */ });
            });
          }
        } catch { /* non-fatal */ }
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

    // L3 grounding guard: downgrade L3→L2 if chunks lack clinical context
    let guardedLevels = levels;
    if (process.env.ENABLE_L3_GROUNDING_GUARD !== 'false' && levels.includes(3)) {
      const chunks = conceptChunks[i] ?? [];
      if (!hasClinicalPresentationSupport(chunks)) {
        guardedLevels = Array.from(new Set(levels.map(l => l === 3 ? 2 : l)));
        console.log(`[Pipeline] L3→L2 downgrade: ${c.name} (insufficient clinical context in chunks)`);
      }
    }
    const neighborPassages = ((conceptChunks[i] as ChunkRecord[] & { _neighborPassages?: string[] })._neighborPassages ?? []);
    return {
      name:             c.name,
      category:         c.category,
      importance:       c.importance,
      levels:           guardedLevels,
      facts,
      pageEstimate:     c.pageEstimate ?? '',
      passages,
      neighborSnippets: neighborPassages,
      coverageDomain:   c.coverageDomain ?? 'definition_recall',
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

    const neighborLine = (cs as typeof cs & { neighborSnippets?: string[] }).neighborSnippets?.length
      ? `Distractor grounding (neighbor concepts): ${(cs as typeof cs & { neighborSnippets?: string[] }).neighborSnippets!.map(s => `"${s}"`).join(' | ')}`
      : '';
    return `
CONCEPT ${i + 1}: ${cs.name} [${cs.category}] [${cs.importance}-yield] [Pages: ${cs.pageEstimate || 'unknown'}] [Domain: ${cs.coverageDomain || 'definition_recall'}]
Key information: ${cs.facts}${cs.passages ? `\nSource passages from PDF:\n${cs.passages}` : ''}${confusionLine ? '\n' + confusionLine : ''}${candidateLine ? '\n' + candidateLine : ''}${neighborLine ? '\n' + neighborLine : ''}
Required question levels: ${cs.levels.map((l: number) => l === 1 ? 'L1=recall/definition' : l === 2 ? 'L2=mechanism/application' : 'L3=clinical vignette/comparison').join(', ')}`;
  }).join('\n');

  const prompt = `You are a medical board exam writer. Generate MCQ questions with MANDATORY per-concept coverage.
${specsText}

ITEM DESIGN PROCESS (follow for every question):
Step 1 — Choose a decisionTarget: one of: diagnosis / mechanism / pathophysiology / distinguishing feature / next best step / adverse effect / contraindication / complication / interpretation / comparison
Step 2 — Identify the decidingClue: the SINGLE clue that separates the correct answer from the strongest distractor
Step 3 — Identify the mostTemptingDistractor: the best wrong answer a partially-informed student would pick
Step 4 — Write the question so that knowing the decidingClue is necessary and sufficient to choose the correct answer

LEVEL STEM RULES (strictly enforced):
- Level 1: Recall/discrimination only. Direct questions acceptable. CLASSIC ASSOCIATIONS: pathognomonic signs, eponyms, classic triads, drug-disease links. Vary openers — do NOT start every L1 with "What is...".
- Level 2: MUST test mechanism, comparison, or why/how reasoning. NEVER write L2 as a definition or "what is the role/function of X" — that is L1. L2 must require explaining HOW something works, WHY a process occurs, or COMPARE two related concepts.
- Level 3: MUST open with "[Age]-year-old [male/female] presents with [specific symptoms]." Every L3 MUST have age, sex, and ≥2 specific clinical details. Abstract stems at L3 are REJECTED. Only include vignette details that are purposeful — no fluff.

QUALITY RULES (strictly enforced):
1. One question = one concept = one cognitive task. The decidingClue must be singular.
2. Generate EXACTLY the required levels for every concept — no skipping, no merging.
3. All options must belong to the SAME comparison class (all drugs, all mechanisms, all diagnoses, etc.).
4. At least 2 distractors must be genuinely competitive — a partially-informed student must seriously consider them.
5. Distractors should reflect real misconception types: related mechanism but wrong condition; related condition but wrong mechanism; right diagnosis but wrong next step; wrong timing/severity/location; classic confusion pair from supplied confusion candidates.

OPTION COUNT RULES:
6. L1: exactly 5 answer choices (A-E). L2/L3: exactly 4 answer choices (A-D). correctAnswer is 0-based index.

TELL-SIGN RULES (strictly enforced):
7. LENGTH PARITY: All options within 3 words of each other. Correct answer must NOT be longer.
8. STRUCTURAL PARITY: All options use identical grammatical form.
9. NO KEYWORD MIRRORING: If correct answer uses a rare stem term, ≥2 distractors must too.
10. SPECIFICITY MATCHING: If correct names a specific pathway/receptor, distractors must too.
11. THE BLINDFOLD TEST: Could a test-taker eliminate 2 distractors without medical knowledge? If yes, rewrite.

CONVERGENCE RULES (strictly enforced):
12. THEME DIVERSITY: Each distractor represents a distinctly different mechanism/pathway/concept.
13. NO SHARED DOMINANT WORDS: No single term dominates 3+ options unless it appears in all.
14. THE OUTLIER TEST: No single option is the obvious odd-one-out by theme or polarity.
15. CROSS-CONCEPT DISTRACTORS: Prefer distractors that are correct in a different context.
16. NO POLARITY CLUSTERING: Mix directional changes across options.

DISTRACTOR RULES:
17. Distractors must differ from correct answer by exactly ONE clinically meaningful feature.
18. Each distractor = genuine misconception. STRONGLY PREFER distractor candidates from the "Commonly confused with" and "Distractor candidates" lines when provided.
19. At least 1 distractor drawn from the confusion candidate list when supplied.
20. No distractor that is physiologically impossible or medically fabricated.

NEGATION STEMS (NOT/EXCEPT/LEAST):
21. Avoid at L1. At L2/L3: all non-keyed options must be definitively, unambiguously true.
22. False option must be substantially wrong, not a technicality.

EXPLANATION RULES:
23. Explanation MUST include:
   - WHY CORRECT: one sentence (key mechanism/fact)
   - WHY WRONG: for each distractor, one clause with contrast language (whereas/however/unlike/in contrast). Name the mostTemptingDistractor explicitly: why it is tempting AND why it fails.
   - DISTINCTION: one final sentence — "Key distinction: [decidingClue] — remember that [reusable rule]."
   Format: "[Correct] because [mechanism]. [MostTempting] is tempting because [shared feature], but fails because [specific reason]; [other distractor] applies only when [context]. Key distinction: [decidingClue]."

EVIDENCE:
24. sourceQuote: copy VERBATIM from source passages above. Must be a literal substring of the provided text. If none supports the correct answer, write UNGROUNDED.
25. evidenceStart/evidenceEnd: character offsets in the passage text (optional, best-effort).

ANSWER FORM VARIETY:
26. Vary forms across batch: mechanism, sequence, comparison, exception, cause-effect, clinical implication. No more than 2 directional-change questions per batch.

Return ONLY valid JSON array (no markdown, no code blocks).

L1 example (5 options):
[{"conceptName":"Pyloric Stenosis","level":1,"question":"Which physical exam finding is pathognomonic for hypertrophic pyloric stenosis?","options":["Olive-shaped epigastric mass","Hyperactive bowel sounds in RLQ","Rebound tenderness at McBurney's","Succussion splash on auscultation","Dance's sign on palpation"],"correctAnswer":0,"explanation":"A palpable olive-shaped mass in the epigastrium represents the hypertrophied pylorus and is pathognomonic for HPS. Hyperactive RLQ sounds suggest small bowel obstruction; McBurney's rebound indicates appendicitis; succussion splash is seen in gastric outlet obstruction from other causes; Dance's sign is associated with intussusception. Key distinction: pathognomonic HPS mass is olive-shaped and epigastric, not RLQ.","sourceQuote":"Hypertrophic pyloric stenosis presents with a palpable, firm, olive-shaped mass in the epigastric region.","evidenceStart":0,"evidenceEnd":90,"pageEstimate":"12","decisionTarget":"distinguishing feature","decidingClue":"olive-shaped epigastric mass is pathognomonic for HPS","mostTemptingDistractor":"Succussion splash on auscultation","whyTempting":"also a sign of gastric outlet obstruction","whyFails":"succussion splash occurs in any outlet obstruction, not specific to HPS"}]

L2 example (4 options):
[{"conceptName":"Myenteric Plexus","level":2,"question":"Why does achalasia cause dysphagia to both solids and liquids equally from the onset?","options":["Loss of inhibitory myenteric neurons abolishes VIP/NO-mediated LES relaxation","Fibrosis of esophageal smooth muscle prevents peristaltic propagation","Excess ACh from overactive excitatory neurons sustains esophageal spasm","Autoimmune destruction of Meissner submucosal plexus blocks swallowing reflex"],"correctAnswer":0,"explanation":"Achalasia results from selective destruction of inhibitory myenteric neurons that release VIP and NO to relax the LES. Without inhibitory input, the LES fails to relax, causing functional obstruction equally for liquids and solids. Fibrosis-based dysphagia would affect solids before liquids; excess ACh would cause intermittent spasm, not persistent failure; Meissner plexus is tempting because it sounds neuromuscular, but Meissner governs secretion, not peristalsis. Key distinction: inhibitory myenteric neuron loss — remember aperistalsis + equal-dysphagia = inhibitory loss, not excitatory or submucosal.","sourceQuote":"Inhibitory neurons of the myenteric plexus release VIP and NO to relax the LES; selective loss of these neurons in achalasia causes aperistalsis and failure of LES relaxation.","evidenceStart":0,"evidenceEnd":148,"pageEstimate":"5","decisionTarget":"mechanism","decidingClue":"inhibitory myenteric neurons (not excitatory or submucosal)","mostTemptingDistractor":"Autoimmune destruction of Meissner submucosal plexus blocks swallowing reflex","whyTempting":"both involve neural destruction in the esophagus","whyFails":"Meissner plexus controls secretion; myenteric plexus controls motility"}]

L3 example (4 options):
[{"conceptName":"Hypersensitivity Pneumonitis","level":3,"question":"A 52-year-old farmer presents with dyspnea and dry cough that worsen during work and improve on weekends. Chest CT shows bilateral ground-glass opacities. BAL reveals lymphocytosis. Which mechanism best explains the lung injury?","options":["CD4+ T-cell–mediated granulomatous inflammation from repeated antigen exposure","IgE-mediated mast cell degranulation triggered by inhaled organic dust","Neutrophil-dominant acute lung injury from endotoxin in moldy hay","Type II cytotoxic antibody response against alveolar basement membrane"],"correctAnswer":0,"explanation":"Hypersensitivity pneumonitis is a Type IV reaction driven by CD4+ T cells. IgE-mediated disease would cause immediate wheezing, not subacute work-related dyspnea — it is tempting because inhaled triggers are shared, but the lymphocytic BAL and granulomas rule it out. Neutrophil-dominant injury causes acute febrile illness without granulomas. Anti-GBM targets the basement membrane causing pulmonary-renal syndrome. Key distinction: lymphocytic BAL + granulomas = Type IV T-cell, not IgE — remember work-related pattern + lymphocytic BAL always points to HP.","sourceQuote":"Hypersensitivity pneumonitis is characterized by lymphocytic alveolitis and granuloma formation driven by CD4+ T cells.","evidenceStart":0,"evidenceEnd":120,"pageEstimate":"18","decisionTarget":"mechanism","decidingClue":"lymphocytic BAL + granulomas = Type IV T-cell, not IgE (Type I)","mostTemptingDistractor":"IgE-mediated mast cell degranulation triggered by inhaled organic dust","whyTempting":"both are triggered by inhaled antigens with respiratory symptoms","whyFails":"IgE causes immediate wheezing; lymphocytic BAL and granulomas indicate delayed T-cell response"}]

correctAnswer is the 0-based index. sourceQuote and pageEstimate are required. Include decisionTarget, decidingClue, mostTemptingDistractor, whyTempting, whyFails in every question.`;

  try {
    // Dynamic model routing: L2/L3 concepts use WRITER_MODEL for better first drafts.
    const hasHigherLevel = batch.some(c => {
      const levels = dc.levels[c.importance as keyof typeof dc.levels] ?? [1, 2];
      return levels.some(l => l >= 2);
    });
    const enableDynamic = process.env.ENABLE_DYNAMIC_MODEL_ROUTING !== 'false';
    const draftModel = (enableDynamic && hasHigherLevel) ? WRITER_MODEL : OPENAI_MODEL;
    console.log(`[Pipeline] Writer draft model: ${draftModel} (${hasHigherLevel ? 'L2/L3 present' : 'L1-only batch'})`);
    const { text, costUSD } = await callOpenAI(prompt, 8192, draftModel);
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
        let evidenceResult: ReturnType<typeof verifyEvidenceSpan> | null = null;
        if (enableGating && q.sourceQuote && q.sourceQuote !== 'UNGROUNDED') {
          // Use all source chunks for this concept as the verification corpus
          const sourceChunks = conceptChunks[batch.indexOf(concept)] ?? [];
          const corpusText = sourceChunks.map(ch => ch.text).join('\n');
          if (corpusText) {
            evidenceResult = verifyEvidenceSpan(
              q.sourceQuote as string,
              q.evidenceStart as number ?? 0,
              q.evidenceEnd as number ?? 0,
              corpusText,
            );
            evidenceValid = evidenceResult.ok;
          }
        }

        const normed = normaliseQuestion(
          { ...q, evidenceValid, evidenceMatchType: evidenceResult?.evidenceMatchType ?? null },
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
    - DISTINCTION: One final sentence: "Key distinction: [decidingClue] — remember that [reusable rule]."
    Example format: "[Correct answer] because [mechanism]. [MostTempting] is tempting because [shared feature], but fails because [specific reason]; [other distractor] applies only when [context]. Key distinction: [decidingClue] — remember that [reusable rule]."

ITEM DESIGN PROCESS (required):
1. Choose decisionTarget (diagnosis/mechanism/pathophysiology/distinguishing feature/next best step/adverse effect/contraindication/complication/interpretation/comparison)
2. Identify decidingClue: the single clue separating correct from mostTemptingDistractor
3. Identify mostTemptingDistractor: the best near-miss a partially-informed student would choose

Return a single JSON object only — no markdown, no prose:
L1: {"conceptName":"${concept.name}","level":${level},"question":"...","options":["...","...","...","...","..."],"correctAnswer":2,"explanation":"...","sourceQuote":"...","pageEstimate":"${concept.pageEstimate || ''}","decisionTarget":"...","decidingClue":"...","mostTemptingDistractor":"...","whyTempting":"...","whyFails":"..."}
L2/L3: {"conceptName":"${concept.name}","level":${level},"question":"...","options":["...","...","...","..."],"correctAnswer":2,"explanation":"...","sourceQuote":"...","pageEstimate":"${concept.pageEstimate || ''}","decisionTarget":"...","decidingClue":"...","mostTemptingDistractor":"...","whyTempting":"...","whyFails":"..."}`;

  const { text, costUSD } = await callOpenAI(prompt, 2048, WRITER_MODEL);
  const rawParsed = parseJSON(text);
  const raw = Array.isArray(rawParsed) ? rawParsed[0] : rawParsed;
  return { raw: raw as Record<string, unknown>, costUSD };
}

// ─── writerAgentRevise — verbatim prompt ─────────────────────────────────────

export async function writerAgentRevise(
  concept:     ConceptSpec,
  prevQuestion: { stem: string; options: string[]; answer: number; level: number; pageEstimate?: string; decidingClue?: string; decisionTarget?: string; mostTemptingDistractor?: string },
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

  const metadataContext = prevQuestion.decidingClue
    ? `\nDesign metadata: decisionTarget=${prevQuestion.decisionTarget ?? '?'} | decidingClue="${prevQuestion.decidingClue}" | mostTemptingDistractor="${prevQuestion.mostTemptingDistractor ?? '?'}"`
    : '';

  const prompt = `You are a specialist USMLE/COMLEX Writer Agent. Revise the question below based on the auditor's feedback.

CONCEPT: ${concept.name} [${concept.category}]
Required level: ${levelLabel}
Key information: ${facts}${sourceSection}${metadataContext}

PREVIOUS VERSION (do NOT repeat its flaws):
Stem: ${prevQuestion.stem}
Options: ${prevQuestion.options.map((o, j) => `${j === prevQuestion.answer ? '★' : ''}${['A', 'B', 'C', 'D'][j]}) ${o}`).join(' | ')}

AUDITOR REJECTION — Criterion violated: ${criterion}
Specific fix required: "${critique}"

Address ONLY the named criterion. Keep everything else correct (same concept, same level, same category constraints). Apply all standard board rules: same-category distractors, equal option lengths, no length tells, stem answerable before options.

Return a single JSON object only — no markdown, no prose (include metadata fields if you improved them):
{"conceptName":"${concept.name}","level":${level},"question":"...","options":["...","...","...","..."],"correctAnswer":2,"explanation":"...","sourceQuote":"...","pageEstimate":"${concept.pageEstimate || ''}","decisionTarget":"...","decidingClue":"...","mostTemptingDistractor":"...","whyTempting":"...","whyFails":"..."}`;

  const { text, costUSD } = await callOpenAI(prompt, 2048, WRITER_MODEL);
  const rawParsed = parseJSON(text);
  const raw = Array.isArray(rawParsed) ? rawParsed[0] : rawParsed;
  return { raw: raw as Record<string, unknown>, costUSD };
}

// ─── L3 Grounding Guard ───────────────────────────────────────────────────────
// Returns true if chunks contain sufficient clinical-context language for L3 vignettes.
export function hasClinicalPresentationSupport(chunks: ChunkRecord[]): boolean {
  if (process.env.ENABLE_L3_GROUNDING_GUARD === 'false') return true;
  const clinicalSignals = /\b(patient|presents?|year.old|male|female|complain|symptom|sign|vital|lab|imaging|exam|diagnosis|management|treatment|history|physical|workup|finding|fever|pain|dyspnea|fatigue|nausea|vomiting|diarrhea|rash|edema|tachycardia|bradycardia|hypertension|hypotension|biopsy|CBC|BMP|CXR|CT|MRI|EKG|ECG)\b/i;
  const combined = chunks.map(ch => ch.text ?? '').join(' ');
  const matchCount = (combined.match(clinicalSignals) ?? []).length;
  const wordCount = combined.split(/\s+/).length;
  return matchCount >= Math.max(2, wordCount / 200);
}
