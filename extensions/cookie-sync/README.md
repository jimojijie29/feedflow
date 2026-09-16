# FeedFlow Cookie 同步扩展

自动将浏览器中已登录的微博、X 等信息源 Cookie 同步到 FeedFlow 桌面端。

> **前置条件：**本扩展是 [FeedFlow 桌面端](https://github.com/joyme123/feedflow)
> 的配套组件，本身不展示信息流。请先下载安装桌面应用：
>
> 👉 **[FeedFlow 桌面端下载（GitHub Releases）](https://github.com/joyme123/feedflow/releases/latest)**
>
> 提供 macOS（arm64 / x64 dmg）、Windows（exe 安装包）、Linux（AppImage / deb）版本，
> 安装后应用支持自动更新。使用时保持桌面端运行，扩展通过 `127.0.0.1:33940`
> 与其本地通信。

## 功能

- **自动同步**：监听 Cookie 变化，自动同步到桌面端（防抖 5 秒）
- **初始同步**：扩展启动时自动同步已授权且有 Cookie 的信息源
- **失败自愈**：桌面端发现 Cookie 失效后，扩展在 1 分钟心跳内自动重同步，必要时通过隐藏标签页轮换 cookie；另有每 10 分钟定期强制重同步
- **状态面板**：展示各信息源的授权状态、Cookie 检测、同步状态
- **手动同步**：每个信息源可单独触发立即同步
- **动态授权**：新增插件时，扩展提示用户授权对应域名，无需更新扩展版本
- **自动同步开关**：可在面板中关闭自动同步

> 仅微博、X 等真正依赖浏览器 Cookie 的信息源需要本扩展；V2EX、Product Hunt
> 使用 Token，GitHub Trending、Hacker News 无需认证，均无需安装扩展。

## 安装

### 方式一：Chrome Web Store（推荐，普通用户）

👉 **[从 Chrome Web Store 安装 FeedFlow Cookie Sync](https://chromewebstore.google.com/detail/akacicfiihjhcjeifgibmhkobcaehiii)**

商店版本会自动更新。安装后确认 FeedFlow 桌面端正在运行，点击扩展图标即可看到连接状态。

### 方式二：开发者模式加载（仅用于开发调试）

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本目录
4. 扩展安装后会自动尝试连接 FeedFlow 桌面端（`127.0.0.1:33940`）

## 使用

1. 确保 FeedFlow 桌面端已打开
2. 点击扩展图标，查看各信息源状态
3. 未授权的信息源点击「授权并同步」
4. 在浏览器中登录对应网站（微博/X/V2EX），Cookie 会自动同步
5. 也可点击「立即同步」手动触发

## 通信协议

扩展通过本机 HTTP 与桌面端通信（`http://127.0.0.1:33940`）：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/providers` | 获取支持的信息源列表及域名 |
| GET | `/sync-status` | 获取各信息源同步状态 |
| POST | `/sync` | 同步 Cookie（`{ domain, cookie }`） |
| POST | `/heartbeat` | 扩展存活上报 |
