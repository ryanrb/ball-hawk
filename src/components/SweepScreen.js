import { inferFast } from '../services/roboflow.js';
import { beep, initAudio } from '../utils/audio.js';

const INFER_W               = 640;
const INFER_H               = 480;
const SCAN_INTERVAL_MS      = 1500;
const DETECT_THRESHOLD      = 0.4;   // minimum confidence to register
const PIP_CANVAS_W          = 200;
const PIP_CANVAS_H          = 112;

/** Map infer-space pred to display canvas (same linear stretch as inferFast). */
function _predCenterOnCanvas(pred, cw, ch) {
  return {
    cx: (pred.x / INFER_W) * cw,
    cy: (pred.y / INFER_H) * ch,
  };
}

function _predRadiusOnCanvas(pred, cw, ch) {
  return Math.max(
    ((pred.width / INFER_W) * cw + (pred.height / INFER_H) * ch) / 4 * 1.35,
    Math.min(cw, ch) * 0.02
  );
}

/** Infer-space box → source pixel center (same linear map as inferFast stretch). */
function _predCenterInSource(pred, sw, sh) {
  return {
    sx: (pred.x / INFER_W) * sw,
    sy: (pred.y / INFER_H) * sh,
  };
}

function _predRadiusInSource(pred, sw, sh) {
  return Math.max(
    ((pred.width / INFER_W) * sw + (pred.height / INFER_H) * sh) / 4 * 1.35,
    Math.min(sw, sh) * 0.02
  );
}

export class SweepScreen {
  constructor(el) {
    this.el = el;
    this._stream        = null;
    this._track         = null;
    this._imageCapture  = null;
    this._video         = null;
    this._liveStage     = null;
    this._overlayCanvas = null;
    this._overlayCtx    = null;
    this._reviewCanvas   = null;
    this._reviewCtx      = null;
    this._pipHitCanvas   = null;
    this._pipHitCtx      = null;
    this._pipLiveCanvas  = null;
    this._pipLiveCtx     = null;
    this._lastHitCanvas   = null;
    this._rafId         = null;
    this._scanTimer     = null;
    this._inferring     = false;
    this._ripples       = [];
    this._lastPred      = null;
    this._state         = 'idle';
    this._mainView      = 'live'; // 'live' | 'review'
    this._hasLastHit    = false;
    this._orientationHandler = null;
    this._reviewResizeObs = null;
    this.onClose       = null;
    this.onFound       = null;
    this.getActiveShot = null;
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
    this._stopSweep();
    this._stopRAF();
    if (this._reviewResizeObs) {
      this._reviewResizeObs.disconnect();
      this._reviewResizeObs = null;
    }
    window.removeEventListener('resize', this._orientationHandler);
    this._orientationHandler = null;
    if (this._stream) {
      this._stream.getTracks().forEach(t => t.stop());
      this._stream       = null;
      this._track        = null;
      this._imageCapture = null;
    }
    this.el.innerHTML      = '';
    this._ripples          = [];
    this._state            = 'idle';
    this._mainView         = 'live';
    this._hasLastHit       = false;
    this._lastPred         = null;
    this._lastHitCanvas    = null;
    this._inferring        = false;
    this._liveStage        = null;
    this._overlayCanvas    = null;
    this._reviewCanvas     = null;
    this._pipHitCanvas     = null;
    this._pipLiveCanvas    = null;
  }

  _render() {
    this.el.innerHTML = `
      <div class="sweep-viewport" id="sweep-viewport">
        <div class="sweep-live-stage" id="sweep-live-stage">
          <video id="sweep-video" autoplay playsinline muted></video>
          <canvas id="sweep-overlay"></canvas>
          <div class="sweep-scanline"></div>
        </div>

        <div class="sweep-review-stage hidden" id="sweep-review-stage">
          <canvas id="sweep-review-canvas"></canvas>
          <div class="sweep-review-bar">
            <button type="button" class="sweep-found-btn" id="sweep-found-btn">&#x2713;&nbsp;Found It!</button>
          </div>
        </div>

        <button type="button" class="sweep-pip sweep-pip-hit hidden" id="sweep-pip-hit" aria-label="View last detection fullscreen">
          <canvas id="sweep-pip-hit-canvas" width="${PIP_CANVAS_W}" height="${PIP_CANVAS_H}"></canvas>
        </button>
        <button type="button" class="sweep-pip sweep-pip-live hidden" id="sweep-pip-live" aria-label="Back to live camera">
          <canvas id="sweep-pip-live-canvas" width="${PIP_CANVAS_W}" height="${PIP_CANVAS_H}"></canvas>
        </button>

        <div class="sweep-header">
          <button class="sweep-back-btn" id="sweep-back">&#x2190; Map</button>
          <div class="sweep-title">Live Sweep</div>
          <div class="sweep-badge scanning" id="sweep-badge">
            <span class="sweep-badge-dot"></span>
            <span class="sweep-badge-text" id="sweep-badge-text">SCANNING</span>
          </div>
        </div>

        <div class="portrait-warning hidden" id="sweep-portrait-warning">
          &#x1F504; Rotate to landscape to sweep
        </div>

        <div class="perm-overlay hidden" id="sweep-perm">
          <p>Ball Hawk needs camera access to perform a live sweep.</p>
          <button class="perm-btn" id="sweep-perm-btn">Enable Camera</button>
          <p class="err-msg hidden" id="sweep-err"></p>
        </div>
      </div>
    `;

    this._video         = document.getElementById('sweep-video');
    this._liveStage    = document.getElementById('sweep-live-stage');
    this._overlayCanvas = document.getElementById('sweep-overlay');
    this._overlayCtx    = this._overlayCanvas.getContext('2d');
    this._reviewCanvas  = document.getElementById('sweep-review-canvas');
    this._reviewCtx     = this._reviewCanvas.getContext('2d');
    this._pipHitCanvas  = document.getElementById('sweep-pip-hit-canvas');
    this._pipHitCtx     = this._pipHitCanvas.getContext('2d');
    this._pipLiveCanvas = document.getElementById('sweep-pip-live-canvas');
    this._pipLiveCtx    = this._pipLiveCanvas.getContext('2d');

    new ResizeObserver(() => {
      this._overlayCanvas.width  = this._overlayCanvas.offsetWidth;
      this._overlayCanvas.height = this._overlayCanvas.offsetHeight;
    }).observe(this._overlayCanvas);

    const reviewStage = document.getElementById('sweep-review-stage');
    this._reviewResizeObs = new ResizeObserver(() => {
      if (this._mainView === 'review') this._layoutReviewCanvas();
    });
    this._reviewResizeObs.observe(reviewStage);
  }

  _bindUI() {
    this.el.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.id === 'sweep-back')         { this.onClose?.(); return; }
      if (btn.id === 'sweep-perm-btn')      { this._initCamera(); return; }
      if (btn.id === 'sweep-found-btn')     { this._confirmFound(); return; }
      if (btn.id === 'sweep-pip-hit')      { if (this._hasLastHit) this._setMainView('review'); return; }
      if (btn.id === 'sweep-pip-live')     { this._setMainView('live'); return; }
    });
  }

  async _initCamera() {
    const perm = document.getElementById('sweep-perm');
    const err  = document.getElementById('sweep-err');
    perm?.classList.add('hidden');

    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width:  { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });

      this._video.srcObject = this._stream;
      await this._video.play();

      this._track = this._stream.getVideoTracks()[0];
      if (typeof ImageCapture !== 'undefined') {
        this._imageCapture = new ImageCapture(this._track);
      }

      initAudio();
      this._startRAF();
      if (!(window.innerHeight > window.innerWidth)) {
        this._startSweep();
      }
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

  _checkOrientation() {
    const portrait = window.innerHeight > window.innerWidth;
    document.getElementById('sweep-portrait-warning')?.classList.toggle('hidden', !portrait);
    if (portrait) {
      this._stopSweep();
    } else if (this._stream && this._mainView === 'live') {
      this._startSweep();
    }
  }

  _startSweep() {
    if (this._scanTimer) return;
    if (this._mainView !== 'live') return;
    this._state = 'scanning';
    this._setStatus('SCANNING', 'scanning');
    this._doScan();
    this._scanTimer = setInterval(() => this._doScan(), SCAN_INTERVAL_MS);
  }

  _stopSweep() {
    if (this._scanTimer) {
      clearInterval(this._scanTimer);
      this._scanTimer = null;
    }
  }

  async _doScan() {
    if (this._inferring) return;
    if (this._mainView !== 'live') return;
    if (window.innerHeight > window.innerWidth) return;

    this._inferring = true;
    this._state     = 'inferring';
    this._setStatus('DETECTING\u2026', 'inferring');

    try {
      const frame = await this._grabFrame();
      const preds = await inferFast(frame);
      const best  = preds.find(p => p.confidence >= DETECT_THRESHOLD) ?? null;

      if (best) {
        this._onDetection(best, frame);
      } else {
        this._state = 'scanning';
        this._setStatus('SCANNING', 'scanning');
      }
    } catch (e) {
      console.error('[SweepScreen] Scan error:', e);
      this._state = 'scanning';
      this._setStatus('SCANNING', 'scanning');
    } finally {
      this._inferring = false;
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

  _onDetection(pred, frame) {
    const posX = pred.x / INFER_W;
    const posY = pred.y / INFER_H;

    this._lastPred = pred;

    this._captureLastHit(frame);
    this._hasLastHit = true;
    document.getElementById('sweep-pip-hit')?.classList.remove('hidden');

    const cx    = posX * this._overlayCanvas.width;
    const cy    = posY * this._overlayCanvas.height;
    const baseR = this._predRadius(pred);

    this._addRipples(cx, cy, baseR, pred.confidence);

    if (pred.confidence >= 0.6) beep();

    this._state = 'scanning';
    this._setStatus('BALL SPOTTED', 'detected');

    this._drawHitPip();
    if (this._mainView === 'review') {
      this._layoutReviewCanvas();
    }
  }

  _predRadius(pred) {
    const canvas = this._overlayCanvas;
    if (!canvas || canvas.width === 0) return 22;
    return _predRadiusOnCanvas(pred, canvas.width, canvas.height);
  }

  _addRipples(cx, cy, baseR, confidence) {
    const maxR      = baseR * 3.5;
    const now       = performance.now();
    const count     = confidence >= 0.6 ? 3 : 1;
    const baseAlpha = confidence >= 0.6 ? 1.0 : 0.45;
    for (let i = 0; i < count; i++) {
      this._ripples.push({
        cx, cy, baseR, maxR,
        startTime: now + i * 180,
        duration:  900,
        alpha:     baseAlpha,
      });
    }
  }

  /**
   * @param {object} pred
   * @param {boolean} cover  If true, uniform scale like CSS object-fit: cover (no squash).
   */
  _drawFrozenWithCircle(ctx, destW, destH, pred, cover = false) {
    const img = this._lastHitCanvas;
    if (!img || !pred) return;
    const W = img.width;
    const H = img.height;
    if (!W || !H) return;

    ctx.save();

    if (!cover) {
      ctx.drawImage(img, 0, 0, destW, destH);
      const { cx, cy } = _predCenterOnCanvas(pred, destW, destH);
      const r = _predRadiusOnCanvas(pred, destW, destH);
      this._strokeHitCircle(ctx, cx, cy, r, destW, destH);
      ctx.restore();
      return;
    }

    const scale = Math.max(destW / W, destH / H);
    const dw = W * scale;
    const dh = H * scale;
    const dx = (destW - dw) / 2;
    const dy = (destH - dh) / 2;
    ctx.drawImage(img, 0, 0, W, H, dx, dy, dw, dh);

    const { sx, sy } = _predCenterInSource(pred, W, H);
    const cx = dx + (sx / W) * dw;
    const cy = dy + (sy / H) * dh;
    const r  = _predRadiusInSource(pred, W, H) * scale;
    this._strokeHitCircle(ctx, cx, cy, r, destW, destH);
    ctx.restore();
  }

  _strokeHitCircle(ctx, cx, cy, r, destW, destH) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth   = Math.max(2, Math.min(destW, destH) * 0.006);
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur  = 6;
    ctx.stroke();
    ctx.shadowBlur  = 0;
  }

  _drawHitPip() {
    if (!this._pipHitCtx || !this._lastHitCanvas || !this._lastPred) return;
    const w = PIP_CANVAS_W;
    const h = PIP_CANVAS_H;
    const ctx = this._pipHitCtx;
    ctx.clearRect(0, 0, w, h);
    this._drawFrozenWithCircle(ctx, w, h, this._lastPred, true);
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
    this._drawReviewMain();
  }

  _drawReviewMain() {
    if (!this._reviewCtx || !this._lastPred) return;
    const ctx = this._reviewCtx;
    const rw = this._reviewCanvas.width;
    const rh = this._reviewCanvas.height;
    ctx.clearRect(0, 0, rw, rh);
    this._drawFrozenWithCircle(ctx, rw, rh, this._lastPred, true);
  }

  _setMainView(mode) {
    const vp = document.getElementById('sweep-viewport');
    const reviewStage = document.getElementById('sweep-review-stage');
    const pipHit = document.getElementById('sweep-pip-hit');
    const pipLive = document.getElementById('sweep-pip-live');

    if (mode === 'review') {
      this._mainView = 'review';
      this._stopSweep();
      this._ripples = [];
      vp?.classList.add('sweep-viewport--review-main');
      this._liveStage?.classList.add('sweep-live-stage--hidden');
      reviewStage?.classList.remove('hidden');
      pipHit?.classList.add('hidden');
      pipLive?.classList.remove('hidden');
      requestAnimationFrame(() => {
        this._layoutReviewCanvas();
        requestAnimationFrame(() => this._layoutReviewCanvas());
      });
    } else {
      this._mainView = 'live';
      vp?.classList.remove('sweep-viewport--review-main');
      this._liveStage?.classList.remove('sweep-live-stage--hidden');
      reviewStage?.classList.add('hidden');
      pipLive?.classList.add('hidden');
      if (this._hasLastHit) pipHit?.classList.remove('hidden');
      if (this._stream && !(window.innerHeight > window.innerWidth)) {
        this._startSweep();
      }
      this._setStatus('SCANNING', 'scanning');
    }
  }

  async _confirmFound() {
    const shotId = this.getActiveShot?.()?.id ?? null;
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
    this.onFound?.(shotId, coords);
  }

  async _grabFrame() {
    if (this._imageCapture) {
      try {
        const bitmap = await this._imageCapture.grabFrame();
        const c = document.createElement('canvas');
        c.width  = bitmap.width;
        c.height = bitmap.height;
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

  _startRAF() {
    const loop = (now) => {
      this._drawFrame(now);
      this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  _stopRAF() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  _drawFrame(now) {
    if (this._mainView === 'review') {
      this._drawLivePip();
    }

    if (this._mainView !== 'live') return;

    const canvas = this._overlayCanvas;
    if (!canvas || canvas.width === 0 || canvas.height === 0) return;
    const ctx = this._overlayCtx;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    this._ripples = this._ripples.filter(r => now < r.startTime + r.duration);

    for (const r of this._ripples) {
      const t      = Math.max(0, (now - r.startTime) / r.duration);
      const radius = r.baseR + (r.maxR - r.baseR) * t;
      const alpha  = r.alpha * (1 - t);
      const lw     = Math.max(3 - 2 * t, 0.5);

      ctx.beginPath();
      ctx.arc(r.cx, r.cy, radius, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
      ctx.lineWidth   = lw;
      ctx.shadowColor = `rgba(0,0,0,${(alpha * 0.5).toFixed(3)})`;
      ctx.shadowBlur  = 4;
      ctx.stroke();
      ctx.shadowBlur  = 0;
    }
  }

  _setStatus(text, cls) {
    const badge  = document.getElementById('sweep-badge');
    const textEl = document.getElementById('sweep-badge-text');
    if (badge)  badge.className     = `sweep-badge ${cls}`;
    if (textEl) textEl.textContent  = text;
  }
}
