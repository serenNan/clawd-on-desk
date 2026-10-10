"use strict";

// Picks the input device (user choice, else system default) and for a mic restart. Some inputs deliver pure digital
// zeros while the track stays "live" (built-in mic with the lid closed, a
// route that went away), so after the first plain retry we rotate to another
// real input instead of re-opening the same dead default.
(function exposeMicDevice(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else if (root) root.ClawdVoiceMicDevice = api;
})(typeof window !== "undefined" ? window : this, function factory() {
  const normLabel = (l) => String(l || "").replace(/^(default|communications)\s*-\s*/i, "").trim();

  // Virtual drivers and the iPhone Continuity mic deliver silence or hijack the
  // route, so self-heal never rotates onto them.
  // The last alternative is how a zh-CN Mac names a Continuity mic: “<device name>”的麦克风 (no "iPhone" in it).
  const SKIP_RE = /iphone|continuity|oray|todesk|blackhole|loopback|virtual|aggregate|^[“"][^”"]+[”"]\s*的麦克风/i;
  const isSkippable = (label) => SKIP_RE.test(String(label || ""));
  const isAlias = (id) => id === "default" || id === "communications";
  const realInputs = (devices) => (devices || []).filter((d) => d && d.kind === "audioinput" && d.deviceId && !isAlias(d.deviceId));
  const withDevice = (base, deviceId) => ({ ...base, audio: { ...base.audio, deviceId: { exact: deviceId } } });

  // devices: enumerateDevices() result; tried: Set of normalized labels already
  // found dead this session. Returns the next constraints, or null for "default".
  function pickAlternate(devices, tried, base) {
    const alt = realInputs(devices).find((d) => !isSkippable(d.label) && !tried.has(normLabel(d.label)));
    return alt ? withDevice(base, alt.deviceId) : null;
  }

  // pref {id,label} from settings: id first, then label (ids can change). null = no preference.
  function resolvePreferred(devices, pref) {
    if (!pref || (!pref.id && !pref.label)) return null;
    const list = realInputs(devices);
    const byId = pref.id && list.find((d) => d.deviceId === pref.id);
    if (byId) return { device: byId, via: "id" };
    const want = normLabel(pref.label);
    const byLabel = want && list.find((d) => d.label && normLabel(d.label) === want);
    return byLabel ? { device: byLabel, via: "label" } : { device: null, via: null };
  }

  // Opens the capture stream: the user's chosen device if it resolves, else the
  // system default (logging mic_device_fallback); attempt>1 rotates to another
  // real input only when no device is pinned.
  function createMicOpener({ getUserMedia, enumerateDevices, dlog, base }) {
    let pref = null;
    const list = async () => {
      let devs = await enumerateDevices();
      if (devs.some((d) => d.kind === "audioinput" && !d.label)) { // unlabeled until a first grant
        try { (await getUserMedia(base)).getTracks().forEach((t) => t.stop()); devs = await enumerateDevices(); } catch { /* keep unlabeled list */ }
      }
      return devs;
    };
    const fallback = (why) => { dlog("mic_device_fallback", { why, label: pref.label, id: String(pref.id || "").slice(0, 12) }); pref = null; };
    async function open(attempt = 1, tried = new Set()) {
      if (pref && enumerateDevices) {
        let hit = null;
        try { hit = resolvePreferred(await list(), pref); } catch { /* treated as no match */ }
        if (hit && hit.device) {
          try {
            const s = await getUserMedia(withDevice(base, hit.device.deviceId));
            dlog("mic_device", { via: hit.via, label: hit.device.label });
            return s;
          } catch (err) { if (!err || err.name === "NotAllowedError") throw err; }
        }
        fallback(hit && hit.device ? "open_failed" : "not_found");
      }
      if (attempt > 1 && enumerateDevices) return getUserMedia(pickAlternate(await enumerateDevices(), tried, base) || base);
      return getUserMedia(base);
    }
    // Settings can't read device names (no mic permission there), so the call window reports them.
    const publish = (send) => {
      if (!enumerateDevices || !send) return;
      Promise.resolve(enumerateDevices()).then((l) => {
        const list = l.filter((d) => d.kind === "audioinput" && d.label && !isAlias(d.deviceId)).map((d) => ({ deviceId: d.deviceId, label: d.label }));
        dlog("mic_devices", { n: list.length, labels: list.map((d) => d.label).join(" | ") });
        send(list);
      }).catch(() => {});
    };
    return {
      open, publish,
      setPreferred(p) { pref = p && (p.id || p.label) ? { id: p.id || "", label: p.label || "" } : null; },
      isPinned: () => !!pref,
    };
  }

  // Call-time device watch (navigator.mediaDevices "devicechange"): re-publishes the list and,
  // when following the system default, rebuilds capture on the new default input.
  // Debounced because a Bluetooth connect fires several events in a row.
  function createMicFollow({ enumerateDevices, getLabel, isActive, isDead, onSwitch, publish, dlog, setTimeout: setT = setTimeout, clearTimeout: clearT = clearTimeout, debounceMs = 1000 }) {
    let timer = null;
    async function check() {
      timer = null;
      if (!enumerateDevices || !isActive()) return;
      let def = null;
      try { def = (await enumerateDevices()).find((d) => d.kind === "audioinput" && d.deviceId === "default"); } catch { return; }
      const cur = normLabel(getLabel());
      const want = def && normLabel(def.label);
      if (!isActive() || !cur || !want || want === cur || isDead(want)) return;
      dlog("mic_follow_default", { label: def.label, from: cur }); // main logs it as r:mic_follow_default
      onSwitch(def.label);
    }
    return {
      recheck: check,
      onDeviceChange() {
        publish();
        clearT(timer);
        timer = setT(check, debounceMs);
      },
    };
  }

  const micErrorCode = (err) => (err && (err.name === "NotAllowedError" || err.name === "SecurityError") ? "mic_denied" : "mic_failed");
  const errInfo = (e) => ({ name: e && e.name, message: String((e && e.message) || e || "").slice(0, 200), stack: e && e.stack ? String(e.stack).split("\n").slice(0, 4).join("\n") : "" });

  // Logs track mute/unmute/ended (a dead input keeps feeding zeros); returns its label.
  function watchTrack(t, dlog, onEnded) {
    if (!t) return "";
    const info = () => ({ muted: t.muted, state: t.readyState });
    t.onmute = () => dlog("track_mute", info());
    t.onunmute = () => dlog("track_unmute", info());
    t.onended = () => { dlog("track_ended", info()); if (onEnded) onEnded(t); };
    return t.label || "";
  }

  return { watchTrack, pickAlternate, resolvePreferred, createMicOpener, createMicFollow, isSkippable, normLabel, micErrorCode, errInfo };
});
