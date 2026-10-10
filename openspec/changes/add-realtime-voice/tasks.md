## 1. 实现前 checkpoint（本轮仅文档，以下保持未勾选）

- [x] 1.1 核对本机 CLI 版本/参数与订阅 auth；不调用收费模型。验收：必需 stream-json/partial、禁用工具/MCP/hooks/no-persistence 可验证，认证不指向 API 账单；不符合则列清阻塞，不改全局配置。
- [x] 1.2 配置北京 DashScope key 与云音频/文本告知；保留仅聊天、音量律动无摄像头两项待用户确认，暂按推荐实施。验收：无 key/未确认不采集，key 不入 prefs/renderer/日志；v3.5 无 voice ID 不可选。
- [ ] 1.3 经后续用户授权后测默认云/本地回退格式与冷热性能、计费时长；核对可用 WebSocket transport，已有依赖优先。验收：输出模型、地域、采样率、首 PCM 和账单口径；不拿免费额度当永久成本，本轮不得执行。

## 2. 偏好、provider 合约与 IPC（每项先红→绿→重构）

- [x] 2.1 红：默认关闭、Claude/Paraformer/v3-flash 默认值、缺 key/确认不采集、幂等结束测试；绿：沿 settings-controller/store/actions 接入。验收：启用偏好/重启不录音，凭据不写偏好；源码≤约300行。
- [x] 2.2 红：在 test/voice-runtime.test.js 覆盖 epoch/request 隔离、取消、2句/2s 背压、2,000字回复和8,000字 journal 上限；绿：实现注入式 runtime。验收：迟到文本/PCM/错误不能复活，内存上限稳定，超限只丢完整旧轮且可见。
- [x] 2.3 红：sender、音频大小/类型、可信窗口、camera 拒绝测试；绿：现有 preload/main 受限 IPC。验收：renderer 无任意 URL/child_process/key 能力，/state/HUD snapshot 契约不变。

## 3. 持续录音、VAD 与 STT（每项先红→绿→重构）

- [x] 3.1（能量 VAD，现为模型缺失回退；默认已由 8.2 的 Silero 取代）红：test/voice-vad.test.js 的pre-roll、speech-start、350ms判停/短暂停、噪声、15s上限与重采样；绿：AudioWorklet/VAD。验收：250–500ms可调，播放时输入track活跃，停播不 suspend 采集 context。
- [x] 3.2（云 STT，现为可选 provider，不再是默认）红：fake WebSocket 的Paraformer建任务/PCM/partial/final/finish、重复final、空文本、断连/超时、静音不保持计费任务测试；绿：默认云STT adapter。验收：说话时上传，判停+final只送脑一次，固定WSS地域/鉴权，epoch安全；对应 test/voice-stt-aliyun.test.js。
- [x] 3.3 红：fake HTTP 的whisper zh multipart WAV、loopback绕过代理/拒绝外网redirect、失败测试；绿：本地adapter及用户启用回退。验收：回退先epoch++、提示并重转≤15s片段，不自动拉服务、不跨云；test路径镜像源码。

## 4. Claude 常驻大脑与历史（每项先红→绿→重构）

- [x] 4.1 红：test/voice-brain-claude.test.js 的spawn参数数组、stdin多轮不EOF、text_delta过滤、completed去重、工具非空/缺参数/认证/额度错误测试；绿：常驻CLI adapter。验收：只消费主会话文本，纯聊天fail closed，无bare/API key/bypass参数，不加载自定义hooks/MCP。
- [x] 4.2 红：speech-start本地停声先于interrupt、控制receipt/排队UUID、SIGINT与0.5s取消超时、Windows不支持路径测试；绿：取消和自有子进程回收。验收：旧epoch无效，其他Claude进程不受影响，正常轮次不冷启动；真实协议仅用官方格式及能力探针。
- [x] 4.3 红：test/voice-history.test.js 的三句只播完一句、句中插话、生成完未播、静音、长度截断场景；绿：播放ACK journal和受污染会话重建。验收：新脑输入不含未播后半/第三句，partiallyPlayed不猜字；不修改Claude内部JSONL，不resume别人的会话，不落盘对话。
- [x] 4.4 红：口语prompt、中文短句/标点/数字/英文词边界、thinking/log不播测试；绿：首短句积累与语音prompt。验收：首token与首句分开计时，不为抢首声拆词或播Markdown代码块。

## 5. TTS、播放与本地打断（每项先红→绿→重构）

- [x] 5.1 红：test/voice-tts-aliyun.test.js 的v3-flash系统音色、writeText/finish、PCM格式、voice ID/地域错误、断连cancel测试；绿：双流式TTS。验收：完整合成前播放，v3.5无voice ID不可用，按供应商采样率处理。
- [x] 5.2 红：test/voice-audio-renderer.test.js 的半样本、顺序、重采样、播放ACK、已排程stop、20ms淡出和2句/2s背压；绿：AudioWorklet/PCM sink。验收：speech-start无需ASR或网络便停声，静音不生成已听ACK。
- [x] 5.3 红：fake HTTP 的Kokoro stream:true/zf_xiaobei、取消和已启用回退测试；绿：本地TTS adapter。验收：失败只重合成未播完整句，旧音频无重播，错误显示，服务不自动管理。

- [x] 5.4 红：test/voice-barge-in.test.js 的两段式打断：speech-start ≤100ms 降音不递增 epoch；partial 实义文本或连续人声≥300ms 才正式打断；附和词（嗯/对/好/是/哦）、咳嗽、<300ms 杂音 600ms 内恢复音量且不丢句；离线无 partial 仍可凭时长打断。绿：barge-in 控制器。验收：确认后静音 P95<80ms，附和不打断。

## 6. 桌宠兼容和生命周期（每项先红→绿→重构）

- [x] 6.1 红：listening/speaking overlay、thinking、permission/error优先、HUD无假会话和结束恢复当前状态；绿：接state显示链路。验收：coding/权限不受语音取代。
- [x] 6.2 红：旧主题fallback、音量包络与主题切换；绿：可选状态映射。验收：Clawd/Calico/Cloudling/用户主题不新增必需资源，音量律动可见，不开摄像头。
- [x] 6.3 红：Alt+非拖拽点击/菜单/快捷键同toggle、miniTransitioning开始拒绝、普通点击/HUD保留；绿：接已有输入链路。验收：快捷键默认未绑定，所有入口能结束。
- [x] 6.4 红：退出/DND/隐藏/睡眠/renderer销毁/故障释放；绿：生命周期接线。验收：无track/请求/自有子进程/journal残留，隐藏期间权限原语义保留。
- [x] 6.5 红：设置校验和7种语言键覆盖；绿：cloud/local/provider/key配置提示及状态文案。验收：首次上传确认明确，离线语音仍说明Claude联网，secret不泄露。

## 7. 权限、性能与发布 checkpoint

- [x] 7.1 红：首次麦克风授权/拒绝不循环/仅audio可信窗口；绿：macOS用途说明和audio-input entitlement。验收：签名主程序/Helper可授权，camera拒绝。
- [ ] 7.2 执行每种设备≥40次双声道声学对齐插话。验收：声学起始→静音P95<300ms，speech-start→静音P95<80ms；记录P50/P95/最大、误打断/漏打断，外放60s自打断与噪声20次结果。
- [ ] 7.3 每种provider组合≥40轮中文，冷/热/打断重建/离线回退分组。验收：默认热首声P50≤2s、P95≤3s；测端点/final/首token/首短句/首PCM/首非静音，未达标记录瓶颈，不宣称豆包等速。
- [x] 7.4 网络和隐私检查。验收：只连接选定云语音与Claude及已启用loopback；无内容/secret日志或CLI transcript；静音/失败的已生成未播放合成费用与持续静音计费纳入成本报告。
- [ ] 7.5 跑模块测试及npm test（并发≤2），签名macOS与Windows/Linux设备/权限/取消手动QA。验收：列出未覆盖平台，CLI/transport不支持须明确禁用，不假定Windows SIGINT有效。
- [ ] 7.6 更新已有用户指南并呈交验收；可选后续适配Qwen ASR/v3.5 voice ID、OpenAI、火山、FunASR，逐个先red fixture再green adapter，不预建空文件。验收：每家声明真实能力、价格/隐私/取消；commit、push、部署、archive等待明确指令。

## 8. 本地流式方案：Silero VAD + sherpa-onnx（默认 provider，每项先红→绿）

- [x] 8.1 红：test/voice-models.test.js、test/download-voice-models.test.js 的 userData 路径、就绪检查、sha256 校验失败不安装、重复运行幂等、损坏文件重下；绿：src/voice-models.js、scripts/download-voice-models.js、`npm run download:voice-models`。验收：模型进 userData `voice-models/` 不进仓库；实机下载 Silero 与 X-ASR 160ms int8 成功。
- [x] 8.2 红：test/voice-vad-silero.test.js 用 fake 探测器测起始确认、pre-roll、350ms 判停（250–500 可调）、噪声、15s 上限、任意块大小；绿：src/voice-vad-silero.js。验收：Silero 每 20ms 帧实测 <1ms。
- [x] 8.3 红：test/voice-stt-sherpa.test.js 用 fake engine 测 partial 去重、final 单次、取消后静默、会话隔离、引擎异常、超长截断、日志无文本；绿：src/voice-stt-sherpa.js、src/voice-sherpa-native.js。验收：真实模型 smoke（test/voice-sherpa-native.test.js，模型就绪时运行）通过。
- [x] 8.4 红：test/voice-runtime-sherpa.test.js 测 main VAD 驱动 STT、vad 事件回送、partial 回 renderer、重复 final 只提交一次、noise 取消、stop 后迟到结果隔离；test/voice-renderer.test.js 的 vad:main 模式（降音、连续人声提交、附和 partial 只降音、短促后恢复）；绿：voice-runtime / voice-renderer / voice-ipc / preload 的 `voice:vad`。验收：旧 renderer-VAD 路径测试全部保持通过。
- [x] 8.5 红：test/voice-main.test.js 测模型缺失与 native 加载失败回退 whisper 并提示、显式选 whisper 不提示、sherpa+本地回退保留 whisper、设置页就绪查询；test/voice-settings.test.js 默认 sherpa-onnx；绿：voice-main factories、settings-tab-voice 模型状态行、7 语言文案。验收：npm test 0 fail。
- [x] 8.6 红：test/voice-sherpa-packaging.test.js；绿：package.json 依赖、`asarUnpack`、下载脚本入口。验收：模型不进 files/extraResources。
- [x] 8.7 所有新事件接入 voice-debug-log（vad_start/vad_end/vad_perf/stt_partial_first/sherpa_first_partial/sherpa_final/sherpa_loaded/sherpa_fallback），只记事件与耗时；test/voice-debug-log.test.js 覆盖。
- [ ] 8.8 打包后 .app 内验证：asarUnpack 的 .node/dylib 在签名包中可加载，`audit:native-package` 对 sherpa 的 Mach-O 无告警；Windows/Linux 的 optional 包与跨架构（darwin-x64）补装。验收：各平台 `loadSherpa` 成功或明确走 whisper 回退。
- [ ] 8.9 用真人录音（耳机/外放，含键盘与旁人噪声）测 Silero 误触发率、partial 首字延迟和中文准确率（当前仅 TTS 单样本），并与 whisper small 对比；评估 480ms 版本与 CTC 小模型的准确率/延迟权衡。

## 9. Claude Code 会话语音模式 `/clawd-voice`（每项先红→绿）

- [x] 9.1 红：test/voice-brain-session.test.js、test/voice-session-bridge.test.js（正常一轮、打断 played/unplayed、超时仅播完后计时、superseded、ended、队列、abort、日志无文本）；绿：src/voice-brain-session.js、src/voice-session-bridge.js。
- [x] 9.2 红：test/voice-runtime-session.test.js（不碰 CLI brain、附和不打断、barge 后返回 played、stop 返回 ended、非 session 模式报错）、test/voice-history.test.js heardSentences；绿：voice-runtime 钩子、voice-history.heardSentences、voice-settings 增加 `session`。
- [x] 9.3 红：test/voice-main.test.js（session/start 进程内 override 不写设置、从 claude-code 切换、voice-disabled 不留 override、converse 需 session 通话）；绿：voice-main sessionStart/sessionStop/converse。
- [x] 9.4 红：test/server-route-voice.test.js（三路由、非 loopback 403、Origin/Host/Content-Type 复用 /state 校验、坏 JSON/超长、断连中止、server.js 分发）；绿：src/server-route-voice.js、server.js/main.js 接线。
- [x] 9.5 红：test/clawd-voice-mcp.test.js（initialize/tools/list/tools/call 往返、桌宠未运行、404/409、cancelled、stdio 端到端且忽略代理 env）；绿：hooks/clawd-voice-mcp.js（无新依赖）。
- [x] 9.6 设置页 brain 选项（claude-code / session，7 语言），全局命令 `~/.claude/commands/clawd-voice.md`，`claude mcp add --scope user clawd-voice`。
- [x] 9.7 真机：dev 版重启后 session/start → converse(timeout_s:3) 播报并超时 → stop；MCP stdio 实测。
- [ ] 9.8 真人多轮会话验收（耳机/外放）：插话、思考期间说话、操作电脑后口头汇报；测首声（含 Claude 整段生成）延迟。


## 10. 会话实测后三项调整（每项先红→绿）

- [x] 10.1 Edge TTS：红：test/voice-tts-edge.test.js（Sec-MS-GEC 算法、请求头/SSML/转义、MP3→PCM 顺序、cancel 静默、空文本、401/403/断连/超时、非法音色）、test/voice-settings.test.js（edge 为默认 cloud provider、edgeVoice 校验）；绿：src/voice-tts-edge.js、voice-settings、依赖 mpg123-decoder@1.0.3。验收：真机首包耗时见 .local/handoff/voice-edge.md。
- [x] 10.2 回退：红：test/voice-tts-fallback.test.js（edge 失败→Kokoro 重播并记 tts_fallback、无回退时可见报错、不循环）、test/voice-main.test.js（edge 总是构建 Kokoro 回退）；绿：voice-reply-pipeline 日志、voice-main/voice-runtime 回退条件。
- [x] 10.3 判停：红：test/voice-vad-silero.test.js、test/voice-vad.test.js（默认 800、400–1500 夹取、600ms 停顿不切/900ms 切）、test/voice-main.test.js（endSilenceMs 传给 sherpa VAD）；绿：voice-vad-silero/voice-vad/voice-sherpa-native/voice-main。
- [x] 10.4 合并：红：test/voice-utterance-merge.test.js、test/voice-runtime-merge.test.js（短停顿合并、长停顿切句、说话中保持等待、噪声不吞句、CLI 脑不延迟）；绿：src/voice-utterance-merge.js，runtime 接线；为守 300 行上限拆出 voice-utterances.js、voice-vad-feed.js。
- [x] 10.5 暂停：红：test/voice-runtime-pause.test.js、voice-main.test.js（shortcutToggle/togglePause）、menu-voice.test.js；绿：runtime.setPaused、session-bridge `paused` 提示与丢弃 text、voice-main、menu、main.js 快捷键接线。
- [x] 10.6 设置页与 7 语言文案（Edge 选项/音色/判停时长/云隐私说明/快捷键暂停说明，菜单暂停项），test/settings-tab-voice.test.js。
- [ ] 10.7 真人验收：外放+耳机下听感对比 Edge/Kokoro；多轮会话里短停顿合并是否自然；暂停时听歌/与人交谈场景。

## 11. 外放回声、Edge 预热、暂停关麦与反馈（每项先红→绿）

- [x] 11.1 回声降音：红：test/voice-barge-in.test.js（连续人声 ≥200ms 才 duck、-8dB、<200ms 杂音不 duck、选项可调、300ms 仍 commit）、test/voice-silero-strong.test.js（严格阈值 0.8 的第二路 Silero、frame.strong）、test/voice-renderer-mic.test.js（播报期间弱帧不 duck/不 commit、<200ms 强噪声不 duck）；绿：voice-barge-in、voice-sherpa-native（STRONG_THRESHOLD）、voice-vad-silero/voice-vad-feed、voice-renderer handleVad。
- [x] 11.2 回声文本不算打断：红：test/voice-echo.test.js、test/voice-runtime-echo.test.js（回声 partial 不转发、真人实义文本转发、回声 final 不打断、无播报时照常）；绿：src/voice-echo.js（相邻字对重叠 >60%）、voice-reply-pipeline.recentSpoken、voice-runtime 过滤。
- [x] 11.3 Edge 连接复用：红：test/voice-edge-conn.test.js（预热、同连接多请求按 X-RequestId 路由、60s 空闲关闭、断线重连、陈旧连接重试一次、鉴权/超时）、test/voice-tts-edge.test.js；绿：src/voice-edge-conn.js、voice-tts-edge warm/dispose、runtime 开始预热/结束释放。真机前后首包见 .local/handoff/voice-echo-prewarm.md。
- [x] 11.4 暂停真正关麦：红：test/voice-renderer-mic.test.js（暂停 stop track + 断开 source，恢复重新 getUserMedia 同约束，暂停中结束无残留）、test/voice-runtime-cues.test.js（voice:paused 下发）；绿：voice-renderer handlePaused、preload/boot/ipc。
- [x] 11.5 暂停/恢复反馈：红：test/voice-cue.test.js、test/voice-runtime-cues.test.js（start/end 各自触发点、恢复后 650ms 屏蔽 VAD）、test/voice-main.test.js、test/state-voice-overlay.test.js（三主题 paused 显示 sleeping 美术）、test/voice-renderer-boot.test.js（常驻麦克风角标三态）；绿：assets/sounds/voice-start.wav|voice-end.wav（Cora 音效）、src/voice-cue.js（遵守 soundMuted/soundVolume/DND）、state overlay `paused`、index.html/styles.css 角标。
- [ ] 11.6 真人验收：外放下长时间播报不再自降音；暂停后橙点熄灭、恢复后可再收音；提示音不被当成人声。

## 12. 单会话独占、Edge 保活、字幕、长文摘要（每项先红→绿）

- [x] 12.1 单会话驱动：红：test/voice-session-bridge.test.js（takeOver）、test/voice-main.test.js（新 start 换 owner token、旧 converse 即刻 `{ended:true,reason:"taken_over"}` 且 text 不播、旧 stop 被忽略）、test/server-route-voice.test.js、test/clawd-voice-mcp.test.js（MCP 保存并携带 token，不暴露给模型）；绿：voice-main sessionStart/sessionStop/converse、voice-runtime.takeOver、server-route-voice、hooks/clawd-voice-mcp.js，`~/.claude/commands/clawd-voice.md` 补 taken_over 处理（不再调 voice_stop）。
- [x] 12.2 Edge 保活：红：test/voice-edge-conn.test.js（fake ws：20s ws ping、断线立即后台重连、快速断开/连不上按 1s/2s/4s 退避后放弃、idle 关闭放宽到 10 分钟）；绿：src/voice-edge-conn.js。
- [x] 12.3 字幕气泡：红：test/voice-runtime-captions.test.js、test/voice-renderer-boot.test.js、test/voice-settings.test.js；绿：`voice.captions`（默认开）、`voice:caption`/`voice:state` 通道、src/voice-captions.js、设置页开关与 7 语言文案。文本只在渲染进程显示，不写日志。
- [x] 12.4 桌宠动效：已被 13.1 取代（自制动效全部撤销）。
- [x] 12.5 长文摘要：红：test/voice-summarize.test.js（fake CLI：禁工具/MCP/hooks、stdin 传文、超时/失败回退前两句并记 summarize_fallback、日志无文本）、test/voice-session-bridge.test.js、test/voice-runtime-session.test.js；绿：src/voice-summarize.js、`voice.summarizeOver`（默认 120，0 关闭）、bridge 返回 `played`+`summarized:true`。
- [ ] 12.6 真机：双 owner 接管、listening/speaking/thinking/paused 截图、120s 无 edge_ws_drop 或断后立即重连、400 字摘要耗时（见 .local/handoff/voice-anim.md）。

## 13. 只用自带动画、语音优先级、暂停修复、仅会话开启（每项先红→绿）

- [x] 13.1 撤销自制动效：删 voice-pet-anim.js / voice-pet.css / 测试及 index.html、boot、preload、ipc 的 voice:state 接线；clawd 主题 listening=clawd-headphones-groove.svg、speaking=clawd-working-thinking.svg、等待大脑（新增可选主题状态 voiceThinking，不影响 coding 的 thinking）=clawd-idle-bubble.svg，paused 回退 sleeping；其他主题沿用原回退。测试：test/state-voice-overlay.test.js、test/voice-renderer-boot.test.js。
- [x] 13.2 语音优先级 4.5（高于 working/juggling/carrying，低于 attention/sweeping/permission/error）：test/state-voice-overlay.test.js（coding 进行中仍显示语音状态；error、权限仍压过语音）；绿：src/state-priority.js。
- [x] 13.3 暂停卡 speaking：红：test/voice-runtime-pause.test.js（播报中暂停→paused，之后 converse 超时等 phase 变化不得离开 paused）；绿：voice-runtime setPhase。
- [x] 13.4 字幕与仅会话开启已在 12.x/本节前序落地并有测试（voice-caption-window、voice-main-session-only、menu-voice）。
- [x] 13.5 真机验证（见 .local/handoff/voice-anim.md）。

## 14. 设置页选麦克风、自愈取舍、track 结束即重开（每项先红→绿）

- [x] 14.1 设置页麦克风下拉：红：test/voice-mic-select.test.js（设备匹配 id 命中 / label 回退 / 都不命中回默认并记 `mic_device_fallback`、getUserMedia 用 `deviceId:{exact}` 且 AEC/NS/AGC 不变、voice:start 携带 `micDeviceId`/`micLabel`）、test/settings-tab-voice.test.js（系统默认在首位、同时存 id+label、devicechange 刷新、无 label 提示）；绿：`voice.micDeviceId`/`voice.micLabel`（voice-settings）、src/settings-tab-voice.js、settings-i18n 7 语言、src/voice-mic-device.js `createMicOpener`/`resolvePreferred`。
- [x] 14.2 通话中切换立即生效：红：test/voice-mic-select.test.js（只重建采集链路、ctx 与通话不断、未变化不重复下发）；绿：voice-main.onSettingsChanged -> runtime.selectMic -> `voice:mic-select`（ipc/preload/boot）-> renderer `handleMicSelect`。
- [x] 14.3 自愈取舍：红：同上（label 含 iPhone/Continuity/Oray/ToDesk/BlackHole/Loopback/Virtual/Aggregate 一律跳过；指定设备时自愈只在该设备重开）；绿：voice-mic-device `isSkippable`/`pickAlternate`。
- [x] 14.4 track ended 立即重开：红：test/voice-mic-select.test.js（不推进时钟即重建、每会话 track_ended 触发最多 3 次、主进程全零检测保留作兜底并在 1.5s 内不重复）；绿：voice-renderer `onTrackEnded`/`restartMic`。
- [ ] 14.5 真机验收：见 .local/handoff/voice-mic-select.md。

## 15. 暂停只关麦、通话中跟随系统默认输入（每项先红→绿）

- [x] 15.1 暂停改为「用户说话不再当输入」：红：test/voice-runtime-pause.test.js（暂停不停播/不取消 TTS/不推进 epoch、暂停中 converse 的 text 照常播并在播完后超时返回 `timeout`+`paused`、暂停中说话无打断/无 user/无 partial/无 caption/无 voice:vad、全零帧静音期间照常触发 mic-restart、speaking/paused 相位切换、thinking 时暂停显示 paused 且恢复还原）、test/voice-renderer-mic.test.js（静音不释放 track、帧照常上行、barge-in 解除、静音中 track 死亡仍重建）；绿：voice-runtime `wanted`/`show`、setPaused 不再 interrupt、speak 不再丢弃；voice-session-bridge 去掉丢弃分支；voice-renderer 去掉 setMicPaused。取代 10.5/11.4/13.3 中的「立即停播、丢弃 text、真关麦」。
- [x] 15.1b 语音口令：红：test/voice-runtime-mute-cmd.test.js（「静音」及变体触发、长句不触发、静音中别的话丢弃且无 user、「恢复语音」恢复并保留 650ms 屏蔽、快捷键↔口令互相恢复、播报回声不触发、日志无原文、CLI 脑同样适用）；绿：src/voice-commands.js、voice-runtime submitUtterance、voice-utterances `sttFor`（静音只用本地 STT）。顺带拆出 voice-runtime-providers.js、voice-cue-mask.js 使 voice-runtime.js 不超 300 行。
- [x] 15.2 通话中跟随系统默认输入：红/绿：test/voice-mic-follow.test.js（默认变了切、指定设备不切、暂停不切、1s 防抖、失声设备不回跳、未通话无动作）；src/voice-mic-device.js `createMicFollow`、voice-renderer `handleDeviceChange`、voice-renderer-boot 监听 `devicechange`。
- [ ] 15.3 真机验收：通话中连 AirPods 能跟过去；暂停时 Claude 的播报继续念完且橙点熄灭。

## 16. AirPods 柄静音（随包 Swift 助手，每项先红→绿；helper 不录音的版本，已被第 17 节取代）

- [x] 16.1 主进程模块：红：test/voice-mute-helper.test.js（fake spawn/流：mute/unmute 驱动共用 paused、快捷键/口令改变后写 `{"set":x}`、helper 回报状态不回写不回环、非 darwin/macOS<14/缺二进制不 spawn、通话结束 kill、崩溃同一通话最多重启 1 次、voice-main 接线）；绿：src/voice-mute-helper.js（日志 `airpods_mute`/`mute_helper_spawn`/`mute_helper_exit`）、voice-main `onStateChange` 接线、main.js `muteHelperPath`。
- [x] 16.2 助手与构建：native/airpods-mute/clawd-mute-helper.swift（setInputMuteStateChangeHandler、stdin `{"set"}`、stdin 关闭即退出，不开麦）；scripts/build-mute-helper.js（darwin 才编、`-target <arch>-apple-macos14.0`、arm64+x86_64 lipo、无 swiftc 仅警告）作为 electron-builder `beforePack`；`build.mac.extraResources` -> `Contents/Resources/bin/`；`.gitignore` 加 build/bin/。
- [ ] 16.3 真机：装好后开语音，按 AirPods 柄 3 次，voice-debug.log 应有 `mute_helper_spawn`、`airpods_mute`（source=airpods，mute 依次 true/false/true），静音时听到 end 提示音、取消时 start 提示音（见 .local/handoff/airpods-mute-impl.md）。

## 17. 由 helper 自己录音，按柄才收得到事件（取代 16 的「不开麦」，每项先红→绿）

- [x] 17.1 帧协议：红：test/voice-frame-protocol.test.js（单帧、拆包于头/载荷/逐字节、粘包加残包、魔数错报告并丢弃、空帧跳过）；绿：src/voice-frame-protocol.js。
- [x] 17.2 helper 管理：红：test/voice-capture-helper.test.js（带 `--device` spawn、stdout 帧→PCM、stderr 状态日志 `helper_capture_started`、按柄 mute/unmute 驱动 paused、ready 前的 mute 忽略、防回环、set 同步、崩溃重启 ≤3 次后 `capture_fallback_renderer`、静音重启共用预算、协议错误重启、spawn 抛错立即回退）；绿：src/voice-capture-helper.js（取代 voice-mute-helper.js）。
- [x] 17.3 来源选择：红：test/voice-runtime-capture.test.js（开关开/关选对来源、无主进程 VAD 用 renderer、helper PCM 进 VAD 且忽略 renderer PCM、静音时 PCM 仍进唤醒词识别但不产生 user、全零请求 helper 重启而不是 renderer、第 4 次请求、通话中切换、失败后锁定 renderer 且下次通话重置）；绿：src/voice-capture-source.js、voice-runtime（`refreshCapture`/`captureFailed`/`handleAudio(buf, from)`）。
- [x] 17.4 主进程接线：红：test/voice-main-capture.test.js（开关开/关、macOS13 不 spawn、PCM 进 VAD、按柄静音、静音时 helper 不停、连崩回退并通话不断、全零重启、通话中切开关、通话中换麦按 label 通知 helper）；绿：voice-main 接线、`voice:capture` IPC/preload/boot。
- [x] 17.5 renderer：红：test/voice-renderer-capture.test.js（helper 模式不 getUserMedia 且麦克风被拒也不报错、播放与远程 VAD 打断照常、设备变化不开浏览器麦、`handleCapture` 双向切换、重开被拒报错、同来源空操作）；绿：voice-renderer `openCapture`/`handleCapture`。
- [x] 17.6 设置：红：test/voice-airpods-setting.test.js（默认 true、布尔校验、设置页开关、7 语言文案）；绿：voice-settings、settings-tab-voice、settings-i18n。
- [x] 17.7 Swift helper 与构建：AVAudioEngine + 回声消除 + 重采样 + 设备匹配与跟随；`--list-devices` 调试开关；打包验证见 .local/handoff/airpods-helper-capture.md。
- [ ] 17.8 真机验收：外放回声、收音、打断、三种静音、交叉开关、关闭后回旧路径（清单见 .local/handoff/airpods-helper-capture.md）。
