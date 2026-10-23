import { parseWish, type Wish, type State } from "./model";
export interface Page {
  id: string;
  name: string;
  original: string;
  processed?: string;
  width?: number;
  height?: number;
}
export interface Draft {
  byName: Record<string, Record<string, Wish>>;
  dates: string[];
  pages: Page[];
  warnings: string[];
}
export const emptyDraft = (): Draft => ({
  byName: {},
  dates: [],
  pages: [],
  warnings: [],
});
export function parseInput(raw: string, s: State, reviewed: boolean): Wish {
  const t = s.shifts.find((t) => t.code === raw.trim());
  return t
    ? { raw, kind: "fixed", code: t.code, reviewed }
    : parseWish(raw, reviewed);
}
export function mergeDraft(a: Draft, b: Draft): Draft {
  const byName = structuredClone(a.byName),
    warnings = [...a.warnings, ...b.warnings];
  for (const [name, ws] of Object.entries(b.byName)) {
    byName[name] ??= {};
    for (const [date, w] of Object.entries(ws)) {
      const prev = byName[name][date];
      byName[name][date] =
        prev && prev.raw !== w.raw
          ? {
              ...w,
              kind: "unknown",
              raw: `${prev.raw || "空欄"} / ${w.raw || "空欄"}`,
              reviewed: false,
            }
          : w;
      if (prev && prev.raw !== w.raw)
        warnings.push(`${name} ${date}：複数原本の内容が異なります`);
    }
  }
  return {
    byName,
    warnings,
    dates: [...new Set([...a.dates, ...b.dates])].sort(),
    pages: [...a.pages, ...b.pages],
  };
}
async function db() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("liberty-source-drafts", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("draft");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function saveDraft(draft: Draft) {
  const d = await db();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction("draft", "readwrite");
      tx.objectStore("draft").put(draft, "current");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    d.close();
  }
}
export async function loadDraft(): Promise<Draft | null> {
  const d = await db();
  try {
    return await new Promise((resolve, reject) => {
      const r = d.transaction("draft").objectStore("draft").get("current");
      r.onsuccess = () => resolve(r.result ?? null);
      r.onerror = () => reject(r.error);
    });
  } finally {
    d.close();
  }
}
export async function dataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
export async function imageTransform(
  raw: string,
  angle = 0,
  brightness = 100,
  contrast = 100,
) {
  const img = new Image();
  img.src = raw;
  try {
    await img.decode();
  } catch {
    throw new Error(
      "画像を開けません。HEICは写真アプリからJPEG/PNGで書き出して再度選んでください。",
    );
  }
  const factor = Math.min(1, 2400 / Math.max(img.width, img.height)),
    w = img.width * factor,
    h = img.height * factor,
    r = (angle * Math.PI) / 180,
    c = document.createElement("canvas");
  c.width = Math.ceil(Math.abs(w * Math.cos(r)) + Math.abs(h * Math.sin(r)));
  c.height = Math.ceil(Math.abs(w * Math.sin(r)) + Math.abs(h * Math.cos(r)));
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(r);
  ctx.filter = `brightness(${brightness}%) contrast(${contrast}%)`;
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  return {
    image: c.toDataURL("image/jpeg", 0.9),
    width: c.width,
    height: c.height,
  };
}
export async function pdfPages(file: File) {
  const pdf = await import("pdfjs-dist");
  pdf.GlobalWorkerOptions.workerSrc = `${process.env.NODE_ENV === "production" ? (process.env.NEXT_PUBLIC_BASE_PATH ?? "/-shift-scheduler") : ""}/pdf.worker.min.mjs`;
  const task = pdf.getDocument({ data: await file.arrayBuffer() }),
    doc = await task.promise;
  try {
    if (doc.numPages > 10)
      throw new Error("PDFは10ページ以内に分割してください");
    const result: Page[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const p = await doc.getPage(n),
        original = p.getViewport({ scale: 1 }),
        v = p.getViewport({
          scale: Math.min(2, 2400 / Math.max(original.width, original.height)),
        }),
        c = document.createElement("canvas");
      c.width = Math.ceil(v.width);
      c.height = Math.ceil(v.height);
      await p.render({ canvas: c, viewport: v }).promise;
      result.push({
        id: file.name + "#" + n,
        name: file.name + " · " + n + "ページ",
        original: c.toDataURL("image/jpeg", 0.9),
      });
      p.cleanup();
    }
    return result;
  } finally {
    await task.destroy();
  }
}
