# Vclip

跨设备的极简文本剪贴板。手机、电脑、VR 浏览器之间传递文字和链接，不需要登录、不需要装客户端。

场景：在 VR 头显里想打开一个别人发来的链接，你没法打字。手机发一条到 Vclip，头显浏览器打开入口，点一下复制，结束。

## 技术架构

| 层 | 实现 |
|---|---|
| 前端 | React 19 + TypeScript + Vite 6，Tailwind + Framer Motion，打包为静态文件 |
| 服务端 | `server.mjs`，Node 原生 `node:http`，**无 Web 框架、无第三方运行时依赖** |
| 存储 | SQLite，通过 Node 22 内置的 `node:sqlite`（`DatabaseSync`），单文件落盘 |
| 鉴权 | HTTP Basic Auth（全站）+ 服务端强制校验的入口路径（`SECRET_PATH`） |

服务端只 import 四个内置模块：`node:http`、`node:fs`、`node:path`、`node:sqlite`。`package.json` 里的运行时依赖全部属于前端。

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

启动后访问 `http://localhost:4173/<SECRET_PATH>`，浏览器弹出 Basic Auth 密码框，输入 `ACCESS_PASSWORD` 即可。

## 环境变量

在项目根目录创建 `.env`（参考 `.env.example`）。服务端自己解析 `.env`，不依赖 `dotenv`；已存在的真实环境变量优先级更高。

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `SECRET_PATH` | 建议 | 空 | 入口路径，例如 `my-private-space`。为空时任意页面路径均可访问 |
| `ACCESS_PASSWORD` | 建议 | 空 | Basic Auth 密码。留空表示**不启用鉴权**，此时页面和接口完全开放 |
| `PORT` | 否 | `4173` | 监听端口 |
| `DB_PATH` | 否 | `data/vclip.db` | SQLite 文件路径，相对路径基于工作目录 |

兼容说明：旧的 `VITE_SECRET_PATH` 仍会被读取，但**推荐改用 `SECRET_PATH`**。`VITE_` 前缀的变量会被 Vite 编译进前端产物，与「入口不暴露给浏览器」的目标背道而驰。

## API

所有接口都需要 Basic Auth（用户名任意，只校验密码）。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/clips` | 返回最近 100 条未过期记录，按 `id` 倒序 |
| `POST` | `/api/clips` | 新建一条，返回完整行（含数据库生成的 `id` 和时间戳） |
| `DELETE` | `/api/clips/:id` | 删除指定记录 |

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

## 安全模型

三层保护，全部在服务端生效：

1. **Basic Auth**：整站生效，包括 API。密码错误或缺失直接 `401`。
2. **入口路径校验**：路径首段必须等于 `SECRET_PATH`，否则返回真正的 HTTP `404` 和独立错误页，**不会返回 `index.html`**。这段逻辑只在 `server.mjs`，前端 bundle 中没有入口字符串，查看源码拿不到。
3. **路径穿越防护**：静态文件解析后必须落在 `dist/` 内，否则 `403`。

已知边界：

- Basic Auth 是明文凭据（HTTPS 下加密传输）。**对外暴露时请务必套 HTTPS**，例如 Nginx/Caddy 反代并配置证书；直接用 HTTP 挂在公网等同于公开密码。
- 密码长度请至少 12 位。当前校验只比对密码部分，用户名可以随便填。

## 数据与备份

全部数据在 `data/vclip.db` 一个文件里。

```bash
# 停止服务后直接复制即可
cp data/vclip.db backup.db
```

WAL 模式下还会有 `vclip.db-wal` 和 `vclip.db-shm` 两个附属文件。推荐在线备份（不用停机）：

```bash
sqlite3 data/vclip.db ".backup backup.db"
```

首次启动自动建表，无需手工执行 DDL。过期清理在启动时执行一次，之后每 10 分钟一次，走 `idx_clips_expires_at` 索引。

## 访问日志

页面访问记录写入 `logs/access-YYYY-MM-DD.log`，每行格式：

```
2026-10-28T08:38:33.976Z | 192.168.1.10 | GET /my-private-space | 200 | Mozilla/5.0 ...
```

只记录页面请求（含可选的 `X-Forwarded-For` 真实 IP），不记录 API 调用和复制/删除操作。需要更完整的审计请在反向代理层保留日志。

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
├── server.mjs              # 全部服务端逻辑：静态托管、API、鉴权、日志、SQLite
├── src/
│   ├── App.tsx             # 单页 UI 与数据逻辑
│   ├── main.tsx
│   ├── index.css
│   └── Tailwind.ts
├── index.html
├── vite.config.ts
├── 启动vclip.bat            # Windows 一键启动
├── .env.example
└── data/vclip.db           # 运行时生成，已 gitignore
```

## 设计取舍

- **不用框架**：服务端只有三个接口和静态托管，Express/Fastify 属于净增依赖。
- **不用 `better-sqlite3`**：它需要原生模块编译，换 Node 大版本就要重装。`node:sqlite` 零依赖，代价是启动时需 `--disable-warning=ExperimentalWarning` 消掉实验性提示。
- **入口校验放服务端**：前端校验形同注释，看源码即得。宁可多一次 404 分支，也不要假的防护。
- **时间存 ISO 8601 UTC 文本**：SQLite 没有原生日期类型，这种格式的字典序比较恰好等价于时间比较，`WHERE expires_at > ?` 可以走索引。

## 已知限制

- `node:sqlite` 在 Node 22 仍标记为 experimental，API 未来可能微调。**升级 Node 大版本前请先跑一次 `npm run serve` 验证**。若真要换回 `better-sqlite3`，只需改 `import` 和三处 `statements` 调用，接口契约不变。
- 单进程单写入者。适合个人使用场景，不适合多实例部署共享同一个 `.db`。
- 内容以纯文本存储，暂不支持图片/文件。
