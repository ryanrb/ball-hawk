/**
 * Client-side Canvas API preprocessing pipeline applied before Roboflow inference.
 * Steps (in order):
 *   1. Auto levels (per-channel histogram stretch)
 *   2. Shadow recovery (lift shadows by 25%)
 *   3. Mild unsharp mask (Laplacian-based sharpening kernel)
 *   4. Color-conditional channel filter (ball-color-aware)
 *   5. CLAHE-style local contrast enhancement (tiled histogram equalization)
 */
export function applyPipeline(canvas, ballColor = 'white') {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  let id = ctx.getImageData(0, 0, width, height);
  id = autoLevels(id);
  id = shadowRecovery(id, 0.25);
  id = unsharpMask(id, 0.5);
  id = channelFilter(id, ballColor);
  id = clahe(id, 64, 4.0);
  ctx.putImageData(id, 0, 0);
  return canvas;
}

function autoLevels(id) {
  const d = id.data;
  let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i]   < rMin) rMin = d[i];   if (d[i]   > rMax) rMax = d[i];
    if (d[i+1] < gMin) gMin = d[i+1]; if (d[i+1] > gMax) gMax = d[i+1];
    if (d[i+2] < bMin) bMin = d[i+2]; if (d[i+2] > bMax) bMax = d[i+2];
  }
  const rR = rMax - rMin || 1, gR = gMax - gMin || 1, bR = bMax - bMin || 1;
  const out = new Uint8ClampedArray(d.length);
  for (let i = 0; i < d.length; i += 4) {
    out[i]   = (d[i]   - rMin) / rR * 255;
    out[i+1] = (d[i+1] - gMin) / gR * 255;
    out[i+2] = (d[i+2] - bMin) / bR * 255;
    out[i+3] = d[i+3];
  }
  return new ImageData(out, id.width, id.height);
}

function shadowRecovery(id, amount) {
  const d = id.data;
  const out = new Uint8ClampedArray(d.length);
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = d[i + c];
      // Lift shadows: darker pixels get more boost
      out[i + c] = Math.min(255, v + Math.round(amount * (255 - v) * (1 - v / 255)));
    }
    out[i+3] = d[i+3];
  }
  return new ImageData(out, id.width, id.height);
}

function unsharpMask(id, amount) {
  const { data: d, width: w, height: h } = id;
  // Laplacian sharpening kernel scaled by amount
  const k = [0, -amount, 0, -amount, 1 + 4 * amount, -amount, 0, -amount, 0];
  const out = new Uint8ClampedArray(d.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const ny = Math.max(0, Math.min(h - 1, y + ky));
            const nx = Math.max(0, Math.min(w - 1, x + kx));
            s += d[(ny * w + nx) * 4 + c] * k[(ky + 1) * 3 + (kx + 1)];
          }
        }
        out[i + c] = Math.max(0, Math.min(255, Math.round(s)));
      }
      out[i+3] = d[i+3];
    }
  }
  return new ImageData(out, w, h);
}

function channelFilter(id, ballColor) {
  const d = id.data;
  const out = new Uint8ClampedArray(d.length);
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i+1], b = d[i+2];
    if (ballColor === 'white') {
      b = Math.min(255, Math.round(b * 1.15));          // +15% blue
    } else if (ballColor === 'yellow') {
      r = Math.min(255, Math.round(r * 1.05));          // violet tint:
      b = Math.min(255, Math.round(b * 1.10));          // +5% red, +10% blue
    }
    // orange: no filter
    out[i] = r; out[i+1] = g; out[i+2] = b; out[i+3] = d[i+3];
  }
  return new ImageData(out, id.width, id.height);
}

function clahe(id, tileSize, clipLimit) {
  const { data: d, width: w, height: h } = id;
  const tilesX = Math.ceil(w / tileSize);
  const tilesY = Math.ceil(h / tileSize);
  const luts = Array.from({ length: tilesY }, () => new Array(tilesX));

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const x0 = tx * tileSize, y0 = ty * tileSize;
      const x1 = Math.min(x0 + tileSize, w);
      const y1 = Math.min(y0 + tileSize, h);
      const n = (x1 - x0) * (y1 - y0);
      const hist = new Int32Array(256);

      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = (y * w + x) * 4;
          hist[(d[idx] * 77 + d[idx+1] * 150 + d[idx+2] * 29) >> 8]++;
        }
      }

      // Clip histogram and redistribute excess
      const limit = Math.max(1, Math.round(clipLimit * n / 256));
      let excess = 0;
      for (let j = 0; j < 256; j++) {
        if (hist[j] > limit) { excess += hist[j] - limit; hist[j] = limit; }
      }
      const add = Math.floor(excess / 256), rem = excess % 256;
      for (let j = 0; j < 256; j++) { hist[j] += add; if (j < rem) hist[j]++; }

      // Build CDF lookup table
      const lut = new Uint8Array(256);
      let cdf = 0;
      for (let j = 0; j < 256; j++) {
        cdf += hist[j];
        lut[j] = Math.min(255, Math.round(cdf / n * 255));
      }
      luts[ty][tx] = lut;
    }
  }

  // Apply per-tile LUT (nearest-tile assignment; artifacts at boundaries are minor at tileSize=64)
  const out = new Uint8ClampedArray(d.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = (d[i] * 77 + d[i+1] * 150 + d[i+2] * 29) >> 8;
      const tx = Math.min(Math.floor(x / tileSize), tilesX - 1);
      const ty = Math.min(Math.floor(y / tileSize), tilesY - 1);
      const newLum = luts[ty][tx][lum];
      const scale = lum > 0 ? newLum / lum : 1;
      out[i]   = Math.min(255, Math.round(d[i]   * scale));
      out[i+1] = Math.min(255, Math.round(d[i+1] * scale));
      out[i+2] = Math.min(255, Math.round(d[i+2] * scale));
      out[i+3] = d[i+3];
    }
  }
  return new ImageData(out, w, h);
}
