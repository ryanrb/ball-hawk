import { haversineDistance } from '../utils/geo.js';

class SessionService {
  constructor() {
    this.shots = [];       // { id, fromPin, landingPin, timestamp, status }
    this.detections = [];  // { id, lat, lng, confidence, shotId, timestamp }
    this._shotSeq = 1;
    this._detSeq = 1;
    this._listeners = new Set();
  }

  addShot(fromPin, landingPin) {
    const shot = {
      id: this._shotSeq++,
      fromPin,
      landingPin,
      timestamp: Date.now(),
      status: 'active', // 'active' | 'found' | 'lost'
    };
    this.shots.push(shot);
    this._emit();
    return shot;
  }

  addDetection(lat, lng, confidence, shotId = null) {
    const det = {
      id: this._detSeq++,
      lat, lng, confidence, shotId,
      timestamp: Date.now(),
    };
    this.detections.push(det);
    this._emit();
    return det;
  }

  updateShotStatus(shotId, status) {
    const shot = this.shots.find(s => s.id === shotId);
    if (shot) { shot.status = status; this._emit(); }
  }

  updateShotLanding(shotId, landingPin) {
    const shot = this.shots.find(s => s.id === shotId);
    if (shot) { shot.landingPin = landingPin; this._emit(); }
  }

  // Merge detections within MERGE_M of each other; 2+ matches boost confidence one tier
  mergeNearby(detections) {
    const MERGE_M = 5;
    const used = new Set();
    const result = [];
    for (let i = 0; i < detections.length; i++) {
      if (used.has(i)) continue;
      const group = [detections[i]];
      for (let j = i + 1; j < detections.length; j++) {
        if (used.has(j) || !detections[j].lat) continue;
        const dist = haversineDistance(
          detections[i].lat, detections[i].lng,
          detections[j].lat, detections[j].lng
        );
        if (dist < MERGE_M) { group.push(detections[j]); used.add(j); }
      }
      used.add(i);
      if (group.length >= 2) {
        const maxConf = Math.max(...group.map(d => d.confidence));
        result.push({ ...group[0], confidence: Math.min(1, maxConf + 0.15), merged: group.length });
      } else {
        result.push(group[0]);
      }
    }
    return result;
  }

  get summary() {
    return {
      total:  this.shots.length,
      found:  this.shots.filter(s => s.status === 'found').length,
      lost:   this.shots.filter(s => s.status === 'lost').length,
      active: this.shots.filter(s => s.status === 'active').length,
    };
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    this._listeners.forEach(fn => fn());
  }
}

export const session = new SessionService();
