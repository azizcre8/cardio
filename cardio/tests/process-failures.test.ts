import { describe, expect, it } from 'vitest';
import { isOpenAIAuthError, summarizePipelineFailure } from '@/lib/pipeline/process-helpers';

describe('pipeline failure summaries', () => {
  it('detects invalid openai api key errors', () => {
    expect(isOpenAIAuthError(new Error('401 Incorrect API key provided: sk-xxxx'))).toBe(true);
    expect(isOpenAIAuthError(new Error('network timeout'))).toBe(false);
  });

  it('turns auth failures into a user-facing pipeline error', () => {
    expect(
      summarizePipelineFailure([
        '401 Incorrect API key provided: sk-xxxx',
      ]),
    ).toContain('OpenAI authentication failed');
  });
});
