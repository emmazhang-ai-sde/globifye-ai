import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { insertTranscriptRows } from '@/lib/supabase';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
  try {
    const {
      recording_id,
      speaker,
      content_raw,
      sentence_start_sec,
      sequence_index,                          // ← ADD
    } = await req.json()

    if (!recording_id || content_raw === undefined) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 },
      )
    }

    await insertTranscriptRows([
      {
        recording_id,
        speaker: speaker ?? 'Speaker 0',
        content_raw,
        content_clean: content_raw.trim(),
        sentence_start_sec: sentence_start_sec ?? 0,
        sequence_index: sequence_index ?? 0,    // ← ADD
      },
    ])

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    )
  }
}