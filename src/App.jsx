import React, { useState, useEffect, useRef, useCallback } from "react";
import Icon from "./components/Icon.jsx";
import { Brand, Toast, KeyModal, Confetti } from "./components/ui.jsx";
import Home from "./screens/Home.jsx";
import WordsScreen from "./screens/WordsScreen.jsx";
import Editor from "./screens/Editor.jsx";
import { store, prefs } from "./lib/storage.js";
import { ENV_KEY, warmUp, warmConnection } from "./lib/gemini.js";
import { resizeDataUrl } from "./lib/image.js";
import { wordLines, studyStats } from "./lib/parse.js";
import { saveCheer } from "./lib/motivation.js";
import { learn } from "./lib/progress.js";
import { setSpeechKey, stopSpeaking } from "./lib/speech.js";
import { GOALS } from "./lib/config.js";
import { hideSplash } from "./lib/splash.js";

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const titleFrom = (text) => {
  const first = (text || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
  if (!first) return "سؤال بدون عنوان";
  return first.length > 56 ? first.slice(0, 54).trimEnd() + "…" : first;
};

export default function App({ boot }) {
  const [questions, setQuestions] = useState(boot.questions);
  const [words, setWords] = useState(boot.words);
  const [view, setView] = useState({ name: "home" });
  const [toast, setToast] = useState("");
  const [apiKey, setApiKey] = useState(boot.apiKey || ENV_KEY);
  const [goal, setGoal] = useState(boot.goal);
  const [perf, setPerf] = useState(boot.perf);
  const [showKey, setShowKey] = useState(false);
  const [burst, setBurst] = useState(0);
  const burstTimer = useRef(null);
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || "light");
  const toastTimer = useRef(null);
  const perfRef = useRef(perf);
  perfRef.current = perf;
  /* always-current copies of the lists: auto-save can fire twice before React re-renders, and must never see a stale list */
  const qRef = useRef(questions);
  const wRef = useRef(words);
  qRef.current = questions;
  wRef.current = words;

  /* the launch splash (native icon screen + the cover in index.html) is handed over to the app after the first real paint */
  useEffect(() => { hideSplash(); }, []);

  /* warm the network while the user is still choosing a picture */
  useEffect(() => { warmUp(apiKey); warmConnection(apiKey); }, [apiKey]);

  /* history-aware navigation so the Android back button works */
  useEffect(() => {
    window.history.replaceState({ v: { name: "home" } }, "");
    const onPop = (e) => setView((e.state && e.state.v) || { name: "home" });
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    prefs.set("nclex:theme", next);
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", next === "dark" ? "#061317" : "#EFF6F4");
  };

  const say = (msg, ms = 2800) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), ms);
  };

  const celebrate = () => {
    setBurst(Date.now());
    clearTimeout(burstTimer.current);
    burstTimer.current = setTimeout(() => setBurst(0), 2600);
  };

  /* pronunciation: key for Gemini voice, error toast, and silence when the screen changes */
  const sayRef = useRef(say);
  sayRef.current = say;
  useEffect(() => { setSpeechKey(apiKey); }, [apiKey]);
  useEffect(() => {
    const h = (e) => sayRef.current(e.detail);
    window.addEventListener("nclex:speech-error", h);
    return () => window.removeEventListener("nclex:speech-error", h);
  }, []);
  useEffect(() => { stopSpeaking(); }, [view]);

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

  const cycleGoal = async () => {
    const next = GOALS[(Math.max(0, GOALS.indexOf(goal)) + 1) % GOALS.length];
    setGoal(next);
    await store.set("nclex:goal", next);
  };

  const onLearn = useCallback((task, modeId, ms, chars) => {
    const next = learn(perfRef.current, task, modeId, ms, chars);
    perfRef.current = next;
    setPerf(next);
    store.set("nclex:perf", next);
  }, []);

  /* Auto-save, called by the editor (it never navigates away).
     `id` is empty only for the very first save of a new question; after that the editor keeps sending the same id,
     so every later save updates that one question instead of creating a copy. */
  const saveQuestion = async ({ id: knownId, title, imageUrl, doc, imageChanged, instructions, chips, result }) => {
    const id = knownId || uid();
    const existing = qRef.current.find((q) => q.id === id) || null;
    const now = Date.now();
    let thumb = existing?.thumb || null;
    if (!existing || imageChanged) {
      if (imageUrl) {
        try { thumb = await resizeDataUrl(imageUrl, 360, 0.6); } catch (e) { /* keep old thumb */ }
        const ok = await store.set(`nclex:img:${id}`, { data: imageUrl, doc: doc || null });
        if (!ok) say("الصورة كبيرة والتخزين ممتلئ، اتحفظ النص بس");
      } else {
        await store.del(`nclex:img:${id}`);
        thumb = null;
      }
    }
    const q = {
      id, title: title.trim() || titleFrom(result.original_question_text), ...result, instructions, chips,
      thumb, createdAt: existing?.createdAt || now, updatedAt: now,
    };
    const prevQ = qRef.current;
    const nextQ = existing ? prevQ.map((x) => (x.id === id ? q : x)) : [q, ...prevQ];

    // auto-sync new words → global dictionary
    const lines = wordLines(result.new_words);
    let nextW = wRef.current.filter((w) => w.qid !== id);
    if (lines.length) nextW = [{ id: "w-" + id, qid: id, title: q.title, text: result.new_words, updatedAt: now }, ...nextW];

    /* a new question: tell the person how far they are (goal / streak / level) and celebrate the big moments */
    const statsOf = (qs) => ({ ...studyStats(qs, goal), total: qs.length });
    const cheer = existing ? { confetti: false, msg: "" } : saveCheer(statsOf(prevQ), statsOf(nextQ), goal);

    qRef.current = nextQ; wRef.current = nextW;
    setQuestions(nextQ); setWords(nextW);
    await Promise.all([store.set("nclex:questions", nextQ), store.set("nclex:words", nextW)]);
    if (!existing) {   // only the first save speaks; later silent updates (edits) don't pop a message each time
      const base = lines.length ? `اتحفظ تلقائي ✅ واتضاف ${lines.length} مصطلح للقاموس` : "اتحفظ السؤال تلقائي ✅";
      if (cheer.confetti) celebrate();
      say(cheer.msg ? `اتحفظ ✅ ${cheer.msg}` : base, cheer.confetti ? 4200 : 3200);
    }
    return id;
  };

  const deleteQuestion = async (id) => {
    const nextQ = qRef.current.filter((q) => q.id !== id);
    const nextW = wRef.current.filter((w) => w.qid !== id);
    qRef.current = nextQ; wRef.current = nextW;
    setQuestions(nextQ); setWords(nextW);
    await Promise.all([store.set("nclex:questions", nextQ), store.set("nclex:words", nextW), store.del(`nclex:img:${id}`), store.del(`nclex:chat:${id}`)]);
    say("اتحذف السؤال");
    back();
  };

  const deleteWordEntry = async (wid) => {
    const nextW = wRef.current.filter((w) => w.id !== wid);
    wRef.current = nextW;
    setWords(nextW);
    await store.set("nclex:words", nextW);
  };

  const editing = view.name === "edit" && view.id ? questions.find((q) => q.id === view.id) : null;

  return (
    <div className="app" dir="rtl" data-sub={view.name !== "home"}>
      <div className="paper" aria-hidden="true" />

      <header className="topbar">
        <div className="topbar-in">
          <div className="tb-side tb-start">
            {view.name !== "home" && (
              <button onClick={back} aria-label="رجوع" className="iconbtn iconbtn-solid"><Icon name="back" size={20} /></button>
            )}
            <Brand onClick={() => go({ name: "home" }, true)} />
          </div>
          <div className="tb-side tb-end">
            <button onClick={toggleTheme} aria-label={theme === "dark" ? "الوضع النهاري" : "الوضع الليلي"} className="iconbtn">
              <Icon name={theme === "dark" ? "sun" : "moon"} size={19} />
            </button>
            <button onClick={() => setShowKey(true)} aria-label="مفتاح Gemini" data-missing={!apiKey} className="iconbtn">
              <Icon name="key" size={19} />
            </button>
          </div>
        </div>
      </header>

      <main>
        {view.name === "home" ? (
          <Home questions={questions} words={words} goal={goal} onGoal={cycleGoal}
            onAdd={() => go({ name: "edit" })} onWords={() => go({ name: "words" })}
            onOpen={(id) => go({ name: "edit", id })} />
        ) : view.name === "words" ? (
          <WordsScreen words={words} onOpen={(id) => go({ name: "edit", id })} onDeleteEntry={deleteWordEntry} />
        ) : (
          <Editor key={view.id || "new"} initial={editing} boot={boot} apiKey={apiKey} perf={perf} onLearn={onLearn}
            onNeedKey={() => setShowKey(true)} onSave={saveQuestion} onDelete={deleteQuestion} />
        )}
      </main>

      {showKey && <KeyModal current={apiKey === ENV_KEY ? "" : apiKey} hasEnv={!!ENV_KEY} onSave={saveKey} onClose={() => setShowKey(false)} />}
      <Toast msg={toast} />
      {burst > 0 && <Confetti key={burst} />}
    </div>
  );
}
