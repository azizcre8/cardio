import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    rpc: vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'match_chunks RPC failed: function public.match_chunks does not exist' },
    }),
  },
}));

describe('retrieveTopChunks', () => {
  it('falls back to BM25 when dense retrieval is unavailable', async () => {
    const { buildBM25Index, retrieveTopChunks } = await import('@/lib/pipeline/retrieval');

    const chunks = [
      {
        id: 'c1',
        pdf_id: 'pdf-1',
        text: 'venous compliance determines how veins store large blood volumes',
        start_page: 1,
        end_page: 1,
        headers: [],
        word_count: 9,
        embedding: [0.1, 0.2],
      },
      {
        id: 'c2',
        pdf_id: 'pdf-1',
        text: 'arterioles primarily regulate total peripheral resistance',
        start_page: 2,
        end_page: 2,
        headers: [],
        word_count: 7,
        embedding: [0.2, 0.3],
      },
    ];

    const bm25Index = buildBM25Index(chunks);
    const results = await retrieveTopChunks(
      'pdf-1',
      [0.01, 0.02],
      'venous compliance blood volume',
      bm25Index,
      chunks,
      1,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('c1');
  });
});
