# AutoTransformation 部署状态（2026-10-26）

## 现在的访问方式

平板/电脑直接打开：

```text
https://iz7xv11pgdwzf7rz8y7loiz.tail6020bc.ts.net/
```

首次打开需要带访问令牌：

```text
https://iz7xv11pgdwzf7rz8y7loiz.tail6020bc.ts.net/?token=<ACCESS_TOKEN>
```

完整带令牌的地址已经配置在平板 App 的「服务器」里，本地备份在：

```text
C:\Users\Philip\Documents\AutoTransformation\.cloud-access
```

服务端令牌在 `/opt/autotransformation/.env` 的 `ACCESS_TOKEN`。

**平板不再需要打开 Tailscale。** 公网入口走 Tailscale Funnel，平板只走普通 HTTPS。

## 架构

```text
平板/电脑
  → https://iz7xv11pgdwzf7rz8y7loiz.tail6020bc.ts.net/   (Tailscale Funnel, HTTPS)
  → http://127.0.0.1:8787                               (服务器本机 Node)
  → DeepSeek API
```

- 服务器：阿里云轻量，Ubuntu 24.04，Node 22
- 代码：`/opt/autotransformation`
- 服务：`autotransformation.service`，只监听 `127.0.0.1:8787`
- Tailscale：仅服务器端需要，用于 Funnel；平板不需要
- Funnel：`tailscale funnel --bg http://127.0.0.1:8787`
- 公网 80/8787 没有直接监听；所有公网流量从 Funnel 443 进来

## 认证

- 服务端 `ACCESS_TOKEN` 非空时启用令牌认证
- 首次访问 `/?token=...`：服务端写入 HttpOnly cookie，然后 303 跳转到无令牌地址
- API 也接受 `x-access-token` 或 `Authorization: Bearer ...`
- 无令牌：页面 401，API 401
- 已加回归测试：`tests/auth.test.js`；目前 `npm test` 36 项全过

## 电子书（2026-10-26 新增）

- 右上角「电子书」进入独立书架，不影响原来的单页翻译流程
- 新建时一次选多张书页；Android 文件选择器已按 `multiple` 打开多选
- 服务端按上传顺序逐页 OCR + 翻译，队列串行，避免并发打满模型接口
- 书架显示封面、页数、进度；新建时按书名从 Douban 匹配真实封面并保存到服务器，匹配不到则生成带书名/作者的排版封面
- 旧书可通过 `POST /api/ebooks/:id/cover` 回填封面；当前《Pride and Prejudice》已回填真实封面
- 阅读器全屏只显示 OCR 英文；底部留白已压缩，文字自动放大铺满可用高度
- 阅读器不上下滚动：装不下的文字分到下一屏；每张新书页和 `Chapter 1` 这类篇章页都另起一屏
- 右下角「中文 / English」切换译文，切换后保持当前书页/段落位置，不跳回页首
- 左右滑动翻页，带 3D 书页翻转动画；无页码、无原图、无上一页/下一页按钮
- 阅读位置记录 `lastPage + lastPart`，重新打开能回到上次的分页
- Android 阅读模式会隐藏原生顶栏和系统栏，返回键回到书架
- 书架卡片「＋ 书页」可继续导入；失败页在正文里直接重试；整本完成显示「已完成」
- 数据：`data/ebooks.json`，原图：`data/ebooks/<bookId>/`
- 实测：平板导入一张真实排版书页，OCR 与译文正确，状态 `done`
- 平板 APK 已重装，原生顶栏有「电子书」按钮，多选文件选择器已生效
- 测试书已删除，未触碰其他已有电子书；封面截图见 `docs/at-cover-final.png`，阅读截图见 `docs/at-spacing.png`

## 已验证

- 平板 Tailscale 关闭，App 仍能打开 Funnel 首页
- 平板翻译示例：2 段 / 71 词
- `want` 语境义：`n.（旧义/正式）需要，缺少`
- 生词本自动新增 1 条，截图见 `docs/at-funnel-final.png`
- 无令牌访问 401，带令牌页面/API 200
- 电子书真实书页 OCR/翻译成功；封面匹配与分页阅读截图见 `docs/at-cover-final.png`、`docs/at-spacing.png`
- 封面源测试：Douban 成功，未知书名会生成 SVG 备用封面

## 常用命令

```bash
# 服务
systemctl status autotransformation --no-pager
systemctl restart autotransformation
journalctl -u autotransformation -n 50 --no-pager

# Funnel
tailscale funnel status
tailscale funnel --bg http://127.0.0.1:8787
tailscale funnel --https=443 off   # 关闭公网入口

# 证书（Funnel TLS 续期失败时）
tailscale cert iz7xv11pgdwzf7rz8y7loiz.tail6020bc.ts.net

# SSH
ssh -i C:\Users\Philip\.ssh\at_cloud root@8.138.184.0
```

## 注意

- Funnel 地址依赖 tailnet 节点名；如果改了机器名，地址会变。
- 令牌如果泄露：改服务器 `.env` 的 `ACCESS_TOKEN`，重启服务，然后重新用新 token 打开一次 App。
- 当前平板 Tailscale 已关闭，Always-on VPN 已清除；Tailscale App 还装着，但不再需要。
- 仓库源码默认地址仍是 `127.0.0.1:8787`；平板当前安装的 App 里保存的是 Funnel 地址 + token，重装 App 后需要重新填。
- 复习提醒的 `PUSH_URL`/systemd timer 仍未配置，需要 webhook 后再加。
- DeepSeek Key 在服务器 `.env`，建议抽空轮换。
