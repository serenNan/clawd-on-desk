"use strict";

// Caption window renderer: shows the latest sentence, two lines max, fading out.
(function bootCaption() {
  const api = window.voiceCaption;
  const el = document.getElementById("voice-caption");
  if (!api || !el || !window.ClawdVoiceCaptions) return;
  const captions = window.ClawdVoiceCaptions.createCaptions({ el });
  api.onShow((payload) => captions.show(payload));
  api.onHide(() => el.classList.remove("show"));
})();
