import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCostTracker } from '@/lib/pipeline/offline-comparison';
import { callOpenAI, parseJSON } from '@/lib/pipeline/generation';

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

type ConfusionPair = {
  topic: string;
  correct_concept: string;
  confusable_with: Array<{
    concept: string;
    reason: string;
  }>;
};

const REF_PATH = 'data/reference-bank.json';
const OUT_PATH = 'data/confusion-pairs.json';

async function extractConfusableReasons(
  ref: any,
  onCost: (cost: number) => void,
): Promise<Array<{ concept: string; reason: string }>> {
  const prompt = `You are analyzing why incorrect answer options are tempting in medical exam questions.

CORRECT ANSWER: ${ref.options[ref.options.findIndex((o: any) => o.letter === ref.correctLetter)].text}

DISTRACTORS:
${ref.options
  .filter((o: any) => o.letter !== ref.correctLetter)
  .map((o: any) => `${o.letter}) ${o.text}`)
  .join('\n')}

CONTEXT: ${ref.explanation}

For each distractor, output JSON with: the concept being confused (1-3 words) and a 1-sentence reason why it's tempting.

Output strictly this JSON:
{"confusable": [
  {"concept": "<concept>", "reason": "<1 sentence>"},
  ...
]}`;

  try {
    const { text } = await callOpenAI(prompt, 512, 'gpt-4o-mini', onCost, {
      temperature: 0,
    });
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    const parsed = parseJSON(jsonMatch[0]) as { confusable?: Array<{ concept: string; reason: string }> };
    return parsed.confusable ?? [];
  } catch (err) {
    console.error(`  Error extracting confusable concepts for "${ref.topic}": ${(err as Error).message}`);
    return [];
  }
}

async function main() {
  loadEnvFile();
  console.log('Loading reference bank...');
  const refBank = JSON.parse(await fsp.readFile(REF_PATH, 'utf8'));
  console.log(`Loaded ${refBank.length} reference entries\n`);

  const pairs: ConfusionPair[] = [];
  const tracker = createCostTracker();
  const topicMap = new Map<string, ConfusionPair>();

  console.log(`Mining confusable concepts from ${refBank.length} questions...`);
  console.log(`Estimated cost: ~$${(refBank.length * 0.01).toFixed(2)} (1¢/extraction)\n`);

  for (let i = 0; i < refBank.length; i++) {
    const ref = refBank[i];
    process.stdout.write(`  [${i + 1}/${refBank.length}] ${ref.topic}... `);

    const confusable = await extractConfusableReasons(ref, tracker.recordCost);
    console.log(`${confusable.length} distractors`);

    // Aggregate by topic: one confusion-pair entry per topic
    if (!topicMap.has(ref.topic)) {
      topicMap.set(ref.topic, {
        topic: ref.topic,
        correct_concept: ref.stem.split(' ').slice(0, 5).join(' '),
        confusable_with: [],
      });
    }

    const pair = topicMap.get(ref.topic)!;
    for (const c of confusable) {
      // Avoid duplicates within a topic
      if (!pair.confusable_with.some(x => x.concept === c.concept)) {
        pair.confusable_with.push(c);
      }
    }
  }

  const confusion_pairs = Array.from(topicMap.values());
  await fsp.writeFile(OUT_PATH, JSON.stringify(confusion_pairs, null, 2));
  console.log(`\nWrote ${confusion_pairs.length} confusion-pair groups to ${OUT_PATH}`);
  console.log(`Total cost: $${tracker.getTotalCostUSD().toFixed(4)}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
