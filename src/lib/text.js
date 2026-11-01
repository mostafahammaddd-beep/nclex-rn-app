/* ───────────── Text hygiene (Arabic shaping fixes) ─────────────
   AI text sometimes carries characters that make Arabic render as garbage (letters collapsing on top of each
   other, a stray "ﬁ"-like glyph in the middle of a word):
     • Arabic presentation forms (U+FB50–FDFF, U+FE70–FEFE) and Latin ligature characters (ﬁ ﬂ …) — these are
       glyph codes, not letters, and they do not join with the normal letters around them → NFKC turns them back
       into real letters
     • Persian / Urdu look-alikes (ی ک ھ ہ) mixed into Arabic words — different shapes, wrong joining
     • invisible direction / joiner marks (ZWSP, ZWNJ, LRM, RLM, LRE…PDF, LRI…PDI, BOM, soft hyphen) that cut a word
       in two for the shaper
     • tatweel and harakat piled on one letter
   Applied to everything the AI writes AND to everything drawn on screen (so questions saved earlier are healed too). */

const INVISIBLE = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const PRESENTATION = /[\uFB00-\uFB06\uFB50-\uFDFF\uFE70-\uFEFE]/g;
const MARKS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;       // harakat, Quranic marks, tatweel
const LOOKALIKE = { "ی": "ي", "ې": "ي", "ۍ": "ي", "ێ": "ي", "ک": "ك", "ڪ": "ك", "ھ": "ه", "ہ": "ه", "ە": "ه", "ۃ": "ة" };
const LOOKALIKE_RE = /[یېۍێکڪھہەۃ]/g;
const DIGITS_RE = /[\u0660-\u0669\u06F0-\u06F9]/g;                           // Arabic-Indic / Persian digits → 0-9

export function fixText(s) {
  if (!s || typeof s !== "string") return s;
  // pure ASCII → nothing to fix (fast path for English text)
  if (!/[^\x00-\x7F]/.test(s)) return s;
  return s
    .replace(PRESENTATION, (c) => c.normalize("NFKC"))
    .replace(INVISIBLE, "")
    .replace(MARKS, "")
    .replace(LOOKALIKE_RE, (c) => LOOKALIKE[c] || c)
    .replace(DIGITS_RE, (d) => String(d.charCodeAt(0) & 15));
}
