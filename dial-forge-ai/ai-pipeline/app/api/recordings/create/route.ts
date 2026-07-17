import { NextResponse } from 'next/server'
import { createRecording } from '@/lib/supabase'

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const recordingId = await createRecording(body)   // was: createRecording(body.call_metadata ?? {})
    return NextResponse.json({ recording_id: recordingId })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}