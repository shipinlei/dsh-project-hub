#!/usr/bin/env node
/**
 * dsh-project-hub host 侧离线自测。
 *
 * 用假 ctx（inject / effect / get）驱动 apply，捕获 webServer 注册的 handler，
 * 再用最小假 req / res 跑通接口约定 1-4 与状态文件损坏恢复。
 *
 * 用法：node scripts/test-host.mjs
 * 全程只操作 os.tmpdir() 下的临时目录，结束时清理；不接触真实 profile。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { apply } from '../lib/index.js'
import { createStateStore, resolveProfileDir } from '../lib/state.js'

const API = '/dsh-project-hub/api'
const results = []
let failures = 0
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-project-hub-test-'))
const profileDir = path.join(root, 'profile')
const workspaceDir = path.join(root, 'workspace')
const dshHome = path.join(root, 'dsh-home')
const agentsHome = path.join(root, 'agents-home')

const savedEnv = {
  DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
  DSH_HOME: process.env.DSH_HOME,
  DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME,
  DSH_PROFILE: process.env.DSH_PROFILE,
}

/** 依次执行一个测试；失败不中断后续用例。 */
async function test(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`✓ ${name}`)
  } catch (error) {
    failures += 1
    results.push({ name, ok: false })
    console.error(`✗ ${name}`)
    console.error(`  ${String(error?.stack ?? error).split('\n').join('\n  ')}`)
  }
}

/** 假请求：把 body 在下一个宏任务分片发完（handler 先挂监听）。 */
function makeRequest(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  // /health 只接受回环地址，默认给本机来源。
  req.socket = { remoteAddress: '::ffff:127.0.0.1' }
  if (body === undefined) {
    setImmediate(() => req.emit('end'))
    return req
  }
  setImmediate(() => {
    req.emit('data', Buffer.from(body, 'utf8'))
    req.emit('end')
  })
  return req
}

/** 假响应：记录状态码、header 与 body，足够断言契约字段。 */
function makeResponse() {
  return {
    statusCode: 0,
    headersSent: false,
    finished: false,
    headers: {},
    body: '',
    setHeader(headerName, value) {
      this.headers[String(headerName).toLowerCase()] = value
    },
    writeHead(status, headers) {
      this.statusCode = status
      this.headersSent = true
      if (headers !== undefined) {
        for (const [key, value] of Object.entries(headers)) this.headers[key.toLowerCase()] = value
      }
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk
      this.finished = true
    },
    get json() {
      try {
        return JSON.parse(this.body)
      } catch {
        return undefined
      }
    },
  }
}

/** 构造假宿主：services 表 + 路由捕获，形状对齐 cordis 的 ctx 子集。 */
function createFakeHost(options = {}) {
  const profileName = options.profileName ?? 'desktop'
  const rejection = options.rejection
  const routes = new Map()
  const registered = []
  const disposers = []
  const services = new Map()

  const memorySettings = { storageScope: 'global', runtimeUserScope: 'storage' }
  let revision = 0
  const settings = {
    describe() {
      return [
        {
          ns: 'mnemon',
          revision,
          applies: 'live',
          value: { ...memorySettings },
          base: { ...memorySettings },
        },
      ]
    },
    async mutate(ns, ops, expectedRevision) {
      assert.equal(ns, 'mnemon')
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        throw Object.assign(new Error('stale revision'), { name: 'SettingsConflictError' })
      }
      for (const op of ops) {
        assert.equal(op.op, 'set')
        memorySettings[op.path[0]] = op.value
      }
      revision += 1
    },
  }
  const workspaces = [{ workspaceId: 'ws-1', id: 'ws-1', path: workspaceDir, title: '项目组开发插件' }]
  const workspaceRegistry = {
    get(id) {
      return workspaces.find((workspace) => workspace.id === id || workspace.workspaceId === id)
    },
    list() {
      return workspaces
    },
  }

  services.set('settings', settings)
  services.set('workspaceRegistry', workspaceRegistry)
  services.set('profileContext', { name: profileName, dir: profileDir })
  // 可选：模拟 connection.requestRejection 返回 401/403（宿主鉴权网关）。
  if (rejection !== undefined) services.set('connection', { requestRejection: () => rejection })

  const webServer = {
    register(route) {
      registered.push(route)
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
  services.set('webServer', webServer)

  function get(serviceName) {
    return services.get(serviceName)
  }
  function effect(fn) {
    const dispose = fn()
    disposers.push(dispose)
    return dispose
  }
  const hostCtx = { get, effect, webServer }
  const ctx = {
    get,
    effect,
    inject(names, callback) {
      for (const serviceName of names) assert.ok(services.has(serviceName), `缺少服务：${serviceName}`)
      return callback(hostCtx)
    },
  }

  return { ctx, routes, registered, disposers, settings, memorySettings }
}

/** 调用捕获到的路由 handler，返回 { status, headers, json, body }。 */
async function request(host, method, url, body) {
  const pathname = url.split('?')[0]
  const handler = host.routes.get(pathname)
  assert.equal(typeof handler, 'function', `路由未注册：${pathname}`)
  const req = makeRequest(method, url, body)
  const res = makeResponse()
  await handler(req, res)
  return { status: res.statusCode, headers: res.headers, body: res.body, json: res.json }
}

/** 设置环境变量；undefined 表示删除。 */
function putEnv(key, value) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

async function main() {
  // 临时目录布局：项目根含 .git，全局 / agents 规则文件各一份。
  fs.mkdirSync(profileDir, { recursive: true })
  fs.mkdirSync(path.join(workspaceDir, '.git'), { recursive: true })
  fs.mkdirSync(dshHome, { recursive: true })
  fs.mkdirSync(agentsHome, { recursive: true })
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# 项目规则\n\n始终写中文注释。\n')
  fs.writeFileSync(path.join(dshHome, 'AGENTS.md'), '# 全局规则\n')
  fs.writeFileSync(path.join(agentsHome, 'AGENTS.md'), '# 用户规则\n')

  putEnv('DSH_PROFILE_DIR', profileDir)
  putEnv('DSH_HOME', dshHome)
  putEnv('DSH_AGENTS_HOME', agentsHome)
  putEnv('DSH_PROFILE', 'desktop')

  const host = createFakeHost()
  apply(host.ctx)

  await test('apply 注册 7 条路由并写入 boot.json（含 profile 来源）', () => {
    assert.equal(host.registered.length, 7)
    assert.deepEqual(
      host.registered.map((route) => route.path).sort(),
      [`${API}/state`, `${API}/project`, `${API}/rules`, `${API}/memory-scope`, `${API}/client-report`, `${API}/beacon`, `${API}/health`].sort(),
    )
    const boot = JSON.parse(fs.readFileSync(path.join(profileDir, '.dsh-project-hub', 'boot.json'), 'utf8'))
    assert.equal(boot.profileDir, path.resolve(profileDir))
    assert.equal(boot.source, 'profileContext')
    assert.equal(typeof boot.pid, 'number')
  })

  await test('GET /health 回环可读、非回环 403、不含文件内容', async () => {
    const res = await request(host, 'GET', `${API}/health`)
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
    assert.equal(res.json.plugin, 'dsh-project-hub')
    assert.equal(res.json.profileDir, path.resolve(profileDir))
    assert.equal(res.json.profileSource, 'profileContext')
    assert.equal(res.json.statePath, path.join(profileDir, '.dsh-project-hub', 'state.json'))
    assert.equal(res.json.memory.storageScope, 'global')
    assert.equal(res.json.projectCount, 0)
    // 假宿主没有 clientModules 服务：登记信息应为未收录，而不是报错。
    assert.equal(res.json.client.registered, false)
    assert.equal(res.json.clientEvents.count, 0)

    const handler = host.routes.get(`${API}/health`)
    const remote = makeRequest('GET', `${API}/health`)
    remote.socket.remoteAddress = '10.0.0.7'
    const remoteRes = makeResponse()
    await handler(remote, remoteRes)
    assert.equal(remoteRes.statusCode, 403)
    assert.equal(remoteRes.json.ok, false)
  })

  await test('桌面宿主：网关 401 时放行并记录 auth-bypassed', async () => {
    const desktopHost = createFakeHost({ profileName: 'desktop', rejection: 401 })
    apply(desktopHost.ctx)
    const res = await request(desktopHost, 'GET', `${API}/state`)
    assert.equal(res.status, 200)
    const health = await request(desktopHost, 'GET', `${API}/health`)
    assert.equal(health.json.desktopHost, true)
    assert.equal(health.json.profileName, 'desktop')
    assert.equal(health.json.clientEvents.last.event, 'auth-bypassed')
    assert.equal(health.json.clientEvents.last.data.path, `${API}/state`)
  })

  await test('非桌面 profile：网关 401 时拒绝并记录 auth-rejected', async () => {
    const webHost = createFakeHost({ profileName: 'web', rejection: 401 })
    apply(webHost.ctx)
    const res = await request(webHost, 'GET', `${API}/state`)
    assert.equal(res.status, 401)
    const health = await request(webHost, 'GET', `${API}/health`)
    assert.equal(health.json.desktopHost, false)
    assert.equal(health.json.clientEvents.last.event, 'auth-rejected')
  })

  await test('POST /client-report 非桌面 + 非回环请求 403', async () => {
    const webHost = createFakeHost({ profileName: 'web' })
    apply(webHost.ctx)
    const remoteReq = makeRequest('POST', `${API}/client-report`, JSON.stringify({ event: 'mounted' }))
    remoteReq.socket.remoteAddress = '10.0.0.7'
    const remoteRes = makeResponse()
    await webHost.routes.get(`${API}/client-report`)(remoteReq, remoteRes)
    assert.equal(remoteRes.statusCode, 403)
  })

  await test('POST /client-report 桌面宿主放宽（无 socket 的内进程请求也可上报）', async () => {
    const desktopReq = makeRequest('POST', `${API}/client-report`, JSON.stringify({ event: 'mounted' }))
    delete desktopReq.socket
    const desktopRes = makeResponse()
    await host.routes.get(`${API}/client-report`)(desktopReq, desktopRes)
    assert.equal(desktopRes.statusCode, 200)
    assert.equal(desktopRes.json.event, 'mounted')
  })

  await test('GET /beacon 记录阶段事件（204 + clientEvents 可见）', async () => {
    const res = await request(host, 'GET', `${API}/beacon?stage=factory-start&href=dsh-app%3A%2F%2Fhost%2F`)
    assert.equal(res.status, 204)
    const health = await request(host, 'GET', `${API}/health`)
    const last = health.json.clientEvents.last
    assert.equal(last.event, 'mounted')
    assert.equal(last.data.via, 'beacon')
    assert.equal(last.data.stage, 'factory-start')
  })

  await test('POST /client-report 记录事件并在 /health 可见，非法 event 400', async () => {
    const posted = await request(host, 'POST', `${API}/client-report`, JSON.stringify({
      event: 'panel-view',
      data: { workspaces: 4, sessions: 12, memoryScoped: true },
    }))
    assert.equal(posted.status, 200)
    assert.equal(posted.json.ok, true)
    assert.equal(posted.json.event, 'panel-view')

    const health = await request(host, 'GET', `${API}/health`)
    assert.ok(health.json.clientEvents.count >= 1)
    assert.equal(health.json.clientEvents.last.event, 'panel-view')
    assert.equal(health.json.clientEvents.last.data.workspaces, 4)
    assert.equal(typeof health.json.clientEvents.last.at, 'string')

    const bad = await request(host, 'POST', `${API}/client-report`, JSON.stringify({ event: 'nope' }))
    assert.equal(bad.status, 400)
  })

  await test('GET /state 首次返回空项目与记忆状态', async () => {
    const res = await request(host, 'GET', `${API}/state`)
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
    assert.equal(res.json.ok, true)
    assert.equal(res.json.version, 1)
    assert.equal(res.json.profileDir, path.resolve(profileDir))
    assert.deepEqual(res.json.projects, {})
    assert.equal(res.json.memory.available, true)
    assert.equal(res.json.memory.namespace, 'mnemon')
    assert.equal(res.json.memory.storageScope, 'global')
    assert.equal(res.json.memory.runtimeUserScope, 'storage')
    assert.equal(res.json.memory.projectScoped, false)
    assert.equal(res.json.memory.error, null)
  })

  await test('POST /project 写入后 GET /state 能读到，且未知键被忽略', async () => {
    const posted = await request(
      host,
      'POST',
      `${API}/project`,
      JSON.stringify({
        workspaceId: 'ws-1',
        patch: {
          description: '订单对账系统',
          agentPreset: 'standard',
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          reasoningEffort: 'high',
          color: 'red',
        },
      }),
    )
    assert.equal(posted.status, 200)
    assert.equal(posted.json.ok, true)
    assert.equal(posted.json.workspaceId, 'ws-1')
    assert.equal(posted.json.project.description, '订单对账系统')
    assert.equal(posted.json.project.agentPreset, 'standard')
    assert.equal(posted.json.project.provider, 'deepseek-official')
    assert.equal(posted.json.project.model, 'deepseek-flash')
    assert.equal(posted.json.project.reasoningEffort, 'high')
    assert.equal(posted.json.project.color, undefined)
    assert.equal(typeof posted.json.project.updatedAt, 'string')

    const state = await request(host, 'GET', `${API}/state`)
    assert.equal(state.json.projects['ws-1'].model, 'deepseek-flash')
    assert.equal(state.json.projects['ws-1'].updatedAt, posted.json.project.updatedAt)

    // 空字符串清除字段 → null
    const cleared = await request(host, 'POST', `${API}/project`, JSON.stringify({ workspaceId: 'ws-1', patch: { model: '' } }))
    assert.equal(cleared.json.project.model, null)
    assert.equal(cleared.json.project.provider, 'deepseek-official')
  })

  await test('GET /rules 返回 AGENTS.md 候选链与项目根', async () => {
    const res = await request(host, 'GET', `${API}/rules?workspaceId=ws-1`)
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
    assert.equal(res.json.projectRoot, path.resolve(workspaceDir))

    const files = res.json.files
    assert.equal(files.length, 6)
    assert.deepEqual(
      files.map((file) => file.scope),
      ['global', 'agents', 'project', 'project', 'project-local', 'project-local'],
    )
    assert.equal(files[0].path, path.join(dshHome, 'AGENTS.md'))
    assert.equal(files[0].exists, true)
    assert.match(files[0].excerpt, /全局规则/)
    assert.equal(files[1].path, path.join(agentsHome, 'AGENTS.md'))
    assert.equal(files[1].exists, true)

    const projectAgents = files[2]
    assert.equal(projectAgents.path, path.join(workspaceDir, 'AGENTS.md'))
    assert.equal(projectAgents.exists, true)
    assert.ok(projectAgents.size > 0)
    assert.match(projectAgents.excerpt, /项目规则/)

    const missing = files[3]
    assert.equal(missing.path, path.join(workspaceDir, 'CLAUDE.md'))
    assert.equal(missing.exists, false)
    assert.equal(missing.size, 0)
    assert.equal(missing.excerpt, null)
  })

  await test('GET /rules 未知 workspaceId 返回 404', async () => {
    const res = await request(host, 'GET', `${API}/rules?workspaceId=missing-id`)
    assert.equal(res.status, 404)
    assert.equal(res.json.ok, false)
    assert.equal(typeof res.json.error, 'string')
  })

  await test('POST /memory-scope 切换 storageScope 并回包最新状态', async () => {
    const res = await request(
      host,
      'POST',
      `${API}/memory-scope`,
      JSON.stringify({ storageScope: 'workspaces', runtimeUserScope: 'global' }),
    )
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
    assert.equal(res.json.memory.available, true)
    assert.equal(res.json.memory.storageScope, 'workspaces')
    assert.equal(res.json.memory.projectScoped, true)
    assert.equal(res.json.memory.runtimeUserScope, 'global')
    assert.equal(host.memorySettings.storageScope, 'workspaces')
  })

  await test('POST /memory-scope 非法取值返回 400', async () => {
    const res = await request(host, 'POST', `${API}/memory-scope`, JSON.stringify({ storageScope: 'bogus' }))
    assert.equal(res.status, 400)
    assert.equal(res.json.ok, false)
  })

  await test('非法 JSON body 返回 400', async () => {
    const res = await request(host, 'POST', `${API}/project`, '{ this is not json')
    assert.equal(res.status, 400)
    assert.equal(res.json.ok, false)
    assert.equal(typeof res.json.error, 'string')
  })

  await test('请求体超过 64KB 返回 400', async () => {
    const big = JSON.stringify({ workspaceId: 'ws-1', patch: { description: 'x'.repeat(65 * 1024) } })
    const res = await request(host, 'POST', `${API}/project`, big)
    assert.equal(res.status, 400)
    assert.equal(res.json.ok, false)
    assert.match(res.json.error, /64KB/)
  })

  await test('POST /memory-scope 缺少 storageScope 返回 400', async () => {
    const res = await request(host, 'POST', `${API}/memory-scope`, JSON.stringify({ runtimeUserScope: 'global' }))
    assert.equal(res.status, 400)
    assert.equal(res.json.ok, false)
  })

  await test('POST /project 缺少 workspaceId 返回 400', async () => {
    const res = await request(host, 'POST', `${API}/project`, JSON.stringify({ patch: { model: 'x' } }))
    assert.equal(res.status, 400)
    assert.equal(res.json.ok, false)
  })

  await test('方法不允许返回 405 + Allow', async () => {
    const res = await request(host, 'POST', `${API}/state`, '{}')
    assert.equal(res.status, 405)
    assert.equal(res.headers.allow, 'GET')
    assert.equal(res.json.ok, false)
  })

  await test('createStateStore 遇到损坏 JSON 能备份并恢复空状态', () => {
    const dir = path.join(root, 'corrupt-store')
    fs.mkdirSync(dir, { recursive: true })
    const statePath = path.join(dir, 'state.json')
    fs.writeFileSync(statePath, '{ 这是坏掉的 JSON', 'utf8')

    const store = createStateStore(dir)
    assert.deepEqual(store.load(), { version: 1, projects: {} })
    assert.equal(fs.existsSync(statePath), false)

    const backups = fs.readdirSync(dir).filter((fileName) => fileName.startsWith('state.json.corrupt-'))
    assert.equal(backups.length, 1)

    // 恢复后能正常写回并再读。
    store.save({ version: 1, projects: { 'ws-1': { description: '恢复后写入' } } })
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).projects['ws-1'].description, '恢复后写入')
  })

  await test('resolveProfileDir 优先级：profileContext > DSH_PROFILE_DIR > DSH_HOME', () => {
    const fromContext = resolveProfileDir({}, profileDir)
    assert.deepEqual(fromContext, { dir: path.resolve(profileDir), source: 'profileContext' })

    const fromEnvDir = resolveProfileDir({ DSH_PROFILE_DIR: path.join(root, 'explicit'), DSH_HOME: path.join(root, 'home') })
    assert.equal(fromEnvDir.source, 'DSH_PROFILE_DIR')
    assert.equal(fromEnvDir.dir, path.resolve(path.join(root, 'explicit')))

    const fromHome = resolveProfileDir({ DSH_HOME: path.join(root, 'home'), DSH_PROFILE: 'mobile' })
    assert.equal(fromHome.source, 'DSH_HOME')
    assert.equal(fromHome.dir, path.join(path.resolve(root, 'home'), 'profiles', 'mobile'))
  })
}

main()
  .then(() => {
    const passed = results.filter((entry) => entry.ok).length
    console.log('')
    console.log(`共 ${results.length} 项，通过 ${passed} 项，失败 ${failures} 项`)
    if (failures > 0) process.exitCode = 1
  })
  .catch((error) => {
    console.error('测试驱动异常：', error)
    process.exitCode = 1
  })
  .finally(() => {
    putEnv('DSH_PROFILE_DIR', savedEnv.DSH_PROFILE_DIR)
    putEnv('DSH_HOME', savedEnv.DSH_HOME)
    putEnv('DSH_AGENTS_HOME', savedEnv.DSH_AGENTS_HOME)
    putEnv('DSH_PROFILE', savedEnv.DSH_PROFILE)
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch (error) {
      console.warn(`清理临时目录失败：${error?.message ?? error}`)
    }
  })
