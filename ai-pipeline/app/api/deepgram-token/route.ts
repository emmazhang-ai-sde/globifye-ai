import { NextResponse } from 'next/server';

// SDK v5 removed the manage namespace — call the REST API directly.
export async function GET() {
  const projectId = process.env.DEEPGRAM_PROJECT_ID!;
  const apiKey = process.env.DEEPGRAM_API_KEY!;

  const res = await fetch(
    `https://api.deepgram.com/v1/projects/${projectId}/keys`,
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        comment: 'browser-session',
        scopes: ['usage:write'],
        time_to_live_in_seconds: 60,
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    console.error('[deepgram-token] API error:', res.status, body);
    return NextResponse.json({ error: 'Failed to create token' }, { status: 500 });
  }

  const data = await res.json();
  return NextResponse.json({ key: data.key });
}