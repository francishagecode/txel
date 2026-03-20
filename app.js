// ===================== STATE =====================
const RES_STEPS = [8, 16, 32, 64, 128, 256, 512, 1024];
function getResolution() { return RES_STEPS[parseInt(document.getElementById('resolution').value)]; }

let sourceImage = null;
let sourceData = null;
let currentView = 'result';
let tileGridVisible = true;
let outlineColorMode = 'black';
let noiseType = 'mono';
let processing = false;
let processQueued = false;
let lastSmallCanvas = null;

// Cache for expensive pre-processing (crop + tile + downscale)
let _preCache = { key: '', data: null, tw: 0, th: 0, sw: 0, sh: 0 };

// Custom palettes from Lospec import (persisted in localStorage)
let customPalettes = {};

// ===================== LOSPEC PALETTE IMPORT =====================
function parseLospecPalette(text) {
  const lines = text.split(/\r?\n/);
  let name = 'Imported Palette';
  const colors = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith(';')) {
      const nameMatch = trimmed.match(/;Palette Name:\s*(.+)/i);
      if (nameMatch) name = nameMatch[1].trim();
      continue;
    }
    // Data line: AARRGGBB (8 hex chars) or RRGGBB (6 hex chars)
    const hexMatch = trimmed.match(/^([0-9a-fA-F]{6,8})$/);
    if (hexMatch) {
      const hex = hexMatch[1];
      let r, g, b;
      if (hex.length === 8) {
        // AARRGGBB — skip alpha
        r = parseInt(hex.slice(2, 4), 16);
        g = parseInt(hex.slice(4, 6), 16);
        b = parseInt(hex.slice(6, 8), 16);
      } else {
        r = parseInt(hex.slice(0, 2), 16);
        g = parseInt(hex.slice(2, 4), 16);
        b = parseInt(hex.slice(4, 6), 16);
      }
      colors.push([r, g, b]);
    }
  }
  return { name, colors };
}

function saveCustomPalettes() {
  localStorage.setItem('txel_customPalettes', JSON.stringify(customPalettes));
}

function loadCustomPalettes() {
  try {
    const stored = localStorage.getItem('txel_customPalettes');
    if (stored) customPalettes = JSON.parse(stored);
  } catch(e) { customPalettes = {}; }
}

function generatePaletteKey(name) {
  // Create a unique key from the name
  let key = 'imported_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  // Ensure uniqueness
  let base = key, i = 2;
  while (customPalettes[key]) { key = base + '_' + i; i++; }
  return key;
}

function addCustomPaletteToDropdown(key, name, colorCount) {
  const select = document.getElementById('paletteMode');
  const marker = select.querySelector('option[value="customImported"]');
  if (!marker) return;
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = 'Custom: ' + name + ' (' + colorCount + ')';
  // Insert after the marker
  marker.after(opt);
}

function removeCustomPalette(key) {
  delete customPalettes[key];
  saveCustomPalettes();
  // Remove from dropdown
  const opt = document.querySelector('#paletteMode option[value="' + key + '"]');
  if (opt) opt.remove();
  // If currently selected, reset
  if (document.getElementById('paletteMode').value === key) {
    document.getElementById('paletteMode').value = 'none';
    processImage();
  }
  renderCustomPaletteList();
}

function renderCustomPaletteList() {
  const container = document.getElementById('customPaletteList');
  if (!container) return;
  const keys = Object.keys(customPalettes);
  if (keys.length === 0) { container.innerHTML = ''; return; }
  container.innerHTML = keys.map(key => {
    const pal = customPalettes[key];
    return '<div class="custom-pal-entry">' +
      '<span class="pal-name">' + pal.name + '</span>' +
      '<span class="pal-count">' + pal.colors.length + 'c</span>' +
      '<button class="pal-delete" onclick="removeCustomPalette(\'' + key + '\')" title="Delete">&times;</button>' +
      '</div>';
  }).join('');
}

function importPaletteFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    const result = parseLospecPalette(e.target.result);
    if (result.colors.length === 0) return;
    const key = generatePaletteKey(result.name);
    customPalettes[key] = { name: result.name, colors: result.colors };
    saveCustomPalettes();
    addCustomPaletteToDropdown(key, result.name, result.colors.length);
    renderCustomPaletteList();
    // Select the imported palette
    document.getElementById('paletteMode').value = key;
    processImage();
  };
  reader.readAsText(file);
}

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

// ===================== PALETTES =====================
const PALETTES = {
  pal_gameboy: [[15,56,15],[48,98,48],[139,172,15],[155,188,15]],
  pal_nes: [
    [124,124,124],[0,0,252],[0,0,188],[68,40,188],[148,0,132],[168,0,32],[168,16,0],[120,40,0],
    [0,120,0],[0,104,0],[0,88,0],[0,64,88],[0,0,0],[0,0,0],[0,0,0],[188,188,188],
    [0,120,248],[0,88,248],[104,68,252],[216,0,204],[228,0,88],[248,56,0],[228,92,16],[172,124,0],
    [0,184,0],[0,168,0],[0,168,68],[0,136,136],[0,0,0],[0,0,0],[0,0,0],[248,248,248],
    [60,188,252],[104,136,252],[152,120,248],[248,120,248],[248,88,152],[248,120,88],[252,160,68],[248,184,0],
    [184,248,24],[88,216,84],[88,248,152],[0,232,216],[120,120,120],[0,0,0],[0,0,0],[252,252,252],
    [164,228,252],[184,184,248],[216,184,248],[248,184,248],[248,164,192],[240,208,176],[252,224,168],[248,216,120],
    [216,248,120],[184,248,184],[184,248,216],[0,252,252],[216,216,216],[0,0,0],[0,0,0]
  ],
  pal_cga: [
    [0,0,0],[0,0,170],[0,170,0],[0,170,170],[170,0,0],[170,0,170],[170,85,0],[170,170,170],
    [85,85,85],[85,85,255],[85,255,85],[85,255,255],[255,85,85],[255,85,255],[255,255,85],[255,255,255]
  ],
  pal_c64: [
    [0,0,0],[255,255,255],[136,0,0],[170,255,238],[204,68,204],[0,204,85],[0,0,170],[238,238,119],
    [221,136,85],[102,68,0],[255,119,119],[51,51,51],[119,119,119],[170,255,102],[0,136,255],[187,187,187]
  ],
  pal_pico8: [
    [0,0,0],[29,43,83],[126,37,83],[0,135,81],[171,82,54],[95,87,79],[194,195,199],[255,241,232],
    [255,0,77],[255,163,0],[255,236,39],[0,228,54],[41,173,255],[131,118,156],[255,119,168],[255,204,170]
  ],
  pal_sweetie16: [
    [26,28,44],[93,39,93],[177,62,83],[239,125,87],[255,205,117],[167,240,112],[56,183,100],[37,113,121],
    [41,54,111],[59,93,201],[65,166,246],[115,239,247],[244,244,244],[148,176,194],[86,108,134],[51,60,87]
  ],
  pal_endesga32: [
    [190,74,47],[215,118,67],[234,212,170],[228,166,114],[184,111,80],[115,62,57],[62,39,49],[162,38,51],
    [228,59,68],[247,118,34],[255,204,170],[232,183,150],[194,133,105],[18,78,137],[0,153,219],[44,232,245],
    [0,135,81],[171,82,54],[0,0,0],[27,38,50],[64,67,78],[96,103,108],[148,161,167],[196,207,209],
    [255,255,255],[155,173,183],[132,126,135],[105,106,106],[75,90,82],[40,56,46],[26,28,44],[93,39,93]
  ],
  pal_lospec500: [
    [16,0,20],[43,15,84],[99,36,100],[207,55,93],[242,147,131],[245,230,203],[102,194,164],[40,135,162],
    [36,59,97],[15,27,56],[35,25,23],[84,42,14],[168,68,0],[219,117,0],[255,190,11],[255,237,81]
  ]
};

// ===================== BAYER MATRICES =====================
const BAYER2 = [[0,2],[3,1]];
const BAYER4 = [
  [0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]
];
const BAYER8 = [
  [0,32,8,40,2,34,10,42],[48,16,56,24,50,18,58,26],
  [12,44,4,36,14,46,6,38],[60,28,52,20,62,30,54,22],
  [3,35,11,43,1,33,9,41],[51,19,59,27,49,17,57,25],
  [15,47,7,39,13,45,5,37],[63,31,55,23,61,29,53,21]
];

// ===================== HELPERS =====================
function clamp(v, lo = 0, hi = 255) { return v < lo ? lo : v > hi ? hi : v; }

function colorDist(r1,g1,b1,r2,g2,b2) {
  const dr=r1-r2, dg=g1-g2, db=b1-b2;
  return dr*dr + dg*dg + db*db;
}

function findClosest(r, g, b, palette) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const d = colorDist(r, g, b, palette[i][0], palette[i][1], palette[i][2]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return palette[best];
}

function generateUniformPalette(steps) {
  const pal = [];
  for (let r = 0; r < steps; r++)
    for (let g = 0; g < steps; g++)
      for (let b = 0; b < steps; b++)
        pal.push([Math.round(r*255/(steps-1)), Math.round(g*255/(steps-1)), Math.round(b*255/(steps-1))]);
  return pal;
}

function generateGrayPalette(n) {
  const pal = [];
  for (let i = 0; i < n; i++) {
    const v = Math.round(i * 255 / (n - 1));
    pal.push([v, v, v]);
  }
  return pal;
}

// RGB 332
function rgb332Palette() {
  const pal = [];
  for (let r = 0; r < 8; r++)
    for (let g = 0; g < 8; g++)
      for (let b = 0; b < 4; b++)
        pal.push([Math.round(r*255/7), Math.round(g*255/7), Math.round(b*255/3)]);
  return pal;
}

// Median cut
function medianCut(imageData, numColors) {
  const pixels = [];
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i+3] > 128) pixels.push([d[i], d[i+1], d[i+2]]);
  }
  if (pixels.length === 0) return [[0,0,0]];

  function splitBucket(bucket) {
    let minR=255,maxR=0,minG=255,maxG=0,minB=255,maxB=0;
    for (const p of bucket) {
      if(p[0]<minR)minR=p[0]; if(p[0]>maxR)maxR=p[0];
      if(p[1]<minG)minG=p[1]; if(p[1]>maxG)maxG=p[1];
      if(p[2]<minB)minB=p[2]; if(p[2]>maxB)maxB=p[2];
    }
    const rRange=maxR-minR, gRange=maxG-minG, bRange=maxB-minB;
    let ch = 0;
    if (gRange >= rRange && gRange >= bRange) ch = 1;
    else if (bRange >= rRange && bRange >= gRange) ch = 2;
    bucket.sort((a,b) => a[ch] - b[ch]);
    const mid = Math.floor(bucket.length / 2);
    return [bucket.slice(0, mid), bucket.slice(mid)];
  }

  let buckets = [pixels];
  while (buckets.length < numColors) {
    let maxIdx = 0, maxLen = 0;
    for (let i = 0; i < buckets.length; i++) {
      if (buckets[i].length > maxLen) { maxLen = buckets[i].length; maxIdx = i; }
    }
    if (maxLen <= 1) break;
    const [a, b] = splitBucket(buckets[maxIdx]);
    buckets.splice(maxIdx, 1, a, b);
  }

  return buckets.map(bucket => {
    let rSum=0, gSum=0, bSum=0;
    for (const p of bucket) { rSum+=p[0]; gSum+=p[1]; bSum+=p[2]; }
    const n = bucket.length || 1;
    return [Math.round(rSum/n), Math.round(gSum/n), Math.round(bSum/n)];
  });
}

// ===================== HSL helpers for adjustments =====================
function rgbToHsl(r, g, b) {
  r/=255; g/=255; b/=255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b);
  let h, s, l=(max+min)/2;
  if (max===min) { h=s=0; }
  else {
    const d=max-min;
    s = l>0.5 ? d/(2-max-min) : d/(max+min);
    switch(max) {
      case r: h=((g-b)/d+(g<b?6:0))/6; break;
      case g: h=((b-r)/d+2)/6; break;
      case b: h=((r-g)/d+4)/6; break;
    }
  }
  return [h*360, s*100, l*100];
}

function hslToRgb(h, s, l) {
  h/=360; s/=100; l/=100;
  let r, g, b;
  if (s===0) { r=g=b=l; }
  else {
    const hue2rgb = (p,q,t) => {
      if(t<0)t+=1; if(t>1)t-=1;
      if(t<1/6)return p+(q-p)*6*t;
      if(t<1/2)return q;
      if(t<2/3)return p+(q-p)*(2/3-t)*6;
      return p;
    };
    const q = l<0.5 ? l*(1+s) : l+s-l*s;
    const p = 2*l-q;
    r = hue2rgb(p,q,h+1/3);
    g = hue2rgb(p,q,h);
    b = hue2rgb(p,q,h-1/3);
  }
  return [Math.round(r*255), Math.round(g*255), Math.round(b*255)];
}

// ===================== TILE BLEND METHODS =====================

// Helper: get pixel data from a canvas/image source
function getSourceData(src, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

// Helper: create canvas from ImageData
function imageDataToCanvas(imgData) {
  const c = document.createElement('canvas');
  c.width = imgData.width; c.height = imgData.height;
  c.getContext('2d').putImageData(imgData, 0, 0);
  return c;
}

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
    default: return src;
  }
}

// ===================== UNDO / REDO =====================
const _undoStack = [];
const _redoStack = [];
const _maxUndo = 40;
let _undoLock = false;

// All control IDs to snapshot
const _snapshotIds = [
  'resolution','downscaleMethod','ditherMode','ditherStrength','paletteMode','medianColors',
  'brightness','contrast','saturation','hueShift',
  'sharpenAmount','noiseAmount','alphaMode','colorKeyTolerance','lumaThreshold','colorKeyPick',
  'outlineEnabled','outlineThreshold',
  'tileEnabled','tileMethod','blendWidth','edgeMix','edgeMatchEnabled','pyramidLevels',
  'squareCrop','panX','panY','cropZoom',
  'lightNormEnabled','lightNormGrid','lightNormStr',
  'edgePreserve','edgeSensitivity',
  'harmonyMode','harmonyStrength'
];

function takeSnapshot() {
  const snap = {};
  _snapshotIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    snap[id] = el.type === 'checkbox' ? el.checked : el.value;
  });
  snap._outlineColorMode = outlineColorMode;
  snap._noiseType = noiseType;
  snap._curveChannel = curveChannel;
  snap._curvePoints = JSON.stringify(curvePoints);
  return snap;
}

function restoreSnapshot(snap) {
  _undoLock = true;
  _snapshotIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el || !(id in snap)) return;
    if (el.type === 'checkbox') el.checked = snap[id];
    else el.value = snap[id];
  });
  outlineColorMode = snap._outlineColorMode || 'black';
  noiseType = snap._noiseType || 'mono';

  // Restore curve
  curveChannel = snap._curveChannel || 'rgb';
  if (snap._curvePoints) curvePoints = JSON.parse(snap._curvePoints);
  buildCurveLUT();
  renderCurve();

  // Update toggle button visuals
  document.querySelectorAll('[data-outline]').forEach(b => b.classList.toggle('active', b.dataset.outline === outlineColorMode));
  document.querySelectorAll('[data-noise]').forEach(b => b.classList.toggle('active', b.dataset.noise === noiseType));
  document.querySelectorAll('[data-curve]').forEach(b => b.classList.toggle('active', b.dataset.curve === curveChannel));

  // Show/hide conditional controls
  document.getElementById('cropControls').style.display = document.getElementById('squareCrop').checked ? 'block' : 'none';
  document.getElementById('tileControls').style.display = document.getElementById('tileEnabled').checked ? 'block' : 'none';
  document.getElementById('medianCutControls').style.display = document.getElementById('paletteMode').value === 'median' ? 'block' : 'none';
  const am = document.getElementById('alphaMode').value;
  document.getElementById('colorKeyControls').style.display = am === 'colorkey' ? 'block' : 'none';
  document.getElementById('lumaThreshControls').style.display = (am === 'luma' || am === 'lumaInv') ? 'block' : 'none';
  document.getElementById('outputCanvas').classList.toggle('pannable', document.getElementById('squareCrop').checked);
  document.getElementById('lightNormControls').style.display = document.getElementById('lightNormEnabled').checked ? 'block' : 'none';
  document.getElementById('edgePreserveControls').style.display = document.getElementById('edgePreserve').checked ? 'block' : 'none';
  document.getElementById('harmonyControls').style.display = document.getElementById('harmonyMode').value !== 'none' ? 'block' : 'none';

  _preCache.key = '';
  updateAllLabels();
  processImage();
  _undoLock = false;
}

function pushUndo() {
  if (_undoLock) return;
  const snap = takeSnapshot();
  // Don't push if identical to top of stack
  if (_undoStack.length > 0 && JSON.stringify(_undoStack[_undoStack.length-1]) === JSON.stringify(snap)) return;
  _undoStack.push(snap);
  if (_undoStack.length > _maxUndo) _undoStack.shift();
  _redoStack.length = 0; // clear redo on new action
  updateUndoButtons();
}

function undo() {
  if (_undoStack.length < 2) return;
  _redoStack.push(_undoStack.pop()); // current state → redo
  restoreSnapshot(_undoStack[_undoStack.length - 1]);
  updateUndoButtons();
}

function redo() {
  if (_redoStack.length === 0) return;
  const snap = _redoStack.pop();
  _undoStack.push(snap);
  restoreSnapshot(snap);
  updateUndoButtons();
}

function updateUndoButtons() {
  document.getElementById('undoBtn').disabled = _undoStack.length < 2;
  document.getElementById('redoBtn').disabled = _redoStack.length === 0;
}

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
});

// Debounced undo push (don't snapshot on every slider tick)
let _undoPushTimer = null;
function schedulePushUndo() {
  if (_undoLock) return;
  clearTimeout(_undoPushTimer);
  _undoPushTimer = setTimeout(() => pushUndo(), 300);
}

// ===================== TONE CURVE =====================
let curveChannel = 'rgb';
// Each channel has its own set of control points: {x:0-255, y:0-255}
// Always has endpoints at 0 and 255
let curvePoints = {
  rgb: [{x:0,y:0},{x:255,y:255}],
  r: [{x:0,y:0},{x:255,y:255}],
  g: [{x:0,y:0},{x:255,y:255}],
  b: [{x:0,y:0},{x:255,y:255}]
};
// Precomputed LUTs (256 entries per channel)
let curveLUT = { rgb: null, r: null, g: null, b: null };

function setCurveChannel(el) {
  document.querySelectorAll('[data-curve]').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  curveChannel = el.dataset.curve;
  renderCurve();
}

function resetCurve() {
  curvePoints[curveChannel] = [{x:0,y:0},{x:255,y:255}];
  buildCurveLUT();
  renderCurve();
  schedulePushUndo();
  processDebounced();
}

// Monotone cubic spline interpolation (Fritsch-Carlson)
function splineInterpolate(points) {
  const n = points.length;
  if (n < 2) return new Uint8Array(256);
  const lut = new Uint8Array(256);

  if (n === 2) {
    // Linear
    for (let i = 0; i < 256; i++) {
      const t = (i - points[0].x) / (points[1].x - points[0].x);
      lut[i] = clamp(Math.round(points[0].y + t * (points[1].y - points[0].y)));
    }
    return lut;
  }

  // Compute slopes
  const dx = [], dy = [], m = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(points[i+1].x - points[i].x);
    dy.push(points[i+1].y - points[i].y);
    m.push(dy[i] / (dx[i] || 1));
  }

  // Tangents (Fritsch-Carlson monotone)
  const tangents = [m[0]];
  for (let i = 1; i < n - 1; i++) {
    if (m[i-1] * m[i] <= 0) tangents.push(0);
    else tangents.push(2 / (1/m[i-1] + 1/m[i]));
  }
  tangents.push(m[n-2]);

  // Evaluate for each x
  for (let x = 0; x < 256; x++) {
    // Find segment
    let seg = 0;
    for (let i = 0; i < n - 1; i++) {
      if (x >= points[i].x) seg = i;
    }
    const x0 = points[seg].x, x1 = points[seg+1].x;
    const y0 = points[seg].y, y1 = points[seg+1].y;
    const h = x1 - x0 || 1;
    const t = (x - x0) / h;
    const t2 = t * t, t3 = t2 * t;
    // Hermite basis
    const h00 = 2*t3 - 3*t2 + 1;
    const h10 = t3 - 2*t2 + t;
    const h01 = -2*t3 + 3*t2;
    const h11 = t3 - t2;
    const val = h00 * y0 + h10 * h * tangents[seg] + h01 * y1 + h11 * h * tangents[seg+1];
    lut[x] = clamp(Math.round(val));
  }
  return lut;
}

function buildCurveLUT() {
  for (const ch of ['rgb','r','g','b']) {
    const pts = curvePoints[ch].slice().sort((a,b) => a.x - b.x);
    curveLUT[ch] = splineInterpolate(pts);
  }
}

function applyCurveLUT(r, g, b) {
  // Apply channel-specific curves, then the master RGB curve
  if (curveLUT.r) r = curveLUT.r[r];
  if (curveLUT.g) g = curveLUT.g[g];
  if (curveLUT.b) b = curveLUT.b[b];
  if (curveLUT.rgb) { r = curveLUT.rgb[r]; g = curveLUT.rgb[g]; b = curveLUT.rgb[b]; }
  return [r, g, b];
}

function isCurveActive() {
  for (const ch of ['rgb','r','g','b']) {
    const pts = curvePoints[ch];
    if (pts.length !== 2) return true;
    if (pts[0].x !== 0 || pts[0].y !== 0 || pts[1].x !== 255 || pts[1].y !== 255) return true;
  }
  return false;
}

// Render the SVG curve and control points
function renderCurve() {
  const pts = curvePoints[curveChannel].slice().sort((a,b) => a.x - b.x);
  const lut = splineInterpolate(pts);

  // Build SVG path from LUT
  let pathD = `M 0 ${256 - lut[0]}`;
  for (let x = 1; x < 256; x++) {
    pathD += ` L ${x} ${256 - lut[x]}`;
  }
  document.getElementById('curvePath').setAttribute('d', pathD);

  // Set curve color based on channel
  const colors = { rgb: 'var(--accent)', r: '#ff4444', g: '#44ff44', b: '#4488ff' };
  document.getElementById('curvePath').setAttribute('stroke', colors[curveChannel] || 'var(--accent)');

  // Render control points
  const g = document.getElementById('curvePoints');
  g.innerHTML = '';
  pts.forEach((pt, i) => {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', pt.x);
    circle.setAttribute('cy', 256 - pt.y);
    circle.setAttribute('r', 5);
    circle.setAttribute('fill', colors[curveChannel] || 'var(--accent)');
    circle.setAttribute('stroke', '#fff');
    circle.setAttribute('stroke-width', '1.5');
    circle.classList.add('curve-point');
    circle.dataset.index = i;
    g.appendChild(circle);
  });
}

// Curve interaction
(function() {
  const svg = document.getElementById('curveSvg');
  let dragging = null; // index of point being dragged

  function svgCoords(e) {
    const rect = svg.getBoundingClientRect();
    const x = Math.round((e.clientX - rect.left) / rect.width * 256);
    const y = Math.round(256 - (e.clientY - rect.top) / rect.height * 256);
    return { x: clamp(x, 0, 255), y: clamp(y, 0, 255) };
  }

  svg.addEventListener('mousedown', e => {
    const pt = svgCoords(e);
    const pts = curvePoints[curveChannel];

    // Check if clicking near an existing point
    for (let i = 0; i < pts.length; i++) {
      if (Math.abs(pts[i].x - pt.x) < 10 && Math.abs(pts[i].y - pt.y) < 15) {
        dragging = i;
        e.preventDefault();
        return;
      }
    }

    // Right-click to remove (except endpoints)
    if (e.button === 2) {
      e.preventDefault();
      for (let i = 1; i < pts.length - 1; i++) {
        if (Math.abs(pts[i].x - pt.x) < 15 && Math.abs(pts[i].y - pt.y) < 20) {
          pts.splice(i, 1);
          buildCurveLUT();
          renderCurve();
          schedulePushUndo();
          processDebounced();
          return;
        }
      }
      return;
    }

    // Add new point
    pts.push(pt);
    pts.sort((a,b) => a.x - b.x);
    const newIdx = pts.indexOf(pt);
    dragging = newIdx;
    buildCurveLUT();
    renderCurve();
    schedulePushUndo();
    processDebounced();
    e.preventDefault();
  });

  svg.addEventListener('contextmenu', e => e.preventDefault());

  window.addEventListener('mousemove', e => {
    if (dragging === null) return;
    const pt = svgCoords(e);
    const pts = curvePoints[curveChannel];
    // Endpoints: lock x
    if (dragging === 0) { pts[0].y = pt.y; pts[0].x = 0; }
    else if (dragging === pts.length - 1) { pts[pts.length-1].y = pt.y; pts[pts.length-1].x = 255; }
    else {
      // Clamp x between neighbors
      const minX = pts[dragging - 1].x + 1;
      const maxX = pts[dragging + 1].x - 1;
      pts[dragging].x = clamp(pt.x, minX, maxX);
      pts[dragging].y = pt.y;
    }
    buildCurveLUT();
    renderCurve();
    processDebounced();
  });

  window.addEventListener('mouseup', () => {
    if (dragging !== null) {
      dragging = null;
      schedulePushUndo();
    }
  });
})();

// Initialize curve
buildCurveLUT();
renderCurve();

// ===================== PROCESSING =====================
function processImage() {
  if (!sourceImage) return;
  if (processing) { processQueued = true; return; }
  processing = true;

  const res = getResolution();
  const downMethod = document.getElementById('downscaleMethod').value;
  const ditherMode = document.getElementById('ditherMode').value;
  const ditherStr = parseInt(document.getElementById('ditherStrength').value) / 100;
  const palMode = document.getElementById('paletteMode').value;
  const bright = parseInt(document.getElementById('brightness').value);
  const cont = parseInt(document.getElementById('contrast').value);
  const sat = parseInt(document.getElementById('saturation').value);
  const hueShift = parseInt(document.getElementById('hueShift').value);
  const outlineOn = document.getElementById('outlineEnabled').checked;
  const outlineThresh = parseInt(document.getElementById('outlineThreshold').value);
  const tileOn = document.getElementById('tileEnabled').checked;
  const tileMethod = document.getElementById('tileMethod').value;
  const blendPct = parseInt(document.getElementById('blendWidth').value) / 100;
  const edgeMix = parseInt(document.getElementById('edgeMix').value) / 100;
  const squareCrop = document.getElementById('squareCrop').checked;
  const panXPct = parseInt(document.getElementById('panX').value) / 100;
  const panYPct = parseInt(document.getElementById('panY').value) / 100;
  const cropZoom = parseInt(document.getElementById('cropZoom').value) / 100;
  const sharpenAmt = parseInt(document.getElementById('sharpenAmount').value) / 100;
  const noiseAmt = parseInt(document.getElementById('noiseAmount').value);
  const alphaMode = document.getElementById('alphaMode').value;
  const lumaThresh = parseInt(document.getElementById('lumaThreshold').value) / 100;
  const colorKeyTol = parseInt(document.getElementById('colorKeyTolerance').value);
  const edgePreserveOn = document.getElementById('edgePreserve').checked;
  const edgeSensitivity = parseInt(document.getElementById('edgeSensitivity').value) / 100;
  const harmonyMode = document.getElementById('harmonyMode').value;
  const harmonyStr = parseInt(document.getElementById('harmonyStrength').value);

  const sw = sourceImage.naturalWidth || sourceImage.width;
  const sh = sourceImage.naturalHeight || sourceImage.height;

  // Calculate target dimensions
  let tw, th;
  if (squareCrop) {
    tw = res; th = res;
  } else {
    if (sw >= sh) { tw = res; th = Math.max(1, Math.round(res * sh / sw)); }
    else { th = res; tw = Math.max(1, Math.round(res * sw / sh)); }
  }

  // Calculate source crop rect for square crop with pan + zoom
  let srcX = 0, srcY = 0, srcW = sw, srcH = sh;
  if (squareCrop) {
    const baseCropSize = Math.min(sw, sh);
    // Zoom shrinks the crop window: at 1× = full, at 5× = 1/5th
    const cropSize = Math.max(4, Math.round(baseCropSize / cropZoom));
    srcW = cropSize;
    srcH = cropSize;
    const maxOffX = sw - cropSize;
    const maxOffY = sh - cropSize;
    srcX = Math.round(Math.max(0, maxOffX) * panXPct);
    srcY = Math.round(Math.max(0, maxOffY) * panYPct);
  }

  // Pre-step: Crop source if square crop is enabled
  // Build cache key for expensive pre-processing steps
  const lightNormOn = document.getElementById('lightNormEnabled').checked;
  const lightNormGrid = parseInt(document.getElementById('lightNormGrid').value);
  const lightNormStr = parseInt(document.getElementById('lightNormStr').value) / 100;

  const preCacheKey = [res, downMethod, squareCrop, panXPct, panYPct, cropZoom,
    tileOn, tileMethod, blendPct,
    tileOn ? document.getElementById('pyramidLevels').value : 0,
    lightNormOn, lightNormGrid, lightNormStr,
    edgePreserveOn, edgeSensitivity].join('|');

  let d, imgData, smallCanvas, sctx;

  if (_preCache.key === preCacheKey && _preCache.tw === tw && _preCache.th === th) {
    // Cache hit — reuse downscaled pixel data, skip crop + tile + downscale
    smallCanvas = document.createElement('canvas');
    smallCanvas.width = tw; smallCanvas.height = th;
    sctx = smallCanvas.getContext('2d');
    imgData = sctx.createImageData(tw, th);
    imgData.data.set(_preCache.data);
    d = imgData.data;
  } else {
    // Cache miss — run full pre-processing pipeline
  let croppedSource;
  if (squareCrop) {
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = srcW; cropCanvas.height = srcH;
    const cctx = cropCanvas.getContext('2d');
    cctx.drawImage(sourceImage, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);
    croppedSource = cropCanvas;
  } else {
    croppedSource = sourceImage;
  }
  const cw = squareCrop ? srcW : sw;
  const ch = squareCrop ? srcH : sh;

  // Pre-processing: Lighting normalization (operates at cropped source resolution)
  let normSource = croppedSource;
  if (lightNormOn && lightNormStr > 0) {
    normSource = applyLightingNormalize(croppedSource, cw, ch, lightNormGrid, lightNormStr);
  }

  // Pre-processing: Tile blend (operates at cropped source resolution)
  let tileSource = normSource;
  if (tileOn) {
    tileSource = applyTileBlend(normSource, cw, ch, tileMethod, blendPct,
      parseInt(document.getElementById('pyramidLevels').value));
  }

  // Step 1: Downscale with chosen filter
  // Get full-res source pixel data
  const fullCanvas = document.createElement('canvas');
  const fcw = (tileSource.width || tileSource.naturalWidth || cw);
  const fch = (tileSource.height || tileSource.naturalHeight || ch);
  fullCanvas.width = fcw; fullCanvas.height = fch;
  const fctx = fullCanvas.getContext('2d');
  fctx.drawImage(tileSource, 0, 0, fcw, fch);
  const fullData = fctx.getImageData(0, 0, fcw, fch).data;

  smallCanvas = document.createElement('canvas');
  smallCanvas.width = tw; smallCanvas.height = th;
  sctx = smallCanvas.getContext('2d');
  imgData = sctx.createImageData(tw, th);
  d = imgData.data;

  const scaleX = fcw / tw;
  const scaleY = fch / th;

  if (downMethod === 'nearest') {
    // Nearest neighbor: snap to center source pixel
    for (let y = 0; y < th; y++) {
      const sy = Math.min(fch - 1, Math.floor((y + 0.5) * scaleY));
      for (let x = 0; x < tw; x++) {
        const sx = Math.min(fcw - 1, Math.floor((x + 0.5) * scaleX));
        const si = (sy * fcw + sx) * 4;
        const di = (y * tw + x) * 4;
        d[di] = fullData[si]; d[di+1] = fullData[si+1]; d[di+2] = fullData[si+2]; d[di+3] = 255;
      }
    }
  } else if (downMethod === 'box') {
    // Box average: average all source pixels that fall within each output cell
    for (let y = 0; y < th; y++) {
      const sy0 = Math.floor(y * scaleY);
      const sy1 = Math.min(fch, Math.ceil((y + 1) * scaleY));
      for (let x = 0; x < tw; x++) {
        const sx0 = Math.floor(x * scaleX);
        const sx1 = Math.min(fcw, Math.ceil((x + 1) * scaleX));
        let rSum = 0, gSum = 0, bSum = 0, count = 0;
        for (let sy = sy0; sy < sy1; sy++) {
          for (let sx = sx0; sx < sx1; sx++) {
            const si = (sy * fcw + sx) * 4;
            rSum += fullData[si]; gSum += fullData[si+1]; bSum += fullData[si+2];
            count++;
          }
        }
        const di = (y * tw + x) * 4;
        d[di] = Math.round(rSum / count); d[di+1] = Math.round(gSum / count);
        d[di+2] = Math.round(bSum / count); d[di+3] = 255;
      }
    }
  } else if (downMethod === 'bilinear') {
    // Bilinear interpolation at the center of each output pixel's region
    for (let y = 0; y < th; y++) {
      const srcY = (y + 0.5) * scaleY - 0.5;
      const y0 = Math.max(0, Math.floor(srcY));
      const y1 = Math.min(fch - 1, y0 + 1);
      const fy = srcY - y0;
      for (let x = 0; x < tw; x++) {
        const srcX = (x + 0.5) * scaleX - 0.5;
        const x0 = Math.max(0, Math.floor(srcX));
        const x1 = Math.min(fcw - 1, x0 + 1);
        const fx = srcX - x0;
        const di = (y * tw + x) * 4;
        const i00 = (y0 * fcw + x0) * 4;
        const i10 = (y0 * fcw + x1) * 4;
        const i01 = (y1 * fcw + x0) * 4;
        const i11 = (y1 * fcw + x1) * 4;
        for (let c = 0; c < 3; c++) {
          const top = fullData[i00+c] * (1-fx) + fullData[i10+c] * fx;
          const bot = fullData[i01+c] * (1-fx) + fullData[i11+c] * fx;
          d[di+c] = Math.round(top * (1-fy) + bot * fy);
        }
        d[di+3] = 255;
      }
    }
  } else if (downMethod === 'lanczos') {
    // Lanczos-2 downscale: sinc-based, sharp with controlled ringing
    const a = 2; // Lanczos kernel radius
    function lanczosKernel(x) {
      if (x === 0) return 1;
      if (Math.abs(x) >= a) return 0;
      const px = Math.PI * x;
      return (Math.sin(px) / px) * (Math.sin(px / a) / (px / a));
    }
    for (let y = 0; y < th; y++) {
      const srcCY = (y + 0.5) * scaleY;
      for (let x = 0; x < tw; x++) {
        const srcCX = (x + 0.5) * scaleX;
        let rSum = 0, gSum = 0, bSum = 0, wSum = 0;
        // Sample window: a*scale pixels in each direction
        const radiusX = Math.ceil(a * scaleX);
        const radiusY = Math.ceil(a * scaleY);
        const sy0 = Math.max(0, Math.floor(srcCY - radiusY));
        const sy1 = Math.min(fch - 1, Math.ceil(srcCY + radiusY));
        const sx0 = Math.max(0, Math.floor(srcCX - radiusX));
        const sx1 = Math.min(fcw - 1, Math.ceil(srcCX + radiusX));
        for (let sy = sy0; sy <= sy1; sy++) {
          const wy = lanczosKernel((sy - srcCY) / scaleY);
          for (let sx = sx0; sx <= sx1; sx++) {
            const wx = lanczosKernel((sx - srcCX) / scaleX);
            const w = wx * wy;
            const si = (sy * fcw + sx) * 4;
            rSum += fullData[si] * w; gSum += fullData[si+1] * w; bSum += fullData[si+2] * w;
            wSum += w;
          }
        }
        const di = (y * tw + x) * 4;
        d[di] = clamp(Math.round(rSum / wSum));
        d[di+1] = clamp(Math.round(gSum / wSum));
        d[di+2] = clamp(Math.round(bSum / wSum));
        d[di+3] = 255;
      }
    }
  } else if (downMethod === 'mode') {
    // Mode: most common color in each cell (quantized to 5-bit per channel for bucketing)
    for (let y = 0; y < th; y++) {
      const sy0 = Math.floor(y * scaleY);
      const sy1 = Math.min(fch, Math.ceil((y + 1) * scaleY));
      for (let x = 0; x < tw; x++) {
        const sx0 = Math.floor(x * scaleX);
        const sx1 = Math.min(fcw, Math.ceil((x + 1) * scaleX));
        const colorCounts = new Map();
        let bestKey = 0, bestCount = 0, bestR = 0, bestG = 0, bestB = 0;
        for (let sy = sy0; sy < sy1; sy++) {
          for (let sx = sx0; sx < sx1; sx++) {
            const si = (sy * fcw + sx) * 4;
            const r = fullData[si], g = fullData[si+1], b = fullData[si+2];
            // Quantize to 5-bit for bucketing to group similar colors
            const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
            const entry = colorCounts.get(key);
            if (entry) {
              entry.count++;
              entry.rSum += r; entry.gSum += g; entry.bSum += b;
              if (entry.count > bestCount) {
                bestCount = entry.count; bestKey = key;
                bestR = entry.rSum / entry.count;
                bestG = entry.gSum / entry.count;
                bestB = entry.bSum / entry.count;
              }
            } else {
              colorCounts.set(key, { count: 1, rSum: r, gSum: g, bSum: b });
              if (1 > bestCount) {
                bestCount = 1; bestKey = key; bestR = r; bestG = g; bestB = b;
              }
            }
          }
        }
        const di = (y * tw + x) * 4;
        d[di] = Math.round(bestR); d[di+1] = Math.round(bestG);
        d[di+2] = Math.round(bestB); d[di+3] = 255;
      }
    }
  }

  // Edge-preserving blend: mix between smooth result and nearest-neighbor based on edge map
  if (edgePreserveOn && downMethod !== 'nearest' && downMethod !== 'mode') {
    // Compute edge map on full-res source
    const edgeMap = computeEdgeMap(fullData, fcw, fch);
    // Downscale edge map (max per cell)
    const smallEdge = downscaleEdgeMap(edgeMap, fcw, fch, tw, th);
    // Compute nearest-neighbor (sharp) result
    const sharpData = new Uint8ClampedArray(tw * th * 4);
    for (let y = 0; y < th; y++) {
      const sy = Math.min(fch - 1, Math.floor((y + 0.5) * scaleY));
      for (let x = 0; x < tw; x++) {
        const sx = Math.min(fcw - 1, Math.floor((x + 0.5) * scaleX));
        const si = (sy * fcw + sx) * 4;
        const di2 = (y * tw + x) * 4;
        sharpData[di2] = fullData[si];
        sharpData[di2+1] = fullData[si+1];
        sharpData[di2+2] = fullData[si+2];
        sharpData[di2+3] = 255;
      }
    }
    // Blend: result = lerp(smoothResult, sharpResult, edgeStrength * sensitivity)
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const idx = (y * tw + x) * 4;
        const blend = Math.min(1, smallEdge[y * tw + x] * edgeSensitivity * 2);
        for (let c = 0; c < 3; c++) {
          d[idx + c] = Math.round(d[idx + c] * (1 - blend) + sharpData[idx + c] * blend);
        }
      }
    }
  }

    // Save to cache
    _preCache.key = preCacheKey;
    _preCache.data = new Uint8ClampedArray(d);
    _preCache.tw = tw;
    _preCache.th = th;
    _preCache.sw = sw;
    _preCache.sh = sh;
  } // end cache miss block

  // Step 2: Adjustments (brightness, contrast, saturation, hue)
  if (bright !== 0 || cont !== 0 || sat !== 0 || hueShift !== 0) {
    const contF = (259 * (cont + 255)) / (255 * (259 - cont));
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i], g = d[i+1], b = d[i+2];
      // Brightness
      r += bright * 2.55; g += bright * 2.55; b += bright * 2.55;
      // Contrast
      if (cont !== 0) {
        r = contF * (r - 128) + 128;
        g = contF * (g - 128) + 128;
        b = contF * (b - 128) + 128;
      }
      // Saturation & Hue
      if (sat !== 0 || hueShift !== 0) {
        let [h, s, l] = rgbToHsl(clamp(r), clamp(g), clamp(b));
        if (hueShift !== 0) h = (h + hueShift) % 360;
        if (sat !== 0) s = clamp(s + sat, 0, 100);
        [r, g, b] = hslToRgb(h, s, l);
      }
      d[i] = clamp(r); d[i+1] = clamp(g); d[i+2] = clamp(b);
    }
  }

  // Step 2b: Tone curve
  if (isCurveActive()) {
    for (let i = 0; i < d.length; i += 4) {
      const [r, g, b] = applyCurveLUT(d[i], d[i+1], d[i+2]);
      d[i] = r; d[i+1] = g; d[i+2] = b;
    }
  }

  // Step 3: Get palette
  let palette = null;
  if (palMode.startsWith('pal_')) palette = PALETTES[palMode];
  else if (palMode === 'mono') palette = [[0,0,0],[255,255,255]];
  else if (palMode === 'gray4') palette = generateGrayPalette(4);
  else if (palMode === 'gray8') palette = generateGrayPalette(8);
  else if (palMode === 'gray16') palette = generateGrayPalette(16);
  else if (palMode === 'rgb8') palette = rgb332Palette();
  else if (palMode === 'rgb27') palette = generateUniformPalette(3);
  else if (palMode === 'rgb64') palette = generateUniformPalette(4);
  else if (palMode === 'median') {
    const numC = parseInt(document.getElementById('medianColors').value);
    palette = medianCut(imgData, numC);
  }
  else if (palMode.startsWith('imported_') && customPalettes[palMode]) {
    palette = customPalettes[palMode].colors;
  }

  // Step 3b: Apply palette harmony
  if (palette && harmonyMode !== 'none' && harmonyStr > 0) {
    palette = applyHarmony(palette, harmonyMode, harmonyStr);
  }

  // Step 4: Dithering + palette mapping
  if (palette) {
    if (ditherMode === 'none' || ditherStr === 0) {
      // Direct quantize
      for (let i = 0; i < d.length; i += 4) {
        const [cr, cg, cb] = findClosest(d[i], d[i+1], d[i+2], palette);
        d[i] = cr; d[i+1] = cg; d[i+2] = cb;
      }
    } else if (ditherMode.startsWith('ordered')) {
      // Ordered dithering
      let matrix, size;
      if (ditherMode === 'ordered2') { matrix = BAYER2; size = 2; }
      else if (ditherMode === 'ordered4') { matrix = BAYER4; size = 4; }
      else { matrix = BAYER8; size = 8; }
      const levels = size * size;
      for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
          const idx = (y * tw + x) * 4;
          const threshold = (matrix[y % size][x % size] / levels - 0.5) * ditherStr * 64;
          const r = clamp(d[idx] + threshold);
          const g = clamp(d[idx+1] + threshold);
          const b = clamp(d[idx+2] + threshold);
          const [cr, cg, cb] = findClosest(r, g, b, palette);
          d[idx] = cr; d[idx+1] = cg; d[idx+2] = cb;
        }
      }
    } else {
      // Error diffusion
      const diffusion = getDiffusionMatrix(ditherMode);
      const errR = new Float32Array(tw * th);
      const errG = new Float32Array(tw * th);
      const errB = new Float32Array(tw * th);
      for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
          const idx = (y * tw + x) * 4;
          const pi = y * tw + x;
          let r = clamp(d[idx] + errR[pi]);
          let g = clamp(d[idx+1] + errG[pi]);
          let b = clamp(d[idx+2] + errB[pi]);
          const [cr, cg, cb] = findClosest(r, g, b, palette);
          d[idx] = cr; d[idx+1] = cg; d[idx+2] = cb;
          const er = (r - cr) * ditherStr;
          const eg = (g - cg) * ditherStr;
          const eb = (b - cb) * ditherStr;
          for (const [dx, dy, w] of diffusion) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && nx < tw && ny >= 0 && ny < th) {
              const ni = ny * tw + nx;
              errR[ni] += er * w;
              errG[ni] += eg * w;
              errB[ni] += eb * w;
            }
          }
        }
      }
    }
  }

  // Step 5: Outline detection (on small image)
  let outlineData = null;
  if (outlineOn) {
    outlineData = new Uint8Array(tw * th);
    const t2 = outlineThresh * outlineThresh * 3;
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const idx = (y * tw + x) * 4;
        let isEdge = false;
        for (const [ox, oy] of [[1,0],[0,1],[-1,0],[0,-1]]) {
          const nx = x + ox, ny = y + oy;
          if (nx >= 0 && nx < tw && ny >= 0 && ny < th) {
            const ni = (ny * tw + nx) * 4;
            const dr = d[idx]-d[ni], dg = d[idx+1]-d[ni+1], db = d[idx+2]-d[ni+2];
            if (dr*dr + dg*dg + db*db > t2) { isEdge = true; break; }
          }
        }
        outlineData[y * tw + x] = isEdge ? 1 : 0;
      }
    }
  }

  // Apply outlines to pixel data
  if (outlineOn && outlineData) {
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        if (outlineData[y * tw + x]) {
          const idx = (y * tw + x) * 4;
          if (outlineColorMode === 'black') {
            d[idx] = 0; d[idx+1] = 0; d[idx+2] = 0;
          } else if (outlineColorMode === 'dark') {
            d[idx] = Math.floor(d[idx] * 0.25);
            d[idx+1] = Math.floor(d[idx+1] * 0.25);
            d[idx+2] = Math.floor(d[idx+2] * 0.25);
          }
        }
      }
    }
  }

  // Step 5b: Edge pixel matching for tiling (post-pixelation)
  if (tileOn && document.getElementById('edgeMatchEnabled').checked) {
    // Average left↔right columns
    for (let y = 0; y < th; y++) {
      const li = (y * tw + 0) * 4;
      const ri = (y * tw + (tw - 1)) * 4;
      for (let c = 0; c < 3; c++) {
        const avg = Math.round(d[li + c] * (1 - edgeMix) + d[ri + c] * edgeMix);
        const avg2 = Math.round(d[ri + c] * (1 - edgeMix) + d[li + c] * edgeMix);
        d[li + c] = avg;
        d[ri + c] = avg2;
      }
    }
    // Average top↔bottom rows
    for (let x = 0; x < tw; x++) {
      const ti = (0 * tw + x) * 4;
      const bi = ((th - 1) * tw + x) * 4;
      for (let c = 0; c < 3; c++) {
        const avg = Math.round(d[ti + c] * (1 - edgeMix) + d[bi + c] * edgeMix);
        const avg2 = Math.round(d[bi + c] * (1 - edgeMix) + d[ti + c] * edgeMix);
        d[ti + c] = avg;
        d[bi + c] = avg2;
      }
    }
    // Re-quantize edge pixels to palette if one is active
    if (palette) {
      // Left & right columns
      for (let y = 0; y < th; y++) {
        for (const col of [0, tw - 1]) {
          const idx = (y * tw + col) * 4;
          const [cr, cg, cb] = findClosest(d[idx], d[idx+1], d[idx+2], palette);
          d[idx] = cr; d[idx+1] = cg; d[idx+2] = cb;
        }
      }
      // Top & bottom rows
      for (let x = 0; x < tw; x++) {
        for (const row of [0, th - 1]) {
          const idx = (row * tw + x) * 4;
          const [cr, cg, cb] = findClosest(d[idx], d[idx+1], d[idx+2], palette);
          d[idx] = cr; d[idx+1] = cg; d[idx+2] = cb;
        }
      }
    }
  }

  // Step 5c: Sharpen (unsharp mask on pixelated output)
  if (sharpenAmt > 0) {
    const orig = new Uint8ClampedArray(d);
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const idx = (y * tw + x) * 4;
        for (let c = 0; c < 3; c++) {
          // Average of 4 neighbors (wrapping for tileability if tiling enabled)
          let sum = 0, count = 0;
          for (const [ox, oy] of [[1,0],[0,1],[-1,0],[0,-1]]) {
            let nx = x + ox, ny = y + oy;
            if (tileOn) {
              nx = (nx + tw) % tw;
              ny = (ny + th) % th;
            } else {
              if (nx < 0 || nx >= tw || ny < 0 || ny >= th) continue;
            }
            sum += orig[(ny * tw + nx) * 4 + c];
            count++;
          }
          const avg = sum / count;
          const diff = orig[idx + c] - avg;
          d[idx + c] = clamp(Math.round(orig[idx + c] + diff * sharpenAmt * 3));
        }
      }
    }
  }

  // Step 5d: Noise overlay
  if (noiseAmt > 0) {
    // Deterministic seed based on pixel position for stable noise
    let noiseSeed = 77777;
    const noiseScale = noiseAmt * 0.8; // max ±80 per channel at 100%
    for (let i = 0; i < d.length; i += 4) {
      if (noiseType === 'mono') {
        // Same noise value for all channels (luminance grain)
        noiseSeed = (noiseSeed * 16807) % 2147483647;
        const n = ((noiseSeed / 2147483647) - 0.5) * 2 * noiseScale;
        d[i] = clamp(d[i] + n);
        d[i+1] = clamp(d[i+1] + n);
        d[i+2] = clamp(d[i+2] + n);
      } else if (noiseType === 'color') {
        // Independent noise per channel (chromatic grain)
        for (let c = 0; c < 3; c++) {
          noiseSeed = (noiseSeed * 16807) % 2147483647;
          const n = ((noiseSeed / 2147483647) - 0.5) * 2 * noiseScale;
          d[i + c] = clamp(d[i + c] + n);
        }
      } else if (noiseType === 'dither') {
        // 1-bit noise: randomly bump whole pixel lighter or darker
        noiseSeed = (noiseSeed * 16807) % 2147483647;
        const flip = (noiseSeed / 2147483647) < (noiseAmt / 100) * 0.5;
        if (flip) {
          noiseSeed = (noiseSeed * 16807) % 2147483647;
          const dir = (noiseSeed / 2147483647) > 0.5 ? 1 : -1;
          const bump = dir * noiseScale * 0.6;
          d[i] = clamp(d[i] + bump);
          d[i+1] = clamp(d[i+1] + bump);
          d[i+2] = clamp(d[i+2] + bump);
        }
      }
    }
  }

  // Step 5e: Alpha channel
  if (alphaMode !== 'none') {
    if (alphaMode === 'source') {
      // Preserve alpha from the downscaled source — re-read it
      // The downscale step already captured alpha in imgData, but our processing
      // set d[i+3]=255 everywhere. Re-read from a clean downscale of the source.
      const alphaCanvas = document.createElement('canvas');
      alphaCanvas.width = tw; alphaCanvas.height = th;
      const actx = alphaCanvas.getContext('2d');
      actx.imageSmoothingEnabled = true;
      actx.imageSmoothingQuality = 'high';
      if (squareCrop) {
        actx.drawImage(sourceImage, srcX, srcY, srcW, srcH, 0, 0, tw, th);
      } else {
        actx.drawImage(sourceImage, 0, 0, tw, th);
      }
      const alphaData = actx.getImageData(0, 0, tw, th).data;
      for (let i = 0; i < d.length; i += 4) {
        d[i + 3] = alphaData[i + 3];
      }
    } else if (alphaMode === 'luma' || alphaMode === 'lumaInv') {
      for (let i = 0; i < d.length; i += 4) {
        let lum = (d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114) / 255;
        if (alphaMode === 'lumaInv') lum = 1 - lum;
        // Apply threshold: below threshold = 0, above = scale to 255
        const alpha = lum > lumaThresh ? Math.round(((lum - lumaThresh) / (1 - lumaThresh)) * 255) : 0;
        d[i + 3] = clamp(alpha);
      }
    } else if (alphaMode === 'colorkey') {
      const hex = document.getElementById('colorKeyPick').value;
      const kr = parseInt(hex.slice(1,3), 16);
      const kg = parseInt(hex.slice(3,5), 16);
      const kb = parseInt(hex.slice(5,7), 16);
      const tol2 = colorKeyTol * colorKeyTol * 3;
      for (let i = 0; i < d.length; i += 4) {
        const dr = d[i] - kr, dg = d[i+1] - kg, db = d[i+2] - kb;
        const dist2 = dr*dr + dg*dg + db*db;
        if (dist2 <= tol2) {
          // Fully transparent
          d[i + 3] = 0;
        } else if (dist2 <= tol2 * 4) {
          // Soft edge: partially transparent
          const t = (Math.sqrt(dist2) - Math.sqrt(tol2)) / Math.sqrt(tol2);
          d[i + 3] = clamp(Math.round(t * 255));
        } else {
          d[i + 3] = 255;
        }
      }
    }
  }

  sctx.putImageData(imgData, 0, 0);

  // Step 6: Scale up with nearest neighbor
  lastSmallCanvas = smallCanvas;
  const outCanvas = document.getElementById('outputCanvas');

  if (currentView === 'tile') {
    // 3×3 tile preview
    const tileScale = Math.max(1, Math.floor(192 / Math.max(tw, th)));
    const tilePx = tw * tileScale;
    const tilePy = th * tileScale;
    outCanvas.width = tilePx * 3;
    outCanvas.height = tilePy * 3;
    const octx = outCanvas.getContext('2d');
    octx.imageSmoothingEnabled = false;
    for (let ty = 0; ty < 3; ty++) {
      for (let tx = 0; tx < 3; tx++) {
        octx.drawImage(smallCanvas, tx * tilePx, ty * tilePy, tilePx, tilePy);
      }
    }
    // Draw subtle grid lines at tile boundaries
    if (tileGridVisible) {
      octx.strokeStyle = 'rgba(0,255,136,0.25)';
      octx.lineWidth = 1;
      for (let i = 1; i < 3; i++) {
        octx.beginPath();
        octx.moveTo(i * tilePx, 0);
        octx.lineTo(i * tilePx, outCanvas.height);
        octx.stroke();
        octx.beginPath();
        octx.moveTo(0, i * tilePy);
        octx.lineTo(outCanvas.width, i * tilePy);
        octx.stroke();
      }
    }
  } else {
    // Normal single-tile view
    const maxDim = 512;
    let scale = Math.max(1, Math.floor(maxDim / Math.max(tw, th)));
    const ow = tw * scale;
    const oh = th * scale;
    outCanvas.width = ow;
    outCanvas.height = oh;
    const octx = outCanvas.getContext('2d');
    octx.imageSmoothingEnabled = false;
    octx.drawImage(smallCanvas, 0, 0, ow, oh);
  }

  // Update info
  document.getElementById('infoSrc').textContent = `${sw}×${sh}`;
  document.getElementById('infoOut').textContent = `${tw}×${th}`;
  const displayScale = currentView === 'tile'
    ? Math.max(1, Math.floor(192 / Math.max(tw, th)))
    : Math.max(1, Math.floor(512 / Math.max(tw, th)));
  const viewLabel = currentView === 'tile' ? `${displayScale}× tile 3×3` : `${displayScale}× display`;
  document.getElementById('canvasInfo').textContent = `${sw}×${sh} → ${tw}×${th} (${viewLabel})`;

  // Count unique colors in output
  const colorSet = new Set();
  const od = sctx.getImageData(0, 0, tw, th).data;
  for (let i = 0; i < od.length; i += 4) {
    colorSet.add((od[i] << 16) | (od[i+1] << 8) | od[i+2]);
  }
  document.getElementById('infoColors').textContent = colorSet.size;
  document.getElementById('infoPalette').textContent = palette ? palette.length : 'Full';

  // Update palette preview
  updatePalettePreview(palette);

  processing = false;
  if (processQueued) {
    processQueued = false;
    requestAnimationFrame(processImage);
  }
}

function getDiffusionMatrix(mode) {
  switch(mode) {
    case 'floyd': return [[1,0,7/16],[-1,1,3/16],[0,1,5/16],[1,1,1/16]];
    case 'atkinson': return [[1,0,1/8],[2,0,1/8],[-1,1,1/8],[0,1,1/8],[1,1,1/8],[0,2,1/8]];
    case 'sierra': return [[1,0,2/4],[-1,1,1/4],[0,1,1/4]];
    case 'stucki': return [[1,0,8/42],[2,0,4/42],[-2,1,2/42],[-1,1,4/42],[0,1,8/42],[1,1,4/42],[2,1,2/42],[-2,2,1/42],[-1,2,2/42],[0,2,4/42],[1,2,2/42],[2,2,1/42]];
    default: return [[1,0,7/16],[-1,1,3/16],[0,1,5/16],[1,1,1/16]];
  }
}

function updatePalettePreview(palette) {
  const container = document.getElementById('palettePreview');
  if (!palette || palette.length > 64) { container.innerHTML = ''; return; }
  container.innerHTML = palette.map(c =>
    `<div class="palette-swatch" style="background:rgb(${c[0]},${c[1]},${c[2]})" title="rgb(${c[0]},${c[1]},${c[2]})"></div>`
  ).join('');
}

// ===================== VIEW MODES =====================
function toggleGrid(el) {
  tileGridVisible = !tileGridVisible;
  el.classList.toggle('active', tileGridVisible);
  if (sourceImage) processImage();
}

function setView(mode, el) {
  currentView = mode;
  document.querySelectorAll('.view-toggle .view-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  document.getElementById('gridToggle').style.display = mode === 'tile' ? '' : 'none';

  const wrapper = document.getElementById('canvasWrapper');
  const outCanvas = document.getElementById('outputCanvas');
  if (!sourceImage) return;

  if (mode === 'original') {
    const ctx = outCanvas.getContext('2d');
    const sw = sourceImage.naturalWidth || sourceImage.width;
    const sh = sourceImage.naturalHeight || sourceImage.height;
    const maxDim = 512;
    const scale = Math.min(maxDim / sw, maxDim / sh, 1);
    outCanvas.width = Math.round(sw * scale);
    outCanvas.height = Math.round(sh * scale);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(sourceImage, 0, 0, outCanvas.width, outCanvas.height);
  } else {
    // result, split, or tile — all go through processImage
    processImage();
  }
}

// ===================== OUTLINE COLOR =====================
function setOutlineColor(el) {
  document.querySelectorAll('[data-outline]').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  outlineColorMode = el.dataset.outline;
  processImage();
}

function setNoiseType(el) {
  document.querySelectorAll('[data-noise]').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  noiseType = el.dataset.noise;
  processImage();
}

// ===================== PRESETS =====================
function applyPreset(name) {
  const presets = {
    gameboy:  { resolution: 64, paletteMode: 'pal_gameboy', ditherMode: 'ordered2', ditherStrength: 100, brightness: 0, contrast: 0, saturation: 0, hueShift: 0 },
    pico8:   { resolution: 64, paletteMode: 'pal_pico8', ditherMode: 'floyd', ditherStrength: 100, brightness: 0, contrast: 0, saturation: 0, hueShift: 0 },
    '1bit':  { resolution: 128, paletteMode: 'mono', ditherMode: 'atkinson', ditherStrength: 100, brightness: 10, contrast: 20, saturation: 0, hueShift: 0 },
    crt:     { resolution: 128, paletteMode: 'rgb27', ditherMode: 'ordered4', ditherStrength: 80, brightness: 5, contrast: 10, saturation: 10, hueShift: 0 },
    lofi:    { resolution: 64, paletteMode: 'pal_endesga32', ditherMode: 'sierra', ditherStrength: 90, brightness: 0, contrast: 5, saturation: -10, hueShift: 0 },
    hires:   { resolution: 256, paletteMode: 'median', ditherMode: 'none', ditherStrength: 100, brightness: 0, contrast: 0, saturation: 0, hueShift: 0 },
  };
  const p = presets[name]; if (!p) return;
  // Find closest slider index for the resolution value
  let bestIdx = 0;
  for (let i = 0; i < RES_STEPS.length; i++) {
    if (Math.abs(RES_STEPS[i] - p.resolution) < Math.abs(RES_STEPS[bestIdx] - p.resolution)) bestIdx = i;
  }
  document.getElementById('resolution').value = bestIdx;
  document.getElementById('paletteMode').value = p.paletteMode;
  document.getElementById('ditherMode').value = p.ditherMode;
  document.getElementById('ditherStrength').value = p.ditherStrength;
  document.getElementById('brightness').value = p.brightness;
  document.getElementById('contrast').value = p.contrast;
  document.getElementById('saturation').value = p.saturation;
  document.getElementById('hueShift').value = p.hueShift;
  if (p.paletteMode === 'median') {
    document.getElementById('medianCutControls').style.display = 'block';
    document.getElementById('medianColors').value = 32;
    document.getElementById('medianVal').textContent = 32;
  } else {
    document.getElementById('medianCutControls').style.display = 'none';
  }
  updateAllLabels();
  processImage();
}

// ===================== EXPORT =====================
function exportImage(mode) {
  if (!sourceImage) return;
  const exportCanvas = lastSmallCanvas || document.getElementById('outputCanvas');
  if (mode === 'download') {
    const link = document.createElement('a');
    const res = getResolution();
    link.download = `pxl8_${res}x${res}.png`;
    link.href = exportCanvas.toDataURL('image/png');
    link.click();
  } else {
    exportCanvas.toBlob(blob => {
      navigator.clipboard.write([new ClipboardItem({'image/png': blob})]).catch(() => {
        exportImage('download');
      });
    });
  }
}

function resetAll() {
  _preCache.key = '';
  document.getElementById('resolution').value = 3;
  document.getElementById('downscaleMethod').value = 'box';
  document.getElementById('ditherMode').value = 'none';
  document.getElementById('ditherStrength').value = 100;
  document.getElementById('paletteMode').value = 'none';
  document.getElementById('brightness').value = 0;
  document.getElementById('contrast').value = 0;
  document.getElementById('saturation').value = 0;
  document.getElementById('hueShift').value = 0;
  document.getElementById('outlineEnabled').checked = false;
  document.getElementById('outlineThreshold').value = 30;
  document.getElementById('medianCutControls').style.display = 'none';
  document.getElementById('tileEnabled').checked = false;
  document.getElementById('tileControls').style.display = 'none';
  document.getElementById('tileMethod').value = 'crossfade';
  document.getElementById('blendWidth').value = 25;
  document.getElementById('edgeMix').value = 50;
  document.getElementById('edgeMatchEnabled').checked = true;
  document.getElementById('pyramidLevels').value = 4;
  document.getElementById('blendWidthWrap').style.display = 'block';
  document.getElementById('pyramidLevelsWrap').style.display = 'none';
  document.getElementById('methodDesc').textContent = 'Wraps edges and cross-fades overlap — smooth, preserves center.';
  document.getElementById('squareCrop').checked = false;
  document.getElementById('cropControls').style.display = 'none';
  document.getElementById('panX').value = 50;
  document.getElementById('panY').value = 50;
  document.getElementById('cropZoom').value = 100;
  document.getElementById('outputCanvas').classList.remove('pannable');
  document.getElementById('lightNormEnabled').checked = false;
  document.getElementById('lightNormControls').style.display = 'none';
  document.getElementById('lightNormGrid').value = 8;
  document.getElementById('lightNormStr').value = 100;
  document.getElementById('edgePreserve').checked = false;
  document.getElementById('edgePreserveControls').style.display = 'none';
  document.getElementById('edgeSensitivity').value = 50;
  document.getElementById('harmonyMode').value = 'none';
  document.getElementById('harmonyControls').style.display = 'none';
  document.getElementById('harmonyStrength').value = 50;
  outlineColorMode = 'black';
  noiseType = 'mono';
  document.querySelectorAll('[data-outline]').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-outline="black"]').classList.add('active');
  document.querySelectorAll('[data-noise]').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-noise="mono"]').classList.add('active');
  document.getElementById('sharpenAmount').value = 0;
  document.getElementById('noiseAmount').value = 0;
  document.getElementById('alphaMode').value = 'none';
  document.getElementById('colorKeyControls').style.display = 'none';
  document.getElementById('lumaThreshControls').style.display = 'none';
  document.getElementById('colorKeyTolerance').value = 30;
  document.getElementById('lumaThreshold').value = 50;
  document.getElementById('colorKeyPick').value = '#ff00ff';
  // Reset curves
  curveChannel = 'rgb';
  curvePoints = {
    rgb: [{x:0,y:0},{x:255,y:255}],
    r: [{x:0,y:0},{x:255,y:255}],
    g: [{x:0,y:0},{x:255,y:255}],
    b: [{x:0,y:0},{x:255,y:255}]
  };
  buildCurveLUT();
  renderCurve();
  document.querySelectorAll('[data-curve]').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-curve="rgb"]').classList.add('active');
  updateAllLabels();
  processImage();
  pushUndo();
}

// ===================== LABELS =====================
function updateAllLabels() {
  document.getElementById('resVal').textContent = getResolution();
  document.getElementById('ditherStrVal').textContent = document.getElementById('ditherStrength').value + '%';
  document.getElementById('brightVal').textContent = document.getElementById('brightness').value;
  document.getElementById('contrastVal').textContent = document.getElementById('contrast').value;
  document.getElementById('satVal').textContent = document.getElementById('saturation').value;
  document.getElementById('hueVal').textContent = document.getElementById('hueShift').value + '°';
  document.getElementById('outlineThreshVal').textContent = document.getElementById('outlineThreshold').value;
  document.getElementById('medianVal').textContent = document.getElementById('medianColors').value;
  document.getElementById('blendWidthVal').textContent = document.getElementById('blendWidth').value + '%';
  document.getElementById('edgeMixVal').textContent = document.getElementById('edgeMix').value + '%';
  document.getElementById('panXVal').textContent = document.getElementById('panX').value + '%';
  document.getElementById('panYVal').textContent = document.getElementById('panY').value + '%';
  document.getElementById('pyramidLevelsVal').textContent = document.getElementById('pyramidLevels').value;
  document.getElementById('cropZoomVal').textContent = (parseInt(document.getElementById('cropZoom').value) / 100).toFixed(1) + '×';
  document.getElementById('sharpenVal').textContent = document.getElementById('sharpenAmount').value;
  document.getElementById('noiseAmountVal').textContent = document.getElementById('noiseAmount').value;
  document.getElementById('colorKeyTolVal').textContent = document.getElementById('colorKeyTolerance').value;
  document.getElementById('lumaThreshVal').textContent = document.getElementById('lumaThreshold').value + '%';
  document.getElementById('lightNormGridVal').textContent = document.getElementById('lightNormGrid').value;
  document.getElementById('lightNormStrVal').textContent = document.getElementById('lightNormStr').value + '%';
  document.getElementById('edgeSensVal').textContent = document.getElementById('edgeSensitivity').value + '%';
  document.getElementById('harmonyStrVal').textContent = document.getElementById('harmonyStrength').value + '%';
}

// ===================== EVENT LISTENERS =====================

// Debounced process for continuous inputs (sliders, drag, scroll)
let _debounceTimer = null;
function processDebounced() {
  if (_debounceTimer) cancelAnimationFrame(_debounceTimer);
  _debounceTimer = requestAnimationFrame(() => {
    _debounceTimer = null;
    processImage();
    schedulePushUndo();
  });
}

const sliderIds = ['resolution','ditherStrength','brightness','contrast','saturation','hueShift','outlineThreshold','medianColors','blendWidth','edgeMix','panX','panY','pyramidLevels','cropZoom','sharpenAmount','noiseAmount','colorKeyTolerance','lumaThreshold','lightNormGrid','lightNormStr','edgeSensitivity','harmonyStrength'];
sliderIds.forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', () => {
    updateAllLabels();
    processDebounced();
  });
});

['downscaleMethod','ditherMode','paletteMode','alphaMode'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => {
    if (id === 'paletteMode') {
      const v = document.getElementById('paletteMode').value;
      document.getElementById('medianCutControls').style.display = v === 'median' ? 'block' : 'none';
    }
    if (id === 'downscaleMethod') {
      const filterDescs = {
        box: 'Averages all source pixels per output cell — clean, balanced.',
        nearest: 'Snaps to one source pixel — crunchy, preserves hard edges.',
        bilinear: 'Weighted interpolation at cell center — smooth, slight blur.',
        lanczos: 'Sinc-based filter — sharpest edges, slight ringing on high contrast.',
        mode: 'Picks the most frequent color per cell — great for flat-shaded source art.'
      };
      document.getElementById('filterDesc').textContent = filterDescs[document.getElementById('downscaleMethod').value] || '';
    }
    if (id === 'alphaMode') {
      const am = document.getElementById('alphaMode').value;
      document.getElementById('colorKeyControls').style.display = am === 'colorkey' ? 'block' : 'none';
      document.getElementById('lumaThreshControls').style.display = (am === 'luma' || am === 'lumaInv') ? 'block' : 'none';
    }
    processImage();
  });
});

document.getElementById('outlineEnabled').addEventListener('change', processImage);
document.getElementById('colorKeyPick').addEventListener('input', processDebounced);

// Edge preserve toggle
document.getElementById('edgePreserve').addEventListener('change', () => {
  document.getElementById('edgePreserveControls').style.display =
    document.getElementById('edgePreserve').checked ? 'block' : 'none';
  processImage();
});

// Harmony mode toggle
document.getElementById('harmonyMode').addEventListener('change', () => {
  document.getElementById('harmonyControls').style.display =
    document.getElementById('harmonyMode').value !== 'none' ? 'block' : 'none';
  processImage();
});

// Palette import
document.getElementById('importPaletteBtn').addEventListener('click', () => {
  document.getElementById('paletteFileInput').click();
});
document.getElementById('paletteFileInput').addEventListener('change', e => {
  if (e.target.files[0]) importPaletteFile(e.target.files[0]);
  e.target.value = ''; // reset so same file can be re-imported
});

document.getElementById('squareCrop').addEventListener('change', () => {
  const on = document.getElementById('squareCrop').checked;
  document.getElementById('cropControls').style.display = on ? 'block' : 'none';
  const canvas = document.getElementById('outputCanvas');
  canvas.classList.toggle('pannable', on);
  processImage();
});

// Canvas drag-to-pan for square crop
(function() {
  let dragging = false;
  let startX, startY, startPanX, startPanY;
  const canvas = document.getElementById('outputCanvas');

  canvas.addEventListener('mousedown', e => {
    if (!document.getElementById('squareCrop').checked) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startPanX = parseInt(document.getElementById('panX').value);
    startPanY = parseInt(document.getElementById('panY').value);
    e.preventDefault();
  });

  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const sw = sourceImage ? (sourceImage.naturalWidth || sourceImage.width) : 500;
    const sh = sourceImage ? (sourceImage.naturalHeight || sourceImage.height) : 500;
    const zoom = parseInt(document.getElementById('cropZoom').value) / 100;
    const baseCropSize = Math.min(sw, sh);
    const cropSize = baseCropSize / zoom;

    // Get display size of the canvas to scale drag sensitivity
    const rect = canvas.getBoundingClientRect();
    const displaySize = Math.max(rect.width, rect.height);
    // More zoomed in = smaller crop window = more sensitive panning
    const sensitivity = 100 / (displaySize * 0.8);

    const dx = (e.clientX - startX) * sensitivity;
    const dy = (e.clientY - startY) * sensitivity;

    // Invert: dragging right moves the crop window left (natural scroll feel)
    const newX = Math.max(0, Math.min(100, Math.round(startPanX - dx)));
    const newY = Math.max(0, Math.min(100, Math.round(startPanY - dy)));

    document.getElementById('panX').value = newX;
    document.getElementById('panY').value = newY;
    updateAllLabels();
    processDebounced();
  });

  window.addEventListener('mouseup', () => { dragging = false; });

  // Scroll to zoom
  canvas.addEventListener('wheel', e => {
    if (!document.getElementById('squareCrop').checked) return;
    e.preventDefault();
    const zoomEl = document.getElementById('cropZoom');
    let val = parseInt(zoomEl.value);
    // Scroll up = zoom in, scroll down = zoom out
    const step = e.deltaY < 0 ? 10 : -10;
    val = Math.max(100, Math.min(500, val + step));
    zoomEl.value = val;
    updateAllLabels();
    processDebounced();
  }, { passive: false });
})();

document.getElementById('lightNormEnabled').addEventListener('change', () => {
  document.getElementById('lightNormControls').style.display =
    document.getElementById('lightNormEnabled').checked ? 'block' : 'none';
  processImage();
});

document.getElementById('tileEnabled').addEventListener('change', () => {
  document.getElementById('tileControls').style.display =
    document.getElementById('tileEnabled').checked ? 'block' : 'none';
  processImage();
});

document.getElementById('edgeMatchEnabled').addEventListener('change', processImage);

document.getElementById('tileMethod').addEventListener('change', () => {
  const m = document.getElementById('tileMethod').value;
  const descs = {
    crossfade: 'Wraps edges and cross-fades overlap — smooth, preserves center.',
    offset: 'Classic: offsets image by half, blends the visible seam. Simple, reliable.',
    diamond: 'Diamond-shaped gradient from center — natural falloff, no axis bias.',
    perlin: 'Procedural noise blend mask — organic, irregular seam. Great for natural textures.',
    gradaware: 'Blends more in flat areas, less near edges — preserves detail, hides seams in smooth zones.',
    weave: 'Interlocking sine waves create a wavy blend boundary — breaks up rectangular artifacts.',
    multiscale: 'Laplacian pyramid blend — seamless at every frequency. Best quality, slowest.'
  };
  document.getElementById('methodDesc').textContent = descs[m] || '';
  document.getElementById('blendWidthWrap').style.display = (m === 'multiscale') ? 'none' : 'block';
  document.getElementById('pyramidLevelsWrap').style.display = (m === 'multiscale') ? 'block' : 'none';
  processImage();
});

// File loading
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');

function loadImage(file) {
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      sourceImage = img;
      _preCache.key = '';
      dropZone.classList.add('has-image');
      document.getElementById('canvasWrapper').style.display = 'flex';
      processImage();
      pushUndo(); // initial state
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

fileInput.addEventListener('change', e => {
  if (e.target.files[0]) loadImage(e.target.files[0]);
});

document.addEventListener('dragover', e => { e.preventDefault(); });
document.addEventListener('drop', e => {
  e.preventDefault();
  if (e.dataTransfer.files[0]) loadImage(e.dataTransfer.files[0]);
});

// Prevent palette mode "custom" labels from being selectable
document.getElementById('paletteMode').addEventListener('change', function() {
  if (this.value === 'custom' || this.value === 'custom2' || this.value === 'customImported') {
    this.value = 'none';
  }
});

// Load custom palettes from localStorage on startup
loadCustomPalettes();
(function() {
  const keys = Object.keys(customPalettes);
  for (const key of keys) {
    const pal = customPalettes[key];
    addCustomPaletteToDropdown(key, pal.name, pal.colors.length);
  }
  renderCustomPaletteList();
})();
