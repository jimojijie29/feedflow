/**
 * hn-api.js — Hacker News 官方 API 封装
 *
 * 基于 Hacker News 官方公开 API（Firebase Realtime Database），无需认证。
 * API 文档: https://github.com/HackerNews/API
 *
 * 核心接口:
 *   - GET /v0/topstories.json   — 热门故事 ID 列表（最多 500）
 *   - GET /v0/newstories.json   — 最新故事 ID 列表（最多 500）
 *   - GET /v0/beststories.json  — 最佳故事 ID 列表（最多 500）
 *   - GET /v0/askstories.json   — Ask HN ID 列表（最多 200）
 *   - GET /v0/showstories.json  — Show HN ID 列表（最多 200）
 *   - GET /v0/jobstories.json   — 招聘信息 ID 列表（最多 200）
 *   - GET /v0/item/{id}.json    — 单条故事/评论详情
 */

const https = require('https')

const API_HOST = 'hacker-news.firebaseio.com'

// ============================================================
// 自定义错误类
// ============================================================

class ApiError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

// ============================================================
// HTTP GET 工具
// ============================================================

function httpsGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: API_HOST,
        path,
        headers: {
          'User-Agent':
            'FeedFlow/1.0 (https://github.com/joyme123/feedflow)',
          'Accept': 'application/json'
        },
        timeout: 15000
      },
      (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => {
          if (res.statusCode === 429) {
            reject(new ApiError(429, '请求过于频繁，请稍后重试'))
            return
          }
          if (res.statusCode >= 400) {
            reject(new ApiError(res.statusCode, `API 返回错误 (${res.statusCode})`))
            return
          }
          try {
            const json = JSON.parse(body)
            resolve(json)
          } catch (e) {
            reject(new Error(`解析响应失败: ${body.slice(0, 200)}`))
          }
        })
      }
    )
    req.on('error', (err) => reject(err))
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('请求超时，请稍后重试'))
    })
  })
}

// ============================================================
// 故事 ID 列表（按信息流类型）
// ============================================================

const FEED_ENDPOINTS = {
  top: '/v0/topstories.json',
  new: '/v0/newstories.json',
  best: '/v0/beststories.json',
  ask: '/v0/askstories.json',
  show: '/v0/showstories.json',
  jobs: '/v0/jobstories.json'
}

/**
 * 获取指定信息流类型的故事 ID 列表
 * @param {string} feedType - top / new / best / ask / show / jobs
 * @returns {Promise<number[]>} 故事 ID 数组
 */
function fetchStoryIds(feedType) {
  const path = FEED_ENDPOINTS[feedType] || FEED_ENDPOINTS.top
  return httpsGet(path)
}

// ============================================================
// 单条故事详情
// ============================================================

/**
 * 获取单条故事/评论详情
 * @param {number|string} id - 故事 ID
 * @returns {Promise<Object>} 故事对象
 */
function fetchItem(id) {
  return httpsGet(`/v0/item/${id}.json`)
}

/**
 * 批量获取故事详情（带并发控制，避免打爆 API）
 * @param {number[]} ids - 故事 ID 数组
 * @param {number} concurrency - 并发数，默认 10
 * @returns {Promise<Object[]>} 故事对象数组（过滤掉失败的）
 */
async function fetchItemsByIds(ids, concurrency = 10) {
  const results = []
  for (let i = 0; i < ids.length; i += concurrency) {
    const batch = ids.slice(i, i + concurrency)
    const batchResults = await Promise.all(
      batch.map((id) =>
        fetchItem(id).catch((err) => {
          // 单条失败不影响整体，返回 null 后过滤
          return null
        })
      )
    )
    results.push(...batchResults)
  }
  return results.filter(Boolean)
}

module.exports = {
  ApiError,
  fetchStoryIds,
  fetchItem,
  fetchItemsByIds
}
