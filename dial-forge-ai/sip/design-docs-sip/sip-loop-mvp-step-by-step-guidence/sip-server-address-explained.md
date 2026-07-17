# SIP Server Address: What to Register Against

**Parent doc:** [`./step1-environment-setup.md`](./step1-environment-setup.md) - section 2, "Registration fields"

This explains what value to put in a softphone's "Domain / SIP server" field, and why. The short version: on macOS Docker Desktop, you never need to hunt for a "Docker container internal IP" - that instinct comes from Linux Docker tutorials and doesn't apply here.

## If the softphone and Docker are on the same Mac

| Field | Value |
|---|---|
| SIP server | `127.0.0.1` or `localhost` |
| Port | `5060` |
| Transport | `UDP` |

This works because `docker run` already published the container's port onto the Mac itself via `-p 5060:5060/udp` in the `docker run` command from step 1.3. The container's `5060` port is mapped straight onto the Mac's own network stack, so the softphone just needs to talk to the Mac, not to anything Docker-internal.

## If the softphone is on a different device

For example:
- Asterisk's Docker container runs on your MacBook
- The softphone runs on your iPhone
- Both devices are on the same Wi-Fi

In this case, `localhost` will not work. On the iPhone, `localhost` refers to the iPhone itself, not your Mac.

You need the Mac's LAN IP on the current Wi-Fi network instead. Find it by running one of these in the Mac's Terminal:

| Command | When to use |
|---|---|
| `ipconfig getifaddr en0` | Wi-Fi on most Macs - try this first |
| `ipconfig getifaddr en1` | Fallback if `en0` returns nothing |
| `ipconfig getifaddr en2` | Fallback (e.g. on Ethernet) |

Say the output is `192.168.1.25`. Then on the phone's softphone, fill in:

| Field | Value |
|---|---|
| SIP server | `192.168.1.25` (your Mac's actual LAN IP) |
| Port | `5060` |
| Transport | `UDP` |

Each teammate will get a different IP here depending on whatever network their laptop is on - there's no single value to hardcode into any doc.

## Why not hunt for a Docker container IP

Many Linux Docker tutorials tell you to look for a container IP that looks like `172.17.0.2`. That doesn't apply here:

| | Linux Docker assumption | Docker Desktop for Mac (actual) |
|---|---|---|
| Same machine | container's `docker0` bridge IP | `localhost` |
| Other device on the LAN | container's `docker0` bridge IP | Mac's LAN IP |

In Docker Desktop for Mac, the container actually runs inside a hidden Linux VM, and that internal VM address is generally not something the Mac or the phone should connect to directly.

## Confirm the ports are actually open

| Command | Tests |
|---|---|
| `nc -z -v -u localhost 5060` | SIP signaling, UDP port `5060` |
| `nc -z -v localhost 8088` | ARI's HTTP server, TCP port `8088` |

Both should report success against the running `asterisk-mvp` container.

> One-line summary: don't hunt for the Asterisk Docker container's IP. On the Mac itself, fill in `localhost`; on a phone, fill in the Mac's Wi-Fi IP.
