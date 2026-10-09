(() => {
  const profiles = Object.freeze({
    KAR_HOMER_CZ: Object.freeze({ lang: "cs-CZ", pitch: 0.72, rate: 0.9, volume: 1 }),
    KAR_NORMAL_CZ: Object.freeze({ lang: "cs-CZ", pitch: 1, rate: 1, volume: 1 }),
  });

  // UI depends only on this adapter contract. A future local TTS adapter can
  // replace BrowserSpeechOutput and keep the selector and chat UI unchanged.
  class BrowserSpeechOutput {
    constructor() {
      this.voices = [];
      this.refreshVoices();
      if ("speechSynthesis" in window) {
        window.speechSynthesis.addEventListener("voiceschanged", () => {
          this.refreshVoices();
          this.voicesChangedListener?.(this.getCzechVoices());
        });
      }
    }

    refreshVoices() {
      this.voices = "speechSynthesis" in window ? window.speechSynthesis.getVoices() : [];
    }

    getCzechVoices() {
      return this.voices.filter((voice) => voice.lang.toLowerCase().startsWith("cs"));
    }

    onVoicesChanged(callback) {
      this.voicesChangedListener = callback;
      callback(this.getCzechVoices());
    }

    speak(text, profileId, voiceURI = "") {
      if (!("speechSynthesis" in window) || !window.SpeechSynthesisUtterance) {
        throw new Error("Předčítání není v tomto prohlížeči dostupné.");
      }
      const profile = profiles[profileId] || profiles.KAR_HOMER_CZ;
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = profile.lang;
      utterance.pitch = profile.pitch;
      utterance.rate = profile.rate;
      utterance.volume = profile.volume;
      utterance.voice = this.selectCzechVoice(voiceURI);
      window.speechSynthesis.speak(utterance);
    }

    selectCzechVoice(voiceURI) {
      const czech = this.getCzechVoices();
      if (voiceURI) {
        const selected = czech.find((voice) => voice.voiceURI === voiceURI);
        if (selected) return selected;
      }
      // Prefer voices that explicitly identify as male; browser voice names
      // are inconsistent, so fall back to the first Czech voice available.
      return czech.find((voice) => /\b(male|muž|mužský)\b/i.test(voice.name)) || czech[0] || null;
    }

    cancel() {
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    }
  }

  class SpeechOutput {
    constructor() {
      this.browser = new BrowserSpeechOutput();
      this.audio = null;
      this.objectUrl = null;
      this.controller = null;
    }

    onVoicesChanged(callback) { this.browser.onVoicesChanged(callback); }
    getCzechVoices() { return this.browser.getCzechVoices(); }

    async speak(text, profileId, voiceURI = "") {
      this.cancel();
      const controller = new AbortController();
      this.controller = controller;
      try {
        const response = await fetch("/api/speech", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "audio/mpeg, audio/wav, audio/ogg" },
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
          body: JSON.stringify({ text: text.slice(0, 4000), profileId }),
        });
        if (!response.ok) throw new Error(response.status === 503 ? "Modelový český hlas zatím není nakonfigurován." : `TTS služba vrátila chybu ${response.status}.`);
        const blob = await response.blob();
        if (!blob.type.startsWith("audio/")) throw new Error("TTS služba nevrátila zvuk.");
        this.objectUrl = URL.createObjectURL(blob);
        this.audio = new Audio(this.objectUrl);
        this.audio.addEventListener("ended", () => this.revoke(), { once: true });
        this.audio.addEventListener("error", () => this.revoke(), { once: true });
        await this.audio.play();
        if (this.controller !== controller) return "cancelled";
        this.controller = null;
        return "model";
      } catch (error) {
        this.revoke();
        if (controller.signal.aborted) return "cancelled";
        if (this.controller === controller) this.controller = null;
        if (!("speechSynthesis" in window) || !window.SpeechSynthesisUtterance) throw error;
        this.browser.speak(text, profileId, voiceURI);
        return "browser-fallback";
      }
    }

    revoke() {
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
      this.audio = null;
    }

    cancel() {
      this.controller?.abort();
      this.controller = null;
      this.browser.cancel();
      if (this.audio) this.audio.pause();
      this.revoke();
    }
  }

  window.KarSpeechOutput = Object.freeze({ profiles, create: () => new SpeechOutput() });
})();
