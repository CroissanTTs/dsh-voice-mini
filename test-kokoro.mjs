// PROTOTYPE — Kokoro-82M standalone validation (not part of the plugin).
// Run: node test-kokoro.mjs
import { env } from '@huggingface/transformers';

// huggingface.co is blocked in this environment; use the mirror (same path layout).
env.remoteHost = 'https://hf-mirror.com/';

const t0 = Date.now();
const { KokoroTTS } = await import('kokoro-js');

const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
  dtype: 'q8',
  device: 'cpu',
});
console.log(`[model] loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const cases = [
  ['zh', '你好，世界。语音反馈原型跑通了。', 'zf_xiaoxiao'],
  ['en', 'Build finished. Zero failures.', 'af_heart'],
];

for (const [tag, text, voice] of cases) {
  const t1 = Date.now();
  const audio = await tts.generate(text, { voice });
  const ms = Date.now() - t1;
  const file = `test-${tag}.wav`;
  await audio.save(file);
  console.log(`[${tag}] "${text}" voice=${voice} synth=${ms}ms -> ${file}`);
}
console.log('OK');
