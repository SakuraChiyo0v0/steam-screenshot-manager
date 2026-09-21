## Why

阶段 2–4 把「收进独立图库 → 备份到 WebDAV → 换电脑恢复」这条链路走通了，但日常使用仍然要人一直手动点：每次开机要自己想起来扫描、归档、备份；关掉窗口就完全停摆；图库大了以后相册网格要解码 4K 原图，滚动会卡。

阶段 5 的目标是**日常不用反复手动操作**，并且让大图库浏览不卡。

## What Changes

- **后台自动收集**：按设置的间隔（默认 60 分钟）自动执行「增量扫描 → 归档 →（可选）上传」。启动后延迟 2 分钟跑第一轮；已有任务在跑时跳过本轮，不排队、不叠加；单步失败只记录不打断。设置页可开关、可调间隔、可开启"收集后自动备份"。
- **预览缓存**：为图库资产生成 800px JPEG（`cache/previews/<sha256>.jpg`，用 Electron 内置 nativeImage，零新增依赖）。相册网格改用缩略图通道，取值顺序为「自建预览 → Steam 缩略图 → 原图」；缺预览时立即回退可用图像，同时在后台按 25 张/秒的限速补齐（nativeImage 解码是同步的，不能在请求里直接生成，否则会卡住界面）。
- **系统托盘**：托盘菜单显示当前状态（空闲 / 正在扫描 / 正在归档 / 正在备份 / 上次自动收集结果），可显示主窗口、立即收集、退出；左键点击显示或隐藏窗口。
- **启动设置**：关闭窗口留在托盘（任务继续跑）、开机自动启动（`app.setLoginItemSettings`，随设置即时生效）。
- **应用图标**：用零依赖脚本生成 `build/icon.png`（打包图标）与 `build/tray.png`（托盘），不再使用 Electron 默认图标。
- **设置项**：`autoCollectIntervalMinutes`、`autoBackup`、`closeToTray`、`launchAtLogin`（`autoCollect` 沿用），带运行时校验与默认值。

### 非目标

- 不做增量历史版本、不做多图库并行。
- 不做自动更新检查（没有更新服务）。
- 不做批量删除（破坏性操作需要单独设计，本地删除不会传播到远端）。
- 不做后台线程池：预览生成仍在主进程内限速执行。

## Capabilities

### New Capabilities

- `background-collection`: 按间隔自动增量扫描、归档与可选上传，含跳过与容错规则。
- `preview-cache`: 预览生成、取值顺序、后台限速补齐与缓存统计。
- `tray-and-startup`: 托盘菜单与状态显示、关闭到托盘、开机自启。

### Modified Capabilities

- `library-query`：相册网格改用缩略图通道（预览优先）。
- `desktop-shell`：设置项扩展与预览缓存统计通道。

## Impact

- **新增代码**：`src/core/library/previews.ts`、`src/main/preview-queue.ts`、`src/main/auto-collect.ts`、`src/main/tray.ts`、`src/main/build-previews.ts`、`scripts/make-icons.mjs`。
- **数据库**：不需要新表；`settings` 表新增若干键。
- **渲染层**：设置页新增"日常使用"区块（开关 + 间隔 + 预览缓存统计）。
- **打包**：`win.icon` 与应用图标；托盘图标通过 `extraResources` 随包携带。
- **验证**：对 2,919 张图库批量生成预览并对比体积；真实窗口确认托盘创建、设置开关往返、网格请求走预览通道。
