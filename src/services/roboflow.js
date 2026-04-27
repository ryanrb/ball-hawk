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

/**
 * Run inference on sourceCanvas with auto-refinement loop.
 *
 * Confidence tiers:
 *   >= 0.75  skip refinement
 *   0.50-0.75  crop 2x bbox, upscale to 1280x1280, re-infer (up to 3 extra passes)
 *   < 0.50 (threshold)  no detection
 *
 * Returns { predictions, passes, finalConfidence, captureWidth, captureHeight, best }
 */
export async function runWithRefinement(sourceCanvas, threshold = 0.5, ballColor = 'white') {
  // Initial inference at 640x480
  const cap = makeCanvas(INFER_W, INFER_H);
  cap.getContext('2d').drawImage(sourceCanvas, 0, 0, INFER_W, INFER_H);
  applyPipeline(cap, ballColor);

  let preds = await inferCanvas(cap);
  let passes = 1;
  let best = preds.find(p => p.confidence >= threshold) ?? null;

  if (!best) {
    return { predictions: [], passes, finalConfidence: 0,
             captureWidth: INFER_W, captureHeight: INFER_H, best: null };
  }

  // Refinement loop: run while confidence < 0.75 and passes remaining
  while (best.confidence < 0.75 && passes < 4) {
    const cropW = Math.min(INFER_W, best.width  * 2);
    const cropH = Math.min(INFER_H, best.height * 2);
    const cropX = Math.max(0, Math.min(INFER_W - cropW, best.x - cropW / 2));
    const cropY = Math.max(0, Math.min(INFER_H - cropH, best.y - cropH / 2));

    const ref = makeCanvas(1280, 1280);
    ref.getContext('2d').drawImage(cap, cropX, cropY, cropW, cropH, 0, 0, 1280, 1280);
    applyPipeline(ref, ballColor);

    const refPreds = await inferCanvas(ref);
    passes++;

    const refBest = refPreds[0]; // already sorted by confidence
    if (!refBest || refBest.confidence <= best.confidence) break;

    // Map refined bbox back to original 640x480 coordinate space
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

  return {
    predictions:    preds.filter(p => p.confidence >= threshold),
    passes,
    finalConfidence: best?.confidence ?? 0,
    captureWidth:   INFER_W,
    captureHeight:  INFER_H,
    best,
  };
}
