import React, { memo, useMemo } from "react";
import Icon from "./Icon.jsx";
import { hasArabic, wordLines, parseWord } from "../lib/parse.js";

/* ───────── text-to-speech (English) ───────── */

export const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance === "function";

export function speak(text) {
  if (!canSpeak) return;
  try {
    const u = new window.SpeechSynthesisUtterance(String(text || "").replace(/\*\*/g, ""));
    u.lang = "en-US";
    u.rate = 0.92;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch (e) { /* no TTS engine */ }
}

function SpeakBtn({ text, label = "اسمع النطق" }) {
  if (!canSpeak) return null;
  return (
    <button type="button" className="speak" aria-label={label} onClick={() => speak(text)}>
      <Icon name="volume" size={17} />
    </button>
  );
}

/* ───────── inline: **bold** + Latin runs isolated as LTR so Arabic/English mix correctly ───────── */

const W0 = "[A-Za-z0-9+\\-<>=≥≤±/.%'’&]";            // first char of a token inside a run
const WN = "[A-Za-z0-9'’\\-/.%+&,;:!?<>=≥≤±]*";      // the rest of a token (keeps its punctuation)
const PAR = "\\([A-Za-z0-9 ,.'’\\-/%+&<>=≥≤±]*\\)";
const LATIN_RUN = new RegExp(`(?:[A-H]\\)[ ]+)?[A-Za-z0-9]${WN}(?:[ ]+(?:${W0}${WN}|${PAR}))*(?:[ ]*${PAR})?`, "g");

function latinWrap(t, key) {
  const res = [];
  let last = 0, i = 0;
  for (const m of t.matchAll(LATIN_RUN)) {
    if (m.index > last) res.push(t.slice(last, m.index));
    res.push(<bdi key={`${key}-${i++}`} dir="ltr" className="en">{m[0]}</bdi>);
    last = m.index + m[0].length;
  }
  if (last < t.length) res.push(t.slice(last));
  return res;
}

export function Inline({ text }) {
  const parts = (text || "").split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^\*\*[^*]+\*\*$/.test(p)
          ? <strong key={i} className="kw">{latinWrap(p.slice(2, -2), `b${i}`)}</strong>
          : <React.Fragment key={i}>{latinWrap(p, `t${i}`)}</React.Fragment>
      )}
    </>
  );
}

/* ───────── rich text (explanation + tricks) ───────── */

const dirOf = (s) => (hasArabic(s) ? "rtl" : "ltr");

function parseBlocks(text) {
  const out = [];
  (text || "").split("\n").map((l) => l.trim()).filter(Boolean).forEach((l) => {
    let m;
    if ((m = l.match(/^#{1,3}\s+(.*)$/))) out.push({ t: "h", s: m[1] });
    else if ((m = l.match(/^[-•*]\s+(.*)$/))) {
      const ok = /✅/.test(m[1]), no = /❌/.test(m[1]);
      out.push({ t: "li", s: m[1], v: ok && !no ? "ok" : no && !ok ? "no" : null });
    }
    else if ((m = l.match(/^(\d{1,2})[.)]\s+(.*)$/))) out.push({ t: "num", n: m[1], s: m[2] });
    else if ((m = l.match(/^>\s?(.*)$/))) out.push({ t: "quote", s: m[1] });
    else if (/^💡/.test(l)) out.push({ t: "tip", s: l });
    else if (out.length && out[out.length - 1].t === "quote" && hasArabic(l)) out.push({ t: "trans", s: l });
    else out.push({ t: "p", s: l });
  });
  return out;
}

function Block({ b }) {
  switch (b.t) {
    case "h":
      return <h4><i /><span><Inline text={b.s} /></span></h4>;
    case "li":
      return <div className="li" dir={dirOf(b.s)} data-v={b.v || undefined}><em /><p><Inline text={b.s} /></p></div>;
    case "num":
      return <div className="num" dir={dirOf(b.s)}><b>{b.n}</b><p><Inline text={b.s} /></p></div>;
    case "quote":
      return <div className="quote"><span><Inline text={b.s} /></span><SpeakBtn text={b.s} label="اسمع الجملة" /></div>;
    case "tip":
      return <p className="tip" dir={dirOf(b.s)}><Inline text={b.s} /></p>;
    case "trans":
      return <p className="trans"><Inline text={b.s} /></p>;
    default:
      return <p dir={dirOf(b.s)}><Inline text={b.s} /></p>;
  }
}
const BlockMemo = memo(Block, (a, b) => a.b.t === b.b.t && a.b.s === b.b.s && a.b.v === b.b.v && a.b.n === b.b.n);

export const RichText = memo(function RichText({ text }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const dir = hasArabic(text) ? "rtl" : "ltr";
  return (
    <div dir={dir} className="rt">
      {blocks.map((b, i) => <BlockMemo key={i} b={b} />)}
    </div>
  );
});

/* ───────── the question itself (always LTR English) ───────── */

export const QuestionView = memo(function QuestionView({ text }) {
  const lines = useMemo(() => (text || "").split("\n").map((l) => l.trim()).filter(Boolean), [text]);
  return (
    <div dir="ltr" className="qv">
      {lines.map((l, i) => {
        const m = i > 0 ? l.match(/^\(?([A-H])[).]\s*(.+)$/) : null;
        if (m) return <div key={i} className="opt"><b>{m[1]}</b><p>{m[2]}</p></div>;
        return <p key={i} className="stem" style={i === 0 ? { fontWeight: 600 } : undefined}>{l}</p>;
      })}
    </div>
  );
});

/* ───────── vocabulary ───────── */

export const WordCard = memo(function WordCard({ line }) {
  const { term, meaning, note } = parseWord(line);
  const dir = hasArabic(meaning + note) ? "rtl" : "ltr";
  return (
    <div dir={dir} className="word">
      <div className="word-top">
        <bdi dir="ltr" className="word-term">{term}</bdi>
        <SpeakBtn text={term} />
      </div>
      {meaning && <p className="word-mean"><Inline text={meaning} /></p>}
      {note && <p className="word-note"><Inline text={note} /></p>}
    </div>
  );
});

export function WordList({ text, showCount = true }) {
  const lines = useMemo(() => wordLines(text), [text]);
  return (
    <div>
      {showCount && lines.length > 0 && <p className="words-count">{lines.length} كلمة / عبارة</p>}
      <div className="words">
        {lines.map((l, i) => <WordCard key={i} line={l} />)}
      </div>
    </div>
  );
}
