import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCostTracker } from '@/lib/pipeline/offline-comparison';
import { evalQuestion, aggregateScores, type EvalResult } from '@/lib/pipeline/eval-judge';
import type { Question } from '@/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env.local');

function loadEnvFile() {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const rawValue = trimmed.slice(eqIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

const REF_PATH = 'data/reference-bank.json';
const REPORT_DIR = 'reports';
const GOLD_SET_SIZE = 50;

async function selectGoldenSet(refBank: any[]): Promise<any[]> {
  // Simple stratification: ~16-17 per level (L1/L2/L3) + cross-topic diversity
  const byLevel: Record<string, any[]> = { L1: [], L2: [], L3: [] };
  for (const e of refBank) {
    const level = e.level ?? 'L2';
    byLevel[level]?.push(e);
  }
  const golden = [];
  for (const level of ['L1', 'L2', 'L3']) {
    const shuffled = byLevel[level]?.sort(() => Math.random() - 0.5) ?? [];
    golden.push(...shuffled.slice(0, Math.ceil(GOLD_SET_SIZE / 3)));
  }
  return golden.slice(0, GOLD_SET_SIZE);
}

async function main() {
  loadEnvFile();
  console.log('Loading reference bank...');
  const refBank = JSON.parse(await fsp.readFile(REF_PATH, 'utf8'));
  console.log(`Loaded ${refBank.length} reference entries`);

  const golden = await selectGoldenSet(refBank);
  console.log(`Selected ${golden.length} for golden eval set`);
  console.log(`Levels: L1=${golden.filter((e: any) => e.level === 'L1').length} L2=${golden.filter((e: any) => e.level === 'L2').length} L3=${golden.filter((e: any) => e.level === 'L3').length}`);

  const results: EvalResult[] = [];
  const tracker = createCostTracker();

  console.log(`\nEvaluating ${golden.length} questions...`);
  console.log(`Estimated cost: ~$${(golden.length * 0.03).toFixed(2)} (3¢/eval)\n`);

  for (let i = 0; i < golden.length; i++) {
    const ref = golden[i];
    process.stdout.write(`  [${i + 1}/${golden.length}] ${ref.topic} (${ref.level})... `);
    try {
      // For this MVP, just evaluate the reference question as a generated question
      // (In full implementation, extract concept and run through generation pipeline)
      const generated: Question = {
        stem: ref.stem,
        options: ref.options.map((o: any) => o.text),
        correctOptionIndex: ref.options.findIndex((o: any) => o.letter === ref.correctLetter),
        explanation: ref.explanation,
        evidence: ref.citation,
        itemType: ref.level === 'L1' ? 'definition' : ref.level === 'L2' ? 'mechanism' : 'vignette',
      };

      const scores = await evalQuestion(ref, generated, tracker.recordCost);
      const result: EvalResult = {
        generatedId: `golden_${ref.id}`,
        referenceId: ref.id,
        scores: {
          stemQuality: scores.stemQuality,
          distractorCompetitiveness: scores.distractorCompetitiveness,
          explanationDepth: scores.explanationDepth,
          evidenceGrounding: scores.evidenceGrounding,
        },
        rationale: scores.rationale,
      };
      results.push(result);
      console.log(`OK`);
    } catch (err) {
      console.log(`ERROR: ${(err as Error).message}`);
    }
  }

  console.log(`\nEvaluated ${results.length}/${golden.length} entries`);

  await fsp.mkdir(REPORT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().split('T')[0];
  const reportPath = path.join(REPORT_DIR, `eval-${timestamp}.json`);
  await fsp.writeFile(
    reportPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        goldenSetSize: golden.length,
        results,
        aggregate: aggregateScores(results),
        costUSD: tracker.getTotalCostUSD(),
      },
      null,
      2,
    ),
  );
  console.log(`\nReport written to ${reportPath}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
