// Clawd 录音助手：作为桌宠子进程运行，自己录音，并注册 AirPods 柄静音回调。
// 柄事件只送给“正在录音的进程”，所以录音必须由本进程完成（Chromium 的 audio service 收不到）。
//   stdout: 二进制帧 [0xCA 0xFE][uint16 LE 长度][16kHz 单声道 s16le，20ms=640 字节]，只有音频，没有别的。
//   stderr: JSON 行（控制/状态）：{"ready":true,"muted":b} {"capture":{device,voiceProcessing,vpError,rate,channels}} {"mute":b} {"error":..}
//   stdin : JSON 行：{"set":b} 把系统静音状态同步成桌宠的状态；{"device":"label"} 切换输入（空串=系统默认）；关闭即退出。
// 参数：--device <label> 启动时指定麦克风；--list-devices 打印输入设备后退出（不录音）；--no-voice-processing 不开回声消除（调试用，启动更快）。
// 静音时不把音频置零：桌宠静音语义是“不当输入”，仍要在本地听唤醒词。
import AVFAudio
import AudioToolbox
import CoreAudio
import Foundation

signal(SIGPIPE, SIG_IGN)
setvbuf(stderr, nil, _IOLBF, 0)

let ctlLock = NSLock()
func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    ctlLock.lock(); defer { ctlLock.unlock() }
    FileHandle.standardError.write(data + Data("\n".utf8))
}

// ---- 设备枚举与 label 匹配 ----
func deviceName(_ id: AudioDeviceID) -> String {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var name: Unmanaged<CFString>? = nil; var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &name) == noErr, let n = name else { return "" }
    return n.takeRetainedValue() as String
}

func inputDevices() -> [(id: AudioDeviceID, name: String)] {
    let sys = AudioObjectID(kAudioObjectSystemObject)
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(sys, &addr, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(sys, &addr, 0, nil, &size, &ids) == noErr else { return [] }
    return ids.compactMap { id in
        var sc = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
        var s: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &sc, 0, nil, &s) == noErr, s > 0 else { return nil }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(s), alignment: 16); defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(id, &sc, 0, nil, &s, raw) == noErr else { return nil }
        let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        return list.reduce(0) { $0 + Int($1.mNumberChannels) } > 0 ? (id, deviceName(id)) : nil
    }
}

func defaultInputID() -> AudioDeviceID? {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var id = AudioDeviceID(0); var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    return AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id) == noErr ? id : nil
}

// Chromium 标签形如 "Default - MacBook Pro Microphone (Built-in)"，HAL 名只有 "MacBook Pro Microphone"。
func norm(_ s: String) -> String {
    var t = s.lowercased()
    if t.hasPrefix("default - ") { t = String(t.dropFirst(10)) }
    while t.hasSuffix(")"), let r = t.range(of: " (", options: .backwards) { t = String(t[..<r.lowerBound]) }
    return t.trimmingCharacters(in: .whitespaces)
}

func findDevice(_ label: String) -> (id: AudioDeviceID, name: String)? {
    let want = norm(label)
    if want.isEmpty { return nil }
    let all = inputDevices()
    return all.first { norm($0.name) == want } ?? all.first { let n = norm($0.name); return !n.isEmpty && (n.contains(want) || want.contains(n)) }
}

let argv = CommandLine.arguments
if argv.contains("--list-devices") {
    print(inputDevices().map { "\($0.name)" }.joined(separator: "\n")); exit(0)
}

// ---- 录音：AVAudioEngine -> 16k 单声道 s16le -> stdout 帧 ----
let outQueue = DispatchQueue(label: "clawd.pcm-out")
let FRAME_SAMPLES = 320
let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!

func writeFrame(_ samples: ArraySlice<Int16>) {
    var data = Data([0xCA, 0xFE, UInt8(samples.count * 2 & 0xFF), UInt8((samples.count * 2) >> 8)])
    samples.withUnsafeBufferPointer { data.append(UnsafeBufferPointer(start: UnsafeRawPointer($0.baseAddress!).assumingMemoryBound(to: UInt8.self), count: $0.count * 2)) }
    outQueue.async { do { try FileHandle.standardOutput.write(contentsOf: data) } catch { exit(0) } }  // 父进程没了
}

final class Capture {
    var label: String
    var engine: AVAudioEngine?
    var runningName = ""
    var converter: AVAudioConverter?
    var convRate = 0.0
    var pending: [Int16] = []
    init(label: String) { self.label = label }

    func targetName() -> String {
        if let d = findDevice(label) { return d.name }
        return defaultInputID().map(deviceName) ?? ""
    }

    func stop() {
        engine?.inputNode.removeTap(onBus: 0); engine?.stop(); engine = nil
        converter = nil; pending.removeAll()
    }

    func build(voiceProcessing: Bool) throws -> (vp: Bool, vpError: String?, fmt: AVAudioFormat) {
        let eng = AVAudioEngine()
        let input = eng.inputNode
        if !label.isEmpty {
            if let d = findDevice(label), let au = input.audioUnit {
                var id = d.id
                AudioUnitSetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &id, UInt32(MemoryLayout<AudioDeviceID>.size))
            } else { emit(["error": "device_not_found_use_default"]) }
        }
        var vp = false; var vpError: String? = nil
        if voiceProcessing {
            do {
                try input.setVoiceProcessingEnabled(true); vp = true
                // 回声消除会默认压低其他应用的声音（含桌宠自己的播报），压到最低。
                input.voiceProcessingOtherAudioDuckingConfiguration = AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
            } catch { vpError = "\(error)" }
        }
        let fmt = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: fmt) { [weak self] buf, _ in self?.process(buf) }
        engine = eng
        try eng.start()
        return (vp, vpError, fmt)
    }

    var vpMuted: Bool { engine?.inputNode.isVoiceProcessingInputMuted ?? false }

    func start() {
        stop()
        let t0 = Date()
        var result: (vp: Bool, vpError: String?, fmt: AVAudioFormat)
        do { result = try build(voiceProcessing: !argv.contains("--no-voice-processing")) }
        catch {  // 回声消除起不来：不带它再试一次，仍然失败才退出（桌宠会重启或回退）
            let first = "\(error)"; stop()
            do { result = try build(voiceProcessing: false); result.vpError = first }
            catch { emit(["error": "engine_start", "message": "\(error)"]); exit(2) }
        }
        runningName = targetName()
        var info: [String: Any] = ["startMs": Int(Date().timeIntervalSince(t0) * 1000), "device": runningName, "voiceProcessing": result.vp, "rate": result.fmt.sampleRate, "channels": Int(result.fmt.channelCount)]
        if let e = result.vpError { info["vpError"] = e }
        emit(["capture": info])
    }

    // 只取第 0 声道（开了回声消除时它是处理后的人声），重采样成 16k s16le。
    func process(_ buf: AVAudioPCMBuffer) {
        let n = Int(buf.frameLength), ch = Int(buf.format.channelCount)
        guard n > 0, let src = buf.floatChannelData else { return }
        let stride = buf.format.isInterleaved ? ch : 1
        let rate = buf.format.sampleRate
        guard let monoFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false),
              let mono = AVAudioPCMBuffer(pcmFormat: monoFmt, frameCapacity: AVAudioFrameCount(n)) else { return }
        mono.frameLength = AVAudioFrameCount(n)
        for i in 0..<n { mono.floatChannelData![0][i] = src[0][i * stride] }
        if converter == nil || convRate != rate { converter = AVAudioConverter(from: monoFmt, to: outFormat); convRate = rate }
        guard let conv = converter,
              let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: AVAudioFrameCount(Double(n) * 16000 / rate) + 32) else { return }
        var fed = false; var err: NSError?
        conv.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true; status.pointee = .haveData; return mono
        }
        guard err == nil, let p = out.int16ChannelData?[0] else { return }
        pending.append(contentsOf: UnsafeBufferPointer(start: p, count: Int(out.frameLength)))
        while pending.count >= FRAME_SAMPLES { writeFrame(pending[0..<FRAME_SAMPLES]); pending.removeFirst(FRAME_SAMPLES) }
    }
}

var deviceArg = ""
if let i = argv.firstIndex(of: "--device"), i + 1 < argv.count { deviceArg = argv[i + 1] }
let capture = Capture(label: deviceArg)

// ---- AirPods 柄：回调返回 true 表示已处理；不改音频 ----
let app = AVAudioApplication.shared
var lastMute = false  // 只在状态真的变了才上报（引擎启动/重建时系统会回报一次当前状态）
func report(_ m: Bool, via: String) {
    if m != lastMute { lastMute = m; emit(["mute": m, "via": via]) }
}
do {
    try app.setInputMuteStateChangeHandler { shouldMute in
        emit(["handler": shouldMute])  // 原始回调，排查用
        DispatchQueue.main.async { report(shouldMute, via: "handler") }
        return true
    }
} catch {
    emit(["error": "handler_register", "message": "\(error)"]); exit(1)
}

capture.start()
emit(["ready": true, "muted": app.isInputMuted])

// ---- 跟随系统默认输入 / 指定设备上下线：目标变了才重建，去抖 400ms ----
var rebuildWork: DispatchWorkItem?
func scheduleRebuild(force: Bool) {
    rebuildWork?.cancel()
    let w = DispatchWorkItem { if force || capture.targetName() != capture.runningName { capture.start() } }
    rebuildWork = w
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: w)
}
for sel in [kAudioHardwarePropertyDefaultInputDevice, kAudioHardwarePropertyDevices] {
    var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, DispatchQueue.main) { _, _ in scheduleRebuild(force: false) }
}
NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main) { _ in
    // 配置变了引擎会被停掉：原地重启同一个引擎即可；整个重建会再开一次回声消除、再触发配置变化，循环不止。
    guard let eng = capture.engine, !eng.isRunning else { return }
    do { try eng.start(); emit(["engine_restarted": true]) } catch { scheduleRebuild(force: true) }
}
// 兜底：系统可能不调回调（例如开了回声消除时），每 0.3 秒查一次系统和回声消除的静音状态。
NotificationCenter.default.addObserver(forName: AVAudioApplication.inputMuteStateChangeNotification, object: nil, queue: .main) { _ in
    report(app.isInputMuted, via: "notification")
}
// 回声消除自己静音时音频会被置零、听不到唤醒词：当作一次按柄切换，并立刻解除它的静音。
Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { _ in
    if capture.vpMuted {
        capture.engine?.inputNode.isVoiceProcessingInputMuted = false
        report(!lastMute, via: "vp")
    } else {
        report(app.isInputMuted, via: "poll")
    }
}

DispatchQueue.global().async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
        DispatchQueue.main.async {
            if let want = obj["set"] as? Bool { lastMute = want; try? app.setInputMuted(want) }
            if let l = obj["device"] as? String, l != capture.label { capture.label = l; capture.start() }
        }
    }
    exit(0)  // 父进程退出 / stdin 关闭
}
RunLoop.main.run()
