import { inferFast } from '../services/roboflow.js';
import { beep, initAudio } from '../utils/audio.js';

const INFER_W               = 640;
const INFER_H               = 480;
const SCAN_INTERVAL_MS      = 1500;
const CONSECUTIVE_THRESHOLD = 3;
const POSITION_TOL          = 0.15;  // 15% of frame dimension
const DETECT_THRESHOLD      = 0.4;   // minimum confidence to register

export class SweepScreen {
  constructor(el) {
    this.el = el;
    this._stream        = null;
    this._track         = null;
    this._imageCapture  = null;
    this._video         = null;
    this._overlayCanvas = null;
    this._overlayCtx    = null;
    this._rafId         = null;
    this._scanTimer     = null;
    this._inferring     = false;
    this._ripples       = [];
    this._consecutiveCount  = 0;
    this._lastDetPos    = null;  // { x, y } normalized [0–1]
    this._lastPred      = null;  // last detection in INFER space
    this._state         = 'idle';
    this._orientationHandler = null;
    // Callbacks set by main.js
    this.onClose       = null;
    this.onFound       = null;   // (shotId, coords) → void
    this.getActiveShot = null;   // () => shot | null
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
    this._consecutiveCount = 0;
    this._lastDetPos       = null;
    this._lastPred         = null;
    this._inferring        = false;
  }

  // ── DOM ───────────────────────────────────────────────────────────────
  _render() {
    this.el.innerHTML = `
      <div class="sweep-viewport" id="sweep-viewport">
        <video id="sweep-video" autoplay playsinline muted></video>
        <canvas id="sweep-overlay"></canvas>
        <div class="sweep-scanline"></div>

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
    this._overlayCanvas = document.getElementById('sweep-overlay');
    this._overlayCtx    = this._overlayCanvas.getContext('2d');

    new ResizeObserver(() => {
      this._overlayCanvas.width  = this._overlayCanvas.offsetWidth;
      this._overlayCanvas.height = this._overlayCanvas.offsetHeight;
    }).observe(this._overlayCanvas);
  }

  // ── UI binding ────────────────────────────────────────────────────────
  _bindUI() {
    this.el.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.id === 'sweep-back')      { this.onClose?.(); return; }
      if (btn.id === 'sweep-perm-btn')  { this._initCamera(); return; }
      if (btn.id === 'sweep-found-btn') { this._confirmFound(); return; }
      if (btn.id === 'sweep-keep-btn')  { this._keepScanning(); return; }
    });
  }

  // ── Camera init ───────────────────────────────────────────────────────
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

  // ── Orientation ───────────────────────────────────────────────────────
  _checkOrientation() {
    const portrait = window.innerHeight > window.innerWidth;
    document.getElementById('sweep-portrait-warning')?.classList.toggle('hidden', !portrait);
    if (portrait) {
      this._stopSweep();
    } else if (this._stream && this._state !== 'confirmed') {
      this._startSweep();
    }
  }

  // ── Sweep timer ───────────────────────────────────────────────────────
  _startSweep() {
    if (this._scanTimer) return;
    this._state = 'scanning';
    this._setStatus('SCANNING', 'scanning');
    this._doScan();  // immediate first scan; interval handles subsequent ones
    this._scanTimer = setInterval(() => this._doScan(), SCAN_INTERVAL_MS);
  }

  _stopSweep() {
    if (this._scanTimer) {
      clearInterval(this._scanTimer);
      this._scanTimer = null;
    }
  }

  // ── Scan / infer ──────────────────────────────────────────────────────
  async _doScan() {
    if (this._inferring) return;
    if (this._state === 'confirmed' || this._state === 'closing') return;
    if (window.innerHeight > window.innerWidth) return;

    this._inferring = true;
    this._state     = 'inferring';
    this._setStatus('DETECTING\u2026', 'inferring');

    try {
      const frame = await this._grabFrame();
      const preds = await inferFast(frame);
      const best  = preds.find(p => p.confidence >= DETECT_THRESHOLD) ?? null;

      if (best) {
        this._onDetection(best);
      } else {
        this._consecutiveCount = 0;
        this._lastDetPos = null;
        if (this._state !== 'confirmed') {
          this._state = 'scanning';
          this._setStatus('SCANNING', 'scanning');
        }
      }
    } catch (e) {
      console.error('[SweepScreen] Scan error:', e);
      if (this._state !== 'confirmed') {
        this._state = 'scanning';
        this._setStatus('SCANNING', 'scanning');
      }
    } finally {
      this._inferring = false;
    }
  }

  // ── Detection handling ────────────────────────────────────────────────
  _onDetection(pred) {
    const posX = pred.x / INFER_W;
    const posY = pred.y / INFER_H;

    if (this._lastDetPos) {
      const dx = Math.abs(posX - this._lastDetPos.x);
      const dy = Math.abs(posY - this._lastDetPos.y);
      if (dx > POSITION_TOL || dy > POSITION_TOL) {
        this._consecutiveCount = 0;
      }
    }

    this._consecutiveCount++;
    this._lastDetPos = { x: posX, y: posY };
    this._lastPred   = pred;

    const cx    = posX * this._overlayCanvas.width;
    const cy    = posY * this._overlayCanvas.height;
    const baseR = this._predRadius(pred);

    this._addRipples(cx, cy, baseR, pred.confidence);

    if (pred.confidence >= 0.6) beep();

    if (this._consecutiveCount >= CONSECUTIVE_THRESHOLD) {
      this._showConfirmation();
    } else {
      this._state = 'scanning';
      this._setStatus(
        `BALL SPOTTED \u00B7 ${this._consecutiveCount}/${CONSECUTIVE_THRESHOLD}`,
        'detected'
      );
    }
  }

  // ── Ripple animation ──────────────────────────────────────────────────
  _predRadius(pred) {
    const canvas = this._overlayCanvas;
    if (!canvas || canvas.width === 0) return 22;
    return Math.max(
      ((pred.width / INFER_W) * canvas.width + (pred.height / INFER_H) * canvas.height) / 4 * 1.35,
      18
    );
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

  // ── Confirmation ──────────────────────────────────────────────────────
  _showConfirmation() {
    this._state = 'confirmed';
    this._stopSweep();
    beep();
    this._setStatus('CONFIRMED!', 'confirmed');

    // Burst of celebration ripples
    if (this._lastPred) {
      const canvas = this._overlayCanvas;
      const cx     = (this._lastPred.x / INFER_W) * canvas.width;
      const cy     = (this._lastPred.y / INFER_H) * canvas.height;
      const baseR  = this._predRadius(this._lastPred);
      for (let i = 0; i < 5; i++) {
        this._ripples.push({
          cx, cy, baseR, maxR: baseR * 4.5,
          startTime: performance.now() + i * 150,
          duration:  1100,
          alpha:     1.0,
        });
      }
    }

    // Show card after ripples have started
    setTimeout(() => this._renderConfirmCard(), 600);
  }

  _renderConfirmCard() {
    if (this._state !== 'confirmed') return;
    const pred  = this._lastPred;
    const spotX = pred ? ((pred.x / INFER_W) * 100).toFixed(1) : '50';
    const spotY = pred ? ((pred.y / INFER_H) * 100).toFixed(1) : '50';

    const overlay = document.createElement('div');
    overlay.className = 'sweep-confirm-overlay';
    overlay.id        = 'sweep-confirm-overlay';
    overlay.innerHTML = `
      <div class="sweep-confirm-dim" style="--spot-x:${spotX}%;--spot-y:${spotY}%"></div>
      <div class="sweep-confirm-card">
        <div class="sweep-confirm-icon">&#x26F3;</div>
        <div class="sweep-confirm-title">Ball Found!</div>
        <div class="sweep-confirm-sub">Detected ${CONSECUTIVE_THRESHOLD} times in a row</div>
        <div class="sweep-confirm-actions">
          <button class="sweep-keep-btn" id="sweep-keep-btn">Keep Scanning</button>
          <button class="sweep-found-btn" id="sweep-found-btn">&#x2713;&nbsp;Found It!</button>
        </div>
      </div>
    `;
    document.getElementById('sweep-viewport')?.appendChild(overlay);
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
    this._removeConfirmOverlay();
    this.onFound?.(shotId, coords);
  }

  _keepScanning() {
    this._removeConfirmOverlay();
    this._consecutiveCount = 0;
    this._lastDetPos = null;
    this._state = 'scanning';
    this._setStatus('SCANNING', 'scanning');
    this._startSweep();
  }

  _removeConfirmOverlay() {
    document.getElementById('sweep-confirm-overlay')?.remove();
  }

  // ── Frame grab ────────────────────────────────────────────────────────
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

  // ── RAF overlay loop ──────────────────────────────────────────────────
  _startRAF() {
    const loop = (now) => {
      this._drawOverlay(now);
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

  _drawOverlay(now) {
    const canvas = this._overlayCanvas;
    if (!canvas || canvas.width === 0 || canvas.height === 0) return;
    const ctx = this._overlayCtx;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Expire finished ripples
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

    // Persistent circle at detection point when confirmed and ripples have cleared
    if (this._state === 'confirmed' && this._lastPred && this._ripples.length === 0) {
      const pred = this._lastPred;
      const cx   = (pred.x / INFER_W) * canvas.width;
      const cy   = (pred.y / INFER_H) * canvas.height;
      const r    = this._predRadius(pred);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth   = 3;
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur  = 6;
      ctx.stroke();
      ctx.shadowBlur  = 0;
    }
  }

  // ── Status badge ──────────────────────────────────────────────────────
  _setStatus(text, cls) {
    const badge  = document.getElementById('sweep-badge');
    const textEl = document.getElementById('sweep-badge-text');
    if (badge)  badge.className     = `sweep-badge ${cls}`;
    if (textEl) textEl.textContent  = text;
  }
}
