const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const realApi = require('./weibo-api')

// Isolate module caches and mock network/files without touching real credentials.
function setup({ groups, timeline, legacy } = {}) {
  const calls = []
  let fileReads = 0
  let groupReads = 0
  const api = {
    ...realApi,
    fetchAllGroups: async cookie => {
      groupReads++
      return groups ? groups(cookie) : { groups: [{ group_type: 0, group: [{ gid: '100011', title: '全部关注' }] }] }
    },
    fetchFriendsTimelineFull: async (cookie, params) => {
      calls.push({ cookie, ...params })
      return timeline ? timeline(cookie, params) : { ok: 1, statuses: [status('20', '1'), status('10', '2')] }
    }
  }
  const context = {
    module: { exports: {} }, console: { log() {}, warn() {} },
    setTimeout: callback => { callback(); return 0 },
    require: name => {
      if (name === './weibo-api') return api
      if (name === './auth') return { verifyCookie() {} }
      if (name === 'fs') return {
        statSync() { if (!legacy) throw new Error('missing file'); return { mtimeMs: 1 } },
        readFileSync() { fileReads++; return JSON.stringify(legacy) }
      }
      throw new Error(`Unexpected dependency: ${name}`)
    }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'plugin.js'), 'utf8'), context)
  return { ...context.module.exports, calls, fileReads: () => fileReads, groupReads: () => groupReads }
}

function status(id, author) {
  return { idstr: id, text: '测试微博', user: { idstr: author, screen_name: author } }
}
const config = { cookie: 'account-a', listId: '123', authorFilterMode: 'none', pages: 1 }

test('group listing normalizes numeric IDs, deduplicates and includes all-follow', async () => {
  const h = setup({ groups: () => ({ groups: [{ group_type: 0, group: [
    { gid: 100011, title: '全部关注' }, { gid: '123', title: '科研' },
    { gid: '123', title: '科研' }, { gid: 'invalid', title: 'invalid' }
  ] }] }) })
  assert.deepEqual(JSON.parse(JSON.stringify(await h.listGroups('a'))), [
    { label: '科研', value: '123' }, { label: '全部关注', value: 'all' }
  ])
})

test('invalid and empty group responses fail explicitly', async () => {
  for (const response of [{ ok: 0 }, {}, { groups: [] }]) {
    const h = setup({ groups: () => response })
    await assert.rejects(h.listGroups('a'), /分组/)
  }
})

test('all-follow caches are isolated by credential; no fallback to unrestricted feed', async () => {
  const h = setup({ groups: cookie => ({ groups: [{ group_type: 0, group: [
    { title: '全部关注', gid: cookie === 'account-a' ? '100011' : '100012' }
  ] }] }) })
  await h.default.fetchItems({ ...config, listId: 'all' })
  await h.default.fetchItems({ ...config, listId: 'all', cookie: 'account-b' })
  await h.default.fetchItems({ ...config, listId: 'all' })
  assert.deepEqual(h.calls.map(call => call.list_id), ['100011', '100012', '100011'])
  assert.equal(h.groupReads(), 2)
  const missing = setup({ groups: () => ({ groups: [{ group: [{ gid: '123', title: '科研' }] }] }) })
  await assert.rejects(missing.default.fetchItems({ ...config, listId: 'all' }), /无法解析/)
  assert.equal(missing.calls.length, 0)
})

test('new sources do not read external files; legacy configs preserve both defaults', async () => {
  const h = setup()
  assert.equal((await h.default.fetchItems(config)).items.length, 2)
  assert.equal(h.fileReads(), 0)
  const old = setup({ legacy: { weibo: { '2': 'name' } } })
  const result = await old.default.fetchItems({ cookie: 'old', pages: 1 })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].externalId, '10')
  assert.equal(old.calls[0].list_id, '3649296794726060')
  assert.equal(old.fileReads(), 1)
  await assert.rejects(h.default.fetchItems({ cookie: 'old' }), /外部微博关注人清单不可用/)
})

test('UID lists accept delimiters and reject empty or malformed values', async () => {
  const h = setup()
  const result = await h.default.fetchItems({ ...config, authorFilterMode: 'uids', authorUids: '1, 1，2\n2' })
  assert.equal(result.items.length, 2)
  assert.equal(h.fileReads(), 0)
  for (const authorUids of ['', ' , ', '1 abc', '1.5']) {
    await assert.rejects(h.default.fetchItems({ ...config, authorFilterMode: 'uids', authorUids }), /UID/)
  }
})

test('filtered empty pages advance raw cursor and terminate on upstream exhaustion', async () => {
  const h = setup({ timeline: (_, params) => ({ ok: 1, statuses:
    params.max_id === '10' ? [status('9', '2')] : params.max_id === '9' ? [] : [status('20', '1'), status('10', '1')]
  }) })
  const cfg = { ...config, authorFilterMode: 'uids', authorUids: '2' }
  const first = await h.default.fetchItems(cfg)
  assert.equal(first.items.length, 0)
  assert.equal(JSON.parse(first.nextCursor).maxId, '10')
  const second = await h.default.fetchItems(cfg, first.nextCursor)
  assert.equal(second.items[0].externalId, '9')
  const end = await h.default.fetchItems(cfg, second.nextCursor)
  assert.equal(end.nextCursor, null)
})

test('refresh watermark uses raw data and isolates filter, group and account', async () => {
  const h = setup()
  const cfg = { ...config, authorFilterMode: 'uids', authorUids: '99' }
  await h.default.fetchItems(cfg)
  await h.default.fetchItems({ ...cfg, authorUids: '2' })
  await h.default.fetchItems(cfg)
  await h.default.fetchItems({ ...cfg, listId: '456' })
  await h.default.fetchItems({ ...cfg, cookie: 'account-b' })
  assert.deepEqual(h.calls.map(call => call.since_id), ['0', '0', '20', '0', '0'])
})

test('invalid manual gid fails before any timeline request', async () => {
  const h = setup()
  await assert.rejects(h.default.fetchItems({ ...config, listId: 'bad-gid' }), /gid/)
  assert.equal(h.calls.length, 0)
})

test('refresh traverses filtered pages before returning matching authors', async () => {
  const h = setup({ timeline: (_, params) => ({ ok: 1, statuses:
    params.max_id === '10' ? [status('9', '2')] : [status('20', '1'), status('10', '1')]
  }) })
  const result = await h.default.fetchItems({ ...config, pages: 2, authorFilterMode: 'uids', authorUids: '2' })
  assert.equal(h.calls.length, 2)
  assert.equal(result.items[0].externalId, '9')
  assert.equal(JSON.parse(result.nextCursor).maxId, '9')
})

test('explicit external mode uses legacy list and rejects empty lists', async () => {
  const h = setup({ legacy: { weibo: { '1': 'author' } } })
  const result = await h.default.fetchItems({ ...config, authorFilterMode: 'legacyExternal' })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].externalId, '20')
  const empty = setup({ legacy: { weibo: {} } })
  await assert.rejects(empty.default.fetchItems({ ...config, authorFilterMode: 'legacyExternal' }), /清单为空/)
})
