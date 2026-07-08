import { NextResponse } from 'next/server'
import { writeFile, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { transcribeFile } from '@/lib/deepgram'
import { createRecording, writeTranscript } from '@/lib/supabase'

export async function POST(req: Request) {
  const formData = await req.formData()
  const file = formData.get('audio') as File | null

  if (!file) {
    return NextResponse.json(
      { error: 'No audio file provided. Send the file as form field name: audio' },
      { status: 400 }
    )
  }

  const ext = file.name.split('.').pop() ?? 'wav'
  const tmpPath = join(tmpdir(), `${randomUUID()}.${ext}`)

  try {
    // Write the uploaded file to /tmp so transcribeFile() can read it by path
    await writeFile(tmpPath, Buffer.from(await file.arrayBuffer()))

    const utterances = await transcribeFile(tmpPath)
    // `filename` was dropped in Step 11 (recordings has no such column). No column
    // exists to store the original filename today, so we don't persist it — audio_url
    // is for the storage pointer, not the source name. Add a column later if needed.
    const recordingId = await createRecording({})
    await writeTranscript(recordingId, utterances)

    return NextResponse.json({ recording_id: recordingId, utterances })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  } finally {
    // Clean up the temp file whether the request succeeded or failed
    await unlink(tmpPath).catch(() => {})
  }
}