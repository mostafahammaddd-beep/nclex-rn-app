import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/cairo/400.css";
import "@fontsource/cairo/600.css";
import "@fontsource/cairo/700.css";
import "@fontsource/cairo/900.css";
import "./styles.css";
import App from "./App.jsx";
import { loadBoot } from "./lib/storage.js";

/* ───────── start-up ─────────
   The app is NOT painted until (a) the Cairo faces are really loaded and (b) the saved data is read.
   Both happen in parallel while the splash from index.html is on screen, so the user never sees
   the thin fallback font swapping to Cairo, and never sees a spinner or a layout jump. */

const FACES = ["400", "600", "700", "900"];
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

async function fontsReady() {
  try {
    if (!document.fonts || !document.fonts.load) return;
    const jobs = [];
    FACES.forEach((w) => {
      jobs.push(document.fonts.load(`${w} 16px Cairo`, "ابتثجحخدذرزسشصضطظعغفقكلمنهوي"));
      jobs.push(document.fonts.load(`${w} 16px Cairo`, "AaBbCcDdEe0123456789"));
    });
    await withTimeout(Promise.all(jobs), 2000); // never hold the app hostage to a font
  } catch (e) { /* fall back to system font */ }
}

const EMPTY_BOOT = { questions: [], words: [], apiKey: "", mode: null, goal: 5, perf: {} };

async function start() {
  const [boot] = await Promise.all([
    withTimeout(loadBoot(), 2500).then((b) => b || EMPTY_BOOT).catch(() => EMPTY_BOOT),
    fontsReady(),
  ]);
  createRoot(document.getElementById("root")).render(<App boot={boot} />);
}

start();
