// ===================== TILE BLEND METHODS =====================

// === CROSS-FADE WRAP ===
// For each pixel, blend it with its wrapped counterpart based on distance to edge
function tileCrossFade(src, w, h, blendPct) {
  const imgData = getSourceData(src, w, h);
  const orig = new Uint8ClampedArray(imgData.data);
  const d = imgData.data;
  const bw = Math.max(2, Math.floor(w * blendPct));
  const bh = Math.max(2, Math.floor(h * blendPct));

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Distance-to-edge factor for each axis (0 at edge, 1 at blend boundary)
      let ax = 1, ay = 1;
      if (x < bw) ax = x / bw;
      else if (x >= w - bw) ax = (w - 1 - x) / bw;
      if (y < bh) ay = y / bh;
      else if (y >= h - bh) ay = (h - 1 - y) / bh;

      // Smooth with cosine
      ax = 0.5 - 0.5 * Math.cos(ax * Math.PI);
      ay = 0.5 - 0.5 * Math.cos(ay * Math.PI);
      const a = ax * ay; // combined factor: 0 near corner edges, 1 in center

      if (a >= 0.999) continue; // fully original, skip

      // Wrapped coordinate
      const wx = (x + Math.floor(w / 2)) % w;
      const wy = (y + Math.floor(h / 2)) % h;
      const si = (y * w + x) * 4;
      const wi = (wy * w + wx) * 4;

      for (let c = 0; c < 3; c++) {
        d[si + c] = Math.round(orig[si + c] * a + orig[wi + c] * (1 - a));
      }
    }
  }
  return imageDataToCanvas(imgData);
}

// === OFFSET + BLEND SEAM (original method) ===
function tileOffsetBlend(src, w, h, blendPct) {
  const preCanvas = document.createElement('canvas');
  preCanvas.width = w; preCanvas.height = h;
  const pctx = preCanvas.getContext('2d');

  const hx = Math.floor(w / 2);
  const hy = Math.floor(h / 2);
  pctx.drawImage(src, hx, hy, w - hx, h - hy, 0, 0, w - hx, h - hy);
  pctx.drawImage(src, 0, hy, hx, h - hy, w - hx, 0, hx, h - hy);
  pctx.drawImage(src, hx, 0, w - hx, hy, 0, h - hy, w - hx, hy);
  pctx.drawImage(src, 0, 0, hx, hy, w - hx, h - hy, hx, hy);

  const blendW = Math.max(2, Math.floor(w * blendPct));
  const blendH = Math.max(2, Math.floor(h * blendPct));
  const offsetData = pctx.getImageData(0, 0, w, h);
  const od = offsetData.data;

  const origData = getSourceData(src, w, h).data;

  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  // Vertical stripe blend
  for (let y = 0; y < h; y++) {
    for (let x = cx - blendW; x < cx + blendW; x++) {
      if (x < 0 || x >= w) continue;
      const t = (x - (cx - blendW)) / (blendW * 2);
      const a = 0.5 - 0.5 * Math.cos(t * Math.PI);
      const idx = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        od[idx + c] = Math.round(od[idx + c] * (1 - a) + origData[idx + c] * a);
      }
    }
  }
  // Horizontal stripe blend
  for (let x = 0; x < w; x++) {
    for (let y = cy - blendH; y < cy + blendH; y++) {
      if (y < 0 || y >= h) continue;
      const t = (y - (cy - blendH)) / (blendH * 2);
      const a = 0.5 - 0.5 * Math.cos(t * Math.PI);
      const idx = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        od[idx + c] = Math.round(od[idx + c] * (1 - a) + origData[idx + c] * a);
      }
    }
  }
  pctx.putImageData(offsetData, 0, 0);
  return preCanvas;
}

// === DIAMOND BLEND ===
// Uses a diamond-shaped (L1 / Manhattan distance) gradient from center
// so the blend falls off uniformly in all directions — no axis bias
function tileDiamondBlend(src, w, h, blendPct) {
  const imgData = getSourceData(src, w, h);
  const orig = new Uint8ClampedArray(imgData.data);
  const d = imgData.data;
  const blendDist = Math.max(2, Math.floor(Math.min(w, h) * blendPct));

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Manhattan distance to nearest edge
      const dx = Math.min(x, w - 1 - x);
      const dy = Math.min(y, h - 1 - y);
      const distToEdge = dx + dy;

      if (distToEdge >= blendDist) continue; // fully original

      const t = distToEdge / blendDist;
      const a = 0.5 - 0.5 * Math.cos(t * Math.PI); // 0 at edge, 1 at threshold

      // Wrapped counterpart
      const wx = (x + Math.floor(w / 2)) % w;
      const wy = (y + Math.floor(h / 2)) % h;
      const si = (y * w + x) * 4;
      const wi = (wy * w + wx) * 4;

      for (let c = 0; c < 3; c++) {
        d[si + c] = Math.round(orig[si + c] * a + orig[wi + c] * (1 - a));
      }
    }
  }
  return imageDataToCanvas(imgData);
}

// === MULTI-SCALE PYRAMID BLEND ===
// Decomposes into Gaussian/Laplacian pyramid levels, blends each level
// with a progressively wider seam mask, then reconstructs. This hides seams
// at every spatial frequency — the gold standard for texture tiling.
function tileMultiScaleBlend(src, w, h, levels) {
  // Work at a manageable resolution — cap at 512 for performance
  const maxDim = Math.min(512, Math.max(w, h));
  let pw = w, ph = h;
  if (Math.max(w, h) > maxDim) {
    const scale = maxDim / Math.max(w, h);
    pw = Math.round(w * scale);
    ph = Math.round(h * scale);
  }

  // Get source and its half-offset version as float arrays [r,g,b] per pixel
  function toFloat(imgData) {
    const n = imgData.width * imgData.height;
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      out[i * 3] = imgData.data[i * 4];
      out[i * 3 + 1] = imgData.data[i * 4 + 1];
      out[i * 3 + 2] = imgData.data[i * 4 + 2];
    }
    return out;
  }

  function fromFloat(arr, width, height) {
    const imgData = new ImageData(width, height);
    const n = width * height;
    for (let i = 0; i < n; i++) {
      imgData.data[i * 4] = clamp(Math.round(arr[i * 3]));
      imgData.data[i * 4 + 1] = clamp(Math.round(arr[i * 3 + 1]));
      imgData.data[i * 4 + 2] = clamp(Math.round(arr[i * 3 + 2]));
      imgData.data[i * 4 + 3] = 255;
    }
    return imgData;
  }

  // Simple 3×3 Gaussian blur (wrapping edges for tileability)
  function blur(arr, width, height) {
    const out = new Float32Array(arr.length);
    const k = [1/16, 2/16, 1/16, 2/16, 4/16, 2/16, 1/16, 2/16, 1/16];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let ki = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const nx = (x + kx + width) % width;
            const ny = (y + ky + height) % height;
            const ni = (ny * width + nx) * 3;
            const w = k[ki++];
            const oi = (y * width + x) * 3;
            out[oi] += arr[ni] * w;
            out[oi + 1] += arr[ni + 1] * w;
            out[oi + 2] += arr[ni + 2] * w;
          }
        }
      }
    }
    return out;
  }

  // Repeated blur for deeper Gaussian levels
  function multiBlur(arr, width, height, passes) {
    let result = arr;
    for (let i = 0; i < passes; i++) result = blur(result, width, height);
    return result;
  }

  // Get source data at working resolution
  const srcData = getSourceData(src, pw, ph);
  const srcArr = toFloat(srcData);

  // Create offset version (shifted by half)
  const offCanvas = document.createElement('canvas');
  offCanvas.width = pw; offCanvas.height = ph;
  const octx = offCanvas.getContext('2d');
  const ohx = Math.floor(pw / 2);
  const ohy = Math.floor(ph / 2);
  octx.drawImage(src, 0, 0, w, h); // draw at original then we'll shift pixels
  const offData = octx.getImageData(0, 0, pw, ph);
  // Manual pixel shift for precision
  const tmpCanvas2 = document.createElement('canvas');
  tmpCanvas2.width = pw; tmpCanvas2.height = ph;
  const tctx = tmpCanvas2.getContext('2d');
  tctx.drawImage(src, ohx, ohy, w - ohx, h - ohy, 0, 0, pw - ohx, ph - ohy);
  tctx.drawImage(src, 0, ohy, ohx, h - ohy, pw - ohx, 0, ohx, ph - ohy);
  tctx.drawImage(src, ohx, 0, w - ohx, ohy, 0, ph - ohy, pw - ohx, ohy);
  tctx.drawImage(src, 0, 0, ohx, ohy, pw - ohx, ph - ohy, ohx, ohy);
  const offArr = toFloat(tctx.getImageData(0, 0, pw, ph));

  // Build Gaussian pyramids for both
  const srcPyramid = [srcArr];
  const offPyramid = [offArr];
  for (let l = 1; l <= levels; l++) {
    const passes = Math.pow(2, l);
    srcPyramid.push(multiBlur(srcArr, pw, ph, passes));
    offPyramid.push(multiBlur(offArr, pw, ph, passes));
  }

  // Build Laplacian pyramids (difference between adjacent Gaussian levels)
  const srcLap = [];
  const offLap = [];
  for (let l = 0; l < levels; l++) {
    const n = pw * ph * 3;
    const sl = new Float32Array(n);
    const ol = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      sl[i] = srcPyramid[l][i] - srcPyramid[l + 1][i];
      ol[i] = offPyramid[l][i] - offPyramid[l + 1][i];
    }
    srcLap.push(sl);
    offLap.push(ol);
  }
  // Lowest frequency residual
  srcLap.push(srcPyramid[levels]);
  offLap.push(offPyramid[levels]);

  // Build blend masks — one per level, sharper at high freq, wider at low freq
  const masks = [];
  for (let l = 0; l <= levels; l++) {
    const mask = new Float32Array(pw * ph);
    // Blend radius grows with level
    const radius = Math.max(4, Math.floor(Math.min(pw, ph) * 0.15 * (l + 1) / levels));
    const cx = Math.floor(pw / 2);
    const cy = Math.floor(ph / 2);
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        // Distance from center (where the offset seam is)
        const dx = Math.abs(x - cx);
        const dy = Math.abs(y - cy);
        const dist = Math.max(dx, dy); // Chebyshev distance
        if (dist >= radius) {
          mask[y * pw + x] = 0; // 100% offset
        } else {
          const t = dist / radius;
          mask[y * pw + x] = 0.5 - 0.5 * Math.cos(t * Math.PI);
        }
      }
    }
    masks.push(mask);
  }

  // Blend each Laplacian level using its mask
  const blendedLap = [];
  for (let l = 0; l <= levels; l++) {
    const n = pw * ph;
    const out = new Float32Array(n * 3);
    const mask = masks[l];
    for (let i = 0; i < n; i++) {
      const m = mask[i]; // 0 = use offset, 1 = use original
      for (let c = 0; c < 3; c++) {
        out[i * 3 + c] = offLap[l][i * 3 + c] * (1 - m) + srcLap[l][i * 3 + c] * m;
      }
    }
    blendedLap.push(out);
  }

  // Reconstruct from blended Laplacian pyramid
  let result = blendedLap[levels]; // lowest freq
  for (let l = levels - 1; l >= 0; l--) {
    const n = pw * ph * 3;
    const combined = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      combined[i] = result[i] + blendedLap[l][i];
    }
    result = combined;
  }

  // Convert back to canvas
  const outData = fromFloat(result, pw, ph);
  const outCanvas = document.createElement('canvas');
  outCanvas.width = w; outCanvas.height = h;
  const outCtx = outCanvas.getContext('2d');
  // If we worked at reduced resolution, scale back up
  if (pw !== w || ph !== h) {
    const tmpC = imageDataToCanvas(outData);
    outCtx.drawImage(tmpC, 0, 0, w, h);
  } else {
    outCtx.putImageData(outData, 0, 0);
  }
  return outCanvas;
}

// === PERLIN NOISE MASK ===
// Uses 2D value noise to create an organic, irregular blend boundary.
// The noise field determines where the blend happens — no geometric regularity.
function tilePerlinNoise(src, w, h, blendPct) {
  const imgData = getSourceData(src, w, h);
  const orig = new Uint8ClampedArray(imgData.data);
  const d = imgData.data;

  // Simple 2D value noise with smooth interpolation
  const gridSize = 8; // noise cell size
  const gw = Math.ceil(w / gridSize) + 2;
  const gh = Math.ceil(h / gridSize) + 2;
  // Seed random grid — use deterministic seed so results are stable per-process
  const grid = new Float32Array(gw * gh);
  let seed = 12345;
  for (let i = 0; i < grid.length; i++) {
    seed = (seed * 16807 + 0) % 2147483647;
    grid[i] = (seed / 2147483647);
  }

  function sampleNoise(x, y) {
    const gx = x / gridSize;
    const gy = y / gridSize;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = gx - x0, fy = gy - y0;
    // Smoothstep
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const i00 = grid[((y0 % gh + gh) % gh) * gw + ((x0 % gw + gw) % gw)];
    const i10 = grid[((y0 % gh + gh) % gh) * gw + (((x0+1) % gw + gw) % gw)];
    const i01 = grid[(((y0+1) % gh + gh) % gh) * gw + ((x0 % gw + gw) % gw)];
    const i11 = grid[(((y0+1) % gh + gh) % gh) * gw + (((x0+1) % gw + gw) % gw)];
    const top = i00 * (1 - sx) + i10 * sx;
    const bot = i01 * (1 - sx) + i11 * sx;
    return top * (1 - sy) + bot * sy;
  }

  // Multi-octave noise
  function fbm(x, y) {
    let val = 0, amp = 0.5, freq = 1;
    for (let i = 0; i < 4; i++) {
      val += sampleNoise(x * freq, y * freq) * amp;
      amp *= 0.5;
      freq *= 2;
    }
    return val;
  }

  const blendDist = Math.max(4, Math.floor(Math.min(w, h) * blendPct));

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = Math.min(x, w - 1 - x);
      const dy = Math.min(y, h - 1 - y);
      const distToEdge = Math.min(dx, dy);

      if (distToEdge >= blendDist) continue;

      // Base geometric blend factor
      let t = distToEdge / blendDist;

      // Perturb with noise — noise pushes the blend boundary in and out
      const noiseVal = fbm(x, y); // 0..~1
      t = t + (noiseVal - 0.5) * 0.6;
      t = Math.max(0, Math.min(1, t));

      const a = 0.5 - 0.5 * Math.cos(t * Math.PI);

      if (a >= 0.999) continue;

      const wx = (x + Math.floor(w / 2)) % w;
      const wy = (y + Math.floor(h / 2)) % h;
      const si = (y * w + x) * 4;
      const wi = (wy * w + wx) * 4;

      for (let c = 0; c < 3; c++) {
        d[si + c] = Math.round(orig[si + c] * a + orig[wi + c] * (1 - a));
      }
    }
  }
  return imageDataToCanvas(imgData);
}

// === GRADIENT-AWARE BLEND ===
// Analyzes local contrast (Sobel-like edge magnitude) and uses it to modulate
// the blend — flat/smooth areas blend aggressively, detailed/edgy areas preserve
// their original pixels. Content-adaptive seam hiding.
function tileGradientAware(src, w, h, blendPct) {
  const imgData = getSourceData(src, w, h);
  const orig = new Uint8ClampedArray(imgData.data);
  const d = imgData.data;
  const blendDist = Math.max(4, Math.floor(Math.min(w, h) * blendPct));

  // Compute edge magnitude map (simplified Sobel on luminance)
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    lum[i] = orig[i * 4] * 0.299 + orig[i * 4 + 1] * 0.587 + orig[i * 4 + 2] * 0.114;
  }

  const edgeMag = new Float32Array(w * h);
  let maxEdge = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      // Sobel X
      const gx = -lum[(y-1)*w+(x-1)] + lum[(y-1)*w+(x+1)]
                -2*lum[y*w+(x-1)]    + 2*lum[y*w+(x+1)]
                -lum[(y+1)*w+(x-1)]  + lum[(y+1)*w+(x+1)];
      // Sobel Y
      const gy = -lum[(y-1)*w+(x-1)] - 2*lum[(y-1)*w+x] - lum[(y-1)*w+(x+1)]
                +lum[(y+1)*w+(x-1)]  + 2*lum[(y+1)*w+x] + lum[(y+1)*w+(x+1)];
      const mag = Math.sqrt(gx * gx + gy * gy);
      edgeMag[y * w + x] = mag;
      if (mag > maxEdge) maxEdge = mag;
    }
  }
  // Normalize
  if (maxEdge > 0) {
    for (let i = 0; i < edgeMag.length; i++) edgeMag[i] /= maxEdge;
  }

  // Slight blur on edge map so it's not too noisy
  const blurEdge = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, count = 0;
      for (let ky = -2; ky <= 2; ky++) {
        for (let kx = -2; kx <= 2; kx++) {
          const nx = (x + kx + w) % w;
          const ny = (y + ky + h) % h;
          sum += edgeMag[ny * w + nx];
          count++;
        }
      }
      blurEdge[y * w + x] = sum / count;
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = Math.min(x, w - 1 - x);
      const dy = Math.min(y, h - 1 - y);
      const distToEdge = Math.min(dx, dy);

      if (distToEdge >= blendDist) continue;

      let t = distToEdge / blendDist;

      // Modulate: high edge = push t toward 1 (keep original), low edge = keep t low (blend more)
      const edgeWeight = blurEdge[y * w + x];
      // Remap: where edges are strong, we want less blending (higher a)
      // edgeWeight 0 (flat) -> t stays as is or gets pushed lower
      // edgeWeight 1 (edge) -> t gets pushed toward 1
      t = t + edgeWeight * (1 - t) * 0.7;
      t = Math.max(0, Math.min(1, t));

      const a = 0.5 - 0.5 * Math.cos(t * Math.PI);

      if (a >= 0.999) continue;

      const wx = (x + Math.floor(w / 2)) % w;
      const wy = (y + Math.floor(h / 2)) % h;
      const si = (y * w + x) * 4;
      const wi = (wy * w + wx) * 4;

      for (let c = 0; c < 3; c++) {
        d[si + c] = Math.round(orig[si + c] * a + orig[wi + c] * (1 - a));
      }
    }
  }
  return imageDataToCanvas(imgData);
}

// === SINUSOIDAL WEAVE ===
// Overlapping sine waves at different frequencies along X and Y create a wavy,
// interlocking blend boundary — like fingers interlacing. Breaks up any rectangular
// or geometric pattern the eye could latch onto.
function tileWeaveBlend(src, w, h, blendPct) {
  const imgData = getSourceData(src, w, h);
  const orig = new Uint8ClampedArray(imgData.data);
  const d = imgData.data;
  const blendDist = Math.max(4, Math.floor(Math.min(w, h) * blendPct));

  // Pre-compute wavy boundary offsets for each edge
  // Multiple sine waves at different frequencies create organic shapes
  function wavyOffset(pos, length) {
    return Math.sin(pos / length * Math.PI * 6) * 0.3
         + Math.sin(pos / length * Math.PI * 14 + 1.7) * 0.15
         + Math.sin(pos / length * Math.PI * 23 + 3.1) * 0.08;
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Distance to each edge, modulated by sine waves along the perpendicular axis
      const waveX = wavyOffset(y, h) * blendDist;
      const waveY = wavyOffset(x, w) * blendDist;

      const dLeft  = x + waveX;
      const dRight = (w - 1 - x) + waveX;
      const dTop   = y + waveY;
      const dBot   = (h - 1 - y) + waveY;

      const distToEdge = Math.min(dLeft, dRight, dTop, dBot);

      if (distToEdge >= blendDist) continue;
      if (distToEdge < 0) {
        // Fully in blend zone — use wrapped pixel entirely
        const wx = (x + Math.floor(w / 2)) % w;
        const wy = (y + Math.floor(h / 2)) % h;
        const si = (y * w + x) * 4;
        const wi = (wy * w + wx) * 4;
        for (let c = 0; c < 3; c++) d[si + c] = orig[wi + c];
        continue;
      }

      const t = distToEdge / blendDist;
      const a = 0.5 - 0.5 * Math.cos(Math.max(0, Math.min(1, t)) * Math.PI);

      const wx = (x + Math.floor(w / 2)) % w;
      const wy = (y + Math.floor(h / 2)) % h;
      const si = (y * w + x) * 4;
      const wi = (wy * w + wx) * 4;

      for (let c = 0; c < 3; c++) {
        d[si + c] = Math.round(orig[si + c] * a + orig[wi + c] * (1 - a));
      }
    }
  }
  return imageDataToCanvas(imgData);
}

// === MIRROR FOLD ===
// Mirrors image at edges so they naturally meet themselves — guaranteed seamless
function tileMirrorFold(src, w, h, blendPct) {
  const imgData = getSourceData(src, w, h);
  const orig = new Uint8ClampedArray(imgData.data);
  const d = imgData.data;
  const blendDist = Math.max(2, Math.floor(Math.min(w, h) * blendPct));
  const hw = w / 2, hh = h / 2;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Distance to nearest edge
      const dx = Math.min(x, w - 1 - x);
      const dy = Math.min(y, h - 1 - y);
      const distToEdge = Math.min(dx, dy);

      if (distToEdge >= blendDist) continue; // fully original

      // Mirrored coordinates
      const mx = x < hw ? x : w - 1 - x;
      const my = y < hh ? y : h - 1 - y;

      // Blend factor: 0 at edge (use mirrored), 1 at threshold (use original)
      const t = distToEdge / blendDist;
      const a = 0.5 - 0.5 * Math.cos(t * Math.PI);

      const si = (y * w + x) * 4;
      const mi = (my * w + mx) * 4;

      for (let c = 0; c < 3; c++) {
        d[si + c] = Math.round(orig[si + c] * a + orig[mi + c] * (1 - a));
      }
    }
  }
  return imageDataToCanvas(imgData);
}

// === ROTATIONAL TILE (180°) ===
// Blends image with its 180° rotated copy — opposite edges align naturally
function tileRotational(src, w, h, blendPct) {
  const imgData = getSourceData(src, w, h);
  const orig = new Uint8ClampedArray(imgData.data);
  const d = imgData.data;
  const cx = (w - 1) / 2, cy = (h - 1) / 2;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Radial distance from center, normalized to [0,1]
      const nx = Math.abs(x - cx) / cx;
      const ny = Math.abs(y - cy) / cy;
      const dist = Math.max(nx, ny); // Chebyshev distance

      // Blend zone: from (1 - blendPct) to 1
      const threshold = 1 - blendPct;
      if (dist <= threshold) continue; // fully original

      // Blend factor: 0 = original, 1 = rotated
      const t = (dist - threshold) / blendPct;
      const blend = 0.5 - 0.5 * Math.cos(t * Math.PI);

      // 180° rotated coordinates
      const rx = w - 1 - x;
      const ry = h - 1 - y;

      const si = (y * w + x) * 4;
      const ri = (ry * w + rx) * 4;

      for (let c = 0; c < 3; c++) {
        d[si + c] = Math.round(orig[si + c] * (1 - blend) + orig[ri + c] * blend);
      }
    }
  }
  return imageDataToCanvas(imgData);
}

// === JIGSAW INTERLEAVE ===
// Puzzle-piece shaped seam boundary using circular bumps along edges
function tileJigsawInterleave(src, w, h, blendPct) {
  const imgData = getSourceData(src, w, h);
  const orig = new Uint8ClampedArray(imgData.data);
  const d = imgData.data;
  const blendDist = Math.max(4, Math.floor(Math.min(w, h) * blendPct));

  // Deterministic pseudo-random
  let seed = 54321;
  function rand() {
    seed = (seed * 16807 + 0) % 2147483647;
    return seed / 2147483647;
  }

  // Generate bumps for each edge
  const numBumps = 8;
  const bumpRadius = blendDist * 0.6;
  const bumps = []; // {edge, pos, dir, cx, cy}

  // Top/bottom edge bumps (along x axis)
  for (let i = 0; i < numBumps; i++) {
    const pos = (i + 0.5) / numBumps * w;
    const dir = rand() > 0.5 ? 1 : -1;
    bumps.push({ cx: pos, cy: 0, axis: 'h', dir });
    bumps.push({ cx: pos, cy: h, axis: 'h', dir: -dir });
  }
  // Left/right edge bumps (along y axis)
  for (let i = 0; i < numBumps; i++) {
    const pos = (i + 0.5) / numBumps * h;
    const dir = rand() > 0.5 ? 1 : -1;
    bumps.push({ cx: 0, cy: pos, axis: 'v', dir });
    bumps.push({ cx: w, cy: pos, axis: 'v', dir: -dir });
  }

  // For each pixel compute the perturbed distance-to-edge
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Base distances to each edge
      let dLeft = x, dRight = w - 1 - x, dTop = y, dBot = h - 1 - y;

      // Apply bump perturbations
      for (const b of bumps) {
        let along, perp;
        if (b.axis === 'h') {
          // Horizontal edge bump — affects top or bottom distance
          along = x - b.cx;
          const distAlong = Math.abs(along);
          if (distAlong < bumpRadius) {
            const offset = b.dir * bumpRadius * (1 - (distAlong / bumpRadius) * (distAlong / bumpRadius));
            if (b.cy === 0) dTop += offset;
            else dBot += offset;
          }
        } else {
          // Vertical edge bump — affects left or right distance
          along = y - b.cy;
          const distAlong = Math.abs(along);
          if (distAlong < bumpRadius) {
            const offset = b.dir * bumpRadius * (1 - (distAlong / bumpRadius) * (distAlong / bumpRadius));
            if (b.cx === 0) dLeft += offset;
            else dRight += offset;
          }
        }
      }

      const distToEdge = Math.min(dLeft, dRight, dTop, dBot);

      if (distToEdge >= blendDist) continue;

      const wx = (x + Math.floor(w / 2)) % w;
      const wy = (y + Math.floor(h / 2)) % h;
      const si = (y * w + x) * 4;
      const wi = (wy * w + wx) * 4;

      if (distToEdge <= 0) {
        // Fully wrapped
        for (let c = 0; c < 3; c++) d[si + c] = orig[wi + c];
        continue;
      }

      // Narrow cosine-smooth transition
      const t = Math.min(1, distToEdge / blendDist);
      const a = 0.5 - 0.5 * Math.cos(t * Math.PI);

      for (let c = 0; c < 3; c++) {
        d[si + c] = Math.round(orig[si + c] * a + orig[wi + c] * (1 - a));
      }
    }
  }
  return imageDataToCanvas(imgData);
}

// === PATCH STAMP ===
// Samples patches from image interior and stamps them over seam zones
function tilePatchStamp(src, w, h, blendPct) {
  // Start with a crossfade base
  const baseCanvas = tileCrossFade(src, w, h, blendPct);
  const baseData = getSourceData(baseCanvas, w, h);
  const base = baseData.data;

  const origData = getSourceData(src, w, h);
  const orig = origData.data;

  const blendDist = Math.max(4, Math.floor(Math.min(w, h) * blendPct));
  const patchSize = Math.max(3, Math.floor(blendDist / 2));
  const halfPatch = Math.floor(patchSize / 2);

  // Interior region bounds (center, far from edges)
  const margin = blendDist + patchSize;
  const intLeft = margin, intTop = margin;
  const intRight = w - margin, intBot = h - margin;

  if (intRight <= intLeft || intBot <= intTop) {
    // Image too small for patch stamping, return crossfade base
    return baseCanvas;
  }

  // Deterministic RNG
  let seed = 31415;
  function rand() {
    seed = (seed * 16807 + 0) % 2147483647;
    return seed / 2147483647;
  }

  // Compute luminance at a position
  function lum(data, x, y) {
    const i = (y * w + x) * 4;
    return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
  }

  // For seam zone pixels, stamp interior patches
  // Work in patch-sized steps along the seam zone
  const stepSize = Math.max(2, Math.floor(patchSize * 0.7));

  for (let py = -halfPatch; py < h + halfPatch; py += stepSize) {
    for (let px = -halfPatch; px < w + halfPatch; px += stepSize) {
      // Check if this patch overlaps the seam zone
      const cx = px + halfPatch;
      const cy = py + halfPatch;
      const dx = Math.min(cx, w - 1 - cx);
      const dy = Math.min(cy, h - 1 - cy);
      const distToEdge = Math.min(dx, dy);

      if (distToEdge >= blendDist || distToEdge < 0) continue;

      // Find a matching interior patch by luminance similarity
      const targetLum = (cx >= 0 && cx < w && cy >= 0 && cy < h) ? lum(orig, Math.max(0, Math.min(w - 1, cx)), Math.max(0, Math.min(h - 1, cy))) : 128;

      let bestX = intLeft, bestY = intTop, bestDiff = Infinity;
      const numCandidates = 8;
      for (let t = 0; t < numCandidates; t++) {
        const sx = Math.floor(intLeft + rand() * (intRight - intLeft - patchSize));
        const sy = Math.floor(intTop + rand() * (intBot - intTop - patchSize));
        const srcLum = lum(orig, sx + halfPatch, sy + halfPatch);
        const diff = Math.abs(srcLum - targetLum);
        if (diff < bestDiff) { bestDiff = diff; bestX = sx; bestY = sy; }
      }

      // Stamp the patch with cosine falloff at edges
      for (let dy2 = 0; dy2 < patchSize; dy2++) {
        for (let dx2 = 0; dx2 < patchSize; dx2++) {
          const tx = px + dx2, ty = py + dy2;
          if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue;

          // Check this pixel is in seam zone
          const edx = Math.min(tx, w - 1 - tx);
          const edy = Math.min(ty, h - 1 - ty);
          const edist = Math.min(edx, edy);
          if (edist >= blendDist) continue;

          // Cosine falloff from patch center
          const pcx = dx2 - halfPatch, pcy = dy2 - halfPatch;
          const pdist = Math.sqrt(pcx * pcx + pcy * pcy) / halfPatch;
          if (pdist > 1) continue;
          const patchAlpha = 0.5 + 0.5 * Math.cos(pdist * Math.PI);

          // Seam zone strength: stronger near edges
          const seamStr = 1 - edist / blendDist;
          const alpha = patchAlpha * seamStr;

          const si = bestX + dx2;
          const sy2 = bestY + dy2;
          if (si >= w || sy2 >= h) continue;

          const srcIdx = (sy2 * w + si) * 4;
          const dstIdx = (ty * w + tx) * 4;

          for (let c = 0; c < 3; c++) {
            base[dstIdx + c] = Math.round(base[dstIdx + c] * (1 - alpha) + orig[srcIdx + c] * alpha);
          }
        }
      }
    }
  }

  return imageDataToCanvas(baseData);
}

// === MIN-COST SEAM ===
// Finds optimal cut through overlap zone using dynamic programming (Efros-Freeman quilting)
function tileMinCostSeam(src, w, h, blendPct) {
  // Create offset version (same as offset method)
  const preCanvas = document.createElement('canvas');
  preCanvas.width = w; preCanvas.height = h;
  const pctx = preCanvas.getContext('2d');
  const hx = Math.floor(w / 2);
  const hy = Math.floor(h / 2);
  pctx.drawImage(src, hx, hy, w - hx, h - hy, 0, 0, w - hx, h - hy);
  pctx.drawImage(src, 0, hy, hx, h - hy, w - hx, 0, hx, h - hy);
  pctx.drawImage(src, hx, 0, w - hx, hy, 0, h - hy, w - hx, hy);
  pctx.drawImage(src, 0, 0, hx, hy, w - hx, h - hy, hx, hy);

  const offsetData = pctx.getImageData(0, 0, w, h);
  const od = offsetData.data;
  const origData = getSourceData(src, w, h);
  const origD = origData.data;

  const blendW = Math.max(4, Math.floor(w * blendPct));
  const blendH = Math.max(4, Math.floor(h * blendPct));
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  const soften = 3; // blur radius along seam

  // --- Vertical seam (along the vertical center stripe) ---
  const vLeft = cx - blendW, vRight = cx + blendW;
  const vW = vRight - vLeft;
  if (vW > 0 && vLeft >= 0 && vRight <= w) {
    // Cost map
    const cost = new Float32Array(h * vW);
    for (let y = 0; y < h; y++) {
      for (let i = 0; i < vW; i++) {
        const x = vLeft + i;
        const idx = (y * w + x) * 4;
        const dr = od[idx] - origD[idx];
        const dg = od[idx + 1] - origD[idx + 1];
        const db = od[idx + 2] - origD[idx + 2];
        cost[y * vW + i] = Math.sqrt(dr * dr + dg * dg + db * db);
      }
    }

    // DP accumulation (top to bottom)
    const dp = new Float32Array(h * vW);
    for (let i = 0; i < vW; i++) dp[i] = cost[i];
    for (let y = 1; y < h; y++) {
      for (let i = 0; i < vW; i++) {
        let best = dp[(y - 1) * vW + i];
        if (i > 0) best = Math.min(best, dp[(y - 1) * vW + i - 1]);
        if (i < vW - 1) best = Math.min(best, dp[(y - 1) * vW + i + 1]);
        dp[y * vW + i] = cost[y * vW + i] + best;
      }
    }

    // Backtrack to find seam path
    const seamX = new Int32Array(h);
    let minVal = Infinity, minIdx = 0;
    for (let i = 0; i < vW; i++) {
      if (dp[(h - 1) * vW + i] < minVal) { minVal = dp[(h - 1) * vW + i]; minIdx = i; }
    }
    seamX[h - 1] = minIdx;
    for (let y = h - 2; y >= 0; y--) {
      let best = seamX[y + 1];
      let bestVal = dp[y * vW + best];
      if (best > 0 && dp[y * vW + best - 1] < bestVal) { bestVal = dp[y * vW + best - 1]; best = best - 1; }
      if (best < vW - 1 && dp[y * vW + best + 1] < bestVal) { best = best + 1; }
      seamX[y] = best;
    }

    // Apply: left of seam = offset, right of seam = original, with narrow soften
    for (let y = 0; y < h; y++) {
      const seamPos = vLeft + seamX[y];
      for (let i = 0; i < vW; i++) {
        const x = vLeft + i;
        const idx = (y * w + x) * 4;
        const distFromSeam = i - seamX[y];
        if (Math.abs(distFromSeam) <= soften) {
          // Soft blend near seam
          const t = (distFromSeam + soften) / (soften * 2);
          const a = 0.5 - 0.5 * Math.cos(t * Math.PI);
          for (let c = 0; c < 3; c++) {
            od[idx + c] = Math.round(od[idx + c] * (1 - a) + origD[idx + c] * a);
          }
        } else if (distFromSeam > soften) {
          // Right side: use original
          for (let c = 0; c < 3; c++) od[idx + c] = origD[idx + c];
        }
        // Left side: keep offset (already there)
      }
    }
  }

  // --- Horizontal seam (along the horizontal center stripe) ---
  const hTop = cy - blendH, hBot = cy + blendH;
  const hH = hBot - hTop;
  if (hH > 0 && hTop >= 0 && hBot <= h) {
    // Cost map
    const cost = new Float32Array(hH * w);
    for (let j = 0; j < hH; j++) {
      const y = hTop + j;
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        const dr = od[idx] - origD[idx];
        const dg = od[idx + 1] - origD[idx + 1];
        const db = od[idx + 2] - origD[idx + 2];
        cost[j * w + x] = Math.sqrt(dr * dr + dg * dg + db * db);
      }
    }

    // DP accumulation (left to right)
    const dp = new Float32Array(hH * w);
    for (let j = 0; j < hH; j++) dp[j * w] = cost[j * w];
    for (let x = 1; x < w; x++) {
      for (let j = 0; j < hH; j++) {
        let best = dp[j * w + x - 1];
        if (j > 0) best = Math.min(best, dp[(j - 1) * w + x - 1]);
        if (j < hH - 1) best = Math.min(best, dp[(j + 1) * w + x - 1]);
        dp[j * w + x] = cost[j * w + x] + best;
      }
    }

    // Backtrack
    const seamY = new Int32Array(w);
    let minVal = Infinity, minIdx = 0;
    for (let j = 0; j < hH; j++) {
      if (dp[j * w + w - 1] < minVal) { minVal = dp[j * w + w - 1]; minIdx = j; }
    }
    seamY[w - 1] = minIdx;
    for (let x = w - 2; x >= 0; x--) {
      let best = seamY[x + 1];
      let bestVal = dp[best * w + x];
      if (best > 0 && dp[(best - 1) * w + x] < bestVal) { bestVal = dp[(best - 1) * w + x]; best = best - 1; }
      if (best < hH - 1 && dp[(best + 1) * w + x] < bestVal) { best = best + 1; }
      seamY[x] = best;
    }

    // Apply: above seam = offset, below seam = original, with narrow soften
    for (let x = 0; x < w; x++) {
      const seamPos = hTop + seamY[x];
      for (let j = 0; j < hH; j++) {
        const y = hTop + j;
        const idx = (y * w + x) * 4;
        const distFromSeam = j - seamY[x];
        if (Math.abs(distFromSeam) <= soften) {
          const t = (distFromSeam + soften) / (soften * 2);
          const a = 0.5 - 0.5 * Math.cos(t * Math.PI);
          for (let c = 0; c < 3; c++) {
            od[idx + c] = Math.round(od[idx + c] * (1 - a) + origD[idx + c] * a);
          }
        } else if (distFromSeam > soften) {
          for (let c = 0; c < 3; c++) od[idx + c] = origD[idx + c];
        }
      }
    }
  }

  pctx.putImageData(offsetData, 0, 0);
  return preCanvas;
}

// ===================== ILLUMINATION NORMALIZATION =====================
// Samples lightness on a grid, interpolates a lightness map, and compensates
// each pixel to even out uneven lighting (dark corners, bright spots, etc.)
function applyLightingNormalize(src, w, h, gridSize, strength) {
  const imgData = getSourceData(src, w, h);
  const d = imgData.data;
  const n = w * h;

  // Step 1: Compute average luminance in each grid cell
  const gw = gridSize, gh = gridSize;
  const cellW = w / gw, cellH = h / gh;
  const gridLum = new Float32Array(gw * gh);
  const gridCount = new Uint32Array(gw * gh);

  for (let y = 0; y < h; y++) {
    const gy = Math.min(gh - 1, Math.floor(y / cellH));
    for (let x = 0; x < w; x++) {
      const gx = Math.min(gw - 1, Math.floor(x / cellW));
      const i = (y * w + x) * 4;
      const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      const gi = gy * gw + gx;
      gridLum[gi] += lum;
      gridCount[gi]++;
    }
  }

  // Average each cell
  for (let i = 0; i < gw * gh; i++) {
    gridLum[i] = gridCount[i] > 0 ? gridLum[i] / gridCount[i] : 128;
  }

  // Step 2: Compute global average luminance
  let globalLum = 0;
  for (let i = 0; i < gw * gh; i++) globalLum += gridLum[i];
  globalLum /= (gw * gh);
  if (globalLum < 1) globalLum = 1; // avoid division by zero

  // Step 3: Bilinearly interpolate the grid into a per-pixel lightness map
  // and apply multiplicative correction
  for (let y = 0; y < h; y++) {
    // Map pixel center to grid coordinates (cell centers)
    const gy = (y + 0.5) / cellH - 0.5;
    const gy0 = Math.max(0, Math.floor(gy));
    const gy1 = Math.min(gh - 1, gy0 + 1);
    const fy = gy - gy0;

    for (let x = 0; x < w; x++) {
      const gx = (x + 0.5) / cellW - 0.5;
      const gx0 = Math.max(0, Math.floor(gx));
      const gx1 = Math.min(gw - 1, gx0 + 1);
      const fx = gx - gx0;

      // Bilinear interpolation of local luminance
      const top = gridLum[gy0 * gw + gx0] * (1 - fx) + gridLum[gy0 * gw + gx1] * fx;
      const bot = gridLum[gy1 * gw + gx0] * (1 - fx) + gridLum[gy1 * gw + gx1] * fx;
      const localLum = top * (1 - fy) + bot * fy;

      if (localLum < 1) continue; // skip near-black to avoid blowout

      // Multiplicative correction: pixel * (globalAvg / localAvg)
      // Blend with strength: factor = lerp(1, globalAvg/localAvg, strength)
      const correction = globalLum / localLum;
      const factor = 1 + (correction - 1) * strength;

      const i = (y * w + x) * 4;
      d[i]     = clamp(Math.round(d[i] * factor));
      d[i + 1] = clamp(Math.round(d[i + 1] * factor));
      d[i + 2] = clamp(Math.round(d[i + 2] * factor));
    }
  }

  return imageDataToCanvas(imgData);
}

// === CROSS-TEXTURE STAMP ===
// Stamps interior patches across tile boundaries (wrapping around edges) to
// disguise where one tile copy ends and the next begins.
// Patches are centered ON the texture edges and wrap, so they literally
// straddle two adjacent tile copies.
function applyCrossTextureStamp(src, w, h, density, patchPct, opacity, centerSpread) {
  const imgData = getSourceData(src, w, h);
  const orig = new Uint8ClampedArray(imgData.data);
  const d = imgData.data;

  const minDim = Math.min(w, h);
  const patchSize = Math.max(3, Math.floor(minDim * patchPct));
  const halfPatch = Math.floor(patchSize / 2);

  // Deterministic RNG
  let seed = 57721;
  function rand() {
    seed = (seed * 16807 + 0) % 2147483647;
    return seed / 2147483647;
  }

  // Luminance + variance for a patch region (with wrapping)
  function patchStats(data, px, py) {
    let sumL = 0, sumL2 = 0, count = 0;
    for (let dy = 0; dy < patchSize; dy++) {
      for (let dx = 0; dx < patchSize; dx++) {
        const x = ((px + dx) % w + w) % w;
        const y = ((py + dy) % h + h) % h;
        const i = (y * w + x) * 4;
        const l = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        sumL += l;
        sumL2 += l * l;
        count++;
      }
    }
    const mean = sumL / count;
    return { mean, variance: sumL2 / count - mean * mean };
  }

  // Interior region for sourcing patches (center of texture, away from edges)
  const margin = Math.max(patchSize, Math.floor(minDim * 0.2));
  const srcLeft = margin, srcTop = margin;
  const srcRight = w - margin, srcBot = h - margin;

  if (srcRight <= srcLeft || srcBot <= srcTop) {
    return src; // image too small
  }

  // Build candidate pool from interior
  const numCandidates = Math.min(64, Math.max(16, Math.floor(
    Math.sqrt((w * h) / (patchSize * patchSize)) * 4)));
  const candidates = [];
  for (let i = 0; i < numCandidates; i++) {
    const cx = Math.floor(srcLeft + rand() * (srcRight - srcLeft - patchSize));
    const cy = Math.floor(srcTop + rand() * (srcBot - srcTop - patchSize));
    candidates.push({ x: cx, y: cy, ...patchStats(orig, cx, cy) });
  }

  // Place stamps along all 4 edges.
  // Density controls how many stamps per edge and how much jitter off the edge.
  // At each edge, stamps are centered right on the boundary (x=0, x=w-1, y=0, y=h-1)
  // with some random offset so they straddle the seam.
  const stepSize = Math.max(2, Math.floor(patchSize * (1.1 - density * 0.6)));
  // How far off the exact edge line a stamp center can drift (in pixels)
  const jitter = Math.floor(halfPatch * density);

  // Edges: [start coord, end coord, is-horizontal, edge-position]
  const edges = [
    { len: w, horiz: true,  pos: 0 },     // top edge (y=0)
    { len: w, horiz: true,  pos: h - 1 },  // bottom edge (y=h-1)
    { len: h, horiz: false, pos: 0 },      // left edge (x=0)
    { len: h, horiz: false, pos: w - 1 },  // right edge (x=w-1)
  ];

  for (const edge of edges) {
    for (let along = -halfPatch; along < edge.len + halfPatch; along += stepSize) {
      // Random jitter along and perpendicular to the edge
      const jitterAlong = Math.floor((rand() - 0.5) * stepSize * 0.8);
      const jitterPerp = Math.floor((rand() - 0.5) * 2 * jitter);

      let tx, ty;
      if (edge.horiz) {
        tx = along + jitterAlong - halfPatch;
        ty = edge.pos + jitterPerp - halfPatch;
      } else {
        ty = along + jitterAlong - halfPatch;
        tx = edge.pos + jitterPerp - halfPatch;
      }

      // Find best matching candidate by luminance + variance
      const target = patchStats(d, tx, ty);
      let bestIdx = 0, bestScore = Infinity;
      for (let c = 0; c < candidates.length; c++) {
        const meanDiff = Math.abs(candidates[c].mean - target.mean);
        const varDiff = Math.abs(Math.sqrt(Math.max(0, candidates[c].variance)) -
                                 Math.sqrt(Math.max(0, target.variance)));
        const score = meanDiff + varDiff * 0.5;
        if (score < bestScore) { bestScore = score; bestIdx = c; }
      }

      const srcPatch = candidates[bestIdx];

      // Stamp with radial cosine falloff, writing with wrapping
      for (let dy = 0; dy < patchSize; dy++) {
        for (let dx = 0; dx < patchSize; dx++) {
          // Wrap destination coordinates so stamps cross tile boundaries
          const dstX = ((tx + dx) % w + w) % w;
          const dstY = ((ty + dy) % h + h) % h;

          const srcX = srcPatch.x + dx;
          const srcY = srcPatch.y + dy;
          if (srcX >= w || srcY >= h) continue;

          // Radial falloff from patch center
          const pcx = (dx - halfPatch) / halfPatch;
          const pcy = (dy - halfPatch) / halfPatch;
          const pDist = Math.sqrt(pcx * pcx + pcy * pcy);
          if (pDist > 1) continue;

          const alpha = (0.5 + 0.5 * Math.cos(pDist * Math.PI)) * opacity;
          if (alpha < 0.003) continue;

          const si = (srcY * w + srcX) * 4;
          const di = (dstY * w + dstX) * 4;

          for (let ch = 0; ch < 3; ch++) {
            d[di + ch] = Math.round(d[di + ch] * (1 - alpha) + orig[si + ch] * alpha);
          }
        }
      }
    }
  }

  // Optional: scatter stamps across the interior too
  if (centerSpread > 0) {
    const interiorArea = (srcRight - srcLeft) * (srcBot - srcTop);
    const numInterior = Math.max(2, Math.floor(
      interiorArea * centerSpread * 1.5 / (patchSize * patchSize)));

    for (let s = 0; s < numInterior; s++) {
      const tx = Math.floor(srcLeft + rand() * (srcRight - srcLeft - patchSize));
      const ty = Math.floor(srcTop + rand() * (srcBot - srcTop - patchSize));

      const target = patchStats(d, tx, ty);
      let bestIdx = 0, bestScore = Infinity;
      for (let c = 0; c < candidates.length; c++) {
        const meanDiff = Math.abs(candidates[c].mean - target.mean);
        const varDiff = Math.abs(Math.sqrt(Math.max(0, candidates[c].variance)) -
                                 Math.sqrt(Math.max(0, target.variance)));
        const score = meanDiff + varDiff * 0.5;
        if (score < bestScore) { bestScore = score; bestIdx = c; }
      }

      const srcPatch = candidates[bestIdx];
      const interiorOpacity = opacity * centerSpread;

      for (let dy = 0; dy < patchSize; dy++) {
        for (let dx = 0; dx < patchSize; dx++) {
          const dstX = tx + dx, dstY = ty + dy;
          if (dstX < 0 || dstX >= w || dstY < 0 || dstY >= h) continue;

          const srcX = srcPatch.x + dx, srcY = srcPatch.y + dy;
          if (srcX >= w || srcY >= h) continue;

          const pcx = (dx - halfPatch) / halfPatch;
          const pcy = (dy - halfPatch) / halfPatch;
          const pDist = Math.sqrt(pcx * pcx + pcy * pcy);
          if (pDist > 1) continue;

          const alpha = (0.5 + 0.5 * Math.cos(pDist * Math.PI)) * interiorOpacity;
          if (alpha < 0.003) continue;

          const si = (srcY * w + srcX) * 4;
          const di = (dstY * w + dstX) * 4;

          for (let ch = 0; ch < 3; ch++) {
            d[di + ch] = Math.round(d[di + ch] * (1 - alpha) + orig[si + ch] * alpha);
          }
        }
      }
    }
  }

  return imageDataToCanvas(imgData);
}

// Dispatcher
function applyTileBlend(src, w, h, method, blendPct, pyramidLevels) {
  switch (method) {
    case 'crossfade': return tileCrossFade(src, w, h, blendPct);
    case 'offset': return tileOffsetBlend(src, w, h, blendPct);
    case 'diamond': return tileDiamondBlend(src, w, h, blendPct);
    case 'perlin': return tilePerlinNoise(src, w, h, blendPct);
    case 'gradaware': return tileGradientAware(src, w, h, blendPct);
    case 'weave': return tileWeaveBlend(src, w, h, blendPct);
    case 'multiscale': return tileMultiScaleBlend(src, w, h, pyramidLevels);
    case 'mirror': return tileMirrorFold(src, w, h, blendPct);
    case 'rotate': return tileRotational(src, w, h, blendPct);
    case 'jigsaw': return tileJigsawInterleave(src, w, h, blendPct);
    case 'stamp': return tilePatchStamp(src, w, h, blendPct);
    case 'mincut': return tileMinCostSeam(src, w, h, blendPct);
    default: return src;
  }
}
