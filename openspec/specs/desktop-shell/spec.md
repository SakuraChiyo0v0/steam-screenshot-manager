# desktop-shell Specification

## Purpose
TBD - created by archiving change m0-engineering-bootstrap. Update Purpose after archive.
## Requirements
### Requirement: 单实例运行

应用 MUST 同一时刻只允许一个运行实例；重复启动 MUST 不产生第二个独立工作实例。

#### Scenario: 重复启动

- **WHEN** 应用已在运行时再次启动
- **THEN** 不创建第二个工作实例，已有实例被聚焦或被前置，且新进程以退出码 0 结束

#### Scenario: 实例锁获取失败但已有实例已退出

- **WHEN** 上次异常退出遗留锁、当前没有存活实例
- **THEN** 应用正常启动，不因残留锁永久拒绝启动

### Requirement: 受限进程边界

渲染层 MUST 开启上下文隔离并关闭 Node 集成，MUST NOT 直接访问文件系统、数据库或凭据。

#### Scenario: 渲染层尝试直接访问文件系统

- **WHEN** 渲染层代码尝试 `require('node:fs')`、访问 `process` 或读取任意路径
- **THEN** 该访问不可用或被拒绝，应用不崩溃

#### Scenario: 渲染层尝试直接打开数据库

- **WHEN** 渲染层代码尝试直接打开 SQLite 数据库文件
- **THEN** 访问被拒绝，数据库读写的唯一入口是主进程暴露的功能接口

### Requirement: IPC 白名单与输入校验

主进程 MUST 只暴露明确列出的功能通道，MUST NOT 提供通用任意文件读写或任意命令执行通道；所有输入 MUST 在运行时校验。

#### Scenario: 调用未在清单中的通道

- **WHEN** 渲染层请求一个未列入白名单的通道
- **THEN** 请求被拒绝并返回稳定错误码，不执行任何文件或数据库操作

#### Scenario: 传入非法参数

- **WHEN** 合法通道收到类型错误或越界的参数
- **THEN** 返回稳定错误码与中文 message，操作不产生副作用

#### Scenario: 尝试以路径参数读取任意文件

- **WHEN** 渲染层通过预览或文件相关接口传入白名单外路径、`..`、绝对路径或指向图库外的路径
- **THEN** 请求被拒绝，不返回该文件内容

### Requirement: 窗口关闭与退出行为

关闭窗口 MUST NOT 遗留无法结束的进程；显式退出 MUST 安全停止进行中的本机任务。

#### Scenario: 关闭窗口

- **WHEN** 用户关闭窗口
- **THEN** 应用按既定行为进入托盘或退出，不残留占用数据库文件的孤儿进程

### Requirement: IPC 白名单扩展

系统 MUST 把新增的来源、扫描与图库通道加入 preload 白名单与主进程校验，MUST NOT 提供以任意路径为参数的读写通道。

#### Scenario: 新增通道可用
- **WHEN** 渲染层调用来源发现、来源登记、扫描开始/取消、游戏列表、资产列表、资产详情等已声明通道
- **THEN** 请求经运行时校验后执行，返回统一结果结构

#### Scenario: 未声明通道
- **WHEN** 渲染层调用不在白名单中的通道
- **THEN** 请求被拒绝，不执行任何文件或数据库操作

#### Scenario: 非法参数
- **WHEN** 合法通道收到类型错误或越界参数（例如非法的 assetId、非法的筛选值）
- **THEN** 返回稳定错误码与中文说明，不产生副作用

### Requirement: 扫描进度事件

系统 MUST 通过事件把扫描进度推送给渲染层，MUST NOT 要求渲染层轮询。

#### Scenario: 进度推送
- **WHEN** 扫描进行中
- **THEN** 渲染层按事件收到阶段、已处理数量、总量与失败计数

#### Scenario: 扫描结束
- **WHEN** 扫描完成、取消或失败
- **THEN** 推送一个终态事件，包含结束原因与统计，渲染层据此停止等待

### Requirement: 协议注册不影响安全基线

系统 MUST 在注册自定义协议的同时保持上下文隔离、禁用 Node 集成与沙箱开启。

#### Scenario: 注册协议后检查边界
- **WHEN** 注册 `ssm-asset` 协议后执行渲染层边界探测
- **THEN** 渲染层仍然拿不到 `require`、`process`，也无法直接读取文件系统

### Requirement: 大列表的内存边界

系统 MUST 限制同一时刻渲染的图片数量，MUST NOT 随列表长度线性增长。

#### Scenario: 查看器缩略图带
- **WHEN** 相册有数千张截图并打开查看器
- **THEN** 缩略图带只渲染当前项附近的有限张数，窗口外使用等宽占位保持滚动几何不变

#### Scenario: 离屏卡片
- **WHEN** 相册滚动到列表中部
- **THEN** 离屏卡片跳过渲染与绘制，不产生额外的图片解码与图层

#### Scenario: 模态背景
- **WHEN** 打开大图查看器或数据来源对话框
- **THEN** 背景使用纯色压暗，不使用要求栅格化整页的背景模糊

