import { applyPipeline } from '../utils/preprocess.js';

const API_KEY  = import.meta.env.VITE_ROBOFLOW_KEY ?? '';
const ENDPOINT = 'https://serverless.roboflow.com/golfball/1';
const INFER_W  = 640;
const INFER_H  = 480;

async function inferCanvas(canvas) {
  const b64 = canvas.toDataURL('image/jpeg', 0.92)
    .replace(/^data:image\/jpeg;base64,/, '');
  const res = await fetch(`${ENDPOINT}?api_key=${API_KEY}&format=json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: b64,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.predictions ?? []).sort((a, b) => b.confidence - a.confidence);
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Returns a rect covering the center third of the source canvas.
function centerCropRect(src) {
  const w = Math.round(src.width  / 3);
  const h = Math.round(src.height / 3);
  return { x: Math.round((src.width - w) / 2), y: Math.round((src.height - h) / 2), w, h };
}

// Run inference + refinement loop on an already-prepared 640×480 canvas.
// Returns { preds, passes, best } or null if nothing above threshold.
async function inferWithRefinement(cap, threshold) {
  let preds = await inferCanvas(cap);
  let passes = 1;
  let best = preds.find(p => p.confidence >= threshold) ?? null;
  if (!best) return null;

  while (best.confidence < 0.75 && passes < 4) {
    const cropW = Math.min(INFER_W, best.width  * 2);
    const cropH = Math.min(INFER_H, best.height * 2);
    const cropX = Math.max(0, Math.min(INFER_W - cropW, best.x - cropW / 2));
    const cropY = Math.max(0, Math.min(INFER_H - cropH, best.y - cropH / 2));

    const ref = makeCanvas(1280, 1280);
    ref.getContext('2d').drawImage(cap, cropX, cropY, cropW, cropH, 0, 0, 1280, 1280);
    applyPipeline(ref);

    const refPreds = await inferCanvas(ref);
    passes++;

    const refBest = refPreds[0];
    if (!refBest || refBest.confidence <= best.confidence) break;

    const sx = cropW / 1280, sy = cropH / 1280;
    best = {
      ...refBest,
      x:      cropX + refBest.x      * sx,
      y:      cropY + refBest.y      * sy,
      width:  refBest.width  * sx,
      height: refBest.height * sy,
    };
    preds = [best];
    if (best.confidence >= 0.85) break;
  }

  return { preds, passes, best };
}

/**
 * Two-pass inference: center-crop first (3× effective zoom using full sensor
 * resolution), then full-frame fallback if nothing found.
 *
 * Returns { predictions, passes, finalConfidence, captureWidth, captureHeight,
 *           best, cropRect }
 * cropRect is non-null when the center-crop pass found the ball (used by the
 * review screen to display the cropped region at full detail).
 */
export async function runWithRefinement(sourceCanvas, threshold = 0.5) {
  // Center-crop is only beneficial when the source is significantly larger than
  // the inference canvas (i.e. we have a real high-res sensor frame). If the
  // source is already near 640×480 (video-element fallback), cropping 1/3 would
  // just upscale a blurry patch — skip straight to full-frame in that case.
  const highRes = sourceCanvas.width > INFER_W * 2 && sourceCanvas.height > INFER_H * 2;

  if (highRes) {
    // Pass 1: center crop → effectively 3× zoom from the raw sensor frame
    const crop = centerCropRect(sourceCanvas);
    const cap1 = makeCanvas(INFER_W, INFER_H);
    cap1.getContext('2d').drawImage(
      sourceCanvas, crop.x, crop.y, crop.w, crop.h, 0, 0, INFER_W, INFER_H
    );
    applyPipeline(cap1);
    const r1 = await inferWithRefinement(cap1, threshold);

    if (r1) {
      return {
        predictions:     r1.preds.filter(p => p.confidence >= threshold),
        passes:          r1.passes,
        finalConfidence: r1.best.confidence,
        captureWidth:    INFER_W,
        captureHeight:   INFER_H,
        best:            r1.best,
        cropRect:        crop,
      };
    }
  }

  // Full-frame inference (only pass on low-res source; pass 2 fallback on high-res)
  const cap = makeCanvas(INFER_W, INFER_H);
  cap.getContext('2d').drawImage(sourceCanvas, 0, 0, INFER_W, INFER_H);
  applyPipeline(cap);
  const r = await inferWithRefinement(cap, threshold);

  if (!r) {
    return { predictions: [], passes: highRes ? 2 : 1, finalConfidence: 0,
             captureWidth: INFER_W, captureHeight: INFER_H, best: null, cropRect: null };
  }

  return {
    predictions:     r.preds.filter(p => p.confidence >= threshold),
    passes:          highRes ? r.passes + 1 : r.passes,
    finalConfidence: r.best.confidence,
    captureWidth:    INFER_W,
    captureHeight:   INFER_H,
    best:            r.best,
    cropRect:        null,
  };
}
