import asyncio
import json
import os
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
from fastapi import FastAPI, WebSocket
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .session import Action, SegmentBuffer, silero_vad
from .transcriber import Transcriber

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
TTS_DIR = Path(settings.tts_dir)
TTS_AVAILABLE = (
    (TTS_DIR / "runtime" / "pipeline.mjs").is_file()
    and (TTS_DIR / "artifacts" / "onnx_fp16").is_dir()
    and (TTS_DIR / "tokenizer" / "llmjp_tok").is_dir()
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.transcriber = Transcriber(
        settings.model, settings.device, settings.compute_type
    )
    # Single worker keeps transcriptions serial so partial/final order is stable.
    app.state.executor = ThreadPoolExecutor(max_workers=1)
    yield
    app.state.executor.shutdown(wait=False, cancel_futures=True)


app = FastAPI(lifespan=lifespan)


@app.get("/")
async def index():
    return RedirectResponse(url="/game/")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# Spell-battle game. Served at /game so it reuses this server's /ws (STT) and
# /tts/* (TTS models) on the same origin — no CORS. The game's web/ now lives in
# this repo, so the default points at it directly.
GAME_DIR = Path(
    os.environ.get(
        "STT_GAME_DIR",
        str(Path(__file__).resolve().parent.parent / "web"),
    )
)
if (GAME_DIR / "game.html").is_file():

    # Redirect /game -> /game/ so the page's relative imports (./spell-judge.js,
    # ./ref-kyoko.wav) resolve against /game/ instead of the site root.
    @app.get("/game")
    async def game_redirect():
        return RedirectResponse(url="/game/")

    @app.get("/game/")
    async def game_index():
        return FileResponse(GAME_DIR / "game.html")

    app.mount("/game", StaticFiles(directory=GAME_DIR, html=True), name="game")


@app.get("/tts/status")
async def tts_status():
    return {"available": TTS_AVAILABLE}


if TTS_AVAILABLE:
    app.mount("/tts/runtime", StaticFiles(directory=TTS_DIR / "runtime"), name="tts-runtime")
    app.mount("/tts/artifacts", StaticFiles(directory=TTS_DIR / "artifacts"), name="tts-artifacts")
    app.mount("/tts/tokenizer", StaticFiles(directory=TTS_DIR / "tokenizer"), name="tts-tokenizer")


@app.websocket("/ws")
async def transcribe_ws(ws: WebSocket):
    await ws.accept()
    transcriber = ws.app.state.transcriber
    executor = ws.app.state.executor
    loop = asyncio.get_running_loop()
    buffer = SegmentBuffer(silero_vad)
    language: str | None = None
    inflight = 0
    segment_index = 0
    tasks: set[asyncio.Task] = set()

    async def send(payload: dict) -> None:
        try:
            await ws.send_text(json.dumps(payload, ensure_ascii=False))
        except RuntimeError:
            pass  # client already disconnected

    async def run(action: Action) -> None:
        nonlocal inflight, segment_index
        inflight += 1
        try:
            text = await loop.run_in_executor(
                executor, transcriber.transcribe, action.audio, language
            )
        except Exception as exc:
            await send({"type": "error", "message": str(exc)})
            return
        finally:
            inflight -= 1
        if action.kind == "final":
            if text:
                segment_index += 1
                await send({"type": "final", "index": segment_index, "text": text})
            else:
                await send({"type": "partial", "text": ""})
        else:
            await send({"type": "partial", "text": text})

    def dispatch(actions: list[Action]) -> None:
        for action in actions:
            if action.kind == "partial" and inflight > 0:
                continue  # latest-wins: drop partials while a job is running
            task = asyncio.create_task(run(action))
            tasks.add(task)
            task.add_done_callback(tasks.discard)

    await send({"type": "ready", "model": transcriber.model_size})

    while True:
        message = await ws.receive()
        if message["type"] == "websocket.disconnect":
            break
        if message.get("bytes") is not None:
            pcm = np.frombuffer(message["bytes"], dtype=np.int16).astype(np.float32) / 32768.0
            dispatch(buffer.feed(pcm))
        elif message.get("text") is not None:
            control = json.loads(message["text"])
            if control.get("type") == "config":
                language = control.get("language") or None
            elif control.get("type") == "stop":
                dispatch(buffer.flush())
                if tasks:
                    await asyncio.gather(*list(tasks), return_exceptions=True)
                await send({"type": "stopped"})

    for task in tasks:
        task.cancel()


def main() -> None:
    import uvicorn

    uvicorn.run("server.app:app", host=settings.host, port=settings.port)
