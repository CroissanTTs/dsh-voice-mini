import { EdgeTTS } from 'node-edge-tts';
const text = '测试。';
const candidates = [
  'zh-CN-XiaoxiaoNeural','zh-CN-XiaoyiNeural','zh-CN-YunyangNeural','zh-CN-YunjianNeural',
  'zh-CN-liaoning-XiaobeiNeural','zh-CN-shaanxi-YongkangNeural',
  'zh-HK-HiuMaanNeural','zh-HK-WanLungNeural',
  'zh-TW-HsiaoChenNeural','zh-TW-YunJheNeural','zh-TW-ShanJiaNeural',
  'en-US-AnneNeural','en-US-BrandonNeural','en-US-ChristopherNeural','en-US-EricNeural',
  'en-US-GenderNeutral','en-US-JennyNeural','en-US-MichelleNeural','en-US-RogerNeural',
  'en-US-SteffanNeural',
  'ja-JP-NanamiNeural','ja-JP-KeitaNeural',
  'ko-KR-HyunjunNeural','ko-KR-SunhiNeural',
];
for (const v of candidates) {
  try {
    await new EdgeTTS({ voice: v }).ttsPromise(text, '/tmp/vs.mp3');
    console.log(`OK  ${v}`);
  } catch { console.log(`FAIL ${v}`); }
}
