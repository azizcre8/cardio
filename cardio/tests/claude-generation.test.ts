import { describe, expect, it } from 'vitest';
import { parseClaudeJson } from '@/lib/pipeline/claude-generation';

describe('parseClaudeJson', () => {
  it('parses a valid JSON array', () => {
    expect(parseClaudeJson('[{"stem":"What is preload?","answer":0}]')).toEqual([
      { stem: 'What is preload?', answer: 0 },
    ]);
  });

  it('parses a JSON array wrapped in markdown fences', () => {
    const text = '```json\n[{"stem":"What raises afterload?","answer":1}]\n```';

    expect(parseClaudeJson(text)).toEqual([
      { stem: 'What raises afterload?', answer: 1 },
    ]);
  });

  it('repairs unquoted property names', () => {
    expect(parseClaudeJson('[{stem:"What increases stroke volume?", answer:0}]')).toEqual([
      { stem: 'What increases stroke volume?', answer: 0 },
    ]);
  });

  it('repairs trailing commas', () => {
    expect(parseClaudeJson('[{"stem":"What lowers preload?","answer":2},]')).toEqual([
      { stem: 'What lowers preload?', answer: 2 },
    ]);
  });

  it('repairs single-quoted strings', () => {
    expect(parseClaudeJson("[{'stem':'What increases contractility?','answer':3}]")).toEqual([
      { stem: 'What increases contractility?', answer: 3 },
    ]);
  });

  it('extracts an array after preamble text', () => {
    const text = 'Here are the requested questions:\n[{"stem":"What raises venous return?","answer":0}]';

    expect(parseClaudeJson(text)).toEqual([
      { stem: 'What raises venous return?', answer: 0 },
    ]);
  });

  it('recovers from a truncated response (unterminated string)', () => {
    const truncated = '[{"level": 1, "topic": "Heart failure", "stem": "Which mechanism?", "options": ["A", "B", "C", "D"], "answer": 0, "source_quote": "Increased pulmonary venous pressure causes dyspnea in heart failure.", "explanation": "This is a very long explanation that got cut';

    const result = parseClaudeJson(truncated);

    expect(result).toHaveLength(1);
    expect(result[0]?.level).toBe(1);
  });

  it('recovers from unescaped quotes inside string values', () => {
    const withBadQuotes = '[{"level": 1, "topic": "Heart failure", "stem": "Which test is "gold standard"?", "options": ["A", "B", "C", "D"], "answer": 0, "source_quote": "Increased pulmonary venous pressure causes dyspnea in heart failure.", "explanation": "This is a short explanation."}]';

    const result = parseClaudeJson(withBadQuotes);

    expect(result).toHaveLength(1);
  });

  it('throws the first parse error for invalid input', () => {
    expect(() => parseClaudeJson('not JSON at all')).toThrow(SyntaxError);
  });
});
