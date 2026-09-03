// lib/kb-retrieve.ts
// Call-time retrieval. Embeds the caller's utterance (or the running query),
// finds the nearest chunks via the match_kb_chunks RPC, and returns them plus a
// ready-to-inject context string. `docIds` should be the documents currently
// ATTACHED to the agent in the console (the toggles in the Knowledge Base tab).
import { supabaseAdmin } from "./supabase-admin";
import { embedOne } from "./embeddings";

export interface RetrievedChunk {
  id: string;
  documentId: string;
  content: string;
  similarity: number;
}

export interface RetrieveOptions {
  organizationId: string;
  docIds?: string[]; // attached documents; omit to search the whole org KB
  matchCount?: number;
  minSimilarity?: number; // 0..1 cosine similarity floor
}

export async function retrieveChunks(
  query: string,
  opts: RetrieveOptions
): Promise<RetrievedChunk[]> {
  const { organizationId, docIds, matchCount = 6, minSimilarity = 0.2 } = opts;

  const queryEmbedding = await embedOne(query);

  const { data, error } = await supabaseAdmin.rpc("match_kb_chunks", {
    query_embedding: queryEmbedding,
    match_count: matchCount,
    filter_org: organizationId,
    doc_ids: docIds && docIds.length ? docIds : null,
  });
  if (error) throw new Error(`Retrieval failed: ${error.message}`);

  return (data ?? [])
    .filter((r: any) => r.similarity >= minSimilarity)
    .map((r: any) => ({
      id: r.id,
      documentId: r.document_id,
      content: r.content,
      similarity: r.similarity,
    }));
}

/** Turn retrieved chunks into a prompt block for the LLM. */
export function formatContext(chunks: RetrievedChunk[]): string {
  if (!chunks.length) return "";
  const body = chunks
    .map((c, i) => `[${i + 1}] ${c.content}`)
    .join("\n\n");
  return `# Knowledge base (use these facts; do not invent)\n${body}`;
}
