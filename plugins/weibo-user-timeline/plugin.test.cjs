const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

function plugin(response, statusCode = 200) {
  const context = {
    module: { exports: {} }, URLSearchParams,
    console: { log() {}, warn() {} },
    require(name) {
      assert.equal(name, 'https')
      return {
        get(_, callback) {
          const request = new EventEmitter()
          request.destroy = () => {}
          queueMicrotask(() => {
            const res = new EventEmitter()
            res.statusCode = statusCode
            callback(res)
            res.emit('data', typeof response === 'string' ? response : JSON.stringify(response))
            res.emit('end')
          })
          return request
        }
      }
    }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'plugin.js'), 'utf8'), context)
  return context.module.exports.default
}

const config = { cookie: 'test-only-cookie', uid: '123' }

test('successful empty first page and history page are normal, with no next cursor', async () => {
  for (const cursor of [undefined, JSON.stringify({ maxId: '100' })]) {
    const result = await plugin({ ok: 1, data: { list: [] } }).fetchItems(config, cursor)
    assert.equal(result.items.length, 0)
    assert.equal(result.nextCursor, null)
  }
})

test('supported list envelopes still return real posts and pagination', async () => {
  const posts = [{ idstr: '12345', user: { id: 123, screen_name: '作者' }, text: '正文' }]
  for (const response of [{ ok: 1, data: { list: posts } }, { ok: 1, statuses: posts }, { ok: 1, data: { statuses: posts } }]) {
    const result = await plugin(response).fetchItems(config)
    assert.equal(result.items[0].externalId, '12345')
    assert.equal(JSON.parse(result.nextCursor).maxId, '12345')
  }
})

test('missing, malformed and unusable lists remain errors instead of becoming empty feeds', async () => {
  for (const data of [{}, { list: null }, { list: {} }, { list: [null, {}, []] }]) {
    for (const cursor of [undefined, JSON.stringify({ maxId: '100' })]) {
      await assert.rejects(plugin({ ok: 1, data }).fetchItems(config, cursor), error => {
        assert.match(error.message, /格式异常/)
        assert.doesNotMatch(error.message, /Cookie/)
        return true
      })
    }
  }
})

test('API failure is not swallowed as an empty history page', async () => {
  await assert.rejects(plugin({ ok: 0, msg: '用户不存在', data: { list: [] } }).fetchItems(config, '{"maxId":"100"}'), /用户不存在/)
})

test('actual authentication failures still request re-login', async () => {
  for (const code of [401, 403]) {
    await assert.rejects(plugin({}, code).fetchItems(config), /Cookie 已过期/)
  }
  await assert.rejects(plugin({ ok: -100, msg: '请先登录' }).fetchItems(config), /Cookie 已过期/)
})

test('rate limits and HTML responses do not claim an expired cookie', async () => {
  for (const [response, code] of [[{}, 429], ['<html>风控</html>', 200]]) {
    await assert.rejects(plugin(response, code).fetchItems(config), error => {
      assert.doesNotMatch(error.message, /Cookie/)
      return true
    })
  }
})
