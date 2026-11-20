/**
 * 文件删除 —— 整个插件唯一会挪文件的地方。
 *
 * 两阶段：先 rename 进 $DSH_HOME/_trash/<时间戳>/wrapup/…，
 * 过几天再由 purgeOldTrash（或 auto-clean 的回收站阶段）物理删。
 * 所以任何一次点错都还有得捞。
 */
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PATHS, isHomeOwned } from './config.mjs'

/** 这一批删除的落点。 */
export function batchDir(now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return join(PATHS.trash, stamp, 'wrapup')
}

/** 单个文件在回收站里的落点：home 下保持相对路径，别处按盘符加前缀。 */
function landing(runDir, abs) {
  let relative
  if (isHomeOwned(abs)) {
    relative = abs.slice(PATHS.home.length).replace(/^[\\/]+/, '')
  } else {
    relative = abs.replace(/^([A-Za-z]):[\\/]/, '$1_/').replace(/^[\\/]+/, '')
  }
  let destination = join(runDir, relative)
  let n = 1
  while (existsSync(destination)) {
    const dot = relative.lastIndexOf('.')
    destination =
      dot > 0
        ? join(runDir, `${relative.slice(0, dot)}~${n}${relative.slice(dot)}`)
        : join(runDir, `${relative}~${n}`)
    n += 1
  }
  return destination
}

/**
 * 把一组路径挪进回收站。
 * 返回 { batch, moved:[{path,size}], failed:[{path,error}], bytes, apply }
 */
export function trashPaths(paths, { apply = false, now = Date.now() } = {}) {
  const batch = batchDir(now)
  const result = { batch, moved: [], failed: [], bytes: 0, apply }

  for (const raw of paths) {
    const abs = String(raw ?? '').trim().replace(/^"|"$/g, '')
    if (!abs) continue
    // 最后一道闸：home 下的一切（会话、插件、运行时）绝不在这里删
    if (isHomeOwned(abs)) {
      result.failed.push({ path: abs, error: 'DSH 数据目录不归收尾面板管' })
      continue
    }
    let st
    try {
      st = statSync(abs)
    } catch {
      result.failed.push({ path: abs, error: '不存在' })
      continue
    }
    const size = st.size || 0
    if (!apply) {
      result.moved.push({ path: abs, size })
      result.bytes += size
      continue
    }
    try {
      const destination = landing(batch, abs)
      mkdirSync(dirname(destination), { recursive: true })
      renameSync(abs, destination)
      result.moved.push({ path: abs, size })
      result.bytes += size
    } catch (error) {
      result.failed.push({ path: abs, error: error.message })
    }
  }
  return result
}
