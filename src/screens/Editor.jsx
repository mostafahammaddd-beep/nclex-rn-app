import React, { useState, useEffect, useRef, useCallback, memo } from "react";
import Icon from "../components/Icon.jsx";
import { AutoTextArea, ConfirmButton } from "../components/ui.jsx";
import { Monitor, DockProgress } from "../components/Progress.jsx";
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

const ResultSection = memo(function ResultSection({ section, value, onChange, running, error, onRetry }) {
  const { key, title, sub, icon, rows, cls, ltr, wait } = section;
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const pending = value === null || value === undefined;
  const hasText = !pending && value.trim().length > 0;
  const canTool = !pending && !running && (hasText || editing);

  const copy = async () => {
    try { await navigator.clipboard.writeText(value || ""); setCopied(true); setTimeout(() => setCopied(false), 1400); }
    catch (e) { /* clipboard unavailable */ }
  };

  return (
    <section className={`sec ${cls}`}>
      <header className="sec-head">
        <span className="sec-ico"><Icon name={icon} size={21} /></span>
        <div className="sec-title">
          <h3>
            {title}
            {running && hasText && <span className="live" aria-label="بيتكتب دلوقتي"><i /><i /><i /></span>}
          </h3>
          <p>{sub}</p>
        </div>
        {canTool && (
          <div className="sec-tools">
            <button className="iconbtn" onClick={() => setEditing((e) => !e)} aria-label={editing ? "تم" : `تعديل ${title}`}>
              <Icon name={editing ? "check" : "pencil"} size={16} />
            </button>
            <button className="iconbtn" onClick={copy} aria-label={`نسخ ${title}`}>
              <Icon name={copied ? "check" : "copy"} size={16} />
            </button>
          </div>
        )}
      </header>
      <div className="sec-body">
        {pending ? (
          <Skeleton hint={running ? wait : null} />
        ) : editing ? (
          <AutoTextArea value={value} onChange={(v) => onChange(key, v)} rows={rows} ltr={ltr} placeholder="اكتب أو عدّل هنا…" />
        ) : !hasText ? (
          !running && !error && <button onClick={() => setEditing(true)} className="btn btn-ghost" style={{ width: "100%" }}>فاضي. دوس هنا واكتب بنفسك</button>
        ) : key === "new_words" ? (
          <WordList text={value} />
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
      </div>
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

  /* ── housekeeping ── */
  useEffect(() => { warmConnection(apiKey); }, [apiKey]);
  useEffect(() => () => { an.current?.cancel(); clearTimeout(timer.current); }, []);

  useEffect(() => {
    if (!initial?.id) return;
    let alive = true;
    store.get(`nclex:img:${initial.id}`).then((r) => { if (alive && r?.data) setImageUrl(r.data); });
    return () => { alive = false; };
  }, [initial?.id]);

  const pickMode = (m) => { setMode(m); store.set("nclex:mode", m); };

  const takeFile = useCallback(async (file) => {
    if (!file || !file.type.startsWith("image/")) { setError({ msg: "الملف لازم يكون صورة." }); return; }
    try { setImageUrl(await fileToCompressedDataUrl(file)); setError(null); warmConnection(apiKey); }
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

  const makeAnalysis = () => createAnalysis({
    dataUrl: imageUrl, extra: instructions, chips, apiKey, modeId: mode,
    onUpdate, onDone, onError,
  });

  const analyze = () => {
    if (!imageUrl) { setError({ msg: "ارفع صورة السؤال الأول." }); return; }
    if (!apiKey) { setError({ msg: "محتاج تحط مفتاح Gemini الأول. دوس على أيقونة 🔑 فوق." }); onNeedKey(); return; }
    an.current?.cancel();
    clearTimeout(timer.current); timer.current = 0; buf.current = {};
    prev.current = result;
    tracker.current = createTracker(mode, perfRef.current);
    setSnap(snapshot(tracker.current));
    setError(null); setErrors({}); setModels({}); setLastRun(null);
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
  const save = () => onSave({
    title, imageUrl, instructions, chips,
    result: Object.fromEntries(Object.entries(result || EMPTY_RESULT).map(([k, v]) => [k, v ?? ""])),
  });

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
  const errCount = Object.values(status).filter((s) => s === "error").length;

  return (
    <div className="page">
      <div className="page-head">
        <h1>{initial ? "تعديل السؤال" : "سؤال جديد"}</h1>
        {initial && <ConfirmButton onConfirm={() => onDelete(initial.id)} label="حذف السؤال" />}
      </div>

      <div className="stack">
        {/* 1 · the screenshot */}
        <div>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { takeFile(e.target.files?.[0]); e.target.value = ""; }} />
          {imageUrl ? (
            <div className="card preview">
              <img src={imageUrl} alt="صورة السؤال" />
              <div className="preview-actions">
                <button onClick={() => fileRef.current?.click()} className="btn btn-ghost btn-sm"><Icon name="imagePlus" size={16} /> غيّر الصورة</button>
                <button onClick={() => setImageUrl(null)} className="btn btn-danger btn-sm"><Icon name="x" size={16} /> شيل</button>
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

        {/* 4 · results */}
        {started && (
          <div ref={resultRef} className="results">
            {running && snap && <Monitor snap={snap} steps={steps} onStop={stop} />}
            {!running && lastRun && (
              <div className={`done-bar${errCount ? " warn" : ""}`}>
                <Icon name={errCount ? "alert" : "check"} size={18} />
                {errCount ? "خلص، بس جزء فيه مشكلة (تحت)" : lastRun.stopped ? "اتوقف التحليل قبل ما يخلص" : `خلص التحليل في ${lastRun.sec} ث`}
                {usedModels && <small>{usedModels}</small>}
              </div>
            )}
            {SECTIONS.map((s) => {
              const task = TASK_OF[s.key];
              return (
                <ResultSection key={s.key} section={s} value={result[s.key]} onChange={setField}
                  running={status[task] === "run"} error={s.key === "tricks" ? null : errors[task]}
                  onRetry={retry} />
              );
            })}
            <p className="note-end">ملحوظة: Regenerate بيستبدل أي تعديلات عملتها على النتيجة الحالية.</p>
          </div>
        )}
      </div>

      {/* 5 · dock */}
      {started && (
        <div className="dock">
          <div className="dock-in">
            {running && snap ? (
              <DockProgress snap={snap} onStop={stop} />
            ) : (
              <>
                <button onClick={analyze} className="btn btn-ghost btn-regen" aria-label="Regenerate">
                  <Icon name="refresh" size={18} /><span className="lbl">Regenerate</span>
                </button>
                <button onClick={save} className="btn btn-sun btn-save">
                  <Icon name="save" size={20} /><span>حفظ السؤال</span>
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
