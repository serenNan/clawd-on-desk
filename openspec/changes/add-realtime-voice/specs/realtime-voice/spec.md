## ADDED Requirements

### Requirement: 默认关闭且由用户主动开始
系统 SHALL 默认设置 voiceEnabled=false、大脑 Claude Code、STT sherpa-onnx（本地流式）、TTS 本地 Kokoro；启用偏好、恢复配置或重启 SHALL NOT 自动开始录音。用户显式选云 provider 时，云 key 或地域/音频上传确认缺失，以及 Claude 纯聊天能力缺失，SHALL 提示配置且不采集音频。默认本地模型无需 key 或上传确认。

#### Scenario: 新用户启动
- **WHEN** 应用以默认配置启动
- **THEN** 无麦克风请求、录音 track、大脑请求或语音 overlay。

#### Scenario: 仅启用偏好
- **WHEN** 用户打开 voiceEnabled 但尚未主动开始通话
- **THEN** 应用仅显示可用入口，不请求麦克风或启动语音服务。

### Requirement: 统一开始和结束入口
系统 SHALL 通过非拖拽 Alt+单击桌宠、菜单及用户配置的快捷键调用同一通话 toggle。快捷键默认 SHALL 未绑定；普通点击、HUD、拖拽行为 SHALL 保留，miniTransitioning 期间 SHALL 拒绝开始且允许结束。

#### Scenario: 用户通过桌宠开始
- **WHEN** 语音已启用且 provider 已选，用户 Alt+单击桌宠并未拖拽
- **THEN** 显式请求所需麦克风权限并开始一次通话，第二次 Alt+单击结束。

#### Scenario: 过渡中操作
- **WHEN** 桌宠正在 mini 过渡且用户尝试开始或结束
- **THEN** 开始被拒绝且不修改窗口位置，已在进行的通话仍能结束。

### Requirement: 播报期间持续录音和可见反馈
系统 SHALL 在整个通话期间持续保持麦克风输入，包括 TTS 播报时，请求 echoCancellation 并检查实际支持/设置；SHALL 持续显示麦克风、倾听、等待、播报、静音或错误状态。AEC 无法满足外放验收时 SHALL 明确反馈，不能静默改成轮流录音。

#### Scenario: 正在播放回复
- **WHEN** TTS 音频正在播放
- **THEN** 输入 track 仍活跃，VAD 继续接收帧并能检测用户插话。

#### Scenario: 输出静音
- **WHEN** 用户静音语音输出但未结束通话
- **THEN** 不输出 TTS，麦克风状态仍明确可见且持续输入，用户可显式结束录音。

### Requirement: 用户开口即本地两段式打断
系统 SHALL 在 VAD speech-start 时先把当前 TTS 降音（约 -18dB）而不停播、不递增 epoch、不取消后端；随后 SHALL 在以下任一条件满足时正式打断（淡出停止当前与已排程 TTS、清空播放队列、递增 epoch，再取消 ASR/TTS/大脑请求）：流式 STT partial 出现非附和实义文本，或连续人声 ≥300ms。附和词（嗯/对/好/是/哦/啊等，忽略标点）、咳嗽和 <300ms 杂音 SHALL 在 600ms 内恢复音量继续播放，不丢句。正式打断 SHALL NOT 等待 final、端点静音或网络返回。安静耳机和受控外放验收各至少 40 次，声学起始至输出静音 P95 SHALL 小于 300ms，确认至静音 P95 SHALL 小于 80ms。

#### Scenario: 大脑和 TTS 均未结束
- **WHEN** 用户在 AI 播报过程中说出实义内容
- **THEN** AI 声音先降音，partial 出现实义文本后立即淡出停止，当前大脑/TTS 被取消、麦克风保持开启、新输入保留 pre-roll。

#### Scenario: 用户只是附和
- **WHEN** 用户在播报中只说“嗯”或“对”
- **THEN** AI 声音降音后恢复，不递增 epoch、不取消大脑或 TTS，也不提交新一轮。

#### Scenario: 识别器不可用
- **WHEN** 流式识别不可用或回退到不产生 partial 的 whisper
- **THEN** 连续人声 ≥300ms 仍触发正式打断。

#### Scenario: 测量延迟
- **WHEN** 测试人员完成每种设备 40 次双声道声学对齐的插话测试
- **THEN** 报告声学起始与停止声道间隔的 P50/P95/最大值、误打断和漏打断，不能用 pause 调用时间代替实际停止。

### Requirement: 过期结果隔离和有界队列
系统 SHALL 用单调 turnEpoch 标记请求/结果，在插话、结束或 renderer 销毁时失效旧 epoch；迟到文本/PCM/错误 SHALL NOT 更新状态或播放。待预合成句子 SHALL 不超过 2 句，PCM 缓存 SHALL 不超过 2s，并对上游实施背压。

#### Scenario: 取消后收到 PCM
- **WHEN** 已失效 epoch 的 PCM chunk 在下一轮开始后到达
- **THEN** 该 chunk 被丢弃，不插入下一轮、不恢复旧动画。

#### Scenario: 长回答溢出
- **WHEN** 大脑生成速度超过播报速度
- **THEN** 停止继续预取直到队列回落，有界缓存和音频顺序保持，内存不随回答无限增长。

### Requirement: 本地神经网络 VAD 与流式中文识别
系统 SHALL 分离 STT、brain、TTS provider 接口，默认 STT 为在 main 进程运行的本地 sherpa-onnx 流式中英识别、VAD 为 Silero；renderer SHALL 连续上送 16kHz PCM，由 main 切分语音段并回送 speech-start/frame/speech-end 供就地降音。STT SHALL 声明真实流式能力、边说边解码、以 partial 驱动打断确认与界面，partial SHALL NOT 提交大脑；只有 VAD 判停后识别器给出的 final 才触发一次大脑输入。VAD 尾静音初值 SHALL 为 350ms、允许 250–500ms 调优，最短有效人声 150ms，单段 ≤15s。模型 SHALL 位于 userData 的 `voice-models/` 并经 sha256 校验的下载脚本获取，不进仓库和安装包；设置页 SHALL 显示模型是否就绪。模型缺失或 native 模块加载失败时 SHALL 回退 whisper（WAV/zh 分段识别，不冒充流式）与能量 VAD，并明确提示，不静默失败。日志 SHALL 只记事件与耗时，不记识别文本。保留音频 SHALL 有 15s 上限；超长语音 SHALL 分段并提示，不默默丢音。

#### Scenario: 中文输入和短停顿
- **WHEN** 用户发言中出现短于本地判停阈值的停顿，云端已经返回 partial
- **THEN** 不将 partial 提交给 Claude，继续接收音频，final 与判停都满足后只提交一次。

#### Scenario: 空识别与重复 final
- **WHEN** STT 返回空文本、无语音或同 request 的重复 final
- **THEN** 空文本不调用大脑，重复 final 不产生第二轮回复。

#### Scenario: 模型缺失回退
- **WHEN** 默认 sherpa-onnx 的模型文件未下载，用户开始通话
- **THEN** 通话使用 whisper 与能量 VAD 正常开始，并提示运行 `npm run download:voice-models`；用户显式选择 whisper 时不出现该提示。

#### Scenario: 已取消语句的迟到结果
- **WHEN** 某句因噪声被取消或通话已结束，之后其识别器回调 partial/final
- **THEN** 回调被丢弃，不更新界面、不提交大脑。

### Requirement: 可插拔流式中文合成和按序播放
系统 SHALL 默认使用 cosyvoice-v3-flash 系统音色 longanyang，按短句提交流式文本并在合成完成前播放首 PCM；SHALL 按 provider 真实采样率/格式解码与背压，不播报推理/日志。v3.5-flash SHALL 仅在北京地域且合法 voice ID 已配置时可选；本地 Kokoro:8880/zf_xiaobei SHALL 作为用户启用的离线语音回退。

#### Scenario: 多句回复
- **WHEN** Claude 流出首个可朗读短句且 TTS 已返回首 PCM
- **THEN** 首句立即按顺序排程，不等待完整大脑回复或完整音频；后续最多预取 2 句/2s PCM。

#### Scenario: 传输切在半个样本处
- **WHEN** provider s16le 两次读取将一个样本拆开
- **THEN** 合并余字节再解码，不产生偏移/爆音，不将 HTTP 头部首字节记为首音频。

#### Scenario: 选择无系统音色模型
- **WHEN** 用户选择 v3.5-flash 却未配置可用 voice ID
- **THEN** 显示音色配置错误，不请求默认系统音色、不静默换模型。

### Requirement: Claude Code 常驻纯聊天接入
系统 SHALL 默认复用本机用户已有 Claude Code 订阅登录，消费常驻 stream-json 输入/输出和 partial text_delta，使用中文口语短句 system prompt；SHALL NOT 写 API key、复制 OAuth secret、改全局配置或切换账号。SHALL 验证工具全集为空、MCP 未连接、hooks 禁用，禁止把 allowedTools 空数组或 read-only 当作全工具禁用。能力不满足 SHALL fail closed；配额/认证错误 SHALL 可见且不换脑。MVP SHALL 默认 no-session-persistence，不 resume 其他 coding 会话。

#### Scenario: 正常连续聊天
- **WHEN** 两轮回复都已完整播完且继续第三轮
- **THEN** 复用同一个已验证 CLI 进程，stdin 保持开启，completed 不重复播报已流过文字。

#### Scenario: 认证或能力不符
- **WHEN** CLI 缺少必需参数、工具非空或认证指向 API key/第三方账单
- **THEN** 不启动语音大脑，提示具体配置问题，不绕过权限或静默走 API 计费。

### Requirement: 打断后的已听历史一致
系统 SHALL 以音频 sink 的完整短句播放 ACK 建立内存已听 journal；插话 SHALL 先使 epoch 失效并本地停播，再取消当前大脑/TTS。取消 SHALL 仅针对自有子进程/请求，未确认中断在 0.5s 后 SHALL 终止自有进程。SHALL 在有未播文本的打断或静音后重建 Claude 会话，只传已听历史和新输入，不能 resume 含未播回复的旧上下文；句中中断 SHALL 标记 partiallyPlayed，不猜精确已播字符。journal SHALL 不超过 8,000 字，完整回复 SHALL 不超过 2,000 字。

#### Scenario: Claude 已生成三句而只播完一句
- **WHEN** 用户在第二句中插话且第三句尚未播放
- **THEN** 旧 epoch 永不播报，下一脑会话只带完整第一句与中断标记，不含未播第二句后半和第三句；不依赖 prompt 声称删除旧内部历史。

#### Scenario: Windows 或取消超时
- **WHEN** 当前平台不能验证在途 interrupt 或 0.5s 未确认
- **THEN** 本地停声仍立即有效，只回收当前自有进程并重建，其他 Claude 会话不受影响。

### Requirement: 默认仅对话的操作边界
系统 SHALL 默认禁用电脑操作与工具执行；CLI 无可靠工具禁用能力时 SHALL 将其纯聊天模式标为不可用，而不是依赖提示词或 read-only 声称无工具。启用电脑操作 SHALL 先有用户批准的工具/目录和审批规格，不得自动开启 unattended 或绕过审批。

#### Scenario: 语音要求执行命令
- **WHEN** 用户在默认纯对话模式说“删除目录”
- **THEN** 不执行命令，说明当前仅对话；任何电脑操作升级都需要独立明确配置。

### Requirement: 桌宠显示状态兼容已有会话和主题
系统 SHALL 以 runtime overlay 添加 listening/speaking，等待大脑复用 thinking；SHALL 保留 error、notification/permission、attention、工作状态的优先级规则，不写入虚构 coding session、不改变 HUD 快照。主题缺语音状态 SHALL 降级现有 idle/working/thinking 动画，结束 SHALL 恢复当前实时状态。

#### Scenario: 同时有权限审批
- **WHEN** 通话期间 coding agent 产生权限审批或高优先级错误
- **THEN** 审批/错误动画优先，通话指示仍可见；审批决策不由语音模式代替。

#### Scenario: 旧主题且通话结束
- **WHEN** 旧主题缺 speaking，且结束时 coding session 已由 working 变为 idle
- **THEN** 播报时用既有动画降级，结束显示当前 idle，不恢复开始时缓存的 working。

### Requirement: 云音频告知、离线回退与生命周期释放
系统 SHALL 在开始云通话前告知并取得确认：STT 向已选厂商/地域上传原始音频，TTS 上传待朗读文本，Claude 接收转写和已听上下文；SHALL 默认不保存录音、转写、音频或 secret 日志。云密钥 SHALL 只在主进程使用，不写 renderer/prefs。本地语音 SHALL 在本机完成：sherpa-onnx 与 Silero 在进程内运行，whisper/Kokoro 只连固定 loopback，绕过代理、拒绝外网重定向，但不得称联网 Claude 为完全离线。系统 SHALL NOT 自动管理本机服务或静默跨云厂商 fallback。

#### Scenario: 云确认或 key 缺失
- **WHEN** 用户主动开始默认云语音，但未确认上传或未配 key
- **THEN** 不采集/上传音频，显示配置入口；允许显式选择本地语音。

#### Scenario: 用户预先启用本地回退
- **WHEN** 云 STT/TTS 失败且用户已启用 loopback 回退
- **THEN** 先取消旧请求并更换 epoch，再重转有界当轮音频或重合成未播完整句，明示模型已回退；不会切到另一家云服务。

#### Scenario: 全局代理已开启
- **WHEN** 本地回退时环境配置 http(s)_proxy
- **THEN** whisper/Kokoro 仍直连 127.0.0.1，不上传到代理或云。

#### Scenario: DND、隐藏或退出
- **WHEN** 用户结束、禁用语音、DND、隐藏桌宠、睡眠、退出或 renderer 销毁
- **THEN** 停播、取消请求、停止全部 tracks、释放音频与已听 journal、清除 overlay；重复调用安全，隐藏期间权限请求仍沿原逻辑出现。

### Requirement: 首声预算可验证
系统 SHALL 记录用户声学结束、VAD 判停、STT final、Claude 首 text delta/首可朗读短句、TTS 首可播放 PCM、输出首非静音样本的时刻，仅记录时长/错误码，不记录内容。默认热链路验收目标 SHALL 为每种组合至少 40 轮中文、P50≤2s 且 P95≤3s；冷启动、插话后重建与离线回退 SHALL 分组报告，不宣称官方 SLA 或豆包等速。

#### Scenario: 单独 TTS 很快而大脑较慢
- **WHEN** TTS 首包达标但完整链路首声超过目标
- **THEN** 报告真实端到端 P50/P95 和阶段瓶颈，不能拿首 token、HTTP 头部或厂商宣传首包替代首声。

### Requirement: 可信麦克风授权和服务故障反馈
系统 SHALL 仅在用户主动开始时向可信语音 renderer 授权 audio media，拒绝 camera 与其他窗口/来源；macOS 包 SHALL 包含麦克风用途说明及所需 audio-input entitlement。授权拒绝或音频服务失败 SHALL 可见且停止未完成通话，不循环请求权限或自动拉起服务。

#### Scenario: macOS 拒绝授权
- **WHEN** 用户拒绝首次麦克风权限
- **THEN** 通话未开始或立即结束，显示系统设置入口，不重复自动弹窗、不残留 track。

#### Scenario: 服务不可达
- **WHEN** 本机 whisper/Kokoro 无响应、错误或超时
- **THEN** 显示具体服务错误并释放资源，用户可显式重试；不启动/停止系统服务、不静默跨厂商上传；只有事先配置的本地回退可用。

### Requirement: Claude Code 会话语音模式
系统 SHALL 提供 `session` 大脑模式：不启动后台 CLI，用户 final 交给外部 Claude Code 会话，外部提交的回复文本走现有分句、TTS、播放和两段式打断链路。系统 SHALL 在 23333 服务上提供仅 loopback 的 `POST /voice/session/start`、`/voice/session/stop`、`/voice/converse`；同一时刻 SHALL 只有一个待取 converse，新请求使旧请求返回 `superseded`。converse SHALL 返回正常 `user`、被打断时的 `played`/`unplayed_count`/`user`、`timeout`、`ended` 之一；状态 SHALL 在等待时为 listening、播报时为 speaking、两次 converse 之间为 thinking。debug 日志 SHALL 只记事件与耗时。

#### Scenario: 正常一轮
- **WHEN** Claude 提交 text 且用户播完后回答
- **THEN** 先完整播报，再返回 `{interrupted:false,user}`。

#### Scenario: 播报中被插话
- **WHEN** 用户在第一句播完、第二句播放中说出实义内容
- **THEN** 立即停播并返回 `interrupted:true`、已完整播完的 `played`、`unplayed_count` 与用户新说的话；仅「嗯」类附和不打断也不返回。

#### Scenario: 超时、结束与被顶替
- **WHEN** 播完后 `timeout_s` 内无人说话，或用户说「结束语音」，或新 converse 到达
- **THEN** 分别返回 `{timeout:true}`、`{ended:true}`、`{superseded:true}`。

#### Scenario: 非本机或浏览器请求
- **WHEN** 对端非 loopback，或请求带 Origin / 非 loopback Host / 非 JSON Content-Type
- **THEN** 拒绝且不开麦、不改设置；`voice.enabled` 未开时 start 返回 `voice-disabled`。

#### Scenario: MCP 桥
- **WHEN** Claude Code 通过 `clawd-voice` MCP 调 `tools/list` 与 `tools/call`
- **THEN** 返回 `voice_start`/`voice_converse`/`voice_stop` 并直连 127.0.0.1（不走代理）；桌宠未运行时返回清晰错误。

### Requirement: Edge 在线语音合成
系统 SHALL 提供 TTS provider `edge`（微软 Edge 在线神经语音），并作为 `voice.tts` 默认值，默认音色 `zh-CN-XiaoxiaoNeural`，音色可在设置选 zh-CN 神经语音，语速沿用 `ttsSpeed`（1.2 → rate +20%）。adapter SHALL 满足 begin/writeText/finish/cancel 合约、可取消、迟到音频被 epoch 丢弃，并把服务返回的 MP3 解码为 24kHz 单声道 s16le PCM。使用 edge SHALL 要求 `cloudConsent`（回复文本发往微软，设置页与同意弹窗 SHALL 明示），但不要求 DashScope key。edge 失败时 SHALL 自动回退到本地 Kokoro 重播未播完的句子，记录 `tts_fallback` 并提示，不依赖 `localFallback` 开关。

#### Scenario: 正常合成
- **WHEN** 已同意云语音且选择 edge，一句回复到达
- **THEN** 以含 Sec-MS-GEC 的连接请求合成，MP3 帧被解码后作为 PCM 播放，并记录首包耗时（不含文本）。

#### Scenario: 服务不可用
- **WHEN** 连接超时、被拒绝或中途断开
- **THEN** 通话继续，未播完的句子改由 Kokoro 播放，日志有 `tts_fallback`；Kokoro 也失败则可见报错并结束通话。

#### Scenario: 未同意
- **WHEN** 选择 edge 但 `cloudConsent` 为 false
- **THEN** 开始通话前弹出云上传同意；拒绝则不开麦。

### Requirement: 句末静音可调与会话模式句子合并
系统 SHALL 使用 `voice.endSilenceMs`（默认 800ms，范围 400–1500ms）作为 VAD 判停静音。会话模式下 SHALL 在 final 后保留 600ms 合并窗口：窗口内出现新的 speech-start，则下一段 final 并入同一句再交给 converse；窗口结束仍无新语音则单独提交。噪声段不得吞掉已持有的句子。

#### Scenario: 短停顿不切句
- **WHEN** 用户说「你这个音调太」，停顿 400ms 后说「太平静了」
- **THEN** converse 只返回一次，user 为合并后的整句。

#### Scenario: 长停顿切句
- **WHEN** 第一段 final 后超过 600ms 才有新语音
- **THEN** 第一段单独返回，第二段属于下一次 converse。

### Requirement: 静音与恢复（快捷键与语音口令共用同一静音状态）
`toggleVoice` 快捷键 SHALL 在无通话时开始通话，通话中（含会话模式与后台 CLI 模式）改为静音/恢复而不结束通话。静音 SHALL 只表示「用户说话不再当作输入」：播放 end 提示音，忽略 VAD 驱动的打断与用户输入、不送给会话、不产生 user；SHALL NOT 停止或打断正在进行的播报、SHALL NOT 推进 epoch；静音期间 converse 的 text SHALL 照常合成播放，已排队的句子播完。桌宠 SHALL 在播报时显示 speaking、不在播报时显示 paused（睡觉），不得停留在 thinking；待取 converse SHALL 不返回 `ended`，播完后继续等待，超时返回 `timeout`（带 `paused:true`）。恢复 SHALL 播放 start 提示音并保留 650ms VAD 屏蔽。菜单 SHALL 在通话中显示静音/恢复项并体现状态，设置页文案 SHALL 说明该行为。

静音期间麦克风 SHALL 保持开启（系统麦克风指示常亮），音频 SHALL 只在本机识别且只用来匹配唤醒词「恢复语音」；云端 STT SHALL NOT 在静音期间使用（无本地 STT 时只能用快捷键恢复）。主进程全零检测在静音期间 SHALL 照常工作。

用户说出整句基本就是口令的「静音」（去掉标点和「请/先/吧/一下」等语气词后等于「静音」）时 SHALL 进入静音；长句中带「静音」SHALL 作为普通输入。静音期间识别结果去掉标点后包含「恢复语音」SHALL 恢复，其他话一律丢弃。口令 SHALL 由 runtime 本地处理，不交给 Claude 会话；日志只记 `voice_cmd_mute` / `voice_cmd_resume` 事件、不记原文；播报内容回声 SHALL NOT 触发口令。快捷键静音可用口令恢复，口令静音可用快捷键恢复。

#### Scenario: 会话模式静音
- **WHEN** /clawd-voice 会话进行中按快捷键或说「静音」
- **THEN** 正在进行的播报不被打断并播完，播报期间桌宠显示 speaking、否则 paused；静音中 converse 的 text 照常播放，converse 不结束（超时返回 `timeout`+`paused:true`）；说「恢复语音」或再按快捷键恢复，下一句话正常返回。

#### Scenario: 长句带静音
- **WHEN** 用户说「这个静音功能怎么样」
- **THEN** 作为普通输入送给会话，不静音。

#### Scenario: 无通话
- **WHEN** 没有通话时按快捷键
- **THEN** 与以前一样开始通话。

### Requirement: 通话中跟随系统默认输入设备
通话进行中 renderer SHALL 监听 `devicechange`：重新上报设备列表；偏好为系统默认（`micDeviceId` 为空）且未暂停时，若 `deviceId=default` 的设备 label 与当前采集 track 的 label 不一致，SHALL 只重建采集链路切到新的默认设备，通话不断，并记录 `r:mic_follow_default`。用户指定了具体设备时 SHALL NOT 自动跟随；事件 SHALL 做 1s 防抖；本通话已判定失声的设备 SHALL NOT 被跟随回去。

#### Scenario: 通话中连上蓝牙耳机
- **WHEN** 通话开始用内置麦克风，之后 AirPods 连上并成为系统默认输入
- **THEN** 1s 内无新事件后采集切到 AirPods，设置页设备列表同步刷新。

#### Scenario: 指定了设备
- **WHEN** 用户在设置页指定了某个麦克风
- **THEN** 系统默认变化时不切换。
