# asset-delivery Specification

## Purpose
TBD - created by archiving change gallery-data-integration. Update Purpose after archive.
## Requirements
### Requirement: 按资产 ID 供给图片

系统 MUST 通过自定义协议按资产 ID 提供图片，渲染层 MUST NOT 通过路径访问文件。

#### Scenario: 渲染层请求原图
- **WHEN** 页面用 `ssm-asset://asset/<assetId>` 请求图片
- **THEN** 主进程查库定位来源文件并返回内容，响应包含正确的图片类型

#### Scenario: 缩略图
- **WHEN** 页面用 `ssm-asset://thumb/<assetId>` 请求缩略图
- **THEN** 若来源存在同名缩略图则返回缩略图，否则回退返回原图

#### Scenario: 未知资产
- **WHEN** 请求一个不存在的 assetId
- **THEN** 返回未找到，不返回任何文件内容，也不泄露路径

### Requirement: 路径边界校验

系统 MUST 在每次图片请求时校验解析后的路径位于该来源根之内。

#### Scenario: 越界路径
- **WHEN** 数据库中记录的相对路径包含 `..`、绝对路径或指向来源根之外
- **THEN** 请求被拒绝，不返回文件内容

#### Scenario: 来源根之外的符号链接
- **WHEN** 解析后的真实路径落在来源根之外
- **THEN** 请求被拒绝并记录为异常

### Requirement: 渲染层不可拼接路径

系统 MUST NOT 向渲染层返回任何文件系统路径，MUST NOT 提供以路径为参数的取图接口。

#### Scenario: 查询接口返回内容
- **WHEN** 检查资产与游戏查询的返回结构
- **THEN** 只包含 assetId 与展示元数据，不含来源根或文件绝对路径

#### Scenario: 渲染层尝试用路径取图
- **WHEN** 渲染层构造含路径的 `ssm-asset` 地址
- **THEN** 该请求无法解析为有效资产并被拒绝

