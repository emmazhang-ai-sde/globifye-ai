# Database Linking: How Contacts, Recordings, and Call History Connect

**Author:** Shuyang Zhang (AI)
**Last updated:** July 28, 2026
**Status:** Proposal — discussed with Danish and Wil in the 7/28 meeting, not yet reviewed with the full backend team or implemented
**Builds on:** the 7/23 meeting decision to move call recordings off Supabase and onto Appwrite (Supabase's 1GB storage tier fills up fast once audio is involved; Appwrite bills on reads/writes instead and has no hard storage cap)

## 1. Why this needs a decision

Once recordings, call history, and contact information live in separate databases instead of one, something has to tie a given recording and its call-history row back to the right contact. The natural instinct is to use the phone number, since the whole product is call-centric. That instinct breaks for a reason specific to how phone numbers work in this system: DialForge doesn't issue permanent numbers, it rents DIDs. If a business stops paying for a number, the number goes back to the open market and can be picked up by a different customer. If records were keyed by phone number alone, that new customer's calls would land in the previous owner's call history, mixing two different businesses' data under one record. This doc is about the identifier scheme that avoids that, and how it fits into the split-database plan.

> **What's a DID:** A "Direct Inward Dial" number - a phone number DialForge rents from a telephony provider and assigns to a business. Unlike a personal cell number, a DID is only yours as long as the rental is paid; miss a payment and the provider can reassign it to someone else.

## 2. The technical decisions, and why

### A. Split call data across purpose-built databases, not one

Recordings and their metadata will keep growing in a way structured contact rows never will. Mixing them in one database means the heavy, binary-heavy write path (recordings) crowds out the light, frequent write path (contact and call-history updates), and the whole thing hits a storage ceiling sooner than if they were separate. The choice, continuing from 7/23, is Appwrite with the data split into purpose-built collections: one for user/contact information, one for call recordings, one for call history and analytics.

Why not keep it as one database: it was the original plan, and the reason it changed is exactly the storage-ceiling problem above; recordings alone will outgrow a single-tier database well before contact data would.

### B. Do not use phone number as the sole identifier

The concrete failure case, from the 7/28 discussion: Business A rents a DID, misses a payment, the number returns to the open market, Business B starts using that same number through DialForge. If phone number were the key, B's calls would get filed under A's existing contact record, exposing A's history to B and corrupting both. The choice is to make the primary identifier a UUID assigned to each contact, with phone number stored only as an attribute on that record, never as the key itself.

Why not phone number alone: it is exactly the same problem as looking someone up in a large record system (a university's student records, for example) by first name only, more than one record can share the value, and here that collision isn't rare, it's the designed behavior of how DIDs get recycled.

### C. A UUID alone isn't enough to resolve an incoming call

A UUID has no meaning to the outside world, an inbound call still identifies itself by phone number first. So the phone number has to be checked against something else before it's trusted to resolve to a UUID: at minimum, name or company, not phone number in isolation.

Why not "match on phone number, then trust it": that's decision B's failure case again, phone number alone doesn't distinguish the old and new owner of a reassigned number. Requiring a second matching attribute is what actually prevents the mix-up, the UUID is just where the resolved identity lives once verified.

### D. Reuse the existing transcript ID hierarchy instead of inventing a new one

Recordings and transcripts need to be queryable both as a whole conversation and sentence by sentence. Danish recalled seeing only a flat, one-ID-per-sentence structure the last time he looked at the database, with no grouping ID above it. Confirmed in this meeting: the transcription pipeline already generates a master ID for the entire transcript, with each sentence/utterance carrying its own ID nested under that master ID. That is exactly the hierarchy this design needs, so no new ID scheme is required here, just confirmation that the live schema actually reflects it.

Why not design a new hierarchy: introducing a second ID scheme in parallel with one that already exists and is exercised in production would just create two sources of truth for the same relationship.

## 3. What to change, and where

| Where | What | New / Change |
|---|---|---|
| Appwrite: contact/user info collection | Add a UUID as the primary key per contact; keep phone number as a plain attribute, not a key | New |
| Appwrite: call recordings collection | Key each recording by contact UUID + a call ID, not by phone number | New |
| Appwrite: call history / analytics collection | Same UUID-based keying, so recordings and call history both resolve to the same contact | New |
| Inbound call matching logic | Require phone number plus at least one more attribute (name or company) to match before resolving to a UUID, instead of trusting phone number alone | New |
| Transcription pipeline's persisted schema | Verify the master-ID-per-transcript + ID-per-sentence structure is actually present in the live schema, not only in the pipeline's in-memory objects | Status: unverified, action item below |

## Open questions / next steps

- This is a proposal, not yet implemented or reviewed with the full backend team. Per the meeting, the plan is to bring it to backend for review before any schema changes land.
- Exact Appwrite collection and attribute names aren't decided here, this doc is the conceptual split and identifier scheme; naming is a follow-up once backend signs off on the approach.
- Whether the "second matching attribute" in decision C should be a fixed pair (name + company) or configurable per business wasn't discussed and needs an answer before implementation.
- Shuyang to confirm the master-ID/sentence-ID hierarchy (decision D) is actually live in the schema, since Danish's recollection of the database didn't show it last time he checked.
