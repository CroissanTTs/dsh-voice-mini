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
    /** {n} = number of gear-owned switches changed by hand. */
    customized: string;
    restore: string;
  };

  /** Card headings. */
  cards: {
    session: string;
    preset: string;
    speaking: string;
    events: string;
    voice: string;
    chime: string;
    test: string;
    jarvis: string;
    /** Collapsible read-only section (info + queue + metrics). */
    status: string;
    info: string;
    queue: string;
    metrics: string;
  };

  /** Row titles, each usually followed by a `…Hint` line saying when it acts. */
  rows: {
    perSession: string;
    perSessionHint: string;
    sessionVoice: string;
    speechMode: string;
    speechSelf: string;
    speechSelfHint: string;
    speechRead: string;
    /** {cap} = character limit per reply. */
    speechReadHint: string;
    summarizeResult: string;
    summarizeHint: string;
    summarizeOffByRead: string;
    provider: string;
    providerAuto: string;
    providerHint: string;
    refreshProviders: string;
    model: string;
    refreshModels: string;
    eventsMaster: string;
    eventsMasterHint: string;
    eventsChimeOnly: string;
    announceApproval: string;
    announceApprovalHint: string;
    announceQuestion: string;
    announceQuestionHint: string;
    announceTurnStart: string;
    announceTurnStartHint: string;
    announceTurnEnd: string;
    announceTurnEndHint: string;
    phrasePlaceholder: string;
    phraseHint: string;
    announceTodo: string;
    announceTodoHint: string;
    announceToolCall: string;
    announceToolCallHint: string;
    voiceAssign: string;
    voicePerSession: string;
    voiceFixed: string;
    voiceAssignHint: string;
    palette: string;
    paletteDefault: string;
    paletteCustom: string;
    palettePrefix: string;
    palettePlaceholder: string;
    voice: string;
    backend: string;
    backendHint: string;
    chimeMaster: string;
    chimeMasterHint: string;
    chimeSpeech: string;
    chimeStatus: string;
    jarvisState: string;
    jarvisConnected: string;
    jarvisDisconnected: string;
    jarvisVoice: string;
    jarvisVoiceAuto: string;
    jarvisVoiceHint: string;
  };

  /** Buttons + standalone action text. */
  actions: {
    preview: string;
    testSpeak: string;
    testPlaceholder: string;
    synthesizing: string;
    refresh: string;
    resetOverrides: string;
    refreshMetrics: string;
    resetPalette: string;
    rerollVoice: string;
    pause: string;
    resume: string;
    skip: string;
    replay: string;
    settingsHint: string;
    titleAttr: string;
    header: string;
    close: string;
  };

  /** The read-only info grid labels + enumerated values. */
  info: {
    preset: string;
    speechMode: string;
    speechReadReplies: string;
    speechAssistant: string;
    voice: string;
    backend: string;
    rate: string;
    volume: string;
    chime: string;
    off: string;
    queue: string;
    queuePlaying: string;
    lastCall: string;
    summarize: string;
    summarizeModel: string;
    summarizeTemplate: string;
    recentSpoken: string;
    noData: string;
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
