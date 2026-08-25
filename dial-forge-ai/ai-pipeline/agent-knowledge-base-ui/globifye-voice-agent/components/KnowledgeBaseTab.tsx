"use client";
// components/KnowledgeBaseTab.tsx
// Knowledge Base tab, wired to the real backend and styled to the DialForge
// design system (dark glass, fire-orange primary, Syne/DM Sans/JetBrains Mono).
//
//   <KnowledgeBaseTab organizationId={orgId} agentId={agentId} />
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  UploadCloud, FileText, Check, Loader, Trash2, Paperclip, AlertCircle,
} from "lucide-react";
import {
  KbDoc, listDocuments, uploadDocument, setAttached, deleteDocument, formatSize,
} from "@/lib/kb-client";

let tmp = 0;
const localId = () => `local-${tmp++}`;

export default function KnowledgeBaseTab({
  organizationId,
  agentId,
}: {
  organizationId: string;
  agentId?: string;
}) {
  const [docs, setDocs] = useState<KbDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hot, setHot] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    listDocuments(organizationId, agentId)
      .then((d) => alive && (setDocs(d), setLoadError(null)))
      .catch((e) => alive && setLoadError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [organizationId, agentId]);

  const upload = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList).filter(
        (f) => f.type === "application/pdf" || f.name.endsWith(".pdf")
      );
      for (const file of files) {
        const lid = localId();
        setDocs((prev) => [
          ...prev,
          {
            id: lid,
            localId: lid,
            filename: file.name,
            byteSize: file.size,
            status: "processing",
            chunkCount: 0,
            attached: true,
          },
        ]);
        try {
          const res = await uploadDocument(file, organizationId, agentId);
          setDocs((prev) =>
            prev.map((d) =>
              d.localId === lid
                ? {
                    ...d,
                    id: res.documentId,
                    localId: undefined,
                    status: res.status,
                    chunkCount: res.chunkCount,
                    error: res.status === "error" ? res.error ?? "Ingestion failed" : null,
                  }
                : d
            )
          );
        } catch (e: any) {
          setDocs((prev) =>
            prev.map((d) => (d.localId === lid ? { ...d, status: "error", error: e.message } : d))
          );
        }
      }
    },
    [organizationId, agentId]
  );

  const toggle = useCallback(
    async (doc: KbDoc) => {
      if (doc.status !== "ready" || !agentId) return;
      const next = !doc.attached;
      setDocs((prev) => prev.map((d) => (d.id === doc.id ? { ...d, attached: next } : d)));
      try {
        await setAttached(doc.id, next, agentId);
      } catch {
        setDocs((prev) => prev.map((d) => (d.id === doc.id ? { ...d, attached: !next } : d)));
      }
    },
    [agentId]
  );

  const remove = useCallback(async (doc: KbDoc) => {
    if (doc.localId) {
      setDocs((prev) => prev.filter((d) => d.id !== doc.id));
      return;
    }
    const snapshot = doc;
    setDocs((prev) => prev.filter((d) => d.id !== doc.id));
    try {
      await deleteDocument(doc.id);
    } catch {
      setDocs((prev) => [...prev, snapshot]);
    }
  }, []);

  const attachedCount = docs.filter((d) => d.attached && d.status === "ready").length;

  return (
    <div className="kb-root">
      <style>{CSS}</style>

      <p className="kb-eyebrow">Grounding</p>
      <h2 className="kb-h">Knowledge base</h2>
      <p className="kb-sub">
        Attached documents are chunked, embedded, and retrieved at answer time so the agent quotes
        real facts instead of guessing.
      </p>

      <div
        className={`kb-drop ${hot ? "hot" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setHot(true);
        }}
        onDragLeave={() => setHot(false)}
        onDrop={(e) => {
          e.preventDefault();
          setHot(false);
          upload(e.dataTransfer.files);
        }}
      >
        <div className="kb-drop-ic">
          <UploadCloud size={24} />
        </div>
        <div className="kb-drop-title">Drop PDFs here, or browse</div>
        <div className="kb-drop-sub">PDF up to 20 MB · company docs, pricing, FAQs</div>
        <button className="kb-btn" onClick={() => fileInput.current?.click()}>
          <Paperclip size={14} /> Browse files
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".pdf"
          multiple
          hidden
          onChange={(e) => e.target.files && upload(e.target.files)}
        />
      </div>

      <div className="kb-listhead">
        <span className="kb-label">Library · {docs.length} files</span>
        <span className="kb-count">{attachedCount} grounding this agent</span>
      </div>

      {loading && (
        <div className="kb-state">
          <Loader size={16} className="kb-spin" /> Loading documents…
        </div>
      )}
      {loadError && !loading && (
        <div className="kb-state err">
          <AlertCircle size={16} /> Couldn’t load documents: {loadError}
        </div>
      )}
      {!loading && !loadError && docs.length === 0 && (
        <div className="kb-state muted">No documents yet. Upload a PDF to get started.</div>
      )}

      {docs.map((f) => (
        <div className="kb-file" key={f.id}>
          <div className="kb-file-ic">
            <FileText size={18} />
          </div>
          <div className="kb-file-meta">
            <div className="kb-file-name">{f.filename}</div>
            <div className="kb-file-sub">
              <span>{formatSize(f.byteSize)}</span>
              <span className="kb-dot">•</span>
              {f.status === "ready" && (
                <span className="kb-badge ready">
                  <Check size={11} /> Ready · {f.chunkCount} chunks
                </span>
              )}
              {f.status === "processing" && (
                <span className="kb-badge proc">
                  <Loader size={11} className="kb-spin" /> Processing
                </span>
              )}
              {f.status === "error" && (
                <span className="kb-badge err" title={f.error ?? ""}>
                  <AlertCircle size={11} /> {f.error ?? "Error"}
                </span>
              )}
            </div>
          </div>
          <button
            className={`kb-switch ${f.attached ? "on" : ""}`}
            onClick={() => toggle(f)}
            disabled={f.status !== "ready" || !agentId}
            aria-label="Attach to agent"
          />
          <button className="kb-icon-btn" onClick={() => remove(f)} aria-label="Remove file">
            <Trash2 size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500;700&family=JetBrains+Mono:wght@500;700&display=swap');
.kb-root{
  --bg:#07080F; --surface:#12131a; --surface-container:#1e1f27;
  --on-surface:#e3e1ec; --on-surface-variant:#e5beb4; --outline:#ac8980;
  --primary:#ffb4a2; --primary-container:#ff562a; --on-primary:#611200;
  --secondary:#7cffa3; --danger:#ff5a6b;
  --glass-bg:rgba(20,21,34,.55); --glass-border:rgba(255,255,255,.07);
  --fire:linear-gradient(135deg,#FF4D1C 0%,#FF8A00 100%);
  font-family:'DM Sans',system-ui,sans-serif; color:var(--on-surface);
}
.kb-root *{box-sizing:border-box}
.kb-eyebrow{font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--primary);margin-bottom:6px}
.kb-h{font-family:'Syne',sans-serif;font-weight:800;font-size:26px;letter-spacing:-.01em;color:var(--on-surface)}
.kb-sub{color:var(--on-surface-variant);font-size:14px;line-height:1.6;margin-top:4px;max-width:60ch}
.kb-drop{
  margin-top:20px;border:1.5px dashed rgba(255,255,255,.14);border-radius:22px;
  padding:34px 20px;text-align:center;
  background:radial-gradient(120% 120% at 50% 0%, rgba(255,77,28,.06), transparent 60%), var(--glass-bg);
  backdrop-filter:blur(20px);transition:.16s;
}
.kb-drop.hot{border-color:var(--primary-container);box-shadow:0 0 24px rgba(255,77,28,.18)}
.kb-drop-ic{width:52px;height:52px;border-radius:14px;margin:0 auto 12px;display:grid;place-items:center;background:var(--fire);color:#fff;box-shadow:0 6px 18px rgba(255,77,28,.35)}
.kb-drop-title{font-weight:700;font-size:15px}
.kb-drop-sub{color:var(--on-surface-variant);font-size:12.5px;margin-top:4px}
.kb-btn{
  display:inline-flex;align-items:center;gap:7px;margin-top:14px;font-family:'DM Sans';
  font-size:13px;font-weight:700;padding:9px 16px;border-radius:999px;cursor:pointer;
  color:var(--on-surface);background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);transition:.14s;
}
.kb-btn:hover{background:rgba(255,255,255,.09);border-color:rgba(255,255,255,.2)}
.kb-listhead{display:flex;align-items:center;justify-content:space-between;margin-top:24px}
.kb-label{font-family:'JetBrains Mono',monospace;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--on-surface-variant)}
.kb-count{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--secondary)}
.kb-state{display:flex;align-items:center;gap:9px;font-size:13.5px;color:var(--on-surface-variant);padding:16px 2px}
.kb-state.err{color:var(--danger)} .kb-state.muted{color:var(--on-surface-variant);opacity:.7}
.kb-file{
  display:flex;align-items:center;gap:13px;padding:13px 15px;margin-top:11px;border-radius:16px;
  background:var(--glass-bg);backdrop-filter:blur(20px);border:1px solid var(--glass-border);transition:.14s;
}
.kb-file:hover{border-color:rgba(255,180,162,.25)}
.kb-file-ic{width:40px;height:40px;border-radius:11px;flex-shrink:0;display:grid;place-items:center;color:var(--primary);background:rgba(255,180,162,.1)}
.kb-file-meta{flex:1;min-width:0}
.kb-file-name{font-weight:500;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-file-sub{display:flex;align-items:center;gap:7px;margin-top:3px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--on-surface-variant)}
.kb-dot{opacity:.4}
.kb-badge{display:inline-flex;align-items:center;gap:5px;font-family:'DM Sans';font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px}
.kb-badge.ready{background:rgba(124,255,163,.12);color:var(--secondary)}
.kb-badge.proc{background:rgba(255,180,162,.12);color:var(--primary)}
.kb-badge.err{background:rgba(255,90,107,.14);color:var(--danger);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-switch{width:40px;height:23px;border-radius:999px;position:relative;flex-shrink:0;border:none;cursor:pointer;background:rgba(255,255,255,.14);transition:.16s}
.kb-switch.on{background:var(--fire)}
.kb-switch:disabled{opacity:.35;cursor:not-allowed}
.kb-switch::after{content:"";position:absolute;top:2.5px;left:2.5px;width:18px;height:18px;border-radius:50%;background:#fff;transition:.16s}
.kb-switch.on::after{transform:translateX(17px)}
.kb-icon-btn{width:32px;height:32px;border-radius:9px;display:grid;place-items:center;color:var(--on-surface-variant);border:none;background:none;cursor:pointer;transition:.14s}
.kb-icon-btn:hover{background:rgba(255,90,107,.14);color:var(--danger)}
.kb-spin{animation:kbspin 1s linear infinite}
@keyframes kbspin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.kb-root *{animation:none!important;transition:none!important}}
`;
