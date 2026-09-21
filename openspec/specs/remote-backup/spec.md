# remote-backup Specification

## Purpose
TBD - created by archiving change webdav-backup. Update Purpose after archive.
## Requirements
### Requirement: 远端图库布局

系统 MUST 按 `<根>/steam-gallery-v1/<libraryId>/` 组织远端内容，包含 `library.json`、按设备与上传批次隔离的对象目录与按月分目录的记录。

#### Scenario: 新建远端图库
- **WHEN** 目标位置没有可用图库
- **THEN** 创建目录并写入 `library.json`（仅格式版本、库标识、创建时间），读回校验后才认为建库成功

#### Scenario: 加入已有图库
- **WHEN** 目标位置已存在格式版本匹配且库标识一致的图库
- **THEN** 加入该图库，不新建、不覆盖其描述文件

#### Scenario: 描述文件版本不匹配
- **WHEN** 读到的 `library.json` 格式版本不受支持
- **THEN** 拒绝加入并提示版本问题，不尝试写入

### Requirement: 对象上传与读回校验

系统 MUST 先上传对象、再读回并校验内容，MUST NOT 依赖服务端提供内容哈希，MUST NOT 使用 MOVE 或 LOCK。

#### Scenario: 上传后读回一致
- **WHEN** 对象上传完成并读回
- **THEN** 读回内容的 SHA-256 与字节数都与本地原件一致，才允许进入记录发布

#### Scenario: 远端内容被截断或只存一半
- **WHEN** 读回的对象与本地原件不一致
- **THEN** 标记为失败（指纹不一致），且该资产不得被标记为已备份

#### Scenario: 路径安全
- **WHEN** 生成远端路径时相对路径包含上级目录、绝对路径或空字节
- **THEN** 拒绝发起请求

### Requirement: 记录发布与读回校验

系统 MUST 在对象校验通过后发布不可变记录，并读回记录逐字段校验，通过后才标记"远端已校验"。

#### Scenario: 记录发布成功
- **WHEN** 记录写入并读回
- **THEN** 记录的 libraryId、recordId、objectKey、指纹与字节数都与本次上传一致，资产状态变为已校验

#### Scenario: 记录被改动或字段缺失
- **WHEN** 读回的记录字段与预期不符
- **THEN** 标记失败且不标记已校验

#### Scenario: 记录路径越界
- **WHEN** 记录中的 objectKey 不在本图库的 originals 之下或包含上级目录
- **THEN** 校验失败

### Requirement: 断点续传与幂等

系统 MUST 在重跑时先尝试读回已分配的对象与记录，避免重复传输；重复执行不重复计数。

#### Scenario: 中断在记录发布之前
- **WHEN** 交互中断后重新执行
- **THEN** 已读回校验通过的对象不再重传，直接继续发布记录

#### Scenario: 全部完成后重跑
- **WHEN** 所有资产都已校验后再次执行
- **THEN** 计划为空，不产生新的上传

### Requirement: 失败分类与退避

系统 MUST 区分可重试与不可重试错误，并为可重试错误安排有上限的退避；认证或权限失败时暂停整轮。

#### Scenario: 限流
- **WHEN** 远端返回 429
- **THEN** 该资产记为失败并安排下次重试，优先使用服务端给出的等待时间

#### Scenario: 认证失败
- **WHEN** 远端返回 401 或 403
- **THEN** 立即停止整轮上传并保留已完成成果，不继续重试

#### Scenario: 服务端错误
- **WHEN** 远端返回 5xx 或连接中断
- **THEN** 记为可重试失败并安排退避

### Requirement: 凭据安全

系统 MUST 使用系统加密存储保存远端凭据，MUST NOT 明文写入数据库、日志或诊断包。

#### Scenario: 保存凭据
- **WHEN** 用户连接远端
- **THEN** 密码写入系统加密存储，数据库只保存不可逆的凭据引用键

#### Scenario: 加密不可用
- **WHEN** 当前系统无法安全加密
- **THEN** 拒绝连接并说明原因，不回退为明文保存

#### Scenario: 断开连接
- **WHEN** 用户断开远端
- **THEN** 删除本机凭据并保留连接记录与已备份历史，重连后不重复上传

### Requirement: 兼容探测

系统 MUST 在远端新建的随机子目录里测试必要能力，并在返回网页内容时判为不兼容。

#### Scenario: 服务其实是登录页
- **WHEN** 探测请求收到 200 的 HTML 页面
- **THEN** 判定为非 WebDAV 服务并给出明确错误，不当作可用或空库

#### Scenario: 中文与空格文件名
- **WHEN** 探测写入带中文与空格的文件名
- **THEN** 读回一致才认为该能力可用

