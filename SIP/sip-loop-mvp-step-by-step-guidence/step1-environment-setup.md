# Step 1 — Environment Setup

**Parent doc:** [`../sip-loop-mvp-design-doc.md`](../sip-loop-mvp-design-doc.md) — section 4, Step 1
**Goal of this step:** get Asterisk running with ARI enabled, and prove a single test call reaches it. Nothing else — no STT, no TTS yet.

---

## 1. Why Docker for the MVP

Since nobody on the team has run Asterisk before, install it via Docker rather than compiling/apt-installing it directly on a box. Docker gives a disposable, reproducible environment — if the config gets tangled, `docker rm` and start over instead of debugging a half-broken native install.

```bash
docker pull andrius/asterisk
# or build from the official Asterisk source Dockerfile if andrius/asterisk feels unmaintained —
# either works for an MVP, andrius/asterisk is just the fastest way to get something running today
```

Run it with the SIP/RTP ports exposed:

```bash
docker run -d --name asterisk-mvp \
  -p 5060:5060/udp \
  -p 8088:8088/tcp \
  -p 10000-10100:10000-10100/udp \
  -v $(pwd)/asterisk-config:/etc/asterisk \
  andrius/asterisk
```

- `5060/udp` — SIP signaling
- `8088/tcp` — Asterisk's built-in HTTP server (this is what ARI's REST + WebSocket interface rides on)
- `10000-10100/udp` — RTP media range (kept small for local testing; production would need a wider range)

## 2. Enable ARI

Three config files matter, all under `/etc/asterisk/` (mount this as a volume so you can edit from the host):

**`http.conf`** — turn on the built-in HTTP server ARI depends on:
```ini
[general]
enabled=yes
bindaddr=0.0.0.0
bindport=8088
```

**`ari.conf`** — create ARI credentials and allow the app to connect:
```ini
[general]
enabled=yes
pretty=yes

[sip-mvp-user]
type=user
read_only=no
password=changeme_use_a_real_secret
```

**`pjsip.conf`** — register at least one SIP endpoint so a test client can dial in. For the MVP, a single local endpoint (no external trunk needed):
```ini
[transport-udp]
type=transport
protocol=udp
bind=0.0.0.0:5060

[test-endpoint]
type=endpoint
context=sip-mvp
disallow=all
allow=ulaw
allow=alaw
auth=test-auth
aors=test-aor

[test-auth]
type=auth
auth_type=userpass
password=changeme_use_a_real_secret
username=test-endpoint

[test-aor]
type=aor
max_contacts=1
```

**`extensions.conf`** — the dialplan that routes an incoming call into the ARI Stasis application (this is the bridge between "a call came in" and "your code gets notified"):
```ini
[sip-mvp]
exten => 1000,1,NoOp(Routing call into ARI)
 same => n,Stasis(sip-mvp-app)
 same => n,Hangup()
```

`sip-mvp-app` is an arbitrary name — it's the Stasis application name your ARI client will subscribe to.

## 3. Get a test call in

Fastest path, zero external cost: install a free softphone client (**Zoiper** or **Linphone**) on your laptop, register it against `test-endpoint` (SIP server = your Docker host IP, username/password from `pjsip.conf` above), and dial extension `1000`.

This proves the SIP signaling path works without needing a PSTN trunk or a real phone number — that's a separate, later concern (DID provisioning is Abraham's pricing track, not this MVP).

## 4. Verify ARI receives the call

Use a small script (Python `ari` library or Node `ari-client` npm package) to connect to the ARI WebSocket and subscribe to the Stasis app:

```python
import ari

client = ari.connect('http://localhost:8088', 'sip-mvp-user', 'changeme_use_a_real_secret')

def on_stasis_start(channel, ev):
    print(f"Call arrived: channel {channel.id}")
    channel.answer()

client.on_channel_event('StasisStart', on_stasis_start)
client.run(apps='sip-mvp-app')
```

**Deliverable for this step:** dialing `1000` from the softphone prints `Call arrived: channel <id>` in this script's output, and the call is answered (silence on the line is fine — no audio pipeline yet).

---

## Common Pitfalls (flagging since this is new territory for the team)

| Symptom | Likely cause |
|---|---|
| Softphone can't register | Check `pjsip.conf` port/firewall; confirm 5060/udp is actually reachable from your softphone's network |
| Call connects but drops immediately | Dialplan typo — check `extensions.conf` context name matches the endpoint's `context=` |
| No audio / one-way audio | Codec mismatch (`allow=ulaw`/`allow=alaw`) or NAT — if softphone and Asterisk aren't on the same LAN, you'll likely need `external_media_address` / `external_signaling_address` set in `pjsip.conf`'s transport section |
| ARI script never fires `StasisStart` | `ari.conf` user doesn't match what the script connects with, or the dialplan never reaches the `Stasis()` line — add `NoOp()` logging lines to `extensions.conf` to confirm the call is even routing there |

Same-machine (softphone + Asterisk on one LAN) testing avoids most NAT issues — start there before testing across networks.

## Next

Once a test call reliably reaches ARI and gets answered, move to [Step 2 — Wire call audio into STT](./step2-wire-call-audio-into-stt.md).
