# Discord 人狼 Bot（開発中）

Discord サーバー上で人狼ルームを作成し、参加、役職配布、夜行動、昼議論、投票、勝敗判定、ログ保存まで行う TypeScript製のbotです。テキスト対応です（既存はvcのみであるみたいですが，それは余裕があれば作ります）

## 現在入っている機能

- `/jinro-setup` で ⓪ロビー用チャンネルを作成し、ルーム作成・参加・ログ確認ボタンを投稿
- 同時に使えるルームを Discord サーバーごとに 8個まで制限
- ルームごとにカテゴリを作成
- テキストモード: ①通常用 ②人狼・狂人陣営用 ③霊界用テキストチャンネルを作成
- VC モード: ①進行用テキスト + ①通常 VC ②人狼陣営 VC ③霊界 VC を作成
- ルーム作成時に人数、各フェーズ秒数、役職数、初日噛み、同票処理、テキスト/VC を設定
- 参加ボタンから参加先ルームを選択
- ホストの「開始する」ボタンでゲーム開始
- 役職をDMで個別配布
- 夜行動:
  - 人狼: 人狼陣営チャンネルで噛み投票
  - 占い師: DMで占い先選択、結果をDM
  - 狩人: DMで護衛先選択
  - 霊媒師: 2 日目夜以降にDMで直近処刑者の判定
- 昼議論の残り 5分、3分、1分、30秒でリマインド
- 処刑投票は非公開
- 死亡者は霊界に移動し、通常チャンネルと人狼陣営チャンネルは閲覧のみ
- 村人陣営 / 人狼陣営の勝敗判定
- サイコ、パン屋を実装（もっと役職ほしいよね，）
- 試合終了後、役職一覧と勝利陣営を表示
- 20分後にチャンネルログとイベントログを `yymmddhhmm` 形式の `.txt` に保存し、ルームチャンネルを削除
- ロビーのログ確認ボタンから保存済みログを取得

## 役職

必須:

- 村人
- 人狼

任意:

- 狂人: 人狼陣営勝利で勝ちます。夜の人狼陣営チャンネルに参加できます。
- 占い師: 夜に1人を占います。人狼かどうかだけ判定します。
- 霊媒師:2日目夜以降、直近で処刑された人が人狼かどうかを判定します。
- 狩人: 夜に1人を護衛します。
- パン屋: 生存中は毎朝「パンが届いた」ログが流れます。
- サイコ: 村人陣営です。夜に能力や噛みで対象にされると、対象にした側へ事故死が発生します。

狐陣営はまだ入れていません。勝敗判定や占い結果、死亡処理が大きく変わってややっこいので、また時間が空いたら考えてみます。

## セットアップ

1. Discord Developer Portal で bot を作成します。
2. Bot の Privileged Gateway Intents で以下を有効にします。
   - Server Members Intent
   - Message Content Intent
3. OAuth2 URL Generator で `bot` と `applications.commands` を選び、権限は少なくとも以下を付けます。
   - Manage Channels
   - View Channels
   - Send Messages
   - Read Message History
   - Manage Roles
   - Move Members
   - Use Voice Activity
4. `.env.example` を `.env` にコピーし、`DISCORD_TOKEN` と `CLIENT_ID` を入れます。
5. 初回テストでは `GUILD_ID` にテストサーバー ID を入れると、スラッシュコマンドの反映が速いです。

```powershell
npm.cmd install
npm.cmd run dev
```

起動後、Discord 上で `/jinro-setup` を実行してください。

## ルーム数の上限

デフォルトでは、待機中または進行中のルームを Discord サーバーごとに 8 個まで作成できます。

`.env` で変更できます。

```env
MAX_ROOMS_PER_GUILD=8
```

終了済みで20分後のログ化待ちになっているルームは、この上限には含めていません。

## ルーム設定の書き方

ルーム作成ボタンを押すとモーダルが出ます。

役職数は次のように入力します。

```text
人狼=2, 占い師=1, 霊媒師=1, 狩人=1, 狂人=1, パン屋=1, サイコ=1
```

人数より役職数の合計が少ない場合、足りない人数は村人で埋めます。人狼が 0 人の場合は開始できません。

同票処理は次のどれかです。

- `revote`: 再投票し、それでも同票ならランダム
- `random`: 同票者からランダム
- `runoff`: 同票者だけで決選投票し、それでも同票ならランダム

モードは次のどちらかです。

- `text`
- `vc`

## 運用メモ

この版の状態管理はプロセス内メモリ中心です。試合中に bot を再起動すると進行中ルームは復元されません。広く公開する段階では、PostgreSQL や SQLite などにルーム状態とタイマー予定を保存する構成にすると安定します。

また、役職通知は DM で送ります。ユーザーがサーバーからの DM を閉じている場合、その人には役職通知が届かないため、プレイ前に DM 許可を案内してください。

## Ubuntuで動かす手順（開発者もこれで動かしてます）
Discord bot は基本的に外部から HTTP アクセスを受けないため、Web サーバー用のポート開放は不要です。必要なのは、サーバーから Discord へ出ていく通信、SSH 管理、常駐プロセス管理です。

### 1. Node.js 22 を入れる

```bash
sudo apt update
sudo apt install -y curl ca-certificates git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
```

### 2. 専用ユーザーを作る

```bash
sudo adduser --system --group --home /opt/discord-jinro discord-jinro
sudo chown -R discord-jinro:discord-jinro /opt/discord-jinro
```

### 3. コードを配置する

GitHub に置く場合:

```bash
sudo -u discord-jinro git clone https://github.com/your-name/discord-jinro-bot.git /opt/discord-jinro/app
cd /opt/your_discord-jinro_dir/app
```

### 4. `.env` を作る

```bash
cd /opt/discord-jinro/app
sudo -u discord-jinro cp .env.example .env
sudo -u discord-jinro nano .env
```

最低限、次を入れます。

```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_application_client_id_here
GUILD_ID=your_test_guild_id_here
MAX_ROOMS_PER_GUILD=8
```


