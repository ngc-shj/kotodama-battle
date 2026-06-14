import numpy as np

from server.session import SAMPLE_RATE, SegmentBuffer


def amplitude_vad(audio):
    """Test VAD: treats |sample| > 0.5 as speech, grouped into regions."""
    mask = np.abs(audio) > 0.5
    regions = []
    start = None
    for i, is_speech in enumerate(mask):
        if is_speech and start is None:
            start = i
        elif not is_speech and start is not None:
            regions.append((start, i))
            start = None
    if start is not None:
        regions.append((start, len(mask)))
    return regions


def speech(seconds):
    return np.ones(int(seconds * SAMPLE_RATE), dtype=np.float32)


def silence(seconds):
    return np.zeros(int(seconds * SAMPLE_RATE), dtype=np.float32)


def feed_in_chunks(buffer, audio, chunk_s=0.5):
    actions = []
    chunk = int(chunk_s * SAMPLE_RATE)
    for offset in range(0, len(audio), chunk):
        actions.extend(buffer.feed(audio[offset : offset + chunk]))
    return actions


def test_returns_no_actions_for_silence_only():
    buffer = SegmentBuffer(amplitude_vad)

    actions = feed_in_chunks(buffer, silence(3.0))

    assert actions == []


def test_emits_final_after_trailing_silence():
    buffer = SegmentBuffer(amplitude_vad)

    actions = feed_in_chunks(buffer, np.concatenate([speech(1.0), silence(1.5)]))

    finals = [a for a in actions if a.kind == "final"]
    assert len(finals) == 1
    assert len(finals[0].audio) >= int(1.0 * SAMPLE_RATE)


def test_emits_partial_during_continuous_speech():
    buffer = SegmentBuffer(amplitude_vad)

    actions = feed_in_chunks(buffer, speech(2.0))

    assert any(a.kind == "partial" for a in actions)
    assert not any(a.kind == "final" for a in actions)


def test_forces_final_when_segment_cap_is_reached():
    buffer = SegmentBuffer(amplitude_vad, max_segment_s=2.0)

    actions = feed_in_chunks(buffer, speech(3.0))

    assert any(a.kind == "final" for a in actions)


def test_flush_finalizes_pending_speech():
    buffer = SegmentBuffer(amplitude_vad)
    feed_in_chunks(buffer, speech(0.6))

    actions = buffer.flush()

    assert len(actions) == 1
    assert actions[0].kind == "final"
    assert len(actions[0].audio) >= int(0.5 * SAMPLE_RATE)


def test_flush_returns_nothing_for_silence():
    buffer = SegmentBuffer(amplitude_vad)
    feed_in_chunks(buffer, silence(0.6))

    assert buffer.flush() == []
