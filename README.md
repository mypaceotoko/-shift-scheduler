# シフトスケジューラ (Shift Scheduler)

店舗向けのシフト作成支援Webアプリケーションです。  
メンバーの希望表（Excelファイル / 画像）から取り込み、人数制約に沿って2週間分のシフトを自動生成・編集・出力できます。

参考レイアウトは画像のような **CS PORTER シフト表** です。

---

## 主な機能

- **メンバー管理**: 名前、優先度、許可/禁止シフト、週・連続勤務上限などを管理
- **希望表の読み取り**: Excel/CSVから日付×メンバーの希望を取り込み、`○`／`／`／`A`/`B`/`13-18`/`-16` などを自動解釈
- **不確定セルのレビュー**: パーサーが解釈できなかったセルをハイライトし、UI上で直接修正
- **シフト自動生成**: 必要人数・優先度・希望・連勤・週上限を考慮した貪欲＋負荷均等化アルゴリズム
- **シフト確認・編集**: メンバー別 / 日付別ビュー、セル直接編集、不足日のアラート
- **エクスポート**: Excel (.xlsx) / 印刷用HTML / 状態のJSON保存・復元
- **設定**: 曜日別必要人数、シフト種別（時間帯・重み・休フラグ）、既定値の編集

## 技術スタック

| レイヤ | 採用技術 | 補足 |
| --- | --- | --- |
| フロントエンド | Next.js 14 (App Router) + React 18 + TypeScript | GitHub Pages / Vercel どちらにも乗せやすい |
| UI | Tailwind CSS | コンパクトで保守しやすい |
| 状態管理 | Zustand + `persist` (localStorage) | データはブラウザに保存。サーバー不要 |
| Excel I/O | `xlsx` (SheetJS) | 取り込み・書き出しを共通化 |
| シフト最適化 | 自前の貪欲＋制約スコアリング (`src/lib/scheduler.ts`) | 制約最適化エンジンへの差し替えを想定し、UI/データと分離 |

## ディレクトリ構成

```
.
├── data/                          # サンプルデータ
│   └── sample-preferences.csv
├── public/
├── src/
│   ├── app/                       # 各ページ (Next.js App Router)
│   │   ├── layout.tsx
│   │   ├── page.tsx              # ダッシュボード
│   │   ├── members/page.tsx      # メンバー管理
│   │   ├── import/page.tsx       # 希望表の読み取り
│   │   ├── generate/page.tsx     # シフト生成
│   │   ├── schedule/page.tsx     # シフト確認・編集
│   │   ├── export/page.tsx       # エクスポート
│   │   ├── settings/page.tsx     # 設定
│   │   └── globals.css
│   ├── components/
│   │   ├── Sidebar.tsx
│   │   ├── PageHeader.tsx
│   │   └── ScheduleGrid.tsx
│   └── lib/
│       ├── types.ts              # ドメイン型
│       ├── store.ts              # Zustand ストア
│       ├── scheduler.ts          # シフト生成ロジック
│       ├── shiftTypes.ts         # 既定シフト種別
│       ├── excel.ts              # Excel/CSV パース・出力
│       ├── dateUtils.ts          # 日付ユーティリティ
│       └── sampleData.ts         # サンプル
├── package.json
├── tsconfig.json
├── tailwind.config.ts
├── postcss.config.js
├── next.config.js
├── .gitignore
├── .env.example
└── LICENSE                        # MIT
```

## セットアップ

```bash
# Node.js 20 以上を推奨
npm install
npm run dev    # http://localhost:3000
```

主なスクリプト:

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | 開発サーバー起動 |
| `npm run build` | 本番ビルド |
| `npm run start` | ビルド後の本番サーバー起動 |
| `npm run typecheck` | TypeScript 型チェック |
| `npm run lint` | ESLint |

## 使い方

1. **サンプルデータを読み込む**: ダッシュボード右上の「サンプルデータを読み込む」ボタンで CS PORTER 風のメンバー・期間・希望が入ります。
2. **希望表の読み取り**: `data/sample-preferences.csv` を取り込むと、`○`・`／`・固定シフト・`13-18` などが解釈され、不確定セルは黄色でハイライトされます。
3. **シフト生成**: 期間と必要人数を確認し「生成する」を押すと、希望と制約に従って自動配置されます。「手動編集を維持して再計算」で部分修正後の再生成が可能。
4. **シフト確認・編集**: メンバー別／日付別ビュー、セル編集、不足日の警告（赤背景）。
5. **エクスポート**: Excel / 印刷HTML / JSON で書き出し。JSONをインポートすると環境を復元できます。

## 希望表セルの解釈ルール

| 入力 | 解釈 |
| --- | --- |
| 空欄 / `○` / `◯` | 出勤可（任意のシフト） |
| `／` / `/` / `x` / `休` / `公休` | 出勤不可 |
| `T`, `B`, `D`, `S`, `C`, `F`, `A` | そのシフト固定 |
| `13-18`, `13:00-18:00` | 時間帯指定（半日扱い） |
| `18-` | その時刻以降出勤可 |
| `-16` | その時刻まで出勤可 |
| その他 | 不確定 → UIで要確認 |

## シフト種別の既定値

| コード | 時間 | 備考 |
| --- | --- | --- |
| S | 9:30-18:30 | |
| T | 9:45-18:45 | |
| B | 10:00-19:00 | |
| C | 11:00-20:00 | |
| D | 12:00-21:00 | |
| F | 14:00-23:00 | |
| A | 14:00- | 半日扱い (countAs=0.5) |
| OFF | — | 公休 |

設定画面から自由に追加・編集できます。

## 設計意図

- **ロジックとUIの分離**: 生成アルゴリズムは `src/lib/scheduler.ts` に閉じ込め、ページ側は Zustand のストア経由で呼び出すだけ。将来 OR-Tools などの制約最適化エンジンに差し替える際もUIに変更を波及させない。
- **拡張しやすいシフト定義**: シフト種別は `ShiftType[]` として可変。半日（`countAs: 0.5`）や休フラグを設定すれば、生成ロジックがそのまま追従する。
- **入力解釈の単一エントリ**: Excel・CSV・将来のOCR結果はいずれも `parseCellPreference()` を通すことで挙動を揃えている。
- **手動編集の優先**: 自動生成時に `manuallyEdited: true` の枠は再計算で上書きしない。
- **GitHub公開を意識**: 依存はクライアント側のみ、API/秘匿情報なし、`.env.example` のみ用意。

## 拡張アイデア

- 画像OCR (Tesseract.js やクラウドOCR) を `src/lib/excel.ts` 同様の形で追加
- OR-Toolsベースの最適化サーバー (Python) を追加し、`scheduler.ts` の代替として呼び出し
- サーバーサイド永続化 (SQLite, Supabase など)
- 通知 (LINE / Slack) でメンバーに公開

## デプロイ

`npm run build` で生成される標準的な Next.js アプリのため、Vercel / Netlify / Cloudflare Pages / 任意の Node ホスティングにそのままデプロイできます。

## ライセンス

MIT License - [LICENSE](./LICENSE) を参照。
