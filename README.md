# Vclip

跨设备的极简剪贴板。手机、电脑、VR 浏览器之间传递文字、链接和截图，首次输入访问密码，之后由浏览器记住登录，不需要装客户端。

场景：在 VR 头显里想打开一个别人发来的链接，你没法打字。手机发一条到 Vclip，头显浏览器打开入口，点一下复制，结束。截图同理——电脑上 `Win+Shift+S` 截完直接 `Ctrl+V`，手机上打开就是图。

## 技术架构

| 层 | 实现 |
|---|---|
| 前端 | React 19 + TypeScript + Vite 6，Tailwind + Framer Motion，打包为静态文件 |
| 服务端 | `server.mjs`，Node 原生 `node:http`，**无 Web 框架、无第三方运行时依赖** |
| 存储 | SQLite（`node:sqlite` 的 `DatabaseSync`）存记录，图片字节落 `data/uploads/` |
| 鉴权 | 密码登录 + 一年期 Cookie 会话（Basic Auth 保留给程序化调用） |

服务端只用内置模块：`node:http`、`node:fs`、`node:path`、`node:crypto`、`node:os`、`node:sqlite`。`package.json` 里的运行时依赖全部属于前端。

## 环境要求

- **Node.js 22 或以上**。SQLite 用的是 Node 内置模块 `node:sqlite`（22.5 起提供），低版本无法启动。
- 现代浏览器（需要 `fetch`、可选链、`Intl` 等基础能力）。

## 快速开始

### Windows 一键启动

双击 `启动vclip.bat`：

- 自动 `cd` 到脚本所在目录，不依赖调用位置
- 系统 PATH 里找不到 `node` 时，会回退扫描 `%USERPROFILE%\.workbuddy\binaries\node\versions\*`
- `node_modules` 缺失自动 `npm install`，`dist` 缺失自动 `npm run build`
- 启动后控制台会打印可直接访问的完整入口地址
- 任何一步失败都会停住并提示，窗口不会一闪而过

### 手动启动

```bash
npm install
npm run build
npm run serve
```

`npm run serve` 等价于 `node --disable-warning=ExperimentalWarning server.mjs`，默认监听 `4173`，同时托管 `dist/` 静态资源和 `/api` 接口。

启动后访问 `http://localhost:4173/<SECRET_PATH>`，会看到登录页，输入 `ACCESS_PASSWORD` 进入。**登录一次，本设备一年内免密**。

控制台启动日志只打印本机与局域网入口地址，不生成免密链接。

## 环境变量

在项目根目录创建 `.env`（参考 `.env.example`）。服务端自己解析 `.env`，不依赖 `dotenv`；已存在的真实环境变量优先级更高。

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `SECRET_PATH` | 是 | 无 | 隐藏入口，例如 `my-private-space`；只允许一段字母、数字、`_` 或 `-`，缺失或非法时拒绝启动 |
| `ACCESS_PASSWORD` | 是 | 无 | 首次访问的密码，缺失或空白时拒绝启动；浏览器登录后记住一年 |
| `PORT` | 否 | `4173` | 监听端口 |
| `DB_PATH` | 否 | `data/vclip.db` | SQLite 文件路径，相对路径基于工作目录 |

入口只读取服务端 `SECRET_PATH`。旧配置需要将 `VITE_SECRET_PATH` 改名为 `SECRET_PATH`；不要通过 `VITE_` 变量把入口带入前端构建。

## API

所有接口都需要认证：浏览器带 Cookie 会话，程序化调用用 Basic Auth（用户名任意，只校验密码）。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/clips` | 返回最近 100 条未过期记录，按 `id` 倒序 |
| `POST` | `/api/clips` | 新建一条，返回完整行（含数据库生成的 `id` 和时间戳） |
| `DELETE` | `/api/clips/:id` | 删除指定记录（若是图片，同时删除磁盘文件） |
| `GET` | `/api/media/:filename` | 读取图片字节，`filename` 来自图片记录的 `content` |

### POST /api/clips

请求体：

```json
{
  "content": "要保存的文本",
  "expires_at": "2026-11-04T08:38:33.930Z"
}
```

- `content` 必填，去除首尾空白后不能为空，上限 1MB（超出返回 `413`）
- `expires_at` 可选，ISO 8601 字符串。不传则默认 24 小时
  - 非法值、过去时间、超过 30 天一律忽略并退回默认 24 小时
  - 内部统一归一化为 `toISOString()` 的 UTC 格式存储，保证 SQLite 的字符串比较等价于时间比较

成功返回 `201`：

```json
{
  "id": 1,
  "content": "要保存的文本",
  "type": "text",
  "created_at": "2026-10-28T08:38:33.976Z",
  "expires_at": "2026-11-04T08:38:33.930Z"
}
```

示例：

```bash
# 写入（默认 24 小时）
curl -u "vclip:你的密码" -X POST http://127.0.0.1:4173/api/clips \
  -H 'Content-Type: application/json' \
  -d '{"content":"hello"}'

# 读取
curl -u "vclip:你的密码" http://127.0.0.1:4173/api/clips

# 删除
curl -u "vclip:你的密码" -X DELETE http://127.0.0.1:4173/api/clips/1
```

`POST` 之所以返回整行，是因为前端采用乐观 UI：插入时先渲染临时行，拿到真实 `id` 和时间戳后再替换。

### 上传图片

同一个 `POST /api/clips`，把 `Content-Type` 换成 `image/*`，请求体直接是图片字节（**不是** `multipart/form-data`）：

```bash
curl -u "vclip:你的密码" -X POST http://127.0.0.1:4173/api/clips \
  -H 'Content-Type: image/png' \
  --data-binary @screenshot.png
```

返回 `201`：

```json
{
  "id": 12,
  "content": "mw2bapik-95ed1a16-567f-4b4c-94ea-d462ce4a5cc4.png",
  "type": "image",
  "created_at": "2026-11-04T16:09:12.622Z",
  "expires_at": "2026-11-05T16:09:12.622Z"
}
```

图片的 `content` 存的是文件名，不是图片本身。字节落在 `data/uploads/`，列表接口因此不会被 base64 撑爆。

| 约束 | 值 |
|---|---|
| 允许格式 | PNG / JPEG / GIF / WebP |
| 类型判定 | 读文件头魔数，**不信任** `Content-Type` 和扩展名 |
| SVG | **一律拒绝（415）**，原因见下方安全模型 |
| 单张上限 | 8MB（`Content-Length` 超限直接 413，不读请求体） |
| 读取地址 | `GET /api/media/:filename`，带 `Cache-Control: private, immutable` |
| 生命周期 | 与文本一致，默认 24 小时；过期清理时连文件一起删 |

**原图无损**：上面这四种格式命中后一个字节都不改，原样落盘。下载回来的文件和本地文件逐字节相同，不会二次压缩。

**另外会存一张缩略图**：上传后前端在浏览器里生成一张长边 480 的 WebP，通过 `POST /api/clips/:id/thumb` 单独提交。列表只加载这张（实测 4–10KB，截图类不到 1KB），点开大图才去取原图。原图动辄几 MB，走公网时一张要几十秒，缩略图让「浏览」这个动作先变得可用。

非 PNG/JPEG/GIF/WebP 的图片会尝试在浏览器本地转成 JPEG（q0.92）再上传。HEIC/HEIF（包括 Live Photo 的静态照片）在浏览器无法原生解码时，会按需加载项目内置的 `heic-to` 解码 worker，不依赖外部转换服务。其他格式要求浏览器能够自行解码。

**Live Photo 当前仅保存静态照片，不保留动态视频、声音和原始 HEIC 元数据。** 单独选择 MOV 视频仍不支持。待转换源照片上限 32MB，转换后的 JPEG 仍需满足 8MB 上传上限；普通 PNG/JPEG/GIF/WebP 超过 8MB 会直接拒绝，符合限制的文件保持原始字节不变。

### 素材留言与完成标记

每张图片或文本卡片下方都有「追加 / 回复」入口，支持多段留言和引用回复。留言不会覆盖旧内容；昵称可选，仅作显示，不是已验证身份。昵称保存在当前浏览器本地。

- 点击「标记已完成」标记素材处理完毕，可撤回标记。
- 留言支持多行，点击「发送留言」保存，电脑可用 Ctrl/Cmd+Enter。
- 页面可见时每 5 秒刷新列表，展开的留言也会同步；刷新不会清空正在输入的留言草稿。
- 新素材可选择保留 1 / 7 / 30 天，卡片显示过期时间。**追加留言和标记完成不会延长保留时间**，过期或删除素材时，关联留言一并删除。
- 每条留言最多 4000 字，昵称最多 40 字，每条素材最多 500 条留言。

新增接口（与原接口使用相同鉴权）：

| 方法 | 路径 | 请求 / 返回 |
|---|---|---|
| `GET` | `/api/clips/:id/comments` | 按时间顺序返回留言 |
| `POST` | `/api/clips/:id/comments` | `{ "content": "已处理", "author": "朋友", "reply_to": null }`，返回新增留言；回复时填写同一素材内的留言 ID |
| `PATCH` | `/api/clips/:id` | `{ "status": "done" }` 或 `{ "status": "pending" }`，返回 ID 和状态 |

列表记录新增 `status`（`pending` / `done`）和 `comment_count`。文本创建接口支持 JSON 字段 `retention_days`，图片创建接口支持同名查询参数，取值为 1 / 7 / 30，按服务器时间计算。旧 `expires_at` 参数继续兼容；指定有效 `retention_days` 时优先使用相对时长。旧数据库在启动时自动补充状态列和留言表。


## 入口与密码登录

本项目用于内网直连。浏览器必须知道正确入口，并在首次访问时输入密码；同一局域网没有特殊放行规则。

| 请求 | 行为 |
|---|---|
| `/`、错误入口、`/index.html`、入口下的任意子页面 | 直接返回 404，不跳转、不提示真实入口 |
| 正确入口 `/<SECRET_PATH>` 或其尾斜杠形式，无有效 Cookie | 在当前地址显示密码表单 |
| 正确密码提交到该入口 | 设置登录 Cookie，跳转到干净的入口地址 |
| 正确入口，已有有效 Cookie | 显示剪贴板 |
| 未登录请求 API、图片或构建资源 | 返回 401，不透露入口 |
| 未登录请求 `/manifest.webmanifest` | 返回 401，不返回含入口的 manifest |
| 已登录请求 manifest | 返回正确 `start_url`，使用 `private, no-store`，不写缓存 |
| 图标 | 可以公开读取，不包含入口或用户数据 |

登录页不加载 manifest。登录后的页面用 `crossorigin="use-credentials"` 携带 Cookie 读取 manifest，主屏幕图标可保留正确入口。先登录后再添加到主屏幕。

入口只存在于服务端配置、登录后的 manifest、用户已知的地址和本机日志中，不写入前端 bundle；响应统一使用 `Referrer-Policy: no-referrer`。已经知道入口的用户仍需输入密码。

### 会话与退出

- Cookie 为 `HttpOnly`、`SameSite=Lax`，记住登录 365 天；清除 Cookie 或更换浏览器后需要重新输入密码。
- Cookie 使用密码和入口派生的 HMAC 值，不含明文密码。改密码或入口后，旧 Cookie 立即失效。
- 已登录时访问 `/__logout` 清除当前浏览器 Cookie，返回入口的密码表单。
- 这次访问策略升级将会话版本改为 `session-v2`，旧登录与旧免密链接签发的 Cookie 都需要重新验证密码。

局域网免密、免密登录链接、代理转发头信任和隧道专用连接参数已经移除。旧 `LAN_FREE_ACCESS` 或 `?k=` 不会产生任何免密效果。登录就在正确入口完成，旧 `/__login` 地址返回 404，也不再接受任意登录后跳转目的地。

### API 联动

`file-share-server`、`curl` 等程序仍可对 `/api/` 使用 Basic Auth（用户名任意，只校验密码）。浏览器 API 使用登录 Cookie。Basic Auth 不替代页面登录，也不能读取包含入口的 manifest。

### 地址与基础保护

建议在路由器绑定服务器固定 IP，避免手机书签随 DHCP 变化而失效。静态文件仍有目录边界检查，图片按文件头验证并限制大小，SQLite 使用参数化查询。HTTP 内网复制继续支持 `document.execCommand('copy')` 回退。

当前服务使用 HTTP 内网直连，不包含反向代理或公网隧道兼容逻辑。

## 数据与备份

数据分两处：

- `data/vclip.db` —— 所有文本和图片记录（图片只存文件名）
- `data/uploads/` —— 图片字节

```bash
# 停止服务后两处一起复制
cp data/vclip.db backup.db
cp -r data/uploads backup-uploads
```

WAL 模式下还会有 `vclip.db-wal` 和 `vclip.db-shm` 两个附属文件。推荐在线备份（不用停机）：

```bash
sqlite3 data/vclip.db ".backup backup.db"
```

首次启动自动建表，无需手工执行 DDL。过期清理在启动时执行一次，之后每 10 分钟一次，走 `idx_clips_expires_at` 索引，**图片过期时磁盘文件同步删除**。启动时还会扫一遍 `data/uploads/`，把数据库里没有引用的孤儿文件清掉。

如果只备份了 `.db` 而漏掉 `uploads/`，恢复后图片记录还在但图片全部打不开——前端会显示「图片加载失败」而不是一块空白。

## 访问日志

页面访问记录写入 `logs/access-YYYY-MM-DD.log`，每行格式：

```
2026-10-28T08:38:33.976Z | 192.168.1.10 | GET /my-private-space | 200 | Mozilla/5.0 ...
```

只记录页面请求，来源 IP 使用 TCP 连接对端地址，不信任转发头；不记录 API 调用和复制/删除操作。

## 与其他项目联动

[`file-share-server`](https://github.com/MasonWest/file-share-server) 在生成文件分享链接时，会通过本项目的 `POST /api/clips` 把链接推进剪贴板，实现「生成即出现在手机/VR 上」。

这种联动走 HTTP 接口而非共享数据库，因此两个项目的存储实现可以各自演进。`POST` 的 `expires_at` 参数就是为它加的：分享链接最长 7 天有效，如果强制 24 小时会导致链接提前从剪贴板消失。

## 开发模式

前后端分开调试：

```bash
# 终端 1：后端，固定 4173
npm run serve

# 终端 2：前端热更新，5173
npm run dev
```

`vite.config.ts` 已把 `/api` 代理到 `http://localhost:4173`，dev 模式下接口可直接调用。

## 项目结构

```
Vclip/
├── server.mjs              # 全部服务端逻辑：静态托管、API、登录/会话、日志、SQLite、图片落盘
├── src/
│   ├── App.tsx             # 页面、拖拽/粘贴入口、大图预览
│   ├── hooks/useClips.ts   # 上传、删除、跨设备刷新与状态一致性
│   ├── components/ClipDiscussion.tsx # 留言、引用回复与完成标记
│   ├── utils/images.ts    # 图片识别、转码、缩略图
│   ├── workers/heic.worker.ts # 按需加载的本地 HEIC 解码器
│   ├── main.tsx
│   ├── index.css
│   └── Tailwind.ts
├── index.html
├── public/                 # 图标（构建时原样复制到 dist/）
├── vite.config.ts
├── 启动vclip.bat            # Windows 一键启动
├── .env.example
└── data/
    ├── vclip.db            # 运行时生成，已 gitignore
    └── uploads/            # 图片字节，已 gitignore
```

服务端请求体读取和留言逻辑分别放在 `server/body.mjs`、`server/discussion.mjs`。`tests/` 包含请求体边界检查与浏览器回归测试，使用隔离的临时数据库和上传目录，不读取正式数据。

### 验证改动

```bash
npm run build
npm run lint
npm test
```

Windows 浏览器测试使用已安装的 Edge；其他环境先执行 `npx playwright install chromium`。测试覆盖隐藏入口与登录保护、manifest 的认证和浏览器加载、旧免密失效、异常 URL/JSON、跨块中文、请求体限额、原图字节一致性、留言与回复、完成标记、过期、HEIC 转码和刷新/删除竞态。HEIC 测试样本来自 libheif 官方示例，真实 iPhone 相册选择流程仍需真机验收。

## 设计取舍

- **不用框架**：当前接口规模下，原生 HTTP 足以处理路由和静态托管。
- **不用 `better-sqlite3`**：它需要原生模块编译，换 Node 大版本就要重装。`node:sqlite` 零依赖，代价是启动时需 `--disable-warning=ExperimentalWarning` 消掉实验性提示。
- **入口校验放服务端**：前端校验形同注释，看源码即得。宁可多一次 404 分支，也不要假的防护。
- **时间存 ISO 8601 UTC 文本**：SQLite 没有原生日期类型，这种格式的字典序比较恰好等价于时间比较，`WHERE expires_at > ?` 可以走索引。
- **图片落盘而不是存 base64**：base64 会让体积涨三分之一，且 `GET /api/clips` 每次都要把全部图片塞进 JSON，十张图就是几 MB，手机端直接卡死。落盘之后列表接口只返回文件名，图片还能被浏览器独立缓存。
- **上传不走 multipart**：Node 没有内置 multipart 解析器，手写 boundary 解析要几十行且容易出错。直接收原始二进制，`Content-Type` 声明类型，服务端用魔数复核——代码更短，校验也更硬。

## 已知限制

- `node:sqlite` 在 Node 22 仍标记为 experimental，API 未来可能微调。**升级 Node 大版本前请先跑一次 `npm run serve` 验证**。若真要换回 `better-sqlite3`，只需改 `import` 和三处 `statements` 调用，接口契约不变。
- 单进程单写入者。适合个人使用场景，不适合多实例部署共享同一个 `.db`。
- **登录页没有失败次数限速**。安全性完全依赖密码强度，请务必使用长随机密码；若你坚持用短密码，建议在反向代理层加限流。
- 支持文本与图片（PNG/JPEG/GIF/WebP），暂不支持任意文件上传。原图无损保存，超过 8MB 的原始文件会被拒绝。
