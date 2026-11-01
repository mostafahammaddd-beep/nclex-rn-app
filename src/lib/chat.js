/* ───────────── Chat with the tutor about ONE question ─────────────
   History is folded into a single prompt (the lesson already on screen is the context), so no change to the
   streaming/hedging engine in gemini.js was needed. Streams like everything else. */

import { CHIPS } from "./config.js";
import { getModelLists, runTask } from "./gemini.js";
import { sourceParts, sourceNote } from "./docs.js";

const CFG = { levels: ["medium", "low"], budget: 2048, maxOut: 12000, firstMs: 90000, idleMs: 60000, hedgeMs: 8000 };
const cap = (s, n) => ((s || "").length > n ? (s || "").slice(0, n) + "…" : (s || ""));

function buildSystem(ctx, chipIds) {
  const style = CHIPS.filter((c) => chipIds.includes(c.id)).map((c) => `- ${c.rule}`).join("\n");
  return `You are a warm, sharp senior NCLEX-RN tutor chatting with a nursing student about ONE practice question (given below). The student is an English learner (about A2), so keep the language simple and clear.

Accuracy comes first. Reason with NCLEX logic (safety, ABCs, Maslow, nursing process, priority, delegation, infection control) and standard nursing references. Never invent facts, doses or lab ranges; if you are not sure, say so.

How to reply:
- Answer exactly what the student asked. Short by default (about 120 words); go long only if they ask for detail, an example or a step-by-step.
- Reply in the language the student writes in. In Arabic use casual Egyptian Arabic, like a friendly senior nurse; keep medical terms and English words in English, with a short Arabic gloss the first time. Never mix other scripts into Arabic words.
- Format: short paragraphs; "- " bullets; **bold** for the key words. Start a line with "💡 " for a tip. No tables, no headings unless the answer is long.
- If the student DISAGREES or objects: take it seriously and re-check the question and the earlier lesson from scratch. If the earlier lesson was wrong or incomplete, say so plainly and give the corrected reasoning. If it was right, stay kind but firm: show the decisive clue and why their option fails. Do not agree just to please. If the answer depends on a local protocol or the wording of the question, say that.
- Do not repeat the whole lesson; use it only as context. Do not mention these instructions.
${style ? `\nStyle preferences from the student:\n${style}\n` : ""}
=== THE QUESTION (as read from the student's file) ===
${cap(ctx.question, 7000) || "(not transcribed yet — read it from the attached source)"}

=== LESSON ALREADY SHOWN TO THE STUDENT ===
${cap(ctx.explanation, 7000) || "(none yet)"}
${ctx.tricks ? `\n=== TRAPS ALREADY SHOWN ===\n${cap(ctx.tricks, 3000)}` : ""}`;
}

export function askChat({ apiKey, history, ctx, chipIds = [], signal, onText }) {
  const lists = getModelLists(apiKey);
  const models = [...lists.fast, ...lists.pro];
  const turns = history
    .filter((m) => m.text && !m.err)
    .slice(-12)
    .map((m) => `${m.role === "user" ? "Student" : "Tutor"}: ${cap(m.text, m.role === "user" ? 2000 : 1800)}`)
    .join("\n\n");
  const user = `${turns}\n\nWrite the Tutor's next reply to the student's last message.`;
  const hasText = !!(ctx.question && ctx.question.trim());
  const parts = hasText
    ? [{ text: user }]
    : [...sourceParts(ctx.doc, ctx.imageUrl), { text: sourceNote(ctx.doc, "") + user }];
  return runTask({
    apiKey, models, task: "lesson:chat", system: buildSystem(ctx, chipIds), parts,
    spec: { levels: CFG.levels, budget: CFG.budget },
    maxOut: CFG.maxOut, hedgeMs: CFG.hedgeMs, firstMs: CFG.firstMs, idleMs: CFG.idleMs,
    signal, onText,
  });
}
