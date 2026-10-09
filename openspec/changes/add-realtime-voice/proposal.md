## Why

Clawd 目前能感知 coding agent 的活动，但用户不能直接和桌宠持续语音交流。用户已选 Claude Code 为大脑，允许选更快的流式 STT/TTS；改为完全本地、免费的方案：Silero VAD + sherpa-onnx 本地流式中文识别；已有 whisper.cpp 保留为识别回退，Kokoro 为默认 TTS。目标是播报时仍能听见用户、用户插话即停播。

体验对标豆包实时通话的连续倾听、打断和可见反馈；采用可插拔流式 STT + 常驻 Claude Code + 流式 TTS 的级联方案，不承诺复现豆包原生端到端全双工模型的语义判停能力。

## What Changes

- 增加默认关闭的实时语音模式，用户主动通过桌宠点击、菜单或可配置快捷键开始/结束。
- 录音与播报同时运行；开启 echoCancellation，VAD 判断用户开口后立即停止播报，撤销当前轮的 ASR/TTS/大脑请求并丢弃迟到结果。
- 默认本地流式识别：Silero VAD（main 进程，经 sherpa-onnx）+ sherpa-onnx 流式中英 zipformer（X-ASR 160ms int8，约 134MB）；partial 驱动两段式打断确认，final 送 Claude。TTS 默认本机 Kokoro；云 Paraformer / CosyVoice 等为用户显式选择的可选项；whisper 为模型缺失或加载失败时的回退。大脑输出按短句合成、顺序播放，并提供失败、静音和结束反馈。
- 新增可选的 listening / speaking 显示状态；等待大脑时复用 thinking，旧主题使用已有动画降级，不影响 coding session/HUD 或权限审批。
- 大脑固定为本机已登录的 Claude Code：常驻 stream-json 输入/输出、partial text；用户已知并接受订阅额度消耗。MVP 禁用所有工具、MCP 与 hooks，使用语音短句 system prompt。
- 默认本地语音不上传音频：sherpa-onnx / Silero 在进程内、Kokoro 与 whisper 只连 loopback；Claude Code 仍联网接收转写文本。仅当用户选云 STT/TTS 时才上传音频/文本，首次使用明确告知并确认。不得静默跨厂商切换。
- 本轮只交付提案，摄像头、视觉理解、精确音素口型和电脑操作不纳入默认实现范围。

## Capabilities

### New Capabilities

- `realtime-voice`: 默认关闭的连续录音、语音打断、可插拔流式识别与合成、Claude Code 接入、桌宠状态反馈、生命周期和隐私约束。

### Modified Capabilities

无；当前仓库没有既有 `openspec/specs/` 能力文件，语音以独立新能力描述，对现有权限和会话行为增加兼容性约束。

## Impact

- 沿用双窗口、preload IPC、settings store/controller、状态优先级和主题 loader 现有架构；main 只组装依赖，新增模块按职责控制在约 300 行以内。
- 预计接触 state-priority/state、pet-interaction-ipc/hit-renderer/preload、renderer/index.html、menu、shortcut runtime/actions、prefs/settings actions/general/i18n、theme-loader 与主题能力验证。
- 新增运行时依赖 `sherpa-onnx-node`（N-API 预编译，各平台 optional 包；macOS arm64 解压 34MB），`asarUnpack` 需包含其 `.node` 与 dylib；模型（Silero 0.6MB + ASR 约 170MB）放 userData `voice-models/`，由 `scripts/download-voice-models.js` 下载并校验，不入仓库。
- 仍依赖已有 `127.0.0.1:8880/v1/audio/speech`（TTS）与可选回退 `127.0.0.1:2022/v1/audio/transcriptions`；不安装或管理其服务，也不依赖 VoiceMode MCP。
- macOS 打包需麦克风用途说明与音频输入 entitlement；当前 `build/` 尚无该 entitlement 文件，需随实现补齐并验证签名产物。
- MVP 优先 Web Audio / AudioWorklet、内置 Node HTTP/child_process；云音频需 WebSocket transport，实施前核对 Electron 主进程可用性，已有 transport 优先，确需新依赖按本变更评审。CLI 默认不引入 Agent SDK。能量 VAD 保留为模型缺失时的回退；Silero 已随本变更引入（经 sherpa-onnx，无需再加 onnxruntime 依赖）。
- 不改变 `/state` HTTP 契约；语音状态来自进程内受控 runtime，不注册虚构 coding agent、不向公网开放音频端点。

## 方案已落定与估算

默认本地语音无调用费（不含 Claude 订阅）；本机实测 VAD 每 20ms 帧约 0.25ms，流式识别说完后约 0.38s 出 final（含 350ms 判停），说完至首声的整链路仍为估算 1.2–3.0s，非实测或 SLA。云 provider（北京 DashScope key，约 15.48 元/月）仅为可选。MVP 先仅聊天、listening/speaking + 音量律动、无摄像头；这两项推荐仍列 Open Questions 待确认。详见 design 第 4、5 节。
