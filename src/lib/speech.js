/* ───────────── Pronunciation (American English, male voice) ─────────────
   Why not the phone's built-in TTS alone?  On Android WebView it is often missing, and when it exists the voice
   and accent are whatever the phone ships with (frequently a female or non-US voice).

   Order of attempts:
     1. Gemini TTS, locked to en-US and a male prebuilt voice → the same clear American voice on every phone.
        Each word is downloaded ONCE, then kept in memory + IndexedDB (works offline and costs no extra requests).
     2. Phone TTS (speechSynthesis) with a US-English male voice picked on purpose, if Gemini is unavailable
        (no key, no internet, quota).                                                                          */

import { useSyncExternalStore } from "react";
import { API_BASE, rawRequest } from "./gemini.js";
import { store } from "./storage.js";

/* newest first; an unknown / retired model just falls through to the next one */
const MODELS = ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts"];
const VOICE = "Charon"; // Gemini prebuilt MALE voice. Other male options: "Orus", "Iapetus", "Puck", "Fenrir".
const CACHE = `tts:v1:${VOICE}:`;
const SAMPLE_RATE = 24000; // Gemini TTS returns raw PCM, 16-bit, mono, 24 kHz

let _key = "";
export const setSpeechKey = (k) => { _key = k || ""; };

/* ── what to say: English only (the Arabic gloss must never be read by the American voice) ── */
export function speakable(s) {
  return String(s || "")
    .replace(/\*\*/g, "")
    .replace(/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]+/g, " ")
    .replace(/\(\s*[,;/\-–—]?\s*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ── tiny external store so every speaker button knows if ITS word is loading / playing ── */
let current = { id: null, state: "idle" };
const subs = new Set();
const setState = (id, state) => { current = { id, state }; subs.forEach((f) => f()); };
const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };
const snapshot = () => current;

export function useSpeechState(id) {
  const c = useSyncExternalStore(subscribe, snapshot, snapshot);
  return c.id === id ? c.state : "idle";
}

/* ── audio plumbing ── */
let ctx = null;
let src = null;
let token = 0;
let goodModel = null;
const mem = new Map();

function getCtx() {
  const AC = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return null;
  if (!ctx) { try { ctx = new AC(); } catch (e) { return null; } }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

function pcmToBuffer(c, b64) {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const buf = c.createBuffer(1, n, SAMPLE_RATE);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    if (v >= 32768) v -= 65536;
    ch[i] = v / 32768;
  }
  return buf;
}

export function stopSpeaking() {
  token += 1;
  try { if (src) { src.onended = null; src.stop(); } } catch (e) { /* already stopped */ }
  src = null;
  try { if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
  setState(null, "idle");
}

/* ── 1 · Gemini TTS ── */
async function fetchPcm(text) {
  if (!_key) throw Object.assign(new Error("no key"), { code: "nokey" });
  const order = goodModel ? [goodModel, ...MODELS.filter((m) => m !== goodModel)] : MODELS;
  const body = {
    contents: [{ parts: [{ text: `Say clearly in a General American accent: ${text}` }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { languageCode: "en-US", voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
    },
  };
  let last = new Error("tts failed");
  for (const model of order) {
    try {
      const { status, json } = await rawRequest("POST", `${API_BASE}/${model}:generateContent?key=${encodeURIComponent(_key)}`, body, 25000);
      if (status >= 200 && status < 300) {
        const part = (json?.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData && p.inlineData.data);
        if (part) { goodModel = model; return part.inlineData.data; }
        last = new Error("empty audio");
        continue;
      }
      last = Object.assign(new Error(`HTTP ${status}`), { status });
      if (status === 401 || status === 403 || status === 429) break; // another model will not help
    } catch (e) { last = e; break; } // network problem
  }
  throw last;
}

/* ── 2 · phone voice (fallback) ── */
const MALE_NAME = /\b(david|mark|guy|alex|fred|aaron|ryan|christopher|eric|roger|brian|andrew|matthew|steffan|tom|daniel|james)\b|x-(iom|iol|tpd)\b|\bmale\b/i;

function pickVoice() {
  try {
    const all = window.speechSynthesis.getVoices() || [];
    const us = all.filter((v) => /^en[-_]US$/i.test(v.lang));
    const label = (v) => `${v.name} ${v.voiceURI}`;
    return us.find((v) => MALE_NAME.test(label(v)) && !/female/i.test(label(v))) || us[0] || null;
  } catch (e) { return null; }
}

function systemSpeak(text, my, id) {
  if (typeof window === "undefined" || !("speechSynthesis" in window) || typeof window.SpeechSynthesisUtterance !== "function") return false;
  try {
    const u = new window.SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = 0.9;
    u.pitch = 0.85;
    u.onend = u.onerror = () => { if (token === my) setState(null, "idle"); };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
    setState(id, "play");
    return true;
  } catch (e) { return false; }
}

const fail = (msg) => {
  try { window.dispatchEvent(new CustomEvent("nclex:speech-error", { detail: msg })); } catch (e) { /* ignore */ }
};

/* ── public: tap once = play, tap again while it plays = stop ── */
export async function speak(raw, id = raw) {
  const text = speakable(raw);
  if (!text) return;
  if (current.id === id && current.state !== "idle") { stopSpeaking(); return; }
  stopSpeaking();
  const my = ++token;
  const c = getCtx(); // must be created/resumed inside the tap, before any await
  setState(id, "load");
  try {
    let b64 = mem.get(text) || (await store.get(CACHE + text));
    if (!b64) {
      b64 = await fetchPcm(text);
      if (my !== token) return;
      mem.set(text, b64);
      store.set(CACHE + text, b64).catch?.(() => {});
    } else if (!mem.has(text)) mem.set(text, b64);
    if (my !== token) return;
    if (!c) throw new Error("no audio context");
    const s = c.createBufferSource();
    s.buffer = pcmToBuffer(c, b64);
    s.connect(c.destination);
    s.onended = () => { if (token === my) { src = null; setState(null, "idle"); } };
    src = s;
    s.start();
    setState(id, "play");
  } catch (e) {
    if (my !== token) return;
    if (systemSpeak(text, my, id)) return;
    setState(null, "idle");
    fail(e && e.code === "nokey"
      ? "ضيف مفتاح Gemini (أيقونة 🔑) عشان النطق الأمريكي يشتغل."
      : "مقدرتش أجيب النطق دلوقتي. اتأكد من النت وجرّب تاني.");
  }
}
