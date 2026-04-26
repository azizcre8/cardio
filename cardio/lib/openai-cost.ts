type OpenAIUsageLike = {
  prompt_tokens?: number | null;
  input_tokens?: number | null;
  completion_tokens?: number | null;
  output_tokens?: number | null;
};

export type OpenAIPricedModel = 'gpt-4o' | 'gpt-4o-mini' | 'text-embedding-3-small';

export const OPENAI_MODEL_PRICING_USD_PER_MILLION: Record<OpenAIPricedModel, { input: number; output: number }> = {
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
};

export type OpenAICostEvent = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
};

export type OpenAICostTracker = (event: OpenAICostEvent) => void | Promise<void>;

export function roundUsdAmount(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function calculateOpenAICostUSD(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = OPENAI_MODEL_PRICING_USD_PER_MILLION[model as OpenAIPricedModel];
  if (!pricing) return 0;

  return roundUsdAmount(
    (Math.max(0, inputTokens) / 1_000_000) * pricing.input +
    (Math.max(0, outputTokens) / 1_000_000) * pricing.output,
  );
}

export function calculateOpenAIUsageCostUSD(model: string, usage: OpenAIUsageLike | null | undefined): OpenAICostEvent {
  const inputTokens = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0);
  const outputTokens = Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0);

  return {
    model,
    inputTokens,
    outputTokens,
    costUSD: calculateOpenAICostUSD(model, inputTokens, outputTokens),
  };
}
