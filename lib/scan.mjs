/**
 * 扫描：把「这次对话在工作区里留下了什么」整理成一张清单。
 *
 * 纯计算 —— 不写缓存、不删任何东西。每次调用都重新读会话日志，
 * 所以面板看到的一切都基于「此刻的磁盘」，不会出现拿旧编号删错文件的问题。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectFiles,
  findSessionDir,
  readSession,
  sessionMeta,
  sweepWorkspace,
} from './artifacts.mjs'
import { classify, clearRulesCache, loadRules } from './classify.mjs'
import { HOME, isHomeOwned, isValidSessionId, normPath } from './config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 插件自己的源码目录 —— 它可能正好在某个会话的工作区里，别把自己列进去。 */
const SELF_DIR = normPath(join(HERE, '..'))

const KIND_RANK = { 交付物: 0, 其他: 1, 中间产物: 2, 中间脚本: 3, 临时文件: 4 }

/** 路径里是否带着某个目录名（`/deliverables/` 这种）。 */
function inDirs(path, dirs) {
  const normalized = `/${normPath(path)}/`
  return (dirs ?? []).some((dir) => normalized.includes(`/${String(dir).toLowerCase()}/`))
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
  const files = collectFiles(records)

  const useSweep = sweep && rules.sweep?.enabled !== false
  if (useSweep && meta.cwd) {
    for (const found of sweepWorkspace(meta.cwd, meta.start, rules.sweep ?? {})) {
      const key = normPath(found.path)
      if (files.has(key)) continue
      files.set(key, {
        path: found.path,
        tools: new Set(['sweep']),
        presented: false,
        exists: true,
        size: found.size,
        mtime: found.mtime,
      })
    }
  }

  const items = []
  let skippedHome = 0
  let skippedGone = 0
  for (const entry of files.values()) {
    const key = normPath(entry.path)
    if (key === SELF_DIR || key.startsWith(`${SELF_DIR}/`)) continue
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
      path: entry.path,
      size: entry.size,
      kind: result.kind,
      importance: result.importance,
      keep: result.keep,
      why: result.why,
      via: [...entry.tools].join('+'),
      presented: entry.presented,
    })
  }

  items.sort(
    (a, b) => (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) || b.size - a.size,
  )
  items.forEach((item, index) => {
    item.idx = index + 1
  })

  return {
    session: sessionId,
    dir,
    title: meta.title,
    cwd: meta.cwd,
    start: meta.start,
    scannedAt: Date.now(),
    skippedHome,
    skippedGone,
    totalBytes: items.reduce((sum, item) => sum + item.size, 0),
    deleteBytes: items.filter((item) => !item.keep).reduce((sum, item) => sum + item.size, 0),
    items,
  }
}

/** 规则改了之后清缓存，下次扫描生效。 */
export function reloadRules() {
  clearRulesCache()
  return loadRules({ fresh: true })
}
