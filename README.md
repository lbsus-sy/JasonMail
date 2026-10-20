# Jason Mail 俊鵬郵件

**把自己的網域變成一個私人網頁郵局。** Jason Mail 是一個開源、單一管理員使用的 Webmail，部署在 Cloudflare Workers；你可以在網頁建立郵件地址、收信、寄信和開啟私人聊天室。

[下載完整原始碼 ZIP](https://github.com/lbsus-sy/JasonMail/archive/refs/heads/main.zip) · [GitHub 專案](https://github.com/lbsus-sy/JasonMail) · [Cloudflare 部署說明](#從零開始部署)

> **先看這裡：** 應用本身可使用 Cloudflare 和 Resend 的免費方案；網域註冊可能要付費。Jason Mail 不會自動升級付費方案。本安裝實例每日最多處理 100 個、每月最多 3,000 個額度單位；外寄郵件按收件人數計算，每封入站郵件計 1 單位。供應商也有帳戶層級的免費額度，可能由同帳戶其他應用共用。供應商可能調整免費額度，部署前請以 Dashboard 顯示為準。

## 快速部署摘要

如果你已經有 Cloudflare、Resend 帳號和一個放在 Cloudflare DNS 的網域，照這個順序做：

1. 下載 ZIP，解壓縮後開啟 `JasonMail` 資料夾。
2. 安裝 Node.js 22 或更新版本，開啟終端機並執行 `npm ci`。
3. 登入 Cloudflare：`npx wrangler login`。
4. 建立 D1 資料庫和 KV 命名空間，把輸出的 ID 填進 `wrangler.jsonc`。
5. 執行 `npx wrangler d1 migrations apply jasonmail --remote`。
6. 設定 `SETUP_TOKEN`、`RESEND_API_KEY` 和 `RESEND_WEBHOOK_SECRET` 三個 Worker secrets。
7. 執行 `npm run deploy`。
8. 在 Cloudflare DNS 建立代理 DNS 記錄，再替 Worker 加上網域 Route。
9. 在 Resend 驗證你的郵件網域，加入 Resend 顯示的 DNS 記錄並建立收件 webhook。
10. 開啟網站，用 `SETUP_TOKEN` 建立管理員帳號，新增第一個郵件地址，寄一封測試信。

第一次部署也可以跟著下面的完整操作做。即使沒寫過程式，也只需要複製命令、貼上 ID 和照畫面指示設定。

## Jason Mail 可以做什麼？

- **一位管理員：** 首次安裝建立使用者名稱和密碼；沒有公開註冊。
- **網頁郵件：** 收件匣、已寄出、草稿、封存、垃圾桶、未分類收件、星號、搜尋、郵件串、回覆、轉寄和附件。
- **自訂地址：** 在已驗證網域下建立例如 `hello@send.example.com`、`billing@send.example.com` 的地址；全部由同一位管理員管理。
- **私人聊天室：** 管理員可隨時開關；加入碼每分鐘更新，也能手動刷新。可設定檔案、副檔名黑名單／白名單、大小上限和訊息間隔。
- **手機和桌面：** 自適應網頁介面，可用手機瀏覽器操作。
- **可自行部署：** 原始碼、資料庫 migration、設定範本和 MIT 授權都在本專案中。

Jason Mail 是輕量自架郵局，不是 Gmail 的完整替代品。首版不提供 IMAP/POP、行事曆、聯絡人、多管理員、垃圾郵件分類或端對端加密，也不保證信件一定進入收件匣。

草稿會保留文字、收件人和主旨；附件不會隨草稿保存，重新開啟草稿後請再次附加檔案。

為保護 Cloudflare Worker 免費資源，Resend 傳回的單封郵件內容／附件清單最多讀取 2 MiB；超過時仍會保存寄件人、收件人和主旨，並在郵件正文顯示提示，但不會保存該封正文或過大的附件清單。單封郵件附件累計最多保存 10 MiB；超限、無效或失效下載連結，以及免費 KV 儲存額度造成略過的附件，會在郵件正文列出提示。暫時性下載或收件處理錯誤會回覆 Resend 重試。

## 郵件怎樣流動？

```text
外部寄件者 ──MX──▶ Resend Receiving ──簽章 webhook──▶ Cloudflare Worker
                                                        │
管理員網頁 ◀──HTTPS / WebSocket── Cloudflare Worker ── D1（帳號與郵件）
                                                        ├── KV（附件）
                                                        └── Durable Object（即時聊天室）
管理員網頁 ──HTTPS──▶ Cloudflare Worker ──Resend API──▶ 外部收件者
```

Resend 負責郵件傳輸；Jason Mail 負責瀏覽器介面、地址、郵件資料和聊天室。收件 webhook 會驗證 Resend 簽章、去除重複事件，並向 Resend 取得郵件正文和附件。網站不會替你修改 DNS。

## 從零開始部署

### 你需要準備

- 一個免費 Cloudflare 帳號，並把你持有的網域加入 Cloudflare DNS。
- 一個 Resend 帳號和 API key。預設方案不需要升級付費。
- Node.js 22 或更新版本。可從 [nodejs.org](https://nodejs.org/) 免費下載。
- Windows PowerShell、macOS Terminal 或 Linux shell。
- 你打算使用的郵件網域，例如 `send.example.com`。

> 網域本身通常要向註冊商付費購買。Cloudflare/Resend 免費服務不包含網域註冊費。

### 第 1 步：取得原始碼

**下載 ZIP（不用 Git）：** 在 [GitHub 專案頁](https://github.com/lbsus-sy/JasonMail) 按 **Code → Download ZIP**，解壓縮後在終端機進入 `JasonMail` 資料夾。

或使用 Git：

```bash
git clone https://github.com/lbsus-sy/JasonMail.git
cd JasonMail
```

安裝 Wrangler：

```bash
npm ci
npx wrangler login
```

`wrangler login` 會開啟 Cloudflare 授權頁，照畫面登入即可。

### 第 2 步：建立免費資料服務

建立 D1 資料庫：

```bash
npx wrangler d1 create jasonmail
```

在命令輸出中複製 `database_id`，打開 `wrangler.jsonc`，取代 `REPLACE_WITH_D1_DATABASE_ID`。

建立 KV 命名空間：

```bash
npx wrangler kv namespace create FILES
```

複製輸出的 namespace ID，取代 `wrangler.jsonc` 裡的 `REPLACE_WITH_KV_NAMESPACE_ID`。請勿在 `wrangler.jsonc` 留下 `REPLACE_WITH_...`。

Durable Object 已在 `wrangler.jsonc` 宣告，部署時會建立聊天室所需的 SQLite-backed Durable Object。**不要建立 R2 bucket**；本專案使用免費額度內的 KV 存附件。

建立資料表：

```bash
npx wrangler d1 migrations apply jasonmail --remote
```

若 Wrangler 問你是否確定要套用 migration，輸入 `y`。之後每次更新原始碼，都檢查 README/版本說明有沒有新增 migration；有的話先執行這個命令，再部署 Worker。

### 第 3 步：安全設定 Worker secrets

以下值是秘密，只透過 Wrangler 輸入 Cloudflare，不要貼到 README、程式碼或 GitHub：

| Secret 名稱 | 從哪裡取得 |
| --- | --- |
| `SETUP_TOKEN` | 自己產生的一次性長密鑰；第一次建立管理員後可從 Cloudflare 移除 |
| `RESEND_API_KEY` | Resend Dashboard → API Keys，建立有寄件／收件權限的 key |
| `RESEND_WEBHOOK_SECRET` | 建立 Resend webhook 時顯示的 signing secret，通常以 `whsec_` 開頭 |

設定命令會安全地逐一提示輸入：

```bash
npx wrangler secret put SETUP_TOKEN
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_WEBHOOK_SECRET
```

`SETUP_TOKEN` 請用密碼管理器產生一個至少 32 個隨機位元組的值；例如安裝有 OpenSSL 時執行 `openssl rand -base64 32`。密鑰只用於首次安裝，不要和登入密碼共用。

### 第 4 步：第一次部署

```bash
npm run deploy
```

Wrangler 會打包 `public/` 靜態頁面和 Worker，並在輸出中顯示 `workers.dev` 預覽網址。初次部署後先確認網站能打開；若畫面提示資料庫未就緒，回到第 2 步確認 migration 和資料庫 ID。

### 第 5 步：連接自己的網域

推薦使用專用子網域，例如 `send.example.com`。這樣不會改動 `example.com` 現有郵件服務。

1. 在 Cloudflare Dashboard 打開該網域的 **DNS → Records**。
2. 新增 `A` 記錄：**Name** 填 `send`，**IPv4 address** 填 `192.0.2.1`，開啟代理（橘色雲）。這個保留的示例 IP 不用來連接你的伺服器；Cloudflare 會在邊緣處理 Worker Route。
3. 打開 **Workers & Pages → jasonmail → Settings → Domains & Routes**（或 Routes），新增 route：`send.example.com/*`，選擇 `example.com` 這個 zone。
4. 如果使用根網域，把記錄名稱換成 `@`，Route 填 `example.com/*`。根網域可能已有 MX；先確認不會中斷目前收件服務。
5. 等待 HTTPS 憑證啟用，再打開 `https://send.example.com`。

如果你使用 Wrangler 從 Dashboard 建立 Route，確認 Route 指向 `jasonmail` Worker。不要把同一個主機名改成 CNAME；本方案用代理 A 記錄加 Worker Route，讓網站記錄與郵件 MX 記錄可以在同一個主機名配置。

### 第 6 步：建立 Resend 網域和 DNS 記錄

1. 在 Resend Dashboard → **Domains**，新增你要收發信的郵件網域，例如 `send.example.com`。
2. 開啟該網域的 **Receiving**。從 Resend 複製寄件驗證和收件所需的 DNS 記錄。
3. 在 Cloudflare DNS 手動新增 Resend 顯示的 MX、SPF、DKIM 記錄。以 Resend 畫面中的 **Name、Type、Value、Priority** 為準；不同帳號／網域的值可能不同。
4. 再新增 DMARC TXT 記錄。常見起始範例是名稱 `_dmarc`、內容 `v=DMARC1; p=none; rua=mailto:dmarc@example.com`；把報告信箱換成你能收取的地址。先觀察報告，再考慮 `quarantine` 或 `reject`。
5. 等待 Resend 顯示網域寄件驗證和 Receiving MX 均為 **Verified**。

**重要 DNS 提醒：**

- SPF 同一個網域只能有一筆 SPF TXT 記錄。若已有 SPF，請依 Resend 說明合併 `include`，不要新增第二筆 `v=spf1`。
- DKIM selector 和記錄值以 Resend 顯示為準。不要自行猜測或照抄其他人的 key。
- Resend 的收件 MX 會接管該網域的收件路由。若 `example.com` 正在用 Google Workspace、Microsoft 365 或其他信箱，不要直接把根網域 MX 指向 Resend；先建立專用子網域並把 Jason Mail 的郵件網域設定為該子網域。
- Resend 的 DNS 畫面若顯示 `inbound` 這類 Name，代表收件 MX 使用的就是那個子網域。請讓 Jason Mail 使用實際接收郵件的完整網域。
- SPF、DKIM、DMARC 有助寄件驗證與網域對齊，但無法保證收件方不把信件放進垃圾郵件。寄信域名聲譽、收件方政策和信件內容也會影響投遞。

### 第 7 步：設定收件 Webhook

在 Resend Dashboard → **Webhooks** 新增 endpoint：

- **Endpoint URL：** `https://send.example.com/api/webhooks/resend`（換成你的網址）。也可以從 Jason Mail「網域與設定」頁面複製。
- **Event：** 勾選 `email.received`。
- 建立後複製 signing secret，設定成 `RESEND_WEBHOOK_SECRET`。若剛才先設定 secrets，建立 webhook 後再執行 `npx wrangler secret put RESEND_WEBHOOK_SECRET` 更新。

Webhook 送達時，Jason Mail 會向 Resend API 取得完整正文和附件。請確認 API key 可讀取 Receiving emails；不要把 webhook secret 放進瀏覽器或網站設定頁。

### 第 8 步：建立管理員和第一個郵件地址

1. 打開 `https://send.example.com`。畫面會建議目前網站主機名作為郵件網域；確認它和 Resend 已驗證並啟用收件的網域一致。
2. 貼上 `SETUP_TOKEN`，建立使用者名稱和至少 12 個字元的密碼。
3. 開啟「郵件地址」，新增例如 `hello`，網站會建立 `hello@send.example.com`。
4. 回到 Cloudflare Dashboard → **Workers & Pages → jasonmail → Settings → Variables and Secrets**，移除 `SETUP_TOKEN` secret。一次性安裝已鎖定，之後以管理員名稱和密碼登入。

密碼在瀏覽器使用 Web Crypto 的 PBKDF2-SHA-256（600,000 次）推導；登入採用一次性 challenge-response，Worker 只驗證一個 HMAC。這樣保留強密碼推導，同時避免把大量 PBKDF2 計算放進 Cloudflare Free Worker 的每次請求 CPU 預算。

### 第 9 步：測試寄件和收件

1. 從 Jason Mail 寄一封信到你能讀取的外部信箱。
2. 查看外部信箱的收件匣和垃圾郵件匣；點開郵件的原始標頭，確認 SPF、DKIM、DMARC 結果。
3. 從外部信箱寄信到剛建立的 `hello@send.example.com`。
4. 確認 Resend Dashboard 的 Receiving 郵件記錄和 webhook 顯示成功；Jason Mail 的「收件匣」應出現郵件。
5. 寄到尚未建立的地址，例如 `unknown@send.example.com`，應出現在「未分類收件」。

### 第 10 步：開啟私人聊天室（可選）

1. Jason Mail 側欄 → **私人聊天室** → 開啟聊天室。
2. 複製顯示的邀請連結，例如 `https://send.example.com/privchat/123456`，傳給朋友。
3. 驗證碼每分鐘自動換新；可按「立即刷新驗證碼」。更新後舊碼不能開新連線，已連線的人仍能繼續聊天。
4. 如有需要設定檔案開關、副檔名白名單／黑名單、大小和訊息間隔。
5. 關閉聊天室會斷開所有連線並刪除聊天記錄和聊天室檔案。

## 更新原始碼

先從 GitHub 下載最新 ZIP，或在 Git checkout 執行：

```bash
git pull
npm ci
```

若新版有新的 D1 migration，先套用：

```bash
npx wrangler d1 migrations apply jasonmail --remote
```

再部署：

```bash
npm run deploy
```

## 本機開發

```bash
npm ci
```

複製 `.dev.vars.example` 成 `.dev.vars`，填入測試用 secret；這個檔案已加入 `.gitignore`。然後建立本機 D1 migration：

```bash
npx wrangler d1 migrations apply jasonmail --local
npm run dev
```

Wrangler 會顯示本機預覽網址。`.dev.vars` 只供本機使用，不要上傳到 GitHub。

## 免費額度、儲存與停止行為

| 服務 | Jason Mail 用途 | 免費保護方式 |
| --- | --- | --- |
| Cloudflare Workers | 網頁、API、Webhook | 使用 Workers Free；留意帳戶當日 requests/CPU 等官方限制 |
| Cloudflare D1 | 管理員、郵件與狀態 | 使用 D1 Free；空間和每日讀寫量與 Cloudflare 帳戶共用 |
| Cloudflare KV | 郵件附件、聊天室檔案 | 不建立 R2；附件上限 10 MiB，受 KV 免費讀寫次數和總容量限制 |
| Durable Objects | 私聊 WebSocket、每分鐘換碼 | 使用 SQLite-backed DO；受帳戶免費請求和運算額度限制 |
| Resend Free | 郵件寄送和收件 | Jason Mail 本地保護上限：每日 100 個額度單位、每月 3,000 個；外寄按收件人數計，入站每封計 1 單位 |

本地額度計數屬於這一份 Jason Mail 安裝；Resend Free 額度則是 Resend 帳戶共用，其他應用也可能消耗。每位外寄收件人各計一個本地額度單位，每封入站郵件計一個。供應商可調整免費方案；請查看 [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)、[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)、[Workers KV limits](https://developers.cloudflare.com/kv/platform/limits/) 和 [Resend pricing](https://resend.com/pricing)。

當郵件額度用完，新的寄件會被拒絕；收件 webhook 會記錄已處理的 quota-blocked 事件並停止抓取郵件正文和附件，該封信不會出現在 Jason Mail。請在 Resend Dashboard 查看原信並等額度重置。KV／D1／Worker 額度用完時，相關讀寫也可能失敗；應用不會自動購買付費額度或建立 R2。

## 安全與資料管理

- 只有首次安裝使用 `SETUP_TOKEN`。部署後請移除該 secret。
- 管理員密碼驗證使用瀏覽器端 PBKDF2-SHA-256（600,000 次）和伺服器端一次性 HMAC challenge；session cookie 為 HttpOnly、SameSite=Strict，修改資料需要 CSRF token。
- 登入與安裝錯誤會按來源 IP 雜湊後限流。登入 challenge 五分鐘失效並且只能使用一次。
- 收件 webhook 驗證 Resend 簽章及時間戳，按 webhook ID 去重。
- 郵件 HTML 在受 sandbox 限制的 iframe 顯示，移除主動內容；附件以安全下載方式提供。
- 私聊驗證碼只防止未獲邀請者新加入，不是端對端加密。聊天室連線能力 token 只在該連線期間有效。
- 郵件會一直保留，直到管理員移至垃圾桶並永久刪除。永久刪除郵件時，Jason Mail 也會刪除其 KV 附件。
- 私聊關閉會先使聊天室無法加入，再關閉 WebSocket 並刪除 D1 聊天記錄和 KV 聊天室檔案。
- 應定期備份 D1。附件在 KV，請依 Cloudflare 的 KV 資料匯出方式另行備份；本專案不提供雲端備份或復原點。

## 常見問題

### 「資料庫尚未就緒」

先核對 `wrangler.jsonc` 的 D1 ID 和 KV ID，再執行 `npx wrangler d1 migrations apply jasonmail --remote`，最後 `npm run deploy`。

### 登入頁面一直回到安裝畫面

確認 Worker 使用正確的遠端 D1 資料庫且 migration 已套用。管理員資料在 D1；若部署到另一個環境或換資料庫，該環境會顯示首次安裝畫面。

### 郵件地址無法收信

確認 Resend 網域的 Receiving 已啟用、MX 顯示 Verified、收件 webhook 選了 `email.received`，並且 `RESEND_WEBHOOK_SECRET` 對應同一個 webhook。檢查 Resend Webhooks 的投遞記錄和 Worker Logs。

### 郵件進垃圾郵件

確認寄件網域驗證、單一 SPF、DKIM 和 DMARC 都通過。查看退信及郵件標頭；不要把 `p=reject` 當成投遞保證。新網域通常需要慢慢建立寄件信譽。

### 寄件回報超額或 API 錯誤

查看 Jason Mail 側欄的本地額度、Resend Dashboard 使用量和 API key 狀態。Resend Free 可能被同帳戶的其他專案共用。Jason Mail 不會替你升級方案。

### 私聊檔案無法上傳

確認聊天室設定已允許檔案、檔案未超過目前上限，且副檔名沒有被黑名單封鎖。可執行檔類型會固定封鎖；KV 免費寫入額度用完時也會暫停上傳。

## English quick start

1. Download and unzip the source. Install Node.js 22+, then run `npm ci` and `npx wrangler login`.
2. Create D1 with `npx wrangler d1 create jasonmail` and KV with `npx wrangler kv namespace create FILES`. Put both returned IDs in `wrangler.jsonc`.
3. Run `npx wrangler d1 migrations apply jasonmail --remote`.
4. Set `SETUP_TOKEN`, `RESEND_API_KEY`, and `RESEND_WEBHOOK_SECRET` with `npx wrangler secret put NAME`.
5. Run `npm run deploy`. Add a proxied A record and a Worker Route for your chosen hostname.
6. Verify that same mail domain in Resend, enable receiving, add the DNS records shown by Resend, and create an `email.received` webhook at `https://YOUR-HOST/api/webhooks/resend`.
7. Open your site, use `SETUP_TOKEN` once to create the admin, remove that secret, add a mailbox, and send/receive a message.

The default deployment uses Cloudflare Free and Resend Free, has no automatic paid upgrade, and stops at local caps of 100 quota units/day and 3,000/month. Outbound recipients count individually; each inbound message counts as one unit. Domain registration may cost money. See the full Chinese guide above for DNS, limits, and troubleshooting.

## 開源授權

MIT License，詳見 [LICENSE](LICENSE)。
