// PROTOTYPE — Kokoro child-process synth. Args: <text> <out.wav> [voice] [speed].
// NOTE: this process may abort-trap on exit (onnxruntime + Node 26 teardown);
// the parent judges success by the output file, so always write BEFORE exit.
import { env } from '@huggingface/transformers';
if (!env.remoteHost || env.remoteHost.includes('huggingface.co')) {
  env.remoteHost = process.env.DSH_VOICE_MINI_HF_HOST ?? 'https://hf-mirror.com/';
}

const [text, outFile, voice = 'af_heart', speedArg = '1'] = process.argv.slice(2);
if (!text || !outFile) {
  console.error('usage: synth-kokoro.mjs <text> <out.wav> [voice] [speed]');
  process.exit(2);
}
const speed = Number.parseFloat(speedArg);
const safeSpeed = Number.isFinite(speed) && speed > 0 ? Math.min(2, Math.max(0.5, speed)) : 1;

const { KokoroTTS } = await import('kokoro-js');
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
  dtype: 'q8',
  device: 'cpu',
});
const audio = await tts.generate(text, { voice, speed: safeSpeed });
await audio.save(outFile);
process.exit(0);
