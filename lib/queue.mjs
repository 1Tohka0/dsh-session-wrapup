/**
 * 收尾账本 —— 「这个会话已经收过尾、日志可以删了」的便签。
 *
 * 文件：$DSH_HOME/state/wrapup-queue.json
 * 结构：{ sessions: { "<会话 id>": { markedAt, title, kept, deleted } } }
 *
 * 只是便签，不存内容：真正的记录在会话日志里。
 * 启动清理（lib/sessions.mjs 的 finishQueued）按这张便签做事；
 * auto-clean 技能也会读同一个文件，两边谁先跑都行（跑完会把它划掉）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { HOME } from './config.mjs'

export function queuePath(home = HOME) {
  return join(home, 'state', 'wrapup-queue.json')
}

export function readQueue(home = HOME) {
  const file = queuePath(home)
  if (!existsSync(file)) return { sessions: {} }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (!data.sessions || typeof data.sessions !== 'object') data.sessions = {}
    return data
  } catch {
    return { sessions: {} }
  }
}

export function writeQueue(queue, home = HOME) {
  const file = queuePath(home)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(queue, null, 2), 'utf8')
}

/** 记账。重复记会合并，不会丢之前的保留列表。 */
export function markSession(sessionId, info = {}, home = HOME) {
  const queue = readQueue(home)
  queue.sessions[sessionId] = { markedAt: Date.now(), ...(queue.sessions[sessionId] ?? {}), ...info }
  writeQueue(queue, home)
  return queue.sessions[sessionId]
}

/** 撤销记账（面板上的「取消收尾」）。 */
export function unmarkSession(sessionId, home = HOME) {
  const queue = readQueue(home)
  if (!queue.sessions[sessionId]) return false
  delete queue.sessions[sessionId]
  writeQueue(queue, home)
  return true
}

/** 这个会话有没有被记过账。 */
export function isMarked(sessionId, home = HOME) {
  return Boolean(readQueue(home).sessions[sessionId])
}
