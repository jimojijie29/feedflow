/**
 * plugin.js — 微博用户动态插件（v1.0，基于 weibo.com AJAX API）
 *
 * 按指定用户抓取微博（/ajax/statuses/mymblog），作为「微博关注流」插件的补充：
 * 关注流接口（friendstimeline）会在服务端过滤个别微博（限流/风控），
 * 这些微博在作者主页可见但不进入关注时间线，导致关注流无论如何翻页都抓不到。
 * 本插件直接拉取作者主页时间线，确保指定作者的内容不漏。
 *
 * 数据来源: https://weibo.com (微博桌面版 AJAX 接口)
 * 认证方式: Cookie (与微博关注流插件共用同一凭据)
 *
 * 与 weibo-home-timeline 插件的关系:
 *   本插件按插件系统「自包含可独立安装」的约定，内联了与关注流插件相同的
 *   数据映射逻辑（长文清理、转发拼接、图片提取、日期解析），未跨插件引用。
 */

const https = require('https')

const WEIBO_HOST = 'weibo.com'

// ============================================================
// HTTP 基础（与 weibo-home-timeline/weibo-api.js 相同的请求约定）
// ============================================================

function sanitizeCookie(cookie) {
  if (!cookie) return ''
  return cookie.replace(/[\r\n\t]/g, '').trim()
}

function extractCookieField(cookie, fieldName) {
  if (!cookie) return ''
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${fieldName}=([^;]*)`))
  return match ? decodeURIComponent(match[1].trim()) : ''
}

function httpsGet(path, cookie, host = WEIBO_HOST) {
  const cleanCookie = sanitizeCookie(cookie)
  const xsrfToken = extractCookieField(cleanCookie, 'XSRF-TOKEN')
  const headers = {
    'Cookie': cleanCookie,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': `https://${host}/`
  }
  if (xsrfToken) {
    headers['x-xsrf-token'] = xsrfToken
  }
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: host, path, headers, timeout: 15000 }, (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => {
        if (res.statusCode === 403) {
          reject(new Error('Cookie 已过期或无效，请重新登录 weibo.com 获取'))
          return
        }
        try {
          const json = JSON.parse(body)
          if (json.ok === -100) {
            reject(new Error(json.msg || 'Cookie 已过期或需要重新登录，请重新登录 weibo.com'))
            return
          }
          if (json.ok !== undefined && json.ok !== 1 && json.ok !== 0) {
            reject(new Error(json.msg || `API 返回错误 (ok=${json.ok})`))
            return
          }
          resolve(json)
        } catch (e) {
          // 响应体可能是风控 HTML 页，内容不可控，仅记录到日志，不抛给用户界面
          console.warn(`[weibo-user] 解析响应失败，body 前 200 字符: ${body.slice(0, 200)}`)
          reject(new Error('解析 API 响应失败（可能触发了微博风控），请稍后重试'))
        }
      })
    })
    req.on('error', (err) => reject(err))
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('请求超时'))
    })
  })
}

// ============================================================
// weibo.com AJAX API
// ============================================================

/** 获取指定用户发布的微博: GET /ajax/statuses/mymblog?uid=&page=&count=&max_id= */
function fetchUserBlogs(cookie, uid, params) {
  const query = new URLSearchParams({ uid })
  if (params.page) query.set('page', params.page)
  if (params.count) query.set('count', params.count)
  if (params.max_id) query.set('max_id', params.max_id)
  return httpsGet(`/ajax/statuses/mymblog?${query.toString()}`, cookie)
}

/** 获取单条微博详情: GET /ajax/statuses/show?id= */
function fetchStatusById(cookie, id) {
  const query = new URLSearchParams({ id })
  return httpsGet(`/ajax/statuses/show?${query.toString()}`, cookie)
}

/** 获取长微博完整正文: GET m.weibo.cn/statuses/extend?id= */
function fetchLongTextById(cookie, id) {
  const query = new URLSearchParams({ id })
  return httpsGet(`/statuses/extend?${query.toString()}`, cookie, 'm.weibo.cn')
}

/** mymblog 响应: { ok, data: { list: [...] } } */
function extractStatuses(response) {
  const list = response?.data?.list || response?.statuses || response?.data?.statuses
  return Array.isArray(list) ? list : []
}

// ============================================================
// Plugin Metadata
// ============================================================

const meta = {
  id: 'feedflow-plugin-weibo-user',
  name: '微博用户动态',
  version: '1.0.0',
  description: '按用户抓取微博动态（绕过关注流服务端过滤，确保指定作者的微博不漏）',
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
    helpText: '与微博关注流共用同一个微博 Cookie 凭据，直接选择即可。'
  },
  {
    key: 'uid',
    label: '用户 UID',
    type: 'text',
    required: true,
    helpText: '要抓取的用户 UID：打开其微博主页，地址栏 weibo.com/u/6406710319 中的数字即是（部分主页为 weibo.com/昵称，进入后点任意一条微博，链接 weibo.com/数字/... 中的数字即是）'
  },
  {
    key: 'count',
    label: '每次获取条数',
    type: 'number',
    default: 25,
    min: 5,
    max: 50,
    helpText: '单次刷新获取该用户的最新微博数量（个人用户发布频率低，默认 25 条通常覆盖数天）'
  }
]

// ============================================================
// 数据映射（与 weibo-home-timeline 一致，自包含副本）
// ============================================================

function getFullText(status) {
  const rawText = status.text || ''
  const isTruncated = !status.long_text && /展开/.test(rawText)
  const text = status.long_text || rawText
  return { text: cleanExpandMarker(text), isTruncated }
}

function cleanExpandMarker(html) {
  if (!html) return ''
  return html
    .replace(/<a\b[^>]*>(?:(?!<\/?a\b)[\s\S])*?展开(?:(?!<\/?a\b)[\s\S])*?<\/a>/gi, '')
    .replace(/<span\b[^>]*class="[^"]*(?:expand|WB_text_opt)[^"]*"[^>]*>[\s\S]*?<\/span>/gi, '')
    .replace(/[.。…\s]*展开\s*$/g, '')
    .replace(/[.。…\s]+$/g, '')
    .trim()
}

function mapStatusToItem(status) {
  const user = status.user || {}
  const mid = status.mid || status.idstr || (status.id != null ? String(status.id) : '')

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

  const { text: mainText, isTruncated } = getFullText(status)
  let displayText = mainText

  if (status.retweeted_status) {
    const rtUser = status.retweeted_status.user
    const rtName = rtUser ? `@${rtUser.screen_name}` : ''
    const rtResult = getFullText(status.retweeted_status)
    displayText += `\n\n//${rtName}: ${rtResult.text}`
  }

  return {
    externalId: status.idstr || (status.id != null ? String(status.id) : ''),
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
  dateStr = String(dateStr || '')
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
// fetchItems
// ============================================================

/**
 * 获取指定用户的微博
 *
 * 刷新（无游标）时取最新一页；loadOlder 时按游标 maxId 继续向下取更旧的微博。
 * 个人用户发布频率低，单页 25 条通常已覆盖数天。
 *
 * 游标格式（与宿主的 {sinceId, maxId} 约定一致）: {"sinceId":"...","maxId":"..."}
 *
 * @param {SourceConfig} config - 用户配置 { cookie, uid, count }
 * @param {string|null} cursor  - 分页游标 JSON
 * @returns {Promise<FetchResult>}
 */
async function fetchItems(config, cursor) {
  const cookie = config.cookie
  if (!cookie) {
    throw new Error('微博 Cookie 未配置。请在源设置中填入 weibo.com 的 Cookie。')
  }
  const uid = String(config.uid || '').trim()
  if (!/^\d+$/.test(uid)) {
    throw new Error('用户 UID 未配置或格式不正确。UID 是微博主页链接 weibo.com/u/xxxx 中的纯数字部分。')
  }
  const count = Math.min(Math.max(config.count || 25, 5), 50)

  let maxId = null
  if (cursor) {
    try {
      const cursorObj = JSON.parse(cursor)
      maxId = cursorObj.maxId || null
    } catch {
      maxId = null
    }
  }

  console.log(`[weibo-user] fetchItems uid=${uid}, count=${count}, max_id=${maxId || '无'}`)

  try {
    const params = { count }
    if (maxId) params.max_id = maxId
    const response = await fetchUserBlogs(cookie, uid, params)
    // 过滤掉畸形条目，避免单条坏数据导致整页失败
    const statuses = extractStatuses(response).filter((s) => s && typeof s === 'object')
    console.log(`[weibo-user] ok=${response?.ok}, statuses=${statuses.length}`)

    const items = statuses
      .map(mapStatusToItem)
      .filter((item) => item.externalId)

    if (items.length > 0) {
      // 置顶微博可能重复出现在结果中，由宿主按 externalId 去重（upsert）
      const newestId = items[0].externalId
      const oldestId = items[items.length - 1].externalId
      const nextCursor = JSON.stringify({ sinceId: newestId, maxId: oldestId })
      return { items, nextCursor }
    }

    if (maxId) {
      // 向下翻页到没有更多：正常结束，返回空
      return { items: [], nextCursor: cursor || '' }
    }

    const detail = `ok=${response?.ok}, msg=${response?.msg || '无'}`
    throw new Error(`用户微博接口返回异常（${detail}）。请检查 Cookie 是否有效、UID 是否正确。`)
  } catch (err) {
    console.warn('[weibo-user] fetchItems failed:', err.message)
    if (err.message.includes('用户微博接口返回异常')) {
      throw err
    }
    throw new Error(`用户微博接口暂时不可用（${err.message}）。请稍后重试，或检查 Cookie 是否仍然有效。`)
  }
}

// ============================================================
// fetchItemDetail — 拉取单条微博完整正文（用于内联展开长文）
// ============================================================

async function fetchItemDetail(config, externalId) {
  const cookie = config.cookie
  if (!cookie) {
    throw new Error('微博 Cookie 未配置。请在源设置中填入 weibo.com 的 Cookie。')
  }
  if (!externalId) {
    throw new Error('缺少微博 ID，无法获取完整内容。')
  }

  const response = await fetchStatusById(cookie, externalId)
  const status = response?.data || response
  if (!status || (!status.text && !status.long_text)) {
    throw new Error('获取微博完整内容失败，请稍后重试。')
  }

  let displayText
  if (status.isLongText) {
    try {
      const ltRes = await fetchLongTextById(cookie, externalId)
      const longText = ltRes?.data?.longTextContent
      displayText = longText || getFullText(status).text
    } catch {
      displayText = getFullText(status).text
    }
  } else {
    displayText = getFullText(status).text
  }

  if (status.retweeted_status) {
    const rtUser = status.retweeted_status.user
    const rtName = rtUser ? `@${rtUser.screen_name}` : ''
    const rtResult = getFullText(status.retweeted_status)
    displayText += `\n\n//${rtName}: ${rtResult.text}`
  }

  return {
    content: {
      text: stripHtml(displayText) || '',
      html: displayText
    },
    metadata: { isTruncated: false }
  }
}

// ============================================================
// 生命周期
// ============================================================

async function onRegister(ctx) {
  ctx.logger.info('[weibo-user] 微博用户动态插件 (weibo.com AJAX) 已注册')
}

// ============================================================
// 导出
// ============================================================

const weiboUserPlugin = {
  meta,
  configSchema,
  fetchItems,
  fetchItemDetail,
  onRegister
}

module.exports = {
  default: weiboUserPlugin
}
