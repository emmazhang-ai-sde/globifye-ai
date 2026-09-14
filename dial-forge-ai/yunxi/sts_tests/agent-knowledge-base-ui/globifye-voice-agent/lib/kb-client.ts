// lib/kb-client.ts
// Browser-side helpers the console uses to talk to the KB API routes.
export type DocStatus = "uploading" | "processing" | "ready" | "error";

export interface KbDoc {
  id: string;
  filename: string;
  byteSize: number | null;
  status: DocStatus;
  chunkCount: number;
  attached: boolean;
  error?: string | null;
  createdAt?: string;
  /** local-only id for optimistic rows before the server assigns one */
  localId?: string;
}

export async function listDocuments(
  organizationId: string,
  agentId?: string
): Promise<KbDoc[]> {
  const qs = new URLSearchParams({ organizationId });
  if (agentId) qs.set("agentId", agentId);
  const res = await fetch(`/api/kb/documents?${qs}`);
  if (!res.ok) throw new Error((await res.json()).error ?? "Failed to load documents");
  return (await res.json()).documents as KbDoc[];
}

export async function uploadDocument(
  file: File,
  organizationId: string,
  agentId?: string
): Promise<{ documentId: string; chunkCount: number; status: "ready" | "error"; error?: string }> {
  const form = new FormData();
  form.append("file", file);
  form.append("organizationId", organizationId);
  if (agentId) form.append("agentId", agentId);

  const res = await fetch("/api/kb/upload", { method: "POST", body: form });
  const json = await res.json();
  if (!res.ok && res.status !== 422) {
    throw new Error(json.error ?? "Upload failed");
  }
  return json;
}

export async function setAttached(
  id: string,
  attached: boolean,
  agentId: string
): Promise<void> {
  const res = await fetch(`/api/kb/documents/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attached, agentId }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? "Failed to update");
}

export async function deleteDocument(id: string): Promise<void> {
  const res = await fetch(`/api/kb/documents/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error((await res.json()).error ?? "Failed to delete");
}

export function formatSize(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
