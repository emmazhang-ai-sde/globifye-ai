"""
Phase 4 step 1 (frame-migration-decision-and-plan.md, implementation order,
step 1): upgrade poc_chan_websocket_echo.py's raw-bytes echo into a real
Pipecat pipeline over chan_websocket -- prove StartFrame/InputAudioRawFrame/
OutputAudioRawFrame/EndFrame actually flow end to end through pipecat's own
transport + frame system on this project's Asterisk setup, not just that raw
bytes can be echoed over a bare WebSocket (poc_chan_websocket_echo.py already
proved that part).

Still fully isolated: extension 9000, doesn't touch the live agent or either
company's routing. Requires fastapi + uvicorn (added to venv for this step;
not yet in requirements.txt -- add there once this becomes real, non-PoC
code).

Run (from sip/scripts/): ../../venv/bin/uvicorn poc_pipecat_transport:app --host 0.0.0.0 --port 8790
Dial extension 9000 from Linphone, same as poc_chan_websocket_echo.py.
"""

import base64
import time

from fastapi import FastAPI, WebSocket
from loguru import logger

from asterisk_websocket_serializer import AsteriskWebSocketSerializer
from pipecat.frames.frames import AudioRawFrame, EndFrame, Frame, OutputAudioRawFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport

USERNAME = "pipecat_poc"
PASSWORD = "EiWxmiMD8veNDmZZHeckmf8u"  # matches asterisk-config/websocket_client.conf


def _log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


class FrameLevelEchoProcessor(FrameProcessor):
    """Step 1's whole point: prove InputAudioRawFrame -> OutputAudioRawFrame
    round-trips through a real pipecat Pipeline, not just raw bytes through a
    bare socket. Every non-audio frame (StartFrame, EndFrame, ...) still has
    to pass through untouched or the transport's own lifecycle breaks."""

    def __init__(self):
        super().__init__()
        self._frame_count = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, AudioRawFrame) and not isinstance(frame, OutputAudioRawFrame):
            self._frame_count += 1
            if self._frame_count <= 5 or self._frame_count % 50 == 0:
                _log(f"frame {self._frame_count}: {len(frame.audio)}B @ {frame.sample_rate}Hz")
            await self.push_frame(
                OutputAudioRawFrame(
                    audio=frame.audio,
                    sample_rate=frame.sample_rate,
                    num_channels=frame.num_channels,
                ),
                direction,
            )
            return

        await self.push_frame(frame, direction)


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

    serializer = AsteriskWebSocketSerializer(
        params=AsteriskWebSocketSerializer.InputParams(codec="ulaw", asterisk_sample_rate=8000)
    )
    transport = FastAPIWebsocketTransport(
        websocket,
        FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_sample_rate=8000,
            audio_out_sample_rate=8000,
            add_wav_header=False,
            serializer=serializer,
        ),
    )

    pipeline = Pipeline([transport.input(), FrameLevelEchoProcessor(), transport.output()])
    task = PipelineTask(
        pipeline,
        params=PipelineParams(audio_in_sample_rate=8000, audio_out_sample_rate=8000),
    )

    @transport.event_handler("on_client_disconnected")
    async def on_disconnected(_transport, _client):
        _log("client disconnected, ending pipeline task")
        await task.queue_frame(EndFrame())

    runner = PipelineRunner(handle_sigint=False)
    try:
        await runner.run(task)
    except Exception as e:
        _log(f"pipeline error: {type(e).__name__}: {e}")
    _log("pipeline task finished")
