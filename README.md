# 喵喵结构工坊 · Structure Studio

在**手机浏览器**里搭 Minecraft 建筑，直接导出 `.nbt` 结构文件。

纯静态网页，无后端、无构建步骤，丢到 GitHub Pages / Cloudflare Pages 就能用。

## 功能

- **3D 放置 / 删除 / 框选**：自由轨道相机（可仰视）、左上角 3D 方向指示（点一下回正）、
  内壁网格、长按框选后批量填充或清除
- **导入**：`.nbt` 原版结构 / `.litematic` 投影 / `.schem` WorldEdit 原理图，必要时自动扩尺寸
- **透视**：不做内部剔除，所有方块所有面都画出来
- **1013 种方块**（1.13 → 1.21.8 共 16 个版本，各自独立的方块清单）
- **真实模型渲染**：从原版 jar 的 blockstate → model → parent 链算出几何（楼梯、台阶、栅栏、告示牌、床、箱子…）
- **自动形态**：半砖点顶/底、楼梯朝向、原木轴向、栅栏连接、告示牌贴墙——按你点的那一面自动选状态
- **变体合并**：羊毛/地毯/混凝土/陶瓦/玻璃/床/旗帜/蜡烛/潜影盒… 16 色并成一格，箭头展开
- **分类**：建筑 / 自然 / 装饰 / 功能 / 红石 / 其他 / 调试 + 实体 / 物品库
- **实体模式**：62 种生物，导入后可直接摆进结构（导出会写进 `entities`）
- **物品库**：294 → 496 个纯物品（含 83 个刷怪蛋，按生物贴图平均色染色），只读查看 + 抄 id
- **模组导入**：选一个 mod 的 `.jar`，浏览器里解压 → 解析 blockstates/models/lang/贴图 → 进「模组」页签，可直接放置
- **导出三种格式**：
  - `.nbt` 原版结构（结构方块 / 数据包），可选结构空位填充
  - `.litematic` Litematica 投影（自动裁剪到包围盒，带实体）
  - `.schem` WorldEdit / FAWE 原理图（Sponge v2，`//paste` 直接粘贴）

## 快速开始

```bash
# 本地跑（不需要打包也能跑，会逐个文件加载）
python3 -m http.server 8124

# 出正式站
python3 tools/build_pack.py     # 运行时资源 → data.pack.zip（1 个请求，~1MB）
bash tools/build_site.sh        # → dist/
```

然后打开 `dist/` 里的 `index.html`（或者用 http 服务器跑 `dist/`）。

部署到 GitHub Pages 见 [DEPLOY.md](DEPLOY.md)。

## 目录

```
index.html          页面（单页，样式内联）
js/app.js           主逻辑：UI、放置/删除、分类、物品库、模组导入
js/render.js        WebGL 渲染器（InstancedMesh 立方体 + 合并模型层 + 拾取）
js/modelmesh.js     模型几何 → BufferGeometry
js/entity.js        实体模型构建
js/voxel.js         世界数据（方块 + 实体 + 撤销栈）
js/nbt.js           NBT 读写（结构文件格式）
js/modimport.js     模组 jar 解析（zip + 模型转换），挂 window.ModImport
tools/              构建脚本（贴图/模型/物品/打包/出站）
data/               构建产物（运行时只用打包后的 data.pack.zip）
```

## 数据从哪来

全部来自**正版客户端 jar**（`cache/jar/1.20.1`、`1.21.8`）：
方块注册表与贴图、blockstate/model JSON、实体模型与皮肤、物品图标、语言文件。
`tools/` 下每个脚本都可以离线重跑。

> 本项目只做编辑与导出，不包含任何游戏代码；贴图版权归 Mojang 所有，仅供个人建筑创作使用。
