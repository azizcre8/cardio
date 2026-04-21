/**
 * Phase 5a — Content inventory extraction and concept canonicalization.
 * Verbatim port from medical-study-app-v2.html (extractInventory, mergeInventory,
 * canonicalizeConcepts, generateConfusionMap, assignCoverageDomain).
 */

import { callOpenAI, parseJSON } from './generation';
import type { ChunkRecord, RawConcept, ConfusionMap, Concept, DensityConfig } from '@/types';
import type { OpenAICostTracker } from '@/lib/openai-cost';

const OPENAI_MODEL = 'gpt-4o-mini';

function isLikelyFrontMatterChunk(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  const contentsSignals = [
    /\bchapter\s+contents\b/i,
    /\bsee targeted therapy available online\b/i,
    /\bvascular structure and function\b/i,
    /\bvascular anomalies\b/i,
    /\bpathology of vascular intervention\b/i,
  ];
  const hasContentsSignal = contentsSignals.some(pattern => pattern.test(normalized));
  const tocEntryCount = (normalized.match(/\b\d{3}\s+[A-Z][A-Za-z][^.;]{3,60}/g) ?? []).length;
  const pageNumberBurst = (normalized.match(/\b\d{3}\b/g) ?? []).length;

  return hasContentsSignal && (tocEntryCount >= 6 || pageNumberBurst >= 10);
}

// ─── Coverage domain classifier — verbatim from HTML ─────────────────────────

function assignCoverageDomain(
  name: string,
  category: string,
): string {
  const cat = (category || '').toLowerCase();
  const cpt = (name || '').toLowerCase();

  if (
    cat.includes('pathophysiological mechanism') || cat.includes('mechanism') ||
    cpt.includes('mechanism') || cpt.includes('pathway') || cpt.includes('regulation') ||
    cpt.includes('physiology')
  ) return 'mechanism_causal';

  if (
    cpt.includes('pressure') || cpt.includes('volume') || cpt.includes(' flow') ||
    cpt.includes('resistance') || cpt.includes('compliance') || cpt.includes('cardiac output') ||
    cpt.includes('gradient') || cpt.includes('starling') || cpt.includes('frank-starling')
  ) return 'pressure_volume_quantitative';

  if (
    cat.includes('complication') || cat.includes('classic association') ||
    cpt.includes(' versus ') || cpt.includes(' vs ') || cpt.includes('differential') ||
    cpt.includes('distinction') || cpt.includes('comparison')
  ) return 'comparison_differential';

  if (
    cat.includes('clinical presentation') || cat.includes('treatment') ||
    cat.includes('diagnostic method') || cat.includes('drug') || cat.includes('pharmacology') ||
    cpt.includes('management') || cpt.includes('presentation') || cpt.includes('diagnosis') ||
    cpt.includes('therapy') || cpt.includes('treatment')
  ) return 'clinical_application';

  return 'entity_recall';
}

// ─── extractInventory — verbatim port ────────────────────────────────────────

export interface InventoryBatch {
  headings:      string[];
  sourceChunkIds: string[];
  concepts:      RawConcept[];
}

export async function extractInventory(
  chunkBatch:   ChunkRecord[],
  dc:           DensityConfig,
  batchIdx:     number,
  totalBatches: number,
  onCost?: OpenAICostTracker,
): Promise<InventoryBatch> {
  // P0.1 — skip chunks shorter than 80 chars (garbage from scanned or blank pages)
  const records = chunkBatch.filter(r => {
    if ((r.text || '').length < 80) {
      console.warn(`[extractInventory] skipping chunk ${r.id} — only ${(r.text || '').length} chars`);
      return false;
    }
    if (isLikelyFrontMatterChunk(r.text || '')) {
      console.warn(`[extractInventory] skipping chunk ${r.id} — looks like table-of-contents/front matter`);
      return false;
    }
    if ((r.text || '').length >= 80) return true;
    console.warn(`[extractInventory] skipping chunk ${r.id} — only ${(r.text || '').length} chars`);
    return false;
  });

  if (!records.length) return { headings: [], sourceChunkIds: [], concepts: [] };

  const realStart = records.find(r => r.start_page != null)?.start_page;
  const realEnd   = records[records.length - 1]?.end_page;
  const wordsPerPage = 275;
  const startPage = realStart != null
    ? realStart
    : Math.max(1, Math.round((batchIdx * 3 * dc.words) / wordsPerPage));
  const endPage = realEnd != null
    ? realEnd
    : Math.round(((batchIdx * 3 + 3) * dc.words) / wordsPerPage);

  const sourceChunkIds = records.map(r => r.id).filter(Boolean);
  const combined = records.map(r => r.text).join('\n\n---\n\n');

  const minMax = `${dc.min}-${dc.max}`;

  const prompt = `You are a medical education expert performing comprehensive content analysis for exam preparation.

MEDICAL TEXT:
"""
${combined}
"""

Return ONLY valid JSON (no markdown, no code blocks):
{"headings":["Lower GI Tract","Crohn Disease"],"concepts":[{"name":"Myenteric Plexus","category":"Anatomical Structure","importance":"high","keyFacts":["between circular and longitudinal muscle layers","controls peristalsis","absent in Hirschsprung disease"],"clinicalRelevance":"Loss of inhibitory ganglion cells causes achalasia; absent in Hirschsprung disease","associations":["achalasia","Hirschsprung disease","Chagas disease"]}]}

FIELD DEFINITIONS:
- name: specific, testable name (drug, structure, condition, mechanism, finding)
- category: Anatomical Structure | Pathological Condition | Pathophysiological Mechanism | Clinical Presentation | Diagnostic Method | Treatment | Drug/Pharmacology | Risk Factor | Complication | Classic Association | Key Term
- importance: "high" (board-testable, first-line, gold standard, classic association) | "medium" (important) | "low" (supporting detail)
- keyFacts: 2-4 specific testable facts (mechanisms, diagnostics, treatments — fold them in here)
- clinicalRelevance: one sentence on clinical significance (empty string if not applicable)
- associations: 1-3 classic linked concepts, conditions to distinguish, or commonly confused items

Extract ${minMax} concepts per section. Every named structure, disease, drug, test, mechanism, complication, contraindication, classic association, or board-tested detail in the text must be captured.`;

  const { text } = await callOpenAI(prompt, Math.min(4000 * records.length, 16384), OPENAI_MODEL, onCost);
  const data = parseJSON(text);
  const arr = Array.isArray(data) ? data : (data.concepts || []);
  const headings: string[] = !Array.isArray(data) && Array.isArray(data.headings) ? data.headings : [];

  return {
    headings,
    sourceChunkIds,
    concepts: arr
      .filter((c: Record<string, unknown>) => c.name && c.category)
      .map((c: Record<string, unknown>) => ({
        name: c.name as string,
        category: (c.category as string) || 'Key Term',
        importance: (['high', 'medium', 'low'].includes(c.importance as string)
          ? c.importance as string
          : 'medium') as 'high' | 'medium' | 'low',
        keyFacts: Array.isArray(c.keyFacts)
          ? (c.keyFacts as string[]).filter(f => typeof f === 'string' && f.trim().length > 3).slice(0, 5)
          : [],
        clinicalRelevance: (c.clinicalRelevance as string) || '',
        associations: Array.isArray(c.associations) ? (c.associations as string[]).slice(0, 4) : [],
        aliases: [],
        chunk_ids: sourceChunkIds,
      })),
  };
}

// ─── mergeInventory — verbatim port ──────────────────────────────────────────

interface MergedRawConcept {
  name: string;
  category: string;
  importance: 'high' | 'medium' | 'low';
  keyFacts: string[];
  clinicalRelevance: string;
  associations: string[];
  pageEstimate: string;
  sourceChunkIds: string[];
  coverageDomain: string;
  aliases: string[];
}

export function mergeInventory(
  inventories: InventoryBatch[],
  pdfId: string,
): MergedRawConcept[] {
  const seen = new Map<string, MergedRawConcept & { _chunkIds: string[] }>();
  const impRank: Record<string, number> = { high: 3, medium: 2, low: 1 };

  inventories.forEach(inv => {
    inv.concepts.forEach(c => {
      const key =
        c.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30) +
        '|' +
        (c.category || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 10);

      if (!seen.has(key)) {
        seen.set(key, {
          name: c.name,
          category: c.category,
          importance: c.importance,
          keyFacts: [...(c.keyFacts ?? [])],
          clinicalRelevance: c.clinicalRelevance ?? '',
          associations: [...(c.associations ?? [])],
          aliases: [],
          pageEstimate: '',
          sourceChunkIds: [...(c.chunk_ids ?? [])],
          coverageDomain: '',
          _chunkIds: [...(c.chunk_ids ?? [])],
        });
      } else {
        const ex = seen.get(key)!;

        // Upgrade importance if this occurrence is higher-yield
        if ((impRank[c.importance] ?? 1) > (impRank[ex.importance] ?? 1)) {
          ex.importance = c.importance;
        }

        // Merge arrays, deduplicate, cap size
        const kf = [...new Set([...ex.keyFacts, ...(c.keyFacts ?? [])])].slice(0, 6);
        ex.keyFacts = kf;
        const as = [...new Set([...ex.associations, ...(c.associations ?? [])])].slice(0, 6);
        ex.associations = as;

        if (c.clinicalRelevance) {
          if (!ex.clinicalRelevance) {
            ex.clinicalRelevance = c.clinicalRelevance;
          } else if (!ex.clinicalRelevance.toLowerCase().includes(c.clinicalRelevance.toLowerCase().slice(0, 30))) {
            ex.clinicalRelevance = (ex.clinicalRelevance + ' ' + c.clinicalRelevance).slice(0, 300);
          }
        }

        // Union chunk IDs
        if (c.chunk_ids?.length) {
          ex._chunkIds = [...new Set([...ex._chunkIds, ...c.chunk_ids])];
          ex.sourceChunkIds = ex._chunkIds;
        }
      }
    });
  });

  return [...seen.values()].map(c => ({
    name: c.name,
    category: c.category,
    importance: c.importance,
    keyFacts: c.keyFacts,
    clinicalRelevance: c.clinicalRelevance,
    associations: c.associations,
    aliases: [],
    pageEstimate: c.pageEstimate,
    sourceChunkIds: c._chunkIds,
    coverageDomain: assignCoverageDomain(c.name, c.category),
  }));
}

// ─── canonicalizeConcepts — verbatim port ────────────────────────────────────

export function canonicalizeConcepts(concepts: MergedRawConcept[]): MergedRawConcept[] {
  const impRank: Record<string, number> = { high: 3, medium: 2, low: 1 };
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Step 1: Merge near-duplicates by substring containment within same category
  const used = new Set<number>();
  for (let i = 0; i < concepts.length; i++) {
    if (used.has(i)) continue;
    concepts[i]!.aliases = concepts[i]!.aliases ?? [];
    const ni = norm(concepts[i]!.name);

    for (let j = i + 1; j < concepts.length; j++) {
      if (used.has(j)) continue;
      const nj = norm(concepts[j]!.name);
      const sameCategory = (concepts[i]!.category || '') === (concepts[j]!.category || '');
      const oneContainsOther =
        (ni.includes(nj) || nj.includes(ni)) && Math.min(ni.length, nj.length) >= 4;

      if (oneContainsOther && sameCategory) {
        concepts[i]!.aliases.push(concepts[j]!.name);
        concepts[i]!.keyFacts = [...new Set([...concepts[i]!.keyFacts, ...concepts[j]!.keyFacts])].slice(0, 8);
        concepts[i]!.associations = [...new Set([...concepts[i]!.associations, ...concepts[j]!.associations])].slice(0, 6);
        if ((impRank[concepts[j]!.importance] ?? 1) > (impRank[concepts[i]!.importance] ?? 1)) {
          concepts[i]!.importance = concepts[j]!.importance;
        }
        if (concepts[j]!.clinicalRelevance && !concepts[i]!.clinicalRelevance) {
          concepts[i]!.clinicalRelevance = concepts[j]!.clinicalRelevance;
        }
        used.add(j);
      }
    }
  }
  let result = concepts.filter((_, i) => !used.has(i));

  // Step 2: Prefix-density cap — prevent fragmentation (e.g. 15 "Esophageal X" concepts)
  const maxPerPrefix = 4;
  const prefixGroups = new Map<string, number[]>();
  result.forEach((c, i) => {
    const words = c.name.replace(/[^a-zA-Z0-9 ]/g, '').split(/\s+/).filter(Boolean);
    const prefix = (
      words[0] && words[0].length > 4 ? words[0] : words.slice(0, 2).join(' ')
    ).toLowerCase();
    if (!prefixGroups.has(prefix)) prefixGroups.set(prefix, []);
    prefixGroups.get(prefix)!.push(i);
  });

  const drop = new Set<number>();
  prefixGroups.forEach(indices => {
    if (indices.length <= maxPerPrefix) return;
    indices.sort((a, b) => (impRank[result[b]!.importance] ?? 0) - (impRank[result[a]!.importance] ?? 0));
    indices.slice(maxPerPrefix).forEach(di => {
      result[indices[0]!]!.keyFacts = [...new Set([
        ...result[indices[0]!]!.keyFacts,
        ...result[di]!.keyFacts,
      ])].slice(0, 8);
      result[indices[0]!]!.aliases = [
        ...(result[indices[0]!]!.aliases ?? []),
        result[di]!.name,
        ...(result[di]!.aliases ?? []),
      ];
      drop.add(di);
    });
  });
  result = result.filter((_, i) => !drop.has(i));

  // Step 3: Tag coverage domain
  result.forEach(c => {
    if (!c.coverageDomain) c.coverageDomain = assignCoverageDomain(c.name, c.category);
  });

  return result;
}

// ─── generateConfusionMap — verbatim port ────────────────────────────────────

export async function generateConfusionMap(
  concepts: Array<{ name: string; category: string }>,
  onCost?: OpenAICostTracker,
): Promise<ConfusionMap> {
  const conceptList = concepts.map(c => `- ${c.name} [${c.category}]`).join('\n');

  const prompt = `You are a medical education expert. Given this list of concepts from a single medical chapter, identify pairs that students commonly confuse on board exams.

CONCEPTS:
${conceptList}

For each confusion pair, explain in one sentence WHY students confuse them (similar presentation, overlapping mechanism, similar name, opposing effects, or commonly tested together).
Also provide a short differentiator phrase naming the single clue that separates them.

Rules:
- Only include pairs with genuine, high-yield confusability — concepts a student could realistically mix up
- Maximum 20 pairs
- Do not fabricate pairs that are not genuinely confusable
- Both concepts in each pair must appear in the list above

Return ONLY valid JSON — no markdown, no prose:
[{"conceptA":"exact name from list","conceptB":"exact name from list","reason":"one sentence why confused","differentiator":"short clue separating them"}]`;

  try {
    const { text } = await callOpenAI(prompt, 2048, OPENAI_MODEL, onCost);
    const pairs = parseJSON(text);
    if (!Array.isArray(pairs)) return {};

    const map: ConfusionMap = {};
    pairs
      .filter((p: Record<string, string>) => p.conceptA && p.conceptB && p.reason)
      .forEach((p: Record<string, string>) => {
        if (!map[p.conceptA]) map[p.conceptA] = [];
        if (!map[p.conceptB]) map[p.conceptB] = [];
        map[p.conceptA]!.push({
          concept: p.conceptB,
          reason: p.reason,
          differentiator: p.differentiator,
        });
        map[p.conceptB]!.push({
          concept: p.conceptA,
          reason: p.reason,
          differentiator: p.differentiator,
        });
      });
    return map;
  } catch (e) {
    console.warn('Confusion map generation failed:', (e as Error).message);
    return {};
  }
}

// ─── Concept → Supabase row converter ────────────────────────────────────────

export function toConceptRow(
  merged: MergedRawConcept,
  pdfId:  string,
  userId: string,
): Omit<Concept, 'id' | 'created_at'> {
  return {
    pdf_id:           pdfId,
    user_id:          userId,
    name:             merged.name,
    category:         merged.category,
    importance:       merged.importance,
    summary:          merged.clinicalRelevance || '',
    coverage_domains: [merged.coverageDomain ?? 'other'] as Concept['coverage_domains'],
    chunk_ids:        merged.sourceChunkIds,
    aliases:          merged.aliases ?? [],
    confusion_targets: [],
  };
}
