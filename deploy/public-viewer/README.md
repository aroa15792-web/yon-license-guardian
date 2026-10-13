# 公网只读状态 gateway

此模块不控制监控进程、不读取监控服务的私有状态文件，也不读取浏览器会话。它在 `127.0.0.1:3105` 提供独立的只读运行看板，将 `GET /status` 转发到已有的状态 Unix socket，并从同一脱敏接口持续采集运行记录，供 `GET /events` 展示。

外层 HTTPS Nginx 必须对整个 `/yon-license/` 前缀启用 BasicAuth，包括首页、`status` 和 `events`，并将这个前缀剥掉后转发至 gateway；`/yon-license` 应先跳转为带末尾斜线的 `/yon-license/`。例如 `proxy_pass http://127.0.0.1:3105/;` 的末尾斜线会完成前缀替换。认证凭据应由外层 Nginx 管理，gateway 不接收或转发用友凭据。

`index.html` 是 gateway 自己的静态页面，启动时只从自己的安装目录读取和严格校验。每次 GET 首页都生成新的随机 nonce 和严格 CSP，并将唯一的 `fetch('/status', {cache:'no-store',credentials:'omit',signal:abort.signal})` 改为 `fetch('./status', {cache:'no-store',credentials:'same-origin',signal:abort.signal})`，让同源刷新沿公网前缀继续使用外层登录保护。日志直接请求相对路径 `./events`，同样使用已有查看账号。模板、替换数量、nonce 或大小合同不匹配时拒绝启动，不放宽 CSP。

首页不请求 monitor。monitor 暂停维护或 socket 消失时，GET 首页仍为 200，可以随时打开；GET 状态返回明确的 503，页面显示连接中断、占用 `— / 10`，不会显示为零。socket 恢复后下一轮 15 秒刷新即可重新读取。这里的页面可访问不等于自动清理服务始终可用。

只接受精确的 GET `/`、`/status` 和 `/events`；HEAD、POST、其它方法、查询参数、额外路径及 WebSocket 均拒绝。上游 Host 固定为 `127.0.0.1:19080`，客户端 Authorization、Cookie、Origin、转发头从不传入 Unix socket。响应只包含当前页面或严格验证过的脱敏 JSON；错误不会转成占用为零。每次读取最多 64 KiB、最多 5 秒，禁止缓存和转发上游 Cookie。

## 运行记录

采集器由此 gateway 服务常驻运行，每 15 秒读取一次已有脱敏状态接口，不依赖查看页是否打开。监控服务自身仍每 60 秒检查许可；采集器对原检查时间与状态去重，记录每个观察到的新检测结果。它不会调用许可清理、登录或浏览器控制接口。

- 记录全部采集到的检测结果、自动清理核验、暂停、停止、连接异常与恢复，以及状态过期与恢复。
- 人工测试使用独立来源与原测试时间，页面标为手动测试，不算作自动清理。
- 日志从首次启用采集开始产生，不补造过去的检测记录；短于采集间隔的中间状态可能不会被观察到。这是脱敏状态快照日志，不是底层每个请求的完整审计日志。
- 保留最近 24 小时、最多 2000 条，接口返回最新 200 条。页面支持检测、清理、异常与手动测试筛选，筛选只针对返回的这些记录。
- 仅保存白名单状态、计数、时间和采集器生成的标识；不保存账号、人员名单、企业标识、密码、Cookie 或原始错误。详细暂停原因仍需管理员按运维手册核对。
- 记录在专属状态目录中持久化，正常重启后保留并去重。目录 0700、文件 0600，拒绝不安全权限、符号链接、超大或损坏记录；写入失败时日志接口显示不可用，不把它当作空日志，也不覆盖损坏文件。

页面的状态与日志独立刷新，日志不可用不代表监控已经停止。状态超过 180 秒未更新时按过期展示，占用人数显示 `—`。所有筛选和刷新都是只读操作。

```bash
node --test deploy/public-viewer/*.test.mjs
node deploy/public-viewer/gateway.mjs
```

随附 systemd 模板使用与 monitor 相同的动态身份 `DynamicUser=yes, User=yon-license-login` 来连接异主不可读的 0700 目录及 0600 socket，并移除全部 capabilities。`gateway.mjs`、三个 `event-*.mjs` 模块和 `index.html` 单独安装在 `/opt/yon-license-public-viewer/`，原项目目录、监控私有状态、浏览器控制 socket 和凭据在 gateway 的文件系统视图中不可见。部署前必须实测两个服务的运行 UID 一致，并确认可读状态且不可读监控私有数据；不能为解决权限而开放 socket 给所有用户。

gateway 只声明自己专属的 `StateDirectory=yon-license-public-viewer` 来保存脱敏运行记录，不声明 monitor 的 RuntimeDirectory 或 StateDirectory，也没有 Requires、BindsTo 或 PartOf 关系，因此不会创建/清理 monitor 目录或发起 monitor 重启。monitor 停止、socket 消失或登录验证期间状态不可读取时，公网页如实提示状态不可用；gateway 自身仍运行。当 socket 恢复可用，下一次 GET 状态即可重新读取。

由于共享 Unix UID，模板额外将 `/proc` 设为不可访问，并禁止 `kill`、`tkill`、`tgkill`、`pidfd_send_signal`、`ptrace`、`process_vm_readv`、`process_vm_writev`、`pidfd_getfd` 系统调用，限制访问 monitor 的文件系统视图、内存和信号。部署前必须在目标 systemd 和 Node 版本下实测：服务启动、GET 首页及状态、正常停止均可用；本地模拟测试不代表这些 Linux 沙箱选项已验收。

同时应确认 Node 的实际路径。模板展示 `/usr/bin/node`；如果服务器安装在 `/usr/local/bin/node`，只修改这个独立服务的 ExecStart。

模块和测试仅使用 Node.js 内置模块，不需要安装 npm 依赖。本地测试使用临时 Unix socket 与模拟脱敏响应，不连接用友、不触发清理。

## 部署到已有 HTTPS 网站

以下命令在已部署 monitor 的服务器执行，源码目录为当前仓库。需已配置有效 HTTPS 证书、Nginx 和 `htpasswd`，并确认 `/yon-license/` 与回环端口 3105 未被其它项目使用。示例按 Ubuntu 的 Nginx 用户组 `www-data` 编写，实际组名不同需相应调整。

```bash
test ! -e /opt/yon-license-public-viewer
test ! -e /etc/yon-license-public-viewer
sudo install -d -m 0755 /opt/yon-license-public-viewer
sudo install -m 0644 deploy/public-viewer/gateway.mjs deploy/public-viewer/event-contract.mjs deploy/public-viewer/event-store.mjs deploy/public-viewer/event-collector.mjs deploy/public-viewer/index.html /opt/yon-license-public-viewer/
sudo install -m 0644 deploy/public-viewer/yon-license-public-viewer.service.example /etc/systemd/system/yon-license-public-viewer.service
sudo install -d -m 0750 -o root -g www-data /etc/yon-license-public-viewer
sudo htpasswd -cB -C 12 /etc/yon-license-public-viewer/viewers.htpasswd viewer
sudo chown root:www-data /etc/yon-license-public-viewer/viewers.htpasswd
sudo chmod 0640 /etc/yon-license-public-viewer/viewers.htpasswd
sudo systemd-analyze verify /etc/systemd/system/yon-license-public-viewer.service
sudo systemctl daemon-reload
sudo systemctl enable --now yon-license-public-viewer.service
curl --fail http://127.0.0.1:3105/status
curl --fail http://127.0.0.1:3105/events
```

`htpasswd` 会交互要求设置独立查看密码，勿复用用友或服务器密码。`-c` 仅用于首次创建，已有文件时不要使用，以免覆盖现有用户。

```bash
test ! -e /etc/nginx/snippets/yon-license-public-viewer.conf
test ! -e /etc/nginx/conf.d/yon-license-public-viewer-rate-limit.conf
sudo install -m 0644 deploy/public-viewer/nginx-location.conf.example /etc/nginx/snippets/yon-license-public-viewer.conf
sudo install -m 0644 deploy/public-viewer/nginx-rate-limit.conf.example /etc/nginx/conf.d/yon-license-public-viewer-rate-limit.conf
```

备份当前网站配置，在目标 **HTTPS 的 server 块**中只增加下面这行，不改已有路由或证书。全局速率配置必须位于 `http` 上下文；通常 `/etc/nginx/conf.d/` 已由主配置在该上下文加载，须自行核实。

```nginx
include /etc/nginx/snippets/yon-license-public-viewer.conf;
```

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl is-enabled yon-license-public-viewer.service
sudo systemctl is-active yon-license-public-viewer.service
```

访问 `https://YOUR_EXISTING_HTTPS_HOST/yon-license/`，在浏览器登录框使用自己的查看账号。未登录首页、状态和日志都必须为 401，登录后均为 200；刷新请求应位于 `/yon-license/status` 与 `/yon-license/events`，其它操作路径与写入方法应拒绝。Nginx 将带 URI 的 `proxy_pass` 用于剥离前缀，并在转发前去掉认证与 Cookie，参见 [官方代理说明](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) 和 [BasicAuth 说明](https://nginx.org/en/docs/http/ngx_http_auth_basic_module.html)。

验收时核对 monitor 的 PID 和重启次数未变、已有网站入口正常。独立页面启用后不再依赖本机 SSH；后台状态暂时不可用时页面仍打开并显示不可用。网站证书续期由原 HTTPS 站点的既有机制管理。

## 升级已有公网查看页

备份本模块安装目录与 systemd 单位，保留 `/var/lib/yon-license-public-viewer/` 的日志，不改动 monitor、Nginx 原有路由、证书或查看账号。先在源码目录运行本模块测试，再安装上述五个运行文件和新的独立服务模板；随后只对 `yon-license-public-viewer.service` 执行 `daemon-reload` 与重启。没有启用监控私有目录的读取权限，也不需要重启 monitor。

升级后等待首次采集，核对 `/events` 有新检测记录，重启此查看服务后记录仍在且同一检查未重复增加。不要通过删除损坏日志绕过错误；先备份并由管理员核查本模块专属状态目录。`node deploy/public-viewer/gateway.mjs` 直接启动时若没有 systemd 提供的状态目录，日志接口不可用，首页和实时状态仍可读取。
