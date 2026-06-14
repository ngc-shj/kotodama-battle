from dataclasses import dataclass
from typing import Callable

import numpy as np

SAMPLE_RATE = 16000

SpeechRegions = list[tuple[int, int]]
VadFunc = Callable[[np.ndarray], SpeechRegions]


@dataclass(frozen=True)
class Action:
    kind: str  # "partial" or "final"
    audio: np.ndarray


def silero_vad(audio: np.ndarray) -> SpeechRegions:
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    options = VadOptions(min_silence_duration_ms=300, speech_pad_ms=100)
    timestamps = get_speech_timestamps(audio, vad_options=options)
    return [(t["start"], t["end"]) for t in timestamps]


class SegmentBuffer:
    """Splits a live 16kHz PCM stream into utterance segments using VAD.

    feed() returns actions: "partial" carries the in-progress utterance for
    provisional transcription, "final" closes a segment once trailing silence
    (or the segment length cap) is reached.
    """

    def __init__(
        self,
        vad: VadFunc,
        *,
        silence_ms: int = 700,
        max_segment_s: float = 30.0,
        partial_interval_s: float = 1.0,
        check_interval_s: float = 0.5,
        keep_tail_s: float = 1.0,
        pad_s: float = 0.2,
    ):
        self._vad = vad
        self._silence = int(silence_ms / 1000 * SAMPLE_RATE)
        self._max_segment = int(max_segment_s * SAMPLE_RATE)
        self._partial_interval = int(partial_interval_s * SAMPLE_RATE)
        self._check_interval = int(check_interval_s * SAMPLE_RATE)
        self._keep_tail = int(keep_tail_s * SAMPLE_RATE)
        self._pad = int(pad_s * SAMPLE_RATE)
        self._buffer = np.zeros(0, dtype=np.float32)
        self._since_check = 0
        self._since_partial = 0

    def feed(self, pcm: np.ndarray) -> list[Action]:
        self._buffer = np.concatenate([self._buffer, pcm.astype(np.float32)])
        self._since_check += len(pcm)
        self._since_partial += len(pcm)
        if self._since_check < self._check_interval:
            return []
        self._since_check = 0
        return self._evaluate()

    def flush(self) -> list[Action]:
        regions = self._vad(self._buffer)
        actions = []
        if regions:
            cut = min(len(self._buffer), regions[-1][1] + self._pad)
            actions.append(Action("final", self._buffer[:cut]))
        self._reset_buffer()
        return actions

    def _evaluate(self) -> list[Action]:
        regions = self._vad(self._buffer)
        if not regions:
            # No speech yet: keep only a short tail so a new utterance
            # is not clipped at its onset.
            if len(self._buffer) > self._keep_tail:
                self._buffer = self._buffer[-self._keep_tail :]
            self._since_partial = 0
            return []
        last_end = regions[-1][1]
        trailing = len(self._buffer) - last_end
        if trailing >= self._silence or len(self._buffer) >= self._max_segment:
            return [self._finalize(last_end)]
        if self._since_partial >= self._partial_interval:
            self._since_partial = 0
            return [Action("partial", self._buffer.copy())]
        return []

    def _finalize(self, last_end: int) -> Action:
        cut = min(len(self._buffer), last_end + self._pad)
        segment = self._buffer[:cut]
        self._buffer = self._buffer[cut:]
        self._since_partial = 0
        return Action("final", segment)

    def _reset_buffer(self) -> None:
        self._buffer = np.zeros(0, dtype=np.float32)
        self._since_check = 0
        self._since_partial = 0
