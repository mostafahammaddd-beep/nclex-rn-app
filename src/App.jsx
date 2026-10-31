import React, { useState, useEffect, useRef, useCallback } from "react";
import Icon from "./components/Icon.jsx";
import { Brand, Toast, KeyModal } from "./components/ui.jsx";
import Home from "./screens/Home.jsx";
import WordsScreen from "./screens/WordsScreen.jsx";
import Editor from "./screens/Editor.jsx";
import { store, prefs } from "./lib/storage.js";
import { ENV_KEY, warmUp, warmConnection } from "./lib/gemini.js";
import { resizeDataUrl } from "./lib/image.js";
import { wordLines } from "./lib/parse.js";
import { learn } from "./lib/progress.js";
import { GOALS } from "./lib/config.js";

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
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || "light");
  const toastTimer = useRef(null);
  const perfRef = useRef(perf);
  perfRef.current = perf;

  /* the splash from index.html fades out right after the first real paint */
  useEffect(() => {
    const el = document.getElementById("splash");
    if (!el) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.classList.add("out");
      setTimeout(() => el.remove(), 380);
    }));
  }, []);

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
      id, title: title.trim() || titleFrom(result.original_question_text), ...result, instructions, chips,
      thumb, createdAt: existing?.createdAt || now, updatedAt: now,
    };
    const nextQ = existing ? questions.map((x) => (x.id === id ? q : x)) : [q, ...questions];

    // auto-sync new words → global dictionary
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
    </div>
  );
}
