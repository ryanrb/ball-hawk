import mapboxgl from 'mapbox-gl';
import { gps } from '../services/gps.js';
import { session } from '../services/session.js';
import { bing, initAudio } from '../utils/audio.js';
import { haversineDistance, circlePolygon, SEARCH_RADIUS_M } from '../utils/geo.js';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_KEY ?? '';

export class MapScreen {
  constructor(el) {
    this.el = el;
    this.map = null;
    this.userMarker = null;
    this.userCoords = null;
    this.shotMarkers = new Map();      // shotId → { fromM, landM, fromEl, landEl }
    this.detectionMarkers = new Map(); // detId  → mapboxgl.Marker
    this.inRange = new Set();          // shotIds currently in proximity
    this.markingMode = false;
    this._pendingFrom = null;
    this._pendingFromMarker = null;
    this._alertedIds = new Set();      // shots we've already bung'd for
    this._satellite = false;
    this._pendingRemoveId = null;
    this.onCameraRequest = null;
    this.onSessionRequest = null;
  }

  async init() {
    this._render();
    await this._initMap();
    this._bindEvents();
    this._startGPS();
    session.onChange(() => this._syncSession());
  }

  // ── DOM ────────────────────────────────────────────────────────────────
  _render() {
    this.el.innerHTML = `
      <div id="bh-map"></div>

      <div class="map-header">
        <button class="hamburger-btn" id="hamburger-btn" aria-label="Menu">
          <span></span><span></span><span></span>
        </button>
        <div class="header-title">
          <span class="header-logo">&#x26F3;</span>
          <span class="header-wordmark">BALL HAWK</span>
        </div>
        <div class="gps-status">
          <div class="gps-dot" id="gps-dot"></div>
          <span id="gps-text">Locating&hellip;</span>
        </div>
      </div>

      <div class="menu-drawer" id="menu-drawer">
        <button class="menu-item" id="layer-toggle">
          <div class="menu-item-icon" id="layer-icon">&#x1F6F0;&#xFE0F;</div>
          <div class="menu-item-body">
            <div class="menu-item-title" id="layer-title">Satellite View</div>
            <div class="menu-item-desc">Toggle aerial imagery</div>
          </div>
        </button>
        <button class="menu-item" id="session-btn">
          <div class="menu-item-icon">&#x1F4CB;</div>
          <div class="menu-item-body">
            <div class="menu-item-title">Shot History</div>
            <div class="menu-item-desc"><span class="shot-count">0</span> shots this session</div>
          </div>
        </button>
      </div>
      <div class="menu-overlay hidden" id="menu-overlay"></div>

      <div class="dismiss-banner hidden" id="dismiss-banner">
        <span class="dismiss-text">Remove shot <span id="dismiss-shot-num"></span>?</span>
        <div class="dismiss-btns">
          <button class="dismiss-cancel-btn" id="cancel-remove-btn">Keep</button>
          <button class="dismiss-confirm-btn" id="confirm-remove-btn">Remove</button>
        </div>
      </div>

      <div class="proximity-banner hidden" id="prox-banner">
        &#x1F3AF; You&rsquo;re in range &mdash; tap Scan to detect
      </div>

      <div class="marking-banner hidden" id="mark-banner">
        <span>&#x1F4CD; Tap the map where the ball landed</span>
        <button class="cancel-btn" id="cancel-mark">Cancel</button>
      </div>

      <div class="action-sheet" id="action-sheet">
        <div class="sheet-peek" id="sheet-peek">
          <div class="sheet-handle"></div>
          <div class="sheet-prompt">Where is your ball?</div>
        </div>
        <div class="sheet-options">
          <button class="action-option" id="mark-shot-opt">
            <div class="action-opt-icon mark-opt-icon">&#x1F4CD;</div>
            <div class="action-opt-text">
              <div class="action-opt-title">Mark Your Shot</div>
              <div class="action-opt-desc">Tag landing zone after shot</div>
            </div>
            <span class="action-opt-chevron">&#x203A;</span>
          </button>
          <button class="action-option" id="camera-btn">
            <div class="action-opt-icon scan-opt-icon">&#x1F4F7;</div>
            <div class="action-opt-text">
              <div class="action-opt-title">Take a High-Res Scan</div>
              <div class="action-opt-desc">Zoom and scan distant spots</div>
            </div>
            <span class="action-opt-chevron">&#x203A;</span>
          </button>
          <button class="action-option sweep-option" disabled>
            <div class="action-opt-icon sweep-opt-icon">&#x1F50D;</div>
            <div class="action-opt-text">
              <div class="action-opt-title">Perform a Live Sweep</div>
              <div class="action-opt-desc">Scan close-range grass</div>
            </div>
            <span class="coming-soon-badge">Soon</span>
          </button>
        </div>
      </div>

      <div class="range-tip hidden" id="range-tip">
        Best results within 15 yards &mdash; move closer if no detection
      </div>
    `;
  }

  // ── Mapbox init ────────────────────────────────────────────────────────
  _initMap() {
    return new Promise(resolve => {
      this.map = new mapboxgl.Map({
        container: 'bh-map',
        style: 'mapbox://styles/mapbox/outdoors-v12',
        zoom: 16,
        center: [-98.583, 39.833], // US center fallback
        attributionControl: false,
      });
      this.map.addControl(
        new mapboxgl.AttributionControl({ compact: true }),
        'bottom-left'
      );
      this.map.on('load', () => {
        this._addCircleLayers();
        resolve();
      });
    });
  }

  _addCircleLayers() {
    this.map.addSource('circles', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    this.map.addLayer({
      id: 'circles-fill',
      type: 'fill',
      source: 'circles',
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.12 },
    });
    this.map.addLayer({
      id: 'circles-line',
      type: 'line',
      source: 'circles',
      paint: {
        'line-color': ['get', 'color'],
        'line-width': 2,
        'line-opacity': 0.85,
        'line-dasharray': [4, 2],
      },
    });
  }

  _toggleLayer() {
    this._satellite = !this._satellite;
    const style = this._satellite
      ? 'mapbox://styles/mapbox/satellite-streets-v12'
      : 'mapbox://styles/mapbox/outdoors-v12';
    const icon  = document.getElementById('layer-icon');
    const title = document.getElementById('layer-title');
    if (icon)  icon.textContent  = this._satellite ? '\u{1F5FA}️' : '\u{1F6F0}️';
    if (title) title.textContent = this._satellite ? 'Map View' : 'Satellite View';
    this.map.once('style.load', () => {
      this._addCircleLayers();
      this._refreshCircles();
    });
    this.map.setStyle(style);
  }

  // ── Event binding ──────────────────────────────────────────────────────
  _bindEvents() {
    this.el.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (btn) {
        if (btn.id === 'hamburger-btn') { this._toggleMenu(); return; }
        if (btn.id === 'layer-toggle')  { this._toggleLayer(); this._closeMenu(); return; }
        if (btn.id === 'session-btn')   { this.onSessionRequest?.(); this._closeMenu(); return; }
        if (btn.id === 'mark-shot-opt')     { this._startMarkShot(); return; }
        if (btn.id === 'cancel-mark')       { this._cancelMark(); return; }
        if (btn.id === 'camera-btn')        { this.onCameraRequest?.(); return; }
        if (btn.id === 'confirm-remove-btn') { this._confirmRemoveShot(); return; }
        if (btn.id === 'cancel-remove-btn')  { this._cancelRemoveShot(); return; }
        return;
      }
      if (e.target.id === 'menu-overlay') this._closeMenu();
    });

    this.map.on('click', e => {
      if (this.markingMode) this._confirmLanding(e.lngLat);
    });

    this._bindSheetGesture();
  }

  _bindSheetGesture() {
    const peek  = document.getElementById('sheet-peek');
    const sheet = document.getElementById('action-sheet');
    if (!peek || !sheet) return;

    let startY       = 0;
    let touchFired   = false;

    peek.addEventListener('touchstart', e => {
      startY     = e.touches[0].clientY;
      touchFired = false;
    }, { passive: true });

    peek.addEventListener('touchend', e => {
      touchFired   = true;
      const dy     = startY - e.changedTouches[0].clientY; // positive = swipe up
      if (dy > 20)       sheet.classList.add('expanded');
      else if (dy < -20) sheet.classList.remove('expanded');
      else               sheet.classList.toggle('expanded'); // tap
      setTimeout(() => { touchFired = false; }, 400);
    }, { passive: true });

    peek.addEventListener('click', () => {
      if (touchFired) return; // touch already handled it
      sheet.classList.toggle('expanded');
    });
  }

  // ── Menu drawer ────────────────────────────────────────────────────────
  _toggleMenu() {
    const drawer  = document.getElementById('menu-drawer');
    const overlay = document.getElementById('menu-overlay');
    const isOpen  = drawer?.classList.contains('open');
    drawer?.classList.toggle('open', !isOpen);
    overlay?.classList.toggle('hidden', isOpen);
  }

  _closeMenu() {
    document.getElementById('menu-drawer')?.classList.remove('open');
    document.getElementById('menu-overlay')?.classList.add('hidden');
  }

  // ── Action sheet ───────────────────────────────────────────────────────
  _dismissSheet() {
    const sheet = document.getElementById('action-sheet');
    sheet?.classList.remove('expanded');
    sheet?.classList.add('dismissed');
  }

  _restoreSheet() {
    document.getElementById('action-sheet')?.classList.remove('dismissed');
  }

  // ── GPS ────────────────────────────────────────────────────────────────
  async _startGPS() {
    try {
      const coords = await gps.start();
      this._onCoords(coords);
      this.map.flyTo({ center: [coords.lng, coords.lat], zoom: 18 });
    } catch {
      const t = document.getElementById('gps-text');
      if (t) t.textContent = 'GPS denied';
    }
    gps.onUpdate(c => this._onCoords(c));
  }

  _onCoords(c) {
    this.userCoords = c;
    const t   = document.getElementById('gps-text');
    const dot = document.getElementById('gps-dot');
    if (t)   t.textContent = `±${Math.round(c.accuracy ?? 0)}m`;
    if (dot) dot.className = 'gps-dot active';
    this._updateUserDot(c);
    this._checkProximity(c);
  }

  _updateUserDot(c) {
    const pos = [c.lng, c.lat];
    if (!this.userMarker) {
      const el = document.createElement('div');
      el.className = 'user-dot';
      el.innerHTML = '<div class="user-dot-inner"></div><div class="user-dot-ring"></div>';
      this.userMarker = new mapboxgl.Marker({ element: el, anchor: 'center' })
        .setLngLat(pos).addTo(this.map);
    } else {
      this.userMarker.setLngLat(pos);
    }
  }

  // ── Shot marking (Phase 1) ─────────────────────────────────────────────
  _startMarkShot() {
    if (!this.userCoords) { alert('Waiting for GPS…'); return; }
    initAudio();

    this._pendingFrom = { lat: this.userCoords.lat, lng: this.userCoords.lng };

    const el = this._makeShotEl(session._shotSeq, 'tee');
    this._pendingFromMarker = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([this._pendingFrom.lng, this._pendingFrom.lat]).addTo(this.map);

    this.markingMode = true;
    this._dismissSheet();
    document.getElementById('mark-banner').classList.remove('hidden');
  }

  _confirmLanding(lngLat) {
    const landing = { lat: lngLat.lat, lng: lngLat.lng };
    this._pendingFromMarker?.remove();
    this._pendingFromMarker = null;
    this.markingMode = false;

    const shot = session.addShot(this._pendingFrom, landing);
    this._pendingFrom = null;
    this._drawShot(shot);

    document.getElementById('mark-banner').classList.add('hidden');
    this._restoreSheet();
  }

  _cancelMark() {
    this._pendingFromMarker?.remove();
    this._pendingFromMarker = null;
    this._pendingFrom = null;
    this.markingMode = false;
    document.getElementById('mark-banner').classList.add('hidden');
    this._restoreSheet();
  }

  _drawShot(shot) {
    const fromEl = this._makeShotEl(shot.id, 'tee');
    const landEl = this._makeShotEl(shot.id, 'landing');
    landEl.style.cursor = 'grab';

    const fromM = new mapboxgl.Marker({ element: fromEl, anchor: 'bottom' })
      .setLngLat([shot.fromPin.lng, shot.fromPin.lat]).addTo(this.map);
    const landM = new mapboxgl.Marker({ element: landEl, anchor: 'bottom', draggable: true })
      .setLngLat([shot.landingPin.lng, shot.landingPin.lat]).addTo(this.map);

    landM.on('drag', () => {
      const { lat, lng } = landM.getLngLat();
      shot.landingPin = { lat, lng };
      this._refreshCircles();
    });

    landM.on('dragend', () => {
      const { lat, lng } = landM.getLngLat();
      session.updateShotLanding(shot.id, { lat, lng });
      if (this.userCoords) this._checkProximity(this.userCoords);
    });

    this._addLongPress(fromEl, shot.id);
    this._addLongPress(landEl, shot.id);

    this.shotMarkers.set(shot.id, { fromM, landM, fromEl, landEl });
    this._refreshCircles();
    this._updateShotCount();
  }

  _makeShotEl(id, type) {
    const el = document.createElement('div');
    el.className = `shot-marker ${type === 'tee' ? 'tee-marker' : 'landing-marker'}`;
    el.innerHTML = `<div class="shot-number">${id}</div>`;
    return el;
  }

  // ── Long-press removal ────────────────────────────────────────────────
  _addLongPress(el, shotId) {
    let timer = null;

    const startPress = () => {
      el.classList.add('pressing');
      timer = setTimeout(() => {
        el.classList.remove('pressing');
        timer = null;
        this._showRemoveConfirm(shotId);
      }, 650);
    };

    const cancelPress = () => {
      if (!timer) return;
      el.classList.remove('pressing');
      clearTimeout(timer);
      timer = null;
    };

    el.addEventListener('touchstart',  startPress,  { passive: true });
    el.addEventListener('touchend',    cancelPress);
    el.addEventListener('touchmove',   cancelPress);
    el.addEventListener('mousedown',   startPress);
    el.addEventListener('mouseup',     cancelPress);
    el.addEventListener('mouseleave',  cancelPress);
  }

  _showRemoveConfirm(shotId) {
    if (this.markingMode) return;
    navigator.vibrate?.(50);
    this._pendingRemoveId = shotId;
    const numEl = document.getElementById('dismiss-shot-num');
    if (numEl) numEl.textContent = `#${shotId}`;
    document.getElementById('dismiss-banner')?.classList.remove('hidden');
  }

  _confirmRemoveShot() {
    if (this._pendingRemoveId == null) return;
    const { fromM, landM } = this.shotMarkers.get(this._pendingRemoveId) ?? {};
    fromM?.remove();
    landM?.remove();
    this.shotMarkers.delete(this._pendingRemoveId);
    this.inRange.delete(this._pendingRemoveId);
    this._alertedIds.delete(this._pendingRemoveId);
    session.removeShot(this._pendingRemoveId);
    if (this.userCoords) this._checkProximity(this.userCoords);
    this._updateShotCount();
    this._cancelRemoveShot();
  }

  _cancelRemoveShot() {
    this._pendingRemoveId = null;
    document.getElementById('dismiss-banner')?.classList.add('hidden');
  }

  // ── Proximity monitoring ───────────────────────────────────────────────
  _checkProximity(c) {
    let anyInRange = false;
    for (const shot of session.shots) {
      if (shot.status !== 'active') continue;
      const dist = haversineDistance(c.lat, c.lng, shot.landingPin.lat, shot.landingPin.lng);
      if (dist <= SEARCH_RADIUS_M) {
        anyInRange = true;
        if (!this.inRange.has(shot.id)) {
          this.inRange.add(shot.id);
          if (!this._alertedIds.has(shot.id)) {
            this._alertedIds.add(shot.id);
            bing();
          }
        }
      } else {
        this.inRange.delete(shot.id);
      }
    }

    const banner = document.getElementById('prox-banner');
    const tip    = document.getElementById('range-tip');
    if (anyInRange) {
      banner?.classList.remove('hidden');
      tip?.classList.remove('hidden');
    } else {
      banner?.classList.add('hidden');
      tip?.classList.add('hidden');
    }
    this._refreshCircles();
  }

  _refreshCircles() {
    const src = this.map?.getSource?.('circles');
    if (!src) return;
    const features = session.shots
      .filter(s => s.status === 'active')
      .map(shot => {
        const f = circlePolygon(shot.landingPin.lng, shot.landingPin.lat, SEARCH_RADIUS_M);
        f.properties.color = this.inRange.has(shot.id) ? '#00ff88' : '#3b82f6';
        return f;
      });
    src.setData({ type: 'FeatureCollection', features });
  }

  // ── Detection pins (called from CameraScreen via main.js) ─────────────
  addDetectionPin(lat, lng, confidence, shotId = null) {
    const det = session.addDetection(lat, lng, confidence, shotId);
    this._renderDetPin(det.id, lat, lng, confidence);
    return det;
  }

  _renderDetPin(id, lat, lng, conf) {
    let color, label;
    if (conf >= 0.85)      { color = '#00ff88'; label = 'Ball Found'; }
    else if (conf >= 0.70) { color = '#fbbf24'; label = 'Probable Ball'; }
    else                   { color = '#f97316'; label = 'Possible Ball'; }

    const el = document.createElement('div');
    el.className = 'detection-pin';
    el.innerHTML = `
      <div class="pin-circle" style="background:${color};box-shadow:0 0 8px ${color}66"></div>
      <div class="pin-label" style="color:${color}">${label}<br>${Math.round(conf * 100)}%</div>
    `;
    const m = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([lng, lat]).addTo(this.map);
    this.detectionMarkers.set(id, m);
  }

  // ── Session sync ───────────────────────────────────────────────────────
  _updateShotCount() {
    const count = session.shots.length;
    this.el.querySelectorAll('.shot-count').forEach(el => el.textContent = count);
  }

  _syncSession() {
    this._updateShotCount();
    this._refreshCircles();
    for (const [id, { landEl }] of this.shotMarkers) {
      const shot = session.shots.find(s => s.id === id);
      if (!shot) continue;
      if (shot.status === 'found') {
        landEl.style.background = '#00ff88';
        landEl.style.boxShadow  = '0 2px 10px rgba(0,255,136,0.6)';
      } else if (shot.status === 'lost') {
        landEl.style.background = '#4b5563';
        landEl.style.boxShadow  = 'none';
      }
    }
  }

  // ── Public helpers used by CameraScreen ───────────────────────────────
  getGpsContext() {
    return this.userCoords;
  }

  getNearestActiveShot() {
    if (!this.userCoords || !session.shots.length) return null;
    let nearest = null, minDist = Infinity;
    for (const shot of session.shots) {
      if (shot.status !== 'active') continue;
      const d = haversineDistance(
        this.userCoords.lat, this.userCoords.lng,
        shot.landingPin.lat, shot.landingPin.lng
      );
      if (d < minDist) { minDist = d; nearest = shot; }
    }
    return nearest;
  }
}
