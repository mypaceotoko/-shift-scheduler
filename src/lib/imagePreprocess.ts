"use client";

/** Image preprocessing for OCR.
 *  - Upscales small images so character strokes are at least ~30px tall.
 *  - Converts to grayscale and stretches contrast.
 *  - Optional adaptive binarization.
 *  Returns a data URL ready to feed into Tesseract.
 */

export interface PreprocessOptions {
  /** Target longest-side pixel size after scaling. */
  targetLongSide?: number;
  /** When true, also apply adaptive (Sauvola-like) thresholding. */
  binarize?: boolean;
  /** Block radius (in pixels) used for adaptive thresholding. */
  binarizeWindow?: number;
}

const DEFAULTS: Required<PreprocessOptions> = {
  targetLongSide: 2000,
  binarize: true,
  binarizeWindow: 12,
};

export async function preprocessImageForOcr(
  source: string | Blob,
  opts: PreprocessOptions = {},
): Promise<string> {
  const o = { ...DEFAULTS, ...opts };
  const img = await loadImage(source);

  const longSide = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = longSide > 0 ? Math.min(3, Math.max(1, o.targetLongSide / longSide)) : 1;
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas context unavailable");

  // High-quality scaling.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);

  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;

  // Pass 1: grayscale + collect histogram for percentile contrast stretch.
  const gray = new Uint8ClampedArray(w * h);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    // Luma (BT.601) — robust against the warm-tinted phone-camera shots
    // that often come in for handwritten shift sheets.
    const g = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114 + 500) / 1000;
    const v = g < 0 ? 0 : g > 255 ? 255 : g | 0;
    gray[j] = v;
    hist[v]++;
  }
  // 2nd / 98th percentile bounds.
  const total = w * h;
  const lowCut = total * 0.02;
  const highCut = total * 0.98;
  let lo = 0;
  let hi = 255;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= lowCut) {
      lo = v;
      break;
    }
  }
  acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= highCut) {
      hi = v;
      break;
    }
  }
  if (hi - lo < 16) {
    lo = 0;
    hi = 255;
  }
  const range = hi - lo;
  for (let j = 0; j < gray.length; j++) {
    const v = gray[j];
    let s = ((v - lo) * 255) / range;
    if (s < 0) s = 0;
    else if (s > 255) s = 255;
    gray[j] = s | 0;
  }

  let out: Uint8ClampedArray = gray;
  if (o.binarize) {
    out = adaptiveThreshold(gray, w, h, o.binarizeWindow);
  }

  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const v = out[j];
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL("image/png");
}

/** Adaptive threshold using a separable mean filter (fast box-blur).
 *  Pixel becomes white when it is brighter than (local mean - bias). */
function adaptiveThreshold(
  gray: Uint8ClampedArray,
  w: number,
  h: number,
  radius: number,
  bias = 8,
): Uint8ClampedArray {
  const blurred = boxBlur(gray, w, h, radius);
  const out = new Uint8ClampedArray(gray.length);
  for (let i = 0; i < gray.length; i++) {
    out[i] = gray[i] + bias < blurred[i] ? 0 : 255;
  }
  return out;
}

function boxBlur(src: Uint8ClampedArray, w: number, h: number, r: number): Uint16Array {
  // Two-pass box blur (horizontal then vertical) using running sums.
  const tmp = new Uint16Array(src.length);
  const out = new Uint16Array(src.length);
  const win = r * 2 + 1;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[row + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = (sum / win) | 0;
      const xAdd = clamp(x + r + 1, 0, w - 1);
      const xRem = clamp(x - r, 0, w - 1);
      sum += src[row + xAdd] - src[row + xRem];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = (sum / win) | 0;
      const yAdd = clamp(y + r + 1, 0, h - 1);
      const yRem = clamp(y - r, 0, h - 1);
      sum += tmp[yAdd * w + x] - tmp[yRem * w + x];
    }
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function loadImage(source: string | Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = typeof source === "string" ? source : URL.createObjectURL(source);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (typeof source !== "string") URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      if (typeof source !== "string") URL.revokeObjectURL(url);
      reject(new Error("Image load failed"));
    };
    img.src = url;
  });
}
