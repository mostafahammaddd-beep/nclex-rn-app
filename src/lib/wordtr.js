/* One English word → its Arabic meaning (for the double-click popup). Fast model, tiny answer, cached forever. */

import { getModelLists, runTask } from "./gemini.js";
import { fixText, ARABIC_RULE } from "./text.js";

const LS = "nclex:wtr:v1";
const mem = new Map();

function readCache() {
  try { return JSON.parse(window.localStorage.getItem(LS)) || {}; } catch (e) { return {}; }
}
function writeCache(k, v) {
  try {
    const all = readCache();
    all[k] = v;
    const keys = Object.keys(all);
    if (keys.length > 600) for (const old of keys.slice(0, keys.length - 600)) delete all[old];
    window.localStorage.setItem(LS, JSON.stringify(all));
  } catch (e) { /* ignore */ }
}

export const cachedMeaning = (word) => mem.get(word.toLowerCase()) || readCache()[word.toLowerCase()] || "";

export async function translateWord({ apiKey, word, context, signal }) {
  const key = word.toLowerCase();
  const hit = cachedMeaning(word);
  if (hit) return hit;
  const lists = getModelLists(apiKey);
  const out = await runTask({
    apiKey, task: "word", models: [...lists.fast, ...lists.pro], signal,
    system: `You translate ONE English word for an Arabic-speaking nursing student (English level A2) who is preparing for the NCLEX-RN.
Reply with ONLY the Arabic meaning that fits the sentence the word appears in: at most 5 words, plain Arabic, no English, no quotes, no punctuation at the end. If it is a medical term, add after " — " a very short everyday explanation (at most 6 Arabic words).${ARABIC_RULE}`,
    parts: [{ text: `Word: ${word}\nSentence: ${String(context || "").slice(0, 300)}` }],
    spec: { levels: ["minimal", "low"], budget: 0 }, maxOut: 200, hedgeMs: 2500, firstMs: 20000, idleMs: 15000,
  });
  const text = fixText(String(out.text || "").replace(/["“”«»\n]+/g, " ").replace(/\s+/g, " ").trim());
  if (text) { mem.set(key, text); writeCache(key, text); }
  return text;
}
