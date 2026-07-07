# Cloud Storage Selection Guideline
## For the GlobiFYE Sales Call System
**Created: July 4, 2026**

---

## 1. Context

`sales-call-system-pipeline-0520-v1.1.md` (Phase 1 architecture, e.g. lines 23, 89–90, 332, 365) has always shown raw audio chunks flowing to "Cloud Storage (S3/GCS)" without picking one — this was an open item, never decided. With the Step 10 WebSocket layer now live-streaming 100–200ms audio chunks in real time, we need real-time audio storage decided before that data path is built out.

## 2. Core Requirements

| Requirement | Specification |
|---|---|
| Write pattern | Streaming, chunked writes (100–200ms audio chunks arriving continuously during a live call) — not a single post-call upload |
| Runtime | Must work from Vercel serverless/edge functions (Next.js API routes) |
| Ecosystem fit | Should minimize cross-cloud latency/egress given Supabase (Postgres metadata) is already in the stack |
| Access pattern | Write-heavy during the call, read-heavy (infrequent) afterward for playback/QA |
| Ops overhead | Minimize — small team, no dedicated infra role |

---

## 3. Comparison

| Dimension | AWS S3 | Google Cloud Storage (GCS) | Supabase Storage |
|---|---|---|---|
| **Ecosystem fit** | ✅ Strong — Supabase's own Storage service is itself an S3-compatible layer, and Supabase-hosted projects default to AWS. Keeping audio on S3 keeps metadata (Postgres) and binary data (audio) in the same cloud, avoiding cross-cloud latency/egress | ⚠️ Weak — no native affinity with the rest of the stack; requires standing up a separate GCP project, service account, and IAM policy from scratch | ✅ Strongest — no separate cloud account at all; reuses the existing `supabaseAdmin` client and project credentials already in `lib/supabase.ts` |
| **Vercel/Next.js integration** | `@aws-sdk/client-s3` (v3, modular) is lightweight and cold-start-friendly in API routes | `@google-cloud/storage` works but has a heavier dependency footprint, slightly worse cold-start | Native `supabase-js` `.storage` API — same client already imported everywhere in the codebase |
| **Streaming/chunked upload support** | Multipart Upload API — well-suited to "accumulate a part, upload, repeat" during a live call | Resumable Upload — functionally equivalent | Wraps S3-compatible multipart upload under the hood; same capability, simpler API surface |
| **Pricing (Standard storage)** | ~$0.023/GB/month | ~$0.020/GB/month (marginally cheaper) | Bundled into existing Supabase plan up to project storage quota; equivalent-to-S3 pricing beyond that (Supabase bills through to S3 pricing at scale) |
| **Egress cost** | Comparable to GCS | Comparable to S3 | Same underlying cost model as S3 (since it is S3-backed) |
| **Credential/IAM complexity** | IAM policies are flexible but have a learning curve; largest community/doc base | Service accounts are conceptually simpler | None — no new credentials, reuses existing Supabase service-role key |
| **Team/codebase precedent** | Already the implicit default in every architecture diagram in `sales-call-system-pipeline-0520-v1.1.md` ("S3/GCS" always lists S3 first) | No GCP footprint anywhere in the codebase or design docs today | Already the primary DB/auth provider; zero new infra to stand up |

---

## 4. Decision

**Selected: AWS S3.**

### Why not Supabase Storage, given it scores well above?

Supabase Storage would be the simplest path (zero new accounts, reuses existing credentials), and is worth reconsidering if ops simplicity becomes the priority. It was not selected now because:
- The team wants a direct cloud-vendor storage layer (not routed through a second abstraction layer on top of S3) for headroom on things Supabase Storage doesn't control directly — e.g. bucket-level lifecycle policies, direct CDN (CloudFront) attachment, and fine-grained IAM if audio access needs to be scoped beyond what Supabase's storage policies expose.
- Keeping audio storage on the same primitive (S3) that Supabase itself sits on top of means no added abstraction layer between the app and the object store.

### Why not GCS

No existing GCP footprint in the stack (Vercel, Supabase, Deepgram, Groq, ElevenLabs are all cloud-agnostic or AWS-adjacent), and marginal pricing differences don't outweigh the cost of standing up and maintaining a second cloud vendor's credentials/IAM for a single bucket's worth of usage.

---

## 5. Implementation Notes

- Bucket should be created in the same AWS region as the Supabase project (check Supabase project settings → region) to minimize cross-service latency
- Use `@aws-sdk/client-s3` with Multipart Upload, writing each accumulated audio chunk as a part; complete the multipart upload on call end (`speech_final`/session stop)
- `recordings.audio_url` continues to store the S3 object URL/key as originally designed in the `ai-pipeline-data-dictionary.md` schema — no schema change needed
- Server-side only: S3 credentials stay in Vercel environment variables, never exposed to the browser (same pattern as `GROQ_API_KEY`, `ELEVENLABS_API_KEY`)
