import React, { useMemo, useState, useEffect } from "react";
import Icon from "../components/Icon.jsx";
import { wordLines, studyStats } from "../lib/parse.js";
import { levelInfo, weekDays, heroMessage, pickWord } from "../lib/motivation.js";
import { WordCard } from "../components/rich.jsx";

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
  const sorted = useMemo(() => [...questions].sort((a, b) => b.updatedAt - a.updatedAt), [questions]);
  const wordCount = useMemo(() => words.reduce((n, w) => n + wordLines(w.text).length, 0), [words]);
  const stats = useMemo(() => studyStats(questions, goal), [questions, goal]);
  const pct = Math.min(1, stats.today / Math.max(1, goal));
  const left = Math.max(0, goal - stats.today);
  const lv = useMemo(() => levelInfo(questions.length), [questions.length]);
  const week = useMemo(() => weekDays(questions), [questions]);
  const allLines = useMemo(() => words.flatMap((w) => wordLines(w.text)), [words]);
  const [shift, setShift] = useState(0);
  const wod = useMemo(() => pickWord(allLines, shift), [allLines, shift]);

  /* the ring fills up when the screen opens (a small reward for looking at your progress) */
  const [shown, setShown] = useState(0);
  useEffect(() => { const id = requestAnimationFrame(() => setShown(pct)); return () => cancelAnimationFrame(id); }, [pct]);

  return (
    <div className="page page-wide home-in home-grid">
      <div className="home-side">
      <section className="hero">
        <p className="hello">{greeting()}</p>
        <h1>جاهز تحل سؤال النهاردة؟</h1>
        <p className="cheer">{heroMessage({ total: questions.length, today: stats.today, goal, streak: stats.streak })}</p>
      </section>

      <section className="card dash">
        <button type="button" className="goal" onClick={onGoal} aria-label="غيّر هدف اليوم">
          <div className="ring">
            <svg viewBox="0 0 84 84" aria-hidden="true">
              <circle className="ring-track" cx="42" cy="42" r={R} fill="none" strokeWidth="8" />
              <circle className="ring-val" cx="42" cy="42" r={R} fill="none" strokeWidth="8" strokeLinecap="round"
                strokeDasharray={C} strokeDashoffset={C * (1 - shown)} />
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

        <div className="week" role="img" aria-label={`آخر 7 أيام: ${week.filter((d) => d.count).length} أيام فيها مذاكرة`}>
          {week.map((d) => (
            <div key={d.key} className="wd" data-done={d.count > 0} data-today={d.today}>
              <i>{d.count > 0 ? <Icon name="check" size={14} stroke={3} /> : null}</i>
              <span>{d.today ? "النهاردة" : d.label}</span>
            </div>
          ))}
        </div>

        <div className="level">
          <span className="lv-emoji" aria-hidden="true">{lv.emoji}</span>
          <div className="lv-body">
            <div className="lv-top"><b>مستوى {lv.level} · {lv.name}</b></div>
            <div className="lv-bar"><i style={{ width: `${Math.round(lv.pct * 100)}%` }} /></div>
            <small>{lv.next ? `فاضل ${lv.toNext} ${lv.toNext <= 10 ? "أسئلة" : "سؤال"} للمستوى الجاي: ${lv.next.name} ${lv.next.emoji}` : "وصلت لأعلى مستوى، فخور بيك 🏆"}</small>
          </div>
        </div>
      </section>

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

      {wod && (
        <section className="wod">
          <div className="wod-head">
            <h2>كلمة النهاردة ✨</h2>
            {allLines.length > 1 && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShift((n) => n + 1)}>
                <Icon name="refresh" size={15} /> كلمة تانية
              </button>
            )}
          </div>
          <WordCard line={wod} />
        </section>
      )}

      </div>

      <div className="home-main">
      <h2 className="h-sec">أسئلتك المحفوظة <span>{sorted.length}</span></h2>

      {sorted.length === 0 ? (
        <div className="card empty">
          <span className="empty-ico"><Icon name="heartPulse" size={34} /></span>
          <b>لسه مفيش أسئلة محفوظة</b>
          <p>ارفع أول سؤال وشوف التفصيص بنفسك. كل سؤال بتفهمه بيقرّبك من الرخصة 💙</p>
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
    </div>
  );
}
