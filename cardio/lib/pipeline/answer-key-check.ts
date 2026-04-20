export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripOptionLabel(text: string): string {
  return text.replace(/^\s*[A-Ea-e][.)]\s*/, '').trim();
}

export function normalizeOptionAlias(text: string): string {
  return normalizeText(stripOptionLabel(text));
}

export function singularizeToken(token: string): string {
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('ses') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss') && token.length > 3) return token.slice(0, -1);
  return token;
}

export function buildOptionAliases(option: string): string[] {
  const aliases = new Set<string>();
  const cleaned = stripOptionLabel(option);
  const normalized = normalizeOptionAlias(cleaned);
  if (normalized) aliases.add(normalized);

  const noParens = cleaned.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const normalizedNoParens = normalizeText(noParens);
  if (normalizedNoParens) aliases.add(normalizedNoParens);

  for (const match of cleaned.matchAll(/\(([^)]+)\)/g)) {
    const inner = normalizeText(match[1] ?? '');
    if (inner) aliases.add(inner);
  }

  for (const alias of Array.from(aliases)) {
    const singular = alias
      .split(' ')
      .map(singularizeToken)
      .join(' ')
      .trim();
    if (singular) aliases.add(singular);
  }

  return Array.from(aliases).filter(Boolean);
}

export function explanationMentionsAlias(explanation: string, alias: string): boolean {
  if (!alias) return false;
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(explanation);
}

export function detectExplanationAnswerMismatch(
  options: string[],
  answer: number,
  explanation: string,
): string | null {
  const normalizedExplanation = normalizeText(explanation);
  if (!normalizedExplanation) return null;

  const firstSentence = explanation.split(/(?<=[.!?])\s+/)[0] ?? explanation;
  const normalizedFirstSentence = normalizeText(firstSentence);
  const positiveCue = /\b(is correct|correct because|best answer|primarily responsible|primarily explains|directly affects|defined as|refers to)\b/i;
  const negativeCue = /\b(tempting|fails because|incorrect|wrong|whereas|however|unlike|in contrast|not because)\b/i;

  const optionMatches = options.map((option, idx) => {
    const aliases = buildOptionAliases(option);
    const mentionedInExplanation = aliases.some(alias => explanationMentionsAlias(normalizedExplanation, alias));
    const mentionedEarly = aliases.some(alias => explanationMentionsAlias(normalizedFirstSentence, alias));
    const startsExplanation = aliases.some(alias => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      return new RegExp(`^${escaped}\\b`, 'i').test(normalizedFirstSentence);
    });
    return { idx, option, mentionedInExplanation, mentionedEarly, startsExplanation };
  });

  const correctMatch = optionMatches[answer];
  if (!correctMatch) return null;

  const incorrectLead = optionMatches.find(match =>
    match.idx !== answer &&
    (match.startsExplanation || (match.mentionedEarly && positiveCue.test(firstSentence))) &&
    !negativeCue.test(firstSentence),
  );

  if (incorrectLead && !correctMatch.mentionedEarly) {
    return `Explanation appears to justify a different answer choice than the keyed correct answer (${incorrectLead.option}).`;
  }

  const correctAliases = buildOptionAliases(options[answer] ?? '');
  const correctMentioned = correctAliases.some(alias =>
    explanationMentionsAlias(normalizedExplanation, alias),
  );
  if (!correctMentioned && normalizedExplanation.length > 20) {
    const incorrectTokenCounts = options
      .map((opt, idx) => {
        if (idx === answer) return { idx, count: 0 };
        const aliases = buildOptionAliases(opt);
        const count = aliases.filter(a => explanationMentionsAlias(normalizedExplanation, a)).length;
        return { idx, count };
      })
      .sort((a, b) => b.count - a.count);
    if ((incorrectTokenCounts[0]?.count ?? 0) > 0) {
      const dominantIdx = incorrectTokenCounts[0]!.idx;
      return `Explanation appears to justify a different answer choice than the keyed correct answer (${options[dominantIdx]}).`;
    }
  }

  return null;
}

function buildConceptAliases(conceptName: string, keyFacts: string[]): string[] {
  const aliases = new Set<string>();
  for (const value of [conceptName, ...keyFacts]) {
    const normalized = normalizeText(value);
    if (normalized) aliases.add(normalized);
    const normalizedTokens = normalized.split(' ').filter(Boolean);
    if (value === conceptName && normalizedTokens.length > 1) {
      const tailToken = normalizedTokens[normalizedTokens.length - 1] ?? '';
      if (tailToken.length >= 4) aliases.add(tailToken);
    }

    for (const match of value.matchAll(/\(([^)]+)\)/g)) {
      const inner = normalizeText(match[1] ?? '');
      if (inner) aliases.add(inner);
    }
  }

  for (const alias of Array.from(aliases)) {
    const singular = alias
      .split(' ')
      .map(singularizeToken)
      .join(' ')
      .trim();
    if (singular) aliases.add(singular);
  }

  return Array.from(aliases).filter(alias => alias.length >= 2);
}

function textContainsAlias(text: string, alias: string): boolean {
  return explanationMentionsAlias(normalizeText(text), alias);
}

export function detectConceptMismatch(
  stem: string,
  keyedOption: string,
  conceptName: string,
  keyFacts: string[],
): string | null {
  const conceptAliases = buildConceptAliases(conceptName, keyFacts);
  if (!conceptAliases.length) return null;

  const supported = conceptAliases.some(alias =>
    textContainsAlias(stem, alias) || textContainsAlias(keyedOption, alias),
  );

  if (supported) return null;

  return `Stem and keyed answer do not mention the target concept or any accepted alias for ${conceptName}.`;
}
