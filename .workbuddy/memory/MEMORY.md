# Vclip 项目长期记忆（压缩版）

局域网剪贴板：手机/VR 发文本与图片，另一端即开即看。

## 架构
- 前端：React 19 + Vite 6 + TS + Tailwind，SPA，`dist/` 由后端托管
- 后端：`server.mjs` 单文件，`node:http` + `node:sqlite`(`DatabaseSync`)，**运行时零 npm 依赖**，Node 22+
- 端口 4173（`listen(port)` 无 host，双栈）；`PORT` 可覆盖
- 数据：`data/vclip.db`（WAL）、`data/uploads/`（图片二进制）、`logs/access-YYYY-MM-DD.log`
- `.env` 由文件内 `loadEnvFile()` 解析，**进程环境变量优先于 `.env`**；改完必须重启

## 认证模型
- 密码登录一次 → `vclip_session` Cookie 365 天；值 = `HMAC-SHA256(密码|入口路径)` 派生，改密码即全体失效
- `/__login`（GET 表单 / POST 校验）、`/__logout`、`?k=<loginKey>` 免密登录一次
- API 未认证仍回 `401 + WWW-Authenticate`，兼容 curl 与配套 fastapi 项目
- 入口路径 `SECRET_PATH` 仅服务端校验；**不匹配时对任何来源都返回真 404**（含已登录、含局域网）
- `LAN_FREE_ACCESS=true`：**免密码但不免入口路径**
  `lanBypass = lanTrusted && (onSecretPath || isApiPath) || isPublicAsset`
- `isLanTrusted()` 用 `getClientIp()`：直连只信 socket 对端地址（转发头一概不读，可伪造）；**仅当对端是本机**（`localAddresses` = 回环 + 本机网卡）才采信 `CF-Connecting-IP` / `XFF` 首段。否则 cloudflared 隧道（从 127.0.0.1 连入）会把公网访客全变成"局域网"，整条隧道成免密后门
- 图标等 `isPublicAsset` 免鉴权，否则 iOS 加主屏拿不到图

## 图片上传
- `POST /api/clips` 按 `Content-Type: image/*` 分流，二进制落盘，`content` 只存文件名
- `GET /api/media/:filename`：文件名正则 + 扩展名白名单，`private, immutable` + `nosniff`
- 魔数嗅探 PNG/JPEG/GIF/WebP，**拒 SVG**；启动 `pruneOrphanUploads()` 清孤儿
- 前端用 `<img>` 解码压缩（不用 `createImageBitmap`：Safari 15 支持晚且不套 EXIF），长边 2400 / JPEG .86

## 踩过的坑
1. `isPageRequest('/api/x')` 为 true（按"无扩展名"判定）→ 放行 API 必须 `startsWith('/api/')`；漏 `/api/media/` 会让图片 401 破图（**已犯两次**）
2. 机器上可能残留旧 server 进程，表现为"改了 `.env` 没反应"；判据：`/__login` 返回 401 即旧版
3. Git Bash 会把参数里的 `/abc` 转成 Windows 路径 → 测 `next` 类参数用 `%2F`
4. 收二进制超限时**不能 `req.destroy()`**，连接一断 413 发不回去，前端只见"网络错误"
5. 竖图必须 `max-w-full max-h-[420px] w-auto`；`w-full` 会压成窄条
6. 上传成功后 id 由临时值变真实值会让 React 重建 → 必须用 `uid` 当 key
7. Edge 无头最小窗口约 500px，出 180px 图用 `--force-device-scale-factor`；`--virtual-time-budget` 冻结 rAF 会让 framer-motion 停在 `opacity:0`
8. `git push` 偶发 `schannel: failed to receive handshake`（代理端口切换）→ 重试一次即可

## 部署与联动
- `启动vclip.bat`：本机无系统级 node，需扫 `%USERPROFILE%\.workbuddy\binaries\node\versions\*` 注入 PATH
- 防火墙已有 `Allow EasyTier TCP 4173`（Inbound/Allow/Any profile/RemoteAddress=Any）
- EasyTier 虚拟网卡 `10.126.126.3` 属私有网段 → 免密直进，是独立于端口映射的入站通路
- 配套 `F:\fastapi`（文件分享）用 `POST /api/clips` + Basic Auth 推链接，可带 `expires_at`

## 已知风险（用户已知悉，勿反复提）
- `/__login` 无限速，安全性全靠密码强度（当前 6 位数字）
- 仓库为**公开**仓库，历史 `162d88c` 含真实入口路径，无法撤销
- 纯 HTTP 明文，密码与 Cookie 在链路上可被嗅探
