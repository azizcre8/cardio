// ─── Enums / Union Types ──────────────────────────────────────────────────────

export type PlanTier = 'free' | 'student' | 'boards' | 'institution';

export type Density = 'standard' | 'comprehensive' | 'boards';

export type ImportanceLevel = 'high' | 'medium' | 'low';

export type QuestionLevel = 1 | 2 | 3;

export type MasteryStatus = 'new' | 'learning' | 'reviewing' | 'mastered';

export type SharedBankVisibility = 'private' | 'invite_only' | 'public';

export type SharedBankMemberRole = 'owner' | 'member';

export type CoverageDomain =
  | 'pathophysiology'
  | 'pharmacology'
  | 'diagnosis'
  | 'treatment'
  | 'anatomy'
  | 'physiology'
  | 'microbiology'
  | 'other';

export type StudyBucket = 'srs' | 'weak' | 'medium' | 'new';

export type TextQuality = 'ok' | 'poor' | 'empty';

// ─── Plan Limits ──────────────────────────────────────────────────────────────

export interface PlanLimits {
  pdfsPerMonth: number | null; // null = unlimited
  maxQuestionsPerPdf: number;
}

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free:        { pdfsPerMonth: 2,    maxQuestionsPerPdf: 50  },
  student:     { pdfsPerMonth: 20,   maxQuestionsPerPdf: 300 },
  boards:      { pdfsPerMonth: null, maxQuestionsPerPdf: 500 },
  institution: { pdfsPerMonth: null, maxQuestionsPerPdf: 500 },
};

// ─── Database Row Types ───────────────────────────────────────────────────────

export interface Deck {
  id: string;                   // uuid
  user_id: string;              // uuid → auth.users
  parent_id: string | null;     // uuid → decks.id (null = root)
  name: string;
  is_exam_block: boolean;
  due_date: string | null;      // ISO timestamp — required when is_exam_block = true
  position: number;
  created_at: string;
  updated_at: string;
  // Populated by get_deck_tree RPC (not stored)
  depth?: number;
}

/** Client-side tree node — built from the flat Deck list */
export interface DeckNode extends Deck {
  children: DeckNode[];
  ownPdfCount: number;    // PDFs directly in this deck
  totalPdfCount: number;  // PDFs in this deck + all descendant decks
}

export interface PDF {
  id: string;                   // uuid
  user_id: string;              // uuid → auth.users
  name: string;
  page_count: number;
  density: Density;
  created_at: string;           // ISO timestamp
  processed_at: string | null;
  processing_cost_usd: number | null;
  concept_count: number | null;
  question_count: number | null;
  // Deck membership (added in migration 004)
  deck_id: string | null;
  display_name: string | null;
  position: number;
  access_scope?: 'owned' | 'shared';
  shared_bank_id?: string | null;
  shared_bank_title?: string | null;
  shared_bank_slug?: string | null;
  shared_bank_visibility?: SharedBankVisibility | null;
  // Pipeline state stored between prepare and generate calls (migration 008)
  concept_specs?: unknown[] | null;
  confusion_map?: Record<string, unknown> | null;
  effective_max_questions?: number | null;
}

export interface SharedBank {
  id: string;
  owner_user_id: string;
  source_pdf_id: string | null;
  source_deck_id: string | null;
  title: string;
  description: string | null;
  slug: string;
  visibility: SharedBankVisibility;
  is_active: boolean;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  source_pdf?: PDF | null;
  source_deck?: Deck | null;
  source_pdfs?: PDF[];
  membership_role?: SharedBankMemberRole | null;
  membership_joined_at?: string | null;
}

export interface SharedBankMember {
  id: string;
  shared_bank_id: string;
  user_id: string;
  role: SharedBankMemberRole;
  joined_at: string;
}

export interface JoinedSharedBankNotice {
  slug: string;
  title: string;
  sourceCount: number;
  questionCount: number;
  firstPdfId: string | null;
}

export type PDFJobStatus = 'processing' | 'completed' | 'failed';

export interface PDFJob {
  id: string;
  user_id: string;
  pdf_id: string;
  pdf_name: string;
  page_count: number | null;
  question_count: number | null;
  concept_count: number | null;
  density: Density;
  plan_name: string;
  status: PDFJobStatus;
  started_at: string;
  finished_at: string | null;
  openai_cost_usd: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface Concept {
  id: string;                   // uuid
  pdf_id: string;               // uuid → pdfs
  user_id: string;
  name: string;
  category: string;
  importance: ImportanceLevel;
  summary: string;
  coverage_domains: CoverageDomain[];
  chunk_ids: string[];          // source chunk ids
  aliases: string[];
  confusion_targets: string[];  // names of concepts easily confused with this one
  created_at: string;
}

export interface Chunk {
  id: string;                   // text key, e.g. "{pdfId}_chunk_{i}"
  pdf_id: string;
  user_id: string;
  text: string;
  start_page: number;
  end_page: number;
  headers: string[];
  word_count: number;
  embedding: number[] | null;   // vector(512); null before embed step
  created_at: string;
}

/** Question row — SRS fields are stored separately in srs_state; they are
 *  merged onto this object at the API boundary before returning to the client. */
export interface Question {
  id: string;
  pdf_id: string;
  concept_id: string | null;
  user_id: string;
  level: QuestionLevel;

  // Content
  stem: string;
  options: string[];            // L1 uses 5 options (A-E); L2/L3 use 4 options (A-D)
  answer: number;               // 0-indexed correct option
  explanation: string;
  option_explanations: string[] | null; // per-distractor explanations, generated lazily
  source_quote: string;
  concept_name?: string;
  evidence_start: number | null;
  evidence_end: number | null;
  chunk_id: string | null;

  // Evidence match metadata
  evidence_match_type: 'exact' | 'normalized' | 'fuzzy' | 'none' | null;

  // Item design metadata
  decision_target: string | null;
  deciding_clue: string | null;
  most_tempting_distractor: string | null;
  why_tempting: string | null;
  why_fails: string | null;

  // Programmatic flags
  option_set_flags: string[] | null;

  // Flags
  flagged: boolean;
  flag_reason: string | null;

  created_at: string;

  // SRS fields (optional — merged from srs_state; undefined when not yet reviewed)
  interval?: number;            // days until next review
  ease_factor?: number;
  repetitions?: number;
  next_review?: string;         // ISO timestamp
  last_reviewed?: string;       // ISO timestamp
  times_reviewed?: number;
  times_correct?: number;
  times_incorrect?: number;
  quality_history?: number[];
}

export interface WaitlistSubmission {
  id: string;
  user_id: string;
  email: string;
  use_case: string;
  created_at: string;
}

export interface FlaggedQuestionRow {
  question_id: string;
  pdf_id: string;
  stem: string;
  answer_text: string;
  level: QuestionLevel;
  pdf_name: string;
  flag_reason: string | null;
  source: 'question_flag' | 'srs_quality';
}

export interface AllQuestionRow {
  id: string;
  pdf_id: string;
  stem: string;
  options: string[];
  answer: number;
  answer_text: string;
  explanation: string;
  level: QuestionLevel;
  flagged: boolean;
  flag_reason: string | null;
  pdf_name: string;
}

export interface FactCheckResult {
  medicallyAccurate: boolean;
  sourcedFromText: boolean;
}

export type KeybindingAction =
  | 'quiz.previous'
  | 'quiz.next'
  | 'quiz.flip'
  | 'study.quality1'
  | 'study.quality2'
  | 'study.quality3'
  | 'study.quality4'
  | 'library.newDeck'
  | 'library.renameDeck'
  | 'library.deleteDeck';

export type KeybindingMap = Record<KeybindingAction, string>;

// ─── SRS State (user × question) ─────────────────────────────────────────────

export interface SRSState {
  id?: string;
  user_id: string;
  question_id: string;
  pdf_id: string;
  interval: number;
  ease_factor: number;
  repetitions: number;
  next_review: string;
  last_reviewed: string;
  times_reviewed: number;
  times_correct: number;
  times_incorrect: number;
  quality_history: number[];
  updated_at?: string;
}

// ─── Review Log (append-only) ─────────────────────────────────────────────────

export interface Review {
  id?: string;
  user_id: string;
  question_id: string;
  pdf_id: string;
  quality: number;              // 1–4
  interval_after: number;
  ease_after: number;
  reviewed_at?: string;
}

// ─── Study Queue ──────────────────────────────────────────────────────────────

/** A question ready for study, enriched with queue metadata. */
export interface StudyQueueItem extends Question {
  _bucket: StudyBucket;
  _proxiedFromId: string | null; // set when this is a sibling standing in for an original due question
}

// ─── Pipeline Internal Types ──────────────────────────────────────────────────

export interface PageRecord {
  page: number;
  text: string;
}

export interface RawChunk {
  id: string;
  pdf_id: string;
  text: string;
  start_page: number;
  end_page: number;
  headers: string[];
  word_count: number;
}

export interface ChunkRecord extends RawChunk {
  embedding: number[];
}

export interface BM25Index {
  tf: Map<string, Map<string, number>>;  // docId → term → tf
  idf: Map<string, number>;              // term → idf
  docLengths: Map<string, number>;       // docId → length in tokens
  avgDocLength: number;
  docIds: string[];
}

// ─── SSE Progress Events ──────────────────────────────────────────────────────

export interface ProcessEvent {
  phase: number;                // 0 = init, 1–6 = pipeline phases, 7 = done
  message: string;
  pct: number;                  // 0–100
  data?: {
    pdfId?: string;
    wordsParsed?: number;
    conceptsGenerated?: number;
    questionsGenerated?: number;
    questionsAccepted?: number;
    questionsRejected?: number;
    rejectionBreakdown?: Record<string, number>;
    estimatedTotalSec?: number;
    [key: string]: unknown;
  };
}

// ─── Mastery / Stats ──────────────────────────────────────────────────────────

export interface MasteryData {
  conceptId: string;
  l1: number;                   // 0–100 score for level 1 questions
  l2: number;
  l3: number;
  overall: number;              // 0–100 weighted overall score
  status: 'new' | 'weak' | 'medium' | 'strong' | 'mastered';
}

// ─── Concept Inventory (pipeline intermediate) ────────────────────────────────

export interface RawConcept {
  name: string;
  category: string;
  importance: ImportanceLevel;
  summary: string;
  chunk_ids: string[];
  aliases?: string[];
}

export interface ConfusionTarget {
  concept: string;
  reason: string;
  differentiator?: string;
}

export interface ConfusionMap {
  [conceptName: string]: ConfusionTarget[];
}

export interface ConceptSpec {
  id:                string;
  name:              string;
  category:          string;
  importance:        string;
  keyFacts:          string[];
  clinicalRelevance: string;
  associations:      string[];
  pageEstimate:      string;
  coverageDomain:    string;
  chunk_ids:         string[];
}

export interface GenerationSlot {
  conceptId: string;
  conceptName: string;
  category: string;
  importance: ImportanceLevel;
  level: QuestionLevel;
  coverageDomain: string;
  chunkIds: string[];
  pageEstimate: string;
  keyFacts: string[];
  clinicalRelevance: string;
  associations: string[];
}

export interface DistractorCandidate {
  text: string;
  sourceConcept: string;
  category: string;
  reasonType:
    | 'same_category_peer'
    | 'confusion_pair'
    | 'negative_rag'
    | 'association'
    | 'hardcoded_fallback'
    | 'synthetic_backfill';
  sharedFeature: string;
  differentiator: string;
  evidenceSnippet?: string;
}

// ─── Density Config (mirrors HTML DENSITY presets) ───────────────────────────

export interface DensityConfig {
  words: number;                // words per chunk
  overlap: number;              // overlap fraction
  min: number;                  // min questions per concept
  max: number;                  // max questions per concept
  levels: Record<ImportanceLevel, QuestionLevel[]>;
  diagCount: number;            // diagnostic session question count
  questionsPerPage: number;     // Claude flat question target per page
}

export const DENSITY_CONFIG: Record<Density, DensityConfig> = {
  standard: {
    words: 2000, overlap: 0.15, min: 15, max: 28,
    levels: { high: [1, 2, 3], medium: [1, 2], low: [1] },
    diagCount: 20,
    questionsPerPage: 7,
  },
  comprehensive: {
    words: 1800, overlap: 0.18, min: 28, max: 45,
    levels: { high: [1, 2, 3], medium: [1, 2, 3], low: [1, 2] },
    diagCount: 25,
    questionsPerPage: 13,
  },
  boards: {
    words: 1500, overlap: 0.20, min: 40, max: 60,
    levels: { high: [1, 2, 3], medium: [1, 2, 3], low: [1, 2, 3] },
    diagCount: 30,
    questionsPerPage: 18,
  },
};

// ─── User Profile ─────────────────────────────────────────────────────────────

export interface UserProfile {
  id: string;                   // uuid — matches auth.users.id
  email: string;
  plan: PlanTier;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  exam_date: string | null;     // ISO date string, e.g. "2026-06-15"
  pdfs_this_month: number;
  month_reset_at: string;       // ISO timestamp of last monthly counter reset
  created_at: string;
}

// ─── API Request/Response shapes ─────────────────────────────────────────────

export interface ProcessRequestBody {
  pdfName: string;
  density: Density;
}

export interface SubmitQualityBody {
  questionId: string;
  quality: number;              // 1–4
  pdfId: string;
  proxiedFromId?: string | null;
}

export interface QueueResponse {
  queue: StudyQueueItem[];
  examDate: string | null;
}

// ─── Feature Flags ────────────────────────────────────────────────────────────

export interface FeatureFlags {
  enableTextQualityCheck: boolean;
  enableEvidenceGating: boolean;
  enableHybridRetrieval: boolean;
  enableConfusionDistractors: boolean;
  enableDynamicModelRouting: boolean;
  enableNegativeRag: boolean;
  enableFuzzyEvidenceMatch: boolean;
  enableL3GroundingGuard: boolean;
  enableStructuralChunking: boolean;
}

// ─── Question Quality Analytics ───────────────────────────────────────────────

export type AttemptFlagReason = 'wrong_answer_key' | 'confusing_wording' | 'out_of_scope' | 'other';
export type AttemptSource = 'quiz' | 'study';

export interface QuestionAttempt {
  id: string;
  question_id: string;
  user_id: string;
  pdf_id: string;
  selected_option: number;  // 0-indexed; -1 = skipped
  is_correct: boolean;
  time_spent_ms: number;
  explanation_helpful: boolean | null;
  flag_reason: AttemptFlagReason | null;
  source: AttemptSource;
  created_at: string;
}

export interface AttemptRequestBody {
  questionId: string;
  pdfId: string;
  selectedOption: number;
  isCorrect: boolean;
  timeSpentMs: number;
  explanationHelpful?: boolean | null;
  flagReason?: AttemptFlagReason | null;
  source?: AttemptSource;
}

export interface QuestionStatRow {
  question_id: string;
  stem: string;
  level: QuestionLevel;
  concept_name: string;
  total_attempts: number;
  difficulty_index: number;        // correct / total (0–1)
  discrimination_index: number;    // p_top27 - p_bottom27
  option_counts: number[];         // count per option slot
  avg_time_ms: number;
  flag_count: number;
  flag_reasons: Partial<Record<AttemptFlagReason, number>>;
  helpful_pct: number | null;      // null when no ratings yet
}
