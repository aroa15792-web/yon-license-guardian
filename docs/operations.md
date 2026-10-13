# Yon License Guardian 运维与故障处理

本说明适用于已经按 [部署手册](deployment.md) 安装的同名项目。服务器命令均在 root 终端执行；SSH 隧道命令在管理员电脑执行，并使用自己的服务器和具备私有 socket 访问权限的账户。常驻服务不依赖 Codex、本机浏览器或 SSH 隧道保持开启。

## 1 查看是否正常运行

```bash
systemctl is-active yon-license-monitor
systemctl is-enabled yon-license-monitor
cat /var/lib/yon-license-monitor/monitor/status.json
journalctl -u yon-license-monitor --no-pager -n 30
```

`active` 只代表进程在运行，业务状态仍可能 paused。enabled 代表开机启动。检查 `checkedAt` 是否最近更新；只读网页会把超过 150 秒的旧状态标为不新鲜，不能把旧占用当成实时人数。

| 状态 | 处理方式 |
| --- | --- |
| observing | 未满额，检查 used、capacity 与最新时间 |
| checking / cooldown | 正在读取或保护等待，观察下一轮 |
| released | 清理和完整回查成功，查看 before、after、released 与正式 journal |
| changed_retry_next_cycle | 写前名单变化，本轮未执行，下一轮重读 |
| paused / needs_login | 普通自动登录未完成，需要人工验证或核对账号 |
| paused / access_denied | 核对许可查看和释放权限 |
| paused / scope_mismatch | 核对企业与目标，不修改 PIN 来迁就错误企业 |
| paused / needs_reconciliation | 先核对未决事务，不重发清理或删除 journal |
| invalid_observation / journal_error / unexpected_error | 先读本项目日志，检查完整数据、文件权限或环境变化 |

网页当前不展示详细暂停原因；以状态文件和本项目日志为准。未接入外部告警，维护人员需要自己的巡检方式。图像验证码、短信、MFA 等挑战不会由当前程序无人值守通过。

## 2 暂停与恢复常驻服务

暂停：

```bash
systemctl stop yon-license-monitor
systemctl is-active yon-license-monitor
```

结果应为 inactive。停止服务不会撤销已经发出的远端请求；若当时正在执行写操作，等待退出并核对 journal，不能立即重启后再清一次。

恢复前检查正式和单次测试事务：

```bash
if [ -f /var/lib/yon-license-monitor/journal/journal.json ]; then
  cat /var/lib/yon-license-monitor/journal/journal.json
fi
if [ -f /var/lib/yon-license-monitor/manual-test/journal.json ]; then
  cat /var/lib/yon-license-monitor/manual-test/journal.json
fi
```

任意 journal 为 pending 都须先人工对账。确认无未决事务、企业和权限正确，且可视登录/单次测试已停止后，再恢复：

```bash
systemctl is-active yon-license-login
systemctl is-active yon-license-test
systemctl start yon-license-monitor
systemctl is-active yon-license-monitor
cat /var/lib/yon-license-monitor/monitor/status.json
```

业务暂停没有自动解除接口，人工登录成功本身不等于监控已恢复。等待至少一轮检查后确认新的时间和结果。不要重启服务器或无关业务服务来处理本项目暂停。

## 3 遇验证码时接管浏览器

先查看暂停原因并检查上节两个 journal。任何 pending 优先进入对账处理；不要把验证码流程用作不确定清理的重试。

1. 停止 monitor，确保单次测试未运行：

   ```bash
   systemctl stop yon-license-monitor
   systemctl is-active yon-license-test
   ```

2. 检查临时登录单位是否仍存在：

   ```bash
   systemctl show yon-license-login.service -p LoadState -p ActiveState
   ```

   `LoadState=not-found` 时才执行：

   ```bash
   bash /opt/yon-license-monitor/start-visual-login.sh login
   ```

   如果 loaded 且 inactive，使用 `systemctl start yon-license-login` 复用原单位；如果 active，直接使用已启动窗口。failed 时先读其日志并处理原因，必要时只对本单位 `systemctl reset-failed yon-license-login`。不要反复运行 systemd-run、全局 reset 或删除运行目录。

3. 管理员电脑结束本项目旧的状态隧道，建立人工登录隧道：

   ```bash
   ssh -N -o ExitOnForwardFailure=yes \
     -L 127.0.0.1:19080:/run/yon-license-login/web.sock \
     YOUR_TUNNEL_SSH_USER@YOUR_SERVER_IP
   ```

   该 SSH 用户必须能访问私有 socket。浏览器打开 `http://127.0.0.1:19080/`，在远端 Chrome 进入 `https://c3.yonyoucloud.com/`，完成验证并核对企业。不要将密码、验证码或 Cookie 分享到文档。

4. 同一专用 profile 只能由一个项目服务使用。可视单位每次最多 30 分钟；结束后会保留 profile 的正常登录状态。完成验证且没有 pending，停止可视单位再启动常驻服务：

   ```bash
   systemctl stop yon-license-login
   systemctl is-active yon-license-login
   systemctl start yon-license-monitor
   cat /var/lib/yon-license-monitor/monitor/status.json
   ```

   等待一轮新检查，确认企业、许可和状态正确，再把本机隧道切回 `status-web.sock`。临时登录启动器未加载企业 PIN，不能原样用它的 `/snapshot` 认定完整核验通过；完整核验在 PIN 已加载的常驻模式执行。

## 4 pending 事务如何处理

pending 表示程序已准备发送或已经发送释放请求，但尚未取得完整成功核验。它不能直接说明失败，也不能直接说明成功。程序保留它以防重启或超时后重复发送请求。

维护人员先停止本项目监控，保留 journal、时间和本项目脱敏日志，再在用友核对企业、许可占用、该次旧占用是否消失及业务结果。只读核对不触发释放。证据不完整时保持暂停。

当前版本没有可直接运行的自动对账/解除 pending 工具。需要负责人员根据实际结果制定审查过的恢复处理，不能由模型猜测。不删除 journal、不手改 pending 为 verified、不重发旧 POST，也不切换到单次测试去再清一次。

## 5 凭据和文件权限

凭据原件 `/etc/yon-license-monitor/yon-login.json`：目录 0700、文件 0600、root 所有。仅有 username 和 password 两键，密码不得写入 monitor.env。首次创建命令不覆盖已有文件；更新由管理员在受信任终端安全替换，不打印旧内容或在命令参数中填写密码。

更新后只有确认无未决事务，才重启本项目，让 systemd 加载新凭据。运行副本 `/run/credentials/yon-license-monitor.service/yon-login` 是 systemd 提供的只读材料；本代码对精确单位名和元数据有检查，不擅自重命名服务或修改副本权限。排障只看元数据：

```bash
stat -c '%a %U:%G %n' \
  /etc/yon-license-monitor /etc/yon-license-monitor/yon-login.json
stat -c '%a %U:%G %n' \
  /run/credentials/yon-license-monitor.service \
  /run/credentials/yon-license-monitor.service/yon-login
getfacl -p /run/credentials/yon-license-monitor.service/yon-login
```

服务运行时副本由 systemd ACL 授权，预期 root:root、目录 0550、文件 0440。不同主机不匹配时先核对 systemd 和受限 loader 的兼容性，不用 chmod 或 setfacl 绕过。状态目录与 profile 由 systemd/应用管理，不递归放宽为 0777。

## 6 常见故障

| 现象 | 排查顺序 |
| --- | --- |
| 本机网页白屏或连不上 | 检查隧道仍运行、19080未被占用、socket对应正确、SSH账户具备访问权限，再读本项目日志 |
| 登录窗口失败 | 检查 Xvfb/x11vnc/xauth、Google Chrome硬路径、Node系统PATH、root visual-login复制目录和依赖 |
| 只读网页 unavailable | 初次AUTO_RELEASE=0可能为旧状态契约；改看status.json与scope/snapshot，不直接启用清理 |
| 401 / needs_login | 核对C3、普通凭据与验证要求，按人工接管流程处理 |
| 403 / access_denied | 让企业管理员核对目标许可权限，不改代码规避权限 |
| scope_mismatch | 核对实际企业与先前PIN，不将错误企业散列写回配置 |
| invalid_observation | 核对真实容量、类型、控制点、完整分页、人数变化或接口变更；当前固定10人 |
| Chrome退出 / OOM | 查看本项目systemd状态、内存余量、sandbox日志与Chrome版本；不关闭sandbox或盲目放宽资源 |
| npm ci失败 | 检查npm网络、TLS、Node版本与lockfile；不直接npm update |
| apt重复Google源或Signed-By冲突 | 查看sources.list.d中Google Chrome条目，管理员合并成唯一有效源，保留官方签名验证 |
| 启动过快被限流 | 先分析失败根因，修复后仅reset-failed本项目单位；禁止无新假设循环重启 |

Google 源冲突只读检查：

```bash
grep -R -n 'dl.google.com/linux/chrome' \
  /etc/apt/sources.list /etc/apt/sources.list.d
```

读取 .list 与 .sources 条目；某个文件不存在不代表 Chrome 服务失败。签名配置以自己的实际仓库为准。

## 7 更新、备份与停用

更新前先停止本项目、核对两种 journal 并保存仅本项目文件的受限备份。受保护凭据、profile 和运行状态仅按部署者的内部备份规则保存，不能混入对外源码包。保留原企业 PIN、文件所有者、权限和已消费事务；不把 Cookie 当作跨服务器部署模板。

更新代码与浏览器后先以 AUTO_RELEASE=0重新核验，再按负责人授权恢复写操作。变更PIN、目标范围、容量、服务名或认证方式需要重新适配验收。不要在共享服务器重装全局Node或操作无关服务。

停用并取消开机启动：

```bash
systemctl disable --now yon-license-monitor
systemctl stop yon-license-login
systemctl is-active yon-license-monitor
```

保留 journal 和内部受限备份，不把停用等同于删除数据。正式删除软件、凭据或 profile 由部署者按保留要求另行处理。

## 8 单次实际清理测试入口

源码包含 [start-manual-test.sh](../deploy/start-manual-test.sh)、[run-manual-test.sh](../deploy/run-manual-test.sh)、[manual-test.mjs](../deploy/cloud-browser/manual-test.mjs)，用于负责人明确授权的一次性真实清理验收，可在至少 1 人时执行，属于写操作，不是日常维护指令。本通用安装流程不自动运行这个入口，也不携带其他环境的测试 journal。

执行新的一次性测试前，必须核对正式和测试两个 journal：任意 pending 禁止测试，测试 journal 已存在（包括 verified）也不能删除后重跑。测试 CLI 自身只查测试 journal，不能代替人工检查正式事务。还需停止常驻与可视服务、核对自己的企业 PIN、制定业务核验方式；之后由负责维护人员审查并执行源码入口。

正式自动规则始终固定 10 人。不要降低阈值、伪造人数或删事务来完成验收。安装验收、模拟测试、登录核验、真实释放和员工正常提单应分别记录。
