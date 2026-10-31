import React, { useMemo } from "react";
import Icon from "../components/Icon.jsx";
import { CHEERS } from "../lib/config.js";
import { wordLines, studyStats } from "../lib/parse.js";

const fmtDate = (ts) => {
  try { return new Date(ts).toLocaleDateString("ar-EG", { day: "numeric", month: "short" }); }
  catch (e) { return ""; }
};

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "لسه صاحي؟ ربنا يعينك 🌙";
  if (h < 12) return "صباح الخير ☀️";
  if (h < 18) return "أهلاً بيك 👋";
  return "مساء الخير 🌙";
}

const R = 36, C = 2 * Math.PI * R;

export default function Home({ questions, words, goal, onGoal, onAdd, onWords, onOpen }) {
  const cheer = CHEERS[new Date().getDate() % CHEERS.length];
  const sorted = useMemo(() => [...questions].sort((a, b) => b.updatedAt - a.updatedAt), [questions]);
  const wordCount = useMemo(() => words.reduce((n, w) => n + wordLines(w.text).length, 0), [words]);
  const stats = useMemo(() => studyStats(questions, goal), [questions, goal]);
  const pct = Math.min(1, stats.today / Math.max(1, goal));
  const left = Math.max(0, goal - stats.today);

  return (
    <div className="page page-wide">
      <section className="hero">
        <p className="hello">{greeting()}</p>
        <h1>جاهز تحل سؤال النهاردة؟</h1>
        <p className="cheer">{cheer}</p>
      </section>

      <button type="button" className="card goal" onClick={onGoal} aria-label="غيّر هدف اليوم">
        <div className="ring">
          <svg viewBox="0 0 84 84" aria-hidden="true">
            <circle className="ring-track" cx="42" cy="42" r={R} fill="none" strokeWidth="8" />
            <circle className="ring-val" cx="42" cy="42" r={R} fill="none" strokeWidth="8" strokeLinecap="round"
              strokeDasharray={C} strokeDashoffset={C * (1 - pct)} />
          </svg>
          <div className="ring-num"><div><b>{stats.today}/{goal}</b><span>النهاردة</span></div></div>
        </div>
        <div className="goal-info">
          <h3>{pct >= 1 ? "خلّصت هدف النهاردة 🎉" : "هدف النهاردة"} <Icon name="pencil" size={13} style={{ opacity: .45, verticalAlign: "middle" }} /></h3>
          <p>{pct >= 1 ? "كمّل لو لسه عندك طاقة" : `فاضل ${left} ${left <= 10 ? "أسئلة" : "سؤال"}`}</p>
          <div className="pills">
            <span className="pill pill-fire"><Icon name="flame" size={14} /> <b>{stats.streak}</b> يوم ورا بعض</span>
            <span className="pill pill-violet"><Icon name="library" size={14} /> <b>{wordCount}</b> كلمة</span>
          </div>
        </div>
      </button>

      <div className="cta-grid">
        <button onClick={onAdd} className="cta cta-main">
          <span>
            <b>أضف سؤالاً</b>
            <span className="sub">صوّر السؤال وسيبها على الذكاء الاصطناعي</span>
          </span>
          <span className="cta-ico"><Icon name="plus" size={28} stroke={3} /></span>
        </button>
        <button onClick={onWords} className="cta cta-alt">
          <span>
            <b>قاموس الكلمات</b>
            <span className="sub">{wordCount ? `${wordCount} مصطلح في قاموسك` : "كل كلمة جديدة بتتحفظ هنا"}</span>
          </span>
          <span className="cta-ico"><Icon name="bookOpen" size={26} /></span>
        </button>
      </div>

      <h2 className="h-sec">أسئلتك المحفوظة <span>{sorted.length}</span></h2>

      {sorted.length === 0 ? (
        <div className="card empty">
          <span className="empty-ico"><Icon name="heartPulse" size={34} /></span>
          <b>لسه مفيش أسئلة محفوظة</b>
          <p>ارفع أول سؤال وشوف التفصيص بنفسك.</p>
          <button onClick={onAdd} className="btn btn-teal" style={{ marginTop: 8 }}>أضف أول سؤال</button>
        </div>
      ) : (
        <div className="qlist">
          {sorted.map((q) => {
            const n = wordLines(q.new_words).length;
            return (
              <button key={q.id} className="card qcard" onClick={() => onOpen(q.id)}>
                <span className="qthumb">
                  {q.thumb ? <img src={q.thumb} alt="" loading="lazy" /> : <Icon name="fileText" size={26} />}
                </span>
                <span className="qbody">
                  <h3>{q.title}</h3>
                  <span className="snip" dir="auto">{q.original_question_text || "—"}</span>
                  <span className="qfoot">
                    <span className="pill pill-violet" style={{ padding: "1px 10px" }}>{n} كلمة</span>
                    <span>{fmtDate(q.updatedAt)}</span>
                  </span>
                </span>
                <span className="qgo"><Icon name="back" size={18} /></span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
