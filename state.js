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
