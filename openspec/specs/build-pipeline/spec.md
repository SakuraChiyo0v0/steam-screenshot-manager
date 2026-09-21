# build-pipeline Specification

## Purpose
TBD - created by archiving change m0-engineering-bootstrap. Update Purpose after archive.
## Requirements
### Requirement: 依赖锁定与包管理器

项目 MUST 使用单一包管理器并提交锁文件，MUST NOT 混用多个包管理器的锁文件。

#### Scenario: 干净环境安装

- **WHEN** 在无 node_modules 的环境按锁文件安装
- **THEN** 安装成功且版本与锁文件一致

#### Scenario: 只存在一种锁文件

- **WHEN** 检查仓库根目录
- **THEN** 只存在所选包管理器的锁文件，不存在其他包管理器的锁文件

### Requirement: 可运行命令集

项目 MUST 提供开发、类型检查、测试、构建与打包命令，且 README 中记录的命令 MUST 与实际可用命令一致。

#### Scenario: 各命令可运行

- **WHEN** 依次执行类型检查、测试、构建与打包命令
- **THEN** 每个命令以退出码 0 结束，无未处理错误

#### Scenario: 按 README 命令操作即可运行

- **WHEN** 按 README 记录的命令原样执行
- **THEN** 命令可用，不出现文档与实际不一致（如命令已改名或缺少前置步骤）

### Requirement: 打包产物可启动

Windows 打包产物 MUST 能启动并完成 工程基础阶段的出口验证，MUST NOT 只验证构建成功。

#### Scenario: 启动打包产物

- **WHEN** 运行 Windows 打包产物
- **THEN** 应用窗口正常出现，数据库读写与开发运行一致

#### Scenario: 产物不含凭据与真实图片

- **WHEN** 检查打包产物内容
- **THEN** 不包含 WebDAV 密码、访问令牌、真实截图样本或设备绝对来源路径

### Requirement: 测试基线

项目 MUST 提供可执行的最小自动化测试，覆盖 工程基础阶段 的进程边界与数据库行为。

#### Scenario: 运行测试

- **WHEN** 执行测试命令
- **THEN** 测试运行并报告结果；失败时以非零退出码结束

#### Scenario: 渲染层越权访问被测试覆盖

- **WHEN** 运行测试套件
- **THEN** 至少有一条用例验证渲染层无法直接访问文件系统或数据库

### Requirement: 解析依赖不进入运行时依赖

系统 MUST 保持运行时依赖为 0：VDF 解析库 MUST 作为 devDependency 由构建打进主进程产物，MUST NOT 要求产物内包含 node_modules。

#### Scenario: 打包产物内容
- **WHEN** 检查打包后的 `app.asar`
- **THEN** 只包含构建产物与 `package.json`，不存在 `node_modules` 目录

#### Scenario: 打包产物中解析可用
- **WHEN** 在打包产物中扫描一个包含 VDF 文件的来源
- **THEN** VDF 解析正常工作，不需要外部模块

### Requirement: 打包产物可完成真实扫描

系统 MUST 能在打包产物中完成索引扫描，MUST NOT 只在开发环境可用。

#### Scenario: 打包产物中执行扫描
- **WHEN** 在打包产物里对已登记来源执行扫描
- **THEN** 扫描成功完成并写入索引，结果与开发运行一致

