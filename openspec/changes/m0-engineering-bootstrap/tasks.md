# 工程基础阶段 实施任务

验证方式写在每条任务里。涉及真实数据或真实服务的任务必须注明证据来源与挂账条件——工程基础阶段 除样本目录的**存在性**外不接触真实数据。

## 1. 工程与依赖

- [x] 1.1 用 pnpm 初始化项目，写 `package.json`（`private: true`、引擎与包管理器版本）。验证：`pnpm install` 退出码 0。
- [x] 1.2 安装并锁定 Electron 44.4.3、React 19.3.0、electron-vite 5.0.0、electron-builder 26.15.3、Vitest 5.0.1 与 TypeScript 7.0.2；只保留 `pnpm-lock.yaml` 一种锁文件。验证：仓库根只有一种锁文件。
- [x] 1.3 建立 TypeScript 配置（main/preload/renderer 分别适用）与 `electron.vite.config.ts`。验证：`pnpm typecheck` 退出码 0。
- [x] 1.4 建立 `src/{main,preload,renderer,shared,core}` 骨架与 `shared/` 下的 DTO、错误码模块（对齐 `docs/architecture.md` §7.1）。验证：目录结构与架构文档 §2 一致，类型可被三层共同引用。

## 2. SQLite 方案选型与持久化基础

- [x] 2.1 spike：在 Electron 主进程实测 `node:sqlite` 可用性。验证：自检报告 `sqliteDriver = "node:sqlite"`，`schemaVersion = 1`，写入读回成功。
- [x] 2.2 回退路径：**未触发**。`node:sqlite` 在 Electron 44.4.3 可用，因此不引入 `better-sqlite3` 与 `electron-rebuild`。验证：运行时依赖为 0 个。
- [x] 2.3 实现 schema 版本号（`PRAGMA user_version`）、顺序迁移框架与事务封装；建立最小自检表。验证：单元测试覆盖。
- [x] 2.4 单元测试：事务中途失败整体回滚；嵌套事务只回滚内层；迁移可重复执行不重复应用；迁移失败保留原库且不自动删库。验证：`pnpm test` 退出码 0（38 条用例）。
- [x] 2.5 打包产物中验证数据库读写与跨重启保留。验证：打包产物写入记录后累计行数递增、`deviceId` 不变。
- [x] 2.6 在 工程基础阶段 报告中记录实际选定的 SQLite 方案、版本、理由与实测命令。验证：`docs/implementation-reports/工程基础阶段.md` 第 1、6 节。

## 3. 进程边界与受限 IPC

- [x] 3.1 主进程创建窗口时启用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`，并加单实例锁。验证：重复启动不产生第二个工作实例。
- [x] 3.2 preload 仅用 `contextBridge` 暴露设计 D4 的白名单通道，不暴露 `ipcRenderer` 本身。验证：自检探测到 `apiMethods` 恰为 5 个白名单方法，且不存在通用 `invoke`。
- [x] 3.3 主进程为每个通道实现输入运行时校验与稳定错误码（含 `IPC_INVALID_INPUT`、`APP_INTERNAL`）。验证：单元测试覆盖非法参数与错误码契约。
- [x] 3.4 渲染层实现最小自检面板：显示应用版本、设备 ID、数据目录、图库根目录状态，并触发一次 `db:health` 写入读回。验证：dev 窗口可开且自检通过。
- [x] 3.5 边界测试：渲染层尝试 `require('node:fs')`、直接打开数据库、以及通过接口传白名单外路径。验证：`--self-check` 隐藏窗口探测得到 `requireType`/`processType` 为 `undefined`、`fsReachable` 为 `false`。

## 4. 数据位置、图库选择与设备 ID

- [x] 4.1 建立应用数据布局（`app.sqlite3`、`device.json`、`self-check.json`），全部位于 `app.getPath('userData')`。验证：运行后文件落在 `%APPDATA%\steam-screenshot-manager`，不在源码或安装目录。
- [x] 4.2 实现设备 ID 的生成、持久化与显式重置路径。验证：单元测试覆盖生成、重复读取、重置与非法内容处理；5 次运行 `deviceId` 保持不变。
- [x] 4.3 实现图库根目录选择与重叠校验（相同、互相嵌套、互为父子、受保护目录均拒绝），并持久化。验证：10 条单元测试覆盖；**实际目录选择对话框的人工点击验证未做**（见 工程基础阶段 报告第 7 节）。

## 5. 命令与文档

- [x] 5.1 定义 `dev`、`typecheck`、`test`、`build`、`self-check`、`package`、`package:dir` 脚本。验证：逐个执行，除完整安装器外退出码均为 0。
- [x] 5.2 在 README 写入真实可用的命令、环境要求、运行时事实与镜像说明，替换"没有可运行命令"的现状描述。验证：命令与 README 一致。

## 6. 打包验证与 工程基础阶段 报告

- [ ] 6.1 用 electron-builder 产出 Windows **安装包**：未完成。`--dir` 免安装产物已产出并验证；NSIS/便携安装器在应用目录打好后因网络请求 600 秒超时失败（见 工程基础阶段 报告第 7 节）。
- [x] 6.2 启动打包产物，验证窗口出现、数据库读写与开发运行一致、跨重启数据保留。验证：`packaged: true` 自检 + 窗口标题 `Steam 截图管理器`。
- [x] 6.3 检查打包产物与仓库内不含 WebDAV 凭据、令牌、真实截图样本与设备绝对来源路径。验证：产物内无 `.jpg/.png/.sqlite3/device.json`；`app.asar` 588 KB 且只含 `out/` 与 `package.json`；仓库源码目录无图片样本。
- [x] 6.4 按 `docs/implementation-plan.md` §3 模板写 `docs/implementation-reports/工程基础阶段.md`，逐项列出改动文件、实际命令与结果、未验证项、已知风险。
- [x] 6.5 结论层级自查：工程基础阶段 只声称到"隔离验证通过"，真实截图、真实 WebDAV、跨电脑仍挂账。验证：报告第 5 节分层表。

## 7. 收尾

- [x] 7.1 用 `openspec validate` 校验本次变更提案。验证：`Change 'm0-engineering-bootstrap' is valid`。
- [ ] 7.2 提交 工程基础阶段 改动（不推送、不创建远端），commit message 用中文 Conventional Commits。
