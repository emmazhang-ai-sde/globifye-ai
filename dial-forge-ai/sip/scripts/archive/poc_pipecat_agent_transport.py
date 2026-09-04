"""
Phase 4 step 2 (frame-migration-decision-and-plan.md, section 4.10):
wire real STT/LLM/TTS into Step 1's chan_websocket transport
(poc_pipecat_transport.py), replacing FrameLevelEchoProcessor.

Still fully isolated, same boundary as step 1: extension 9000, one
hardcoded company, no ARI, no set_holder()/call-transfer integration.
Extension 9000 dials straight into WebSocket (Dial(WebSocket/...), never
Stasis()), so ari_event_loop() never runs for this call -- there's no
current_bridge_id, so play_deepgram()'s ARI-bridge-play path (what the
live agent uses today) cannot work here. TTS audio has no route except
out through transport.output().

Decision 1 (STT): Modulate stays exactly as-is -- same modulate_worker(),
same audio_queue/transcript_queue, imported from stt_bridge_final and
reused directly. This file only adds AgentAudioBridgeProcessor, which
forwards InputAudioRawFrame.audio into that same audio_queue. Importing
stt_bridge_final as a module does NOT start its live RTP/ARI/Modulate
threads -- those only launch under stt_bridge_final's own
`if __name__ == "__main__":` guard (same trick test_hops_safety_valve.py
already relies on). modulate_worker() is started once, here, guarded so a
second call on the same running process doesn't spawn a second thread
racing the first for the same queue.

Decision 2 (LLM/tool loop): pipecat_turn_runner.run_pecat_turn_async() is
imported directly, not through stt_bridge_final. stt_bridge_final's own
_run_turn()/groq_worker() -- what actually drives the live agent on
extensions 1000/2000 -- are never called and never modified. This file
owns its own local conversation_history/current_node per call, and its
own set_stage() closure; it never touches bridge.set_stage() (which
mutates stt_bridge_final's live module globals) or bridge._run_turn().
turn_epoch is a fixed 0 for every turn -- there is no call-transfer/
human-takeover concept in this isolated test.

Decision 3 (TTS): real per-chunk streaming, not buffer-then-play.
TTSQueueBridgeProcessor's existing sentence-level chunking (inside
run_pecat_turn_async()'s pipeline) is untouched -- tts_queue still gets
(sentence, turn_epoch) tuples. What's new is how each sentence becomes
audio: AsyncDeepgramClient's speak.v1.audio.generate() is a real async
generator (confirmed via inspect.isasyncgenfunction on the installed SDK,
deepgram 7.4.0) -- `async for chunk in ...` yields each linear16 chunk as
Deepgram produces it, no asyncio.to_thread wrapper needed, no waiting for
the full utterance. Each chunk becomes its own OutputAudioRawFrame pushed
straight to transport.output(), no WAV file, no ffmpeg, no docker cp, no
ARI play call.

One correction to the doc's original D3 reasoning, found while reading
FastAPIWebsocketTransport's actual output path (fastapi.py,
FastAPIWebsocketOutputTransport.write_audio_frame): it does NOT respect
each frame's own sample_rate -- it rebuilds every OutputAudioRawFrame with
`sample_rate=self.sample_rate` (the transport's one fixed configured
audio_out_sample_rate), keeping the original audio bytes untouched. So
this only works correctly because every frame pushed here is consistently
at Aura's native 24000Hz, and audio_out_sample_rate below is set to match
that -- it is not "the serializer honors each frame's own rate" like the
doc first assumed. AsteriskWebSocketSerializer.serialize() still does the
real 24kHz -> 8kHz ulaw resampling per frame, that part was correct.

Written but not yet tested against a real call. Two things flagged inline
below (audio byte-endianness on the 16kHz Modulate path, Deepgram chunk
byte-alignment) need an actual call to confirm, same as every prior PoC
step in this project found its real bug by running it, not by reading
code alone.
"""

import asyncio
import base64
import threading
import time

from deepgram import AsyncDeepgramClient
from fastapi import FastAPI, WebSocket
from loguru import logger

from asterisk_websocket_serializer import AsteriskWebSocketSerializer
from pipecat.frames.frames import EndFrame, Frame, InputAudioRawFrame, OutputAudioRawFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport

import stt_bridge_final as bridge  # STAGES/COMPANIES/config only -- see 4.10 decision 2
from pipecat_turn_runner import run_pecat_turn_async

USERNAME = "pipecat_poc"
PASSWORD = "EiWxmiMD8veNDmZZHeckmf8u"  # matches asterisk-config/websocket_client.conf, same as step 1

COMPANY_KEY = "pacificbeef"  # hardcoded -- no ARI/StasisStart here to pick it from an extension

# Modulate's own STT expects 16000Hz s16le (stt_bridge_final.RATE); Asterisk sends 8kHz ulaw.
STT_SAMPLE_RATE = 16000
# Deepgram Aura's native output rate (matches play_deepgram()'s existing dg.speak... call).
TTS_SAMPLE_RATE = 24000

dg_async = AsyncDeepgramClient(api_key=bridge.DEEPGRAM_KEY)

_modulate_thread_started = threading.Event()
_bridge_threads_started = threading.Event()

# "Single active call" pointers (2026-08-29 fix, see docstring below) -- the
# one and only pair of asyncio.Queue instances that the current call's
# _transcript_consumer()/_tts_consumer() are actually reading from. None when
# no call is active. Matches this project's existing single-active-call
# scope (current_channel_id etc. in stt_bridge_final.py).
_active_call = {"transcript_queue": None, "tts_queue": None}


def _log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def _ensure_modulate_worker_started():
    """Start stt_bridge_final.modulate_worker() exactly once per process, not
    once per call -- it already reconnects to Modulate lazily per call via its
    own `first_chunk = audio_queue.get()` loop. Starting a second thread on a
    second call would race the first for the same shared audio_queue."""
    if _modulate_thread_started.is_set():
        return
    _modulate_thread_started.set()
    threading.Thread(target=bridge.modulate_worker, daemon=True).start()


def _ensure_bridge_threads_started(loop):
    """Fix (2026-08-29, found on the second real call): the first draft had
    each call's _transcript_consumer()/_tts_consumer() do
    `await asyncio.to_thread(queue.get)` directly on the shared
    bridge.transcript_queue/bridge.tts_queue. Cancelling that task on
    disconnect (media_endpoint()'s `finally: transcript_task.cancel()`) only
    cancels the asyncio-level await -- the underlying OS thread stays blocked
    inside queue.Queue.get() (a known asyncio.to_thread limitation, not
    fixable by cancelling harder). Call N+1 spawns a fresh thread doing the
    same blocking .get() on the same shared queue, so after a few calls
    multiple stale threads are all blocked on it -- whichever one Python's
    queue implementation happens to wake up "wins" the next item, and if it's
    a dead call's stale thread, the item is read and silently discarded
    (nobody is still awaiting that cancelled task's result). Confirmed this
    is what happened on the second real call: STT produced a clean final
    transcript, but zero LLM/TTS activity followed for the rest of that
    ~2.5-minute call.

    Fix: exactly ONE thread per queue, for the life of the process (same
    "start once" pattern as _ensure_modulate_worker_started()), forwarding
    each item to whichever call is currently active via
    loop.call_soon_threadsafe(). Each call's consumer then reads from its own
    real asyncio.Queue -- which IS safely cancellable, unlike a thread
    blocked on a synchronous queue.Queue.get()."""
    if _bridge_threads_started.is_set():
        return
    _bridge_threads_started.set()

    def _forward(source_queue, key):
        while True:
            item = source_queue.get()
            target = _active_call[key]
            if target is not None:
                loop.call_soon_threadsafe(target.put_nowait, item)
            # else: no active call right now -- dropped, matches this
            # project's single-active-call scope everywhere else.

    threading.Thread(
        target=_forward, args=(bridge.transcript_queue, "transcript_queue"), daemon=True
    ).start()
    threading.Thread(target=_forward, args=(bridge.tts_queue, "tts_queue"), daemon=True).start()


class AgentAudioBridgeProcessor(FrameProcessor):
    """Decision 1: forwards InputAudioRawFrame.audio into Modulate's existing
    audio_queue, unchanged. Also the object TTS chunks get pushed through
    (decision 3) -- it's the one thing in this pipeline with a live
    push_frame() once the pipeline has started.

    Self-echo guard (added 2026-08-29, after the first real call): the RTP
    path already has one (rtp_listener()'s `if current_playback_id is not
    None: continue`), gated on ARI's real PlaybackFinished event. This
    transport has no such event -- audio goes out as streamed frames, not an
    ARI-tracked playback -- so instead of a single boolean this tracks a
    "speaking until" deadline. mark_ai_speaking() pins it to infinity while a
    sentence is actively streaming; mark_ai_done_speaking() (called in a
    finally, so it still fires if TTS errors mid-sentence) sets it to
    `now + ECHO_GUARD_TAIL_SECONDS` instead of clearing it immediately, to
    cover the gap between "last chunk handed to transport.output()" and the
    audio actually finishing playback on the Asterisk/caller side. If the
    next sentence in the same reply starts streaming before that tail
    elapses (the common case -- see the first test call's back-to-back
    `TTS gen` lines), mark_ai_speaking() re-pins it to infinity, so the tail
    only actually elapses once after the whole reply, not once per sentence.

    First real call (2026-08-29, before this guard existed) showed exactly
    the failure this prevents: the AI's own first question got picked back
    up by Modulate (STT: "Do you currently.", echoing the AI's own "Do you
    currently run phone operations...") and confused the next LLM turn --
    caller was on a Mac's built-in speaker/mic, no headphones, same
    acoustic-feedback shape as the 2026-08-10 RTP self-echo bug and the step
    1 PoC's "boomy" call-1 scare (4.4)."""

    ECHO_GUARD_TAIL_SECONDS = 0.3

    def __init__(self, audio_queue):
        super().__init__()
        self._audio_queue = audio_queue
        self._ai_speaking_until = 0.0  # monotonic time; audio dropped while now < this

    def mark_ai_speaking(self):
        self._ai_speaking_until = float("inf")

    def mark_ai_done_speaking(self):
        self._ai_speaking_until = time.monotonic() + self.ECHO_GUARD_TAIL_SECONDS

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, InputAudioRawFrame):
            if time.monotonic() < self._ai_speaking_until:
                return  # dropped -- AI is speaking or still in the echo-guard tail
            # Consumed here, not forwarded -- letting it continue to
            # transport.output() would have it re-encoded and echoed back
            # to the caller, since AsteriskWebSocketSerializer.serialize()
            # matches on AudioRawFrame generally, not InputAudioRawFrame
            # specifically.
            self._audio_queue.put(frame.audio)
            return

        await self.push_frame(frame, direction)


def _split_sentences(text):
    """Same boundary rule TTSQueueBridgeProcessor already uses to chunk
    tts_queue puts: split on ., !, ? -- terminator stays attached."""
    sentences = []
    buf = ""
    for ch in text:
        buf += ch
        if ch in ".!?":
            sentences.append(buf.strip())
            buf = ""
    if buf.strip():
        sentences.append(buf.strip())
    return sentences


def _truncate_to_first_question(text):
    """One-question-per-turn hard backstop (2026-08-30, see 4.17) --
    AGENT_RULES already says "ask about only one thing per turn" but the
    model has twice ignored it mid-call and stacked 6-11 questions into one
    reply. Keeps sentences up to and including the first one containing '?';
    drops the rest. Filler before the first question ("Sure, I can hear
    you.") is kept -- the rule is about stacking questions, not about
    multi-sentence replies in general. Must match _tts_consumer's per-
    sentence suppression exactly, or conversation_history would record
    questions the caller was never actually asked (the exact bug class
    flagged in 3.3 -- content gets written into history that was never
    actually spoken)."""
    kept = []
    for sentence in _split_sentences(text):
        kept.append(sentence)
        if "?" in sentence:
            break
    return " ".join(kept)


async def _tts_stream_sentence(voice, sentence, push_frame):
    """Decision 3: stream each Aura chunk out as its own OutputAudioRawFrame
    as it's produced. No WAV, no ffmpeg, no docker cp, no ARI play."""
    first = True
    # VERIFY AT TEST TIME: 16-bit PCM needs an even number of bytes per
    # sample. If Deepgram's HTTP chunk boundaries don't land on 2-byte
    # boundaries, feeding a chunk straight to AsteriskWebSocketSerializer's
    # pcm_to_ulaw resampler could misalign samples -- listen for artifacts.
    async for chunk in dg_async.speak.v1.audio.generate(
        text=sentence,
        model=voice,
        encoding="linear16",
        sample_rate=TTS_SAMPLE_RATE,
        container="none",
    ):
        if first:
            _log("TTS first chunk")
            first = False
        await push_frame(
            OutputAudioRawFrame(audio=chunk, sample_rate=TTS_SAMPLE_RATE, num_channels=1),
            FrameDirection.DOWNSTREAM,
        )


async def _tts_consumer(tts_asyncio_queue, bridge_processor, voice):
    """Reads from this call's own asyncio.Queue (see
    _ensure_bridge_threads_started()'s docstring for why it's not
    bridge.tts_queue directly anymore) -- real async queue, so cancelling
    this task on disconnect actually stops it, unlike the first draft.

    One-question-per-turn enforcement (2026-08-30, see 4.17): items carry
    the real turn_epoch now (state["turn_counter"] in _transcript_consumer,
    no longer a hardcoded 0), so a change in turn_epoch marks a fresh turn.
    Once a '?'-sentence has been spoken this turn, further '?'-sentences in
    the same turn are dropped, not spoken -- must match
    _truncate_to_first_question()'s rule exactly, since that's what trims
    conversation_history to the same cutoff."""
    current_turn_epoch = None
    question_spoken_this_turn = False
    while True:
        sentence, turn_epoch = await tts_asyncio_queue.get()
        if turn_epoch != current_turn_epoch:
            current_turn_epoch = turn_epoch
            question_spoken_this_turn = False
        if question_spoken_this_turn and "?" in sentence:
            _log(f"TTS suppressed (extra question this turn): {sentence}")
            continue
        if "?" in sentence:
            question_spoken_this_turn = True
        _log(f"TTS gen: {sentence}")
        bridge_processor.mark_ai_speaking()
        try:
            await _tts_stream_sentence(voice, sentence, bridge_processor.push_frame)
        finally:
            bridge_processor.mark_ai_done_speaking()


async def _transcript_consumer(transcript_asyncio_queue, tts_sync_queue, state, company, on_first_token):
    """Decision 2: owns its own conversation_history/current_node, calls
    run_pecat_turn_async() directly. Never touches stt_bridge_final's live
    globals, bridge.set_stage(), or bridge._run_turn().

    transcript_asyncio_queue: this call's own real asyncio.Queue, fed by the
    single dedicated bridge thread (_ensure_bridge_threads_started()) -- not
    bridge.transcript_queue directly, see that function's docstring for why.

    tts_sync_queue: NOT swapped for an asyncio.Queue -- this is
    bridge.tts_queue itself, passed straight through to
    run_pecat_turn_async(). TTSQueueBridgeProcessor calls `.put(...)` on it
    synchronously (pipecat_turn_runner.py); asyncio.Queue.put() is a
    coroutine, so handing it an asyncio.Queue here would make those calls
    silently no-op (an unawaited coroutine, item never enqueued) -- TTS would
    go completely dark with no error. It has to stay a plain queue.Queue."""
    while True:
        transcript = await transcript_asyncio_queue.get()
        state["conversation_history"].append({"role": "user", "content": transcript})
        state["turn_counter"] += 1

        def set_stage(stage_id):
            state["current_node"] = stage_id
            state["conversation_history"][0] = bridge._build_stage_system_prompt(
                company["display_name"], bridge.STAGES[stage_id]
            )

        async def _on_first_token():
            await on_first_token()

        messages, tool_call_count, _spoke = await run_pecat_turn_async(
            state["conversation_history"],
            bridge.STAGES[state["current_node"]],
            bridge.STAGES,
            COMPANY_KEY,
            company,
            bridge.GROQ_KEY,
            tts_sync_queue,
            state["turn_counter"],  # turn_epoch -- real per-turn counter now, see 4.17's
            # one-question-per-turn enforcement in _tts_consumer, which keys off this
            # to detect a fresh turn. No call-transfer/human-takeover in this isolated
            # test, so it's not used for staleness-discarding like the live epoch is.
            bridge.FALLBACK_LINE,
            bridge.USE_RAG,
            bridge.rag_retrieval if bridge.USE_RAG else None,
            set_stage,
            _log,
            on_first_token=_on_first_token,
            # Shortened from pipecat_turn_runner's 30s default (2026-08-30,
            # Shuyang's request) -- 30s of dead air was longer than a real
            # caller waits before hanging up (confirmed: 4.15's error call,
            # caller hung up at 25s, 5s before the fallback would have
            # fired). Only this isolated script's default changed --
            # turn_timeout is an opt-in kwarg, stt_bridge_final's live
            # _run_turn() doesn't pass it, so 1000/2000 still get 30s.
            turn_timeout=10.0,
        )
        state["conversation_history"] = messages

        # One-question-per-turn backstop (2026-08-30, see 4.17): must match
        # _tts_consumer's per-sentence suppression rule exactly, or history
        # would record questions the caller was never actually asked --
        # mutating messages[-1] in place, same dict _tts_consumer's sibling
        # task already streamed the truncated version of.
        last_turn_msg = messages[-1] if messages else None
        if last_turn_msg and last_turn_msg.get("role") == "assistant" and last_turn_msg.get("content"):
            truncated = _truncate_to_first_question(last_turn_msg["content"])
            if truncated != last_turn_msg["content"]:
                _log(f"AGENT: truncated multi-question reply, kept: {truncated!r}")
                last_turn_msg["content"] = truncated

        # Ported from stt_bridge_final.groq_worker() (2026-08-30), then fixed
        # the same day: a plain "keep the system prompt + last MAX_HISTORY
        # messages" cut (matching groq_worker()'s own logic verbatim) can
        # land the boundary between a paired assistant tool_calls message
        # and its tool-result message, dropping the assistant message (which
        # names the tool) while keeping the now-orphaned tool-result. Groq's
        # harmony template renderer then rejects the whole request with
        # "Tools should have a name!" -- confirmed live, see 4.14 addendum.
        # Fix: if the naive cut boundary lands on a 'tool'-role message,
        # keep skipping forward until it doesn't -- guarantees the kept
        # window never starts with an orphaned tool result. (groq_worker()
        # in stt_bridge_final.py has this same latent bug -- not fixed there,
        # out of scope for this isolated script, flagged for Shuyang.)
        if len(state["conversation_history"]) > bridge.MAX_HISTORY + 1:
            history = state["conversation_history"]
            cut = len(history) - bridge.MAX_HISTORY
            while cut < len(history) and history[cut]["role"] == "tool":
                cut += 1
            state["conversation_history"] = [history[0]] + history[cut:]

        last = messages[-1] if messages else None
        if last and last.get("role") == "assistant" and last.get("content"):
            _log(f"LLM reply: {last['content']}")
        if tool_call_count:
            _log(f"AGENT: {tool_call_count} tool call(s) this turn (stage: {state['current_node']})")


app = FastAPI()


@app.websocket("/media")
async def media_endpoint(websocket: WebSocket):
    auth_header = websocket.headers.get("authorization", "")
    expected = "Basic " + base64.b64encode(f"{USERNAME}:{PASSWORD}".encode()).decode()
    if auth_header != expected:
        _log(f"rejected connection: bad/missing auth header {auth_header!r}")
        await websocket.close(code=1008)
        return

    await websocket.accept(subprotocol="media")
    _log(f"connection accepted from {websocket.client}")

    _ensure_modulate_worker_started()
    _ensure_bridge_threads_started(asyncio.get_running_loop())

    # This call's own real asyncio.Queue instances -- registered as the
    # active call's targets so the single dedicated bridge threads forward
    # into them. See _ensure_bridge_threads_started()'s docstring.
    transcript_asyncio_queue = asyncio.Queue()
    tts_asyncio_queue = asyncio.Queue()
    _active_call["transcript_queue"] = transcript_asyncio_queue
    _active_call["tts_queue"] = tts_asyncio_queue

    company = bridge.COMPANIES[COMPANY_KEY]
    state = {
        "current_node": "prospect",
        "conversation_history": [company["system_prompt"]],
        "turn_counter": 0,  # real per-turn epoch now, see 4.17
    }

    async def _on_first_token():
        _log("LLM first-token")

    serializer = AsteriskWebSocketSerializer(
        params=AsteriskWebSocketSerializer.InputParams(codec="ulaw", asterisk_sample_rate=8000)
    )
    transport = FastAPIWebsocketTransport(
        websocket,
        FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_sample_rate=STT_SAMPLE_RATE,
            audio_out_sample_rate=TTS_SAMPLE_RATE,
            add_wav_header=False,
            serializer=serializer,
        ),
    )

    bridge_processor = AgentAudioBridgeProcessor(bridge.audio_queue)
    pipeline = Pipeline([transport.input(), bridge_processor, transport.output()])
    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=STT_SAMPLE_RATE,
            audio_out_sample_rate=TTS_SAMPLE_RATE,
        ),
    )

    transcript_task = asyncio.create_task(
        _transcript_consumer(transcript_asyncio_queue, bridge.tts_queue, state, company, _on_first_token)
    )
    tts_task = asyncio.create_task(_tts_consumer(tts_asyncio_queue, bridge_processor, company["voice"]))

    @transport.event_handler("on_client_disconnected")
    async def on_disconnected(_transport, _client):
        _log("client disconnected, ending pipeline task")
        await task.queue_frame(EndFrame())

    runner = PipelineRunner(handle_sigint=False)
    try:
        await runner.run(task)
    except Exception as e:
        _log(f"pipeline error: {type(e).__name__}: {e}")
    finally:
        transcript_task.cancel()
        tts_task.cancel()
        # Only clear if still pointing at this call -- defensive, in case a
        # new call's registration already overwrote these (shouldn't happen
        # under the single-active-call assumption, but don't clobber a
        # newer call's live registration if it somehow does).
        if _active_call["transcript_queue"] is transcript_asyncio_queue:
            _active_call["transcript_queue"] = None
        if _active_call["tts_queue"] is tts_asyncio_queue:
            _active_call["tts_queue"] = None
    _log("pipeline task finished")
