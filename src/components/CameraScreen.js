import { runWithRefinement } from '../services/roboflow.js';
import { beep, initAudio } from '../utils/audio.js';

const BOX_FONT = 'bold 13px -apple-system, sans-serif';

export class CameraScreen {
  constructor(el) {
    this.el = el;
    this.stream = null;
    this.track = null;
    this.imageCapture = null;
    this.threshold = 0.70;
    this.currentZoom = 1;
    this.processing = false;
    this._overlayCtx = null;
    this._overlayRaf = null;
    this._lastPreds = [];
    this._video = null;
    // Callbacks set by main.js
    this.onClose = null;
    this.onFound = null;        // (shotId, confidence) → void
    this.getActiveShot = null;  // () => shot | null
    this._reviewData = null;   // { shotId, confidence } stored during review
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
      </div>

      <div class="camera-controls">
        <div class="zoom-controls" id="zoom-controls">
          <button class="zoom-btn active" data-zoom="1">1&times;</button>
          <button class="zoom-btn" data-zoom="2">2&times;</button>
          <button class="zoom-btn" data-zoom="3">3&times;</button>
          <button class="zoom-btn" data-zoom="5">5&times;</button>
        </div>
        <div class="capture-row">
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
      if (btn.id === 'cam-perm-btn') this._initCamera();
      if (btn.id === 'review-found') this._confirmFound();
      if (btn.id === 'review-keep')  this._dismissReview();

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

  // ── Capture entry point ───────────────────────────────────────────────
  async _capture() {
    if (this.processing) return;
    this.processing = true;
    const captureBtn = document.getElementById('capture-btn');
    if (captureBtn) captureBtn.disabled = true;
    try {
      await this._singleCapture();
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
    const result = await runWithRefinement(canvas, this.threshold);

    if (result.predictions.length > 0) {
      const best   = result.predictions[0];
      const shotId = this.getActiveShot?.()?.id ?? null;
      this._lastPreds = result.predictions;
      this._showReview(canvas, best, result.captureWidth, result.captureHeight, best.confidence, shotId);
    } else {
      this._lastPreds = [];
      if (status) { status.textContent = 'No ball detected'; status.className = 'scan-status'; }
    }
  }

  // ── Review overlay ────────────────────────────────────────────────────
  _showReview(rawFrame, pred, capW, capH, confidence, shotId) {
    this._reviewData = { shotId, confidence };

    // Pause live overlay while review is visible
    cancelAnimationFrame(this._overlayRaf);
    this._overlayRaf = null;

    const viewport = this.el.querySelector('.camera-viewport');
    const div = document.createElement('div');
    div.className = 'review-overlay';
    div.id = 'review-overlay';
    div.innerHTML = `
      <canvas id="review-canvas"></canvas>
      <div class="review-actions">
        <button class="review-keep-btn" id="review-keep">Keep looking</button>
        <button class="review-found-btn" id="review-found">&#x2713; Found it</button>
      </div>
    `;
    viewport.appendChild(div);

    const canvas = document.getElementById('review-canvas');
    canvas.width  = viewport.offsetWidth;
    canvas.height = viewport.offsetHeight;
    const ctx = canvas.getContext('2d');

    // Draw captured frame scaled to fill the canvas
    ctx.drawImage(rawFrame, 0, 0, canvas.width, canvas.height);

    // Scale bounding circle from inference space to canvas display space
    const W  = canvas.width;
    const H  = canvas.height;
    const cx = (pred.x / capW) * W;
    const cy = (pred.y / capH) * H;
    const r  = ((pred.width / capW) + (pred.height / capH)) / 4 * Math.min(W, H);

    const t     = Math.min(1, (confidence - this.threshold) / (1 - this.threshold));
    const hue   = Math.round(240 * (1 - t));
    const color = `hsl(${hue},100%,55%)`;

    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(r, 12), 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth   = 3;
    ctx.shadowColor = color;
    ctx.shadowBlur  = 14;
    ctx.stroke();
    ctx.shadowBlur  = 0;

    const label = `${Math.round(confidence * 100)}%`;
    ctx.font = 'bold 14px -apple-system, sans-serif';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(cx - tw / 2 - 6, cy + r + 6, tw + 12, 22);
    ctx.fillStyle = color;
    ctx.fillText(label, cx - tw / 2, cy + r + 22);

    beep();
  }

  _confirmFound() {
    if (!this._reviewData) return;
    const { shotId, confidence } = this._reviewData;
    this._reviewData = null;
    this._removeReviewOverlay();
    this.onFound?.(shotId, confidence);
  }

  _dismissReview() {
    this._reviewData = null;
    this._lastPreds  = [];
    this._removeReviewOverlay();
    this._startOverlayLoop();
    const status = document.getElementById('scan-status');
    if (status) { status.textContent = 'Ready — tap Capture'; status.className = 'scan-status'; }
  }

  _removeReviewOverlay() {
    document.getElementById('review-overlay')?.remove();
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
