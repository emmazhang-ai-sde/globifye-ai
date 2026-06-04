import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  const { recording_id, speaker, content_raw, sentence_start_sec } = await req.json();

  if (!recording_id || content_raw === undefined) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const { error } = await supabase.from('transcript').insert({
    recording_id,
    speaker,
    content_raw,
    content_clean: content_raw.trim(),
    sentence_start_sec,
  });

  if (error) {
    console.error('[transcribe/live] insert error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}