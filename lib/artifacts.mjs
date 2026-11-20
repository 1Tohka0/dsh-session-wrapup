/**
 * 会话日志 → 文件清单（只读，绝不动磁盘）。
 *
 * 数据来源，按可信度从高到低：
 *   1. deliverables/presented —— AI 明确交给你、你点开过的东西；
 *   2. tool/call 的参数 —— write / edit / office_* / present / generate_image* 里出现的绝对路径；
 *   3. 兜底扫描 —— 会话开始后工作目录里被改过的文件（低置信，抓 bash 重定向之类）。
 *
 * 会话日志是「多帧串接」的 zstd：直接用 zstdDecompressSync 只解第一帧，正文会丢。
 * 下面的 decompressFrames 按 magic 28 B5 2F FD 逐帧解再拼。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
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
      if (statSync(dir).isDirectory()) return dir
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

/** 从任意嵌套参数里捞出「看起来是绝对路径」的字符串。 */
function harvestPaths(node, out, toolName) {
  if (typeof node === 'string') {
    if (ABS_PATH.test(node) && node.length < 400) {
      const key = normPath(node)
      const entry = out.get(key) ?? { path: node, tools: new Set(), presented: false }
      entry.tools.add(toolName)
      out.set(key, entry)
    }
    return
  }
  if (Array.isArray(node)) {
    for (const value of node) harvestPaths(value, out, toolName)
    return
  }
  if (node && typeof node === 'object') {
    for (const key of Object.keys(node)) harvestPaths(node[key], out, toolName)
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

/**
 * 收集本会话碰过的文件。
 * 返回 Map<小写路径, { path, tools:Set, presented, exists, size, mtime }>
 */
export function collectFiles(records) {
  const out = new Map()
  for (const record of records) {
    if (record.type === 'deliverables/presented') {
      for (const file of record.data?.files ?? []) {
        if (!file?.path) continue
        const key = normPath(file.path)
        const entry = out.get(key) ?? { path: file.path, tools: new Set(), presented: false }
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
    harvestPaths(args, out, name)
  }
  for (const entry of out.values()) {
    try {
      const st = statSync(entry.path)
      entry.exists = st.isFile()
      entry.size = st.size
      entry.mtime = st.mtimeMs
    } catch {
      entry.exists = false
      entry.size = 0
      entry.mtime = 0
    }
  }
  return out
}

const SKIP_SWEEP_DIRS = new Set([
  'node_modules', '.git', '.cache', '__pycache__', '.next', 'dist', 'build',
  '.venv', 'venv', '.idea', '.vscode', '.pnpm-store', 'target', 'obj',
])

/** 兜底：工作目录里会话开始后被改过的文件（低置信）。 */
export function sweepWorkspace(cwd, startMs, { maxDepth = 4, maxFiles = 200 } = {}) {
  const found = []
  if (!cwd || !existsSync(cwd)) return found
  const walk = (dir, depth) => {
    if (found.length >= maxFiles || depth > maxDepth) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_SWEEP_DIRS.has(entry.name.toLowerCase())) continue
        if (entry.name.startsWith('.')) continue
        walk(path, depth + 1)
      } else if (entry.isFile()) {
        try {
          const st = statSync(path)
          if (st.mtimeMs >= startMs - 1000) found.push({ path, size: st.size, mtime: st.mtimeMs })
        } catch {
          /* 读不到跳过 */
        }
      }
    }
  }
  walk(cwd, 0)
  return found
}
