# local-persistence Specification

## Purpose
TBD - created by archiving change m0-engineering-bootstrap. Update Purpose after archive.
## Requirements
### Requirement: 应用数据与图库位置分离

应用设置、设备身份与任务数据库 MUST 存放于 Electron 用户数据目录；图库根目录 MUST 由用户选择且位于安装目录与源码目录之外。

#### Scenario: 首次启动确定数据位置

- **WHEN** 应用首次启动
- **THEN** 在用户数据目录下创建应用数据位置，且图库根目录处于"未选择"状态，不默认指向安装目录或源码目录

#### Scenario: 选择图库根目录

- **WHEN** 用户选择一个图库根目录
- **THEN** 该路径被持久化，且不把真实图片写入安装包目录或源码目录

#### Scenario: 图库与来源路径重叠

- **WHEN** 用户选择的图库根目录与已登记来源目录相同、互相嵌套或互为父子
- **THEN** 拒绝该选择并给出可理解的中文原因，不开始任何写入

### Requirement: 设备 ID

设备 ID MUST 在安装实例首次运行时生成并持久化，MUST NOT 硬编码在安装包内。

#### Scenario: 首次运行生成设备 ID

- **WHEN** 应用首次运行且本机不存在设备 ID
- **THEN** 生成新的随机设备 ID 并持久化到应用数据目录

#### Scenario: 重复启动保持同一设备 ID

- **WHEN** 应用在已有设备 ID 的机器上再次启动
- **THEN** 读回同一个设备 ID，不重新生成

#### Scenario: 应用数据目录被复制到另一实例

- **WHEN** 应用数据目录被整体复制并在另一实例启动
- **THEN** 提供重置设备 ID 的明确路径，避免两个实例共用同一写入命名空间

### Requirement: SQLite 选型与打包可用性

SQLite 方案 MUST 在开发运行与 Windows 打包产物中均可读写，MUST NOT 只验证开发脚本。

#### Scenario: 开发运行时读写数据库

- **WHEN** 通过 dev 命令启动应用并写入一条记录
- **THEN** 写入成功，重新读取可得到该记录

#### Scenario: 打包产物中读写数据库

- **WHEN** 启动 Windows 打包产物并写入一条记录
- **THEN** 写入成功，与开发运行行为一致，且不因缺少原生模块或 ASAR 内路径失败

#### Scenario: 数据跨重启保留

- **WHEN** 写入记录后完全退出应用并重新启动
- **THEN** 之前写入的记录仍可读回

### Requirement: 事务原子性

数据库写入 MUST 以事务提交，MUST NOT 在失败时留下半写状态。

#### Scenario: 事务中途失败

- **WHEN** 一个包含多条写入的事务在中途失败
- **THEN** 该事务的全部写入被回滚，数据库保持事务前状态

### Requirement: schema 版本化与迁移

数据库 MUST 带 schema 版本号，迁移 MUST 可重复执行且失败时保持原库可恢复。

#### Scenario: 从旧版本迁移

- **WHEN** 打开一个 schema 版本低于当前代码要求的数据库
- **THEN** 按顺序执行迁移并更新版本号，迁移后数据仍可读

#### Scenario: 迁移失败

- **WHEN** 迁移过程中失败
- **THEN** 保留原数据库文件、不自动删除数据库"重新开始"，并报告可理解的中文原因

#### Scenario: 重复执行迁移

- **WHEN** 对已是当前版本的数据库再次启动应用
- **THEN** 不重复执行已应用过的迁移，不报错

