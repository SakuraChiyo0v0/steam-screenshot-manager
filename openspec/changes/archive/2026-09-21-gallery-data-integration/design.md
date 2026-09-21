## Context

UI 已完成并自带一套静态示例数据契约（`PreviewGame` / `PreviewShot`）。本变更要把它换成真实数据，同时不破坏已有交互、主题与响应式行为。

真实数据的能力边界已在 `docs/evidence/real-data-structure.md` 记录清楚，其中三条直接决定本设计：

1. VDF 索引**会漏图**（实测 6,073 张漏 3 张 VR 截图）→ 目录枚举必须为主、VDF 只能补元数据。
2. 真实离线数据**没有类型、英文名、封面**，也**没有"截图标题"**这个概念 → 这 4 个 UI 字段必须换语义。
3. 非 Steam 快捷方式的目录名是 64 位 gameID，名称只能从二进制 `shortcuts.vdf` 解析。

架构约束（`docs/architecture.md`）：渲染层不得直接访问文件系统；预览地址必须"由资产 ID 映射受管路径，禁止界面拼路径读取任意文件"（§7）；主进程是数据库唯一拥有者（§1）。

## Goals / Non-Goals

**Goals:**

- 用真实数据驱动现有 UI：游戏列表、相册、全部截图、查看器都读 SQLite 索引。
- 来源**全程只读**，索引不等于备份，界面不得出现"已备份/已校验"。
- 图片供给走 assetId，渲染层拿不到任何文件路径。
- 扫描有进度、可取消、失败可见，重复扫描不重复计数。
- 用 3,005 张真实原图验证并与既有哈希基准逐张对账。

**Non-Goals:**

- 不复制归档、不做本地 metadata 文件与崩溃对账（下一个变更）。
- 不做导出、WebDAV、同步中心。
- 不生成缩略图缓存（直接复用 Steam 的 `thumbnails`）。
- 不接商店接口，不伪造类型/英文名/官方封面。
- 不改 CSP 之外的任何安全配置；不放开 `sandbox`、`contextIsolation`。

## Decisions

### D1：本变更只建索引，不复制文件

索引阶段直接指向来源原文件（只读），不产生图库副本。这样 UI 能立刻拿到真实数据，而"归档"涉及复制、发布、对账与崩溃恢复，独立成一个变更更安全。

- 备选 A（已否决）：本变更同时归档。会让变更同时承担扫描与写入两个高风险面，且样本对账要等归档完成才能做。
- 代价：此时"本机可用"状态指的是来源文件存在，而不是图库副本存在。界面文案必须如实区分，不得显示"已备份"。

### D2：逻辑身份用 `(accountKey, gameKey, sha256)`，扫描时流式计算哈希

统计口径（`docs/product-plan.md` §4）要求按内容指纹去重，所以哈希必须在索引期完成，不能等到归档。

- 计算方式：`createReadStream` 分块喂 `crypto.createHash('sha256')`，用 `for await` 逐块处理，避免把大文件读入内存、也避免长时间占用事件循环。
- 性能取舍：3,005 张 / 1.66 GB 实测可接受；10 万张级别需要单独评估（本变更给出实测耗时，不预设结论）。
- 备选 B（已否决）：先用文件名占位、归档时再算哈希。会与统计口径冲突，且并发同名文件会算错。

### D3：文本 VDF 用 `@node-steam/vdf`，二进制 shortcuts.vdf 自写读取器

`@node-steam/vdf@2.2.0`（MIT）只导出 `parse(text)`，**不支持二进制 VDF**，所以：

- `libraryfolders.vdf`、`appmanifest_*.acf`、`screenshots.vdf` → 用库解析，不写正则。
- `shortcuts.vdf`（二进制）→ 自写小型读取器（类型字节 0x00 对象开始 / 0x01 字符串 / 0x02 int32 / 0x08 对象结束），只取 `appid`(4 字节小端) 与 `AppName`；gameID 按 `(storedAppid << 32) | 0x02000000` 换算。
- 依赖形态：`@node-steam/vdf` 放 **devDependencies**，由 electron-vite 打进主进程产物，运行时依赖保持为 0、产物内不出现 `node_modules`。

### D4：数据库 schema 迁移 v2

新增 5 张表（沿用 `docs/architecture.md` §4 的命名）：

| 表 | 关键字段 |
|---|---|
| `profiles` | `account_key` PK、`steam_account_id`、`steam_id64`、`display_name` |
| `games` | `game_key` PK、`app_id`、`kind`(`steam`/`non-steam`)、`name`、`name_source`、`installed` |
| `sources` | `source_id` PK、`root_path`、`kind`(`registry`/`manual`)、`created_at`、`last_scan_at`、`last_scan_status` |
| `assets` | `asset_id` PK、`account_key`、`game_key`、`sha256`、`bytes`、`ext`、`width`、`height`、`captured_at`、`capture_time_source`、**UNIQUE(account_key, game_key, sha256)** |
| `source_files` | `source_file_id` PK、`source_id`、`relative_path`、`size`、`mtime`、`asset_id`、`present`、**UNIQUE(source_id, relative_path)** |

`source_files.present` 是"来源文件当前是否存在"的可撤销状态；扫描不到不等于用户删除（`docs/sync-protocol.md` §10），本变更只更新状态、不删除任何行。

索引：`assets(game_key)`、`assets(account_key, game_key)`、`source_files(asset_id)`。

### D5：扫描任务与进度

- 扫描在**主进程**执行，任务状态持久化到 `jobs` 之外的轻量内存状态 + `sources.last_scan_status`；进度通过 IPC 事件 `scan:progress` 推送（阶段、已处理、总量、当前文件、错误计数）。
- 可取消：协作式取消标志，在文件之间检查；取消后保留已入库的部分（不回收）。
- 单文件失败（读取错误、哈希失败）只记录该文件并继续，不中断整批；扫描结束给出失败明细计数。
- 不伪造百分比：总量未知时字段为 `null`。

### D6：图片供给用自定义协议 `ssm-asset://`

- 注册为 `standard: true, secure: true` 的 scheme，供 `<img src>` 直接使用；URL 形式 `ssm-asset://asset/<assetId>` 与 `ssm-asset://thumb/<assetId>`。
- 处理流程：解析 assetId → 查 `source_files` 得到来源与相对路径 → 拼接后 `path.resolve` → 校验位于该 source 根之内（拒绝 `..`、绝对路径、跨界）→ 再校验文件存在 → 返回文件内容与 `Content-Type`。
- 路径**永不回传渲染层**：资产详情接口只返回展示用元数据（游戏名、文件名、大小、时间、尺寸），不含绝对路径。
- 缩略图优先取 Steam 的 `thumbnails` 同名文件，缺失时回退原图。
- CSP：`index.html` 的 `img-src` 需加入 `ssm-asset:`（当前只有 `'self' data:`）。

### D7：UI 字段映射（已与用户确认）

| UI 字段 | 真实来源 | 处理 |
|---|---|---|
| `genre`（类型筛选） | 离线无来源 | 改为**账号**与**安装状态（已安装／已卸载）**筛选 |
| `english`（副标题） | 无来源 | 显示 `steam-<AppID>`；非 Steam 显示 gameID |
| `title`（截图标题） | 无此概念 | 显示**原文件名**，并给出**拍摄时间来源**（`screenshots.vdf` / 文件时间 / 未知） |
| `cover` | 本机 Steam 封面缓存为空 | 用该游戏**最近一张真实截图**（列表内每款游戏必有截图，且 16:9 天然匹配） |
| `date` | `screenshots.vdf` 的 `creation` 或文件 mtime | 保留，但必须带来源标记；不可信时显示未知 |

### D8：幂等与重复扫描

- `assets` 按 `(account_key, game_key, sha256)` upsert；`source_files` 按 `(source_id, relative_path)` upsert。
- 同一资产被多个来源发现时保留多条 `source_files`，图片数仍按资产计一次。
- 重复扫描不产生重复计数；已存在的行只更新 `size`/`mtime`/`present`。

## Risks / Trade-offs

- [大库哈希耗时与 IO 压力] → 流式分块 + 进度可取消；实测耗时写入报告，不预先承诺规模指标。
- [网络来源根（UNC）慢或中断] → 单文件失败不中断整批；扫描状态记录为部分失败，界面如实显示；不把不可达当成"没有截图"。
- [`ssm-asset` 路径越界] → 每次请求都做 resolve + 根内校验，拒绝越界；对该边界写单元测试。
- [CSP 放开 `ssm-asset:`] → 只放开图片源，不放宽脚本与连接来源。
- [去掉生成封面素材后首屏观感变化] → 用真实截图作封面，并保持 16:9 容器与主题样式不变。
- [移除 `preview-data.ts` 会破坏浏览器预览 `pnpm dev:ui`] → 保留无 Electron 桥时的空态与提示，不再依赖静态样本。

## Migration Plan

- 部署：`pnpm dev` 后进入设置登记来源（或自动发现），执行扫描，图库即显示真实数据。
- 回滚：schema v2 为追加式迁移，旧库可继续被 v1 代码读取（新表未被使用时不影响）；脚本删除新表即可回到 v1 形态，不需要删库重建。
- 数据安全：全程不写来源；不新建图库目录；索引仅写应用数据目录下的 `app.sqlite3`。

## Open Questions

1. 手动来源根是否需要在界面里做"看起来像 Steam 根"的前置校验（含 `userdata` 或 `steamapps`）？本变更按宽松校验实现（可读 + 存在 `userdata` 目录），并在报告里说明。
2. 扫描是否需要限制并发（同时哈希的文件数）以避免机械盘抖动？本变更先按串行实现，把并发留到有实测数据后再定。
