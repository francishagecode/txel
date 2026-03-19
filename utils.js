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

function getDiffusionMatrix(mode) {
  switch(mode) {
    case 'floyd': return [[1,0,7/16],[-1,1,3/16],[0,1,5/16],[1,1,1/16]];
    case 'atkinson': return [[1,0,1/8],[2,0,1/8],[-1,1,1/8],[0,1,1/8],[1,1,1/8],[0,2,1/8]];
    case 'sierra': return [[1,0,2/4],[-1,1,1/4],[0,1,1/4]];
    case 'stucki': return [[1,0,8/42],[2,0,4/42],[-2,1,2/42],[-1,1,4/42],[0,1,8/42],[1,1,4/42],[2,1,2/42],[-2,2,1/42],[-1,2,2/42],[0,2,4/42],[1,2,2/42],[2,2,1/42]];
    default: return [[1,0,7/16],[-1,1,3/16],[0,1,5/16],[1,1,1/16]];
  }
}
