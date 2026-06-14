import numpy as np
from faster_whisper import WhisperModel


class Transcriber:
    def __init__(self, model_size: str, device: str = "auto", compute_type: str = "int8"):
        self.model_size = model_size
        self.model = WhisperModel(model_size, device=device, compute_type=compute_type)

    def transcribe(self, audio: np.ndarray, language: str | None = None) -> str:
        segments, _ = self.model.transcribe(
            audio,
            language=language,
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
            without_timestamps=True,
        )
        return "".join(segment.text for segment in segments).strip()
