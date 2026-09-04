"""
Phase 4 PoC -- does NOT touch stt_bridge_final.py or any live company extension.

Shuyang's spec (2026-08-28): before rewriting Phase 4 around Asterisk's
chan_websocket, prove the transport itself works in isolation.

    Asterisk -> chan_websocket -> this tiny server -> echo audio back -> Asterisk

Four things this is meant to answer, nothing else:
  1. does audio from the call reliably arrive here?
  2. does the PCM this sends back play reliably in the call?
  3. what's the round-trip latency?
  4. do repeated calls / hangup / redial behave, or does state leak between calls?

Protocol details below are taken directly from Asterisk's own reference
implementation (asterisk/asterisk-websocket-examples, mow_echo_test_server.py,
Apache-2.0), not guessed from the docs -- the docs' web page turned out to
paraphrase a couple of details (JSON vs plain-text control messages) that the
reference script and this Asterisk 22.9.0 container's own `core show
application Dial` output settled: plain-text control messages, subprotocol
"media", codec token is "sln16" (not "slin16"), HTTP Basic Auth on connect.

Live echo, not the reference script's buffer-then-compare file-replay mode:
every binary (audio) frame is sent straight back as soon as it arrives, so
this measures the same kind of round-trip a real conversational turn would
need, not a bulk transfer.

Run (from sip/scripts/): ../../venv/bin/python -u poc_chan_websocket_echo.py
Dial extension 9000 from Linphone to hit it (asterisk-config/extensions.conf).
"""

import time

from websockets.asyncio.server import basic_auth, serve

HOST = "0.0.0.0"
PORT = 8790
USERNAME = "pipecat_poc"
PASSWORD = "EiWxmiMD8veNDmZZHeckmf8u"  # matches asterisk-config/websocket_client.conf


def _log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


async def handle_media(ws):
    channel_name = "?"
    frame_count = 0
    byte_count = 0
    call_start = time.monotonic()
    last_frame_at = None

    _log(f"connection opened from {ws.remote_address}")

    try:
        async for message in ws:
            if isinstance(message, str):
                # Plain-text control message, e.g.
                # "MEDIA_START connection_id:... channel:WebSocket/... format:sln16 optimal_frame_size:320"
                _log(f"control: {message}")
                if message.startswith("MEDIA_START"):
                    for pair in message.split(" ")[1:]:
                        if ":" not in pair:
                            continue
                        key, _, value = pair.partition(":")
                        if key == "channel":
                            channel_name = value
                continue

            # Binary frame = raw audio (sln16, no headers). Echo it straight
            # back -- this is the round trip the latency question is about.
            now = time.monotonic()
            gap_ms = None if last_frame_at is None else (now - last_frame_at) * 1000
            last_frame_at = now

            send_start = time.monotonic()
            await ws.send(message)
            echo_ms = (time.monotonic() - send_start) * 1000

            frame_count += 1
            byte_count += len(message)
            if frame_count <= 5 or frame_count % 50 == 0:
                gap_str = f"{gap_ms:.1f}ms" if gap_ms is not None else "n/a"
                _log(
                    f"{channel_name}: frame {frame_count} ({len(message)}B, "
                    f"gap since prior frame {gap_str}, echo-send took {echo_ms:.1f}ms)"
                )

    except Exception as e:
        _log(f"error for {channel_name}: {type(e).__name__}: {e}")
    finally:
        elapsed = time.monotonic() - call_start
        _log(
            f"connection closed for {channel_name}: {frame_count} frames, "
            f"{byte_count} bytes, {elapsed:.1f}s"
        )


async def main():
    _log(f"listening on ws://{HOST}:{PORT}/ (subprotocol 'media', basic auth)")
    async with serve(
        handle_media,
        HOST,
        PORT,
        subprotocols=["media"],
        process_request=basic_auth(realm="asterisk", credentials=(USERNAME, PASSWORD)),
    ) as server:
        await server.serve_forever()


if __name__ == "__main__":
    import asyncio

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
