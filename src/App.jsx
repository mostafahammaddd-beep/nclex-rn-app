import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import {
  Plus, BookOpen, ImagePlus, Sparkles, RefreshCw, Save, Trash2, ArrowRight,
  Search, Copy, Check, X, HeartPulse, Lightbulb, Brain, FileText,
  AlertTriangle, Library, KeyRound, Pencil,
} from "lucide-react";
import { Capacitor, CapacitorHttp } from "@capacitor/core";

/* ───────────────────────── Config ───────────────────────── */

// Optional build-time key (GitHub secret GEMINI_API_KEY). You can also paste it inside the app (key icon).
const ENV_KEY = (import.meta.env && import.meta.env.VITE_GEMINI_API_KEY) || "";

// gemini-1.5-pro has been retired by Google. "gemini-pro-latest" always points to
// Google's current strongest Pro model; the others are fallbacks tried in order.
const MODEL_CANDIDATES = ["gemini-pro-latest", "gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-flash-latest"];
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const CHIPS = [
  { id: "egy", label: "شرح بالبلدي 🇪🇬", excludes: "en",
    rule: "Write the explanation and tricks in casual Egyptian Arabic (عامية مصرية), like a friendly senior nurse coaching a junior. Keep every medical term in English." },
  { id: "en", label: "إنجليزي بحت 🇬🇧", excludes: "egy",
    rule: "Write EVERYTHING in clear English only. Do not use any Arabic at all, not even for the new words." },
  { id: "emoji", label: "إضافة إيموجي ✨",
    rule: "Use relevant emojis generously (✅ for correct, ❌ for wrong, 🚨 for traps, 💡 for tips) to make the text lively and memorable." },
  { id: "simple", label: "شرح مبسط ⚡",
    rule: "Explain in very simple language with short sentences and everyday analogies, as if to a beginner who is overwhelmed." },
];

const SECTIONS = [
  { key: "original_question_text", title: "نص السؤال", sub: "اللي اتقرا من الصورة", icon: FileText, rows: 5,
    accent: "#2BA8E8", tint: "#EEF8FE", ltr: true },
  { key: "new_words", title: "كلمات جديدة", sub: "مصطلحات طبية هتتضاف للمجموعة", icon: Library, rows: 4,
    accent: "#7A6BF0", tint: "#F3F1FF" },
  { key: "explanation", title: "تفصيص السؤال", sub: "تحليل عميق وتفنيد كل اختيار", icon: Brain, rows: 10,
    accent: "#0E9F94", tint: "#E9FAF7" },
  { key: "tricks", title: "التريكات", sub: "الفخ المخفي في السؤال", icon: Lightbulb, rows: 5,
    accent: "#FF6B5B", tint: "#FFF1EE" },
];

const EMPTY_RESULT = { original_question_text: "", new_words: "", explanation: "", tricks: "" };

// Speed / accuracy presets for the reasoning call (the strongest model is still used in balanced + deep).
const MODES = {
  turbo:    { id: "turbo",    label: "⚡ فائق السرعة", sub: "الأسرع",       tier: "flash", levels: ["medium", "low"], budget: 2048,  words: 260 },
  balanced: { id: "balanced", label: "⚖️ متوازن",      sub: "موصى به",      tier: "pro",   levels: ["low"],           budget: 1024,  words: 340 },
  deep:     { id: "deep",     label: "🎯 دقة قصوى",    sub: "أعمق تفكير",   tier: "pro",   levels: ["high"],          budget: 16384, words: 520 },
};

const LOADING_LINES = [
  "بنقرأ السؤال بتركيز… 🔍",
  "بنفصّص كل اختيار… 🧠",
  "بندوّر على الفخ المخفي… 🪤",
  "شوية وهتفهمها من جذورها 💙",
];

const CHEERS = [
  "كل سؤال بتحله بيقرّبك من الـ RN 💙",
  "فهم سؤال واحد صح أحسن من حفظ عشرة 🌟",
  "خطوة صغيرة النهاردة، رخصة بكرة 🩺",
  "أنت أقرب مما تتخيل. كمّل! 🚀",
];

/* ───────────────────────── Storage ───────────────────────── */
// IndexedDB (big quota, good for images) with localStorage fallback.

let _dbp = null;
const openDb = () => {
  if (!_dbp) {
    _dbp = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") return reject(new Error("no idb"));
      const r = indexedDB.open("nclex-rn", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return _dbp;
};
const idbRun = async (mode, fn) => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", mode);
    const req = fn(tx.objectStore("kv"));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
};

const store = {
  async get(key) {
    try {
      const v = await idbRun("readonly", (s) => s.get(key));
      return v === undefined ? null : v;
    } catch (e) {
      try { const v = window.localStorage.getItem(key); return v ? JSON.parse(v) : null; }
      catch (e2) { return null; }
    }
  },
  async set(key, value) {
    try { await idbRun("readwrite", (s) => s.put(value, key)); return true; }
    catch (e) {
      try { window.localStorage.setItem(key, JSON.stringify(value)); return true; }
      catch (e2) { return false; }
    }
  },
  async del(key) {
    try { await idbRun("readwrite", (s) => s.delete(key)); }
    catch (e) { try { window.localStorage.removeItem(key); } catch (e2) { /* ignore */ } }
  },
};

/* ───────────────────────── Helpers ───────────────────────── */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function resizeDataUrl(src, maxSide, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error("تعذّر قراءة الصورة"));
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL("image/jpeg", quality));
    };
    img.src = src;
  });
}

function fileToCompressedDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("تعذّر قراءة الملف"));
    reader.onload = () => resizeDataUrl(reader.result, 1500, 0.8).then(resolve, reject);
    reader.readAsDataURL(file);
  });
}

const langRules = (chipIds) => CHIPS.filter((c) => chipIds.includes(c.id)).map((c) => `- ${c.rule}`).join("\n");

function buildExtractPrompt(chipIds) {
  const english = chipIds.includes("en");
  return `You are an OCR and medical-vocabulary assistant for NCLEX-RN students.

The image is a screenshot of ONE NCLEX-style question. Return ONLY a JSON object with EXACTLY these two string keys (no markdown, no code fences, nothing else):
{"original_question_text": "", "new_words": ""}

1. original_question_text: transcribe the question exactly as shown (do NOT translate). Put the stem first, then every option on its own line written as "A) text", "B) text", and so on. For tables, exhibits or ordering lists, transcribe them line by line. Use \\n between lines.
2. new_words: the 4 to 8 most useful medical/nursing terms from the question that a student may not know. ONE term per line, exactly in this format:
Term — ${english ? "short English meaning" : "المعنى بالعربي باختصار"} — optional very short note
Use \\n between lines. Do not number or bullet the lines.`;
}

function buildReasonPrompt(extra, chipIds, words) {
  const rules = langRules(chipIds);
  const defaultLang = chipIds.includes("en") || chipIds.includes("egy")
    ? ""
    : "- Default language: clear, friendly Arabic; keep every medical/nursing term in English.\n";
  return `You are an elite NCLEX-RN educator and clinical-reasoning coach.

The image is a screenshot of ONE NCLEX-style question. Read everything in it (stem, exhibits, labs, every option). Work out the correct answer carefully (accuracy matters more than anything else), then explain it.

Return ONLY a JSON object with EXACTLY these two string keys (no markdown fences, nothing outside the JSON):
{"explanation": "", "tricks": ""}

The text is displayed by a custom renderer, so follow this layout strictly:
- ONE idea per line. Separate lines with \\n. Never write a line longer than two short sentences.
- Headings: a line that starts with "## ".
- Bullets: lines that start with "- ".
- Wrap key terms, option letters and the final answer in **double asterisks**.
- No tables, no HTML.

explanation layout (write the headings in the answer language):
## What is the question really asking?
- one line: the question type (priority / delegation / safety / pharmacology / SATA ...) and what the examiner wants
## Reasoning
- 2 to 4 short bullets applying the right framework (ABCs, Maslow, nursing process: assess before intervene, safety first, scope of practice)
## Options
- **A)** ✅ or ❌ then one short reason. Cover EVERY option. For select-all-that-apply, judge each option separately.
## Correct answer
- **B)** then one line explaining why

tricks layout:
- 2 to 4 bullets, each like "**Trap name:** short explanation" (tricky keywords such as EXCEPT / FIRST / BEST / NEXT, tempting distractors, common student mistakes)
- final line: "💡 " followed by one short memory tip

Length: keep explanation + tricks under about ${words} words in total.
Style rules:
${defaultLang}${rules ? rules + "\n" : ""}${extra && extra.trim() ? `Extra instructions from the student (follow them): ${extra.trim()}\n` : ""}Output the JSON object only.`;
}

function parseJsonKeys(text, keys) {
  const t = (text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a === -1 || b === -1) throw new Error("الرد مش JSON صالح");
  const obj = JSON.parse(t.slice(a, b + 1));
  const s = (v) => (typeof v === "string" ? v : Array.isArray(v) ? v.join("\n") : v == null ? "" : String(v));
  const out = {};
  keys.forEach((k) => { out[k] = s(obj[k]); });
  return out;
}

function friendlyError(status, message) {
  const m = (message || "").toLowerCase();
  if (m.includes("api key") || status === 401 || status === 403)
    return "مفتاح الـ API مش مقبول أو مالوش صلاحية. اتأكد من المفتاح من أيقونة 🔑 فوق.";
  if (status === 429) return "وصلت للحد المسموح من الطلبات. استنى دقيقة وجرّب تاني.";
  if (status === 400 && m.includes("image")) return "الصورة مش واضحة أو مش مدعومة. جرّب صورة تانية.";
  if (status >= 500) return "سيرفرات Google مشغولة دلوقتي. جرّب تاني بعد شوية.";
  return "حصلت مشكلة أثناء التحليل.";
}

/* ── Networking ──
   On Android we call Google through the NATIVE Capacitor HTTP client with long timeouts
   (Android's default 10s read timeout kills slow "thinking" requests).
   If native fails for a non-timeout reason, we retry once through the WebView fetch. */

function normalizeResponse(status, data) {
  let json = data;
  if (typeof data === "string") { try { json = JSON.parse(data); } catch (e) { json = {}; } }
  return { status, json: json && typeof json === "object" ? json : {} };
}

async function rawRequest(method, url, body, readTimeoutMs) {
  const errors = [];
  if (Capacitor.isNativePlatform()) {
    try {
      const opts = {
        url, method,
        headers: { "Content-Type": "application/json" },
        connectTimeout: 30000,
        readTimeout: readTimeoutMs,
      };
      if (body !== undefined) opts.data = body;
      const r = await CapacitorHttp.request(opts);
      return normalizeResponse(r.status, r.data);
    } catch (e) {
      const msg = String((e && e.message) || e);
      errors.push("native: " + msg);
      if (/timeout|timed out/i.test(msg)) {
        throw Object.assign(new Error("الطلب أخد وقت طويل أوي واتقطع. جرّب وضع أسرع."), { detail: errors.join(" | ") });
      }
    }
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), readTimeoutMs);
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

const modelRank = (n) => {
  const tier = /pro/.test(n) ? 2 : /lite/.test(n) ? 0 : 1;
  const v = (n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1];
  const base = /latest$/.test(n) ? 500 : (v ? parseFloat(v) * 10 : 0);
  return tier * 1000 + base - (/preview|exp/.test(n) ? 1 : 0);
};

const _dead = new Set(); // models that are unavailable for this key (404 / quota 0)
let _modelCache = null;

async function pickModels(apiKey) {
  if (_modelCache && _modelCache.key === apiKey) return _modelCache.lists;
  const { status, json } = await rawRequest("GET", `${API_BASE}?pageSize=200&key=${encodeURIComponent(apiKey)}`, undefined, 30000);
  if (status !== 200) {
    const msg = json?.error?.message || "";
    throw Object.assign(new Error(friendlyError(status, msg)), { detail: `HTTP ${status} ${msg}`.slice(0, 300) });
  }
  let found = (json.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent") && /^models\/gemini-/.test(m.name)
      && !/image|tts|audio|live|embed|robotics|computer|learnlm|gemma|aqa|vision|deep-research|customtools/i.test(m.name))
    .map((m) => m.name.replace("models/", ""))
    .sort((x, y) => modelRank(y) - modelRank(x));
  if (!found.length) found = MODEL_CANDIDATES;
  const pro = found.filter((n) => /pro/.test(n)).slice(0, 3);
  const flash = found.filter((n) => !/pro/.test(n)).slice(0, 3);
  const lists = { pro: pro.length ? pro : flash, flash: flash.length ? flash : pro };
  _modelCache = { key: apiKey, lists };
  return lists;
}

async function testConnection(apiKey) {
  _modelCache = null;
  _dead.clear();
  const { pro, flash } = await pickModels(apiKey);
  return `${pro[0]} + ${flash[0]}`;
}

// Thinking control: Gemini 3.x uses thinkingLevel, 2.5 uses thinkingBudget. We try them in order.
const thinkLadder = (levels, budget) => [...levels.map((l) => ({ thinkingLevel: l })), { thinkingBudget: budget }, null];
const _thinkMemo = {};

async function callModel({ apiKey, models, ladder, parts, schema, maxOut, parse }) {
  let lastError = null;
  const alive = models.filter((m) => !_dead.has(m));
  const order = alive.length ? alive : models;
  for (const model of order) {
    const memoKey = model + "|" + JSON.stringify(ladder[0]);
    let li = _thinkMemo[memoKey] || 0;
    while (li < ladder.length) {
      const think = ladder[li];
      const generationConfig = {
        temperature: 0.3, maxOutputTokens: maxOut,
        responseMimeType: "application/json", responseSchema: schema,
      };
      if (think) generationConfig.thinkingConfig = think;
      const { status, json } = await rawRequest(
        "POST", `${API_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        { contents: [{ role: "user", parts }], generationConfig }, 300000
      );
      if (status === 200) {
        const cand = json?.candidates?.[0];
        const text = (cand?.content?.parts || []).filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
        if (text) {
          try { const data = parse(text); _thinkMemo[memoKey] = li; return { data, model }; }
          catch (e) {
            lastError = Object.assign(new Error("الرد جه ناقص أو بصيغة غلط. دوس Regenerate وجرّب تاني."),
              { detail: `${model} · finish: ${cand?.finishReason || "?"}` });
          }
        } else {
          lastError = Object.assign(new Error("الذكاء الاصطناعي رجّع رد فاضي. جرّب تاني."),
            { detail: `${model} · ${cand?.finishReason || json?.promptFeedback?.blockReason || "?"}` });
        }
        break; // try next model
      }
      const msg = json?.error?.message || "";
      lastError = Object.assign(new Error(friendlyError(status, msg)), { detail: `${model} · HTTP ${status} · ${msg}`.slice(0, 400) });
      if (status === 400 && /thinking|thought/i.test(msg) && li < ladder.length - 1) { li++; continue; }
      if (status === 404 || (status === 429 && /limit:\s*0/.test(msg))) _dead.add(model);
      const tryNext = status === 404 || status === 429 || status >= 500 ||
        /not found|no longer available|deprecated|not supported|quota|limit/i.test(msg);
      if (tryNext) break;
      throw lastError;
    }
  }
  throw lastError || new Error("مفيش موديل متاح دلوقتي.");
}

/* Two parallel calls:
   1) fast extraction (Flash, almost no thinking): question text + new words  → shows in a few seconds
   2) deep reasoning (Pro, controlled thinking):    explanation + tricks      → fills in when ready */
async function analyzeStaged({ dataUrl, extra, chips, apiKey, modeId, onPart }) {
  const mode = MODES[modeId] || MODES.balanced;
  const { pro, flash } = await pickModels(apiKey);
  const img = { inlineData: { mimeType: "image/jpeg", data: dataUrl.split(",")[1] } };
  const S = { type: "STRING" };
  const exKeys = ["original_question_text", "new_words"];
  const reKeys = ["explanation", "tricks"];

  const extract = callModel({
    apiKey, models: [...flash, ...pro], ladder: thinkLadder(["minimal", "low"], 0),
    parts: [img, { text: buildExtractPrompt(chips) }],
    schema: { type: "OBJECT", properties: { original_question_text: S, new_words: S }, required: exKeys },
    maxOut: 4096, parse: (t) => parseJsonKeys(t, exKeys),
  });
  const reason = callModel({
    apiKey, models: mode.tier === "flash" ? [...flash, ...pro] : [...pro, ...flash],
    ladder: thinkLadder(mode.levels, mode.budget),
    parts: [img, { text: buildReasonPrompt(extra, chips, mode.words) }],
    schema: { type: "OBJECT", properties: { explanation: S, tricks: S }, required: reKeys },
    maxOut: 12000, parse: (t) => parseJsonKeys(t, reKeys),
  });

  const settle = (name, keys, task) =>
    task.then(({ data, model }) => { onPart(data, name, model); return null; }).catch((error) => ({ keys, error }));
  const results = await Promise.all([settle("extract", exKeys, extract), settle("reason", reKeys, reason)]);
  return results.filter(Boolean);
}

const fmtDate = (ts) => {
  try { return new Date(ts).toLocaleDateString("ar-EG", { day: "numeric", month: "short" }); }
  catch (e) { return ""; }
};

const wordLines = (text) =>
  (text || "").split("\n").map((l) => l.replace(/^[\s\-•*\d.)]+/, "").trim()).filter(Boolean);

/* ───────────────────────── Styles ───────────────────────── */

const CSS = `
:root{
  --ink:#0F3138; --teal:#0E9F94; --teal-deep:#0A6F68; --aqua:#E6FAF7;
  --sky:#2BA8E8; --sun:#FFB627; --coral:#FF6B5B; --violet:#7A6BF0; --paper:#F4FBFB;
}
.nx-root{
  font-family:'Cairo','Tajawal','Segoe UI',system-ui,sans-serif; color:var(--ink); min-height:100vh;
  background:
    radial-gradient(1100px 520px at 95% -8%, #CDF4EE 0%, transparent 60%),
    radial-gradient(900px 520px at -8% 6%, #D8ECFF 0%, transparent 58%),
    var(--paper);
}
.nx-logo{font-family:'Fredoka','Cairo',system-ui,sans-serif; letter-spacing:.03em; font-weight:700}
.nx-card{
  background:#fff; border-radius:22px; border:1.5px solid rgba(14,159,148,.14);
  box-shadow:0 1px 2px rgba(15,49,56,.05), 0 10px 26px -14px rgba(15,49,56,.22);
  transition:transform .28s cubic-bezier(.2,.8,.2,1), box-shadow .28s ease, border-color .28s ease;
}
.nx-lift{cursor:pointer}
.nx-lift:hover{transform:translateY(-5px); border-color:rgba(14,159,148,.5);
  box-shadow:0 2px 4px rgba(15,49,56,.06), 0 22px 36px -16px rgba(14,159,148,.45)}
.nx-lift:hover .nx-go{transform:translateX(-6px); color:var(--teal)}
.nx-go{transition:transform .25s ease, color .25s ease}
.nx-btn{transition:transform .18s ease, box-shadow .22s ease, filter .22s ease, background .22s ease; cursor:pointer}
.nx-btn:hover{transform:translateY(-2px) scale(1.02)}
.nx-btn:active{transform:translateY(0) scale(.97)}
.nx-btn:disabled{cursor:not-allowed; opacity:.55; transform:none}
.nx-btn:focus-visible,.nx-lift:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid rgba(43,168,232,.55); outline-offset:2px}
.nx-primary{background:linear-gradient(135deg,#0E9F94 0%,#22B8D6 100%); color:#fff; box-shadow:0 12px 26px -10px rgba(14,159,148,.7)}
.nx-primary:hover{box-shadow:0 16px 32px -10px rgba(14,159,148,.85)}
.nx-sun{background:linear-gradient(135deg,#FFC93C 0%,#FF9F43 100%); color:#4A2B00; box-shadow:0 12px 26px -12px rgba(255,159,67,.8)}
.nx-ghost{background:#fff; border:1.5px solid rgba(14,159,148,.25); color:var(--teal-deep)}
.nx-ghost:hover{background:var(--aqua)}
.nx-chip{
  display:inline-flex; align-items:center; gap:6px; padding:9px 16px; border-radius:999px; font-weight:700; font-size:14px;
  background:#fff; border:1.5px solid rgba(14,159,148,.28); color:var(--teal-deep);
}
.nx-chip:hover{background:var(--aqua)}
.nx-chip[data-on="true"]{background:linear-gradient(135deg,#0E9F94,#22B8D6); color:#fff; border-color:transparent;
  box-shadow:0 8px 18px -8px rgba(14,159,148,.8); transform:scale(1.04)}
.nx-input{
  width:100%; background:#fff; border:1.5px solid rgba(14,159,148,.22); border-radius:16px; padding:13px 16px; font:inherit; color:var(--ink);
  transition:border-color .2s ease, box-shadow .2s ease;
}
.nx-input:hover{border-color:rgba(14,159,148,.5)}
.nx-input:focus{border-color:var(--teal); box-shadow:0 0 0 4px rgba(14,159,148,.14)}
.nx-area{resize:none; line-height:1.85; font-size:15.5px; overflow:hidden}
.nx-drop{border:2px dashed rgba(14,159,148,.4); background:linear-gradient(180deg,#F2FCFB,#E9F7FF); transition:all .25s ease; cursor:pointer}
.nx-drop:hover,.nx-drop[data-over="true"]{border-color:var(--teal); background:#E3F8F5; transform:scale(1.01)}
.nx-sweep{position:relative; overflow:hidden}
.nx-sweep::after{content:""; position:absolute; top:0; bottom:0; width:40%; left:-60%;
  background:linear-gradient(100deg,transparent,rgba(255,255,255,.45),transparent); transform:skewX(-20deg)}
.nx-sweep:hover::after{animation:nx-sweep .9s ease}
.nx-ecg path{stroke-dasharray:420; stroke-dashoffset:420; animation:nx-ecg 1.6s linear infinite}
.nx-pulse{animation:nx-pulse 1.4s ease-in-out infinite}
.nx-pop{animation:nx-pop .35s cubic-bezier(.2,1.2,.3,1)}
.nx-fade{animation:nx-fade .35s ease both}
@keyframes nx-sweep{to{left:130%}}
@keyframes nx-ecg{to{stroke-dashoffset:-420}}
@keyframes nx-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.14)}}
@keyframes nx-pop{from{transform:scale(.85);opacity:0}to{transform:scale(1);opacity:1}}
@keyframes nx-fade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.nx-clamp{display:-webkit-box; -webkit-box-orient:vertical; overflow:hidden}
html,body{touch-action:pan-y; overscroll-behavior:none; -webkit-text-size-adjust:100%}
.nx-root{overflow-x:clip; max-width:100vw}
.nx-area{unicode-bidi:plaintext; line-height:1.9}
.nx-skel{height:14px; border-radius:8px; background:linear-gradient(90deg,#E6F1F1 25%,#F8FDFD 50%,#E6F1F1 75%); background-size:200% 100%; animation:nx-shimmer 1.3s linear infinite}
@keyframes nx-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}
.nx-word{background:#fff; border-radius:16px; padding:12px 14px; border:1.5px solid rgba(122,107,240,.16); border-inline-start:5px solid var(--violet);
  box-shadow:0 6px 16px -12px rgba(122,107,240,.5)}
.nx-mode{display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; padding:10px 6px; border-radius:18px; text-align:center;
  background:#fff; border:1.5px solid rgba(14,159,148,.25); color:var(--teal-deep)}
.nx-mode:hover{background:var(--aqua)}
.nx-mode[data-on="true"]{background:linear-gradient(135deg,#0E9F94,#22B8D6); color:#fff; border-color:transparent; box-shadow:0 10px 20px -10px rgba(14,159,148,.85); transform:translateY(-2px)}
@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{animation-duration:.001ms !important; animation-iteration-count:1 !important; transition-duration:.001ms !important}
}
`;

/* ───────────────────────── Small components ───────────────────────── */

function AutoTextArea({ value, onChange, rows = 4, ltr, style, placeholder }) {
  const ref = useRef(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + 2 + "px";
  };
  useLayoutEffect(fit, [value]);
  useEffect(() => {
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  return (
    <textarea
      ref={ref}
      dir={ltr ? "ltr" : "auto"}
      rows={rows}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="nx-input nx-area"
      style={style}
    />
  );
}

function ConfirmButton({ onConfirm, label = "حذف", confirmLabel = "تأكيد الحذف؟", className = "", iconOnly }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); armed ? onConfirm() : setArmed(true); }}
      className={`nx-btn inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm font-bold ${className}`}
      style={{ background: armed ? "#FF6B5B" : "#FFF1EE", color: armed ? "#fff" : "#C8412F" }}
      aria-label={label}
    >
      <Trash2 size={16} />
      {(!iconOnly || armed) && <span>{armed ? confirmLabel : label}</span>}
    </button>
  );
}

function Toast({ msg }) {
  if (!msg) return null;
  return (
    <div className="fixed left-1/2 z-50 px-4" style={{ bottom: 28, transform: "translateX(-50%)" }} role="status">
      <div className="nx-pop flex items-center gap-2 rounded-full px-5 py-3 font-bold text-white"
        style={{ background: "linear-gradient(135deg,#0A6F68,#0E9F94)", boxShadow: "0 18px 36px -14px rgba(10,111,104,.8)" }}>
        <Check size={18} /> {msg}
      </div>
    </div>
  );
}

function Logo({ onClick }) {
  return (
    <button onClick={onClick} className="nx-btn flex shrink-0 items-center gap-2" aria-label="NCLEX-RN" style={{ direction: "ltr" }}>
      <span className="flex items-center justify-center rounded-xl"
        style={{ width: 38, height: 38, background: "linear-gradient(135deg,#0E9F94,#22B8D6)", boxShadow: "0 8px 16px -8px rgba(14,159,148,.8)" }}>
        <HeartPulse size={22} color="#fff" />
      </span>
      <span className="nx-logo text-xl sm:text-3xl" style={{ color: "var(--teal-deep)", whiteSpace: "nowrap" }}>NCLEX-RN</span>
    </button>
  );
}

function Loader() {
  const [i, setI] = useState(0);
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => (x + 1) % LOADING_LINES.length), 2200);
    const c = setInterval(() => setSec((x) => x + 1), 1000);
    return () => { clearInterval(t); clearInterval(c); };
  }, []);
  return (
    <div className="nx-card nx-fade flex flex-col items-center gap-4 px-6 py-10 text-center" aria-live="polite">
      <svg className="nx-ecg" width="260" height="70" viewBox="0 0 260 70" fill="none" style={{ maxWidth: "100%" }}>
        <path d="M0 38 H60 L74 38 L84 10 L98 62 L110 38 H150 L162 38 L172 16 L184 56 L194 38 H260"
          stroke="#0E9F94" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="text-xl font-extrabold" style={{ color: "var(--teal-deep)" }}>{LOADING_LINES[i]}</div>
      <p className="text-sm" style={{ opacity: 0.65 }}>أول جزء بيظهر في ثواني، والتفصيص بيتكمل بعده. ({sec} ث)</p>
    </div>
  );
}

/* ── Rich text rendering: clean spacing + correct Arabic/English mixing ── */

const LATIN_RUN = /[A-Za-z][A-Za-z0-9'’\-\/.%+&]*(?:[ ]+(?:[A-Za-z0-9][A-Za-z0-9'’\-\/.%+&]*|\([A-Za-z0-9 ,.'’\-\/%+&]*\)))*(?:[ ]*\([A-Za-z0-9 ,.'’\-\/%+&]*\))?/g;
const hasArabic = (s) => /[\u0600-\u06FF]/.test(s || "");

function latinWrap(t, key) {
  const res = [];
  let last = 0, i = 0;
  for (const m of t.matchAll(LATIN_RUN)) {
    if (m.index > last) res.push(t.slice(last, m.index));
    res.push(<bdi key={`${key}-${i++}`} dir="ltr">{m[0]}</bdi>);
    last = m.index + m[0].length;
  }
  if (last < t.length) res.push(t.slice(last));
  return res;
}

function Inline({ text }) {
  const parts = (text || "").split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^\*\*[^*]+\*\*$/.test(p)
          ? <strong key={i} style={{ fontWeight: 800 }}>{latinWrap(p.slice(2, -2), `b${i}`)}</strong>
          : <React.Fragment key={i}>{latinWrap(p, `t${i}`)}</React.Fragment>
      )}
    </>
  );
}

function RichText({ text, accent, ltr }) {
  const lines = (text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const dir = !ltr && hasArabic(text) ? "rtl" : "ltr";
  return (
    <div dir={dir} className="flex flex-col" style={{ gap: 12, fontSize: 16, lineHeight: 1.9, overflowWrap: "anywhere" }}>
      {lines.map((l, i) => {
        if (/^#{1,3}\s+/.test(l)) {
          return (
            <h4 key={i} className="flex items-center font-black" style={{ gap: 8, marginTop: i ? 12 : 0, fontSize: 17, color: accent }}>
              <span style={{ width: 6, height: 22, borderRadius: 6, background: accent, flexShrink: 0 }} />
              <span className="min-w-0"><Inline text={l.replace(/^#{1,3}\s+/, "")} /></span>
            </h4>
          );
        }
        if (/^[-•*]\s+/.test(l)) {
          return (
            <div key={i} className="flex items-start" style={{ gap: 10 }}>
              <span style={{ width: 8, height: 8, borderRadius: 8, background: accent, marginTop: 14, flexShrink: 0, opacity: 0.85 }} />
              <p className="min-w-0 flex-1"><Inline text={l.replace(/^[-•*]\s+/, "")} /></p>
            </div>
          );
        }
        const num = l.match(/^(\d+)[.)]\s+(.*)$/);
        if (num) {
          return (
            <div key={i} className="flex items-start" style={{ gap: 10 }}>
              <span className="flex shrink-0 items-center justify-center font-black"
                style={{ width: 26, height: 26, marginTop: 4, borderRadius: 9, background: accent + "22", color: accent, fontSize: 13 }}>{num[1]}</span>
              <p className="min-w-0 flex-1"><Inline text={num[2]} /></p>
            </div>
          );
        }
        return <p key={i}><Inline text={l} /></p>;
      })}
    </div>
  );
}

function QuestionView({ text, accent }) {
  const lines = (text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  return (
    <div dir="ltr" className="flex flex-col" style={{ gap: 10, fontSize: 16, lineHeight: 1.7, textAlign: "left", overflowWrap: "anywhere" }}>
      {lines.map((l, i) => {
        const m = i > 0 ? l.match(/^\(?([A-Za-z]|\d{1,2})[).:]\s*(.+)$/) : null;
        if (m) {
          return (
            <div key={i} className="flex items-start" style={{ gap: 10 }}>
              <span className="flex shrink-0 items-center justify-center font-black"
                style={{ width: 28, height: 28, borderRadius: 10, background: accent + "22", color: accent, fontSize: 14 }}>{m[1].toUpperCase()}</span>
              <p className="min-w-0 flex-1" style={{ paddingTop: 2 }}>{m[2]}</p>
            </div>
          );
        }
        return <p key={i} style={{ fontWeight: i === 0 ? 600 : 400 }}>{l}</p>;
      })}
    </div>
  );
}

function parseWord(line) {
  const [term, meaning, ...note] = line.split(/\s[—–]\s|\s\|\s/);
  return { term: (term || "").trim(), meaning: (meaning || "").trim(), note: note.join(" — ").trim() };
}

function WordCard({ line, accent = "#7A6BF0" }) {
  const { term, meaning, note } = parseWord(line);
  const dir = hasArabic(meaning + note) ? "rtl" : "ltr";
  return (
    <div dir={dir} className="nx-word" style={{ borderInlineStartColor: accent }}>
      <div className="font-extrabold" style={{ color: accent, fontSize: 17, lineHeight: 1.5 }}>
        <bdi dir="ltr">{term}</bdi>
      </div>
      {meaning && <p style={{ marginTop: 4, fontSize: 15.5, lineHeight: 1.8 }}><Inline text={meaning} /></p>}
      {note && <p style={{ marginTop: 4, fontSize: 13.5, lineHeight: 1.7, opacity: 0.65 }}><Inline text={note} /></p>}
    </div>
  );
}

function WordList({ text, accent }) {
  return (
    <div className="flex flex-col" style={{ gap: 12 }}>
      {wordLines(text).map((l, i) => <WordCard key={i} line={l} accent={accent} />)}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="flex flex-col" style={{ gap: 12 }} aria-label="جاري التحضير">
      <div className="nx-skel" style={{ width: "92%" }} />
      <div className="nx-skel" style={{ width: "78%" }} />
      <div className="nx-skel" style={{ width: "86%" }} />
      <div className="nx-skel" style={{ width: "52%" }} />
    </div>
  );
}

function ResultSection({ section, value, onChange }) {
  const { key, title, sub, icon: Icon, rows, accent, tint, ltr } = section;
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const pending = value === null || value === undefined;
  const copy = async () => {
    try { await navigator.clipboard.writeText(value || ""); setCopied(true); setTimeout(() => setCopied(false), 1400); }
    catch (e) { /* clipboard unavailable */ }
  };
  const iconBtn = { width: 38, height: 38, color: accent, border: `1.5px solid ${accent}55`, background: "#fff" };

  return (
    <section className="nx-card nx-fade overflow-hidden" style={{ borderColor: accent + "55" }}>
      <header className="flex items-center gap-3 px-4 py-3" style={{ background: tint }}>
        <span className="flex shrink-0 items-center justify-center rounded-2xl"
          style={{ width: 40, height: 40, background: accent, boxShadow: `0 8px 16px -8px ${accent}` }}>
          <Icon size={21} color="#fff" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-extrabold leading-tight sm:text-lg" style={{ whiteSpace: "nowrap" }}>{title}</h3>
          <p className="text-xs" style={{ opacity: 0.65 }}>{sub}</p>
        </div>
        {!pending && (
          <div className="flex shrink-0 items-center gap-2">
            <button onClick={() => setEditing((e) => !e)} className="nx-btn flex items-center justify-center rounded-full"
              style={iconBtn} aria-label={editing ? "تم" : `تعديل ${title}`}>
              {editing ? <Check size={17} /> : <Pencil size={16} />}
            </button>
            <button onClick={copy} className="nx-btn flex items-center justify-center rounded-full" style={iconBtn} aria-label={`نسخ ${title}`}>
              {copied ? <Check size={17} /> : <Copy size={16} />}
            </button>
          </div>
        )}
      </header>
      <div className="p-4">
        {pending ? (
          <Skeleton />
        ) : editing ? (
          <AutoTextArea value={value} onChange={onChange} rows={rows} ltr={ltr}
            style={{ borderColor: accent + "44", background: "#FFFFFF" }} placeholder="اكتب أو عدّل هنا…" />
        ) : !value.trim() ? (
          <button onClick={() => setEditing(true)} className="nx-btn nx-ghost w-full rounded-2xl px-4 py-4 text-sm font-bold">
            فاضي. دوس هنا واكتب بنفسك
          </button>
        ) : key === "new_words" ? (
          <WordList text={value} accent={accent} />
        ) : key === "original_question_text" ? (
          <QuestionView text={value} accent={accent} />
        ) : (
          <RichText text={value} accent={accent} ltr={ltr} />
        )}
      </div>
    </section>
  );
}

/* ───────────────────────── Home ───────────────────────── */

function Home({ questions, words, onAdd, onWords, onOpen }) {
  const cheer = CHEERS[new Date().getDate() % CHEERS.length];
  const sorted = useMemo(() => [...questions].sort((a, b) => b.updatedAt - a.updatedAt), [questions]);
  const wordCount = useMemo(() => words.reduce((n, w) => n + wordLines(w.text).length, 0), [words]);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-16 pt-6 sm:px-6">
      <div className="py-6 sm:py-10">
        <h1 className="text-3xl font-black leading-tight sm:text-5xl">جاهز تحل سؤال النهاردة؟</h1>
        <p className="mt-3 text-base sm:text-lg" style={{ opacity: 0.75 }}>{cheer}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <button onClick={onAdd} className="nx-btn nx-primary nx-sweep flex items-center justify-between rounded-3xl px-6 py-6 text-start">
          <span>
            <span className="block text-2xl font-black">أضف سؤالاً</span>
            <span className="mt-1 block text-sm" style={{ opacity: 0.9 }}>صوّر السؤال وسيبها على الذكاء الاصطناعي</span>
          </span>
          <span className="flex items-center justify-center rounded-2xl" style={{ width: 56, height: 56, background: "var(--sun)" }}>
            <Plus size={30} color="#4A2B00" strokeWidth={3} />
          </span>
        </button>

        <button onClick={onWords} className="nx-btn nx-ghost flex items-center justify-between rounded-3xl px-6 py-6 text-start">
          <span>
            <span className="block text-2xl font-black">تجميع الكلمات الجديدة</span>
            <span className="mt-1 block text-sm" style={{ opacity: 0.75 }}>
              {wordCount ? `${wordCount} مصطلح في قاموسك` : "قاموسك الشخصي للمصطلحات الطبية"}
            </span>
          </span>
          <span className="flex items-center justify-center rounded-2xl" style={{ width: 56, height: 56, background: "#F3F1FF" }}>
            <BookOpen size={28} color="var(--violet)" />
          </span>
        </button>
      </div>

      <h2 className="mb-4 mt-10 text-xl font-extrabold">أسئلتك المحفوظة</h2>

      {sorted.length === 0 ? (
        <div className="nx-card flex flex-col items-center gap-3 px-6 py-12 text-center">
          <span className="nx-pulse flex items-center justify-center rounded-full" style={{ width: 72, height: 72, background: "var(--aqua)" }}>
            <HeartPulse size={36} color="var(--teal)" />
          </span>
          <p className="text-lg font-bold">لسه مفيش أسئلة محفوظة</p>
          <p className="text-sm" style={{ opacity: 0.7 }}>ارفع أول سؤال وشوف التفصيص بنفسك.</p>
          <button onClick={onAdd} className="nx-btn nx-primary mt-2 rounded-full px-6 py-3 font-bold">أضف أول سؤال</button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sorted.map((q) => {
            const n = wordLines(q.new_words).length;
            return (
              <article key={q.id} tabIndex={0} role="button" onClick={() => onOpen(q.id)}
                onKeyDown={(e) => { if (e.key === "Enter") onOpen(q.id); }}
                className="nx-card nx-lift flex flex-col overflow-hidden">
                {q.thumb ? (
                  <div className="h-32 w-full overflow-hidden" style={{ background: "#E9F7FF" }}>
                    <img src={q.thumb} alt="" className="h-full w-full object-cover" />
                  </div>
                ) : (
                  <div className="h-2 w-full" style={{ background: "linear-gradient(90deg,#0E9F94,#2BA8E8,#FFB627)" }} />
                )}
                <div className="flex flex-1 flex-col gap-2 p-4">
                  <h3 className="text-lg font-extrabold leading-snug">{q.title}</h3>
                  <p dir="auto" className="nx-clamp text-sm" style={{ opacity: 0.7, WebkitLineClamp: 2 }}>
                    {q.original_question_text || "—"}
                  </p>
                  <div className="mt-auto flex items-center justify-between pt-2 text-xs font-bold">
                    <span className="flex items-center gap-2">
                      <span className="rounded-full px-3 py-1" style={{ background: "#F3F1FF", color: "var(--violet)" }}>{n} كلمة</span>
                      <span style={{ opacity: 0.55 }}>{fmtDate(q.updatedAt)}</span>
                    </span>
                    <ArrowRight size={18} className="nx-go" style={{ transform: "scaleX(-1)" }} />
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── Words collection ───────────────────────── */

function WordsScreen({ words, onOpen, onDeleteEntry }) {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState("alpha");
  const [copied, setCopied] = useState(false);
  const needle = q.trim().toLowerCase();

  const alpha = useMemo(() => {
    const seen = new Map();
    words.forEach((w) =>
      wordLines(w.text).forEach((line) => {
        const [term, ...rest] = line.split(/\s[—–-]\s/);
        const key = term.trim().toLowerCase();
        if (key && !seen.has(key)) seen.set(key, { term: term.trim(), rest: rest.join(" — "), qid: w.qid });
      })
    );
    return [...seen.values()]
      .sort((a, b) => a.term.localeCompare(b.term))
      .filter((x) => !needle || (x.term + " " + x.rest).toLowerCase().includes(needle));
  }, [words, needle]);

  const grouped = useMemo(
    () => [...words].sort((a, b) => b.updatedAt - a.updatedAt)
      .map((w) => ({ ...w, lines: wordLines(w.text).filter((l) => !needle || l.toLowerCase().includes(needle)) }))
      .filter((w) => w.lines.length),
    [words, needle]
  );

  const copyAll = async () => {
    const text = alpha.map((x) => (x.rest ? `${x.term} — ${x.rest}` : x.term)).join("\n");
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1400); }
    catch (e) { /* clipboard unavailable */ }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-4 sm:px-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-black sm:text-3xl">تجميع الكلمات الجديدة</h1>
        <button onClick={copyAll} className="nx-btn nx-ghost flex items-center gap-2 rounded-full px-4 py-2 text-sm font-bold">
          {copied ? <Check size={16} /> : <Copy size={16} />} نسخ الكل
        </button>
      </div>

      <div className="relative mb-4">
        <Search size={18} className="absolute top-1/2" style={{ insetInlineStart: 14, transform: "translateY(-50%)", opacity: 0.5 }} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="دوّر على مصطلح…" className="nx-input"
          style={{ paddingInlineStart: 42 }} dir="auto" />
      </div>

      <div className="mb-5 flex gap-2">
        {[["alpha", "أبجدي"], ["byq", "حسب السؤال"]].map(([id, label]) => (
          <button key={id} onClick={() => setMode(id)} data-on={mode === id} className="nx-btn nx-chip">{label}</button>
        ))}
      </div>

      {words.length === 0 ? (
        <div className="nx-card px-6 py-12 text-center">
          <p className="text-lg font-bold">القاموس فاضي لحد دلوقتي</p>
          <p className="mt-1 text-sm" style={{ opacity: 0.7 }}>أي كلمات جديدة هتتضاف هنا تلقائياً لما تحفظ سؤال.</p>
        </div>
      ) : mode === "alpha" ? (
        <div className="flex flex-col" style={{ gap: 12 }}>
          {alpha.length === 0 && <p className="p-6 text-center text-sm" style={{ opacity: 0.7 }}>مفيش نتائج.</p>}
          {alpha.map((x) => <WordCard key={x.term} line={x.rest ? `${x.term} — ${x.rest}` : x.term} />)}
        </div>
      ) : (
        <div className="flex flex-col" style={{ gap: 20 }}>
          {grouped.map((w) => (
            <div key={w.id} className="nx-card nx-fade overflow-hidden">
              <div className="flex items-center justify-between gap-2 px-4 py-3" style={{ background: "#F3F1FF" }}>
                <button onClick={() => onOpen(w.qid)} className="nx-btn min-w-0 text-start font-extrabold" style={{ color: "var(--violet)" }}>{w.title}</button>
                <ConfirmButton iconOnly label="حذف" onConfirm={() => onDeleteEntry(w.id)} />
              </div>
              <div className="flex flex-col p-4" style={{ gap: 12 }}>
                {w.lines.map((l, i) => <WordCard key={i} line={l} />)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── Editor ───────────────────────── */

function Editor({ initial, apiKey, onNeedKey, onSave, onDelete }) {
  const [title, setTitle] = useState(initial?.title || "");
  const [imageUrl, setImageUrl] = useState(null);
  const [instructions, setInstructions] = useState(initial?.instructions || "");
  const [chips, setChips] = useState(initial?.chips || []);
  const [result, setResult] = useState(
    initial ? {
      original_question_text: initial.original_question_text || "",
      new_words: initial.new_words || "",
      explanation: initial.explanation || "",
      tricks: initial.tricks || "",
    } : null
  );
  const [loading, setLoading] = useState(false);
  const [usedModels, setUsedModels] = useState({});
  const [mode, setMode] = useState("balanced");
  const [error, setError] = useState(null);
  const [over, setOver] = useState(false);
  const fileRef = useRef(null);
  const resultRef = useRef(null);

  useEffect(() => {
    store.get("nclex:mode").then((m) => { if (typeof m === "string" && MODES[m]) setMode(m); });
  }, []);
  const pickMode = (m) => { setMode(m); store.set("nclex:mode", m); };

  // load stored image for existing questions
  useEffect(() => {
    if (!initial?.id) return;
    let alive = true;
    store.get(`nclex:img:${initial.id}`).then((r) => { if (alive && r?.data) setImageUrl(r.data); });
    return () => { alive = false; };
  }, [initial?.id]);

  const takeFile = async (file) => {
    if (!file || !file.type.startsWith("image/")) { setError({ msg: "الملف لازم يكون صورة." }); return; }
    try { setImageUrl(await fileToCompressedDataUrl(file)); setError(null); }
    catch (e) { setError({ msg: e.message }); }
  };

  // paste a screenshot with Ctrl+V
  useEffect(() => {
    const onPaste = (e) => {
      const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
      if (item) { e.preventDefault(); takeFile(item.getAsFile()); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const toggleChip = (c) =>
    setChips((cur) => {
      if (cur.includes(c.id)) return cur.filter((x) => x !== c.id);
      return [...cur.filter((x) => x !== c.excludes), c.id];
    });

  const anyArrived = !!result && Object.values(result).some((v) => v !== null && v !== undefined);

  const analyze = async () => {
    if (!imageUrl) { setError({ msg: "ارفع صورة السؤال الأول." }); return; }
    if (!apiKey) { setError({ msg: "محتاج تحط مفتاح Gemini الأول. دوس على أيقونة 🔑 فوق." }); onNeedKey(); return; }
    const prev = result;
    setLoading(true); setError(null); setUsedModels({});
    setResult({ original_question_text: null, new_words: null, explanation: null, tricks: null });
    setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
    try {
      const failures = await analyzeStaged({
        dataUrl: imageUrl, extra: instructions, chips, apiKey, modeId: mode,
        onPart: (data, name, model) => {
          setResult((r) => ({ ...(r || EMPTY_RESULT), ...data }));
          setUsedModels((m) => ({ ...m, [name]: model }));
        },
      });
      if (failures.length) {
        setResult((r) => {
          const n = { ...(r || EMPTY_RESULT) };
          failures.forEach((f) => f.keys.forEach((k) => { if (n[k] === null || n[k] === undefined) n[k] = prev?.[k] ?? ""; }));
          return n;
        });
        setError({ msg: failures[0].error.message || "حصلت مشكلة.", detail: failures[0].error.detail });
      }
    } catch (e) {
      setResult(prev);
      setError({ msg: e.message || "حصلت مشكلة.", detail: e.detail });
    } finally { setLoading(false); }
  };

  const setField = (key) => (v) => setResult((r) => ({ ...(r || EMPTY_RESULT), [key]: v }));

  const save = () => onSave({
    title, imageUrl, instructions, chips,
    result: Object.fromEntries(Object.entries(result || EMPTY_RESULT).map(([k, v]) => [k, v ?? ""])),
  });

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-32 pt-4 sm:px-6">
      <div className="mb-5 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-black sm:text-3xl">{initial ? "تعديل السؤال" : "سؤال جديد"}</h1>
        {initial && <ConfirmButton onConfirm={() => onDelete(initial.id)} label="حذف السؤال" />}
      </div>

      <div className="flex flex-col gap-5">
        <div>
          <label htmlFor="q-title" className="mb-2 block text-sm font-extrabold">عنوان السؤال</label>
          <input id="q-title" value={title} onChange={(e) => setTitle(e.target.value)} className="nx-input" dir="auto"
            placeholder="مثال: أولويات التمريض في الـ DKA" />
        </div>

        <div>
          <span className="mb-2 block text-sm font-extrabold">صورة السؤال</span>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { takeFile(e.target.files?.[0]); e.target.value = ""; }} />
          {imageUrl ? (
            <div className="nx-card nx-pop overflow-hidden">
              <img src={imageUrl} alt="صورة السؤال" className="w-full object-contain" style={{ maxHeight: 360, background: "#F2FAFB" }} />
              <div className="flex gap-2 p-3">
                <button onClick={() => fileRef.current?.click()} className="nx-btn nx-ghost flex items-center gap-2 rounded-full px-4 py-2 text-sm font-bold">
                  <ImagePlus size={16} /> غيّر الصورة
                </button>
                <button onClick={() => setImageUrl(null)} className="nx-btn flex items-center gap-2 rounded-full px-4 py-2 text-sm font-bold"
                  style={{ background: "#FFF1EE", color: "#C8412F" }}>
                  <X size={16} /> شيل
                </button>
              </div>
            </div>
          ) : (
            <div role="button" tabIndex={0} data-over={over} className="nx-drop flex flex-col items-center gap-2 rounded-3xl px-4 py-10 text-center"
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") fileRef.current?.click(); }}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); takeFile(e.dataTransfer.files?.[0]); }}>
              <span className="flex items-center justify-center rounded-2xl" style={{ width: 56, height: 56, background: "#fff" }}>
                <ImagePlus size={28} color="var(--teal)" />
              </span>
              <p className="text-base font-extrabold">ارفع سكرين شوت السؤال</p>
              <p className="text-xs" style={{ opacity: 0.65 }}>اضغط، اسحب الصورة هنا، أو الصق بـ Ctrl+V</p>
            </div>
          )}
        </div>

        <div>
          <label htmlFor="q-extra" className="mb-2 block text-sm font-extrabold">تعليمات إضافية للذكاء الاصطناعي</label>
          <textarea id="q-extra" dir="auto" rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)}
            className="nx-input nx-area" style={{ overflow: "auto" }} placeholder="اختياري: مثلاً ركّز على الأدوية أو اشرح الـ rationale بالتفصيل" />
          <div className="mt-3 flex flex-wrap gap-2">
            {CHIPS.map((c) => (
              <button key={c.id} type="button" aria-pressed={chips.includes(c.id)} data-on={chips.includes(c.id)}
                onClick={() => toggleChip(c)} className="nx-btn nx-chip">
                {c.label}
                {chips.includes(c.id) && <Check size={14} />}
              </button>
            ))}
          </div>
        </div>

        <div>
          <span className="mb-2 block text-sm font-extrabold">وضع التحليل</span>
          <div className="grid grid-cols-3 gap-2">
            {Object.values(MODES).map((m) => (
              <button key={m.id} type="button" data-on={mode === m.id} aria-pressed={mode === m.id}
                onClick={() => pickMode(m.id)} className="nx-btn nx-mode">
                <span className="text-sm font-black leading-tight">{m.label}</span>
                <span style={{ fontSize: 11, opacity: 0.8 }}>{m.sub}</span>
              </button>
            ))}
          </div>
        </div>

        {!result && !loading && (
          <button onClick={analyze} disabled={!imageUrl}
            className="nx-btn nx-primary nx-sweep flex items-center justify-center gap-3 rounded-3xl px-6 py-5 text-xl font-black">
            <Sparkles size={24} /> حلّل السؤال
          </button>
        )}

        {error && (
          <div role="alert" className="nx-pop flex gap-3 rounded-2xl p-4" style={{ background: "#FFF1EE", border: "1.5px solid #FF6B5B66" }}>
            <AlertTriangle size={22} color="#C8412F" className="shrink-0" />
            <div className="min-w-0 text-sm">
              <p className="font-extrabold" style={{ color: "#8F2A1B" }}>{error.msg}</p>
              {error.detail && <p dir="ltr" className="mt-1 break-words text-xs" style={{ opacity: 0.7 }}>{error.detail}</p>}
            </div>
          </div>
        )}

        {loading && !anyArrived && <Loader />}

        {result && (!loading || anyArrived) && (
          <div ref={resultRef} className="flex flex-col gap-5" style={{ scrollMarginTop: 90 }}>
            {SECTIONS.map((s) => (
              <ResultSection key={s.key} section={s} value={result[s.key]} onChange={setField(s.key)} />
            ))}
            <p className="text-center text-xs" style={{ opacity: 0.6 }}>
              ملحوظة: Regenerate بيستبدل أي تعديلات عملتها على النتيجة الحالية.
            </p>
            {Object.keys(usedModels).length > 0 && <p dir="ltr" className="text-center text-xs" style={{ opacity: 0.5 }}>Models: {[...new Set(Object.values(usedModels))].join(" + ")}</p>}
          </div>
        )}
      </div>

      {result && (
        <div className="fixed inset-x-0 bottom-0 z-30 px-3 pt-3"
          style={{ background: "linear-gradient(180deg,transparent,rgba(244,251,251,.96) 40%)", paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}>
          <div className="mx-auto flex max-w-3xl gap-2">
            <button onClick={analyze} disabled={loading}
              className="nx-btn nx-ghost flex shrink-0 items-center justify-center rounded-2xl px-4 py-3 font-extrabold"
              style={{ background: "#fff", whiteSpace: "nowrap" }}>
              Regenerate 🔄
            </button>
            <button onClick={save} disabled={loading}
              className="nx-btn nx-sun nx-sweep flex min-w-0 flex-1 items-center justify-center gap-2 rounded-2xl px-4 py-3 text-base font-black"
              style={{ whiteSpace: "nowrap" }}>
              <Save size={18} /> حفظ السؤال
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── App ───────────────────────── */

function KeyModal({ current, hasEnv, onSave, onClose }) {
  const [val, setVal] = useState(current || "");
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const runTest = async () => {
    const k = (val || "").trim() || current;
    if (!k) { setTest({ ok: false, msg: "اكتب المفتاح الأول." }); return; }
    setTesting(true); setTest(null);
    try { const m = await testConnection(k); setTest({ ok: true, msg: `الاتصال شغال ✅ الموديل: ${m}` }); }
    catch (e) { setTest({ ok: false, msg: e.message, detail: e.detail }); }
    finally { setTesting(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      style={{ background: "rgba(15,49,56,.45)" }} onClick={onClose}>
      <div className="nx-card nx-pop w-full max-w-md p-6" style={{ borderRadius: 28 }} onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center gap-3">
          <span className="flex items-center justify-center rounded-2xl" style={{ width: 44, height: 44, background: "#FFF7E0" }}>
            <KeyRound size={22} color="#B87400" />
          </span>
          <h2 className="text-xl font-black">مفتاح Gemini API</h2>
        </div>
        <p className="mb-3 text-sm" style={{ opacity: 0.75 }}>
          الصق المفتاح هنا مرة واحدة وهيتحفظ على موبايلك بس.
          {hasEnv ? " (فيه مفتاح مدمج وقت البناء، وده هيتفوق عليه لو كتبته)" : ""}
        </p>
        <input value={val} onChange={(e) => setVal(e.target.value)} dir="ltr" className="nx-input"
          placeholder="AIza…" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <button onClick={runTest} disabled={testing} className="nx-btn nx-ghost mt-3 w-full rounded-2xl px-5 py-3 font-bold">
          {testing ? "بنجرّب الاتصال…" : "جرّب الاتصال"}
        </button>
        {test && (
          <div role="status" className="mt-3 rounded-2xl p-3 text-sm"
            style={{ background: test.ok ? "#E9FAF7" : "#FFF1EE", border: `1.5px solid ${test.ok ? "#0E9F9466" : "#FF6B5B66"}` }}>
            <p className="font-extrabold">{test.msg}</p>
            {test.detail && <p dir="ltr" className="mt-1 break-words text-xs" style={{ opacity: 0.7 }}>{test.detail}</p>}
          </div>
        )}
        <div className="mt-4 flex gap-3">
          <button onClick={() => onSave(val)} className="nx-btn nx-primary flex-1 rounded-2xl px-5 py-3 font-black">حفظ</button>
          <button onClick={onClose} className="nx-btn nx-ghost rounded-2xl px-5 py-3 font-bold">إلغاء</button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [questions, setQuestions] = useState([]);
  const [words, setWords] = useState([]);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState({ name: "home" });
  const [toast, setToast] = useState("");
  const [apiKey, setApiKey] = useState(ENV_KEY);
  const [showKey, setShowKey] = useState(false);
  const toastTimer = useRef(null);

  // history-aware navigation so the Android back button works
  useEffect(() => {
    window.history.replaceState({ v: { name: "home" } }, "");
    const onPop = (e) => setView((e.state && e.state.v) || { name: "home" });
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    (async () => {
      const [q, w, k] = await Promise.all([store.get("nclex:questions"), store.get("nclex:words"), store.get("nclex:apikey")]);
      if (typeof k === "string" && k.trim()) setApiKey(k.trim());
      setQuestions(Array.isArray(q) ? q : []);
      setWords(Array.isArray(w) ? w : []);
      setReady(true);
    })();
  }, []);

  const say = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2800);
  };

  const go = (v, replace = false) => {
    if (replace) window.history.replaceState({ v }, "");
    else window.history.pushState({ v }, "");
    setView(v);
    window.scrollTo({ top: 0 });
  };
  const back = () => window.history.back();

  const saveKey = async (k) => {
    const key = (k || "").trim();
    setApiKey(key || ENV_KEY);
    await store.set("nclex:apikey", key);
    setShowKey(false);
    say(key ? "اتحفظ المفتاح 🔑" : "اتمسح المفتاح");
  };

  const saveQuestion = async ({ title, imageUrl, instructions, chips, result }) => {
    const existing = view.id ? questions.find((q) => q.id === view.id) : null;
    const id = existing?.id || uid();
    const now = Date.now();
    let thumb = existing?.thumb || null;
    if (imageUrl) {
      try { thumb = await resizeDataUrl(imageUrl, 360, 0.6); } catch (e) { /* keep old thumb */ }
      const ok = await store.set(`nclex:img:${id}`, { data: imageUrl });
      if (!ok) say("الصورة كبيرة والتخزين ممتلئ، اتحفظ النص بس");
    } else {
      await store.del(`nclex:img:${id}`);
      thumb = null;
    }
    const q = {
      id, title: title.trim() || "سؤال بدون عنوان", ...result, instructions, chips,
      thumb, createdAt: existing?.createdAt || now, updatedAt: now,
    };
    const nextQ = existing ? questions.map((x) => (x.id === id ? q : x)) : [q, ...questions];

    // auto-sync new words → global collection
    const lines = wordLines(result.new_words);
    let nextW = words.filter((w) => w.qid !== id);
    if (lines.length) nextW = [{ id: "w-" + id, qid: id, title: q.title, text: result.new_words, updatedAt: now }, ...nextW];

    setQuestions(nextQ); setWords(nextW);
    await Promise.all([store.set("nclex:questions", nextQ), store.set("nclex:words", nextW)]);
    say(lines.length ? `اتحفظ ✅ واتضاف ${lines.length} مصطلح للقاموس` : "اتحفظ السؤال ✅");
    back();
  };

  const deleteQuestion = async (id) => {
    const nextQ = questions.filter((q) => q.id !== id);
    const nextW = words.filter((w) => w.qid !== id);
    setQuestions(nextQ); setWords(nextW);
    await Promise.all([store.set("nclex:questions", nextQ), store.set("nclex:words", nextW), store.del(`nclex:img:${id}`)]);
    say("اتحذف السؤال");
    back();
  };

  const deleteWordEntry = async (wid) => {
    const nextW = words.filter((w) => w.id !== wid);
    setWords(nextW);
    await store.set("nclex:words", nextW);
  };

  const editing = view.name === "edit" && view.id ? questions.find((q) => q.id === view.id) : null;

  return (
    <div className="nx-root" dir="rtl">
      <style>{CSS}</style>

      <header className="sticky top-0 z-40 border-b backdrop-blur"
        style={{ background: "rgba(244,251,251,.92)", borderColor: "rgba(14,159,148,.14)" }}>
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-3 py-2 sm:px-6 sm:py-3">
          <div className="flex min-w-0 items-center gap-2">
            {view.name !== "home" && (
              <button onClick={back} aria-label="رجوع" className="nx-btn nx-primary flex shrink-0 items-center justify-center rounded-full"
                style={{ width: 40, height: 40 }}>
                <ArrowRight size={20} />
              </button>
            )}
            <Logo onClick={() => go({ name: "home" }, true)} />
          </div>
          <button onClick={() => setShowKey(true)} aria-label="مفتاح Gemini"
            className="nx-btn nx-ghost flex shrink-0 items-center justify-center rounded-full"
            style={{ width: 40, height: 40, borderColor: apiKey ? "rgba(14,159,148,.25)" : "#FFB627", background: apiKey ? "#fff" : "#FFF7E0" }}>
            <KeyRound size={18} color={apiKey ? "var(--teal-deep)" : "#B87400"} />
          </button>
        </div>
      </header>

      {!ready ? (
        <div className="flex justify-center py-24"><HeartPulse size={40} color="var(--teal)" className="nx-pulse" /></div>
      ) : view.name === "home" ? (
        <Home questions={questions} words={words}
          onAdd={() => go({ name: "edit" })} onWords={() => go({ name: "words" })}
          onOpen={(id) => go({ name: "edit", id })} />
      ) : view.name === "words" ? (
        <WordsScreen words={words} onOpen={(id) => go({ name: "edit", id })} onDeleteEntry={deleteWordEntry} />
      ) : (
        <Editor key={view.id || "new"} initial={editing} apiKey={apiKey} onNeedKey={() => setShowKey(true)}
          onSave={saveQuestion} onDelete={deleteQuestion} />
      )}

      {showKey && <KeyModal current={apiKey === ENV_KEY ? "" : apiKey} hasEnv={!!ENV_KEY} onSave={saveKey} onClose={() => setShowKey(false)} />}
      <Toast msg={toast} />
    </div>
  );
}
