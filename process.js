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
  'crossStampEnabled','crossStampDensity','crossStampSize','crossStampOpacity','crossStampCenter',
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
  const crossStampOn = document.getElementById('crossStampEnabled').checked;
  const crossStampDensity = parseInt(document.getElementById('crossStampDensity').value) / 100;
  const crossStampSize = parseInt(document.getElementById('crossStampSize').value) / 100;
  const crossStampOpacity = parseInt(document.getElementById('crossStampOpacity').value) / 100;
  const crossStampCenter = parseInt(document.getElementById('crossStampCenter').value) / 100;

  const preCacheKey = [res, downMethod, squareCrop, panXPct, panYPct, cropZoom,
    tileOn, tileMethod, blendPct,
    tileOn ? document.getElementById('pyramidLevels').value : 0,
    lightNormOn, lightNormGrid, lightNormStr,
    edgePreserveOn, edgeSensitivity,
    crossStampOn, crossStampDensity, crossStampSize, crossStampOpacity, crossStampCenter].join('|');

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

  // Pre-processing: Cross-texture stamp (operates at cropped source resolution)
  if (crossStampOn) {
    tileSource = applyCrossTextureStamp(tileSource, cw, ch,
      crossStampDensity, crossStampSize, crossStampOpacity, crossStampCenter);
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

  // Compute available space from container
  const container = document.getElementById('canvasContainer');
  const availW = container.clientWidth - 32;  // padding
  const availH = container.clientHeight - 32;

  if (currentView === 'tile') {
    // 3×3 tile preview — fit 3 tiles into available space
    const maxTileDim = Math.min(availW / 3, availH / 3);
    const tileScale = Math.max(1, Math.floor(maxTileDim / Math.max(tw, th)));
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
    // Normal single-tile view — fill available space
    const maxDim = Math.min(availW, availH);
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
  const displayMaxDim = Math.min(availW, availH);
  const displayScale = currentView === 'tile'
    ? Math.max(1, Math.floor(Math.min(availW / 3, availH / 3) / Math.max(tw, th)))
    : Math.max(1, Math.floor(displayMaxDim / Math.max(tw, th)));
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

function updatePalettePreview(palette) {
  const container = document.getElementById('palettePreview');
  if (!palette || palette.length > 64) { container.innerHTML = ''; return; }
  container.innerHTML = palette.map(c =>
    `<div class="palette-swatch" style="background:rgb(${c[0]},${c[1]},${c[2]})" title="rgb(${c[0]},${c[1]},${c[2]})"></div>`
  ).join('');
}
