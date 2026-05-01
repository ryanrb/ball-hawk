import { runWithRefinement } from '../services/roboflow.js';
import { beep, initAudio } from '../utils/audio.js';

const INFER_W      = 640;
const INFER_H      = 480;
const PIP_CANVAS_W = 200;
const PIP_CANVAS_H = 112;

function predCenterFullPixels(pred, capW, capH, cropRect, fw, fh) {
  if (!cropRect) {
    return { sx: (pred.x / capW) * fw, sy: (pred.y / capH) * fh };
  }
  return {
    sx: cropRect.x + (pred.x / capW) * cropRect.w,
    sy: cropRect.y + (pred.y / capH) * cropRect.h,
  };
}

function predRadiusFullPixels(pred, capW, capH, cropRect, fw, fh) {
  const rw = cropRect ? cropRect.w : fw;
  const rh = cropRect ? cropRect.h : fh;
  const rNorm = ((pred.width / capW) + (pred.height / capH)) / 4 * 1.35;
  return rNorm * Math.min(rw, rh);
}

export class CameraScreen {
  constructor(el) {
    this.el = el;
    this.stream = null;
    this.track = null;
    this.imageCapture = null;
    this.threshold = 0.5;
    this.currentZoom = 1;
    this.processing = false;
    this._overlayCtx = null;
    this._overlayRaf = null;
    this._lastPreds = [];
    this._video = null;
    this.onClose = null;
    this.onFound = null;
    this.getActiveShot = null;
    this._reviewData = null;
    this._orientationHandler = null;

    this._mainView      = 'live';
    this._hasLastHit    = false;
    this._lastHitCanvas = null;
    this._lastPred      = null;
    this._captureDims   = { capW: INFER_W, capH: INFER_H };
    this._cropRect      = null;
    this._reviewCanvas  = null;
    this._reviewCtx     = null;
    this._pipHitCanvas  = null;
    this._pipHitCtx     = null;
    this._pipLiveCanvas = null;
    this._pipLiveCtx    = null;
    this._liveStage     = null;
    this._reviewResizeObs = null;
  }

  start() {
    this._render();
    this._bindUI();
    this._initCamera();
    this._orientationHandler = () => this._checkOrientation();
    window.addEventListener('resize', this._orientationHandler);
    this._checkOrientation();
  }

  stop() {
    cancelAnimationFrame(this._overlayRaf);
    this._overlayRaf = null;
    if (this._reviewResizeObs) {
      this._reviewResizeObs.disconnect();
      this._reviewResizeObs = null;
    }
    window.removeEventListener('resize', this._orientationHandler);
    this._orientationHandler = null;
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
      this.track = null;
      this.imageCapture = null;
    }
    this.el.innerHTML = '';
    this._lastPreds = [];
    this._mainView = 'live';
    this._hasLastHit = false;
    this._lastHitCanvas = null;
    this._lastPred = null;
    this._cropRect = null;
  }

  _render() {
    this.el.innerHTML = `
      <div class="camera-header">
        <button class="back-btn" id="cam-back">&#x2190; Map</button>
        <div class="phase-label">Phase 2 &middot; Smart Camera</div>
      </div>

      <div class="cam-viewport" id="cam-viewport">
        <div class="cam-live-stage" id="cam-live-stage">
          <video id="cam-video" autoplay playsinline muted></video>
          <canvas id="cam-overlay"></canvas>
          <div class="scan-status" id="scan-status">Camera starting&hellip;</div>
          <div class="portrait-warning hidden" id="portrait-warning">
            &#x1F504; Rotate to landscape for best detection
          </div>

          <div class="camera-controls">
            <div class="zoom-controls" id="zoom-controls">
              <button class="zoom-btn active" data-zoom="1">1&times;</button>
              <button class="zoom-btn" data-zoom="2">2&times;</button>
              <button class="zoom-btn" data-zoom="3">3&times;</button>
              <button class="zoom-btn" data-zoom="5">5&times;</button>
            </div>
            <div class="shutter-row">
              <button class="shutter-btn" id="capture-btn" disabled>
                <span class="shutter-inner"></span>
              </button>
            </div>
          </div>
        </div>

        <div class="cam-review-stage hidden" id="cam-review-stage">
          <canvas id="cam-review-canvas"></canvas>
          <div class="cam-review-bar">
            <button type="button" class="cam-found-btn" id="review-found">&#x2713;&nbsp;Found it</button>
          </div>
        </div>

        <button type="button" class="cam-pip cam-pip-hit hidden" id="cam-pip-hit" aria-label="View detection fullscreen">
          <canvas id="cam-pip-hit-canvas" width="${PIP_CANVAS_W}" height="${PIP_CANVAS_H}"></canvas>
        </button>
        <button type="button" class="cam-pip cam-pip-live hidden" id="cam-pip-live" aria-label="Back to live camera">
          <canvas id="cam-pip-live-canvas" width="${PIP_CANVAS_W}" height="${PIP_CANVAS_H}"></canvas>
        </button>
      </div>

      <div class="perm-overlay hidden" id="cam-perm">
        <p>Ball Hawk needs camera access to scan for golf balls.</p>
        <button class="perm-btn" id="cam-perm-btn">Enable Camera</button>
        <p class="err-msg hidden" id="cam-err"></p>
      </div>
    `;

    this._video = document.getElementById('cam-video');
    this._liveStage = document.getElementById('cam-live-stage');
    const overlay = document.getElementById('cam-overlay');
    this._overlayCtx = overlay.getContext('2d');
    new ResizeObserver(() => {
      overlay.width  = overlay.offsetWidth;
      overlay.height = overlay.offsetHeight;
    }).observe(overlay);

    this._reviewCanvas = document.getElementById('cam-review-canvas');
    this._reviewCtx = this._reviewCanvas.getContext('2d');
    this._pipHitCanvas = document.getElementById('cam-pip-hit-canvas');
    this._pipHitCtx = this._pipHitCanvas.getContext('2d');
    this._pipLiveCanvas = document.getElementById('cam-pip-live-canvas');
    this._pipLiveCtx = this._pipLiveCanvas.getContext('2d');

    const reviewStage = document.getElementById('cam-review-stage');
    this._reviewResizeObs = new ResizeObserver(() => {
      if (this._mainView === 'review') this._layoutReviewCanvas();
    });
    this._reviewResizeObs.observe(reviewStage);
  }

  _bindUI() {
    this.el.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.id === 'cam-back')     { this.onClose?.(); return; }
      if (btn.id === 'capture-btn'   && !this.processing) this._capture();
      if (btn.id === 'cam-perm-btn') this._initCamera();
      if (btn.id === 'review-found') this._confirmFound();
      if (btn.id === 'cam-pip-hit')  { if (this._hasLastHit) this._setMainView('review'); return; }
      if (btn.id === 'cam-pip-live') { this._setMainView('live'); return; }

      if (btn.classList.contains('zoom-btn')) {
        const z = parseFloat(btn.dataset.zoom);
        this._setZoom(z);
        this.el.querySelectorAll('.zoom-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      }
    });
  }

  async _initCamera() {
    const perm = document.getElementById('cam-perm');
    const err  = document.getElementById('cam-err');
    perm?.classList.add('hidden');

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width:  { ideal: 4032 },
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

      const caps = this.track.getCapabilities?.();
      if (caps?.zoom) {
        this._buildZoomBtns(caps.zoom);
        if (caps.zoom.max >= 2) {
          await this._setZoom(2);
          this.el.querySelectorAll('.zoom-btn').forEach(b => {
            b.classList.toggle('active', parseFloat(b.dataset.zoom) === 2);
          });
        }
      }

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

  _checkOrientation() {
    const portrait = window.innerHeight > window.innerWidth;
    document.getElementById('portrait-warning')?.classList.toggle('hidden', !portrait);
    const btn = document.getElementById('capture-btn');
    if (btn && !this.processing) btn.disabled = portrait;
  }

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

  async _singleCapture() {
    const status = document.getElementById('scan-status');
    if (status) { status.textContent = 'Processing…'; status.className = 'scan-status processing'; }

    const canvas = await this._grabFrame();
    const result = await runWithRefinement(canvas, this.threshold);

    if (result.predictions.length > 0) {
      const best   = result.predictions[0];
      const shotId = this.getActiveShot?.()?.id ?? null;
      this._lastPreds = result.predictions;
      this._reviewData = { shotId, confidence: best.confidence };
      this._captureDims = { capW: result.captureWidth, capH: result.captureHeight };
      this._cropRect = result.cropRect;
      this._lastPred = best;

      this._captureLastHit(canvas);
      this._hasLastHit = true;
      document.getElementById('cam-pip-hit')?.classList.remove('hidden');
      this._drawHitPip();

      if (status) {
        status.textContent = 'Ball spotted — tap preview or capture again';
        status.className = 'scan-status detecting';
      }
      beep();
    } else {
      this._lastPreds = [];
      this._clearHitState();
      if (status) { status.textContent = 'No ball detected'; status.className = 'scan-status'; }
    }
  }

  _captureLastHit(frame) {
    if (!this._lastHitCanvas
        || this._lastHitCanvas.width !== frame.width
        || this._lastHitCanvas.height !== frame.height) {
      this._lastHitCanvas = document.createElement('canvas');
      this._lastHitCanvas.width  = frame.width;
      this._lastHitCanvas.height = frame.height;
    }
    this._lastHitCanvas.getContext('2d').drawImage(frame, 0, 0);
  }

  _clearHitState() {
    this._hasLastHit = false;
    this._lastPred = null;
    this._cropRect = null;
    this._reviewData = null;
    document.getElementById('cam-pip-hit')?.classList.add('hidden');
    document.getElementById('cam-pip-live')?.classList.add('hidden');
  }

  _strokeHitCircle(ctx, cx, cy, r) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth   = Math.max(2, Math.min(ctx.canvas.width, ctx.canvas.height) * 0.006);
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur  = 6;
    ctx.stroke();
    ctx.shadowBlur  = 0;
  }

  /** Full-screen review: letterboxed crop region with dimmed bars (matches prior UX). */
  _drawReviewLetterboxed(ctx, destW, destH) {
    const rawFrame = this._lastHitCanvas;
    const pred = this._lastPred;
    if (!rawFrame || !pred) return;
    const { capW, capH } = this._captureDims;
    const cropRect = this._cropRect;

    const srcX = cropRect ? cropRect.x : 0;
    const srcY = cropRect ? cropRect.y : 0;
    const srcW = cropRect ? cropRect.w : rawFrame.width;
    const srcH = cropRect ? cropRect.h : rawFrame.height;

    const scale = Math.min(destW / srcW, destH / srcH);
    const drawW = srcW * scale;
    const drawH = srcH * scale;
    const drawX = (destW  - drawW) / 2;
    const drawY = (destH - drawH) / 2;

    ctx.globalAlpha = 0.35;
    ctx.drawImage(rawFrame, srcX, srcY, srcW, srcH, 0, 0, destW, destH);
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, destW, destH);
    ctx.drawImage(rawFrame, srcX, srcY, srcW, srcH, drawX, drawY, drawW, drawH);

    const W  = drawW;
    const H  = drawH;
    const cx = drawX + (pred.x / capW) * W;
    const cy = drawY + (pred.y / capH) * H;
    const r  = ((pred.width / capW) + (pred.height / capH)) / 4 * Math.min(W, H);
    const circleR = Math.max(r * 1.35, 22);

    ctx.beginPath();
    ctx.arc(cx, cy, circleR, 0, Math.PI * 2);
    ctx.strokeStyle = 'white';
    ctx.lineWidth   = 5;
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur  = 6;
    ctx.stroke();
    ctx.shadowBlur  = 0;

    const label = 'Ball found';
    ctx.font = 'bold 14px -apple-system, sans-serif';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(cx - tw / 2 - 8, cy + circleR + 6, tw + 16, 22);
    ctx.fillStyle = 'white';
    ctx.fillText(label, cx - tw / 2, cy + circleR + 22);
  }

  /** PiP thumbnail: cover-fit full frame + circle in image space. */
  _drawPipCover(ctx, destW, destH) {
    const img = this._lastHitCanvas;
    const pred = this._lastPred;
    if (!img || !pred) return;
    const W = img.width;
    const H = img.height;
    if (!W || !H) return;

    const { capW, capH } = this._captureDims;
    const cropRect = this._cropRect;
    const { sx, sy } = predCenterFullPixels(pred, capW, capH, cropRect, W, H);
    const rSrc = predRadiusFullPixels(pred, capW, capH, cropRect, W, H);

    const scale = Math.max(destW / W, destH / H);
    const dw = W * scale;
    const dh = H * scale;
    const dx = (destW - dw) / 2;
    const dy = (destH - dh) / 2;
    ctx.drawImage(img, 0, 0, W, H, dx, dy, dw, dh);

    const cx = dx + (sx / W) * dw;
    const cy = dy + (sy / H) * dh;
    const r  = rSrc * scale;
    this._strokeHitCircle(ctx, cx, cy, r);
  }

  _drawHitPip() {
    if (!this._pipHitCtx || !this._lastHitCanvas || !this._lastPred) return;
    const w = PIP_CANVAS_W;
    const h = PIP_CANVAS_H;
    const ctx = this._pipHitCtx;
    ctx.clearRect(0, 0, w, h);
    this._drawPipCover(ctx, w, h);
  }

  _drawLivePip() {
    if (!this._pipLiveCtx || !this._video || this._video.readyState < 2) return;
    const ctx = this._pipLiveCtx;
    const w = PIP_CANVAS_W;
    const h = PIP_CANVAS_H;
    ctx.clearRect(0, 0, w, h);
    const vw = this._video.videoWidth;
    const vh = this._video.videoHeight;
    if (!vw || !vh) return;
    ctx.drawImage(this._video, 0, 0, vw, vh, 0, 0, w, h);
  }

  _layoutReviewCanvas() {
    const canvas = this._reviewCanvas;
    if (!canvas) return;
    const rw = Math.max(1, Math.floor(canvas.clientWidth));
    const rh = Math.max(1, Math.floor(canvas.clientHeight));
    if (canvas.width !== rw || canvas.height !== rh) {
      canvas.width  = rw;
      canvas.height = rh;
    }
    if (!this._reviewCtx || !this._lastPred) return;
    this._reviewCtx.clearRect(0, 0, rw, rh);
    this._drawReviewLetterboxed(this._reviewCtx, rw, rh);
  }

  _setMainView(mode) {
    const vp = document.getElementById('cam-viewport');
    const reviewStage = document.getElementById('cam-review-stage');
    const pipHit = document.getElementById('cam-pip-hit');
    const pipLive = document.getElementById('cam-pip-live');

    if (mode === 'review') {
      this._mainView = 'review';
      vp?.classList.add('cam-viewport--review-main');
      this._liveStage?.classList.add('cam-live-stage--hidden');
      reviewStage?.classList.remove('hidden');
      pipHit?.classList.add('hidden');
      pipLive?.classList.remove('hidden');
      requestAnimationFrame(() => {
        this._layoutReviewCanvas();
        requestAnimationFrame(() => this._layoutReviewCanvas());
      });
    } else {
      this._mainView = 'live';
      vp?.classList.remove('cam-viewport--review-main');
      this._liveStage?.classList.remove('cam-live-stage--hidden');
      reviewStage?.classList.add('hidden');
      pipLive?.classList.add('hidden');
      if (this._hasLastHit) pipHit?.classList.remove('hidden');
      const status = document.getElementById('scan-status');
      if (status && this._hasLastHit) {
        status.textContent = 'Ball spotted — tap preview or capture again';
        status.className = 'scan-status detecting';
      }
    }
  }

  async _confirmFound() {
    if (!this._reviewData) return;
    const { shotId, confidence } = this._reviewData;
    this._reviewData = null;
    this._clearHitState();
    this._setMainView('live');
    let coords = null;
    try {
      coords = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
          p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
          reject,
          { enableHighAccuracy: true, timeout: 5000 }
        );
      });
    } catch (_) {}
    this.onFound?.(shotId, confidence, coords);
  }

  async _grabFrame() {
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
    const c = document.createElement('canvas');
    c.width  = this._video.videoWidth  || 640;
    c.height = this._video.videoHeight || 480;
    c.getContext('2d').drawImage(this._video, 0, 0);
    return c;
  }

  _startOverlayLoop() {
    const loop = () => {
      this._drawFrame();
      this._overlayRaf = requestAnimationFrame(loop);
    };
    loop();
  }

  _drawFrame() {
    if (this._mainView === 'review') {
      this._drawLivePip();
    }

    const canvas = document.getElementById('cam-overlay');
    if (!canvas || !this._overlayCtx) return;
    if (this._mainView !== 'live') return;

    const ctx = this._overlayCtx;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!this._lastPreds.length) return;

    const vw = this._video.videoWidth  || 640;
    const vh = this._video.videoHeight || 480;
    const sx = canvas.width  / vw;
    const sy = canvas.height / vh;

    for (const p of this._lastPreds) {
      if (p.confidence < this.threshold) continue;
      const cx = p.x * sx;
      const cy = p.y * sy;
      const r  = Math.max((p.width * sx + p.height * sy) / 4 * 1.35, 18);

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'white';
      ctx.lineWidth   = 4;
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur  = 6;
      ctx.stroke();
      ctx.shadowBlur  = 0;
    }
  }
}
