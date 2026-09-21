## Why

阶段 2 已经把截图复制进本机独立图库，但副本仍只在一台电脑上：系统盘损坏、误删或换机都会一起丢。产品需求 FR-08/FR-09 要求把图库单向备份到用户自己的 WebDAV，并在新电脑上恢复。

本阶段只做单向备份（本地 → 远端）。恢复与冲突处理放到下一阶段，避免在还没有可靠上传链路时就设计双向语义。

## What Changes

- **远端布局**（按 `docs/sync-protocol.md`）：`<根>/steam-gallery-v1/<libraryId>/`，含 `library.json`、`originals/<accountKey>/<gameKey>/<deviceId>/<uploadId>/<sha256>.<ext>` 与 `records/<deviceId>/<YYYY-MM>/<recordId>.json`。
- **设备独立、对象不可变**：每个设备只写自己的对象与记录，不共同维护一份索引；不依赖 MOVE/LOCK。
- **先对象后记录**：上传对象 → 读回并流式校验 SHA-256 → 通过后才发布不可变记录 → 再读回记录并逐字段校验。**任一步未通过都不允许标记"远端已校验"**。
- **断点续传**：中断后重跑先尝试读回已分配的对象/记录，判断上一次是否其实成功，再决定是否重传；重复执行不重复计数。
- **可重试与退避**：超时、断网、429（尊重 Retry-After）、5xx、507 归为可重试并按有上限的指数退避安排下次；401/403 立即暂停整轮，避免拿错误凭据空转。
- **凭据安全**：账号密码用 Electron safeStorage 加密后存用户数据目录，不写数据库明文、不进日志与诊断包；不可用时报错而不是明文回退。
- **兼容探测**：在远端新建的随机子目录里测试 MKCOL、PROPFIND(Depth:1)、PUT/GET、中文与空格文件名；返回登录页或非 WebDAV 响应时判为不兼容。
- **连接记录**：断开只删除本机凭据并保留连接记录，重连复用同一 remoteId，已备份历史不丢。
- **DB 迁移 v4**：`remotes`、`remote_objects`。
- **最小 UI**：设置页连接表单与能力测试结果；同步中心显示真实状态（全部/已备份/待备份/失败）与进度，可暂停、可重试失败项。

### 非目标

- 不做恢复、下载、冲突处理与删除传播（下一阶段）。
- 不做远端对象清理/保留策略：对象不可变，重复上传留下的旧对象由后续阶段的保留策略处理。
- 不做多远端并行与带宽限制。

## Capabilities

### New Capabilities

- `remote-backup`: 远端图库布局、对象上传与读回校验、记录发布与读回校验、断点续传、退避重试、连接与凭据管理。

### Modified Capabilities

- `desktop-shell`: 新增远端连接与上传的 IPC 通道、进度事件与输入校验。

## Impact

- **新增代码**：`src/core/sync/{webdav,credentials,library-remote,upload}.ts`、`src/main/sync-job.ts`、`src/main/verify-upload.ts`。
- **数据库**：迁移 v4（`remotes`、`remote_objects`），旧库可升级。
- **渲染层**：设置页远端存储改为真实表单与能力测试；同步中心从占位示例改为真实状态与操作。
- **验证**：本机隔离 WebDAV 测试服务（`docs/evidence/test-dav-server.mjs`）做真实 HTTP 端到端验证，含故障注入（限流、5xx、响应截断、只存一半、登录页、认证失败）。
- **不涉及**：来源只读、归档语义、导出规则。
