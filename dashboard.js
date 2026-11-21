import { evaluate, parseCSV, replay, alarmsOnly, DEFAULT_CONFIG, deepCopy } from "./logic.js?v=7";

const $ = s => document.querySelector(s);
const LEVEL = ["Normale", "Attenzione", "Pericolo"];
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const fmtTime = ts => ts ? new Date(ts).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "medium" }) : "–";
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ago = s => s == null ? "mai" : s < 90 ? `${s} s fa` : s < 5400 ? `${Math.round(s / 60)} min fa` : s < 172800 ? `${Math.round(s / 3600)} h fa` : `${Math.round(s / 86400)} giorni fa`;
const badge = (lv, online = true) => online ? `<span class="badge b${lv ?? 0}">${LEVEL[lv ?? 0]}</span>` : `<span class="badge boff">Offline</span>`;

// ------------------------------------------------------------------ API (con fallback dimostrativo)
let token = (() => { try { return localStorage.getItem("smartbox_token") || ""; } catch { return ""; } })();
let mock = null;

async function api(path) {
  if (mock) return mock.handle(path);
  try {
    const r = await fetch(`/api/v1${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (r.status === 401) {
      const t = prompt("Token della dashboard (SMARTBOX_DASHBOARD_TOKEN):");
      if (t) { token = t; try { localStorage.setItem("smartbox_token", t); } catch {} return api(path); }
      throw new Error("non autorizzato");
    }
    if (!r.ok) throw new Error(r.status);
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("json")) throw new Error("risposta non JSON");
    return r.json();
  } catch (e) {
    if (!mock) {
      mock = new MockBackend();
      showBanner("Backend non raggiungibile: la dashboard mostra <b>dati dimostrativi</b> generati nel browser. Avvia <span class='mono'>uvicorn app:app</span> nella cartella backend per i dati reali.");
      return mock.handle(path);
    }
    throw e;
  }
}

function showBanner(html, info = false) {
  const b = $("#banner"); b.innerHTML = html; b.classList.toggle("info", info); b.classList.remove("hidden");
}

// ------------------------------------------------------------------ tab
let current = "flotta";
document.querySelectorAll("#tabs button").forEach(b => b.onclick = () => {
  document.querySelectorAll("#tabs button").forEach(x => x.classList.toggle("active", x === b));
  current = b.dataset.tab;
  document.querySelectorAll("[data-panel]").forEach(p => p.classList.toggle("hidden", p.dataset.panel !== current));
  refresh();
});

// ------------------------------------------------------------------ flotta
let vehicles = [];
async function loadFleet() {
  vehicles = await api("/vehicles");
  const recent = await api("/events?only_alarms=true&limit=15");
  const online = vehicles.filter(v => v.online);
  const kpi = [
    ["Veicoli online", `${online.length}<span class="muted" style="font-size:16px"> / ${vehicles.length}</span>`],
    ["In pericolo ora", online.filter(v => v.level === 2).length],
    ["In attenzione ora", online.filter(v => v.level === 1).length],
    ["Allarmi pericolo 24 h", vehicles.reduce((a, v) => a + (v.danger_24h || 0), 0)],
  ];
  $("#kpis").innerHTML = kpi.map(([l, v]) => `<div class="card kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");

  $("#vehicles").innerHTML = vehicles.map(v => {
    const warn = [];
    if (v.online && v.alert && !["ok", "non verificabile"].includes(v.alert)) warn.push(`avviso locale: ${v.alert}`);
    if (v.online && v.cpu_temp >= 80) warn.push(`CPU ${v.cpu_temp} °C`);
    if (v.online && v.face_ratio != null && v.face_ratio < 0.7) warn.push("volto poco visibile");
    if (v.outbox_pending > 0) warn.push(`${v.outbox_pending} eventi in coda`);
    return `<div class="card vehicle ${v.online ? "l" + (v.level ?? 0) + " live" : ""}">
      <div class="row"><h3>${esc(v.vehicle)}</h3>${badge(v.level, v.online)}</div>
      <dl>
        <dt>Modalità</dt><dd>${esc(v.mode ?? "–")}</dd>
        <dt>PERCLOS</dt><dd>${v.perclos != null ? (v.perclos * 100).toFixed(0) + "%" : "–"}</dd>
        <dt>Elaborazione</dt><dd>${v.fps != null ? v.fps + " fps" : "–"}</dd>
        <dt>Temperatura CPU</dt><dd>${v.cpu_temp != null ? v.cpu_temp + " °C" : "–"}</dd>
        <dt>Allarmi 24 h</dt><dd>${v.events_24h ?? 0}</dd>
        <dt>Ultimo contatto</dt><dd>${ago(v.seconds_since_status)}</dd>
      </dl>
      ${warn.length ? `<p class="small pill-bad" style="margin:10px 0 0">⚠ ${warn.map(esc).join(" · ")}</p>` : ""}
    </div>`;
  }).join("") || `<p class="muted">Nessun veicolo registrato. Aggiungili in <span class="mono">devices.yaml del backend</span>.</p>`;

  $("#recent").innerHTML = eventsTable(recent, false);
  fillVehicleSelects();
}

function eventsTable(rows, full = true) {
  if (!rows.length) return `<tr><td class="muted">Nessun evento</td></tr>`;
  return `<thead><tr><th>Ora</th><th>Veicolo</th><th>Livello</th><th>Motivo</th><th class="num">PERCLOS</th><th class="num">EAR</th>${full ? "<th>Via</th>" : ""}</tr></thead><tbody>` +
    rows.map(r => `<tr><td>${fmtTime(r.ts)}</td><td>${esc(r.vehicle)}</td><td>${r.prev_level != null && r.level < r.prev_level ? `<span class="badge boff">${LEVEL[r.prev_level]} → ${LEVEL[r.level]}</span>` : badge(r.level)}</td>
      <td>${esc(r.reason)}</td><td class="num">${r.perclos != null ? (r.perclos * 100).toFixed(0) + "%" : "–"}</td>
      <td class="num">${r.ear != null ? Number(r.ear).toFixed(3) : "–"}</td>${full ? `<td>${esc(r.via ?? "")}</td>` : ""}</tr>`).join("") + "</tbody>";
}

function fillVehicleSelects() {
  for (const id of ["#f-vehicle", "#s-vehicle"]) {
    const sel = $(id), keep = sel.value;
    sel.innerHTML = `<option value="">Tutti i veicoli</option>` + vehicles.map(v => `<option>${esc(v.vehicle)}</option>`).join("");
    sel.value = keep;
  }
}

// ------------------------------------------------------------------ eventi
async function loadEvents() {
  const q = new URLSearchParams({ min_level: $("#f-level").value, only_alarms: $("#f-alarms").checked, limit: 500 });
  if ($("#f-vehicle").value) q.set("vehicle", $("#f-vehicle").value);
  $("#events").innerHTML = eventsTable(await api(`/events?${q}`));
}
$("#f-apply").onclick = loadEvents;
$("#f-export").onclick = async () => {
  if (mock) return alert("Esportazione disponibile solo con il backend attivo.");
  const v = $("#f-vehicle").value;
  const r = await fetch(`/api/v1/export.csv${v ? "?vehicle=" + encodeURIComponent(v) : ""}`,
                        { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  download("eventi_smartbox.csv", await r.text());
};

// ------------------------------------------------------------------ statistiche
const charts = {};
function chart(id, cfg) {
  charts[id]?.destroy();
  Chart.defaults.color = css("--muted"); Chart.defaults.borderColor = css("--border");
  charts[id] = new Chart(document.getElementById(id), { ...cfg, options: { maintainAspectRatio: false, responsive: true, ...cfg.options } });
}

async function loadStats() {
  const q = new URLSearchParams({ days: $("#s-days").value });
  if ($("#s-vehicle").value) q.set("vehicle", $("#s-vehicle").value);
  const s = await api(`/stats?${q}`);
  const t = s.totals;
  $("#s-kpis").innerHTML = [["Allarmi totali", t.alarms ?? 0], ["Pericolo", t.danger ?? 0], ["Attenzione", t.warning ?? 0], ["Veicoli coinvolti", t.vehicles ?? 0]]
    .map(([l, v]) => `<div class="card kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");
  chart("c-day", { type: "bar", data: { labels: s.by_day.map(d => d.day.slice(5)), datasets: [
      { label: "Attenzione", data: s.by_day.map(d => d.l1), backgroundColor: css("--warn") },
      { label: "Pericolo", data: s.by_day.map(d => d.l2), backgroundColor: css("--danger") }] },
    options: { scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } } } });
  chart("c-reason", { type: "bar", data: { labels: s.by_reason.map(r => r.reason), datasets: [
      { label: "Allarmi", data: s.by_reason.map(r => r.n), backgroundColor: css("--accent") }] },
    options: { indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } } });
  const hours = Array.from({ length: 24 }, (_, h) => s.by_hour.find(x => x.hour === h)?.n ?? 0);
  chart("c-hour", { type: "bar", data: { labels: hours.map((_, h) => h), datasets: [
      { label: "Allarmi", data: hours, backgroundColor: css("--accent") }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } } });
}
$("#s-days").onchange = $("#s-vehicle").onchange = loadStats;

// ------------------------------------------------------------------ validazione (tutto lato client)
const files = {};
for (const [id, key] of [["#v-det", "det"], ["#v-ann", "ann"], ["#v-ind", "ind"]]) {
  $(id).onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    files[key] = { name: f.name, rows: parseCSV(await f.text()) };
    $("#v-files").textContent = Object.values(files).map(x => `${x.name} (${x.rows.length} righe)`).join(" · ");
  };
}
$("#v-example").onclick = () => {
  // protocollo 3b della demo: socchiusi (10–15 s) e sbadiglio isolato (36–43 s) sono controlli, non episodi da rilevare
  files.ann = { name: "protocollo standard 60 s (3b)", rows: [
    { inizio_s: "22", fine_s: "26", tipo: "occhi_chiusi" }, { inizio_s: "50", fine_s: "54", tipo: "chinamento" }] };
  $("#v-files").textContent = Object.values(files).map(x => `${x.name} (${x.rows.length} righe)`).join(" · ");
};
$("#v-run").onclick = () => {
  if (!files.ann) return alert("Servono le annotazioni (o 'Usa protocollo standard').");
  if (!files.det && !files.ind) return alert("Serve eventi.csv oppure indicatori.csv.");
  const tol = +$("#v-tol").value;
  const ann = files.ann.rows.map(r => ({ inizio: +r.inizio_s, fine: +r.fine_s, tipo: r.tipo }));
  const indRows = files.ind?.rows.map(r => ({ t: +r.t, face_found: ["1", "true", "True"].includes(r.face), ear: +r.ear, mar: +r.mar, pitch: +r.pitch }));
  const det = files.det
    ? files.det.rows.filter(r => r.t_video_s !== "" && +r.level > 0 && +r.level > +(r.prev_level || 0)).map(r => ({ t: +r.t_video_s, reason: r.reason }))
    : alarmsOnly(replay(indRows, DEFAULT_CONFIG));
  const res = evaluate(det, ann, tol);
  $("#v-kpis").innerHTML = [["Precisione", res.precisione.toFixed(2)], ["Richiamo", res.richiamo.toFixed(2)],
    ["Latenza media", res.latenza_media != null ? res.latenza_media.toFixed(1) + " s" : "n.d."], ["VP / FP / FN", `${res.vp} / ${res.fp} / ${res.fn}`]]
    .map(([l, v]) => `<div class="card kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");
  $("#v-detail").innerHTML = `<thead><tr><th>Episodio</th><th>Intervallo</th><th>Esito</th><th class="num">Latenza</th></tr></thead><tbody>` +
    res.dettaglio.map(d => `<tr><td>${esc(d.tipo)}</td><td>${d.inizio}–${d.fine} s</td>
      <td>${d.allarme_t != null ? `<span class="pill-ok">✓ ${d.allarme_t.toFixed(1)} s (${esc(d.motivo)})</span>` : `<span class="pill-bad">✗ mancato</span>`}</td>
      <td class="num">${d.latenza != null ? d.latenza.toFixed(1) + " s" : "–"}</td></tr>`).join("") +
    res.falsi_positivi.map(f => `<tr><td colspan="2" class="muted">falso positivo</td><td class="pill-bad">${f.t.toFixed(1)} s (${esc(f.reason)})</td><td></td></tr>`).join("") + "</tbody>";

  if (indRows) {
    const thr = Array.from({ length: 13 }, (_, i) => +(0.14 + 0.01 * i).toFixed(2));
    const sweep = thr.map(t => { const c = deepCopy(DEFAULT_CONFIG); c.indicators.ear_closed_threshold = t;
      return { t, ...evaluate(alarmsOnly(replay(indRows, c)), ann, tol) }; });
    chart("v-sweep", { type: "line", data: { labels: thr, datasets: [
      { label: "Precisione", data: sweep.map(s => s.precisione), borderColor: css("--accent"), backgroundColor: css("--accent") },
      { label: "Richiamo", data: sweep.map(s => s.richiamo), borderColor: css("--warn"), backgroundColor: css("--warn") }] },
      options: { scales: { y: { min: 0, max: 1 }, x: { title: { display: true, text: "soglia EAR" } } } } });
    $("#v-sweep-t").innerHTML = `<thead><tr><th class="num">Soglia</th><th class="num">Prec.</th><th class="num">Rich.</th><th class="num">FP</th><th class="num">FN</th></tr></thead><tbody>` +
      sweep.map(s => `<tr><td class="num">${s.t.toFixed(2)}</td><td class="num">${s.precisione.toFixed(2)}</td><td class="num">${s.richiamo.toFixed(2)}</td><td class="num">${s.fp}</td><td class="num">${s.fn}</td></tr>`).join("") + "</tbody>";
  } else {
    $("#v-sweep-t").innerHTML = `<tr><td class="muted">Carica indicatori.csv per la tabella di sensibilità.</td></tr>`;
  }
};

function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ------------------------------------------------------------------ tempo reale
function connectWS() {
  if (mock || location.protocol === "file:") return;
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws${token ? "?token=" + encodeURIComponent(token) : ""}`);
  ws.onopen = () => { $("#ws-state").textContent = "· aggiornamento in tempo reale"; setInterval(() => ws.readyState === 1 && ws.send("ping"), 20000); };
  ws.onmessage = m => {
    const msg = JSON.parse(m.data);
    if (msg.type === "event" && msg.data.level > (msg.data.prev_level ?? 0) && msg.data.level === 2) beep();
    if (current === "flotta") loadFleet();
  };
  ws.onclose = () => { $("#ws-state").textContent = "· riconnessione…"; setTimeout(connectWS, 3000); };
}

let audio;
function beep() {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = 880; g.gain.value = 0.08; o.connect(g).connect(audio.destination);
    o.start(); o.stop(audio.currentTime + 0.25);
  } catch {}
}

async function refresh() {
  try {
    if (current === "flotta") await loadFleet();
    else if (current === "eventi") { if (!vehicles.length) vehicles = await api("/vehicles"); fillVehicleSelects(); await loadEvents(); }
    else if (current === "statistiche") { if (!vehicles.length) vehicles = await api("/vehicles"); fillVehicleSelects(); await loadStats(); }
  } catch (e) { showBanner("Errore: " + esc(e.message)); }
}

// ------------------------------------------------------------------ backend dimostrativo (solo se quello vero manca)
class MockBackend {
  constructor() {
    const now = Date.now();
    this.vehicles = ["veicolo-01", "veicolo-02", "furgone-07", "furgone-12"].map((v, i) => ({
      vehicle: v, level: 0, mode: "completa", online: i !== 3, fps: 14.5, cpu_temp: 58, alert: i === 2 ? "non verificabile" : "ok",
      face_ratio: 0.96, perclos: 0.04, outbox_pending: 0, received_epoch: now / 1000 }));
    this.events = [];
    const reasons = { 1: ["PERCLOS", "sbadigli ripetuti", "volto assente"], 2: ["microsonno", "chinamento", "PERCLOS alto"] };
    for (let k = 0; k < 140; k++) {
      const v = this.vehicles[k % 4].vehicle, lv = Math.random() < 0.35 ? 2 : 1;
      const h = [2, 3, 4, 14, 15, 16, 23][k % 7] + (k % 3);
      const d = new Date(now - Math.floor(Math.random() * 7) * 864e5); d.setHours(h % 24, Math.floor(Math.random() * 60));
      this.events.push(this._ev(v, lv, 0, d, reasons[lv][k % 3]));
    }
    this.reasons = reasons;
    setInterval(() => this._tick(), 4000);
  }
  _ev(vehicle, level, prev, d, reason) {
    return { event_id: Math.random().toString(36).slice(2), vehicle, ts: d.toISOString(), level, prev_level: prev, reason,
             perclos: +(Math.random() * 0.35 + 0.05).toFixed(3), ear: +(Math.random() * 0.2 + 0.1).toFixed(3), via: "mqtt" };
  }
  _tick() {
    for (const v of this.vehicles.filter(v => v.online)) {
      v.fps = +(13 + Math.random() * 3).toFixed(1); v.cpu_temp = +(55 + Math.random() * 15).toFixed(1);
      v.perclos = +(Math.random() * 0.12).toFixed(3); v.received_epoch = Date.now() / 1000;
      const r = Math.random(); let nw = v.level;
      if (v.level === 0 && r < 0.08) nw = Math.random() < 0.3 ? 2 : 1; else if (v.level > 0 && r < 0.35) nw = v.level - 1;
      if (nw !== v.level) {
        this.events.push(this._ev(v.vehicle, nw, v.level, new Date(), nw < v.level ? "rientro" : this.reasons[nw][Math.floor(Math.random() * 3)]));
        if (nw === 2) beep();
        v.level = nw;
      }
    }
    if (current === "flotta") loadFleet();
  }
  handle(path) {
    const [p, qs] = path.split("?"), q = new URLSearchParams(qs || "");
    const isAlarm = e => e.level > e.prev_level;
    const day = 864e5, now = Date.now();
    if (p === "/vehicles") return this.vehicles.map(v => {
      const ev = this.events.filter(e => e.vehicle === v.vehicle && now - Date.parse(e.ts) < day && isAlarm(e));
      return { ...v, seconds_since_status: v.online ? Math.round(now / 1000 - v.received_epoch) : 3600 * 5,
               events_24h: ev.length, danger_24h: ev.filter(e => e.level === 2).length };
    });
    if (p === "/events") {
      let e = this.events.filter(e => e.level >= +(q.get("min_level") || 0));
      if (q.get("vehicle")) e = e.filter(x => x.vehicle === q.get("vehicle"));
      if (q.get("only_alarms") === "true") e = e.filter(isAlarm);
      return e.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, +(q.get("limit") || 200));
    }
    if (p === "/stats") {
      const days = +(q.get("days") || 7);
      let e = this.events.filter(x => isAlarm(x) && now - Date.parse(x.ts) < days * day);
      if (q.get("vehicle")) e = e.filter(x => x.vehicle === q.get("vehicle"));
      const group = (key) => { const m = {}; e.forEach(x => { const k = key(x); m[k] = m[k] || []; m[k].push(x); }); return m; };
      const byDay = group(x => x.ts.slice(0, 10)), byReason = group(x => x.reason), byHour = group(x => new Date(x.ts).getHours());
      return {
        by_day: Object.keys(byDay).sort().map(d => ({ day: d, l1: byDay[d].filter(x => x.level === 1).length, l2: byDay[d].filter(x => x.level === 2).length })),
        by_reason: Object.entries(byReason).map(([reason, l]) => ({ reason, n: l.length })).sort((a, b) => b.n - a.n),
        by_hour: Object.entries(byHour).map(([hour, l]) => ({ hour: +hour, n: l.length })),
        totals: { alarms: e.length, danger: e.filter(x => x.level === 2).length, warning: e.filter(x => x.level === 1).length, vehicles: new Set(e.map(x => x.vehicle)).size },
      };
    }
    return [];
  }
}

refresh().then(connectWS);
setInterval(() => current === "flotta" && !mock && refresh(), 10000);
