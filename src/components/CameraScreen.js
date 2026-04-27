import { runWithRefinement } from '../services/roboflow.js';
import { beep, initAudio } from '../utils/audio.js';
import { destinationPoint, ballDistanceMeters, focalLengthPx } from '../utils/geo.js';
import { session } from '../services/session.js';

const BOX_FONT = 'bold 13px -apple-system, sans-serif';

export class CameraScreen {
  constructor(el) {
    this.el = el;
    this.stream = null;
    this.track = null;
    this.imageCapture = null;
    this.threshold = 0.70;
    this.ballColor = 'white';
    this.currentZoom = 1;
    this.sweepMode = false;
    this.processing = false;
    this._overlayCtx = null;
    this._overlayRaf = null;
    this._lastPreds = [];
    this._video = null;
    // Callbacks set by main.js
    this.onClose = null;
    this.onDetection = null;   // (lat, lng, confidence, shotId)
    this.getGpsContext = null; // () => { lat, lng, heading, accuracy }
    this.getActiveShot = null; // () => shot | null
  }

  start() {
    this._render();
    this._bindUI();
    this._initCamera();
  }

  stop() {
    cancelAnimationFrame(this._overlayRaf);
    this._overlayRaf = null;
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
      this.track = null;
      this.imageCapture = null;
    }
    this.el.innerHTML = '';
    this._lastPreds = [];
  }

  // ── DOM ───────────────────────────────────────────────────────────────
  _render() {
    this.el.innerHTML = `
      <div class="camera-header">
        <button class="back-btn" id="cam-back">&#x2190; Map</button>
        <div class="phase-label">Phase 2 &middot; Smart Camera</div>
        <div class="conf-row">
          <label>Min: <span class="conf-val" id="conf-val">70%</span></label>
          <input class="conf-slider" id="conf-slider" type="range"
                 min="0" max="1" step="0.01" value="0.70" />
        </div>
      </div>

      <div class="camera-viewport">
        <video id="cam-video" autoplay playsinline muted></video>
        <canvas id="cam-overlay"></canvas>
        <div class="scan-status" id="scan-status">Camera starting&hellip;</div>
        <div class="range-hint">Best results within 15 yards &mdash; move closer if no detection</div>
        <div class="sweep-frames hidden" id="sweep-frames">
          <div class="sweep-frame-dot" id="sf0"></div>
          <div class="sweep-frame-dot" id="sf1"></div>
          <div class="sweep-frame-dot" id="sf2"></div>
        </div>
      </div>

      <div class="camera-controls">
        <div class="color-selector">
          <button class="color-btn active" data-color="white">&#x26AA; White</button>
          <button class="color-btn" data-color="yellow">&#x1F7E1; Yellow</button>
          <button class="color-btn" data-color="orange">&#x1F7E0; Orange</button>
        </div>
        <div class="zoom-controls" id="zoom-controls">
          <button class="zoom-btn active" data-zoom="1">1&times;</button>
          <button class="zoom-btn" data-zoom="2">2&times;</button>
          <button class="zoom-btn" data-zoom="3">3&times;</button>
          <button class="zoom-btn" data-zoom="5">5&times;</button>
        </div>
        <div class="capture-row">
          <button class="sweep-toggle" id="sweep-toggle">Sweep: OFF</button>
          <button class="capture-btn" id="capture-btn" disabled>&#x1F4F8; Capture</button>
        </div>
      </div>

      <div class="perm-overlay hidden" id="cam-perm">
        <p>Ball Hawk needs camera access to scan for golf balls.</p>
        <button class="perm-btn" id="cam-perm-btn">Enable Camera</button>
        <p class="err-msg hidden" id="cam-err"></p>
      </div>
    `;

    this._video = document.getElementById('cam-video');
    const overlay = document.getElementById('cam-overlay');
    this._overlayCtx = overlay.getContext('2d');
    new ResizeObserver(() => {
      overlay.width  = overlay.offsetWidth;
      overlay.height = overlay.offsetHeight;
    }).observe(overlay);
  }

  // ── UI binding ───────────────────────────────────────────────────────
  _bindUI() {
    this.el.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.id === 'cam-back')     { this.onClose?.(); return; }
      if (btn.id === 'capture-btn'   && !this.processing) this._capture();
      if (btn.id === 'sweep-toggle') this._toggleSweep();
      if (btn.id === 'cam-perm-btn') this._initCamera();

      if (btn.classList.contains('color-btn')) {
        this.ballColor = btn.dataset.color;
        this.el.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      }
      if (btn.classList.contains('zoom-btn')) {
        const z = parseFloat(btn.dataset.zoom);
        this._setZoom(z);
        this.el.querySelectorAll('.zoom-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      }
    });

    this.el.addEventListener('input', e => {
      if (e.target.id === 'conf-slider') {
        this.threshold = parseFloat(e.target.value);
        const v = document.getElementById('conf-val');
        if (v) v.textContent = `${Math.round(this.threshold * 100)}%`;
      }
    });
  }

  // ── Camera init ───────────────────────────────────────────────────────
  async _initCamera() {
    const perm = document.getElementById('cam-perm');
    const err  = document.getElementById('cam-err');
    perm?.classList.add('hidden');

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width:  { ideal: 4032 }, // 48 MP on iPhone 15 Pro
          height: { ideal: 3024 },
        },
        audio: false,
      });

      this._video.srcObject = this.stream;
      await this._video.play();

      this.track = this.stream.getVideoTracks()[0];
      if (typeof ImageCapture !== 'undefined') {
        this.imageCapture = new ImageCapture(this.track);
      }

      // Rebuild zoom buttons based on device capabilities
      const caps = this.track.getCapabilities?.();
      if (caps?.zoom) this._buildZoomBtns(caps.zoom);

      const captureBtn = document.getElementById('capture-btn');
      if (captureBtn) captureBtn.disabled = false;
      const status = document.getElementById('scan-status');
      if (status) status.textContent = 'Ready — tap Capture';

      this._startOverlayLoop();
      initAudio();
    } catch (e) {
      perm?.classList.remove('hidden');
      if (err) {
        err.classList.remove('hidden');
        err.textContent = e.name === 'NotAllowedError'
          ? 'Camera permission denied. Please allow access in Settings.'
          : `Camera error: ${e.message}`;
      }
    }
  }

  _buildZoomBtns(zoomCap) {
    const container = document.getElementById('zoom-controls');
    if (!container) return;
    const available = [1, 2, 3, 5].filter(z => z >= zoomCap.min && z <= zoomCap.max);
    if (available.length < 2) return;
    container.innerHTML = available
      .map((z, i) => `<button class="zoom-btn${i === 0 ? ' active' : ''}" data-zoom="${z}">${z}&times;</button>`)
      .join('');
  }

  async _setZoom(zoom) {
    this.currentZoom = zoom;
    if (!this.track) return;
    try {
      await this.track.applyConstraints({ advanced: [{ zoom }] });
    } catch (_) {}
  }

  _toggleSweep() {
    this.sweepMode = !this.sweepMode;
    const btn    = document.getElementById('sweep-toggle');
    const frames = document.getElementById('sweep-frames');
    if (btn) {
      btn.textContent = `Sweep: ${this.sweepMode ? 'ON' : 'OFF'}`;
      btn.classList.toggle('active', this.sweepMode);
    }
    frames?.classList.toggle('hidden', !this.sweepMode);
  }

  // ── Capture entry point ───────────────────────────────────────────────
  async _capture() {
    if (this.processing) return;
    this.processing = true;
    const captureBtn = document.getElementById('capture-btn');
    if (captureBtn) captureBtn.disabled = true;
    try {
      if (this.sweepMode) await this._sweepCapture();
      else                await this._singleCapture();
    } catch (e) {
      console.error('Capture error:', e);
      const status = document.getElementById('scan-status');
      if (status) { status.textContent = 'Error — try again'; status.className = 'scan-status error'; }
    } finally {
      this.processing = false;
      if (captureBtn) captureBtn.disabled = false;
    }
  }

  // ── Single capture ─────────────────────────────────────────────────────
  async _singleCapture() {
    const status = document.getElementById('scan-status');
    if (status) { status.textContent = 'Processing…'; status.className = 'scan-status processing'; }

    const canvas = await this._grabFrame();
    const result = await runWithRefinement(canvas, this.threshold, this.ballColor);

    if (result.predictions.length > 0) {
      const best = result.predictions[0];
      this._lastPreds = result.predictions;
      this._dropMapPin(best, result.captureWidth, result.captureHeight);
      beep();
      if (status) {
        const passStr = result.passes > 1 ? ` (${result.passes} passes)` : '';
        status.textContent = `${Math.round(best.confidence * 100)}% confidence${passStr}`;
        status.className = 'scan-status detecting';
      }
    } else {
      this._lastPreds = [];
      if (status) { status.textContent = 'No ball detected'; status.className = 'scan-status'; }
    }
  }

  // ── Sweep mode (3 sequential stills) ──────────────────────────────
  async _sweepCapture() {
    const status = document.getElementById('scan-status');
    const dots   = [0, 1, 2].map(i => document.getElementById(`sf${i}`));
    const allPreds = [];

    for (let i = 0; i < 3; i++) {
      if (dots[i]) dots[i].className = 'sweep-frame-dot processing';
      if (status)  { status.textContent = `Sweep ${i + 1}/3…`; status.className = 'scan-status processing'; }

      const canvas = await this._grabFrame();
      const result = await runWithRefinement(canvas, this.threshold, this.ballColor);
      if (dots[i]) dots[i].className = 'sweep-frame-dot captured';

      if (result.predictions.length > 0) {
        const best    = result.predictions[0];
        const pinData = this._calcBallPosition(best, result.captureWidth, result.captureHeight);
        if (pinData) allPreds.push({ ...best, ...pinData });
      }

      if (i < 2) await new Promise(r => setTimeout(r, 500));
    }

    // Reset sweep dots
    dots.forEach(d => { if (d) d.className = 'sweep-frame-dot'; });

    if (allPreds.length === 0) {
      if (status) { status.textContent = 'No ball detected'; status.className = 'scan-status'; }
      return;
    }

    // Merge nearby detections; 2+ overlapping → confidence boost
    const merged = session.mergeNearby(allPreds);
    for (const det of merged) {
      if (det.lat != null && det.lng != null) {
        const shotId = this.getActiveShot?.()?.id ?? null;
        this.onDetection?.(det.lat, det.lng, det.confidence, shotId);
        beep();
      }
    }

    if (status) {
      status.textContent = `${merged.length} detection${merged.length !== 1 ? 's' : ''} mapped`;
      status.className = 'scan-status detecting';
    }
  }

  // ── Frame grab ──────────────────────────────────────────────────────────
  async _grabFrame() {
    // Prefer ImageCapture.grabFrame() for full sensor resolution
    if (this.imageCapture) {
      try {
        const bitmap = await this.imageCapture.grabFrame();
        const c = document.createElement('canvas');
        c.width = bitmap.width; c.height = bitmap.height;
        c.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close?.();
        return c;
      } catch (_) {}
    }
    // Fallback: snapshot from video element
    const c = document.createElement('canvas');
    c.width  = this._video.videoWidth  || 640;
    c.height = this._video.videoHeight || 480;
    c.getContext('2d').drawImage(this._video, 0, 0);
    return c;
  }

  // ── Ball GPS position calculation ────────────────────────────────────
  _calcBallPosition(pred, capW, capH) {
    const gpsCtx = this.getGpsContext?.();
    if (!gpsCtx?.lat || gpsCtx.heading == null) return null;

    const bboxDiam = (pred.width + pred.height) / 2;
    if (bboxDiam < 1) return null;

    const focal   = focalLengthPx(capW, this.currentZoom);
    const distM   = ballDistanceMeters(focal, bboxDiam);

    // Sanity check: golf ball should be 1–80 m away when detectable
    if (distM < 1 || distM > 80) return null;

    return destinationPoint(gpsCtx.lat, gpsCtx.lng, gpsCtx.heading, distM);
  }

  _dropMapPin(pred, capW, capH) {
    const pos = this._calcBallPosition(pred, capW, capH);
    if (pos) {
      const shotId = this.getActiveShot?.()?.id ?? null;
      this.onDetection?.(pos.lat, pos.lng, pred.confidence, shotId);
    }
  }

  // ── Overlay render loop ───────────────────────────────────────────────
  _startOverlayLoop() {
    const loop = () => {
      if (this._overlayCtx) this._drawOverlay();
      this._overlayRaf = requestAnimationFrame(loop);
    };
    loop();
  }

  _drawOverlay() {
    const canvas = document.getElementById('cam-overlay');
    if (!canvas) return;
    const ctx = this._overlayCtx;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!this._lastPreds.length) return;

    const vw = this._video.videoWidth  || 640;
    const vh = this._video.videoHeight || 480;
    const sx = canvas.width  / vw;
    const sy = canvas.height / vh;

    for (const p of this._lastPreds) {
      if (p.confidence < this.threshold) continue;
      const t     = Math.min(1, (p.confidence - this.threshold) / (1 - this.threshold));
      const hue   = Math.round(240 * (1 - t)); // blue → red as confidence rises
      const color = `hsl(${hue},100%,55%)`;
      const cx    = p.x * sx;
      const cy    = p.y * sy;
      const r     = (p.width * sx + p.height * sy) / 4;

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth   = 2.5;
      ctx.shadowColor = color;
      ctx.shadowBlur  = 8;
      ctx.stroke();
      ctx.shadowBlur  = 0;

      const label = `${Math.round(p.confidence * 100)}%`;
      ctx.font = BOX_FONT;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(cx - tw / 2 - 5, cy + r + 4, tw + 10, 20);
      ctx.fillStyle = color;
      ctx.fillText(label, cx - tw / 2, cy + r + 18);
    }
  }
}
