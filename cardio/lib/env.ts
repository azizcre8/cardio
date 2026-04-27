function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function isEnabled(name: string, defaultValue = true): boolean {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  return value !== 'false';
}

export const env = {
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000',
  supabaseUrl: required('NEXT_PUBLIC_SUPABASE_URL'),
  supabaseAnonKey: required('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
  GENERATION_MODEL: process.env.GENERATION_MODEL ?? 'claude-sonnet-4-5',
  openAiApiKey: process.env.OPENAI_API_KEY ?? '',
  stripeSecretKey: () => required('STRIPE_SECRET_KEY'),
  stripeWebhookSecret: () => required('STRIPE_WEBHOOK_SECRET'),
  stripeStudentPriceId: () => required('STRIPE_STUDENT_PRICE_ID'),
  stripeBoardsPriceId: () => required('STRIPE_BOARDS_PRICE_ID'),
  flags: {
    textQualityCheck: isEnabled('ENABLE_TEXT_QUALITY_CHECK'),
    evidenceGating: isEnabled('ENABLE_EVIDENCE_GATING'),
    hybridRetrieval: isEnabled('ENABLE_HYBRID_RETRIEVAL'),
    confusionDistractors: isEnabled('ENABLE_CONFUSION_DISTRACTORS'),
    structuralChunking: isEnabled('ENABLE_STRUCTURAL_CHUNKING'),
    fuzzyEvidenceMatch: isEnabled('ENABLE_FUZZY_EVIDENCE_MATCH'),
    negativeRag: isEnabled('ENABLE_NEGATIVE_RAG'),
    l3GroundingGuard: isEnabled('ENABLE_L3_GROUNDING_GUARD'),
    dynamicModelRouting: isEnabled('ENABLE_DYNAMIC_MODEL_ROUTING'),
    strictQuestionValidation: isEnabled('ENABLE_STRICT_QUESTION_VALIDATION'),
    structuredConfusionMap: isEnabled('ENABLE_STRUCTURED_CONFUSION_MAP'),
    distractorCandidatePool: isEnabled('ENABLE_DISTRACTOR_CANDIDATE_POOL'),
    slotBasedGeneration: isEnabled('ENABLE_SLOT_BASED_GENERATION'),
  },
} as const;
