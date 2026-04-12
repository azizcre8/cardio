// ─── Enums / Union Types ──────────────────────────────────────────────────────

export type PlanTier = 'free' | 'student' | 'boards' | 'institution';

export type Density = 'standard' | 'comprehensive' | 'boards';

export type ImportanceLevel = 'high' | 'medium' | 'low';

export type QuestionLevel = 1 | 2 | 3;

export type MasteryStatus = 'new' | 'learning' | 'reviewing' | 'mastered';

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
  concept_id: string;
  user_id: string;
  level: QuestionLevel;

  // Content
  stem: string;
  options: string[];            // 4 options, A-D
  answer: number;               // 0-indexed correct option
  explanation: string;
  option_explanations: string[] | null; // per-distractor explanations, generated lazily
  source_quote: string;
  concept_name?: string;
  evidence_start: number | null;
  evidence_end: number | null;
  chunk_id: string | null;

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
  data?: Record<string, unknown>;
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

export interface ConfusionMap {
  [conceptName: string]: string[]; // concept name → list of confusable names
}

// ─── Density Config (mirrors HTML DENSITY presets) ───────────────────────────

export interface DensityConfig {
  words: number;                // words per chunk
  overlap: number;              // overlap fraction
  min: number;                  // min questions per concept
  max: number;                  // max questions per concept
  levels: Record<ImportanceLevel, QuestionLevel[]>;
  diagCount: number;            // diagnostic session question count
}

export const DENSITY_CONFIG: Record<Density, DensityConfig> = {
  standard: {
    words: 2000, overlap: 0.15, min: 15, max: 28,
    levels: { high: [1, 2, 3], medium: [1, 2], low: [1] },
    diagCount: 20,
  },
  comprehensive: {
    words: 1800, overlap: 0.18, min: 28, max: 45,
    levels: { high: [1, 2, 3], medium: [1, 2, 3], low: [1, 2] },
    diagCount: 25,
  },
  boards: {
    words: 1500, overlap: 0.20, min: 40, max: 60,
    levels: { high: [1, 2, 3], medium: [1, 2, 3], low: [1, 2, 3] },
    diagCount: 30,
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
}
