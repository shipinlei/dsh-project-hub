/**
 * dsh-project-hub — host 侧 cordis 插件。
 *
 * 职责：
 *  1. 项目元数据存储：<profile>/.dsh-project-hub/state.json，键 = workspaceId
 *     字段：description / agentPreset / provider / model / reasoningEffort
 *  2. HTTP 路由（/dsh-project-hub/api/*，契约见 docs/接口约定.md）：
 *       GET  /state         读项目元数据 + 记忆作用域状态
 *       POST /project       写单个项目元数据（白名单浅合并）
 *       GET  /rules         预览 AGENTS.md 候选链
 *       POST /memory-scope  切换 Mnemon 记忆作用域
 *  3. boot 记录：<profileDir>/.dsh-project-hub/boot.json（写入时间、pid、profile 来源）
 *
 * 设计原则：不改核心、不劫持数据。所有平台能力通过 ctx 服务与公开配置调用。
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolveProfileDir, createStateStore, mergeProject, readRules, STATE_VERSION } from './state.js'

export const name = 'dsh-project-hub'

/** 插件命名空间（也用作 profile 侧状态目录名）。 */
const NS = 'dsh-project-hub'
/** HTTP 路由前缀（契约固定）。 */
const API_PREFIX = '/dsh-project-hub/api'
/** POST 请求体上限：64KB。 */
const MAX_BODY_BYTES = 64 * 1024
/** Mnemon 设置命名空间（settings 服务里的 profile entry id）。 */
const MEMORY_NAMESPACE = 'mnemon'
/** memory-scope 允许的 storageScope 取值（契约第 4 节）。 */
const STORAGE_SCOPES = new Set(['global', 'workspaces', 'workspace'])
/** memory-scope 允许的 runtimeUserScope 取值（契约第 4 节）。 */
const RUNTIME_USER_SCOPES = new Set(['storage', 'global'])

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

/** 构造带 HTTP 状态码的错误，供路由包装器统一回包。 */
function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

/** 是否为普通对象（排除数组 / null）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 非空白字符串（去首尾空白）；否则 undefined。 */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 错误信息文本化，避免把异常对象直接拼进日志。 */
function errorText(error) {
  return error?.message ?? String(error)
}

/** 响应统一 utf8 JSON。 */
function sendJson(res, status, payload) {
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.writeHead(status)
  res.end(JSON.stringify(payload))
}

/** 失败响应：{ ok:false, error }。extraHeaders 用于 405 的 Allow。 */
function sendError(res, status, message, extraHeaders = {}) {
  for (const [header, value] of Object.entries(extraHeaders)) res.setHeader(header, value)
  sendJson(res, status, { ok: false, error: message })
}

/* ------------------------------------------------------------------ */
/* profile 与 boot 记录                                                */
/* ------------------------------------------------------------------ */

/**
 * 解析 profile 目录：profileContext 优先，其次环境变量链。
 * profileContext 是 Desktop 在 apply 前 provide 的服务，供验收时确认来源。
 */
function resolveProfile(ctx) {
  let contextDir
  try {
    contextDir = ctx?.get?.('profileContext')?.dir
  } catch (error) {
    console.warn(`[${NS}] 读取 profileContext 失败：${errorText(error)}`)
    contextDir = undefined
  }
  return resolveProfileDir(process.env, contextDir)
}

/** 写入 boot.json（记录来源，便于验收）。失败只 warn，不阻断宿主。 */
function writeBootRecord(profile, stateDir) {
  const loadedAt = new Date().toISOString()
  try {
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(
      path.join(stateDir, 'boot.json'),
      `${JSON.stringify(
        {
          loadedAt,
          pid: process.pid,
          profileDir: profile.dir,
          source: profile.source,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
  } catch (error) {
    console.warn(`[${NS}] 写入 boot.json 失败：${errorText(error)}`)
  }
  return loadedAt
}

/* ------------------------------------------------------------------ */
/* 鉴权 / 请求体                                                        */
/* ------------------------------------------------------------------ */

/**
 * 宿主鉴权：connection.requestRejection(req) 返回数字状态码即拒绝。
 * Desktop 可能不提供该服务，全部空安全处理。
 */
function rejectionStatus(ctx, req) {
  try {
    const rejection = ctx?.get?.('connection')?.requestRejection?.(req)
    return typeof rejection === 'number' ? rejection : undefined
  } catch (error) {
    console.warn(`[${NS}] 鉴权检查异常，按拒绝处理：${errorText(error)}`)
    return 500
  }
}

/** 读取并解析 JSON 请求体（上限 64KB）；超限 / 非法 JSON / 读取失败均映射 400。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let settled = false

    const cleanup = () => {
      req.removeListener?.('data', onData)
      req.removeListener?.('end', onEnd)
      req.removeListener?.('error', onError)
      // 提前回包（超限/非法 JSON）时把剩余请求体放掉，避免 keep-alive 连接挂住。
      try {
        req.resume?.()
      } catch {
        /* 假 req 或已结束的流无 resume，忽略 */
      }
    }
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      cleanup()
      callback(value)
    }
    const fail = (message) => settle(reject, httpError(400, message))

    function onData(chunk) {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.length
      if (total > MAX_BODY_BYTES) {
        fail(`请求体超过 ${Math.round(MAX_BODY_BYTES / 1024)}KB 上限`)
        return
      }
      chunks.push(buffer)
    }
    function onEnd() {
      if (settled) return
      let parsed
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        fail('请求体不是合法 JSON')
        return
      }
      settle(resolve, parsed)
    }
    function onError(error) {
      settle(reject, httpError(400, `读取请求体失败：${errorText(error)}`))
    }

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

/** 解析 req.url（只取 pathname + query）。 */
function requestUrl(req) {
  try {
    return new URL(String(req?.url ?? '/'), 'http://localhost')
  } catch {
    return new URL('/', 'http://localhost')
  }
}

/* ------------------------------------------------------------------ */
/* 记忆作用域（settings / mnemon）                                      */
/* ------------------------------------------------------------------ */

/** 调 settings.describe({redactSecrets:true}) 并兼容数组 / {views} 两种返回。 */
function describeSettings(service) {
  const result = service.describe({ redactSecrets: true })
  if (Array.isArray(result)) return result
  if (result && Array.isArray(result.views)) return result.views
  return []
}

/** 在 describe 结果里取 mnemon 视图；读失败返回 undefined。 */
function findMnemonView(service) {
  try {
    return describeSettings(service).find((view) => view && view.ns === MEMORY_NAMESPACE)
  } catch (error) {
    console.warn(`[${NS}] 读取 mnemon 设置失败：${errorText(error)}`)
    return undefined
  }
}

/** 读取当前记忆作用域快照（契约第 1 节 memory 字段），任何异常都降级为 available:false。 */
function readMemoryState(ctx) {
  const unavailable = (error) => ({
    available: false,
    namespace: MEMORY_NAMESPACE,
    storageScope: 'global',
    runtimeUserScope: 'storage',
    projectScoped: false,
    error,
  })

  let service
  try {
    service = ctx?.get?.('settings')
  } catch (error) {
    return unavailable(`读取设置服务失败：${errorText(error)}`)
  }
  if (!service || typeof service.describe !== 'function') {
    return unavailable('当前 profile 未提供设置服务')
  }

  let view
  try {
    view = describeSettings(service).find((row) => row && row.ns === MEMORY_NAMESPACE)
  } catch (error) {
    return unavailable(`读取 mnemon 设置失败：${errorText(error)}`)
  }
  if (view === undefined) {
    return unavailable('未找到 mnemon 设置项（请确认已安装并启用 Mnemon）')
  }

  const value = isPlainObject(view.value) ? view.value : {}
  const base = isPlainObject(view.base) ? view.base : {}
  // 契约要求兼容 value 缺失时回落 base。
  const rawStorageScope = value.storageScope ?? base.storageScope
  const rawRuntimeUserScope = value.runtimeUserScope ?? base.runtimeUserScope
  const storageScope =
    typeof rawStorageScope === 'string' && rawStorageScope !== '' ? rawStorageScope : 'global'
  const runtimeUserScope =
    typeof rawRuntimeUserScope === 'string' && rawRuntimeUserScope !== '' ? rawRuntimeUserScope : 'storage'

  return {
    available: true,
    namespace: MEMORY_NAMESPACE,
    storageScope,
    runtimeUserScope,
    projectScoped: storageScope === 'workspaces' || storageScope === 'workspace',
    error: null,
  }
}

/* ------------------------------------------------------------------ */
/* 客户端事件记录（用于安装/验收期确认渲染器确实加载并渲染了面板）        */
/* ------------------------------------------------------------------ */

/** 客户端上报日志文件名（与 state.json 同目录）。 */
const CLIENT_EVENT_FILE = 'client-events.ndjson'
/** 允许的事件名；其它一律 400。 */
const CLIENT_EVENTS = new Set(['mounted', 'panel-view'])
/** 诊断事件（宿主侧写、不经客户端上报）：鉴权被拒 / 桌面宿主放行。 */
const DIAGNOSTIC_EVENTS = new Set(['auth-rejected', 'auth-bypassed'])
/** 最多保留的行数，超出时只留最近一半。 */
const CLIENT_EVENTS_MAX = 200
/** 单条 data 序列化后的字符上限。 */
const CLIENT_EVENT_DATA_LIMIT = 2000

/** 读取最近一条客户端事件与总条数；文件缺失/损坏时返回空结果。 */
function readClientEvents(store) {
  const file = path.join(path.dirname(store.path), CLIENT_EVENT_FILE)
  try {
    const text = fs.readFileSync(file, 'utf8').trim()
    if (text === '') return { count: 0, last: null }
    const lines = text.split('\n')
    let last = null
    try {
      last = JSON.parse(lines[lines.length - 1])
    } catch {
      last = null
    }
    return { count: lines.length, last }
  } catch {
    return { count: 0, last: null }
  }
}

/** 追加一条客户端事件；超限时截断为最近一半。 */
function appendClientEvent(store, event, data) {
  const dir = path.dirname(store.path)
  const file = path.join(dir, CLIENT_EVENT_FILE)
  let payload
  try {
    payload = JSON.stringify(data === undefined ? null : data)
  } catch {
    payload = 'null'
  }
  if (typeof payload !== 'string' || payload.length > CLIENT_EVENT_DATA_LIMIT) payload = '"data-too-large"'
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event, data: payload === 'null' ? null : JSON.parse(payload) })}\n`, 'utf8')
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')
    if (lines.length > CLIENT_EVENTS_MAX) {
      fs.writeFileSync(file, `${lines.slice(-Math.floor(CLIENT_EVENTS_MAX / 2)).join('\n')}\n`, 'utf8')
    }
  } catch (error) {
    console.warn(`[${NS}] 截断客户端事件日志失败：${errorText(error)}`)
  }
}

/* ------------------------------------------------------------------ */
/* 路由 handler                                                         */
/* ------------------------------------------------------------------ */

/** GET /state：项目元数据 + 记忆状态。 */
function handleState(ctx, store, profile) {
  return (req, res) => {
    const state = store.load()
    sendJson(res, 200, {
      ok: true,
      version: typeof state.version === 'number' ? state.version : STATE_VERSION,
      profileDir: profile.dir,
      projects: state.projects,
      memory: readMemoryState(ctx),
    })
  }
}

/** 回环地址判断：诊断路由只接受本机请求。 */
function isLoopbackRequest(req) {
  const raw = req?.socket?.remoteAddress ?? req?.connection?.remoteAddress
  if (typeof raw !== 'string') return false
  const address = raw.startsWith('::ffff:') ? raw.slice(7) : raw
  return address === '127.0.0.1' || address === '::1'
}

/**
 * 是否运行在官方桌面宿主（Electron）里。
 *
 * 桌面页面经 `dsh-app://` 协议转发请求，未必携带 `connection` 网关要求的
 * 浏览器会话凭证；官方 dshmarket 在桌面宿主上同样整段跳过 host gate
 * （`enforceHostGate = config.desktopHost !== true`）。这里复用 profileContext
 * 的 profile 名做等价判断，且桌面宿主只监听回环地址，安全边界不变。
 */
function isDesktopHost(ctx) {
  try {
    const context = ctx?.get?.('profileContext')
    return context !== null && typeof context === 'object' && typeof context.name === 'string'
      ? context.name.toLowerCase() === 'desktop'
      : false
  } catch {
    return false
  }
}

/**
 * GET /health：只读诊断（免宿主鉴权，仅回环地址），不返回任何文件内容。
 *
 * 用途：安装/排障时在不带浏览器会话凭证的环境（例如 shell 里 curl）确认
 * 插件已加载、状态文件位置与记忆作用域；敏感信息一律不出现在响应里。
 */
function handleHealth(ctx, store, profile, boot) {
  return (req, res) => {
    if (!isLoopbackRequest(req)) {
      sendError(res, 403, '诊断接口只接受本机回环请求')
      return
    }
    let projectCount = 0
    try {
      projectCount = Object.keys(store.load().projects ?? {}).length
    } catch {
      /* 状态读取异常不影响健康检查 */
    }
    // 客户端 bundle 是否被 client-modules 收录（决定侧栏入口会不会出现）。
    const client = { registered: false, file: null, rev: null }
    try {
      const modules = ctx?.get?.('clientModules')
      const clientFile = modules?.clientPath?.(NS)
      if (typeof clientFile === 'string') {
        client.registered = true
        client.file = clientFile
        const graph = typeof modules.graph === 'function' ? modules.graph() : undefined
        const entry = Array.isArray(graph?.entries) ? graph.entries.find((item) => item?.id === NS) : undefined
        if (entry) {
          if (typeof entry.rev === 'string') client.rev = entry.rev
          client.entry = {
            id: entry.id,
            url: entry.url ?? null,
            immediately: entry.immediately === true,
            inject: Array.isArray(entry.inject) ? entry.inject.slice(0, 12) : [],
          }
        }
      }
    } catch (error) {
      console.warn(`[${NS}] 读取 clientModules 状态失败：${errorText(error)}`)
    }
    sendJson(res, 200, {
      ok: true,
      plugin: NS,
      profileDir: profile.dir,
      profileSource: profile.source,
      profileName: (() => {
        try {
          return ctx?.get?.('profileContext')?.name ?? null
        } catch {
          return null
        }
      })(),
      desktopHost: isDesktopHost(ctx),
      loadedAt: boot.loadedAt,
      statePath: store.path,
      projectCount,
      client,
      clientEvents: readClientEvents(store),
      memory: readMemoryState(ctx),
    })
  }
}

/** POST /project：白名单浅合并写单个项目。 */
function handleProject(store) {
  return async (req, res) => {
    const body = await readJsonBody(req)
    if (!isPlainObject(body)) throw httpError(400, '请求体必须是 JSON 对象')

    const workspaceId = nonEmptyString(body.workspaceId)
    if (workspaceId === undefined) throw httpError(400, '缺少合法的 workspaceId（非空字符串）')

    const patch = body.patch === undefined ? {} : body.patch
    if (!isPlainObject(patch)) throw httpError(400, 'patch 必须是 JSON 对象')

    const merged = mergeProject(store.load(), workspaceId, patch)
    store.save(merged.state)
    sendJson(res, 200, { ok: true, workspaceId, project: merged.project })
  }
}

/**
 * 查工作区：优先 workspaceRegistry.get(id)，失败/缺失时退化。
 * @returns {{ registryAvailable: boolean, workspace: object|undefined }}
 */
function lookupWorkspace(ctx, workspaceId) {
  let registry
  try {
    registry = ctx?.get?.('workspaceRegistry')
  } catch (error) {
    console.warn(`[${NS}] 读取工作区服务失败：${errorText(error)}`)
    registry = undefined
  }
  if (registry === undefined || registry === null) {
    return { registryAvailable: false, workspace: undefined }
  }

  if (typeof registry.get === 'function') {
    try {
      const workspace = registry.get(workspaceId)
      if (workspace !== undefined && workspace !== null) {
        return { registryAvailable: true, workspace }
      }
    } catch (error) {
      // get() 可能要求 branded id；此时退回 list() 扫描，不让预览 500。
      console.warn(`[${NS}] workspaceRegistry.get 失败，改用 list 扫描：${errorText(error)}`)
    }
  }

  try {
    const items = typeof registry.list === 'function' ? registry.list() : []
    const match = (Array.isArray(items) ? items : []).find(
      (item) => item && (item.id === workspaceId || item.workspaceId === workspaceId),
    )
    return { registryAvailable: true, workspace: match }
  } catch (error) {
    console.warn(`[${NS}] 枚举工作区失败：${errorText(error)}`)
    return { registryAvailable: true, workspace: undefined }
  }
}

/** 读取规则候选链并回包（dshHome / agentsHome 取请求时的进程环境）。 */
function respondRules(res, workspacePath) {
  const result = readRules({
    workspacePath,
    dshHome: process.env.DSH_HOME,
    agentsHome: process.env.DSH_AGENTS_HOME,
  })
  sendJson(res, 200, { ok: true, projectRoot: result.projectRoot, files: result.files })
}

/** GET /rules?workspaceId=：AGENTS.md 候选链预览。 */
function handleRules(ctx) {
  return (req, res) => {
    const url = requestUrl(req)
    const workspaceId = nonEmptyString(url.searchParams.get('workspaceId'))
    if (workspaceId === undefined) throw httpError(400, '缺少合法的 workspaceId（非空字符串）')

    const { registryAvailable, workspace } = lookupWorkspace(ctx, workspaceId)
    if (registryAvailable) {
      if (workspace === undefined || workspace === null) {
        throw httpError(404, `未找到工作区：${workspaceId}`)
      }
      const workspacePath = nonEmptyString(workspace.path)
      if (workspacePath === undefined) throw httpError(404, `工作区 ${workspaceId} 没有可用的目录路径`)
      respondRules(res, workspacePath)
      return
    }

    // 工作区服务缺失：退化为显式 path 参数（契约约定）。
    const fallbackPath = nonEmptyString(url.searchParams.get('path'))
    if (fallbackPath === undefined) {
      throw httpError(404, `未找到工作区：${workspaceId}（且未提供 path 参数）`)
    }
    respondRules(res, fallbackPath)
  }
}

/** POST /memory-scope：切换 Mnemon 的 storageScope / runtimeUserScope。 */
function handleMemoryScope(ctx) {
  return async (req, res) => {
    const body = await readJsonBody(req)
    if (!isPlainObject(body)) throw httpError(400, '请求体必须是 JSON 对象')

    const ops = []
    // 契约中 storageScope 为必填（runtimeUserScope 才可省略）。
    if (body.storageScope === undefined) {
      throw httpError(400, '缺少 storageScope（"global" | "workspaces" | "workspace"）')
    }
    if (!STORAGE_SCOPES.has(body.storageScope)) {
      throw httpError(400, 'storageScope 只能是 "global" | "workspaces" | "workspace"')
    }
    ops.push({ op: 'set', path: ['storageScope'], value: body.storageScope })
    if (body.runtimeUserScope !== undefined) {
      if (!RUNTIME_USER_SCOPES.has(body.runtimeUserScope)) {
        throw httpError(400, 'runtimeUserScope 只能是 "storage" | "global"')
      }
      ops.push({ op: 'set', path: ['runtimeUserScope'], value: body.runtimeUserScope })
    }

    let service
    try {
      service = ctx?.get?.('settings')
    } catch (error) {
      console.warn(`[${NS}] 读取设置服务失败：${errorText(error)}`)
      service = undefined
    }
    if (!service || typeof service.describe !== 'function' || typeof service.mutate !== 'function') {
      throw httpError(501, '当前 profile 未提供设置服务，无法切换记忆作用域')
    }

    const view = findMnemonView(service)
    if (view === undefined) {
      throw httpError(501, '当前 profile 未找到 mnemon 设置项，无法切换记忆作用域')
    }

    try {
      // 与 mnemon 自身迁移 legacy 字段使用同一套 volatile mutate 调用：原地生效，无需重启。
      await service.mutate(MEMORY_NAMESPACE, ops, view.revision)
    } catch (error) {
      console.warn(`[${NS}] 切换记忆作用域失败：${errorText(error)}`)
      const message =
        error?.name === 'SettingsConflictError'
          ? '设置已被其他操作修改，请刷新后重试'
          : `切换记忆作用域失败：${errorText(error)}`
      throw httpError(500, message)
    }

    // 成功后重新 describe 一次，回包真实生效值。
    sendJson(res, 200, { ok: true, memory: readMemoryState(ctx) })
  }
}

/**
 * GET /beacon?stage=...：图片式自检信标（`new Image().src`），
 * 用于在 fetch/POST 可能受阻的环境里确认客户端代码是否执行到某一步。
 */
function handleBeacon(ctx, store) {
  return (req, res) => {
    if (!isLoopbackRequest(req) && !isDesktopHost(ctx)) {
      res.writeHead(403)
      res.end()
      return
    }
    const url = requestUrl(req)
    const stage = nonEmptyString(url.searchParams.get('stage')) ?? 'unknown'
    appendClientEvent(store, 'mounted', { stage, via: 'beacon', href: nonEmptyString(url.searchParams.get('href')) ?? null })
    res.writeHead(204)
    res.end()
  }
}

/** POST /client-report：记录渲染器侧事件（安装/验收诊断用，写入同目录 ndjson）。 */
function handleClientReport(ctx, store) {
  return async (req, res) => {
    // 诊断通道：本机回环请求直接接受；桌面宿主经 dsh-app:// 转发的内进程请求可能没有 socket，
    // 因此在桌面宿主上放宽到「宿主自身转发的请求」（桌面宿主只监听回环地址）。
    if (!isLoopbackRequest(req) && !isDesktopHost(ctx)) {
      sendError(res, 403, '诊断接口只接受本机回环请求')
      return
    }
    const body = await readJsonBody(req)
    if (!isPlainObject(body)) throw httpError(400, '请求体必须是 JSON 对象')
    const event = nonEmptyString(body.event)
    if (event === undefined || !CLIENT_EVENTS.has(event)) {
      throw httpError(400, 'event 只能是 "mounted" 或 "panel-view"')
    }
    appendClientEvent(store, event, body.data)
    sendJson(res, 200, { ok: true, event })
  }
}

/** 诊断事件落盘（写 client-events.ndjson，便于安装/排障时回溯）。 */
function recordDiagnostic(store, event, data) {
  if (store === undefined || store === null) return
  if (!DIAGNOSTIC_EVENTS.has(event)) return
  try {
    appendClientEvent(store, event, data)
  } catch (error) {
    console.warn(`[${NS}] 写入诊断事件失败：${errorText(error)}`)
  }
}

/* ------------------------------------------------------------------ */
/* 路由包装与注册                                                       */
/* ------------------------------------------------------------------ */

/**
 * 统一包装：鉴权 → 方法白名单（405 + Allow）→ handler，捕获所有异常。
 * handler 抛出的 error.status 决定状态码（400/404/501），其余按 500。
 */
function wrapRoute(ctx, methods, handler, options = {}) {
  return async (req, res) => {
    try {
      // 诊断路由（/health、/client-report）显式免鉴权；其余路由先过宿主鉴权网关。
      // 桌面宿主（Electron）整段跳过：dsh-app:// 转发的请求未必带浏览器会话凭证。
      if (options.auth !== false) {
        const rejection = rejectionStatus(ctx, req)
        if (rejection !== undefined) {
          if (!isDesktopHost(ctx)) {
            recordDiagnostic(options.store, 'auth-rejected', {
              path: requestUrl(req).pathname,
              status: rejection,
            })
            res.writeHead(rejection)
            res.end()
            return
          }
          recordDiagnostic(options.store, 'auth-bypassed', {
            path: requestUrl(req).pathname,
            status: rejection,
          })
        }
      }

      const method = String(req?.method ?? 'GET').toUpperCase()
      if (!methods.includes(method)) {
        sendError(res, 405, `方法不允许：${method}`, { allow: methods.join(', ') })
        return
      }

      await handler(req, res)
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500
      console.warn(`[${NS}] ${requestUrl(req).pathname} 处理失败（${status}）：${errorText(error)}`)
      if (!res.headersSent) {
        sendError(res, status, error?.message ?? '内部错误')
        return
      }
      try {
        res.end()
      } catch {
        /* 响应已不可写，忽略 */
      }
    }
  }
}

/**
 * 向 webServer 注册 5 条路由（4 条契约业务路由 + 1 条回环诊断）。
 * disposers 由调用方持有：中途注册失败时也能回滚已注册的路由。
 */
function registerRoutes(service, ctx, store, profile, boot, disposers) {
  const route = (suffix, methods, handler, options = {}) => {
    const disposer = service.register({
      kind: 'exact',
      path: `${API_PREFIX}${suffix}`,
      handler: wrapRoute(ctx, methods, handler, { store, ...options }),
    })
    disposers.push(disposer)
    return disposer
  }

  route('/state', ['GET'], handleState(ctx, store, profile))
  route('/project', ['POST'], handleProject(store))
  route('/rules', ['GET'], handleRules(ctx))
  route('/memory-scope', ['POST'], handleMemoryScope(ctx))
  route('/client-report', ['POST'], handleClientReport(ctx, store), { auth: false })
  route('/beacon', ['GET'], handleBeacon(ctx, store), { auth: false })
  route('/health', ['GET'], handleHealth(ctx, store, profile, boot), { auth: false })
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                             */
/* ------------------------------------------------------------------ */

export function apply(ctx) {
  const profile = resolveProfile(ctx)
  const stateDir = path.join(profile.dir, `.${NS}`)
  const loadedAt = writeBootRecord(profile, stateDir)
  const boot = { loadedAt }
  const store = createStateStore(stateDir)
  console.warn(`[${NS}] host loaded; profile=${profile.dir}; source=${profile.source}; boot=${loadedAt}`)

  if (typeof ctx?.inject !== 'function') {
    console.warn(`[${NS}] 当前 ctx 不支持 inject，无法注册 HTTP 路由`)
    return
  }

  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => {
      const service = hostCtx.webServer ?? hostCtx.get?.('webServer')
      if (!service || typeof service.register !== 'function') {
        console.warn(`[${NS}] webServer 不可用，跳过路由注册`)
        return () => {}
      }

      const disposers = []
      try {
        registerRoutes(service, ctx, store, profile, boot, disposers)
      } catch (error) {
        console.warn(`[${NS}] 注册 HTTP 路由失败：${errorText(error)}`)
        for (const dispose of disposers) {
          try {
            if (typeof dispose === 'function') dispose()
          } catch {
            /* 清理失败忽略 */
          }
        }
        return () => {}
      }

      return () => {
        for (const dispose of disposers) {
          try {
            if (typeof dispose === 'function') dispose()
          } catch (error) {
            console.warn(`[${NS}] 移除路由失败：${errorText(error)}`)
          }
        }
      }
    }, `${NS}: routes`)
  })
}

export { resolveProfileDir }
