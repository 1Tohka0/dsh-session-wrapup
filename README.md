# 会话收尾 · dsh-session-wrapup

给 DeepSeek Harness（DSH）加一颗「🧹 收尾」按钮：**把这次对话在工作区里产生的文件全摆出来，分好类、标好重要性，勾一下收进回收站；会话本身也能一起收尾。**

对话里让 AI 做一份 PPT，交付了 pptx，但工作区里还躺着抽页脚本、临时 txt、渲染出来的 png、中间 md、`__pycache__`。你要的从来不是「等 30 天自动清」，而是**东西交了，剩下的当场清掉，我看得见每一条是什么**。

---

## 它做三件事

1. **列清单** —— 从会话日志里还原「这次对话碰过的文件」，分五组，每条都写清为什么这么判。
2. **删文件** —— 勾选后收进 `$DSH_HOME/_trash/<时间戳>/wrapup/`，3 天后才物理消失。
3. **收尾会话** —— 把这个会话记进账本；它闲置满 30 分钟后，**下次启动 DSH** 时会话日志被收进回收站，`workspace.json` 同步摘掉。

清单里**没有**的东西：DSH 自己的数据（会话、附件、插件、运行时），以及插件自己的源码。

---

## 安装

DSH 的插件是「bundle」：一个带 `cordis.patch.yml` 的 npm 包。把仓库克隆到任意目录，然后让 DSH 装上它：

```
plugin_manager install_bundle   target = <本仓库的绝对路径>
```

装完在插件列表里能看到 **会话收尾**（entryId 形如 `include:dsh-session-wrapup`），图标是一把蓝扫帚。

也可以手动写进 `$DSH_HOME/profiles/<profile>/package.json` 的依赖：

```json
"dsh-session-wrapup": "link:D:/path/to/dsh-session-wrapup"
```

然后重启 DSH。**只依赖 Node 20+，没有第三方依赖，不需要构建。**

---

## 用

1. 会话标题右边点 **🧹 收尾**。
2. 弹窗列出五组：

   | 分组 | 含义 | 默认 |
   | --- | --- | --- |
   | 交付物 | 你展示过、在交付目录里、或是成品后缀 | **保留** |
   | 其他 | 认不出来的 | 勾选 |
   | 中间产物 | `.md` `.txt` `.json` 这类过程草稿 | 勾选 |
   | 中间脚本 | `.py` `.js` `.ps1` 这类临时脚本 | 勾选 |
   | 临时文件 | 临时目录 / `.tmp` `.log` 这些 | 勾选 |

3. 每行：`勾选框 · 大小 · 路径 · ← 为什么这么判`。
4. 底部：
   - **只删勾选的** —— 只删文件，会话留着。
   - **删掉并收尾会话** —— 删文件 + 记账，`30 分钟`后生效。
   - 记账之后再打开面板会多一个 **取消收尾**，随时反悔。
5. 这一轮还在输出时，按钮是灰的（「等这一轮说完…」），每 2.5 秒自己复查。

---

## 清单是怎么来的

不是猜的。会话日志 `$DSH_HOME/sessions/<工作区>/<会话>/session.v4.jsonl.zstd` 是**多帧串接的 zstd**，本插件按 magic 逐帧解，然后：

1. `deliverables/presented` 事件 → 你点开过的东西，最可信；
2. `tool/call` 参数里的绝对路径，只看会写文件的工具（`write` `edit` `present` `office_*` `generate_image*` …）；
3. 兜底：工作目录里「会话开始之后被改过」的文件（深度 4、最多 200 个），抓 `bash > file` 这类没有 `tool/call` 的产物。

**已经不在磁盘上的路径不会出现在清单里** —— 所以删完再打开不会看到幽灵条目。

---

## 改分类规则

默认规则在仓库的 `rules.json`（有中文注释）。**不要改仓库里的那份**，改你自己的：

`$DSH_HOME/state/wrapup-rules.json`，只写要覆盖的项，例如「`.ps1` 我要留」：

```json
{
  "scriptExt": [".py", ".js", ".mjs", ".ts", ".sh"]
}
```

保存后再点一次收尾就生效（每次扫描都会重读规则）。

---

## 命令行

同一个 `lib/`，所以命令行和界面行为完全一致：

```bash
node bin/wrapup.mjs scan                 # 打印清单（加 --json 给程序用）
node bin/wrapup.mjs delete --paths "a;b" # 按路径删（会先重扫一遍）
node bin/wrapup.mjs delete --all-deletable --dry   # 预览「建议删」的全部
node bin/wrapup.mjs mark --keep "a;b"    # 记账
node bin/wrapup.mjs unmark               # 撤销
node bin/wrapup.mjs status               # 账本里有什么
node bin/wrapup.mjs finish --dry         # 看看启动清理会删哪些会话
```

环境变量：`DSH_HOME`（必需）、`DSH_SESSION_ID`（默认会话）。
退出码：`2` 参数错、`3` 会话还在写 / 路径已失效。

---

## 文件地图

```
index.js          Host 半边：六条路由 + 校验，所有活都交给 lib/
client.js         浏览器半边：标题栏按钮与弹窗，免构建
lib/config.mjs    所有路径与阈值（想改「多久算还在写」看这里）
lib/artifacts.mjs 会话日志 → 文件集合（只读）
lib/classify.mjs  分类规则与加载/覆盖
lib/scan.mjs      组装清单（纯计算，无缓存）
lib/trash.mjs     两阶段删除，唯一会 rename 文件的地方
lib/queue.mjs     收尾账本 wrapper
lib/sessions.mjs  判活、删会话、同步 workspace.json、启动清理
bin/wrapup.mjs    命令行入口
rules.json        默认分类规则
```

**设计约束：Host、浏览器、命令行三者只共用 `lib/`，不各写一份逻辑。**

---

## 安全：三道闸

1. **同源** —— 只接受 `Origin` 与自身相同的 POST，别的网页不能遥控你删文件。
2. **只在工作区** —— `$DSH_HOME` 下面的一切在扫描时被排除，删除时再拒一次（`lib/trash.mjs`）。
3. **活着的会话不动** —— 面板 10 秒内写过就拒绝记账；启动清理要求**闲置满 30 分钟**才动手。这条是 2026-11-20 那次事故换来的，别调小。

另外：删除永远是「先 rename 进 `_trash`」，误点能捞。

---

## 升级 / 退版本

每次发布都打 tag，按语义化版本：

```bash
git tag            # 看装的是哪个版本
git checkout v1.0.0
```

插件是 link 安装的，改完源码：

- 改 `client.js` → **刷新页面**；
- 改 `index.js` / `lib/` → `plugin_manager set_plugin`（关一次开一次）或重启 DSH。

回滚到某个版本就是 `git checkout <tag>` 再刷新/重载，没有构建产物要清理。

---

## 常见问题

**按钮没出现** —— 页面刷新一次（client bundle 要重新拉）。旧版本插件没卸载就装新的，会出现两个按钮。

**点「删掉并收尾会话」，会话没马上消失** —— 设计如此：闲置满 30 分钟 + 下次启动 DSH 才删。想立刻看效果跑 `node bin/wrapup.mjs finish --dry`。

**清单里有文件但我明明删了** —— 重新打开面板即可（每次都是实时扫描）。

**工作区特别大，打开面板要等** —— 关掉兜底扫描：`{"sweep": {"enabled": false}}` 写进 `wrapup-rules.json`。

---

## License

MIT
