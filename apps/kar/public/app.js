(() => {
  const form = document.querySelector("#chat-form");
  const input = document.querySelector("#prompt");
  const conversation = document.querySelector("#conversation");
  const sendButton = form.querySelector("button[type=submit]");
  const micButton = document.querySelector("#mic-button");
  const speakToggle = document.querySelector("#speak-toggle");
  const voiceProfile = document.querySelector("#voice-profile");
  const personalityProfile = document.querySelector("#personality-profile");
  const pepaRoastSetting = document.querySelector("#pepa-roast-setting");
  const pepaRoastEnabledInput = document.querySelector("#pepa-roast-enabled");
  const voiceChoice = document.querySelector("#voice-choice");
  const speechOutput = window.KarSpeechOutput.create();
  const toast = document.querySelector("#toast");
  let messages = [];
  let speaking = false;
  let pepaRoastEnabled = false;
  let recognition = null;
  let controller = null;
  try {
    const savedProfile = localStorage.getItem("kar-voice-profile");
    if (savedProfile && window.KarSpeechOutput.profiles[savedProfile]) voiceProfile.value = savedProfile;
    const savedPersonality = localStorage.getItem("kar-personality-profile");
    if (savedPersonality && ["KAR_STANDARD_CZ", "KAR_UNCENSORED_CZ"].includes(savedPersonality)) personalityProfile.value = savedPersonality;
    voiceChoice.dataset.saved = localStorage.getItem("kar-voice-uri") || "";
  } catch { /* Private browsing can disable storage; keep the default profile. */ }
  speechOutput.onVoicesChanged((voices) => {
    const saved = voiceChoice.dataset.saved || "";
    voiceChoice.replaceChildren(new Option("Automatický výběr", ""));
    for (const voice of voices) voiceChoice.add(new Option(voice.name, voice.voiceURI));
    if (voices.some((voice) => voice.voiceURI === saved)) voiceChoice.value = saved;
  });
  voiceProfile.addEventListener("change", () => {
    try { localStorage.setItem("kar-voice-profile", voiceProfile.value); } catch { /* Profile remains selected for this page. */ }
  });
  personalityProfile.addEventListener("change", () => {
    try { localStorage.setItem("kar-personality-profile", personalityProfile.value); } catch { /* Selected mode remains active for this page. */ }
  });
  pepaRoastEnabledInput.addEventListener("change", async () => {
    const requested = pepaRoastEnabledInput.checked;
    pepaRoastEnabledInput.disabled = true;
    try {
      const response = await fetch("/api/settings/pepa-roast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ enabled: requested }),
      });
      if (!response.ok) throw new Error(`Nastavení vrátilo chybu ${response.status}.`);
      pepaRoastEnabled = requested;
      notify(requested ? "Pepa Roast je zapnutý. Jen během této přihlášené relace." : "Pepa Roast je vypnutý.");
    } catch (error) {
      pepaRoastEnabledInput.checked = pepaRoastEnabled;
      notify(error.message);
    } finally {
      pepaRoastEnabledInput.disabled = false;
    }
  });

  fetch("/api/session", { credentials: "same-origin", cache: "no-store" }).then(async (response) => {
    if (!response.ok) return;
    const session = await response.json();
    if (!session.pepaRoastEligible) return;
    pepaRoastSetting.hidden = false;
    pepaRoastEnabled = session.pepaRoastEnabled === true;
    pepaRoastEnabledInput.checked = pepaRoastEnabled;
    if (pepaRoastEnabled && Math.random() < 0.25) {
      appendMessage("assistant", "Pepo, dneska jsi ještě nic nerozbil? To je podezřelý.");
    }
  }).catch(() => { /* Unavailable identity endpoint keeps personalized controls hidden and disabled. */ });
  voiceChoice.addEventListener("change", () => {
    try { localStorage.setItem("kar-voice-uri", voiceChoice.value); } catch { /* Device preference stays for this page. */ }
  });

  function notify(text) {
    toast.textContent = text;
    toast.classList.add("show");
    clearTimeout(notify.timeout);
    notify.timeout = setTimeout(() => toast.classList.remove("show"), 3600);
  }

  function appendMessage(role, text, pending = false) {
    const article = document.createElement("article");
    article.className = `message ${role}${pending ? " pending" : ""}`;
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = role === "assistant" ? "K" : "V";
    const copy = document.createElement("div");
    copy.className = "message-copy";
    const speaker = document.createElement("p");
    speaker.className = "speaker";
    speaker.textContent = role === "assistant" ? "KÁR" : "VY";
    const tag = document.createElement("time");
    tag.textContent = role === "assistant" ? "ASISTENT" : "ZPRÁVA";
    speaker.append(" ", tag);
    const content = document.createElement("p");
    content.textContent = text;
    copy.append(speaker, content);
    article.append(avatar, copy);
    conversation.append(article);
    conversation.scrollTop = conversation.scrollHeight;
    return { article, content };
  }

  async function readStream(response, target) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let answer = "";
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      const events = pending.split("\n\n");
      pending = events.pop() || "";
      for (const event of events) {
        const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        if (!data || data === "[DONE]") continue;
        let payload;
        try { payload = JSON.parse(data); } catch { continue; }
        const delta = payload.choices?.[0]?.delta?.content;
        if (typeof delta === "string") {
          answer += delta;
          target.textContent = answer;
          conversation.scrollTop = conversation.scrollHeight;
        }
      }
      if (done) break;
    }
    if (!answer) throw new Error("Model vrátil prázdnou odpověď.");
    return answer;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const prompt = input.value.trim();
    if (!prompt || sendButton.disabled) return;
    if (prompt.length > 8000) return notify("Zpráva je příliš dlouhá.");
    messages.push({ role: "user", content: prompt });
    appendMessage("user", prompt);
    input.value = "";
    sendButton.disabled = true;
    sendButton.querySelector("span").textContent = "Odpovídám";
    const output = appendMessage("assistant", "Přemýšlím…", true);
    controller = new AbortController();
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ messages: messages.slice(-20), personalityId: pepaRoastEnabled ? "KAR_PEPA_ROAST" : personalityProfile.value }),
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        output.content.textContent = "Relace vypršela. Obnovte stránku a přihlaste se přes Cloudflare Access.";
        output.article.classList.remove("pending");
        return;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Služba vrátila chybu ${response.status}.`);
      }
      const answer = await readStream(response, output.content);
      output.article.classList.remove("pending");
      messages.push({ role: "assistant", content: answer });
      if (speaking) {
        speechOutput.cancel();
        try {
          const outputKind = await speechOutput.speak(answer, voiceProfile.value, voiceChoice.value);
          if (outputKind === "browser-fallback") notify("Modelový TTS není dostupný; přehrávám přibližný hlas zařízení.");
        } catch (error) { notify(error.message); }
      }
    } catch (error) {
      if (error.name !== "AbortError") {
        output.content.textContent = "Odpověď se nepodařilo dokončit. " + error.message;
        output.article.classList.remove("pending");
      }
    } finally {
      controller = null;
      sendButton.disabled = false;
      sendButton.querySelector("span").textContent = "Odeslat";
      input.focus();
    }
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
    if (event.key === "Escape" && controller) controller.abort();
  });

  speakToggle.addEventListener("click", () => {
    speaking = !speaking;
    speakToggle.setAttribute("aria-pressed", String(speaking));
    speakToggle.setAttribute("aria-label", speaking ? "Vypnout předčítání odpovědí" : "Zapnout předčítání odpovědí");
    if (!speaking) speechOutput.cancel();
    notify(speaking ? "Předčítání odpovědí je zapnuté." : "Předčítání odpovědí je vypnuté.");
  });

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    micButton.disabled = true;
    micButton.title = "Rozpoznávání řeči není v tomto prohlížeči dostupné";
  } else {
    recognition = new SpeechRecognition();
    recognition.lang = "cs-CZ";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let text = "";
      for (let i = event.resultIndex; i < event.results.length; i++) text += event.results[i][0].transcript;
      input.value = text;
    };
    recognition.onerror = (event) => notify(`Diktování: ${event.error}`);
    recognition.onend = () => micButton.setAttribute("aria-pressed", "false");
    micButton.addEventListener("click", () => {
      try {
        if (micButton.getAttribute("aria-pressed") === "true") recognition.stop();
        else {
          recognition.start();
          micButton.setAttribute("aria-pressed", "true");
          notify("Poslouchám. Rozpoznání řeči zajišťuje váš prohlížeč.");
        }
      } catch { notify("Diktování se nepodařilo spustit."); }
    });
  }
})();
