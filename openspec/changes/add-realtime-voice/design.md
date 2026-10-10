## Context

基线是合并后的 `main@ecdfedf362ba4e060707a645a1b038cd378e43bf`。本轮 v2 仅更新方案；未创建 runtime、请求麦克风权限、改全局配置、启动服务或调用付费 API。以下本机数字来自上一轮交接，本轮未重测。

### 豆包实时通话：查到、未查到和推断

| 项目 | 证据与边界 |
|---|---|
| 全双工、随时插话 | **查到**：Seed 官方 2026-04-09 发布 Seeduplex，称已全量上线豆包 App，持续边听边说，并在用户打断时停播转为倾听。[官方介绍](https://seed.bytedance.com/zh/blog/introducing-seed-full-duplex-speech-llm-attentive-listening-robust-interference-suppression-enabling-more-natural-interaction) |
| 端点检测与打断延迟 | **查到相对改进，未查到绝对 SLA**：同一官方文称判停时延降低约 250ms、打断响应缩短约 300ms；这不是“豆包打断只要 300ms”。动态判停结合语音与语义，能区分思考停顿。本方案的 <300ms 是自己的目标。 |
| 回声消除 | **查到服务层能力**：火山引擎官方开发者文章解释双讲中的回声消除与降噪。[RTC 方案](https://developer.volcengine.com/articles/7400774724738875428)。**未查到**豆包 App 当前客户端的具体 AEC 参数、算法版本；不能把 SDK 配置当作 App 实测。 |
| 视频通话 | **查到**：Seed 官方 2026-08-05 称音视频全双工 SeedRealtime 已上线，持续理解声音、画面及其时序，入口为“打电话”中的视频通话。[官方介绍](https://seed.bytedance.com/zh/blog/seedrealtime-audio-visual-full-duplex-llm-released-toward-omni-modal-natural-interaction?view_from=homepage_tab) |
| 形象、口型和状态反馈 | **未查到**可核实的官方口型同步机制或当前界面形象规范，未实际登录 App 观察。**设计推断**：桌宠应显示倾听/等待/说话状态及音量反馈；这不是宣称豆包有同款像素形象或音素口型。 |

本地级联只能做到录音与播报同时运行、及时打断，不能等同于豆包原生语音语义联合建模、旁人过滤或连续视频理解。官方页面可查的结论直接引用；搜索摘要中的服务参数只作线索，不作为 App 内部实现证据。

### 本机服务实测（2026-10-09；单样本，不是性能基准）

所有 loopback 请求使用 `curl --noproxy '*'`，未启动、停止或改写服务。

| 服务 | 实测结果 |
|---|---|
| whisper.cpp | `GET http://127.0.0.1:2022/` HTTP 200，页面列出 `/v1/audio/transcriptions`。现有进程参数显示 `ggml-small.bin`，中文请求返回 HTTP 200，耗时 0.782519s。输入为 Kokoro 合成的“你好，这是桌宠语音测试。”，输出“你好,这是桌虫语音测试”，说明已能识别但有同音字误差。 |
| Kokoro | `/v1/models` 与 `/v1/audio/voices` HTTP 200，含 `kokoro` 和 `zf_xiaobei`。`stream:true` 的 WAV 请求 HTTP 200，134,970 字节，完成时间 0.893932s，响应 `Transfer-Encoding: chunked`。 |
| Kokoro 流式确认 | 另用中文两句、`stream:true,response_format:pcm`，从 curl stdout 实际读到首个 PCM 数据耗时 1.739s，结束 2.700s，共 109 次读取、442,308 字节，按 24kHz/s16/mono 为 9.215s 音频。证明可以在完整音频生成结束前消费数据；读取次数不是模型分句数。WAV 请求的 0.020293s 首字节是 HTTP 头部时延，不是首音频时延。 |
| VoiceMode MCP | 只读安装元数据确认 8.12.0；本地 `voice_mode/tools/converse.py:3575-3608` 为 speak-only pipeline，`:3800-3845` 在播报/重放后进入 listen。虽有控制通道 stop/skip/replay，未确认持续录音的用户语音 VAD 打断能力。按任务书作轮流对话参考，不调用、不依赖。 |

Kokoro 的本地 `/openapi.json` 声明 `stream` 默认 true、`response_format` 支持 PCM；源码 `~/.voicemode/services/kokoro/api/src/routers/openai_compatible.py:135,209` 有生成器与 StreamingResponse 路径。[官方仓库的流式例子](https://github.com/remsky/Kokoro-FastAPI/blob/master/examples/stream_tts_playback.py) 采用 24kHz、16-bit PCM。实施时要针对本机版本再次校验采样率，不盲信默认值。

### 接入点（上游更新后行号已变化）

| 位置 | 接入方式 |
|---|---|
| `src/state-priority.js:10`、`src/state.js:3748` | 在现有显示状态选择中增加受控 voice overlay，不伪造 agent session；保持 permission/update 优先级与 session snapshot/HUD。 |
| `themes/clawd/theme.json:1104` | 可选 listening/speaking 状态能力；原任务书 `:53` 现已是配饰定义。缺能力时使用现有 SVG fallback。 |
| `src/server.js:979` | `POST /state` 保持 hook 契约；音频与通话控制走经 sender 校验的 IPC，不通过 HTTP state 路由发送二进制或扩展 agent 注册表。 |
| `src/pet-interaction-ipc.js:138`、`src/preload-hit.js:42`、`src/hit-renderer.js` | 在既有输入窗口的非拖拽 click 路径识别语音手势，经 main 通知渲染窗口；保留原点击反应、HUD 与拖拽。 |
| `src/renderer.js:2957`、`src/preload.js`、`src/index.html:5` | 现有 Audio 播放是一次性主题音效，不适合作 PCM 队列。新增独立 voice audio 模块与 AudioWorklet，复用 IPC 生命周期；不把语音代码堆入 renderer。CSP 只为可信本地 worklet/音频增加必要权限。 |
| `src/menu.js:488`、`src/shortcut-actions.js:13`、`src/shortcut-runtime.js` | 菜单 Start/End 与可配置快捷键调用同一个 runtime toggle；快捷键默认未绑定，注册失败可见。 |
| `src/prefs.js:257`、settings-controller/store/actions/general/i18n | 按现有 schema/validators/controller 保存开关及 provider，所有写入由 controller 完成；多语言跟当前 7 种语言保持齐全。 |
| `package.json:120`、`build/` | 目前 extendInfo 仅 LSUIElement，build 没有音频 entitlement 文件。实现时添加用途说明与签名配置，而不是假定麦克风权限已具备。 |

## Goals / Non-Goals

**Goals:** 默认关闭、主动开始、播报时持续倾听；打断不依赖 ASR 或网络；可插拔中文流式识别/合成；在旧主题和并行 coding session 下可用；错误与麦克风状态可见；提供可测量的延迟目标。

**Non-Goals:** 本轮不实现功能；MVP 不开摄像头、不复制豆包模型、不做精确音素口型、不依赖 VoiceMode、不安装服务；大脑已定 Claude Code；电脑操作暂按只聊天推荐执行，保留待确认。

## Decisions

### 1. 运行时沿用现有模块和双窗口

main 组装小型 `createVoiceRuntime`，控制生命周期与请求；可信宠物渲染窗口负责 getUserMedia / AudioWorklet / PCM 播放，输入窗口只发送用户手势。拟新增 `src/voice-runtime.js`、`voice-audio-renderer.js`、`voice-vad.js`、`voice-provider.js`，必要时按 provider 职责拆分，不引入通用 managers/utils 分层。每个文件约 300 行内、函数约 50 行内，测试沿用 `test/<module>.test.js`。

录音片段通过受限 preload IPC 交给 main；loopback HTTP 使用 Node 内置 http，仅连接固定 127.0.0.1 地址，不继承全局代理、不接受重定向到外网。renderer 不直接开放任意 URL/child_process 能力；不放宽 `connect-src` 到公网。云音频由 main 连接已选厂商的固定 TLS/WSS endpoint，密钥不进 renderer；loopback 与云 adapter 分开校验。Claude Code 文本网络由其自身认证管理。

备选：把 VoiceMode MCP 当后端会沿用 speak-then-listen 轮次和更多配置；把全部逻辑放 renderer 会难以管理 CLI 子进程与请求取消，因此采用本地小模块 + IPC。

### 2. 连续录音、Silero VAD 和端点检测

通话期间保持 `getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false})` 的 track 活跃，即使正在播报也不关闭麦克风。不用“说完后再录音”的方案。

**本地神经网络 VAD（默认）：**VAD 由能量阈值换为 Silero（`silero_vad.onnx`，644KB，经 sherpa-onnx 的 `Vad` 运行，threshold 0.5、`windowSize` 512、`minSilenceDuration` 0.1s）。Silero 需要 native 推理，只能在 main 进程：renderer 的 AudioWorklet 仍每 20ms 取一帧，重采样为 16kHz/16-bit 后经现有受限 `voice:audio` IPC **连续**送给 main（约 32KB/s，播报期间也不停）；main 的 `voice-vad-silero.js` 在探测器给出的逐帧 voiced 之上做迟滞状态机：连续约 60ms 人声触发 speech-start，保留 300ms pre-roll，结束静音初值 350ms（250–500ms 可调），最短有效人声 150ms（不足记 reason=noise 并取消 STT），单段最长 15s。main 把 `speech-start`、说话中的逐帧 `frame{voiced}`、`speech-end` 经新增出站通道 `voice:vad` 回给 renderer，让就地降音和“连续人声”计时仍在 renderer 完成，降音不等待 STT 或网络。探测器和状态机分离：状态机用 fake 探测器单测，真实模型由 `test/voice-sherpa-native.test.js`（模型已下载时运行）覆盖。

**实测（2026-10-09，M 系列 macOS arm64，Silero + 20ms 帧，`scripts/manual/voice-sherpa-bench.js`）：**VAD 每 20ms 帧处理均值 0.24–0.26ms、p95 0.58–0.71ms、最大 2.7–6.3ms（Node 与 `ELECTRON_RUN_AS_NODE` 下一致）；纯 sherpa `Vad` 自测均值 0.04ms。speech-start 在 TTS 样本片头后约 80–100ms 触发（含 32ms 窗口与 60ms 起始确认）。这是合成人声的单样本，不是真人/噪声基准。

**能量 VAD 保留为回退：**sherpa 模型缺失或 native 模块加载失败时，renderer 继续使用原 RMS 能量 VAD（`voice:start` 的 `vad:"renderer"`），STT 回退 whisper；此时没有 partial，打断确认只靠连续人声时长。

麦克风实际采样率从 track/AudioContext 读取。识别在 main 进程内流式进行：speech-start 时开启一个 sherpa 在线 stream，pre-roll 和之后每帧即时喂入，partial 经 `voice:partial` 回给 renderer 供打断确认和界面，**不喂大脑**；speech-end（静音 350ms）后补 300ms 尾部静音、`inputFinished`、解码到空，取最终文本作为 final，**只提交一次**。final 之前用户继续说话会取消尚未提交的静音计时。whisper 回退则缓存有界片段转 WAV，显式 language=zh，不把批量接口伪装成流式。

备选：WebRTC VAD 或在 renderer 里用 onnxruntime-web 跑 Silero 会引入 WASM/CSP 与第二份模型运行时，且与 STT 同在 main 更省 IPC，因此不采用。端点降低到 100ms 会增加抢话，不能混同打断的 <300ms 目标。

### 3. 打断先在本地生效，再取消后端

**两段式打断（对标豆包不被附和/杂音误打断）：**
- **先降音（duck）：**main 的 Silero speech-start 到达 renderer 后立即把 TTS gain 压到约 -18dB（IPC 回程为同机进程间消息，毫秒级），不停播、不递增 epoch、不取消后端。
- **再确认（commit）：**任一满足即正式打断：**sherpa-onnx 流式 partial** 出现非附和实义文本（`voice-barge-in.js` 的 `onPartial`，去标点后整句仅由附和词组成则忽略）；或连续人声 ≥300ms（无 partial 也算，保证识别器慢/不可用/回退 whisper 时仍可打断）。附和词表（嗯/对/好/是/哦/啊/嗯嗯…）、咳嗽和 <300ms 杂音在 600ms 内未确认则恢复音量继续播。
- partial 带标点（如“嗯，”）也按附和处理；用户说“嗯，等一下我有问题”时，partial 一旦出现实义字符即提交。partial 来源只有 sherpa 在线 stream，不为打断额外跑第二个识别器。
- 静默确认窗口内 TTS 继续排程，只是降音；确认失败不回放、不丢句。
- 已知差距：旁人说话、电视人声无法区分（豆包靠一体化模型做说话人/语义抑制），第一版不做；外放自打断靠 AEC，需实测，耳机最稳。

正式打断时原子递增 `turnEpoch`：立刻把 TTS gain 淡出到 0（≤20ms）、stop 所有正在/已排程的 AudioBufferSource、清空分句与 PCM 队列，再取消该 epoch 的 ASR、大脑和 TTS 请求。录音 AudioContext 不 suspend，麦克风 track 不 stop。

所有网络响应、JSONL 事件与 PCM chunk 携带 epoch；过期结果即使已经到达，也不能入队、播报或更新状态。HTTP 使用 AbortController 或 request.destroy；CLI 发官方支持的 interrupt 控制请求（能力探针通过后）或 macOS/Linux SIGINT，超时才终止本次拥有的子进程，不能 pkill 全局 node/agent。SIGTERM/HTTP 断开并不保证服务端马上停止算力，本地停止与迟到结果隔离是保证；不能撤销已经执行的电脑操作。

打断时以音频 sink 的播放完成 ACK 维护已听历史，按完整短句保守提交；句中打断只保留完整已播句，另标 partiallyPlayed（无字词时间戳时不得猜测已播字符）。Claude 会话内部已生成内容不会因停播自动删除：打断后丢弃旧脑会话、从应用内存的已听历史重建，详见第 5 节。最多预合成 2 句、缓存 2s PCM，队列达到上限暂停上游读取，避免长回答塞满内存。

**打断验收目标：**从用户真实声学起始 `t0` 到输出声道静音 `tSilent`，安静耳机及受控外放场景 P95 <300ms；从 main 发出 speech-start 到降音 P95 <100ms、从确认到静音 P95 <80ms（P95 <300ms 目标对“降到不干扰”计，彻底停播 ≤ 确认时刻+80ms）。预算为帧收集 20ms + Silero 判定与起始确认约 80–100ms（实测）+ IPC/排程 20–40ms + 淡出/设备缓冲 20–80ms，合计约 140–240ms，仍属待测目标，未做真人双声道声学测量。

**partial 驱动的实测延迟（TTS 合成样本，单样本）：**sherpa partial 在识别器首个 token 时间戳后约 10–35ms 内出现；样本从片头到第一个音节有 0.64–0.8s 的前导，故自 Silero speech-start 起约 0.59–0.84s 才有首个 partial。真人直接开口的首 partial 延迟需用真人录音复测；在此之前打断确认的保底仍是 300ms 连续人声。

**测量方法：**对每种设备至少 40 次插话；用独立双声道录音同时记录测试人声参考与扬声器/输出 loopback，以采样索引算 t0/tSilent，避免 AEC 后的麦克风信号被当作真实起点。应用记录 speech-start、cancel、最后输出样本的 monotonic timestamp，校准跨进程时钟。报告 P50/P95/最大值、误打断率和漏打断次数；不能仅用 pause() 调用时间或 ASR 完成时间算延迟。

### 4. 默认本地流式 STT（sherpa-onnx）、TTS 与 provider 合约

**决策（用户定：完全本地、免费）：**默认 STT 为 `sherpa-onnx`（本地流式中文/中英），VAD 为 Silero；TTS 仍为本机 Kokoro:8880（zf_xiaobei），大脑仍为 Claude Code。云 provider（Paraformer / CosyVoice）保留为用户显式选择的可选项，不再是默认；whisper.cpp:2022 保留为 STT 回退。选择依据是成本为零、语音不出本机、有 partial 可驱动打断，**并未实测优于豆包**。

**模型选择（sherpa-onnx 官方 `asr-models` release，2026-10-09 核实）：**

| 候选 | 下载体积 | 结论 |
|---|---|---|
| `streaming-zipformer-bilingual-zh-en-2023-02-20` | 487MB（含 fp32） | 较老；体积大 |
| `streaming-paraformer-bilingual-zh-en` | 998MB | 过大 |
| `streaming-zipformer-zh-int8-2025-06-30` | 126MB | 仅中文 |
| `streaming-zipformer-small-ctc-zh-int8-2025-04-01` | 20MB | 体积最小，但只中文、未试 |
| **`x-asr-160ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05`** | **134MB（解压约 170MB）** | **选定**：中英双语、带标点、160ms chunk、int8 encoder |

选定模型为 X-ASR 160ms int8 带标点版（zipformer transducer，来源 Gilgamesh-J/X-ASR 经 sherpa-onnx 导出，`encoder.int8.onnx` 155MB + `decoder.onnx` 11MB + `joiner.int8.onnx` 2.6MB + `tokens.txt`）。同系列还有 480ms/960ms/1920ms chunk 版本：chunk 越大延迟越高、准确度未比较；本轮只试 160ms。

**实测（M 系列 macOS arm64，2 线程 CPU，`scripts/manual/voice-sherpa-bench.js`，真实时间 20ms 步进）：**
- 识别器加载约 1.0s（一次，通话开始时）；Silero 加载约 3ms。
- 样本一 `say -v Tingting "你好，今天天气怎么样"`：final = “你好，今天天气怎么样”，与原文逐字一致；样本二（“嗯，我想问一下明天北京的天气，还有适不适合出门跑步”）final = “嗯，我想问一下明天北京的天气还有适不适合出门跑步”，仅丢一个逗号。两条均为 TTS 合成人声单样本，**不是真人/噪声准确率**。
- 说话结束到 final：VAD 结束静音 350ms + 约 30ms 补尾解码，实测末个人声帧后约 376–388ms 出 final。
- 解码开销：每 20ms 帧的 `writeAudio`（含 160ms chunk 时的解码）均值约 2.6–2.9ms、p95 19–26ms、最大 34–39ms，约占单核 6% 实时；在 main 进程同步执行，偶发 ≤40ms 的主线程占用，此规模下不单独起 utilityProcess，若真机出现桌宠卡顿再迁移。
- 输出每个中文字之间带空格（“你好， 今天”），`normalizeSherpaText` 去掉 CJK 间空格、保留英文词间空格。

**native 模块可行性：**`sherpa-onnx-node@1.13.8` 的 `optionalDependencies` 含 `sherpa-onnx-darwin-arm64`（解压 34MB，含 `sherpa-onnx.node` + `libonnxruntime.dylib` + `libsherpa-onnx-c-api.dylib`，rpath `@loader_path`），另有 darwin-x64、linux-x64/arm64、win-x64/ia32 预编译包。addon 为 N-API（node-addon-api），ABI 稳定、无需 electron-rebuild。已在 Electron 41.10.4 的 `ELECTRON_RUN_AS_NODE` 下用同一份 V8/ABI 完成加载和识别（见上），**尚未在打包后的 .app 内验证**。打包要点：`asarUnpack` 加入 `node_modules/sherpa-onnx-node/**/*` 与 `node_modules/sherpa-onnx-*/**/*`（.node 与 dylib 必须在 asar 外同目录）；npm 只安装当前平台的 optional 包，跨平台/跨架构打包需在各自平台安装或补装对应包，否则该包运行时 `loadSherpa` 抛错并走 whisper 回退；macOS 签名需覆盖 unpacked 的 dylib，已有 `disable-library-validation` entitlement。

**模型文件与下载：**模型放在运行时 userData 的 `voice-models/`（macOS：`~/Library/Application Support/clawd-on-desk/voice-models/`），不进仓库、不进安装包。`npm run download:voice-models`（`scripts/download-voice-models.js`）用 curl 下载 Silero 与 ASR 压缩包，**sha256 校验通过才解压安装**，可重复运行（已就绪则跳过，`--force` 重装，`--dir` 指定目录，经 `https_proxy` 走代理）。设置页语音选项卡在选中 sherpa-onnx 时显示模型是否就绪及下载命令。

**回退行为：**开始通话时若模型缺失，或 native 模块加载抛错，runtime 自动改用 whisper（STT）+ 能量 VAD，并在通话成功开始后弹出明确提示（`sherpa-model-missing` / `sherpa-load-failed`），日志记 `sherpa_fallback`。用户显式选 `local-whisper` 时不探测、不提示。选 sherpa 且开启“本地回退”时，通话中 sherpa 报错会按既有机制用保留的 ≤15s 音频改走 whisper。不静默跨云厂商。

**可选云 provider（非默认，保留原调研）：**`paraformer-realtime-v2` + `cosyvoice-v3-flash`（系统音色 `longanyang`）使用同一 DashScope key；`qwen3-asr-flash-realtime` 是多语种/方言备选；`cosyvoice-v3.5-flash` 无系统音色，需 voice ID。截至 2026-10-09 的官方资料核实如下；“未公布”指本轮未找到可比较的绝对首字/首音频 SLA。

| 候选 | 首字/首包与中文证据 | 单价；月毛价 | key / 隐私与限制 |
|---|---|---|---|
| **sherpa-onnx X-ASR 160ms int8（默认）** | 流式 partial；本机实测见上 | 无调用费；本机 CPU | 无 key；语音不出本机；需先下载约 134MB 模型 |
| Paraformer realtime v2 | 支持流式中文识别；未核到固定首字 ms | 北京 0.00024 元/秒；6.48 元 STT | DashScope key；原始音频上云 |
| Qwen3 ASR flash realtime | WebSocket、多语种/中文方言；托管首字 ms 未核到 | 北京 0.00033 元/秒；8.91 元 STT | DashScope key；原始音频上云 |
| CosyVoice v3-flash | 双向流式、系统音色；未核到固定首包 SLA | 1 元/万字符；9 元 TTS | DashScope key；朗读文本上云 |
| CosyVoice v3.5-flash | 官方定性称降低首包；无可核实固定 ms | 0.8 元/万字符；7.20 元 TTS | 仅北京、无系统音色，须先配置 voice ID |
| OpenAI mini transcribe / mini tts | 支持中文；未核到首字/首包 SLA | STT 约 $0.003/分钟；TTS 按 token | OpenAI key；音频/文本上云 |
| 火山豆包流式 ASR / TTS | 官方双向流式；未核到可比 SLA | 直接 API 单价未可靠核到 | 火山 key；音频/文本上云 |
| whisper:2022 / Kokoro:8880 | 上轮短句 STT 0.783s（批量）；Kokoro 两句首 PCM 1.739s，非基准 | 无调用费 | 无 key；沿用已有服务，STT 回退与默认 TTS |

云计费口径：30 天×每日合计 30 分钟（用户/助手各 15 分钟）；默认云组合 15.48 元/月、Qwen+v3-flash 17.91 元/月。不含 Claude Code 订阅/额度。流式云 STT 持续送静音也可能计费，adapter 采用 VAD 开任务、结束后 finish。官方来源：[百炼模型价格](https://help.aliyun.com/zh/model-studio/model-pricing)、[实时识别](https://help.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide)、[CosyVoice 流式](https://help.aliyun.com/zh/model-studio/realtime-tts-user-guide)、[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)、[asr-models release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models)、[X-ASR](https://github.com/Gilgamesh-J/X-ASR)、[Kokoro 模型卡](https://huggingface.co/hexgrad/Kokoro-82M)。

```text
持续麦克风 → AEC / VAD / PCM ──→ 选定 STT（partial → final）
                                    ↓ final + 本地判停
常驻 Claude Code（text delta） → 短句队列 → 选定 TTS（PCM） → Web Audio
speech-start ── epoch++ / 本地停播 / cancel / 重建已听历史 ─────────┘
```

provider 分离为 STT、brain、TTS 三个注入接口，不用一个 voiceProvider 混淆鉴权。STT: begin/writeAudio/finish/cancel、partial/final/error；TTS: begin/writeText/finish/cancel、audioChunk/error/end；brain: send/textDelta/completed/cancel/error。每项声明 streaming/endpointing/audioFormat/cancel 能力与固定 endpoint；消息携带 epoch/request ID，不支持的能力明确降级。具体源码按职责拆进已有 src/、test/ 邻居：默认实现 sherpa-onnx（`voice-stt-sherpa.js`，native 包装在 `voice-sherpa-native.js`，模型路径/就绪检查在 `voice-models.js`）、Claude CLI、whisper/Kokoro，另保留已写的百炼 adapter；其他供应商保留接口和后续任务，不为全部候选先造空 adapter。sherpa STT 的 `engine`（createStream/accept/ready/decode/text/finish）与 VAD 的 `detector`（accept/reset）为注入点，单测全用 fake。

大脑只接 final，先积累约 8–20 字、标点短句（逗号也可作为首段边界），稳定文本才交给 TTS；250ms 积累定时器仅在合理边界切，不拆数字/英文词。后续按句续送，以 provider 的真实 format/sampleRate/channels 播放；PCM 半样本拼接、重采样沿用原约束。最多预取 2 句/2s 音频；流式文本另设总回复 2,000 字上限，无法对厂商真正背压时 cancel 并按已听历史重建，不能把无限服务端队列称为有界。鉴权/费用错误不自动换厂商；仅用户事先启用的本地 fallback 可自动切换，先 cancel 旧请求、epoch++，当轮 STT 用保留的≤15s 音频重转、TTS 用未播完整短句重合成，UI 明示回退。

| 用户说完至首声阶段 | 热链路工程估算（非官方、非实测） |
|---|---|
| VAD 尾静音 | 0.25–0.50s，初值 0.35s；Silero 判定每帧 <1ms，短停顿抢话需验收 |
| 流式 ASR 尾段 final | 本地 sherpa 实测补尾解码约 0.03s（云 STT 为 0.10–0.30s）；说话期间已增量解码 |
| Claude 首 token | 0.40–1.20s，常驻、无工具、短上下文；没有官方 SLA |
| 首可朗读短句积累 | 0.20–0.50s，不能用首 token 代替首句 |
| TTS 首可播放 PCM | 0.15–0.40s，热连接假设；不是 HTTP 头部首字节 |
| 播放缓冲/排程 | 0.04–0.10s |
| 合计 | **1.14–3.00s，规划约 1.2–3.0s**；重建/冷启动额外约 0.5–3s 或更久，规划 2–6s+ |

离线 whisper/Kokoro 配 Claude 热进程约 2–6.7s（判停 0.4–0.8 + STT 0.3–1.5 + Claude 首句 0.6–1.7 + TTS 0.5–2.6 + 播放 0.04–0.1），也未端到端实测。热链路验收目标 P50≤2s、P95≤3s，不承诺豆包同等速度；Claude/网络可能成为主瓶颈。每种组合至少 40 轮中文，按真实用户结束到首个输出非静音样本记录 P50/P95；冷启动与打断重建单列。初始超时：STT final 3s（离线15s）、Claude 首句30s、TTS首PCM10s；失败可见且资源释放，参数据实测再调。

### 5. Claude Code 大脑：常驻 CLI、纯聊天与历史一致性

用户已决定 Claude Code、接受占用其额度，本方案不再比较换脑。**首选常驻 CLI**：Node child_process.spawn 参数数组（不经 shell）打开 stdin，不在每轮 EOF，按轮写 user JSONL；只消费主会话 text_delta，忽略 thinking/tool/log，completed 不重复播读已流过文字。

```bash
claude -p --input-format stream-json --output-format stream-json \
  --verbose --include-partial-messages --tools "" \
  --disallowedTools "*" --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  --safe-mode --settings '{"disableAllHooks":true}' --no-session-persistence \
  --system-prompt '你是桌宠语音聊天伙伴。用自然中文口语和短句回答，通常一到三句。先直接回应，再补必要信息。不用 Markdown、列表、代码块或朗读格式符号。遇到电脑操作请求，说明当前只聊天，不执行工具。你只知道实际已播完的对话；被打断的后半句不要当作用户已听见。'
```

这是实现时使用的参数模板，本轮未执行。官方确认 input/output stream-json、partial、tools 空集、resume 与 no-session-persistence；`--tools ""` 只关闭内置工具，MCP 另以 wildcard deny + strict empty config 关闭。safe-mode 保留认证、跳过自定义配置；managed policy 仍可能生效，因此启动前只读检查 managed hooks/policy，存在不可禁用 hook 或无法核对时不得启动；启动后必须校验初始化 tools 为空、无 MCP，无法保证则 fail closed。不使用 `--bare`：官方 headless 文档明确其不复用订阅登录。不得把 `--allowedTools` / SDK `allowedTools: []` 当作工具白名单；不使用 bypassPermissions/unattended。

认证复用本机正常 Claude Code 登录，由 CLI 自身读取，不复制 OAuth token，不写 API key、不改 ~/.claude。启动前只读版本/能力与 auth status（实现阶段），仅接受用户期望的 claude.ai 订阅认证；发现环境 API key/第三方 endpoint 时提示明确配置冲突，不静默产生 API 账单、不打印密钥。GUI 环境 PATH 找不到 CLI 时允许用户配置可执行文件路径。所用新参数在当前官方文档存在，未验证本机版本；缺参数/流式/禁用能力则报不支持，不偷偷换参数或大脑。

| 接入 | 事实 / 取消与延续 | 性能与选择 |
|---|---|---|
| CLI 常驻 stdin/stdout | 官方支持 JSONL + partial；官方 headless 说明 SIGINT 结束当前 turn、SIGTERM 结束进程；支持能力探测后的 control interrupt，未知协议不自己猜 | 无新 SDK 依赖、可复用本机登录，MVP 默认；正常轮次不重启。首 token 0.4–1.2s 是规划，无实测 |
| TypeScript Agent SDK `@anthropic-ai/claude-agent-sdk` | `query({prompt: asyncIterable, options:{includePartialMessages:true, tools:[], disallowedTools:["*"], persistSession:false}})`；streaming input 的 `query.interrupt()` 取消当前轮，abortController 用于终止整 query；resume 指定会话 ID | 同样 Claude Code 引擎，官方没给更快的首 token 比较，不宣称 SDK 更快。需新增依赖；quickstart 要求 API 鉴权且未获批准的第三方产品不得提供 claude.ai 登录/额度，因此不作为本次“已有登录、无 API key”默认；不是劝换脑 |

官方资料：[CLI 参数](https://code.claude.com/docs/en/cli-reference)、[headless：partial/SIGINT/bare](https://code.claude.com/docs/en/headless)、[hooks 禁用及 managed 限制](https://code.claude.com/docs/en/hooks#disable-or-remove-hooks)、[SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)、[TS SDK 参数及 interrupt](https://code.claude.com/docs/en/agent-sdk/typescript)、[sessions/resume](https://code.claude.com/docs/en/agent-sdk/sessions)、[SDK 认证边界](https://code.claude.com/docs/en/agent-sdk/quickstart)。SDK TS 大页面的静态 .md 本轮已读，不因网页过大错误而凭记忆填参数。

**中断与会话规则：**一次只允许一个在途 user turn，不提前入队下一条 final。speech-start 先 epoch++ 与本地停声，随后 cancel STT/TTS，并发 Claude interrupt；支持 control receipt 时检查仍排队的自有 UUID，清掉应用队列。macOS/Linux 可用官方 SIGINT；Windows 不假定 POSIX signal 等价，先验证控制协议，否则终止本次子进程并重建。0.5s 内未收到中断确认则结束自有进程，仍不得影响其他 Claude 会话。所有旧进程/epoch frame 永久失效。

**严格已听历史：**音频播放完成与大脑生成完成是不同事实。内存 journal 保留用户 final 与已完整播完短句，句中被打断只记 interrupted/partiallyPlayed，无逐词对齐时不声称精确字符。Claude 常驻上下文可能已有整段未播文本，interrupt 和 resume 都不会修剪它；因此每次打断、静音导致未播回复或长度上限取消后，终止旧会话，启动新的 no-session-persistence 会话，只在首条 user 消息内附应用序列化的已听历史和新输入（角色边界结构化/转义，作为数据而非新 system 指令）。不编辑 Claude 内部 JSONL，不用提示词“忘掉后半句”冒充删除。正常播完轮次直接沿用常驻会话；未播放结束前不提交下一条用户 final，插话则进入重建路径，避免脑上下文早于已听 journal。已听 journal 总文本上限 8,000 字，超限只保留最近完整轮次并显式提示上下文已缩短。

resume 已核实存在，但 **MVP 默认不落盘，故不使用 resume/continue**；特别不能恢复含未播放内容的旧会话，也不选 cwd 最新 coding 会话。将来用户显式选择持久化时只能按自己的 session ID resume，且先解决已听历史一致性，不能默认写入 ~/.claude 历史。常驻避免正常轮次冷启动；严格中断重建牺牲一点下一轮首声，预算单列，不能承诺所有插话仍热启动。

### 6. 状态、主题、入口与开关

增加显示状态 listening=3.5、speaking=3.5；二者互斥，语音等待复用 thinking，语音 overlay 提示优先级 2.5。保留 working=3、carrying/juggling=4、attention=5、sweeping=6、notification=7、error=8；permission lock 永远压过语音。没有启动语音时，显示逻辑完全沿用当前状态。

语音状态作为 runtime overlay 参与既有显示选择，不写 sessions Map、不产生 HUD 假会话、不覆盖 coding activity。高优先级 coding 动画暂时覆盖语音时，保留小型通话/麦克风状态指示，避免误以为麦克风关闭。结束时移除 overlay，恢复当下的 live session 显示；不能回放开始通话时缓存的旧状态。

Clawd 初版 listening → `clawd-idle-follow.svg`，speaking → `clawd-headphones-groove.svg`，thinking → `clawd-working-thinking.svg`；后续主题可提供独立动画。Calico/Cloudling/用户主题缺能力时分别 fallback idle/working/thinking。音量律动可以按包络驱动，不承诺精确口型，也不新增必需主题状态。

设置 `voiceEnabled=false`、`voiceBrain=claude-code`、`voiceStt=sherpa-onnx`、`voiceTts=local-kokoro`；仅启用设置不开始采集，重启也不自动通话。启用且凭据、云隐私确认及 Claude 能力检查通过后，**Alt+单击桌宠**（非拖拽，miniTransitioning 时不启动）或菜单 Start/End、用户配置的快捷键切换通话。Alt+单击是本提案的手势选择，避免抢走现有普通点击反应/HUD 手势；菜单与快捷键始终可结束。快捷键默认未绑定。

通话提供清晰“麦克风正在开启/正在听/等待/说话/静音/错误”反馈。关闭 voiceEnabled、退出、睡眠、DND、隐藏宠物或 renderer 销毁时立即停播、cancel、停止 tracks、释放 PCM 并移除 overlay；结束操作必须幂等。隐藏宠物触发语音结束不改变现有“隐藏期间新权限仍弹出”的语义。voice mute 只静音语音输出，显示麦克风状态，明确结束才关闭录音。

### 7. 隐私、权限和 macOS 打包

Claude 只接转写文本与已听对话上下文；默认 sherpa-onnx STT 与 Silero VAD 全在本机处理，麦克风音频不出本机；仅用户显式选云 provider 时，云 STT 接麦克风音频、云 TTS 接待播文本（含未播文字也可能已发送），开始前明示地域/厂商并确认。无摄像头或自动 coding session 全量内容上传。离线语音模式只走 loopback，但不把联网 Claude 称为完全离线。key 仅主进程内存/用户外部环境提供，偏好只记 provider/地域/voice ID；不自行把 secret 存 prefs 或新增系统凭据依赖。原始音频默认仅存内存，15s 片段有上限，结束/错误/取消后释放；不把转写、token、音频内容写日志，计时日志只含时长/epoch/错误码。调试录音另行用户主动授权，不纳入默认路径。

现有 whisper 进程监听 `0.0.0.0:2022`，本功能只连 loopback 不代表已有服务拒绝局域网访问。该部署边界需由用户维护者确认；本轮不修改其绑定或防火墙，不宣称整个机器的服务已网络隔离。

macOS 首次用户开始时才 `systemPreferences.askForMediaAccess('microphone')`，拒绝时结束通话并显示系统设置入口；不循环弹权限。新增 `NSMicrophoneUsageDescription`，签名/hardened runtime 需要 `com.apple.security.device.audio-input`，按 electron-builder 当前继承配置验证主程序及 Helper。[Electron 权限文档](https://www.electronjs.org/docs/latest/api/system-preferences#systempreferencesaskformediaaccessmediatype-macos)、[打包 entitlement 说明](https://www.electronjs.org/docs/latest/tutorial/mac-app-store-submission-guide)。

Electron permission check/request handler 仅允许已登记可信 voice renderer 在显式通话期间请求 audio media；拒绝 camera 与其他窗口/导航来源。先检查 `getSupportedConstraints()` 与 track.getSettings() 的 AEC 实际状态，不能把请求 true 等同于有效消回声。[MDN 约束说明](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints/echoCancellation)。外放验证 AEC 未通过时明确提示耳机或结束通话，不静默切成半双工。当前打包产物与真实麦克风权限尚未验证。

### 8. 测试策略与手动验收

单元测试使用 Node runner，依赖注入 fake 时间、HTTP、provider 和音频 sink；测试路径镜像新模块。先红后绿：speech-start 打断、epoch 隔离、在播放期间保留 track、分句/标点/半样本拼接、背压、provider JSONL/错误与 cancel、默认关闭与权限拒绝、幂等结束及高优先级状态恢复。集成 fixture 用合成音频/文本，不调用付费大脑作为单元测试。

手动验收步骤：

1. 新配置启动，确认没有麦克风权限请求或采集；启用后仍不自动开始。拒绝权限一次，确认没有循环请求。
2. 选定 provider，菜单/Alt+单击/快捷键分别开始和结束；拖拽与普通点击/HUD 保留，mini 过渡不误启用；重启不自动恢复通话。
3. 连说 10 轮中文，观察 listening → thinking → speaking，暂停约 0.35s 可提交，短思考停顿不频繁抢话；确认云 STT final 单次提交、同音字误识别可纠正，并单测 whisper 回退。
4. 耳机和外放分别完成 ≥40 次插话，按双声道方法量 P95，旧句停止且不复活，新句 pre-roll 完整；无人说话外放 60s，记录自打断；旁人/键盘噪声各 20 次记录误触发，作为 VAD 模型升级证据。
5. 播放时注入延迟 TTS/大脑结果，再打断，确认旧 epoch 不更新状态/播放；连续快速插话不遗留 CLI 子进程、请求或内存队列。
6. 手动模拟服务不可达/HTTP 错误/空转写/超时，确认错误可见、仅按已启用策略本地回退，不静默跨云厂商，应用不拉起或停掉系统服务。
7. coding session working/permission/DND/sleep/隐藏、主题缺 listening/speaking、跨屏/mini 切换下验收；权限审批优先、结束恢复实时状态、不产生 HUD 假会话、不改窗口定位保护。
8. 使用签名 macOS 包验证授权与 entitlement；Windows/Linux 的设备拔插、音频输出和权限也列入发布验收。检查网络：只有选定云语音 TLS/WSS、Claude 文本请求及已启用 loopback 回退；结束后无 tracks。

### 9. Claude Code 会话语音模式（`session` brain）

用户在任意 Claude Code 会话输入全局命令 `/clawd-voice`，**该会话本身**成为语音大脑，聊天记录留在会话里；桌宠只做耳朵、嘴、打断和状态动画。保留 `claude-code`（后台 CLI）作为另一选项。

- **runtime**：`brain === "session"` 时不启动 CLI。`src/voice-brain-session.js` 是回放型 brain（`send` 立即把外部文本当作一次 delta+completed），因此分句、TTS、ack、两段式打断、epoch 隔离全部复用。`src/voice-session-bridge.js` 管理唯一的待取 converse、用户 final 待取队列（Claude 思考期间说的话，最多 5 条）、超时与「已播/未播」汇总；`voice-runtime.js` 只在 `submitUtterance`/`interrupt`/`setPhase`/`stop` 处各加一个钩子。
- **converse 语义**：`{text}` 非空先播报，播完后才开始计时（默认 120s，`timeout_s` 限 1–600s，另有 timeout+60s 的兜底防 TTS 卡死），再等用户下一句 final。结果：`{interrupted:false,user}`、`{interrupted:true,played,unplayed_count,user}`（played=按序已完整播完的句子，被打断的那句不算）、`{timeout:true}`、`{ended:true}`（final 去标点后 ≤12 字且含「结束语音/退出语音/关闭语音/挂断」等）、`{superseded:true}`（同一时刻仅一个 converse，新请求顶掉旧请求）、停止通话为 `{ended:true,reason:"stopped"}`。附和词（嗯/对/好）播报中不打断也不返回；非播报期间照常作为用户回答。
- **状态**：converse 等待为 listening，播报为 speaking，converse 返回到下一次 converse 到来之间为 thinking（Claude 在想/在操作电脑）。
- **HTTP**（`src/server-route-voice.js`，挂在 23333 服务）：`POST /voice/session/start|stop`、`POST /voice/converse`。沿用 `/state` 的传输校验（拒绝带 Origin、Host 非 loopback、Content-Type 非 JSON）并额外校验对端地址为 loopback；仅本机 profile，SSH 远程入口不开放；请求体 ≤8KB；客户端断开则放弃该 converse。`session/start` 用进程内 override 强制 `session`，**不写设置**，通话结束即失效；仍受 `voice.enabled` 与就绪检查约束（未启用返回 `voice-disabled`，不会静默开麦）。
- **MCP**：`hooks/clawd-voice-mcp.js`（项目无 `@modelcontextprotocol/sdk` 依赖，手写最小 stdio JSON-RPC，零新依赖）暴露 `voice_start` / `voice_converse(text, timeout_s?)` / `voice_stop`；用显式 `http.Agent` 直连 127.0.0.1，不受 `http_proxy` 影响；桌宠未运行返回清晰工具错误；收到 `notifications/cancelled` 即中止在途请求。
- **日志**：`voice-debug-log` 增加 `session_api_start/stop`、`session_final`、`session_user_queued`、`converse_start/converse_done`（outcome/ms/interrupted/unplayed），不记文本。
- **已知限制**：Claude 必须整段回复写完才能开始播（无流式，首声慢于后台 CLI 模式）；回复总长受既有 2000 字上限；任何本机进程都能在 `voice.enabled` 已开时开麦（与 `/state` 同一信任边界，桌宠显示 listening 状态）。

### 10. 会话实测后的三项调整：Edge TTS、判停合并、暂停收音

**Edge TTS（默认 provider `edge`）**
- 选型：msedge-tts 2.0.9 已处理 `Sec-MS-GEC`，但只提供 mp3/webm（PCM 常量被注释掉），且拖入 axios 等 5 个依赖；edge-tts-universal 1.4.0 体积 1.2MB 且带 axios/https-proxy-agent。两者都得不到 PCM，也都没有给我们的 adapter 合约（begin/writeText/finish/cancel）带来便利，因此用已依赖的 `ws` 自写协议（src/voice-tts-edge.js，约 165 行）：`Sec-MS-GEC` = SHA256(`(unix 秒+11644473600)` 向下取整到 300 秒 ×1e7 的十进制字符串 + TrustedClientToken) 转大写，URL 带 `Sec-MS-GEC-Version=1-<Chromium 版本>`，Origin 用 Edge 扩展 ID。
- 实测（speech.platform.bing.com，本机直连，未用代理）：服务只接受 `audio-24khz-48kbitrate-mono-mp3`；`raw-24khz-16bit-mono-pcm`、`riff-24khz-16bit-mono-pcm`、`raw-16khz-16bit-mono-pcm`、`webm/ogg opus` 都被直接关闭连接且无音频。因此 MP3 帧在主进程用 `mpg123-decoder@1.0.3`（MIT，WASM 内嵌于 JS，无原生依赖，可流式喂块、与整段解码样本数一致）解成 float，取第 1 声道转 s16le，24kHz 单声道交给既有 PCM sink；不改 renderer、不用 decodeAudioData。
- 合约：每个 `begin()` 一个短句、一条连接；`cancel()` 关 socket 并释放解码器，所有迟到帧被 `done` 与 pipeline 的 epoch/session 校验丢弃；连接超时 10s、响应超时 15s；错误码 `tts_edge_network` / `tts_edge_auth`（上传被 401/403 拒绝，常见原因是系统时钟偏差）/ `tts_edge_decode`。voice 名严格匹配 `xx-XX-NameNeural` 后才拼进 SSML，文本做 XML 转义。语速：`ttsSpeed` 1.2 → `rate='+20%'`。
- 代理：Node 的 ws 不读 `https_proxy`。本机直连可通则不引入代理；adapter 预留 `agent` 选项（项目未直接依赖 https-proxy-agent，不新增依赖，需要时再接）。
- 隐私与同意：Edge 属云服务（回复文本发往微软，不上传麦克风音频），`resolveVoiceReadiness` 把 edge 计入 `cloud`，只要求 `cloudConsent`，不要求 DashScope key；设置页云端区与首次同意弹窗都写明微软。
- 回退：edge 失败时无需 `localFallback` 开关，`voice-main` 总是构建 Kokoro 作回退，pipeline 用既有 `fallbackTts` 路径重播未播完的句子并记 `tts_fallback`（from/to/code/unplayed）与通知；回退后本次通话保持 Kokoro（不反复重试 Edge）。
- 默认值：`voice.tts` 默认 `edge`、`edgeVoice` 默认 `zh-CN-XiaoxiaoNeural`；已有用户的显式设置不变，新默认仍受 `cloudConsent` 约束，不会静默上传。

**判停与句子合并**
- Silero/energy VAD 的结束静音默认 350ms → 800ms，范围 250–500 → 400–1500，设置项 `voice.endSilenceMs`（设置页下拉 400…1500）。
- 会话模式额外合并（src/voice-utterance-merge.js）：final 到达后持有 600ms；窗口内出现新的 speech-start 则继续持有，等下一段 final 并入同一句（CJK 直接拼接，拉丁词加空格），可连续合并；噪声段/空 final 触发 `onDiscard` 重新计时；兜底 20s。仅作用于 `session` 脑（CLI 脑不加这 600ms 延迟）。代价：会话模式每句多 ≤600ms 提交延迟，换来短停顿不被切句。

**暂停收音（快捷键）**
- `toggleVoice` 快捷键语义：无通话 → 开始；通话中 → 暂停/恢复收音（`voice-main.shortcutToggle`）。托盘/右键菜单在通话中多一项「暂停/恢复收音（已暂停）」；Alt+点击桌宠、菜单的开始/结束行为不变。
- 静音（runtime.setPaused，快捷键与语音口令共用同一状态，2026-10 改版）：语义是「用户说话不再当输入」，不是关麦。播 end 提示音；不停播、不取消 TTS/CLI 脑、不推进 epoch；converse 的 text 照常合成播放，播完后继续等用户，超时返回 `{timeout:true,paused:true}`。phase 由 runtime 的 `wanted`（管线/桥请求的相位）推导：静音且非 speaking 时显示 `paused`（睡觉，避免卡在 thinking 图），播报时显示 `speaking`。恢复：播 start 提示音、650ms VAD 屏蔽。
- 静音期间麦克风保持开启（橙点常亮）：renderer 只解除 barge-in（忽略 voice:vad/partial，reset 压低），采集链路和 track 不动，所以主进程全零检测与自愈照常；主进程继续跑 VAD+STT，但 `sttFor()` 只返回本地 STT（sherpa/whisper，云 STT 一律不用），识别结果只做唤醒词匹配（`voice-commands.isResumeCommand`），不发 partial/caption、不产生 user。
- 语音口令（src/voice-commands.js，runtime 本地处理）：final 文本去标点及「请/先/吧/一下」等语气词后等于「静音」才静音（长句不触发）；静音期间 final 含「恢复语音」才恢复；播报回声（echoing）不触发；partial 里的口令不转发给 barge-in；日志只记 `voice_cmd_mute`/`voice_cmd_resume`。
- 通话中跟随系统默认输入（voice-mic-device `createMicFollow`）：renderer 监听 `devicechange`，1s 防抖后重新上报设备列表；未指定设备且未暂停时，`default` 设备 label 与当前 track label（去 Default - 前缀）不一致则 `queueRestart({reason:"follow"})`，记 `r:mic_follow_default`；本通话失声设备不回跳。
- CLI 脑模式同样适用同一暂停语义。

### 11. AirPods 按柄静音：由随包 helper 自己录音（`voice.airpodsMuteCapture`，默认开）

**为什么改**：实测按柄事件只发给真正在录音的进程；Electron 里录音的是 Chromium audio service 子进程，决定 10 里「helper 只注册回调、不录音」的版本收不到任何事件（系统弹「无法用 AirPods 控制麦克风」）。原型证明同一进程既录音又注册 `setInputMuteStateChangeHandler` 才收得到。所以开关打开时，由 helper 用 AVAudioEngine 采集并注册回调，renderer 不再 `getUserMedia`。

**采集来源选择**（`src/voice-capture-source.js`，runtime 持有）：helper 需要同时满足 开关开、darwin、macOS ≥14（Darwin ≥23）、二进制存在、主进程有 Silero VAD（helper 只产出原始 PCM；非 sherpa STT 的 renderer-VAD 路径仍用 renderer 录音）。否则 `renderer`，完全走旧路径、不 spawn。来源写进 `voice:start.capture` 并记日志 `capture_source`。通话中改开关或 helper 放弃：`runtime.refreshCapture()` / `captureFailed()` 重新选择并发 `voice:capture`，renderer `handleCapture` 释放或重开 getUserMedia，通话不中断。

**helper 协议**（`native/airpods-mute/clawd-mute-helper.swift`，`src/voice-capture-helper.js`，`src/voice-frame-protocol.js`）：
- 音频走 stdout 二进制帧 `[0xCA 0xFE][uint16 LE 长度][payload]`，payload 为 16kHz 单声道 s16le、20ms=640 字节；解析器处理拆包/粘包，魔数不对视为协议错误并按崩溃重启。
- 控制走 stderr JSON 行（`ready`、`capture{device,voiceProcessing,vpError,rate,channels,startMs}`、`mute`、`error`），与二进制分离，按行解析不会被污染；非 JSON 行（运行库警告）忽略。主进程 → helper 走 stdin：`{"set":b}` 同步系统静音、`{"device":label}` 切输入。
- 采集：`setVoiceProcessingEnabled(true)` 做回声消除（失败则不带它重建一次，`vpError` 带回，日志 `helper_capture_started.voiceProcessing=false`）；其他应用的「压低音量」调到最小，避免压低桌宠自己的播报；取第 0 声道，AVAudioConverter 重采样到 16k s16le。
- 设备：设置里指定了麦克风时按 label 规范化匹配（去 `Default - ` 前缀和括号后缀，相等或包含），匹配不上用系统默认；监听系统默认输入与设备列表变化，目标设备变了去抖 400ms 重建；`AVAudioEngineConfigurationChange` 也重建。

**静音语义不变**：helper 回调返回 true 但不把音频置零，PCM 继续送主进程（本地 STT 听「恢复语音」，不产生 user）。三种静音（快捷键、口令、按柄）共用 runtime 的 `paused`；按柄经 helper 上报 `mute`，桌宠进入/退出 paused；paused 变化写 `{set}` 同步系统状态，防回环沿用（helper 只在状态真变时上报，主进程只在与 paused 不同时处理，ready 之前的 `mute` 一律忽略）。

**自愈**：helper 退出、协议错误、或主进程全零检测（沿用 mic-watch，对 helper 来源改为请求 helper 重启）共用「同一通话最多 3 次重启」预算；超出后日志 `capture_fallback_renderer`，本次通话回退 renderer 录音（下次通话重新尝试 helper）。mic-watch 对 helper 来源放宽到第 4 次请求，让 helper 模块有机会判定超限并回退。

**取舍与未测**：helper 录音比 Chromium 自带 AEC 多一层系统回声消除（VPIO），外放回声效果、VPIO 首次启动延迟（本机实测 3–8s，正式通话占着 AirPods 时测得，安静环境未测）需要真机验收；renderer 在 helper 模式下不枚举设备，设置页麦克风列表依赖缓存。

## Risks / Trade-offs

- [AEC 对同窗 Web Audio 播放效果不稳定] → 外放双讲实测，确认 capture/render 参考；未通过不能声称达到实时通话验收，提示耳机并评估本地 VAD/AEC 方案。
- [small 中文误识别、噪声 VAD 抢话] → 显式 zh、静音迟滞、pre-roll 与真实中文用例；同音字误识别已实测，后续模型升级需单独选择。
- [级联/CLI 首声慢] → 句级 TTS 流水线、限制上下文、展示等待状态；本地音频服务可复用不代表整链路达到豆包时延。
- [中断只取消接收，不取消后端算力] → epoch、停止本地 sink、有界队列及自有子进程回收；不声称能撤销工具副作用。
- [provider CLI 接口/计费变动] → 适配能力探针、pin 支持版本、不把日志当文本 delta，启动前复核认证类型，额度耗尽按错误处理，不静默切换厂商。
- [现有服务 LAN 可达] → loopback-only 客户端与部署说明；服务自身访问控制由维护者确认，本提案不改服务。

## Migration Plan

大脑已拍板、默认语音组合本轮已选，按 tasks 红→绿实现；仅在实际开通云通话前需要配置 key 与隐私确认。其余两项暂按推荐 MVP 执行，不阻塞本轮文档。prefs 使用新增默认值，无历史数据迁移；主题能力可选。仅在用户启用时激活 runtime，主流程默认不受影响。首轮先用耳机验证默认云链路与本机回退，再做外放/签名包/多平台验收；通过前不宣称生产级全双工。

回退时关闭 voiceEnabled，立即结束并释放 tracks/请求/overlay；回滚版本可忽略新增偏好键。保留原有 hook、审批、HUD 和普通点击。OpenSpec 本轮只生成文档，不 apply、不 archive、不 commit，不启动任何服务。

## Open Questions

1. **云语音凭据与地域是否确认？** 仅当用户选云 provider 时需要：北京 DashScope key（不提交/不写全局配置），首次明确同意云 STT 上传音频、云 TTS 上传文本；如不接受则手动选离线语音。v3.5-flash voice ID 仅升级时需要，不额外阻塞默认。
2. **是否允许操作电脑？** 用户未表态，MVP 按仅聊天/工具全关执行；升级操作需另批工具、目录、审批规格。
3. **视觉反馈级别？** 用户未表态，按 listening/speaking + 音量律动、无摄像头执行；精确口型/视频理解另提范围与隐私。
