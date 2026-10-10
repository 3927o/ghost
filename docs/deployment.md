# 部署

从本机或 CI 运行，通过 SSH 更新 Linux 主机上的一个固定应用目录。

```sh
cp .deploy.env.example .deploy.env
chmod 600 .deploy.env
# 编辑 .deploy.env，填入目标配置。
npm run deploy                       # 当前 HEAD
npm run deploy -- --ref abc1234       # 指定提交，也支持标签或本地已有的分支引用
```

只发布已提交的内容；未提交的修改和未跟踪文件不会上传。`--ref` 在本地解析，不自动拉取远程分支。要恢复旧代码，再部署那个提交即可。

指定版本必须具备当前的 API/Worker 工作区、ORM 数据库适配及前端构建入口，脚本会在本地构建和连接服务器前检查。当前历史中，这套结构从 `e93f0e5` 开始；`9a3dcd6` 虽然已有 API/Worker，但仍只支持旧的 SQLite 配置，更早的单体架构也不支持。跨架构或数据库格式的迁移需单独处理，`--ref` 不负责转换运行配置和数据。

## 配置与首次准备

`.deploy.env` 被 Git 忽略，环境变量可以覆盖其中的值。只需要四项配置，示例全部使用通用值：

| 变量 | 含义 |
| --- | --- |
| `DEPLOY_HOST` | SSH 别名或 `user@host`；端口、密钥等放在 SSH 配置中 |
| `DEPLOY_PATH` | 应用专用的绝对目录，例如 `/srv/application` |
| `DEPLOY_SERVICES` | 空格分隔的 systemd 服务名，包含 API 和 Worker |
| `DEPLOY_HEALTH_URL` | 从服务器访问的 HTTP/HTTPS 健康接口 |

本机需要 Node.js 24+、npm、Git、tar、SSH。服务器需要 Node.js 24+、npm、tar、curl、flock、systemd，以及原生依赖需要的编译工具。Node.js 和 npm 应在非交互 SSH 会话的 PATH 中。SSH 密钥和已验证的 known_hosts 需提前准备。

服务器目录结构如下，文件都在应用自己的目录里：

```text
/srv/application/
  .env
  data/
  apps/
  packages/
  dist/web/
  node_modules/
  package.json
  package-lock.json
  .deploy-commit
  .deploy.lock
```

首次部署前创建应用账户、应用目录、`.env` 和 `data/`，让应用账户可以读取 `.env`、写入 `data/`；建议配置文件权限为 `0600`。部署账户需要能更新代码、安装依赖，并控制对应服务。

调整 [systemd 模板](../scripts/deploy/application@.service.example) 的账户、路径和 Node.js 路径，安装为 `application@.service`，执行 `daemon-reload` 并启用 `application@api.service` 和 `application@agent-worker.service`。非 root 部署通过 `sudo -n systemctl` 操作，需要预先配置相应权限。

静态服务指向 `<应用目录>/dist/web`，将 `/api/*` 反向代理到 API 监听端口，并支持 SSE。服务与反向代理的配置只在首次准备或配置变化时调整。

## 每次部署做什么

1. 从指定 Git 提交导出代码，在本机临时目录执行 `npm ci --include=dev`、`npm run build:web`。
2. 上传源码、包清单、锁文件和前端产物。运行配置、本机依赖和数据不在上传范围内。
3. 服务器获取部署锁，解包后停止 API 和 Worker，只替换 `apps`、`packages`、`dist`、`package.json`、`package-lock.json`。
4. 在应用目录执行 `npm ci --omit=dev`，启动服务，分别检查所有服务及 HTTP 健康接口。

`.env` 和 `data` 始终原地保留，没有软链接，也不会从本机上传。保留它们靠的是明确限定更新范围；Git 的忽略规则本身并不能保护服务器上的文件。`.deploy-commit` 记录已经写入目录的代码提交，不代表健康检查一定通过。

部署期间会短暂停机，Worker 停止时会取消当前任务。失败会返回非零状态并显示命令诊断；更新开始后的失败可能使服务保持停止或异常状态，需要修复后重试，或用 `--ref` 部署旧提交。没有版本目录和自动回滚；重新部署旧代码也不会回退数据库。健康检查覆盖进程状态和 HTTP 接口，不调用模型。

## GitHub Actions

准备代码、Node.js、SSH 密钥与 known_hosts 后，使用相同入口。部署脚本及辅助文件需要先提交到 Git，CI 才能检出它们。

```yaml
- name: Deploy
  run: npm run deploy
  env:
    DEPLOY_HOST: ${{ secrets.DEPLOY_HOST }}
    DEPLOY_PATH: ${{ secrets.DEPLOY_PATH }}
    DEPLOY_SERVICES: ${{ secrets.DEPLOY_SERVICES }}
    DEPLOY_HEALTH_URL: ${{ secrets.DEPLOY_HEALTH_URL }}
```

目标信息只放在忽略文件或 CI Secrets 中。脚本输出常规构建和安装诊断，应用日志通过 systemd journal 查看。`npm run test:deploy` 在临时目录中验证部署脚本，不连接实际服务器。
