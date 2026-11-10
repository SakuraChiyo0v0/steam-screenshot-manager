# 交互重构：从"功能罗列"到"状态 + 下一步"

## 为什么

用起来最难受的不是某个 bug，是**结构**：61 个 IPC 通道、单文件 8.4 万字符的渲染层、
四个各写一套状态机的后台任务。结果就是：

- 要连远端，得自己手拼 `https://host/webdav/home/xxx/yyyy`，拼错只有 404；
- 想知道"还有没有活没干完"，得在三个页面之间找各自的进度条；
- 打开应用是三个并列空态，链条（来源 → 索引 → 图库 → 远端）要自己悟；
- 报错直接把 `DAV_PATH_INVALID` 糊在脸上。

## 这次做了什么

1. **远端目录浏览器**：`sync:browse` + `RemoteClient.listEntries`（WebDAV 解析 PROPFIND、文件夹读目录），
   连接前即可浏览；界面用模态框逐层点选。
2. **统一任务视图**：`src/main/jobs.ts` 把扫描/归档/备份/恢复收成 `JobSummaryDto[]` 与
   `jobs:list` / `jobs:cancel`；渲染层一个 `JobCenter` 组件展示与取消。
3. **首页清单**：`SetupChecklist` 按顺序列出四步，只高亮下一步。
4. **人话报错**：`shared/messages.ts` 把错误码映射成「是什么 + 怎么办」。

## 边界

- **不动**数据库 schema、sha256 去重、幂等归档、四段备份校验、恢复回滚与迁移。
- 各任务内部实现不改，只加一层统一视图。
- 渲染层仍是单个 `App.tsx`（下一步再拆页面），本次先把"最硌手"的四处修掉。

## 后续

- 把 `App.tsx` 拆成 `pages/`（图库/同步/设置/任务）与 `state/`（`use-library`、`use-remote`、`use-jobs`）。
- IPC 按语义收敛：`sync:*` / `library:*` 各自的细碎通道合并。
