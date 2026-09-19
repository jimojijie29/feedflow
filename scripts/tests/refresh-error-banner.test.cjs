const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

function render(error) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/src/components/timeline/RefreshErrorBanner.tsx'), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } })
  const context = {
    exports: {},
    require(name) {
      if (name === 'react') return {
        useState: initial => [typeof initial === 'object' ? { ...initial, status: 'active' } : initial, () => {}],
        useEffect() {}
      }
      if (name === '../../store') return { useStore: () => ({
        refreshProgress: [{ sourceId: 'test', sourceName: '微博用户动态', status: 'error', error }], selectedSourceId: null
      }) }
      if (name === '../common/Button') return { Button: ({ children }) => React.createElement('button', null, children) }
      if (name.endsWith('.css')) return { default: {} }
      return require(name)
    }
  }
  vm.runInNewContext(outputText, context)
  return renderToStaticMarkup(React.createElement(context.exports.RefreshErrorBanner))
}

test('ordinary refresh failures display their message without cookie advice', () => {
  for (const message of ['用户微博接口返回格式异常', '请求超时', '用户微博接口返回异常（ok=1, msg=无）。请检查 Cookie 是否有效、UID 是否正确。']) {
    const html = render(message)
    assert.match(html, /刷新失败/)
    assert.doesNotMatch(html, /Cookie 可能已过期|打开浏览器/)
  }
})

test('explicit cookie failures retain re-login guidance', () => {
  const html = render('用户微博接口暂时不可用（Cookie 已过期或无效，请重新登录 weibo.com 获取）。')
  assert.match(html, /Cookie 可能已过期/)
  assert.match(html, /打开浏览器/)
})
