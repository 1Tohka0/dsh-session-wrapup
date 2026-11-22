/**
 * 扫描：把「这次对话在工作区里留下了什么」整理成一张清单。
 *
 * 纯计算 —— 不写缓存、不删任何东西。每次调用都重新读会话日志，
 * 所以面板看到的一切都基于「此刻的磁盘」，不会出现拿旧编号删错文件的问题。
 *
 * 清单里有两类条目：
 *   type='file' —— 一个文件；
 *   type='dir'  —— 会话期间新建的文件夹（叶子目录才列，避免一层套一层），
 *                  删除时连同里面的内容一起进回收站。
 */
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectFiles,
  findSessionDir,
  readSession,
  sessionMeta,
  sweepWorkspace,
} from './artifacts.mjs'
import { classify, classifyDir, clearRulesCache, loadRules } from './classify.mjs'
import { HOME, PATHS, SESSION_ID_RE, isHomeOwned, isValidSessionId, normPath } from './config.mjs'
import { sessionFolderName } from './deliver.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 所有会话目录（project-slug/session-id）。 */
function listSessionDirs() {
  const found = []
  let projects = []
  try {
    projects = readdirSync(PATHS.sessions, { withFileTypes: true })
  } catch {
    return found
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    let sessions = []
    try {
      sessions = readdirSync(join(PATHS.sessions, project.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of sessions) {
      if (!entry.isDirectory() || !SESSION_ID_RE.test(entry.name)) continue
      found.push({ id: entry.name, dir: join(PATHS.sessions, project.name, entry.name) })
    }
  }
  return found
}

/**
 * 同一工作区里别的会话点名写过的路径。
 *
 * DSH 的会话可以共用一个 cwd，兜底扫描只看时间的话，会把「另一个对话刚生成的文件」
 * 算到当前对话头上。这里读兄弟会话的日志，把它们写过的文件收成两类：
 *   claimed —— 精确文件路径，扫描时跳过；
 *   roots   —— 该文件所在的工作区一级目录（如 shuma_tier），整棵跳过。
 * 只影响兜底扫描；本会话工具调用里明确写过的路径不受影响。
 */
function otherSessionClaims(cwd, selfId) {
  const claimed = new Set()
  const roots = new Set()
  let sessions = 0
  if (!cwd) return { claimed, roots, sessions }
  const cwdNorm = normPath(cwd)
  for (const { id, dir } of listSessionDirs()) {
    if (id === selfId) continue
    let records
    try {
      records = readSession(dir)
    } catch {
      continue
    }
    const meta = sessionMeta(records)
    if (!meta.cwd || normPath(meta.cwd) !== cwdNorm) continue
    sessions += 1
    const files = collectFiles(records, { cwd: meta.cwd })
    for (const key of files.keys()) {
      claimed.add(key)
      const rest = key.slice(cwdNorm.length).replace(/^\/+/, '')
      const slash = rest.indexOf('/')
      if (slash > 0) roots.add(`${cwdNorm}/${rest.slice(0, slash)}`)
    }
  }
  return { claimed, roots, sessions }
}
/** 插件自己的源码目录 —— 它可能正好在某个会话的工作区里，别把自己列进去。 */
const SELF_DIR = normPath(join(HERE, '..'))

const KIND_RANK = { 交付物: 0, 文件夹: 1, 其他: 2, 中间产物: 3, 中间脚本: 4, 临时文件: 5 }

/** path 是否在 dir 里面（不含 dir 本身）。 */
function isUnder(path, dir) {
  return normPath(path).startsWith(`${normPath(dir)}/`)
}

/** path 是否落在任意一个 root 里（含 root 本身）。 */
function isUnderAny(path, roots) {
  const key = normPath(path)
  for (const root of roots) {
    if (key === root || key.startsWith(`${root}/`)) return true
  }
  return false
}

/** 路径里是否带着某个目录名（`/deliverables/` 这种）。 */
function inDirs(path, dirs) {
  const normalized = `/${normPath(path)}/`
  return (dirs ?? []).some((dir) => normalized.includes(`/${String(dir).toLowerCase()}/`))
}

function isSelf(path) {
  const key = normPath(path)
  return key === SELF_DIR || key.startsWith(`${SELF_DIR}/`)
}

/**
 * 生成清单。
 * @param sessionId session-<uuid>
 * @param options { sweep?: boolean } 关掉兜底扫描会快很多，但可能漏掉脚本产物
 */
export function scanSession(sessionId, { sweep = true } = {}) {
  if (!isValidSessionId(sessionId)) {
    throw new Error('会话 id 不合法（应形如 session-xxxxxxxx-…）')
  }
  const dir = findSessionDir(HOME, sessionId)
  if (!dir) throw new Error(`找不到会话目录：${sessionId}`)

  const rules = loadRules({ fresh: true })
  const records = readSession(dir)
  const meta = sessionMeta(records)
  // 相对路径按会话工作目录解析；这是旧版漏检的一大来源
  const files = collectFiles(records, { cwd: meta.cwd })

  const useSweep = sweep && rules.sweep?.enabled !== false
  let swept = null
  let skippedOther = 0
  let foreign = { claimed: new Set(), roots: new Set(), sessions: 0 }
  if (useSweep && meta.cwd) {
    if (rules.sweep?.excludeOtherSessions !== false) {
      foreign = otherSessionClaims(meta.cwd, sessionId)
    }
    swept = sweepWorkspace(meta.cwd, meta.start, {
      ...rules.sweep,
      excludeRoots: [...foreign.roots],
    })
    for (const found of swept.files.values()) {
      const key = normPath(found.path)
      if (files.has(key)) continue
      if (foreign.claimed.has(key) || isUnderAny(key, foreign.roots)) {
        skippedOther += 1
        continue
      }
      files.set(key, {
        path: found.path,
        tools: new Set(['sweep']),
        presented: false,
        exists: true,
        size: found.size,
        mtimeMs: found.mtimeMs,
        ctimeMs: found.ctimeMs,
        birthtimeMs: found.birthtimeMs,
      })
    }
  }

  const items = []
  let skippedHome = 0
  let skippedGone = 0

  // ---- 文件 ----
  for (const entry of files.values()) {
    if (isSelf(entry.path)) continue
    if (isHomeOwned(entry.path)) {
      skippedHome += 1
      continue
    }
    if (!entry.exists) {
      // 已经删掉的，不再出现在清单里 —— 否则面板会一直显示幽灵条目
      skippedGone += 1
      continue
    }
    const result = classify(entry.path, rules, {
      presented: entry.presented,
      inDeliverablesDir: inDirs(entry.path, rules.deliverableDirs),
    })
    items.push({
      idx: 0,
      type: 'file',
      path: entry.path,
      size: entry.size,
      kind: result.kind,
      importance: result.importance,
      keep: result.keep,
      defaultDelete: result.defaultDelete,
      why: result.why,
      via: [...entry.tools].join('+'),
      presented: entry.presented,
    })
  }

  // ---- 文件夹 ----
  const fileItems = items.slice()
  const dirCandidates = swept
    ? [...swept.dirs.values()].filter((candidate) => !isUnderAny(candidate.path, foreign.roots))
    : []
  const pruneCandidates = []
  for (const candidate of dirCandidates) {
    if (isSelf(candidate.path)) continue
    if (isHomeOwned(candidate.path)) continue
    if (normPath(candidate.path) === normPath(meta.cwd)) continue
    pruneCandidates.push(candidate.path)
  }

  // 只列叶子目录：`out/a/b` 列 b；删掉 b 后 a、out 由删除层顺手收掉。
  // 这样界面不会出现三层「文件夹」，也不会出现父子重复勾选。
  const withChildren = new Set()
  for (const candidate of dirCandidates) {
    for (const other of dirCandidates) {
      if (other.path === candidate.path) continue
      if (isUnder(other.path, candidate.path)) withChildren.add(normPath(candidate.path))
    }
  }

  for (const candidate of dirCandidates) {
    if (isSelf(candidate.path) || isHomeOwned(candidate.path)) continue
    if (withChildren.has(normPath(candidate.path))) continue
    // 纯空目录（浏览器缓存最爱生成）不单独列行，免得几百个空壳把面板淹了；
    // 它们仍在 pruneCandidates 里，删除/归集后会被顺手收掉。
    if (!Number(candidate.fileCount || 0)) continue
    const descendants = fileItems.filter((item) => isUnder(item.path, candidate.path))
    const deliverableCount = descendants.filter((item) => item.keep).length
    const known = descendants.length
    const unknownFiles = Math.max(0, Number(candidate.fileCount || 0) - known)
    const result = classifyDir(candidate.path, rules, {
      containsDeliverable: deliverableCount > 0,
      deliverableCount,
      unknownFiles,
      fileCount: Number(candidate.fileCount || 0),
    })
    items.push({
      idx: 0,
      type: 'dir',
      path: candidate.path,
      size: candidate.size,
      kind: result.kind,
      importance: result.importance,
      keep: result.keep,
      defaultDelete: result.defaultDelete,
      why: result.why,
      via: '扫描',
      presented: false,
      fileCount: candidate.fileCount,
      dirCount: candidate.dirCount,
      unknownFiles,
    })
  }

  items.sort((a, b) => {
    const rank = (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9)
    if (rank !== 0) return rank
    if (a.type !== b.type) return a.type === 'dir' ? 1 : -1
    return b.size - a.size
  })
  items.forEach((item, index) => {
    item.idx = index + 1
  })

  const fileList = items.filter((item) => item.type === 'file')
  const dirList = items.filter((item) => item.type === 'dir')
  const warnings = []
  if (swept?.truncated) {
    warnings.push(
      `扫描到了上限（最多 ${swept.limits.maxFiles} 个文件 / ${swept.limits.maxDepth} 层），` +
        '可能还有没列出来的。可以在 rules.json 里把 sweep.maxFiles / maxDepth 调大。',
    )
  }
  if (swept?.skippedHidden) {
    warnings.push(`跳过了 ${swept.skippedHidden} 个点开头的隐藏目录（通常不放交付物）。`)
  }
  if (swept?.skippedHeavy) {
    warnings.push(`跳过了 ${swept.skippedHeavy} 个依赖/构建目录（node_modules、.git 等）。`)
  }
  if (swept?.skippedProfiles) {
    warnings.push(`跳过了 ${swept.skippedProfiles} 个浏览器配置目录（Edge/Chrome 的缓存，不是交付物）。`)
  }
  if (foreign.sessions > 0) {
    warnings.push(
      `排除了 ${foreign.sessions} 个其他会话在同一个工作区里写过的内容` +
        (skippedOther ? `，另有 ${skippedOther} 个文件没列进来` : '') +
        '。',
    )
  }

  const deliverDir = rules.deliverDir || '成品'
  const deliverPerSession = rules.deliverPerSession !== false
  // 面板提前显示真实落点；真正交付时 Host 会按当时的标题再算一次
  const deliverFolder = deliverPerSession ? sessionFolderName(meta.title, sessionId) : ''

  return {
    session: sessionId,
    dir,
    title: meta.title,
    cwd: meta.cwd,
    start: meta.start,
    scannedAt: Date.now(),
    skippedHome,
    skippedGone,
    totalBytes: fileList.reduce((sum, item) => sum + item.size, 0),
    deleteBytes: fileList.filter((item) => item.defaultDelete).reduce((sum, item) => sum + item.size, 0),
    folderBytes: dirList.filter((item) => item.defaultDelete).reduce((sum, item) => sum + item.size, 0),
    fileCount: fileList.length,
    folderCount: dirList.length,
    truncated: Boolean(swept?.truncated),
    skippedHidden: swept?.skippedHidden ?? 0,
    skippedHeavy: swept?.skippedHeavy ?? 0,
    skippedProfiles: swept?.skippedProfiles ?? 0,
    skippedOtherSessions: skippedOther,
    excludedOtherSessions: foreign.sessions,
    deliverDir,
    deliverPerSession,
    deliverFolder,
    warnings,
    /** 删除后允许顺手收掉的空目录（Host 会再校验一次） */
    pruneCandidates,
    items,
  }
}

/** 规则改了之后清缓存，下次扫描生效。 */
export function reloadRules() {
  clearRulesCache()
  return loadRules({ fresh: true })
}
