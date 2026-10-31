import React from "react";
import Icon from "./Icon.jsx";
import { fmtRemaining } from "../lib/progress.js";

/* One heartbeat every 150 px; the path is two identical halves so the sweep loops without a seam. */
const BEAT = [[0, 38], [40, 38], [48, 38], [56, 12], [68, 58], [78, 38], [112, 38], [120, 38], [127, 27], [137, 45], [144, 38], [150, 38]];
const TRACE = "M" + [0, 1, 2, 3].flatMap((k) => BEAT.map(([x, y]) => `${x + k * 150} ${y}`)).join(" L");

export function Monitor({ snap, steps, onStop }) {
  const eta = snap.almost ? "لحظات وهنخلّص…" : `فاضل ${fmtRemaining(snap.remainingSec)}`;
  return (
    <section className="monitor" aria-live="polite" aria-label="تقدّم التحليل">
      <div className="mon-top">
        <div className="mon-read">
          <b className="mon-pct">{snap.percent}<small>%</small></b>
          <span className="mon-lead">جاري التحليل</span>
        </div>
        <div className="mon-trace" aria-hidden="true">
          <svg viewBox="0 0 600 64"><path d={TRACE} /></svg>
        </div>
      </div>
      <div className="mon-eta">
        <b>{eta}</b>
        <span>مرّ {Math.round(snap.elapsedSec)} ث</span>
      </div>
      <div className="mon-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={snap.percent}>
        <i style={{ width: `${snap.percent}%` }} />
      </div>
      <ul className="mon-steps">
        {steps.map((s) => (
          <li key={s.id} data-s={s.s}><i />{s.label}</li>
        ))}
      </ul>
      <div className="mon-foot">
        <span>النتايج بتظهر تحت أول بأول</span>
        <button type="button" onClick={onStop}><Icon name="stop" size={13} /> إيقاف</button>
      </div>
    </section>
  );
}

/* compact version that lives in the bottom dock while the analysis runs */
export function DockProgress({ snap, onStop }) {
  return (
    <div className="dock-prog" aria-live="polite">
      <b className="pct">{snap.percent}%</b>
      <div className="mid">
        <div className="row">
          <b>{snap.almost ? "لحظات…" : `فاضل ${fmtRemaining(snap.remainingSec)}`}</b>
          <span>جاري التحليل</span>
        </div>
        <div className="mon-bar"><i style={{ width: `${snap.percent}%` }} /></div>
      </div>
      <button type="button" className="stop" onClick={onStop} aria-label="إيقاف التحليل"><Icon name="stop" size={14} /></button>
    </div>
  );
}
