# dsh-voice-mini — PROTOTYPE（一次性原型，勿用于生产）

> 回答的问题：**"工具式语音反馈插件 + 小模型本地 TTS + 原生悬浮宠物窗"这条路线在 DSH 里能不能跑通、体验如何。**

语音反馈插件 v0.3：`speak` 工具（模型自己决定说什么）+ readReplies 自动朗读 + 状态播报（审批/提问/进度）+ 提示音 + 会话头部图标弹出的设置窗口 + 原生 macOS 悬浮宠物。

## 架构

```
                         ┌── edge-tts（默认，云端，中英好）
模型 ──speak 工具──      ├── kokoro（本地 82M，仅英文）
                  ├─►合成┤── say（macOS 离线，Tingting 中文）
助手消息 ─readReplies┘    └── fake（联调占位）
                          │
审批/提问/turn/todo 事件 ──┴─► 播报队列（单工）─► ①提示音 ②语音
                                   │
会话头部 SVG 图标 ──► 居中设置窗口 ─┤
                                   └─► /voice-mini/*（宿主路由）
                                        │  + runtime.json（origin+token）
原生宠物窗 pet/ ──► /voice-mini/pet/* ──
```

### 两类回复（按需求）

| 类型 | 触发 | 行为 |
|---|---|---|
| **结果回复** | `assistant/message`、`speak` 工具 | 完整播报内容（原来的逻辑），内容上限 300 字 |
| **进行中回复** | `approval/asked`、`approval/decided`、`ask_user_question`、`turn/start`、`turn/end`、`todo/write` | 一句状态提示："需要你批准：bash"、"有新问题需要你回答：…"、"本轮完成"、"任务进度：完成 2/5" |

### 提示音（earcon）规则

- 播报流程：**① 提示音 → ② 语音**。
- 提示音**每"一串"只响一次**：队列从空闲→忙碌的那一条携带提示音，紧随其后的连续播报不再重复响（`enqueue` 里的 `startsBurst`）。隔一会儿再来新事件算新一串，会再响一声。
- 音色内置合成（`ping` 双音 / `soft` 单音 / `none`），不依赖任何音频资源文件。

### 谁在说：助理本人 vs 模板（核心设计）

同一件事有两种做法，插件里**明确分开**：

| | 谁组织语言 | 性质 | 用在哪 |
|---|---|---|---|
| **助理口播**（默认） | **模型自己**，同一轮内调 `speak`，有完整上下文 | 人格化：说"你会对雇主说的那句话" | 结果、进度、里程碑 |
| **模板播报** | 宿主固定字符串 | 机械但可靠 | **阻塞类**：审批待办、新问题 |
| **逐字朗读**（可选，默认关） | 宿主照念回复文本 | 念稿 | 你不想看屏幕、只想听回复时 |

设计原则：**模型在回路里的（结果、进度）交给模型说；模型不在回路里的（审批、提问）老实用模板**——那时它在等你，机械警报反而合适。

三条防止"说两遍"的规则（都已实测）：

1. 模型本轮已调过 `speak` → `turn/end` 的「本轮完成」模板**不响**
2. 模型本轮没开口 → 模板照常兜底，保证有完成提示
3. 开了逐字朗读 → 回复本身就是语音，模板不响；同时人设切换为"逐字朗读模式"，明确要求模型**不要**再调 `speak`

### 情绪化总结（Verbalizer Pass）

会话结束后，用一个轻量模型分析助手回复，生成一句**带情绪引导的口播**——不是念稿、不是模板，是助理看了结果后对你说的那句话：

```
turn/end（模型没自己开口、没开逐字朗读、summarizeResult 开启）
  ↓ 取最后一条回复文本
  ↓ 拼 prompt（summarizePrompt，{reply} 占位符）
  ↓ ctx.llm.stream({ messages, system, maxTokens, purpose, signal })
     ├─ 超时(summarizeTimeoutMs) → fallback 模板
     ├─ 报错 → fallback 模板
     └─ 正常 → 口播文本 → enqueue → chime → TTS
```

比如模型回了 300 字技术分析，助理说："好消息，三个测试全过了，有个小警告我先标出来了。"

防重复（第四条）：verbalizer 成功 → `spokeThisTurn = true` → 模板不触发。

配置：
- `summarizeResult`（默认 `true`；少量档关）
- `summarizePrompt`（`{reply}` 占位符，可自定义）
- `summarizeModel`（留空走默认）
- `summarizeMaxTokens`（80，一句话够）
- `summarizeTimeoutMs`（8000ms）

人设联动：开启时人设加一句"系统会自动总结你的结果，你不需要为日常完成调 `speak`"。

自检 8 种情况全对 ✅：mock LLM 成功 / LLM 报错 fallback / LLM 超时 fallback / 模型已开口抑制 / 逐字朗读抑制 / 无 LLM 服务 fallback / 空回复 fallback / summarizeResult 关闭走模板。

### 档位（沟通频率 / 内容范围 / 声音）

三档是"粒状配置之上的一个 bundle"：宿主不特判它，只把它作为解析的**基础层**（见 `resolve()`），所以任何单项仍可覆盖。

| | 即时沟通 `instant` | 默认沟通 `default` | 少量沟通 `quiet` |
|---|---|---|---|
| **频率** | 开始 + 完成 + 进度 + 工具调用 + 审批/提问 + 每步都开口 | 结果说一句 + 完成 + 审批/提问 | **仅**审批 / 提问（阻塞项） |
| **内容范围** | 全过程都说（模型自述） | 结果说一句（模型自述） | 不主动开口 |
| **声音** | 语速 +18% | 原速 | 语速 −5%、音量 −30%、提示音 `soft` |
| **人设** | "以你自己的身份说，每完成一步就说你会说的话" | "给出结果后说一句；例行过程保持沉默" | "只在人必须行动或你被阻塞时说，一句话" |

**"频率"由两处同时决定**：宿主的事件过滤器 + **人设文本**。只改前者的话，即时档的模型仍然不会主动开口——因为它自己决定要不要调 `speak`。

> `narrationCap`（朗读上限）只作用于**逐字朗读模式**；助理口播由模型自己控制长度（人设要求一两句）。

### 提示音规则

- **提示音只在有说话内容之前响**（result/tool/verbalizer/speak），状态播报不再带提示音前缀——状态本身够短，不需要"注意，要说话了"的信号。
- **少量档**：状态项（审批/提问/完成等）**只响提示音不说话**（`statusSpeech: false`）——提示音就是通知本身，内容看屏幕即可。
- **默认/即时档**：状态项有说话内容（`statusSpeech: true`），提示音只在真正的口播前响。

### 异常状态

turn/end 的 `reason.kind` 匹配到不同短语，不再一律"会话已完成"：

| reason.kind | 短语 |
|---|---|
| `completed` | 正常 → verbalizer 或模板 |
| `aborted` | 会话被中止 |
| `blocked` | 会话被阻塞 |
| `error` | 出错了，请查看 |
| `max-tokens` | 回复被截断 |
| `interrupted` | 会话被中断 |

### 按会话自动分配声音

每个会话按 ID 哈希**确定性地**分配一个音色（外加语速微差），无需用户指定：

- **确定性**：同一会话永远同一个声音（跨重启）——FNV-1a 哈希
- **靠音色区分**：默认音色池是一组**自然**声音（女声 + 男声），**不改音高**——改调子会让声音变怪，所以随机只随机音色、保留音色原色；另加 ±6% 语速（5 档）微差做"同音色不同快慢"的辅助区分
- **池大小**：edge 默认 10 个 zh-CN 音色（6 女 4 男），kokoro 6 个（女+男），say 3 个（婷婷/美佳/善怡）
- 实测：40 个会话 → 27 种去重组合；前 12 个会话 10/12 去重（生日悖论预期内，10 个默认音色全部覆盖到）

```
声音分配 = 按会话（默认） | 固定
音色池    = [] → 用后端内置默认；或自定义如 ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunjianNeural']
```

- `zh-CN-YunxiNeural` 已被上游下线，勿列入音色池

> 更大的贾维斯式总体助理（跨会话告知 + 语音回复路由 + 切模型/推理强度）**不应**在本插件实现——它需要独立设计一个调度型插件。本插件只做"每个会话有自己的声音"这一件事。

解析优先级（低 → 高）：

```
PRESETS[preset]  <  组合配置里显式写的键  <  设置面板的改动  <  弹窗/宠物的即时覆盖
```

- "设置面板的改动"靠**与组合默认值比较**判定：面板总是返回完整对象，只有和 `entry` 不同的值才算用户改过，这样没动过的面板不会盖掉档位。
- 所以 `cordis.patch.yml` 里手写的 `announceTurnEnd: true` 能在切到少量沟通后依然生效。

### 关键技术点（都是踩过坑的）

- **延迟注入**：`ctx.get('webServer'/'systemPrompt'/'settings')` 在 `apply()` 里会与服务启动竞争，必须用 `ctx.inject([...], cb)`，否则路由静默不注册（表现为弹窗里所有控件都点不动）。
- **Kokoro 子进程隔离**：onnxruntime 在 Node 26 退出时 abort-trap；子进程按"输出文件是否存在"判成功，并设 `ELECTRON_RUN_AS_NODE=1` 规避 Electron 的 `process.execPath` 陷阱。
- **宠物发现机制**（参考 [dsh-notch](https://github.com/aa2246740/dsh-notch)）：宿主写 `~/.dsh/voice-mini/runtime.json`（0600）= `{origin, token, pid}`，原生 App 读它连接；`/pet/*` 路由要求 loopback + `Bearer <token>`。可用 `DSH_VOICE_MINI_RUNTIME` 覆写路径。
- **桌面壳门禁（关键坑）**：DSH Desktop 会给**每一个**插件路由套 `permits(req)`，当 `openBrowser: false` 且 `networkExposure: loopback`（默认）时，**不带 `x-dsh-desktop-renderer` 能力的请求一律 403 "forbidden"**。插件从自身 `desktopBrowserAccess` 服务读到该能力并写进 runtime 文件，宠物带上它才连得上——无需用户开启普通浏览器访问。

## 运行

```bash
npm install --cache /tmp/npm-cache   # 本机 ~/.npm 是 root 所有，绕一下
npm run build                        # tsc + 客户端 bundle
node test-plugin.mjs                 # 无 harness 自检（会真实发声，含宠物端点鉴权检查）
node test-presets.mjs                # 档位解析优先级自检
node test-agency.mjs                 # "谁在说"自检：模型口播 vs 模板不重复
node test-voices.mjs               # 按会话分配音色：确定性 + 分布 + 碰撞率
node test-summarize.mjs            # 情绪化总结（verbalizer）：mock LLM/超时/报错/防重复/逐字朗读/无LLM/空回复
```

原生宠物（可选）：

```bash
export DEVELOPER_DIR=/Library/Developer/CommandLineTools
swift build --package-path pet -c release     # 沙箱内需加 --disable-sandbox，详见 pet/README.md
pet/.build/release/voice-pet                  # 悬浮球，hover 展开
pet/.build/release/voice-pet --selftest       # 无窗口自检：读 runtime + 拉一次 state
npm run test:pet                              # 端到端：真实插件路由 + 真实原生二进制
```

`npm run test:pet` 会用插件自身的路由处理函数起一个真实 HTTP 服务，写入 runtime 文件，再让**真实的原生宠物二进制**去连它——覆盖"发现 → 鉴权 → 契约 → 原生客户端"整条链路，不需要 DSH 应用在场。

## 安装

装在**你的 DSH profile**里（任选一个激活的 profile，不限于默认 `desktop`）：

- `<profile>/package.json`：`dependencies` 加 `"dsh-voice-mini": "link:<本目录>"`（或发布后的版本号），`dsh.profile.bundles` 末尾加 `"dsh-voice-mini"`
- `pnpm install`（软链生效）
- 客户端半边支持热更新（改完刷新页面即可）；宿主半边改动需要重启应用

## 配置

即时改：点右上角图标 → 弹出窗口（设置在上、信息在下）。
持久化：设置面板「dsh-voice-mini」分区，或 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-voice-mini
  config:
    backend: edge                    # edge | kokoro | say | fake
    voice: zh-CN-XiaoxiaoNeural
    readReplies: false
    chimeEnabled: true               # 提示音开关
    chimeSound: ping                 # ping | soft | none
    statusEnabled: true              # 状态播报总开关
    announceApproval: true           # 权限待审批
    announceQuestion: true           # 新问题
    announceTurnStart: false         # 开始处理
    announceTurnEnd: true            # 本轮完成
    announceTodo: false              # 任务进度
```

## 已知限制（原型边界）

- **Kokoro 仅英文**：kokoro-js 1.2.1 没有中文 G2P，中文音色文件存在但喂中文出乱码 → 中文用 edge 或 say。
- 朗读前只是粗糙正则去 Markdown（代码块 → "（代码略）"）；单条上限 300 字。
- 播报串行、无打断（barge-in）、无句级流式——属 v2 范围。
- 宠物不做 SSE 推送，是 0.5s 轮询（够用，但状态有几毫秒延迟）。
- 只测 macOS；自定义会话事件在 rc 系列不能持久化，故全部走内存。

## 验证记录（2026-09-14，本机 macOS）

- Kokoro-82M q8 CPU：缓存后装载 0.3s，短句合成 ~1.3s → 真实可听 ✅（英文）
- edge-tts zh-CN-XiaoxiaoNeural：~1.5s → 真实可听 ✅（中文）
- 提示音合成：`ping` 0.29s WAV，实际播放 ✅
- "谁在说"4 条规则实测 ✅：模型开口→模板静音、模型沉默→模板兜底、逐字朗读→模板静音、人设随档位/模式切换
- 档位解析 6 种情况全对 ✅（默认档 / 切 quiet / 切 instant / 档位+单项覆盖 / 组合配置压过档位 / reset 回到配置默认）
- 声音维度实测 ✅：同一句话 `+0%` → 8.064s，`+18%` → 6.840s（比值 1.179，正是 +18%），`-5%` → 8.472s（比值 0.952）
- **音量坑**：edge 的 SSML `volume` 被服务端归一化——`-100%` 完全无效、`+100%` 只提升 6.6%（实测峰值 −100% 仍是 24948）。改为**播放端** `afplay -v` 控制，对所有后端一致生效。
- 合成健壮性：edge-tts 偶发超时并留下 **0 字节 mp3**（会导致静默）→ 已加"空文件检测 + 重试一次" ✅
- 自检全绿：Config 默认值 / 延迟注入（无服务 routes=0 → 有服务 routes=1）/ persona / settings 分区 / `/state` `/config` `/toggle` `/test` / 队列串行 / 审批事件→状态播报 / 提示音每串一次 / 宠物端点鉴权（无 token 403）
- 原生宠物：`swift build -c release` 干净通过（二进制 519KB）；4 条 selftest 路径（runtime 缺失→exit 2、端口不通→exit 1、成功→exit 0）✅；窗口在 layer 25 全屏空间可见、hover 展开 300×260 / 移开 0.4s 折叠 72×72 ✅
- **端到端**：真实插件路由 + 真实原生二进制 → `200 OK`，`attention=approval`、`attentionText="需要你批准：bash：写入工作区"`、`speaking=true` ✅

## 后续规划（落盘）

### 语音信箱（Voicemail）

**即时档**：有消息直接播放（当前行为）。
**默认档**：口播内容进入"语音信箱"——悬浮窗上显示未读标记，用户**点击后才开始播放**。类似收到语音消息后选择何时听。

难点（暂未解决）：
- 多会话内容堆积：A 说完了、B 说完了、C 正在说——信箱需要排队 + 优先级 + 去重
- 回复机制：用户听完后的回应如何路由到正确的会话？需要独立设计一个调度型插件
- 这属于"总体助理"范畴（跨会话调度 + 语音回复路由 + 切模型/推理强度），不应在本插件内实现

### 总体助理（独立插件）

本插件只做"每个会话有自己的声音"这一件事。更大的贾维斯式总体助理需要独立设计：
- 跨会话监听 + 用对应会话的声音告知
- 接收用户语音 + 理解意图 + 发消息到正确会话
- 切模型 / 推理强度 / 工具选择

本插件为那个未来插件留了底：`sessionVoiceFor(sessionId, config)` 已可复用。