# Transfer Step 1 — Salesperson SIP Endpoint + Muted Bridge Leg

**Parent doc:** [`call-transfer-architecture.md`](./call-transfer-architecture.md)
**Builds on:** [Steps 1–4, the verified AI SIP loop](./sip-loop-mvp-step-by-step-guidence/) and [Step 5, the demo console](./sip-loop-mvp-step-by-step-guidence/step5-pm-demo-ui.md)
**Status: built and verified (2026-07-21).** This is the "add SIP to the normal call" prerequisite (transfer architecture, decision B) at the Asterisk-endpoint level: a second SIP endpoint the customer can be bridged to, plus the bridge script auto-joining it (muted) to every call.
**Goal of this step:** a salesperson softphone registered as a second SIP endpoint on the same Asterisk as the AI agent leg, and the bridge script originating that leg into the call's mixing bridge, muted, on every call — with clean teardown and no leaks.
**Non-goals:** the `holder` switch, mute/unmute toggling, epoch guard, UI control. Those are [Transfer Step 2](./transfer-step2-holder-switching.md). This step only proves the salesperson channel can be created, registered, and silently bridged.

---

## 1. Why this step exists

The transfer architecture's decision B is the one hard ordering constraint in the whole feature:

> For Asterisk to bridge the customer to a salesperson, the salesperson has to be something Asterisk can dial: a **SIP endpoint** on the same Asterisk. Only when both legs live on one Asterisk is there anything to bridge.

The AI agent leg is already on SIP (Steps 1–4). The salesperson was not. This step puts the salesperson on SIP and proves the three-party bridge (customer + AI externalMedia + salesperson) can be assembled by the bridge script itself.

> **Why the script originates the sales leg, not a manual/dialplan step:**
> Manually originating the sales leg into the `sip-mvp-app` Stasis app while the bridge script is running causes a collision — the script's event loop treats the sales channel's `StasisStart` as a brand-new caller, answers it, and bridges it to a *fresh* externalMedia leg, cascading into orphaned bridges/channels (the same failure mode as the original externalMedia self-collision). The fix is for the script to originate the sales leg itself and track its channel id so it recognizes and skips its own leg's `StasisStart`. This step implements exactly that.

---

## 2. Asterisk config: register the salesperson endpoint

Edited in `asterisk-config/pjsip.conf`, in the active block at the top of the file (above the ~1700 lines of commented sample config). This mirrors the existing `[test-endpoint]` (customer) setup exactly, with a second identity.

### 2.1 The three blocks to add

```
[sales-endpoint]
type=endpoint
context=sip-mvp
disallow=all
allow=ulaw
allow=alaw
auth=sales-auth
aors=sales-endpoint
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
direct_media=no

[sales-auth]
type=auth
auth_type=userpass
password=<sales-secret>        ; the value you set; must match the softphone byte-for-byte
username=sales-endpoint

[sales-endpoint]
type=aor
max_contacts=1
```

### 2.2 Field-by-field

| Field | Value | Why |
|---|---|---|
| Endpoint section name | `[sales-endpoint]` | Arbitrary identity name; must match `username` in the auth block and the softphone's User Name |
| `context` | `sip-mvp` | Same dialplan context as the customer, so a call from this endpoint routes into `Stasis(sip-mvp-app)` |
| `auth` | `sales-auth` | Points at the auth block below |
| `aors` | `sales-endpoint` | **Must equal the AOR section name.** See the name-matching rule below |
| AOR section name | `[sales-endpoint]` | Same string as the endpoint — this is required, see 2.3 |
| `username` (auth) | `sales-endpoint` | What the softphone registers as |
| `password` (auth) | `<sales-secret>` | Any secret string; must be identical in the softphone's Password field |

### 2.3 Name-matching rule (learned the hard way on the customer endpoint)

The AOR section name **must equal the endpoint name** (`sales-endpoint`), and the endpoint's `aors=` line must point at that same string. If the AOR is named something else (e.g. `sales-aor`), the softphone's REGISTER comes through with an empty AOR and Asterisk rejects it:

```
WARNING res_pjsip_registrar.c find_registrar_aor: AOR '' not found for endpoint 'sales-endpoint'
SIP/2.0 404 Not Found
```

This is why both the endpoint section and the AOR section are named `[sales-endpoint]` (they don't collide — Asterisk keys objects by name **and** `type`, so one `type=endpoint` and one `type=aor` with the same name is valid and intended).

### 2.4 The NAT block is mandatory

The four lines `rtp_symmetric=yes`, `force_rport=yes`, `rewrite_contact=yes`, `direct_media=no` are **required**, for the same Docker-NAT reason the customer endpoint needs them:

- `direct_media=no` — keeps Asterisk in the media path. With direct media on, Asterisk steps out and the audio it needs to bridge never reaches it.
- `rtp_symmetric` / `force_rport` / `rewrite_contact` — make Asterisk use where packets actually came from, not the (NAT-hidden) address the softphone advertises.

Omitting these produces a call that connects but carries no audio — silent, no error.

### 2.5 Apply

```bash
docker restart asterisk-mvp
```

(Bind-mounted config, so the edit is already inside the container; the restart reloads it. A `docker restart` clears all in-memory registrations — both softphones must re-register afterward.)

---

## 3. Register the second softphone

The salesperson needs its own softphone registration, separate from the customer's `test-endpoint`.

### 3.1 Softphone: Telephone (Mac App Store), second account

> **Note on softphone choice:** Linphone's macOS build fails on Apple Silicon ("not supported on this Mac"); Zoiper5's onboarding forces a provider-account flow that's hard to escape. Telephone (free, Mac App Store) registers cleanly and is what the customer leg already uses. It supports multiple accounts, so a second identity in the same app works.

Add a second account in Telephone with these fields:

| Field | Value |
|---|---|
| Full Name | anything, e.g. `Sales Rep` (display only) |
| Domain | `127.0.0.1` |
| User Name | `sales-endpoint` |
| Password | `<sales-secret>` — identical to `pjsip.conf`'s `[sales-auth]` password |
| Transport (Advanced) | **UDP** — required; Asterisk is UDP-only. Set this after account creation in the account's advanced/transport settings |

### 3.2 Verify both endpoints are registered

```bash
docker exec asterisk-mvp asterisk -rx "pjsip show contacts"
```

Success = **two** contacts, both live:

```
Contact:  sales-endpoint/sip:sales-endpoint@192.168.65.1:... ... NonQual
Contact:  test-endpoint/sip:test-endpoint@192.168.65.1:...  ... NonQual
Objects found: 2
```

A populated contact URI for each (`sip:<user>@192.168.65.1:<port>`) is the proof, independent of what the softphone UI claims. (`NonQual` = qualify/keepalive pings off; expected and fine.)

---

## 4. Bridge script changes (`sip/scripts/step2_stt_bridge.py`)

The script now originates the salesperson leg into the same mixing bridge it already builds for the customer + externalMedia, and adds it **muted** when it answers.

### 4.1 New globals

Near `current_bridge_id` / `current_ext_channel_id`:

```python
current_sales_channel_id = None
_sales_channel_ids = set()
```

### 4.2 Originate the sales leg in `bridge_call_to_external_media`

After the existing bridge + customer + externalMedia setup:

```python
def bridge_call_to_external_media(caller_channel_id):
    global current_bridge_id, current_ext_channel_id, current_sales_channel_id
    bridge = ari_post("/bridges", type="mixing")
    bridge_id = bridge["id"]
    ari_post(f"/bridges/{bridge_id}/addChannel", channel=caller_channel_id)

    ext_channel = ari_post(
        "/channels/externalMedia",
        app=APP_NAME,
        external_host=EXTERNAL_MEDIA_HOST,
        format="slin16",
    )
    _external_media_channel_ids.add(ext_channel["id"])
    ari_post(f"/bridges/{bridge_id}/addChannel", channel=ext_channel["id"])

    current_bridge_id = bridge_id
    current_ext_channel_id = ext_channel["id"]
    log("CALL", f"bridged {caller_channel_id} + externalMedia {ext_channel['id']} into bridge {bridge_id}")

    # --- TRANSFER (step 1): originate the salesperson leg into the SAME bridge,
    # muted. Answer is async -- the actual addChannel + mute happen when this
    # channel's StasisStart fires (handled in ari_event_loop). Tracked in
    # _sales_channel_ids so its StasisStart is NOT treated as a new caller. ---
    sales = ari_post(
        "/channels",
        endpoint="PJSIP/sales-endpoint",
        app=APP_NAME,
        callerId="Sales",
    )
    _sales_channel_ids.add(sales["id"])
    current_sales_channel_id = sales["id"]
    log("SALES", f"originating sales leg {sales['id']} (ringing, will join muted)")
```

### 4.3 Handle the sales channel's `StasisStart`

In `ari_event_loop`, right after the `_external_media_channel_ids` skip block:

```python
                if channel_id in _external_media_channel_ids:
                    continue

                if channel_id in _sales_channel_ids:
                    # Our own salesperson leg answered -- add to the active bridge, muted.
                    ari_post(f"/bridges/{current_bridge_id}/addChannel", channel=channel_id)
                    requests.post(
                        f"http://{ARI_HOST}/ari/channels/{channel_id}/mute",
                        params={"direction": "in"},
                        auth=(ARI_USER, ARI_PASSWORD),
                    )
                    log("SALES", f"joined bridge muted: {channel_id}")
                    continue
```

`direction=in` mutes only the salesperson's microphone — they still hear everything, which is the natural silent-monitoring state.

### 4.4 Tear down the sales leg on `StasisEnd`

Two additions to the existing `StasisEnd` handler — ignore the sales leg's own end, and clean up the sales leg when the customer hangs up:

```python
            elif event_type == "StasisEnd":
                channel_id = event["channel"]["id"]

                # Our own sales leg ending -- just untrack, no teardown cascade.
                if channel_id in _sales_channel_ids:
                    _sales_channel_ids.discard(channel_id)
                    continue

                if channel_id == current_channel_id:
                    log("CALL", f"ended: {channel_id}", blank_before=2)
                    current_channel_id = None
                    if current_ext_channel_id:
                        ari_delete(f"/channels/{current_ext_channel_id}")
                    if current_bridge_id:
                        ari_delete(f"/bridges/{current_bridge_id}")
                    if current_sales_channel_id:
                        ari_delete(f"/channels/{current_sales_channel_id}")
                        _sales_channel_ids.discard(current_sales_channel_id)
                    _external_media_channel_ids.discard(current_ext_channel_id)
                    current_ext_channel_id = None
                    current_bridge_id = None
                    current_sales_channel_id = None
```

### 4.5 Critical: add the new global to `ari_event_loop`'s `global` declaration

The `StasisEnd` cleanup assigns `current_sales_channel_id = None`. Because the function assigns to it, Python treats it as local unless declared global — so without this line the teardown raises `UnboundLocalError: cannot access local variable 'current_sales_channel_id'`. The function's globals must include it:

```python
    global current_channel_id, current_company, current_voice, conversation_history
    global current_bridge_id, current_ext_channel_id, current_sales_channel_id
```

---

## 5. Verification (the deliverable)

**Deliverable:** on a customer call, the bridge script auto-originates the salesperson leg; when answered, all three channels (customer, externalMedia, salesperson) share one mixing bridge with the salesperson muted; on hangup, everything tears down with zero leaks.

### 5.1 Steps

1. Both softphones registered (`pjsip show contacts` shows 2 contacts).
2. Start the script: `venv/bin/python -u sip/scripts/step2_stt_bridge.py`
3. Dial 1000 from the **customer** softphone (`test-endpoint`).
4. Expected script output:
   ```
   [CALL] arrived: <id>
   [CALL] bridged <id> + externalMedia <id> into bridge <bridge-id>
   [SALES] originating sales leg <id> (ringing, will join muted)
   [RTP] first packet received (652 bytes)
   [SALES] joined bridge muted: <id>
   ```
5. **Answer the salesperson softphone** when it rings.
6. Confirm the three-party bridge:
   ```bash
   docker exec asterisk-mvp asterisk -rx "bridge show all"
   ```
   Expected: `Chans` = **3**, type `softmix` (a mixing bridge with three legs).
7. Hang up the customer. Expected: a clean `[CALL] ended: <id>` with **no** `UnboundLocalError`, then:
   ```bash
   docker exec asterisk-mvp asterisk -rx "core show channels"
   ```
   Expected: `0 active channels`.

### 5.2 Verified result (2026-07-21)

Passed. `bridge show all` showed one `softmix` bridge with 3 channels; the script logged `[SALES] joined bridge muted`; after fixing the missing global (5.4 below), hangup produced clean teardown and `core show channels` returned `0 active channels`.

---

## 6. Failures log

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | Manual `originate` of the sales leg into `sip-mvp-app` (script running) created orphaned bridges + stranded `UnicastRTP` channels | The script's event loop saw the sales channel's `StasisStart` and treated it as a new caller — answered it, bridged it to a fresh externalMedia, cascading | Stop hand-originating; have the script originate the sales leg itself and track its id in `_sales_channel_ids` to skip its own `StasisStart` (section 4) |
| 2 | `UnboundLocalError: cannot access local variable 'current_sales_channel_id'` on hangup | `current_sales_channel_id` assigned in `StasisEnd` cleanup but not in the function's `global` declaration → Python treated it as a local read-before-assignment | Add `current_sales_channel_id` to `ari_event_loop`'s `global` line (section 4.5) |
| 3 | Orphaned `UnicastRTP` channels accumulating across runs (`0 active calls` but N `active channels`) | externalMedia/sales legs don't self-hangup; a script crash mid-teardown (or Ctrl+C mid-call) skips `StasisEnd` cleanup | `docker restart asterisk-mvp` to clear; re-register both softphones. Long-term: a startup sweep of pre-existing `UnicastRTP` channels |

---

## 7. Known limitations / assumptions (carried into Step 2)

| Assumption | Note |
|---|---|
| Single active call | `current_bridge_id` / `current_sales_channel_id` are global singletons. A second call arriving before the first's sales leg answers would bind the sales leg to the wrong bridge. Single-active-call is MVP scope |
| Salesperson must answer | If the sales phone isn't answered, the leg stays `Down`, never fires `StasisStart`, never joins — call proceeds AI-only. No-answer handling is deferred |
| Mute not audible-testable solo | With both softphones on one Mac and one speaker, "salesperson is muted" is hard to verify by ear. Confirm structurally: `docker exec asterisk-mvp asterisk -rx "core show channel <sales-id>" \| grep -i mute` |
| Post-restart ritual | Every `docker restart` clears registrations and channels. After a restart: re-register both softphones, and check `core show channels` is `0` before testing |

---

## 8. Post-restart checklist (operational)

After any `docker restart asterisk-mvp`:

1. Re-register **both** softphones (`test-endpoint` and `sales-endpoint`) — toggle each account, or wait for the 300s re-register cycle.
2. `docker exec asterisk-mvp asterisk -rx "pjsip show contacts"` → 2 live contacts.
3. `docker exec asterisk-mvp asterisk -rx "core show channels"` → `0 active channels` (sweep stragglers first if any).
4. Confirm NAT config survived (only if configs were touched):
   `docker exec asterisk-mvp asterisk -rx "pjsip show endpoint sales-endpoint" | grep -E "direct_media |rtp_symmetric"`

---

## Next

[Transfer Step 2 — `holder` switching](./transfer-step2-holder-switching.md): make who-is-audible switchable. A single `holder` value (`ai`/`human`) derives mute, LLM gating, and TTS suppression; triggered first by DTMF (`*1`), then by a dashboard toggle, with an epoch guard so in-flight AI turns don't play after a takeover.