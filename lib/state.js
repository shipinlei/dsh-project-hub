/**
 * dsh-project-hub — 状态与规则读取层（无 ctx 依赖，纯函数，可直接单测）。
 *
 * 提供：
 *  - resolveProfileDir：profile 根目录探测（profileContext > DSH_PROFILE_DIR > DSH_HOME > ~/.dsh）
 *  - createStateStore：<profile>/.dsh-project-hub/state.json 的读/原子写/损坏恢复
 *  - mergeProject：项目白名单字段浅合并（不可变）
 *  - readRules：AGENTS.md 候选链探测与片段读取
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 状态文件名（相对状态目录）。 */
export const STATE_FILE = 'state.json'
/** 状态文件当前版本。 */
export const STATE_VERSION = 1
/** 项目元数据白名单字段（顺序即响应中的字段顺序）。 */
export const PROJECT_FIELDS = ['description', 'agentPreset', 'provider', 'model', 'reasoningEffort']
/** 规则文件片段字符上限。 */
export const RULES_EXCERPT_LIMIT = 4000

/** UTF-8 最坏情况 4 字节/字符；多读一些再按字符截断。 */
const RULES_MAX_READ_BYTES = RULES_EXCERPT_LIMIT * 4

/** 判断是否为普通对象（排除数组 / null）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 非空白字符串，返回去首尾空白的值；否则 undefined。 */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * 探测 profile 根目录。
 *
 * 优先级（2026-11-10 与 Lead 核实）：
 *  1. 调用方传入的 profileContext.dir（Desktop 在 apply 时已 provide）
 *  2. process.env.DSH_PROFILE_DIR
 *  3. $DSH_HOME/profiles/$DSH_PROFILE（默认 desktop）
 *  4. ~/.dsh/profiles/$DSH_PROFILE（默认 desktop）
 *
 * @param {Record<string, string|undefined>} [env] 环境变量来源，便于测试注入。
 * @param {string} [profileContextDir] ctx.get('profileContext')?.dir 的值。
 * @returns {{ dir: string, source: 'profileContext'|'DSH_PROFILE_DIR'|'DSH_HOME'|'home' }}
 */
export function resolveProfileDir(env = process.env, profileContextDir) {
  const fromContext = nonEmptyString(profileContextDir)
  if (fromContext !== undefined) return { dir: path.resolve(fromContext), source: 'profileContext' }

  const explicit = nonEmptyString(env?.DSH_PROFILE_DIR)
  if (explicit !== undefined) return { dir: path.resolve(explicit), source: 'DSH_PROFILE_DIR' }

  const profileName = nonEmptyString(env?.DSH_PROFILE) ?? 'desktop'
  const dshHome = nonEmptyString(env?.DSH_HOME)
  const home = dshHome ?? path.join(os.homedir(), '.dsh')
  return {
    dir: path.resolve(path.join(home, 'profiles', profileName)),
    source: dshHome === undefined ? 'home' : 'DSH_HOME',
  }
}

/** 空状态。 */
function emptyState() {
  return { version: STATE_VERSION, projects: {} }
}

/** 规整单个项目对象：只保留白名单字段与 updatedAt，非法类型回落默认值。 */
function normalizeProject(value) {
  const source = isPlainObject(value) ? value : {}
  const stringOrNull = (raw) => (typeof raw === 'string' ? raw : null)
  return {
    description: source.description === null ? null : stringOrNull(source.description) ?? '',
    agentPreset: stringOrNull(source.agentPreset),
    provider: stringOrNull(source.provider),
    model: stringOrNull(source.model),
    reasoningEffort: stringOrNull(source.reasoningEffort),
    updatedAt: stringOrNull(source.updatedAt),
  }
}

/** 规整整份状态：版本号回退、项目表只保留字符串键。 */
function normalizeState(value) {
  const source = isPlainObject(value) ? value : {}
  const projects = {}
  if (isPlainObject(source.projects)) {
    for (const [id, project] of Object.entries(source.projects)) {
      if (nonEmptyString(id) === undefined) continue
      projects[id] = normalizeProject(project)
    }
  }
  return {
    version: typeof source.version === 'number' ? source.version : STATE_VERSION,
    projects,
  }
}

/**
 * 创建状态仓库。
 *
 * load()：读 state.json；缺失 → 空状态；JSON 损坏 → 原名备份为
 *   state.json.corrupt-<ISO 时间戳>（Windows 文件名不允许 ':'，故把 : 和 . 换成 '-'）
 *   并 warn，返回空状态。
 * save(state)：先写 state.json.tmp 再 renameSync，实现原子替换；目录不存在时递归创建。
 *
 * @param {string} dir 状态目录（<profile>/.dsh-project-hub）。
 * @returns {{ load: () => { version: number, projects: Record<string, object> }, save: (state: object) => void, path: string }}
 */
export function createStateStore(dir) {
  const baseDir = nonEmptyString(dir)
  if (baseDir === undefined) throw new TypeError('createStateStore(dir)：dir 必须是非空字符串')
  const statePath = path.join(baseDir, STATE_FILE)

  /** 把损坏文件改名留档（不删除用户数据）。 */
  function archiveCorrupt() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = `${statePath}.corrupt-${stamp}`
    try {
      fs.renameSync(statePath, target)
      console.warn(`[dsh-project-hub] state.json 解析失败，已备份为 ${target}`)
    } catch (error) {
      console.warn(`[dsh-project-hub] state.json 解析失败且备份失败：${error?.message ?? error}`)
    }
  }

  function load() {
    let raw
    try {
      raw = fs.readFileSync(statePath, 'utf8')
    } catch (error) {
      // 首次运行（ENOENT）属正常情况；其他读取错误也回退空状态，不阻断宿主。
      if (error?.code !== 'ENOENT') {
        console.warn(`[dsh-project-hub] 读取状态文件失败（按空状态处理）：${error?.message ?? error}`)
      }
      return emptyState()
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      archiveCorrupt()
      return emptyState()
    }
    if (!isPlainObject(parsed)) {
      // 合法 JSON 但不是对象（数组/字符串/null）同样视为损坏。
      archiveCorrupt()
      return emptyState()
    }
    return normalizeState(parsed)
  }

  function save(state) {
    if (!isPlainObject(state)) throw new TypeError('save(state)：state 必须是对象')
    const payload = `${JSON.stringify(state, null, 2)}\n`
    const tmpPath = `${statePath}.tmp`
    try {
      fs.mkdirSync(baseDir, { recursive: true })
      fs.writeFileSync(tmpPath, payload, 'utf8')
      fs.renameSync(tmpPath, statePath)
    } catch (error) {
      try {
        fs.unlinkSync(tmpPath)
      } catch {
        /* 清理失败忽略，避免掩盖原始错误 */
      }
      throw error
    }
  }

  return { load, save, path: statePath }
}

/**
 * 项目元数据浅合并（不可变：不修改入参 state）。
 *
 * - 仅白名单字段（PROJECT_FIELDS）生效，未知键忽略；
 * - null / 空字符串（含纯空白）表示清除该字段（置 null）；
 * - 非字符串值忽略（契约只定义字符串与清除语义）；
 * - 总是刷新 updatedAt。
 *
 * @param {object} state 当前状态。
 * @param {string} workspaceId 工作区 id。
 * @param {object} patch 待合并字段。
 * @returns {{ state: object, project: object }}
 */
export function mergeProject(state, workspaceId, patch) {
  const id = nonEmptyString(workspaceId)
  if (id === undefined) throw new TypeError('mergeProject：workspaceId 必须是非空字符串')

  const base = isPlainObject(state) ? state : emptyState()
  const projects = isPlainObject(base.projects) ? base.projects : {}
  const project = normalizeProject(projects[id])
  const incoming = isPlainObject(patch) ? patch : {}

  for (const field of PROJECT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(incoming, field)) continue
    const value = incoming[field]
    if (value === null || (typeof value === 'string' && value.trim() === '')) {
      project[field] = null
      continue
    }
    if (typeof value === 'string') project[field] = value
    // 其它类型：忽略，避免把非字符串写进状态文件。
  }
  project.updatedAt = new Date().toISOString()

  return {
    state: {
      ...base,
      version: typeof base.version === 'number' ? base.version : STATE_VERSION,
      projects: { ...projects, [id]: project },
    },
    project,
  }
}

/** 目录内是否存在 .git（目录或 worktree 的 .git 文件都算）。 */
function hasGitMarker(dir) {
  try {
    const stat = fs.statSync(path.join(dir, '.git'))
    return stat.isDirectory() || stat.isFile()
  } catch {
    return false
  }
}

/** 从 workspacePath 向上找第一个含 .git 的目录；找不到用 workspacePath 本身。 */
function findProjectRoot(workspacePath) {
  const start = path.resolve(workspacePath)
  let current = start
  for (;;) {
    if (hasGitMarker(current)) return current
    const parent = path.dirname(current)
    if (parent === current) return start
    current = parent
  }
}

/**
 * 读取 AGENTS.md 候选链（契约第 3 节）。
 *
 * 顺序（宽 → 专）：
 *  1. $DSH_HOME/AGENTS.md                    scope=global
 *  2. $DSH_AGENTS_HOME/AGENTS.md             scope=agents（未设置时 ~/.agents/AGENTS.md）
 *  3. <项目根>/AGENTS.md、<项目根>/CLAUDE.md  scope=project
 *  4. <项目根>/AGENTS.local.md、CLAUDE.local.md scope=project-local
 *
 * 候选文件全部列出；存在才 stat + 读取片段（最多 4000 字符）。
 *
 * @param {{ workspacePath: string, dshHome?: string, agentsHome?: string }} options
 * @returns {{ projectRoot: string, files: Array<{ path: string, scope: string, exists: boolean, size: number, excerpt: string|null }> }}
 */
export function readRules({ workspacePath, dshHome, agentsHome } = {}) {
  const workspace = nonEmptyString(workspacePath)
  if (workspace === undefined) throw new TypeError('readRules：workspacePath 必须是非空字符串')

  const home = os.homedir()
  const dshHomeDir = nonEmptyString(dshHome) ?? path.join(home, '.dsh')
  const agentsHomeDir = nonEmptyString(agentsHome) ?? path.join(home, '.agents')
  const projectRoot = findProjectRoot(workspace)

  const candidates = [
    { path: path.join(dshHomeDir, 'AGENTS.md'), scope: 'global' },
    { path: path.join(agentsHomeDir, 'AGENTS.md'), scope: 'agents' },
    ...['AGENTS.md', 'CLAUDE.md'].map((name) => ({ path: path.join(projectRoot, name), scope: 'project' })),
    ...['AGENTS.local.md', 'CLAUDE.local.md'].map((name) => ({
      path: path.join(projectRoot, name),
      scope: 'project-local',
    })),
  ]

  const files = candidates.map((candidate) => describeRuleFile(candidate))
  return { projectRoot, files }
}

/** 探测单个候选文件：存在才读片段，异常按不存在处理（不阻断预览）。 */
function describeRuleFile(candidate) {
  const result = { path: candidate.path, scope: candidate.scope, exists: false, size: 0, excerpt: null }
  let stat
  try {
    stat = fs.statSync(candidate.path)
  } catch {
    return result
  }
  if (!stat.isFile()) return result

  result.exists = true
  result.size = stat.size

  let fd
  try {
    fd = fs.openSync(candidate.path, 'r')
    const length = Math.min(stat.size, RULES_MAX_READ_BYTES)
    const buffer = Buffer.alloc(length)
    const read = length === 0 ? 0 : fs.readSync(fd, buffer, 0, length, 0)
    result.excerpt = buffer.toString('utf8', 0, read).slice(0, RULES_EXCERPT_LIMIT)
  } catch (error) {
    console.warn(`[dsh-project-hub] 读取规则文件失败：${candidate.path}（${error?.message ?? error}）`)
    result.excerpt = null
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* 关闭失败不影响预览 */
      }
    }
  }
  return result
}
