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
