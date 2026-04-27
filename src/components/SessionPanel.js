import { session } from '../services/session.js';

export class SessionPanel {
  constructor() {
    this.el = null;
    this.visible = false;
  }

  mount() {
    this.el = document.createElement('div');
    this.el.className = 'session-panel';
    this.el.innerHTML = `
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <h2>&#x26F3; Session</h2>
        <button class="close-btn" id="sp-close">&#x2715;</button>
      </div>
      <div class="session-stats" id="sp-stats"></div>
      <div class="shot-list" id="sp-list"></div>
    `;
    document.getElementById('app').appendChild(this.el);

    this.el.querySelector('#sp-close').addEventListener('click', () => this.hide());

    // Event delegation for found/lost buttons
    this.el.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const shotId = parseInt(btn.dataset.shotId, 10);
      if (isNaN(shotId)) return;
      if (btn.classList.contains('found-btn')) session.updateShotStatus(shotId, 'found');
      if (btn.classList.contains('lost-btn'))  session.updateShotStatus(shotId, 'lost');
    });

    session.onChange(() => { if (this.visible) this._refresh(); });
  }

  show() {
    this.visible = true;
    this._refresh();
    this.el.classList.add('visible');
  }

  hide() {
    this.visible = false;
    this.el.classList.remove('visible');
  }

  _refresh() {
    const { total, found, lost, active } = session.summary;

    const stats = document.getElementById('sp-stats');
    if (stats) {
      stats.innerHTML = `
        <div class="stat"><span class="stat-num">${total}</span><span class="stat-label">Shots</span></div>
        <div class="stat found"><span class="stat-num">${found}</span><span class="stat-label">Found &#x2713;</span></div>
        <div class="stat lost"><span class="stat-num">${lost}</span><span class="stat-label">Lost &#x2717;</span></div>
        <div class="stat"><span class="stat-num">${active}</span><span class="stat-label">Active</span></div>
      `;
    }

    const list = document.getElementById('sp-list');
    if (!list) return;

    if (!session.shots.length) {
      list.innerHTML = `<p class="empty-list">No shots marked yet.<br>Tap "Mark Shot" on the map.</p>`;
      return;
    }

    list.innerHTML = session.shots.map(shot => `
      <div class="shot-item" data-status="${shot.status}">
        <div class="shot-item-header">
          <span class="shot-item-label">Shot ${shot.id}</span>
          <span class="shot-item-time">${new Date(shot.timestamp).toLocaleTimeString()}</span>
        </div>
        <div class="shot-item-actions">
          <button class="found-btn ${shot.status === 'found' ? 'active' : ''}" data-shot-id="${shot.id}">
            &#x2713; Found it
          </button>
          <button class="lost-btn ${shot.status === 'lost' ? 'active' : ''}" data-shot-id="${shot.id}">
            &#x2717; Lost ball
          </button>
        </div>
      </div>
    `).join('');
  }
}
