// ─── Config ──────────────────────────────────────────────────────────────────
const API_KEY = import.meta.env.VITE_ROBOFLOW_KEY ?? '';
const ENDPOINT = 'https://serverless.roboflow.com/golfball/1';
const CAPTURE_W = 640;
const CAPTURE_H = 480;
const INTERVAL_MS = 250;
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
const toggleBtn = document.getElementById('toggle-btn');
const errMsg = document.getElementById('err-msg');
const ctx = overlay.getContext('2d');

// ─── State ────────────────────────────────────────────────────────────────────
let threshold = parseFloat(thresholdInput.value);
let audioCtx = null;
let inferring = false;
let lastPredictions = [];
let animFrameId = null;
let scanning = true;
let inferenceInterval = null;

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

// ─── Confidence color (blue=low → red=high across threshold–100%) ─────────────
function confidenceColor(confidence) {
  const t = Math.min(1, Math.max(0, (confidence - threshold) / (1 - threshold)));
  const hue = Math.round(240 * (1 - t));
  return `hsl(${hue}, 100%, 55%)`;
}

// ─── Pulse animation ──────────────────────────────────────────────────────────
let pulseTimeout = null;
function triggerPulse(color) {
  pulseEl.style.borderColor = color;
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

// ─── Draw detection circles ───────────────────────────────────────────────────
function drawPredictions(predictions) {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!predictions.length) return;

  // The Roboflow response coords are relative to the capture canvas (CAPTURE_W x CAPTURE_H).
  // Scale them to the overlay's actual display size.
  const scaleX = overlay.width / CAPTURE_W;
  const scaleY = overlay.height / CAPTURE_H;

  for (const p of predictions) {
    if (p.confidence < threshold) continue;

    const color = confidenceColor(p.confidence);
    const cx = p.x * scaleX;
    const cy = p.y * scaleY;
    const radius = (p.width * scaleX + p.height * scaleY) / 4;

    // Circle
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Confidence label centered below the circle
    const label = `${Math.round(p.confidence * 100)}%`;
    ctx.font = BOX_FONT;
    const textW = ctx.measureText(label).width;
    const labelH = 20;
    const lx = cx - textW / 2 - 5;
    const ly = cy + radius + 6;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(lx, ly, textW + 10, labelH);
    ctx.fillStyle = color;
    ctx.fillText(label, lx + 5, ly + 14);
  }
}

// ─── Render loop (RAF) ────────────────────────────────────────────────────────
function renderLoop() {
  drawPredictions(lastPredictions);
  animFrameId = requestAnimationFrame(renderLoop);
}

// ─── Scan toggle ──────────────────────────────────────────────────────────────
function toggleScanning() {
  scanning = !scanning;
  if (scanning) {
    toggleBtn.textContent = 'Pause';
    toggleBtn.classList.remove('paused');
    statusEl.textContent = 'Scanning…';
    statusEl.className = '';
  } else {
    toggleBtn.textContent = 'Resume';
    toggleBtn.classList.add('paused');
    statusEl.textContent = 'Paused';
    statusEl.className = '';
    lastPredictions = [];
    ctx.clearRect(0, 0, overlay.width, overlay.height);
  }
}

toggleBtn.addEventListener('click', toggleScanning);

// ─── Roboflow inference ───────────────────────────────────────────────────────
async function runInference() {
  if (!scanning || inferring || video.readyState < 2) return;
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
      const topColor = confidenceColor(Math.max(...preds.map(p => p.confidence)));
      triggerPulse(topColor);
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
    toggleBtn.disabled = false;
    renderLoop();
    inferenceInterval = setInterval(runInference, INTERVAL_MS);
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
