// app/api/kb/upload/route.ts
// POST a PDF here from the Knowledge Base tab's dropzone. Runs the full
// ingest pipeline and returns the document id + chunk count.
//
// Expects multipart/form-data:
//   file            (required)  the PDF
//   organizationId  (required)  tenant scope
//   agentId         (optional)  attach to a specific agent; omit for library
import { NextRequest, NextResponse } from "next/server";
import { ingestDocument } from "@/lib/kb-ingest";

export const runtime = "nodejs"; // pdf.js + OpenAI SDK need the Node runtime
export const maxDuration = 60; // ingestion can take a few seconds for big PDFs

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const organizationId = form.get("organizationId");
    const agentId = form.get("agentId");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file provided." }, { status: 400 });
    }
    if (typeof organizationId !== "string" || !organizationId) {
      return NextResponse.json(
        { error: "organizationId is required." },
        { status: 400 }
      );
    }
    if (file.type && file.type !== "application/pdf") {
      return NextResponse.json(
        { error: "Only PDF files are supported." },
        { status: 415 }
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await ingestDocument({
      fileName: file.name,
      bytes,
      organizationId,
      agentId: typeof agentId === "string" && agentId ? agentId : null,
    });

    const status = result.status === "ready" ? 200 : 422;
    return NextResponse.json(result, { status });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Ingestion failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
