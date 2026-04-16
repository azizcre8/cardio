import type { DensityConfig, ChunkRecord } from '@/types';
import type { OpenAICostTracker } from '@/lib/openai-cost';
import { extractInventory, type InventoryBatch } from './inventory';

const INVENTORY_BATCH_SIZE = 3;

export interface InventoryBatchWarning {
  batchIndex: number;
  chunkIds: string[];
  message: string;
}

export function isOpenAIAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes('incorrect api key') || normalized.includes('invalid api key') || normalized.includes('401');
}

export function summarizePipelineFailure(messages: string[]): string | null {
  if (!messages.length) return null;
  if (messages.some(message => isOpenAIAuthError(message))) {
    return 'OpenAI authentication failed. Check OPENAI_API_KEY in cardio/.env.local and restart the dev server.';
  }
  return null;
}

export async function extractInventoriesResilient(
  chunkRecords: ChunkRecord[],
  dc: DensityConfig,
  onCost?: OpenAICostTracker,
): Promise<{ inventories: InventoryBatch[]; warnings: InventoryBatchWarning[] }> {
  const inventories: InventoryBatch[] = [];
  const warnings: InventoryBatchWarning[] = [];
  const totalBatches = Math.ceil(chunkRecords.length / INVENTORY_BATCH_SIZE);

  for (let b = 0; b < chunkRecords.length; b += INVENTORY_BATCH_SIZE) {
    const batch = chunkRecords.slice(b, b + INVENTORY_BATCH_SIZE);
    const batchIndex = Math.floor(b / INVENTORY_BATCH_SIZE);

    try {
      const inv = await extractInventory(batch, dc, batchIndex, totalBatches, onCost);
      inventories.push(inv);
    } catch (error) {
      if (isOpenAIAuthError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      warnings.push({
        batchIndex,
        chunkIds: batch.map(chunk => chunk.id),
        message,
      });
    }
  }

  return { inventories, warnings };
}

export function buildGenerationBatchFailureFlags(
  batch: Array<{ id: string; name: string }>,
  error: unknown,
): Array<{ reason: string; raw_json: Record<string, unknown> }> {
  const message = error instanceof Error ? error.message : String(error);
  const safeMessage = message || 'Unknown generation error';

  return batch.map(concept => ({
    reason: `GENERATION_BATCH_FAILED: ${safeMessage}`,
    raw_json: {
      conceptId: concept.id,
      conceptName: concept.name,
      error: safeMessage,
    },
  }));
}

export function sortConceptsByImportanceAndName<T extends { importance: string; name: string }>(
  concepts: T[],
): T[] {
  const importanceOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  return [...concepts].sort((a, b) => {
    const importanceDiff = (importanceOrder[a.importance] ?? 2) - (importanceOrder[b.importance] ?? 2);
    if (importanceDiff !== 0) return importanceDiff;
    return a.name.localeCompare(b.name);
  });
}
