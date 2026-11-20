/**
 * Client half of the wrap-up panel bundle — plain browser module, no build step.
 *
 * A small button sits beside the Session title; it opens a dialog that asks the
 * Host half which files this conversation produced, groups them by purpose, and
 * lets the user tick what to delete. Nothing is scanned in the browser: the
 * Host route `/wrapup-panel/*` owns the filesystem and the trash.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-wrapup',
  factory(require) {
    const React = require('react')
    // `react-dom` is baseline, but a missing table entry must never blank the slot:
    // without a portal the dialog still renders, just inline where it was opened.
    let createPortal = null
    try {
      createPortal = require('react-dom').createPortal
    } catch {
      createPortal = null
    }
    const h = React.createElement

    /** Mount a fixed overlay over the page, or in place when no portal is available. */
    function mountOverlay(node) {
      return typeof createPortal === 'function' ? createPortal(node, document.body) : node
    }
    const { useCallback, useEffect, useMemo, useState } = React

    const TOKEN = {
      border: 'var(--dsw-alias-border-l2)',
      label1: 'var(--dsw-alias-label-primary)',
      label2: 'var(--dsw-alias-label-secondary)',
      label3: 'var(--dsw-alias-label-tertiary)',
      label4: 'var(--dsw-alias-label-quaternary)',
      surface: 'var(--dsw-alias-bg-module-platform)',
      layer: 'var(--dsw-alias-bg-layer-1)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      accent: 'var(--dsw-alias-state-business-primary)',
      radius: 'var(--dsw-radius-lg)',
    }

    const GROUP_ORDER = ['交付物', '其他', '中间产物', '中间脚本', '临时文件']
    const GROUP_HINT = {
      交付物: '这次要交的东西，默认保留',
      其他: '说不准用途，自己看一眼',
      中间产物: '过程草稿，默认删除',
      中间脚本: '跑完就没用了，默认删除',
      临时文件: '纯垃圾，默认删除',
    }

    function humanSize(bytes) {
      const n = Number(bytes) || 0
      if (n < 1024) return `${n} B`
      const units = ['KB', 'MB', 'GB']
      let value = n / 1024
      let i = 0
      while (value >= 1024 && i < units.length - 1) {
        value /= 1024
        i += 1
      }
      return `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ${units[i]}`
    }

    /** Call one Host route and unwrap its `{ok, data}` envelope. */
    async function call(path, init) {
      const response = await fetch(`/wrapup-panel${path}`, {
        cache: 'no-store',
        ...init,
      })
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (!response.ok || body.ok !== true) {
        throw new Error(body.error || `HTTP ${response.status}`)
      }
      return body.data
    }

    function postJson(path, payload) {
      return call(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
    }

    const styles = {
      trigger: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        height: '24px',
        padding: '0 8px',
        border: `0.5px solid ${TOKEN.border}`,
        borderRadius: '999px',
        background: 'transparent',
        color: TOKEN.label2,
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '1',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 9000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.32)',
      },
      dialog: {
        display: 'flex',
        flexDirection: 'column',
        width: 'min(940px, 92vw)',
        maxHeight: '84vh',
        border: `0.5px solid ${TOKEN.border}`,
        borderRadius: TOKEN.radius,
        background: TOKEN.surface,
        color: TOKEN.label1,
        boxShadow: '0 18px 60px rgba(0,0,0,0.28)',
        overflow: 'hidden',
      },
      header: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '12px',
        padding: '16px 20px 12px',
        borderBottom: `0.5px solid ${TOKEN.border}`,
      },
      title: { margin: 0, fontSize: '15px', fontWeight: 600, color: TOKEN.label1 },
      subtitle: { margin: '4px 0 0', fontSize: '12px', lineHeight: '1.6', color: TOKEN.label3 },
      close: {
        marginLeft: 'auto',
        border: 'none',
        background: 'transparent',
        color: TOKEN.label3,
        fontSize: '18px',
        lineHeight: '1',
        cursor: 'pointer',
        padding: '2px 4px',
      },
      body: { padding: '8px 20px 16px', overflow: 'auto', flex: '1 1 auto' },
      groupHead: {
        position: 'sticky',
        top: 0,
        display: 'flex',
        alignItems: 'baseline',
        gap: '8px',
        padding: '10px 0 6px',
        background: TOKEN.surface,
        zIndex: 1,
      },
      groupName: { fontSize: '12px', fontWeight: 600, color: TOKEN.label1 },
      groupHint: { fontSize: '11px', color: TOKEN.label4 },
      row: {
        display: 'grid',
        gridTemplateColumns: '18px 76px 1fr',
        alignItems: 'center',
        gap: '10px',
        padding: '6px 8px',
        margin: '0 -8px',
        borderRadius: '8px',
      },
      size: { fontSize: '11px', color: TOKEN.label3, textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
      path: { fontSize: '12px', color: TOKEN.label2, wordBreak: 'break-all', lineHeight: '1.5' },
      why: { fontSize: '11px', color: TOKEN.label4, marginLeft: '6px' },
      footer: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '12px 20px',
        borderTop: `0.5px solid ${TOKEN.border}`,
        background: TOKEN.surface,
        flexWrap: 'wrap',
      },
      note: { fontSize: '11px', color: TOKEN.label3, marginRight: 'auto', lineHeight: '1.5' },
      button: {
        height: '30px',
        padding: '0 14px',
        border: `0.5px solid ${TOKEN.border}`,
        borderRadius: '999px',
        background: 'transparent',
        color: TOKEN.label1,
        font: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
      },
      primary: {
        height: '30px',
        padding: '0 16px',
        border: 'none',
        borderRadius: '999px',
        background: TOKEN.accent,
        color: '#fff',
        font: 'inherit',
        fontSize: '12px',
        fontWeight: 600,
        cursor: 'pointer',
      },
      empty: { padding: '32px 0', textAlign: 'center', fontSize: '12px', color: TOKEN.label3 },
      error: { padding: '16px 0', fontSize: '12px', color: '#d9534f', lineHeight: '1.6' },
    }

    /** The dialog: scan on open, tick, delete, or queue the session. */
    function WrapupDialog({ sessionId, onClose }) {
      const [payload, setPayload] = useState(null)
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [message, setMessage] = useState('')
      const [picked, setPicked] = useState(() => new Set())
      /** 服务器最近一次实测的「闲置毫秒」；null = 不知道。 */
      const [liveIdle, setLiveIdle] = useState(null)
      /** 这个会话是否已经记进清理账本。 */
      const [queued, setQueued] = useState(false)

      const load = useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          const data = await call(`/scan?session=${encodeURIComponent(sessionId)}`)
          const list = Array.isArray(data.items) ? data.items : []
          setPayload({ ...data, items: list })
          setLiveIdle(typeof data.idleMs === 'number' ? data.idleMs : null)
          setQueued(Boolean(data.queued))
          // 默认勾选：扫描已经标成「建议删」的那些
          setPicked(new Set(list.filter((item) => !item.keep).map((item) => item.idx)))
        } catch (caught) {
          setError(String(caught?.message ?? caught))
        } finally {
          setLoading(false)
        }
      }, [sessionId])

      useEffect(() => {
        void load()
      }, [load])

      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])

      const items = payload?.items ?? []
      const groups = useMemo(() => {
        const map = new Map()
        for (const item of items) {
          const key = GROUP_ORDER.includes(item.kind) ? item.kind : '其他'
          if (!map.has(key)) map.set(key, [])
          map.get(key).push(item)
        }
        return GROUP_ORDER.filter((kind) => map.has(kind)).map((kind) => [kind, map.get(kind)])
      }, [items])

      const pickedBytes = useMemo(
        () => items.filter((item) => picked.has(item.idx)).reduce((sum, item) => sum + (item.size || 0), 0),
        [items, picked],
      )

      const toggle = (idx) => {
        setPicked((previous) => {
          const next = new Set(previous)
          if (next.has(idx)) next.delete(idx)
          else next.add(idx)
          return next
        })
      }

      const selectDeletable = () => setPicked(new Set(items.filter((item) => !item.keep).map((item) => item.idx)))
      const selectNone = () => setPicked(new Set())

      const runDelete = useCallback(
        async (alsoQueue) => {
          setBusy(true)
          setError('')
          setMessage('')
          // 只传路径：Host 会立刻重扫一遍再按路径匹配，编号错位也删不到别的文件。
          const paths = items.filter((item) => picked.has(item.idx)).map((item) => item.path)
          const keptPaths = items.filter((item) => !picked.has(item.idx)).map((item) => item.path)
          try {
            let text = ''
            if (paths.length > 0) {
              const result = await postJson('/delete', { session: sessionId, paths })
              text = `已删除 ${result.deleted} 个文件，${humanSize(result.bytes)}\n${result.batch}`
              if (result.missing?.length) text += `\n跳过 ${result.missing.length} 个已经不在磁盘上的`
              if (result.failed?.length) {
                text += '\n' + result.failed.map((item) => `! ${item.path}: ${item.error}`).join('\n')
              }
            } else {
              text = '没有勾选任何文件，跳过删除'
            }
            if (alsoQueue) {
              const marked = await postJson('/mark', {
                session: sessionId,
                keep: keptPaths,
                title: payload?.title ?? '',
              })
              setQueued(true)
              text +=
                `\n已记账：这个会话闲置满 ${marked.willDeleteAfterMinutes} 分钟后，` +
                '下次启动 DSH 会把它收进回收站（在那之前可以点「取消收尾」）。'
            }
            setMessage(text)
            await load()
          } catch (caught) {
            setError(String(caught?.message ?? caught))
          } finally {
            setBusy(false)
          }
        },
        [items, load, payload, picked, sessionId],
      )

      // 每 2.5 秒问一次服务器「现在多久没写了」。
      // 只靠打开面板时的快照会过期 —— AI 可能在扫描之后又开始写，快照就会把按钮
      // 错误地点亮成可点。轮询很轻（只 readdir + stat），比重新扫一遍便宜得多。
      useEffect(() => {
        let stopped = false
        const tick = async () => {
          try {
            const state = await call(`/queue?session=${encodeURIComponent(sessionId)}`)
            if (stopped) return
            setLiveIdle(typeof state.idleMs === 'number' ? state.idleMs : null)
            setQueued(Boolean(state.queued))
          } catch {
            /* 轮询失败不打扰用户，下一轮再试 */
          }
        }
        const timer = setInterval(tick, 2500)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [sessionId])

      // 10 秒内写过 = 这一轮还没说完。null 表示量不到，按「没在写」处理。
      const writing = liveIdle !== null && liveIdle < 10000

      const headerNote = payload
        ? `共 ${items.length} 个文件 · 合计 ${humanSize(payload.totalBytes)} · 勾选 ${picked.size} 个（${humanSize(pickedBytes)}）`
        : '正在统计这次对话产生的文件…'

      return mountOverlay(
        h(
          'div',
          {
            style: styles.overlay,
            onMouseDown: (event) => {
              if (event.target === event.currentTarget) onClose()
            },
          },
          h(
            'div',
            { style: styles.dialog, role: 'dialog', 'aria-modal': 'true', 'aria-label': '会话收尾' },
            h(
              'div',
              { style: styles.header },
              h(
                'div',
                null,
                h('h2', { style: styles.title }, '会话收尾'),
                h('p', { style: styles.subtitle }, headerNote),
                payload?.title
                  ? h('p', { style: { ...styles.subtitle, color: TOKEN.label4 } }, `会话：${payload.title}`)
                  : null,
              ),
              h('button', { style: styles.close, onClick: onClose, 'aria-label': '关闭' }, '×'),
            ),
            h(
              'div',
              { style: styles.body },
              loading ? h('div', { style: styles.empty }, '扫描中…') : null,
              error ? h('div', { style: styles.error }, error) : null,
              !loading && !error && items.length === 0
                ? h('div', { style: styles.empty }, '这次对话没有在工作区留下任何文件。')
                : null,
              groups.map(([kind, list]) =>
                h(
                  'section',
                  { key: kind },
                  h(
                    'div',
                    { style: styles.groupHead },
                    h('span', { style: styles.groupName }, kind),
                    h('span', { style: styles.groupHint }, `${GROUP_HINT[kind] ?? ''} · ${list.length} 个`),
                  ),
                  list.map((item) =>
                    h(
                      'label',
                      {
                        key: item.idx,
                        style: { ...styles.row, cursor: 'pointer' },
                        onMouseEnter: (event) => {
                          event.currentTarget.style.background = TOKEN.hover
                        },
                        onMouseLeave: (event) => {
                          event.currentTarget.style.background = 'transparent'
                        },
                      },
                      h('input', {
                        type: 'checkbox',
                        checked: picked.has(item.idx),
                        onChange: () => toggle(item.idx),
                      }),
                      h('span', { style: styles.size }, humanSize(item.size)),
                      h(
                        'span',
                        { style: styles.path, title: item.path },
                        item.path,
                        item.why ? h('span', { style: styles.why }, `← ${item.why}`) : null,
                      ),
                    ),
                  ),
                ),
              ),
              message
                ? h(
                    'pre',
                    {
                      style: {
                        margin: '14px 0 0',
                        padding: '10px 12px',
                        borderRadius: '8px',
                        background: TOKEN.layer,
                        color: TOKEN.label2,
                        fontSize: '11px',
                        lineHeight: '1.6',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                      },
                    },
                    message,
                  )
                : null,
            ),
            h(
              'div',
              { style: styles.footer },
              h(
                'span',
                { style: styles.note },
                queued
                  ? '这个会话已记进清理账本：闲置够久后，下次启动 DSH 会把它收进回收站。'
                  : payload?.skippedHome
                    ? `另有 ${payload.skippedHome} 个 DSH 自身数据文件不在清单里。`
                    : '删除是两阶段的：文件先挪进 home\\_trash，3 天后才真正消失。',
              ),
              h('button', { style: styles.button, onClick: selectDeletable, disabled: busy }, '恢复默认勾选'),
              h('button', { style: styles.button, onClick: selectNone, disabled: busy }, '全部不勾'),
              queued
                ? h(
                    'button',
                    {
                      style: styles.button,
                      disabled: busy,
                      onClick: async () => {
                        setBusy(true)
                        try {
                          await postJson('/unmark', { session: sessionId })
                          setQueued(false)
                          setMessage('已取消收尾，这个会话不会被自动删掉了。')
                        } catch (caught) {
                          setError(String(caught?.message ?? caught))
                        } finally {
                          setBusy(false)
                        }
                      },
                    },
                    '取消收尾',
                  )
                : null,
              h('button', { style: styles.button, onClick: onClose, disabled: busy }, '关掉'),
              h(
                'button',
                { style: styles.button, onClick: () => void runDelete(false), disabled: busy || picked.size === 0 },
                busy ? '处理中…' : '只删勾选的',
              ),
              h(
                'button',
                {
                  style: styles.primary,
                  onClick: () => void runDelete(true),
                  disabled: busy || writing,
                  title: writing ? '这一轮还在写，等它说完再收尾' : '删掉勾选的文件，并把这个会话记进清理队列',
                },
                busy ? '处理中…' : writing ? '等这一轮说完…' : '删掉并收尾会话',
              ),
            ),
          ),
        ),
      )
    }

    /** Header button: one per Session, opens the dialog. */
    function WrapupButton({ sessionId }) {
      const [open, setOpen] = useState(false)
      if (typeof sessionId !== 'string' || sessionId === '') return null
      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            style: styles.trigger,
            title: '列出这次对话产生的文件，选择要删掉哪些',
            onClick: () => setOpen(true),
            onMouseEnter: (event) => {
              event.currentTarget.style.background = TOKEN.hover
            },
            onMouseLeave: (event) => {
              event.currentTarget.style.background = 'transparent'
            },
          },
          h('span', { 'aria-hidden': true }, '🧹'),
          h('span', null, '收尾'),
        ),
        open ? h(WrapupDialog, { sessionId, onClose: () => setOpen(false) }) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.actions',
              id: 'wrapup-panel',
              order: 20,
            },
            WrapupButton,
          ),
        )
      },
    }
  },
})
