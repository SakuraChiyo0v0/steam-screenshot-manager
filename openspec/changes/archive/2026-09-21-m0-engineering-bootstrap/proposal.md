## Why

规划基线（README、docs/ 六篇文档）已于 2026-09-20 完成，真实数据也已完成勘测：生活机上有 2 个账号、48 组游戏目录、6,079 张真实原图（3.32 GB），已逐张固化 SHA-256 基准（见 `docs/evidence/real-data-structure.md`）。项目目前**没有任何程序代码、依赖或可运行命令**，实施计划 工程基础阶段 的全部任务尚未开始。

工程基础阶段 的作用不是产出可用功能，而是**先把工程基础立住，并把最大的技术风险提前打掉**：Electron 打包后的 SQLite 是否真的能读写、界面是否真的无法任意访问硬盘。这两件事如果拖到 离线采集与归档阶段 之后才发现问题，返工成本会落在已经写好的采集与归档代码上。

## What Changes

- 初始化单个 pnpm + Electron + TypeScript + React 项目（不加服务端、不加多仓库），并按 `docs/architecture.md` 第 2 节建立 `src/{main,preload,renderer,shared,core}` 目录。
- 建立主进程 / 预加载 / 渲染层边界：上下文隔离开启、渲染层关闭 Node 集成、IPC 只暴露白名单功能接口，禁止通用任意文件读写与任意命令执行；单实例运行。
- **实测选定 SQLite 方案**：优先验证 Electron 内置 Node 的 `node:sqlite`（本机 Node 24 已实测可用），可用则零原生模块；不可用则回退 `better-sqlite3` + 重新编译。选定后验证开发运行与 **Windows 打包产物**下的数据库读写、事务与 schema 迁移。
- 建立应用数据位置（Electron 用户数据目录）、图库根目录选择流程与首次运行生成的设备 ID。
- 跑通 `dev` / `typecheck` / `test` / `build` / `package` 命令，并用**真实可用命令**替换 README 中"没有可运行命令"的现状。
- 按 `docs/implementation-plan.md` 第 3 节模板产出 `docs/implementation-reports/工程基础阶段.md`。

### 非目标（本次变更明确不做）

- 不做 Steam 扫描、截图复制、哈希归档（离线采集与归档阶段）；不做图库浏览与导出（桌面图库阶段）；不做 WebDAV（WebDAV 上传阶段/新环境恢复阶段）；不做托盘、自动补扫、限速（后台可靠性阶段）。
- 不实现任何 Steam 数据写回；工程基础阶段 不接触真实图库与远端，样本仅用于隔离测试。
- 不扩大首版范围：录像与剪辑、存档、跨端永久删除、多用户服务、NAS 网页图库仍为范围外（README「首版边界」、`docs/product-plan.md` 第 7 节）。
- 不创建远端仓库、不推送、不部署。

## Capabilities

### New Capabilities

- `desktop-shell`: 桌面应用外壳与受限进程边界——单实例、主进程/预加载/渲染层职责划分、IPC 白名单与输入校验、渲染层无法直接访问文件系统与数据库。
- `local-persistence`: 本机持久化基础——应用数据位置与图库根目录、设备 ID 的生成与持久化、SQLite 选型与 schema 版本化迁移、数据库在开发运行与打包产物中均可读写且跨重启保留。
- `build-pipeline`: 开发与交付流水线——依赖锁定与包管理器、`dev`/`typecheck`/`test`/`build`/`package` 命令、Windows 打包产物可启动，且产物不含凭据与真实图片。

### Modified Capabilities

无。项目此前没有任何 spec（`openspec/specs/` 为空），本次是首批能力定义。

## Impact

- **新增代码**：`src/main`、`src/preload`、`src/renderer`、`src/shared`、`src/core` 骨架；`package.json`、TypeScript 与构建配置；最小测试。
- **新增依赖**：Electron 44.x、React 19.x、TypeScript、electron-vite、electron-builder，以及选定后的 SQLite 方案。版本在 工程基础阶段 中实测后锁定。
- **新增流程**：`openspec/`（schema: spec-driven）与 `.codex/` 指令文件；后续所有变更走 OpenSpec 提案。
- **文档**：README 增加真实可用命令；新增 `docs/implementation-reports/工程基础阶段.md`。
- **不影响**：`docs/` 现有规划基线的范围与数据保护规则；不同步协议、不涉及任何远端写入。
- **风险**：首次安装 Electron 需下载约 100 MB 二进制，打包还需下载 NSIS/winCodeSign，网络慢时耗时明显；TypeScript 7.x 较新，若与 electron-vite 5 工具链不兼容将回退 5.x 并在报告中说明。
