class GpsService {
  constructor() {
    this.coords = null;   // { lat, lng, accuracy, heading }
    this.heading = null;  // compass heading (degrees from north)
    this.watchId = null;
    this._listeners = new Set();
    this._orientHandler = null;
  }

  async start() {
    await this._setupOrientation();
    return new Promise((resolve, reject) => {
      if (this.watchId !== null) { resolve(this.coords); return; }
      this.watchId = navigator.geolocation.watchPosition(
        pos => {
          this.coords = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            heading: this.heading ?? pos.coords.heading,
          };
          this._notify();
          resolve(this.coords);
        },
        err => reject(err),
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
      );
    });
  }

  async _setupOrientation() {
    const handler = e => {
      // iOS uses webkitCompassHeading; Android provides absolute alpha
      if (e.webkitCompassHeading != null) {
        this.heading = e.webkitCompassHeading;
      } else if (e.absolute && e.alpha != null) {
        this.heading = (360 - e.alpha) % 360;
      }
      if (this.coords) {
        this.coords.heading = this.heading;
        this._notify();
      }
    };

    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function'
    ) {
      try {
        const result = await DeviceOrientationEvent.requestPermission();
        if (result === 'granted') {
          window.addEventListener('deviceorientation', handler, true);
          this._orientHandler = handler;
        }
      } catch (_) {}
    } else {
      window.addEventListener('deviceorientation', handler, true);
      this._orientHandler = handler;
    }
  }

  onUpdate(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify() {
    this._listeners.forEach(fn => fn(this.coords));
  }

  stop() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    if (this._orientHandler) {
      window.removeEventListener('deviceorientation', this._orientHandler, true);
      this._orientHandler = null;
    }
  }

  get current() { return this.coords; }
}

export const gps = new GpsService();
