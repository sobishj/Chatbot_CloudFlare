/*!
 * Website Assistant chat widget.
 * Embed: <script src="https://YOUR-DOMAIN/widget.js" data-client="CLIENT_ID" defer></script>
 *
 * - Everything renders inside a Shadow DOM, so the host page's CSS can't break the
 *   widget and the widget's CSS can't leak into the page.
 * - No dependencies, no cookies. The conversation is kept in sessionStorage so it
 *   survives navigation between pages of the same site.
 * - Exposes window.WebsiteAssistant.mount(options) (used by the admin live preview).
 */
(function () {
  "use strict";
  if (window.WebsiteAssistant && window.WebsiteAssistant.__loaded) return;

  var script = document.currentScript;
  var API_BASE = script && script.src ? new URL(script.src, location.href).origin : location.origin;

  var STRINGS = {
    en: { placeholder: "Type your question…", send: "Send", open: "Open chat", close: "Close chat", sources: "Sources", error: "Sorry, something went wrong. Please try again.", offline: "Sorry, I couldn't connect. Please check your internet connection and try again.", busy: "Too many messages. Please wait a moment.", title: "Chat", confirm: "Confirm", cancel: "Cancel" },
    ml: { placeholder: "നിങ്ങളുടെ ചോദ്യം ടൈപ്പ് ചെയ്യുക…", send: "അയയ്ക്കുക", open: "ചാറ്റ് തുറക്കുക", close: "ചാറ്റ് അടയ്ക്കുക", sources: "ഉറവിടങ്ങൾ", error: "ക്ഷമിക്കണം, ഒരു പിശക് സംഭവിച്ചു. വീണ്ടും ശ്രമിക്കുക.", offline: "ക്ഷമിക്കണം, കണക്റ്റ് ചെയ്യാൻ കഴിഞ്ഞില്ല. ഇന്റർനെറ്റ് കണക്ഷൻ പരിശോധിച്ച് വീണ്ടും ശ്രമിക്കുക.", busy: "ധാരാളം സന്ദേശങ്ങൾ. അൽപ്പസമയം കാത്തിരിക്കുക.", title: "ചാറ്റ്", confirm: "സ്ഥിരീകരിക്കുക", cancel: "റദ്ദാക്കുക" },
    hi: { placeholder: "अपना प्रश्न लिखें…", send: "भेजें", open: "चैट खोलें", close: "चैट बंद करें", sources: "स्रोत", error: "क्षमा करें, कुछ गलत हो गया। फिर से प्रयास करें।", offline: "क्षमा करें, कनेक्ट नहीं हो सका। अपना इंटरनेट कनेक्शन जांचें और फिर से प्रयास करें।", busy: "बहुत सारे संदेश। कृपया थोड़ी देर प्रतीक्षा करें।", title: "चैट", confirm: "पुष्टि करें", cancel: "रद्द करें" },
    ar: { placeholder: "اكتب سؤالك…", send: "إرسال", open: "فتح الدردشة", close: "إغلاق الدردشة", sources: "المصادر", error: "عذرًا، حدث خطأ. حاول مرة أخرى.", offline: "عذرًا، تعذّر الاتصال. تحقق من اتصالك بالإنترنت وحاول مرة أخرى.", busy: "رسائل كثيرة. يرجى الانتظار قليلًا.", title: "دردشة", confirm: "تأكيد", cancel: "إلغاء" },
    ta: { placeholder: "உங்கள் கேள்வியை தட்டச்சு செய்யவும்…", send: "அனுப்பு", open: "அரட்டையைத் திற", close: "அரட்டையை மூடு", sources: "ஆதாரங்கள்", error: "மன்னிக்கவும், பிழை ஏற்பட்டது. மீண்டும் முயலவும்.", offline: "மன்னிக்கவும், இணைக்க முடியவில்லை. இணைய இணைப்பைச் சரிபார்த்து மீண்டும் முயலவும்.", busy: "அதிக செய்திகள். சிறிது காத்திருக்கவும்.", title: "அரட்டை", confirm: "உறுதிப்படுத்து", cancel: "ரத்து செய்" }
  };

  // ------------------------------------------------------------------ helpers
  function storage() {
    try { var s = window.sessionStorage; s.setItem("__wa", "1"); s.removeItem("__wa"); return s; } catch (e) { return null; }
  }

  function randomId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "");
    var out = "";
    for (var i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16);
    return out;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function safeUrl(u) {
    try {
      var url = new URL(u, location.href);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch (e) { return null; }
  }

  // Minimal, safe formatting: escape everything, then add links, **bold** and lists.
  function formatText(text) {
    var lines = escapeHtml(text).split(/\r?\n/);
    var html = "", inList = false;
    lines.forEach(function (line) {
      var item = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (item) {
        if (!inList) { html += "<ul>"; inList = true; }
        html += "<li>" + inline(item[1]) + "</li>";
      } else {
        if (inList) { html += "</ul>"; inList = false; }
        html += line.trim() ? "<p>" + inline(line) + "</p>" : "";
      }
    });
    if (inList) html += "</ul>";
    return html;
  }

  function inline(s) {
    s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    return s.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]]/g, function (m) {
      var href = safeUrl(m.replace(/&amp;/g, "&"));
      return href ? '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' + m + "</a>" : m;
    });
  }

  // A size setting (percent of the screen), kept between 20 and 100.
  function pct(v, fallback) {
    var n = Math.round(Number(v));
    return isFinite(n) && n > 0 ? Math.min(100, Math.max(20, n)) : fallback;
  }

  function contrastText(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return "#ffffff";
    var n = parseInt(m[1], 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return lum > 0.6 ? "#111827" : "#ffffff";
  }

  // ------------------------------------------------------------------ styles
  // Phone layout, written once for real phones (vw/vh) and for the admin preview (% of the box).
  // The dvh copy is dropped by browsers that don't know dvh; it keeps the window above the keyboard.
  function phoneRules(sel, position, w, h) {
    return sel + " .panel{position:" + position + ";left:0;right:0;margin:0 auto;bottom:12px;" +
      "width:calc(var(--wa-mw,92) * " + w + ");min-width:0;max-width:calc(100 * " + w + ");" +
      "height:calc(var(--wa-mh,80) * " + h + ");min-height:min(320px,calc(100 * " + h + " - 24px));max-height:calc(100 * " + h + " - 24px);border-radius:16px}" +
      sel + " .panel.full{inset:0;margin:0;width:auto;height:auto;min-height:0;max-height:none;border:0;border-radius:0}";
  }

  var CSS = [
    ":host{all:initial}",
    "*,*::before,*::after{box-sizing:border-box}",
    ".wa{--wa-primary:#1f5f5b;--wa-on-primary:#fff;position:fixed;bottom:20px;z-index:2147483000;font:15px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,'Noto Sans','Noto Sans Malayalam',sans-serif;color:#1f2933}",
    ".wa.right{right:20px}.wa.left{left:20px}",
    ".bubble{width:58px;height:58px;border-radius:50%;border:0;cursor:pointer;background:var(--wa-primary);color:var(--wa-on-primary);box-shadow:0 6px 20px rgba(15,23,42,.25);display:grid;place-items:center;transition:transform .15s ease}",
    ".bubble:hover{transform:scale(1.05)}",
    ".bubble:focus-visible,.icon-btn:focus-visible,.send:focus-visible,textarea:focus-visible,a:focus-visible{outline:3px solid #2563eb;outline-offset:2px}",
    ".bubble svg{width:28px;height:28px}",
    // Size: --wa-w/--wa-h (desktop) and --wa-mw/--wa-mh (phones) are percentages of the screen,
    // set from the branding settings. Minimums keep the chat usable on small screens.
    ".panel{position:absolute;bottom:74px;width:calc(var(--wa-w,25) * 1vw);min-width:min(300px,calc(100vw - 40px));max-width:calc(100vw - 40px);height:calc(var(--wa-h,70) * 1vh);min-height:min(360px,calc(100vh - 110px));max-height:calc(100vh - 110px);background:#fff;border-radius:16px;box-shadow:0 18px 50px rgba(15,23,42,.28);display:flex;flex-direction:column;overflow:hidden;border:1px solid rgba(15,23,42,.08)}",
    ".wa.right .panel{right:0}.wa.left .panel{left:0}",
    ".panel[hidden]{display:none}",
    ".head{background:var(--wa-primary);color:var(--wa-on-primary);padding:14px 14px 14px 16px;display:flex;align-items:center;gap:10px}",
    ".logo{width:34px;height:34px;border-radius:8px;background:#fff;object-fit:contain;padding:3px;flex:none}",
    ".name{font-weight:600;font-size:16px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".icon-btn{background:transparent;border:0;color:inherit;cursor:pointer;width:34px;height:34px;border-radius:8px;display:grid;place-items:center}",
    ".icon-btn:hover{background:rgba(255,255,255,.15)}",
    ".log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;background:#f7f8fa}",
    ".msg{max-width:86%;padding:10px 13px;border-radius:14px;word-wrap:break-word;overflow-wrap:anywhere}",
    ".msg p{margin:0 0 6px}.msg p:last-child{margin:0}.msg ul{margin:4px 0;padding-left:20px}",
    ".msg a{color:inherit;text-decoration:underline}",
    ".bot{align-self:flex-start;background:#fff;border:1px solid #e5e7eb;border-bottom-left-radius:4px}",
    ".user{align-self:flex-end;background:var(--wa-primary);color:var(--wa-on-primary);border-bottom-right-radius:4px}",
    ".sources{margin-top:8px;padding-top:8px;border-top:1px solid #eef0f3;font-size:13px;color:#52606d}",
    ".sources span{display:block;font-weight:600;margin-bottom:3px}",
    ".sources a,.sources em{display:inline-block;margin:2px 6px 2px 0;padding:2px 8px;background:#f1f5f9;border-radius:999px;color:#1f2933;text-decoration:none;font-style:normal;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".sources a:hover{background:#e2e8f0}",
    ".choices{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}",
    ".choices button{border:1px solid var(--wa-primary);border-radius:8px;padding:6px 14px;font:inherit;font-size:14px;cursor:pointer;background:#fff;color:var(--wa-primary)}",
    ".choices button.yes{background:var(--wa-primary);color:var(--wa-on-primary)}",
    ".choices button:disabled{opacity:.5;cursor:default}",
    ".choices button:focus-visible{outline:2px solid var(--wa-primary);outline-offset:2px}",
    ".typing{display:inline-flex;gap:4px;align-items:center}",
    ".typing i{width:7px;height:7px;border-radius:50%;background:#9aa5b1;animation:wa-b 1.2s infinite ease-in-out}",
    ".typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}",
    "@keyframes wa-b{0%,80%,100%{opacity:.3;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}",
    ".foot{border-top:1px solid #e5e7eb;background:#fff;padding:10px 12px 8px}",
    ".row{display:flex;gap:8px;align-items:flex-end}",
    "textarea{flex:1;resize:none;border:1px solid #d6dbe1;border-radius:10px;padding:9px 11px;font:inherit;color:inherit;max-height:110px;min-height:40px;background:#fff}",
    ".send{border:0;border-radius:10px;background:var(--wa-primary);color:var(--wa-on-primary);height:40px;min-width:44px;padding:0 12px;cursor:pointer;display:grid;place-items:center}",
    ".send:disabled{opacity:.5;cursor:default}",
    ".notice{font-size:11.5px;color:#7b8794;margin-top:6px;text-align:center}",
    ".powered{font-size:11.5px;color:#9aa5b1;text-align:center;margin-top:2px}",
    ".powered a{color:inherit}",
    ".sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}",
    // Admin live preview: the widget fills a (scaled) stand-in screen, so sizes are % of that box.
    ".wa.embedded{position:absolute;inset:0;pointer-events:none}",
    ".wa.embedded .bubble,.wa.embedded .panel{pointer-events:auto}",
    ".wa.embedded .bubble{position:absolute;bottom:20px}.wa.embedded.right .bubble{right:20px}.wa.embedded.left .bubble{left:20px}",
    ".wa.embedded .panel{bottom:94px;width:calc(var(--wa-w,25) * 1%);min-width:min(300px,calc(100% - 40px));max-width:calc(100% - 40px);height:calc(var(--wa-h,70) * 1%);min-height:min(360px,calc(100% - 114px));max-height:calc(100% - 114px)}",
    ".wa.embedded.right .panel{right:20px}.wa.embedded.left .panel{left:20px}",
    // Phones: the chat window is centred near the bottom of the screen; 100% x 100% is full screen.
    "@media (max-width:480px){.wa{bottom:16px}.wa.right{right:16px}.wa.left{left:16px}" +
      phoneRules(".wa:not(.embedded)", "fixed", "1vw", "1vh") + phoneRules(".wa:not(.embedded)", "fixed", "1vw", "1dvh") + "}",
    phoneRules(".wa.embedded.mobile", "absolute", "1%", "1%"),
    "@media (prefers-reduced-motion:reduce){.bubble,.typing i{transition:none;animation:none}}"
  ].join("");

  var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>';
  var ICON_CLOSE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  var ICON_SEND = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

  // ------------------------------------------------------------------ widget
  function mount(options) {
    var config = options.config;
    var preview = !!options.preview;
    var apiBase = options.apiBase || API_BASE;
    var clientId = config.client_id;
    var t = STRINGS[(config.default_language || "en").slice(0, 2)] || STRINGS.en;
    var store = preview ? null : storage();
    var key = "wa:" + clientId;
    var state = { sessionId: randomId(), messages: [], open: !!options.open };
    if (store) {
      try { var saved = JSON.parse(store.getItem(key) || "null"); if (saved && saved.sessionId) state = saved; } catch (e) { /* ignore */ }
    }

    var host = document.createElement("div");
    host.setAttribute("data-website-assistant", clientId);
    (options.container || document.body).appendChild(host);
    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;

    root.innerHTML =
      "<style>" + CSS + "</style>" +
      '<div class="wa ' + (config.position === "left" ? "left" : "right") + (options.container ? " embedded" : "") + '">' +
      '<div class="panel" role="dialog" aria-modal="false" hidden>' +
      '<div class="head"></div>' +
      '<div class="log" role="log" aria-live="polite" aria-relevant="additions"></div>' +
      '<div class="foot"><form class="row"><label class="sr" for="wa-input"></label>' +
      '<textarea id="wa-input" rows="1" maxlength="1000"></textarea>' +
      '<button class="send" type="submit">' + ICON_SEND + "</button></form>" +
      '<div class="notice"></div><div class="powered"></div></div></div>' +
      '<button class="bubble" type="button" aria-expanded="false">' + ICON_CHAT + "</button></div>";

    var device = options.device === "mobile" ? "mobile" : "desktop"; // preview only
    var wrap = root.querySelector(".wa");
    var panel = root.querySelector(".panel");
    var head = root.querySelector(".head");
    var log = root.querySelector(".log");
    var form = root.querySelector("form");
    var input = root.querySelector("textarea");
    var sendBtn = root.querySelector(".send");
    var bubble = root.querySelector(".bubble");
    var busy = false;

    function applyConfig(cfg) {
      config = cfg;
      t = STRINGS[(cfg.default_language || "en").slice(0, 2)] || STRINGS.en;
      wrap.className = "wa " + (cfg.position === "left" ? "left" : "right") + (options.container ? " embedded" : "") + (options.container && device === "mobile" ? " mobile" : "");
      wrap.style.setProperty("--wa-primary", cfg.primary_color || "#1f5f5b");
      var mw = pct(cfg.mobile_width_pct, 92), mh = pct(cfg.mobile_height_pct, 80);
      wrap.style.setProperty("--wa-w", String(pct(cfg.width_pct, 25)));
      wrap.style.setProperty("--wa-h", String(pct(cfg.height_pct, 70)));
      wrap.style.setProperty("--wa-mw", String(mw));
      wrap.style.setProperty("--wa-mh", String(mh));
      panel.classList.toggle("full", mw >= 100 && mh >= 100);
      wrap.style.setProperty("--wa-on-primary", contrastText(cfg.primary_color));
      head.innerHTML = "";
      if (cfg.logo_url) {
        var img = document.createElement("img");
        img.className = "logo"; img.alt = ""; img.src = cfg.logo_url.indexOf("http") === 0 || cfg.logo_url.indexOf("blob:") === 0 || cfg.logo_url.indexOf("data:") === 0 ? cfg.logo_url : apiBase + cfg.logo_url;
        head.appendChild(img);
      }
      var name = document.createElement("div");
      name.className = "name"; name.id = "wa-title"; name.textContent = cfg.bot_name || t.title;
      head.appendChild(name);
      var close = document.createElement("button");
      close.className = "icon-btn"; close.type = "button"; close.setAttribute("aria-label", t.close); close.innerHTML = ICON_CLOSE;
      close.addEventListener("click", function () { setOpen(false); bubble.focus(); });
      head.appendChild(close);
      panel.setAttribute("aria-labelledby", "wa-title");
      input.placeholder = t.placeholder;
      root.querySelector("label").textContent = t.placeholder;
      sendBtn.setAttribute("aria-label", t.send);
      bubble.setAttribute("aria-label", t.open);
      root.querySelector(".notice").textContent = cfg.notice || "";
      var powered = root.querySelector(".powered");
      powered.innerHTML = "";
      if (cfg.powered_by && cfg.powered_by_text) {
        var href = cfg.powered_by_url && safeUrl(cfg.powered_by_url);
        var el = document.createElement(href ? "a" : "span");
        el.textContent = cfg.powered_by_text;
        if (href) { el.href = href; el.target = "_blank"; el.rel = "noopener noreferrer"; }
        powered.appendChild(el);
      }
      render();
    }

    function save() {
      if (!store) return;
      try { store.setItem(key, JSON.stringify({ sessionId: state.sessionId, messages: state.messages.slice(-40), open: state.open })); } catch (e) { /* quota */ }
    }

    function messageEl(m) {
      var div = document.createElement("div");
      div.className = "msg " + (m.role === "user" ? "user" : "bot");
      div.setAttribute("dir", "auto");
      if (m.role === "user") { div.textContent = m.text; return div; }
      div.innerHTML = formatText(m.text);
      if (m.sources && m.sources.length) {
        var box = document.createElement("div");
        box.className = "sources";
        var label = document.createElement("span"); label.textContent = t.sources; box.appendChild(label);
        m.sources.forEach(function (s) {
          var href = s.url && safeUrl(s.url);
          var el = document.createElement(href ? "a" : "em");
          el.textContent = s.title || s.url || "";
          el.title = s.url || s.title || "";
          if (href) { el.href = href; el.target = "_blank"; el.rel = "noopener noreferrer"; }
          box.appendChild(el);
        });
        div.appendChild(box);
      }
      if (m.confirm) {
        // An API action waiting for the visitor's OK: one click, then both buttons are disabled.
        var choices = document.createElement("div");
        choices.className = "choices";
        [[t.confirm || STRINGS.en.confirm, true, "yes"], [t.cancel || STRINGS.en.cancel, false, "no"]].forEach(function (c) {
          var b = document.createElement("button");
          b.type = "button"; b.className = c[2]; b.textContent = c[0];
          b.disabled = !!m.decided || busy;
          b.addEventListener("click", function () { if (m.decided || busy) return; m.decided = true; save(); send(c[0], c[1]); });
          choices.appendChild(b);
        });
        div.appendChild(choices);
      }
      return div;
    }

    function render() {
      log.innerHTML = "";
      if (config.greeting) log.appendChild(messageEl({ role: "bot", text: config.greeting }));
      state.messages.forEach(function (m) { log.appendChild(messageEl(m)); });
      if (busy && !(streaming && streaming.text)) { // dots until the first words arrive
        var typing = document.createElement("div");
        typing.className = "msg bot"; typing.setAttribute("aria-label", "…");
        typing.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
        log.appendChild(typing);
      }
      log.scrollTop = log.scrollHeight;
    }

    // On phones the open chat covers the bubble, so it is hidden (the header has a close button).
    function isPhone() {
      if (options.container) return device === "mobile";
      return !!(window.matchMedia && window.matchMedia("(max-width:480px)").matches);
    }
    function syncBubble() { bubble.style.display = state.open && isPhone() ? "none" : ""; }

    function setOpen(open) {
      state.open = open;
      panel.hidden = !open;
      bubble.setAttribute("aria-expanded", String(open));
      syncBubble();
      if (open) { render(); setTimeout(function () { input.focus(); }, 30); }
      save();
    }

    function add(m) { state.messages.push(m); save(); render(); }

    var streaming = null; // the bot message currently being written (streamed answers)

    function requestBody(text, confirm) {
      return JSON.stringify(typeof confirm === "boolean"
        ? { client_id: clientId, session_id: state.sessionId, message: text, confirm: confirm }
        : { client_id: clientId, session_id: state.sessionId, message: text });
    }

    // Whole answer in one response (older servers, or browsers without streaming).
    function sendWhole(body) {
      return fetch(apiBase + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: body })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (data) { return { status: r.status, data: data }; });
        })
        .then(function (res) {
          if (res.status === 200) add({ role: "bot", text: res.data.answer || t.error, confirm: !!res.data.confirmation });
          else add({ role: "bot", text: res.status === 429 ? t.busy : t.error });
        });
    }

    // The answer appears word by word as the model writes it.
    function sendStreamed(body) {
      var queued = false;
      function paint() {
        if (queued) return;
        queued = true;
        (window.requestAnimationFrame || setTimeout)(function () { queued = false; render(); });
      }
      function onEvent(raw) {
        if (raw.indexOf("data:") !== 0) return;
        var ev;
        try { ev = JSON.parse(raw.slice(5)); } catch (e) { return; }
        if (!streaming) { streaming = { role: "bot", text: "" }; state.messages.push(streaming); }
        if (ev.t === "delta") { streaming.text += ev.text || ""; paint(); }
        else if (ev.t === "done") { streaming.text = ev.answer || t.error; streaming.confirm = !!ev.confirmation; save(); }
      }
      return fetch(apiBase + "/api/chat/stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: body })
        .then(function (r) {
          if (r.status === 404 || r.status === 405) return sendWhole(body);
          if (r.status !== 200) { add({ role: "bot", text: r.status === 429 ? t.busy : t.error }); return; }
          if (!r.body || !r.body.getReader || typeof TextDecoder === "undefined") {
            return r.text().then(function (all) { all.split("\n\n").forEach(onEvent); });
          }
          var reader = r.body.getReader();
          var decoder = new TextDecoder();
          var buffer = "";
          function pump() {
            return reader.read().then(function (chunk) {
              if (chunk.done) { buffer += decoder.decode(); if (buffer) onEvent(buffer); return; }
              buffer += decoder.decode(chunk.value, { stream: true });
              var parts = buffer.split("\n\n");
              buffer = parts.pop();
              parts.forEach(onEvent);
              return pump();
            });
          }
          return pump();
        });
    }

    function send(text, confirm) {
      text = text.trim();
      if (!text || busy) return;
      // Any new message settles an open confirmation (the server drops it as well).
      state.messages.forEach(function (m) { if (m.confirm) m.decided = true; });
      add({ role: "user", text: text });
      input.value = ""; autosize();
      busy = true; sendBtn.disabled = true; render();
      if (preview) {
        setTimeout(function () {
          busy = false; sendBtn.disabled = false;
          add({ role: "bot", text: "This is a preview. Use the Test chat tab to try real answers." });
        }, 700);
        return;
      }
      streaming = null;
      sendStreamed(requestBody(text, confirm))
        .catch(function (err) {
          // fetch() rejects with a TypeError when the server can't be reached: say so plainly.
          var message = err && err.name === "TypeError" ? (t.offline || STRINGS.en.offline) : t.error;
          if (!streaming) add({ role: "bot", text: message });
          else if (!streaming.text) streaming.text = message;
        })
        .then(function () { streaming = null; busy = false; sendBtn.disabled = false; save(); render(); input.focus(); });
    }

    function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 110) + "px"; }

    bubble.addEventListener("click", function () { setOpen(panel.hidden); });
    form.addEventListener("submit", function (e) { e.preventDefault(); send(input.value); });
    input.addEventListener("input", autosize);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
    });
    window.addEventListener("resize", syncBubble); // rotation, or a desktop window made narrow
    root.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !panel.hidden) { setOpen(false); bubble.focus(); }
    });

    applyConfig(config);
    setOpen(!!state.open || !!options.open);

    return {
      update: function (cfg) { applyConfig(cfg); },
      setDevice: function (d) { device = d === "mobile" ? "mobile" : "desktop"; applyConfig(config); syncBubble(); },
      open: function () { setOpen(true); },
      destroy: function () { window.removeEventListener("resize", syncBubble); host.remove(); }
    };
  }

  function autoMount() {
    var clientId = script && script.getAttribute("data-client");
    if (!clientId) return;
    fetch(API_BASE + "/api/client/" + encodeURIComponent(clientId) + "/config", { credentials: "omit" })
      .then(function (r) { if (!r.ok) throw new Error("config " + r.status); return r.json(); })
      .then(function (config) { mount({ config: config }); })
      .catch(function (e) {
        // Not allowed on this site, inactive client, or network error: stay invisible.
        if (window.console) console.warn("[Website Assistant] not loaded:", e.message);
      });
  }

  window.WebsiteAssistant = { __loaded: true, mount: mount };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoMount);
  else autoMount();
})();
