# 开发计划

## 阶段一：dsh-voice-mini 发布前（当前）

### 1. 音色池拓展
- [x] edge 默认池加到 8 个（4 女 4 男，中文）+ 2 英文（Anne/Christopher）
- [x] 英文音色加入默认池（en-US-AnneNeural, en-US-ChristopherNeural）
- [x] `voicePalette` 配置项在面板里可编辑（默认/自定义 pill + textarea 每行一个音色ID + 恢复默认按钮，blur 时提交）
- [x] test-voices：新 palette 8 zh + 2 en，40 会话 → 27 种组合，前 12 个 10/12 无碰撞

### 2. i18n（中英文切换）
- [x] 新建 `src/locale/` 目录（types.ts/zh.ts/en.ts/index.ts），抽取全部 UI 字符串（100 个叶子键）
- [x] 客户端按 `state.locale`（从 `/voice-mini/state` 读，config 字段）切换文案
- [x] 涉及字符串：档位名、提示词标签、说明文字、按钮文案、监控面板标签（共 100 项）
- [x] verbalizer 的 `SUMMARIZE_PROMPT` 按 locale 切换（中文 / 英文 prompt）
- [x] 人设文本 `PERSONA_BY_PRESET` 保持英文（模型能理解，回复语言由用户语言决定）
- [x] `test-i18n.mjs`：21 项测试（结构对齐 + locale 解析 + 口播短语切换集成）

### 3. 模型目录 + 一键切换
- [ ] 新建 `tts-models.yml` catalog（模型列表 + 元数据）
- [ ] 新增后端类型 `onnx-direct`（用 onnxruntime-node 直接跑 VITS ONNX）
- [ ] 下载缓存机制：`~/.dsh/voice-mini/models/<id>/`
- [ ] 路由 `POST /voice-mini/model/switch`（切换 + 下载）
- [ ] 客户端：模型目录面板（列表 + 一键下载/切换 + 状态标记）
- [ ] 验证 VITS MeloTTS zh_en（MIT, 中英双语, 词库自带）能否在 onnxruntime-node 下跑

### 4. 文档 + 发布
- [x] README 英文版（`README.md`，中文保留为 `README.zh-CN.md` 并互相链接）
- [x] LICENSE 文件（MIT）
- [x] package.json 完善（description 重写、version 0.3.0、keywords、author、files 清单）
- [x] `files` 白名单 + `.npmignore` 清理（`npm pack --dry-run`：212.7 kB / 23 文件，排除 src/test/pet/.build 210MB）
- [x] **隐私清理**：cordis.patch.yml / schema 默认 / 客户端 placeholder / locale / README 全部中性化（无 bailian/qwen3.7-plus/bailian-dev profile）；verbalizer 未配 model 时自动走模板短语
- [ ] `npm publish`（需 npm 凭据/网络，由用户执行）
- [ ] 社区市场上架（`dsh-community-market`，由用户执行）

---

## 阶段二：dsh-harness-assistant（新插件）

### 定位
跨会话 AI 助理——监听所有会话，用对应会话的声音告知用户，接收语音回复并路由到正确会话。

### 依赖
- `peerDependencies: { "dsh-voice-mini": "^0.3.0" }`
- 复用 voice-mini 的 `tts.ts`（TTS 合成）、`sessionVoiceFor()`（按会话分配音色）、播报队列

### 功能模块

#### A. 跨会话监听
- [ ] 全局 `ctx.on('session/event')` 监听所有会话
- [ ] 过滤：只关注 assistant/message、approval/asked、ask_user_question
- [ ] 用 `sessionVoiceFor(sessionId)` 取该会话的声音
- [ ] 告知用户："会话 A 有新回复" / "会话 B 需要审批"

#### B. 语音信箱（Voicemail）
- [ ] 默认档：口播内容进信箱，悬浮窗显示未读标记
- [ ] 用户点击播放
- [ ] 即时档：直接播放（复用 voice-mini 的流式 TTS）
- [ ] 多会话堆积处理：排队 + 优先级 + 去重

#### C. STT（语音输入）
- [ ] 浏览器端：Web Speech API（免安装，Chrome 支持）
- [ ] 本地端：Whisper ONNX / SenseVoice（备选）
- [ ] 用户说话 → STT → 文本

#### D. 意图理解 + 消息路由
- [ ] 用户语音转文本后，用 LLM 理解意图
- [ ] 判断该回复哪个会话（基于上下文/关键词/最近活跃会话）
- [ ] 向目标会话发送用户消息

#### E. 模型调度
- [ ] 根据问题复杂度调整目标会话的 model / reasoningEffort
- [ ] 简单问题 → 快速模型 + 低推理
- [ ] 复杂问题 → 强模型 + 高推理

#### F. 助理人格
- [ ] 统一人格：跨会话一致的助理角色
- [ ] 每个会话用不同声音，但人格统一
- [ ] 人设 prompt 管理

### 技术依赖

| 能力 | 来源 | 备注 |
|---|---|---|
| TTS 合成 | 复用 voice-mini `tts.ts` | peerDep |
| 按会话分配音色 | 复用 `sessionVoiceFor()` | 直接 import |
| 跨会话事件 | `ctx.on('session/event')` 全局 | voice-mini 已用，不冲突 |
| STT | 新建 | Web Speech API / Whisper ONNX |
| 消息路由 | 新建 | LLM 意图理解 + 会话选择 |
| 模型调度 | 新建 | 读/写 agent preset 的 model/effort |
| 悬浮窗 | 复用 dsh-notch 思路 | voice-mini pet 已验证 |

### 开发顺序
1. A（跨会话监听）— 最基础，能先跑通
2. F（助理人格）— 定义角色
3. B（语音信箱）— 默认档的核心体验
4. C（STT）— 语音输入
5. D（意图理解 + 路由）— 最复杂
6. E（模型调度）— 锦上添花

---

## 已完成清单（dsh-voice-mini）

- [x] speak 工具（模型自主决定说什么）
- [x] readReplies 逐字朗读（互斥模式）
- [x] 情绪化总结 verbalizer（LLM 生成口播）
- [x] 流式 TTS（边生成边说，5 字缓冲）
- [x] 档位（即时/默认/少量）+ 人设联动
- [x] 提示音（Glass 系统通知声 + ding/ping/soft/none）
- [x] 按内容分提示音（语音前/状态前）
- [x] 少量档 chime-only（只响提示音不说话）
- [x] 按会话分配音色（FNV-1a 哈希 + pitch/rate 微差）
- [x] 按会话开关语音（disabledSessions）
- [x] 异常状态短语（aborted/blocked/error/max-tokens/interrupted）
- [x] 审批/提问不念具体内容（只说"有操作需要你批准"/"您有一个问题待回答"）
- [x] 完成提示词自定义（phraseTurnEnd，{title} 占位符）
- [x] 工作区目录名作为会话标识
- [x] 监控面板（Token/延迟/系统/使用量 + SVG sparkline）
- [x] 宠物悬浮窗（Swift NSPanel + 跨空间 + hover 展开）
- [x] 桌面壳门禁适配（renderer capability 自动获取）
- [x] edge-tts volume 证伪 → 改用 afplay -v 播放端控制
- [x] reasoningEffort: 'off' 自动重试（不支持就去掉）
- [x] provider/model 自动检测 + 用户可选
- [x] 防重复规则（spokeThisTurn / 逐字朗读互斥 / verbalizer 抑制模板）
- [x] 合成健壮性（空文件检测 + 重试）
- [x] Kokoro 子进程隔离（onnxruntime abort-trap）
- [x] 弹窗面板（分卡片布局 + Toggle 开关 + SVG icon）
