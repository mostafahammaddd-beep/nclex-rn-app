import React, { useState, useEffect, useRef, useCallback } from "react";
import Icon from "./Icon.jsx";
import { RichText } from "./rich.jsx";
import { askChat } from "../lib/chat.js";
import { fixText } from "../lib/text.js";
import { store } from "../lib/storage.js";

const uid = () => Math.random().toString(36).slice(2, 10);

const SUGGEST = [
  { label: "اشرحلي أكتر", text: "اشرحلي السؤال ده بشكل أعمق وبالتفصيل، خطوة بخطوة.", send: true },
  { label: "ليه الباقي غلط؟", text: "ليه كل اختيار من الاختيارات التانية غلط؟ وإيه الكلمة اللي بتكشفه؟", send: true },
  { label: "أنا معترض ✋", text: "أنا معترض على الإجابة، لأن ", send: false },
  { label: "اديني مثال شبهه", text: "اديني حالة مشابهة بس بأرقام وسيناريو مختلف، وخليني أحلها.", send: true },
  { label: "لخّصها في سطرين", text: "لخّصلي القاعدة اللي لازم أحفظها من السؤال ده في سطرين.", send: true },
];

/* Chat drawer. Stays mounted (hidden) after the first open so an answer that is still streaming is never lost. */
export default function ChatPanel({ open, onClose, apiKey, onNeedKey, ctx, chipIds, storeKey }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  const abortRef = useRef(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const stick = useRef(true);

  /* load / save the conversation (per saved question) */
  useEffect(() => {
    if (!storeKey) return;
    let alive = true;
    store.get(storeKey).then((r) => { if (alive && Array.isArray(r) && r.length) setMessages((cur) => (cur.length ? cur : r)); });
    return () => { alive = false; };
  }, [storeKey]);

  useEffect(() => {
    if (!storeKey || busy || !messages.length) return;
    const t = setTimeout(() => store.set(storeKey, messages.slice(-60).map(({ id, role, text }) => ({ id, role, text }))), 400);
    return () => clearTimeout(t);
  }, [messages, busy, storeKey]);

  useEffect(() => () => abortRef.current?.abort(), []);

  /* keep the newest text in view unless the student scrolled up to read */
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, open]);
  const onScroll = () => {
    const el = listRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  };

  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => inputRef.current?.focus(), 120);
    const esc = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => { clearTimeout(t); window.removeEventListener("keydown", esc); };
  }, [open, onClose]);

  const patch = (id, fn) => setMessages((cur) => cur.map((m) => (m.id === id ? fn(m) : m)));

  const send = useCallback(async (raw, base) => {
    const q = (raw ?? input).trim();
    if (!q || busy) return;
    if (!apiKey) { onNeedKey(); return; }
    const history = [...(base || messages), { id: uid(), role: "user", text: q }];
    const ai = { id: uid(), role: "ai", text: "" };
    setMessages([...history, ai]);
    setInput(""); setBusy(true); stick.current = true;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const out = await askChat({
        apiKey, history, ctx, chipIds, signal: ctrl.signal,
        onText: (t) => patch(ai.id, (m) => ({ ...m, text: fixText(t) })),
      });
      patch(ai.id, (m) => ({ ...m, text: fixText(out.text) }));
    } catch (err) {
      if (err && err.name === "AbortError") patch(ai.id, (m) => ({ ...m, stopped: true }));
      else patch(ai.id, (m) => ({ ...m, err: (err && err.message) || "حصلت مشكلة. جرّب تاني." }));
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setBusy(false);
    }
  }, [input, busy, apiKey, messages, ctx, chipIds, onNeedKey]);

  const stop = () => abortRef.current?.abort();

  const retry = (aiId) => {
    const i = messages.findIndex((m) => m.id === aiId);
    const user = i > 0 ? messages[i - 1] : null;
    if (user && user.role === "user") send(user.text, messages.slice(0, i - 1));
  };

  const clear = () => {
    if (!sure) { setSure(true); setTimeout(() => setSure(false), 2500); return; }
    abortRef.current?.abort();
    setMessages([]); setSure(false);
    if (storeKey) store.del(storeKey);
  };

  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  };

  const suggest = (s) => {
    if (s.send) send(s.text);
    else { setInput(s.text); setTimeout(() => inputRef.current?.focus(), 30); }
  };

  return (
    <aside className="chat" hidden={!open} aria-label="دردشة مع الـ AI">
      <header className="chat-head">
        <span className="chat-ico"><Icon name="chat" size={20} /></span>
        <span className="chat-title"><b>اسأل الـ AI عن السؤال</b><small>اطلب شرح أعمق أو اعترض على أي حاجة</small></span>
        {messages.length > 0 && (
          <button type="button" className="iconbtn chat-clear" data-sure={sure} onClick={clear} aria-label="مسح المحادثة" title="مسح المحادثة">
            {sure ? <span className="chat-sure">تأكيد؟</span> : <Icon name="trash" size={17} />}
          </button>
        )}
        <button type="button" className="iconbtn" onClick={onClose} aria-label="إغلاق"><Icon name="x" size={18} /></button>
      </header>

      <div className="chat-list" ref={listRef} onScroll={onScroll}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <span className="chat-empty-ico"><Icon name="sparkles" size={30} /></span>
            <b>عايز تفهم حاجة أكتر؟</b>
            <p>اسأل أي سؤال عن الاختيارات أو القاعدة أو الكلمات، أو اعترض لو شايف الإجابة غلط. هراجعها معاك بصراحة.</p>
            <div className="chat-sugs">
              {SUGGEST.map((s) => <button key={s.label} type="button" className="chat-sug" onClick={() => suggest(s)}>{s.label}</button>)}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`chat-msg ${m.role === "user" ? "me" : "bot"}`}>
            {m.role === "user"
              ? <p dir="auto">{m.text}</p>
              : m.text
                ? <RichText text={m.text} />
                : !m.err && !m.stopped && <span className="chat-typing">بيفكّر<i /><i /><i /></span>}
            {m.stopped && <small className="chat-note">اتوقّف الرد</small>}
            {m.err && (
              <div className="chat-err">
                <span>{m.err}</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => retry(m.id)} disabled={busy}><Icon name="refresh" size={15} /> حاول تاني</button>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="chat-compose">
        <textarea ref={inputRef} dir="auto" rows={1} value={input} placeholder="اكتب سؤالك أو اعتراضك… (Enter للإرسال)"
          onChange={(e) => { setInput(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 150) + "px"; }}
          onKeyDown={onKey} />
        {busy
          ? <button type="button" className="chat-send stop" onClick={stop} aria-label="إيقاف"><Icon name="stop" size={18} /></button>
          : <button type="button" className="chat-send" onClick={() => send()} disabled={!input.trim()} aria-label="إرسال"><Icon name="send" size={18} /></button>}
      </div>
    </aside>
  );
}
