/* ───────────── Question sources: image · PDF · text file ─────────────
   An image is compressed to a JPEG exactly as before. A PDF is sent to Gemini as-is (it reads PDFs natively);
   a text file is sent as text. For PDF / text we also draw a small "document tile" that plays the role of the
   screenshot everywhere else in the app (preview, saved-question thumbnail), so nothing else had to change. */

import { fileToCompressedDataUrl } from "./image.js";

export const MAX_PDF = 10 * 1024 * 1024;   // sent up to 5× in parallel → keep the request small
export const MAX_TEXT = 60000;             // characters

const ext = (n) => ((n || "").split(".").pop() || "").toLowerCase();
export const isPdf = (f) => f.type === "application/pdf" || ext(f.name) === "pdf";
export const isTextFile = (f) => (f.type || "").startsWith("text/") || ["txt", "md", "csv", "text"].includes(ext(f.name));
export const isImage = (f) => (f.type || "").startsWith("image/");
export const isSupported = (f) => !!f && (isImage(f) || isPdf(f) || isTextFile(f));

const mb = (n) => Math.round((n / 1048576) * 10) / 10;

function readAs(file, how) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("تعذّر قراءة الملف."));
    r[how](file);
  });
}

function docThumb(label, name) {
  const W = 720, H = 480;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#1CA3BE"); bg.addColorStop(1, "#0E7C8F");
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  // page
  g.fillStyle = "#ffffff";
  g.beginPath();
  if (g.roundRect) g.roundRect(W / 2 - 150, 50, 300, 380, 22); else g.rect(W / 2 - 150, 50, 300, 380);
  g.fill();
  g.fillStyle = "#D8EEF2";
  [0, 1, 2, 3, 4].forEach((i) => g.fillRect(W / 2 - 110, 200 + i * 30, i === 4 ? 120 : 220, 12));
  g.textAlign = "center";
  g.fillStyle = "#0E7C8F";
  g.font = "900 78px Cairo, 'Segoe UI', Tahoma, sans-serif";
  g.fillText(label, W / 2, 150);
  g.fillStyle = "#0B2A30";
  g.font = "700 24px Cairo, 'Segoe UI', Tahoma, sans-serif";
  let t = name || "";
  while (t.length > 3 && g.measureText(t).width > 270) t = t.slice(0, -2);
  if (t !== name) t = t.replace(/\s+$/, "") + "…";
  g.fillText(t, W / 2, 396);
  return c.toDataURL("image/jpeg", 0.8);
}

/* → { imageUrl, doc }   (doc is null for a plain image) */
export async function readSource(file) {
  if (!file) throw new Error("مفيش ملف.");
  if (isImage(file)) return { imageUrl: await fileToCompressedDataUrl(file), doc: null };

  if (isPdf(file)) {
    if (file.size > MAX_PDF) {
      throw new Error(`ملف الـ PDF كبير (${mb(file.size)} ميجا) والحد ${mb(MAX_PDF)} ميجا. اقطع الصفحات اللي فيها السؤال أو صوّرها.`);
    }
    const url = await readAs(file, "readAsDataURL");
    const data = String(url).split(",")[1] || "";
    if (!data) throw new Error("ملف الـ PDF فاضي أو تالف.");
    return { imageUrl: docThumb("PDF", file.name), doc: { kind: "pdf", name: file.name, size: file.size, data } };
  }

  if (isTextFile(file)) {
    const raw = String(await readAs(file, "readAsText")).replace(/\r\n/g, "\n").trim();
    if (!raw) throw new Error("الملف النصي فاضي.");
    return { imageUrl: docThumb("TXT", file.name), doc: { kind: "text", name: file.name, size: file.size, text: raw.slice(0, MAX_TEXT) } };
  }

  throw new Error("نوع الملف ده مش مدعوم. ارفع صورة أو ملف PDF أو ملف نصي (.txt).");
}

/* the "image" part(s) of every Gemini request */
export function sourceParts(doc, dataUrl) {
  if (!doc) return [{ inlineData: { mimeType: "image/jpeg", data: (dataUrl || "").split(",")[1] } }];
  if (doc.kind === "pdf") return [{ inlineData: { mimeType: "application/pdf", data: doc.data } }];
  return [{ text: `<document name="${String(doc.name || "").replace(/"/g, "'")}">\n${doc.text}\n</document>` }];
}

/* prepended to every prompt: the prompts talk about "the image", this tells the model what it really got */
export function sourceNote(doc, extra) {
  if (!doc) return "";
  const what = doc.kind === "pdf" ? "a PDF document" : "a plain-text document";
  const t = String(extra || "").trim().slice(0, 300);
  const pick = t
    ? `The student's note (it may name the question number or page to use) is: «${t}». Follow it if it points to a question; otherwise use the first complete question.`
    : "Use the first complete question in the document.";
  return `SOURCE NOTE: the question comes from ${what} instead of a screenshot. Wherever the instructions say "image", "screenshot" or "photo", read it as this document. The document may contain several questions, cover pages, rationales or answer keys. Work on exactly ONE question and never mix questions. ${pick}\n\n`;
}
