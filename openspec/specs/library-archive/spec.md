# library-archive Specification

## Purpose
TBD - created by archiving change library-archive-export. Update Purpose after archive.
## Requirements
### Requirement: 复制原件进独立图库

系统 MUST 把索引中的资产从来源复制进用户选定的图库根目录，MUST NOT 修改、移动或删除来源文件。

#### Scenario: 首次归档
- **WHEN** 对已建立索引的资产执行归档
- **THEN** 原件出现在 `originals/<accountKey>/<gameKey>/<sha256>.<ext>`，并写入对应 `metadata/...json` 说明文件与 `local_copies` 记录

#### Scenario: 来源只读
- **WHEN** 归档前后比较来源目录
- **THEN** 来源文件的字节与修改时间不变，来源目录内没有任何新增文件

### Requirement: 复制后校验一致

系统 MUST 在复制过程中流式计算 SHA-256，并与索引指纹核对后才发布。

#### Scenario: 指纹不一致
- **WHEN** 复制得到的指纹与索引不符（来源被改动）
- **THEN** 该资产不发布、记为失败，`staging` 中不残留临时文件

#### Scenario: 目标已存在但内容不同
- **WHEN** 发布路径已被其他内容的文件占用
- **THEN** 拒绝覆盖、记为失败，已存在的文件保持不变

### Requirement: 增量与幂等

系统 MUST 只处理还没有受管副本的资产，重复执行不重复复制、不重复计数。

#### Scenario: 重复归档
- **WHEN** 对同一图库连续执行两次归档
- **THEN** 第二次的计划为空，副本数量不变

#### Scenario: 文件已发布但记录丢失
- **WHEN** 受管文件存在但 `local_copies` 记录缺失
- **THEN** 校验内容一致后补写记录，不重复复制

### Requirement: 中断可恢复

系统 MUST 支持协作式取消，取消后已完成的副本保留，重跑继续处理剩余项。

#### Scenario: 中途取消
- **WHEN** 归档进行到一半被取消
- **THEN** 已完成的副本与记录保留；再次执行时计划只包含剩余资产

### Requirement: 启动对账

系统 MUST 在启动时核对受管副本的存在状态，并清理未完成的临时文件。

#### Scenario: 受管副本丢失
- **WHEN** 图库中的受管文件被移走或删除
- **THEN** 对应记录标记为不存在，资产不因此被删除

#### Scenario: 清理临时文件
- **WHEN** 图库的 `staging` 下存在上次未完成的临时文件
- **THEN** 启动时清理，且不影响已发布的原件

