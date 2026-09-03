// app/api/kb/documents/route.ts
// GET /api/kb/documents?organizationId=...&agentId=...
// Lists the org's documents. `attached` is computed relative to agentId:
// a doc is "attached" to this agent when documents.agent_id === agentId.
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const organizationId = req.nextUrl.searchParams.get("organizationId");
  const agentId = req.nextUrl.searchParams.get("agentId");

  if (!organizationId) {
    return NextResponse.json(
      { error: "organizationId is required." },
      { status: 400 }
    );
  }

  const { data, error } = await supabaseAdmin
    .from("documents")
    .select("id, filename, byte_size, status, chunk_count, agent_id, error, created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const docs = (data ?? []).map((d) => ({
    id: d.id,
    filename: d.filename,
    byteSize: d.byte_size,
    status: d.status,
    chunkCount: d.chunk_count,
    error: d.error,
    attached: agentId ? d.agent_id === agentId : false,
    createdAt: d.created_at,
  }));

  return NextResponse.json({ documents: docs });
}
