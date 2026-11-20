/**
 * 会话收尾面板 · Host 半边
 *
 * 只做三件事：给浏览器开几条同源路由、校验参数、把活儿交给 lib/。
 * 所有磁盘操作都在 lib/ 里，命令行（bin/wrapup.mjs）用的是同一批函数 ——
 * 所以界面和命令行永远一致，不会有「两套逻辑」。
 *
 * 路由（都挂在 /wrapup-panel 前缀下）：
 *   GET  /health            存活探针 + 版本 + 账本数量
 *   GET  /scan?session=     列出本次对话产生的文件
 *   GET  /queue?session=    这个会话有没有被记过账
 *   POST /delete            把勾选的文件收进回收站
 *   POST /mark              记账：这个会话收过尾了
 *   POST /unmark            撤销记账
 */
import { markSession, readQueue, unmarkSession } from './lib/queue.mjs'
import { scanSession } from './lib/scan.mjs'
import { trashPaths } from './lib/trash.mjs'
import { finishQueued, isWriting, lastWriteMs, purgeOldTrash } from './lib/sessions.mjs'
import { HOME, IDLE_DELETE_MS, IDLE_REFUSE_MS, PATHS, isValidSessionId, normPath } from './lib/config.mjs'

export const name = 'wrapup-panel'
export const inject = ['webServer']

const VERSION = '1.0.0'
const MAX_BODY = 1024 * 1024
const PREFIX = '/wrapup-panel'

/** 启动后等一会儿再动手，别和 DSH 自己的启动流程抢 IO。 */
const STARTUP_DELAY_MS = 90_000

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

const ok = (res, data) => sendJson(res, 200, { ok: true, data })
const fail = (res, status, error) => sendJson(res, status, { ok: false, error })

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 只接受同源页面的请求；别的网页不能遥控你删文件。 */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  return origin === `http://${req.headers.host}`
}

/**
 * 按路径删。路径由浏览器传回，Host 立刻重新扫一遍再按路径匹配 ——
 * 这样即使中途有文件新增/改名，也绝不会删到别的文件。
 */
function deleteByPaths(session, paths) {
  if (!isValidSessionId(session)) throw new Error('会话 id 不合法')
  const listed = (Array.isArray(paths) ? paths : []).filter((value) => typeof value === 'string' && value !== '')
  if (!listed.length) throw new Error('没有选中任何文件')
  // 和面板用同样的扫描口径（含兜底扫描），否则靠兜底才发现的文件删不掉
  const fresh = scanSession(session)
  const byPath = new Map(fresh.items.map((item) => [normPath(item.path), item.path]))
  const resolved = []
  const missing = []
  for (const path of listed) {
    const hit = byPath.get(normPath(path))
    if (hit) resolved.push(hit)
    else missing.push(path)
  }
  if (!resolved.length) {
    throw new Error('选中的文件已经不在清单里了（可能被删或改名），重新打开一次面板')
  }
  const result = trashPaths(resolved, { apply: true })
  return {
    deleted: result.moved.length,
    bytes: result.bytes,
    batch: result.batch,
    missing,
    failed: result.failed,
  }
}

async function handle(req, res, config) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname.slice(PREFIX.length) || '/'

  if (req.method === 'GET' && path === '/health') {
    const queue = readQueue(HOME)
    return ok(res, {
      home: HOME,
      version: VERSION,
      queued: Object.keys(queue.sessions).length,
      config,
    })
  }

  if (req.method === 'GET' && path === '/scan') {
    const session = url.searchParams.get('session') ?? ''
    try {
      const payload = scanSession(session)
      const wrote = lastWriteMs(session)
      return ok(res, {
        ...payload,
        lastWriteMs: wrote,
        idleMs: wrote > 0 ? Date.now() - wrote : null,
        queued: Boolean(readQueue(HOME).sessions[session]),
      })
    } catch (error) {
      return fail(res, 400, String(error?.message ?? error))
    }
  }

  if (req.method === 'GET' && path === '/queue') {
    const session = url.searchParams.get('session') ?? ''
    const queue = readQueue(HOME)
    const wrote = isValidSessionId(session) ? lastWriteMs(session) : 0
    return ok(res, {
      session,
      wrote,
      idleMs: wrote > 0 ? Date.now() - wrote : null,
      queued: Boolean(queue.sessions[session]),
      entry: queue.sessions[session] ?? null,
      total: Object.keys(queue.sessions).length,
    })
  }

  if (req.method !== 'POST') return fail(res, 405, '不支持的方法')
  if (!['/delete', '/mark', '/unmark'].includes(path)) return fail(res, 404, '没有这个接口')
  if (!sameOrigin(req)) return fail(res, 403, '跨源请求被拒绝')

  let body
  try {
    body = await readBody(req)
  } catch (error) {
    return fail(res, 400, String(error?.message ?? error))
  }

  try {
    if (path === '/delete') {
      return ok(res, deleteByPaths(body.session, body.paths))
    }
    if (!isValidSessionId(body.session)) throw new Error('会话 id 不合法')
    if (path === '/mark') {
      if (isWriting(body.session, { withinMs: IDLE_REFUSE_MS })) {
        return fail(res, 409, 'AI 还在往这个会话里写，等这一轮结束再来收尾')
      }
      const kept = (Array.isArray(body.keep) ? body.keep : []).filter((v) => typeof v === 'string' && v !== '')
      const entry = markSession(body.session, {
        title: typeof body.title === 'string' ? body.title : '',
        kept,
      })
      return ok(res, {
        entry,
        willDeleteAfterMinutes: Math.round(IDLE_DELETE_MS / 60000),
        queueFile: PATHS.queue,
      })
    }
    return ok(res, { removed: unmarkSession(body.session) })
  } catch (error) {
    return fail(res, 500, String(error?.message ?? error))
  }
}

/**
 * 启动清理：把账本里「收过尾 + 闲置够久」的会话日志收进回收站。
 * 这是面板自己的清理，不依赖 auto-clean —— 别人下载插件也能用。
 */
function scheduleCleanup(ctx) {
  const run = () => {
    try {
      const report = finishQueued()
      const purged = purgeOldTrash({ keepDays: 3 })
      if (report.done.length || report.failed.length || purged.length) {
        console.log(
          `[wrapup] 收尾 ${report.done.length} 个会话，回收站清理 ${purged.length} 批，` +
            `失败 ${report.failed.length} 个`,
        )
      }
    } catch (error) {
      console.warn('[wrapup] 启动清理失败：', error?.message ?? error)
    }
  }
  // 用全局 setTimeout：ctx 上取未注入的服务会直接抛错，
  // 而这里只是一次延迟任务，不需要跟着插件生命周期取消。
  const timer = setTimeout(run, STARTUP_DELAY_MS)
  if (typeof timer?.unref === 'function') timer.unref()
}

export function apply(ctx, config) {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: (req, res) => handle(req, res, config),
    }),
  )
  scheduleCleanup(ctx)
}
