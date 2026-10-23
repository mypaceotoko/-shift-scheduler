"use client";
import { useState } from "react";
import Link from "next/link";
import { useWorkspace, readLegacy } from "@/lib/v2/storage";
import { stateSchema, RULES } from "@/lib/v2/model";
import { audit } from "@/lib/v2/engine";
import { Heading, download } from "./Common";
export default function Exporting() {
  const { data: s, replace } = useWorkspace();
  const [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  if (!s) return null;
  const issues = audit(s),
    errors = issues.filter((i) => i.level === "error"),
    warnings = issues.filter((i) => i.level === "warning");
  async function excel() {
    setBusy(true);
    setError("");
    try {
      const { exportExcel } = await import("@/lib/v2/workbook");
      download(
        await exportExcel(s!),
        `LIBERTY_${s!.plan!.start}_${s!.plan!.end}.xlsx`,
      );
      setMessage(
        "6シートのExcelを書き出しました。チェックと削減集計を確認してください。",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function restore(file: File) {
    try {
      if (file.size > 15 * 1024 * 1024)
        throw new Error("JSONは15MB以内で選んでください");
      const raw = await file.text(),
        json = JSON.parse(raw),
        state =
          json.schemaVersion === 2 ? stateSchema.parse(json) : readLegacy(raw);
      if (
        !confirm(
          `${state.people.length}人のバックアップで置き換えます。現在の状態は元に戻す操作で復帰できます。`,
        )
      )
        return;
      replace(state);
      setMessage("復元しました。スタッフの契約と監査結果を確認してください。");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <Heading
        title="Excel出力とバックアップ"
        subtitle="実務用の6シートと、編集を続けられるJSONを保存します。"
        action={
          <Link className="btn" href="/schedule">
            監査に戻る
          </Link>
        }
      />
      {message ? (
        <div className="notice" role="status">
          {message}
        </div>
      ) : null}
      {error ? (
        <div className="notice danger" role="alert">
          {error}
        </div>
      ) : null}
      <section className="panel">
        <div className="panel-head">
          <h2>月間シフトをExcelに出力</h2>
          <span className="badge">.xlsx · 6シート</span>
        </div>
        <p className="muted">
          シフト案 / 希望読取 / チェック / コード設定 / 計算 / 削減集計
        </p>
        <div className="notice">
          部署別コード、実働と休憩、削減時間と8h換算日数、固定見出し、A4横の印刷設定を含みます。計算シートの数式には出力時点の計算値も保存します。
        </div>
        {errors.length ? (
          <div className="notice danger">
            ハード制約違反 {errors.length}件。監査画面で解消してください。
          </div>
        ) : null}
        {warnings.length ? (
          <div className="notice warning">
            <p>調整項目 {warnings.length}件。チェックシートに記録されます。</p>
            <label className="check gap">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              不足時間帯・人件費超過などを確認し、調整用の案として出力します
            </label>
          </div>
        ) : null}
        <button
          className="btn primary"
          disabled={
            !s.plan?.generatedAt ||
            !!errors.length ||
            (!!warnings.length && !ack) ||
            busy
          }
          onClick={() => void excel()}
        >
          {busy ? "Excelを作成中…" : "↓ 6シートのExcelを保存"}
        </button>
      </section>
      <div className="form-grid gap">
        <section className="panel">
          <h2>編集データを保存</h2>
          <p className="subtitle">
            スタッフ・希望・コード・設定・生成案を保存し、別端末へ移せます。
          </p>
          <button
            className="btn gap"
            onClick={() =>
              download(
                new Blob(
                  [
                    JSON.stringify(
                      {
                        ...s,
                        ruleVersion: RULES.version,
                        exportedAt: new Date().toISOString(),
                      },
                      null,
                      2,
                    ),
                  ],
                  { type: "application/json" },
                ),
                "LIBERTY_backup.json",
              )
            }
          >
            JSONを書き出す
          </button>
          <button
            className="btn gap"
            onClick={() => {
              const raw = localStorage.getItem("shift-scheduler-state-v1");
              if (raw)
                download(
                  new Blob([raw], { type: "application/json" }),
                  "LIBERTY_legacy_original.json",
                );
              else setMessage("旧版の保存データはこの端末にはありません。");
            }}
          >
            旧版の原本JSONを保存
          </button>
        </section>
        <section className="panel">
          <h2>バックアップを復元</h2>
          <p className="subtitle">
            入力形式を検証してから置き換えます。旧版は部署・契約・希望を再確認してください。
          </p>
          <label className="gap">
            JSONファイル
            <input
              type="file"
              accept=".json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void restore(f);
                e.target.value = "";
              }}
            />
          </label>
        </section>
      </div>
      <p className="subtitle gap">
        読取途中の画像・PDF原本は端末内に保存され、JSONには含まれません。ブラウザデータを削除する前に原本も保管してください。
      </p>
    </>
  );
}
