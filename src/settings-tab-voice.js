"use strict";

(function initSettingsTabVoice(root) {
  let state = null;
  let helpers = null;
  let ops = null;
  let pending = false;
  let modelsStatus = null; // { ready, missing, dir } from main; null until fetched
  let modelsRequested = false;

  const STT_OPTIONS = [
    ["sherpa-onnx", "voiceSttSherpa"],
    ["local-whisper", "voiceSttLocal"],
    ["aliyun-paraformer", "voiceSttAliyun"],
  ];
  const BRAIN_OPTIONS = [
    ["claude-code", "voiceBrainClaude"],
    ["session", "voiceBrainSession"],
  ];
  const TTS_OPTIONS = [
    ["edge", "voiceTtsEdge"],
    ["local-kokoro", "voiceTtsLocal"],
    ["aliyun-cosyvoice-v3-flash", "voiceTtsCosyV3"],
    ["aliyun-cosyvoice-v3.5-flash", "voiceTtsCosyV35"],
  ];
  const EDGE_VOICES = [
    ["zh-CN-XiaoxiaoNeural", "Xiaoxiao (zh-CN)"],
    ["zh-CN-XiaoyiNeural", "Xiaoyi (zh-CN)"],
    ["zh-CN-YunxiNeural", "Yunxi (zh-CN)"],
    ["zh-CN-YunjianNeural", "Yunjian (zh-CN)"],
  ];
  const END_SILENCE_CHOICES = [400, 600, 800, 1000, 1200, 1500];
  const DEFAULTS = {
    enabled: false, brain: "claude-code", stt: "sherpa-onnx", tts: "edge", edgeVoice: "zh-CN-XiaoxiaoNeural", endSilenceMs: 800,
    cloudConsent: false, ttsVoice: "longanyang", ttsVoiceId: "", localFallback: false, claudePath: "",
  };

  const t = (key) => helpers.t(key);
  const current = () => ({ ...DEFAULTS, ...((state.snapshot && state.snapshot.voice) || {}) });
  const isCloud = (v) => v.stt.startsWith("aliyun-") || v.tts.startsWith("aliyun-") || v.tts === "edge";
  const isAliyun = (v) => v.stt.startsWith("aliyun-") || v.tts.startsWith("aliyun-");
  const labelOf = (k) => (/^voice[A-Z]/.test(k) ? t(k) : k); // literal names (voices, ms) pass through

  function save(patch) {
    pending = true;
    ops.requestRender({ content: true });
    const done = () => { pending = false; ops.requestRender({ content: true }); };
    return Promise.resolve(window.settingsAPI.update("voice", { ...current(), ...patch })).then((result) => {
      if (!result || result.status !== "ok") ops.showToast(t("toastSaveFailed") + ((result && result.message) || ""), { error: true });
      done();
    }).catch((err) => {
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      done();
    });
  }

  function makeRow(labelKey, descKey, control, { disabled = false } = {}) {
    const row = document.createElement("div");
    row.className = "row";
    if (disabled) row.classList.add("tg-approval-row-disabled");
    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t(labelKey);
    text.appendChild(label);
    if (descKey) {
      const desc = document.createElement("span");
      desc.className = "row-desc";
      desc.textContent = t(descKey);
      text.appendChild(desc);
    }
    row.appendChild(text);
    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    ctrl.appendChild(control);
    row.appendChild(ctrl);
    return { row, label };
  }

  function switchRow(labelKey, descKey, key, { disabled = false } = {}) {
    const v = current();
    const holder = document.createElement("div");
    const { row } = makeRow(labelKey, descKey, holder, { disabled });
    const sw = helpers.buildSwitch({
      checked: !!v[key],
      pending,
      disabled,
      ariaLabel: t(labelKey),
      onToggle: () => save({ [key]: !v[key] }),
    });
    holder.appendChild(sw.element);
    return row;
  }

  // Option values are strings; `parse` converts back (numbers) before saving.
  function selectRow(labelKey, key, options, { disabled = false, descKey = null, parse = (x) => x } = {}) {
    const v = current();
    const holder = document.createElement("div");
    const { row } = makeRow(labelKey, descKey, holder, { disabled });
    const picker = helpers.buildSettingsSelect({
      value: String(v[key]),
      options: options.map(([value, textKey]) => ({ value: String(value), label: labelOf(textKey) })),
      ariaLabel: t(labelKey),
      viewportPlacement: "down",
      onChange: (next) => (next === String(v[key]) ? true : save({ [key]: parse(next) }).then(() => true)),
    });
    holder.appendChild(picker.element);
    return row;
  }

  function textRow(labelKey, descKey, key) {
    const v = current();
    const wrap = document.createElement("div");
    wrap.className = "tg-approval-input-row";
    const input = document.createElement("input");
    input.type = "text";
    input.spellcheck = false;
    input.className = "tg-approval-input";
    input.value = v[key] || "";
    input.setAttribute("aria-label", t(labelKey));
    const btn = helpers.buildButton({ labelKey: "voiceInputSave", tone: "accent", disabled: pending, pending });
    btn.addEventListener("click", () => save({ [key]: input.value.trim() }));
    wrap.appendChild(input);
    wrap.appendChild(btn);
    return makeRow(labelKey, descKey, wrap).row;
  }

  function note(textKey) {
    const p = document.createElement("p");
    p.className = "subtitle";
    p.textContent = t(textKey);
    return p;
  }

  function sherpaStatusNote(v) {
    if (v.stt !== "sherpa-onnx") return null;
    if (!modelsRequested && window.settingsAPI && window.settingsAPI.getVoiceModelsStatus) {
      modelsRequested = true;
      Promise.resolve(window.settingsAPI.getVoiceModelsStatus()).then((status) => {
        modelsStatus = status || { ready: false };
        ops.requestRender({ content: true });
      }).catch(() => { modelsStatus = { ready: false }; });
    }
    if (!modelsStatus) return null;
    const p = note(modelsStatus.ready ? "voiceSherpaReady" : "voiceSherpaMissing");
    if (modelsStatus.dir) p.title = modelsStatus.dir;
    return p;
  }

  function render(parent) {
    const v = current();
    const h1 = document.createElement("h1");
    h1.textContent = t("voiceTitle");
    parent.appendChild(h1);
    parent.appendChild(note("voiceSubtitle"));
    parent.appendChild(note("voiceOfflineNote"));
    parent.appendChild(helpers.buildSection(t("voiceSectionCall"), [
      switchRow("voiceEnabledLabel", "voiceEnabledDesc", "enabled"),
    ]));
    parent.appendChild(helpers.buildSection(t("voiceSectionProviders"), [
      selectRow("voiceBrainLabel", "brain", BRAIN_OPTIONS),
      selectRow("voiceSttLabel", "stt", STT_OPTIONS),
      selectRow("voiceTtsLabel", "tts", TTS_OPTIONS),
      ...(v.tts === "edge" ? [selectRow("voiceEdgeVoiceLabel", "edgeVoice", EDGE_VOICES)] : []),
      selectRow("voiceEndSilenceLabel", "endSilenceMs", END_SILENCE_CHOICES.map((ms) => [ms, `${ms} ms`]), { descKey: "voiceEndSilenceDesc", parse: Number }),
      switchRow("voiceLocalFallbackLabel", "voiceLocalFallbackDesc", "localFallback", { disabled: !isCloud(v) && v.stt !== "sherpa-onnx" }),
    ].concat(sherpaStatusNote(v) || [])));
    if (isCloud(v)) {
      parent.appendChild(helpers.buildSection(t("voiceSectionCloud"), [
        switchRow("voiceCloudConsentLabel", "voiceCloudConsentDesc", "cloudConsent"),
        ...(isAliyun(v) ? [note("voiceKeyHint")] : []),
        ...(v.tts === "edge" ? [note("voiceEdgeCloudNote")] : []),
      ]));
    }
    parent.appendChild(helpers.buildSection(t("voiceSectionAdvanced"), [
      textRow("voiceTtsVoiceLabel", null, "ttsVoice"),
      textRow("voiceTtsVoiceIdLabel", null, "ttsVoiceId"),
      textRow("voiceClaudePathLabel", "voiceClaudePathDesc", "claudePath"),
    ]));
  }

  function init(core) {
    state = core.state;
    helpers = core.helpers;
    ops = core.ops;
    core.tabs.voice = { render };
  }

  root.ClawdSettingsTabVoice = { init };
})(globalThis);
