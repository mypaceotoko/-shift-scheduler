# LIBERTY SHIFT SCHEDULER v2

リバティヒルクラブ CS課・PORTERの月間シフト作成を支援する、GitHub Pages上のWebアプリです。

[公開サイト](https://mypaceotoko.github.io/-shift-scheduler/) · [操作ガイド](docs/USER_GUIDE.md) · [監査・改修記録](docs/AUDIT_2026-10-24.md)

## 操作の流れ

1. JPG・PNG・PDF・XLSX・CSVを取り込みます。HEICはブラウザのデコード対応に依存します。
2. 原本と読取表を照合し、氏名・日付・各希望を確認します。アップロードだけではスタッフを変更しません。
3. スタッフの部署・契約区分を確認し、期間・休館日・営業時間を指定して生成します。
4. 不足・制約違反・実働・削減を監査し、セルを編集します。元に戻す・やり直す操作に対応しています。
5. Excelを作成し、表示されたリンクからダウンロードします。編集を再開するためのJSONも保存できます。

## 業務ルール

ルールは `src/lib/v2/model.ts` のバージョン付き設定に集約しています。

- 空欄・認識不明・未確認・勤務不可・有給には自動配置しません。
- PORTERの実働は平日24h以内。土日祝は28h目安・30h上限で評価します。人数重みは使用しません。
- 拘束・休憩・実働を分離し、休憩中の人員不足も監査します。
- KB双葉はスタッフIDと契約区分で管理し、実働4h・8hだけを候補にします。
- PORTERとフロントの勤務コードは部署別です。フロントAは8:45〜17:45です。
- 時間指定・契約・勤務不可を優先します。人員不足は警告として残し、希望違反で補いません。
- 有効な手動勤務・手動公休を保持して再生成できます。不正な保護セルは修正を求めて停止します。
- 独立した監査でハード制約違反があるExcel出力を停止します。警告の残る案は明示確認して出力します。

日別の幅制限付きビーム探索をWeb Workerで実行します。月全体の厳密な最適解を保証する方式ではありません。

## 保存とプライバシー

原本と読取途中の表はIndexedDB、スタッフ・確定希望・生成案はlocalStorageへ保存します。外部のOCR APIへ原本を送信しません。Tesseractのエンジン・言語データの初回取得にはネット接続が必要です。

旧版の保存領域は残し、原本JSONを書き出せます。旧データ移行時は契約と希望の再確認が必要です。端末やブラウザを変える場合はJSONバックアップを利用してください。JSONには読取途中の画像原本を含みません。

## 実装

| 領域 | 技術・場所 |
| --- | --- |
| 画面 | Next.js 16 / React 19 / TypeScript、`src/components/v2/` |
| 共通ルール・型 | Zod、`src/lib/v2/model.ts` |
| 生成・独立監査 | `src/lib/v2/engine.ts` / `generator.worker.ts` |
| 希望取込 | SheetJS / Tesseract.js / PDF.js、`importing.ts` |
| Excel出力 | ExcelJS、`workbook.ts`。6シート、数式・計算値・印刷設定付き |
| 保存 | `storage.tsx`、localStorage / IndexedDB |
| 公開 | 静的エクスポート、GitHub Actions / GitHub Pages |

旧ライブラリは既存ファイルの構造解析や互換性のために残しています。公開画面のシフト生成はv2エンジンを使用します。

## 開発と検証

Node.js 24とnpmを使用します。

```bash
npm ci
npm run dev
```

```bash
npm run typecheck
npm run lint
npm test
npm audit
npm run build
npx playwright install --with-deps chromium webkit
npm run test:browser
```

標準の公開パスは `/-shift-scheduler`。別パスへ配置するときは `NEXT_PUBLIC_BASE_PATH` を指定してビルドします。PDF workerはpostinstallとbuild時に配置します。

Actionsは型・lint・単体テスト・静的ビルド・ChromiumとiPhone相当のWebKitテストの通過後に公開します。作業ブランチは `preview-next/`、mainは公開サイトのルートへ配置します。実機iPhone Safariおよびホーム画面追加での確認は別途必要です。

## 対応上の限界

手書きOCRは原本照合が必要です。氏名と契約対象者、休館・イベント・営業時間は当月資料で確認してください。祝日カレンダーは2026・2027年に対応し、それ以降は休日扱いを手動指定します。

月間シフトと休憩込みの時間帯監査に対応しています。F/ロ/ゴミ/P/事務を30分単位で自動配置する完全な行動予定表生成は未実装です。スタッフの自由記述メモは自動制約として解釈しません。

## ライセンス

MIT — [LICENSE](LICENSE)
