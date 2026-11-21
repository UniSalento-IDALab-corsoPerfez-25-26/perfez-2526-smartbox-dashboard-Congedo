// Porting 1:1 di smartbox/logic.py e tools/evaluate.py: stessa logica sul dispositivo e nel browser.
// Se si modifica logic.py, aggiornare anche questo file (tests/test_logic.py descrive il comportamento atteso).

// I parametri stanno in config.yaml; config.js è generato da tools/genera_config_js.py (D-48).
import { DEFAULT_CONFIG } from "./config.js?v=7";
export { DEFAULT_CONFIG };

export class DrowsinessMonitor {
  constructor(cfg) {
    const ind = cfg.indicators, al = cfg.alarm;
    this.earThr = ind.ear_closed_threshold; this.marThr = ind.mar_yawn_threshold;
    // criterio "occhio chiuso": blendshape (palpebra chiusa vs occhi stretti) se disponibili, altrimenti EAR
    this.closureSrc = ind.eye_closure_source;
    this.blinkThr = ind.blink_closed_threshold; this.blinkMargin = ind.blink_squint_margin;
    this.pitchThr = ind.pitch_nod_threshold; this.win = ind.window_seconds;
    this.al = al; this.faceLostS = cfg.video.face_lost_seconds; this.gradual = !!al.gradual_descent;
    this.openingFrac = al.yawn_opening_fraction;
    this.closed = []; this.closedHead = 0; this.closedSum = 0; this.yawns = [];
    this.eyeClosedSince = null; this.mouthOpenSince = null; this.nodSince = null; this.wideSince = null; this.yawnGraceUntil = -1e9;
    this.lostSince = null; this.faceLost = false;
    this.level = 0; this.belowSince = null; this.lastAlertT = -1e9; this.perclos = 0;
  }

  _prune(now) {
    while (this.closedHead < this.closed.length && now - this.closed[this.closedHead][0] > this.win) {
      this.closedSum -= this.closed[this.closedHead][1]; this.closedHead++;
    }
    if (this.closedHead > 4096) { this.closed = this.closed.slice(this.closedHead); this.closedHead = 0; }
    while (this.yawns.length && now - this.yawns[0] > this.win) this.yawns.shift();
  }

  _eyesClosed(ind) {
    if (this.closureSrc === "blendshape" && typeof ind.blink === "number" && typeof ind.squint === "number")
      return ind.blink >= this.blinkThr && ind.blink - ind.squint >= this.blinkMargin;
    return ind.ear < this.earThr;
  }

  _event(now, level, reason, ear) {
    const ev = { t: now, level, reason, perclos: this.perclos, ear, prev_level: this.level };
    this.level = level;
    return ev;
  }

  update(ind, now) {
    if (!ind.face_found) return this._noFace(now);
    this.lostSince = null; this.faceLost = false; this.lastPitch = ind.pitch;

    // sbadigliando gli occhi si stringono: con la bocca che si apre la chiusura non conta (PERCLOS e microsonno);
    // dopo uno sbadiglio vero (bocca aperta >= yawn_min_seconds) la tolleranza dura yawn_eye_grace_seconds
    const mouthOpening = ind.mar > this.marThr * this.openingFrac;
    if (mouthOpening) this.wideSince ??= now;
    else {
      if (this.wideSince != null && now - this.wideSince >= this.al.yawn_min_seconds)
        this.yawnGraceUntil = now + this.al.yawn_eye_grace_seconds;
      this.wideSince = null;
    }
    const yawning = this.al.yawn_masks_eye_closure && (mouthOpening || now <= this.yawnGraceUntil);
    const closed = this._eyesClosed(ind) && !yawning;
    this.closed.push([now, closed ? 1 : 0]); this.closedSum += closed ? 1 : 0;
    this._prune(now);
    this.perclos = this.closedSum / Math.max(1, this.closed.length - this.closedHead);
    // all'avvio la finestra è quasi vuota: il PERCLOS dà allarme solo con almeno perclos_min_seconds di dati
    const perclos = now - this.closed[this.closedHead][0] >= this.al.perclos_min_seconds ? this.perclos : 0;

    if (closed) this.eyeClosedSince ??= now; else this.eyeClosedSince = null;
    const microsleep = this.eyeClosedSince !== null && now - this.eyeClosedSince >= this.al.microsleep_seconds;

    if (ind.mar > this.marThr) {
      this.mouthOpenSince ??= now;
      const last = this.yawns[this.yawns.length - 1];
      if (now - this.mouthOpenSince > this.al.yawn_min_seconds && (last === undefined || last < this.mouthOpenSince))
        this.yawns.push(now);
    } else this.mouthOpenSince = null;

    if (ind.pitch > this.pitchThr) this.nodSince ??= now; else this.nodSince = null;
    const nod = this.nodSince !== null && now - this.nodSince >= this.al.nod_seconds;

    let target = 0, reason = "";
    if (microsleep || perclos >= this.al.perclos_danger || nod) {
      target = 2; reason = microsleep ? "microsonno" : nod ? "chinamento" : "PERCLOS alto";
    } else if (perclos >= this.al.perclos_warning || this.yawns.length >= this.al.yawns_per_window_warning) {
      target = 1; reason = perclos >= this.al.perclos_warning ? "PERCLOS" : "sbadigli ripetuti";
    }

    if (target > this.level) {
      if (target === 2 || now - this.lastAlertT >= this.al.min_seconds_between_alerts) {
        this.lastAlertT = now; this.belowSince = null;
        return this._event(now, target, reason, ind.ear);
      }
    } else if (target < this.level) {
      this.belowSince ??= now;
      if (now - this.belowSince >= this.al.hysteresis_seconds) {
        const nw = this.gradual ? Math.max(target, this.level - 1) : target;
        this.belowSince = nw > target ? now : null;
        return this._event(now, nw, "rientro", ind.ear);
      }
    } else this.belowSince = null;
    return null;
  }

  // volto perso con il capo già chinato (almeno nod_lost_fraction della soglia): il chinamento continua (D-42)
  headGoingDown() {
    const f = this.al.nod_lost_fraction;
    return this.lastPitch != null && f > 0 && this.lastPitch >= this.pitchThr * f;
  }

  _noFace(now) {
    this.eyeClosedSince = this.mouthOpenSince = null;
    this.belowSince = null;
    this.lostSince ??= now;
    if (this.headGoingDown()) {
      this.nodSince ??= this.lostSince;
      if (now - this.nodSince >= this.al.nod_seconds && this.level < 2) {
        this.lastAlertT = now;
        return this._event(now, 2, "chinamento", 0);
      }
    } else this.nodSince = null;
    if (!this.faceLost && now - this.lostSince >= this.faceLostS) {
      this.faceLost = true;
      if (this.level < 1) return this._event(now, 1, "volto assente", 0);
    }
    return null;
  }
}

// ---- validazione (stessa regola di tools/evaluate.py) ----
export function evaluate(det, ann, tol = DEFAULT_CONFIG.evaluation.tolerance_seconds) {
  const used = new Set(), detail = [];
  for (const a of ann) {
    const i = det.findIndex((d, k) => a.inizio <= d.t && d.t <= a.fine + tol && !used.has(k));
    if (i >= 0) used.add(i);
    detail.push({ ...a, allarme_t: i >= 0 ? det[i].t : null, motivo: i >= 0 ? det[i].reason : null,
                  latenza: i >= 0 ? +(det[i].t - a.inizio).toFixed(2) : null });
  }
  const vp = used.size, fp = det.length - vp, fn = ann.length - vp;
  const lat = detail.filter(d => d.latenza !== null).map(d => d.latenza);
  return {
    episodi: ann.length, allarmi: det.length, vp, fp, fn,
    precisione: vp / Math.max(1, vp + fp), richiamo: vp / Math.max(1, vp + fn),
    latenza_media: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null,
    dettaglio: detail, falsi_positivi: det.filter((_, k) => !used.has(k)),
  };
}

// riapplica la logica a indicatori già estratti (righe {t, face, ear, mar, pitch})
export function replay(rows, cfg) {
  const m = new DrowsinessMonitor(cfg), events = [];
  for (const r of rows) {
    const ev = m.update(r, r.t);
    if (ev) events.push(ev);
  }
  return events;
}

export const alarmsOnly = evs => evs.filter(e => e.level > 0 && e.level > (e.prev_level ?? 0));

export function parseCSV(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter(l => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split(",").map(h => h.trim());
  return lines.slice(1).map(l => {
    const cells = l.split(","); const o = {};
    head.forEach((h, i) => (o[h] = (cells[i] ?? "").trim()));
    return o;
  });
}

export function toCSV(rows, cols) {
  return [cols.join(","), ...rows.map(r => cols.map(c => r[c] ?? "").join(","))].join("\n");
}

export function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

export function configToYaml(cfg) {
  const sec = (name, o) => `${name}:\n` + Object.entries(o).map(([k, v]) => `  ${k}: ${v}`).join("\n");
  return ["# generato dalla demo browser smartbox – unire a config.yaml",
          sec("indicators", cfg.indicators), sec("alarm", cfg.alarm)].join("\n") + "\n";
}
