/**
 * 真实 DOM 渲染测试（jsdom + react-dom），不是 stub：
 * 把 client/client.js 当作浏览器 bundle 加载 → 用真实 React 18 渲染面板 →
 * 断言侧栏入口、4 个项目卡片、记忆隔离状态、并模拟点击「新建会话」，
 * 断言 sessions.create → selectModel → openSession 的真实调用参数。
 *
 * 依赖（不在插件包内，按需装到临时目录）：
 *   mkdir %TEMP%\ph-render && cd %TEMP%\ph-render
 *   npm i react@18.3.1 react-dom@18.3.1 jsdom@24
 * 运行：
 *   PH_RENDER_MODULES=%TEMP%\ph-render node scripts/test-client-dom.mjs client/client.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const clientFile = process.argv[2] ?? 'client/client.js'
const modulesDir = process.env.PH_RENDER_MODULES ?? path.join(process.env.TEMP ?? '/tmp', 'ph-render')
const req = createRequire(path.join(modulesDir, 'package.json'))
const React = req('react')
const ReactDOMClient = req('react-dom/client')
const { JSDOM } = req('jsdom')

const failures = []
function check(name, fn) {
  try {
    fn()
    console.log(`✓ ${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`✗ ${name}\n  ${String(error?.stack ?? error).split('\n').join('\n  ')}`)
  }
}
const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

/* ── 1. jsdom 环境 ─────────────────────────────────────── */
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:14215/',
  pretendToBeVisual: true,
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
// Node 22+ 的 globalThis.navigator 只有 getter，用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true })
globalThis.HTMLElement = window.HTMLElement
globalThis.MouseEvent = window.MouseEvent
globalThis.IS_REACT_ACT_ENVIRONMENT = false

/* ── 2. 假宿主数据（与真实 workspace.json / 会话行同形） ── */
const SOLO = 'D:\\projects\\dsh插件\\项目组开发插件'
const now = Date.now()
const workspaces = [
  { workspaceId: 'ws-default', path: 'C:\\Users\\Administrator\\Documents\\deepseek-harness\\default-workspace', title: 'default-workspace', sessionIds: ['s-default'], createdAt: '2026-10-31T14:39:30.199Z', updatedAt: '2026-11-10T06:30:00.000Z' },
  { workspaceId: 'ws-order', path: 'D:\\projects\\杨忠舜项目\\订单对账系统3.0', title: '订单对账系统3.0', sessionIds: ['s-order-1', 's-order-2'], createdAt: '2026-11-09T02:07:43.439Z', updatedAt: '2026-11-10T06:23:31.233Z' },
  { workspaceId: 'ws-team', path: 'D:\\projects\\dsh插件\\开发团队工作流', title: '开发团队工作流', sessionIds: ['s-team'], createdAt: '2026-11-10T07:01:55.979Z', updatedAt: '2026-11-10T07:04:36.061Z' },
  { workspaceId: 'ws-hub', path: SOLO, title: '项目组开发插件', sessionIds: ['s-hub'], createdAt: '2026-11-10T07:05:55.079Z', updatedAt: '2026-11-10T07:49:00.000Z' },
]
const sessionsById = {
  's-default': { id: 's-default', displayTitle: '默认工作区会话', updatedAt: now - 3600_000, blank: false, running: false },
  's-order-1': { id: 's-order-1', displayTitle: '对账 bug 修复', updatedAt: now - 7200_000, blank: false, running: true },
  's-order-2': { id: 's-order-2', displayTitle: '对账导出', updatedAt: now - 5 * 86400_000, blank: false, running: false },
  's-team': { id: 's-team', displayTitle: '团队 SOP 设计', updatedAt: now - 600_000, blank: false, running: false },
  's-hub': { id: 's-hub', displayTitle: '项目工作台插件', updatedAt: now - 60_000, blank: false, running: false },
}
const statePayload = {
  ok: true,
  version: 1,
  profileDir: 'C:\\Users\\Administrator\\.dsh\\profiles\\desktop',
  projects: {
    'ws-hub': { description: 'DSH 项目工作台插件', agentPreset: 'standard', provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high', updatedAt: '2026-11-10T07:49:00.000Z' },
  },
  memory: { available: true, namespace: 'mnemon', storageScope: 'workspaces', runtimeUserScope: 'global', projectScoped: true, error: null },
}

/* ── 3. 假 fetch（记录所有请求） ────────────────────────── */
const requests = []
globalThis.fetch = async (url, init = {}) => {
  const target = String(url)
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body
  requests.push({ url: target, method: init.method ?? 'GET', body })
  let payload = { ok: true }
  if (target.includes('/api/state')) payload = statePayload
  else if (target.includes('/api/rules')) payload = { ok: true, projectRoot: SOLO, files: [{ path: path.join(SOLO, 'AGENTS.md'), scope: 'project', exists: true, size: 120, excerpt: '# 项目规则' }] }
  else if (target.includes('/api/project')) payload = { ok: true, workspaceId: body?.workspaceId, project: body?.patch ?? {} }
  else if (target.includes('/api/memory-scope')) payload = { ok: true, memory: statePayload.memory }
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
}

/* ── 4. 加载 bundle（模拟 __ModuleLoader__） ─────────────── */
const captured = []
window.__ModuleLoader__ = { load: (registration) => captured.push(registration) }
const source = fs.readFileSync(clientFile, 'utf8')
new Function('window', 'document', 'navigator', 'fetch', source)(window, window.document, window.navigator, globalThis.fetch)
check('bundle 通过 __ModuleLoader__.load 注册且 id = dsh-project-hub', () => {
  if (captured.length !== 1) throw new Error(`load 调用次数 = ${captured.length}`)
  if (captured[0].id !== 'dsh-project-hub') throw new Error(`id = ${captured[0].id}`)
})
const requireStub = (specifier) => {
  if (specifier === 'react') return React
  if (specifier === 'react-dom' || specifier === 'react-dom/client') return req(specifier)
  if (specifier === 'react/jsx-runtime') return req('react/jsx-runtime')
  throw new Error(`unexpected require: ${specifier}`)
}
const plugin = captured[0].factory(requireStub)
check('插件导出 name / inject / apply', () => {
  if (plugin.name !== 'dsh-project-hub') throw new Error(`name = ${plugin.name}`)
  if (!Array.isArray(plugin.inject) || !plugin.inject.includes('slots')) throw new Error('inject 缺少 slots')
  if (typeof plugin.apply !== 'function') throw new Error('apply 不是函数')
})

/* ── 5. 假 cordis ctx（slots / locale / inject / get / effect） ── */
const registrations = []
const disposers = []
const localeDict = {}
const calls = { created: [], selection: null, opened: [], groupBy: [] }
const services = {
  sessions: {
    create: async (args) => { calls.created.push(args); return 'session-new-1' },
  },
  // 客户端模型选择走 Remote 命名空间（官方 ui-model-selection 即 ctx.remote.session.selectModel）
  remote: {
    session: {
      selectModel: async (args) => { calls.selection = args; return { ok: true, value: undefined } },
    },
  },
  // 官方 ui-workspace 的 view write set（侧栏分组模式）
  uiWorkspace: {
    openSession: (id) => calls.opened.push(id),
    startSession: () => {},
    view: { setGroupBy: (mode) => calls.groupBy.push(mode) },
  },
  layout: { panelInfo: { getSnapshot: () => ({ activePanelId: null }) }, selectPanel: () => {} },
}
const ctx = {
  effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose },
  get(name) { return services[name] },
  inject(names, callback) { return callback(services) },
  locale: {
    register(namespace, dict) { localeDict[namespace] = dict },
    bind(namespace) { return (key) => (localeDict[namespace]?.zh ?? {})[key] ?? key },
  },
  slots: {
    inject(name, callback) { return callback() },
    register(options, Component) { registrations.push({ options, Component }); return () => {} },
  },
}
/* ── 5b. 模拟 Claude 风格皮肤的日期视图（DOM 属性 + 开关事件） ── */
let dateViewToggles = 0
window.document.body.setAttribute('data-dsh-claude-date-groups', '')
window.document.addEventListener('dsh-claude-toggle-date-view', () => {
  dateViewToggles += 1
  window.document.body.removeAttribute('data-dsh-claude-date-groups')
})

plugin.apply(ctx)
await wait(60)
check('启动时关掉皮肤日期视图并把侧栏切回按工作区分组', () => {
  if (dateViewToggles < 1) throw new Error(`日期视图开关事件触发 ${dateViewToggles} 次`)
  if (!calls.groupBy.includes('workspace')) throw new Error(`setGroupBy 调用：${calls.groupBy.join(',') || '(空)'}`)
})

const main = registrations.find((entry) => entry.options.name === 'main')
const row = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
check('注册 main 面板（key=dsh-project-hub）与 sidebar.panellist（label=项目）', () => {
  if (!main) throw new Error('没有注册 main')
  if (main.options.key !== 'dsh-project-hub') throw new Error(`main.key = ${main.options.key}`)
  if (!row) throw new Error('没有注册 sidebar.panellist')
  if (row.options.id !== 'dsh-project-hub') throw new Error(`row.id = ${row.options.id}`)
  if (row.options.label() !== '项目') throw new Error(`label = ${row.options.label()}`)
})
/* ── 6. 用真实 React 18 渲染侧栏图标与面板 ─────────────── */
const iconHost = window.document.createElement('div')
window.document.body.appendChild(iconHost)
const iconRoot = ReactDOMClient.createRoot(iconHost)
iconRoot.render(React.createElement(row.Component, { size: 16 }))
await wait(60)
check('侧栏图标组件渲染出 svg', () => {
  if (!iconHost.querySelector('svg')) throw new Error('图标没有渲染出 svg')
})

const injected = main.options.inject()
const props = Object.assign({}, injected, {
  useWorkspaces: (selector) => selector({ items: workspaces, archivedSessionIds: [], pinnedSessionIds: [], phase: 'ready', state: 'idle' }),
  useSessions: (selector) => selector({ byId: sessionsById, ids: Object.keys(sessionsById), projectionsBySession: {} }),
  usePanelInfo: (selector) => selector({ activePanelId: null }),
})
const container = window.document.getElementById('root')
const root = ReactDOMClient.createRoot(container)
root.render(React.createElement(main.Component, props))
await wait(120)

const text = () => container.textContent ?? ''
check('渲染出标题与副标题', () => {
  if (!text().includes('项目工作台')) throw new Error('缺少标题')
  if (!text().includes('按工作区组织会话')) throw new Error('缺少副标题')
})
check('渲染出 4 个真实项目标题', () => {
  for (const item of workspaces) if (!text().includes(item.title)) throw new Error(`缺少项目：${item.title}`)
})
check('记忆条显示已按项目隔离 + 改回全局共享', () => {
  if (!text().includes('项目记忆已按工作区隔离')) throw new Error('缺少隔离状态')
  if (!text().includes('改回全局共享')) throw new Error('缺少回滚按钮')
})
check('项目描述与默认设置徽标来自 /state', () => {
  if (!text().includes('DSH 项目工作台插件')) throw new Error('缺少项目描述')
  if (!text().includes('deepseek-flash')) throw new Error('缺少模型徽标')
})
check('上报了 panel-view（客户端自检通道）', () => {
  const report = requests.find((item) => item.url.includes('/api/client-report') && item.body?.event === 'panel-view')
  if (!report) throw new Error('没有 panel-view 上报')
  if (report.body.data.workspaces !== 4) throw new Error(`workspaces = ${report.body.data.workspaces}`)
  if (typeof report.body.data.services?.sessions !== 'boolean') throw new Error('缺少 services 能力位')
})

/* ── 6b. 侧栏排列状态条：按项目分组 / 不干预 ─────────────── */
const findButton = (needle) => [...container.querySelectorAll('button')]
  .find((button) => (button.textContent ?? '').includes(needle))
check('面板显示「侧栏会话排列」并提供按项目分组 / 不干预', () => {
  if (!text().includes('侧栏会话排列')) throw new Error('缺少侧栏排列状态条')
  if (!findButton('按项目分组')) throw new Error('缺少「按项目分组」按钮')
  if (!findButton('不干预')) throw new Error('缺少「不干预」按钮')
})
const groupBefore = calls.groupBy.length
findButton('按项目分组').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await wait(60)
check('点「按项目分组」→ 重新把侧栏切到 workspace 分组', () => {
  if (calls.groupBy.length <= groupBefore) throw new Error(`setGroupBy 未再调用：${calls.groupBy.join(',')}`)
  if (calls.groupBy[calls.groupBy.length - 1] !== 'workspace') throw new Error(`最后一次 mode = ${calls.groupBy[calls.groupBy.length - 1]}`)
})
findButton('不干预').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await wait(60)
check('点「不干预」→ 持久化偏好 off 并显示不干预文案', () => {
  if (window.localStorage.getItem('dsh-project-hub.sidebar-grouping.v1') !== 'off') throw new Error('偏好未写入')
  if (!text().includes('已设为不干预')) throw new Error('缺少不干预文案')
})

/* ── 7. 展开会话 + 点击新建会话 ─────────────────────────── */
const buttons = [...container.querySelectorAll('button')]
const byText = (needle) => buttons.find((button) => (button.textContent ?? '').includes(needle))
check('每张卡片都有「新建会话」「会话 (N)」「设置」「项目规则」入口', () => {
  const count = (needle) => buttons.filter((button) => (button.textContent ?? '').includes(needle)).length
  if (count('新建会话') !== 4) throw new Error(`新建会话按钮 = ${count('新建会话')}`)
  if (count('项目规则') !== 4) throw new Error(`项目规则按钮 = ${count('项目规则')}`)
})
const createButton = buttons.filter((button) => (button.textContent ?? '').includes('新建会话'))[0]
createButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await wait(120)
check('新建会话 => create(workspaceId, agentPreset) → selectModel(provider/model/effort) → openSession', () => {
  if (calls.created.length !== 1) throw new Error(`create 调用 ${calls.created.length} 次`)
  // 首张卡片是最近活跃的 ws-hub（has preset/model 配置）
  if (calls.created[0].workspaceId !== 'ws-hub') throw new Error(`workspaceId = ${calls.created[0].workspaceId}`)
  if (calls.created[0].agentPreset !== 'standard') throw new Error(`agentPreset = ${calls.created[0].agentPreset}`)
  if (calls.selection?.provider !== 'deepseek-official' || calls.selection?.model !== 'deepseek-flash') throw new Error('selectModel 参数不对')
  if (calls.selection?.reasoningEffort !== 'high') throw new Error(`reasoningEffort = ${calls.selection?.reasoningEffort}`)
  if (calls.opened[0] !== 'session-new-1') throw new Error(`openSession = ${calls.opened[0]}`)
})

/* ── 7b. 项目规则：断言 query 未被丢弃（回归 apiUrl 丢 search 的 bug） ── */
const rulesButton = buttons.filter((button) => (button.textContent ?? '').includes('项目规则'))[0]
rulesButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await wait(150)
check('项目规则请求带 workspaceId 并渲染 AGENTS.md 预览', () => {
  const call = requests.find((item) => item.url.includes('/api/rules'))
  if (!call) throw new Error('没有请求 /api/rules')
  if (!call.url.includes('workspaceId=')) throw new Error(`query 丢失：${call.url}`)
  if (!text().includes('# 项目规则')) throw new Error('没有渲染规则片段')
})

/* ── 8. 汇总 ─────────────────────────────────────────────── */
root.unmount()
dom.window.close()
console.log(failures.length === 0 ? '\nDOM RENDER OK' : `\nDOM RENDER FAILED: ${failures.length} 项`)
process.exit(failures.length === 0 ? 0 : 1)
