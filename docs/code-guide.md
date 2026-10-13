# Yon License Guardian 代码导览

本导览按 GitHub 仓库根目录的 `src/`、`deploy/`、`test/` 与 `scripts/` 说明当前实现。仓库不携带任何部署者的服务器配置、账号、会话或现场验收记录。

实现由 `systemd + Node.js + Playwright + Chrome + 用友已有接口` 组成，安装完成后可独立在服务器运行，不依赖 Codex 或部署者的电脑常驻。当前程序采用固定规则，还没有接入模型 API 的登录恢复 Agent。正式自动清理只在目标许可占用达到 10/10 时执行。

首次安装请先阅读 [服务器配置与部署说明](deployment.md)；安装后的恢复与维护请阅读 [运维与故障处理](operations.md)。

## 1. 固定范围和触发条件

规则在 [policy.mjs](../src/policy.mjs) 的 `TARGET` 和 `plan()` 中。

| 字段 | 固定值 |
| --- | --- |
| 看板 | 应用许可看板 → 使用中 → 供应链云 → 采购供应 |
| 用友服务域 | `https://c3.yonyoucloud.com` |
| 许可编码 | `BIP0002YB` |
| 许可类型 | `SHAREUSER` |
| 控制点 | `BIPSCM0201`，采购管理 |
| 领域 | `MM` |
| 容量 | `10` |
| 自动操作 | 完整、有效、同企业的占用人数达到 10，释放当时名单中的全部采购许可占用 |

释放对象是采购许可的占用记录。代码没有账号删除、采购订单删除或其他许可的清理入口。

除了 `used >= 10`，`validate()` 还要求：读取成功、目标字段完全一致、企业核验通过、没有筛选且分页完整、快照不超过 30 秒、人数与名单条数一致、记录标识唯一、许可有效。缺少任何证据都会拒绝操作，不会把读取失败当作 0 人。

## 2. 启动和运行链路

```text
systemd：yon-license-monitor.service
  └─ /opt/yon-license-monitor/run-monitor.sh
       ├─ deploy/cloud-browser/session.mjs
       │    └─ 独立 Chrome profile + 浏览器内同源请求
       ├─ src/auto-release-main.mjs（YON_AUTO_RELEASE=1）
       │    └─ release-monitor → Controller → FileJournal
       └─ deploy/status-viewer/server.mjs（只读状态页）
```

`YON_AUTO_RELEASE=0` 时，启动脚本运行 `src/summary-monitor.mjs`，每分钟只读取统计人数；不会运行自动释放入口。[配置模板](../examples/monitor.env.example) 默认关闭写操作。

| 文件 | 主要责任 |
| --- | --- |
| [yon-license-monitor.service](../deploy/yon-license-monitor.service) | 开机启动、故障重启、动态服务用户、受保护凭据注入、资源限制和文件系统限制 |
| [run-monitor.sh](../deploy/run-monitor.sh) | 取得 `flock` 单控制器锁，启动浏览器、监控器和状态页，统一关闭子进程 |
| [session.mjs](../deploy/cloud-browser/session.mjs) | 创建持久浏览器环境、管理会话，提供私有 Unix socket RPC |
| [auto-release-main.mjs](../src/auto-release-main.mjs) | 连接真实读取/释放 RPC，释放前第三次读取，以及释放后的有限次数只读核验 |
| [release-monitor.mjs](../src/release-monitor.mjs) | 60 秒串行调度，写脱敏状态，遇异常暂停 |
| [controller.mjs](../src/controller.mjs) | 决策、第二次读取、写前持久 pending、一次释放和最终核验 |
| [file-journal.mjs](../src/file-journal.mjs) | 严格 journal 字段，原子写入和 fsync，防止重启后重复操作 |
| [policy.mjs](../src/policy.mjs) | 固定采购目标、完整快照校验和名单指纹 |

部署单元的 `ExecStart` 指向 `/opt/yon-license-monitor/run-monitor.sh`。首次部署时应把仓库的 `deploy/run-monitor.sh` 复制到这个单元指定的位置，不能只克隆仓库后假定入口已就绪。其余临时启动脚本也使用固定 `/opt/yon-license-monitor/` 路径，详见 [部署说明](deployment.md)。

## 3. 登录如何实现

[auto-login.mjs](../deploy/cloud-browser/auto-login.mjs) 是确定性登录程序，使用 Playwright 的定位、填充和点击操作。它只读取本项目注入的 `yon-login` 凭据，不导出 Cookie，也不把账号、密码交给模型。

流程是：先核验已有会话 → 确实需要登录时读取凭据 → 打开 c3 原生登录回调 → 找到用友 CAS 的账号密码表单 → 检查是否出现挑战 → 填写并提交一次 → 核验企业身份 → 转到轻量统计页 → 再核验企业身份和统计接口。

`session.mjs` 只在读取操作确认 `needs_login` 时调用这个恢复过程；释放操作不会自动重登后重发。单个浏览器登录任务不并发，登录恢复尝试有 10 分钟间隔限制，整个登录过程有 30 秒期限。

可见图片验证码、短信验证、MFA、人脸、密码修改等界面，会被 `loginObstacle()` 识别为 `challenge`。程序不会识别或绕过这些验证；也不会自动同意未知的登录复选框。登录失败、挑战、企业不匹配或最终核验失败会返回受限错误码。登录成功以实际企业身份和接口读取成功为准，点击登录按钮不算成功。

当前监控器进入 `paused` 后不会自行解除暂停。人工验证后仍需核验并恢复本项目监控服务；未核实的 `pending` 记录不能靠重启清掉。外部告警、模型判断和验证完成后自动恢复是后续功能，当前源码没有实现。

## 4. 读取接口和防混企业

| 读取 | 源码 | 方法与路径 |
| --- | --- | --- |
| 统计人数 | [license-summary.mjs](../src/license-summary.mjs) | `GET /iuap-apcom-workbench/manager/license/getTenantLicenseInfo?labelDomain=MM&status=VALID` |
| 当前企业 | [tenant-scope.mjs](../deploy/cloud-browser/tenant-scope.mjs) 与读取适配器 | `GET /iuap-apcom-workbench/me?onlyShayat=false` |
| 用户当前企业 | 同上 | `GET /iuap-apcom-workbench/user/getUserInfo?userId=` |
| 完整占用名单 | [license-adapter.mjs](../deploy/cloud-browser/license-adapter.mjs) | `POST /iuap-apcom-auth/u8c-auth/bill/list?serviceCode=GZTSYS035&appCode=BIP0002YB&terminalType=1&fromYonyou=true` |

名单接口的 `POST` 是只读查询。请求固定 `billnum=sys_user_licenselist`，每页 20 条，使用默认方案，不传历史页面中的筛选编号。它逐页检查页码、总人数、总页数和实际行数，读完后才接受名单。

每个完整快照的内部顺序是：

```text
企业核验（me → getUserInfo → me）
  → 统计人数
  → 完整分页名单
  → 再读统计人数并比较
  → 再次企业核验
```

企业 ID 的 SHA-256 必须等于部署配置的 `YON_TENANT_HASH`。配置示例只有占位符，没有实际企业 ID 或实际企业哈希。名单与统计的读取期间如果切换企业、人数变化、分页变化或目标变化，这次快照会作废。

真实名单的 `userId` 只保存在浏览器内的短期映射。监控器拿到的是按企业和许可计算的哈希 ID，不会收到姓名、手机号或完整人员行。每次重新读取都会清掉旧写操作令牌，新的令牌 30 秒失效。

## 5. 自动清理的完整顺序

正常调度固定每 60 秒触发；上一轮尚未结束时不新开任务，避免重叠：

1. `Controller.tick()` 先读持久记录。有未核实 `pending` 就暂停，不再发送请求。
2. 第一次完整快照用于计划。低于 10 人只观察；达到 10 人才提出释放。
3. 第二次完整快照与第一次的企业、固定目标及全名单指纹比较。变化则留到下一轮。
4. 生成操作 UUID，把 `pending` 写入 journal 并持久化。这一步必须早于任何写接口。
5. `createLiveAdapter.release()` 第三次完整读取并核对指纹及全名单。
6. 私有 `/release` RPC 再核对配置、最新令牌、完整名单和匹配的 durable pending。它只接受本项目固定格式命令。
7. 浏览器内同步消耗一次性令牌，然后调用固定许可释放接口一次。
8. 接到明确成功应答后，只重读数据核验结果；最多 5 次、30 秒总期限，不重发释放请求。
9. 企业一致、人数确实下降且本轮原占用 ID 全部消失，才把 journal 从 `pending` 改成 `verified`。

固定写接口在 [release-operation.mjs](../deploy/cloud-browser/release-operation.mjs)：

```http
POST https://c3.yonyoucloud.com/iuap-apcom-workbench/manager/license/remove
Content-Type: application/json;charset=utf-8
```

```js
// 参数来自本轮核验的实际占用名单；示例没有实际用户 ID。
{ userId: selectedActualUserIds.join(','), code: 'BIP0002YB' }
```

代码根据运行时页面前端可用情况补充受限认证头；没有可用前端头构造函数时使用同源标准 JSON 请求。它故意不调用可能自动重发的通用前端代理。HTTP 错误、超时、需二次验证或不明确应答都保留 pending 并暂停，不能“猜测失败后再删一次”。

## 6. 一次性测试和正式自动规则的区别

[manual-test.mjs](../deploy/cloud-browser/manual-test.mjs) 是用户明确要求测试时使用的独立 CLI。它可以在 1 人以上时执行一次采购占用释放，但必须同时有显式确认参数、专用环境开关和正确企业 pin。

| 入口 | 条件 | 记录 | 重复行为 |
| --- | --- | --- | --- |
| 正式 `auto-release-main.mjs` | 完整有效占用达到 10 | `journal/journal.json` | 已确认后按正常轮次和冷却期继续；pending 时暂停 |
| `manual-test.mjs` | 显式一次性测试授权，至少 1 人 | `manual-test/journal.json` | 只要已有测试记录，即使 verified，也拒绝再次执行 |

执行任何新的一次性测试前必须检查正式与测试两个 journal；任意 `pending` 都禁止测试。测试 CLI 自身只检查测试 journal，不代替这项人工前置检查。

测试同样三次读取、写前 pending、一次 POST、核验结果。正式服务发现一次性测试 journal 仍是 pending 时，也停止自动写入。测试不会把正式容量改成 1，也不会把人数伪装成满额。

`start-manual-test.sh` 和 `run-manual-test.sh` 负责临时 systemd 测试单元。它们要求本项目监控和可视化登录服务先停止，复用同一私有 profile，运行时限 3 分钟，`Restart=no`，不能用作日常调度。

[auth-check.mjs](../deploy/cloud-browser/auth-check.mjs) 则只做重新登录验收：创建新的匿名、非持久浏览器，再登录和读完整名单，不调用释放接口、不读已有 profile 或 journal。

## 7. 页面与受保护文件

| 类型 | 路径或文件 | 用途 |
| --- | --- | --- |
| 控制 socket | `/run/yon-license-login/browser-control.sock` | 只供本项目同服务用户的 Unix RPC；没有公网浏览器调试端口 |
| 状态 socket | `/run/yon-license-login/status-web.sock` | 只读状态网页，经 SSH 转发到本机 |
| 浏览器 profile | `/var/lib/yon-license-monitor/chrome-profile` | 服务器内保持用友会话，不提交到 Git |
| 脱敏状态文件 | `/var/lib/yon-license-monitor/monitor/status.json` | 状态、人数和计数，不含账号、Cookie 或名单 |
| 正式持久记录 | `/var/lib/yon-license-monitor/journal/journal.json` | pending 或 verified，不提交实时内容到 Git |
| 凭据原文件 | `/etc/yon-license-monitor/yon-login.json` | 由管理员受保护保存；仓库只有占位示例 |

[status-viewer/server.mjs](../deploy/status-viewer/server.mjs) 只允许 `GET /` 和 `GET /status`，只接收本机转发使用的 Host/Origin。它重新构造脱敏输出，不把 journal 的操作 UUID、指纹或异常原文传到页面。关闭状态页或 SSH 转发不会停止服务器监控。

目录权限主要为 0700，状态和 socket 为 0600；凭据通过 `systemd LoadCredential` 注入，源码检查专用路径、文件类型、所有者、权限和链接状态。服务硬性限制半个 CPU 核心、512 MiB 内存，不修改其他业务项目的服务。

可视化人工登录相关文件在 `deploy/visual-login/`，由 `start-visual-login.sh` / `run-visual-login.sh` 启动临时窗口。它使用 Xvfb、x11vnc 和 noVNC，仅供人工验证，30 分钟自动结束，与正式 monitor 互斥。它不是日常自动清理的依赖，也不应长期开放到公网。

可选公网运行看板位于 `deploy/public-viewer/`。`gateway.mjs` 只允许读取首页、脱敏状态与运行记录；`event-contract.mjs` 定义白名单，`event-collector.mjs` 轮询原状态接口并按检查时间与内容去重，`event-store.mjs` 原子持久化到该查看服务自己的受保护目录。采集器不接触浏览器、凭据或清理接口；人工测试与自动监控是不同的事件来源。Nginx 对整个路径前缀启用 HTTPS 与登录保护，查看页仅绑定回环端口。

## 8. 辅助文件和测试

| 文件或目录 | 说明 |
| --- | --- |
| `test/*.test.mjs` | 策略、控制器、journal、监控循环和真实适配器 RPC 的确定性单元测试 |
| `deploy/cloud-browser/*.test.mjs` | 企业核验、登录挑战、完整名单、一次写、令牌、RPC 和一次性测试的模拟测试 |
| `deploy/status-viewer/server.test.mjs` | GET-only、脱敏、权限、Host/Origin 和拒绝未知数据 |
| `deploy/visual-login/*.test.mjs` | 临时窗口网页与连接桥约束 |
| `scripts/build-browser-check.mjs` | 生成浏览器内只读检查代码的辅助入口 |
| `src/check.mjs` | 离线读取脱敏 JSON 快照并生成计划，不联网、不调用清理 |
| `deploy/read-only-preflight.sh` | 新主机只读资源盘点，不安装、不改其他项目 |
| `deploy/cloud-browser/discovery.mjs` | 接口发现辅助代码，不是正式 systemd 服务入口 |
| `package.json` | 根包没有应用运行依赖；完整项目按 Node.js 22 及以上部署 |
| `deploy/cloud-browser/package*.json` | 固定 `playwright-core` 依赖与 lockfile，正式浏览器环境需要安装 |
| `deploy/visual-login/package*.json` | 临时可视化桥依赖，Node.js 22 及以上 |

在仓库根目录运行：

```bash
npm --prefix deploy/cloud-browser ci --omit=dev
npm --prefix deploy/visual-login ci --omit=dev
npm test
```

这会运行模拟测试，不会登录用友，不会修改真实许可。部署者应保存自己环境中的测试结果。单元测试通过不等于真实许可清理成功；真实释放必须另行获得授权并核验结果。

## 9. 未来登录恢复 Agent 的接入位置

当前 `auto-login.mjs` 只有固定判断和有限重登，当前工程没有模型客户端、提示词、模型 API key、消息提醒发送器或无人值守验证码解决程序。

如果后续增加 Agent，建议放在独立恢复调度器中，读取脱敏错误状态，调用受限工具：查询登录状态、普通重登一次、准备人工验证、核验企业和许可数据、恢复监控。`policy`、tenant pin、pending、一次写及完整结果核验应继续由确定性程序执行，不能交给模型放宽。

模型接入、异常提醒渠道和人工验证后自动恢复属于尚未实现的方案；本仓库提供的是当前固定规则服务及其代码。

## 10. 仓库范围和新环境配置

本仓库包含源文件、模拟测试、部署脚本、依赖 lockfile、文档和占位配置。它不包含运行时数据、私有目录、安装后的依赖目录、实际环境配置、SSH 文件、浏览器 profile、HAR、Cookie 或真实登录凭据。

部署者需要在自己的服务器安装依赖，把运行脚本和可视化桥放到 [部署说明](deployment.md) 指定的位置，并提供自己的用友账号与经过核验的企业哈希。[monitor.env.example](../examples/monitor.env.example) 默认关闭释放；只有确认企业、固定采购许可、统计人数和完整名单一致后，才能启用自动清理。[yon-login.example.json](../examples/yon-login.example.json) 仅说明私有凭据格式，不应填入真实凭据后提交到 Git。

程序仍使用固定 C3 域、10 人采购许可和本文第 1 节的目标字段。面向其他用友域、容量或许可时，需要适配源码和重新验证，不能只替换账号后直接启用。
