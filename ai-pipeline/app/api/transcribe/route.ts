import { NextResponse } from 'next/server'
import { writeFile, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  transcribeAudioFile,
  extractUtterances,
  writeTranscriptForRecording,
} from '@/lib/deepgram'
import { createRecording, updateRecordingDuration } from '@/lib/supabase'

export async function POST(req: Request) {
  // ----------------------------------------------------------------
  // 1. Parse the upload
  // ----------------------------------------------------------------
  const formData = await req.formData()
  const file = formData.get('audio') as File | null

  if (!file) {
    return NextResponse.json(
      { error: 'No audio file provided. Use form field name "audio".' },
      { status: 400 },
    )
  }

  // ----------------------------------------------------------------
  // 2. Save to a temp file so Deepgram can read it by path
  // ----------------------------------------------------------------
  const ext = file.name.split('.').pop() ?? 'wav'
  const tmpPath = join(tmpdir(), `${randomUUID()}.${ext}`)

  try {
    await writeFile(tmpPath, Buffer.from(await file.arrayBuffer()))

    // ----------------------------------------------------------------
    // 3. Transcribe with Deepgram
    // ----------------------------------------------------------------
    const deepgramResult = await transcribeAudioFile(tmpPath)
    const utterances = extractUtterances(deepgramResult)

    // ----------------------------------------------------------------
    // 4. Create recording row (only after Deepgram succeeded)
    // ----------------------------------------------------------------
    const recordingId = await createRecording({
      status: 'completed',
    })

    // ----------------------------------------------------------------
    // 5. Write transcript rows
    // ----------------------------------------------------------------
    await writeTranscriptForRecording(recordingId, utterances)

    // ----------------------------------------------------------------
    // 6. Update duration if Deepgram provided it
    // ----------------------------------------------------------------
    const duration = (deepgramResult as any)?.metadata?.duration
    if (typeof duration === 'number') {
      await updateRecordingDuration(recordingId, duration)
    }

    // ----------------------------------------------------------------
    // 7. Return both the recording_id and utterances (UI uses both)
    // ----------------------------------------------------------------
    return NextResponse.json({
      recording_id: recordingId,
      utterances: utterances.map((u, i) => ({
        speaker: u.speaker,
        transcript: u.content_clean,    // UI shows clean version
        content_raw: u.content_raw,
        start: u.sentence_start_sec,
        end: u.sentence_start_sec,       // Step 4 didn't capture end times; reuse start
      })),
    })
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    )
  } finally {
    // Always clean up the temp file
    await unlink(tmpPath).catch(() => {})
  }
}