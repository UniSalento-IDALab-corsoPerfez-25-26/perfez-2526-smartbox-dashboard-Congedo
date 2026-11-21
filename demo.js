import { DrowsinessMonitor, DEFAULT_CONFIG, deepCopy, evaluate, alarmsOnly, toCSV, configToYaml } from "./logic.js?v=7";

const MP_VERSION = "0.10.14";
const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

// stessi indici di smartbox/detector.py
const LEFT_EYE = [362, 385, 387, 263, 373, 380], RIGHT_EYE = [33, 160, 158, 133, 153, 144];
const MOUTH = { top: 13, bottom: 14, left: 78, right: 308 };
const FOREHEAD = 10, CHIN = 152;
// Protocollo del capitolo 5.2, versione 2: episodi più lunghi (4 / 7 / 4 s invece di 3 / 3 / 2) perché chi
// segue un'istruzione vocale reagisce in 1-1,5 s e uno sbadiglio vero dura 4-6 s. Ogni episodio è annunciato
// 3 s prima ("Preparati"). Le annotazioni partono dall'istruzione: la latenza misurata include la reazione.
// Gli episodi "socchiusi" (come per il sole) e "sbadiglio" (isolato) sono di controllo: NON devono dare allarme;
// un allarme lì è un falso positivo. Uno sbadiglio isolato non è un segnale di pericolo: contano solo 3 sbadigli in 60 s
// (registro decisioni D-09, D-19). Nella prova sbadigli, invece, gli sbadigli sono gli episodi da contare.
// Il controllo è in testa: dopo un allarme il livello scende solo dopo 10 s, e un controllo successivo
// non sarebbe valutabile (prova del 10/11: "socchiusi" a 40 s con il livello ancora a 2 dallo sbadiglio).
const PROTOCOL = [
  [0, 10, "Comportamento normale: guarda avanti", null], [10, 15, "SOCCHIUDI GLI OCCHI (sole)", "socchiusi"],
  [15, 22, "Normale", null], [22, 26, "CHIUDI GLI OCCHI", "occhi_chiusi"], [26, 36, "Normale", null],
  [36, 43, "SBADIGLIA", "sbadiglio"], [43, 50, "Normale", null],
  [50, 54, "CHINA LA TESTA IN AVANTI", "chinamento"], [54, 60, "Normale", null]];
const CONTROL = new Set(["socchiusi", "sbadiglio"]);   // episodi del protocollo in cui l'allarme non è atteso
// Prova sbadigli: tre sbadigli in 60 s; con yawns_per_window_warning = 3 l'allarme arriva al terzo.
const YAWN_TEST = [
  [0, 8, "Comportamento normale: guarda avanti", null], [8, 15, "SBADIGLIA", "sbadiglio"],
  [15, 25, "Normale", null], [25, 32, "SBADIGLIA", "sbadiglio"], [32, 42, "Normale", null],
  [42, 49, "SBADIGLIA", "sbadiglio"], [49, 60, "Normale", null]];
const SPOKEN = { occhi_chiusi: "chiudi gli occhi", sbadiglio: "sbadiglia", chinamento: "china la testa in avanti", socchiusi: "socchiudi gli occhi, come per il sole" };
let activeProto = PROTOCOL, protoYawns = [];
const LEVEL = ["Normale", "Attenzione", "Pericolo"];

const $ = s => document.querySelector(s);
const video = $("#video"), overlay = $("#overlay"), ctx = overlay.getContext("2d");
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let cfg = loadCfg(), monitor = new DrowsinessMonitor(cfg), landmarker = null, stream = null, running = false;
let t0 = 0, pitchBaseline = loadNum("smartbox_pitch_baseline", 0), lastVideoTime = -1;
let events = [], frames = [], mode = "live", modeStart = 0, calib = null, protoFrames = [], protoEvents = [];
let fpsEma = 0, lastFrameAt = 0;
// Taratura automatica all'avvio: l'EAR a occhi aperti varia molto tra persone e angolazioni della camera
// (0,18–0,35), quindi una soglia fissa 0,21 può classificare "chiusi" occhi aperti. Nei primi secondi si misura
// l'EAR a occhi aperti e la soglia diventa una frazione di quel valore (0,75 × 0,28 ≈ 0,21, il default della tesi).
// Limiti di plausibilità: sotto EAR_OPEN_MIN la misura "a occhi aperti" non è credibile (sguardo in basso,
// occhi socchiusi, volto di profilo) e la taratura si ripete; la soglia resta comunque in [THR_MIN, THR_MAX].
// Criterio P80 (PERCLOS, Wierwille 1994; Dinges 1998): l'occhio è "chiuso" se chiuso per oltre l'80%, cioè
// EAR < chiusi + 0,2 × (aperti − chiusi). Così gli occhi socchiusi (sole, abbagliamento) non contano come chiusi.
// Serve l'EAR a occhi chiusi, che cambia molto tra sessioni (misurato 0,04 e 0,13): lo dà solo "Calibra".
// La taratura automatica conosce solo gli occhi aperti: soglia provvisoria più prudente (50% di chiusura).
// Criteri della taratura e della demo da config.yaml (sezioni calibration e demo, D-48).
const CAL = DEFAULT_CONFIG.calibration, DEMO = DEFAULT_CONFIG.demo;
const P80_FRACTION = 1 - CAL.fraction;   // EAR: scende chiudendo, la soglia è a (1 − 0,8) del percorso dai chiusi
// Anche le soglie blendshape si tarano sul soggetto (registro D-23, D-24; stessa formula di smartbox/calibration.py):
// palpebra chiusa e scarto palpebra − occhi stretti salgono chiudendo gli occhi, la soglia è all'80% del percorso
// aperti -> chiusi. Le soglie fisse 0,60 / 0,25 valevano per il soggetto 1 ma non per il soggetto 2.
const BS_GAP_MIN = CAL.min_gap, BLINK_LIMITS = CAL.blink_limits, MARGIN_LIMITS = CAL.margin_limits;
const clampTo = (x, [lo, hi]) => Math.min(hi, Math.max(lo, x));
function blendshapeThresholds(open, closed) {
  if (open.length < CAL.min_open_samples || closed.length < CAL.min_closed_samples) return null;
  const bo = median(open.map(p => p[0])), bc = median(closed.map(p => p[0]));
  const dO = median(open.map(p => p[0] - p[1])), dC = median(closed.map(p => p[0] - p[1]));
  if (bc - bo < BS_GAP_MIN || dC - dO < BS_GAP_MIN) return null;
  return { blink: +clampTo(bo + CAL.fraction * (bc - bo), BLINK_LIMITS).toFixed(3), margin: +clampTo(dO + CAL.fraction * (dC - dO), MARGIN_LIMITS).toFixed(3), bo, bc };
}
const AUTO_SECONDS = DEMO.auto_seconds, AUTO_RATIO = DEMO.auto_ratio, EAR_OPEN_MIN = DEMO.ear_open_min, AUTO_MAX_TRIES = DEMO.auto_max_tries;
const [THR_MIN, THR_MAX] = CAL.ear_limits;
let autoBase = null;
const clampThr = x => Math.min(THR_MAX, Math.max(THR_MIN, x));

function loadCfg() {
  try {
    const c = JSON.parse(localStorage.getItem("smartbox_cfg"));
    if (c?.indicators && c?.alarm) {
      // una soglia salvata fuori dai limiti (es. 0,30) classificherebbe chiusi occhi aperti: si torna al default
      const thr = c.indicators.ear_closed_threshold;
      if (!(thr >= THR_MIN && thr <= THR_MAX)) c.indicators.ear_closed_threshold = DEFAULT_CONFIG.indicators.ear_closed_threshold;
      // configurazioni salvate prima della revisione degli sbadigli: soglia MAR 0,6 -> nuovo default
      if (c.indicators.mar_yawn_threshold === 0.6) c.indicators.mar_yawn_threshold = DEFAULT_CONFIG.indicators.mar_yawn_threshold;
      c.alarm = { ...DEFAULT_CONFIG.alarm, ...c.alarm };
      c.indicators = { ...DEFAULT_CONFIG.indicators, ...c.indicators };
      // parametri nuovi con il loro default, e valori delle versioni precedenti aggiornati
      if ([10, 25].includes(c.alarm.perclos_min_seconds)) c.alarm.perclos_min_seconds = DEFAULT_CONFIG.alarm.perclos_min_seconds;
      if (c.indicators.window_seconds === 30) c.indicators.window_seconds = DEFAULT_CONFIG.indicators.window_seconds;
      return c;
    }
  } catch {}
  return deepCopy(DEFAULT_CONFIG);
}
function saveCfg() { try { localStorage.setItem("smartbox_cfg", JSON.stringify(cfg)); } catch {} }
function loadNum(k, d) { try { const v = parseFloat(localStorage.getItem(k)); return isNaN(v) ? d : v; } catch { return d; } }

// ------------------------------------------------------------------ indicatori (porting di detector.py)
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function ear(pts) {
  const [p1, p2, p3, p4, p5, p6] = pts, h = dist(p1, p4);
  return h ? (dist(p2, p6) + dist(p3, p5)) / (2 * h) : 0;
}
function indicators(lm, w, h) {
  const pt = i => [lm[i].x * w, lm[i].y * h];
  const e = (ear(LEFT_EYE.map(pt)) + ear(RIGHT_EYE.map(pt))) / 2;
  const mw = dist(pt(MOUTH.left), pt(MOUTH.right));
  const m = mw ? dist(pt(MOUTH.top), pt(MOUTH.bottom)) / mw : 0;
  // inclinazione dalla profondità: chinando il capo la fronte si avvicina alla camera e il mento si allontana.
  // (nel browser non c'è solvePnP; il valore è relativo alla posa neutra registrata in calibrazione)
  const dy = (lm[CHIN].y - lm[FOREHEAD].y) * h, dz = (lm[CHIN].z - lm[FOREHEAD].z) * w;
  const raw = Math.atan2(dz, dy) * 180 / Math.PI;
  return { face_found: true, ear: e, mar: m, pitchRaw: raw, pitch: raw - pitchBaseline };
}

// ------------------------------------------------------------------ camera e modello
$("#b-start").onclick = async () => {
  $("#b-start").disabled = true;
  try {
    $("#ph").textContent = "Carico il modello MediaPipe (pochi MB, una volta sola)…";
    if (!landmarker) {
      const { FilesetResolver, FaceLandmarker } = await import(`${MP_URL}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${MP_URL}/wasm`);
      landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" }, runningMode: "VIDEO", numFaces: 1,
        minFaceDetectionConfidence: DEFAULT_CONFIG.detector.min_detection_confidence, minTrackingConfidence: DEFAULT_CONFIG.detector.min_tracking_confidence,
        outputFaceBlendshapes: true });   // punteggi 0-1 per palpebra chiusa, occhi stretti, mandibola aperta
    }
    $("#ph").textContent = "Attendo il permesso della webcam…";
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" }, audio: false });
    video.srcObject = stream; await video.play();
    $("#ph").classList.add("hidden");
    overlay.width = video.videoWidth; overlay.height = video.videoHeight;
    resetSession(); running = true;
    ["#b-calib", "#b-proto", "#b-yawn", "#b-stop"].forEach(s => $(s).disabled = false);
    requestAnimationFrame(loop);
  } catch (e) {
    $("#ph").innerHTML = `<span>Impossibile avviare: ${esc(e.message || e)}.<br>Serve una pagina servita da <span class="mono">http://localhost</span> o https e il permesso della webcam.</span>`;
    $("#b-start").disabled = false;
  }
};

$("#b-stop").onclick = () => {
  running = false; stream?.getTracks().forEach(t => t.stop()); stopSound();
  ["#b-calib", "#b-proto", "#b-yawn", "#b-stop"].forEach(s => $(s).disabled = true);
  $("#b-start").disabled = false; $("#ph").classList.remove("hidden"); $("#ph").textContent = "Camera ferma.";
  setPrompt(null); mode = "live";
};

function resetSession() {
  monitor = new DrowsinessMonitor(cfg); events = []; frames = []; t0 = performance.now(); renderEvents();
  autoBase = { ears: [], start: 0, tries: 1 };
}

// percentile alto (demo.open_quantile) invece della mediana: i battiti e gli sguardi brevi verso il basso non abbassano la stima
const pctOpen = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * DEMO.open_quantile)]; };

function finishAutoBase(t) {
  const ears = autoBase.ears;
  const eo = ears.length >= DEMO.auto_min_samples ? pctOpen(ears) : NaN;
  if (!(eo >= EAR_OPEN_MIN)) {
    // misura non credibile: si riprova, poi si lascia la soglia attuale
    if (autoBase.tries < AUTO_MAX_TRIES) { autoBase = { ears: [], start: t, tries: autoBase.tries + 1 }; return; }
    autoBase = null;
    setPrompt(`Taratura non riuscita (${ears.length < DEMO.auto_min_samples ? "volto poco visibile" : "EAR occhi aperti " + eo.toFixed(2)}): tengo la soglia ${cfg.indicators.ear_closed_threshold}. Guarda la camera e premi "Calibra".`);
    say("Taratura non riuscita.");
    setTimeout(() => setPrompt(null), 6000); return;
  }
  autoBase = null;
  say("Pronto.");
  const auto = +clampThr(eo * AUTO_RATIO).toFixed(3), cur = cfg.indicators.ear_closed_threshold;
  let manual = false; try { manual = localStorage.getItem("smartbox_ear_calibrated") === "1"; } catch {}
  // una calibrazione manuale si tiene solo se è compatibile con gli occhi aperti di adesso
  if (manual && cur < eo * DEMO.keep_manual_ratio) { setPrompt(`EAR occhi aperti ${eo.toFixed(2)}: tengo la soglia calibrata ${cur}`); }
  else {
    cfg.indicators.ear_closed_threshold = auto; renderSettings(); applyCfg();
    try { localStorage.removeItem("smartbox_ear_calibrated"); } catch {}
    setPrompt(`EAR occhi aperti ${eo.toFixed(2)} → soglia provvisoria ${auto}. Premi "Calibra" per la soglia all'80% di chiusura.`);
    if (cfg.indicators.eye_closure_source === "ear") setTimeout(() => say("Soglia provvisoria. Per la soglia precisa premi Calibra."), 900);
  }
  setTimeout(() => setPrompt(null), 4000);
}

function loop() {
  if (!running) return;
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const nowMs = performance.now(), t = (nowMs - t0) / 1000;
    const res = landmarker.detectForVideo(video, nowMs);
    const lm = res.faceLandmarks?.[0];
    const ind = lm ? indicators(lm, video.videoWidth, video.videoHeight) : { face_found: false, ear: 0, mar: 0, pitch: 0 };
    // Blendshape MediaPipe: blink = palpebra chiusa, squint = occhi stretti, jaw = mandibola aperta (media dei due occhi).
    // La logica usa blink/squint per decidere se l'occhio è chiuso; senza blendshape torna all'EAR.
    const bs = Object.fromEntries((res.faceBlendshapes?.[0]?.categories ?? []).map(c => [c.categoryName, c.score]));
    if (lm && "eyeBlinkLeft" in bs) {
      ind.blink = (bs.eyeBlinkLeft + bs.eyeBlinkRight) / 2;
      ind.squint = ((bs.eyeSquintLeft ?? 0) + (bs.eyeSquintRight ?? 0)) / 2;
      ind.jaw = bs.jawOpen ?? 0;
    }
    let ev = null;
    if (autoBase && mode === "live") {
      if (ind.face_found) autoBase.ears.push(ind.ear);
      const left = AUTO_SECONDS - (t - autoBase.start);
      setPrompt(`${autoBase.tries > 1 ? "Riprovo – " : ""}Taratura: guarda la camera con gli occhi aperti (${Math.max(1, Math.ceil(left))})`);
      say(autoBase.tries > 1 ? `Riprovo. Guarda la camera. (${autoBase.tries})` : "Taratura. Guarda la camera con gli occhi aperti.");
      if (left <= 0) finishAutoBase(t);
    } else ev = monitor.update(ind, t);
    frames.push({ t: +t.toFixed(3), face: ind.face_found ? 1 : 0, ear: +ind.ear.toFixed(4), mar: +ind.mar.toFixed(4), pitch: +ind.pitch.toFixed(2), perclos: monitor.perclos, level: monitor.level });
    if (frames.length > 20000) frames.splice(0, 5000);
    if (ev) { events.unshift(ev); renderEvents(); }
    draw(lm);
    handleMode(t, ind, ev);
    if (lastFrameAt) fpsEma = 0.9 * fpsEma + 0.1 * (1000 / (nowMs - lastFrameAt));
    lastFrameAt = nowMs;
    updateUI(ind);
  }
  requestAnimationFrame(loop);
}

function draw(lm) {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!lm) return;
  const col = ["#2ecc71", "#f0a83a", "#ff5252"][monitor.level];
  ctx.fillStyle = col;
  for (const i of [...LEFT_EYE, ...RIGHT_EYE, MOUTH.top, MOUTH.bottom, MOUTH.left, MOUTH.right, FOREHEAD, CHIN]) {
    ctx.beginPath(); ctx.arc(lm[i].x * overlay.width, lm[i].y * overlay.height, 2.5, 0, 7); ctx.fill();
  }
}

// ------------------------------------------------------------------ UI
let lastUi = 0;
function updateUI(ind) {
  const now = performance.now();
  setLevel(monitor.level);
  if (now - lastUi < 150) return;
  lastUi = now;
  $("#m-ear").textContent = ind.face_found ? ind.ear.toFixed(2) : "–";
  $("#m-mar").textContent = ind.face_found ? ind.mar.toFixed(2) : "–";
  $("#m-pitch").textContent = ind.face_found ? (ind.pitch >= 0 ? "+" : "") + ind.pitch.toFixed(0) : "–";
  $("#m-perclos").textContent = (monitor.perclos * 100).toFixed(0) + "%";
  $("#fps").textContent = `${fpsEma.toFixed(0)} fps · ${ind.face_found ? (ind.blink != null ? `volto rilevato · palpebra ${ind.blink.toFixed(2)} · occhi stretti ${ind.squint.toFixed(2)} · mandibola ${ind.jaw.toFixed(2)}` : "volto rilevato · solo EAR") : "volto non trovato"}`;
  updateChart();
}

let shownLevel = -1;
function setLevel(lv) {
  if (lv === shownLevel) return;
  shownLevel = lv;
  const el = $("#level"); el.className = `level-big l${lv}`;
  el.textContent = monitor.faceLost && lv === 1 ? "Attenzione – volto assente" : LEVEL[lv];
  playPattern(lv);
}

function renderEvents() {
  $("#events").innerHTML = events.length
    ? `<thead><tr><th class="num">t (s)</th><th>Livello</th><th>Motivo</th><th class="num">PERCLOS</th></tr></thead><tbody>` +
      events.slice(0, 50).map(e => `<tr><td class="num">${e.t.toFixed(1)}</td><td><span class="badge b${e.level}">${e.prev_level} → ${e.level}</span></td><td>${esc(e.reason)}</td><td class="num">${(e.perclos * 100).toFixed(0)}%</td></tr>`).join("") + "</tbody>"
    : `<tr><td class="muted">Nessun evento</td></tr>`;
}

// grafico scorrevole
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
Chart.defaults.color = css("--muted"); Chart.defaults.borderColor = css("--border");
const live = new Chart($("#c-live"), {
  type: "line",
  data: { datasets: [
    { label: "EAR", data: [], borderColor: css("--accent"), borderWidth: 1.5, pointRadius: 0, yAxisID: "y" },
    { label: "soglia EAR", data: [], borderColor: css("--danger"), borderDash: [5, 4], borderWidth: 1, pointRadius: 0, yAxisID: "y" },
    { label: "PERCLOS", data: [], borderColor: css("--warn"), borderWidth: 1.5, pointRadius: 0, yAxisID: "y" }] },
  options: { animation: false, maintainAspectRatio: false, parsing: false,
    scales: { x: { type: "linear", min: 0, max: 30, ticks: { callback: v => v.toFixed(0) + " s" } }, y: { min: 0, max: 0.5 } },
    plugins: { legend: { labels: { boxWidth: 12 } } } },
});
function updateChart() {
  const tEnd = frames.length ? frames[frames.length - 1].t : 0, tStart = tEnd - 30;
  const win = frames.filter(f => f.t >= tStart);
  live.data.datasets[0].data = win.filter(f => f.face).map(f => ({ x: f.t, y: f.ear }));
  live.data.datasets[1].data = [{ x: tStart, y: cfg.indicators.ear_closed_threshold }, { x: tEnd, y: cfg.indicators.ear_closed_threshold }];
  live.data.datasets[2].data = win.map(f => ({ x: f.t, y: f.perclos }));
  live.options.scales.x.min = Math.max(0, tStart); live.options.scales.x.max = Math.max(30, tEnd);
  live.update("none");
}

// ------------------------------------------------------------------ soglie
const FIELDS = [
  ["indicators", "ear_closed_threshold", "Soglia EAR occhio chiuso", 0.01],
  ["indicators", "blink_closed_threshold", "Palpebra chiusa (blendshape)", 0.05],
  ["indicators", "blink_squint_margin", "Margine palpebra − occhi stretti", 0.05],
  ["indicators", "mar_yawn_threshold", "Soglia MAR sbadiglio", 0.05],
  ["indicators", "pitch_nod_threshold", "Soglia chinamento (°)", 1],
  ["alarm", "perclos_warning", "PERCLOS attenzione", 0.01],
  ["alarm", "perclos_danger", "PERCLOS pericolo", 0.01],
  ["alarm", "microsleep_seconds", "Microsonno (s)", 0.1],
  ["alarm", "yawns_per_window_warning", "Sbadigli per attenzione", 1],
  ["alarm", "hysteresis_seconds", "Isteresi (s)", 1],
];
function renderSettings() {
  $("#settings").innerHTML = FIELDS.map(([s, k, l, step]) =>
    `<label for="cfg-${k}">${l}</label><input type="number" id="cfg-${k}" data-s="${s}" data-k="${k}" step="${step}" value="${cfg[s][k]}">`).join("") +
    `<label for="cfg-grad">Discesa graduale 2→1→0</label><input type="checkbox" id="cfg-grad" ${cfg.alarm.gradual_descent ? "checked" : ""}>`;
  $("#settings").querySelectorAll("input[type=number]").forEach(inp => inp.onchange = () => {
    cfg[inp.dataset.s][inp.dataset.k] = +inp.value; applyCfg();
  });
  $("#cfg-grad").onchange = e => { cfg.alarm.gradual_descent = e.target.checked; applyCfg(); };
}
function applyCfg() { saveCfg(); monitor = new DrowsinessMonitor(cfg); }
$("#b-reset").onclick = () => { cfg = deepCopy(DEFAULT_CONFIG); pitchBaseline = 0; try { localStorage.removeItem("smartbox_pitch_baseline"); localStorage.removeItem("smartbox_ear_calibrated"); } catch {} renderSettings(); applyCfg(); };
$("#b-yaml").onclick = () => download("config_tarata.yaml", configToYaml(cfg) + `# baseline inclinazione nel browser: ${pitchBaseline.toFixed(1)}°\n`);
renderSettings();

// ------------------------------------------------------------------ calibrazione e protocollo
$("#b-calib").onclick = () => { autoBase = null; mode = "calib"; modeStart = (performance.now() - t0) / 1000; calib = { open: [], closed: [], pitch: [], openBs: [], closedBs: [] }; };
function startProto(p) {
  activeProto = p; autoBase = null; mode = "proto"; monitor = new DrowsinessMonitor(cfg); modeStart = (performance.now() - t0) / 1000;
  protoFrames = []; protoEvents = []; protoYawns = []; spoken = ""; $("#result").classList.add("hidden");
}
$("#b-proto").onclick = () => startProto(PROTOCOL);
$("#b-yawn").onclick = () => startProto(YAWN_TEST);

function setPrompt(text) { const p = $("#prompt"); p.classList.toggle("hidden", !text); if (text) p.textContent = text; }

// Istruzioni a voce: durante calibrazione e protocollo si guarda la camera, non lo schermo.
// Si usano solo voci installate sul computer (localService): il testo non va a servizi di sintesi in rete.
// Senza una voce italiana locale si suona solo un segnale breve a ogni cambio di istruzione.
let spoken = "";
function say(text) {
  if (text === spoken) return;
  spoken = text;
  if ($("#voice")?.checked === false) return;
  try {
    const v = speechSynthesis.getVoices().find(v => v.lang?.toLowerCase().startsWith("it") && v.localService);
    if (!v) { tone(250); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/\s*\(\d+\)$/, ""));
    u.voice = v; u.lang = v.lang; u.rate = 1.05;
    speechSynthesis.speak(u);
  } catch { tone(250); }
}
try { speechSynthesis.getVoices(); } catch {}   // Chrome carica l'elenco delle voci in modo asincrono
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

function handleMode(t, ind, ev) {
  const dt = t - modeStart;
  if (mode === "calib") {
    const PH = DEMO.calib_phases;   // fine di ogni fase in secondi (config.yaml, demo.calib_phases)
    if (dt < PH.prepara) { setPrompt("Calibrazione: guarda la camera con gli occhi aperti…"); say("Calibrazione. Guarda la camera con gli occhi aperti."); }
    else if (dt < PH.aperti) { setPrompt(`Occhi aperti, posa normale (${Math.ceil(PH.aperti - dt)})`); if (ind.face_found) { calib.open.push(ind.ear); calib.pitch.push(ind.pitchRaw); if (ind.blink != null) calib.openBs.push([ind.blink, ind.squint]); } }
    else if (dt < PH.chiudi) { setPrompt("Ora CHIUDI GLI OCCHI…"); say("Chiudi gli occhi."); }
    else if (dt < PH.chiusi) { setPrompt(`Occhi chiusi (${Math.ceil(PH.chiusi - dt)})`); if (ind.face_found) { calib.closed.push(ind.ear); if (ind.blink != null) calib.closedBs.push([ind.blink, ind.squint]); } }
    else {
      mode = "live"; say("Apri gli occhi.");
      if (calib.open.length < CAL.min_open_samples || calib.closed.length < CAL.min_closed_samples) { setPrompt("Volto non rilevato abbastanza: riprova con più luce."); setTimeout(() => setPrompt(null), 3000); return; }
      const eo = median(calib.open), ec = median(calib.closed);
      if (ec >= eo * CAL.ear_distinct_ratio) { setPrompt(`Occhi chiusi non distinguibili (aperti ${eo.toFixed(2)}, chiusi ${ec.toFixed(2)}): soglia invariata, riprova.`); setTimeout(() => setPrompt(null), 4000); return; }
      try { localStorage.setItem("smartbox_ear_calibrated", "1"); } catch {}
      pitchBaseline = median(calib.pitch);
      try { localStorage.setItem("smartbox_pitch_baseline", pitchBaseline); } catch {}
      cfg.indicators.ear_closed_threshold = +clampThr(ec + P80_FRACTION * (eo - ec)).toFixed(3);   // criterio P80
      // soglie blendshape del soggetto; se la misura non è credibile restano quelle attuali
      const bs = blendshapeThresholds(calib.openBs, calib.closedBs);
      if (bs) { cfg.indicators.blink_closed_threshold = bs.blink; cfg.indicators.blink_squint_margin = bs.margin; }
      renderSettings(); applyCfg();
      const bsMsg = bs ? ` · palpebra aperti ${bs.bo.toFixed(2)}, chiusi ${bs.bc.toFixed(2)} → soglia ${bs.blink}, margine ${bs.margin}`
                       : (calib.openBs.length ? " · palpebra: misura non credibile, soglie invariate" : "");
      setPrompt(`Fatto: EAR aperti ${eo.toFixed(2)}, chiusi ${ec.toFixed(2)} → soglia ${cfg.indicators.ear_closed_threshold} (80% di chiusura)${bsMsg}`);
      setTimeout(() => say("Calibrazione fatta."), 900);
      setTimeout(() => setPrompt(null), 4000);
    }
  } else if (mode === "proto") {
    const P = activeProto, end = P[P.length - 1][1];
    const step = P.find(([a, b]) => dt >= a && dt < b);
    if (step) {
      const next = P.find(([a, , , tipo]) => tipo && a > dt && a - dt <= 3);
      setPrompt(`${next ? `Preparati: ${SPOKEN[next[3]]}` : step[2]}  ·  ${dt.toFixed(0)} / ${end} s`);
      if (step[3]) say(`Ora: ${SPOKEN[step[3]]}. (${step[0]})`);
      else if (next) say(`Preparati: ${SPOKEN[next[3]]}. (${next[0]})`);
      else say(step[0] === 0 ? "Guarda avanti, comportamento normale." : `Basta. Guarda avanti. (${step[0]})`);
      protoFrames.push({ t: +dt.toFixed(3), face: ind.face_found ? 1 : 0, ear: +ind.ear.toFixed(4), mar: +ind.mar.toFixed(4), pitch: +ind.pitch.toFixed(2),
                         blink: ind.blink != null ? +ind.blink.toFixed(3) : "", squint: ind.squint != null ? +ind.squint.toFixed(3) : "", jaw: ind.jaw != null ? +ind.jaw.toFixed(3) : "" });
      if (ev) protoEvents.push({ ...ev, t: dt });
      const ly = monitor.yawns[monitor.yawns.length - 1];
      if (ly !== undefined && ly !== protoYawns.lastAbs) { protoYawns.lastAbs = ly; protoYawns.push(dt); }
    } else { mode = "live"; setPrompt(null); say("Prova finita."); showProtocolResult(); }
  }
}

function showProtocolResult() {
  const isControl = p => activeProto === PROTOCOL && CONTROL.has(p[3]);   // nella prova sbadigli non ci sono controlli
  const ann = activeProto.filter(p => p[3] && !isControl(p)).map(([a, b, , tipo]) => ({ inizio: a, fine: b, tipo }));
  const controls = activeProto.filter(isControl);
  $("#result").classList.remove("hidden");
  const prefix = activeProto === YAWN_TEST ? "sbadigli_" : "";
  $("#d-ev").onclick = () => download(prefix + "eventi.csv", toCSV(protoEvents.map(e => ({ timestamp: "", t_video_s: e.t.toFixed(2), level: e.level, prev_level: e.prev_level, reason: e.reason, perclos: e.perclos.toFixed(3), ear: e.ear.toFixed(3) })),
    ["timestamp", "t_video_s", "level", "prev_level", "reason", "perclos", "ear"]));
  $("#d-ind").onclick = () => download(prefix + "indicatori.csv", toCSV(protoFrames, ["t", "face", "ear", "mar", "pitch", "blink", "squint", "jaw"]));
  $("#d-ann").onclick = () => download(prefix + "annotazioni.csv", toCSV(ann.map(a => ({ inizio_s: a.inizio, fine_s: a.fine, tipo: a.tipo })), ["inizio_s", "fine_s", "tipo"]));
  if (activeProto === YAWN_TEST) { showYawnResult(ann); $("#result").scrollIntoView({ behavior: "smooth" }); return; }
  const res = evaluate(alarmsOnly(protoEvents), ann, DEFAULT_CONFIG.evaluation.tolerance_seconds);
  $("#r-kpis").innerHTML = [["Precisione", res.precisione.toFixed(2)], ["Richiamo", res.richiamo.toFixed(2)],
    ["Latenza media", res.latenza_media != null ? res.latenza_media.toFixed(1) + " s" : "n.d."], ["VP / FP / FN", `${res.vp} / ${res.fp} / ${res.fn}`]]
    .map(([l, v]) => `<div class="card kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");
  $("#r-detail").innerHTML = `<thead><tr><th>Episodio</th><th>Intervallo</th><th>Esito</th></tr></thead><tbody>` +
    res.dettaglio.map(d => `<tr><td>${d.tipo}</td><td>${d.inizio}–${d.fine} s</td><td>${d.allarme_t != null ? `<span class="pill-ok">✓ ${d.allarme_t.toFixed(1)} s (${esc(d.motivo)}), latenza ${d.latenza.toFixed(1)} s</span>` : `<span class="pill-bad">✗ mancato</span>`}</td></tr>`).join("") +
    controls.map(([a, b, , tipo]) => { const fp = res.falsi_positivi.filter(f => f.t >= a && f.t <= b + 3);
      return `<tr><td>${tipo} (controllo)</td><td>${a}–${b} s</td><td>${fp.length ? `<span class="pill-bad">✗ allarme a ${fp[0].t.toFixed(1)} s (${esc(fp[0].reason)})</span>` : `<span class="pill-ok">✓ nessun allarme</span>`}</td></tr>`; }).join("") +
    res.falsi_positivi.filter(f => !controls.some(([a, b]) => f.t >= a && f.t <= b + 3)).map(f => `<tr><td colspan="2" class="muted">falso positivo</td><td class="pill-bad">${f.t.toFixed(1)} s (${esc(f.reason)})</td></tr>`).join("") + "</tbody>";
  $("#result").scrollIntoView({ behavior: "smooth" });
}

// Prova sbadigli: per ogni sbadiglio richiesto, se e quando la logica l'ha contato; poi gli allarmi della prova.
function showYawnResult(ann) {
  const used = new Set();
  const rows = ann.map((a, i) => {
    const k = protoYawns.findIndex((t, j) => !used.has(j) && t >= a.inizio && t <= a.fine + 3);
    if (k >= 0) used.add(k);
    return `<tr><td>sbadiglio ${i + 1}</td><td>${a.inizio}–${a.fine} s</td><td>${k >= 0 ? `<span class="pill-ok">✓ contato a ${protoYawns[k].toFixed(1)} s</span>` : `<span class="pill-bad">✗ non contato</span>`}</td></tr>`;
  });
  const extra = protoYawns.filter((_, j) => !used.has(j));
  const alarms = alarmsOnly(protoEvents);
  const need = cfg.alarm.yawns_per_window_warning;
  $("#r-kpis").innerHTML = [["Sbadigli contati", `${used.size} / ${ann.length}`], ["Sbadigli fuori tempo", extra.length],
    ["Allarmi", alarms.length], ["Richiesti per allarme", need]]
    .map(([l, v]) => `<div class="card kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");
  $("#r-detail").innerHTML = `<thead><tr><th>Episodio</th><th>Intervallo</th><th>Esito</th></tr></thead><tbody>` + rows.join("") +
    extra.map(t => `<tr><td colspan="2" class="muted">sbadiglio non richiesto</td><td>${t.toFixed(1)} s</td></tr>`).join("") +
    (alarms.length ? alarms.map(e => `<tr><td colspan="2" class="muted">allarme</td><td><span class="${e.reason === "sbadigli ripetuti" ? "pill-ok" : "pill-bad"}">${e.t.toFixed(1)} s (${esc(e.reason)})</span></td></tr>`).join("")
                   : `<tr><td colspan="3" class="muted">Nessun allarme.</td></tr>`) + "</tbody>";
}

function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ------------------------------------------------------------------ avviso sonoro (stesso pattern di alerts.py)
let audio = null, soundTimer = null;
function tone(ms) {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = 1000; g.gain.value = 0.1; o.connect(g).connect(audio.destination);
    o.start(); o.stop(audio.currentTime + ms / 1000);
  } catch {}
}
function stopSound() { clearInterval(soundTimer); soundTimer = null; }
function playPattern(lv) {
  stopSound();
  if (!$("#sound").checked || lv === 0) return;
  if (lv === 1) { tone(100); soundTimer = setInterval(() => tone(100), 2000); }
  else { tone(150); soundTimer = setInterval(() => tone(150), 300); }
}
$("#sound").onchange = () => playPattern(monitor.level);
