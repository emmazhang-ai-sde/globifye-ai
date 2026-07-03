# Step 1 - Environment Setup

**Parent doc:** [`../sip-loop-mvp-design-doc.md`](../sip-loop-mvp-design-doc.md) - section 4, Step 1
**Goal of this step:** get Asterisk running with ARI enabled, and prove a single test call reaches it. Nothing else - no STT, no TTS yet.

---

## 1. Why Docker for the MVP

Since nobody on the team has run Asterisk before, install it via Docker rather than compiling/apt-installing it directly on a box. Docker gives a disposable, reproducible environment - if the config gets tangled, `docker rm` and start over instead of debugging a half-broken native install.

### 1.1 Installation

If Docker isn't already on the box, install it from the terminal:

```bash
# macOS
brew install --cask docker

# Linux
curl -fsSL https://get.docker.com | sudo sh
```

Then pull the Asterisk image:

```bash
docker pull andrius/asterisk
# or build from the official Asterisk source Dockerfile if andrius/asterisk feels unmaintained -
# either works for an MVP, andrius/asterisk is just the fastest way to get something running today
```

### 1.2 Seed the local config directory first

The container we run in the next step mounts `./asterisk-config` over `/etc/asterisk` inside the container. If that local folder doesn't exist yet, Docker silently creates an *empty* one and mounts it - which wipes out the image's default config files and makes Asterisk crash on startup (`Exited (1)`, complaining about missing `modules.conf` / `logger.conf`). Pull the image's default configs out before mounting anything:

```bash
# start a throwaway container with no volume mount, so it boots with the image's built-in configs
docker run -d --name asterisk-seed andrius/asterisk

# copy those default configs to the host
docker cp asterisk-seed:/etc/asterisk ./asterisk-config

# done - remove the throwaway container
docker rm -f asterisk-seed
```

Now `./asterisk-config` is populated and safe to mount.

### 1.3 Asterisk config

Run the real container with the SIP/RTP ports exposed and the seeded config directory mounted:

```bash
docker run -d --name asterisk-mvp \
  -p 5060:5060/udp \
  -p 8088:8088/tcp \
  -p 10000-10100:10000-10100/udp \
  -v $(pwd)/asterisk-config:/etc/asterisk \
  andrius/asterisk
```

- `5060/udp` - SIP signaling
- `8088/tcp` - Asterisk's built-in HTTP server (this is what ARI's REST + WebSocket interface rides on)
- `10000-10100/udp` - RTP media range (kept small for local testing; production would need a wider range)

> **What's ARI:**
>
> ARI = **Asterisk REST Interface**. It's an HTTP REST API plus a WebSocket, both exposed over the `8088/tcp` port above, that let an external program control calls instead of relying only on the static rules written in `extensions.conf`.
>
> Concretely, an ARI client (the Python/Node script in section 3 below) does two things:
> - **Subscribes over the WebSocket** to events, e.g. `StasisStart` - "a call just got routed to me."
> - **Calls the REST API** to act on that call - answer it, hang it up, transfer it, play audio, etc.
>
> This matters here because `extensions.conf` (file 4 below) hands a call off to ARI via a `Stasis()` step - at that point, control passes from Asterisk's static dialplan to whatever code is subscribed on the other end of ARI.

Check it actually stayed up (Asterisk containers can exit immediately if the config is bad):

```bash
docker ps -a --filter name=asterisk-mvp   # STATUS should say "Up", not "Exited"
docker logs asterisk-mvp                  # look for "Asterisk Ready" near the end
```

Four files inside `./asterisk-config` matter. They came from the seed step above, so each one already has the image's full default/commented content - don't delete that, just add the lines below to it. Edit them from the host; the mount means changes show up inside the container immediately (a `docker restart` is still needed for Asterisk to reload them - see the end of this section).

**1. `http.conf`**

This file already has a `[general]` section with everything commented out. Find these three commented lines and uncomment / change them (leave the rest of the file's comments alone):
```diff
- ;enabled=yes
+ enabled=yes
- bindaddr=127.0.0.1
+ bindaddr=0.0.0.0
- ;bindport=8088
+ bindport=8088
```
Turns on the built-in HTTP server ARI rides on, and binds it to all interfaces (not just localhost) so it's reachable from outside the container.

**2. `ari.conf`**

This file's `[general]` section already has `enabled = yes` by default (leave it). Uncomment `pretty` and set it to `yes`:
```diff
- ;pretty = no
+ pretty = yes
```
Then add a brand-new section at the bottom of the file for the ARI account your script will authenticate as:
```ini
[sip-mvp-user]
type = user
read_only = no
password = changeme_use_a_real_secret
```

**3. `pjsip.conf`**

This file ships as ~1700 lines of commented sample config with nothing actually loaded. Don't try to find-and-edit inside that; instead **insert a new block at the very top of the file**, above all the sample text, so it's unambiguous which config is real:
```ini
; =====================================================================
; SIP MVP - active config (everything below this block is Asterisk's
; commented sample/reference file, kept for reference, not loaded)
; =====================================================================

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
This registers one test SIP endpoint (`test-endpoint`) so a softphone can dial in - no external trunk needed for the MVP.

> **What's an AOR:**
>
> AOR = Address Of Record, a SIP protocol concept. In short, it's the record Asterisk uses to track "which network address is this user (e.g. `test-endpoint`) currently reachable at."
>
> ```
> 1. Softphone (Linphone) starts up and sends a REGISTER request to Asterisk:
>    "I'm test-endpoint, my current IP/port is xxx, please remember this"
>                          |
>                          v
> 2. Asterisk stores the "username -> current contact address" mapping.
>    This stored record IS the AOR.
>                          |
>                          v
> 3. Later, when someone calls test-endpoint, Asterisk looks up this AOR
>    record, finds where Linphone actually is right now, and forwards
>    the call there.
> ```

**4. `extensions.conf`**

Unlike `pjsip.conf`, this file already has real, active contexts (`[general]`, `[globals]`, etc.), so **append a new context at the end of the file** instead of touching the top:
```ini
; =====================================================================
; SIP MVP - active dialplan: routes test-endpoint's call into the ARI
; Stasis app (sip-mvp-app). See step1-environment-setup.md
; =====================================================================
[sip-mvp]
exten => 1000,1,NoOp(Routing call into ARI)
 same => n,Stasis(sip-mvp-app)
 same => n,Hangup()
```
This is the dialplan that routes an incoming call into the ARI Stasis application (the bridge between "a call came in" and "your code gets notified"). `sip-mvp-app` is an arbitrary name - it's the Stasis application name your ARI client will subscribe to. `context=sip-mvp` in `pjsip.conf`'s `[test-endpoint]` above must match this `[sip-mvp]` context name exactly.

> **What's a Stasis app:**
>
> A **Stasis application** is a name for "hand this call's control over to whatever ARI client has subscribed with this name," instead of continuing to run the static instructions written in the dialplan.
>
> - `Stasis(sip-mvp-app)` in `extensions.conf` above means: stop following dialplan steps, and route this call to any ARI client subscribed to the app named `sip-mvp-app`.
> - An ARI client "subscribes" by connecting to the WebSocket and calling something like `client.run(apps='sip-mvp-app')` (the Python script in section 3 does exactly this).
> - The name itself (`sip-mvp-app`) is arbitrary - it's not a keyword, just a label that has to match exactly on both sides: the `Stasis(...)` call in `extensions.conf`, and the `apps=` argument in the ARI client script.
>
> If nothing is currently subscribed under that name, `Stasis()` has nowhere to hand the call off to, so Asterisk logs a warning (`Stasis app 'sip-mvp-app' doesn't exist`) and falls through to whatever comes next in the dialplan - in our case, `Hangup()`. That's exactly the behavior in the "dial the test extension" note in section 2 below, before an ARI client is running.

After editing all four files, restart the container so Asterisk reloads them:

```bash
docker restart asterisk-mvp
docker logs asterisk-mvp | tail -20   # confirm "Asterisk Ready" again, no crash
```

Verify each piece actually took effect, without needing a softphone yet:

```bash
# HTTP server + ARI REST paths are bound
docker exec asterisk-mvp asterisk -rx "http show status"

# the test endpoint exists (state will show "Unavailable" until a softphone registers - that's expected)
docker exec asterisk-mvp asterisk -rx "pjsip show endpoint test-endpoint"

# the dialplan context exists and routes extension 1000 into Stasis
docker exec asterisk-mvp asterisk -rx "dialplan show sip-mvp"

# ARI REST auth actually works end to end
curl -u sip-mvp-user:changeme_use_a_real_secret http://localhost:8088/ari/asterisk/info
```
The `curl` call should return a JSON blob with Asterisk version info - if you get `401`, the `ari.conf` username/password don't match what you passed to `curl`.

## 2. Get a test call in

> **What's a softphone:**
>
> An app that acts like a physical SIP desk phone but runs on your laptop or mobile device instead - no physical handset needed. It registers to a SIP server (here, our `asterisk-mvp` container) with a username/password, the same way a real office phone would, and lets you place and receive calls through it. We use one here purely as a free, disposable test client to prove the SIP signaling path works, before any real phone number or hardware is involved.

Fastest path, zero external cost: 
- install a free softphone client on your laptop, 
- register it against `test-endpoint`, and 
- dial extension `1000`.

> **Which softphone (finally pick Linphone):**
>
> [Linphone](https://www.linphone.org/) and [Zoiper](https://www.zoiper.com/) are both free, widely-used softphone apps - either works fine for this test, we just need to pick one.
>
> | Softphone | Install method | Notes |
> |---|---|---|
> | **Linphone** | `brew install --cask linphone` | Installs cleanly via **Homebrew**, macOS's standard command-line package manager.<br><br>`brew install X` downloads and installs `X` for you, no manual download / drag-to-Applications needed.<br><br>`--cask` is Homebrew's flag for full GUI apps (e.g. `brew install --cask google-chrome`), as opposed to plain command-line tools which skip the flag (e.g. `brew install git`).<br><br>Homebrew catalogues these GUI apps in what's called the **cask list**. |
> | **Zoiper** | Manual download from [zoiper.com](https://www.zoiper.com/) | Not in Homebrew's cask list, so `brew install --cask zoiper` won't find it.<br><br>You'd have to manually download the installer from Zoiper's site and drag it into Applications yourself. |
>
> Functionally the two are equivalent for this MVP test - both are free, both can register a SIP endpoint, both can place a call. The only real difference is install friction, so use **Linphone** unless you already have Zoiper.



**1. Open Linphone, skip its default "create a linphone.org account" wizard**

On first launch it pops up a "Create Account / Use SIP Account" onboarding screen. Choose **"Use a SIP Account"**, not the linphone.org signup - you're connecting to your own Asterisk, not Linphone's official server.

**2. Fill in the registration info**

Go to **Settings → Accounts / SIP Accounts → add account**, and fill in these fields (matches Linphone's UI; Zoiper's field names are close enough to map 1:1):

| Field | What to fill in |
|---|---|
| Username | `test-endpoint` |
| Password | `changeme_use_a_real_secret` |
| Domain | `127.0.0.1:5060` (same machine) or `<Mac LAN IP>:5060` (cross-device).<br>Write the port explicitly - if you only put `127.0.0.1`, some clients default to guessing the TLS port `5061` instead of UDP `5060`.<br>See [why: sip-server-address-explained.md](./sip-server-address-explained.md) for which address to use. |
| Display name | Anything, e.g. `SIP MVP Test`, or leave blank - doesn't affect functionality |
| Transport | Open the dropdown and change the default `TLS` to `UDP`.<br>This one is required - our Asterisk only has UDP configured, not TLS. |
| Authentication ID (if shown) | Leave blank (only needed when it differs from Username) |
| Registrar URI | Leave blank - the client derives it from Domain + Transport |
| Outbound SIP Proxy URI | Leave blank |

**3. Confirm registration succeeded, from the Asterisk side**

Linphone's own UI will show something like "Registered" once it thinks it's connected, but that's the client's opinion - confirm it from the server side too, since the two don't always agree. Run this from your terminal (not inside the container):

```bash
docker exec asterisk-mvp asterisk -rx "pjsip show endpoint test-endpoint"
```

Breaking that command down:
- `docker exec asterisk-mvp` - run a command inside the already-running `asterisk-mvp` container
- `asterisk -rx "..."` - `-r` connects to the Asterisk process that's already running in the background (the "remote console"); `-x "..."` runs the quoted Asterisk management command once and exits, instead of dropping into an interactive console
- `"pjsip show endpoint test-endpoint"` - Asterisk's built-in query for a given PJSIP endpoint's current registration/status

The output is long, but the lines that matter are:

```
 Endpoint:  test-endpoint       Not in use    0 of inf
     InAuth:  test-auth/test-endpoint
        Aor:  test-endpoint                                      1
      Contact:  test-endpoint/sip:test-endpoint@192.168.65...   NonQual
```

A populated `Contact:` line (an actual `sip:test-endpoint@<ip>...` address, not blank) means Linphone's `REGISTER` reached Asterisk and got stored as this endpoint's AOR - registration genuinely succeeded, independent of what the softphone's UI claims.

**4. Dial the test extension**

Once registered, dial `1000`. This proves the SIP signaling path works without needing a PSTN trunk or a real phone number - that's a separate, later concern (DID provisioning is Abraham's pricing track, not this MVP).

> **Dial attempt 1 of 3 - expected result at this point: the call gets dropped immediately, that's normal, not a bug.**
>
> Before any ARI client exists (that's section 3, next), Linphone's call log will show `1000` with a red arrow icon (not connected / hung up). Check what actually happened from Asterisk's side:
>
> ```bash
> docker logs asterisk-mvp --tail 50
> ```
>
> You should see the dialplan execute in order:
>
> ```
> 1. NoOp("Routing call into ARI")            <- dial reached Asterisk, entered the dialplan
> 2. Stasis("sip-mvp-app")                    <- tried to route into ARI
>    WARNING: Stasis app 'sip-mvp-app' doesn't exist   <- nothing has subscribed to it yet
> 3. Hangup()                                 <- so it just hangs up
> ```
>
> That confirms two separate things:
> - **SIP signaling works end to end** - from Linphone dialing, to Asterisk receiving it, to the dialplan routing it into the `sip-mvp` context's `1000` extension. Nothing to fix here.
> - **The hangup is expected** - `sip-mvp-app` is a Stasis application, and Stasis applications only exist once something is actively subscribed to them. Right now nothing is (that's what the Python/Node script in section 3 does). This isn't a config error, it's just this step's known limitation until section 3's script is running.

## 3. Verify ARI receives the call

### 3.1 Pick a library and know what the script needs to do

Two library options, both verified to actually exist before relying on them here:

| Language | Install | Notes |
|---|---|---|
| Python | `pip install ari` | Confirmed on [PyPI](https://pypi.org/project/ari/), latest `0.1.3`, published by the official `asterisk/asterisk_rest_libraries` GitHub org, not a random third-party package.<br>Any Python 3 works; this box already has Python 3.14.5 / pip 26.1.1 installed. |
| Node | `npm install ari-client` | Confirmed present on the npm registry. |

Either is fine for the MVP; pick whichever the person writing this script is more comfortable in. The saved script: [`sip/scripts/verify_ari.py`](../../sip/scripts/verify_ari.py) - it connects over a raw websocket + `requests` instead of the `ari` package, same behavior (connect to ARI, subscribe to `sip-mvp-app`, answer on `StasisStart`).

`http://localhost:8088` only resolves for a script running on the same Mac as Docker; if run elsewhere on the LAN, swap in the Mac's LAN IP from section 2 above.

### 3.2 Run the script

Run it yourself so its output prints directly in your own terminal, where you can see it live:

```bash
python3 sip/scripts/verify_ari.py
```

It'll print `Connecting to ...` then `Connected. Waiting for calls into sip-mvp-app` and then sit there - that's it listening, not stuck. Any `Call arrived: channel <id>` line will show up in that same terminal window the moment a call comes in.

Only run **one** instance of this script at a time. Since it subscribes to the `sip-mvp-app` Stasis application, two instances running together will race each other for the same incoming call - pick either your own terminal or a background-run copy, not both.

> **Dial attempt 2 of 3 - if the script's output isn't showing up anywhere, even after a call connects, check for Python's output buffering.**
>
> Running the script directly in an interactive terminal (as above) doesn't have this problem - it flushes each `print()` line by line. But if it's run in the background with its output redirected to a file (e.g. `python3 sip/scripts/verify_ari.py > log.txt &`), Python buffers `print()` output by default and only writes it out in chunks - so the log file can look empty for a while even though the script is alive and working correctly. This is a general Python behavior, not a bug in `verify_ari.py`.
>
> Two ways to check whether that's what's going on:
> - Confirm the process is actually still running (e.g. `ps` for its PID), and that Asterisk shows the call as connected (`docker exec asterisk-mvp asterisk -rx "core show channels"` should show the channel `State: Up`, sitting in `Stasis(sip-mvp-app)`).
> - Query the channel directly through the ARI REST API to see if `answer()` actually went out, independent of whether the log file shows it yet.
>
> The fix is to run Python unbuffered, so every `print()` is written out immediately:
> ```bash
> python3 -u sip/scripts/verify_ari.py
> ```
> `-u` is a flag to the Python interpreter itself (not a change to `verify_ari.py`) - it just changes how output is flushed, not what the script does.

### 3.3 Confirm the subscription, from the Asterisk side, before dialing

Once the script is running, don't just trust that it printed something like "connected" - confirm Asterisk itself sees the subscription:

```bash
docker exec asterisk-mvp asterisk -rx "ari show apps"
```

Breaking that down (same pattern as the `pjsip show endpoint` check in section 2):
- `docker exec asterisk-mvp` - run a command inside the already-running `asterisk-mvp` container
- `asterisk -rx "..."` - connect to the running Asterisk process, run the quoted management command once, then exit
- `"ari show apps"` - Asterisk's built-in command listing every Stasis app name that currently has an ARI client subscribed to it

Before the script is running, this returns nothing:
```
Application Name
=========================
```

After the script connects and subscribes, it shows the app name:
```
Application Name
=========================
sip-mvp-app
```

Same reasoning as before: confirm from Asterisk's own bookkeeping that the subscription actually registered, rather than trusting the client's (the script's) side of the story.

### 3.4 Dial and confirm the deliverable

**Deliverable for this step:** dialing `1000` from the softphone prints `Call arrived: channel <id>` in this script's output, and the call is answered (silence on the line is fine - no audio pipeline yet).

> **Dial attempt 3 of 3 - ✅ verified.** Dialing `1000` produced `Call arrived: channel 1782952188.3` in the script's output, and Asterisk's own logs show the full expected path with no errors this time: dial -> `NoOp` -> `Stasis(sip-mvp-app)`, no "app doesn't exist" warning. The call was actually answered by the script, not hung up. Step 1's deliverable is met.

### 3.5 Debugging timeline: what the three dial attempts actually showed

| Attempt | What happened | Root cause | What changed before the next attempt |
|---|---|---|---|
| 1 | Dialed `1000`, call dropped immediately - Linphone's call log showed a red (not connected) icon. | No ARI client had subscribed to the `sip-mvp-app` Stasis app yet. `Stasis()` in `extensions.conf` had nowhere to hand the call off to, so the dialplan fell through to `Hangup()`. Confirmed via `docker logs asterisk-mvp`: `WARNING: Stasis app 'sip-mvp-app' doesn't exist`. | Wrote and started `verify_ari.py` (section 3.1-3.2), so a client would actually be subscribed to `sip-mvp-app` before dialing again. |
| 2 | Dialed `1000` again. This time the call connected and stayed up - `docker exec asterisk-mvp asterisk -rx "core show channels"` showed `State: Up`, sitting in `Stasis(sip-mvp-app)`. But the script's output file stayed empty. | The call and the script both actually worked - `StasisStart` fired and `answer()` was sent. The script's `print()` output just hadn't been flushed to the log file yet, because Python buffers stdout by default when it isn't a live terminal (e.g. redirected to a file for a background run). Not a bug in `verify_ari.py`. | Killed the buffered process, restarted it with `python3 -u verify_ari.py` (see the buffering note in 3.2) so every `print()` flushes immediately instead of sitting in a buffer. |
| 3 | Dialed `1000` a third time. | - | Script printed `Call arrived: channel 1782952188.3` immediately, and the call stayed connected. Step 1's deliverable is met. |

---

## Common Pitfalls (flagging since this is new territory for the team)

| Symptom | Likely cause |
|---|---|
| Container exits immediately (`Exited (1)`) right after `docker run` | `./asterisk-config` was empty when mounted, wiping the image's default configs - see "1.2 Seed the local config directory first" above |
| Softphone can't register | Check `pjsip.conf` port/firewall; confirm 5060/udp is actually reachable from your softphone's network |
| Call connects but drops immediately | Dialplan typo - check `extensions.conf` context name matches the endpoint's `context=` |
| No audio / one-way audio | Codec mismatch (`allow=ulaw`/`allow=alaw`) or NAT - if softphone and Asterisk aren't on the same LAN, you'll likely need `external_media_address` / `external_signaling_address` set in `pjsip.conf`'s transport section |
| ARI script never fires `StasisStart` | `ari.conf` user doesn't match what the script connects with, or the dialplan never reaches the `Stasis()` line - add `NoOp()` logging lines to `extensions.conf` to confirm the call is even routing there |

Same-machine (softphone + Asterisk on one LAN) testing avoids most NAT issues - start there before testing across networks.

## Next

Once a test call reliably reaches ARI and gets answered, move to [Step 2 - Wire call audio into STT](./step2-wire-call-audio-into-stt.md).
