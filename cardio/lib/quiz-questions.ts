export const QUIZ_QUESTION_SELECT = `
  id,
  pdf_id,
  stem,
  options,
  answer,
  explanation,
  source_quote,
  level,
  concept_id,
  chunk_id,
  evidence_start,
  evidence_end,
  evidence_match_type,
  decision_target,
  deciding_clue,
  most_tempting_distractor,
  option_set_flags,
  concepts(name),
  pdfs(name, display_name)
`;

export function flattenQuizQuestion(row: Record<string, unknown>) {
  const { concepts, pdfs, ...rest } = row;
  const pdf = pdfs as { name?: string | null; display_name?: string | null } | null;

  return {
    ...rest,
    concept_name: (concepts as { name?: string } | null)?.name ?? undefined,
    source_name: pdf?.display_name ?? pdf?.name?.replace(/\.pdf$/i, '') ?? undefined,
  };
}

export function shuffleInPlace<T>(items: T[], random = Math.random) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const current = items[i]!;
    items[i] = items[j]!;
    items[j] = current;
  }
  return items;
}
