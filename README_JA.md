# 🐙 Octopus (LLMPET fork) — 5 つの AI コーディング agent 用デスクトップペット

[简体中文](README.md) | [English](README_EN.md) | **日本語**

Octopus は、**5 つの AI コーディング agent** — **CodeWhale、Claude Code、Codex、OpenCode、aider** — の動きをひと目で確認できるデスクトップペットです。考え中、ツール実行中、ユーザー待ち、完了、エラー、休憩中といった agent の状態に合わせて表情が変わります。最新の返答を吹き出しで表示し、セッション、token 使用量、推定コスト、利用履歴をコンパクトなパネルで確認できます。

> **ダウンロードしてすぐ使えます：** 最新の Linux / macOS / Windows 版は [GitHub Releases](https://github.com/purrfecto114-lgtm/LLMPET/releases/tag/v0.1.2-pre) から入手できます。配布版には Electron が含まれているため、一般ユーザーは Node.js やターミナルを用意する必要がありません。

> **注：** これは [myunwang/LLMPET](https://github.com/myunwang/LLMPET) の機能拡張 fork です。画面表示は現在 **簡体字中国語** のみで、英語 / 日本語 UI の切り替えは今後のロードマップです（上流の i18n 作業は未統合）。

## 主な機能

- **agent の状態をリアルタイム表示** — 思考、作業、並列 subagent、コンテキスト整理、ユーザー待ち、エラー、完了、休憩をアニメーションで表現します。
- **5 つの provider** — **CodeWhale**、**Claude Code**、**Codex**、**OpenCode**、**aider** を同時に監視でき、それぞれ専用の hook インストーラを備えます。
- **hook インストーラ** — 各 provider のブリッジ hook をワンクリックで導入（Claude Code `settings.json`、CodeWhale TOML、Codex `hooks.json`、OpenCode plugin system、aider `--notifications-command`）。
- **権限確認** — Claude Code / CodeWhale の権限要求をペットから直接許可 / 拒否でき、一括決済も可能です。
- **セッション切り替え** — ペットをクリックするとスクロール可能な一覧が開き、コンテキスト使用率の確認や対象ウィンドウへの移動ができます。
- **利用状況パネル** — token 履歴、モデル別内訳、推定コスト、レート制限、バックグラウンド処理、現在の操作を確認できます。
- **3 種類のスキン** — タコ 🐙、ピクセルモンスター 👾、月薪喵 🐱。
- **macOS のパトロールモード** — 対応する他のデスクトップペットを検出し、最前面を維持しながら相手を画面端へ押し出します。
- **セキュリティ強化** — `contextIsolation` + `sandbox` + `nodeIntegration:false`、IPC contextBridge 監査、プロセスレベルのエラーガード。

状態機械、利用量計測、権限処理、プロセス照合、デスクトップ UI はこのリポジトリ内で実装されています。各 provider は公開の hook / plugin システム経由で接続し、agent プロセスには注入しません。

## 月薪喵スキンの状態

| アニメーション | 状態 | 表示されるタイミング |
|:---:|:---|:---|
| <img src="assets/cat/cat-working.gif" width="72" alt="作業中"> <img src="assets/cat/cat-working-2.gif" width="72" alt="作業中の別ポーズ"> | 🛠️ **作業中** | ツール実行、ファイル編集、コマンド実行中 |
| <img src="assets/cat/cat-thinking.gif" width="72" alt="思考中"> <img src="assets/cat/cat-thinking-2.gif" width="72" alt="思考中の別ポーズ"> | 🤔 **思考中** | 最初のツール実行前に考えているとき |
| <img src="assets/cat/cat-talking.gif" width="72" alt="返答中"> | 💬 **返答中** | assistant の返答を生成しているとき |
| <img src="assets/cat/cat-juggling.gif" width="72" alt="並列タスク"> | 🤹 **並列タスク** | 複数の subagent が同時に作業しているとき |
| <img src="assets/cat/cat-waiting.gif" width="72" alt="許可待ち"> | ✋ **許可待ち** | Claude Code が実行許可を求めているとき |
| <img src="assets/cat/cat-needsinput.gif" width="72" alt="入力待ち"> | ❓ **入力待ち** | 回答や選択が必要なとき |
| <img src="assets/cat/cat-happy.gif" width="72" alt="完了"> | 🎉 **完了** | 1 ターンの処理が完了したとき |
| <img src="assets/cat/cat-error.gif" width="72" alt="エラー"> | 💥 **エラー** | コマンドや API リクエストが失敗したとき |
| <img src="assets/cat/cat-loafing.gif" width="72" alt="休憩中"> | 🍦 **小休止** | 前の処理が終わり、次の動作を待っているとき |
| <img src="assets/cat/cat-sleeping.gif" width="72" alt="睡眠中"> | 😴 **睡眠中** | セッション終了後、または長時間操作がないとき |

月薪喵の素材は Douyin クリエイター **@月薪喵** のものです。詳細は [`assets/cat/CREDITS.md`](assets/cat/CREDITS.md) をご覧ください。

## ダウンロードと起動

### 配布版

[最新版をダウンロード](https://github.com/myunwang/LLMPET/releases/latest)

- **macOS（Apple Silicon）：** `LLMPET-*-mac-arm64.zip` をダウンロードして展開し、`LLMPET.app` を開きます。初回起動時に Gatekeeper で止められた場合は、Finder でアプリを右クリックして **開く** を選択してください。パトロールモードにはアクセシビリティ権限も必要です。
- **Windows（x64）：** インストーラー版は `LLMPET-*-Windows-x64.exe`、ポータブル版は同名の `.zip` を利用してください。

初回起動時、LLMPET は既存設定を上書きせずに Claude Code hook を追加します。

### ソースから起動

必要なもの：

- macOS または Windows
- Node.js 18 以上
- Claude Code または OpenAI Codex（少なくとも一度は利用済み）

```bash
git clone https://github.com/myunwang/LLMPET.git
cd LLMPET
npm install
npm start
```

主なコマンド：

```bash
npm test                 # ヘッドレス回帰テスト一式
npm run package:mac      # macOS ARM64 パッケージ
npm run package:win      # Windows インストーラー + ZIP
npm run uninstall:hooks  # LLMPET の Claude hook を安全に削除
```

## 連携の仕組み

### Claude Code

LLMPET は `~/.claude/settings.json` に、既存設定と安全に共存するライフサイクル hook と権限 hook を登録します。

- `UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`、`SubagentStart` などのイベントを、`127.0.0.1` にバインドされたローカルサーバーへ送信します。
- 権限リクエストは、ユーザーが許可または拒否を選ぶまで待機します。
- ローカル transcript は token 数、モデル ID、時刻の集計に必要な範囲で増分走査します。assistant の本文は短い返答吹き出しを表示する場合にだけ読み取ります。

### OpenAI Codex

Codex 用の hook はインストールしません。次の rollout を増分かつ読み取り専用で監視します。

```text
~/.codex/sessions/YYYY/MM/DD/*.jsonl
```

rollout イベントを共通の状態機械へ変換し、内部 subagent スレッドを除外します。長時間セッションの復帰時も過去イベントを再生せず、新しく追加された部分だけを読み取ります。利用可能な場合は Codex のレート制限情報も表示します。

## ミームアクション

各ミームは次の構造で保存されます。

```text
assets/memes/<meme-id>/
  visual.gif
  voice.mp3
```

カタログには表示名、説明、再生方法、ペットの反応、Prompt のバージョン、言語別 Prompt がまとまっています。ミームを選ぶと、ペットの横で GIF と音声が再生され、選択中の Claude / Codex セッションへ対応する Prompt が送られます。

言語別 Prompt は逐語訳ではなく、その言語で同じ役割を果たす表現へ置き換えています。たとえば中国語の「你这瓜保熟吗？」は、日本語では「それってあなたの感想ですよね？」となり、どちらも「推測ではなく根拠を出して」という圧を伝えます。

## macOS パトロールモード

ペットの右クリックメニューから **今すぐパトロール** を選ぶか、トレイで自動パトロールを有効にします。

1. **猫の手は常に上：** 対応する他のデスクトップペットを検出すると、LLMPET は最前面レベルを再適用します。
2. **画面端へ押し出す：** アクセシビリティ権限がある場合、相手へ近づき、最寄りの左右端まで移動させます。

ドラッグ helper は、ユーザーがマウスを操作中のときには動作しません。グローバル入力を使う互換処理もアイドル判定で保護され、完了時や失敗時にはマウス状態を復元します。

パトロールモードは現在 macOS のみ対応しています。

## プライバシーとセキュリティ

- HTTP サーバーは `127.0.0.1` のみにバインドし、loopback リクエストを検証します。
- セッション情報、設定、利用履歴はローカル端末内に保存されます。
- Codex rollout へのアクセスは読み取り専用です。
- 外部通信は、24 時間に一度行う公開 LiteLLM 価格表の取得だけです。`OCTOPUS_NO_NET=1` で完全オフラインにできます。
- Electron は `contextIsolation` を有効、`nodeIntegration` を無効にしています。
- Claude hook の追加は既存設定を上書きせず、原子的かつ取り消し可能で、削除前にはバックアップを作成します。

## 設定・開発用フラグ

- `OCTOPUS_NO_HOOKS=1 npm start` — Claude 設定を変更せずに起動します。
- `OCTOPUS_ALLOW_MULTI=1 npm start` — 開発時に単一インスタンス制限を無効化します。
- `OCTOPUS_NO_NET=1 npm start` — 外部ネットワーク通信を無効化します。
- `OCTOPUS_DEBUG=1 npm start` — ローカル `/debug` エンドポイントを有効化します。
- `LLMPET_NO_CODEX=1 npm start` — Codex rollout の監視を無効化します。
- `LLMPET_CODEX_DIR=<dir> npm start` — テスト用の rollout ディレクトリを指定します。

## コントリビューター

[@james6666-max](https://github.com/james6666-max) は [PR #6](https://github.com/myunwang/LLMPET/pull/6) で、Windows のセッションフォーカス、ターミナル PID チェーンの解決とキャッシュ、electron-builder パッケージング、Windows CI テストマトリクスを提供しました。

Issue と Pull Request を歓迎します。
