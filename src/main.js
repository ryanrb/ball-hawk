import 'mapbox-gl/dist/mapbox-gl.css';
import './styles.css';
import { MapScreen }    from './components/MapScreen.js';
import { CameraScreen } from './components/CameraScreen.js';
import { SessionPanel } from './components/SessionPanel.js';
import { session }      from './services/session.js';

async function init() {
  const app = document.getElementById('app');

  // Append screens without destroying the splash
  const mapEl = document.createElement('div');
  mapEl.id = 'map-screen';
  mapEl.className = 'screen active';
  app.appendChild(mapEl);

  const camEl = document.createElement('div');
  camEl.id = 'camera-screen';
  camEl.className = 'screen';
  app.appendChild(camEl);

  // Session panel mounts directly into #app (bottom sheet)
  const sessionPanel = new SessionPanel();
  sessionPanel.mount();

  const mapScreen    = new MapScreen(mapEl);
  const cameraScreen = new CameraScreen(camEl);

  // Wire up cross-component callbacks
  mapScreen.onCameraRequest  = () => showCamera();
  mapScreen.onSessionRequest = () => sessionPanel.show();

  cameraScreen.onClose      = () => showMap();
  cameraScreen.onFound      = (shotId, confidence) => {
    if (shotId != null) session.updateShotStatus(shotId, 'found');
    showMap();
  };
  cameraScreen.getActiveShot = () => mapScreen.getNearestActiveShot();

  await mapScreen.init();

  // Fade out splash once map is ready
  const splash = document.getElementById('splash');
  if (splash) {
    splash.style.transition = 'opacity 0.4s';
    splash.style.opacity    = '0';
    setTimeout(() => splash.remove(), 450);
  }

  function showCamera() {
    mapEl.classList.remove('active');
    camEl.classList.add('active');
    cameraScreen.start();
  }

  function showMap() {
    cameraScreen.stop();
    camEl.classList.remove('active');
    mapEl.classList.add('active');
    // Mapbox doesn't track container size while hidden; resize after layout settles.
    requestAnimationFrame(() => mapScreen.map?.resize());
  }
}

init().catch(console.error);
