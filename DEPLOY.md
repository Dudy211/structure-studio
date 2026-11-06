# 部署到 GitHub Pages（含国内访问优化）

> **线上地址：https://dudy211.github.io/structure-studio/**
> 仓库：https://github.com/Dudy211/structure-studio
> 部署方式：GitHub Actions（`.github/workflows/pages.yml`）—— legacy 构建卡住过，Actions 稳得多

## 一、本地出包

```bash
# 1) 数据变了就先重建（贴图/模型/物品/版本表任一改动）
python3 tools/build_pack.py          # → data.pack.zip（运行时资源，~1MB）

# 2) 出站
bash tools/build_site.sh             # → dist/（1.9MB，只含运行时文件）
```

`dist/` 里就这些：

```
index.html  .nojekyll  data.pack.zip  data.pack.json
js/*.js  vendor/three.min.js
```

**不要把 `data/` 整个上传**：里面有 10MB+ 的构建中间产物
（`blocks-pc_*.json`、`models_1218.json`、`zh_cn.json`…），运行时一个都用不到。

## 二、推上 GitHub

```bash
cd dist
git init -b main
git add -A && git commit -m "structure studio"
git remote add origin git@github.com:<你>/<仓库>.git
git push -u origin main
```

Settings → Pages → Source 选 `Deploy from a branch` → `main` / `/ (root)`。
仓库里的 `.nojekyll` 必须留着（不然 Jekyll 会拖慢构建，还可能忽略下划线文件）。

## 三、为什么要打包成 zip

| | 原来 | 现在 |
|---|---|---|
| 请求数 | **161 个**（149 张实体贴图 + 12 个 json/png） | **1 个** `data.pack.zip` |
| 传输量 | 3.67 MB | **0.97 MB**（deflate，省 74%） |
| 冷启动 | 每个请求一次 RTT，国内尤其痛 | 一次 RTT |

页面启动时 `js/app.js` 的 `loadPack()` 会：
1. 同源拉 `data.pack.zip?v=N`
2. 用 `ModImport.readZip()`（DecompressionStream，无需第三方库）在浏览器里解包
3. JSON 直接 `JSON.parse`，PNG 转 blob URL（实体贴图路径自动替换）
4. **任何一步失败就自动退回逐个文件加载**（本地开发不用打包也能跑）

## 四、国内访问 GitHub Pages 的问题

github.io 在国内经常很慢/被干扰。代码里已经内置**多源回退**（`js/app.js` 顶部）：

```js
var CDN_BASES = [
  '',                                                    // 同源（GitHub Pages）
  'https://cdn.jsdelivr.net/gh/<user>/<repo>@main/',     // jsDelivr
  'https://gh-proxy.com/https://raw.githubusercontent.com/<user>/<repo>/main/'
];
```

按顺序试，谁先成功用谁。上传前把 `<user>/<repo>` 改成你的仓库。

另外几个建议：

1. **jsDelivr** 国内多数地区可用，且有全球缓存；但仓库要打 tag 才稳（`@main` 有 12h 缓存）。
   发版时 `@v1.0.0` 比 `@main` 更靠谱。
2. **Cloudflare Pages** 免费、国内比 github.io 稳，配置几乎一样（构建命令留空、输出目录 `dist`）。
   CNAME 到自己的域名 + Cloudflare 代理，效果最好。
3. 真给国内用户用，最省心还是**自己的服务器/OSS + CDN**，GitHub 只当源码仓库。
4. 首次加载后资源会被浏览器缓存；发新版只要把 `js/app.js` 里的
   `PACK_VER` 和 `index.html` 里的 `?v=` 一起 +1，用户就会拿到新包。

## 五、发版检查清单

- [ ] `python3 tools/build_pack.py`（数据有改动时必须）
- [ ] `js/app.js` 的 `PACK_VER` +1
- [ ] `index.html` 里 `app.js?v=` / `render.js?v=` / `modimport.js?v=` +1
- [ ] `bash tools/build_site.sh`
- [ ] 本地 `python3 -m http.server 8125 -d dist` 打开确认能进
- [ ] 推 `dist/` → 等 Pages 构建 → 手机开一次确认
