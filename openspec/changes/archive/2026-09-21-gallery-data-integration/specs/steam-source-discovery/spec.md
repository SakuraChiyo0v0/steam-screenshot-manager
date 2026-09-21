## ADDED Requirements

### Requirement: Steam 根目录发现

系统 MUST 通过 Windows 注册表与常见安装位置发现 Steam 根目录，MUST 支持多个根目录，MUST 允许用户手动添加根目录。

#### Scenario: 注册表发现
- **WHEN** 系统注册表中存在 Steam 安装路径且该目录可读
- **THEN** 该路径被列为已发现来源，并标记可用

#### Scenario: 注册表缺失或路径失效
- **WHEN** 注册表项不存在，或记录的路径已不存在
- **THEN** 不报错中断，手动选择根目录仍然可用，界面说明未自动发现

#### Scenario: 手动添加根目录
- **WHEN** 用户选择一个目录，且该目录下存在 `userdata` 子目录
- **THEN** 该目录被登记为来源并持久化，重复添加同一目录不产生重复来源

#### Scenario: 添加不像 Steam 根目录的路径
- **WHEN** 用户选择的目录下既没有 `userdata` 也没有 `steamapps`
- **THEN** 拒绝登记并给出中文原因，不写入数据库

### Requirement: 账号枚举

系统 MUST 枚举根目录下存在的全部 Steam 账号，MUST NOT 只取第一个账号。

#### Scenario: 多账号
- **WHEN** 根目录的 `userdata` 下存在多个账号目录
- **THEN** 全部账号被列出，并标注各自是否有截图目录

#### Scenario: 账号没有截图目录
- **WHEN** 某账号下不存在 `760` 目录
- **THEN** 该账号仍被列出并标记为无截图，不视为扫描失败

### Requirement: 来源可用性

系统 MUST 区分"来源不可达"与"来源没有截图"。

#### Scenario: 来源目录不可读
- **WHEN** 已登记来源的目录不存在或不可读
- **THEN** 该来源被标记为异常，扫描不把它当作空图库，也不更新任何"文件被删除"状态
