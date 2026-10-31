/* ───────────── Static config ───────────── */

export const CHIPS = [
  { id: "egy", label: "شرح بالبلدي 🇪🇬", excludes: "en",
    rule: "Write the teaching text in casual Egyptian Arabic (عامية مصرية), like a friendly senior nurse coaching a junior. Keep every medical term and every English exam phrase in English." },
  { id: "en", label: "إنجليزي بحت 🇬🇧", excludes: "egy",
    rule: "Write EVERYTHING in clear, simple English (A2–B1 words, short sentences). Do not use any Arabic at all, not even in the headings or the new-words meanings." },
  { id: "emoji", label: "إضافة إيموجي ✨",
    rule: "Use relevant emojis generously (✅ for correct, ❌ for wrong, 🚨 for traps, 💡 for tips) to make the text lively and memorable." },
  { id: "simple", label: "شرح مبسط ⚡",
    rule: "Explain with extra-simple language, very short sentences and everyday analogies, as if to someone who is overwhelmed and has never seen the topic." },
];

/* cls = css class that sets the section accent (--acc / --acc-rgb / --acc-ink) in light + dark.
   wait = what the placeholder says while this section is still being written. */
export const SECTIONS = [
  { key: "original_question_text", title: "نص السؤال", sub: "اللي اتقرا من الصورة", icon: "fileText", rows: 6, cls: "sec-sky", ltr: true, step: "read",
    wait: "بنقرا السؤال من الصورة…" },
  { key: "new_words", title: "كلمات جديدة", sub: "كل كلمة ممكن تكون صعبة على مستوى A2", icon: "library", rows: 8, cls: "sec-violet", step: "words",
    wait: "بنلمّ كل كلمة ممكن تكون غريبة عليك…" },
  { key: "explanation", title: "تفصيص السؤال", sub: "شرح من الصفر + الإنجليزي", icon: "brain", rows: 12, cls: "sec-teal", step: "explain",
    wait: "بيفكّر في السؤال علشان يشرحه من الصفر…" },
  { key: "tricks", title: "التريكات", sub: "الفخ المخفي في السؤال", icon: "lightbulb", rows: 5, cls: "sec-coral", step: "tricks",
    wait: "بيدوّر على الفخاخ اللي ممكن تقع فيها…" },
];

export const EMPTY_RESULT = { original_question_text: "", new_words: "", explanation: "", tricks: "" };

/* Reasoning presets. `tier` decides which model family is tried first for the long explanation.
   OCR + new-words always use the FAST tier with (almost) no thinking, in parallel with the reasoning.
   maxOut counts the model's hidden "thinking" tokens too, so it must stay far above the visible text. */
export const MODES = {
  turbo: {
    id: "turbo", label: "فائق السرعة", sub: "الأسرع", icon: "zap",
    tier: "fast", levels: ["low", "minimal"], budget: 1024, words: 620, hedgeMs: 12000, maxOut: 16000, idleMs: 60000,
  },
  balanced: {
    id: "balanced", label: "متوازن", sub: "موصى به", icon: "scale",
    tier: "pro", levels: ["low"], budget: 1024, words: 880, hedgeMs: 25000, maxOut: 24000, idleMs: 90000,
  },
  deep: {
    id: "deep", label: "دقة قصوى", sub: "أعمق تفكير", icon: "target",
    tier: "pro", levels: ["high"], budget: 16384, words: 1150, hedgeMs: 70000, maxOut: 48000, idleMs: 180000,
  },
};

export const CHEERS = [
  "كل سؤال بتحله بيقرّبك من الـ RN 💙",
  "فهم سؤال واحد صح أحسن من حفظ عشرة 🌟",
  "خطوة صغيرة النهاردة، رخصة بكرة 🩺",
  "أنت أقرب مما تتخيل. كمّل! 🚀",
  "الإنجليزي بيتبني كلمة كلمة، وإنت ماشي صح ✨",
];

export const GOALS = [3, 5, 8, 10, 15, 20];
