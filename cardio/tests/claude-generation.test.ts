import { describe, expect, it } from 'vitest';
import { isStemCopiedFromSourceText, parseClaudeJson, toQuestion } from '@/lib/pipeline/claude-generation';

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

describe('Claude generation source guards', () => {
  const copiedStem = 'Autopsy shows that the thoracic aorta has a dilated root and arch, giving the intimal surface a "tree-bark" appearance. Microscopic examination of the aorta shows an obliterative endarteritis of the vasa vasorum. Which of the following laboratory findings is most likely to be recorded?';
  const sourceText = [
    '27 A 77-year-old man has had progressive dementia and gait ataxia for the past 9 years.',
    'Autopsy shows that the thoracic aorta has a dilated root and arch, giving the intimal surface a "tree-bark" appear - ance.',
    'Microscopic examination of the aorta shows an oblitera - tive endarteritis of the vasa vasorum.',
    'Which of the following laboratory findings is most likely to be recorded in this patient medical history?',
    'A Antibodies against Treponema pallidum B Double-stranded DNA titer positive at 1:512',
    'Syphilitic aortitis is a complication of tertiary syphilis with characteristic involvement of the thoracic aorta.',
  ].join(' ');

  it('detects generated stems copied from embedded source MCQs despite PDF hyphenation artifacts', () => {
    expect(isStemCopiedFromSourceText(copiedStem, sourceText)).toBe(true);
  });

  it('flags copied source MCQ stems even when the evidence quote itself is valid', () => {
    const question = toQuestion(
      {
        level: 2,
        topic: 'Syphilitic aortitis',
        stem: copiedStem,
        options: ['Treponemal antibodies', 'High dsDNA titer', 'Marked ketonuria', 'Positive P-ANCA'],
        answer: 0,
        source_quote: 'Syphilitic aortitis is a complication of tertiary syphilis with characteristic involvement of the thoracic aorta.',
        explanation: 'Treponemal antibodies are correct because syphilitic aortitis reflects tertiary syphilis. High dsDNA titer points to lupus rather than syphilitic aortitis.',
      },
      sourceText,
      'pdf-1',
      'user-1',
    );

    expect(question.flagged).toBe(true);
    expect(question.flag_reason).toBe('SOURCE_STEM_COPY');
  });

  it('flags source quotes that are embedded MCQ option lists rather than explanatory prose', () => {
    const question = toQuestion(
      {
        level: 2,
        topic: 'Syphilitic aortitis',
        stem: 'Which serologic pattern supports tertiary syphilitic aortitis?',
        options: ['Treponemal antibodies', 'High dsDNA titer', 'Marked ketonuria', 'Positive P-ANCA'],
        answer: 0,
        source_quote: 'Which of the following laboratory findings is most likely to be recorded in this patient medical history? A Antibodies against Treponema pallidum B Double-stranded DNA titer positive at 1:512',
        explanation: 'Treponemal antibodies are correct because they support tertiary syphilis. High dsDNA titer supports lupus instead.',
      },
      sourceText,
      'pdf-1',
      'user-1',
    );

    expect(question.flagged).toBe(true);
    expect(question.flag_reason).toBe('SOURCE_QUOTE_INVALID');
  });
});
