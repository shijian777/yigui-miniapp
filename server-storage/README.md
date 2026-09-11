# 丹姐小程序：独立存储服务安装包

这是服务器存储基础服务，不是完整的小程序改造版。原始小程序仍使用本地存储；安装本服务不会自动迁移、同步或改变现有账目。完成 HTTPS 域名、客户端接入和数据校验后才能正式共用服务器数据。

## 配置

- 目标服务器：instance-20260830-154059（安装时严格核对）。
- 默认监听：127.0.0.1:18473，仅服务器本机；不开放公网数据库。
- 服务：danjie-miniapp.service；用户：danjie-miniapp，无交互登录。
- 程序：/opt/danjie-miniapp；数据：/var/lib/danjie-miniapp/ledger.sqlite3。
- 配置和随机访问凭据：/etc/danjie-miniapp/storage.json。不要截图/分享该配置内容。
- 历史：保留最近 30 次成功写入，可读取旧版本并按当前版本条件写入恢复。
- 数据库备份：/var/backups/danjie-miniapp，每日自动在线备份、保留最近 14 份。它们仍在同一服务器，不替代异地备份。
- 服务资源上限：内存 256MB、CPU 25% 单核、8 个 HTTP 处理线程。
- 请求体最大 8MiB；需要更大数据量时应改成按单据存储，不能直接无限调高限制。

## 安装

在已登录的 Google 浏览器 SSH 右上方选择“上传文件”，上传 danjie-storage-18473.tar.gz 到用户主目录，然后执行：

```sh
(
set -e
mkdir -m 700 "$HOME/danjie-storage-18473-install"
tar -xzf "$HOME/danjie-storage-18473.tar.gz" -C "$HOME/danjie-storage-18473-install"
sudo sh "$HOME/danjie-storage-18473-install/install.sh"
)
```

第一次 mkdir 若提示目录已存在，停止并核实旧安装内容，不要直接覆盖。安装器也会在端口、账号、目录或服务名冲突时停止。

安装器仅使用现有 Python 3.10+ 和 SQLite 标准库，不安装/升级任何系统软件，不修改 Google 防火墙、主机防火墙或 Caddy，不重启其他服务。测试在临时数据库里进行；正式数据库只初始化空账目。安装后会验证新增服务重启、数据库备份，以及原有监听地址仍存在。

看到 `INSTALL_OK` 才表示服务器安装和检查成功；遇到 `INSTALL_STOPPED` 发错误信息排查，不要删除其他目录或放开防火墙。

## 接口

- GET /healthz：无凭据健康检查。
- GET /v1/state：获取账目快照、revision、稳定 storeId。
- PUT /v1/state：一次原子保存全部账目集合。必须携带 `If-Match: 当前revision` 和 `Idempotency-Key: 每个业务操作唯一ID`。
- GET /v1/history：列出保留的历史版本。
- GET /v1/history/数字版本：读取历史快照。
- /v1/ 下所有接口都需要 `Authorization: Bearer 随机凭据`。

PUT 内容格式：

```json
{"collections":{"goods":[],"customers":[],"suppliers":[],"sales_orders":[],"purchase_orders":[],"inventory_logs":[],"settings":[]},"sequence":0}
```

这是完整快照替换接口。客户端必须先拉取当前快照，在内存中完成合法业务变更，再以当前 revision 提交；不要把局部集合直接当完整快照发送。409 代表版本冲突，必须重新加载/合并并让业务确认，不能盲目覆写。网络不确定时重试必须复用原请求 ID 和原内容；凭据不应硬编码在发布的小程序源码中。

服务保证存储原子性、版本检查和网络重试幂等；不会自行修复商品编辑清库存、付款方式重置、对账公式等客户端业务缺陷。

## 查看状态与停止新服务

```sh
sudo systemctl status danjie-miniapp.service --no-pager
sudo cat /opt/danjie-miniapp/install-report.json
```

需要撤回运行时只停止新增单元，保留数据：

```sh
sudo systemctl disable --now danjie-miniapp.service danjie-miniapp-backup.timer
```

不要删除数据库或修改其他服务。恢复独立 SQLite 备份前应先停止新增服务并另存当前数据库及 WAL，具体恢复在核对目标文件后执行。

## 本地验证记录

测试代码 test_storage.py 通过真实 HTTP 和临时 SQLite 进行认证、读写、冲突、幂等、并发、异常输入、重启持久化及备份恢复检查。Windows 本机测试通过不等于 Linux systemd 已部署；服务器安装脚本会再次实测并给出安装报告。
