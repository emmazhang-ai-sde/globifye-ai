import { NextResponse } from 'next/server'
import { writeAnalysis } from '@/lib/llm'

export async function POST(req: Request) {
  try {
    const { recording_id } = await req.json()

    if (!recording_id) {
      return NextResponse.json(
        { error: 'recording_id is required' },
        { status: 400 },
      )
    }

    const analysis = await writeAnalysis(recording_id)
    return NextResponse.json(analysis)
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    )
  }
}