# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Release process:** the section for the version being released is read from
> this file and used as the GitHub Release body. Keep `## [Unreleased]`
> up-to-date as you develop, then "cut" it into a versioned section at release
> time. See `AGENTS.md` → "Release & Changelog" for the full workflow.

## [Unreleased]

### Added
- 微博关注流支持按凭据读取分组、下拉选择或手填 gid，并按分组自动命名信息源；新源可独立设置 UID 白名单，默认展示整个分组，旧源继续使用原有外部清单。
- 新增「微博用户动态」插件：按用户 UID 直接抓取作者主页时间线（`/ajax/statuses/mymblog`）。关注流接口会在服务端过滤个别微博（疑似限流/风控——作者主页可见但不进关注时间线），该插件作为补充确保指定作者的内容不漏，凭据与微博关注流复用

### Changed
- 微博关注流支持按关注分组抓取：新增「关注分组 gid」配置，默认改为只抓「特别关注」分组（gid 可从 weibo.com/mygroups 分组页链接复制），填 `all` 恢复抓取全部关注

### Fixed
- 微博用户动态不再把成功返回的空列表误报为 Cookie 失效；异常响应格式仍明确报错，刷新错误横幅仅在认证失败时提示重新登录。
- 微博关注流按账号、分组及作者过滤配置隔离刷新进度，分页游标依据过滤前的数据推进，修复白名单过滤后空页无法继续分页的问题。
- 微博关注流漏抓已在浏览器/手机端读过的微博：主接口从 `unreadfriendstimeline`（未读接口，受服务端已读位置影响）切换为 `friendstimeline`（完整关注时间线，与已读状态无关），保留 unreadfriendstimeline 与旧版 friends_timeline 作为回退链
- 微博关注流在两次刷新之间新微博超过抓取窗口时中间内容永久丢失：刷新时自动向下翻页（「每次刷新翻页数上限」配置，默认 20、上限 20，页间 500ms 延迟），并维护会话内增量水位线——每次刷新回追到上次见过的最新微博为止，翻页深度随实际新增量自适应
- 微博关注流游标 sinceId 写入后永不前进的问题
- MCP 接口（list_items / search_items / get_item）返回的 `publishedAt`、`fetchedAt` 从 UTC 换算为中国时区（UTC+8，带偏移 ISO 格式），分页游标 nextCursor 保持 UTC 原值不受影响

## [0.3.0] - 2026-09-16

### Added
- 支持用户上传 zip 压缩包安装插件：解压后自动校验 `package.json` 的 `feedflow` 字段与 `fetchItems` 实现，安装到 `{userData}/plugins/` 并即时注册生效
- 插件列表区分「内置」与「用户安装」来源，用户安装的插件支持一键删除（同时清理目录、DB 记录及关联的信息源/条目）
- 新增 GitHub Trending 插件：抓取 github.com/trending 热门仓库，支持按语言和时间范围过滤，无需认证
- 新增 Hacker News 插件：基于官方公开 API，支持 Top / New / Best / Ask HN / Show HN / Jobs 多种信息流，无需认证
- 新增 Product Hunt 插件：双模式——无 Token 时使用公开 Atom Feed（产品名 + 标语），填写 Developer Token 后使用 GraphQL API 获取完整描述、投票数、评论数、缩略图等

### Changed
- Chrome 扩展 Cookie 同步升级：新增定期强制重同步（每 10 分钟）与失败自愈闭环——桌面端检测到 Cookie 失效时标记 provider，扩展在 1 分钟心跳内自动重同步浏览器最新 Cookie，必要时后台打开隐藏标签页触发站点轮换 cookie，验证通过后自动重新拉取对应信息流，全程无需手动操作
- Chrome 扩展版本 1.1.0 → 1.2.0
- 凭据与 Cookie 授权按真实情况区分：仅微博、X 等真正使用浏览器 Cookie 的 provider 出现在 Chrome 扩展弹窗中；GitHub Trending、Hacker News（无需认证）和 Product Hunt、V2EX（使用 Token）不再显示「授权」按钮。桌面端凭据面板也只展示需要凭据的 provider，并正确区分 Cookie / Token 类型

### Fixed
- 刷新失败提示按当前浏览的信息源过滤：单源视图只显示该源的错误，不再在 v2ex 等源下弹出微博等其它源的 Cookie 检查报错
- 修复已安装 Chrome 扩展但凭据页仍显示"安装扩展"提示的问题：Cookie 同步成功时即标记扩展活跃，并将 `extensionLastSeen` 持久化到 settings，App 重启后不再丢失状态

## [0.2.0] - 2026-08-09

### Added
- V2EX plugin with public API support
- Chrome 扩展 Cookie 自动同步
- Chrome 扩展自动发布流程 + 隐私权政策
- `CHANGELOG.md` and release changelog mechanism; release notes now sourced from this file
- `README.md`; `CLAUDE.md` reorganized into `AGENTS.md` with a pointer `CLAUDE.md`
- X (Twitter) plugin: inline expansion of truncated long tweets via `fetchItemDetail` (mirrors weibo "展开更多" behavior)

### Changed
- Open all links in the system browser uniformly
- Timeline "展开" button now shown whenever content is actually clipped by CSS line-clamp (was previously gated on a 300-character threshold, so many multi-line posts had no expand control)

### Fixed
- X (Twitter) plugin: fix `fetchItemDetail` returning HTTP 422 by updating the stale `TweetResultByRestId` and `Viewer` GraphQL operation IDs, fixing the dynamic operation-ID resolver to look at `x.com/home` (where `main.{hash}.js` is still served), and adding the `longform_notetweets_*` feature flags required to fetch full `note_tweet` text
- 微博 plugin: fix XSRF-TOKEN 失效导致关注时间线拉取失败

## [0.1.0] - 2026-08-01

First stable release.

### Added
- Multi-source feed aggregation (微博 home timeline, 微博 group chat, X home timeline)
- Plugin system: sources are plugins under `plugins/` with a `FeedFlowPlugin` interface
- Encrypted credential management (cookies scoped by `provider`, shared across plugins)
- Provider concept: credentials belong to a provider (e.g. `weibo`, `x`) rather than a single plugin
- Independent Settings page (credentials, plugins, MCP)
- MCP Server exposing `list_sources`, `list_items`, `search_items`, `get_item`, `refresh_source` over HTTP
- Inline expansion of truncated items (e.g. long weibo posts) via `fetchItemDetail`
- Pull-to-refresh and infinite scroll in the timeline
- In-app auto-update via `electron-updater`
- GitHub Actions CI (build/type-check) and Release (mac/win/linux packaging + signing/notarization) workflows

### Fixed
- X video playback, startup auto-refresh, and invalid tweet filtering
- 微博 group chat image loading
- Various `provider` migration and default-value issues

[Unreleased]: https://github.com/joyme123/feedflow/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/joyme123/feedflow/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/joyme123/feedflow/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/joyme123/feedflow/releases/tag/v0.1.0
