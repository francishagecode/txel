// ===================== SOBEL EDGE DETECTION =====================
function computeEdgeMap(fullData, w, h) {
  // Compute gradient magnitude using Sobel on luminance
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    lum[i] = fullData[i * 4] * 0.299 + fullData[i * 4 + 1] * 0.587 + fullData[i * 4 + 2] * 0.114;
  }
  const mag = new Float32Array(w * h);
  let maxMag = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx = -lum[(y-1)*w+(x-1)] + lum[(y-1)*w+(x+1)]
                -2*lum[y*w+(x-1)]    + 2*lum[y*w+(x+1)]
                -lum[(y+1)*w+(x-1)]  + lum[(y+1)*w+(x+1)];
      const gy = -lum[(y-1)*w+(x-1)] - 2*lum[(y-1)*w+x] - lum[(y-1)*w+(x+1)]
                +lum[(y+1)*w+(x-1)]  + 2*lum[(y+1)*w+x] + lum[(y+1)*w+(x+1)];
      const m = Math.sqrt(gx * gx + gy * gy);
      mag[y * w + x] = m;
      if (m > maxMag) maxMag = m;
    }
  }
  if (maxMag > 0) {
    for (let i = 0; i < mag.length; i++) mag[i] /= maxMag;
  }
  return mag;
}

function downscaleEdgeMap(edgeMap, srcW, srcH, tw, th) {
  // Take max gradient per output cell
  const scaleX = srcW / tw;
  const scaleY = srcH / th;
  const out = new Float32Array(tw * th);
  for (let y = 0; y < th; y++) {
    const sy0 = Math.floor(y * scaleY);
    const sy1 = Math.min(srcH, Math.ceil((y + 1) * scaleY));
    for (let x = 0; x < tw; x++) {
      const sx0 = Math.floor(x * scaleX);
      const sx1 = Math.min(srcW, Math.ceil((x + 1) * scaleX));
      let maxVal = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const v = edgeMap[sy * srcW + sx];
          if (v > maxVal) maxVal = v;
        }
      }
      out[y * tw + x] = maxVal;
    }
  }
  return out;
}

// ===================== PALETTE HARMONY =====================
function findDominantHue(palette) {
  // Weight by saturation — more saturated colors have stronger hue influence
  let hueX = 0, hueY = 0, totalWeight = 0;
  for (const [r, g, b] of palette) {
    const [h, s, l] = rgbToHsl(r, g, b);
    const weight = s / 100; // saturation 0-1
    const rad = h * Math.PI / 180;
    hueX += Math.cos(rad) * weight;
    hueY += Math.sin(rad) * weight;
    totalWeight += weight;
  }
  if (totalWeight < 0.01) return 0;
  let angle = Math.atan2(hueY / totalWeight, hueX / totalWeight) * 180 / Math.PI;
  if (angle < 0) angle += 360;
  return angle;
}

function getHarmonyTargets(dominantHue, scheme) {
  switch (scheme) {
    case 'complementary': return [dominantHue, (dominantHue + 180) % 360];
    case 'analogous': return [(dominantHue - 30 + 360) % 360, dominantHue, (dominantHue + 30) % 360];
    case 'triadic': return [dominantHue, (dominantHue + 120) % 360, (dominantHue + 240) % 360];
    case 'split': return [dominantHue, (dominantHue + 150) % 360, (dominantHue + 210) % 360];
    case 'tetradic': return [dominantHue, (dominantHue + 90) % 360, (dominantHue + 180) % 360, (dominantHue + 270) % 360];
    default: return [dominantHue];
  }
}

function hueDist(a, b) {
  // Shortest angular distance
  let d = ((b - a) % 360 + 360) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

function hueDirection(from, to) {
  // Returns signed shortest direction from -> to
  let d = ((to - from) % 360 + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

function applyHarmony(palette, scheme, strength) {
  if (scheme === 'none' || strength === 0) return palette;
  const dominantHue = findDominantHue(palette);
  const targets = getHarmonyTargets(dominantHue, scheme);
  const str = strength / 100;

  return palette.map(([r, g, b]) => {
    let [h, s, l] = rgbToHsl(r, g, b);
    // Skip near-gray colors (very low saturation)
    if (s < 3) return [r, g, b];
    // Find nearest harmony target hue
    let nearestTarget = targets[0];
    let nearestDist = hueDist(h, targets[0]);
    for (let i = 1; i < targets.length; i++) {
      const d = hueDist(h, targets[i]);
      if (d < nearestDist) { nearestDist = d; nearestTarget = targets[i]; }
    }
    // Nudge hue toward target
    const dir = hueDirection(h, nearestTarget);
    h = (h + dir * str + 360) % 360;
    return hslToRgb(h, s, l);
  });
}
