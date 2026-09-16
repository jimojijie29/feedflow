# PERSONAL.md — 个人定制分支规则与更新手册

> 本文件只存在于 `personal` 分支,记录本仓库的个人化工作流。上游更新不会覆盖它。

## 分支拓扑

| 分支 | 用途 | 规则 |
|---|---|---|
| `main` | 上游 joyme123/feedflow 的纯净镜像 | 永不直接提交;只 `merge --ff-only upstream/main` |
| `personal` | **日常运行 + 所有个性化定制** | 长期分支;日常始终停在此分支 |
| `fix/*`、`feat/*` | 短期特性/修复 | 完成后合入 `personal`;有通用价值的发 PR 到上游 |

远程:`origin` = 个人 fork(jimojijie29/feedflow),`upstream` = 上游(joyme123/feedflow)。**推送只到 origin。**

## 当前定制清单

| 内容 | 位置 | 状态 |
|---|---|---|
| X 视频 media 请求头崩溃修复 | `fix/x-video-media-header-crash`(已合入) | 上游 PR #1 待合并 |
| X 插件走系统代理(net.fetch) | `fix/x-api-proxy`(已合入) | 上游 PR 待发 |
| Node 22 再生 package-lock | `personal` | 上游 lock 停在 0.1.0,更新时可能冲突 |
| 启动脚本 run-local.bat / run-hidden.vbs | 仓库根 | `.git/info/exclude` 本地忽略,不入 git |

## 定制隔离规则

1. **新信息源/新功能 → 新插件目录**:`plugins/<插件名>/`(提交到 `personal`,新文件零冲突),或仓库外 `%APPDATA%\feedflow\plugins\`(完全脱离 git)。
2. **必须改上游文件时**:改动最小化;有通用价值的整理成独立 `fix/*` 分支 PR 回上游——被合并后本地差异自动消失。
3. 不碰 `main`、不直接对上游 push。

## 上游更新手册(上游发版后)

```bash
git fetch upstream
git checkout main && git merge --ff-only upstream/main
git checkout personal && git merge main     # 有冲突见下
# 若 package.json/lock 变动:
export PATH="/c/Users/Administrator/AppData/Local/nvm/v22.20.0:$PATH"
npm install                                 # 必须 Node 22
# 若 electron 或 better-sqlite3 版本变动:
npx prebuild-install --runtime electron --target <electron版本> -r better-sqlite3
npm run build
```

冲突处理惯例:
- `package-lock.json`:任选一方,然后 Node 22 下 `npm install` 重算,提交结果。
- 已上游化的本地修复(如 PR #1):冲突时采用上游版本。
- 其他:人工合并,保持定制部分。

重启验证:`taskkill /F /IM electron.exe`(注意无单实例锁)→ 运行 `run-hidden.vbs` →
冒烟测试:MCP `list_sources`、微博关注流刷新、X 时间线刷新各一次。
