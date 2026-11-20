/**
 * 会话本身的处理：判活、按账本删日志、同步 workspace.json。
 *
 * 这里只在「启动清理」时动磁盘，而且必须同时满足：
 *   1. 这个会话被用户明确收过尾（在账本里）；
 *   2. 它已经闲置超过 IDLE_DELETE_MS（默认 30 分钟）。
 * 少一条都不删 —— 12:44 那次事故就是因为只看第 1 条。
 */
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { findSessionDir } from './artifacts.mjs'
import { HOME, IDLE_DELETE_MS, PATHS, isValidSessionId } from './config.mjs'
import { readQueue, unmarkSession } from './queue.mjs'

/** 会话目录里最新一个 .zstd 的 mtime；0 表示没找到。 */
export function lastWriteMs(sessionId) {
  const dir = findSessionDir(HOME, sessionId)
  if (!dir) return 0
  let newest = 0
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.zstd')) continue
      try {
        newest = Math.max(newest, statSync(join(dir, name)).mtimeMs)
      } catch {
        /* 单个文件读不到不影响判断 */
      }
    }
  } catch {
    /* 目录读不到就当没写过 */
  }
  return newest
}

/** 这一轮是不是还在写。 */
export function isWriting(sessionId, { withinMs = 10_000 } = {}) {
  const wrote = lastWriteMs(sessionId)
  return wrote > 0 && Date.now() - wrote < withinMs
}

/** 一次删除批次的时间戳目录。 */
export function trashStampDir(now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return join(PATHS.trash, stamp)
}

/**
 * 把会话目录挪进回收站，并同步 DSH 的会话索引。
 * 不物理删 —— 误删还能从 home/_trash 里捞。
 */
export function trashSession(sessionId, now = Date.now()) {
  const dir = findSessionDir(HOME, sessionId)
  if (!dir) return { ok: false, reason: '会话目录不存在' }
  const stamp = trashStampDir(now)
  let size = 0
  try {
    for (const name of readdirSync(dir)) {
      try {
        size += statSync(join(dir, name)).size
      } catch {
        /* 量不到按 0 */
      }
    }
  } catch {
    /* 忽略 */
  }
  const destination = join(stamp, 'sessions', dir.slice(PATHS.sessions.length).replace(/^[\\/]+/, ''))
  try {
    mkdirSync(join(destination, '..'), { recursive: true })
    renameSync(dir, destination)
  } catch (error) {
    return { ok: false, reason: `挪不动：${error.message}` }
  }
  syncWorkspaceIndex(new Set([sessionId]), stamp)
  return { ok: true, bytes: size, destination }
}

/** 从 workspace.json 的会话列表里摘掉已删会话（先备份到同批回收站）。 */
export function syncWorkspaceIndex(deleted, stamp) {
  const file = PATHS.workspaceIndex
  if (!existsSync(file) || deleted.size === 0) return
  try {
    mkdirSync(stamp, { recursive: true })
    copyFileSync(file, join(stamp, 'workspace.json.bak'))
  } catch {
    /* 备份失败也继续 */
  }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    for (const workspace of Object.values(data.tables?.workspaces ?? {})) {
      if (Array.isArray(workspace.sessionIds)) {
        workspace.sessionIds = workspace.sessionIds.filter((id) => !deleted.has(id))
      }
    }
    if (Array.isArray(data.global?.archivedSessionIds)) {
      data.global.archivedSessionIds = data.global.archivedSessionIds.filter((id) => !deleted.has(id))
    }
    if (Array.isArray(data.global?.pinnedSessionIds)) {
      data.global.pinnedSessionIds = data.global.pinnedSessionIds.filter((id) => !deleted.has(id))
    }
    writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
  } catch {
    /* 索引更新失败不影响会话日志删除 */
  }
}

/**
 * 启动清理：把账本里「收过尾 + 闲置够久」的会话日志删掉。
 * @param options { dryRun?: boolean, idleMs?: number }
 */
export function finishQueued({ dryRun = false, idleMs = IDLE_DELETE_MS } = {}) {
  const queue = readQueue(HOME)
  const done = []
  const waiting = []
  const failed = []
  for (const [sessionId, entry] of Object.entries(queue.sessions ?? {})) {
    if (!isValidSessionId(sessionId)) {
      failed.push({ sessionId, reason: '会话 id 不合法' })
      continue
    }
    if (!findSessionDir(HOME, sessionId)) {
      if (!dryRun) unmarkSession(HOME, sessionId)
      done.push({ sessionId, title: entry?.title ?? '', reason: '会话已经不在了' })
      continue
    }
    const wrote = Math.max(lastWriteMs(sessionId), Number(entry?.markedAt) || 0)
    const idle = Date.now() - wrote
    if (idle < idleMs) {
      waiting.push({ sessionId, title: entry?.title ?? '', idleMs: idle })
      continue
    }
    if (dryRun) {
      done.push({ sessionId, title: entry?.title ?? '', reason: '预览：会被删', bytes: 0 })
      continue
    }
    const result = trashSession(sessionId)
    if (result.ok) {
      unmarkSession(HOME, sessionId)
      done.push({ sessionId, title: entry?.title ?? '', bytes: result.bytes, reason: '已收进回收站' })
    } else {
      failed.push({ sessionId, reason: result.reason })
    }
  }
  return { done, waiting, failed }
}

/** 回收站批次按天清理：超过 keepDays 天的物理删除。 */
export function purgeOldTrash({ keepDays = 3, dryRun = false } = {}) {
  const cutoff = Date.now() - keepDays * 24 * 3600 * 1000
  const removed = []
  if (!existsSync(PATHS.trash)) return removed
  for (const name of readdirSync(PATHS.trash)) {
    const dir = join(PATHS.trash, name)
    try {
      if (statSync(dir).mtimeMs > cutoff) continue
    } catch {
      continue
    }
    if (dryRun) {
      removed.push(name)
      continue
    }
    try {
      rmSync(dir, { recursive: true, force: true })
      removed.push(name)
    } catch {
      /* 删不掉就留给下一轮 */
    }
  }
  return removed
}
