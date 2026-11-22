/**
 * 会话日志 → 文件清单（只读，绝不动磁盘）。
 *
 * 数据来源，按可信度从高到低：
 *   1. deliverables/presented —— AI 明确交给你、你点开过的东西；
 *   2. tool/call 的参数 —— write / edit / office_* / present / generate_image* 里的路径
 *      （绝对路径直接用；相对路径按会话工作目录解析）；
 *   3. 兜底扫描 —— 会话开始后工作目录里新建/改过的文件与文件夹（低置信，抓 bash 重定向之类）。
 *
 * 会话日志是「多帧串接」的 zstd：直接用 zstdDecompressSync 只解第一帧，正文会丢。
 * 下面的 decompressFrames 按 magic 28 B5 2F FD 逐帧解再拼。
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { normPath } from './config.mjs'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 多帧 zstd → 明文。坏帧跳过，永不抛。 */
export function decompressFrames(buffer) {
  const pieces = []
  let at = buffer.indexOf(MAGIC, 0)
  while (at !== -1) {
    try {
      const out = zstdDecompressSync(buffer.subarray(at))
      if (out && out.length) pieces.push(out)
    } catch {
      /* 半帧 / 损坏帧，跳过 */
    }
    at = buffer.indexOf(MAGIC, at + 1)
  }
  return Buffer.concat(pieces)
}

/** 会话明文按行解析成记录数组。 */
export function parseRecords(text) {
  const records = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      /* 非 JSON 行跳过 */
    }
  }
  return records
}

/** 会话目录：home/sessions/<工作区>/<会话 id>/；找不到返回 null。 */
export function findSessionDir(home, sessionId) {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return null
  let workspaces = []
  try {
    workspaces = readdirSync(root)
  } catch {
    return null
  }
  for (const workspace of workspaces) {
    const dir = join(root, workspace, sessionId)
    try {
      if (lstatSync(dir).isDirectory()) return dir
    } catch {
      /* 不在这个工作区 */
    }
  }
  return null
}

/** 读一个会话目录下的全部记录。 */
export function readSession(dir) {
  let files = []
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.zstd'))
  } catch {
    return []
  }
  const records = []
  for (const name of files) {
    try {
      const text = decompressFrames(readFileSync(join(dir, name))).toString('utf8')
      records.push(...parseRecords(text))
    } catch {
      /* 读坏就跳 */
    }
  }
  return records
}

/** 会话标题 / 工作目录 / 起止时间。 */
export function sessionMeta(records) {
  const head = records.find((record) => record.type === 'session') ?? {}
  const titles = records.filter((record) => record.type === 'session/title')
  const times = records.map((record) => record.time).filter(Boolean)
  const start = times.length > 0 ? Math.min(...times) : Date.now()
  return {
    title: titles.length > 0 ? titles[titles.length - 1].data?.title ?? '' : '',
    cwd: head.cwd ?? '',
    start,
    last: times.length > 0 ? Math.max(...times) : start,
  }
}

const ABS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/

/**
 * 工具参数里这些键才当路径看。别的字符串只有「本身就是绝对路径」才收，
 * 免得把提示词、命令、标题里的 `D:\` 误当成产物。
 */
const PATH_KEYS = new Set([
  'file_path', 'filepath', 'path', 'paths', 'output_path', 'outputpath',
  'target', 'target_path', 'targetpath', 'destination', 'dest',
  'filename', 'file', 'output', 'files',
])

/** 把参数值变成绝对路径；不像路径就返回 null。 */
function pathFromArg(value, key, cwd) {
  const raw = String(value ?? '').trim().replace(/^"|"$/g, '')
  if (!raw || raw.length > 400) return null
  if (ABS_PATH.test(raw)) return raw
  if (!cwd || !PATH_KEYS.has(key)) return null
  // 命令、通配符、选项不是文件路径
  if (raw.startsWith('-') || /[\r\n*?<>|]/.test(raw)) return null
  try {
    return resolve(cwd, raw)
  } catch {
    return null
  }
}

/** 从任意嵌套参数里捞出路径字符串（绝对路径，或按 cwd 解析出来的相对路径）。 */
function harvestPaths(node, out, toolName, context) {
  if (typeof node === 'string') {
    const path = pathFromArg(node, context.key, context.cwd)
    if (!path) return
    const key = normPath(path)
    const entry = out.get(key) ?? { path, tools: new Set(), presented: false }
    entry.tools.add(toolName)
    out.set(key, entry)
    return
  }
  if (Array.isArray(node)) {
    for (const value of node) harvestPaths(value, out, toolName, context)
    return
  }
  if (node && typeof node === 'object') {
    for (const key of Object.keys(node)) {
      harvestPaths(node[key], out, toolName, { ...context, key })
    }
  }
}

/** 会写文件的工具。别的一律不当作产物来源。 */
export const WRITE_TOOLS = new Set([
  'write',
  'edit',
  'present',
  'ops_write',
  'ops_edit',
  'office_render',
  'office_convert',
  'office_recalculate',
  'generate_image',
  'generate_images',
  'edit_image',
])

function statEntry(entry) {
  try {
    const st = lstatSync(entry.path)
    entry.exists = st.isFile()
    entry.isDir = st.isDirectory()
    entry.size = st.size
    entry.mtimeMs = st.mtimeMs
    entry.ctimeMs = st.ctimeMs
    entry.birthtimeMs = st.birthtimeMs
  } catch {
    entry.exists = false
    entry.isDir = false
    entry.size = 0
    entry.mtimeMs = 0
    entry.ctimeMs = 0
    entry.birthtimeMs = 0
  }
  return entry
}

/**
 * 收集本会话「工具明确碰过」的文件。
 * 返回 Map<小写路径, { path, tools:Set, presented, exists, size, mtimeMs, ... }>
 *
 * cwd 用于解析相对路径；不传就只认绝对路径（和旧版行为一致）。
 */
export function collectFiles(records, { cwd = '' } = {}) {
  const out = new Map()
  for (const record of records) {
    if (record.type === 'deliverables/presented') {
      for (const file of record.data?.files ?? []) {
        if (!file?.path) continue
        const path = pathFromArg(file.path, 'path', cwd)
        if (!path) continue
        const key = normPath(path)
        const entry = out.get(key) ?? { path, tools: new Set(), presented: false }
        entry.presented = true
        entry.tools.add('present')
        out.set(key, entry)
      }
      continue
    }
    if (record.type !== 'tool/call') continue
    const name = record.data?.name ?? ''
    if (!WRITE_TOOLS.has(name) && !name.startsWith('office_')) continue
    let args = record.data?.arguments
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args)
      } catch {
        continue
      }
    }
    harvestPaths(args, out, name, { cwd, key: '' })
  }
  for (const entry of out.values()) statEntry(entry)
  return out
}

/** 这些目录太重，兜底扫描不进去（里面的东西通常不该由「收尾」来管）。 */
const HEAVY_DIRS = new Set([
  'node_modules', '.git', '.cache', '__pycache__', '.next', 'dist', 'build',
  '.venv', 'venv', '.idea', '.vscode', '.pnpm-store', 'target', 'obj',
])

/** 目录/文件是不是「会话开始前后才出现的」。Windows 上用 birthtime，别处退回 ctime。 */
function isFreshDir(st, cutoff) {
  if (st.birthtimeMs > 0) return st.birthtimeMs >= cutoff
  return st.ctimeMs >= cutoff
}

/**
 * 是不是浏览器（Edge/Chrome）的配置目录。
 * 这类目录里全是缓存、Cookie、几十层空目录，不是交付物；
 * 会话里跑过浏览器工具时它会被当成「新建文件夹」淹没清单。
 */
function looksLikeBrowserProfile(dir) {
  let names
  try {
    names = new Set(readdirSync(dir))
  } catch {
    return false
  }
  if (!names.has('Local State')) return false
  return names.has('Default') || names.has('Preferences') || names.has('Secure Preferences')
}

function isFreshFile(st, cutoff) {
  if (st.birthtimeMs >= cutoff) return true
  // 解压、复制会保留旧 mtime，但 ctime 会更新，所以三个都看
  return st.mtimeMs >= cutoff || st.ctimeMs >= cutoff
}

/**
 * 统计一个目录的递归体积与条目数（只读，跳过符号链接）。
 * 用于文件夹行显示「多大、多少东西」，并发现清单外的内容。
 */
export function measureTree(root, { maxEntries = 5000, maxDepth = 40 } = {}) {
  const state = { size: 0, files: 0, dirs: 0, entries: 0, truncated: false }
  const walk = (dir, depth) => {
    if (state.truncated) return
    if (depth > maxDepth) {
      state.truncated = true
      return
    }
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (state.truncated) return
      state.entries += 1
      if (state.entries > maxEntries) {
        state.truncated = true
        return
      }
      if (entry.isSymbolicLink()) continue
      const path = join(dir, entry.name)
      let st
      try {
        st = lstatSync(path)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        state.dirs += 1
        walk(path, depth + 1)
      } else if (st.isFile()) {
        state.files += 1
        state.size += st.size
      }
    }
  }
  walk(root, 0)
  return state
}

/**
 * 兜底：工作目录里会话开始后新建/改过的文件，以及会话期间新建的文件夹。
 *
 * 和旧版相比：
 *   - 同时返回目录（删完成空文件夹的根因修复）；
 *   - 文件看 birthtime / mtime / ctime，解压或复制保留旧 mtime 也能抓到；
 *   - 新建文件夹里的所有内容都算（force），不再被单个文件的旧 mtime 骗过去；
 *   - 上限提高，并且返回 truncated 让界面能说「还有没列出来的」。
 *
 * @returns {{files: Map, dirs: Map, truncated: boolean, scannedFiles: number,
 *   scannedDirs: number, skippedHidden: number, skippedHeavy: number,
 *   limits: {maxDepth: number, maxFiles: number}}}
 */
export function sweepWorkspace(cwd, startMs, { maxDepth = 12, maxFiles = 2000, excludeRoots = [] } = {}) {
  const blocked = (excludeRoots ?? []).map((root) => normPath(root))
  const files = new Map()
  const dirs = new Map()
  const result = {
    files,
    dirs,
    truncated: false,
    scannedFiles: 0,
    scannedDirs: 0,
    skippedHidden: 0,
    skippedHeavy: 0,
    skippedProfiles: 0,
    limits: { maxDepth, maxFiles },
  }
  if (!cwd || !existsSync(cwd)) return result

  const cutoff = Number(startMs) - 1500

  const walk = (dir, depth, force) => {
    if (result.truncated) return
    if (depth > maxDepth) {
      result.truncated = true
      return
    }
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (result.truncated) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.isSymbolicLink()) continue
        if (HEAVY_DIRS.has(entry.name.toLowerCase())) {
          result.skippedHeavy += 1
          continue
        }
        if (entry.name.startsWith('.')) {
          result.skippedHidden += 1
          continue
        }
        let st
        try {
          st = lstatSync(path)
        } catch {
          continue
        }
        const key = normPath(path)
        // 别的会话的目录整棵跳过，别占扫描额度，也别让 truncated 误报
        if (blocked.some((root) => key === root || key.startsWith(`${root}/`))) continue
        result.scannedDirs += 1
        // 浏览器配置目录整棵跳过，否则缓存空目录会占满面板
        if (looksLikeBrowserProfile(path)) {
          result.skippedProfiles += 1
          continue
        }
        const fresh = force || isFreshDir(st, cutoff)
        if (fresh) {
          const key = normPath(path)
          if (!dirs.has(key)) {
            dirs.set(key, {
              path,
              size: 0,
              fileCount: 0,
              dirCount: 0,
              measured: false,
              truncated: false,
              mtimeMs: st.mtimeMs,
              birthtimeMs: st.birthtimeMs,
            })
          }
        }
        walk(path, depth + 1, fresh)
        continue
      }
      if (!entry.isFile()) continue
      if (result.scannedFiles >= maxFiles) {
        result.truncated = true
        return
      }
      result.scannedFiles += 1
      let st
      try {
        st = lstatSync(path)
      } catch {
        continue
      }
      if (!force && !isFreshFile(st, cutoff)) continue
      const key = normPath(path)
      if (files.has(key)) continue
      files.set(key, {
        path,
        size: st.size,
        mtimeMs: st.mtimeMs,
        ctimeMs: st.ctimeMs,
        birthtimeMs: st.birthtimeMs,
      })
    }
  }

  walk(cwd, 0, false)

  // 候选文件夹量一下体积；量不全就把 truncated 带出去，界面会提示。
  for (const dir of dirs.values()) {
    const measured = measureTree(dir.path)
    dir.size = measured.size
    dir.fileCount = measured.files
    dir.dirCount = measured.dirs
    dir.measured = true
    dir.truncated = measured.truncated
    if (measured.truncated) result.truncated = true
  }

  return result
}
