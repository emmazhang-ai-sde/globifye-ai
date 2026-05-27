// =====================
// Database row types (match Supabase schema)
// =====================

export interface Recording {
  id: string;                          // UUID
  call_metadata: Record<string, unknown> | null;
  audio_url: string | null;
  duration: number | null;             // seconds
  created_at: string;                  // ISO timestamp
}

export interface TranscriptRow {
  id: string;
  recording_id: string;
  speaker: string | null;              // e.g. "Speaker 0"
  content_raw: string | null;          // with filler words
  content_clean: string | null;        // filler words stripped
  sentence_start_sec: number | null;
  created_at: string;
}

export interface Analysis {
  id: string;
  recording_id: string;
  summary: string | null;
  key_topics: KeyTopic[] | null;
  objection_analysis: Objection[] | null;
  what_went_well: WhatWentWell[] | null;
  raw_llm_output: string | null;
  created_at: string;
}

// =====================
// Nested JSON shapes inside analysis
// =====================

export interface KeyTopic {
  name: string;
  start_time: number;
}

export interface Objection {
  timestamp: number;
  speaker: string;
  exact_quote: string;
  reason: string;
  suggestion: string;
}

export interface WhatWentWell {
  timestamp: number;
  speaker: string;
  exact_quote: string;
  reason: string;
}

// =====================
// Input types (for inserts — no id/created_at, those are DB-generated)
// =====================

export type NewRecording = Omit<Recording, 'id' | 'created_at'>;
export type NewTranscriptRow = Omit<TranscriptRow, 'id' | 'created_at'>;
export type NewAnalysis = Omit<Analysis, 'id' | 'created_at'>;