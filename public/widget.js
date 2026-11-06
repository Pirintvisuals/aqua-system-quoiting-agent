(function () {
  // Configuration with defaults for local development.
  //   apiUrl / assetsUrl  where the backend and the static files live
  //   autoOpenDelay       ms after load to open the chat once per visit
  //                       (desktop only); leave unset to never auto-open
  //   client              PostHog `client` tag
  const config = window.AQUA_CONFIG || {};
  const apiUrl = config.apiUrl || "/api/faq-agent";
  const assetsUrl = config.assetsUrl || ""; // e.g. "https://your-app.vercel.app"
  const PHONE = "+36 20 399 0093";
  const BRAND = "Aqua System";

  let chatOpen = false;
  let chatWindow = null;
  let messagesContainer = null;
  let inputElement = null;
  let sending = false;
  let conversationHistory = []; // [{ role: "user"|"assistant", content: "..." }]
  let convState = {}; // accumulated answer-state, carried turn-to-turn
  let started = false;
  let lastLead = null; // { sel, quote } — needed for the post-quote actions
  let thinkingEl = null;
  let progressFillEl = null, progressLabelEl = null, progressBarEl = null;
  let photoData = []; // compressed data URLs, sent with the contact form
  let container = null;

  // What is rendered, so a page reload can rebuild the chat as it was.
  let transcript = []; // [{ s: "bot"|"user", t: text, k?: "quote-price" }]
  let ui = null;       // the controls currently under the last message
  let progressSnap = null;

  // --- Analytics (PostHog) -------------------------------------------------
  // Every event carries a `client` super-property so one dashboard splits the
  // numbers per widget. No PII: inputs and the customer's bubbles are masked
  // in replays, and events only carry field NAMES / counts.
  // Local test runs stay out of the real numbers unless a key is passed in.
  const IS_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const POSTHOG_KEY = config.posthogKey !== undefined ? config.posthogKey
    : (IS_LOCAL ? "" : "phc_v8Kz9YKBCizrjV3vLzRxdiqvikGJpYy4FMET92Z8htpP");
  const POSTHOG_HOST = config.posthogHost || "https://eu.i.posthog.com";
  const CLIENT_ID = config.client || "aqua-system";
  const WIDGET_VERSION = "2026-10-02";
  const SESSION_REPLAY = config.sessionReplay !== false;

  let filledFields = [];
  let lastField = null;
  let lastProgress = 0, lastProgressTotal = 0;
  let quoteDone = false;
  let turns = 0;

  function track(event, props, options) {
    try {
      if (window.posthog && typeof window.posthog.capture === "function") {
        window.posthog.capture(event, props || {}, options);
      }
    } catch (e) {}
  }

  function initAnalytics() {
    if (!POSTHOG_KEY) return;
    if (window.posthog && window.posthog.__loaded) return; // host page already runs PostHog
    !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug getPageViewId".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
    try {
      window.posthog.init(POSTHOG_KEY, {
        api_host: POSTHOG_HOST,
        capture_pageview: false,
        autocapture: false,
        disable_session_recording: !SESSION_REPLAY,
        session_recording: {
          maskAllInputs: true,
          maskTextSelector: ".faq-msg.user .faq-bubble, .faq-photo-thumbs, .ph-no-capture",
        },
      });
      window.posthog.register({
        client: CLIENT_ID,
        widget_version: WIDGET_VERSION,
        page: location.pathname,
      });
    } catch (e) {}
  }

  // One question_answered per newly filled field (names only, never values).
  function noteStateChange(prevState, data) {
    const isFilled = (s, k) => s && s[k] != null && String(s[k]).trim() !== "";
    const newly = Object.keys(convState || {}).filter(
      (k) => isFilled(convState, k) && !isFilled(prevState, k) && filledFields.indexOf(k) === -1
    );
    if (typeof data.progress === "number" && typeof data.progressTotal === "number") {
      lastProgress = data.progress;
      lastProgressTotal = data.progressTotal;
    }
    newly.forEach((field) => {
      filledFields.push(field);
      lastField = field;
      track("question_answered", { field, step: filledFields.length, answered: lastProgress, total: lastProgressTotal });
    });
    if (!newly.length && !data.lead) track("message_unmatched", { after_field: lastField, answered: lastProgress });
  }

  function funnelSnapshot() {
    return {
      last_field: lastField,
      fields_answered: filledFields.length,
      answered: lastProgress,
      total: lastProgressTotal,
      turns,
      completed: quoteDone,
    };
  }

  let leftSent = false;
  function onLeave() {
    if (leftSent || !started) return;
    leftSent = true;
    track("widget_left", funnelSnapshot(), { transport: "sendBeacon" });
  }
  window.addEventListener("pagehide", onLeave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") onLeave();
    else leftSent = false;
  });

  // --- Persistence -----------------------------------------------------------
  // A reload or a click to another page of the site must not wipe a half
  // finished quote. sessionStorage: survives navigation within the tab, gone
  // when the tab closes. Every access is guarded — it can throw in private
  // windows or with storage blocked, and the widget must work regardless.
  const STORE_KEY = "aqua-chat-v2";
  const PHOTO_KEY = "aqua-chat-v2-photos";

  function save() {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify({
        transcript, ui, convState, conversationHistory, lastLead, progressSnap,
        quoteDone, filledFields, lastField, turns,
      }));
    } catch (e) {}
  }
  function savePhotos() {
    try { sessionStorage.setItem(PHOTO_KEY, JSON.stringify(photoData)); } catch (e) {}
  }
  function load() {
    try {
      const raw = sessionStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      return d && Array.isArray(d.transcript) && d.transcript.length ? d : null;
    } catch (e) { return null; }
  }
  const saved = load();

  // --- Inline SVG icons (no emojis used as UI icons) ---
  const ICON = {
    chat: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
    phone: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    mail: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    write: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    camera: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    shield: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  };

  function logoSrc() {
    return assetsUrl ? `${assetsUrl}/logo.webp` : "logo.webp";
  }

  function injectStyles() {
    if (document.getElementById("faq-agent-styles")) return;
    const link = document.createElement("link");
    link.id = "faq-agent-styles";
    link.rel = "stylesheet";
    link.href = assetsUrl ? `${assetsUrl}/style.css` : "style.css";
    document.head.appendChild(link);
  }

  function createContainer() {
    container = document.createElement("div");
    container.id = "faq-agent-container";
    document.body.appendChild(container);
  }

  function createLauncher() {
    if (!container) createContainer();

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "faq-chat-launcher";
    btn.setAttribute("aria-label", `Csevegés megnyitása — ${BRAND}`);
    btn.innerHTML = `<span class="faq-launcher-ring" aria-hidden="true"></span>${ICON.chat}<span class="faq-launcher-dot" aria-hidden="true"></span>`;
    btn.onclick = toggleChat;
    container.appendChild(btn);

    // A visitor who already started a quote gets ONE teaser: pick up where
    // they left off. Everyone else gets the rotating ones.
    const resuming = saved && !saved.quoteDone;
    const TEASERS = resuming
      ? ["Folytassa az árajánlatot ott, ahol abbahagyta."]
      : [
        "Üdv! Kérjen pár kattintással ingyenes árajánlatot kazáncserére.",
        "Egynapos gázkészülék csere. Nézze meg, mennyibe kerül.",
        "Régi kazánját cserélné? Számoljon árat egy perc alatt.",
        "Melyik kondenzációs kazán illik a lakásához? Segítek.",
        "Kondenzációs kazán ára beszereléssel, nézze meg most.",
        "Kérdése van a fűtésről? Írjon, azonnal válaszolok.",
        "Csere egyetlen nap alatt. Kérjen árajánlatot itt.",
        "Hányan laknak Önöknél? Megmondom, mekkora kazán kell.",
        "Ingyenes, kötelezettség nélküli árajánlat, kezdjük el!",
      ];
    let teaserIdx = 0;
    let teaserTimer = null;
    let teaserDismissed = false;

    const tooltip = document.createElement("div");
    tooltip.className = "faq-chat-tooltip";
    tooltip.setAttribute("role", "button");
    tooltip.setAttribute("tabindex", "0");
    tooltip.innerHTML = `<span class="faq-tooltip-text">${TEASERS[0]}</span>`;
    const teaserText = tooltip.querySelector(".faq-tooltip-text");

    function stopTeaserRotation() {
      if (teaserTimer) { clearInterval(teaserTimer); teaserTimer = null; }
    }
    function rotateTeaser() {
      if (teaserDismissed || chatOpen) return;
      teaserIdx = (teaserIdx + 1) % TEASERS.length;
      teaserText.style.opacity = "0";
      setTimeout(() => {
        teaserText.textContent = TEASERS[teaserIdx];
        teaserText.style.opacity = "1";
      }, 280);
    }

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "faq-tooltip-close";
    closeBtn.setAttribute("aria-label", "Buborék bezárása");
    closeBtn.innerHTML = "&times;";
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      teaserDismissed = true;
      stopTeaserRotation();
      tooltip.classList.remove("show");
      setTimeout(() => tooltip.classList.add("hidden"), 300);
    };

    tooltip.appendChild(closeBtn);
    const openFromTooltip = () => {
      stopTeaserRotation();
      tooltip.classList.remove("show");
      setTimeout(() => tooltip.classList.add("hidden"), 300);
      if (!chatOpen) toggleChat();
    };
    tooltip.onclick = openFromTooltip;
    tooltip.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFromTooltip(); } };

    container.appendChild(tooltip);
    setTimeout(() => {
      if (teaserDismissed || chatOpen) return;
      tooltip.classList.add("show");
      if (TEASERS.length > 1) teaserTimer = setInterval(rotateTeaser, 9000);
    }, 1600);
  }

  function toggleChat() {
    const tooltip = document.querySelector(".faq-chat-tooltip");
    const launcher = document.querySelector(".faq-chat-launcher");

    if (chatOpen) {
      const w = chatWindow;
      w.classList.add("closing");
      setTimeout(() => {
        if (w) { w.style.display = "none"; w.classList.remove("closing"); }
      }, 180);
      chatOpen = false;
      track("chat_closed", funnelSnapshot());
      if (launcher) launcher.classList.remove("active");
    } else {
      if (tooltip) {
        tooltip.classList.remove("show");
        setTimeout(() => tooltip.classList.add("hidden"), 300);
      }
      if (!chatWindow) {
        openChat();
      } else {
        chatWindow.style.display = "flex";
        chatWindow.style.animation = "none";
        void chatWindow.offsetWidth;
        chatWindow.style.animation = "";
        scrollToBottom();
        setTimeout(() => inputElement && inputElement.focus(), 120);
      }
      chatOpen = true;
      track("chat_opened", { turns });
      if (launcher) launcher.classList.add("active");
    }
  }

  function openChat() {
    chatWindow = document.createElement("div");
    chatWindow.className = "faq-chat-window";
    chatWindow.setAttribute("role", "dialog");
    chatWindow.setAttribute("aria-label", `${BRAND} árajánló asszisztens`);

    // ---- Header ----
    const header = document.createElement("div");
    header.className = "faq-chat-header";

    const logo = document.createElement("img");
    logo.src = logoSrc();
    logo.alt = BRAND;
    logo.className = "faq-header-logo";

    const textBlock = document.createElement("div");
    textBlock.className = "faq-header-text";
    textBlock.innerHTML =
      `<span class="faq-header-title">${BRAND}</span>` +
      `<span class="faq-header-status"><span class="faq-status-dot" aria-hidden="true"></span>Azonnal válaszol</span>`;

    const actions = document.createElement("div");
    actions.className = "faq-header-actions";

    const phone = document.createElement("a");
    phone.className = "faq-header-phone";
    phone.href = `tel:${PHONE.replace(/\s/g, "")}`;
    phone.setAttribute("aria-label", `Hívás: ${PHONE}`);
    phone.innerHTML = `${ICON.phone}<span>${PHONE}</span>`;
    phone.onclick = () => track("phone_clicked", funnelSnapshot());

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "faq-header-close";
    closeBtn.setAttribute("aria-label", "Csevegés bezárása");
    closeBtn.innerHTML = ICON.close;
    closeBtn.onclick = toggleChat;

    actions.appendChild(phone);
    actions.appendChild(closeBtn);
    header.appendChild(logo);
    header.appendChild(textBlock);
    header.appendChild(actions);

    // ---- Progress bar ----
    const progress = document.createElement("div");
    progress.className = "faq-progress";
    progress.innerHTML =
      '<div class="faq-progress-track"><div class="faq-progress-fill"></div></div>' +
      '<span class="faq-progress-label"></span>';
    progressBarEl = progress;
    progressFillEl = progress.querySelector(".faq-progress-fill");
    progressLabelEl = progress.querySelector(".faq-progress-label");

    // ---- Messages ----
    messagesContainer = document.createElement("div");
    messagesContainer.className = "faq-chat-messages";
    messagesContainer.setAttribute("role", "log");
    messagesContainer.setAttribute("aria-live", "polite");

    // ---- Input ----
    const inputBar = document.createElement("form");
    inputBar.className = "faq-chat-input";
    inputBar.onsubmit = (e) => { e.preventDefault(); sendMessage(); };

    inputElement = document.createElement("input");
    inputElement.type = "text";
    inputElement.className = "faq-input-field";
    inputElement.setAttribute("aria-label", "Írja be a válaszát");
    inputElement.placeholder = "Írja be a válaszát – vagy kérdezzen bátran…";
    inputElement.autocomplete = "off";

    const sendBtn = document.createElement("button");
    sendBtn.type = "submit";
    sendBtn.className = "faq-send-btn";
    sendBtn.setAttribute("aria-label", "Küldés");
    sendBtn.innerHTML = ICON.send;

    inputBar.appendChild(inputElement);
    inputBar.appendChild(sendBtn);

    const inputHint = document.createElement("div");
    inputHint.className = "faq-input-hint";
    inputHint.innerHTML = `${ICON.write}<span>Most Önön a sor — kérjük, írja be a válaszát, majd nyomjon Entert.</span>`;

    const questionHint = document.createElement("div");
    questionHint.className = "faq-question-hint";
    questionHint.textContent = "Kérdezzen bátran – pl. árakról, márkákról, garanciáról, határidőkről";

    const inputWrap = document.createElement("div");
    inputWrap.className = "faq-input-wrap";
    inputWrap.appendChild(inputHint);
    inputWrap.appendChild(inputBar);

    chatWindow.appendChild(header);
    chatWindow.appendChild(progress);
    chatWindow.appendChild(messagesContainer);
    chatWindow.appendChild(questionHint);
    chatWindow.appendChild(inputWrap);
    container.appendChild(chatWindow);
    setTimeout(() => inputElement && inputElement.focus(), 150);

    if (started) return;
    started = true;

    if (saved) {
      restore(saved);
      track("chat_restored", funnelSnapshot());
      return;
    }

    track("quote_started");
    addMessage("bot", `Üdvözlöm az **${BRAND}** árajánló asszisztensénél!\n\n• **8 rövid kérdés**, körülbelül egy perc\n• A végén **azonnal látja az induló árat**\n• Közben **bármit kérdezhet** – ár, márkák, garancia`);
    startQuote();
  }

  // The first question comes straight from the backend template — no model
  // call and no hidden fake user message.
  async function startQuote() {
    sending = true;
    addThinking();
    try {
      const data = await postApi({ action: "start" });
      removeThinking();
      handleReply(data, { hidden: true });
    } catch (e) {
      removeThinking();
      addMessage("bot", `Elnézést, nem sikerült kapcsolódni. Kérem, próbálja újra később, vagy hívjon: **${PHONE}**`);
    } finally {
      sending = false;
    }
  }

  function restore(d) {
    convState = d.convState || {};
    conversationHistory = d.conversationHistory || [];
    lastLead = d.lastLead || null;
    quoteDone = !!d.quoteDone;
    filledFields = d.filledFields || [];
    lastField = d.lastField || null;
    turns = d.turns || 0;
    try { photoData = JSON.parse(sessionStorage.getItem(PHOTO_KEY) || "[]") || []; } catch (e) { photoData = []; }
    (d.transcript || []).forEach((m) => addMessage(m.s, m.t, m.k));
    if (d.progressSnap) updateProgress(d.progressSnap[0], d.progressSnap[1]);
    renderUi(d.ui);
  }

  function renderMarkdown(text) {
    const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const inline = (s) =>
      esc(s)
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+|tel:[^)\s]+|mailto:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

    let html = "";
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line === "") { html += '<div class="faq-sp"></div>'; continue; }
      if (line.startsWith("## ")) { html += '<div class="faq-sec">' + inline(line.slice(3)) + "</div>"; continue; }
      if (line.startsWith(">> ")) { html += '<div class="faq-total">' + inline(line.slice(3)) + "</div>"; continue; }
      if (line.startsWith("•")) { html += '<div class="faq-li">' + inline(line) + "</div>"; continue; }
      if (/^\*\*.*\*\*:?$/.test(line)) { html += '<div class="faq-h">' + inline(line) + "</div>"; continue; }
      html += '<div class="faq-p">' + inline(line) + "</div>";
    }
    return html;
  }

  function clearChips() {
    messagesContainer.querySelectorAll(".faq-chips").forEach((c) => c.remove());
  }

  function setInputMode(typeMode) {
    if (!chatWindow) return;
    chatWindow.classList.toggle("type-mode", typeMode);
    if (inputElement) {
      inputElement.placeholder = typeMode ? "Írja ide a válaszát…" : "Válasszon fent, vagy írjon ide…";
      if (typeMode) setTimeout(() => inputElement && inputElement.focus(), 80);
    }
  }

  function makeChip(label) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "faq-chip";
    chip.textContent = label;
    return chip;
  }

  // Answer buttons. The one that fits the household (backend decides) gets a
  // highlight and an "ajánlott" tag — the click still sends the plain label.
  function renderChips(chips, recommended) {
    clearChips();
    if (!chips || !chips.length) return;
    const wrap = document.createElement("div");
    wrap.className = "faq-chips";
    chips.forEach((label) => {
      const chip = makeChip(label);
      if (label === recommended) {
        chip.classList.add("faq-chip-rec");
        const tag = document.createElement("span");
        tag.className = "faq-chip-tag";
        tag.textContent = "ajánlott";
        chip.appendChild(tag);
      }
      chip.onclick = () => { clearChips(); sendMessage(label); };
      wrap.appendChild(chip);
    });
    messagesContainer.appendChild(wrap);
    scrollToBottom();
  }

  // Rebuild whichever controls belong under the last message.
  function renderUi(u) {
    ui = u || null;
    if (!u) { setInputMode(false); return; }
    if (u.type === "chips") { renderChips(u.chips, u.recommended); setInputMode(!u.chips.length); }
    else if (u.type === "photo") { renderPhotoStep(); setInputMode(false); }
    else if (u.type === "contact") { renderContactForm(); setInputMode(false); }
    else if (u.type === "post") { renderPostQuote(u.post); setInputMode(false); }
    else setInputMode(false);
  }

  // --- Photo step --------------------------------------------------------
  // Optional. Photos are shrunk to <=1600px JPEG in the browser (a phone photo
  // goes from ~4 MB to ~250 KB) and only sent with the contact form, where
  // they ride along to the owner's e-mail as attachments.
  const MAX_PHOTOS = 3;

  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const max = 1600;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          URL.revokeObjectURL(url);
          resolve(canvas.toDataURL("image/jpeg", 0.72));
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
      img.src = url;
    });
  }

  function renderPhotoStep() {
    clearChips();
    const box = document.createElement("div");
    box.className = "faq-chips faq-form faq-photo";

    const thumbs = document.createElement("div");
    thumbs.className = "faq-photo-thumbs";

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.multiple = true;
    fileInput.hidden = true;

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "faq-photo-add";
    addBtn.innerHTML = `${ICON.camera}<span>Fotó hozzáadása</span>`;
    addBtn.onclick = () => fileInput.click();

    const status = document.createElement("div");
    status.className = "faq-form-note";

    const actionsRow = document.createElement("div");
    actionsRow.className = "faq-photo-actions";

    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.className = "faq-form-submit";

    const skip = makeChip("Kihagyom");
    skip.onclick = () => {
      photoData = []; savePhotos();
      track("photo_skipped");
      clearChips();
      sendMessage("Kihagyom");
    };

    function refresh() {
      thumbs.innerHTML = "";
      photoData.forEach((src, i) => {
        const t = document.createElement("div");
        t.className = "faq-photo-thumb";
        t.innerHTML = `<img src="${src}" alt="Fotó ${i + 1}">`;
        const rm = document.createElement("button");
        rm.type = "button";
        rm.setAttribute("aria-label", "Fotó törlése");
        rm.innerHTML = "&times;";
        rm.onclick = () => { photoData.splice(i, 1); savePhotos(); refresh(); };
        t.appendChild(rm);
        thumbs.appendChild(t);
      });
      addBtn.style.display = photoData.length >= MAX_PHOTOS ? "none" : "";
      sendBtn.style.display = photoData.length ? "" : "none";
      sendBtn.textContent = `Tovább ${photoData.length} fotóval`;
      status.textContent = photoData.length ? "" : `Legfeljebb ${MAX_PHOTOS} fotó. Mobilon közvetlenül a kamerával is fotózhat.`;
    }

    fileInput.onchange = async () => {
      const files = Array.from(fileInput.files || []).slice(0, MAX_PHOTOS - photoData.length);
      fileInput.value = "";
      if (!files.length) return;
      status.textContent = "Fotók feldolgozása…";
      for (const f of files) {
        try { photoData.push(await compressImage(f)); }
        catch (e) { track("photo_failed"); }
      }
      savePhotos();
      refresh();
      scrollToBottom();
    };

    sendBtn.onclick = () => {
      if (!photoData.length) return;
      track("photo_added", { count: photoData.length });
      clearChips();
      sendMessage(`${photoData.length} fotót csatoltam`);
    };

    actionsRow.appendChild(addBtn);
    actionsRow.appendChild(skip);
    box.appendChild(thumbs);
    box.appendChild(actionsRow);
    box.appendChild(sendBtn);
    box.appendChild(status);
    box.appendChild(fileInput);
    messagesContainer.appendChild(box);
    refresh();
    scrollToBottom();
  }

  // --- Contact form --------------------------------------------------------
  // Ferenc's four contact fields, all required, in his order.
  const CONTACT_FIELDS = [
    { key: "name", label: "Név", type: "text", ph: "Kovács Anna", auto: "name",
      err: "Kérjük, adja meg a nevét.",
      ok: (v) => v.trim().length >= 2 },
    { key: "email", label: "E-mail", type: "email", ph: "anna@example.hu", auto: "email",
      err: "Ez az e-mail cím nem tűnik helyesnek.",
      ok: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) },
    { key: "phone", label: "Telefonszám", type: "tel", ph: "+36 30 123 4567", auto: "tel",
      err: "Kérjük, adjon meg egy elérhető telefonszámot.",
      ok: (v) => (v.replace(/\D/g, "").length >= 7) },
    { key: "postal_code", label: "Irányítószám", type: "text", ph: "1117", auto: "postal-code",
      err: "Az irányítószám 4 számjegy.",
      ok: (v) => /^\d{4}$/.test(v.trim()) },
  ];

  function renderContactForm() {
    clearChips();
    track("contact_form_shown", funnelSnapshot());
    const form = document.createElement("form");
    form.className = "faq-chips faq-form";
    form.noValidate = true;

    const title = document.createElement("div");
    title.className = "faq-form-title";
    title.textContent = "Hova küldjük az árajánlatot?";
    form.appendChild(title);

    const inputs = {};
    CONTACT_FIELDS.forEach((f) => {
      const row = document.createElement("div");
      row.className = "faq-form-row";
      const id = "faq-f-" + f.key;
      const label = document.createElement("label");
      label.setAttribute("for", id);
      label.textContent = f.label;
      const input = document.createElement("input");
      input.id = id;
      input.type = f.type;
      input.placeholder = f.ph;
      input.autocomplete = f.auto;
      if (f.key === "postal_code") { input.inputMode = "numeric"; input.maxLength = 4; }
      const err = document.createElement("div");
      err.className = "faq-form-err";
      err.textContent = f.err;
      input.addEventListener("input", () => { row.classList.remove("showerr"); input.classList.remove("invalid"); });
      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(err);
      form.appendChild(row);
      inputs[f.key] = { input, row };
    });

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "faq-form-submit";
    submit.textContent = "Árajánlat kérése";
    form.appendChild(submit);

    const note = document.createElement("div");
    note.className = "faq-form-note";
    note.textContent = "Az adatait csak az ajánlathoz és a felmérés egyeztetéséhez használjuk.";
    form.appendChild(note);

    form.onsubmit = (e) => {
      e.preventDefault();
      if (sending) return;
      let firstBad = null;
      const values = {};
      CONTACT_FIELDS.forEach((f) => {
        const { input, row } = inputs[f.key];
        const v = input.value;
        if (!f.ok(v)) {
          row.classList.add("showerr");
          input.classList.add("invalid");
          if (!firstBad) firstBad = input;
        } else if (v.trim()) {
          values[f.key] = v.trim();
        }
      });
      if (firstBad) { track("contact_form_invalid", { field: firstBad.id.replace("faq-f-", "") }); firstBad.focus(); return; }
      track("contact_form_submitted", { with_email: !!values.email });

      // The backend sees the state is complete and prices it without a model call.
      convState = Object.assign({}, convState, values);
      submit.disabled = true;
      sendMessage([values.name, values.email, values.phone, values.postal_code].join(" · "));
    };

    messagesContainer.appendChild(form);
    scrollToBottom();
    const first = inputs.name && inputs.name.input;
    if (first) setTimeout(() => first.focus(), 120);
  }

  // --- After the quote: warranty, survey booking, e-mail copy ----------------
  const HU_DAYS = ["vasárnap", "hétfő", "kedd", "szerda", "csütörtök", "péntek", "szombat"];
  const HU_DAY_ABBR = ["V", "H", "K", "Sze", "Cs", "P", "Szo"];
  const HU_MONTHS = ["jan.", "febr.", "márc.", "ápr.", "máj.", "jún.", "júl.", "aug.", "szept.", "okt.", "nov.", "dec."];

  // The next 8 working days, starting tomorrow.
  function nextWorkingDays(n) {
    const out = [];
    const d = new Date();
    while (out.length < n) {
      d.setDate(d.getDate() + 1);
      const wd = d.getDay();
      if (wd === 0 || wd === 6) continue;
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      out.push({ iso, label: `${HU_MONTHS[d.getMonth()]} ${d.getDate()}. (${HU_DAYS[wd]})`, abbr: HU_DAY_ABBR[wd], date: `${HU_MONTHS[d.getMonth()]} ${d.getDate()}.` });
    }
    return out;
  }

  function renderPostQuote(post) {
    clearChips();
    if (!post) return;
    const card = document.createElement("div");
    card.className = "faq-chips faq-form faq-post";

    // Warranty: chosen here, on the finished quote, where the price is visible.
    if (!post.booked) {
      const wTitle = document.createElement("div");
      wTitle.className = "faq-form-title faq-post-title";
      wTitle.innerHTML = `${ICON.shield}<span>Garancia a készülékre</span>`;
      card.appendChild(wTitle);
      const seg = document.createElement("div");
      seg.className = "faq-seg";
      (post.warrantyOptions || []).forEach((o) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "faq-seg-btn" + (o.value === post.warranty ? " active" : "");
        b.innerHTML = `<span>${o.label}</span><small>${o.extra}</small>`;
        b.onclick = () => changeWarranty(o.value, post);
        seg.appendChild(b);
      });
      card.appendChild(seg);
    }

    // Survey booking: a requested slot, confirmed by phone (no live calendar).
    const bTitle = document.createElement("div");
    bTitle.className = "faq-form-title faq-post-title";
    bTitle.innerHTML = `${ICON.calendar}<span>Ingyenes felmérés — mikor jöhetünk?</span>`;
    card.appendChild(bTitle);

    if (post.booked) {
      const done = document.createElement("div");
      done.className = "faq-post-done";
      done.innerHTML = `${ICON.check}<span>Időpont kérve: ${post.booked}</span>`;
      card.appendChild(done);
    } else {
      const days = nextWorkingDays(8);
      let pickedDay = null, pickedWindow = null;
      const dayGrid = document.createElement("div");
      dayGrid.className = "faq-day-grid";
      days.forEach((d) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "faq-day";
        b.innerHTML = `<span>${d.abbr}</span><small>${d.date}</small>`;
        b.title = d.label;
        b.setAttribute("aria-label", d.label);
        b.onclick = () => {
          pickedDay = d;
          dayGrid.querySelectorAll(".faq-day").forEach((x) => x.classList.toggle("active", x === b));
          check();
        };
        dayGrid.appendChild(b);
      });
      card.appendChild(dayGrid);

      const winRow = document.createElement("div");
      winRow.className = "faq-seg faq-seg-sm";
      [["delelott", "Délelőtt"], ["delutan", "Délután"], ["barmikor", "Bármikor"]].forEach(([v, l]) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "faq-seg-btn";
        b.textContent = l;
        b.onclick = () => {
          pickedWindow = v;
          winRow.querySelectorAll(".faq-seg-btn").forEach((x) => x.classList.toggle("active", x === b));
          check();
        };
        winRow.appendChild(b);
      });
      card.appendChild(winRow);

      const book = document.createElement("button");
      book.type = "button";
      book.className = "faq-form-submit";
      book.textContent = "Felmérés kérése";
      book.disabled = true;
      function check() { book.disabled = !(pickedDay && pickedWindow); }
      book.onclick = () => bookSurvey(pickedDay, pickedWindow, post, book);
      card.appendChild(book);

      const note = document.createElement("div");
      note.className = "faq-form-note";
      note.textContent = "Kollégánk telefonon visszaigazolja az időpontot. Ha nem jó, egyeztet egy másikat.";
      card.appendChild(note);
    }

    if (post.emailOffer && !post.emailed) {
      const mailBtn = document.createElement("button");
      mailBtn.type = "button";
      mailBtn.className = "faq-chip faq-post-mail";
      mailBtn.innerHTML = `${ICON.mail}<span>Elküldjük e-mailben is</span>`;
      mailBtn.onclick = () => { track("email_requested"); requestEmail(post); };
      card.appendChild(mailBtn);
    }

    messagesContainer.appendChild(card);
    scrollToBottom();
  }

  async function changeWarranty(value, post) {
    if (sending || !lastLead || value === post.warranty) return;
    sending = true;
    try {
      const data = await postApi({ action: "set_warranty", warranty: value, lead: lastLead });
      if (!data || !data.lead) throw new Error("bad reply");
      lastLead = data.lead;
      post.warranty = value;
      track("warranty_changed", { warranty: value });
      // Rewrite the price bubble in place, so there is only ever one total.
      const idx = transcript.findIndex((m) => m.k === "quote-price");
      const el = messagesContainer.querySelector('[data-kind="quote-price"] .faq-bubble');
      if (idx >= 0) transcript[idx].t = data.answer;
      if (el) {
        el.innerHTML = renderMarkdown(data.answer);
        el.classList.remove("faq-flash"); void el.offsetWidth; el.classList.add("faq-flash");
      }
      renderUi({ type: "post", post });
      save();
    } catch (e) {
      addMessage("bot", `Elnézést, ezt most nem sikerült módosítani. A garanciát a felmérésen is kiválaszthatja.`);
    } finally {
      sending = false;
    }
  }

  async function bookSurvey(day, windowKey, post, btn) {
    if (sending || !lastLead || !day || !windowKey) return;
    sending = true;
    btn.disabled = true;
    addThinking();
    try {
      const data = await postApi({ action: "book_survey", lead: lastLead, booking: { date: day.iso, dayLabel: day.label, window: windowKey } });
      removeThinking();
      if (!data || !data.answer) throw new Error("bad reply");
      track("booking_requested", { window: windowKey, days_ahead: nextWorkingDays(8).findIndex((d) => d.iso === day.iso) + 1 });
      post.booked = `${day.label}, ${windowKey === "delelott" ? "délelőtt" : windowKey === "delutan" ? "délután" : "bármikor"}`;
      clearChips();
      addMessage("bot", data.answer);
      renderUi({ type: "post", post });
      save();
    } catch (e) {
      removeThinking();
      btn.disabled = false;
      addMessage("bot", `Elnézést, most nem sikerült elküldeni. Kérem, próbálja újra, vagy hívjon: **${PHONE}**`);
    } finally {
      sending = false;
    }
  }

  async function requestEmail(post) {
    if (sending || !lastLead) return;
    sending = true;
    addThinking();
    try {
      const data = await postApi({ action: "email_customer", lead: lastLead });
      removeThinking();
      post.emailed = true;
      clearChips();
      addMessage("bot", (data && data.answer) || "Elküldtük az ajánlatot a megadott e-mail címre.");
      renderUi({ type: "post", post });
      save();
    } catch (e) {
      removeThinking();
      addMessage("bot", "Sajnos most nem sikerült e-mailt küldeni. Kérjük, próbálja később.");
    } finally {
      sending = false;
    }
  }

  function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // kind: optional tag ("quote-price") so a message can be found and rewritten.
  function addMessage(sender, text, kind) {
    const msg = document.createElement("div");
    msg.className = "faq-msg " + sender;
    if (kind) msg.dataset.kind = kind;

    if (sender === "bot") {
      const avatar = document.createElement("img");
      avatar.className = "faq-avatar";
      avatar.src = logoSrc();
      avatar.alt = "";
      avatar.setAttribute("aria-hidden", "true");
      msg.appendChild(avatar);
    }

    const bubble = document.createElement("div");
    bubble.className = "faq-bubble";
    if (sender === "bot") bubble.innerHTML = renderMarkdown(text);
    else bubble.textContent = text;

    msg.appendChild(bubble);
    messagesContainer.appendChild(msg);
    transcript.push(kind ? { s: sender, t: text, k: kind } : { s: sender, t: text });
    scrollToBottom();
    return msg;
  }

  function addThinking() {
    const msg = document.createElement("div");
    msg.className = "faq-msg bot";
    msg.innerHTML =
      `<img class="faq-avatar" src="${logoSrc()}" alt="" aria-hidden="true">` +
      `<div class="faq-bubble faq-typing"><span></span><span></span><span></span></div>`;
    messagesContainer.appendChild(msg);
    scrollToBottom();
    thinkingEl = msg;
  }

  function removeThinking() {
    if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  }

  function updateProgress(done, total) {
    if (!progressFillEl || !total) return;
    progressSnap = [done, total];
    const pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
    progressFillEl.style.width = pct + "%";
    if (progressLabelEl) progressLabelEl.textContent = pct + "%";
    if (progressBarEl) {
      progressBarEl.classList.add("visible");
      progressBarEl.classList.toggle("complete", done >= total);
    }
  }

  async function postApi(body) {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = new Error("http " + res.status);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  // Render one backend reply: the bubbles, then the right controls.
  function handleReply(data, opts) {
    const prevState = (opts && opts.prevState) || {};
    if (data.state && typeof data.state === "object") convState = data.state;
    try {
      if (!(opts && opts.hidden)) noteStateChange(prevState, data);
      if (data.lead && !quoteDone) {
        quoteDone = true;
        const qs = data.lead.quote || {};
        track("quote_completed", { fields_answered: filledFields.length, turns, quote_total: qs.total, photos: photoData.length });
      }
    } catch (e) {}
    if (typeof data.progress === "number" && typeof data.progressTotal === "number") {
      updateProgress(data.progress, data.progressTotal);
    }

    const parts = String(data.answer || "Elnézést, nem találtam választ.").split("[[SPLIT]]").map(s => s.trim()).filter(Boolean);
    parts.forEach((p, i) => addMessage("bot", p, data.lead && i === 0 ? "quote-price" : undefined));
    conversationHistory.push({ role: "assistant", content: parts.join("\n\n") });

    if (data.lead) {
      lastLead = data.lead;
      photoData = []; savePhotos(); // they went out with the owner e-mail
      renderUi({ type: "post", post: data.postQuote || {} });
    } else if (data.contactForm) {
      renderUi({ type: "contact" });
    } else if (data.photoStep) {
      renderUi({ type: "photo" });
    } else {
      renderUi({ type: "chips", chips: data.chips || [], recommended: data.recommendedChip || null });
    }
    save();
  }

  // text: message to send (typed, or a clicked chip label).
  async function sendMessage(presetText) {
    if (sending) return;
    const text = (presetText !== undefined ? presetText : (inputElement.value || "")).trim();
    if (!text) return;

    clearChips();
    addMessage("user", text);
    if (presetText === undefined) inputElement.value = "";
    sending = true;

    conversationHistory.push({ role: "user", content: text });
    turns++;
    track("message_sent", { via: presetText !== undefined ? "chip" : "typed", after_field: lastField });
    let prevState = {};
    try { prevState = Object.assign({}, convState); } catch (e) {}
    addThinking();

    try {
      const body = { question: text, history: conversationHistory, state: convState };
      // Photos only travel with the request that completes the quote.
      if (photoData.length && convState.name && convState.phone) body.photos = photoData;
      const data = await postApi(body);
      removeThinking();
      handleReply(data, { prevState });
    } catch (err) {
      removeThinking();
      track("widget_error", { kind: err && err.status ? "http" : "network", status: err && err.status, after_field: lastField });
      addMessage("bot", `Elnézést, hiba történt. Kérjük, próbálja újra, vagy hívjon: **${PHONE}**`);
      // Put the controls back so the customer is not stuck.
      renderUi(ui);
    } finally {
      sending = false;
    }
  }

  // --- Opening from outside ----------------------------------------------------
  //   window.AquaWidget.open()      any button on the host site
  //   ?ajanlat or #ajanlat in URL   direct link for Google profile, ads, QR codes
  //   AQUA_CONFIG.autoOpenDelay     opens once per visit, desktop only
  function open() { if (!chatOpen) toggleChat(); }
  function close() { if (chatOpen) toggleChat(); }
  window.AquaWidget = { open, close };

  function wantsDeepLink() {
    try {
      return new URLSearchParams(location.search).has("ajanlat") || /^#ajanlat\b/.test(location.hash);
    } catch (e) { return false; }
  }

  function scheduleAutoOpen() {
    const delay = Number(config.autoOpenDelay);
    if (!delay || saved) return;
    const desktop = window.matchMedia && window.matchMedia("(min-width: 768px)").matches;
    if (!desktop) return;
    let done = false;
    try { done = sessionStorage.getItem("aqua-auto-opened") === "1"; } catch (e) {}
    if (done) return;
    setTimeout(() => {
      if (chatOpen || started) return;
      try { sessionStorage.setItem("aqua-auto-opened", "1"); } catch (e) {}
      track("auto_opened");
      open();
    }, delay);
  }

  function init() {
    injectStyles();
    createLauncher();
    initAnalytics();
    track("widget_loaded", { resumed: !!saved });
    if (wantsDeepLink()) {
      track("deep_link_opened");
      open();
    } else {
      scheduleAutoOpen();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
