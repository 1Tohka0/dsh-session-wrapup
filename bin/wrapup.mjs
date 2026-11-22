#!/usr/bin/env node
/**
 * 会话收尾 · 命令行入口
 *
 * 面板按钮用的是同一批 lib/*.mjs，所以命令行和界面永远一个行为。
 *
 *   node bin/wrapup.mjs scan   [--session <id>] [--no-sweep] [--json]
 *   node bin/wrapup.mjs delete --session <id> --paths "a;b;c" [--dry]
 *   node bin/wrapup.mjs delete --session <id> --all-deletable [--dry]
 *   node bin/wrapup.mjs mark   [--session <id>] [--keep "a;b"] [--force]
 *   node bin/wrapup.mjs unmark [--session <id>]
 *   node bin/wrapup.mjs status
 *   node bin/wrapup.mjs finish [--dry] [--idle 30]
 *
 * 环境变量：DSH_HOME（必需）、DSH_SESSION_ID（默认会话）。
 */
import { HOME, IDLE_DELETE_MS, IDLE_REFUSE_MS, isValidSessionId } from '../lib/config.mjs'
import { humanSize } from '../lib/classify.mjs'
import { scanSession } from '../lib/scan.mjs'
import { trashPaths } from '../lib/trash.mjs'
import { markSession, readQueue, unmarkSession } from '../lib/queue.mjs'
import { finishQueued, isWriting } from '../lib/sessions.mjs'

function parseArgs(argv) {
  const command = (argv[0] ?? 'scan').toLowerCase()
  const options = {}
  for (let i = 1; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      options[key] = next
      i += 1
    } else {
      options[key] = true
    }
  }
  return { command, options }
}

function sessionId(options) {
  return options.session || process.env.DSH_SESSION_ID || ''
}

function groupOf(items) {
  const groups = { 交付物: [], 文件夹: [], 其他: [], 中间产物: [], 中间脚本: [], 临时文件: [] }
  for (const item of items) (groups[item.kind] ?? groups['其他']).push(item)
  return groups
}

function printScan(payload) {
  const groups = groupOf(payload.items)
  console.log(`会话：${payload.title || '(无标题)'}  ${payload.session}`)
  console.log(`目录：${payload.cwd || payload.dir}`)
  console.log(
    `共 ${payload.fileCount ?? payload.items.length} 个文件` +
      `${payload.folderCount ? `、${payload.folderCount} 个文件夹` : ''}，` +
      `${humanSize(payload.totalBytes)}；` +
      `其中建议删除 ${humanSize(payload.deleteBytes)}`,
  )
  if (payload.truncated) console.log('注意：文件太多，清单被截断了，请用面板或缩小工作区再扫。')
  for (const line of payload.warnings ?? []) console.log(`注意：${line}`)
  const order = [
    ['交付物', '保留'],
    ['文件夹', '整包删'],
    ['其他', '待定'],
    ['中间产物', '建议删'],
    ['中间脚本', '建议删'],
    ['临时文件', '建议删'],
  ]
  for (const [kind, hint] of order) {
    const list = groups[kind]
    if (!list.length) continue
    const bytes = list.reduce((sum, item) => sum + item.size, 0)
    console.log(`\n【${kind}】（${hint}，${list.length} 个，${humanSize(bytes)}）`)
    for (const item of list) {
      const tag = item.type === 'dir' ? `[文件夹 ${item.fileCount} 个文件] ` : ''
      const unknown = item.unknownFiles > 0 ? `（其中 ${item.unknownFiles} 个不在清单里）` : ''
      console.log(
        `  ${String(item.idx).padStart(2)}. ${humanSize(item.size).padStart(8)}  ${tag}${item.path}${unknown}   ← ${item.why}`,
      )
    }
  }
  if (!payload.items.length) console.log('\n(这次没有留下任何文件)')
  if (payload.skippedHome) console.log(`\n(另有 ${payload.skippedHome} 个 DSH 自身数据文件不在清单里)`)
  if (payload.skippedGone) console.log(`(跳过 ${payload.skippedGone} 个已经不在磁盘上的旧记录)`)
}

function commandScan(options) {
  const payload = scanSession(sessionId(options), { sweep: options['no-sweep'] !== true })
  if (options.json) console.log(JSON.stringify(payload, null, 2))
  else printScan(payload)
}

function commandDelete(options) {
  const id = sessionId(options)
  if (!isValidSessionId(id)) {
    console.error('会话 id 不合法：需要 --session session-<uuid>')
    process.exit(2)
  }
  const payload = scanSession(id)
  let picked
  if (options['all-deletable'] === true) {
    picked = payload.items.filter((item) => !item.keep)
  } else if (typeof options.paths === 'string') {
    const wanted = new Set(
      options.paths.split(';').map((value) => value.trim().replace(/\\/g, '/').toLowerCase()).filter(Boolean),
    )
    picked = payload.items.filter((item) =>
      wanted.has(item.path.replace(/\\/g, '/').toLowerCase()),
    )
    if (!picked.length) {
      console.error('这些路径不在本次清单里（可能已经被删或改名），重新 scan 一次')
      process.exit(3)
    }
  } else {
    console.error('要删哪些？--paths "a;b" 或 --all-deletable')
    process.exit(2)
  }
  const kept = picked.filter((item) => item.keep)
  for (const item of kept) console.error(`! ${item.path}：这是要保留的交付物，跳过`)
  picked = picked.filter((item) => !item.keep)
  if (!picked.length) {
    console.error('选中的都是要保留的交付物，没有可删的')
    process.exit(3)
  }
  const result = trashPaths(picked.map((item) => item.path), {
    apply: options.dry !== true,
    cwd: payload.cwd,
    pruneCandidates: payload.pruneCandidates,
  })
  const prefix = options.dry === true ? '[预览] 将删除' : '[已删除]'
  const folders = result.moved.filter((moved) => moved.isDir).length
  const files = result.moved.length - folders
  console.log(`${prefix} ${files} 个文件、${folders} 个文件夹，${humanSize(result.bytes)} → ${result.batch}`)
  for (const moved of result.moved) console.log(`  - ${moved.isDir ? '[文件夹] ' : ''}${moved.path}`)
  for (const dir of result.pruned) console.log(`  - 空文件夹 ${dir}`)
  for (const failed of result.failed) console.log(`  ! ${failed.path}: ${failed.error}`)
}

function commandMark(options) {
  const id = sessionId(options)
  if (!isValidSessionId(id)) {
    console.error('会话 id 不合法')
    process.exit(2)
  }
  if (options.force !== true && isWriting(id, { withinMs: IDLE_REFUSE_MS })) {
    console.error('这个会话刚才还在写，等这一轮说完再记账（真要记加 --force）')
    process.exit(3)
  }
  const kept = typeof options.keep === 'string' ? options.keep.split(';').filter(Boolean) : []
  const entry = markSession(id, { title: options.title ?? '', kept })
  console.log(`已记账：${id}`)
  console.log(`下次启动 DSH 时，若它已闲置 ${Math.round(IDLE_DELETE_MS / 60000)} 分钟以上，会话日志会被收进回收站。`)
  console.log(JSON.stringify(entry, null, 2))
}

function commandUnmark(options) {
  const id = sessionId(options)
  console.log(unmarkSession(id) ? `已撤销：${id}` : `队列里没有：${id}`)
}

function commandStatus() {
  const queue = readQueue(HOME)
  const ids = Object.keys(queue.sessions)
  if (!ids.length) {
    console.log('收尾队列是空的')
    return
  }
  for (const id of ids) {
    const entry = queue.sessions[id]
    console.log(`${id}  ${new Date(entry.markedAt).toLocaleString()}  ${entry.title ?? ''}  保留 ${(entry.kept ?? []).length} 个`)
  }
}

function commandFinish(options) {
  const idleMs = Number(options.idle) > 0 ? Number(options.idle) * 60_000 : IDLE_DELETE_MS
  const report = finishQueued({ dryRun: options.dry === true, idleMs })
  if (!report.done.length && !report.waiting.length && !report.failed.length) {
    console.log('账本是空的，没有要收尾的会话')
    return
  }
  for (const item of report.done) {
    console.log(`✓ ${item.sessionId}  ${humanSize(item.bytes ?? 0)}  ${item.reason}  ${item.title ?? ''}`)
  }
  for (const item of report.waiting) {
    console.log(`· 再等等 ${item.sessionId}  ${Math.round(item.idleMs / 60000)} 分钟前还在写  ${item.title ?? ''}`)
  }
  for (const item of report.failed) console.log(`! ${item.sessionId}  ${item.reason}`)
}

const { command, options } = parseArgs(process.argv.slice(2))
try {
  dispatch(command, options)
} catch (error) {
  // 不给用户看堆栈：参数/路径这类问题一句话说清就够了
  console.error(String(error?.message ?? error))
  process.exit(1)
}

function dispatch(command, options) {
  switch (command) {
  case 'scan':
    commandScan(options)
    break
  case 'delete':
    commandDelete(options)
    break
  case 'mark':
    commandMark(options)
    break
  case 'unmark':
    commandUnmark(options)
    break
  case 'status':
    commandStatus()
    break
  case 'finish':
    commandFinish(options)
    break
    default:
      console.error(`未知命令：${command}`)
      process.exit(2)
  }
}
