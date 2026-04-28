function normalize(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function similarity(a: string, b: string) {
  const aw = new Set(normalize(a).split(' ').filter(Boolean));
  const bw = new Set(normalize(b).split(' ').filter(Boolean));
  if (!aw.size || !bw.size) return 0;
  let overlap = 0;
  aw.forEach(word => { if (bw.has(word)) overlap += 1; });
  return overlap / Math.max(aw.size, bw.size);
}

export function simplifyExplanation(explanation: string, answerText: string): string {
  const answer = answerText.trim();
  const text = explanation.trim();
  if (!answer || !text) return text;

  const normalizedText = normalize(text);
  const normalizedAnswer = normalize(answer);
  if (normalizedText.startsWith(normalizedAnswer)) {
    const remainder = text.slice(answer.length).replace(/^[:\s,.;-]+/, '').trim();
    return remainder ? `This is correct because: ${remainder}` : `Why this answer? ${answer}.`;
  }

  const firstSentence = text.split(/(?<=[.!?])\s+/)[0] ?? text;
  if (similarity(firstSentence, answer) >= 0.8) {
    const remainder = text.slice(firstSentence.length).replace(/^[:\s,.;-]+/, '').trim();
    return remainder ? `This is correct because: ${remainder}` : `Why this answer? ${answer}.`;
  }

  return text;
}
