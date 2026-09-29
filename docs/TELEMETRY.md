# ラウンド記録の収集（Google Apps Script + Google スプレッドシート）

1ラウンド終了ごとに、ゲームが JSON を1件 POST する。受け口は Google Apps Script のウェブアプリで、受け取った内容を非公開のスプレッドシートに1行追記する。

- 書き込み: 誰でも可（ゲームを開いた全員が送れる必要があるため）
- 閲覧: スプレッドシートの所有者のみ（シートは共有しない）
- サーバー・DB・料金: なし（Google アカウントの無料枠）
- 送信先が未設定なら何も送らない。送信に失敗してもゲームには影響しない

## 送る内容（1ラウンド1件）

| 項目 | 内容 |
|---|---|
| `player` | ブラウザごとの匿名 ID（乱数16桁、localStorage に保存。アカウントとは無関係） |
| `seed` | 提示シード。`?seed=` で同じ提示順を再現できる |
| `offers[]` | 提示ごとの `cards`（3枚）、`pick`（選んだカード）、`decisionSec`（表示から選択までの秒数）、`atSec`（提示時刻） |
| `score`, `peakRate`, `line`, `speedCount`, `extendCount` | 結果 |
| `durationSec`, `roundLengthSec` | 設定の長さと、EXTEND 込みの実際の長さ |
| `abandoned`, `playedSec` | 途中でリトライしたか（true なら記録はそこまでの分）と、遊んだ秒数 |
| `speed`, `speedSec` | 記録時点の倍速と、倍速ごとに遊んだゲーム内の秒数（例: `{"1": 12.5, "1.5": 57.5}`）。ラウンド途中の切り替えが分かる |
| `muted`, `fever` | 記録時点の消音状態と、到達したフィーバー段階（0〜3） |
| `build` | デプロイしたコミットの SHA |
| `screen` | 画面幅・高さ・DPR・タッチの有無 |
| `time` | 終了時刻（ISO） |

個人を特定する情報（IP、アカウント、UA 文字列）は送らない。

## 設定手順（10分）

1. Google スプレッドシートを新規作成する（名前は任意、例: `ball-factory rounds`）。
2. メニュー「拡張機能」→「Apps Script」を開く。
3. エディタの `コード.gs` の中身を全て消し、このリポジトリの `apps-script/Code.gs` を貼り付けて保存する。
4. 右上「デプロイ」→「新しいデプロイ」→ 種類の選択で「ウェブアプリ」。
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員**
5. 「デプロイ」を押す。初回は権限の承認が出る（自分のシートへの書き込み許可）。
6. 表示される **ウェブアプリの URL**（`https://script.google.com/macros/s/.../exec`）をコピーする。
7. GitHub リポジトリの「Settings」→「Secrets and variables」→「Actions」→「Variables」タブ→「New repository variable」で
   - Name: `TELEMETRY_URL`
   - Value: 手順6の URL
8. `main` に何か push する（または Actions の「Deploy to GitHub Pages」を「Run workflow」で手動実行）。ビルド時に URL が埋め込まれる。

ローカルで試す場合は `.env.local` に `VITE_TELEMETRY_URL=<URL>` を書くか、`src/config/telemetry.ts` の `endpoint` に直接書く。

## 動作確認

1. デプロイ後のゲームを開き、1ラウンド終える。
2. スプレッドシートに `rounds` シートが自動作成され、1行追加されていれば成功。
3. 追加されない場合: ブラウザの開発者ツール → Network で `exec` への POST があるか確認する。ステータスが 302/200 なら送信は成功している。行がなければ Apps Script 側の「実行数」ログでエラーを見る。
4. 「実行数」に `No spreadsheet` が出る場合: `Code.gs` 先頭の `SPREADSHEET_ID` にシートの URL（`/spreadsheets/d/<ID>/edit`）の ID を入れて再デプロイする。手順2の通りシートから開いたスクリプトなら不要。

## 注意

- スクリプトを修正したら「デプロイ」→「デプロイを管理」→ 編集 → バージョン「新バージョン」で再デプロイしないと反映されない（URL は変わらない）。
- ウェブアプリの URL は公開ビルドに含まれるので、誰でも POST できる。スクリプト側で形式チェック（`v`、`score`、`offers`）と 20KB 上限を入れてある。悪戯で行が増えたら、新しいデプロイを作って URL を変える。
- 集計は `raw` 列（元の JSON）を使う。`offers` 列は `SAP>P` のような短縮表記（提示3枚 > 選択、S=SPLIT P=PRESS A=ACCEL V=SPEED E=EXTEND）。
- 収集を止めるには、リポジトリ変数 `TELEMETRY_URL` を削除して再デプロイするか、Apps Script のデプロイをアーカイブする。
