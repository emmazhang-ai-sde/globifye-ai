import { NextResponse } from 'next/server'
import { createRecording } from '@/lib/supabase'

export async function POST(req: Request) {
  try {
    // Body is optional — default to empty metadata if no body provided
    const body = await req.json().catch(() => ({}))

    const recording = await createRecording({
      call_metadata: body.call_metadata ?? {},
      audio_url: null,
      duration: null,
    })

    return NextResponse.json({ recording_id: recording.id })
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    )
  }
}