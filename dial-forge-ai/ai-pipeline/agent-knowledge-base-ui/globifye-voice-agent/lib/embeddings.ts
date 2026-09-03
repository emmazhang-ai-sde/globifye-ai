// lib/embeddings.ts
// Wraps OpenAI text-embedding-3-small. Batches large inputs so a document with
// hundreds of chunks becomes a handful of requests instead of one-per-chunk.
import OpenAI from "openai";

export const EMBED_MODEL = "text-embedding-3-small";
export const EMBED_DIM = 1536; // must match vector(1536) in the DB

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** Embed many texts, preserving input order. */
export async function embedBatch(
  texts: string[],
  batchSize = 96
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const slice = texts.slice(i, i + batchSize);
    const res = await openai.embeddings.create({
      model: EMBED_MODEL,
      input: slice,
    });
    // The API may return items out of order; sort by index to be safe.
    const ordered = [...res.data]
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding as number[]);
    out.push(...ordered);
  }
  return out;
}

/** Embed a single string (used at query time). */
export async function embedOne(text: string): Promise<number[]> {
  const [vec] = await embedBatch([text]);
  return vec;
}
