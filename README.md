# ZOG 传奇模式 · 网页版

纯静态站点（零依赖、无后端），数据包与前端一起发布。

## 目录

- `app/` —— 正式页：`index.html` / `app.js` / `styles.css`
- `assets/data/` —— 数据包三层：`pool.json`（候选池）→ `segments.json`（段汇总）→ `races/s*.json`（逐场明细）
- `index.html`（根）—— 只是跳转到 `app/`

## 本地预览

浏览器禁止 `file://` 下的 fetch，必须经 HTTP 起：

```bash
python3 -m http.server 8000
# 然后打开 http://localhost:8000/app/
```

## 发布

GitHub Pages 源设为 `main / (root)`，站点地址为 `https://<用户名>.github.io/<仓库名>/`。

## 更新

在源码仓库改完后，跑 `python3 tools/sync_site.py` 同步到本目录，再提交推送。
改过 `app.js` / `styles.css` 记得把 `app/index.html` 里的 `?v=` 缓存号加一。
