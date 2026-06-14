import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_TTS_DIR = Path(__file__).resolve().parent.parent.parent / "irodori-tts-webgpu"


@dataclass(frozen=True)
class Settings:
    model: str = field(default_factory=lambda: os.environ.get("STT_MODEL", "small"))
    device: str = field(default_factory=lambda: os.environ.get("STT_DEVICE", "auto"))
    compute_type: str = field(
        default_factory=lambda: os.environ.get("STT_COMPUTE_TYPE", "int8")
    )
    host: str = field(default_factory=lambda: os.environ.get("STT_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: int(os.environ.get("STT_PORT", "8000")))
    tts_dir: str = field(
        default_factory=lambda: os.environ.get("STT_TTS_DIR", str(DEFAULT_TTS_DIR))
    )


settings = Settings()
