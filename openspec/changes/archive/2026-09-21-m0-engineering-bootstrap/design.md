## Context

项目处于纯规划状态：`README.md` 与 `docs/` 六篇基线文档已完成，真实数据勘测也已完成（`docs/evidence/real-data-structure.md`），但仓库内**没有 `package.json`、没有代码、没有可运行命令**。实施计划 工程基础阶段 要求先立住工程基础，并把"打包后的 SQLite 是否可用""界面是否真无法任意读盘"这两个最大风险提前验证掉。

约束来自既有基线文档，本设计不重新决定它们：

- `docs/architecture.md` §1：Electron + TypeScript + 本地 SQLite，界面建议 React；只建一个桌面项目，不加服务端、微服务或多仓库。
- `docs/architecture.md` §2：`src/{main,preload,renderer,shared,core/*}` 目录分工；渲染层不被核心反向依赖。
- `docs/architecture.md` §8、§9：凭据与路径保护、单实例、退出落状态、产品数据放安装目录外。
- `docs/implementation-plan.md` 工程基础阶段：六项任务与出口判据；报告模板见其 §3。

## Goals / Non-Goals

**Goals:**

- 一个可 `dev` 运行、可 `package` 打包、数据库跨重启保留的 Electron + TypeScript + React 骨架。
- 用**实测结果**而非猜测选定 SQLite 方案，并在开发运行与 Windows 打包产物两种形态下都验证读写、事务与迁移。
- 建立渲染层无法绕过主进程访问文件系统与数据库的边界，并用测试覆盖这条边界。
- 建立应用数据位置、图库根目录选择与设备 ID 这三件后续所有里程碑都要用的基础设施。
- 把 `dev`/`typecheck`/`test`/`build`/`package` 写成 README 里可原样执行的命令。

**Non-Goals:**

- 不实现 Steam 发现、扫描、复制、哈希（离线采集与归档阶段）；不实现图库浏览与导出（桌面图库阶段）；不实现 WebDAV（WebDAV 上传阶段/新环境恢复阶段）；不实现托盘、补扫、限速（后台可靠性阶段）。
- 不设计数据库业务表（profiles/games/assets/jobs 等留到各自里程碑），工程基础阶段 只建立迁移框架与最小自检表。
- 不接触真实图库与任何远端；真实样本（`C:\LocalSpace\sample-data\steam-screenshot-manager`）在 工程基础阶段 仅作为"存在的测试数据"，不参与 工程基础阶段 验证。
- 不引入状态管理库、路由库、UI 组件库——工程基础阶段 的渲染层只需一个自检面板。

## Decisions

### D1：SQLite 方案——优先 Electron 内置 `node:sqlite`，不可用才回退原生模块

本机 Node 24.18.0 实测 `node:sqlite` 可用（建表、写入、查询通过）。若 Electron 44 内置的 Node 同样暴露该模块，则**零原生依赖**：不需要 `better-sqlite3`、不需要 `electron-rebuild`、不需要为 ASAR 配置 `asarUnpack`，工程基础阶段 最大的技术风险直接消失。

判定标准（spike 中执行，写入 工程基础阶段 报告）：在主进程 `import('node:sqlite')` 成功、`DatabaseSync` 能建表写入并跨重启读回、打包产物中同样成立。

- 备选 A（回退路径）：`better-sqlite3` 13.x + `electron-rebuild`，在 `electron-builder` 中配置 `asarUnpack`。
- 备选 B（已被否决）：在渲染层或独立 Node 侧车进程持有数据库。前者违反进程边界（架构 §1），后者在首版属过度设计。

### D2：构建工具链——electron-vite + electron-builder

选 `electron-vite` 5.x：原生处理 main/preload/renderer 三份构建、支持渲染层 HMR、与 Vite 生态一致，配置量最小。

- 备选 A：Electron Forge——模板与 maker 更完整，但配置更重，且本项目打包需求只有 Windows 一种形态。
- 备选 B：手写 Vite + tsc 多份配置——控制力最强但需要自己维护三套构建，收益不足。

打包选 `electron-builder` 26.x：Windows NSIS 与便携产物开箱可用。

### D3：TypeScript 版本以工具链实测兼容为准，不追最新

最新为 TypeScript 7.0.2（原生重写的大版本）。工程基础阶段 以"electron-vite 5 与 Vitest 实测能跑通"为准选择版本线；若不兼容则回退到 5.x 最新。**实际选定版本与理由必须写进 工程基础阶段 报告**，不允许以"最新"为由引入未验证风险。

### D4：进程边界与 IPC 契约

`BrowserWindow` 采用：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`。preload 只用 `contextBridge` 暴露一个白名单对象，不暴露 `ipcRenderer` 本身、不暴露任何路径拼接能力。

工程基础阶段 通道清单（后续里程碑按同一约定扩展，新增通道必须同时加入白名单与输入校验）：

| 通道 | 方向 | 用途 |
|---|---|---|
| `app:getInfo` | 渲染层 → 主进程 | 应用版本、平台、数据目录、设备 ID、图库根目录状态 |
| `settings:get` / `settings:update` | 双向 | 本机偏好读写（工程基础阶段 只含自动收集等占位项） |
| `library:pickRoot` | 渲染层 → 主进程 | 打开目录选择并做重叠校验 |
| `db:health` | 渲染层 → 主进程 | 启动自检：写入并读回一条记录 |

统一返回 `{ ok: true, data }` 或 `{ ok: false, code, message }`；`code` 取 `docs/architecture.md` §7.1 的稳定错误码，工程基础阶段 至少实现 `LIB_PATH_INVALID`、`LIB_DISK_FULL`、`LIB_DB_CORRUPT` 与一个通用 `IPC_INVALID_INPUT`。界面文案由 code 映射，不解析 message。

### D5：应用数据布局与设备 ID 存放位置

- 应用数据目录：`app.getPath('userData')`，下含 `app.sqlite3`（数据库）、`device.json`（设备 ID）、`logs/`（脱敏日志）。
- 图库根目录：用户选择，持久化在数据库 `settings` 表；不得默认指向安装目录或源码目录。
- **设备 ID 单独放 `device.json` 而不是数据库**：目的是让"复制应用数据目录到另一实例后重置设备 ID"变成一次显式删除文件的操作，而不必写数据库迁移。

### D6：迁移策略——`PRAGMA user_version` + 顺序迁移数组，失败保留原库

迁移实现为有序数组，每项带版本号与事务包裹；启动时比较 `user_version` 顺序执行未应用项，全部成功后统一提交版本号。迁移失败时**不删除、不重建**数据库，报告 `LIB_DB_CORRUPT` 并保留原文件可恢复（`docs/architecture.md` §4 要求）。

### D7：测试框架——Vitest

与 Vite 同生态、配置成本最低。测试分两类：纯 Node 环境的单元测试（迁移、事务、输入校验）与需要 Electron 运行时的边界测试。若 Electron 运行时测试成本过高，工程基础阶段 允许先用"在渲染层执行越权访问并断言失败"的手工验证 + 脚本化证据，但必须在报告中明确标注为手工证据而非自动化用例。

## Risks / Trade-offs

- [`node:sqlite` 在 Electron 44 不可用] → 立即切到 D1 备选 A；spike 在写业务代码之前完成，返工面为零。
- [TypeScript 7.x 与 electron-vite 5 / Vitest 不兼容] → 按 D3 回退 5.x，报告记录实际版本。
- [`sandbox: true` 限制 preload 能力] → preload 只做 `contextBridge` 与 `ipcRenderer.invoke`，实测可行；若确有必要放宽，必须在报告中列为**偏离架构 §1 的偏差**并说明补偿措施，不得静默关闭隔离。
- [首次安装与打包需要下载 Electron 二进制、NSIS、winCodeSign] → 网络慢时耗时明显；分步执行并记录实际耗时，不把下载失败当成代码问题。
- [打包产物中数据库路径落进 ASAR 或只读目录] → 数据库固定放 `userData`，绝不写入 ASAR 内路径；打包后必须实测写入与跨重启保留。
- [工程基础阶段 引入过多抽象] → 明确 Non-Goals：不设计业务表、不引入状态管理与 UI 库，`core/` 下只放 工程基础阶段 真正用到的模块，其余留空目录或干脆不建。

## Migration Plan

新项目，无存量数据需要迁移。

- 部署：本机 `pnpm install` 后 `pnpm dev` 即可运行；打包产物为 Windows 安装包与便携版。
- 回滚：工程基础阶段 的全部产物集中在 `src/`、`package.json`、构建配置、`openspec/`、`.codex/` 与 README 命令段。若 工程基础阶段 需要回滚，删除这些新增文件即可回到纯规划状态；`docs/` 既有基线文档不因 工程基础阶段 改变语义。

## Open Questions

1. Electron 44 内置 Node 是否暴露 `node:sqlite`——由 D1 的 spike 回答，是本设计唯一未决的技术前提。
2. TypeScript 版本线最终锁定在 7.x 还是 5.x——由 D3 的实测回答。
3. 工程基础阶段 是否需要把 Electron 运行时边界测试纳入自动化（D7 的取舍）——取决于 `@electron/…` 测试方案的实际成本，工程基础阶段 报告中给出结论与后续建议。
