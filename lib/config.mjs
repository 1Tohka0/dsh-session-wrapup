/**
 * 路径与阈值 —— 整个插件只有这一份。
 *
 * 想改行为先看这里：两个「多久算还在写」的阈值、会话 id 的合法形状、
 * 以及 home 下哪些目录不许碰，全在这里定义，Host、Client、CLI 共用。
 */
import { join } from 'node:path'

/** DSH 数据目录。桌面端一定注入了 DSH_HOME；没有就退回 ~/.dsh。 */
export const HOME = (process.env.DSH_HOME || join(process.env.USERPROFILE || 'C:/Users', '.dsh'))
  .replace(/[\\/]+$/, '')

/** 常用路径。 */
export const PATHS = {
  home: HOME,
  sessions: join(HOME, 'sessions'),
  trash: join(HOME, '_trash'),
  state: join(HOME, 'state'),
  /** 收尾账本：谁已经被收过尾、日志可以删了。 */
  queue: join(HOME, 'state', 'wrapup-queue.json'),
  /** 用户自定义分类规则（可选）；没有就用插件包里自带的 rules.json。 */
  rulesOverride: join(HOME, 'state', 'wrapup-rules.json'),
  /** DSH 自己的会话索引，删会话后要同步。 */
  workspaceIndex: join(HOME, 'storages', 'workspace.json'),
}

/**
 * 面板：这一轮还在写（不足 10 秒前落过盘）就不让记账。
 * 只是挡住误点，真正的安全闸在下面那个。
 */
export const IDLE_REFUSE_MS = 10_000

/**
 * 启动清理：收过尾的会话，要闲置满 30 分钟才真的删。
 * 12:44 那次事故就是没有这道闸 —— 重启时把正在用的会话删了。
 */
export const IDLE_DELETE_MS = 30 * 60_000

/** 合法会话 id：session-<uuid>。挡住 ../ 之类的怪东西。 */
export const SESSION_ID_RE = /^session-[0-9a-f-]{8,}$/i

/** 路径比较统一成 / 加小写 —— Windows 上同一路径可能写成 D:\x 或 D:/x。 */
export function normPath(value) {
  return String(value ?? '').replace(/\\/g, '/').toLowerCase()
}

export const HOME_NORM = normPath(HOME)

/** home 下面的一切（会话、附件、插件、运行时）都不归收尾面板管。 */
export function isHomeOwned(value) {
  const n = normPath(value)
  return n === HOME_NORM || n.startsWith(`${HOME_NORM}/`)
}

/** 会话 id 形状校验；顺便挡掉路径穿越。 */
export function isValidSessionId(value) {
  return typeof value === 'string' && SESSION_ID_RE.test(value)
}
