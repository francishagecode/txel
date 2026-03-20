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
    const container = document.getElementById('canvasContainer');
    const maxW = container.clientWidth - 32;
    const maxH = container.clientHeight - 32;
    const scale = Math.min(maxW / sw, maxH / sh, 1);
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
  document.getElementById('hueVal').textContent = document.getElementById('hueShift').value + '\u00B0';
  document.getElementById('outlineThreshVal').textContent = document.getElementById('outlineThreshold').value;
  document.getElementById('medianVal').textContent = document.getElementById('medianColors').value;
  document.getElementById('blendWidthVal').textContent = document.getElementById('blendWidth').value + '%';
  document.getElementById('edgeMixVal').textContent = document.getElementById('edgeMix').value + '%';
  document.getElementById('panXVal').textContent = document.getElementById('panX').value + '%';
  document.getElementById('panYVal').textContent = document.getElementById('panY').value + '%';
  document.getElementById('pyramidLevelsVal').textContent = document.getElementById('pyramidLevels').value;
  document.getElementById('cropZoomVal').textContent = (parseInt(document.getElementById('cropZoom').value) / 100).toFixed(1) + '\u00D7';
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
    multiscale: 'Laplacian pyramid blend — seamless at every frequency. Best quality, slowest.',
    mirror: 'Mirrors image at edges — guaranteed seamless, visible symmetry near borders.',
    rotate: 'Blends with 180° rotated copy — opposite edges align naturally, no axis bias.',
    jigsaw: 'Puzzle-piece shaped seam boundary — irregular, hard to detect repeating patterns.',
    stamp: 'Stamps interior patches over seam areas — organic, great for complex textures.',
    mincut: 'Finds optimal cut through overlap — sharpest result, best for structured textures.'
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

// ===================== PRESET SAVE / LOAD =====================
const PRESET_STORAGE_KEY = 'txel_saved_presets';

function getSavedPresets() {
  try { return JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY) || '[]'); }
  catch { return []; }
}

function saveSavedPresets(list) {
  localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(list));
}

function savePresetFile() {
  const name = prompt('Preset name:');
  if (!name || !name.trim()) return;
  const snap = takeSnapshot();
  const preset = { txelPreset: 1, name: name.trim(), created: new Date().toISOString(), settings: snap };
  // Save to localStorage list
  const list = getSavedPresets();
  list.push(preset);
  saveSavedPresets(list);
  renderSavedPresets();
  // Also download as file
  const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.download = name.trim().replace(/[^a-zA-Z0-9_-]/g, '_') + '.txel';
  link.href = URL.createObjectURL(blob);
  link.click();
  URL.revokeObjectURL(link.href);
}

function loadPresetFromFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const preset = JSON.parse(e.target.result);
      if (!preset.settings) { alert('Invalid preset file.'); return; }
      restoreSnapshot(preset.settings);
      pushUndo();
      // Add to saved list if not already there
      const list = getSavedPresets();
      if (!list.some(p => p.name === preset.name && p.created === preset.created)) {
        list.push(preset);
        saveSavedPresets(list);
        renderSavedPresets();
      }
    } catch { alert('Could not parse preset file.'); }
  };
  reader.readAsText(file);
}

function applyLocalPreset(index) {
  const list = getSavedPresets();
  const preset = list[index];
  if (!preset || !preset.settings) return;
  restoreSnapshot(preset.settings);
  pushUndo();
}

function deleteLocalPreset(index, evt) {
  evt.stopPropagation();
  const list = getSavedPresets();
  if (!confirm('Delete preset "' + list[index].name + '"?')) return;
  list.splice(index, 1);
  saveSavedPresets(list);
  renderSavedPresets();
}

function exportLocalPreset(index, evt) {
  evt.stopPropagation();
  const list = getSavedPresets();
  const preset = list[index];
  const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.download = preset.name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.txel';
  link.href = URL.createObjectURL(blob);
  link.click();
  URL.revokeObjectURL(link.href);
}

function renderSavedPresets() {
  const container = document.getElementById('savedPresetsList');
  const list = getSavedPresets();
  if (list.length === 0) { container.innerHTML = ''; return; }
  container.innerHTML = list.map((p, i) => {
    const desc = summarizePreset(p.settings);
    return `<div class="preset-item" onclick="applyLocalPreset(${i})">
      <div class="preset-preview saved-preset-icon">USR</div>
      <div style="flex:1;min-width:0"><div class="preset-name">${escapeHtml(p.name)}</div><div class="preset-desc">${escapeHtml(desc)}</div></div>
      <div class="preset-item-actions">
        <button class="preset-btn" onclick="exportLocalPreset(${i},event)" title="Download .txel file">↓</button>
        <button class="preset-btn preset-btn-del" onclick="deleteLocalPreset(${i},event)" title="Delete">×</button>
      </div>
    </div>`;
  }).join('');
}

function summarizePreset(s) {
  const parts = [];
  if (s.resolution) {
    const idx = parseInt(s.resolution);
    const res = RES_STEPS[idx] || s.resolution;
    parts.push(res + 'px');
  }
  if (s.paletteMode && s.paletteMode !== 'none') parts.push(s.paletteMode.replace('pal_', ''));
  if (s.ditherMode && s.ditherMode !== 'none') parts.push(s.ditherMode);
  if (s.tileEnabled === true || s.tileEnabled === 'true') parts.push('tiled');
  return parts.join(', ') || 'custom';
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

document.getElementById('presetFileInput').addEventListener('change', e => {
  if (e.target.files[0]) loadPresetFromFile(e.target.files[0]);
  e.target.value = '';
});

// Render saved presets on load
renderSavedPresets();

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
