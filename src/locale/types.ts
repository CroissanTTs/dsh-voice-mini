/**
 * Locale dictionary contract — shared by the host (server) and the client.
 *
 * `zh.ts` and `en.ts` are the two concrete dictionaries; `index.ts` exports
 * `pickLocale()` so a single call returns the right one for `config.locale`.
 *
 * Placeholders like `{title}`, `{tool}`, `{done}/{total}` stay as literal
 * text — the caller replaces them. The verbalizer prompt keeps `{reply}`.
 *
 * @module dsh-voice-mini/locale
 */

export type LocaleId = 'zh' | 'en';

export interface LocaleDict {
  /** Communication presets — names + one-line hints shown under the pills. */
  presets: {
    instant: { name: string; hint: string };
    default: { name: string; hint: string };
    quiet: { name: string; hint: string };
  };

  /** Uppercase card labels. */
  cards: {
    broadcast: string;  // 播报 / Broadcast
    voice: string;      // 声音 / Voice
    chime: string;      // 提示音 / Chime
    test: string;       // 试听 / Test
    info: string;       // 信息 / Info
    queue: string;      // 队列 / Queue
    metrics: string;    // 监控 / Monitor
    jarvis: string;     // Jarvis 助理 / Jarvis Assistant
  };

  /** Row titles + small inline hints. */
  rows: {
    perSession: string;        // 本会话语音 / This session voice
    perSessionHint: string;    // 关闭后该会话不发声… / When off, this session stays silent…
    readReplies: string;       // 逐字朗读（念稿） / Read aloud (script)
    statusBroadcast: string;  // 状态播报 / Status broadcast
    announceApproval: string;  // 权限待批 / Approval pending
    announceQuestion: string;  // 新问题 / New question
    announceTurnStart: string; // 开始处理 / Started
    announceTurnEnd: string;   // 本轮完成 / Turn done
    announceTodo: string;      // 任务进度 / Task progress
    announceToolCall: string;  // 工具调用 / Tool call
    summarizeResult: string;   // 情绪化总结 / Emotional summary
    summarizeHint: string;     // 开启后由模型分析… / When on, a model analyzes…
    provider: string;          // 服务商 / Provider
    providerHint: string;      // 填你的服务商路由名… / Enter your provider route name…
    providerPlaceholder: string; // 占位 / placeholder
    providerAuto: string;      // 自动(取第一个) / Auto (first adapter)
    refreshProviders: string;  // 刷新服务商列表 / Refresh provider list
    model: string;             // 模型 / Model
    refreshModels: string;     // 刷新模型列表 (title) / Refresh model list
    voiceAssign: string;       // 分配 / Assignment
    voicePerSession: string;   // 按会话 / Per-session
    voiceFixed: string;        // 固定 / Fixed
    palettePrefix: string;     // 池：/ Pool:
    paletteDefault: string;    // 默认池 / Default pool
    paletteCustom: string;     // 自定义 / Custom
    paletteHint: string;       // 每会话从池中取一个音色… / Each session picks one voice from the pool…
    palettePlaceholder: string; // 每行一个音色ID / One voice ID per line
    voice: string;             // 音色 / Voice
    backend: string;           // 引擎 / Engine
    chimeMaster: string;       // 总开关 / Master switch
    chimeSpeech: string;       // 语音前（助理口播） / Before speech (assistant)
    chimeStatus: string;       // 状态前（播报通知） / Before status (notice)
    phrasePlaceholder: string; // 工作区 {title} 下的会话已完成 / Workspace {title} session done
    phraseHint: string;        // {title} = 工作区目录名 / {title} = workspace directory name
    // ── Jarvis 联动 ──
    jarvisLinked: string;     // 启用联动 / Enable linkage
    jarvisLinkedHint: string; // 检测到 jarvis 插件自动激活… / Auto-activated when jarvis is detected…
    jarvisVoice: string;      // 专属声音 / Dedicated voice
    jarvisVoiceHint: string;  // 留空=用默认音色… / Empty = default voice…
    jarvisSpeechMode: string; // 播报模式 / Speech mode
    jarvisVoicemail: string;  // 语音信箱 / Voicemail
    jarvisVoicemailHint: string; // 口播内容进信箱… / Utterances park in inbox…
    jarvisPersona: string;    // 人设 / Persona
    jarvisPersonaPlaceholder: string; // 统一助理人格 prompt… / Unified assistant persona…
  };

  /** Buttons + standalone action text. */
  actions: {
    preview: string;          // 试听 / Preview
    testSpeak: string;        // ▶ 试听语音 / ▶ Test voice
    testPlaceholder: string;  // 试听文本（留空用默认） / Test text (empty = default)
    synthesizing: string;     // 合成中… / Synthesizing…
    refresh: string;          // 刷新 / Refresh
    resetOverrides: string;   // 重置覆写 / Reset overrides
    refreshMetrics: string;   // 刷新监控 / Refresh monitor
    resetPalette: string;     // 恢复默认 / Reset to default
    rerollVoice: string;      // 重新随机声音 / Re-roll voice
    pause: string;            // 暂停 / Pause
    resume: string;           // 继续 / Resume
    skip: string;             // 跳过 / Skip
    replay: string;           // 重播本会话 / Replay session
    jarvisAlways: string;     // 总是播报 / Always
    jarvisNormal: string;     // 正常 / Normal
    jarvisQuiet: string;      // 安静 / Quiet
    settingsHint: string;     // 持久设置在「设置 → dsh-voice-mini」分区 / Persistent settings under "Settings → dsh-voice-mini"
    titleAttr: string;        // 语音反馈 (button title) / Voice feedback
    header: string;           // 语音反馈 / Voice feedback
  };

  /** The read-only info grid labels + enumerated values. */
  info: {
    preset: string;            // 档位 / Preset
    speechMode: string;        // 口播 / Speech
    speechReadReplies: string; // 逐字朗读 / Read aloud
    speechAssistant: string;  // 助理自述 / Assistant voice
    voice: string;             // 音色 / Voice
    backend: string;           // 引擎 / Engine
    rate: string;              // 语速 / Rate
    volume: string;            // 音量 / Vol
    chime: string;             // 提示音 / Chime
    chimeOff: string;          // 关 / Off
    queue: string;             // 队列 / Queue
    queuePlaying: string;      // 播放中 / playing
    lastCall: string;          // 上次 / Last
    summarize: string;         // 总结 / Summary
    summarizeModel: string;    // 模型口播 / Model voice
    summarizeTemplate: string; // 模板 / Template
    recentSpoken: string;      // 最近播报 / Recent
    noData: string;            // 暂无 / None
  };

  /** Metrics panel labels. */
  metrics: {
    totalTokens: string;      // 总 Token / Total Tokens
    llmSuccessRate: string;   // LLM 成功率 / LLM success
    ttsFailRate: string;      // TTS 失败率 / TTS fail
    avgLlm: string;           // 均 LLM / Avg LLM
    avgTts: string;           // 均 TTS / Avg TTS
    avgTextLen: string;       // 均字数 / Avg chars
    tokenTrend: string;       // Token 消耗趋势（近 N 次） / Token trend (last N)
    latencyTrend: string;     // LLM 延迟趋势（ms） / LLM latency trend (ms)
    kindDist: string;        // 播报类型分布 / Broadcast kind distribution
    sysResource: string;      // 系统资源 / System
    cpu: string;              // CPU / CPU
    memory: string;           // 内存 / Memory
    audioDisk: string;       // 音频盘 / Audio disk
    loading: string;         // 加载中… / Loading…
    noSparkData: string;     // 暂无数据 / No data yet
  };

  /** Server-side spoken phrases (what the human *hears*). */
  spoken: {
    approvalNeeded: string;  // 有操作需要你批准 / An action needs your approval
    newQuestion: string;     // 有新问题需要你回答 (pet card) / A new question needs your answer
    questionPending: string; // 您有一个问题待回答 / You have a question to answer
    startHandling: string;   // 开始处理 / Starting
    /** {tool} replaced with the tool name. */
    executingTool: string;   // 执行 {tool} / Running {tool}
    /** {done}/{total} replaced with counts. */
    todoProgress: string;    // 任务进度：完成 {done}/{total} / Task progress: {done}/{total} done
    turnCompleted: string;   // 会话已完成 / Session complete
    testDefault: string;     // 你好，这是语音反馈原型。 / Hello, this is the voice feedback prototype.
    fallbackTool: string;    // 某操作 / an action
    /** {title} replaced with the workspace directory name. */
    phraseTurnEnd: string;   // 工作区 {title} 下的会话已完成 / Session in workspace {title} is complete
    aborted: string;
    blocked: string;
    error: string;
    maxTokens: string;
    interrupted: string;
  };

  /** Inline markers used by text scrubbing. */
  misc: {
    truncatedSuffix: string; // …（后略） / …(more omitted)
    codeOmitted: string;      // （代码略） / (code omitted)
  };

  /** Verbalizer prompt — {reply} replaced with the assistant's last message. */
  summarizePrompt: string;
}
