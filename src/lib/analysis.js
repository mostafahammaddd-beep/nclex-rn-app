/* ───────────── Analysis orchestration ─────────────
   Three INDEPENDENT jobs start at the same instant (no job waits for another):
     ocr    → original_question_text            (fast model, no thinking)
     words  → new_words                         (fast model, no thinking)
     reason → explanation + tricks              (strong model, streamed section by section)
   Each job streams into the UI as it is written, and each can be retried or stopped on its own. */

import { MODES } from "./config.js";
import { buildOcrPrompt, buildWordsPrompt, buildReasonPrompt } from "./prompts.js";
import { cleanOcr, cleanWords, splitReason } from "./parse.js";
import { getModelLists, runTask } from "./gemini.js";

export const TASK_KEYS = {
  ocr: ["original_question_text"],
  words: ["new_words"],
  reason: ["explanation", "tricks"],
};

export function createAnalysis({ dataUrl, extra, chips, apiKey, modeId, onUpdate, onDone, onError }) {
  const mode = MODES[modeId] || MODES.balanced;
  const lists = getModelLists(apiKey);
  const img = { inlineData: { mimeType: "image/jpeg", data: dataUrl.split(",")[1] } };
  const live = {};

  const fastFirst = [...lists.fast, ...lists.pro];
  const defs = {
    ocr: {
      models: fastFirst,
      spec: { levels: ["minimal", "low"], budget: 0 },
      parts: [img, { text: buildOcrPrompt() }],
      maxOut: 4000, firstMs: 40000, idleMs: 30000, hedgeMs: 4500,
      apply: (full) => ({ original_question_text: cleanOcr(full) }),
    },
    words: {
      models: fastFirst,
      spec: { levels: ["minimal", "low"], budget: 0 },
      parts: [img, { text: buildWordsPrompt(chips) }],
      maxOut: 8000, firstMs: 40000, idleMs: 30000, hedgeMs: 5500,
      apply: (full, final) => ({ new_words: cleanWords(full, final) }),
    },
    reason: {
      models: mode.tier === "fast" ? fastFirst : [...lists.pro, ...lists.fast],
      spec: { levels: mode.levels, budget: mode.budget },
      parts: [img, { text: buildReasonPrompt(extra, chips, mode.words) }],
      maxOut: mode.maxOut, firstMs: 300000, idleMs: mode.idleMs, hedgeMs: mode.hedgeMs,
      apply: (full, final) => splitReason(full, final),
    },
  };

  function run(name) {
    const def = defs[name];
    live[name]?.abort();
    const ctrl = new AbortController();
    live[name] = ctrl;

    const t0 = performance.now();
    let lastFull = "";
    runTask({
      apiKey, models: def.models, task: name, parts: def.parts, spec: def.spec,
      maxOut: def.maxOut, hedgeMs: def.hedgeMs, firstMs: def.firstMs, idleMs: def.idleMs, signal: ctrl.signal,
      onText: (full, model) => {
        if (ctrl.signal.aborted) return;
        lastFull = full;
        onUpdate(name, def.apply(full, false), { chars: full.length, model, final: false });
      },
    }).then(({ text, model }) => {
      if (ctrl.signal.aborted) return;
      onUpdate(name, def.apply(text, true), { chars: text.length, model, final: true });
      onDone(name, { ms: performance.now() - t0, chars: text.length, model });
    }).catch((err) => {
      if (!err || err.name === "AbortError" || ctrl.signal.aborted) return;
      onError(name, err, lastFull ? def.apply(lastFull, true) : null);
    });
  }

  return {
    start() { Object.keys(defs).forEach(run); },
    retry(name) { if (defs[name]) run(name); },
    stop(name) { live[name]?.abort(); },
    cancel() { Object.values(live).forEach((c) => c.abort()); },
  };
}
