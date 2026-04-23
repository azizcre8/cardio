import fs from 'node:fs/promises';
import path from 'node:path';

import {
  renderComparisonMarkdown,
  runOfflineComparison,
  type ComparisonRunnerSelection,
} from '@/lib/pipeline/offline-comparison';
import type { Density } from '@/types';

interface ParsedArgs {
  pdfPath: string;
  conceptCount: number;
  runner: ComparisonRunnerSelection;
  density: Density;
  outputDir: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let runner: ComparisonRunnerSelection = 'both';
  let density: Density = 'standard';
  let outputDir: string | null = null;
  let conceptCount = 12;

  for (const arg of argv) {
    if (arg.startsWith('--runner=')) {
      const value = arg.slice('--runner='.length);
      if (value === 'current' || value === 'simplified' || value === 'both') runner = value;
      continue;
    }
    if (arg.startsWith('--density=')) {
      const value = arg.slice('--density='.length);
      if (value === 'standard' || value === 'comprehensive' || value === 'boards') density = value;
      continue;
    }
    if (arg.startsWith('--out-dir=')) {
      outputDir = arg.slice('--out-dir='.length);
      continue;
    }
    positional.push(arg);
  }

  const pdfPath = positional[0];
  if (!pdfPath) {
    throw new Error('Usage: tsx scripts/compare-generation.ts <pdf-path> [concept-count] [--runner=current|simplified|both] [--density=standard|comprehensive|boards] [--out-dir=<dir>]');
  }

  if (positional[1]) {
    const parsed = Number.parseInt(positional[1], 10);
    if (Number.isFinite(parsed) && parsed > 0) conceptCount = parsed;
  }

  return { pdfPath, conceptCount, runner, density, outputDir };
}

function slugifyFileStem(filePath: string): string {
  return path.basename(filePath, path.extname(filePath))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const bundle = await runOfflineComparison({
    pdfPath: parsed.pdfPath,
    conceptCount: parsed.conceptCount,
    density: parsed.density,
    runner: parsed.runner,
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = slugifyFileStem(parsed.pdfPath);
  const outputDir = parsed.outputDir
    ? path.resolve(parsed.outputDir)
    : path.resolve(process.cwd(), 'reports', `compare-${slug}-${timestamp}`);

  await fs.mkdir(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, 'comparison.json');
  const mdPath = path.join(outputDir, 'comparison.md');

  await fs.writeFile(jsonPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  await fs.writeFile(mdPath, `${renderComparisonMarkdown(bundle)}\n`, 'utf8');

  console.log(JSON.stringify({
    outputDir,
    jsonPath,
    markdownPath: mdPath,
    results: bundle.results.map(result => ({
      runner: result.runner,
      acceptedQuestions: result.acceptedQuestions,
      rejectedQuestions: result.rejectedQuestions,
      dedupedQuestions: result.dedupedQuestions,
      acceptanceRate: result.acceptanceRate,
      openaiCostUSD: result.openaiCostUSD,
    })),
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
