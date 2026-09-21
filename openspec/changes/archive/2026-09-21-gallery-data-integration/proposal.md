## Why

渲染层 UI 已完成（`openspec/changes/ui-gallery-preview`），但它读的是 `src/renderer/src/preview-data.ts` 里的静态示例：6 款虚构游戏、8 张生成素材。整个应用目前看不到任何真实截图——Steam 扫描、索引与图库查询都还不存在。

真实数据已经就位并且可离线使用：本机仓库外有生活机的真实 Steam 数据子集（3,005 张原图 / 1,659 MB，含完整 `screenshots.vdf`、`shortcuts.vdf` 与 78 个 `appmanifest`），逐张 SHA-256 基准在 `docs/evidence/sample-baseline.csv`。本变更把 UI 接到真实数据上。

按 `docs/design/ui-handoff.md` 的「后续业务接入顺序」，这对应步骤 1 与步骤 2（来源发现、索引、缩略图查询，以及把 UI 数据源换成受限通信接口）。

## What Changes

- **来源发现**：Windows 注册表 `HKCU\Software\Valve\Steam` 的安装路径、常见安装位置，以及用户手动选择的根目录；枚举根目录下全部 Steam 账号，不擅自只取第一个账号。
- **元数据解析**：用 `@node-steam/vdf` 解析 `libraryfolders.vdf`（含 `apps` 子表）、`appmanifest_*.acf` 与 `screenshots.vdf`；二进制 `shortcuts.vdf` 用自写的小型读取器解析，用于非 Steam 快捷方式的名称与 gameID（`gameID = (storedAppid << 32) | 0x02000000`）。
- **扫描与索引**：以目录枚举为主、VDF 为辅（实测 VDF 会漏 VR 截图），枚举 `<Steam>\userdata\<AccountID>\760\remote\<gameKey>\screenshots\` 下的原图，**排除 `thumbnails`**；流式读取计算 SHA-256；写入 SQLite 索引表（`profiles`、`games`、`sources`、`assets`、`source_files`，schema 迁移 v2）。**本变更不复制、不移动、不修改任何来源文件**——归档属于后续变更。
- **受限 IPC**：新增来源发现/登记/扫描与图库查询通道，全部走现有白名单与运行时校验；扫描进度通过事件推送给渲染层，不轮询。
- **安全图片供给**：注册自定义协议 `ssm-asset://`，渲染层只能按 assetId 取图；主进程查库得到受管路径并校验其位于允许的来源根之内，渲染层永远拿不到文件系统路径拼接能力。
- **渲染层接入**：`preview-data.ts` 换成真实查询；保留现有布局、主题与交互；补齐加载中、空库、扫描失败、原图缺失状态。
- **UI 字段按已确认映射改造**（真实离线数据填不上的四个字段）：
  - 类型筛选 `genre` → 改为**账号**与**安装状态（已安装／已卸载）**筛选；
  - 副标题 `english` → `steam-<AppID>`（非 Steam 为 gameID）；
  - 截图标题 `title` → **原文件名 + 拍摄时间来源**（截图索引／文件时间／未知），不再伪造标题；
  - 游戏封面 `cover` → 该游戏**最近一张真实截图**（列表内每款游戏必然有截图，且真实截图本就是 16:9）。

### 非目标

- 不做归档复制、SHA-256 校验发布、本地 metadata 文件与崩溃对账（下一个变更）。
- 不做导出、WebDAV、同步中心、托盘、自动补扫与限速。
- 不接 Steam 商店接口：**类型/英文名/官方封面仍然没有来源**，不伪造。
- 不生成缩略图缓存：索引阶段直接使用 Steam 自带的 `thumbnails`，它们是只读来源文件。
- 不修改数据保护规则：来源仍然只读，索引不构成备份，界面不得显示"已备份/已校验"。

## Capabilities

### New Capabilities

- `steam-source-discovery`: Steam 根目录与账号的发现、手动根目录登记、来源可用性判定。
- `steam-metadata-parsing`: 文本 VDF/ACF 与二进制 shortcuts.vdf 的解析，含字段缺失与解析失败容错、非 Steam gameID 换算。
- `library-indexing`: 截图枚举与 SHA-256 索引入库；逻辑身份 `(accountKey, gameKey, sha256)`；缩略图不计入原件；扫描进度与失败可见。
- `library-query`: 游戏列表统计（数量、体积、最新时间、封面资产）、按游戏/账号/安装状态的资产分页查询与筛选排序。
- `asset-delivery`: `ssm-asset://` 协议的 assetId 映射与路径边界校验，为渲染层提供原图与缩略图，绝不暴露文件系统路径。

### Modified Capabilities

- `desktop-shell`: IPC 白名单扩展（新增来源与图库通道、扫描进度事件），并注册自定义协议处理器；安全基线不变。
- `build-pipeline`: 运行时仍然不引入 `node_modules` 依赖——`@node-steam/vdf` 作为 devDependency 由构建工具打进主进程产物。

## Impact

- **新增代码**：`src/core/steam/`（discovery、vdf、shortcuts、scanner）、`src/core/library/`（index、queries、assets）；`src/main/` 新增协议注册与来源/扫描/图库 IPC。
- **数据库**：schema 迁移 v2（新增 5 张表）。迁移失败仍保留原库。
- **渲染层**：`App.tsx`、`Viewer.tsx` 数据源与筛选维度改造；新增加载/空/失败/缺失状态；`preview-data.ts` 与生成的封面素材将被移除。
- **新增依赖**：`@node-steam/vdf@2.2.0`（MIT，devDependency，无原生模块，会被打进主进程 bundle）。
- **IPC 契约**：新增通道与事件，`docs/architecture.md` §7.1 的错误码表按需追加。
- **验证**：用 `C:\LocalSpace\sample-data\steam-screenshot-manager` 作为手动来源根扫描，与 `docs/evidence/sample-baseline.csv` 逐张对账；真实 Steam 目录全程只读。
- **不影响**：同步协议、远端存储、数据保护语义。
