# Yon License Guardian 服务器配置与部署

本说明供部署人员从 [GitHub 源码仓库](https://github.com/aroa15792-web/yon-license-guardian) 在自己的 Linux 服务器安装本项目。请使用自己的服务器、用友账号和企业配置，按步骤先完成只读核验，再启用满额自动清理。安装后程序由 systemd 常驻运行，个人电脑只用于首次登录和查看状态。

## 1 项目功能与适用范围

当前版本固定检查 C3 的“应用许可看板 → 使用中 → 供应链云 → 采购供应 → 采购管理”，许可编码 `BIP0002YB`、控制点 `BIPSCM0201`、类型 `SHAREUSER`、领域 `MM`，容量为 10 人。

每 60 秒定时触发检查；上一轮未完成时不新开任务。未满 10 人只观察，达到或超过 10 人且完整名单、企业和许可核验通过时，释放本项当前全部占用。它没有判断用户是否闲置的依据。释放对象为许可占用记录；代码没有删除员工账号、订单或其他许可的入口。

```text
专用 Linux 服务器
  systemd → Chrome 登录会话 → 完整名单与企业核对
          → 固定满额规则 → 单次释放 → 只读回查与事务记录
          → 仅经 SSH 查看的状态页
```

其他用友集群、许可类型、控制点或容量，不能仅修改配置模板就套用本版本，需要适配并重新验收。当前包含普通密码自动重登；验证码或 MFA 需人工完成验证并恢复。模型 Agent、外部告警和验证后自动恢复尚未实现。

## 2 服务器配置

建议使用一台全新的专用虚拟机，减少与现有项目共用浏览器、Node 和服务名称的冲突。以下硬件是部署建议，并非压测得出的最低要求。

| 配置项 | 建议或要求 |
| --- | --- |
| 操作系统 | Ubuntu Server 24.04 LTS，标准 systemd 环境 |
| 架构 | x86_64 / amd64；本手册的安装命令按此架构编写 |
| CPU | 建议 2 vCPU 或更多 |
| 内存 | 建议 4 GB 或更多；共用主机需额外保留其他项目余量 |
| 磁盘 | 建议 20 GB 或更多系统盘，部署前至少 5 GB 可用空间 |
| 登录管理 | 部署账户可 sudo；查看私有窗口需另备组织允许的 root SSH 密钥账户 |
| Node.js | 本手册安装 22.23.3 LTS；源码完整模块最低要求 22 |
| 浏览器 | Google Chrome，执行路径必须为 `/usr/bin/google-chrome` |
| 网络 | 可访问 Ubuntu 软件源、Node 官方下载、npm、Google 软件包与用友服务 |
| 时间 | 系统时间准确、时间同步正常；不要求固定某个时区 |
| 域名与 HTTPS | 本项目无需购买域名或配置公网网站证书 |
| Docker | 本版本不依赖 Docker |

本项目 systemd 单位限制半核 CPU、448 MiB 内存软限、512 MiB 内存硬限、192 个任务且不使用 swap。这些是本项目进程组限制，不代表整台服务器只需 512 MiB。遇资源问题先排查，不在共享主机盲目扩大限制。

安全组或防火墙仅需允许管理员来源访问实际 SSH 端口，通常为 TCP 22。应用页面经 SSH 转发到管理员电脑 `127.0.0.1:19080`，不要开放公网 19080、19590 或浏览器调试端口。VNC 19590 只在临时人工登录时绑定服务器回环地址。已有 SSH 端口非 22 时，相应为 `ssh` 加 `-p`、为 `scp` 加 `-P`。

出站需允许用友 C3、统一认证及其实际跳转资源，例如 `c3.yonyoucloud.com`、`euc.yonyoucloud.com`、`www.yonyoucloud.com`；安装阶段还需软件源和下载域名。企业网络限制出站时，由管理员按真实重定向补齐允许项，不关闭 TLS 证书校验。

## 3 准备自己的部署参数

先准备服务器地址、SSH 管理账号、具备当前企业许可查看和释放权限的用友账号，以及本人可完成的验证码或 MFA。账号应按组织规则专用或受控，避免多人反复登录互相挤出。用友企业配置必须在自己的登录会话中取得，不向他人复制企业 PIN 或 Cookie。

下文中 `YOUR_SERVER_IP` 是自己的服务器地址，`YOUR_SSH_USER` 是可 sudo 的部署账户，`YOUR_TUNNEL_SSH_USER` 是用于查看窗口的账户。本指南查看窗口的标准方式为组织允许的 root SSH 密钥登录，因此后者通常填 `root`。普通部署账户有 sudo，不代表 SSH 转发能访问 root/服务用户私有 socket。执行前准备好两个通道；服务器命令均在管理员进入 root 终端后执行。

如果尚未配置查看账户，在管理员电脑准备自己的 SSH 公钥；通过已有管理通道进入服务器 root 终端，将这一条公钥追加到 `/root/.ssh/authorized_keys`，保留已有其他条目：

```bash
install -d -m 0700 -o root -g root /root/.ssh
touch /root/.ssh/authorized_keys
chmod 0600 /root/.ssh/authorized_keys
chown root:root /root/.ssh/authorized_keys
editor /root/.ssh/authorized_keys
```

随后在电脑验证 `ssh root@YOUR_SERVER_IP` 使用密钥成功。此处添加的是公钥，不复制私钥，也不要求开启 root 密码登录。若组织禁止 root SSH 或 Unix socket 转发，先由管理员提供符合策略的受控中转；不要修改全局 SSH 策略或放宽 socket 权限来迁就本项目。

## 4 登录服务器并检查环境

在管理员电脑终端执行：

```bash
ssh YOUR_SSH_USER@YOUR_SERVER_IP
```

在服务器执行：

```bash
sudo -i
cat /etc/os-release
uname -m
nproc
free -m
df -h / /opt
systemctl --version
timedatectl status
ss -lnt
systemctl show yon-license-monitor.service -p LoadState
```

确认系统为 Ubuntu 24.04、架构为 x86_64、资源符合建议，且尚未部署同名项目。不要覆盖已有 `/opt/yon-license-monitor`、同名服务、Node 或 Chrome 配置。已有部署请使用运维说明，不能重跑初始化。安装工具命令适用于新专用主机。

## 5 安装系统依赖

在服务器 root 终端执行：

```bash
apt-get update
apt-get install -y ca-certificates curl xz-utils git python3 \
  xvfb x11vnc xauth util-linux iproute2 acl fonts-noto-cjk
```

不需要安装完整桌面环境。Xvfb、x11vnc 和 xauth 只供临时可视登录使用；正常监控为 headless Chrome。`acl` 供查看凭据访问权限，中文字体用于远端页面显示。

## 6 安装 Node.js

先检查 `node --version`、`npm --version`。已有兼容 Node 且能够在 systemd 常用 PATH 内执行时，跳过下面安装段，直接执行本节最后的检查。仅在 nvm 或个人 shell 中可见的 Node 不满足当前启动脚本要求。

下面仅用于没有现有 Node 的全新服务器：下载 [Node.js 22.23.3 官方 Linux x64 发行包](https://nodejs.org/en/download/archive/v22.23.3)，核对官方 SHA-256，解压到本项目 runtime 目录，再建立系统可见命令链接。它不会覆盖已有命令；有冲突就停止。

```bash
(
  set -euo pipefail
  test "$(uname -m)" = x86_64
  for yon_command in node npm npx; do
    if command -v "$yon_command" >/dev/null 2>&1; then
      printf '已有 Node/npm/npx，请检查版本与服务 PATH，未执行覆盖\n' >&2
      exit 1
    fi
  done
  test ! -e /opt/yon-license-node
  test ! -L /opt/yon-license-node
  for yon_command in node npm npx; do
    test ! -e "/usr/local/bin/$yon_command"
    test ! -L "/usr/local/bin/$yon_command"
  done
  yon_node_version=v22.23.3
  yon_node_archive="node-${yon_node_version}-linux-x64.tar.xz"
  yon_node_tmp=$(mktemp -d /tmp/yon-node-download.XXXXXX)
  cd "$yon_node_tmp"
  curl --fail --location --proto '=https' --tlsv1.2 \
    -O "https://nodejs.org/dist/${yon_node_version}/${yon_node_archive}"
  curl --fail --location --proto '=https' --tlsv1.2 \
    -O "https://nodejs.org/dist/${yon_node_version}/SHASUMS256.txt"
  awk -v name="$yon_node_archive" '$2 == name { print }' \
    SHASUMS256.txt > node-checksum.txt
  test -s node-checksum.txt
  sha256sum --check node-checksum.txt
  install -d -m 0755 /opt/yon-license-node
  tar -xJf "$yon_node_archive" --strip-components=1 \
    -C /opt/yon-license-node
  for yon_command in node npm npx; do
    ln -s "/opt/yon-license-node/bin/$yon_command" \
      "/usr/local/bin/$yon_command"
  done
)
```

检查普通 shell 和 systemd 常用命令路径都能执行 Node：

```bash
node --version
npm --version
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  node --version
env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  npm --version
```

Node 22.23.3 是本手册的固定安装版本；部署者应按组织要求维护安全更新并重新验证。不要只在 `monitor.env` 修改隔离 Node 的 PATH：现有临时登录启动器不读取这个文件，无法覆盖全部入口。共享主机需要隔离 Node 时，维护人员必须同时适配所有 systemd 入口。

## 7 安装 Google Chrome

确认是 amd64 的新主机后，在服务器通过 HTTPS 下载 Google 官方 .deb 软件包，并用 apt 安装其系统依赖。Chrome 安装器会管理软件仓库，手册不额外创建第二份 Google 源。Google 官方说明支持 Ubuntu 安装 .deb，见 [Google Chrome 安装帮助](https://support.google.com/chrome/answer/95346)。

```bash
(
  set -euo pipefail
  test "$(dpkg --print-architecture)" = amd64
  if command -v google-chrome >/dev/null 2>&1; then
    printf '已有 Chrome，请检查硬路径和版本，未执行覆盖\n' >&2
    exit 1
  fi
  yon_chrome_tmp=$(mktemp -d /tmp/yon-chrome-download.XXXXXX)
  cd "$yon_chrome_tmp"
  curl --fail --location --proto '=https' --tlsv1.2 \
    https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    -o google-chrome.deb
  chmod 0755 "$yon_chrome_tmp"
  chmod 0644 google-chrome.deb
  apt-get install -y ./google-chrome.deb
  apt-get update
)
test -x /usr/bin/google-chrome
/usr/bin/google-chrome --version
```

已有符合要求的 Chrome 可跳过安装。安装后的一次 `apt-get update` 应无重复 Google 源或 `Signed-By` 冲突；否则按运维说明检查并保留唯一有效 Google 源，不盲目删除无关源。签名与后续更新机制见 [Google Linux 软件仓库说明](https://www.google.com/linuxrepositories/)。

不要用 Playwright 下载的浏览器或其他可执行别名替代硬编码路径。代码启用 Chrome sandbox；出现 AppArmor / namespace / sandbox 错误时先排查 Ubuntu 策略，不统一添加 `--no-sandbox`。Chrome 官方系统说明见 [Google Chrome 安装帮助](https://support.google.com/chrome/answer/95346)。

## 8 获取开源源码

选择下面一条路线即可。源码直接位于仓库根目录的 `src/`、`deploy/`、`test/`、`scripts/`。记录自己审核过的 Git commit；服务器已有目录或同名项目时停止初始化，按 [运维说明](operations.md) 更新，不能覆盖现有项目。

### 路线 A 服务器直接 git clone

适用于服务器可访问 GitHub 的情况。在服务器 root 终端执行：

```bash
(
  set -e
  test ! -e /opt/yon-license-monitor
  test ! -L /opt/yon-license-monitor
  git clone https://github.com/aroa15792-web/yon-license-guardian.git \
    /opt/yon-license-monitor
  cd /opt/yon-license-monitor
  git rev-parse HEAD
  git status --short
)
```

记录输出的 commit，确认它是自己审核或组织允许部署的版本；不要用未来未经审查的 `git pull` 直接更新运行中的服务。克隆本身不会安装、登录或释放许可。

### 路线 B 管理员电脑审查、模拟测试后上传源码

适用于服务器不能直接访问 GitHub 的情况。管理员电脑需安装 Git 和 Node.js 22 及以上。以下本地示例使用 Linux/macOS 的 Bash；Windows 管理员可用已配置的 WSL 环境，或选择路线 A。在新的工作目录执行：

```bash
git clone https://github.com/aroa15792-web/yon-license-guardian.git
cd yon-license-guardian
git rev-parse HEAD
npm --prefix deploy/cloud-browser ci --omit=dev
npm --prefix deploy/visual-login ci --omit=dev
npm test
git archive --format=tar.gz \
  --output=../yon-license-guardian-source.tar.gz HEAD
```

`npm test` 只运行模拟测试，不连接用友或释放真实许可。`git archive HEAD` 只打包该 commit 的已跟踪文件；本地安装的 `node_modules` 和未跟踪文件不会混入。审查通过后上传：

```bash
scp ../yon-license-guardian-source.tar.gz \
  YOUR_SSH_USER@YOUR_SERVER_IP:/tmp/yon-license-guardian-source.tar.gz
```

可在管理员电脑计算源码归档的 SHA-256（Linux 使用 `sha256sum`，macOS 使用 `shasum -a 256`），再与服务器输出比较：

```bash
sha256sum /tmp/yon-license-guardian-source.tar.gz
```

服务器 root 终端先查看归档文件名，再解压到新部署目录：

```bash
tar -tzf /tmp/yon-license-guardian-source.tar.gz
(
  set -e
  test ! -e /opt/yon-license-monitor
  test ! -L /opt/yon-license-monitor
  install -d -m 0755 /opt/yon-license-monitor
  tar -xzf /tmp/yon-license-guardian-source.tar.gz \
    -C /opt/yon-license-monitor
)
```

只接受自己从审核过的 commit 生成的归档。归档中应为相对源码路径，不应有绝对路径、`..` 路径、凭据或运行数据。上传的是源码，依赖仍须按下一节在服务器安装，不上传电脑的浏览器、会话或依赖目录。

## 9 安装依赖并放置启动脚本

两条获取路线都在服务器执行本步骤：

```bash
(
  set -e
  cd /opt/yon-license-monitor
  npm --prefix deploy/cloud-browser ci --omit=dev
  npm --prefix deploy/visual-login ci --omit=dev
  npm test
  test ! -e /opt/yon-license-monitor/visual-login
  cp -a deploy/visual-login /opt/yon-license-monitor/visual-login
  for yon_script in run-monitor run-visual-login start-visual-login \
    run-manual-test start-manual-test; do
    install -m 0755 "deploy/${yon_script}.sh" \
      "/opt/yon-license-monitor/${yon_script}.sh"
  done
)
```

`npm ci` 使用仓库 lockfile，安装失败先读完整错误。不要替换成自动升级依赖或跳过测试。服务器上的模拟测试也不能替代后续真实环境验收。

必须保留 `src/` 与 `deploy/cloud-browser/` 相对位置。临时可视登录脚本使用根目录 `visual-login/` 的固定路径，因此需要复制带依赖的目录；常驻单位也使用根目录的启动脚本副本。状态页仍在 `deploy/status-viewer/`，没有额外 npm 依赖。

```text
/opt/yon-license-monitor/
  src/   test/   scripts/   docs/   examples/
  deploy/cloud-browser/ + node_modules/
  deploy/visual-login/ + node_modules/
  deploy/status-viewer/
  visual-login/ + node_modules/
  package.json
  run-monitor.sh   run-visual-login.sh   start-visual-login.sh
  run-manual-test.sh   start-manual-test.sh
  monitor.env                  后续创建，不提交到 Git
```

安装目录名仍是 `/opt/yon-license-monitor`，systemd 单位名仍是 `yon-license-monitor.service`。仓库名 `yon-license-guardian` 不改变代码中的这些固定运行路径。

## 10 创建本项目登录凭据

在服务器受信任终端输入部署者自己的用友账号和密码。账号和密码都不回显、不放在命令行，首次创建拒绝覆盖已有文件：

```bash
install -d -m 0700 -o root -g root /etc/yon-license-monitor
python3 - <<'PY'
import getpass, json, os
target = '/etc/yon-license-monitor/yon-login.json'
username = getpass.getpass('用友账号（不回显）：').strip()
password = getpass.getpass('用友密码（不回显）：')
if not username or not password:
    raise SystemExit('输入为空，未创建凭据')
fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, 'w', encoding='utf-8') as output:
    json.dump({'username': username, 'password': password}, output, ensure_ascii=False)
    output.write('\n')
    output.flush()
    os.fsync(output.fileno())
print('凭据已创建；未显示内容')
PY
stat -c '%a %U:%G %n' \
  /etc/yon-license-monitor /etc/yon-license-monitor/yon-login.json
```

预期目录 `700 root:root`，文件 `600 root:root`；文件仅含 `username`、`password` 两键。即使先运行只读模式，服务的 `LoadCredential` 也需要此文件存在。不要打印或分享内容，不把真实凭据放进源码包。systemd 管理的只读凭据副本无需手工 chmod 或 setfacl。

## 11 首次人工登录并确认企业

服务器执行：

```bash
bash /opt/yon-license-monitor/start-visual-login.sh login
systemctl status yon-license-login --no-pager
```

该临时单位由 systemd 创建专用用户、运行目录和 Chrome profile。不要提前以 root 创建 profile，也不要复制其他部署的会话。临时窗口最长 30 分钟，正常监控尚未启动。

管理员电脑另开一个终端建立登录窗口隧道：

```bash
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:19080:/run/yon-license-login/web.sock \
  YOUR_TUNNEL_SSH_USER@YOUR_SERVER_IP
```

当前私有 socket 默认只允许服务用户与服务器 root 访问。使用第 3 节已准备并验证的窗口 SSH 密钥账户；不要把 socket chmod 成所有人可读写。转发失败时先确认是否误用了普通部署账号。

浏览器打开 `http://127.0.0.1:19080/`。在远端 Chrome 地址栏明确打开 `https://c3.yonyoucloud.com/`，使用自己的账号完成密码、短信、扫码或其他验证，确认预期企业和采购许可容量 10。`login` 初始页可能是 www，不能据此认定已进入 C3。该窗口显示的是服务器浏览器；关闭本机窗口不会删除服务器 profile。

## 12 取得并固定自己的企业 PIN

临时浏览器登录完成后，服务器执行两个只读请求：

```bash
curl --fail --silent --show-error \
  --unix-socket /run/yon-license-login/browser-control.sock \
  http://localhost/scope
curl --fail --silent --show-error \
  --unix-socket /run/yon-license-login/browser-control.sock \
  http://localhost/summary
```

`/scope` 成功结果中的 `scope.tenantHash` 是需要的 64 位小写十六进制 PIN。结合响应中的公司名称、可视页面企业与许可范围确认一致，不能只看散列。此临时启动器尚未传入 PIN，完整 `/snapshot` 当前不可用；先配置下一步，再到只读常驻模式核验完整名单。

用服务器编辑器创建 `/opt/yon-license-monitor/monitor.env`，格式可参考 [配置模板](../examples/monitor.env.example)：

```text
YON_TENANT_HASH=REPLACE_WITH_VERIFIED_64_HEX_TENANT_SHA256
YON_AUTO_RELEASE=0
YON_AUTO_LOGIN=1
```

仅将占位 PIN 替换为自己核验的 `scope.tenantHash`，先保持清理开关为 0。不可填公司名称或原始企业 ID，不可复制别人 PIN。文件不含账号、密码或 Cookie。

```bash
chown root:root /opt/yon-license-monitor/monitor.env
chmod 0600 /opt/yon-license-monitor/monitor.env
```

## 13 安装常驻服务并只读验收

先停止临时浏览器，释放同一个 profile，再安装常驻单位：

```bash
systemctl stop yon-license-login
systemctl is-active yon-license-login
install -m 0644 \
  /opt/yon-license-monitor/deploy/yon-license-monitor.service \
  /etc/systemd/system/yon-license-monitor.service
systemctl daemon-reload
systemctl enable yon-license-monitor
systemctl start yon-license-monitor
systemctl status yon-license-monitor --no-pager
cat /var/lib/yon-license-monitor/monitor/status.json
```

临时单位应为 inactive，常驻单位应为 active。`YON_AUTO_RELEASE=0` 仅运行摘要控制器，不发送释放请求。systemd 接管此前专用状态目录，`/var/lib/yon-license-monitor` 可能正常指向 `/var/lib/private/`；不要按普通目录重建或放宽权限。

只读核验企业和完整快照：

```bash
curl --fail --silent --show-error \
  --unix-socket /run/yon-license-login/browser-control.sock \
  http://localhost/scope
curl --fail --silent --show-error \
  --unix-socket /run/yon-license-login/browser-control.sock \
  http://localhost/snapshot
```

快照响应顶层应为 `status:ok`；业务字段位于 `snapshot` 对象。确认 `capacity:10`，目标编码匹配，`complete`、`unfiltered`、`scopeVerified` 为 true，`records` 条数等于 `used`，企业 PIN 与先前核验一致。占用明细只应在自己的服务器检查，不分享完整快照。

如果请求与周期读取撞车返回 `busy`，等待当前轮次结束再读，不堆积并发请求。首次只读控制器与状态网页契约不同，网页可能显示 `unavailable`；本阶段以服务器状态文件和 RPC 结果为准。401、403、企业不一致或不完整快照均不能通过验收。

## 14 启用满额自动清理

只有只读验收全部通过，且部署负责人授权释放本项全部占用后才启用。若此时已满 10 人，启动后的首轮就可能实际清理。

在 `monitor.env` 仅把下列开关改为 1，保留原企业 PIN 和自动登录设置：

```text
YON_AUTO_RELEASE=1
```

服务器执行：

```bash
systemctl restart yon-license-monitor
systemctl is-active yon-license-monitor
systemctl is-enabled yon-license-monitor
cat /var/lib/yon-license-monitor/monitor/status.json
```

状态应含 `enabled:true`。低于 10 时为 `observing`；达到门槛后依次执行：第一次完整读取、第二次完整读取、持久化 pending、第三次完整读取、单次释放 POST、完整回查。只有人数下降且本轮全部旧占用消失，记录才为 `verified`；未知结果保留 pending 并暂停，不重发。

## 15 查看状态并完成部署验收

管理员电脑结束本项目此前指向 `web.sock` 的登录隧道，改为状态页隧道：

```bash
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:19080:/run/yon-license-login/status-web.sock \
  YOUR_TUNNEL_SSH_USER@YOUR_SERVER_IP
```

同样需要具备私有 socket 访问权限的 SSH 账号。打开 `http://127.0.0.1:19080/`，页面展示最近检查时间、占用和清理状态。19080 是当前网页 Host 校验固定的端口，不能任意改成本机其他端口；占用时先结束属于本项目的旧隧道，不杀无关 SSH 连接。关闭隧道和浏览器不影响服务器监控。

服务器核对资源和启动状态：

```bash
systemctl show yon-license-monitor \
  -p ActiveState -p NRestarts -p CPUQuotaPerSecUSec \
  -p MemoryCurrent -p MemoryHigh -p MemoryMax -p TasksCurrent
journalctl -u yon-license-monitor --no-pager -n 30
```

部署验收逐项记录在部署者自己的内部文档：环境版本、开机启动、只读数据与真实看板一致、自动开关、状态时间持续更新、资源限制、人工验证码恢复流程。完成安装、active 或模拟测试通过，不能替代实际满额释放、释放后员工正常提单和长期稳定性验收。首次真实写入必须单独核对人数下降、旧占用消失与业务结果。

日常操作、验证码接管、pending 与故障排查见 [运维与故障处理](operations.md)。源码及接口顺序见 [代码导览](code-guide.md)。
