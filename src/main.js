// ─── Config ──────────────────────────────────────────────────────────────────
const API_KEY = import.meta.env.VITE_ROBOFLOW_KEY ?? '';
const ENDPOINT = 'https://serverless.roboflow.com/golfball/1';
const CAPTURE_W = 640;
const CAPTURE_H = 480;
const INTERVAL_MS = 250;
const BOX_COLOR = '#00ff88';
const BOX_FONT = 'bold 14px -apple-system, sans-serif';

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const video = document.getElementById('camera');
const overlay = document.getElementById('overlay');
const pulseEl = document.getElementById('pulse');
const statusEl = document.getElementById('status');
const thresholdInput = document.getElementById('threshold');
const thresholdVal = document.getElementById('threshold-val');
const permOverlay = document.getElementById('permission-overlay');
const startBtn = document.getElementById('start-btn');
const errMsg = document.getElementById('err-msg');
const ctx = overlay.getContext('2d');

// ─── State ────────────────────────────────────────────────────────────────────
let threshold = parseFloat(thresholdInput.value);
let audioCtx = null;
let inferring = false;
let lastPredictions = [];
let animFrameId = null;

// ─── Offscreen capture canvas ─────────────────────────────────────────────────
const capture = document.createElement('canvas');
capture.width = CAPTURE_W;
capture.height = CAPTURE_H;
const captureCtx = capture.getContext('2d');

// ─── Threshold slider ─────────────────────────────────────────────────────────
thresholdInput.addEventListener('input', () => {
  threshold = parseFloat(thresholdInput.value);
  thresholdVal.textContent = `${Math.round(threshold * 100)}%`;
});

// ─── AudioContext (lazy — needs a user gesture first) ─────────────────────────
function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

function beep() {
  if (!audioCtx) return;
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.12);
  } catch (_) {
    // audio not available — silently skip
  }
}

// ─── Pulse animation ──────────────────────────────────────────────────────────
let pulseTimeout = null;
function triggerPulse() {
  pulseEl.classList.remove('active');
  // force reflow so the animation restarts
  void pulseEl.offsetWidth;
  pulseEl.classList.add('active');
  clearTimeout(pulseTimeout);
  pulseTimeout = setTimeout(() => pulseEl.classList.remove('active'), 650);
}

// ─── Overlay canvas sizing ────────────────────────────────────────────────────
function resizeOverlay() {
  overlay.width = overlay.offsetWidth;
  overlay.height = overlay.offsetHeight;
}
new ResizeObserver(resizeOverlay).observe(overlay);
resizeOverlay();

// ─── Draw bounding boxes ──────────────────────────────────────────────────────
function drawPredictions(predictions) {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!predictions.length) return;

  // The Roboflow response coords are relative to the capture canvas (CAPTURE_W x CAPTURE_H).
  // Scale them to the overlay's actual display size.
  const scaleX = overlay.width / CAPTURE_W;
  const scaleY = overlay.height / CAPTURE_H;

  for (const p of predictions) {
    if (p.confidence < threshold) continue;

    const x = (p.x - p.width / 2) * scaleX;
    const y = (p.y - p.height / 2) * scaleY;
    const w = p.width * scaleX;
    const h = p.height * scaleY;

    // Box
    ctx.strokeStyle = BOX_COLOR;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = BOX_COLOR;
    ctx.shadowBlur = 8;
    ctx.strokeRect(x, y, w, h);
    ctx.shadowBlur = 0;

    // Label background
    const label = `Golf Ball  ${Math.round(p.confidence * 100)}%`;
    ctx.font = BOX_FONT;
    const textW = ctx.measureText(label).width;
    const labelH = 20;
    const lx = x;
    const ly = y > labelH ? y - labelH : y + h;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(lx, ly, textW + 10, labelH);

    // Label text
    ctx.fillStyle = BOX_COLOR;
    ctx.fillText(label, lx + 5, ly + 14);
  }
}

// ─── Render loop (RAF) ────────────────────────────────────────────────────────
function renderLoop() {
  drawPredictions(lastPredictions);
  animFrameId = requestAnimationFrame(renderLoop);
}

// ─── Roboflow inference ───────────────────────────────────────────────────────
async function runInference() {
  if (inferring || video.readyState < 2) return;
  inferring = true;

  try {
    captureCtx.drawImage(video, 0, 0, CAPTURE_W, CAPTURE_H);
    const dataURL = capture.toDataURL('image/jpeg', 0.7);
    const base64 = dataURL.replace(/^data:image\/jpeg;base64,/, '');

    const res = await fetch(`${ENDPOINT}?api_key=${API_KEY}&format=json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: base64,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const preds = (data.predictions ?? []).filter(p => p.confidence >= threshold);
    lastPredictions = data.predictions ?? [];

    if (preds.length > 0) {
      statusEl.textContent = `Detected ${preds.length} ball${preds.length > 1 ? 's' : ''}`;
      statusEl.className = 'detecting';
      triggerPulse();
      beep();
    } else {
      statusEl.textContent = 'Scanning…';
      statusEl.className = '';
      lastPredictions = data.predictions ?? [];
    }
  } catch (err) {
    console.warn('Inference error:', err);
    statusEl.textContent = 'API error';
    statusEl.className = '';
  } finally {
    inferring = false;
  }
}

// ─── Camera init ──────────────────────────────────────────────────────────────
async function startCamera() {
  ensureAudio();
  startBtn.disabled = true;
  errMsg.style.display = 'none';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });

    video.srcObject = stream;
    await video.play();

    permOverlay.classList.remove('visible');
    statusEl.textContent = 'Scanning…';
    renderLoop();
    setInterval(runInference, INTERVAL_MS);
  } catch (err) {
    startBtn.disabled = false;
    errMsg.style.display = 'block';
    if (err.name === 'NotAllowedError') {
      errMsg.textContent = 'Camera permission denied. Please allow camera access and try again.';
    } else if (err.name === 'NotFoundError') {
      errMsg.textContent = 'No camera found on this device.';
    } else {
      errMsg.textContent = `Camera error: ${err.message}`;
    }
  }
}

startBtn.addEventListener('click', startCamera);
