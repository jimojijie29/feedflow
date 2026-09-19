/**
 * plugin.js — 微博关注信息流插件（免费版 v4.3，基于 weibo.com AJAX API）
 *
 * 通过 weibo.com 的 AJAX JSON API 直接获取关注信息流。
 * 无需 OAuth、无需 App Key/Secret、完全免费、无需手动配置 UID。
 * 仅需用户提供 weibo.com 的浏览器 Cookie，插件自动获取关注流。
 *
 * 数据来源: https://weibo.com (微博桌面版 AJAX 接口)
 * 认证方式: Cookie (用户从浏览器登录后复制)
 *
 * 核心接口（按回退顺序）:
 *   - /ajax/feed/friendstimeline        — 完整关注时间线（与已读状态无关，主接口）
 *   - /ajax/feed/unreadfriendstimeline  — 未读关注流（已读微博不返回，回退）
 *   - /ajax/statuses/friends_timeline   — 旧版关注流（回退）
 *   - /ajax/statuses/mymblog            — 单用户微博（备用方案）
 *
 * v4.2 改进: 主接口切换为 friendstimeline，修复用户在浏览器/手机端已读过的微博
 *           从未读接口消失、导致 App 漏抓的问题；刷新时自动向下翻页（默认上限 5 页），
 *           补抓两次刷新之间超过单页条数的微博；并通过会话内增量水位线
 *           （记住上次刷新见过的最新微博 ID）自动回追，避免高密度关注流在
 *           固定页数窗口外的内容永久丢失。
 *
 * v4.3 改进: 支持按关注分组抓取（list_id）。默认抓取「特别关注」分组，
 *           可通过 listId 配置切换为全部关注（all）或其它分组的 gid。
 */

const {
  fetchFriendsTimeline,
  fetchFriendsTimelineFull,
  fetchFriendsTimelineFallback,
  fetchAllGroups,
  extractAllFollowListId,
  fetchUserBlogs,
  fetchStatusById,
  fetchLongTextById,
  extractStatuses
} = require('./weibo-api')
const { verifyCookie } = require('./auth')
const fs = require('fs')

// ============================================================
// Plugin Metadata
// ============================================================

const meta = {
  id: 'feedflow-plugin-weibo',
  name: '微博关注流',
  version: '4.3.0',
  description: '免费自动获取微博关注信息流（基于 weibo.com AJAX API，无需 OAuth）',
  author: 'FeedFlow',
  color: '#E6162D',
  provider: 'weibo',
  providerName: '微博',
  cookieDomains: ['weibo.com', 'weibo.cn']
}

// ============================================================
// Config Schema
// ============================================================

const configSchema = [
  {
    key: 'cookie',
    label: '微博凭据',
    type: 'credential',
    required: true,
    helpText: '选择一个已保存的微博 Cookie 凭据，或创建新凭据。凭据可在多个信息源间复用，无需重复粘贴。'
  },
  {
    key: 'count',
    label: '每次获取条数',
    type: 'number',
    default: 20,
    min: 1,
    max: 50,
    helpText: '单次刷新获取的微博数量'
  },
  {
    key: 'pages',
    label: '每次刷新翻页数上限',
    type: 'number',
    default: 20,
    min: 1,
    max: 20,
    helpText: '刷新会自动向下回追到上次见过的最新微博，翻页数只是上限（稳态下每次仅需 1-2 页）。长时间未刷新后想补抓更多历史时可调大'
  },
  {
    key: 'listId',
    label: '关注分组',
    type: 'select',
    required: true,
    helpText: '选择微博分组，或手填分组页面地址中 gid= 后面的数字。'
  },
  {
    key: 'authorFilterMode', label: '作者过滤', type: 'select', default: 'none',
    options: [
      { label: '整个分组', value: 'none' },
      { label: '独立 UID 白名单', value: 'uids' },
      { label: '原有外部清单', value: 'legacyExternal' }
    ]
  },
  {
    key: 'authorUids', label: '作者 UID 白名单', type: 'text-area',
    helpText: '仅在独立 UID 白名单模式下生效，以逗号、空格或换行分隔。'
  }
]

// ============================================================
// 缓存（避免重复 API 调用）
// ============================================================

const groupCache = new Map()
const LIST_ID_CACHE_TTL = 60 * 60 * 1000 // list_id 缓存 1 小时

async function listGroups(cookie) {
  if (!cookie) throw new Error('请先选择微博凭据')
  const response = await fetchAllGroups(cookie)
  if (response?.ok === 0 || !Array.isArray(response?.groups)) {
    throw new Error('微博分组读取失败，请检查凭据后重试')
  }
  const options = new Map()
  for (const section of response.groups) {
    for (const group of Array.isArray(section.group) ? section.group : []) {
      const value = String(group.gid ?? '').trim()
      if (/^\d+$/.test(value) && typeof group.title === 'string' && group.title.trim()) {
        options.set(value, { label: group.title.trim(), value })
      }
    }
  }
  if (!options.size) throw new Error('微博未返回可用分组，请重试或手填 gid')
  const allId = extractAllFollowListId(response)
  if (allId && options.has(String(allId))) {
    options.delete(String(allId))
    options.set('all', { label: '全部关注', value: 'all' })
  }
  groupCache.set(cookie, { allId, time: Date.now() })
  return [...options.values()]
}

function resolveAuthorFilter(config) {
  const mode = config.authorFilterMode ?? 'legacyExternal'
  if (mode === 'none') return { mode, ids: null }
  if (mode === 'legacyExternal') return { mode, ids: loadExternalWeiboFollows() }
  if (mode !== 'uids') throw new Error('未知的作者过滤方式')
  const ids = [...new Set(String(config.authorUids || '').trim().split(/[\s,，]+/).filter(Boolean))]
  if (!ids.length || ids.some(id => !/^\d+$/.test(id))) {
    throw new Error('请填写有效的数字 UID 白名单，以逗号、空格或换行分隔')
  }
  return { mode, ids: ids.sort() }
}

// 默认抓取「特别关注」分组的 gid（对应 weibo.com/mygroups?gid=3649296794726060）
const DEFAULT_SPECIAL_FOLLOW_GID = '3649296794726060'
const EXTERNAL_FOLLOWS_FILE = 'D:\\AI_Tools\\feedflow-archive\\config\\digest-follows.json'
let externalFollowsCache = null

function loadExternalWeiboFollows() {
  let stat
  try {
    stat = fs.statSync(EXTERNAL_FOLLOWS_FILE)
  } catch (err) {
    throw new Error(`外部微博关注人清单不可用：${EXTERNAL_FOLLOWS_FILE}（${err.message}）`)
  }
  if (externalFollowsCache && externalFollowsCache.mtimeMs === stat.mtimeMs) {
    return externalFollowsCache.ids
  }
  let data
  try {
    data = JSON.parse(fs.readFileSync(EXTERNAL_FOLLOWS_FILE, 'utf8'))
  } catch (err) {
    throw new Error(`外部微博关注人清单 JSON 无法解析：${EXTERNAL_FOLLOWS_FILE}（${err.message}）`)
  }
  const weibo = data && data.weibo
  const ids = weibo && typeof weibo === 'object' && !Array.isArray(weibo)
    ? Object.keys(weibo).map((id) => String(id).trim()).filter((id) => /^\d+$/.test(id))
    : []
  if (ids.length === 0) {
    throw new Error(`外部微博关注人清单为空或缺少 weibo 映射：${EXTERNAL_FOLLOWS_FILE}`)
  }
  const result = [...new Set(ids)]
  externalFollowsCache = { mtimeMs: stat.mtimeMs, ids: result }
  console.log(`[weibo] loaded external follow list: ${result.length} users from ${EXTERNAL_FOLLOWS_FILE}`)
  return result
}

function statusAuthorId(status) {
  const user = status?.user || {}
  return user.idstr || user.id || status?.user_id || status?.uid || null
}

// 会话内增量水位线：cookie + list_id + 作者过滤配置 → 上次见过的最新微博 ID。
// 刷新时向下翻页直到触及水位线，使翻页深度自动适配实际新增量
// （高密度关注流下，固定页数窗口外、两次刷新之间的内容会永久丢失）。
// key 含 list_id：切换分组后旧分组的最高 ID 普遍高于新分组，
// 若不区分会让首次刷新误判"已回追到水位线"而提前结束。
// 仅存活于主进程运行期间；重启后首次刷新按固定页数窗口补抓。
// 注意: Chrome 扩展自动同步会轮换 Cookie 值，轮换后水位线随之重置，
// 下一次刷新退化为固定页数窗口补抓（无害，仅多抓几页）。
const newestWatermarkByCookie = new Map()

// ============================================================
// 数据映射
// ============================================================

/**
 * 获取微博完整文本：优先使用 long_text 字段，否则清理 text 中的展开标记。
 *
 * 微博长文在 text 字段中会被截断，并附带一个 <a ...>...展开</a> 链接。
 * long_text 字段包含完整正文（纯文本），仅在正文超长时才存在。
 * 无论来源如何，都需要清理展开标记。
 *
 * @returns {{ text: string, isTruncated: boolean }} 清理后的文本及是否被截断
 */
function getFullText(status) {
  // 如果 long_text 不可用且 text 中包含"展开"链接，说明文本被截断了
  const rawText = status.text || ''
  const isTruncated = !status.long_text && /展开/.test(rawText)
  const text = status.long_text || rawText
  return { text: cleanExpandMarker(text), isTruncated }
}

/**
 * 清理微博 HTML 中的"展开"截断标记。
 *
 * 微博长文的 text 字段末尾通常包含：
 *   <a href="..." target="_blank">...展开</a>
 * 或被 <span class="expand"> / <span class="WB_text_opt"> 包裹的展开链接。
 * 此函数移除这些标记，以便 UI 层自行处理展开/收起。
 */
function cleanExpandMarker(html) {
  if (!html) return ''
  return html
    // 移除包含"展开"的 <a> 标签（允许内部有嵌套标签如 <i>/<span>，
    // 但用负向前瞻防止跨越其他 <a> 标签，避免误删前面的链接/话题标签）
    .replace(/<a\b[^>]*>(?:(?!<\/?a\b)[\s\S])*?展开(?:(?!<\/?a\b)[\s\S])*?<\/a>/gi, '')
    // 移除包含"展开"的 <span> 包裹层（expand / WB_text_opt 等微博特有类名）
    .replace(/<span\b[^>]*class="[^"]*(?:expand|WB_text_opt)[^"]*"[^>]*>[\s\S]*?<\/span>/gi, '')
    // 移除尾部残留的"…展开"、"...展开"等纯文本标记（不在任何标签内的情况）
    .replace(/[.。…\s]*展开\s*$/g, '')
    // 清理尾部残留的省略号
    .replace(/[.。…\s]+$/g, '')
    .trim()
}

function mapStatusToItem(status) {
  const user = status.user || {}
  const mid = status.mid || status.idstr || String(status.id)

  // 提取图片 URL
  const mediaUrls = []
  if (status.pic_ids && Array.isArray(status.pic_ids)) {
    for (const picId of status.pic_ids) {
      mediaUrls.push(`https://wx1.sinaimg.cn/large/${picId}.jpg`)
    }
  }
  if (mediaUrls.length === 0 && status.pic_urls && Array.isArray(status.pic_urls)) {
    for (const pic of status.pic_urls) {
      if (pic.thumbnail_pic) {
        mediaUrls.push(pic.thumbnail_pic.replace('/thumbnail/', '/large/'))
      }
    }
  }
  if (mediaUrls.length === 0 && status.original_pic) mediaUrls.push(status.original_pic)
  if (mediaUrls.length === 0 && status.bmiddle_pic) mediaUrls.push(status.bmiddle_pic)

  // 处理正文：优先使用 long_text（完整内容），否则清理 text 中的展开标记
  const { text: mainText, isTruncated } = getFullText(status)
  let displayText = mainText

  // 处理转发微博
  if (status.retweeted_status) {
    const rtUser = status.retweeted_status.user
    const rtName = rtUser ? `@${rtUser.screen_name}` : ''
    const rtResult = getFullText(status.retweeted_status)
    displayText += `\n\n//${rtName}: ${rtResult.text}`
  }

  return {
    externalId: status.idstr || String(status.id),
    author: {
      name: user.screen_name || 'unknown',
      avatarUrl: user.avatar_large || user.profile_image_url || '',
      profileUrl: user.id ? `https://weibo.com/u/${user.id}` : ''
    },
    content: {
      text: stripHtml(displayText) || '',
      html: displayText
    },
    mediaUrls,
    permalink: user.id && mid ? `https://weibo.com/${user.id}/${mid}` : '',
    publishedAt: parseWeiboDate(status.created_at),
    metadata: {
      repostsCount: status.reposts_count || 0,
      commentsCount: status.comments_count || 0,
      attitudesCount: status.attitudes_count || 0,
      source: stripHtml(status.source || ''),
      isRetweet: !!status.retweeted_status,
      isTruncated: isTruncated
    }
  }
}

function parseWeiboDate(dateStr) {
  if (!dateStr) return new Date().toISOString()
  if (dateStr === '刚刚') return new Date().toISOString()

  const minMatch = dateStr.match(/(\d+)分钟前/)
  if (minMatch) return new Date(Date.now() - parseInt(minMatch[1]) * 60000).toISOString()

  const hourMatch = dateStr.match(/(\d+)小时前/)
  if (hourMatch) return new Date(Date.now() - parseInt(hourMatch[1]) * 3600000).toISOString()

  const todayMatch = dateStr.match(/今天\s*(\d{1,2}):(\d{2})/)
  if (todayMatch) {
    const d = new Date()
    d.setHours(parseInt(todayMatch[1]), parseInt(todayMatch[2]), 0, 0)
    return d.toISOString()
  }

  const yesterdayMatch = dateStr.match(/昨天\s*(\d{1,2}):(\d{2})/)
  if (yesterdayMatch) {
    const d = new Date(Date.now() - 86400000)
    d.setHours(parseInt(yesterdayMatch[1]), parseInt(yesterdayMatch[2]), 0, 0)
    return d.toISOString()
  }

  const dateMatch = dateStr.match(/^(\d{1,2})-(\d{1,2})$/)
  if (dateMatch) {
    const d = new Date()
    d.setMonth(parseInt(dateMatch[1]) - 1, parseInt(dateMatch[2]))
    d.setHours(0, 0, 0, 0)
    return d.toISOString()
  }

  const d = new Date(dateStr)
  if (!isNaN(d.getTime())) return d.toISOString()
  return new Date().toISOString()
}

function stripHtml(html) {
  if (!html) return ''
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim()
}

// ============================================================
// fetchItems — 核心拉取逻辑
// ============================================================

/** 翻页间隔，避免连续请求触发限流 */
const PAGE_DELAY_MS = 500

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 提取微博条目的稳定 ID（idstr 优先） */
function statusIdOf(status) {
  if (!status) return ''
  return status.idstr || (status.id != null ? String(status.id) : '')
}

/**
 * 按回退链请求一页关注时间线:
 *   friendstimeline（完整关注流，与已读状态无关，主接口）
 *   → unreadfriendstimeline（未读接口，用户在浏览器/手机端已读的微博不返回）
 *   → statuses/friends_timeline（旧版接口，不需要 list_id/refresh）
 */
async function fetchTimelinePage(cookie, params) {
  try {
    return { response: await fetchFriendsTimelineFull(cookie, params), endpoint: 'friendstimeline' }
  } catch (errFull) {
    console.warn('[weibo] friendstimeline 失败，尝试 unreadfriendstimeline 回退:', errFull.message)
    await sleep(300) // 回退链之间加短延迟，避免限流时请求反而加倍
    try {
      return { response: await fetchFriendsTimeline(cookie, params), endpoint: 'unreadfriendstimeline' }
    } catch (errUnread) {
      console.warn('[weibo] unreadfriendstimeline 失败，尝试 friends_timeline 回退:', errUnread.message)
      await sleep(300)
      const fallbackParams = { count: params.count, list_id: params.list_id }
      if (params.max_id) fallbackParams.max_id = params.max_id
      else fallbackParams.since_id = params.since_id || '0'
      return { response: await fetchFriendsTimelineFallback(cookie, fallbackParams), endpoint: 'friends_timeline' }
    }
  }
}

/**
 * 获取微博关注信息流
 *
 * 主方案: /ajax/feed/friendstimeline（完整关注时间线，不受已读状态影响）
 * 回退链: friendstimeline → unreadfriendstimeline → statuses/friends_timeline
 *
 * 刷新（无 maxId 游标）时自动向下翻页（最多 pages 页），
 * 并以会话内水位线为回追终点，避免两次刷新之间新微博超过
 * 固定页数窗口时中间内容永久丢失。
 *
 * 游标格式:
 *   - sinceId: 增量刷新，获取比此 ID 更新的微博
 *   - maxId: 向下翻页，获取比此 ID 更旧的微博
 *
 * @param {SourceConfig} config - 用户配置
 * @param {string|null} cursor  - 分页游标 JSON: {"sinceId":"...","maxId":"..."}
 * @returns {Promise<FetchResult>}
 */
async function fetchItems(config, cursor) {
  const cookie = config.cookie
  if (!cookie) {
    throw new Error('微博 Cookie 未配置。请在源设置中填入 weibo.com 的 Cookie。')
  }

  const count = Math.min(config.count || 20, 50)
  const maxPages = Math.min(Math.max(config.pages || 20, 1), 20)

  // 解析游标
  let sinceId = null
  let maxId = null
  if (cursor) {
    try {
      const cursorObj = JSON.parse(cursor)
      sinceId = cursorObj.sinceId || null
      maxId = cursorObj.maxId || null
    } catch {
      sinceId = cursor // 兼容旧格式: 纯数字 ID
    }
  }

  // 解析 list_id：显式配置的 gid 优先；填 "all" 时自动解析「全部关注」；
  // 留空默认抓「特别关注」分组（免配置、也省去 allGroups 请求）
  const configuredListId = String(config.listId || '').trim()
  let listId = null
  if (configuredListId && configuredListId !== 'all') {
    if (!/^\d+$/.test(configuredListId)) throw new Error('微博分组 gid 必须是数字')
    listId = configuredListId
  } else if (configuredListId === 'all') {
    // 获取 list_id (缓存 1 小时)
    const cached = groupCache.get(cookie)
    if (!cached || Date.now() - cached.time > LIST_ID_CACHE_TTL) await listGroups(cookie)
    listId = groupCache.get(cookie)?.allId
    if (!listId) throw new Error('无法解析全部关注分组，请重新加载分组或手填 gid')
  } else {
    listId = DEFAULT_SPECIAL_FOLLOW_GID
  }
  const filter = resolveAuthorFilter(config)
  const allowedAuthorSet = filter.ids ? new Set(filter.ids) : null
  const watermarkKey = JSON.stringify([cookie, listId, filter.mode, filter.ids?.slice().sort()])
  console.log(`[weibo] fetchItems params: count=${count}, since_id=${sinceId || '0'}, max_id=${maxId || '无'}, list_id=${listId || '无'}, maxPages=${maxPages}`)

  try {
    // 刷新（无起始 maxId）时自动向下翻页，补抓超过单页条数的新微博；
    // loadOlder（带 maxId）保持单页行为，由 UI 逐页触发
    const totalPages = maxId ? 1 : maxPages
    // 刷新时启用增量水位线：翻页直到触及上次刷新见过的最新微博，
    // 避免高密度时间线两次刷新之间的内容落在固定页数窗口之外
    const watermark = maxId ? null : (newestWatermarkByCookie.get(watermarkKey) || null)
    let reachedWatermark = false
    let stoppedEarly = false // 空页/重复页/翻页失败等提前结束，与"页数用尽"区分
    const seen = new Set()
    const allStatuses = []
    const rawStatuses = []
    let exhausted = false
    let firstResponse = null
    let pageMaxId = maxId

    for (let page = 1; page <= totalPages; page++) {
      const params = { count, refresh: 4 }
      if (pageMaxId) {
        params.max_id = pageMaxId
      } else {
        params.since_id = watermark || sinceId || '0'
      }
      if (listId) {
        params.list_id = listId
      }

      const pageResult = await fetchTimelinePage(cookie, params).catch((err) => {
        // 首页失败：整体抛出（保留 Cookie 失效检测与回退链错误语义）；
        // 后续页失败：保留已抓取的页，提前结束翻页，避免部分成功变整体失败
        if (page === 1) throw err
        console.warn(`[weibo] page ${page}/${totalPages} 失败，保留已抓取的 ${allStatuses.length} 条并结束翻页:`, err.message)
        return null
      })
      if (!pageResult) { stoppedEarly = true; break }
      const { response, endpoint } = pageResult
      if (!firstResponse) {
        firstResponse = response
      }
      const statuses = extractStatuses(response)
      const newStatuses = []
      for (const s of statuses) {
        const id = statusIdOf(s)
        if (id && !seen.has(id)) {
          seen.add(id)
          newStatuses.push(s)
        }
      }
      const filteredStatuses = newStatuses.filter((status) => {
        if (!allowedAuthorSet) return true
        const authorId = statusAuthorId(status)
        return authorId != null && allowedAuthorSet.has(String(authorId))
      })
      allStatuses.push(...filteredStatuses)
      rawStatuses.push(...newStatuses)
      console.log(`[weibo] page ${page}/${totalPages} (${endpoint}): raw=${statuses.length}, unique=${newStatuses.length}, allowed=${filteredStatuses.length}`)

      const pageOldestId = statuses.length > 0 ? statusIdOf(statuses[statuses.length - 1]) : ''
      // 到达水位线：本页最旧条目不新于上次刷新的最新条目，中间已无缺口
      if (watermark && pageOldestId) {
        try {
          reachedWatermark = BigInt(pageOldestId) <= BigInt(watermark)
        } catch {
          reachedWatermark = false // 非数字 ID 时保守地继续翻页
        }
      }
      // 停止条件: 空页、整页重复、无有效 ID，或已回追到水位线。
      // 注意不能用 statuses.length < count 判断到底——微博接口可能不按请求的
      // count 返回（如请求 50 只回 25），短页不等于没有更早的内容。
      if (statuses.length === 0 || newStatuses.length === 0 || !pageOldestId || reachedWatermark) {
        exhausted = statuses.length === 0 || newStatuses.length === 0 || !pageOldestId
        if (!reachedWatermark) stoppedEarly = true
        break
      }
      pageMaxId = pageOldestId
      if (page < totalPages) await sleep(PAGE_DELAY_MS)
    }

    // 页数上限用尽（而非提前停止）仍未触及水位线：中间可能仍有缺口，提示调大翻页上限
    if (watermark && !reachedWatermark && !stoppedEarly && allStatuses.length > 0) {
      console.warn(`[weibo] 已翻满 ${totalPages} 页仍未回追到上次刷新位置，中间可能有遗漏；可在源设置中调大「每次刷新翻页数上限」`)
    }

    // 水位线前进到本次见过的最新条目（与 Map 当前值比较，并发刷新时不回退）
    if (!maxId && rawStatuses.length > 0) {
      const runNewestId = statusIdOf(rawStatuses[0])
      if (runNewestId) {
        const currentWatermark = newestWatermarkByCookie.get(watermarkKey) || null
        let shouldAdvance = true
        if (currentWatermark) {
          try {
            shouldAdvance = BigInt(runNewestId) > BigInt(currentWatermark)
          } catch {
            shouldAdvance = true
          }
        }
        if (shouldAdvance) newestWatermarkByCookie.set(watermarkKey, runNewestId)
      }
    }

    if (allStatuses.length > 0 || firstResponse?.ok === 1) {
      const items = allStatuses.map(mapStatusToItem)

      // 新游标: sinceId 前进到本次最新条目, maxId 取本次最旧条目
      const newestId = (firstResponse?.since_id_str || firstResponse?.since_id) ||
        (rawStatuses.length > 0 ? statusIdOf(rawStatuses[0]) : null)
      const oldestId = rawStatuses.length > 0 ? statusIdOf(rawStatuses[rawStatuses.length - 1]) : maxId

      const nextCursor = JSON.stringify({
        sinceId: newestId || sinceId || '',
        maxId: oldestId || ''
      })

      return { items, nextCursor: exhausted ? null : nextCursor }
    }

    // API 返回成功但无数据：可能是 Cookie 权限不足或接口变化
    const detail = firstResponse ? `ok=${firstResponse.ok}, msg=${firstResponse.msg || '无'}` : '无响应'
    throw new Error(`关注时间线接口返回异常（${detail}）。请检查 Cookie 是否仍然有效，或在浏览器中重新登录微博后自动同步。`)
  } catch (err) {
    console.warn('[weibo] fetchItems failed:', err.message)
    // 如果是上面主动抛出的错误，直接传递；否则包装为更友好的提示
    if (err.message.includes('关注时间线接口返回异常')) {
      throw err
    }
    throw new Error(`关注时间线接口暂时不可用（${err.message}）。请稍后重试，或检查 Cookie 是否仍然有效。`)
  }
}

// ============================================================
// fetchItemDetail — 拉取单条微博完整正文（用于内联展开长文）
// ============================================================

/**
 * 获取单条微博的完整内容。
 *
 * 关注时间线接口返回的长文会被截断（text 字段末尾带"展开"链接），
 * 此函数通过 /ajax/statuses/show 拉取单条详情，拿到 long_text 完整正文，
 * 供 UI 层内联展开，无需跳转浏览器。
 *
 * @param {SourceConfig} config - 用户配置（含 cookie）
 * @param {string} externalId - 微博 id (idstr / mid)
 * @returns {Promise<ItemDetailResult>}
 */
async function fetchItemDetail(config, externalId) {
  console.log('[weibo] fetchItemDetail CALLED, externalId=', externalId, '| hasCookie=', !!config.cookie, '| cookieLen=', config.cookie?.length)
  const cookie = config.cookie
  if (!cookie) {
    throw new Error('微博 Cookie 未配置。请在源设置中填入 weibo.com 的 Cookie。')
  }
  if (!externalId) {
    throw new Error('缺少微博 ID，无法获取完整内容。')
  }

  console.log('[weibo] fetchItemDetail calling fetchStatusById...')
  const response = await fetchStatusById(cookie, externalId)
  const status = response?.data || response
  if (!status || (!status.text && !status.long_text)) {
    throw new Error('获取微博完整内容失败，请稍后重试。')
  }

  // 长微博：weibo.com 的 /ajax/statuses/show 只返回截断 text，
  // 需调用 m.weibo.cn/statuses/extend 获取 longTextContent 完整正文
  let displayText
  if (status.isLongText) {
    console.log('[weibo] fetchItemDetail isLongText=true, calling fetchLongTextById...')
    try {
      const ltRes = await fetchLongTextById(cookie, externalId)
      const longText = ltRes?.data?.longTextContent
      if (longText) {
        console.log('[weibo] fetchItemDetail got longTextContent, length=', longText.length)
        displayText = longText
      } else {
        console.log('[weibo] fetchItemDetail longTextContent empty, fallback to text')
        displayText = getFullText(status).text
      }
    } catch (err) {
      console.log('[weibo] fetchItemDetail fetchLongTextById failed, fallback:', err.message)
      displayText = getFullText(status).text
    }
  } else {
    displayText = getFullText(status).text
  }

  // 处理转发微博
  if (status.retweeted_status) {
    const rtUser = status.retweeted_status.user
    const rtName = rtUser ? `@${rtUser.screen_name}` : ''
    const rtResult = getFullText(status.retweeted_status)
    displayText += `\n\n//${rtName}: ${rtResult.text}`
  }

  const result = {
    content: {
      text: stripHtml(displayText) || '',
      html: displayText
    },
    // 已拿到完整正文，不再标记为截断
    metadata: { isTruncated: false }
  }
  console.log('[weibo] fetchItemDetail RETURNING content.text length=', result.content.text.length)
  return result
}

// ============================================================
// 生命周期
// ============================================================

async function onRegister(ctx) {
  ctx.logger.info('[weibo] 微博关注流插件 (weibo.com AJAX) 已注册')
}

// ============================================================
// 导出
// ============================================================

const weiboPlugin = {
  meta,
  configSchema,
  fetchItems,
  fetchItemDetail,
  onRegister
}

module.exports = {
  default: weiboPlugin,
  verifyCookie,
  listGroups
}
