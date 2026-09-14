// lib/kb-ingest.ts
// The "analyze" step behind the Knowledge Base upload:
//   PDF bytes -> text -> chunks -> embeddings -> rows in kb_chunks.
// Creates a `documents` row up front (status="processing"), then flips it to
// "ready" (or "error") at the end so the UI can poll/subscribe for status.
import { supabaseAdmin } from "./supabase-admin";
import { pdfToText } from "./pdf";
import { chunkText } from "./chunk";
import { embedBatch } from "./embeddings";

export interface IngestInput {
  fileName: string;
  bytes: Uint8Array;
  organizationId: string;
  agentId?: string | null; // null = shared library, not tied to one agent
}

export interface IngestResult {
  documentId: string;
  chunkCount: number;
  status: "ready" | "error";
}

export async function ingestDocument(input: IngestInput): Promise<IngestResult> {
  const { fileName, bytes, organizationId, agentId = null } = input;

  // 1) Record the document so the UI has something to show immediately.
  const { data: doc, error: docErr } = await supabaseAdmin
    .from("documents")
    .insert({
      organization_id: organizationId,
      agent_id: agentId,
      filename: fileName,
      byte_size: bytes.byteLength,
      status: "processing",
    })
    .select("id")
    .single();

  if (docErr || !doc) {
    throw new Error(`Could not create document row: ${docErr?.message}`);
  }
  const documentId = doc.id as string;

  try {
    // 2) Extract + chunk.
    const text = await pdfToText(bytes);
    if (!text) throw new Error("No extractable text (is this a scanned PDF?).");
    const chunks = chunkText(text, { chunkSize: 1000, overlap: 150 });
    if (chunks.length === 0) throw new Error("Document produced no chunks.");

    // 3) Embed.
    const vectors = await embedBatch(chunks);

    // 4) Store chunks (batched inserts to keep payloads small).
    const rows = chunks.map((content, i) => ({
      document_id: documentId,
      organization_id: organizationId,
      chunk_index: i,
      content,
      embedding: vectors[i],
    }));
    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await supabaseAdmin
        .from("kb_chunks")
        .insert(rows.slice(i, i + 100));
      if (error) throw new Error(`Chunk insert failed: ${error.message}`);
    }

    // 5) Mark ready.
    await supabaseAdmin
      .from("documents")
      .update({ status: "ready", chunk_count: chunks.length, error: null })
      .eq("id", documentId);

    return { documentId, chunkCount: chunks.length, status: "ready" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabaseAdmin
      .from("documents")
      .update({ status: "error", error: message })
      .eq("id", documentId);
    return { documentId, chunkCount: 0, status: "error" };
  }
}
