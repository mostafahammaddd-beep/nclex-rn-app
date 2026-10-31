/* ───────────── Gemini networking ─────────────
   Goals: first text on screen in ~1–2 s, never block on housekeeping calls, never wait for a slow
   model when another one can answer.

   • STREAMING (SSE) through the WebView fetch → text is shown while it is still being written.
   • NO blocking "list models" round trip before analysing (cached list + safe defaults; refreshed in background).
   • HEDGED fallback: if a model has not produced its first token after `hedgeMs`, the next model is started
     in parallel and the first one to answer wins (an overloaded model can no longer stall the whole task).
   • Thinking level is remembered per model (no repeated 400 round trips).
   • If WebView fetch cannot reach Google (CORS / network), it falls back to the native Capacitor HTTP client
     (non-streaming) automatically.                                                                       */

import { Capacitor, CapacitorHttp } from "@capacitor/core";

const ENV = (typeof import.meta !== "undefined" && import.meta.env) || {};
export const ENV_KEY = ENV.VITE_GEMINI_API_KEY || "";
export const API_BASE = ENV.VITE_API_BASE || "https://generativelanguage.googleapis.com/v1beta/models";

/* ── errors ── */

export function friendlyError(status, message) {
  const m = (message || "").toLowerCase();
  if (/api key|api_key/.test(m) || status === 401 || status === 403)
    return "مفتاح الـ API مش مقبول أو مالوش صلاحية. اتأكد من المفتاح من أيقونة 🔑 فوق.";
  if (status === 429) return "وصلت للحد المسموح من الطلبات. استنى دقيقة وجرّب تاني.";
  if (status === 400 && m.includes("image")) return "الصورة مش واضحة أو مش مدعومة. جرّب صورة تانية.";
  if (status >= 500) return "سيرفرات Google مشغولة دلوقتي. جرّب تاني بعد شوية.";
  return "حصلت مشكلة أثناء التحليل.";
}

function apiError(status, bodyText) {
  let message = "";
  try { message = JSON.parse(bodyText)?.error?.message || ""; } catch (e) { message = String(bodyText || "").slice(0, 200); }
  return classify(status, message);
}

function classify(status, message) {
  const m = (message || "").toLowerCase();
  const err = new Error(friendlyError(status, message));
  err.status = status;
  err.detail = `HTTP ${status} · ${message || ""}`.slice(0, 400);
  err.thinking = status === 400 && /thinking|thought/.test(m);
  err.fatal = !err.thinking && (
    status === 401 ||
    /api key not valid|api_key_invalid|api key expired|invalid api key|api key not found|api key is missing/.test(m) ||
    (status === 403 && /api key|api_key|referer|ip address|has not been used|is disabled/.test(m))
  );
  err.dead = status === 404 || (status === 429 && /limit:\s*0/.test(m)) || (status === 403 && !err.fatal);
  return err;
}

const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
const timeoutError = (what) =>
  Object.assign(new Error("الطلب أخد وقت أطول من اللازم واتقطع. جرّب تاني أو اختار وضع أسرع."), { detail: `timeout (${what})`, timeout: true });

/* ── plain (non-stream) requests: model list, connection test ── */

function normalizeResponse(status, data) {
  let json = data;
  if (typeof data === "string") { try { json = JSON.parse(data); } catch (e) { json = {}; } }
  return { status, json: json && typeof json === "object" ? json : {} };
}

async function rawRequest(method, url, body, timeoutMs) {
  const errors = [];
  if (Capacitor.isNativePlatform()) {
    try {
      const opts = { url, method, headers: { "Content-Type": "application/json" }, connectTimeout: 30000, readTimeout: timeoutMs };
      if (body !== undefined) opts.data = body;
      const r = await CapacitorHttp.request(opts);
      return normalizeResponse(r.status, r.data);
    } catch (e) { errors.push("native: " + String((e && e.message) || e)); }
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const init = { method, headers: { "Content-Type": "application/json" }, signal: ctrl.signal };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(url, init);
    const text = await res.text();
    clearTimeout(timer);
    return normalizeResponse(res.status, text);
  } catch (e) {
    errors.push("webview: " + (e && e.name === "AbortError" ? "timeout" : String((e && e.message) || e)));
  }
  throw Object.assign(new Error("مفيش اتصال بسيرفرات Google. اتأكد من النت وجرّب تاني."), { detail: errors.join(" | ") });
}

/* ── model lists (cached, never blocking) ── */

const DEFAULT_LISTS = {
  fast: ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest"],
  pro: ["gemini-pro-latest", "gemini-2.5-pro"],
};
const LS_MODELS = "nclex:models:v3";
const keyTag = (k) => (k || "").slice(-8);
let _lists = null;
const _dead = new Set(); // unavailable for this key (404 / quota 0)

const modelRank = (n) => {
  const tier = /pro/.test(n) ? 2 : /lite/.test(n) ? 0 : 1;
  const v = (n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1];
  const base = /latest$/.test(n) ? 500 : (v ? parseFloat(v) * 10 : 0);
  return tier * 1000 + base - (/preview|exp/.test(n) ? 1 : 0);
};

export function getModelLists(apiKey) {
  if (_lists && _lists.k === keyTag(apiKey)) return _lists.lists;
  try {
    const raw = JSON.parse(window.localStorage.getItem(LS_MODELS));
    if (raw && raw.k === keyTag(apiKey) && Date.now() - raw.t < 3 * 864e5) { _lists = raw; return raw.lists; }
  } catch (e) { /* ignore */ }
  return DEFAULT_LISTS;
}

export async function refreshModels(apiKey, { force = false } = {}) {
  if (!apiKey) return DEFAULT_LISTS;
  if (!force) {
    try {
      const raw = JSON.parse(window.localStorage.getItem(LS_MODELS));
      if (raw && raw.k === keyTag(apiKey) && Date.now() - raw.t < 864e5) { _lists = raw; return raw.lists; }
    } catch (e) { /* ignore */ }
  }
  const { status, json } = await rawRequest("GET", `${API_BASE}?pageSize=200&key=${encodeURIComponent(apiKey)}`, undefined, 30000);
  if (status !== 200) throw classify(status, json?.error?.message || "");
  const found = (json.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent") && /^models\/gemini-/.test(m.name)
      && !/image|tts|audio|live|embed|robotics|computer|learnlm|gemma|aqa|vision|deep-research|customtools/i.test(m.name))
    .map((m) => m.name.replace("models/", ""))
    .sort((x, y) => modelRank(y) - modelRank(x));
  const pro = found.filter((n) => /pro/.test(n)).slice(0, 3);
  const flash = found.filter((n) => !/pro/.test(n) && !/lite/.test(n)).slice(0, 3);
  const lite = found.filter((n) => /lite/.test(n)).slice(0, 1);
  const fast = [...flash, ...lite];
  const lists = {
    fast: fast.length ? fast : (pro.length ? pro : DEFAULT_LISTS.fast),
    pro: pro.length ? pro : (flash.length ? flash : DEFAULT_LISTS.pro),
  };
  _lists = { k: keyTag(apiKey), t: Date.now(), lists };
  _dead.clear();
  try { window.localStorage.setItem(LS_MODELS, JSON.stringify(_lists)); } catch (e) { /* ignore */ }
  return lists;
}

export async function testConnection(apiKey) {
  const { fast, pro } = await refreshModels(apiKey, { force: true });
  return `${pro[0]} + ${fast[0]}`;
}

/* Fire-and-forget: refreshes the model list in the background. */
export function warmUp(apiKey) {
  if (!apiKey) return;
  refreshModels(apiKey).catch(() => {});
}

/* Opens the DNS + TLS + HTTP/2 connection to Google BEFORE the user presses "analyse", so the three
   parallel requests reuse one hot connection instead of each paying the handshake (≈ 0.3–0.8 s on mobile). */
let _warmAt = 0;
export function warmConnection(apiKey) {
  if (!apiKey || Date.now() - _warmAt < 45000) return;
  _warmAt = Date.now();
  try {
    fetch(`${API_BASE}?pageSize=1&key=${encodeURIComponent(apiKey)}`, { method: "GET", cache: "no-store" })
      .then((r) => r.arrayBuffer()).catch(() => {});
  } catch (e) { /* ignore */ }
}

/* ── thinking control ──
   Gemini 3.x uses thinkingLevel, 2.x uses thinkingBudget. The first rung that works is remembered. */

const is2x = (model) => /gemini-2\./.test(model);

function ladderFor(model, spec) {
  const bud = { thinkingBudget: spec.budget };
  if (is2x(model)) return [bud, null];
  return [...spec.levels.map((l) => ({ thinkingLevel: l })), bud, null];
}

const memoKey = (model, task) => `nclex:tl:${model}|${task}`;
const readMemo = (model, task) => { try { return parseInt(window.localStorage.getItem(memoKey(model, task)) || "0", 10) || 0; } catch (e) { return 0; } };
const writeMemo = (model, task, i) => { try { window.localStorage.setItem(memoKey(model, task), String(i)); } catch (e) { /* ignore */ } };

function genConfig(model, think, maxOut, task) {
  const g = { maxOutputTokens: maxOut };
  if (is2x(model)) g.temperature = task === "reason" ? 0.3 : 0.1; // Gemini 3: keep Google's default temperature
  if (think) g.thinkingConfig = think;
  return g;
}

/* ── one streaming request (SSE over fetch) ── */

function readParts(json) {
  const cand = json?.candidates?.[0];
  const text = (cand?.content?.parts || []).filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
  return { text, finish: cand?.finishReason || null, block: json?.promptFeedback?.blockReason || null };
}

async function fetchStream({ apiKey, model, body, signal, onText, firstMs, idleMs = 45000 }) {
  if (signal.aborted) throw abortError();
  const url = `${API_BASE}/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  const ctrl = new AbortController();
  const link = () => ctrl.abort();
  signal.addEventListener("abort", link);
  let timer = null, why = null;
  const arm = (ms, w) => { clearTimeout(timer); timer = setTimeout(() => { why = w; ctrl.abort(); }, ms); };
  arm(firstMs, "first-byte");

  let full = "", finish = null, block = null;
  const handle = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let json;
    try { json = JSON.parse(payload); } catch (e) { return; }
    if (json.error) throw classify(json.error.code || 500, json.error.message || "");
    const r = readParts(json);
    if (r.finish) finish = r.finish;
    if (r.block) block = r.block;
    if (r.text) { full += r.text; onText(full); }
  };

  try {
    let res;
    try {
      res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (e) {
      if (signal.aborted) throw abortError();
      if (why) throw timeoutError(why);
      throw Object.assign(new Error("مفيش اتصال بسيرفرات Google. اتأكد من النت وجرّب تاني."), { detail: "fetch: " + String((e && e.message) || e), netBeforeStart: true });
    }
    if (!res.ok) throw apiError(res.status, await res.text());
    arm(idleMs, "idle");

    const reader = res.body && typeof res.body.getReader === "function" ? res.body.getReader() : null;
    if (!reader) {
      (await res.text()).split("\n").forEach((l) => handle(l.replace(/\r$/, "")));
    } else {
      const dec = new TextDecoder("utf-8");
      let buf = "";
      for (;;) {
        let chunk;
        try { chunk = await reader.read(); }
        catch (e) {
          if (signal.aborted) throw abortError();
          if (why) throw timeoutError(why);
          throw Object.assign(new Error("النت قطع في نص التحميل. دوس إعادة المحاولة."), { detail: "stream: " + String((e && e.message) || e), interrupted: true });
        }
        if (chunk.done) break;
        arm(idleMs, "idle");
        buf += dec.decode(chunk.value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          handle(line);
        }
      }
      buf += dec.decode();
      if (buf.trim()) handle(buf.replace(/\r$/, ""));
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", link);
  }
  return { text: full, finish, block };
}

/* Native (non-streaming) fallback — used only if WebView fetch cannot reach Google. */
async function nativeOnce({ apiKey, model, body, signal, onText }) {
  const url = `${API_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  let r;
  try {
    r = await CapacitorHttp.request({ url, method: "POST", headers: { "Content-Type": "application/json" }, data: body, connectTimeout: 30000, readTimeout: 300000 });
  } catch (e) {
    if (signal.aborted) throw abortError();
    const msg = String((e && e.message) || e);
    if (/timeout|timed out/i.test(msg)) throw timeoutError("native");
    throw Object.assign(new Error("مفيش اتصال بسيرفرات Google. اتأكد من النت وجرّب تاني."), { detail: "native: " + msg });
  }
  if (signal.aborted) throw abortError();
  const { status, json } = normalizeResponse(r.status, r.data);
  if (status !== 200) throw classify(status, json?.error?.message || "");
  const out = readParts(json);
  if (out.text) onText(out.text);
  return out;
}

let _noStreamUntil = 0;
async function streamOrNative(args) {
  if (Date.now() >= _noStreamUntil) {
    try { return await fetchStream(args); }
    catch (e) {
      if (!(e && e.netBeforeStart && Capacitor.isNativePlatform())) throw e;
      const out = await nativeOnce(args);          // WebView could not reach Google but native can
      _noStreamUntil = Date.now() + 10 * 60 * 1000; // stop retrying fetch for a while
      return out;
    }
  }
  return nativeOnce(args);
}

async function attemptModel({ apiKey, model, task, parts, spec, maxOut, signal, onText, firstMs, idleMs }) {
  const rungs = ladderFor(model, spec);
  let idx = Math.min(readMemo(model, task), rungs.length - 1);
  for (;;) {
    const body = { contents: [{ role: "user", parts }], generationConfig: genConfig(model, rungs[idx], maxOut, task) };
    try {
      const out = await streamOrNative({ apiKey, model, body, signal, onText, firstMs, idleMs });
      if (!out.text.trim()) {
        throw Object.assign(new Error(out.block ? "السؤال اتحجب من فلتر الأمان بتاع Google. جرّب صورة تانية." : "الذكاء الاصطناعي رجّع رد فاضي. جرّب تاني."),
          { detail: `${model} · ${out.finish || out.block || "empty"}`, emptyReply: true });
      }
      writeMemo(model, task, idx);
      return out;
    } catch (e) {
      if (e.thinking && idx < rungs.length - 1) { idx += 1; continue; }
      if (e && !e.detail) e.detail = model;
      else if (e && e.detail && !e.detail.includes(model)) e.detail = `${model} · ${e.detail}`;
      throw e;
    }
  }
}

/* ── hedged race between models ── */

function raceModels({ models, run, hedgeMs, signal, onText }) {
  return new Promise((resolve, reject) => {
    const alive = models.filter((m) => !_dead.has(m));
    const order = [...new Set(alive.length ? alive : models)];
    if (!order.length) return reject(new Error("مفيش موديل متاح دلوقتي."));

    const ctrls = [];
    let launched = 0, active = 0, winner = -1, settled = false, lastErr = null, hedgeTimer = null;

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      ctrls.forEach((c) => c.abort());
      signal && signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(abortError()));
    if (signal) {
      if (signal.aborted) return reject(abortError());
      signal.addEventListener("abort", onAbort);
    }

    const armHedge = () => {
      clearTimeout(hedgeTimer);
      if (winner === -1 && launched < order.length && hedgeMs) hedgeTimer = setTimeout(launch, hedgeMs);
    };

    function launch() {
      if (settled || winner !== -1 || launched >= order.length) return;
      const i = launched++;
      const model = order[i];
      const ctrl = new AbortController();
      ctrls[i] = ctrl;
      active++;
      run(model, ctrl.signal, (text) => {
        if (settled) return;
        if (winner === -1) {
          winner = i;
          clearTimeout(hedgeTimer);
          ctrls.forEach((c, j) => { if (j !== i) c.abort(); });
        }
        if (winner === i) onText(text, model);
      }).then((res) => {
        active--;
        if (settled) return;
        if (winner === -1) winner = i;
        if (winner === i) finish(() => resolve({ ...res, model }));
      }).catch((err) => {
        active--;
        if (settled || ctrl.signal.aborted) return;       // lost the race on purpose
        if (winner === i) return finish(() => reject(err)); // the winner died mid-stream
        lastErr = err;
        if (err.fatal) return finish(() => reject(err));
        if (err.dead) _dead.add(model);
        if (launched < order.length) { launch(); armHedge(); }
        else if (active === 0) finish(() => reject(lastErr));
      });
      armHedge();
    }
    launch();
  });
}

/* public: run one task against a list of candidate models */
export function runTask({ apiKey, models, task, parts, spec, maxOut, hedgeMs, firstMs, idleMs, signal, onText }) {
  return raceModels({
    models, hedgeMs, signal, onText,
    run: (model, sig, emit) => attemptModel({ apiKey, model, task, parts, spec, maxOut, signal: sig, onText: emit, firstMs, idleMs }),
  });
}
