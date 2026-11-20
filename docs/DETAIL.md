# 会话收尾 · 详细说明

## 它解决什么

一次对话结束，工作区里往往不只是那张交付的相片 / PPT / 表格：还有抽页脚本、临时 txt、渲染出的 png、中间 md、`__pycache__`。手动翻目录既慢又容易删错；等保留期自动清又不知道到底会清掉什么。

这个插件把「这次对话碰过哪些文件」摆在你面前，**分类 + 说明理由 + 让你勾**，然后才动手。会话本身也能一起收尾。

## 一次收尾的流程

1. 点标题栏的 **🧹 收尾**。
2. 面板向 Host 请求 `/wrapup-panel/scan?session=<id>`，Host 读会话日志、组装清单。
3. 你勾选 → 面板把**路径**发回 `/delete`。
4. Host **重新扫描一遍**，按路径匹配后 rename 进 `_trash/<时间戳>/wrapup/`。
5. 若点「删掉并收尾会话」，再 `/mark` 记账。
6. 之后某次启动 DSH，插件等 90 秒（避开启动高峰）读账本：闲置满 30 分钟的会话日志挪进 `_trash`，并同步 `workspace.json`。

## 清单的三个来源

| 顺序 | 来源 | 说明 |
| --- | --- | --- |
| 1 | `deliverables/presented` | AI 明确交付、你点开过的东西，最可信 |
| 2 | `tool/call` 参数 | 只看写文件的工具：`write` `edit` `present` `office_*` `generate_image*` |
| 3 | 兜底扫描 | 会话开始后工作目录里被改过的文件（深度 4，最多 200） |

会话日志是多帧串接的 zstd，按 magic `28 B5 2F FD` 逐帧解；只解第一帧会丢正文。

不在磁盘上的路径会被剔除，所以清单永远是「此刻真实存在」的文件。

## 五组与默认取舍

| 分组 | 判定 | 默认 |
| --- | --- | --- |
| 交付物 | 展示过 / 在 `deliverables` 类目录 / 成品后缀 | 保留 |
| 其他 | 认不出 | 勾选 |
| 中间产物 | `.md` `.txt` `.json` 等 | 勾选 |
| 中间脚本 | `.py` `.js` `.ps1` 等 | 勾选 |
| 临时文件 | 临时目录 / `.tmp` `.log` 等 | 勾选 |

规则文件：包内 `rules.json` 是默认值；`$DSH_HOME/state/wrapup-rules.json` 存在时逐项覆盖（不必抄全文）。

## Host 路由

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/wrapup-panel/health` | 存活探针、版本、账本数量 |
| GET | `/wrapup-panel/scan?session=` | 清单 + `idleMs` + 是否已记账 |
| GET | `/wrapup-panel/queue?session=` | 轮询用：闲置时长与记账状态 |
| POST | `/wrapup-panel/delete` | `{session, paths[]}` → 收进回收站 |
| POST | `/wrapup-panel/mark` | `{session, keep[], title}` 记账；10 秒内写过 → 409 |
| POST | `/wrapup-panel/unmark` | 撤销记账 |

错误一律 `{ok:false, error:"中文原因"}`；成功是 `{ok:true, data:{...}}`。

## 安全边界

- **同源**：`Origin` 必须是自身，跨源 POST 403。
- **只在工作区**：`$DSH_HOME` 下的一切扫描时跳过，删除时再拒一次。
- **活着的会话不动**：面板 10 秒内写过拒绝记账；启动清理要求闲置满 30 分钟。
- **会话 id 形状校验**：`^session-[0-9a-f-]{8,}$`，挡路径穿越。
- **两阶段删除**：先 rename 进 `_trash`，3 天后才物理删。

## 记错账了怎么办

面板上再点一次收尾 → 底部 **取消收尾**。或者命令行 `node bin/wrapup.mjs unmark`。

## 与 auto-clean 技能的关系

账本文件（`$DSH_HOME/state/wrapup-queue.json`）两边共用：auto-clean 若存在，也会读它，谁先跑都行，跑完会把条目划掉。**本插件不依赖 auto-clean**，单独装也能完成收尾。
