# 对话收尾 · 详细说明

README 讲「怎么用」，这一份讲「里面怎么转、改哪里、出错先看哪儿」。

## 它解决什么

一次对话结束，工作区里往往不只是那张交付的相片 / PPT / 表格：还有抽页脚本、临时 txt、渲染出的 png、中间 md、`__pycache__`、以及一两个整包的文件夹。手动翻目录既慢又容易删错；等保留期自动清又不知道到底会清掉什么。

这个插件把「这次对话碰过哪些文件和文件夹」摆在你面前，**分类 + 说明理由 + 让你勾**，然后才动手。会话本身也能一起收尾。

---

## 分层：五层，一层一件事

```
client.js   ① 界面层：弹窗、分组、勾选状态、结果文案
   │  HTTP（同源、JSON）
index.js    ② 接口层：七条路由、参数校验、把活交给 lib
   │  import
lib/        ③ 大脑层：读日志 → 扫描 → 分类 → 删除/归集 → 记账
   │  import
bin/wrapup.mjs ④ 命令行：和界面共用 ③
rules.json  ⑤ 规则层：分类后缀、目录名、扫描上限
```

为什么要分这么细：**同一份逻辑只写一次**。面板和命令行都调 `lib/`，所以「命令行能删的、面板也能删」「面板判定为交付物的、命令行也会保留」是结构保证，不靠人记得同步改两处。

### ③ 大脑层里谁管什么

| 文件 | 输入 | 输出 | 一句话 |
| --- | --- | --- | --- |
| `lib/config.mjs` | 环境变量 `DSH_HOME` | 路径常量、两个时间阈值 | 所有「魔数」只在这里 |
| `lib/artifacts.mjs` | 会话日志、工作区路径 | 文件/文件夹集合 | 只读：解日志、抓路径、兜底扫描 |
| `lib/classify.mjs` | 路径 + 规则 | `{kind, keep, why, defaultDelete}` | 只判断，不碰磁盘 |
| `lib/scan.mjs` | 会话 id | 完整清单 + 警告 | 纯计算、无缓存，每次都是实时 |
| `lib/trash.mjs` | 路径列表 | 回收站批次、失败列表 | **唯一会 rename 的地方** |
| `lib/deliver.mjs` | 清单 + 成品目录名 | 搬迁结果、跳过/失败列表 | 只搬 `keep` 文件；按标题清洗出会话子文件夹 |
| `lib/queue.mjs` | 会话 id + 保留清单 | 账本条目 | 记账/撤销，不做磁盘删除 |
| `lib/sessions.mjs` | 会话 id | 判活、挪会话、同步索引 | 启动清理与「还在写」判断 |

---

## 一次收尾的流程

1. 点标题栏的 **🧹 收尾**。
2. 面板向 Host 请求 `/wrapup-panel/scan?session=<id>`，Host 读会话日志、组装清单。
3. 你勾选 → 面板把**最外层路径**发回 `/delete`。文件夹只发它自己，里面的文件由 Host 整包带走。
4. Host **重新扫描一遍**，按路径匹配后 rename 进 `_trash/<时间戳>/wrapup/`；随后只清理「这次会话新建、现在已经空了」的目录。
5. 若点「收进成品」，面板调 `/deliver`：Host 现扫一遍，把 `keep` 的文件 rename 进 `<工作区>/<deliverDir>/<会话标题>`（`deliverPerSession=false` 时少一层），重名加序号，搬空的新建目录顺手收掉。
6. 若点「删掉并收尾会话」，再 `/mark` 记账。
7. 之后某次启动 DSH，插件等 90 秒（避开启动高峰）读账本：闲置满 30 分钟的会话日志挪进 `_trash`，并同步 `workspace.json`。

---

## 清单是怎么组出来的

### 1. 解会话日志

会话日志 `session.v4.jsonl.zstd` 是**多帧串接的 zstd**，按 magic `28 B5 2F FD` 逐帧解；只解第一帧会丢正文。解出来的 JSON 记录里取 `deliverables/presented`、`tool/call`、时间戳、标题与工作目录。

### 2. 抓路径

- `deliverables/presented`：你点开过的东西，最可信。
- `tool/call` 参数：只看会写文件的工具（`write` `edit` `present` `office_*` `generate_image*` …）。
  - **绝对路径**直接收；
  - **相对路径**按会话工作目录 `resolve` 后再收——旧版只认绝对路径，这是「文件没检测出来」的头号原因。
- 去重、`lstat`、只留真实存在的；已经没了的记成 `skippedGone`，不回显成幽灵条目。

### 3. 兜底扫描

从会话工作目录出发，收「会话开始之后被改过或新建」的文件与文件夹：

- 时间同时看 `mtime` / `ctime` / `birthtime`：解压、复制保留了旧 `mtime` 的文件也能抓到；
- 文件夹也是条目：会话期间新建的目录即使里面是空壳，也会列出来；
- 新建文件夹里的内容整体算「这次产生的」（force），不再被单个文件的旧时间骗过去；
- 默认深度 12、最多 2000 个文件（`rules.json` 的 `sweep` 可调）；
- 跳过 `node_modules`、`.git`、`__pycache__`、`dist` 这类依赖/构建目录和点开头的隐藏目录，并在清单里报告跳过数量；
- **排除兄弟会话**：`otherSessionClaims(cwd, selfId)` 读同一个 `cwd` 下其他会话的日志，把它们 `collectFiles` 得到的精确路径收进 `claimed`，并把这些路径在工作区下的一级目录收进 `roots`；兜底扫描命中这两类就跳过，计入 `skippedOtherSessions`。本会话工具调用明确写过的路径优先，不受影响。可用 `rules.sweep.excludeOtherSessions: false` 关闭；
- 到上限时返回 `truncated: true`，面板顶部显示「可能还有没列出来的」，**不会假装扫全了**。

### 4. 分类

优先级（从高到低）：

1. 展示过 / 在交付目录里 / 成品后缀 → **交付物**，`keep=true`；
2. 临时目录 / 临时后缀 → **临时文件**；
3. 脚本后缀 → **中间脚本**；
4. 成品后缀 → **交付物**；
5. 文本/数据后缀 → **中间产物**；
6. 其余 → **其他**。

文件夹单独走 `classifyDir`：

- 里面有交付物 → `kind='文件夹'`、`keep=true`（面板里勾不动，整包删除被拒）；
- 里面有清单外的文件 → `defaultDelete=false`（默认不勾，让你先看一眼）；
- 空目录 → `defaultDelete=true`（默认勾，删完顺手收掉）。

### 5. 排序与编号

`交付物 → 文件夹 → 其他 → 中间产物 → 中间脚本 → 临时文件`，同组内文件夹在前、再按体积降序。编号 `idx` 只用于当次显示；**删除从不按编号，只按路径**。

---

## 六组与默认取舍

| 分组 | 判定 | 默认 |
| --- | --- | --- |
| 交付物 | 展示过 / 在 `deliverables` 类目录 / 成品后缀 | 保留 |
| 文件夹 | 会话期间新建的目录 | 勾选；含交付物时保留 |
| 其他 | 认不出 | 勾选 |
| 中间产物 | `.md` `.txt` `.json` 等 | 勾选 |
| 中间脚本 | `.py` `.js` `.ps1` 等 | 勾选 |
| 临时文件 | 临时目录 / `.tmp` `.log` 等 | 勾选 |

选择逻辑（`client.js`）：

- 每行一个 checkbox；
- 组头三态：`all / some / none`；
- 勾文件夹 → 递归勾上全部后代；勾/取消一个文件 → 回算所有上层文件夹的三态；
- 底部「恢复默认勾选 / 全选 / 全部取消」；
- 体积按**最外层选中项**求和，父子同时选中不重复计。

规则文件：包内 `rules.json` 是默认值；`$DSH_HOME/state/wrapup-rules.json` 存在时逐项覆盖（不必抄全文）。

---

## 删除：两阶段 + 四道闸

`lib/trash.mjs` 是唯一 rename 文件/目录的地方。

**两阶段**

1. `rename` 到 `$DSH_HOME/_trash/<ISO 时间戳>/wrapup/...`；
2. 3 天后 `purgeOldTrash` 才真正物理删。

回收站里的落点：`$DSH_HOME` 下的路径保留相对结构；其它盘符变成 `D_/...`，便于原样找回。同名冲突加 `~1`、`~2`。

**四道闸**

| 闸 | 规则 |
| --- | --- |
| 同源 | POST 的 `Origin` 必须等于自身 host，否则 403 |
| 工作区 | `$DSH_HOME` 下的一切扫描跳过、删除再拒 |
| 危险路径 | 工作区本身/上级、盘符根、`$DSH_HOME` 及其上级，一律拒绝 |
| 活会话 | 10 秒内写过拒绝记账；启动清理要求闲置满 30 分钟 |

补充：

- 文件夹里有交付物时扫描阶段已 `keep`，Host 收到路径会再拒一次并说明原因；就算文件夹本身没被标 `keep`，Host 也会检查它下面有没有交付物，有就拒绝整包删；
- 父子同时传入时只挪最外层，子项不会重复删；
- 删除后只清理**这次删除路径上**、且属于 `pruneCandidates`（本次会话新建的目录）的**已经空了**的目录。没有被勾选的新建空目录、以及用户原有的空文件夹都不会动。

---

## Host 路由

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/wrapup-panel/health` | 存活探针、版本、账本数量 |
| GET | `/wrapup-panel/scan?session=&sweep=0` | 清单 + `idleMs` + 是否已记账；`sweep=0` 关兜底 |
| GET | `/wrapup-panel/queue?session=` | 轮询用：闲置时长与记账状态 |
| POST | `/wrapup-panel/delete` | `{session, paths[]}` → 收进回收站 |
| POST | `/wrapup-panel/deliver` | `{session, dirName?}` → 把交付物收进 `<deliverDir>/<会话标题>` |
| POST | `/wrapup-panel/mark` | `{session, keep[], title}` 记账；10 秒内写过 → 409 |
| POST | `/wrapup-panel/unmark` | 撤销记账 |

错误一律 `{ok:false, error:"中文原因"}`；成功是 `{ok:true, data:{...}}`。

### `/deliver` 返回

```json
{
  "dest": "…/成品/季度报告",
  "dirName": "成品/季度报告",
  "apply": true,
  "moved": [{ "from": "…/a.png", "to": "…/成品/季度报告/a.png", "size": 1234 }],
  "skipped": [{ "path": "…", "why": "已经在成品文件夹里" }],
  "failed": [],
  "bytes": 1234,
  "pruned": ["…/搬空的子目录"]
}
```

归集只处理 `type==='file' && keep===true` 的条目；重名在扩展名前加 ` (n)`；目标目录必须在 `cwd` 内，否则直接报错。子文件夹名由 `sessionFolderName(title, sessionId)` 清洗：替换 Windows 非法字符、合并空白、最多 48 个字符、空标题回退 `session-xxxxxxxx`；标题相同会共用同一个子文件夹。

### `/delete` 返回

```json
{
  "deleted": 2,
  "deletedFiles": 1,
  "deletedFolders": 1,
  "pruned": ["…/空目录"],
  "bytes": 12345,
  "batch": "…/_trash/2026-…/wrapup",
  "missing": [],
  "refused": [{ "path": "…", "reason": "含 1 个交付物" }],
  "failed": []
}
```

`deleted` 是最外层条目数；`deletedFiles` / `deletedFolders` 是拆开后的数量；`bytes` 是递归体积。

---

## 常见故障先看哪儿

| 现象 | 先查 |
| --- | --- |
| 按钮不出现 | 页面刷新；旧插件是否还开着（两个按钮） |
| 扫描结果为空 | 会话 id 对不对；工作目录是否在 `$DSH_HOME` 下（会被排除） |
| 有文件没列出来 | 是否被 `maxDepth/maxFiles` 截断（看面板警告）；是否在点开头目录/依赖目录；是否早于会话开始 |
| 文件夹删不掉 | 是否 `keep`（内含交付物）；是否工作区本身/上级 |
| 删完目录还在 | 目录不是本次会话新建的（不在 `pruneCandidates`），按设计保留 |
| 记账后会话没消失 | 闲置未满 30 分钟；要等下次启动 DSH |
| 改完没生效 | `client.js` 刷新页面；`index.js`/`lib/` 重载插件或重启 |

---

## 测试

```bash
node --test test/core.test.mjs
```

覆盖：递归体积、父子去重、文件夹整包进回收站、只收这次动过且点名的空目录（没勾选的新建空目录不误删）、拒绝删工作区本身。

---

## 记错账了怎么办

面板上再点一次收尾 → 底部 **取消收尾**。或者命令行 `node bin/wrapup.mjs unmark`。

## 与 auto-clean 技能的关系

账本文件（`$DSH_HOME/state/wrapup-queue.json`）两边共用：auto-clean 若存在，也会读它，谁先跑都行，跑完会把条目划掉。**本插件不依赖 auto-clean**，单独装也能完成收尾。
