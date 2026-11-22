/**
 * 文件/文件夹删除 —— 整个插件唯一会挪东西的地方。
 *
 * 两阶段：先 rename 进 $DSH_HOME/_trash/<时间戳>/wrapup/…，
 * 过几天再由 purgeOldTrash（或 auto-clean 的回收站阶段）物理删。
 * 所以任何一次点错都还有得捞。
 *
 * 目录也走同一条路：整包 rename，体积按递归统计。
 * 移动完成后再把「这次会话新建、现在已经空了」的目录收掉。
 */
import {
  existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync,
} from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'
import { measureTree } from './artifacts.mjs'
import { HOME, PATHS, isHomeOwned, normPath } from './config.mjs'

/** 这一批删除的落点。 */
export function batchDir(now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return join(PATHS.trash, stamp, 'wrapup')
}

/** 单个条目在回收站里的落点：home 下保持相对路径，别处按盘符加前缀。 */
function landing(runDir, abs, isDir = false) {
  let relative
  if (isHomeOwned(abs)) {
    relative = abs.slice(PATHS.home.length).replace(/^[\\/]+/, '')
  } else {
    relative = abs.replace(/^([A-Za-z]):[\\/]/, '$1_/').replace(/^[\\/]+/, '')
  }
  let destination = join(runDir, relative)
  let n = 1
  while (existsSync(destination)) {
    const dot = isDir ? -1 : relative.lastIndexOf('.')
    destination =
      dot > 0
        ? join(runDir, `${relative.slice(0, dot)}~${n}${relative.slice(dot)}`)
        : join(runDir, `${relative}~${n}`)
    n += 1
  }
  return destination
}

/** 盘符根 / 共享根 / `/`。 */
function isRootPath(abs) {
  return normPath(abs) === normPath(parse(abs).root)
}

/** child 是否在 parent 里面（不含相等）。 */
function isUnder(child, parent) {
  const c = normPath(child)
  const p = normPath(parent)
  return c !== p && c.startsWith(`${p}/`)
}

/** 目标是不是工作区本身或它的上级。 */
function isCwdUnsafe(abs, cwd) {
  if (!cwd) return false
  const a = normPath(abs)
  const c = normPath(cwd)
  return a === c || c.startsWith(`${a}/`)
}

/** 目标是不是 DSH home 本身或它的上级。 */
function isHomeUnsafe(abs) {
  const a = normPath(abs)
  const h = normPath(HOME)
  return a === h || h.startsWith(`${a}/`)
}

/**
 * 删除后收空目录。
 * 只收 pruneCandidates 里点过名的目录（= 本次会话新建的目录），
 * 不会顺手删掉用户原本就有的空文件夹。
 */
export function pruneEmptyDirs(candidates, { cwd = '' } = {}) {
  const allowed = new Map()
  for (const value of Array.isArray(candidates) ? candidates : []) {
    const abs = resolve(String(value ?? '').trim())
    if (abs) allowed.set(normPath(abs), abs)
  }
  const ordered = [...allowed.entries()].sort(
    (a, b) => b[0].split('/').length - a[0].split('/').length,
  )
  const pruned = []
  for (const [, dir] of ordered) {
    if (!cwd || !isUnder(dir, cwd)) continue
    if (!existsSync(dir)) continue
    try {
      if (!lstatSync(dir).isDirectory()) continue
      if (readdirSync(dir).length > 0) continue
      rmdirSync(dir)
      pruned.push(dir)
    } catch {
      /* 删不掉就留着，下一轮再说 */
    }
  }
  return pruned
}

/**
 * 把一组路径（文件或文件夹）挪进回收站。
 * 返回 { batch, moved:[{path,size,isDir}], failed:[{path,error}], pruned, bytes, apply }
 *
 * @param options { apply, now, cwd, pruneCandidates }
 */
export function trashPaths(paths, {
  apply = false,
  now = Date.now(),
  cwd = '',
  pruneCandidates = [],
} = {}) {
  const batch = batchDir(now)
  const result = { batch, moved: [], failed: [], pruned: [], bytes: 0, apply }

  const entries = []
  const seen = new Set()
  for (const raw of paths) {
    const cleaned = String(raw ?? '').trim().replace(/^"|"$/g, '')
    if (!cleaned) continue
    let abs
    try {
      abs = resolve(cleaned)
    } catch {
      result.failed.push({ path: cleaned, error: '路径不合法' })
      continue
    }
    const key = normPath(abs)
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ abs, key })
  }

  // 父目录已经选中时，子项不用再单独挪一次（rename 会把它一起带走）。
  entries.sort((a, b) => a.key.split('/').length - b.key.split('/').length)
  const roots = []
  for (const entry of entries) {
    if (roots.some((root) => isUnder(entry.abs, root.abs))) continue
    roots.push(entry)
  }

  for (const { abs } of roots) {
    // 最后一道闸：home、盘符根、工作区本身/上级、home 的上级，全部拒绝
    if (isHomeOwned(abs)) {
      result.failed.push({ path: abs, error: 'DSH 数据目录不归收尾面板管' })
      continue
    }
    if (isHomeUnsafe(abs)) {
      result.failed.push({ path: abs, error: '不能删 DSH 数据目录的上级' })
      continue
    }
    if (isRootPath(abs)) {
      result.failed.push({ path: abs, error: '不能删盘符根目录' })
      continue
    }
    if (isCwdUnsafe(abs, cwd)) {
      result.failed.push({ path: abs, error: '不能删工作区本身或它的上级' })
      continue
    }

    let st
    try {
      st = lstatSync(abs)
    } catch {
      result.failed.push({ path: abs, error: '不存在' })
      continue
    }

    const isDir = st.isDirectory() && !st.isSymbolicLink()
    const size = isDir ? measureTree(abs).size : st.size || 0

    if (!apply) {
      result.moved.push({ path: abs, size, isDir })
      result.bytes += size
      continue
    }
    try {
      const destination = landing(batch, abs, isDir)
      mkdirSync(dirname(destination), { recursive: true })
      renameSync(abs, destination)
      result.moved.push({ path: abs, size, isDir })
      result.bytes += size
    } catch (error) {
      result.failed.push({ path: abs, error: error.message })
    }
  }

  if (apply && result.moved.length > 0) {
    // 只收「这次确实动过」的目录，以及它们的上级里点过名的新建目录。
    // 不这么收的话，同一次会话里新建但没勾选的空目录会被顺手删掉。
    const movedKeys = result.moved.map((item) => normPath(item.path))
    const relevant = pruneCandidates.filter((value) => {
      const key = normPath(resolve(String(value ?? '').trim()))
      return movedKeys.some((moved) => moved === key || moved.startsWith(`${key}/`))
    })
    result.pruned = pruneEmptyDirs(relevant, { cwd })
  }
  return result
}
