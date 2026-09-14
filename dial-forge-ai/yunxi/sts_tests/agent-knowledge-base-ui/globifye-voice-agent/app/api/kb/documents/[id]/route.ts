// app/api/kb/documents/[id]/route.ts
// PATCH  /api/kb/documents/:id   { attached: boolean, agentId: string }
//        -> attach/detach this doc to an agent by setting documents.agent_id
// DELETE /api/kb/documents/:id   -> remove doc (kb_chunks cascade on FK)
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = params;
  const body = await req.json().catch(() => ({}));
  const attached = Boolean(body.attached);
  const agentId = body.agentId as string | undefined;

  if (attached && !agentId) {
    return NextResponse.json(
      { error: "agentId is required when attaching." },
      { status: 400 }
    );
  }

  const { error } = await supabaseAdmin
    .from("documents")
    .update({ agent_id: attached ? agentId : null })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, attached });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { error } = await supabaseAdmin
    .from("documents")
    .delete()
    .eq("id", params.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
