import React, { useState, useMemo } from "react";
import Icon from "../components/Icon.jsx";
import { ConfirmButton } from "../components/ui.jsx";
import { WordCard } from "../components/rich.jsx";
import { wordLines } from "../lib/parse.js";

const fmtDate = (ts) => {
  try { return new Date(ts).toLocaleDateString("ar-EG", { day: "numeric", month: "short" }); }
  catch (e) { return ""; }
};

const SPLIT = /\s[—–]\s|\s-\s/;

export default function WordsScreen({ words, onOpen, onDeleteEntry }) {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState("byq");
  const [openId, setOpenId] = useState(null);
  const [copied, setCopied] = useState(false);
  const needle = q.trim().toLowerCase();

  const alpha = useMemo(() => {
    const seen = new Map();
    words.forEach((w) =>
      wordLines(w.text).forEach((line) => {
        const [term, ...rest] = line.split(SPLIT);
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

  const openEntry = openId ? grouped.find((g) => g.id === openId) : null;

  const copyAll = async () => {
    const text = alpha.map((x) => (x.rest ? `${x.term} — ${x.rest}` : x.term)).join("\n");
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1400); }
    catch (e) { /* clipboard unavailable */ }
  };

  return (
    <div className="page page-wide sec-violet">
      <div className="page-head">
        <h1>قاموس الكلمات</h1>
        <button onClick={copyAll} className="btn btn-ghost btn-sm">
          <Icon name={copied ? "check" : "copy"} size={16} /> نسخ الكل
        </button>
      </div>

      <div className="search">
        <Icon name="search" size={18} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="دوّر على مصطلح…" className="input" dir="auto" />
      </div>

      <div className="seg">
        {[["byq", "حسب السؤال"], ["alpha", "أبجدي"]].map(([id, label]) => (
          <button key={id} onClick={() => { setMode(id); setOpenId(null); }} data-on={mode === id} className="chip">{label}</button>
        ))}
      </div>

      {words.length === 0 ? (
        <div className="card empty">
          <span className="empty-ico"><Icon name="library" size={32} /></span>
          <b>القاموس فاضي لحد دلوقتي</b>
          <p>أي كلمات جديدة هتتضاف هنا تلقائياً لما تحفظ سؤال.</p>
        </div>
      ) : mode === "alpha" ? (
        <div className="wlist">
          {alpha.length === 0 && <p style={{ padding: 24, textAlign: "center", color: "var(--ink-3)" }}>مفيش نتائج.</p>}
          {alpha.map((x) => <WordCard key={x.term} line={x.rest ? `${x.term} — ${x.rest}` : x.term} />)}
        </div>
      ) : openEntry ? (
        <div>
          <div className="qdetail-head">
            <button onClick={() => setOpenId(null)} className="iconbtn" aria-label="كل الأسئلة"><Icon name="back" size={19} /></button>
            <h1 dir="auto">{openEntry.title}</h1>
          </div>
          <div className="qdetail-actions">
            <button onClick={() => onOpen(openEntry.qid)} className="btn btn-ghost btn-sm"><Icon name="fileText" size={16} /> افتح السؤال</button>
            <ConfirmButton label="حذف الكلمات" onConfirm={() => { onDeleteEntry(openEntry.id); setOpenId(null); }} />
          </div>
          <p className="words-count">{openEntry.lines.length} كلمة / عبارة</p>
          <div className="words">
            {openEntry.lines.map((l, i) => <WordCard key={i} line={l} />)}
          </div>
        </div>
      ) : (
        <div className="qfolders">
          {grouped.length === 0 && <p style={{ padding: 24, textAlign: "center", color: "var(--ink-3)" }}>مفيش نتائج.</p>}
          {grouped.map((w) => (
            <button key={w.id} onClick={() => setOpenId(w.id)} className="card qfolder">
              <span className="qf-ico"><Icon name="bookOpen" size={22} /></span>
              <span className="qf-body">
                <h3 dir="auto">{w.title}</h3>
                <p>{fmtDate(w.updatedAt)}</p>
              </span>
              <span className="qf-count">{w.lines.length}</span>
              <span className="qf-go"><Icon name="back" size={18} /></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
