import React, { useState, useEffect, useRef, useCallback, memo } from "react";
import Icon from "../components/Icon.jsx";
import { AutoTextArea, ConfirmButton } from "../components/ui.jsx";
import { Monitor } from "../components/Progress.jsx";
import { RichText, QuestionView, WordList } from "../components/rich.jsx";
import { CHIPS, MODES, SECTIONS, EMPTY_RESULT } from "../lib/config.js";
import { createAnalysis, TASK_KEYS } from "../lib/analysis.js";
import { createTracker, restartTask, snapshot, feed, settle, expectedMs, fmtRemaining } from "../lib/progress.js";
import { fileToCompressedDataUrl } from "../lib/image.js";
import { warmConnection } from "../lib/gemini.js";
import { store } from "../lib/storage.js";

const TASK_OF = { original_question_text: "ocr", new_words: "words", explanation: "reason", tricks: "reason" };
const NULLS = { original_question_text: null, new_words: null, explanation: null, tricks: null };
const FLUSH_MS = 90; // streamed text is painted ~11×/s — smooth, and cheap for long explanations

/* ───────── one result card ───────── */

const Skeleton = ({ hint }) => (
  <div className="skel-wrap" aria-label="جاري التحضير">
    {hint && <p className="skel-hint"><span className="live" style={{ margin: 0 }}><i /><i /><i /></span>{hint}</p>}
    <div className="skel" style={{ width: "92%" }} />
    <div className="skel" style={{ width: "78%" }} />
    <div className="skel" style={{ width: "86%" }} />
    <div className="skel" style={{ width: "52%" }} />
  </div>
);

const ResultSection = memo(function ResultSection({ section, value, onChange, running, error, onRetry, defaultOpen }) {
  const { key, title, sub, icon, rows, cls, ltr, wait } = section;
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(defaultOpen);
  const pending = value === null || value === undefined;
  const hasText = !pending && value.trim().length > 0;
  const canTool = !pending && !running && (hasText || editing);

  /* a section that starts working, or fails, opens by itself so nothing important stays hidden */
  useEffect(() => { if (running || error) setOpen(true); }, [running, !!error]); // eslint-disable-line react-hooks/exhaustive-deps

  const copy = async () => {
    try { await navigator.clipboard.writeText(value || ""); setCopied(true); setTimeout(() => setCopied(false), 1400); }
    catch (e) { /* clipboard unavailable */ }
  };

  return (
    <section className={`sec ${cls}`} data-open={open}>
      <header className="sec-head">
        <button type="button" className="sec-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="sec-ico"><Icon name={icon} size={21} /></span>
          <span className="sec-title">
            <h3>
              {title}
              {running && hasText && <span className="live" aria-label="بيتكتب دلوقتي"><i /><i /><i /></span>}
            </h3>
            <p>{sub}</p>
          </span>
        </button>
        {open && canTool && (
          <div className="sec-tools">
            <button className="iconbtn" onClick={() => setEditing((e) => !e)} aria-label={editing ? "تم" : `تعديل ${title}`}>
              <Icon name={editing ? "check" : "pencil"} size={16} />
            </button>
            <button className="iconbtn" onClick={copy} aria-label={`نسخ ${title}`}>
              <Icon name={copied ? "check" : "copy"} size={16} />
            </button>
          </div>
        )}
        <button type="button" className="sec-chev" aria-expanded={open} aria-label={open ? `اقفل ${title}` : `افتح ${title}`} onClick={() => setOpen((o) => !o)}>
          <Icon name="chevron" size={20} />
        </button>
      </header>
      {open && <div className="sec-body">
        {pending ? (
          <Skeleton hint={running ? wait : null} />
        ) : editing ? (
          <AutoTextArea value={value} onChange={(v) => onChange(key, v)} rows={rows} ltr={ltr} placeholder="اكتب أو عدّل هنا…" />
        ) : !hasText ? (
          !running && !error && <button onClick={() => setEditing(true)} className="btn btn-ghost" style={{ width: "100%" }}>فاضي. دوس هنا واكتب بنفسك</button>
        ) : key === "new_words" ? (
          <WordList text={value} warm={!running} />
        ) : key === "original_question_text" ? (
          <QuestionView text={value} />
        ) : (
          <RichText text={value} />
        )}
        {error && (
          <div className="sec-err" role="alert">
            <p>{error.message}</p>
            {error.detail && <small>{error.detail}</small>}
            <button className="btn btn-ghost btn-sm" onClick={() => onRetry(TASK_OF[key])}><Icon name="refresh" size={15} /> جرّب الجزء ده تاني</button>
          </div>
        )}
      </div>}
    </section>
  );
});

/* ───────── editor ───────── */

export default function Editor({ initial, boot, apiKey, perf, onLearn, onNeedKey, onSave, onDelete }) {
  const [title, setTitle] = useState(initial?.title || "");
  const [imageUrl, setImageUrl] = useState(null);
  const [instructions, setInstructions] = useState(initial?.instructions || "");
  const [chips, setChips] = useState(initial?.chips || []);
  const [moreOpen, setMoreOpen] = useState(false);
  const [mode, setMode] = useState(boot.mode && MODES[boot.mode] ? boot.mode : "balanced");
  const [result, setResult] = useState(initial ? {
    original_question_text: initial.original_question_text || "",
    new_words: initial.new_words || "",
    explanation: initial.explanation || "",
    tricks: initial.tricks || "",
  } : null);
  const [status, setStatus] = useState({});      // task → run | done | error | stopped
  const [errors, setErrors] = useState({});      // task → { message, detail }
  const [models, setModels] = useState({});
  const [error, setError] = useState(null);      // page-level message
  const [snap, setSnap] = useState(null);
  const [runId, setRunId] = useState(0);
  const [over, setOver] = useState(false);
  const [lastRun, setLastRun] = useState(null);  // { sec } of the last completed run
  const [timing, setTiming] = useState({});     // task → measured timings of the last run (shown under the result)

  const fileRef = useRef(null);
  const resultRef = useRef(null);
  const an = useRef(null);
  const tracker = useRef(null);
  const prev = useRef(null);
  const buf = useRef({});
  const timer = useRef(0);
  const perfRef = useRef(perf);
  const modeRef = useRef(mode);
  perfRef.current = perf;
  modeRef.current = mode;

  const running = Object.values(status).some((s) => s === "run");
  const started = !!result;

  /* ── auto-save ──
     A finished analysis saves itself; later edits (text, title, instructions, picture) are saved a moment after you stop.
     The first save creates the question, every later save updates that same question (same id), so there are no copies. */
  const [savedId, setSavedId] = useState(initial?.id || null);
  const [imgRev, setImgRev] = useState(0);                                    // bumps only when the person changes / removes the picture
  const savedIdRef = useRef(initial?.id || null);
  const savedImgRev = useRef(initial ? 0 : -1);
  const lastSig = useRef(null);       // what is already stored; unchanged content is never re-saved
  const saveTimer = useRef(0);
  const pendingSave = useRef(false);
  const busy = useRef(false);
  const again = useRef(false);
  const autoOK = useRef(!!initial);   // a run the person stopped half-way is never saved by itself
  const gone = useRef(false);
  const savePromise = useRef(null);
  const latest = useRef(null);
  const sigNow = JSON.stringify([title, instructions, chips, result, imgRev]);
  latest.current = { title, imageUrl, instructions, chips, result, imgRev, sig: sigNow, onSave };

  const persist = useCallback(() => {
    pendingSave.current = false;
    if (busy.current) { again.current = true; return savePromise.current; }
    busy.current = true;
    savePromise.current = (async () => {
      try {
        do {
          again.current = false;
          const L = latest.current;
          if (gone.current || !L.result || L.sig === lastSig.current) break;
          const id = await L.onSave({
            id: savedIdRef.current, title: L.title, imageUrl: L.imageUrl, imageChanged: L.imgRev !== savedImgRev.current,
            instructions: L.instructions, chips: L.chips,
            result: Object.fromEntries(Object.entries(L.result).map(([k, v]) => [k, v ?? ""])),
          });
          if (id) { savedIdRef.current = id; setSavedId(id); }
          lastSig.current = L.sig;
          savedImgRev.current = L.imgRev;
          setError((cur) => (cur && cur.saveFail ? null : cur));   // a save that failed earlier has now gone through
        } while (again.current);
      } catch (err) {
        // nothing is shown while saving works; only a real failure speaks (and leaving the screen tries once more)
        pendingSave.current = true;
        setError({ msg: "السؤال ماتحفظش. اتأكد إن في مساحة فاضية على الموبايل وجرّب تعدّل أي حاجة أو ارجع تاني.", saveFail: true });
      } finally {
        busy.current = false;
      }
    })();
    return savePromise.current;
  }, []);

  /* ── housekeeping ── */
  useEffect(() => { warmConnection(apiKey); }, [apiKey]);
  useEffect(() => () => {
    an.current?.cancel(); clearTimeout(timer.current);
    clearTimeout(saveTimer.current);
    if (pendingSave.current && !gone.current) persist();   // leaving right after an edit: save it now
  }, [persist]);

  /* the app going to the background (or being switched away from) must not lose a pending edit either */
  useEffect(() => {
    const h = () => {
      if (document.visibilityState === "hidden" && pendingSave.current) { clearTimeout(saveTimer.current); persist(); }
    };
    document.addEventListener("visibilitychange", h);
    return () => document.removeEventListener("visibilitychange", h);
  }, [persist]);

  useEffect(() => {
    if (!initial?.id) return;
    let alive = true;
    store.get(`nclex:img:${initial.id}`).then((r) => { if (alive && r?.data) setImageUrl(r.data); });
    return () => { alive = false; };
  }, [initial?.id]);

  const pickMode = (m) => { setMode(m); store.set("nclex:mode", m); };

  const takeFile = useCallback(async (file) => {
    if (!file || !file.type.startsWith("image/")) { setError({ msg: "الملف لازم يكون صورة." }); return; }
    try { setImageUrl(await fileToCompressedDataUrl(file)); setImgRev((n) => n + 1); setError(null); warmConnection(apiKey); }
    catch (e) { setError({ msg: e.message }); }
  }, [apiKey]);

  useEffect(() => {
    const onPaste = (e) => {
      const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
      if (item) { e.preventDefault(); takeFile(item.getAsFile()); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [takeFile]);

  const toggleChip = (c) =>
    setChips((cur) => (cur.includes(c.id) ? cur.filter((x) => x !== c.id) : [...cur.filter((x) => x !== c.excludes), c.id]));

  /* ── progress clock (4×/s while anything is running) ── */
  useEffect(() => {
    if (!running || !tracker.current) return;
    const tick = () => setSnap(snapshot(tracker.current));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [running, runId]);

  useEffect(() => {
    if (runId && resultRef.current) {
      const t = setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
      return () => clearTimeout(t);
    }
  }, [runId]);

  /* ── streamed text → state (throttled) ── */
  const flush = useCallback(() => {
    clearTimeout(timer.current); timer.current = 0;
    const d = buf.current; buf.current = {};
    if (Object.keys(d).length) setResult((r) => ({ ...(r || EMPTY_RESULT), ...d }));
  }, []);
  const queue = useCallback((data, now) => {
    Object.assign(buf.current, data);
    if (now) flush();
    else if (!timer.current) timer.current = setTimeout(flush, FLUSH_MS);
  }, [flush]);

  /* ── the analysis ── */
  const onUpdate = (name, data, meta) => {
    feed(tracker.current, name, meta.chars);
    if (meta.model) setModels((m) => (m[name] === meta.model ? m : { ...m, [name]: meta.model }));
    queue(data, meta.final);
  };

  const onDone = (name, m) => {
    setTiming((t) => ({ ...t, [name]: m }));
    settle(tracker.current, name, "done");
    setStatus((s) => ({ ...s, [name]: "done" }));
    setErrors((e) => { if (!e[name]) return e; const n = { ...e }; delete n[name]; return n; });
    onLearn(name, modeRef.current, m.ms, m.chars);
  };

  const fillMissing = (name, partial) => {
    flush();
    setResult((r) => {
      const n = { ...(r || EMPTY_RESULT), ...(partial || {}) };
      TASK_KEYS[name].forEach((k) => { if (n[k] === null || n[k] === undefined) n[k] = prev.current?.[k] ?? ""; });
      return n;
    });
  };

  const onError = (name, err, partial) => {
    settle(tracker.current, name, "error");
    setStatus((s) => ({ ...s, [name]: "error" }));
    setErrors((e) => ({ ...e, [name]: { message: err.message || "حصلت مشكلة أثناء التحليل.", detail: err.detail } }));
    fillMissing(name, partial);
    if (err.fatal) onNeedKey();
  };

  const finish = (nextStatus) => {
    const vals = Object.values(nextStatus);
    if (tracker.current && vals.length && !vals.includes("run")) {
      const s = snapshot(tracker.current);
      setSnap(s);
      setLastRun({ sec: Math.round(s.elapsedSec), stopped: vals.includes("stopped") });
    }
  };
  useEffect(() => { if (started && !running) finish(status); }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  /* a finished run (even with a failed part, which "retry" later fixes in the same question) is saved; a stopped one is not */
  useEffect(() => {
    if (!started || running) return;
    const vals = Object.values(status);
    if (vals.length) autoOK.current = !vals.includes("stopped");
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (lastSig.current === null && initial) { lastSig.current = sigNow; return; }   // just opening a saved question is not an edit
    if (running || !autoOK.current || !result || sigNow === lastSig.current) return;
    pendingSave.current = true;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(persist, savedIdRef.current ? 900 : 250);
  }, [sigNow, running]); // eslint-disable-line react-hooks/exhaustive-deps

  const makeAnalysis = () => createAnalysis({
    dataUrl: imageUrl, extra: instructions, chips, apiKey, modeId: mode,
    onUpdate, onDone, onError,
  });

  const analyze = () => {
    if (!imageUrl) { setError({ msg: "ارفع صورة السؤال الأول." }); return; }
    if (!apiKey) { setError({ msg: "محتاج تحط مفتاح Gemini الأول. دوس على أيقونة 🔑 فوق." }); onNeedKey(); return; }
    an.current?.cancel();
    clearTimeout(timer.current); timer.current = 0; buf.current = {};
    clearTimeout(saveTimer.current); pendingSave.current = false; autoOK.current = false;
    prev.current = result;
    tracker.current = createTracker(mode, perfRef.current);
    setSnap(snapshot(tracker.current));
    setError(null); setErrors({}); setModels({}); setLastRun(null); setTiming({});
    setResult({ ...NULLS });
    setStatus({ ocr: "run", words: "run", reason: "run" });
    an.current = makeAnalysis();
    setRunId((n) => n + 1);
    an.current.start();
  };

  const retry = (name) => {
    if (!an.current || !tracker.current) return;
    restartTask(tracker.current, name, perfRef.current);
    TASK_KEYS[name].forEach((k) => { buf.current[k] = null; });
    flush();
    setErrors((e) => { const n = { ...e }; delete n[name]; return n; });
    setStatus((s) => ({ ...s, [name]: "run" }));
    setLastRun(null);
    an.current.retry(name);
  };

  const stop = () => {
    an.current?.cancel();
    autoOK.current = false;
    flush();
    setStatus((s) => {
      const n = { ...s };
      Object.keys(n).forEach((k) => { if (n[k] === "run") { n[k] = "stopped"; settle(tracker.current, k, "stopped"); } });
      return n;
    });
    setResult((r) => {
      const n = { ...(r || EMPTY_RESULT) };
      Object.keys(n).forEach((k) => { if (n[k] === null) n[k] = prev.current?.[k] ?? ""; });
      return n;
    });
  };

  const setField = useCallback((key, v) => setResult((r) => ({ ...(r || EMPTY_RESULT), [key]: v })), []);
  const removeQuestion = async () => {
    gone.current = true; clearTimeout(saveTimer.current); pendingSave.current = false;
    try { await savePromise.current; } catch (err) { /* nothing to wait for */ }
    onDelete(savedIdRef.current);
  };

  /* ── derived: the four monitor lamps ── */
  const has = (k) => !!result && result[k] !== null && result[k] !== undefined && result[k] !== "";
  const lamp = (task, live) => {
    const s = status[task];
    if (s === "error") return "error";
    if (s === "done") return "done";
    if (s === "run") return live ? "live" : "wait";
    return "wait";
  };
  const steps = [
    { id: "read", label: "قراءة السؤال", s: lamp("ocr", has("original_question_text")) },
    { id: "words", label: "الكلمات", s: lamp("words", has("new_words")) },
    { id: "explain", label: "التفصيص", s: status.reason === "run" && result?.tricks != null ? "done" : lamp("reason", has("explanation")) },
    { id: "tricks", label: "التريكات", s: lamp("reason", result?.tricks != null && result.tricks !== "") },
  ];

  const usedModels = [...new Set(Object.values(models))].join(" + ");
  /* measured, not estimated: where the time really went in this run (helps to spot a slow model or network) */
  const sec1 = (ms) => `${(ms / 1000).toFixed(1)}ث`;
  const timingLine = [
    timing.ocr && `قراءة ${sec1(timing.ocr.ms)}`,
    timing.words && `كلمات ${sec1(timing.words.ms)}`,
    timing.reason?.stages && `حلّ ${timing.reason.stages.solve}ث · أساس ${timing.reason.stages.a}ث · تفصيص ${timing.reason.stages.b}ث`,
  ].filter(Boolean).join(" · ");
  const errCount = Object.values(status).filter((s) => s === "error").length;

  return (
    <div className="page">
      <div className="page-head">
        <h1>{savedId ? "تعديل السؤال" : "سؤال جديد"}</h1>
        {savedId && <ConfirmButton onConfirm={removeQuestion} label="حذف السؤال" />}
      </div>

      <div className="stack ed-grid">
        <aside className="ed-side">
        {/* 1 · the screenshot */}
        <div>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { takeFile(e.target.files?.[0]); e.target.value = ""; }} />
          {imageUrl ? (
            <div className="card preview">
              <img src={imageUrl} alt="صورة السؤال" />
              <div className="preview-actions">
                <button onClick={() => fileRef.current?.click()} className="btn btn-ghost btn-sm"><Icon name="imagePlus" size={16} /> غيّر الصورة</button>
                <button onClick={() => { setImageUrl(null); setImgRev((n) => n + 1); }} className="btn btn-danger btn-sm"><Icon name="x" size={16} /> شيل</button>
              </div>
            </div>
          ) : (
            <button type="button" data-over={over} className="drop"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); takeFile(e.dataTransfer.files?.[0]); }}>
              <span className="drop-ico"><Icon name="imagePlus" size={28} /></span>
              <b>ارفع سكرين شوت السؤال</b>
              <span className="hint">اضغط عشان تختار الصورة، أو الصقها بـ Ctrl+V</span>
            </button>
          )}
        </div>

        {/* 2 · mode */}
        <div>
          <span className="label">وضع التحليل</span>
          <div className="modes" role="radiogroup" aria-label="وضع التحليل">
            {Object.values(MODES).map((m) => (
              <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} data-on={mode === m.id}
                onClick={() => pickMode(m.id)} className="mode">
                <b>{m.label}</b>
                <small>{m.sub}</small>
                <span className="eta">{fmtRemaining(Math.round(expectedMs(perf, "reason", m.id) / 1000))}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 3 · optional */}
        <div>
          <button type="button" className="more-btn" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}>
            <span>عنوان وتعليمات إضافية <small style={{ opacity: .65 }}>(اختياري)</small></span>
            <Icon name="chevron" size={18} />
          </button>
          {moreOpen && (
            <div className="more-body">
              <label htmlFor="q-title" className="label">عنوان السؤال</label>
              <input id="q-title" value={title} onChange={(e) => setTitle(e.target.value)} className="input" dir="auto"
                placeholder="سيبه فاضي وهنسمّيه من نص السؤال" />
              <label htmlFor="q-extra" className="label" style={{ marginTop: 14 }}>تعليمات إضافية للذكاء الاصطناعي</label>
              <textarea id="q-extra" dir="auto" rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)}
                className="input area" style={{ overflow: "auto" }} placeholder="مثلاً: ركّز على الأدوية أو اشرح الـ rationale بالتفصيل" />
              <div className="chips">
                {CHIPS.map((c) => (
                  <button key={c.id} type="button" aria-pressed={chips.includes(c.id)} data-on={chips.includes(c.id)}
                    onClick={() => toggleChip(c)} className="chip">
                    {c.label}
                    {chips.includes(c.id) && <Icon name="check" size={14} />}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {!started && (
          <button onClick={analyze} disabled={!imageUrl} className="btn btn-teal btn-go">
            <Icon name="sparkles" size={24} /> حلّل السؤال
          </button>
        )}

        {error && (
          <div role="alert" className="alert">
            <Icon name="alert" size={22} />
            <div style={{ minWidth: 0 }}>
              <b>{error.msg}</b>
              {error.detail && <small>{error.detail}</small>}
            </div>
          </div>
        )}

        </aside>

        {/* 4 · results */}
        {started && (
          <div ref={resultRef} className="results">
            {running && snap && <Monitor snap={snap} steps={steps} onStop={stop} />}
            {!running && lastRun && (
              <div className={`done-bar${errCount ? " warn" : ""}`}>
                <Icon name={errCount ? "alert" : "check"} size={18} />
                {errCount ? "خلص، بس جزء فيه مشكلة (تحت)" : lastRun.stopped ? "اتوقف التحليل قبل ما يخلص" : `خلص التحليل في ${lastRun.sec} ث`}
                {usedModels && <small>{usedModels}</small>}
                {timingLine && <small style={{ width: "100%", marginInlineStart: 0, direction: "rtl", textAlign: "start", opacity: .85 }}>⏱ {timingLine}</small>}
              </div>
            )}
            {SECTIONS.map((s) => {
              const task = TASK_OF[s.key];
              return (
                <ResultSection key={s.key} section={s} value={result[s.key]} onChange={setField}
                  running={status[task] === "run"} error={s.key === "tricks" ? null : errors[task]}
                  onRetry={retry} defaultOpen={!initial} />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
