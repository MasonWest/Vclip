# Vclip

A high-performance, aesthetically pleasing cloud clipboard designed for seamless text transfer across devices.

## 🧠 Why Vclip?

Typing or transferring text inside VR (or between any devices) is painful.

- No easy copy-paste
- No quick way to send links
- Switching devices breaks your flow

**Vclip solves this.**

Send text from your phone or PC →  
Open in your VR browser →  
Copy instantly.

No login. No setup. Just works.

## 🛡️ Protection Mechanism

Vclip includes a "Secret Path" protection layer. The application is only accessible via a custom URL suffix. If the URL doesn't match your secret path, the application will return a 404 page.

Example: If your secret path is `my-tool`, access it via `https://your-domain.com/my-tool`.

此外，服务端还提供 HTTP Basic Auth 保护，页面和 API 都需要通过鉴权才能访问。

## 部署说明

1. **环境准备**：克隆项目并安装依赖 `npm install`。
2. **配置**：在根目录创建 `.env` 文件：
   ```env
   VITE_SECRET_PATH=你的自定义入口路径 (例如: my-private-space)
   ACCESS_PASSWORD=你的访问密码
   # 以下为可选项
   PORT=4173
   DB_PATH=data/vclip.db
   ```
3. **数据库**：无需手动建表。首次启动时会在 `data/vclip.db` 自动创建 SQLite 数据库和 `clips` 表（WAL 模式），过期记录由服务端每 10 分钟自动清理一次。
4. **构建**：`npm run build`
5. **启动本地服务**：`npm run serve`

启动后，浏览器会弹出 Basic Auth 密码框，输入 `ACCESS_PASSWORD` 才能访问页面。

### 开发模式

需要前后端分开调试时：先 `npm run serve`（占用 4173），再 `npm run dev`（5173）。Vite 已配置 `/api` 代理到 `http://localhost:4173`，接口可直接调用。

## 数据与备份

所有剪贴板内容存在 `data/vclip.db` 这一个文件里，直接复制该文件即可完成备份。

注意：WAL 模式下还会有 `vclip.db-wal` 和 `vclip.db-shm` 两个附属文件，建议先停止服务再拷贝，或使用 `sqlite3 data/vclip.db ".backup backup.db"` 做在线备份。

## 访问日志

如果你是自己用公网 IP 或端口映射对外提供服务，访问日志会写到本地：

- `logs/access-YYYY-MM-DD.log`

日志格式更简洁，包含：

- 时间
- 访问者 IP
- 请求路径
- 状态码
- User-Agent

说明：

- 这只记录“谁访问了页面”，不记录复制、删除之类的操作。
- 如果你要更完整的公网访问审计，建议还是在反向代理层保留一份访问日志。
- 当前实现不需要额外数据库表。
- 访问保护是服务端 Basic Auth，不会把密码暴露到前端。

## 设计理念

Vclip 采用 **Raycast 风格** 的极简设计，结合 **Framer Motion** 的流畅动效，追求极致的交互手感：
- **噪点质感背景**：消除死黑，增加高级感。
- **乐观 UI 更新**：发送即上屏，后台同步，无需等待。
- **隐私路径**：自定义入口，增加简单有效的安全防护。
