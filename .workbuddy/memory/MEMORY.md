# Vclip 项目长期记忆（压缩版）

局域网剪贴板：手机/VR 发文本与图片，另一端即开即看。

## 架构
- 前端：React 19 + Vite 6 + TS + Tailwind，SPA，`dist/` 由后端托管
- 后端：`server.mjs` 单文件，`node:http` + `node:sqlite`(`DatabaseSync`)，**运行时零 npm 依赖**，Node 22+
- 端口 4173（`listen(port)` 无 host，双栈）；`PORT` 可覆盖
- 数据：`data/vclip.db`（WAL）、`data/uploads/`（图片二进制）、`logs/access-YYYY-MM-DD.log`
- `.env` 由文件内 `loadEnvFile()` 解析，**进程环境变量优先于 `.env`**；改完必须重启
- 静态资源走 `sendStaticAsset()`：br(q5)/gzip(6) 压一次进内存 Map（key=path+mtime+enc），带 ETag/304/Cache-Control；`/assets/` immutable 一年、html/webmanifest `no-cache`、图标 7 天。JS 340KB → 104KB
- `server.keepAliveTimeout = 65_000`（默认 5s 会被隧道复用连接撞出 ECONNRESET）；`sendJSON` 一律 `no-store`

## 认证模型（2026-11-08 版现状：**没有局域网免密、没有 loginKey**）
- 密码登录一次 → `vclip_session` Cookie 365 天（HttpOnly + SameSite=Lax）；值 = `HMAC-SHA256(密码|入口路径)` 派生，改密码即全体失效
- **登录入口是 `POST /${secretPath}`**（表单 `password` 字段），不是 `/__login`；`/__logout` 仍存在
- `?k=<loginKey>` 免密、`LAN_FREE_ACCESS`、`isLanTrusted()`、`isPublicAsset` **均已在当前代码中移除**，勿按旧记忆调试
- 未认证：`/api/*` 回 `401`，入口页渲染登录表单，manifest 回 401
- 入口路径 `SECRET_PATH` 仅服务端校验；不匹配时对任何来源（含本机、含已登录）都返回 404
- 图标免鉴权靠路由里的 `isPublicIcon` 正则（icon*.svg / icon-*.png / apple-touch-icon* / favicon），否则 iOS 加主屏拿不到图；**登录页也必须声明 apple-touch-icon + manifest**

## 图片上传（**原图无损 + 缩略图**，2026-11-06 改造）
- `POST /api/clips` 按 `Content-Type: image/*` 分流，二进制落盘，`content` 只存文件名
- **原图一个字节都不改**：旧的「900KB 以上压成 2400px JPEG q.86」已删除，实测 1557291B 进 1557291B 出
- 非 PNG/JPEG/GIF/WebP（HEIC/TIFF/BMP）服务端不收 → 前端转 JPEG q0.92，这是必要转码不是优化
- 缩略图：前端 canvas 生成长边 **480 的 WebP q0.72**，`POST /api/clips/:id/thumb` 单独提交
  - 实测：3840×2160 → 480×270 **9.7KB**；2160×3840 → 270×480 **4.5KB**；简单截图 858B
  - 单独接口而不是塞进 `/api/clips`，是为了不动二进制协议（F:\fastapi 也在用），也免写 multipart
- `clips.thumb` 列由启动时 `PRAGMA table_info` 检测后 `ALTER TABLE ADD COLUMN` 补齐，老记录为 NULL
- 列表地址优先级 `displayUrl`：`thumb` → 本地 blob（`localUrl`，刚上传）→ 原图（老记录）
- **删除/过期清理/pruneOrphan 都要同时处理 `content` 和 `thumb`**，漏一个就堆孤儿文件
- `GET /api/media/:filename`：文件名正则 + 扩展名白名单，`private, immutable` + `nosniff`
- 魔数嗅探 PNG/JPEG/GIF/WebP，**拒 SVG**；启动 `pruneOrphanUploads()` 清孤儿
- 前端用 `<img>` 解码（不用 `createImageBitmap`：Safari 15 支持晚且不套 EXIF）

## 带宽实测（2026-11-06，判断「能不能快」就看这张表）
- 局域网读 1.52MB：**9ms / 165MB/s**
- 本机 → CF 边缘 **上行**：**112KB/s**（1.52MB 用 13.9s，第二次直接失败）
- CF 边缘 → 本机 **下行**：**850KB/s**（2MB 用 2.3s）
- 走隧道读 1.52MB：40s 只到 0~1.1MB，**从未传完**；读 100KB 也只有 17.5KB/s
- **回源方向吃的是家宽上行**，隧道再打三折到 ~25KB/s → 2MB 一张要 80s+。换 `--protocol http2` 无效
- 结论：大图靠公网隧道没救，要么走 EasyTier 直连（`10.126.126.3:4173`），要么只传缩略图

## 踩过的坑
1. `isPageRequest('/api/x')` 为 true（按"无扩展名"判定）→ 放行 API 必须 `startsWith('/api/')`；漏 `/api/media/` 会让图片 401 破图（**已犯两次**）
2. 机器上可能残留旧 server 进程，表现为"改了 `.env` 没反应"；判据：`/__login` 返回 401 即旧版
3. Git Bash 会把参数里的 `/abc` 转成 Windows 路径 → 测 `next` 类参数用 `%2F`
4. 收二进制超限时**不能 `req.destroy()`**，连接一断 413 发不回去，前端只见"网络错误"
5. 竖图必须 `max-w-full max-h-[420px] w-auto`；`w-full` 会压成窄条
6. 上传成功后 id 由临时值变真实值会让 React 重建 → 必须用 `uid` 当 key
7. Edge 无头最小窗口约 500px，出 180px 图用 `--force-device-scale-factor`；`--virtual-time-budget` 冻结 rAF 会让 framer-motion 停在 `opacity:0`
8. `git push` 偶发 `schannel: failed to receive handshake`（代理端口切换）→ 重试一次即可
9. **换图标必须换 URL**：旧响应无 Cache-Control 时 CF 自动打 `max-age=14400` 并 `HIT`，服务器换了图边缘照喂旧图。现 index.html 手写 `?v=N`，manifest 用 mtime 36 进制自动版本号
10. **登录页也要声明 apple-touch-icon + manifest**：公网未登录时一切页面 302 到 `/__login`，在登录页「添加到主屏幕」只会得到灰方块
11. Edge 无头出小图：`--window-size=180,180` 渲染出来只有背景（截图早于绘制），必须窗口固定 512 + `--force-device-scale-factor=180/512`；`<img src="x.svg">` 同样会截空，要内联 SVG
12. iOS 主屏图标有系统级缓存，改了必须**删掉旧 PWA 重新添加**，否则一直是旧图
13. **图标体积必须压到几 KB**：隧道下 25KB 的 PNG 会在 18~24KB 处传不完（20s 超时），
    iOS 抓不到就退回 `<link rel="icon">` 的 SVG，而 iOS SVG 渲染器不支持 feDropShadow/渐变 → 变成「简陋的纯白 V」。
    现用纯双色图标：180px 3.1KB / 512px 9.5KB；文件名 `apple-touch-icon-180.png` 独立（不带 query），换图即彻底绕缓存
14. **本机测 API 拿到的 200 不代表 Cookie 正确**：`LAN_FREE_ACCESS=true` 会先按局域网免密放行，
    用错了派生值的 Cookie 本地照样 200，走域名才暴露 401。要验 Cookie 就用 `POST /__login` 拿真实 `Set-Cookie`
15. `logAccess()` 只在 `isPageRequest(path)` 为真时写日志，**带扩展名的 `/api/media/*.jpg` 根本不进日志**；
    「日志没有记录」不能当「请求没到」
16. Windows 上的 node 不认 Git Bash 的 `/tmp/x`（会当成 `E:\tmp\x`），bash 写 `/tmp` 与 node 读 `/tmp` 是两个目录
17. 测真实缩略图体积别用估算：起个本地小服务 + 无头 Edge 跑 canvas.toBlob，`--screenshot` 比
    `--virtual-time-budget` 可靠（后者会让异步 fetch 还没回来就退出）

## 部署与联动
- `启动vclip.bat`：本机无系统级 node，需扫 `%USERPROFILE%\.workbuddy\binaries\node\versions\*` 注入 PATH

## Cloudflare 隧道（remote-managed）
- Windows 服务 `Cloudflared`：`cloudflared tunnel run --token-file C:\ProgramData\cloudflared\token`
  → 路由全在 **Dashboard**，`~/.cloudflared/config.yml` 里那句 `qqtang-match.fun → localhost:3000` **不生效**，别照着改
- 实际映射 **`dora.qqtang-match.fun` → `localhost:4173`**；访问根域名 `qqtang-match.fun` 会拿到 `error 1033`
- 回源落在 **LAX**；实测直连传大文件 30s 必超时（响应体传不完），走系统代理 `127.0.0.1:11420` 虽抖但能完成
- 诊断：`cloudflared tunnel run --token-file ...` 前台跑一次，会打印 ingress / connectivity pre-check / `Registered tunnel connection location=...`
- 防火墙已有 `Allow EasyTier TCP 4173`（Inbound/Allow/Any profile/RemoteAddress=Any）
- EasyTier 虚拟网卡 `10.126.126.3` 属私有网段 → 免密直进，是独立于端口映射的入站通路
- 配套 `F:\fastapi`（文件分享）用 `POST /api/clips` + Basic Auth 推链接，可带 `expires_at`

## 已知风险（用户已知悉，勿反复提）
- `/__login` 无限速，安全性全靠密码强度（当前 6 位数字）
- 仓库为**公开**仓库，历史 `162d88c` 含真实入口路径，无法撤销
- 纯 HTTP 明文，密码与 Cookie 在链路上可被嗅探
