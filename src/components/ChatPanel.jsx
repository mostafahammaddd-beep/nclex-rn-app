import React, { useState, useEffect, useRef, useCallback } from "react";
import Icon from "./Icon.jsx";
import { RichText } from "./rich.jsx";
import { askChat } from "../lib/chat.js";
import { makePicture, ENGINES, getEngine, setEngine } from "../lib/imagegen.js";
import { readFiles, sourceParts, MAX_ITEMS } from "../lib/docs.js";
import { fixText } from "../lib/text.js";
import { store } from "../lib/storage.js";

const uid = () => Math.random().toString(36).slice(2, 10);
const IMG_INTENT = /^\s*(ارسم|ارسمي|ارسملي|ارسم لي|اعمل(لي| لي)?\s+(صورة|رسم|رسمة)|صمم(لي| لي)?\s+(صورة|رسم)|generate\s+(an?\s+)?image|draw\b|illustrate\b|make\s+(me\s+)?(an?\s+)?(image|picture|diagram))/i;

const SUGGEST = [
  { label: "اشرحلي أكتر", text: "اشرحلي السؤال ده بشكل أعمق وبالتفصيل، خطوة بخطوة.", send: true },
  { label: "ليه الباقي غلط؟", text: "ليه كل اختيار من الاختيارات التانية غلط؟ وإيه الكلمة اللي بتكشفه؟", send: true },
  { label: "أنا معترض ✋", text: "أنا معترض على الإجابة، لأن ", send: false },
  { label: "ارسملي صورة 🎨", text: "ارسملي رسم توضيحي بسيط للفكرة الأساسية في السؤال، بعناوين إنجليزي واضحة.", send: true, image: true },
  { label: "اديني مثال شبهه", text: "اديني حالة مشابهة بس بأرقام وسيناريو مختلف، وخليني أحلها.", send: true },
  { label: "لخّصها في سطرين", text: "لخّصلي القاعدة اللي لازم أحفظها من السؤال ده في سطرين.", send: true },
];

/* messages go to storage without bulky data: only the newest pictures (within ~3 MB) keep their pixels */
function forStorage(messages) {
  let budget = 3_000_000;
  const keep = new Set();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.img && m.img.data.length <= budget) { keep.add(m.id); budget -= m.img.data.length; }
  }
  return messages.slice(-60).map(({ id, role, text, atts, img, via }) => ({ id, role, text, via, atts: (atts || []).map(({ name, label, t }) => ({ name, label, t })), img: img && keep.has(id) ? img : undefined }));
}

/* an SVG drawing is saved as a PNG (opens everywhere, shares well from a phone) */
function svgToPngBlob(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => {
      const w = im.naturalWidth || 1200, h = im.naturalHeight || 800, k = 2;
      const c = document.createElement("canvas");
      c.width = w * k; c.height = h * k;
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(im, 0, 0, c.width, c.height);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("png"))), "image/png");
    };
    im.onerror = () => reject(new Error("img"));
    im.src = src;
  });
}

function GenImage({ img, via }) {
  const src = `data:${img.mime};base64,${img.data}`;
  const save = async () => {
    const svg = img.mime === "image/svg+xml";
    const ext = svg ? "png" : (img.mime.split("/")[1] || "png").replace("jpeg", "jpg");
    const name = `nclex-${Date.now()}.${ext}`;
    try {
      const blob = svg ? await svgToPngBlob(src) : await (await fetch(src)).blob();
      const file = new File([blob], name, { type: svg ? "image/png" : img.mime });
      if (navigator.canShare && navigator.canShare({ files: [file] }) && /Android|iPhone|iPad/i.test(navigator.userAgent)) { await navigator.share({ files: [file] }); return; }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) { /* user cancelled the share sheet */ }
  };
  return (
    <figure className="chat-gen">
      <img src={src} alt="صورة اتولّدت" />
      <div className="chat-gen-foot">
        <button type="button" className="btn btn-ghost btn-sm" onClick={save}><Icon name="download" size={16} /> حفظ الصورة</button>
        {via && <small>{via}</small>}
      </div>
    </figure>
  );
}

/* Chat drawer. Stays mounted (hidden) after the first open so an answer that is still streaming is never lost. */
export default function ChatPanel({ open, onClose, apiKey, onNeedKey, ctx, chipIds, storeKey }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  const [files, setFiles] = useState([]);        // pending attachments for the next message
  const [imgMode, setImgMode] = useState(false); // next message → draw a picture
  const [engine, setEng] = useState(getEngine);   // diagram | art | gemini
  const [wait, setWait] = useState("");
  const [note, setNote] = useState("");
  const [over, setOver] = useState(false);
  const abortRef = useRef(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const fileRef = useRef(null);
  const stick = useRef(true);

  /* load / save the conversation (per saved question) */
  useEffect(() => {
    if (!storeKey) return undefined;
    let alive = true;
    store.get(storeKey).then((r) => { if (alive && Array.isArray(r) && r.length) setMessages((cur) => (cur.length ? cur : r)); });
    return () => { alive = false; };
  }, [storeKey]);

  useEffect(() => {
    if (!storeKey || busy || !messages.length) return undefined;
    const t = setTimeout(() => store.set(storeKey, forStorage(messages)), 400);
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

  /* Android back button / browser back: closes the chat first instead of leaving the question */
  const pushed = useRef(false);
  useEffect(() => {
    if (!open) return undefined;
    window.history.pushState(window.history.state, "");
    pushed.current = true;
    const onPop = () => { pushed.current = false; onClose(); };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (pushed.current) { pushed.current = false; window.history.back(); }   // closed with X / Esc: drop the entry we added
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => inputRef.current?.focus(), 120);
    const esc = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => { clearTimeout(t); window.removeEventListener("keydown", esc); };
  }, [open, onClose]);

  const patch = (id, fn) => setMessages((cur) => cur.map((m) => (m.id === id ? fn(m) : m)));

  /* attachments */
  const addFiles = useCallback(async (list) => {
    const arr = [...(list || [])];
    if (!arr.length) return;
    const { items, errors } = await readFiles(arr, files);
    setFiles(items.slice(0, MAX_ITEMS));
    setNote(errors.length ? errors[0] : "");
  }, [files]);
  const onPick = (e) => { addFiles(e.target.files); e.target.value = ""; };
  const onPaste = (e) => {
    const fs = [...(e.clipboardData?.files || [])];
    if (fs.length) { e.preventDefault(); addFiles(fs); }
  };

  const send = useCallback(async (raw, opts = {}) => {
    const q = (raw ?? input).trim();
    if ((!q && !files.length) || busy) return;
    if (!apiKey) { onNeedKey(); return; }
    const base = opts.base || messages;
    const atts = opts.atts || files;
    const wantImage = opts.image ?? (imgMode || IMG_INTENT.test(q));
    const userMsg = { id: uid(), role: "user", text: q || "(ملفات مرفقة)", atts: atts.map(({ name, label, t }) => ({ name, label, t })) };
    const ai = { id: uid(), role: "ai", text: "", gen: wantImage };
    const history = [...base, userMsg];
    setMessages([...history, ai]);
    setInput(""); setFiles([]); setNote(""); setImgMode(false); setBusy(true); stick.current = true;
    if (inputRef.current) inputRef.current.style.height = "auto";
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      if (wantImage) {
        const out = await makePicture({
          engine, apiKey, ctx, request: q, atts, signal: ctrl.signal,
          onStatus: (s) => setWait(s === "wait" ? "خدمة الصور المجانية بتاخد دورها… ثواني" : ""),
        });
        const via = `${{ diagram: "رسم توضيحي بالمفتاح المجاني", art: "صورة AI فنية مجانية (Pollinations)", gemini: "Gemini" }[out.engine]}${out.notes.length ? " · " + out.notes[0] : ""}`;
        patch(ai.id, (m) => ({ ...m, img: { mime: out.mime, data: out.data }, text: fixText(out.text || ""), via }));
      } else {
        const out = await askChat({
          apiKey, history, ctx, chipIds, attach: atts, signal: ctrl.signal,
          onText: (t) => patch(ai.id, (m) => ({ ...m, text: fixText(t) })),
        });
        patch(ai.id, (m) => ({ ...m, text: fixText(out.text) }));
      }
    } catch (err) {
      if (err && err.name === "AbortError") patch(ai.id, (m) => ({ ...m, stopped: true }));
      else patch(ai.id, (m) => ({ ...m, err: (err && err.message) || "حصلت مشكلة. جرّب تاني." }));
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setWait(""); setBusy(false);
    }
  }, [input, files, busy, apiKey, messages, imgMode, engine, ctx, chipIds, onNeedKey]);

  const stop = () => abortRef.current?.abort();

  const retry = (aiId) => {
    const i = messages.findIndex((m) => m.id === aiId);
    const user = i > 0 ? messages[i - 1] : null;
    if (user && user.role === "user") send(user.text, { base: messages.slice(0, i - 1), atts: [], image: messages[i].gen });
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
    if (s.send) send(s.text, s.image ? { image: true } : {});
    else { setInput(s.text); setTimeout(() => inputRef.current?.focus(), 30); }
  };

  return (
    <aside className="chat" hidden={!open} aria-label="دردشة مع الـ AI" data-over={over}
      onDragOver={(e) => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); setOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }}
      onDrop={(e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files); } }}>
      <header className="chat-head">
        <span className="chat-ico"><Icon name="chat" size={20} /></span>
        <span className="chat-title"><b>اسأل الـ AI عن السؤال</b><small>اسأل، اعترض، ارفع ملفات، أو اطلب رسم</small></span>
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
            <p>اسأل أي سؤال عن الاختيارات أو القاعدة أو الكلمات، أو اعترض لو شايف الإجابة غلط. تقدر ترفع صور وملفات، وتطلب منه يرسملك صورة توضيحية.</p>
            <div className="chat-sugs">
              {SUGGEST.map((s) => <button key={s.label} type="button" className="chat-sug" onClick={() => suggest(s)}>{s.label}</button>)}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`chat-msg ${m.role === "user" ? "me" : "bot"}`}>
            {m.role === "user" ? (
              <>
                {m.atts && m.atts.length > 0 && (
                  <div className="chat-atts">{m.atts.map((a, i) => <span key={i} className="chat-att"><Icon name="paperclip" size={12} /> {a.name}</span>)}</div>
                )}
                <p dir="auto">{m.text}</p>
              </>
            ) : (
              <>
                {m.img && <GenImage img={m.img} via={m.via} />}
                {m.text
                  ? <RichText text={m.text} />
                  : !m.err && !m.stopped && !m.img && <span className="chat-typing">{m.gen ? (wait || "بيرسم الصورة") : "بيفكّر"}<i /><i /><i /></span>}
              </>
            )}
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

      {(files.length > 0 || note) && (
        <div className="chat-pending">
          {files.map((f) => (
            <span key={f.id} className="chat-att chat-att-x">
              <Icon name={f.t === "image" ? "image" : "paperclip"} size={13} /> <span dir="auto">{f.name}</span>
              <button type="button" aria-label={`شيل ${f.name}`} onClick={() => setFiles((cur) => cur.filter((x) => x.id !== f.id))}><Icon name="x" size={12} /></button>
            </span>
          ))}
          {note && <small className="chat-note">{note}</small>}
        </div>
      )}

      {imgMode && (
        <div className="chat-engines" role="radiogroup" aria-label="طريقة الرسم">
          {ENGINES.map((e) => (
            <button key={e.id} type="button" role="radio" aria-checked={engine === e.id} data-on={engine === e.id} title={e.hint}
              onClick={() => { setEng(e.id); setEngine(e.id); }}>
              {e.label}<small>{e.hint}</small>
            </button>
          ))}
        </div>
      )}

      <div className="chat-compose">
        <input ref={fileRef} type="file" multiple hidden onChange={onPick} />
        <button type="button" className="chat-tool" onClick={() => fileRef.current?.click()} aria-label="أرفق ملفات أو صور" title="أرفق ملفات أو صور"><Icon name="paperclip" size={19} /></button>
        <button type="button" className="chat-tool" data-on={imgMode} aria-pressed={imgMode} onClick={() => setImgMode((v) => !v)} aria-label="رسم صورة" title="الرسالة الجاية: ارسملي صورة"><Icon name="image" size={19} /></button>
        <textarea ref={inputRef} dir="auto" rows={1} value={input}
          placeholder={imgMode ? "وصف الرسم اللي عايزه… (Enter للرسم)" : "اكتب سؤالك أو اعتراضك… (Enter للإرسال)"}
          onChange={(e) => { setInput(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 150) + "px"; }}
          onKeyDown={onKey} onPaste={onPaste} />
        {busy
          ? <button type="button" className="chat-send stop" onClick={stop} aria-label="إيقاف"><Icon name="stop" size={18} /></button>
          : <button type="button" className="chat-send" onClick={() => send()} disabled={!input.trim() && !files.length} aria-label="إرسال"><Icon name={imgMode ? "image" : "send"} size={18} /></button>}
      </div>
    </aside>
  );
}
