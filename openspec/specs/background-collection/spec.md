# background-collection Specification

## Purpose
TBD - created by archiving change daily-use-polish. Update Purpose after archive.
## Requirements
### Requirement: 后台自动收集

系统 MUST 在开启后按设定间隔自动执行增量扫描与归档，MUST NOT 在已有任务运行时叠加执行。

#### Scenario: 定时触发
- **WHEN** 到达设定的间隔且当前没有扫描/归档/备份任务在跑
- **THEN** 依次执行增量扫描、归档，并在开启时执行上传

#### Scenario: 已有任务在跑
- **WHEN** 本轮触发时已有同类任务在执行
- **THEN** 跳过本轮并记录原因，不排队、不叠加

#### Scenario: 关闭自动收集
- **WHEN** 设置为关闭
- **THEN** 不启动定时器，也不执行任何后台收集

#### Scenario: 单步失败
- **WHEN** 某一步（例如某个来源扫描失败）出错
- **THEN** 记录该步失败并继续后续步骤，不打断用户操作

#### Scenario: 没有登记来源
- **WHEN** 一个来源都没有登记
- **THEN** 本轮直接结束并记录"没有登记来源"，不做无意义的重试

