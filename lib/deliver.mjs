/**
 * 交付物归集 —— 把清单里 keep=true 的文件挪进「成品」文件夹。
 *
 * 为什么单独一层：
 *   - 删除是「不要的东西进回收站」，归集是「要的东西放一起」，方向相反；
 *   - 归集只动交付物，不碰中间产物，也不删会话；
 *   - 同样只做 rename，失败才 copy+unlink，跨盘也能用。
 *
 * 目标目录固定在工作区内：默认 <cwd>/成品/<会话标题>，
 * deliverPerSession=false 时退化成 <cwd>/成品。防止把文件搬到工作区外。
 */
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, renameSync, unlinkSync,
} from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { normPath } from './config.mjs'
import { pruneEmptyDirs } from './trash.mjs'

const DEFAULT_DIR = '成品'
const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const MAX_FOLDER_CHARS = 48

/**
 * 会话标题 → 可以当文件夹名的字符串。
 *
 * 规则：去掉 Windows 不允许的字符；合并空白；掐头去尾的点和空格；
 * 过长按字符截断（不切坏 emoji）；空标题回退到 session-xxxxxxxx；
 * CON/NUL 这类保留名前面加「会话-」。同名标题会落进同一个文件夹，
 * 文件重名时再由 uniqueTarget 加序号。
 */
export function sessionFolderName(title, sessionId = '') {
  let name = String(title ?? '')
    .replace(INVALID_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
  if (!name) {
    const tail = String(sessionId ?? '').replace(/^session-/, '').slice(0, 8)
    name = tail ? `session-${tail}` : '未命名会话'
  }
  if (RESERVED_NAME.test(name)) name = `会话-${name}`
  const chars = Array.from(name)
  if (chars.length > MAX_FOLDER_CHARS) name = chars.slice(0, MAX_FOLDER_CHARS).join('').trim()
  return name || '未命名会话'
}

function isUnder(child, parent) {
  const c = normPath(child)
  const p = normPath(parent)
  return c !== p && c.startsWith(`${p}/`)
}

/** 重名时在扩展名前加 ` (1)`、` (2)`…；planned 让 dry-run 也不会算出两个同名目标。 */
function uniqueTarget(dest, name, planned) {
  const ext = extname(name)
  const base = ext ? name.slice(0, -ext.length) : name
  let candidate = join(dest, name)
  let n = 1
  while (existsSync(candidate) || planned.has(normPath(candidate))) {
    candidate = join(dest, `${base} (${n})${ext}`)
    n += 1
  }
  planned.add(normPath(candidate))
  return candidate
}

/** rename 优先；跨盘（EXDEV）或权限受限时退回「复制 + 删源」。 */
function moveFile(source, target) {
  try {
    renameSync(source, target)
  } catch (error) {
    if (!['EXDEV', 'EPERM', 'EACCES', 'EEXIST'].includes(error?.code)) throw error
    copyFileSync(source, target)
    unlinkSync(source)
  }
}

/**
 * 把 scan 结果里的交付物收进成品文件夹。
 *
 * @param scan scanSession() 的返回值（要有 items / cwd / pruneCandidates）
 * @param options { dirName?: string, subdir?: string, apply?: boolean }
 * @returns {{dest:string, dirName:string, apply:boolean, moved:Array, skipped:Array, failed:Array, bytes:number, pruned:string[]}}
 */
export function deliverItems(scan, { dirName = DEFAULT_DIR, subdir = '', apply = false } = {}) {
  const cwd = scan?.cwd
  if (!cwd) throw new Error('这个会话没有工作目录，没法归集交付物')
  const name = String(dirName ?? '').trim() || DEFAULT_DIR
  const sub = String(subdir ?? '').trim()
  // 子文件夹也走 resolve，`..` 之类会在下面的工作区检查里被拒
  const base = resolve(cwd, name)
  const baseKey = normPath(base)
  const dest = resolve(cwd, name, sub)
  const rootKey = normPath(cwd)
  const destKey = normPath(dest)
  if (destKey === rootKey || !destKey.startsWith(`${rootKey}/`)) {
    throw new Error('成品文件夹必须放在会话工作区里面')
  }

  const result = {
    dest,
    dirName: relative(cwd, dest).replace(/\\/g, '/'),
    apply,
    moved: [],
    skipped: [],
    failed: [],
    bytes: 0,
    pruned: [],
  }

  const sources = (Array.isArray(scan.items) ? scan.items : []).filter(
    (item) => item?.type === 'file' && item.keep,
  )

  // 已经在成品目录（任何一次对话的子文件夹）里的，不再搬第二次
  const pending = []
  for (const item of sources) {
    const source = resolve(item.path)
    if (normPath(source).startsWith(`${baseKey}/`)) {
      result.skipped.push({ path: source, why: '已经在成品文件夹里' })
    } else {
      pending.push(item)
    }
  }

  // 没有可搬的文件就别建空文件夹；有才检查目标并创建
  if (apply && pending.length > 0) {
    if (existsSync(dest) && !lstatSync(dest).isDirectory()) {
      throw new Error(`成品路径被一个同名文件占住了：${dest}`)
    }
    mkdirSync(dest, { recursive: true })
  }

  const planned = new Set()
  for (const item of pending) {
    const source = resolve(item.path)
    let stat
    try {
      stat = lstatSync(source)
    } catch {
      result.failed.push({ path: source, error: '文件不在了' })
      continue
    }
    if (!stat.isFile()) {
      result.skipped.push({ path: source, why: '不是普通文件' })
      continue
    }
    const target = uniqueTarget(dest, basename(source), planned)
    if (!apply) {
      result.moved.push({ from: source, to: target, size: stat.size })
      result.bytes += stat.size
      continue
    }
    try {
      moveFile(source, target)
      result.moved.push({ from: source, to: target, size: stat.size })
      result.bytes += stat.size
    } catch (error) {
      result.failed.push({ path: source, error: String(error?.message ?? error) })
    }
  }

  // 只收「这次被搬走的文件」路径上的空目录，别碰用户没选中的空文件夹
  if (apply && result.moved.length) {
    const allowed = new Set(
      (Array.isArray(scan.pruneCandidates) ? scan.pruneCandidates : []).map((p) => normPath(p)),
    )
    const touched = new Map()
    for (const item of result.moved) {
      let dir = dirname(item.from)
      while (isUnder(dir, cwd)) {
        const key = normPath(dir)
        if (allowed.has(key)) touched.set(key, dir)
        dir = dirname(dir)
      }
    }
    result.pruned = pruneEmptyDirs([...touched.values()], { cwd })
  }

  return result
}
