// Speaks transcribed text with Irodori-TTS running fully in-browser on WebGPU.
// Model files and the runtime core are served by the stt-webui server from a
// local irodori-tts-webgpu checkout (see STT_TTS_DIR).
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.0/dist/ort.webgpu.mjs';
import { AutoTokenizer, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6';
import { IrodoriTTS } from '/tts/runtime/pipeline.mjs';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.0/dist/';
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/tts/tokenizer/';

const MODELS = {
  text: 'text_encoder',
  speaker: 'speaker_encoder',
  duration: 'duration',
  dit: 'dit',
  dac: 'dacvae_decoder',
  enc: 'dacvae_encoder',
};
const ARTIFACTS_BASE = '/tts/artifacts/onnx_fp16';

// Model files (~1.2 GB total) are persisted in the Cache Storage API so they
// download once, not on every page load. A cached entry is revalidated with a
// HEAD request against the server's ETag, so regenerated artifacts in the
// irodori checkout are picked up automatically.
const CACHE_NAME = 'stt-webui-tts-models-v1';

async function fetchBytes(url, onStatus = () => {}) {
  if (!('caches' in globalThis)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  const store = await caches.open(CACHE_NAME);
  const cached = await store.match(url);
  if (cached) {
    const head = await fetch(url, { method: 'HEAD' });
    if (head.ok && head.headers.get('etag') === cached.headers.get('etag')) {
      onStatus('cache');
      return new Uint8Array(await cached.arrayBuffer());
    }
    await store.delete(url);
  }
  const net = await fetch(url);
  if (!net.ok) throw new Error(`fetch ${url}: ${net.status}`);
  await store.put(url, net.clone());
  onStatus('network');
  return new Uint8Array(await net.arrayBuffer());
}

export class TTSSpeaker {
  constructor({ onStatus = () => {}, numSteps = 16 } = {}) {
    this.onStatus = onStatus;
    this.numSteps = numSteps;
    this.tts = null;
    this.spk = null;
    this.queue = [];
    this.draining = false;
    this.audioCtx = null;
  }

  async load() {
    if (this.tts) return;
    if (!navigator.gpu) throw new Error('このブラウザではWebGPUが利用できません');
    const sessions = {};
    for (const [key, name] of Object.entries(MODELS)) {
      this.onStatus(`モデル読込中: ${name}…`);
      let source = 'キャッシュ';
      const note = (kind) => {
        if (kind === 'network') source = 'ダウンロード';
      };
      const [model, data] = await Promise.all([
        fetchBytes(`${ARTIFACTS_BASE}/${name}.onnx`, note),
        fetchBytes(`${ARTIFACTS_BASE}/${name}.onnx.data`, note),
      ]);
      this.onStatus(`モデル読込中: ${name} (${source})…`);
      sessions[key] = await ort.InferenceSession.create(model, {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all',
        externalData: [{ path: `${name}.onnx.data`, data }],
      });
    }
    const tokenizer = await AutoTokenizer.from_pretrained('llmjp_tok');
    this.tts = new IrodoriTTS({ ort, sessions, tokenizer });
    this.onStatus('モデル準備完了');
  }

  // Decode any audio file to 48kHz mono and precompute the speaker state so
  // each utterance only runs text encoding + RF sampling + decode.
  async setReference(file) {
    this.onStatus('参照音声を解析中…');
    const arrayBuffer = await file.arrayBuffer();
    const decodeCtx = new AudioContext();
    const decoded = await decodeCtx.decodeAudioData(arrayBuffer);
    await decodeCtx.close();
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 48000), 48000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const wav = (await offline.startRendering()).getChannelData(0).slice();

    const ref = await this.tts.wavToRefLatent(wav, 48000);
    this.spk = await this.tts.encodeRefLatent(ref.latent, ref.T);
    this.onStatus('読み上げ待機中');
  }

  get ready() {
    return Boolean(this.tts && this.spk);
  }

  speak(text) {
    if (!this.ready || !text.trim()) return;
    this.queue.push(text);
    this._drain();
  }

  async _drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const text = this.queue.shift();
        this.onStatus(`合成中 (残り${this.queue.length}件)…`);
        const audio = await this._synthesize(text);
        this.onStatus('再生中…');
        await this._play(audio, 48000);
      }
      this.onStatus('読み上げ待機中');
    } catch (err) {
      this.onStatus(`エラー: ${err.message || err}`);
      console.error(err);
    } finally {
      this.draining = false;
    }
  }

  async _synthesize(text) {
    const encoded = await this.tts.encodeText(text);
    const seqLen = await this.tts.predictDuration(encoded, this.spk);
    const latent = await this.tts.rfLoop(encoded, this.spk, seqLen, {
      numSteps: this.numSteps,
    });
    return this.tts.decode(latent, seqLen);
  }

  async _play(audio, sampleRate) {
    if (!this.audioCtx) this.audioCtx = new AudioContext();
    if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
    const samples = audio instanceof Float32Array ? audio : Float32Array.from(audio);
    const buffer = this.audioCtx.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    return new Promise((resolve) => {
      const source = this.audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audioCtx.destination);
      source.onended = resolve;
      source.start();
    });
  }
}
