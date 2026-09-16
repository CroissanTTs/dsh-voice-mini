import { EdgeTTS } from 'node-edge-tts';
const tts = new EdgeTTS({ voice: 'zh-CN-XiaoxiaoNeural' });
const t1 = Date.now();
await tts.ttsPromise('你好，世界。语音反馈原型跑通了。', '/tmp/test-zh.mp3');
console.log('[edge-zh]', Date.now() - t1, 'ms');
process.exit(0);
