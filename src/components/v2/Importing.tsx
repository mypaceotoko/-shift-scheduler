"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/v2/storage";
import { days, type Wish } from "@/lib/v2/model";
import {
  dataURL,
  emptyDraft,
  imageTransform,
  loadDraft,
  mergeDraft,
  parseInput,
  pdfPages,
  saveDraft,
  type Draft,
} from "@/lib/v2/importing";
import { Heading, Workflow } from "./Common";
export default function Importing() {
  const { data: s, change } = useWorkspace(),
    router = useRouter();
  const [draft, setDraft] = useState<Draft>(emptyDraft),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [progress, setProgress] = useState(0),
    [page, setPage] = useState(0),
    [angle, setAngle] = useState(0),
    [bright, setBright] = useState(100),
    [contrast, setContrast] = useState(110),
    [mapping, setMapping] = useState(false),
    [only, setOnly] = useState(false),
    [names, setNames] = useState(""),
    [start, setStart] = useState(s?.plan?.start ?? "2026-10-11"),
    [end, setEnd] = useState(s?.plan?.end ?? "2026-11-10"),
    [selected, setSelected] = useState<{ name: string; date: string } | null>(
      null,
    );
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    loadDraft()
      .then((d) => {
        if (d) setDraft(d);
        else if (s?.people.length) {
          setDraft({
            byName: Object.fromEntries(s.people.map((p) => [p.name, p.wishes])),
            dates: [
              ...new Set(s.people.flatMap((p) => Object.keys(p.wishes))),
            ].sort(),
            pages: [],
            warnings: [],
          });
        }
      })
      .catch(() =>
        setError("途中データを復元できません。ファイルを再度選べます。"),
      )
      .finally(() => setReady(true));
  }, []);
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => {
      saveDraft(draft).catch(() =>
        setError(
          "読取途中データの保存に失敗しました。画面を閉じる前に確認・反映してください。",
        ),
      );
    }, 350);
    return () => clearTimeout(t);
  }, [draft, ready]);
  if (!s) return null;
  async function selectFiles(files: FileList | null) {
    if (!files) return;
    setBusy(true);
    setError("");
    let next = draft;
    try {
      if ([...files].reduce((n, f) => n + f.size, 0) > 50 * 1024 * 1024)
        throw new Error("合計50MB以内で選択してください");
      for (const file of [...files]) {
        if (/\.(xlsx|csv)$/i.test(file.name)) {
          const { parseWorkbook } = await import("@/lib/excelImport");
          const result = parseWorkbook(await file.arrayBuffer(), {
            defaultYear: +start.slice(0, 4),
            startMonth: +start.slice(5, 7),
          });
          if (!result.dates.length || !result.members.length)
            throw new Error(
              "日付・氏名の行列を認識できません。手入力表も利用できます。",
            );
          const part = emptyDraft();
          part.dates = result.dates;
          part.warnings = [...result.warnings, ...result.errors];
          for (const r of result.records) {
            part.byName[r.memberName] ??= {};
            part.byName[r.memberName][r.date] = {
              ...parseInput(r.rawCell, s!, false),
              source: {
                file: file.name,
                cell: r.sourceSheet + "!" + r.sourceCell,
                confidence: r.confidence,
              },
            };
          }
          next = mergeDraft(next, part);
        } else if (/\.pdf$/i.test(file.name))
          next = { ...next, pages: [...next.pages, ...(await pdfPages(file))] };
        else if (
          /\.(jpg|jpeg|png|heic|heif)$/i.test(file.name) ||
          file.type.startsWith("image/")
        ) {
          const img = await imageTransform(await dataURL(file));
          next = {
            ...next,
            pages: [
              ...next.pages,
              {
                id: file.name + "#" + Date.now(),
                name: file.name,
                original: img.image,
              },
            ],
          };
        } else
          throw new Error("JPG・PNG・HEIC・PDF・XLSX・CSVを選択してください");
        setDraft(next);
        setMapping(false);
      }
      setMessage(
        "取り込みました。写真・PDFはページを選んで読み取りを実行してください。",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }
  async function ocr() {
    const source = draft.pages[page];
    if (!source) return;
    setBusy(true);
    setError("");
    setProgress(0);
    setMessage("OCRを準備しています。初回はエンジン・言語データを取得します。");
    try {
      const processed = await imageTransform(
        source.original,
        angle,
        bright,
        contrast,
      );
      const T = (await import("tesseract.js")).default;
      const r = await T.recognize(processed.image, "jpn+eng", {
        logger: (m) => {
          if (m.status === "recognizing text")
            setProgress(Math.round((m.progress ?? 0) * 100));
        },
      });
      const { extractGridFromOcr } = await import("@/lib/imageOcr");
      const grid = extractGridFromOcr(
        r.data.words.map((w) => ({
          text: w.text,
          bbox: w.bbox,
          confidence: w.confidence,
        })),
        { startYear: +start.slice(0, 4), startMonth: +start.slice(5, 7) },
      );
      if (!grid)
        throw new Error(
          "日付列と氏名行を検出できません。回転・傾きを調整するか手入力の表をご利用ください。",
        );
      const part = emptyDraft();
      part.dates = grid.dates;
      part.warnings = grid.warnings;
      for (const name of grid.members) {
        part.byName[name] = {};
        for (const date of grid.dates) {
          const metadata = grid.preferences[name][date] as {
            confidence?: number;
            sourceBox?: { x0: number; y0: number; x1: number; y1: number };
          };
          part.byName[name][date] = {
            ...parseInput(grid.cells[name][date], s!, false),
            source: {
              file: source.id,
              confidence: metadata.confidence,
              bbox: metadata.sourceBox,
            },
          };
        }
      }
      const pages = draft.pages.map((p, i) =>
        i === page
          ? {
              ...p,
              processed: processed.image,
              width: processed.width,
              height: processed.height,
            }
          : p,
      );
      setDraft(mergeDraft({ ...draft, pages }, part));
      setMapping(false);
      setMessage(
        `${grid.members.length}人・${grid.dates.length}日を読み取りました。原本の行列対応から確認してください。`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function edit(name: string, date: string, raw: string) {
    const before = draft.byName[name][date];
    setDraft({
      ...draft,
      byName: {
        ...draft.byName,
        [name]: {
          ...draft.byName[name],
          [date]: { ...parseInput(raw, s!, true), source: before?.source },
        },
      },
    });
  }
  function mark() {
    setDraft({
      ...draft,
      byName: Object.fromEntries(
        Object.entries(draft.byName).map(([n, ws]) => [
          n,
          Object.fromEntries(
            Object.entries(ws).map(([d, w]) => [
              d,
              w.kind === "unknown" ? w : { ...w, reviewed: true },
            ]),
          ),
        ]),
      ),
    });
  }
  function apply() {
    change((s) => {
      for (const [name, wishes] of Object.entries(draft.byName)) {
        const matched = s.people.find(
          (p) => p.name.replace(/\s/g, "") === name.replace(/\s/g, ""),
        );
        if (matched) matched.wishes = { ...matched.wishes, ...wishes };
        else
          s.people.push({
            id: crypto.randomUUID(),
            name,
            department: "porter",
            contract: "unknown",
            active: true,
            allowed: [],
            excluded: [],
            notes: "",
            wishes,
          });
      }
    });
    router.push("/members");
  }
  function manual() {
    const dates = days(start, end);
    if (!dates.length || dates.length > 62) {
      setError("期間は1〜62日で指定してください");
      return;
    }
    const list = names
      .split(/[\n,、]/)
      .map((n) => n.trim())
      .filter(Boolean);
    if (!list.length) {
      setError("スタッフ名を入力してください");
      return;
    }
    setDraft(
      mergeDraft(draft, {
        ...emptyDraft(),
        dates,
        byName: Object.fromEntries(
          list.map((n) => [
            n,
            Object.fromEntries(
              dates.map((d) => [
                d,
                { raw: "", kind: "unknown", reviewed: false } as Wish,
              ]),
            ),
          ]),
        ),
      }),
    );
    setMapping(false);
  }
  const source = draft.pages[page],
    active = selected
      ? draft.byName[selected.name]?.[selected.date]
      : undefined,
    unknown = Object.values(draft.byName).reduce(
      (n, ws) =>
        n +
        Object.values(ws).filter((w) => !w.reviewed || w.kind === "unknown")
          .length,
      0,
    );
  return (
    <>
      <Heading
        title="希望表の取り込み"
        subtitle="原本と照合してから、勤務希望として反映します。"
        action={<span className="badge">読取途中も端末保存</span>}
      />
      <Workflow step={draft.dates.length ? 1 : 0} />
      <section className="panel">
        <div className="form-grid">
          <label>
            開始日
            <input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label>
            終了日
            <input
              type="date"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
        </div>
        <div className="upload gap">
          <span style={{ fontSize: 30, color: "#397db7" }}>↥</span>
          <strong>希望表の写真・ファイルを選択</strong>
          <small>
            JPG / PNG / HEIC / PDF / XLSX / CSV · 複数選択可
            <br />
            合計50MBまで · PDFは10ページまで
          </small>
          <input
            aria-label="希望表ファイル"
            ref={fileRef}
            type="file"
            multiple
            disabled={busy}
            accept=".jpg,.jpeg,.png,.heic,.heif,.pdf,.xlsx,.csv"
            onChange={(e) => void selectFiles(e.target.files)}
          />
        </div>
        <p className="subtitle">
          読取は端末内で処理します。OCRエンジン・言語データを取得しますが、原本を外部APIへ送信しません。
        </p>
      </section>
      {message ? (
        <div className="notice" role="status">
          {message}
          {busy ? <progress value={progress} max={100} /> : null}
        </div>
      ) : null}
      {error ? (
        <div className="notice danger" role="alert">
          {error}
        </div>
      ) : null}
      {source ? (
        <section className="panel gap">
          <div className="panel-head">
            <h2>原本との照合</h2>
            <select
              aria-label="原本ページ"
              value={page}
              onChange={(e) => {
                setPage(+e.target.value);
                setAngle(0);
              }}
            >
              {draft.pages.map((p, i) => (
                <option key={p.id} value={i}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="two-col">
            <div className="preview">
              {source.processed ? (
                <svg
                  role="img"
                  aria-label="読取画像と選択セル"
                  viewBox={`0 0 ${source.width} ${source.height}`}
                >
                  <image
                    href={source.processed}
                    width={source.width}
                    height={source.height}
                  />
                  {active?.source?.file === source.id && active.source.bbox ? (
                    <rect
                      x={active.source.bbox.x0}
                      y={active.source.bbox.y0}
                      width={active.source.bbox.x1 - active.source.bbox.x0}
                      height={active.source.bbox.y1 - active.source.bbox.y0}
                      stroke="#0876cf"
                      fill="#268bff33"
                      strokeWidth={3}
                    />
                  ) : null}
                </svg>
              ) : (
                <img src={source.original} alt={source.name} />
              )}
            </div>
            <div className="stack">
              <label>
                回転・傾き（度）
                <input
                  type="number"
                  min={-180}
                  max={180}
                  value={angle}
                  onChange={(e) => setAngle(+e.target.value)}
                />
              </label>
              <label>
                明るさ {bright}%
                <input
                  type="range"
                  min={50}
                  max={180}
                  value={bright}
                  onChange={(e) => setBright(+e.target.value)}
                />
              </label>
              <label>
                コントラスト {contrast}%
                <input
                  type="range"
                  min={60}
                  max={200}
                  value={contrast}
                  onChange={(e) => setContrast(+e.target.value)}
                />
              </label>
              <button
                className="btn primary"
                disabled={busy}
                onClick={() => void ocr()}
              >
                {busy ? "処理中…" : "このページを読み取る"}
              </button>
              <a
                className="btn"
                href={source.original}
                download={source.name + ".jpg"}
              >
                原本画像を保存
              </a>
            </div>
          </div>
        </section>
      ) : null}
      {draft.dates.length ? (
        <section className="panel gap">
          <div className="panel-head">
            <h2>
              読取確認 <span className="badge warn">未確認 {unknown}セル</span>
            </h2>
            <label className="check">
              <input
                type="checkbox"
                checked={only}
                onChange={(e) => setOnly(e.target.checked)}
              />
              未確認だけ
            </label>
          </div>
          <p className="subtitle">
            ○ / ／ / 有給 / F / 10-16 / 18.5-
            などを入力。空欄は勤務可能と判断しません。
          </p>
          <div className="table-wrap gap">
            <table className="schedule">
              <thead>
                <tr>
                  <th>氏名 / 日付</th>
                  {draft.dates.map((d) => (
                    <th key={d}>{d.slice(5)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(draft.byName).map(([name, ws]) => (
                  <tr key={name}>
                    <th>
                      <input
                        aria-label={`氏名 ${name}`}
                        defaultValue={name}
                        style={{ width: 125 }}
                        onBlur={(e) => {
                          const n = e.target.value.trim();
                          if (n && n !== name && !draft.byName[n]) {
                            setDraft({
                              ...draft,
                              byName: Object.fromEntries(
                                Object.entries(draft.byName).map(([old, w]) => [
                                  old === name ? n : old,
                                  w,
                                ]),
                              ),
                            });
                            setMapping(false);
                          } else e.target.value = name;
                        }}
                      />
                    </th>
                    {draft.dates.map((d) => {
                      const w = ws[d],
                        unconfirmed = !w || !w.reviewed || w.kind === "unknown";
                      return (
                        <td
                          key={d}
                          style={{
                            background: unconfirmed ? "#fff9eb" : undefined,
                          }}
                        >
                          {only && !unconfirmed ? (
                            <span className="tiny">✓ 確認済</span>
                          ) : (
                            <>
                              <input
                                key={`${name}-${d}-${w?.raw}`}
                                aria-label={`${name} ${d} 希望`}
                                defaultValue={w?.raw ?? ""}
                                style={{ width: 100 }}
                                onFocus={() => {
                                  setSelected({ name, date: d });
                                  const idx = draft.pages.findIndex(
                                    (p) => p.id === w?.source?.file,
                                  );
                                  if (idx >= 0) setPage(idx);
                                }}
                                onBlur={(e) => {
                                  if (e.target.value !== (w?.raw ?? ""))
                                    edit(name, d, e.target.value);
                                }}
                              />
                              <span className="tiny">
                                {unconfirmed ? "要確認" : "✓ 確認済"}
                                {w?.source?.confidence !== undefined
                                  ? ` · ${Math.round(w.source.confidence * 100)}%`
                                  : ""}
                                {w?.source?.cell ? " · " + w.source.cell : ""}
                              </span>
                            </>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {draft.warnings.map((w, i) => (
            <p className="subtitle" key={i}>
              {w}
            </p>
          ))}
          <label className="check gap">
            <input
              type="checkbox"
              checked={mapping}
              onChange={(e) => setMapping(e.target.checked)}
            />
            原本の氏名・年月日と、表の行列対応を確認しました
          </label>
          <div className="toolbar gap">
            <button className="btn" disabled={!mapping || busy} onClick={mark}>
              判読できたセルを原本と照合済みにする
            </button>
            <button
              className="btn primary"
              disabled={!mapping || busy}
              onClick={apply}
            >
              勤務希望として反映 → スタッフ確認
            </button>
            <button
              className="btn danger"
              onClick={() => {
                if (
                  confirm(
                    "読取途中の表を空にします。反映済みの勤務希望は保持されます。",
                  )
                ) {
                  setDraft(emptyDraft());
                  setMapping(false);
                }
              }}
            >
              読取表をやり直す
            </button>
          </div>
        </section>
      ) : null}
      <details className="panel gap">
        <summary>手入力の表を用意する / 読取に失敗した場合</summary>
        <label className="gap">
          スタッフ名（1行1名）
          <textarea
            value={names}
            onChange={(e) => setNames(e.target.value)}
            rows={4}
          />
        </label>
        <button className="btn gap" onClick={manual}>
          指定期間の入力表を用意
        </button>
      </details>
    </>
  );
}
