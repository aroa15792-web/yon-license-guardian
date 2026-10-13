# 公网只读状态 gateway

此模块不控制监控进程、不读取私有状态文件，也不读取浏览器会话。它在 `127.0.0.1:3105` 提供独立的只读首页，仅将 `GET /status` 转发到已有的状态 Unix socket。

外层 HTTPS Nginx 必须对 `/yon-license/` 和 `/yon-license/status` 同时启用 BasicAuth，并将这个前缀剥掉后转发至 gateway；`/yon-license` 应先跳转为带末尾斜线的 `/yon-license/`。例如 `proxy_pass http://127.0.0.1:3105/;` 的末尾斜线会完成前缀替换。认证凭据应由外层 Nginx 管理，gateway 不接收或转发用友凭据。

`index.html` 是现有脱敏状态页面的原样副本，启动时只从 gateway 自己的安装目录读取和严格校验。每次 GET 首页都生成新的随机 nonce 和严格 CSP，并将唯一的 `fetch('/status', {cache:'no-store',credentials:'omit',signal:abort.signal})` 改为 `fetch('./status', {cache:'no-store',credentials:'same-origin',signal:abort.signal})`，让同源刷新沿公网前缀继续使用外层登录保护。模板、替换数量、nonce 或大小合同不匹配时拒绝启动，不放宽 CSP。其它页面内容保持原样。

首页不请求 monitor。monitor 暂停维护或 socket 消失时，GET 首页仍为 200，可以随时打开；GET 状态返回明确的 503，页面显示连接中断、占用 `— / 10`，不会显示为零。socket 恢复后下一轮 15 秒刷新即可重新读取。这里的页面可访问不等于自动清理服务始终可用。

只接受精确的 GET `/` 和 `/status`；HEAD、POST、其它方法、查询参数、额外路径及 WebSocket 均拒绝。上游 Host 固定为 `127.0.0.1:19080`，客户端 Authorization、Cookie、Origin、转发头从不传入 Unix socket。响应只包含当前页面或严格验证过的既有脱敏 JSON；错误不会转成占用为零。每次读取最多 64 KiB、最多 5 秒，禁止缓存和转发上游 Cookie。

```bash
node --test deploy/public-viewer/gateway.test.mjs
node deploy/public-viewer/gateway.mjs
```

随附 systemd 模板使用与 monitor 相同的动态身份 `DynamicUser=yes, User=yon-license-login` 来连接异主不可读的 0700 目录及 0600 socket，并移除全部 capabilities。`gateway.mjs` 和 `index.html` 应单独安装在 `/opt/yon-license-public-viewer/`，原项目目录、私有状态、浏览器控制 socket 和凭据在 gateway 的文件系统视图中不可见。部署前必须实测两个服务的运行 UID 一致，并确认可读状态且不可读私有数据；不能为解决权限而开放 socket 给所有用户。

gateway 不声明 RuntimeDirectory、StateDirectory、Requires、BindsTo 或 PartOf，因此不会创建/清理 monitor 目录，也不会发起 monitor 重启。monitor 停止、socket 消失或登录验证期间状态不可读取时，公网页如实提示状态不可用；gateway 自身仍运行。当 socket 恢复可用，下一次 GET 状态即可重新读取。

由于共享 Unix UID，模板额外将 `/proc` 设为不可访问，并禁止 `kill`、`tkill`、`tgkill`、`pidfd_send_signal`、`ptrace`、`process_vm_readv`、`process_vm_writev`、`pidfd_getfd` 系统调用，限制访问 monitor 的文件系统视图、内存和信号。部署前必须在目标 systemd 和 Node 版本下实测：服务启动、GET 首页及状态、正常停止均可用；本地模拟测试不代表这些 Linux 沙箱选项已验收。

同时应确认 Node 的实际路径。模板展示 `/usr/bin/node`；如果服务器安装在 `/usr/local/bin/node`，只修改这个独立服务的 ExecStart。

模块和测试仅使用 Node.js 内置模块，不需要安装 npm 依赖。本地测试使用临时 Unix socket 与模拟脱敏响应，不连接用友、不触发清理。

## 部署到已有 HTTPS 网站

以下命令在已部署 monitor 的服务器执行，源码目录为当前仓库。需已配置有效 HTTPS 证书、Nginx 和 `htpasswd`，并确认 `/yon-license/` 与回环端口 3105 未被其它项目使用。示例按 Ubuntu 的 Nginx 用户组 `www-data` 编写，实际组名不同需相应调整。

```bash
test ! -e /opt/yon-license-public-viewer
test ! -e /etc/yon-license-public-viewer
sudo install -d -m 0755 /opt/yon-license-public-viewer
sudo install -m 0644 deploy/public-viewer/gateway.mjs deploy/public-viewer/index.html /opt/yon-license-public-viewer/
sudo install -m 0644 deploy/public-viewer/yon-license-public-viewer.service.example /etc/systemd/system/yon-license-public-viewer.service
sudo install -d -m 0750 -o root -g www-data /etc/yon-license-public-viewer
sudo htpasswd -cB -C 12 /etc/yon-license-public-viewer/viewers.htpasswd viewer
sudo chown root:www-data /etc/yon-license-public-viewer/viewers.htpasswd
sudo chmod 0640 /etc/yon-license-public-viewer/viewers.htpasswd
sudo systemd-analyze verify /etc/systemd/system/yon-license-public-viewer.service
sudo systemctl daemon-reload
sudo systemctl enable --now yon-license-public-viewer.service
curl --fail http://127.0.0.1:3105/status
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

访问 `https://YOUR_EXISTING_HTTPS_HOST/yon-license/`，在浏览器登录框使用自己的查看账号。未登录首页和状态都必须为 401，登录后均为 200，状态刷新请求应位于 `/yon-license/status`，其它操作路径与写入方法应拒绝。Nginx 将带 URI 的 `proxy_pass` 用于剥离前缀，并在转发前去掉认证与 Cookie，参见 [官方代理说明](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) 和 [BasicAuth 说明](https://nginx.org/en/docs/http/ngx_http_auth_basic_module.html)。

验收时核对 monitor 的 PID 和重启次数未变、已有网站入口正常。独立页面启用后不再依赖本机 SSH；后台状态暂时不可用时页面仍打开并显示不可用。网站证书续期由原 HTTPS 站点的既有机制管理。
