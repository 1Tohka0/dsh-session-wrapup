/**
 * 分类规则 —— 决定一个文件算「交付物」还是「中间脚本」。
 *
 * 优先级（改顺序就可能改结论，谨慎）：
 *   1. 展示过（present）或在交付目录里        → 交付物，保留
 *   2. 落在临时目录 / 临时后缀                → 临时文件，删
 *   3. 脚本后缀                               → 中间脚本，删
 *   4. 成品后缀                               → 交付物，保留
 *   5. 文本类后缀                             → 中间产物，删
 *   6. 都不认识 → 其他，删（但面板里会单独列一组，容易看见）
 *
 * 规则来源：插件包内 rules.json 是默认值；若 $DSH_HOME/state/wrapup-rules.json
 * 存在，就用它逐项覆盖（只写你想改的那几项即可，不用抄全文）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PATHS } from './config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLED = join(HERE, '..', 'rules.json')

const FALLBACK = {
  deliverableExt: ['.pptx', '.docx', '.xlsx', '.pdf', '.png', '.svg', '.mp4', '.zip'],
  deliverableDirs: ['deliverables', '交付', '成品', 'output'],
  scriptExt: ['.ps1', '.py', '.js', '.mjs', '.ts', '.sh', '.bat', '.cmd', '.vbs'],
  tempExt: ['.tmp', '.bak', '.log', '.cache', '.part', '.crdownload'],
  tempDirs: ['node_modules', '.git', '.cache', '__pycache__', 'tmp', 'temp'],
  textExt: ['.txt', '.md', '.json', '.csv', '.yaml', '.yml', '.ini', '.html', '.xml'],
  sweep: { enabled: true, maxDepth: 4, maxFiles: 200 },
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

let cached = null

/** 读规则（带进程内缓存；面板要实时生效就重启插件或刷新页面重扫）。 */
export function loadRules({ fresh = false } = {}) {
  if (cached && !fresh) return cached
  const base = readJson(BUNDLED) ?? {}
  const override = existsSync(PATHS.rulesOverride) ? readJson(PATHS.rulesOverride) ?? {} : {}
  const rules = { ...FALLBACK, ...base, ...override }
  // sweep 是对象，单独深合并一层
  rules.sweep = { ...FALLBACK.sweep, ...(base.sweep ?? {}), ...(override.sweep ?? {}) }
  cached = rules
  return rules
}

export function clearRulesCache() {
  cached = null
}

/** 判断一个文件属于哪一组。返回 { kind, importance, keep, why }。 */
export function classify(filePath, rules, { presented = false, inDeliverablesDir = false } = {}) {
  const lower = String(filePath).toLowerCase()
  const ext = extname(lower)
  const parts = lower.split(/[\\/]/)

  if (presented || inDeliverablesDir) {
    return {
      kind: '交付物',
      importance: '高',
      keep: true,
      why: presented ? '你展示/打开过' : '在交付目录里',
    }
  }
  if ((rules.tempDirs ?? []).some((dir) => parts.includes(dir))) {
    return { kind: '临时文件', importance: '低', keep: false, why: '临时目录' }
  }
  if ((rules.tempExt ?? []).includes(ext)) {
    return { kind: '临时文件', importance: '低', keep: false, why: `${ext} 临时后缀` }
  }
  if ((rules.scriptExt ?? []).includes(ext)) {
    return { kind: '中间脚本', importance: '中', keep: false, why: `${ext} 脚本` }
  }
  if ((rules.deliverableExt ?? []).includes(ext)) {
    return { kind: '交付物', importance: '高', keep: true, why: `${ext} 成品格式` }
  }
  if ((rules.textExt ?? []).includes(ext)) {
    return { kind: '中间产物', importance: '中', keep: false, why: `${ext} 草稿/数据` }
  }
  return { kind: '其他', importance: '中', keep: false, why: '未识别' }
}

/** 人看的体积。 */
export function humanSize(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ${units[i]}`
}
