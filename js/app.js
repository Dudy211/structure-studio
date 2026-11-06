/*
 * app.js — 喵喵结构工坊 主程序
 * 纯静态、无构建；依赖全局 window.THREE / window.NBT / window.VoxelWorld / window.VoxelRenderer
 * 语法基线：ES2017（不使用可选链 / 空值合并 / flatMap / replaceAll / structuredClone）
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- 常量
  var LS_KEY = 'yuneko-structure-studio'; // localStorage 存档键
  var SIZES = [16, 32, 48, 64];            // 可选世界尺寸
  var ATLAS_VER = '66';                     // atlas.png 变更时 +1，绕过缓存
  var ENT_VER = '49';                        // entities/entity_assets 重建时 +1（否则浏览器吃缓存）
  var ITEM_VER = '2';                        // items.json / item_atlas 变更时 +1
  var PAGE = 120;                          // 方块库每批渲染数量（避免一次性 1000+ DOM）
  var DRAG_PX = 8;                         // 拖拽判定阈值（px）
  // 三个「穿透」可控的特殊方块
  var SPECIAL_NAMES = { barrier: 1, structure_void: 1, light: 1 };
  var TAP_MS = 550;                        // tap 判定时长（ms），要 > LONG_MS 才不会有空档
  var LONG_MS = 600;                       // 长按判定时长（ms）
  var DENSITY = 0.85;                      // 方块数上限 = 体积 * 0.85
  // 两格高的方块：放一个自动补上半（游戏里本来就是两个方块）
  var TALL_BLOCKS = {
    tall_grass: 1, large_fern: 1, lilac: 1, rose_bush: 1, peony: 1, sunflower: 1,
    tall_seagrass: 1, pitcher_plant: 1, pitcher_crop: 1, small_dripleaf: 1
  };

  // 分类规则（按 n 关键词，顺序即优先级，先匹配先生效；都不匹配 = 其他）
  // 归类逻辑对照 MC 1.20 创造模式标签页（我们只有「方块」，所以映射成 6 类）：
  //   红石  ← Redstone Blocks（红石元件/机器/活塞/按钮/拉杆/压力板/红石粉/火把/铁轨/TNT）
  //   功能  ← Function 等（箱子/熔炉/工作台/门/活板门/栅栏/酿造/命令方块/结构方块/光/屏障…）
  //   装饰  ← Decoration Blocks（玻璃/羊毛/地毯/旗帜/告示牌/灯/花/头/珊瑚/床/铁栏杆）
  //   自然  ← Nature（草/土/树叶/树苗/蘑菇/藤蔓/藻类/海绵/盆栽/发光地衣/竹/作物）
  //   建筑  ← Building Blocks（石头/砖/混凝土/陶瓦/沙岩/石英/紫颂/下界岩/铜/木板/原木/半砖/楼梯）
  // 分类标签（顺序 = 物品栏按钮顺序）—— 归类规则见下面的 CAT_RULES。
  // 对照 MC 1.20 创造模式标签页（我们只有「方块」，映射成 6 类）：
  //   建筑 ← Building Blocks    自然 ← Natural Blocks     装饰 ← Decoration Blocks
  //   功能 ← Functional Blocks  红石 ← Redstone Blocks    其他 ← 兜底
  // 「调试」按用户要求排最后；「实体」特殊（列表来自 data/entity_assets.json）
  var CATS = [
    { id: 'all',      cn: '全部' },
    { id: 'building', cn: '建筑' },
    { id: 'nature',   cn: '自然' },
    { id: 'decor',    cn: '装饰' },
    { id: 'func',     cn: '功能' },
    { id: 'redstone', cn: '红石' },
    { id: 'other',    cn: '其他' },
    { id: 'command',  cn: '调试' },
    { id: 'entity',   cn: '实体' },
    { id: 'mod',      cn: '模组' }   // 导入模组后才出现
  ];

  // 归类规则（★顺序即优先级，先匹配先生效；都不匹配 = 其他）
  // 注意：自然规则必须排在「建筑形状」前面，但要把木头类关键词排除掉
  //       （bamboo_planks 是建筑、crimson_stem 是木头而不是植物茎）。
  var FLOWER_RE = 'dandelion|poppy|blue_orchid|allium|azure_bluet|(red|orange|white|pink)_tulip|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|sunflower|lilac|rose_bush|peony|pink_petals|^torchflower$|^pitcher_plant$|spore_blossom';
  var CAT_RULES = [
    // 红石元件（MC Redstone Blocks）
    { id: 'redstone', re: new RegExp('^(redstone|redstone_block|redstone_lamp|redstone_torch|redstone_wire|repeater|comparator|observer|target|daylight_detector|lever|tripwire|tripwire_hook|tnt|note_block|jukebox|dropper|dispenser|hopper|piston|sticky_piston|piston_head|moving_piston|slime_block|honey_block|rail|powered_rail|detector_rail|activator_rail|lightning_rod|sculk_sensor|calibrated_sculk_sensor|sculk_shrieker|sculk_catalyst|end_portal_frame|crafter|vault|heavy_core)$|(_button|_pressure_plate|_rail)$') },
    // 调试方块（用户要求单独一类，排最后）
    { id: 'command',  re: /^(command_block|chain_command_block|repeating_command_block|structure_block|jigsaw|barrier|structure_void|light|debug_stick|test_block|test_instance_block)$/ },
    // 功能方块（MC Functional Blocks：容器 / 工作站 / 门 / 栅栏 / 酿造 …）
    { id: 'func',     re: new RegExp('((^|_)(chest|barrel|furnace|smoker|blast_furnace|crafting_table|anvil|enchanting_table|beacon|ladder|cauldron|brewing_stand|grindstone|cartography_table|smithing_table|stonecutter|loom|fletching_table|lectern|composter|campfire|lodestone|respawn_anchor|conduit|spawner|bell|bookshelf|scaffolding|hopper)|cake|_door|_trapdoor|_fence|_fence_gate)') },
    // 装饰（MC Decoration Blocks：玻璃 / 羊毛 / 地毯 / 旗帜 / 告示牌 / 灯 / 花 / 头 / 珊瑚 / 床）
    { id: 'decor',    re: new RegExp('(_glass|_glass_pane|^glass$|^glass_pane$|tinted_glass|_wool|(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_carpet|_banner|_sign|_hanging_sign|flower_pot|(^|_)candle|lantern$|(^|_)torch$|froglight|end_rod|cobweb|eyeblossom|wildflowers|_head$|_skull$|painting|item_frame|decorated_pot|coral|sea_lantern|glowstone|iron_bars|chain|_bed|shulker_box|' + FLOWER_RE + ')') },
    // 自然（MC Natural Blocks）—— 木头的 _stem/_block 不在关键词里，避免误收
    { id: 'nature',   re: /(_leaves|_sapling|propagule|fern|grass|dirt|podzol|mycelium|mud(?!_brick)|farmland|_roots|moss_block|moss_carpet|vine$|_vines|kelp|seagrass|sponge|azalea|sweet_berry|sculk|dead_bush|bush|leaf_litter|creaking_heart|resin_clump|pale_hanging_moss|lily_pad|^bamboo$|melon|pumpkin|_crop|beetroots|carrots|potatoes|wheat|cocoa|glow_lichen|mushroom|fungus|nylium|soul_sand|soul_soil|nether_sprouts|nether_wart|wart_block|dripleaf|spore_blossom|cactus|sugar_cane|frogspawn|turtle_egg|sniffer_egg|hay_block|bee_nest|beehive|clay|ice|snow|chorus|dragon_egg|sea_pickle|pointed_dripstone|(melon|pumpkin|dripleaf)_stem)/ },
    // 建筑（先按「形状后缀」收，再按材质关键词兜底）
    { id: 'building', re: /^(?!.*(melon_stem|pumpkin_stem|dripleaf_stem)$).*(_planks|_slab|_stairs|_wall|_fence|_fence_gate|_door|_trapdoor|_log|_wood|_hyphae|_stem|_bricks|_mosaic|_block|_ore|_concrete|_concrete_powder|_terracotta|_glazed_terracotta)$/ },
    { id: 'building', re: /(stone|brick|concrete|terracotta|sandstone|quartz|prismarine|purpur|deepslate|blackstone|tuff|copper|obsidian|netherite|end_stone|amethyst|granite|diorite|andesite|calcite|basalt|glass|bedrock|dripstone|netherrack|magma|shroomlight|ancient_debris|sand$|gravel|bone_block)/ }
  ];

  // 物品库分类（照 MC 创造模式标签页）
  var ITEM_CATS = [
    { id: 'all',         cn: '全部' },
    { id: 'building',    cn: '建筑' },
    { id: 'nature',      cn: '自然' },
    { id: 'decor',       cn: '装饰' },
    { id: 'func',        cn: '功能' },
    { id: 'redstone',    cn: '红石' },
    { id: 'tools',       cn: '工具' },
    { id: 'combat',      cn: '战斗' },
    { id: 'food',        cn: '食物' },
    { id: 'ingredients', cn: '材料' },
    { id: 'eggs',        cn: '刷怪蛋' }
  ];
  // 纯物品归类（方块物品直接用方块分类）
  var ITEM_CAT_RULES = [
    { id: 'eggs', re: /_spawn_egg$/ },
    { id: 'combat', re: /(_helmet|_chestplate|_leggings|_boots|_sword|shield|bow|crossbow|arrow|trident|totem_of_undying|elytra)$/ },
    { id: 'tools', re: /(_pickaxe|_axe|_shovel|_hoe|shears|flint_and_steel|fishing_rod|carrot_on_a_stick|warped_fungus_on_a_stick|brush|spyglass|compass|clock)$/ },
    { id: 'food', re: /^(apple|golden_apple|enchanted_golden_apple|bread|porkchop|cooked_porkchop|beef|cooked_beef|chicken|cooked_chicken|mutton|cooked_mutton|rabbit|cooked_rabbit|cod|cooked_cod|salmon|cooked_salmon|tropical_fish|pufferfish|potato|baked_potato|poisonous_potato|carrot|golden_carrot|beetroot|beetroot_soup|melon_slice|sweet_berries|glow_berries|cookie|cake|pumpkin_pie|mushroom_stew|rabbit_stew|suspicious_stew|honey_bottle|dried_kelp|kelp|chorus_fruit|rotten_flesh|spider_eye|fermented_spider_eye|milk_bucket)$/ },
    { id: 'ingredients', re: /(ingot|nugget|diamond|emerald|coal|charcoal|lapis_lazuli|quartz|amethyst_shard|redstone|glowstone_dust|gunpowder|stick|string$|feather|flint|leather|paper|book|slime_ball|blaze_rod|blaze_powder|ghast_tear|magma_cream|nether_wart|sugar|rabbit_foot|rabbit_hide|phantom_membrane|dragon_breath|shulker_shell|nautilus_shell|heart_of_the_sea|prismarine_shard|prismarine_crystals|ink_sac|dye|clay_ball|brick|netherite_scrap|echo_shard|disc_fragment|scute|goat_horn|bowl|glass_bottle|bone|honeycomb|wheat|seeds|bucket|egg)/ }
  ];

  // 「特殊 NBT 形态」：只靠 NBT/机制出现、正常拿不到的方块，物品栏里隐藏（但仍能通过
  // 状态面板 / NBT 编辑调出来）。命令方块 / 结构方块 / 拼图 / 屏障 / 光 等调试方块不在这里 —— 保留。
  // 贴墙形态（*_wall_*）由放置逻辑（见 pickStateVariant）按点击面自动切换，所以只留「立着的」。
  var HIDDEN_FROM_LIB = [
    /_wall_sign$/, /_wall_hanging_sign$/, /_wall_banner$/,
    /_wall_head$/, /_wall_skull$/, /_coral_wall_fan$/,
    /^potted_/,          // 花盆内容物（flower_pot 变体组已合并，保留 flower_pot 本身）
    /^piston_head$/,     // 活塞伸出时的内部方块（只靠机制出现）
    /_candle_cake$/      // 插了蜡烛的蛋糕（cake_candle 变体组已合并，保留 cake 本身）
  ];

  /** 该方块名是否被隐藏（不在物品栏里显示，但仍可放置/编辑） */
  function hiddenFromLib(name) {
    for (var i = 0; i < HIDDEN_FROM_LIB.length; i++) {
      if (HIDDEN_FROM_LIB[i].test(name)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- 状态
  var state = {
    catalog: [],        // data/catalog.json 原始数组（下标 = catalog 索引）
    versions: {},       // data/versions.json
    atlas: null,        // data/atlas.json
    atlasImg: null,     // atlas.png 的 Image 对象
    models: null,       // data/models.json（方块真实几何）
    states: null,       // data/states.json（blockstate 规则表 + 模型库）
    curVer: '1.20.1',   // 当前选中版本
    size: 16,           // 兼容字段（= sizes[0]）
    sizes: [16, 16, 16],// 世界尺寸 [x, y, z]
    world: null,        // VoxelWorld
    renderer: null,     // VoxelRenderer
    catIdx: null,       // 当前方块的 catalog 下标
    outline: null,      // 高亮格 {x,y,z}
    selBlock: null,     // 选中的场景方块（用于状态编辑）
    varPick: {},        // 变体组当前选中的方块名 { groupId: blockName }
    hiddenNames: new Set(),   // 不渲染的方块名
    pierceNames: new Set(),   // 触摸穿透的方块名
    filterCat: 'all',   // 当前分类
    query: '',          // 搜索词（已小写）
    filtered: [],       // 当前过滤结果（catalog 下标数组）
    entFiltered: null,  // 「实体」页签的结果（资产 id 数组）
    itemFiltered: null, // 「物品」页签的结果（items.json 下标数组）
    mods: [],           // 已导入的模组 [{id,name,blocks}]
    modItems: [],       // 模组的纯物品 [{id,cn,tex,modid}]
    libMode: 'block',   // 下方库：'block' 方块库 / 'item' 物品库
    itemCat: 'all',     // 物品库当前分类
    itemEntries: null,  // 物品库总表（懒构建）
    items: null,        // data/items.json
    itemAtlas: null,    // data/item_atlas.json
    itemAtlasImg: null, // data/item_atlas.png
    rendered: 0,        // 已渲染的 filtered 条目数
    drawerOpen: true,
    xray: false,
    mode: 'build',      // 'build' | 'erase'
    ready: false,
    saveTimer: null,    // 自动存档防抖定时器
    // ---- 实体 ----
    entModels: null,    // data/entities.json 的 models
    entAssets: null,    // data/entity_assets.json 的 entities
    entityId: null,     // 当前选中的实体资产 id（null = 不放实体）
    entGroup: null,     // THREE.Group
    entIcons: {},       // 资产 id -> 图标 dataURL
    iconR: null, iconScene: null, iconCam: null,
    beGroup: null        // 实体方块层（箱子/告示牌/床…）
  };

  // ---------------------------------------------------------------- DOM 引用（集中在初始化阶段取一次）
  var dom = {};
  function cacheDom() {
    dom.canvas = document.getElementById('scene');
    dom.topbar = document.getElementById('topbar');
    dom.bottom = document.getElementById('bottom');
    dom.loading = document.getElementById('loading');
    dom.loadingText = document.getElementById('loadingText');
    dom.retryBtn = document.getElementById('retryBtn');
    dom.verSelect = document.getElementById('verSelect');
    dom.sizeSelect = document.getElementById('sizeSelect');
    dom.sizeModal = document.getElementById('sizeModal');
    dom.szX = document.getElementById('szX');
    dom.szY = document.getElementById('szY');
    dom.szZ = document.getElementById('szZ');
    dom.szCancel = document.getElementById('szCancel');
    dom.szGo = document.getElementById('szGo');
    dom.hudTotal = document.getElementById('hudTotal');
    dom.hudTypes = document.getElementById('hudTypes');
    dom.hudCur = document.getElementById('hudCur');
    dom.gizmo = document.getElementById('axisGizmo');
    dom.sizeAskModal = document.getElementById('sizeAskModal');
    dom.sizeAskTip = document.getElementById('sizeAskTip');
    dom.sizeKeep = document.getElementById('sizeKeep');
    dom.sizeClear = document.getElementById('sizeClear');
    dom.sizeCancel2 = document.getElementById('sizeCancel2');
    dom.hudDbg = document.getElementById('hudDbg');
    dom.btnState = document.getElementById('btnState');
    dom.stSheet = document.getElementById('stateSheet');
    dom.stTitle = document.getElementById('stTitle');
    dom.stSub = document.getElementById('stSub');
    dom.stBody = document.getElementById('stBody');
    dom.stClose = document.getElementById('stClose');
    dom.stReset = document.getElementById('stReset');
    dom.stDone = document.getElementById('stDone');
    dom.variantSheet = document.getElementById('variantSheet');
    dom.vsTitle = document.getElementById('vsTitle');
    dom.vsSub = document.getElementById('vsSub');
    dom.vsBody = document.getElementById('vsBody');
    dom.vsClose = document.getElementById('vsClose');
    dom.specialPanel = document.getElementById('specialPanel');
    dom.specialHead = document.getElementById('specialHead');
    dom.spShowBarrier = document.getElementById('spShowBarrier');
    dom.spShowVoid = document.getElementById('spShowVoid');
    dom.spShowLight = document.getElementById('spShowLight');
    dom.spPierceBarrier = document.getElementById('spPierceBarrier');
    dom.spPierceVoid = document.getElementById('spPierceVoid');
    dom.spPierceLight = document.getElementById('spPierceLight');
    dom.hudGrid = document.getElementById('hudGrid');
    dom.drawer = document.getElementById('drawer');
    dom.drawerHead = document.getElementById('drawerHead');
    dom.drawerCount = document.getElementById('drawerCount');
    dom.catSearch = document.getElementById('catSearch');
    dom.catTabs = document.getElementById('catTabs');
    dom.drawerTitle = document.getElementById('drawerTitle');
    dom.catProg = document.getElementById('catProg');   // ★ 分类加载进度条背景
    dom.catGrid = document.getElementById('catGrid');
    dom.catHint = document.getElementById('catHint');
    dom.btnUndo = document.getElementById('btnUndo');
    dom.btnRedo = document.getElementById('btnRedo');
    dom.btnClear = document.getElementById('btnClear');
    dom.btnNew = document.getElementById('btnNew');
    dom.btnMode = document.getElementById('btnMode');
    dom.btnXray = document.getElementById('btnXray');
    dom.btnExport = document.getElementById('btnExport');
    dom.entModal = document.getElementById('entModal');
    dom.btnMod = document.getElementById('btnMod');
    dom.btnImport = document.getElementById('btnImport');
    dom.impFile = document.getElementById('impFile');
    dom.modFile = document.getElementById('modFile');
    dom.entGrid = document.getElementById('entGrid');
    dom.entClose = document.getElementById('entClose');
    dom.entClear = document.getElementById('entClear');
    dom.btnReplace = document.getElementById('btnReplace');
    dom.repModal = document.getElementById('repModal');
    dom.repFrom = document.getElementById('repFrom');
    dom.repTo = document.getElementById('repTo');
    dom.repFilter = document.getElementById('repFilter');
    dom.repInfo = document.getElementById('repInfo');
    dom.repCancel = document.getElementById('repCancel');
    dom.repGo = document.getElementById('repGo');
    dom.exportModal = document.getElementById('exportModal');
    dom.expName = document.getElementById('expName');
    dom.expTrim = document.getElementById('expTrim');
    dom.expFmt = document.getElementById('expFmt');
    dom.expFmtTip = document.getElementById('expFmtTip');
    dom.expTrimRow = document.getElementById('expTrimRow');
    dom.expVoidRow = document.getElementById('expVoidRow');
    dom.expVoid = document.getElementById('expVoid');
    dom.expCancel = document.getElementById('expCancel');
    dom.expGo = document.getElementById('expGo');
    dom.toast = document.getElementById('toast');
  }

  // ---------------------------------------------------------------- Toast
  var toastTimer = null;
  function toast(msg) {
    dom.toast.textContent = msg;
    dom.toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      dom.toast.classList.remove('show');
      toastTimer = null;
    }, 2200);
  }

  // ---------------------------------------------------------------- F1 启动加载
  /**
   * 并行加载 catalog / versions / atlas.json + atlas.png，
   * 每次完成一项刷新进度文字；全部成功 resolve，任一失败 reject。
   */
  // ---------------------------------------------------------------- 资源加载
  // ★ GitHub Pages / 国内网络：161 个小文件 = 161 次 RTT，冷启动很难受。
  //   所以运行时资源打包成 data.pack.zip（deflate，~1MB），只发 1 个请求；
  //   失败再退回逐个文件（开发时直接开目录也能跑）。
  var PACK_VER = '1';
  // ★ 镜像顺序：同源 → jsDelivr → gh-proxy（后两个在国内通常比 github.io 稳）
  var CDN_BASES = [
    '',
    'https://cdn.jsdelivr.net/gh/Dudy211/structure-studio@main/',
    'https://gh-proxy.com/https://raw.githubusercontent.com/Dudy211/structure-studio/main/'
  ];

  function loadAll() {
    dom.loadingText.className = '';
    dom.loadingText.textContent = '加载资源…';
    dom.retryBtn.style.display = 'none';
    if (!window.ModImport) return loadIndividual();
    return loadPack().catch(function (e) {
      if (window.console) console.warn('资源包不可用，回退逐个文件', e);
      return loadIndividual();
    });
  }

  function loadPack() {
    var i = 0;
    function tryNext() {
      if (i >= CDN_BASES.length) return Promise.reject(new Error('所有源都失败'));
      var url = CDN_BASES[i++] + 'data.pack.zip?v=' + PACK_VER;
      dom.loadingText.textContent = '下载资源包…';
      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      }).then(function (buf) {
        dom.loadingText.textContent = '解包资源…';
        return window.ModImport.readZip(buf);
      }).then(function (z) {
        dom.loadingText.textContent = '装配资源…';
        return applyPack(z.files);
      }).catch(function (e) {
        if (window.console) console.warn('资源包源失败：' + url, e);
        return tryNext();
      });
    }
    return tryNext();
  }

  /** 从解包出来的文件表里装配 state（JSON 直接 parse，PNG 用 blob URL） */
  function applyPack(files) {
    var dec = new TextDecoder();
    function J(name) {
      var b = files.get(name) || files.get('data/' + name);
      if (!b) throw new Error('资源包缺少 ' + name);
      return JSON.parse(dec.decode(b));
    }
    state.catalog = J('catalog.json');
    state.versions = J('versions.json');
    state.atlas = J('atlas.json');
    state.models = J('models.json');
    state.states = J('states.json');
    state.items = J('items.json');
    state.itemAtlas = J('item_atlas.json');
    var ej = J('entities.json');
    state.entModels = ej.models || ej;
    var ea = J('entity_assets.json');
    state.entAssets = ea.entities || ea;

    // 实体贴图：/data/entity_tex/x.png → blob URL（原逻辑不用改）
    var urls = {};
    files.forEach(function (bytes, name) {
      if (name.indexOf('entity_tex/') === 0 && name.slice(-4) === '.png') {
        urls['/data/' + name] = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      }
    });
    function fixTex(a) {
      if (!a) return;
      if (a.tex && urls[a.tex]) a.tex = urls[a.tex];
      if (a.texByColor) {
        for (var k in a.texByColor) if (urls[a.texByColor[k]]) a.texByColor[k] = urls[a.texByColor[k]];
      }
      if (a.dbg && urls[a.dbg]) a.dbg = urls[a.dbg];
    }
    for (var id in state.entAssets) fixTex(state.entAssets[id]);

    function imgt(name) {
      var b = files.get(name) || files.get('data/' + name);
      if (!b) return Promise.resolve(null);
      var u = URL.createObjectURL(new Blob([b], { type: 'image/png' }));
      return new Promise(function (res) {
        var im = new Image();
        im.onload = function () { res(im); };
        im.onerror = function () { res(null); };
        im.src = u;
      });
    }
    return Promise.all([imgt('atlas.png'), imgt('item_atlas.png')]).then(function (imgs) {
      state.atlasImg = imgs[0];
      state.itemAtlasImg = imgs[1];
      if (!state.atlasImg) throw new Error('atlas.png 解包失败');
      return true;
    });
  }

  function loadIndividual() {
    dom.loadingText.className = '';
    dom.loadingText.textContent = '加载资源 0/10…';
    dom.retryBtn.style.display = 'none';
    var done = 0;
    function tick(name) {
      done++;
      dom.loadingText.textContent = '加载资源 ' + done + '/10…（' + name + '）';
    }
    function j(url, key) {
      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error(url + ' HTTP ' + r.status);
        return r.json();
      }).then(function (data) {
        state[key] = data;
        tick(url.split('/').pop());
      });
    }
    var pImg = new Promise(function (res, rej) {
      var im = new Image();
      im.onload = function () { state.atlasImg = im; tick('atlas.png'); res(); };
      im.onerror = function () { rej(new Error('data/atlas.png 加载失败')); };
      im.src = 'data/atlas.png?v=' + ATLAS_VER;
    });
    var pEnt = fetch('data/entities.json?v=' + ENT_VER).then(function (r) { return r.json(); })
      .then(function (d) { state.entModels = d.models; tick('entities.json'); });
    var pEntA = fetch('data/entity_assets.json?v=' + ENT_VER).then(function (r) { return r.json(); })
      .then(function (d) { state.entAssets = d.entities; tick('entity_assets.json'); });
    // 物品目录（只读展示）：缺文件也不影响其它功能
    var pItems = fetch('data/items.json?v=' + ITEM_VER).then(function (r) { return r.json(); })
      .then(function (d) { state.items = d; tick('items.json'); })
      .catch(function () { state.items = []; tick('items.json(跳过)'); });
    var pItemAtlas = fetch('data/item_atlas.json?v=' + ITEM_VER).then(function (r) { return r.json(); })
      .then(function (d) { state.itemAtlas = d; tick('item_atlas.json'); })
      .catch(function () { state.itemAtlas = null; tick('item_atlas(跳过)'); });
    var pItemImg = new Promise(function (res) {
      var im = new Image();
      im.onload = function () { state.itemAtlasImg = im; tick('item_atlas.png'); res(); };
      im.onerror = function () { state.itemAtlasImg = null; tick('item_atlas.png(跳过)'); res(); };
      im.src = 'data/item_atlas.png?v=' + ITEM_VER;
    });
    return Promise.all([
      pEnt, pEntA, pItems, pItemAtlas, pItemImg,
      j('data/catalog.json?v=' + ATLAS_VER, 'catalog'),
      j('data/versions.json?v=' + ATLAS_VER, 'versions'),
      j('data/atlas.json?v=' + ATLAS_VER, 'atlas'),
      j('data/models.json?v=' + ATLAS_VER, 'models'),
      j('data/states.json?v=' + ATLAS_VER, 'states'),
      pImg
    ]);
  }

  /** 显示加载失败信息 + 重试按钮（不白屏） */
  function showLoadError(err) {
    dom.loadingText.className = 'err';
    dom.loadingText.textContent = '加载失败：' + (err && err.message ? err.message : String(err)) +
      '\n请通过 HTTP 服务打开本页面（file:// 下 fetch 会被浏览器拦截）。';
    dom.retryBtn.style.display = '';
  }

  /** 启动入口 */
  function boot() {
    cacheDom();
    loadAll().then(function () {
      init();
    }).catch(function (err) {
      showLoadError(err);
    });
    dom.retryBtn.addEventListener('click', function () {
      loadAll().then(function () {
        init();
      }).catch(function (err) {
        showLoadError(err);
      });
    });
  }

  /** 资源就绪后初始化世界 / 渲染器 / 界面 */
  function init() {
    // 0. catalog 名 -> 条目映射（搜索命中变体组、放置时按名查条目用）
    state.catalogByName = {};
    for (var ci = 0; ci < state.catalog.length; ci++) {
      state.catalogByName[state.catalog[ci].n] = state.catalog[ci];
    }

    // 1. 版本 / 尺寸下拉
    buildVersionSelect();
    buildSizeSelect();
    buildTabs();

    // 2. 检查本地存档：询问是否恢复
    var saved = null;
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch (e) { saved = null; }

    // ★ 自动恢复上次作品（不再弹 confirm：手机端每次刷新都弹很烦；要空白世界点「新建」）
    // ?norestore=1 可跳过（自动化测试用）
    var _noRestore = /[?&]norestore=1/.test(location.search);
    state.world = new VoxelWorld(state.sizes[0], state.sizes[1], state.sizes[2]);
    if (!_noRestore && saved && saved.world && saved.world.blocks &&
        saved.world.sx > 0 && saved.world.sy > 0 && saved.world.sz > 0 &&
        saved.world.sx <= 128 && saved.world.sy <= 128 && saved.world.sz <= 128) {
      var _sl = saved.world.sx + '×' + saved.world.sy + '×' + saved.world.sz;
      try {
        state.world = VoxelWorld.fromJSON(saved.world);
        state.sizes = [saved.world.sx, saved.world.sy, saved.world.sz];
        state.size = state.sizes[0];
        if (saved.version && Object.prototype.hasOwnProperty.call(state.versions, saved.version)) {
          state.curVer = saved.version;
        }
        if (saved.variants && typeof saved.variants === 'object') {
          state.varPick = saved.variants;
        }
        syncSelects();
        state._restoredInfo = _sl + '，' + saved.world.blocks.length + ' 个方块';
      } catch (e) {
        if (window.console) console.warn('存档损坏，已新建空白世界', e);
        state.world = new VoxelWorld(state.sizes[0], state.sizes[1], state.sizes[2]);
      }
    }

    // 3. 渲染器（atlas 参数来自 atlas.json，贴图对象来自 atlas.png）
    state.renderer = new VoxelRenderer(dom.canvas, {
      img: state.atlasImg,
      cell: state.atlas.cell,
      pad: state.atlas.pad,
      cols: state.atlas.cols,
      size: state.atlas.size,
      uv: state.atlas.uv
    });
    if (state.renderer.setModels) state.renderer.setModels(state.models);
    if (state.renderer.setStates) state.renderer.setStates(state.states);
    state.renderer.setSize(state.sizes[0], state.sizes[1], state.sizes[2]);
    if (state.renderer.setEntityBlocks) state.renderer.setEntityBlocks(beNameSet());
    state.renderer.markDirty();
    state.renderer.update(state.world, state.catalog, state.hiddenNames);
    var _fixedBeds = repairBeds();
    if (_fixedBeds) dbg('补上床尾 x' + _fixedBeds);
    state.entGroup = new THREE.Group();
    state.renderer.scene.add(state.entGroup);
    state.beGroup = new THREE.Group();
    state.renderer.scene.add(state.beGroup);
    // 预加载实体贴图（不预加载的话，alphaTest 会把未上传的贴图整片裁掉 → 看不见）
    if (window.EntityRenderer && state.entAssets) {
      for (var ek in state.entAssets) {
        var ea = state.entAssets[ek];
        EntityRenderer.preload(ea.tex);
        if (ea.layers) ea.layers.forEach(function (L) { EntityRenderer.preload(L.tex); });
        if (ea.texByColor) for (var ck2 in ea.texByColor) EntityRenderer.preload(ea.texByColor[ck2]);
      }
    }
    rebuildEntities();
    // 画布可视区域跟随上下栏（抽屉展开/收起、屏幕旋转都会触发）
    layoutCanvas();
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { layoutCanvas(); });
      if (dom.topbar) ro.observe(dom.topbar);
      if (dom.bottom) ro.observe(dom.bottom);
    }

    // 4. 默认当前方块：优先 stone，其次过滤结果第一个
    // 默认进入「选择模式」：不选中任何方块
    state.catIdx = null;
    state.mode = 'build';

    // 盆栽变体组（依赖 catalog，只能运行时生成）
    VARIANT_GROUPS.push(buildPotGroup());

    // 4.5 等实体贴图全部就绪后，重刷一次方块库（图标是离屏渲染的，早刷会拿到空白）
    var _iconTries = 0;
    var _iconTimer = setInterval(function () {
      if (window.EntityRenderer && EntityRenderer.allReady && EntityRenderer.allReady()) {
        clearInterval(_iconTimer);
        iconCache.clear();
        state.entIcons = {};
        state.entIconCanvas = {};
        applyFilter(false);
      } else if (++_iconTries > 30) {
        clearInterval(_iconTimer);
      }
    }, 200);

    // 5. 界面绑定 + 方块库首屏
    bindUI();
    syncSpecial();
    updateModeBtn();
    applyFilter(true);
    updateHud();
    if (state._restoredInfo) toast('已恢复上次作品（' + state._restoredInfo + '）');
    // 上次导入的模组装回来；顺带提示「存档里有认不出的方块」（= 那个模组没装回来）
    restoreMods().then(function (nMods) {
      var miss = 0;
      if (state.world && state.world.map) {
        state.world.map.forEach(function (v) {
          var c = state.catalog[v.c];
          if (!c) miss++;
        });
      }
      if (miss > 0 && !nMods) toast('存档里有 ' + miss + ' 个方块来自未导入的模组');
    }).catch(function (e) {
      if (window.console) console.warn('恢复模组失败', e);
    });

    // 调试出口（浏览器控制台：__STUDIO.state / __STUDIO.shot()）
    window.__STUDIO = {
      state: state,
      dom: dom,
      importModBuffer: importModBuffer,
      // 调试/测试用：直接喂未压缩的 NBT 字节（同步，方便一次性验证）
      importStructureBytes: function (u8, label) {
        var res = detectAndParse(NBT.decode(u8));
        importBlocks(res.blocks, res.ents, label || 'bytes');
        return { blocks: res.blocks.length, ents: res.ents.length, total: state.world.stats().total };
      },
      importStructureUrl: function (url) {
        return fetch(url).then(function (r) { return r.arrayBuffer(); })
          .then(function (buf) { return NBT.gunzip(buf); })
          .then(function (raw) {
            var res = detectAndParse(NBT.decode(raw));
            importBlocks(res.blocks, res.ents, url);
            return { blocks: res.blocks.length, ents: res.ents.length };
          });
      },
      importModUrl: function (url) {
        return fetch(url).then(function (r) { return r.arrayBuffer(); })
          .then(function (buf) { return importModBuffer(buf, url); });
      },
      placeEntity: function (id, x, y, z) {
        var a = state.entAssets && state.entAssets[id];
        if (!a) return 'no-asset';
        state.world.setEntity(x, y, z, { asset: id, id: a.eid || null, yaw: 0 });
        afterChange();
        return 'ok';
      },
      openEntity: function () { openEntityPicker(); },
      selectEntity: function (id) { selectEntity(id); },
      refresh: function () { afterChange(); },
      drawGizmo: drawGizmo,
      panBy: panBy,
      resetView: resetView,
      auditIcons: function () {
        var out = {};
        for (var id in state.entAssets) {
          var a = state.entAssets[id];
          if (a.kind !== 'blockent') continue;
          var tex = entIcon === null ? null : (a.texByColor ? a.texByColor.red : a.tex);
          var ck = id + '|' + tex + '|0';   // 与 entIcon 的缓存键保持一致（tint=0）
          entIcon(id, tex);
          var snap = state.entIconCanvas && state.entIconCanvas[ck];
          var n = 0;
          if (snap) {
            var d = snap.getContext('2d').getImageData(0, 0, 96, 96).data;
            for (var i = 3; i < d.length; i += 4) if (d[i] > 10) n++;
          }
          out[id] = n;
        }
        return out;
      },
      setProp: function (x, y, z, name, val) {
        var v = state.world.get(x, y, z);
        if (!v) return 'no-block';
        state.selBlock = { x: x, y: y, z: z, v: v };
        setBlockProp(name, val);
        return 'ok';
      },
      tapAt: function (cx, cy) { doTap(cx, cy); },
      rebuildEntities: rebuildEntities,
      /** 渲染一帧并把画面 POST 回本地服务器（in-app 截图抓不到 WebGL 层） */
      shot: function () {
        if (!state.renderer) return 'no-renderer';
        state.renderer.render();
        var url = dom.canvas.toDataURL('image/png');
        return fetch('/shot', { method: 'POST', body: url })
          .then(function (x) { return x.text(); })
          .then(function (t) { return t + ' (' + url.length + ' chars)'; });
      }
    };

    // 6. 揭幕 + 主循环
    state.ready = true;
    dom.loading.style.display = 'none';
    requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------- F2 版本选择
  /** 版本号从新到旧比较（1.21.8 > 1.21 > 1.20.1 > …） */
  function cmpVerDesc(a, b) {
    var pa = a.split('.').map(Number);
    var pb = b.split('.').map(Number);
    for (var i = 0; i < 3; i++) {
      var x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return y - x;
    }
    return 0;
  }

  function buildVersionSelect() {
    var names = Object.keys(state.versions).sort(cmpVerDesc);
    var prev = state.curVer;
    dom.verSelect.innerHTML = '';
    names.forEach(function (v) {
      var opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      dom.verSelect.appendChild(opt);
    });
    // 默认 1.20.1（不存在时取最新）
    state.curVer = Object.prototype.hasOwnProperty.call(state.versions, '1.20.1') ? '1.20.1' : names[0];
    dom.verSelect.value = state.curVer;
    // 若之前由存档指定了版本，保留
    if (Object.prototype.hasOwnProperty.call(state.versions, prev) && prev !== '1.20.1') {
      state.curVer = prev;
      dom.verSelect.value = prev;
    }
  }

  function buildSizeSelect() {
    dom.sizeSelect.innerHTML = '';
    SIZES.forEach(function (n) {
      var opt = document.createElement('option');
      opt.value = n + ',' + n + ',' + n;
      opt.textContent = n + '\u00b3';
      dom.sizeSelect.appendChild(opt);
    });
    var cus = document.createElement('option');
    cus.value = 'custom';
    cus.textContent = '自定义…';
    dom.sizeSelect.appendChild(cus);
    syncSizeSelect();
  }

  /** 让尺寸下拉框反映当前 sizes（非预设值时插入临时项） */
  function syncSizeSelect() {
    var k = state.sizes[0] + ',' + state.sizes[1] + ',' + state.sizes[2];
    var has = false;
    for (var i = 0; i < dom.sizeSelect.options.length; i++) {
      if (dom.sizeSelect.options[i].value === k) { has = true; break; }
    }
    if (!has) {
      var cus = dom.sizeSelect.querySelector('option[value="custom"]');
      var opt = document.createElement('option');
      opt.value = k;
      opt.textContent = state.sizes[0] + '×' + state.sizes[1] + '×' + state.sizes[2];
      if (cus) dom.sizeSelect.insertBefore(opt, cus);
      else dom.sizeSelect.appendChild(opt);
    }
    dom.sizeSelect.value = k;
  }

  /** 让下拉框与 state 同步（恢复存档后） */
  function syncSelects() {
    dom.verSelect.value = state.curVer;
    syncSizeSelect();
  }

  // ---------------------------------------------------------------- F12 统计 HUD
  function updateHud() {
    var st = state.world ? state.world.stats() : { total: 0, types: 0 };
    if (dom.hudTotal) dom.hudTotal.textContent = String(st.total);
    var entN = state.world && state.world.entities ? state.world.entities.size : 0;
    if (dom.hudTypes) dom.hudTypes.textContent = st.types + ' · 实体 ' + entN;
    var c = state.catIdx !== null ? state.catalog[state.catIdx] : null;
    var a = state.entityId && state.entAssets ? state.entAssets[state.entityId] : null;
    dom.hudCur.textContent = a ? ('🐾 ' + (a.eid || state.entityId) + '（点场景放置）')
      : (c ? (c.cn + '（' + c.n + '）') : '—（点击下方方块库选择）');
  }

  /** 每次 world 变动后的统一收尾：重建渲染 + 刷新 HUD + 防抖存档 */
  function afterChange() {
    if (state.renderer) {
      // 先告诉渲染器哪些方块交给实体层（否则方块几何还在，会画两遍）
      if (state.renderer.setEntityBlocks) state.renderer.setEntityBlocks(beNameSet());
      state.renderer.markDirty();
      state.renderer.update(state.world, state.catalog, state.hiddenNames);
    }
    rebuildEntities();
    rebuildBlockEntities();
    updateHud();
    scheduleSave();
  }

  // ---------------------------------------------------------------- F4 方块库
  // 同时归属多个分类的方块（用户要求：箱子/陷阱箱既在「功能」也在「红石」）
  var EXTRA_CATS = {
    chest: ['redstone'],
    trapped_chest: ['redstone']
  };

  /** 该方块是否属于某个分类（主分类 or 额外分类） */
  function inCategory(name, cat) {
    if (cat === 'all') return true;
    if (categoryOf(name) === cat) return true;
    var ex = EXTRA_CATS[name];
    return !!(ex && ex.indexOf(cat) >= 0);
  }

  /** 按 n 关键词返回分类 id（顺序即优先级，见 CAT_RULES） */
  function categoryOf(name) {
    for (var i = 0; i < CAT_RULES.length; i++) {
      if (CAT_RULES[i].re.test(name)) return CAT_RULES[i].id;
    }
    return 'other';
  }

  /** 分类标签栏（方块库 / 物品库 两套） */
  function buildTabs() {
    dom.catTabs.innerHTML = '';
    var isItem = state.libMode === 'item';
    var list = isItem ? itemCats() : CATS;
    var cur = isItem ? state.itemCat : state.filterCat;
    dom.drawerTitle.textContent = isItem ? '物品库' : '方块库';
    list.forEach(function (c) {
      if (!isItem && c.id === 'mod' && !state.mods.length) return;   // 没导入模组就不显示
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = c.cn;
      b.dataset.cat = c.id;
      if (c.id === cur) b.classList.add('active');
      b.addEventListener('click', function () {
        if (isItem) {
          if (state.itemCat === c.id) return;
          state.itemCat = c.id;
        } else {
          if (state.filterCat === c.id) return;
          state.filterCat = c.id;
        }
        var btns = dom.catTabs.children;
        for (var i = 0; i < btns.length; i++) {
          btns[i].classList.toggle('active', btns[i].dataset.cat === c.id);
        }
        applyFilter(false);
      });
      dom.catTabs.appendChild(b);
    });
  }

  /** 物品库的标签：MC 那 11 个 + 每个模组一个（名字取 mod 的 displayName） */
  function itemCats() {
    var out = ITEM_CATS.slice();
    var seen = {};
    for (var i = 0; i < state.mods.length; i++) {
      var mid = state.mods[i].id;
      if (!mid || seen[mid]) continue;          // 同一个模组只出一个页签
      seen[mid] = 1;
      out.push({ id: 'mod:' + mid, cn: state.mods[i].name });
    }
    return out;
  }

  /** 方块分类 -> 物品库分类 */
  function itemCatOfBlock(name) {
    var c = categoryOf(name);
    if (c === 'command' || c === 'other') return 'ingredients';
    return c;
  }
  /** 纯物品 -> 物品库分类 */
  function itemCatOfItem(id) {
    for (var i = 0; i < ITEM_CAT_RULES.length; i++) {
      if (ITEM_CAT_RULES[i].re.test(id)) return ITEM_CAT_RULES[i].id;
    }
    return 'ingredients';
  }

  /** 物品库总表：所有方块物品（含变体组代表）+ 所有纯物品 */
  function buildItemEntries() {
    var out = [];
    var v = state.versions[state.curVer];
    if (!v) return out;
    var ok = {}, i, gi, li;
    for (i = 0; i < v.blocks.length; i++) ok[v.blocks[i]] = 1;

    var inGroup = {}, repOk = {};
    for (gi = 0; gi < VARIANT_GROUPS.length; gi++) {
      var g = VARIANT_GROUPS[gi];
      for (li = 0; li < g.list.length; li++) inGroup[g.list[li][1]] = 1;
      var pick = state.varPick[g.id];
      if (!pick || !ok[pick]) {
        pick = null;
        for (li = 0; li < g.list.length; li++) {
          if (ok[g.list[li][1]]) { pick = g.list[li][1]; break; }
        }
      }
      if (pick) repOk[pick] = 1;
    }

    for (i = 0; i < state.catalog.length; i++) {
      var c = state.catalog[i];
      if (!ok[c.n]) continue;
      if (hiddenFromLib(c.n) && !repOk[c.n]) continue;
      if (inGroup[c.n] && !repOk[c.n]) continue;
      out.push({
        kind: 'block', idx: i, key: c.n, cn: c.cn || c.n,
        cat: c.mod ? ('mod:' + (typeof c.mod === 'string' ? c.mod : (state.mods[0] ? state.mods[0].id : 'mod'))) : itemCatOfBlock(c.n)
      });
    }
    // 物品也按版本过滤（versions.json 里每个版本有自己的 items 列表）
    var okItems = null;
    if (v.items && v.items.length) {
      okItems = {};
      for (i = 0; i < v.items.length; i++) okItems[v.items[i]] = 1;
    }
    var items = state.items || [];
    for (i = 0; i < items.length; i++) {
      if (okItems && !okItems[items[i].id]) continue;
      out.push({
        kind: 'item', idx: i, key: 'minecraft:' + items[i].id, tex: items[i].tex,
        cn: items[i].cn || items[i].id, cat: itemCatOfItem(items[i].id)
      });
    }
    // 模组的纯物品（parseMod 的 items，贴图已经在 atlas 里）
    for (i = 0; i < state.modItems.length; i++) {
      var mi = state.modItems[i];
      out.push({ kind: 'item', idx: -1, key: mi.id, tex: mi.tex, cn: mi.cn || mi.id, cat: 'mod:' + mi.modid });
    }
    var catOrder = {};
    for (i = 0; i < ITEM_CATS.length; i++) catOrder[ITEM_CATS[i].id] = i;
    out.sort(function (a, b) {
      if (a.cat !== b.cat) return (catOrder[a.cat] || 0) - (catOrder[b.cat] || 0);
      if (a.kind !== b.kind) return a.kind === 'block' ? -1 : 1;
      if (a.kind === 'block') return cmpSortKey(a.key, b.key);
      return a.cn < b.cn ? -1 : (a.cn > b.cn ? 1 : 0);
    });
    return out;
  }

  /** 计算当前（版本 + 分类 + 搜索词）过滤后的 catalog 下标数组 */
  // ---------------------------------------------------------------- MC 风格排序
  // 目标（用户要求）：主组（草/泥土/石头/木材/矿石/装饰…）→ 组内「基础方块 → 台阶 → 楼梯
  // → 墙 → 栅栏 → 门」→ 颜色变体保持 16 色序。实现：把名字拆成 材质 + 形状 + 颜色 + 变体前缀，
  // 再按 [材质组, 组内素材序, 基础名, 形状, 变体, 颜色, 全名] 排序。

  // 形状后缀（★按长度从长到短排，保证 _fence_gate 不会先被 _fence 截走）
  var SHAPE_STRIP = ['_fence_gate', '_pressure_plate', '_hanging_sign', '_trapdoor',
    '_shulker_box', '_stairs', '_planks', '_banner', '_carpet', '_button',
    '_hyphae', '_mosaic', '_bricks', '_fence', '_slab', '_wall', '_door',
    '_sign', '_stem', '_wood', '_log', '_block'];
  // 形状排序权重（用户指定的顺序：基础 → 台阶 → 楼梯 → 墙 → 栅栏 → 门 …）
  var SHAPE_RANK = {
    '': 0, '_planks': 1, '_log': 2, '_wood': 3, '_hyphae': 4, '_stem': 5,
    '_bricks': 6, '_mosaic': 7, '_block': 8,
    '_slab': 10, '_stairs': 11, '_wall': 12, '_fence': 13, '_fence_gate': 14,
    '_door': 15, '_trapdoor': 16, '_button': 17, '_pressure_plate': 18,
    '_sign': 19, '_hanging_sign': 20, '_banner': 21, '_carpet': 22, '_shulker_box': 23
  };
  // 变体前缀（stripped_ / smooth_ …）：只影响同材质内部的先后
  var VAR_PREFIX = {
    'stripped_': 1, 'polished_': 2, 'cracked_': 3, 'mossy_': 4, 'chiseled_': 5, 'smooth_': 6,
    'exposed_': 10, 'weathered_': 11, 'oxidized_': 12, 'waxed_': 20, 'infested_': 30
  };
  var WOOD_ORDER = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove',
    'cherry', 'bamboo', 'crimson', 'warped', 'pale_oak'];
  var COLOR_ORDER = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink',
    'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
  // 彩色系列的素材顺序（同色内部：羊毛 → 地毯 → 混凝土 → 陶瓦 → 玻璃 → 旗帜 → 床 …）
  var COLOR_BASE_ORDER = ['wool', 'carpet', 'concrete', 'concrete_powder', 'terracotta',
    'glazed_terracotta', 'glass', 'stained_glass', 'stained_glass_pane',
    'banner', 'bed', 'candle', 'shulker_box'];
  // 材质主组（★顺序即显示顺序；正则匹配「拆出来的基础名」）
  var MAT_GROUPS = [
    { id: 'sand', re: /^(sand|red_sand|gravel|sandstone|suspicious_sand|suspicious_gravel|soul_sand|soul_soil)$/ },
    { id: 'ore', re: /(_ore$|^raw_|^(coal|iron|gold|diamond|emerald|lapis|redstone|copper|netherite|quartz|amethyst)_block$|^ancient_debris$)/ },
    { id: 'stone', re: /(^(mud_brick|stone|granite|diorite|andesite|deepslate|tuff|calcite|brick|bricks|obsidian|bedrock|dripstone|netherrack)|stone|brick|tuff|calcite|obsidian|bedrock|dripstone|netherrack)/ },
    { id: 'grass', re: /^(grass_block|grass|fern|dirt|coarse_dirt|rooted_dirt|podzol|mycelium|mud|packed_mud|muddy_mangrove_roots|farmland|dirt_path|moss_block|moss_carpet|clay|decorated_pot)$/ },
    { id: 'wood', re: /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped|pale_oak)(_|$)/ },
    { id: 'nether', re: /(nether|soul_|magma|glowstone|shroomlight|nylium|wart|fungus|roots|sprouts|basalt|blackstone)/ },
    { id: 'end', re: /(end_|purpur|chorus|dragon_egg)/ },
    { id: 'ocean', re: /(prismarine|sea_lantern|sea_pickle|coral|kelp|seagrass|sponge)/ },
    { id: 'ice', re: /(ice|snow)/ },
    { id: 'plant', re: /(leaves|sapling|propagule|flower|tulip|allium|bluet|poppy|daisy|cornflower|lily|rose|peony|sunflower|lilac|orchid|vine|kelp|seagrass|cactus|bamboo|melon|pumpkin|wheat|carrots|potatoes|beetroots|cocoa|sugar_cane|berry|azalea|dripleaf|sculk|mushroom|froglight|hay_block|bee_nest|beehive)/ },
    { id: 'metal', re: /(copper|iron|gold|netherite|chain|anvil|cauldron|lightning_rod|rail)/ },
    { id: 'color', re: /(wool|carpet|banner|bed|candle|concrete|terracotta|glass|shulker_box)/ }
  ];

  /** 拆名：返回 { base, shape, varRank, color } */
  function splitBlockName(name) {
    var base = name, color = 99, varRank = 0;
    // 1) 颜色前缀（light_blue 必须在 blue 前面）
    for (var c = 0; c < COLOR_ORDER.length; c++) {
      var cp = COLOR_ORDER[c] + '_';
      if (base.length > cp.length && base.indexOf(cp) === 0) { base = base.slice(cp.length); color = c; break; }
    }
    // 2) 变体前缀（可能叠加：waxed_exposed_copper）
    for (var guard = 0; guard < 4; guard++) {
      var hit = false;
      for (var k in VAR_PREFIX) {
        if (base.length > k.length && base.indexOf(k) === 0) {
          base = base.slice(k.length); varRank += VAR_PREFIX[k]; hit = true; break;
        }
      }
      if (!hit) break;
    }
    // 3) 形状后缀（彩色系列本身就带「形状语义」，不再剥）
    var shape = '';
    if (COLOR_BASE_ORDER.indexOf(base) < 0) {
      for (var i = 0; i < SHAPE_STRIP.length; i++) {
        var suf = SHAPE_STRIP[i];
        if (base.length > suf.length && base.slice(-suf.length) === suf) { shape = suf; base = base.slice(0, -suf.length); break; }
      }
    }
    return { base: base, shape: shape, varRank: varRank, color: color };
  }

  function matGroupOf(base) {
    for (var i = 0; i < MAT_GROUPS.length; i++) {
      if (MAT_GROUPS[i].re.test(base)) return i;
    }
    return MAT_GROUPS.length;
  }

  var SORT_CACHE = {};   // 名字是静态的，排序键算一次就够（900 个方块 × 每次比较都要跑正则太浪费）

  /** 排序键：[材质组, 组内素材序, 基础名, 形状, 变体, 颜色, 全名] */
  function blockSortKey(name) {
    var memo = SORT_CACHE[name];
    if (memo) return memo;
    var p = splitBlockName(name);
    var gi = matGroupOf(p.base);
    var gid = gi < MAT_GROUPS.length ? MAT_GROUPS[gi].id : 'misc';
    var sub = 99;
    if (gid === 'wood') {
      for (var wi = 0; wi < WOOD_ORDER.length && sub === 99; wi++) {
        var wn = WOOD_ORDER[wi];
        if (p.base === wn || p.base.indexOf(wn + '_') === 0) sub = wi;
      }
    } else if (gid === 'color') {
      var ci = COLOR_BASE_ORDER.indexOf(p.base);
      if (ci >= 0) sub = ci;
    }
    var sr = SHAPE_RANK.hasOwnProperty(p.shape) ? SHAPE_RANK[p.shape] : 30;
    var key = [gi, sub, p.base, sr, p.varRank, p.color, name];
    SORT_CACHE[name] = key;
    return key;
  }

  function cmpSortKey(a, b) {
    var x = blockSortKey(a), y = blockSortKey(b);
    for (var i = 0; i < x.length; i++) {
      if (x[i] < y[i]) return -1;
      if (x[i] > y[i]) return 1;
    }
    return 0;
  }

  function computeFiltered() {
    if (state.filterCat === 'item') {
      var qi = state.query;
      var items = state.items || [];
      var res = [];
      for (var ii = 0; ii < items.length; ii++) {
        var it = items[ii];
        if (qi) {
          var iid = it.id.toLowerCase(), icn = (it.cn || '').toLowerCase();
          if (iid.indexOf(qi) < 0 && icn.indexOf(qi) < 0) continue;
        }
        res.push(ii);
      }
      state.itemFiltered = res;
      state.entFiltered = null;
      return [];
    }
    state.itemFiltered = null;
    if (state.filterCat === 'entity') {
      var q0 = state.query;
      var list = entAssetList().filter(function (it) {
        if (!q0) return true;
        var eid = (it.a.eid || '').toLowerCase();
        return it.id.toLowerCase().indexOf(q0) >= 0 || eid.indexOf(q0) >= 0;
      });
      state.entFiltered = list.map(function (it) { return it.id; });
      return [];
    }
    state.entFiltered = null;
    var v = state.versions[state.curVer];
    if (!v) return [];
    // 版本可用方块名 -> 集合（下标查找）
    var okName = {};
    for (var i = 0; i < v.blocks.length; i++) okName[v.blocks[i]] = true;
    var q = state.query;

    // 变体组（16 色羊毛之类）：方块库里默认只留「当前选中的代表」，其余靠箭头展开
    // 搜索时改为留「组内命中的成员」——这样搜 blue 能命中蓝色羊毛/床/旗帜/陶瓦（每组合并成一格）
    var inGroup = {}, repOk = {};
    var searching = !!q;
    for (var gi = 0; gi < VARIANT_GROUPS.length; gi++) {
      var g = VARIANT_GROUPS[gi];
      for (var li = 0; li < g.list.length; li++) inGroup[g.list[li][1]] = g.id;
      var pick;
      if (searching) {
        pick = null;
        var bestScore = 0;
        for (var sli = 0; sli < g.list.length; sli++) {   // 组内命中的成员（精确颜色优先）
          var sn = g.list[sli][1];
          if (!okName[sn]) continue;
          var snl = sn.toLowerCase();
          var sc = 0;
          if (snl.indexOf(q) === 0) sc = 2;              // 名字以查询为前缀（blue 优先于 light_blue）
          else if (snl.indexOf(q) >= 0) sc = 1;          // 名字包含查询
          if (!sc) {
            var sce = state.catalogByName ? state.catalogByName[sn] : null;
            if (sce && sce.cn && sce.cn.toLowerCase().indexOf(q) >= 0) sc = 1;  // 中文命中
          }
          if (sc > bestScore) { bestScore = sc; pick = sn; }
        }
      } else {
        pick = state.varPick[g.id];
        if (!pick || !okName[pick]) {
          pick = null;
          for (var _li = 0; _li < g.list.length; _li++) {   // 取第一个「当前版本真的有」的变体
            if (okName[g.list[_li][1]]) { pick = g.list[_li][1]; break; }
          }
          if (pick) state.varPick[g.id] = pick;
        }
      }
      if (pick) repOk[pick] = true;
    }

    var out = [];
    for (var k = 0; k < state.catalog.length; k++) {
      var c = state.catalog[k];
      if (!okName[c.n]) continue;
      if (hiddenFromLib(c.n) && !repOk[c.n]) continue;   // 特殊 NBT 形态：隐藏（但用户主动选的变体代表要留下）
      if (inGroup[c.n] && !repOk[c.n]) continue;
      if (state.filterCat === 'mod') {
        if (!c.mod) continue;
      } else if (!inCategory(c.n, state.filterCat)) continue;
      if (q) {
        var nl = c.n.toLowerCase();
        var cl = c.cn ? c.cn.toLowerCase() : '';
        if (nl.indexOf(q) < 0 && cl.indexOf(q) < 0) continue;
      }
      out.push(k);
    }
    out.sort(function (i1, i2) { return cmpSortKey(state.catalog[i1].n, state.catalog[i2].n); });
    return out;
  }

  /**
   * 应用过滤并重置分页。
   * @param {boolean} fixCurrent 为 true 时若当前方块不在过滤结果里，自动选第一个
   */
  function applyFilter(fixCurrent) {
    state.query = dom.catSearch.value.trim().toLowerCase();

    // ---- 物品库模式 ----
    if (state.libMode === 'item') {
      if (!state.itemEntries) state.itemEntries = buildItemEntries();
      var q0 = state.query, arr = [];
      for (var ii0 = 0; ii0 < state.itemEntries.length; ii0++) {
        var e0 = state.itemEntries[ii0];
        if (state.itemCat !== 'all' && e0.cat !== state.itemCat) continue;
        if (q0 && e0.key.toLowerCase().indexOf(q0) < 0 && e0.cn.toLowerCase().indexOf(q0) < 0) continue;
        arr.push(ii0);
      }
      state.itemFiltered = arr;
      state.entFiltered = null;
      state.filtered = [];
      state.renderToken = (state.renderToken || 0) + 1;
      _renderBusy = false;
      state.rendered = 0;
      closeInlineVariants();
      dom.catGrid.innerHTML = '';
      dom.drawerCount.textContent = '共 ' + arr.length + ' 种';
      dom.catHint.style.display = arr.length ? 'none' : '';
      renderPage();
      return;
    }
    state.itemFiltered = null;
    state.filtered = computeFiltered();
    state.renderToken = (state.renderToken || 0) + 1;   // 作废上一轮分帧渲染
    _renderBusy = false;
    state.rendered = 0;
    closeInlineVariants();
    dom.catGrid.innerHTML = '';
    var total = state.itemFiltered ? state.itemFiltered.length
      : (state.entFiltered ? state.entFiltered.length : state.filtered.length);
    dom.drawerCount.textContent = '共 ' + total + ' 种';
    dom.catHint.style.display = total ? 'none' : '';
    renderPage();
    // 版本切换后，当前方块可能已被过滤掉 -> 兜底选第一个
    if (fixCurrent && state.catIdx !== null) {
      // 只处理「已经选了但不合法」的情况；没选就保持选择模式（别替用户选第一个）
      var cur = state.catIdx;
      var ok = state.filtered.indexOf(cur) >= 0 &&
        state.versions[state.curVer].blocks.indexOf(state.catalog[cur].n) >= 0;
      if (!ok) state.catIdx = null;
      refreshSelection();
      updateModeBtn();
    }
  }

  // ---------------------------------------------------------------- 3D 等轴测图标（仿 MC 创造物品栏）
  var iconCache = new Map();
  // MC BlockColors 的硬编码染色值（原版这些贴图是灰度的，靠 tint 上色）
  var TINTS = {
    'grass_block': '#91BD59', 'grass_block_top': '#91BD59',
    'oak_leaves': '#79C05A', 'jungle_leaves': '#59C93C', 'acacia_leaves': '#AEA42A',
    'dark_oak_leaves': '#4F6B2C', 'spruce_leaves': '#619961', 'birch_leaves': '#80A755',
    'mangrove_leaves': '#6A7039', 'cherry_leaves': '#FCCBDE',
    'azalea_leaves': '#6A7039', 'flowering_azalea_leaves': '#6A7039',
    'vine': '#48B518', 'lily_pad': '#48B518', 'sugar_cane': '#97C357',
    'water': '#3F76E4', 'water_still': '#3F76E4',
    'large_fern': '#79C05A', 'fern': '#79C05A', 'grass': '#79C05A',
    'short_grass': '#79C05A', 'tall_grass': '#79C05A', 'potted_fern': '#79C05A'
  };

  // MC DyeColor 的 16 色 RGB（旗帜旗面是白贴图 + 材质染色，这里照抄 MC 官方色值）
  var BANNER_RGB = {
    white: 0xf8f8f8, orange: 0xf0731d, magenta: 0xbd44b3, light_blue: 0x3aafd9,
    yellow: 0xf8c527, lime: 0x70b919, pink: 0xed8dac, gray: 0x3e4451,
    light_gray: 0x8e8e8e, cyan: 0x158991, purple: 0x823d97, blue: 0x35399d,
    brown: 0x724728, green: 0x546d1b, red: 0xa22226, black: 0x141519
  };

  function hexRgb(hx) {
    return [parseInt(hx.substr(1, 2), 16), parseInt(hx.substr(3, 2), 16), parseInt(hx.substr(5, 2), 16)];
  }

  function tintFor(cat) {
    if (TINTS[cat.n]) return TINTS[cat.n];
    if (/_leaves$/.test(cat.n)) return '#79C05A';
    return null;
  }

  /** 从 atlas 裁 16×16，按 tint 做乘算染色（等价 MC 的 tintindex） */
  function tileCanvas(texName, tint) {
    var uv = state.atlas.uv[texName];
    if (!uv) return null;
    var c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    var g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(state.atlasImg, uv.x, uv.y, 16, 16, 0, 0, 16, 16);
    if (tint) {
      var rgb = hexRgb(tint);
      var d = g.getImageData(0, 0, 16, 16);
      var p = d.data;
      for (var i = 0; i < p.length; i += 4) {
        if (p[i + 3] === 0) continue;
        p[i]     = Math.min(255, (p[i]     * rgb[0] / 255) | 0);
        p[i + 1] = Math.min(255, (p[i + 1] * rgb[1] / 255) | 0);
        p[i + 2] = Math.min(255, (p[i + 2] * rgb[2] / 255) | 0);
      }
      g.putImageData(d, 0, 0);
    }
    return c;
  }

  /** 顶面 + 两个侧面拼成等轴测立方体 */
  function drawIso(g, top, side, S) {
    var W = S / 2, H = S / 4, VY = S / 2;
    g.save();  // 顶面（菱形）
    g.setTransform(W / 16, H / 16, -W / 16, H / 16, W, 0);
    g.drawImage(top, 0, 0);
    g.restore();
    g.save();  // 左面
    g.setTransform(W / 16, H / 16, 0, VY / 16, 0, H);
    g.drawImage(side, 0, 0);
    g.fillStyle = 'rgba(0,0,0,0.22)';
    g.fillRect(0, 0, 16, 16);
    g.restore();
    g.save();  // 右面
    g.setTransform(W / 16, -H / 16, 0, VY / 16, W, 2 * H);
    g.drawImage(side, 0, 0);
    g.fillStyle = 'rgba(0,0,0,0.38)';
    g.fillRect(0, 0, 16, 16);
    g.restore();
  }

  // 贴面装饰（藤蔓类）：MC 里贴在方块表面，不能拼成立体
  var FLAT_FORCE = /^(glow_lichen|sculk_vein|hanging_roots|resin_clump|pale_hanging_moss|vine|cave_vines|cave_vines_plant|twisting_vines|twisting_vines_plant|weeping_vines|weeping_vines_plant)$/;

  // 非立方体方块（门/活板门/告示牌/旗帜/床/植物/铁轨等）不拼立方体
  var FLAT_RE = /(_door|_trapdoor|_sign|_banner|_bed|_carpet|_pane|_ladder|_rail|_torch|_lantern|_sapling|_flower|_mushroom|_kelp|_seagrass|_coral|_vine|_candle|_head|_skull|_pot|_cake|_chain|_rod|_lever|_repeater|_comparator|_tripwire|_web|_cocoa|_egg|_bell|_campfire|_anvil|_cauldron|_barrier)$|^(structure_void|barrier|light|glow_lichen|sculk_vein|hanging_roots|resin_clump|pale_hanging_moss)$/;
  // ---- MC 的 BlockEntityRenderer 是 Java 代码 + 硬编码几何，资源包里没有。
  //      这里按 MC 源码里的尺寸手写简化 box，比纯立方体更接近真实形状。
  //      格式: [fx,fy,fz, tx,ty,tz]（MC 的 0~16 坐标）
  var BUILTIN_GEO = {
    chest:         [[1, 0, 1, 15, 10, 15], [1, 10, 1, 15, 15, 15]],
    trapped_chest: [[1, 0, 1, 15, 10, 15], [1, 10, 1, 15, 15, 15]],
    ender_chest:   [[1, 0, 1, 15, 10, 15], [1, 10, 1, 15, 15, 15]],
    bed:           [[0, 0, 0, 16, 9, 16], [0, 9, 0, 16, 13, 16]],
    banner:        [[7.4, 0, 7.4, 8.6, 16, 8.6], [0, 4, 7.3, 16, 16, 8.7]],
    shulker_box:   [[0, 0, 0, 16, 14, 16], [1, 14, 1, 15, 16, 15]],
    decorated_pot: [[2, 0, 2, 14, 13, 14], [1, 13, 1, 15, 16, 15]],
    conduit:       [[4, 4, 4, 12, 12, 12]]
  };

  /** 把 BUILTIN_GEO 的 box 列表转成 els 结构 */
  function builtinEls(name, cat) {
    var key = name;
    if (/_shulker_box$/.test(name)) key = "shulker_box";
    else if (/_bed$/.test(name)) key = "bed";
    else if (/_banner$/.test(name)) key = "banner";
    var boxes = BUILTIN_GEO[key];
    if (!boxes) return null;
    var UV = [0, 0, 16, 16];
    var els = [];
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      els.push([b[0], b[1], b[2], b[3], b[4], b[5], {
        up: [cat.top, UV], down: [cat.top, UV],
        north: [cat.side, UV], south: [cat.side, UV],
        west: [cat.side, UV], east: [cat.side, UV]
      }]);
    }
    return { els: els, cube: false };
  }

  // MC 里由 builtin/entity 特殊渲染的方块：模型文件里只有支架/空壳，
  // 主体（钟体、箱子、床）由 BlockEntityRenderer 绘制，拿不到几何 -> 用贴图拼立方体
  var BUILTIN_ENTITY = /^(bell|chest|trapped_chest|ender_chest|shulker_box|.*_shulker_box|.*_bed|.*_banner|decorated_pot|conduit)$/;

  /** 扁平图标：原贴图居中 32×32，不扭曲 */
  function flatIconUrl(idx) {
    var c = state.catalog[idx];
    var t = tileCanvas(c.side || c.top, tintFor(c)) || tileCanvas(c.top, tintFor(c));
    if (!t) return null;
    var S = 40;
    var cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    var g = cv.getContext('2d');
    g.imageSmoothingEnabled = false;
    // 居中 28×28，四周留 6px；这里绝不能再归一化（否则会被放大铺满）
    g.drawImage(t, 6, 6, 28, 28);
    return cv;
  }

  /** 把画布内容的包围盒缩放到铺满（MC 物品栏就是这么做的） */
  function normalizeCanvas(cv, S) {
    var g = cv.getContext('2d');
    var d;
    try { d = g.getImageData(0, 0, S, S).data; } catch (e) { return cv; }
    var minX = S, minY = S, maxX = -1, maxY = -1;
    for (var y = 0; y < S; y++) {
      var row = y * S * 4;
      for (var x = 0; x < S; x++) {
        if (d[row + x * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return cv;
    var w = maxX - minX + 1, h = maxY - minY + 1;
    var OUT = 40;                                 // 最终图标尺寸
    var sc = Math.min(OUT / w, OUT / h) * 0.92;
    var out = document.createElement('canvas');
    out.width = OUT; out.height = OUT;
    var og = out.getContext('2d');
    og.imageSmoothingEnabled = true;
    og.imageSmoothingQuality = 'high';
    og.drawImage(cv, minX, minY, w, h,
      (OUT - w * sc) / 2, (OUT - h * sc) / 2, w * sc, h * sc);
    return out;
  }

  /** 等轴测投影：MC 的 0~16 方块坐标 -> 画布像素 */
  function isoXY(x, y, z, S) {
    var W = S / 2, H = S / 4, VY = S / 2;
    return [
      (x - z) * (W / 16) + S / 2,
      (x + z) * (H / 16) - y * (VY / 16) + S / 2
    ];
  }

  /** 按方块真实模型渲染（elements + faces），等价 MC 创造栏的做法 */
  function renderModel(mdl, S, tint) {
    var cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    var g = cv.getContext('2d');
    g.imageSmoothingEnabled = false;

    var els = mdl.els;
    // 画家算法：体积大的先画（外壳），体积相同则远的先画。
    // 这样 beacon 这种「玻璃外壳 + 内部结构」才能透过外壳看到里面。
    var order = [];
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      var vol = Math.abs(e[3] - e[0]) * Math.abs(e[4] - e[1]) * Math.abs(e[5] - e[2]);
      var cx = (e[0] + e[3]) / 2, cy = (e[1] + e[4]) / 2, cz = (e[2] + e[5]) / 2;
      order.push({ i: i, v: vol, d: (cx + cy + cz) });
    }
    order.sort(function (a, b) { return (b.v - a.v) || (b.d - a.d); });

    // 等轴测视角可见的三个面
    var VIS = ['up', 'south', 'east'];
    var SHADE = { up: 0, south: 0.26, east: 0.42 };

    for (var k = 0; k < order.length; k++) {
      var el = els[order[k].i];
      var fx = el[0], fy = el[1], fz = el[2];
      var tx = el[3], ty = el[4], tz = el[5];
      var faces = el[6];
      var erot = el[7] || null;
      // 0~16 坐标 -> 等轴测像素（含元素旋转）
      function PP(x, y, z) {
        if (erot && erot.a === 'y' && erot.g) {
          var aa = erot.g * Math.PI / 180;
          var cc2 = Math.cos(aa), sn2 = Math.sin(aa);
          var dx2 = x - erot.o[0], dz2 = z - erot.o[2];
          x = erot.o[0] + dx2 * cc2 + dz2 * sn2;
          z = erot.o[2] - dx2 * sn2 + dz2 * cc2;
        }
        return isoXY(x, y, z, S);
      }
      for (var vi = 0; vi < VIS.length; vi++) {
        var fn = VIS[vi];
        var fv = faces[fn];
        if (!fv) continue;
        var texName = (fv instanceof Array) ? fv[0] : fv;
        var uv = (fv instanceof Array && fv[1]) ? fv[1] : [0, 0, 16, 16];
        var tile = tileCanvas(texName, tint);
        if (!tile) continue;

        var P0, P1, P2;
        if (fn === 'up') {
          P0 = PP(fx, ty, fz); P1 = PP(tx, ty, fz); P2 = PP(fx, ty, tz);
        } else if (fn === 'south') {
          P0 = PP(fx, ty, tz); P1 = PP(tx, ty, tz); P2 = PP(fx, fy, tz);
        } else {
          P0 = PP(tx, ty, fz); P1 = PP(tx, ty, tz); P2 = PP(tx, fy, fz);
        }
        var u0 = uv[0], v0 = uv[1], u1 = uv[2], v1 = uv[3];
        var du = u1 - u0, dv = v1 - v0;
        if (!du || !dv) continue;
        var a = (P1[0] - P0[0]) / du, b = (P1[1] - P0[1]) / du;
        var cc = (P2[0] - P0[0]) / dv, dd = (P2[1] - P0[1]) / dv;
        var ee = P0[0] - u0 * a - v0 * cc;
        var ff = P0[1] - u0 * b - v0 * dd;
        g.save();
        g.setTransform(a, b, cc, dd, ee, ff);
        // ★ 关键：裁剪到 uv 矩形，否则整张贴图会溢出到面外盖住其他面
        g.beginPath();
        g.rect(Math.min(u0, u1), Math.min(v0, v1), Math.abs(du), Math.abs(dv));
        g.clip();
        g.drawImage(tile, 0, 0);
        if (SHADE[fn] > 0) {
          // source-atop：只在不透明像素上加深，避免把透明区涂黑
          g.globalCompositeOperation = 'source-atop';
          g.fillStyle = 'rgba(0,0,0,' + SHADE[fn] + ')';
          g.fillRect(Math.min(u0, u1), Math.min(v0, v1), Math.abs(du), Math.abs(dv));
          g.globalCompositeOperation = 'source-over';
        }
        g.restore();
      }
    }
    return cv;
  }

  /** 方块图标 canvas（带缓存） */
  function iconCanvas(idx) {
    if (iconCache.has(idx)) return iconCache.get(idx);
    var c = state.catalog[idx];
    if (!c) return null;
    var beId = beAssetFor(c.n, null);
    if (beId && state.entAssets && state.entAssets[beId] && window.EntityRenderer) {
      var texU = beTexFor(state.entAssets[beId], { n: c.n });
      if (beId === 'bed_head') {                       // 床：两半拼起来才有「一整张床」的样子
        var bcv = document.createElement('canvas');
        bcv.width = 80; bcv.height = 80;
        var bctx = bcv.getContext('2d');
        bctx.imageSmoothingEnabled = false;
        var bsnap = bedIconSnapshot(texU);
        if (bsnap) bctx.drawImage(bsnap, 0, 0, 80, 80);
        iconCache.set(idx, bcv);
        return bcv;
      }
      var _tint = beTintHex(c.n);                // 旗帜按颜色染色
      var ck = beId + '|' + texU + '|' + (_tint || 0);   // 缓存键必须与 entIcon 一致
      entIcon(beId, texU, _tint);                // 渲染并缓存
      var snap = state.entIconCanvas && state.entIconCanvas[ck];
      var bw = document.createElement('canvas');
      bw.width = 80; bw.height = 80;
      var bg = bw.getContext('2d');
      bg.imageSmoothingEnabled = false;
      if (snap) bg.drawImage(snap, 0, 0, 80, 80);
      iconCache.set(idx, bw);
      return bw;
    }
    var S = 80;   // 内部用大画布渲染，避免高模型（门）被裁，最后缩到 40
    var tint = tintFor(c);
    var cv = null;

    // 钟：MC 物品栏用的是 item/bell 这个 2D 图标，直接照抄
    if (c.n === "bell") {
      var bt = tileCanvas("item/bell", null);
      if (bt) {
        var bc = document.createElement("canvas");
        bc.width = S; bc.height = S;
        var bg2 = bc.getContext("2d");
        bg2.imageSmoothingEnabled = false;
        bg2.drawImage(bt, 4, 4, 32, 32);
        iconCache.set(idx, bc);
        return bc;
      }
    }

    // 贴面装饰优先走 2D（必须在模型分支之前）
    if (FLAT_FORCE.test(c.n)) {
      var ff = flatIconUrl(idx);
      if (ff) { iconCache.set(idx, ff); return ff; }
    }

    var mdl = state.models ? state.models[c.n] : null;
    // 钟/箱子/潜影盒：MC 用 BlockEntityRenderer 渲染，模型里只有支架。
    // 有手写近似几何就用它，否则退回贴图立方体。
    // 注意：不要再用 BUILTIN_GEO 覆盖 —— 箱子/钟/床/旗帜现在都在 models.json 里有真实模型，
    // 用 cat.top/side 拼的立方体会把它们变回「木纹方块」。

    // 门/告示牌/旗帜/床 现在也走真实模型（uv 裁剪修好后 3D 形状才正确）

    // 1) item 模型（红石/小麦等，MC 里就是 2D 图标）
    if (mdl && mdl.item) {
      var it = tileCanvas(mdl.item, tint);
      if (it) {
        cv = document.createElement('canvas');
        cv.width = S; cv.height = S;
        var gi = cv.getContext('2d');
        gi.imageSmoothingEnabled = false;
        gi.drawImage(it, 6, 6, 28, 28);
      }
    }

    // cross 类（花/草/树苗）：元素绕 Y 转 45°，在 2:1 等轴测下会退化成一条线，
    // 直接用 2D 贴图（MC 物品栏里它们也接近平面图标）
    if (!cv && mdl && mdl.els && mdl.els.length &&
        mdl.els[0][7] && mdl.els[0][7].g === 45) {
      var fcx = flatIconUrl(idx);
      if (fcx) { iconCache.set(idx, fcx); return fcx; }
    }

    // 2) 有真实模型 -> 按模型画（满方块也走模型，uv 更准）
    if (!cv && mdl && mdl.els && mdl.els.length) {
      cv = renderModel(mdl, S, tint);
    }

    // 2) 平面物品（门/旗帜/植物…）
    if (!cv && FLAT_RE.test(c.n)) {
      var fu = flatIconUrl(idx);
      if (fu) { iconCache.set(idx, fu); return fu; }
    }

    // 3) 没有模型：明确是平面物品的才用 2D；
    //    箱子/潜影盒这类 builtin/entity 方块（无几何数据）改用立方体近似
    if (!cv && !mdl && FLAT_RE.test(c.n)) {
      var f2 = flatIconUrl(idx);
      if (f2) { iconCache.set(idx, f2); return f2; }
    }

    // 4) 满方块 -> 用贴图拼立方体
    if (!cv) {
      cv = document.createElement('canvas');
      cv.width = S; cv.height = S;
      var g = cv.getContext('2d');
      g.imageSmoothingEnabled = false;
      var top = tileCanvas(c.top, tint);
      var side = tileCanvas(c.side, tint);
      if (!top || !side) return null;
      drawIso(g, top, side, S);
    }
    cv = normalizeCanvas(cv, S);
    iconCache.set(idx, cv);
    return cv;
  }

  /** 生成一个方块格：3D 等轴测图标 + 中文名 */
  /** 实体页签的格子 */
  function makeEntItem(id) {
    var a = state.entAssets && state.entAssets[id];
    var el = document.createElement('div');
    el.className = 'catItem' + (state.entityId === id ? ' sel' : '');
    el.dataset.eid = id;
    var tex = document.createElement('div');
    tex.className = 'catTex';
    var cv = document.createElement('canvas');
    cv.width = 80; cv.height = 80;
    var g = cv.getContext('2d');
    g.imageSmoothingEnabled = false;
    var texUrl = a ? a.tex : '';
    entIcon(id, texUrl);
    var ck0 = id + '|' + texUrl + '|0';
    var snap = state.entIconCanvas && state.entIconCanvas[ck0];
    if (snap) g.drawImage(snap, 0, 0, 80, 80);
    cv.style.width = '40px'; cv.style.height = '40px'; cv.style.display = 'block';
    tex.appendChild(cv);
    el.appendChild(tex);
    var nm = document.createElement('div');
    nm.className = 'catName';
    nm.textContent = (a && a.eid) ? a.eid.replace('minecraft:', '') : id;
    el.appendChild(nm);
    el.addEventListener('click', function () { selectEntity(id); });
    return el;
  }

  /** 物品库的格子：方块物品可选中放置，纯物品只提示 id */
  function makeItemCell(ei) {
    var e = state.itemEntries && state.itemEntries[ei];
    var el = document.createElement('div');
    el.className = 'catItem';
    var tex = document.createElement('div');
    tex.className = 'catTex';
    var cv = document.createElement('canvas');
    cv.width = 40; cv.height = 40;
    var g = cv.getContext('2d');
    g.imageSmoothingEnabled = false;
    if (e && e.kind === 'block') {
      var icv = iconCanvas(e.idx);
      if (icv) g.drawImage(icv, 0, 0, 40, 40);
      el.dataset.idx = String(e.idx);
    } else if (e) {
      var tname = e.tex || ((state.items && state.items[e.idx]) ? state.items[e.idx].tex : null);
      // 先找物品图集；模组物品的贴图是并进「方块图集」的，要回退过去找
      var uv = (state.itemAtlas && tname) ? state.itemAtlas.uv[tname] : null;
      var img = state.itemAtlasImg;
      if (!uv && state.atlas && tname && state.atlas.uv[tname]) {
        uv = state.atlas.uv[tname];
        img = state.atlasImg;
      }
      if (uv && img) {
        g.drawImage(img, uv.x, uv.y, 16, 16, 0, 0, 40, 40);
      }
    }
    cv.style.width = '40px';
    cv.style.height = '40px';
    cv.style.display = 'block';
    tex.appendChild(cv);
    el.appendChild(tex);
    var nm = document.createElement('div');
    nm.className = 'catName';
    nm.textContent = e ? e.cn : '?';
    el.appendChild(nm);
    if (e) {
      el.title = e.key;
      if (e.kind === 'block') {
        el.addEventListener('click', function () { selectBlock(e.idx); });
      } else {
        el.addEventListener('click', function () {
          toast('物品：' + e.cn + '（' + e.key + '）');
        });
      }
    }
    return el;
  }

  function makeItem(idx) {
    var c = state.catalog[idx];
    var el = document.createElement('div');
    el.className = 'catItem' + (idx === state.catIdx ? ' sel' : '');
    el.dataset.idx = String(idx);

    var tex = document.createElement('div');
    tex.className = 'catTex';
    var icv = iconCanvas(idx);
    if (icv) {
      // 直接插入 canvas 元素：绕开 toDataURL + CSS 缩放带来的颜色失真
      var cvEl = document.createElement('canvas');
      cvEl.width = icv.width; cvEl.height = icv.height;
      var cg = cvEl.getContext('2d');
      cg.imageSmoothingEnabled = false;
      cg.drawImage(icv, 0, 0);
      cvEl.style.width = '40px';
      cvEl.style.height = '40px';
      cvEl.style.display = 'block';
      tex.appendChild(cvEl);
    }

    var name = document.createElement('div');
    name.className = 'catName';
    name.textContent = c.cn || c.n;

    el.appendChild(tex);
    el.appendChild(name);

    // 变体组：右上角箭头，展开选颜色
    var vg = findVariantGroup(c.n);
    if (vg) {
      var ar = document.createElement('button');
      ar.type = 'button';
      ar.className = 'varArrow';
      ar.textContent = '\u25B8';
      ar.addEventListener('click', function (ev) {
        ev.stopPropagation();
        toggleInlineVariants(+el.dataset.idx, el);
      });
      el.appendChild(ar);
    }

    el.addEventListener('click', function () { selectBlock(+el.dataset.idx); });
    return el;
  }

  /** 就地重画一个方块格（换变体用：不重建网格，滚动位置和展开状态都不动） */
  function paintCell(el, idx, srcCv) {
    var c = state.catalog[idx];
    if (!c || !el) return;
    el.dataset.idx = String(idx);
    var tex = el.querySelector('.catTex');
    var icv = srcCv || iconCanvas(idx);
    if (tex && icv) {
      tex.innerHTML = '';
      var cvEl = document.createElement('canvas');
      cvEl.width = icv.width;
      cvEl.height = icv.height;
      var cg = cvEl.getContext('2d');
      cg.imageSmoothingEnabled = false;
      cg.drawImage(icv, 0, 0);
      cvEl.style.width = '40px';
      cvEl.style.height = '40px';
      cvEl.style.display = 'block';
      tex.appendChild(cvEl);
    }
    var nm = el.querySelector('.catName');
    if (nm) nm.textContent = c.cn || c.n;
  }

  /** 分类栏进度条：frac=0~1，on=显示/隐藏 */
  function setCatProgress(frac, on) {
    var el = dom.catProg;
    if (!el) return;
    el.style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
    el.className = on ? 'on' : '';
  }

  /**
   * 追加渲染下一批（每次 PAGE 个，滚动到底部再追加）。
   * ★ 分帧渲染（每帧 RENDER_CHUNK 个），分类栏背景当进度条 —— 建筑页 350+、
   *   实体页 62 个离屏 3D 图标都要几百毫秒，一次性同步渲染会「卡住没反应」。
   */
  var RENDER_CHUNK = 6;
  var _renderBusy = false;
  function renderPage() {
    if (_renderBusy) return;
    var list = state.itemFiltered || state.entFiltered || state.filtered;
    var total = list.length;
    if (state.rendered >= total) { setCatProgress(0, false); return; }
    var token = state.renderToken || 0;
    var from = state.rendered;
    var to = Math.min(from + PAGE, total);
    var kind = state.itemFiltered ? 'item' : (state.entFiltered ? 'entity' : 'block');
    _renderBusy = true;
    setCatProgress(0, true);
    var step = function () {
      if (token !== (state.renderToken || 0)) { _renderBusy = false; return; }  // 切换分类了，作废
      var end = Math.min(state.rendered + RENDER_CHUNK, to);
      for (var i = state.rendered; i < end; i++) {
        dom.catGrid.appendChild(kind === 'item' ? makeItemCell(list[i])
          : (kind === 'entity' ? makeEntItem(list[i]) : makeItem(list[i])));
      }
      state.rendered = end;
      setCatProgress((end - from) / (to - from), true);
      if (end < to) {
        setTimeout(step, 0)   // ★ 不用 rAF：后台/切走窗口时 rAF 会暂停，列表会卡在半截;
      } else {
        _renderBusy = false;                                   // 本批完成
        setTimeout(function () { if (!_renderBusy) setCatProgress(0, false); }, 200);
        // 视口还没填满（或用户已经滑到底）就继续追加下一批
        if (state.rendered < total) {
          var g = dom.catGrid;
          if (g.scrollTop + g.clientHeight >= g.scrollHeight - 80) setTimeout(renderPage, 16);
        }
      }
    };
    setTimeout(step, 0)   // ★ 不用 rAF：后台/切走窗口时 rAF 会暂停，列表会卡在半截;
  }

  // ---------------------------------------------------------------- 变体选择器
  var _inlineIdx = -1;
  var _inlineEl = null;

  function closeInlineVariants() {
    if (_inlineEl && _inlineEl.parentNode) _inlineEl.parentNode.removeChild(_inlineEl);
    _inlineEl = null;
    _inlineIdx = -1;
  }

  /** 在方块库里就地展开变体（参考 MC 创造物品栏） */
  function toggleInlineVariants(idx, cellEl) {
    if (_inlineIdx === idx) { closeInlineVariants(); return; }
    closeInlineVariants();
    var c = state.catalog[idx];
    var vg = findVariantGroup(c.n);
    if (!vg) return;
    var g = vg.g;
    var cur = state.varPick[g.id] || g.list[0][1];

    var row = document.createElement('div');
    row.className = 'vsInline';
    for (var i = 0; i < g.list.length; i++) {
      (function (it) {
        var bi = catalogIndexOf(it[1]);
        if (bi < 0) return;
        var cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'vsMini' + (it[1] === cur ? ' on' : '');
        var icv = iconCanvas(bi);
        if (icv) {
          var cv = document.createElement('canvas');
          cv.width = icv.width;
          cv.height = icv.height;
          var cg = cv.getContext('2d');
          cg.imageSmoothingEnabled = false;
          cg.drawImage(icv, 0, 0);
          cell.appendChild(cv);
        }
        var sp = document.createElement('span');
        sp.textContent = it[0];
        cell.appendChild(sp);
        cell.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var keepTop = dom.catGrid.scrollTop;          // ★ 记住滚动位置，重建后恢复
          state.varPick[g.id] = it[1];
          applyFilter(false);                           // 重建网格（代表方块要换）
          selectBlock(bi);
          scheduleSave();
          // 重新展开同一个变体组（按「组成员」找格子，别只认 varPick：
          //  搜索模式下显示的代表可能是别的颜色，用 indexOf(varPick) 会落空）
          var pos = -1;
          for (var pi = 0; pi < state.filtered.length && pos < 0; pi++) {
            var nm2 = state.catalog[state.filtered[pi]].n;
            for (var gi2 = 0; gi2 < g.list.length; gi2++) {
              if (g.list[gi2][1] === nm2) { pos = pi; break; }
            }
          }
          var cell2 = pos >= 0 ? dom.catGrid.children[pos] : null;
          if (cell2) toggleInlineVariants(state.filtered[pos], cell2);
          dom.catGrid.scrollTop = keepTop;              // ★ 回到原来的位置，不弹回顶部
        });
        row.appendChild(cell);
      })(g.list[i]);
    }
    cellEl.parentNode.insertBefore(row, cellEl.nextSibling);
    _inlineEl = row;
    _inlineIdx = idx;
  }

  /** 打开变体选择抽屉（g = VARIANT_GROUPS 里的组） */
  function openVariantPicker(g) {
    var cur = state.varPick[g.id] || g.list[0][1];
    dom.vsTitle.textContent = '选择' + g.label;
    var total = 0;
    for (var t = 0; t < g.list.length; t++) {
      if (catalogIndexOf(g.list[t][1]) >= 0) total++;
    }
    dom.vsSub.textContent = g.id + ' · ' + total + ' 种可用';

    dom.vsBody.innerHTML = '';
    var grid = document.createElement('div');
    grid.className = 'vsGrid';
    for (var i = 0; i < g.list.length; i++) {
      (function (it) {
        var bn = it[1];
        var idx = catalogIndexOf(bn);
        if (idx < 0) return;                 // 当前版本没有这个变体
        var cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'vsItem' + (bn === cur ? ' on' : '');
        var icv = iconCanvas(idx);
        if (icv) {
          var cv = document.createElement('canvas');
          cv.width = icv.width;
          cv.height = icv.height;
          var cg = cv.getContext('2d');
          cg.imageSmoothingEnabled = false;
          cg.drawImage(icv, 0, 0);
          cell.appendChild(cv);
        }
        var sp = document.createElement('span');
        sp.textContent = it[0];
        cell.appendChild(sp);
        cell.addEventListener('click', function () { pickVariant(g, bn, idx); });
        grid.appendChild(cell);
      })(g.list[i]);
    }
    dom.vsBody.appendChild(grid);
    dom.variantSheet.classList.add('show');
  }

  function closeVariantPicker() {
    if (dom.variantSheet) dom.variantSheet.classList.remove('show');
  }

  /** 记住选择 + 立刻选成当前方块 */
  function pickVariant(g, blockName, idx) {
    state.varPick[g.id] = blockName;
    closeVariantPicker();
    applyFilter(false);
    if (idx >= 0) selectBlock(idx);
    scheduleSave();
  }

  function catalogIndexOf(name) {
    for (var i = 0; i < state.catalog.length; i++) {
      if (state.catalog[i].n === name) return i;
    }
    return -1;
  }

  /** 选中方块（高亮 + 设为当前方块） */
  function selectBlock(idx) {
    if (state.entityId) {                 // 从「实体」切回方块：必须清掉实体选择
      state.entityId = null;
      var eitems = dom.catGrid.children;
      for (var ei = 0; ei < eitems.length; ei++) eitems[ei].classList.remove('sel');
    }
    if (state.catIdx === idx) {
      // 再点一次 -> 取消选择，回到选择模式
      state.catIdx = null;
      state.mode = 'build';
    } else {
      state.catIdx = idx;
      state.mode = 'build';
    }
    refreshSelection();
    updateModeBtn();
    updateHud();
  }

  /** 刷新已渲染格子的高亮（children 顺序与 filtered 一致） */
  function refreshSelection() {
    var items = dom.catGrid.children;
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('sel', state.filtered[i] === state.catIdx);
    }
  }

  // ---------------------------------------------------------------- F3 世界尺寸
  function onSizeChange() {
    var v = dom.sizeSelect.value;
    if (v === 'custom') { openSizeModal(); return; }
    var p = v.split(',');
    askSize(parseInt(p[0], 10), parseInt(p[1], 10), parseInt(p[2], 10));
  }

  var _pendingSize = null;

  /** 切尺寸前先问：保留结构 / 清空重建 */
  function askSize(x, y, z) {
    x = Math.max(1, Math.min(128, parseInt(x, 10) || 16));
    y = Math.max(1, Math.min(128, parseInt(y, 10) || 16));
    z = Math.max(1, Math.min(128, parseInt(z, 10) || 16));
    if (x === state.sizes[0] && y === state.sizes[1] && z === state.sizes[2]) { syncSizeSelect(); return; }
    var total = state.world ? state.world.stats().total : 0;
    _pendingSize = [x, y, z];
    if (!total) { applySize(x, y, z, false); return; }
    dom.sizeAskTip.innerHTML =
      '当前作品有 <b>' + total + '</b> 个方块。<br>切到 <b>' + x + '×' + y + '×' + z + '</b> 后：<br>' +
      '· <b>保留结构</b>：放得下的方块继续保留（超出新尺寸的会丢失）<br>' +
      '· <b>清空重建</b>：全部删除';
    dom.sizeAskModal.classList.add('show');
  }

  /** 应用新尺寸 x/y/z；keep=true 时把旧作品搬过去（超出范围的丢弃） */
  function applySize(x, y, z, keep) {
    x = parseInt(x, 10); y = parseInt(y, 10); z = parseInt(z, 10);
    if (!(x > 0 && y > 0 && z > 0)) { toast('尺寸必须是正整数'); syncSizeSelect(); return; }
    x = Math.min(128, x); y = Math.min(128, y); z = Math.min(128, z);
    if (x === state.sizes[0] && y === state.sizes[1] && z === state.sizes[2]) { syncSizeSelect(); return; }
    var label = x + '×' + y + '×' + z;
    var old = state.world;
    var oldN = old ? old.stats().total : 0;
    state.sizes = [x, y, z];
    state.size = x;
    state.world = new VoxelWorld(x, y, z);
    var kept = 0, lost = 0;
    if (keep && old) {
      old.map.forEach(function (v, k) {
        var p = k.split(','), bx = +p[0], by = +p[1], bz = +p[2];
        if (bx < x && by < y && bz < z) { state.world.map.set(k, v); kept++; }
        else lost++;
      });
      if (old.entities) {
        old.entities.forEach(function (e, k) {
          var p = k.split(',');
          if (+p[0] < x && +p[1] < y && +p[2] < z) state.world.entities.set(k, e);
        });
      }
      if (oldN) toast('保留了 ' + kept + ' 个方块' + (lost ? '，' + lost + ' 个超出新尺寸被丢弃' : ''));
    }
    state.outline = null;
    if (state.renderer) {
      state.renderer.setSize(x, y, z);
      state.renderer.markDirty();
      state.renderer.update(state.world, state.catalog, state.hiddenNames);
      state.renderer.setOutline(null);

    }
    syncSizeSelect();
    updateHud();
    scheduleSave();
    toast('世界已重建为 ' + label);
  }

  function openSizeModal() {
    dom.szX.value = state.sizes[0];
    dom.szY.value = state.sizes[1];
    dom.szZ.value = state.sizes[2];
    dom.sizeModal.classList.add('show');
    syncSizeSelect();
  }
  function closeSizeModal() { dom.sizeModal.classList.remove('show'); }

  // ---------------------------------------------------------------- F2 版本切换
  function onVersionChange() {
    state.curVer = dom.verSelect.value;
    state.itemEntries = null;          // ★ 物品库也要按版本重建
    applyFilter(true);                 // 用新版本的 blocks 过滤方块库，并校验当前方块
    updateHud();
    var vv = state.versions[state.curVer];
    toast('已切换到 ' + state.curVer + '（' + vv.blocks.length + ' 种方块 / ' +
      ((vv.items && vv.items.length) || 0) + ' 种物品）');
  }

  // ---------------------------------------------------------------- F8/F9/F11 工具栏
  function doUndo() {
    if (state.world.undo()) {
      state.renderer.setOutline(null);
      state.outline = null;
      afterChange();
    }
  }
  function doRedo() {
    if (state.world.redo()) {
      state.renderer.setOutline(null);
      state.outline = null;
      afterChange();
    }
  }
  function doClear() {
    if (state.world.stats().total === 0) { toast('世界已经是空的'); return; }
    if (!confirm('确定清空整个作品？（可用撤销找回）')) return;
    state.world.clear();
    state.renderer.setOutline(null);
    state.outline = null;
    afterChange();
    toast('已清空');
  }
  function doNew() {
    if (state.world.stats().total > 0 &&
        !confirm('新建将清空当前作品，确定？（可用撤销找回）')) return;
    state.world.clear();
    state.renderer.setOutline(null);
    state.outline = null;
    afterChange();
    toast('已新建空白世界');
  }
  /** F9 透视模式：方块半透明，方便看内部结构 */
  /** 把三个开关同步到 hiddenNames / pierceNames，并刷新渲染 */
  function syncSpecial() {
    var s = state;
    s.hiddenNames = new Set();
    s.pierceNames = new Set();
    if (!dom.spShowBarrier.checked) s.hiddenNames.add('barrier');
    if (!dom.spShowVoid.checked) s.hiddenNames.add('structure_void');
    if (!dom.spShowLight.checked) s.hiddenNames.add('light');
    if (dom.spPierceBarrier.checked) s.pierceNames.add('barrier');
    if (dom.spPierceVoid.checked) s.pierceNames.add('structure_void');
    if (dom.spPierceLight.checked) s.pierceNames.add('light');
    if (state.renderer) {
      state.renderer.markDirty();
      state.renderer.update(state.world, state.catalog, s.hiddenNames);
    }
  }

  /**
   * 当前「放置目标」——方块和实体是同一个概念，只是数据源不同：
   *   { kind:'block', idx } / { kind:'entity', id } / null（= 选择模式）
   * ★ 放置、删除、模式切换、HUD 全走这一个入口，别再各判各的 catIdx / entityId。
   */
  function placeTarget() {
    if (state.entityId && state.entAssets && state.entAssets[state.entityId]) {
      return { kind: 'entity', id: state.entityId };
    }
    if (state.catIdx !== null) return { kind: 'block', idx: state.catIdx };
    return null;
  }
  function hasTarget() { return placeTarget() !== null; }

  /** 当前实际模式：没选目标 = select */
  function currentMode() {
    if (!hasTarget()) return 'select';
    return state.mode === 'erase' ? 'erase' : 'build';
  }

  /** 点击按钮：建造 <-> 删除 轮换（未选目标时提示） */
  function toggleMode() {
    if (!hasTarget()) {
      toast('选择模式：先在下方方块库选方块或实体');
      return;
    }
    state.mode = state.mode === 'erase' ? 'build' : 'erase';
    updateModeBtn();
    toast(state.mode === 'erase' ? '删除模式：点方块即删除' : '建造模式：点方块面放置');
  }

  /** 长按按钮：回到选择模式并取消当前方块 */
  function enterSelectMode() {
    state.catIdx = null;
    state.entityId = null;
    state.mode = 'build';
    refreshSelection();
    if (state.entGroup) {
      var items = dom.catGrid.children;
      for (var i = 0; i < items.length; i++) items[i].classList.remove('sel');
    }
    updateModeBtn();
    updateHud();
    toast('已进入选择模式：点场景中的方块可选中它');
  }

  function updateModeBtn() {
    var m = currentMode();
    dom.btnMode.textContent = m === 'select' ? '选择' : (m === 'erase' ? '删除' : '建造');
    if (m === 'select') dom.btnMode.classList.remove('on');
    else dom.btnMode.classList.add('on');
  }

  function toggleXray() {
    if (!state.renderer) return;
    state.xray = !state.xray;
    var m = state.renderer.mesh.material;
    m.transparent = state.xray;
    // ★ 关键：材质本来有 alphaTest 0.5（为了树叶/玻璃），
    // opacity 0.45 < 0.5 会让整个方块被 alphaTest 裁掉 -> 看起来"直接消失"
    m.alphaTest = state.xray ? 0 : 0.5;
    m.opacity = state.xray ? 0.45 : 1.0;
    m.depthWrite = !state.xray;          // 半透明叠加时别互相遮挡
    m.needsUpdate = true;
    if (state.renderer.setXray) state.renderer.setXray(state.xray);
    state.renderer.markDirty();
    state.renderer.update(state.world, state.catalog, state.hiddenNames);
    dom.btnXray.classList.toggle('on', state.xray);
    toast(state.xray ? '透视模式开' : '透视模式关');
  }

  // ---------------------------------------------------------------- 3D 方向指示（Unity/Blender 风格）
  var DEFAULT_THETA = Math.PI * 0.167, DEFAULT_PHI = Math.PI * 0.32;
  function resetView() {
    if (!state.renderer) return;
    var o = state.renderer.orbit;
    o.theta = DEFAULT_THETA;
    o.phi = DEFAULT_PHI;
    o.q = null;              // 让 updateCamera 用角度重建朝向（回到标准视角）
    o.ty = 3;
    toast('视角已回正');
  }

  function drawGizmo() {
    var cv = dom.gizmo;
    if (!cv || !state.renderer || !window.THREE) return;
    var g = cv.getContext('2d');
    var W = cv.width, H = cv.height, cx = W / 2, cy = H / 2, R = W * 0.33;
    g.clearRect(0, 0, W, H);
    var q = state.renderer.camera.quaternion.clone().invert();
    var axes = [
      { v: new THREE.Vector3(1, 0, 0), c: '#ff6b6b', n: 'X' },
      { v: new THREE.Vector3(0, 1, 0), c: '#7ee787', n: 'Y' },
      { v: new THREE.Vector3(0, 0, 1), c: '#6aa9ff', n: 'Z' }
    ];
    var pts = [];
    for (var i = 0; i < axes.length; i++) {
      var v = axes[i].v.clone().applyQuaternion(q);
      pts.push({ x: cx + v.x * R, y: cy - v.y * R, z: v.z, c: axes[i].c, n: axes[i].n });
    }
    pts.sort(function (a, b) { return a.z - b.z; });     // 背面的先画
    g.lineCap = 'round';
    for (i = 0; i < pts.length; i++) {
      var p = pts[i];
      g.globalAlpha = p.z < 0 ? 0.45 : 1;
      g.strokeStyle = p.c;
      g.lineWidth = 6;
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(p.x, p.y); g.stroke();
      g.fillStyle = p.c;
      g.beginPath(); g.arc(p.x, p.y, 13, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#10131a';
      g.font = 'bold 16px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(p.n, p.x, p.y + 1);
    }
    g.globalAlpha = 1;
    g.fillStyle = 'rgba(255,255,255,.5)';
    g.beginPath(); g.arc(cx, cy, 4, 0, Math.PI * 2); g.fill();
  }

  // ---------------------------------------------------------------- F11 自动存档
  /** 修改后 1 秒防抖写入 localStorage */
  function scheduleSave() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () {
      state.saveTimer = null;
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({
          version: state.curVer,
          size: state.size,
          sizes: state.sizes.slice(),
          variants: state.varPick,
          world: state.world.toJSON()
        }));
      } catch (e) {
        // 存储满 / 隐私模式：静默失败，不影响编辑
      }
    }, 1000);
  }

  // ---------------------------------------------------------------- F7 放置 / 删除

  // ---- D：按放置情况自动选形态（MC 的放置逻辑）----
  // 法线约定（与本仓库一致）：south=+z, north=-z, east=+x, west=-x。
  // 命中点局部坐标 lx/ly/lz 范围 0..1（见 render.js pick）；theta = 相机轨道角。

  /** 连接族：栅栏(含锁链) / 墙 / 玻璃板(含铁栏) 各自成族，同族才互相连接 */
  function connFamily(name) {
    if (/_fence$/.test(name)) return 'fence';
    if (name === 'chain') return 'chain';
    if (/_wall$/.test(name)) return 'wall';
    if (/(^|_)glass_pane$/.test(name)) return 'pane';   // 裸名 glass_pane 无前导下划线，也要匹配
    if (name === 'iron_bars') return 'bars';
    return null;
  }

  /** 放置方块 placed 与邻居 other 是否「同类可连接」 */
  function connCompatible(placed, other) {
    if (placed === other) return true;
    var fa = connFamily(placed), fb = connFamily(other);
    if (!fa || !fb) return false;
    if (fa === 'fence' && (fb === 'fence' || fb === 'chain')) return true;
    if (fa === 'chain' && (fb === 'fence' || fb === 'chain' || fb === 'pane' || fb === 'bars')) return true;
    if (fa === 'pane' && (fb === 'pane' || fb === 'bars' || fb === 'chain')) return true;
    if (fa === 'bars' && (fb === 'bars' || fb === 'pane' || fb === 'chain')) return true;
    if (fa === 'wall' && fb === 'wall') return true;
    return false;
  }

  /** 放置格 (wx,wy,wz) 的 4 个水平邻居是否为可连接同类（供 pickStateVariant 读，保持纯） */
  function connNbrFor(placedName, wx, wy, wz) {
    var out = { north: false, south: false, east: false, west: false };
    if (!connFamily(placedName) || !state.world) return out;
    var w = state.world, b;
    if (w.inBounds(wx, wy, wz - 1)) { b = w.get(wx, wy, wz - 1); if (b && connCompatible(placedName, b.n)) out.north = true; }
    if (w.inBounds(wx, wy, wz + 1)) { b = w.get(wx, wy, wz + 1); if (b && connCompatible(placedName, b.n)) out.south = true; }
    if (w.inBounds(wx - 1, wy, wz)) { b = w.get(wx - 1, wy, wz); if (b && connCompatible(placedName, b.n)) out.west = true; }
    if (w.inBounds(wx + 1, wy, wz)) { b = w.get(wx + 1, wy, wz); if (b && connCompatible(placedName, b.n)) out.east = true; }
    return out;
  }

  /** 视角（orbit.theta）-> 最近水平朝向：取「视线反方向」（= 朝向相机） */
  function viewFacing(theta) {
    // 相机在 (sinθ, cosθ) 方向，视线 = 反方向（MC 的 facing = 玩家看向的方向）
    var dx = -Math.sin(theta), dz = -Math.cos(theta);
    if (Math.abs(dx) >= Math.abs(dz)) return dx > 0 ? 'east' : 'west';
    return dz > 0 ? 'south' : 'north';
  }

  /** 面法线 -> facing（告示牌/旗帜/按钮 贴墙时用；与既有贴墙朝向逻辑一致） */
  function facingFromNormal(nx, nz) {
    if (nx > 0) return 'east';
    if (nx < 0) return 'west';
    if (nz > 0) return 'south';
    if (nz < 0) return 'north';
    return 'south';
  }

  /** 站立形态名 -> 贴墙形态名（*_sign→*_wall_sign、*_banner→*_wall_banner、…） */
  function wallFormOf(name) {
    if (/_wall_/.test(name)) return null;            // 已是贴墙形态
    var m;
    m = /^(.*)_(hanging_sign)$/.exec(name); if (m) return m[1] + '_wall_' + m[2];
    m = /^(.*)_(coral_fan)$/.exec(name);    if (m) return m[1] + '_wall_' + m[2];
    m = /^(.*)_(sign|banner|head|skull)$/.exec(name); if (m) return m[1] + '_wall_' + m[2];
    return null;
  }

  /**
   * 按放置情况自动选形态（纯函数，方便单测）。
   * @param {string} blockName 当前要放的方块名（物品栏里选的那个，通常是「立着的」形态）
   * @param {object} hit { nx, ny, nz, lx, ly, lz, theta, cnbr }
   *   nx/ny/nz 法线；ly 命中点在格内的竖直局部坐标(0..1)；theta 视角角；cnbr 相邻同类
   * @returns {{n:(string|null), p:(object|null)}} n=要替换成的方块名（null=不变），p=props
   */
  function pickStateVariant(blockName, hit) {
    var out = { n: null, p: null };
    var nx = hit.nx || 0, ny = hit.ny || 0, nz = hit.nz || 0;
    var topFace = (ny === 1), bottomFace = (ny === -1);
    var vertical = (nx !== 0 || nz !== 0);
    var ly = (typeof hit.ly === 'number') ? hit.ly : 0.5;

    // 1) 半砖：点顶→底砖；点底→顶砖；点竖直面→上半 top / 下半 bottom
    if (/_slab$/.test(blockName)) {
      var st;
      if (topFace) st = 'bottom';
      else if (bottomFace) st = 'top';
      else st = ly > 0.5 ? 'top' : 'bottom';
      out.p = { type: st };
      return out;
    }

    // 2) 楼梯：朝向=视线反方向；点上半→top，否则 bottom（顶面→bottom，底面→top）
    if (/_stairs$/.test(blockName)) {
      var sh;
      if (topFace) sh = 'bottom';
      else if (bottomFace) sh = 'top';
      else sh = ly > 0.5 ? 'top' : 'bottom';
      out.p = { facing: viewFacing(hit.theta), half: sh, shape: 'straight' };
      return out;
    }

    // 3) 原木类：点竖直面→水平轴(x/z)；点顶/底→y
    if (/_log$|_wood$|_stem$|_hyphae$/.test(blockName)) {
      var ax = nx !== 0 ? 'x' : (nz !== 0 ? 'z' : 'y');
      out.p = { axis: ax };
      return out;
    }

    // 4) 栅栏 / 墙 / 玻璃板 / 铁栏杆：只在「相邻确实有同类」时置 true
    if (connFamily(blockName) && hit.cnbr) {
      var conn = {};
      if (hit.cnbr.north) conn.north = true;
      if (hit.cnbr.south) conn.south = true;
      if (hit.cnbr.east)  conn.east = true;
      if (hit.cnbr.west)  conn.west = true;
      if (conn.north || conn.south || conn.east || conn.west) out.p = conn;
      return out;
    }

    // 5) 告示牌 / 旗帜 / 头颅 / 珊瑚扇：点竖直面→贴墙形态(facing=法线方向)；点顶面→站立
    if (/_sign$/.test(blockName) || /_banner$/.test(blockName) ||
        /_head$/.test(blockName) || /_skull$/.test(blockName) || /_coral_fan$/.test(blockName)) {
      if (vertical) {
        out.n = wallFormOf(blockName);
        out.p = { facing: facingFromNormal(nx, nz) };
      }
      // 顶面 / 底面：保持站立形态（无额外 props）
      return out;
    }

    // 6) 按钮 / 拉杆：竖直面→wall+facing；顶面→floor；底面→ceiling
    if (/_button$/.test(blockName) || blockName === 'lever') {
      if (vertical) out.p = { face: 'wall', facing: facingFromNormal(nx, nz) };
      else if (topFace) out.p = { face: 'floor' };
      else if (bottomFace) out.p = { face: 'ceiling' };
      return out;
    }

    // 7) 活板门：竖直面→top+open；点顶面→bottom；点底面→top
    if (/_trapdoor$/.test(blockName)) {
      if (vertical) out.p = { half: 'top', open: true };
      else if (topFace) out.p = { half: 'bottom' };
      else if (bottomFace) out.p = { half: 'top' };
      else out.p = { half: 'bottom' };
      return out;
    }

    // 8) 藤蔓 / 发光地衣：按「新格指向被点方块」的方向写 true（nx>0→west …）
    if (blockName === 'vine' || blockName === 'glow_lichen') {
      var d = {};
      if (nx > 0) d.west = true; else if (nx < 0) d.east = true;
      if (nz > 0) d.north = true; else if (nz < 0) d.south = true;
      if (ny > 0) d.down = true; else if (ny < 0) d.up = true;
      if (!d.east && !d.west && !d.north && !d.south && !d.up && !d.down) d.down = true;
      out.p = d;
      return out;
    }

    return out;
  }

  /** 由 pick 结果构造 pickStateVariant 需要的 hit（补 theta + 相邻同类） */
  function makeVHit(hit, px, py, pz, placedName) {
    return {
      nx: hit.nx, ny: hit.ny, nz: hit.nz,
      lx: hit.lx, ly: hit.ly, lz: hit.lz,
      theta: state.renderer ? state.renderer.orbit.theta : 0,
      cnbr: connNbrFor(placedName, px, py, pz)
    };
  }

  /** 在「命中格 + 法线方向」放置当前方块（一次手势 = 一条撤销记录） */
  function placeAt(hit) {
    // ---- 实体模式 ----
    if (state.entityId) {
      var ex = hit.x + hit.nx, ey = hit.y + hit.ny, ez = hit.z + hit.nz;
      if (!state.world.inBounds(ex, ey, ez)) { toast('越界了，放不了'); return; }
      var ea = state.entAssets && state.entAssets[state.entityId];
      if (!ea) return;
      state.world.setEntity(ex, ey, ez, { asset: state.entityId, id: ea.eid || null, yaw: 0 });
      dbg('放了实体 ' + state.entityId + ' @ ' + ex + ',' + ey + ',' + ez);
      afterChange();
      return;
    }
    if (state.catIdx === null) {
      dbg('拒绝：没选方块');
      toast('请先在方块库里选择一个方块');
      return;
    }
    var c = state.catalog[state.catIdx];
    var px = hit.x + hit.nx;
    var py = hit.y + hit.ny;
    var pz = hit.z + hit.nz;
    if (!state.world.inBounds(px, py, pz)) {
      dbg('拒绝：越界 ' + px + ',' + py + ',' + pz);
      toast('越界了，放不了');
      return;
    }
    // 密度保护：超过体积 85% 就拒绝
    var limit = Math.floor(state.world.sx * state.world.sy * state.world.sz * DENSITY);
    if (state.world.stats().total >= limit) {
      dbg('拒绝：密度上限 ' + limit);
      toast('太密了：方块数已达上限（' + limit + '）');
      return;
    }
    // 目标格若有「隐藏且未穿透」的特殊方块，拒绝覆盖
    var exist = state.world.get(px, py, pz);
    if (exist) {
      var ec = state.catalog[exist.c];
      if (ec && SPECIAL_NAMES[ec.n] && !state.pierceNames.has(ec.n)) {
        dbg('拒绝：' + ec.cn + ' 未开穿透');
        toast('这里有「' + ec.cn + '」，开启穿透才能覆盖');
        return;
      }
    }

    state.world.beginBatch('放置');
    var changed;
    // D：按放置情况自动选形态（半砖/楼梯/原木/栅栏/告示牌/旗帜/按钮/活板门/藤蔓…）
    // 只对单格形态类生效；门/床/已贴墙形态/箱子 仍走下面各自的原逻辑
    var vres = pickStateVariant(c.n, makeVHit(hit, px, py, pz, c.n));
    var placeName = c.n, placeIdx = state.catIdx, placeProps = vres.p;
    if (vres.n && vres.n !== c.n) {
      var wi = catalogIndexOf(vres.n);
      if (wi >= 0) { placeName = vres.n; placeIdx = wi; }   // 站立→贴墙：换方块名 + 下标
    }
    if (/_door$/.test(c.n) || TALL_BLOCKS[c.n]) {
      // 门 / 高草：必须两格都空着，否则整块不放（避免出现半个）
      if (!state.world.inBounds(px, py + 1, pz) || state.world.has(px, py + 1, pz)) {
        dbg('拒绝：上面那格放不下');
        toast('门 / 高草要占两格，上面那格放不下');
        return;
      }
      changed = state.world.set(px, py, pz, c.n, { half: 'lower' }, state.catIdx);
      state.world.set(px, py + 1, pz, c.n, { half: 'upper' }, state.catIdx);
    } else if (/_bed$/.test(c.n)) {
      // 床：头尾各一块，面对面摆（默认朝南），同样要求两格都空着
      if (!state.world.inBounds(px, py, pz + 1) || state.world.has(px, py, pz + 1)) {
        dbg('拒绝：床要占两格');
        toast('床要占两格（前后各一格），这里放不下');
        return;
      }
      changed = state.world.set(px, py, pz, c.n, { facing: 'south', part: 'head' }, state.catIdx);
      state.world.set(px, py, pz + 1, c.n, { facing: 'north', part: 'foot' }, state.catIdx);
    } else if (/_wall_(banner|sign|head|skull|hanging_sign)$/.test(c.n)) {
      // 贴墙类：自动找相邻的方块决定朝向（facing = 远离墙的方向）
      var wf = 'north';
      if (state.world.has(px, py, pz - 1)) wf = 'south';
      else if (state.world.has(px, py, pz + 1)) wf = 'north';
      else if (state.world.has(px - 1, py, pz)) wf = 'east';
      else if (state.world.has(px + 1, py, pz)) wf = 'west';
      changed = state.world.set(px, py, pz, c.n, { facing: wf }, state.catIdx);
    } else if (c.n === 'chest' || /_chest$/.test(c.n)) {
      // 箱子：默认正面朝南（对着默认视角），这样放下去就能看到锁
      changed = state.world.set(px, py, pz, c.n, { facing: 'south' }, state.catIdx);
    } else {
      changed = state.world.set(px, py, pz, placeName, placeProps, placeIdx);
    }
    state.world.endBatch();
    if (!changed) {
      dbg('拒绝：该位置已有相同方块 ' + px + ',' + py + ',' + pz);
      return;
    }
    dbg('已放置 ' + c.n + ' @ ' + px + ',' + py + ',' + pz);
    // 高亮新放的格子
    state.outline = { x: px, y: py, z: pz };
    state.renderer.setOutline(state.outline);
    afterChange();
  }

  /** 长按删除命中格本身 */
  function deleteAt(hit) {
    if (state.world.getEntity(hit.x, hit.y, hit.z)) {
      state.world.removeEntity(hit.x, hit.y, hit.z);
      afterChange();
      return;
    }
    var cell = state.world.get(hit.x, hit.y, hit.z);
    state.world.beginBatch('删除');
    var changed = state.world.remove(hit.x, hit.y, hit.z);
    // 两格高/两格的方块：连着另一半一起删
    if (changed && cell && cell.p) {
      if (cell.p.half === 'lower' || cell.p.half === 'upper') {
        var oy = hit.y + (cell.p.half === 'lower' ? 1 : -1);
        var other = state.world.get(hit.x, oy, hit.z);
        if (other && other.n === cell.n) state.world.remove(hit.x, oy, hit.z);
      } else if (cell.p.part === 'head' || cell.p.part === 'foot') {
        var dz = cell.p.facing === 'south' ? 1 : -1;
        var other2 = state.world.get(hit.x, hit.y, hit.z + dz);
        if (other2 && other2.n === cell.n) state.world.remove(hit.x, hit.y, hit.z + dz);
      }
    }
    state.world.endBatch();
    if (!changed) return;
    // 若删的正是高亮格，取消高亮
    if (state.outline && state.outline.x === hit.x && state.outline.y === hit.y && state.outline.z === hit.z) {
      state.outline = null;
      state.renderer.setOutline(null);
    }
    afterChange();
    var cc = cell ? state.catalog[cell.c] : null;
    toast('已删除' + (cc && cc.cn ? '：' + cc.cn : ''));
  }

  // ---------------------------------------------------------------- 变体组
  // MC 里有些「同类型」是拆成 16 个方块 ID 实现的（比如插了不同颜色蜡烛的蛋糕）。
  // 这些在状态面板里合并成一行，选一下就换方块。
  var COLOR_LIST = [
    ['白', 'white'], ['橙', 'orange'], ['品红', 'magenta'], ['淡蓝', 'light_blue'],
    ['黄', 'yellow'], ['黄绿', 'lime'], ['粉', 'pink'], ['灰', 'gray'],
    ['淡灰', 'light_gray'], ['青', 'cyan'], ['紫', 'purple'], ['蓝', 'blue'],
    ['棕', 'brown'], ['绿', 'green'], ['红', 'red'], ['黑', 'black']
  ];

  /** 纯颜色变体组（羊毛/床/混凝土…） */
  function colorGroup(id, label, suffix) {
    var list = [];
    for (var i = 0; i < COLOR_LIST.length; i++) {
      list.push([COLOR_LIST[i][0], COLOR_LIST[i][1] + suffix]);
    }
    return { id: id, label: label, key: 'variant', list: list };
  }

  var VARIANT_GROUPS = [
    // 蛋糕：默认不插蜡烛，可选 16 色
    {
      id: 'cake_candle', label: '蜡烛', key: 'variant',
      list: [['无', 'cake']].concat(COLOR_LIST.map(function (c) {
        return [c[0], c[1] + '_candle_cake'];
      }))
    },
    colorGroup('bed', '颜色', '_bed'),
    colorGroup('wool', '颜色', '_wool'),
    colorGroup('carpet', '颜色', '_carpet'),
    colorGroup('concrete', '颜色', '_concrete'),
    colorGroup('concrete_powder', '颜色', '_concrete_powder'),
    colorGroup('stained_glass', '颜色', '_stained_glass'),
    colorGroup('stained_glass_pane', '颜色', '_stained_glass_pane'),
    {
      id: 'candle', label: '颜色', key: 'variant',
      list: [['普通', 'candle']].concat(COLOR_LIST.map(function (c) {
        return [c[0], c[1] + '_candle'];
      }))
    },
    {
      id: 'shulker_box', label: '颜色', key: 'variant',
      list: [['紫', 'shulker_box']].concat(COLOR_LIST.map(function (c) {
        return [c[0], c[1] + '_shulker_box'];
      }))
    },
    // MC 同类合并思路：只差颜色的 16 个方块 ID 并成一格（箭头展开）
    colorGroup('terracotta', '颜色', '_terracotta'),
    colorGroup('glazed_terracotta', '颜色', '_glazed_terracotta'),
    colorGroup('banner', '颜色', '_banner')
  ];

  /** 盆栽：38 个变体，从 catalog 动态生成（中文名去掉「盆栽」作标签） */
  function buildPotGroup() {
    var list = [['空', 'flower_pot']];
    for (var i = 0; i < state.catalog.length; i++) {
      var c = state.catalog[i];
      if (c.n.indexOf('potted_') === 0) {
        list.push([(c.cn || c.n).replace('盆栽', ''), c.n]);
      }
    }
    return { id: 'flower_pot', label: '盆栽', key: 'variant', list: list };
  }

  /** 这个方块属于哪个变体组（返回 {g, idx} 或 null） */
  function findVariantGroup(blockName) {
    for (var i = 0; i < VARIANT_GROUPS.length; i++) {
      var g = VARIANT_GROUPS[i];
      for (var j = 0; j < g.list.length; j++) {
        if (g.list[j][1] === blockName) return { g: g, idx: j };
      }
    }
    return null;
  }

  /** 切换变体（进撤销栈） */
  function setBlockVariant(g, blockName) {
    var sb = state.selBlock;
    if (!sb) return;
    var ci = -1;
    for (var i = 0; i < state.catalog.length; i++) {
      if (state.catalog[i].n === blockName) { ci = i; break; }
    }
    if (ci < 0) { toast('当前版本没有 ' + blockName); return; }
    var v = sb.v;
    state.world.beginBatch('换变体');
    state.world.set(sb.x, sb.y, sb.z, blockName, v.p, ci);
    state.world.endBatch();
    var nv = state.world.get(sb.x, sb.y, sb.z);
    if (nv) sb.v = nv;
    renderStateSheet();
    afterChange();
    toast('换成 ' + (state.catalog[ci].cn || blockName));
  }

  /** 变体行渲染 */
  function renderVariantRow(hit) {
    var g = hit.g;
    var row = document.createElement('div');
    row.className = 'stRow';
    var nm = document.createElement('div');
    nm.className = 'stName';
    nm.textContent = g.label;
    var tag = document.createElement('b');
    tag.textContent = 'variant';
    nm.appendChild(tag);
    row.appendChild(nm);

    var chips = document.createElement('div');
    chips.className = 'stChips';
    for (var i = 0; i < g.list.length; i++) {
      (function (it, i2) {
        var btn = document.createElement('button');
        btn.className = 'stChip' + (i2 === hit.idx ? ' on' : '');
        btn.textContent = it[0];
        btn.addEventListener('click', function () { setBlockVariant(g, it[1]); });
        chips.appendChild(btn);
      })(g.list[i], i);
    }
    row.appendChild(chips);
    dom.stBody.appendChild(row);
  }

  // ---------------------------------------------------------------- F9 方块状态编辑
  // 属性名 / 枚举值的中文标签（没有的就显示原文）
  // 虚拟状态：原版没有对应 blockstate、只影响预览显示的属性（不会写进 NBT）
  var EXTRA_STATES = {
    conduit: [{ name: 'active', type: 'bool', values: ['false', 'true'] }]
  };

  var PROP_CN = {
    facing: '朝向', half: '半', shape: '形状', axis: '轴', type: '类型',
    waterlogged: '含水', powered: '充能', open: '开合', hinge: '合页',
    level: '等级', age: '年龄', moisture: '湿度', power: '强度',
    up: '上', down: '下', north: '北', south: '南', east: '东', west: '西',
    lit: '点亮', instrument: '音色', note: '音高', mode: '模式',
    orientation: '朝向', attachment: '附着', face: '面', rotation: '旋转',
    stage: '阶段', bites: '咬数', delay: '延迟', locked: '上锁',
    in_wall: '嵌墙', disarmed: '已拆除', conditional: '有条件', extended: '伸出',
    short: '矮柱', eye: '眼睛', has_record: '有唱片', hatch: '舱口', eggs: '蛋数',
    vertical_direction: '竖直方向', thickness: '厚度', distance: '距离',
    persistent: '持久', drag: '阻力', signal_fire: '信号火', hanging: '悬挂',
    berries: '浆果', snowy: '积雪', water: '水位', pickles: '泡菜数',
    candles: '蜡烛数', compare: '比较模式', bloom: '开花', tilt: '倾斜',
    propagate: '传播', unstable: '不稳定', natural: '自然', snowy_far: '远雪',
    active: '激活'
  };
  var VAL_CN = {
    north: '北', south: '南', east: '东', west: '西', up: '上', down: '下',
    top: '上', bottom: '下', upper: '上半', lower: '下半',
    x: 'X 轴', y: 'Y 轴', z: 'Z 轴',
    straight: '直', inner_left: '内左', inner_right: '内右',
    outer_left: '外左', outer_right: '外右',
    left: '左', right: '右', side: '侧面', double: '双层',
    north_south: '南北', east_west: '东西',
    ascending_east: '上坡·东', ascending_west: '上坡·西',
    ascending_north: '上坡·北', ascending_south: '上坡·南',
    south_east: '东南', south_west: '西南', north_west: '西北', north_east: '东北',
    single: '单个', floor: '地面', wall: '墙面', ceiling: '天花板',
    'true': '开', 'false': '关',
    none: '无', all: '全部', straight_rail: '直轨'
  };

  function openStateSheet() {
    if (!state.selBlock) return;
    renderStateSheet();
    if (dom.stSheet) dom.stSheet.classList.add('show');
  }

  function closeStateSheet() {
    if (dom.stSheet) dom.stSheet.classList.remove('show');
  }

  /** 根据 selBlock 重新生成面板内容 */
  function renderStateSheet() {
    var sb = state.selBlock;
    if (!sb) { closeStateSheet(); return; }
    var v = sb.v;
    var c = state.catalog[v.c];
    if (!c) { closeStateSheet(); return; }

    dom.stTitle.textContent = c.cn || c.n;
    var st = (c.st || []).concat(EXTRA_STATES[c.n] || []);
    var extraProps = v.x || {};
    dom.stSub.textContent = c.n + ' · ' + sb.x + ',' + sb.y + ',' + sb.z +
      ' · ' + (st.length ? st.length + ' 项状态' : '无状态') + ' · 导出时写入';

    var props = v.p || {};
    dom.stBody.innerHTML = '';
    var _vg = findVariantGroup(c.n);
    if (_vg) renderVariantRow(_vg);
    if (!st.length) {
      if (!_vg) {
        var tip = document.createElement('div');
        tip.className = 'shEmpty';
        tip.textContent = '这个方块没有可编辑的状态，导出时使用游戏默认值。';
        dom.stBody.appendChild(tip);
      }
      return;
    }

    for (var i = 0; i < st.length; i++) {
      (function (s) {
        var row = document.createElement('div');
        row.className = 'stRow';

        var nm = document.createElement('div');
        nm.className = 'stName';
        nm.textContent = PROP_CN[s.name] || s.name;
        var keyTag = document.createElement('b');
        keyTag.textContent = s.name;
        nm.appendChild(keyTag);
        row.appendChild(nm);

        var chips = document.createElement('div');
        chips.className = 'stChips';

        // 「默认」= 不写这个属性，交给游戏自己取值
        var defChip = document.createElement('button');
        defChip.className = 'stChip' + (props[s.name] === undefined && extraProps[s.name] === undefined ? ' on' : '');
        defChip.textContent = '默认';
        defChip.addEventListener('click', function () { setBlockProp(s.name, null); });
        chips.appendChild(defChip);

        var vals = (s.values && s.values.length) ? s.values.slice() : ['false', 'true'];
        for (var j = 0; j < vals.length; j++) {
          (function (val) {
            var btn = document.createElement('button');
            var _curVal = (props[s.name] !== undefined) ? props[s.name] : extraProps[s.name];
            btn.className = 'stChip' + (_curVal === val ? ' on' : '');
            btn.textContent = VAL_CN[val] || val;
            btn.addEventListener('click', function () { setBlockProp(s.name, val); });
            chips.appendChild(btn);
          })(String(vals[j]));
        }
        row.appendChild(chips);
        dom.stBody.appendChild(row);
      })(st[i]);
    }
  }

  /** 修改单个属性（进撤销栈）；val=null 表示删掉这个属性 */
  var DIR4 = { south: [0, 1], north: [0, -1], east: [1, 0], west: [-1, 0] };
  var OPP4 = { south: 'north', north: 'south', east: 'west', west: 'east' };

  /** 多格方块：改一半的状态时，另一半要跟着走（床会移位，门/高草同步属性） */
  function syncPairedBlock(sb, oldProps) {
    var w = state.world, v = sb.v, p = v.p || {};
    var x = sb.x, y = sb.y, z = sb.z;

    // 1) 床：头尾互为 facing 的相反方向，转朝向时另一半要挪位置
    if (/_bed$/.test(v.n) && p.part && p.facing && DIR4[p.facing]) {
      var d = DIR4[p.facing];
      var od = (oldProps && DIR4[oldProps.facing]) || d;   // 旧朝向（找旧伙伴用）
      var ox = x + od[0], oz = z + od[1];            // 旧伙伴位置 = 自己 + (旧) facing
      var other = w.get(ox, y, oz);
      if (!other || other.n !== v.n || !other.p || other.p.part === p.part) return;
      var nx = x + d[0], nz = z + d[1];              // 新伙伴位置 = 自己 + facing
      if (nx === ox && nz === oz) return;
      if (!w.inBounds(nx, y, nz) || w.get(nx, y, nz)) {
        toast('床的另一半放不下，没转');
        return;
      }
      w.remove(ox, y, oz);
      var np = { part: other.p.part, facing: OPP4[p.facing] };
      w.set(nx, y, nz, v.n, np, other.c);
      return;
    }

    // 2) 门：上下两半共用 facing / hinge / open
    if (/_door$/.test(v.n) && p.half) {
      var dy = p.half === 'lower' ? 1 : -1;
      var d2 = w.get(x, y + dy, z);
      if (d2 && d2.n === v.n) {
        var np2 = {};
        for (var k2 in (d2.p || {})) { if (Object.prototype.hasOwnProperty.call(d2.p, k2)) np2[k2] = d2.p[k2]; }
        if (p.facing) np2.facing = p.facing;
        if (p.hinge) np2.hinge = p.hinge;
        if (p.open) np2.open = p.open;
        w.set(x, y + dy, z, v.n, np2, d2.c);
      }
      return;
    }

    // 3) 两格高的植物：上下同款
    if (TALL_BLOCKS[v.n] && p.half) {
      var dy3 = p.half === 'lower' ? 1 : -1;
      var d3 = w.get(x, y + dy3, z);
      if (d3 && d3.n === v.n) w.set(x, y + dy3, z, v.n, d3.p, d3.c);
    }
  }

  function setBlockProp(name, val) {
    var sb = state.selBlock;
    if (!sb) return;
    var v = sb.v;
    // 虚拟状态（潮涌核心的激活）：只影响预览，不写进 NBT
    if (EXTRA_STATES[v.n] && EXTRA_STATES[v.n].some(function (s) { return s.name === name; })) {
      if (!v.x) v.x = {};
      if (val === null) delete v.x[name];
      else v.x[name] = String(val);
      renderStateSheet();
      afterChange();
      return;
    }
    var np = {};
    var old = v.p || {};
    var n = 0;
    for (var k in old) {
      if (!Object.prototype.hasOwnProperty.call(old, k)) continue;
      if (val === null && k === name) continue;
      np[k] = old[k];
      n++;
    }
    if (val !== null) { np[name] = String(val); n++; }
    var out = n ? np : null;

    var _oldProps = null;
    if (v.p) { _oldProps = {}; for (var _k in v.p) { if (Object.prototype.hasOwnProperty.call(v.p, _k)) _oldProps[_k] = v.p[_k]; } }
    state.world.beginBatch('状态 ' + name);
    state.world.set(sb.x, sb.y, sb.z, v.n, out, v.c);
    var _nv0 = state.world.get(sb.x, sb.y, sb.z);
    if (_nv0) {
      var _save = state.selBlock;
      state.selBlock = { x: sb.x, y: sb.y, z: sb.z, v: _nv0 };
      syncPairedBlock(state.selBlock, _oldProps);
      state.selBlock = _save;
    }
    state.world.endBatch();
    var nv = state.world.get(sb.x, sb.y, sb.z);
    if (nv) sb.v = nv;
    renderStateSheet();
    afterChange();
  }

  /** tap 处理：命中 -> 放置；空白 -> 取消高亮 */
  function dbg(msg) {
    if (dom.hudDbg) dom.hudDbg.textContent = msg;
  }

  function doTap(clientX, clientY) {
    var hit = state.renderer.pick(clientX, clientY, state.mode, state.pierceNames);
    // 删除模式：实体也要能点中（擦除模式下 pick() 不会命中地面，所以要单独拾取）
    var entHit = null;
    if (state.mode === 'erase' && hasTarget() && state.renderer.pickEntity) {
      entHit = state.renderer.pickEntity(clientX, clientY, state.entGroup);
    }
    if (dom.hudDbg && state.renderer && state.renderer._gridDbg) {
      // 把网格调试信息顺便显示出来
    }
    if (!hit) {
      if (entHit) {                                   // 只打中实体（脚下没方块）也要能删
        var ek = entHit.key.split(',');
        state.world.removeEntity(+ek[0], +ek[1], +ek[2]);
        afterChange();
        toast('已删除实体');
        dbg('删除实体 @ ' + entHit.key);
        return;
      }
      var R = state.renderer;
      var g = R && R._ground;
      var cam = R && R.camera;
      dbg('miss | ground=' + (g ? 'Y' : 'N') +
          ' scale=' + (g ? Math.round(g.scale.x) + 'x' + Math.round(g.scale.y) : '-') +
          ' camY=' + (cam ? Math.round(cam.position.y) : '-') +
          ' sx=' + (R ? R.sx : '-') +
          ' rect=' + Math.round(R.canvas.getBoundingClientRect().width));
      if (state.outline) {
        state.outline = null;
        state.renderer.setOutline(null);
      }
      return;
    }
    dbg('hit ' + hit.x + ',' + hit.y + ',' + hit.z + ' n=' + hit.nx + ',' + hit.ny + ',' + hit.nz + (hit.ground ? ' 地面' : ''));

    // ① 删除模式：实体比它身后的方块更近就删实体，否则删方块
    if (state.mode === 'erase' && hasTarget()) {
      if (entHit && (!hit.dist || entHit.dist <= hit.dist)) {
        var kp = entHit.key.split(',');
        state.world.removeEntity(+kp[0], +kp[1], +kp[2]);
        afterChange();
        toast('已删除实体');
        dbg('删除实体 @ ' + entHit.key);
        return;
      }
      deleteAt(hit);
      return;
    }

    // ② 已选中放置目标（方块或实体）→ 放置
    if (hasTarget()) { placeAt(hit); return; }

    // ③ 选择模式：点场景里的方块 -> 选中它（用于状态编辑，不影响要放置的方块）
    if (state.catIdx === null) {
      var v = state.world.get(hit.x, hit.y, hit.z);
      if (v && state.catalog[v.c]) {
        state.selBlock = { x: hit.x, y: hit.y, z: hit.z, v: v };
        state.renderer.setOutline({ x: hit.x, y: hit.y, z: hit.z });
        if (dom.btnState) dom.btnState.classList.add('show');
        toast('已选中方块：' + (state.catalog[v.c].cn || state.catalog[v.c].n));
      } else {
        state.selBlock = null;
        if (dom.btnState) dom.btnState.classList.remove('show');
        state.renderer.setOutline(null);
      }
      return;
    }

  }

  /** 框选批量应用（建造=填充，删除=清除） */
  function applySelection() {
    if (!selStart || !selEnd) return;
    var x0 = Math.min(selStart.x, selEnd.x), x1 = Math.max(selStart.x, selEnd.x);
    var y0 = Math.min(selStart.y, selEnd.y), y1 = Math.max(selStart.y, selEnd.y);
    var z0 = Math.min(selStart.z, selEnd.z), z1 = Math.max(selStart.z, selEnd.z);
    var total = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
    if (total > 4096) {
      toast('选区太大（' + total + ' 格），上限 4096');
      return;
    }
    var erase = state.mode === 'erase';
    var c = state.catIdx !== null ? state.catalog[state.catIdx] : null;
    if (!erase && !c) { toast('请先选一个方块'); return; }

    var n = 0;
    state.world.beginBatch(erase ? '框选删除' : '框选填充');
    for (var x = x0; x <= x1; x++) {
      for (var y = y0; y <= y1; y++) {
        for (var z = z0; z <= z1; z++) {
          if (erase) {
            if (state.world.remove(x, y, z)) n++;
          } else {
            if (state.world.set(x, y, z, c.n, null, state.catIdx)) n++;
          }
        }
      }
    }
    state.world.endBatch();
    afterChange();
    toast('框选' + (erase ? '删除' : '填充') + ' ' + n + ' 格（共 ' + total + '）');
    dbg('框选完成：' + n + '/' + total);
  }

  // ---------------------------------------------------------------- F6 相机控制（Pointer Events）
  var pointers = new Map();   // pointerId -> {x,y,sx,sy,lastX,lastY,t,moved}
  var longPressTimer = null;  // 长按计时器
  var selecting = false;      // 框选中
  var selStart = null;
  var selEnd = null;
  var longPressId = null;
  var pinch = null;           // 双指捏合状态
  var pan3 = null;            // 三指平移状态
  var wasPinch = false;       // 本次手势出现过双指 -> 结束后不再触发 tap

  /**
   * 平移目标点：沿「相机右向量 / 相机上向量」走，任意旋转姿态（含仰视、滚转）都对。
   * 以前用的是「水平前向量」——相机一旦大角度就完全错位。
   */
  function panBy(dmx, dmy, base) {
    var o = state.renderer.orbit;
    var s = o.radius * 0.0015;
    var rx, ry, rz, ux, uy, uz;
    if (window.THREE) {
      var q = state.renderer.camera.quaternion;
      var right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      var upv = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      rx = right.x; ry = right.y; rz = right.z;
      ux = upv.x; uy = upv.y; uz = upv.z;
    } else {
      var th = o.theta;
      rx = Math.sin(th); ry = 0; rz = -Math.cos(th);
      ux = 0; uy = 1; uz = 0;
    }
    o.tx = base.tx - rx * dmx * s + ux * dmy * s;
    o.ty = base.ty - ry * dmx * s + uy * dmy * s;
    o.tz = base.tz - rz * dmx * s + uz * dmy * s;
    // 别把目标拖到世界外面太远
    var lim = Math.max(32, (state.renderer.sy || 16) * 2);
    o.ty = Math.max(-lim, Math.min(lim, o.ty));
  }

  function dist2(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function onPointerDown(e) {
    if (!state.ready) return;
    e.preventDefault();
    try { dom.canvas.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    pointers.set(e.pointerId, {
      x: e.clientX, y: e.clientY,
      sx: e.clientX, sy: e.clientY,
      lastX: e.clientX, lastY: e.clientY,
      t: e.timeStamp,
      moved: false
    });
    if (pointers.size === 1) {
      // 单指：开始长按计时（600ms 未移动 -> 删除）
      longPressId = e.pointerId;
      longPressTimer = setTimeout(function () {
        longPressTimer = null;
        var p = pointers.get(longPressId);
        if (p && !p.moved) {
          var hit = state.renderer.pick(p.sx, p.sy);
          if (hit) {
            p.moved = true;             // 长按触发后不再算 tap
            // 进入框选：起点 = 命中面外侧那一格
            selStart = {
              x: hit.x + hit.nx,
              y: Math.max(0, hit.y + hit.ny),
              z: hit.z + hit.nz
            };
            selEnd = { x: selStart.x, y: selStart.y, z: selStart.z };
            selecting = true;
            state.renderer.setSelection(selStart.x, selStart.y, selStart.z,
                                        selEnd.x, selEnd.y, selEnd.z);
            dbg('框选起点 ' + selStart.x + ',' + selStart.y + ',' + selStart.z + '（拖拽）');
          }
        }
      }, LONG_MS);
    } else if (pointers.size === 2) {
      // 双指：取消长按，初始化捏合（距离比例缩放 + 中心移动平移）
      wasPinch = true;
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      var ps = [];
      pointers.forEach(function (p) { ps.push(p); });
      pinch = {
        d0: dist2(ps[0], ps[1]),
        r0: state.renderer.orbit.radius,
        mx0: (ps[0].x + ps[1].x) / 2,
        my0: (ps[0].y + ps[1].y) / 2,
        tx0: state.renderer.orbit.tx,
        ty0: state.renderer.orbit.ty,
        tz0: state.renderer.orbit.tz
      };
    } else if (pointers.size === 3) {
      // 三指：平移摄像机（只改目标点，不改缩放）
      wasPinch = true;
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      pinch = null;
      startPan3();
    }
  }

  /** 记录三指起始的质心与相机目标点 */
  function startPan3() {
    var ps = [];
    pointers.forEach(function (p) { ps.push(p); });
    if (ps.length < 3) return;
    var mx = 0, my = 0;
    for (var i = 0; i < ps.length; i++) { mx += ps[i].x; my += ps[i].y; }
    pan3 = {
      mx0: mx / ps.length,
      my0: my / ps.length,
      tx0: state.renderer.orbit.tx,
      ty0: state.renderer.orbit.ty,
      tz0: state.renderer.orbit.tz
    };
  }

  function onPointerMove(e) {
    var p = pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    p.x = e.clientX;
    p.y = e.clientY;
    // 超过阈值才算拖拽（同时取消长按）
    if (!p.moved && (Math.abs(p.x - p.sx) + Math.abs(p.y - p.sy) > DRAG_PX)) {
      p.moved = true;
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    }
    // 框选中：更新选区，不旋转相机
    if (selecting && pointers.size === 1 && p.moved) {
      var sh = state.renderer.pick(p.x, p.y);
      if (sh) {
        selEnd = {
          x: sh.x + sh.nx,
          y: Math.max(0, sh.y + sh.ny),
          z: sh.z + sh.nz
        };
        state.renderer.setSelection(selStart.x, selStart.y, selStart.z,
                                    selEnd.x, selEnd.y, selEnd.z);
        dbg('框选 ' + (Math.abs(selEnd.x - selStart.x) + 1) + '×' +
            (Math.abs(selEnd.z - selStart.z) + 1) + ' @y' + selStart.y);
      }
      return;
    }

    var o = state.renderer.orbit;
    if (pointers.size === 1 && p.moved && !wasPinch) {
      // 拖拽旋转
      var dx = p.x - p.lastX;
      var dy = p.y - p.lastY;
      p.lastX = p.x;
      p.lastY = p.y;
      // ★ 绝对自由旋转：四元数增量，绕屏幕轴转，没有上下限、能翻过极点、能滚转
      if (!o.q) state.renderer.setOrbitFromAngles();
      var qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -dx * 0.008);
      var qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -dy * 0.008);
      o.q.multiply(qy).multiply(qx).normalize();
    } else if (pointers.size === 2 && pinch) {
      // 双指捏合：半径按两指距离比例；中心移动 -> 沿相机水平方向平移
      var ps = [];
      pointers.forEach(function (q) { ps.push(q); });
      if (ps.length < 2) return;
      var d1 = dist2(ps[0], ps[1]);
      if (d1 > 0 && pinch.d0 > 0) {
        var r = pinch.r0 * (pinch.d0 / d1);
        var minR2 = Math.max(10, (state.renderer ? state.renderer.sx : 16) * 0.85);
        o.radius = Math.max(minR2, Math.min(400, r));
      }
      var dmx = (ps[0].x + ps[1].x) / 2 - pinch.mx0;
      var dmy = (ps[0].y + ps[1].y) / 2 - pinch.my0;
      panBy(dmx, dmy, { tx: pinch.tx0, ty: (pinch.ty0 === undefined ? o.ty : pinch.ty0), tz: pinch.tz0 });
    } else if (pointers.size >= 3 && pan3) {
      // 三指平移：质心位移映射到相机的「右」和「水平前」方向
      var qs = [];
      pointers.forEach(function (q) { qs.push(q); });
      var mx = 0, my = 0;
      for (var qi = 0; qi < qs.length; qi++) { mx += qs[qi].x; my += qs[qi].y; }
      mx /= qs.length; my /= qs.length;
      var dmx2 = mx - pan3.mx0;
      var dmy2 = my - pan3.my0;
      // 同样按相机 right / up 平移（三指也支持大角度）
      panBy(dmx2, dmy2, { tx: pan3.tx0, ty: pan3.ty0, tz: pan3.tz0 });
    }
  }

  function onPointerUp(e) {
    var p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (longPressTimer && longPressId === e.pointerId) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    // 三指松开一根 -> 退回两指，用剩下的两指重建捏合基准，避免手势卡死
    if (pan3 && pointers.size === 2) {
      var rs = [];
      pointers.forEach(function (q) { rs.push(q); });
      pinch = {
        d0: dist2(rs[0], rs[1]),
        r0: state.renderer.orbit.radius,
        mx0: (rs[0].x + rs[1].x) / 2,
        my0: (rs[0].y + rs[1].y) / 2,
        tx0: state.renderer.orbit.tx,
        ty0: state.renderer.orbit.ty,
        tz0: state.renderer.orbit.tz
      };
      pan3 = null;
    }
    if (pointers.size === 0 && selecting) {
      applySelection();
      selecting = false;
      selStart = null;
      selEnd = null;
      if (state.renderer.clearSelection) state.renderer.clearSelection();
      pinch = null;
      pan3 = null;
      wasPinch = false;
      return;
    }
    if (pointers.size === 0) {
      pinch = null;
      pan3 = null;
      // tap：位移 < 8px 且时长 < 400ms（双指手势结束不触发）
      if (p && !p.moved && !wasPinch && (e.timeStamp - p.t) < TAP_MS) {
        doTap(e.clientX, e.clientY);
      }
      wasPinch = false;
    }
  }

  function onWheel(e) {
    if (!state.ready) return;
    e.preventDefault();
    var o = state.renderer.orbit;
    var minR = Math.max(10, (state.renderer ? state.renderer.sx : 16) * 0.85);
    o.radius = Math.max(minR, Math.min(400, o.radius * (1 + e.deltaY * 0.001)));
  }

  /** 让 canvas 的上下边界跟随 topbar / bottom 的实际高度（抽屉展开收起时会变） */
  function layoutCanvas() {
    var t = dom.topbar ? dom.topbar.getBoundingClientRect().height : 56;
    var b = dom.bottom ? dom.bottom.getBoundingClientRect().height : 200;
    var c = dom.canvas;
    // canvas 是替换元素，auto 不会拉伸 —— 必须给明确像素宽高
    var w = Math.max(200, Math.round(window.innerWidth));
    // 画布铺满「顶栏以下」全部区域；底部菜单浮在它上面，
    // 这样抽屉开合不会改变画布尺寸（避免 3D 缩放和闪烁）
    var h = Math.max(140, Math.round(window.innerHeight - t));
    c.style.top = Math.round(t) + 'px';
    c.style.left = '0px';
    c.style.width = w + 'px';
    c.style.height = h + 'px';
    if (state.renderer) state.renderer.resize();
  }

  function onResize() {
    layoutCanvas();
  }

  // ---------------------------------------------------------------- F10 导出
  /** 生成默认文件名 structure_YYYYMMDD_HHmm */
  function defaultName() {
    var d = new Date();
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return 'structure_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '_' + p(d.getHours()) + p(d.getMinutes());
  }

  function openExport() {
    if (!state.world || state.world.stats().total === 0) {
      toast('空世界不能导出');
      return;
    }
    dom.expName.value = defaultName();
    dom.expTrim.checked = true;
    updateExportUI();
    dom.exportModal.classList.add('show');
  }
  function closeExport() {
    dom.exportModal.classList.remove('show');
  }

  /**
   * 空层裁剪：把 blocks 平移到包围盒原点，并缩小 size。
   * 直接改写 NBT 复合体对象（encode 只读它，安全）。
   */
  function trimEmptyLayers(compound) {
    var items = compound.v.blocks.v.items;
    if (!items.length) return;
    var minX = Infinity, minY = Infinity, minZ = Infinity;
    var maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (var i = 0; i < items.length; i++) {
      var pos = items[i].v.pos.v.items;
      var x = pos[0].v, y = pos[1].v, z = pos[2].v;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    for (var j = 0; j < items.length; j++) {
      var p2 = items[j].v.pos.v.items;
      p2[0].v -= minX;
      p2[1].v -= minY;
      p2[2].v -= minZ;
    }
    var sz = compound.v.size.v.items;
    sz[0].v = maxX - minX + 1;
    sz[1].v = maxY - minY + 1;
    sz[2].v = maxZ - minZ + 1;
  }

  /** 把空位置全部填成 structure_void（保证粘贴不破坏周围方块） */
  function fillVoidBlocks(compound) {
    var N = NBT.N, TAG = NBT.TAG;
    var size = compound.v.size.v.items;
    var sx = size[0].v, sy = size[1].v, sz = size[2].v;
    var blocks = compound.v.blocks.v.items;
    var palette = compound.v.palette.v.items;

    var occupied = {};
    for (var i = 0; i < blocks.length; i++) {
      var p = blocks[i].v.pos.v.items;
      occupied[p[0].v + ',' + p[1].v + ',' + p[2].v] = 1;
    }

    var voidIdx = -1;
    for (var j = 0; j < palette.length; j++) {
      if (palette[j].v.Name.v === 'minecraft:structure_void') { voidIdx = j; break; }
    }
    if (voidIdx < 0) {
      voidIdx = palette.length;
      palette.push(N.compound({ Name: N.string('minecraft:structure_void') }));
    }

    var added = 0;
    for (var x = 0; x < sx; x++) {
      for (var y = 0; y < sy; y++) {
        for (var z = 0; z < sz; z++) {
          if (occupied[x + ',' + y + ',' + z]) continue;
          blocks.push(N.compound({
            pos: N.list(TAG.Int, [N.int(x), N.int(y), N.int(z)]),
            state: N.int(voidIdx)
          }));
          added++;
        }
      }
    }
    return added;
  }

  // ---------------------------------------------------------------- 导出格式
  /** 格式切换时：说明文字 + 只对 .nbt 有效的选项 */
  function updateExportUI() {
    var fmt = dom.expFmt ? dom.expFmt.value : 'nbt';
    var tips = {
      nbt: '原版结构：最通用，结构方块直接加载；可选用结构空位填充空白。',
      litematic: 'Litematica 投影：自动裁剪到方块包围盒，游戏里用投影模组贴上去照着搭。',
      schem: 'WorldEdit / FAWE 原理图（Sponge v2）：//paste 直接粘贴，服务器常用。'
    };
    if (dom.expFmtTip) dom.expFmtTip.textContent = tips[fmt] || '';
    var onlyNbt = fmt === 'nbt';
    if (dom.expVoidRow) dom.expVoidRow.style.display = onlyNbt ? '' : 'none';
    if (dom.expTrimRow) dom.expTrimRow.style.display = onlyNbt ? '' : 'none';
  }

  /** 世界快照（trim=true 时裁到有方块的包围盒） */
  function snapshotWorld(trim) {
    var minX = Infinity, minY = Infinity, minZ = Infinity;
    var maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    var list = [];
    state.world.map.forEach(function (v, k) {
      var p = k.split(','), x = +p[0], y = +p[1], z = +p[2];
      list.push({ x: x, y: y, z: z, n: v.n, p: v.p || null });
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    });
    if (!list.length) return null;
    var ox, oy, oz, sx, sy, sz;
    if (trim) {
      ox = minX; oy = minY; oz = minZ;
      sx = maxX - minX + 1; sy = maxY - minY + 1; sz = maxZ - minZ + 1;
    } else {
      ox = 0; oy = 0; oz = 0;
      sx = state.world.sx; sy = state.world.sy; sz = state.world.sz;
    }
    var blocks = [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      var bx = b.x - ox, by = b.y - oy, bz = b.z - oz;
      if (bx < 0 || by < 0 || bz < 0 || bx >= sx || by >= sy || bz >= sz) continue;
      blocks.push({ x: bx, y: by, z: bz, n: b.n, p: b.p });
    }
    var ents = [];
    if (state.world.entities) {
      state.world.entities.forEach(function (e, k) {
        var q = k.split(',');
        var ex = +q[0] - ox, ey = +q[1] - oy, ez = +q[2] - oz;
        if (ex < 0 || ey < 0 || ez < 0 || ex >= sx || ey >= sy || ez >= sz) return;
        ents.push({ x: ex, y: ey, z: ez, id: e.id || 'minecraft:pig', yaw: e.yaw || 0 });
      });
    }
    return { ox: ox, oy: oy, oz: oz, sx: sx, sy: sy, sz: sz, blocks: blocks, entities: ents };
  }

  /** Litematica .litematic（未压缩 NBT，调用方再 gzip） */
  function buildLitematic(snap, dataVersion, title) {
    var N = NBT.N, T = NBT.TAG;
    var pal = [], palIdx = new Map();
    pal.push({ name: 'minecraft:air', props: {} });
    palIdx.set('minecraft:air|{}', 0);
    function sid(b) {
      var keys = b.p ? Object.keys(b.p).sort() : [];
      var props = {}, i;
      for (i = 0; i < keys.length; i++) props[keys[i]] = String(b.p[keys[i]]);
      var sig = b.n + '|' + JSON.stringify(props);
      var id = palIdx.get(sig);
      if (id === undefined) {
        id = pal.length;
        palIdx.set(sig, id);
        pal.push({ name: b.n, props: props });
      }
      return id;
    }

    var SX = snap.sx, SY = snap.sy, SZ = snap.sz;
    var volume = SX * SY * SZ;
    var ids = new Uint32Array(volume);
    for (var bi = 0; bi < snap.blocks.length; bi++) {
      var b = snap.blocks[bi];
      ids[b.y * SZ * SX + b.z * SX + b.x] = sid(b);   // Litematica: (y*sizeZ + z)*sizeX + x
    }

    var bits = 1;
    while ((1 << bits) < pal.length) bits++;
    if (bits < 2) bits = 2;                          // Litematica 最小 2 bit
    var perLong = Math.floor(64 / bits);
    var nLongs = Math.ceil(volume / perLong);
    var longs = new Array(nLongs);
    var i2;
    for (i2 = 0; i2 < nLongs; i2++) longs[i2] = 0n;
    for (i2 = 0; i2 < volume; i2++) {
      var v2 = ids[i2];
      if (!v2) continue;
      var li = (i2 / perLong) | 0, off = (i2 % perLong) * bits;
      longs[li] = longs[li] | (BigInt(v2) << BigInt(off));
    }

    var palList = pal.map(function (pp) {
      var o = { Name: N.string(pp.name) };
      var ks = Object.keys(pp.props);
      if (ks.length) {
        var pr = {};
        ks.forEach(function (k) { pr[k] = N.string(pp.props[k]); });
        o.Properties = N.compound(pr);
      }
      return N.compound(o);
    });

    var region = {
      Position: N.compound({ x: N.int(0), y: N.int(0), z: N.int(0) }),
      Size: N.compound({ x: N.int(SX), y: N.int(SY), z: N.int(SZ) }),
      BlockStatePalette: N.list(T.Compound, palList),
      BlockStates: N.longArray(longs),
      TileEntities: N.list(T.Compound, []),
      Entities: N.list(T.Compound, snap.entities.map(function (e) {
        return N.compound({
          Pos: N.list(T.Double, [N.double(e.x + 0.5), N.double(e.y), N.double(e.z + 0.5)]),
          BlockPos: N.list(T.Int, [N.int(e.x), N.int(e.y), N.int(e.z)]),
          NBT: N.compound({ id: N.string(e.id) })
        });
      }))
    };

    return N.compound({
      MinecraftDataVersion: N.int(dataVersion),
      Version: N.int(6),
      Metadata: N.compound({
        Name: N.string(title || 'structure'),
        Author: N.string('structure-studio'),
        Description: N.string(''),
        RegionCount: N.int(1),
        TotalBlocks: N.long(BigInt(snap.blocks.length)),
        TotalVolume: N.int(volume),
        EnclosingSize: N.compound({ x: N.int(SX), y: N.int(SY), z: N.int(SZ) })
      }),
      Regions: N.compound({ Unnamed: N.compound(region) })
    });
  }

  /** WorldEdit / FAWE 的 Sponge v2 .schem */
  function buildSchem(snap, dataVersion, title) {
    var N = NBT.N, T = NBT.TAG;
    var W = snap.sx, H = snap.sy, L = snap.sz;
    var data = new Uint8Array(W * H * L);
    var pal = new Map(), names = [], nextId = 1;
    for (var i = 0; i < snap.blocks.length; i++) {
      var b = snap.blocks[i];
      var keys = b.p ? Object.keys(b.p).sort() : [];
      var key = b.n;
      if (keys.length) {
        var parts = [];
        for (var k = 0; k < keys.length; k++) parts.push(keys[k] + '=' + b.p[keys[k]]);
        key += '[' + parts.join(',') + ']';
      }
      var id = pal.get(key);
      if (id === undefined) { id = nextId++; pal.set(key, id); names.push(key); }
      data[b.x + b.z * W + b.y * W * L] = id;
    }

    var out = [];
    for (var j = 0; j < data.length; j++) {
      var val = data[j];
      while (val > 0x7f) { out.push((val & 0x7f) | 0x80); val >>>= 7; }
      out.push(val);
    }

    var palette = { 'minecraft:air': N.int(0) };
    for (var pi = 0; pi < names.length; pi++) palette[names[pi]] = N.int(pi + 1);

    return N.compound({
      Version: N.int(2),
      DataVersion: N.int(dataVersion),
      Width: N.short(W),
      Height: N.short(H),
      Length: N.short(L),
      Offset: N.intArray([0, 0, 0]),
      PaletteMax: N.int(names.length + 1),
      Palette: N.compound(palette),
      BlockData: N.byteArray(new Uint8Array(out)),
      BlockEntities: N.list(T.Compound, []),
      Metadata: N.compound({
        Name: N.string(title || 'structure'),
        Author: N.string('structure-studio')
      })
    });
  }

  /** 下载一段字节 */
  function downloadBytes(u8, filename) {
    var blob = new Blob([u8], { type: 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
  }

  function doExport() {
    var fmt = dom.expFmt ? dom.expFmt.value : 'nbt';
    var name = dom.expName.value.trim();
    if (!name) { toast('请填写文件名'); return; }
    name = name.replace(/\.(nbt|litematic|schem|schematic)$/i, '');
    var v = state.versions[state.curVer];
    var total = state.world.stats().total;

    if (fmt !== 'nbt') {
      var snap = snapshotWorld(true);
      if (!snap) { toast('空世界'); return; }
      var cc = fmt === 'litematic'
        ? buildLitematic(snap, v.dataVersion, name)
        : buildSchem(snap, v.dataVersion, name);
      var raw2 = NBT.encode(cc);
      NBT.gzip(raw2).then(function (u8) {
        var fn = name + (fmt === 'litematic' ? '.litematic' : '.schem');
        downloadBytes(u8, fn);
        toast('已导出 ' + fn + '（' + snap.sx + '×' + snap.sy + '×' + snap.sz + '，' +
          total + ' 方块 / ' + (u8.length / 1024).toFixed(1) + ' KB）');
        closeExport();
      }).catch(function (err) {
        toast('导出失败：' + (err && err.message ? err.message : String(err)));
      });
      return;
    }
    name += '.nbt';
    // 1. 构建结构 NBT 复合体
    var c = state.world.toStructureNBT({ dataVersion: v.dataVersion });
    // 2. 用结构空位填充（优先）/ 或空层裁剪
    var voidCount = 0;
    if (dom.expVoid && dom.expVoid.checked) {
      voidCount = fillVoidBlocks(c);
    } else if (dom.expTrim.checked) {
      trimEmptyLayers(c);
    }
    // 3. 编码 + gzip
    var raw = NBT.encode(c);
    NBT.gzip(raw).then(function (u8) {
      // 4. Blob 下载
      var blob = new Blob([u8], { type: 'application/octet-stream' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
      var extra = voidCount ? '，含 ' + voidCount + ' 个空位' : '';
      toast('已导出 ' + name + '（' + total + ' 方块' + extra + ' / ' + (u8.length / 1024).toFixed(1) + ' KB）');
      closeExport();
    }).catch(function (err) {
      toast('导出失败：' + (err && err.message ? err.message : String(err)));
    });
  }

  // ---------------------------------------------------------------- 事件绑定
  // ---------------------------------------------------------------- 批量替换
  function fillReplaceTargets(q, keep) {
    var v = state.versions[state.curVer];
    var ok = {};
    if (v) for (var i = 0; i < v.blocks.length; i++) ok[v.blocks[i]] = true;
    var html = '';
    var count = 0;
    var sel = keep || dom.repTo.value;
    for (var k = 0; k < state.catalog.length; k++) {
      var c = state.catalog[k];
      if (!ok[c.n]) continue;
      if (q && c.n.indexOf(q) < 0 && (!c.cn || c.cn.indexOf(q) < 0)) continue;
      html += '<option value="' + c.n + '">' + (c.cn || c.n) + ' （' + c.n + '）</option>';
      if (++count >= 400) break;
    }
    dom.repTo.innerHTML = html;
    if (sel) dom.repTo.value = sel;
  }

  function updateRepInfo() {
    if (!state.world) return;
    var counts = state.world.nameCounts();
    var from = dom.repFrom.value;
    var n = counts.get(from) || 0;
    dom.repInfo.innerHTML = from ? ('世界里共有 <b>' + n + '</b> 个 <b>' + from + '</b>') : '—';
  }

  function openReplace() {
    if (!state.world || state.world.stats().total === 0) { toast('世界是空的，没什么可换'); return; }
    var counts = state.world.nameCounts();
    var arr = [];
    counts.forEach(function (c, n) { arr.push([n, c]); });
    arr.sort(function (a, b) { return b[1] - a[1]; });
    var html = '';
    for (var i = 0; i < arr.length; i++) {
      html += '<option value="' + arr[i][0] + '">' + arr[i][0] + ' × ' + arr[i][1] + '</option>';
    }
    dom.repFrom.innerHTML = html;
    dom.repFilter.value = '';
    fillReplaceTargets('');
    updateRepInfo();
    dom.repModal.classList.add('show');
  }

  function doReplace() {
    var from = dom.repFrom.value;
    var to = dom.repTo.value;
    if (!from || !to) { toast('请选择原方块和目标方块'); return; }
    if (from === to) { toast('两边一样，没变化'); return; }
    var idx = catalogIndexOf(to);
    if (idx < 0) { toast('目标方块不在当前版本里'); return; }
    var n = state.world.replaceBlocks(from, to, idx, false);
    dom.repModal.classList.remove('show');
    if (!n) { toast('没有匹配的方块'); return; }
    toast('已替换 ' + n + ' 个方块');
    afterChange();
  }

  // ---------------------------------------------------------------- 实体方块（箱子/告示牌/床…）
  var BE_NAMES = { chest: 1, trapped_chest: 1, ender_chest: 1, bell: 1, conduit: 1,
                   decorated_pot: 1, shulker_box: 1 };

  // 每个模型的原点和 MC 渲染器的 translate 不一样，这里逐项补偿（单位：格）
  var BE_OFFSET = {
    sign: [0, 0.75, 0],
    hanging_sign: [0, 0.63, 0],
    shulker_box: [0, 1.5, 0],
    decorated_pot: [0, 1.25, 0],
    bell: [0, -0.25, 0],
    skull: [0, 0, 0],
    conduit_shell: [0, 0, 0],
    bed_head: [0, 0.375, 0],
    bed_foot: [0, 0.375, 0]
  };

  function beAssetFor(n, p) {
    if (BE_NAMES[n]) return n;
    if (/_shulker_box$/.test(n)) return 'shulker_box';
    if (/hanging_sign$/.test(n)) return 'hanging_sign';
    if (/_wall_sign$/.test(n)) return 'sign_wall';
    if (/_sign$/.test(n)) return 'sign';
    if (/_banner$/.test(n)) return 'banner';
    if (/_bed$/.test(n)) return (p && p.part === 'foot') ? 'bed_foot' : 'bed_head';
    if (/_skull$/.test(n) || /_head$/.test(n)) return 'skull';
    return null;
  }

  // 有些模型自带的「正面」和 facing 相反，这里补 180°
  var BE_YAW_FIX = { bed_head: Math.PI, bed_foot: 0 };  // 床尾再转 180°

  function beYaw(v, aid) {
    var f = v.p && v.p.facing;
    if (v.p && v.p.rotation !== undefined && /sign|banner/.test(v.n)) {
      return (parseInt(v.p.rotation, 10) || 0) * Math.PI / 8;
    }
    if (!f) return 0;
    if (f === 'south') return 0;
    if (f === 'north') return Math.PI;
    if (f === 'east') return Math.PI / 2;
    if (f === 'west') return -Math.PI / 2;
    return 0;
  }

  function beYawFor(v, aid) {
    return beYaw(v) + (BE_YAW_FIX[aid] || 0);
  }

  function beNameSet() {
    var set = new Set();
    if (!state.world) return set;
    state.world.map.forEach(function (v) {
      if (beAssetFor(v.n, v.p)) set.add(v.n);
    });
    return set;
  }

  /** 方块实体用哪张贴图：床按颜色、?uvdebug=1 用调试图 */
  function beTexFor(a, v) {
    if (/[?&]uvdebug=1/.test(location.search) && a.dbg) return a.dbg;
    if (a.texByColor) {
      var m = /^([a-z_]+)_(bed|shulker_box)$/.exec(v.n);
      if (m && a.texByColor[m[1]]) return a.texByColor[m[1]];
    }
    return a.tex;
  }

  /** 方块实体的材质染色值：旗帜旗面按颜色（白贴图 + tint），其余返回 0（不染） */
  function beTintHex(blockName) {
    if (/_banner$/.test(blockName)) {
      var m = /^([a-z_]+)_banner$/.exec(blockName);
      if (m && BANNER_RGB[m[1]] !== undefined) return BANNER_RGB[m[1]];
    }
    return 0;
  }

  /** 把 obj 里「旗面」部件（name=flag）的材质克隆并染色；不染旗杆/顶横 */
  function tintBannerMeshes(obj, tintHex) {
    if (!tintHex) return;
    obj.traverse(function (o) {
      if (o.isMesh && o.material && o.name === 'flag') {
        o.material = o.material.clone();
        o.material.color.setHex(tintHex);
      }
    });
  }

  /** 老存档/旧版本放的床只有床头 → 自动补上床尾（一次性修复） */
  function repairBeds() {
    if (!state.world) return 0;
    var todo = [];
    state.world.map.forEach(function (v, k) {
      if (!/_bed$/.test(v.n) || !v.p || v.p.part !== 'head') return;
      var q = k.split(','), x = +q[0], y = +q[1], z = +q[2];
      var f = state.world.get(x, y, z + 1);
      if (!f || f.n !== v.n) todo.push([x, y, z, v.n, v.c]);
    });
    todo.forEach(function (p) {
      if (state.world.inBounds(p[0], p[1], p[2] + 1) && !state.world.get(p[0], p[1], p[2] + 1)) {
        state.world.set(p[0], p[1], p[2] + 1, p[3], { facing: 'north', part: 'foot' }, p[4]);
      }
    });
    return todo.length;
  }

  function rebuildBlockEntities() {
    if (!state.beGroup || !state.world) return;
    var g = state.beGroup;
    while (g.children.length) { var c = g.children.pop(); g.remove(c); }
    if (!state.entModels || !state.entAssets || !window.EntityRenderer) return;
    var ox = state.world.sx / 2, oz = state.world.sz / 2;
    state.world.map.forEach(function (v, k) {
      var aid = beAssetFor(v.n, v.p);
      if (!aid) return;
      var a = state.entAssets[aid];
      var m = a && state.entModels[a.model];
      if (!m) return;
      var obj;
      try {
        if (a.layers) {
          obj = EntityRenderer.buildComposite(a.layers.map(function (L) {
            return { model: state.entModels[L.model], tex: L.tex, texW: L.texW, texH: L.texH };
          }), { yUp: !!a.yUp });
        } else {
          obj = EntityRenderer.build(m, beTexFor(a, v), {
            texW: a.texW, texH: a.texH, raw: !!a.xf, yUp: !!a.yUp, rot: a.rot
          });
        }
      } catch (err) { return; }
      // 旗帜按颜色染色（白贴图 + 材质 tint；床已用预染贴图，这里不重复染）
      tintBannerMeshes(obj, beTintHex(v.n));
      var q = k.split(',');
      var off = BE_OFFSET[aid] || [0, 0, 0];
      // ★ 朝向要包一层：模型自己可能带 rot（床的 90°），直接改 obj.rotation.y 会把它搅乱
      // 有 xf 的（复刻 MC 渲染器 PoseStack 的）直接用变换链，不再套 yaw / 居中
      if (a.hide && a.hide.length) {          // xf 分支也要隐藏零件
        obj.traverse(function (o) {
          if (o.name && a.hide.indexOf(o.name) >= 0) o.visible = false;
        });
      }
      if (a.partTex) {                        // 某些零件用另一张贴图（旗帜的杆/横梁）
        obj.traverse(function (o) {
          if (o.isMesh && o.name && a.partTex[o.name]) {
            var nt = EntityRenderer.preload(a.partTex[o.name]);
            o.material = o.material.clone();
            o.material.map = nt;
            o.material.needsUpdate = true;
          }
        });
      }
      if (a.xf) {
        var YR = { south: 0, west: 90, north: 180, east: 270 };
        var ctx = { yrot: YR[(v.p && v.p.facing) || 'north'] || 0 };
        // 三层空间：xf(方块, y 向上) → scale(1/16) → 模型(像素, y 向下)
        var scaled = new THREE.Group();
        scaled.add(obj);
        scaled.scale.set(1 / 16, 1 / 16, 1 / 16);
        var node = EntityRenderer.applyXf(scaled, a.xf, ctx);
        // ★ 不能直接改 node.position：它就是最外层那个 xf 平移节点，会被覆盖掉
        var holder = new THREE.Group();
        holder.add(node);
        holder.position.set(+q[0] - ox, +q[1], +q[2] - oz);
        g.add(holder);
        return;
      }
      if (a.hide && a.hide.length) {          // 隐藏指定零件（墙牌不要杆）
        obj.traverse(function (o) {
          if (o.name && a.hide.indexOf(o.name) >= 0) o.visible = false;
        });
      }
      var wrap = new THREE.Group();
      wrap.add(obj);
      wrap.rotation.y = beYawFor(v, aid);
      // ★ 自动把模型在 x/z 上居中到方块中心（床这种「从原点向 +z 长出去」的模型必须这样，
      //   转 180° 之后它会长到 -z/-x 方向去）
      var bb = new THREE.Box3().setFromObject(wrap);
      var cxm = (bb.min.x + bb.max.x) / 2, czm = (bb.min.z + bb.max.z) / 2;
      wrap.position.set(+q[0] + 0.5 - ox - cxm, +q[1] + off[1], +q[2] + 0.5 - oz - czm);
      obj = wrap;
      if (obj.userData && obj.userData.texture) {
        var tx = obj.userData.texture;
        if (tx.image && !tx.image.complete) {
          tx.__onload = function () { if (state.renderer) state.renderer.render(); };
        }
      }
      g.add(obj);
    });
  }

  // ---------------------------------------------------------------- 实体库 / 实体渲染
  function entAssetList() {
    var out = [];
    if (!state.entAssets) return out;
    for (var k in state.entAssets) {
      var a = state.entAssets[k];
      if (a.kind === 'mob' && a.eid) out.push({ id: k, a: a });
    }
    out.sort(function (p, q) {
      var a = (p.a.eid || p.id), b = (q.a.eid || q.id);
      return a < b ? -1 : (a > b ? 1 : (p.id < q.id ? -1 : 1));
    });
    return out;
  }

  /** 把 world.entities 全量重建到 entGroup（数量很少，直接重建最省事） */
  function rebuildEntities() {
    if (!state.entGroup || !state.world) return;
    var g = state.entGroup;
    while (g.children.length) {
      var c = g.children.pop();
      g.remove(c);
      if (window.EntityRenderer && EntityRenderer.dispose) EntityRenderer.dispose(c);
    }
    if (!state.entModels || !state.entAssets || !window.EntityRenderer) return;
    state.world.entities.forEach(function (e, k) {
      var a = state.entAssets[e.asset];
      var m = a && state.entModels[a.model];
      if (!m) return;
      var obj;
      try {
        if (a.layers) {
          obj = EntityRenderer.buildComposite(a.layers.map(function (L) {
            return { model: state.entModels[L.model], tex: L.tex, texW: L.texW, texH: L.texH };
          }), { yUp: !!a.yUp });
        } else {
          obj = EntityRenderer.build(m, beTexFor(a, { n: '' }), {
            texW: a.texW, texH: a.texH, raw: !!a.xf, yUp: !!a.yUp, rot: a.rot
          });
        }
      } catch (err) {
        if (!state._entErr) {                 // 只报一次，别刷屏；静默失败 = 实体看不见却毫无线索
          state._entErr = true;
          if (window.console) console.warn('[entity] 构建失败', err);
        }
        return;
      }
      obj.userData.entityKey = k;              // 射线拾取/删除时反查是哪一格
      var p = k.split(',');
      // 渲染器把方块世界整体挪到「以原点为中心」：x/z 各减一半；y 不动
      // 生物模型原点在「脚上方 1.5 格」（LivingEntityRenderer 的 translate(0,-1.501,0)）
      obj.position.set(+p[0] + 0.5 - state.world.sx / 2,
                       +p[1] + 1.5,
                       +p[2] + 0.5 - state.world.sz / 2);
      obj.rotation.y = e.yaw || 0;
      if (obj.userData && obj.userData.texture) {
        var tx = obj.userData.texture;
        if (tx.image && !tx.image.complete) {
          tx.__onload = function () { if (state.renderer) state.renderer.render(); };
        }
      }
      g.add(obj);
    });
  }

  /** 实体图标：用一个离屏 WebGL 渲染一次（96×96） */
  /** 一整张床的图标（头 + 尾拼在一起） */
  function bedIconSnapshot(texUrl) {
    var ck = 'bedfull|' + texUrl;
    if (state.entIcons[ck]) return state.entIcons[ck];
    if (!window.EntityRenderer || !state.entAssets.bed_head) return null;
    if (!state.iconR) { entIcon('bed_head', texUrl); }   // 顺便初始化离屏渲染器
    if (!state.iconR) return null;
    var wrapAll = new THREE.Group();
    ['bed_head', 'bed_foot'].forEach(function (bid, i) {
      var a = state.entAssets[bid], m = state.entModels[a.model];
      if (!m) return;
      var rawObj = EntityRenderer.build(m, texUrl || a.tex, { texW: a.texW, texH: a.texH, raw: true });
      var sc = new THREE.Group(); sc.add(rawObj); sc.scale.set(1 / 16, 1 / 16, 1 / 16);
      var node = EntityRenderer.applyXf(sc, a.xf, { yrot: (bid === 'bed_foot' ? 180 : 0) });
      var holder = new THREE.Group(); holder.add(node);
      holder.position.set(0, 0, i);
      wrapAll.add(holder);
    });
    var box = new THREE.Box3().setFromObject(wrapAll);
    var size = box.getSize(new THREE.Vector3());
    var ctr = box.getCenter(new THREE.Vector3());
    wrapAll.position.sub(ctr);
    state.iconScene.add(wrapAll);
    var r = Math.max(size.x, size.y, size.z) * 1.75 + 0.5;
    state.iconCam.position.set(r * 0.75, r * 0.55, r * 0.85);
    state.iconCam.lookAt(0, 0, 0);
    state.iconR.render(state.iconScene, state.iconCam);
    var url = state.iconR.domElement.toDataURL('image/png');
    var snap = document.createElement('canvas');
    snap.width = 96; snap.height = 96;
    try { snap.getContext('2d').drawImage(state.iconR.domElement, 0, 0); } catch (e) {}
    state.iconScene.remove(wrapAll);
    if (EntityRenderer.dispose) EntityRenderer.dispose(wrapAll);
    state.entIcons[ck] = snap;
    return state.entIcons[ck];
  }

  function entIcon(id, texUrl, tintHex) {
    tintHex = tintHex || 0;
    var ck = id + (texUrl ? '|' + texUrl : '') + '|' + tintHex;
    if (state.entIcons[ck]) return state.entIcons[ck];
    var a = state.entAssets[id], m = a && state.entModels[a.model];
    if (!m || !window.EntityRenderer) return '';
    if (!state.iconR) {
      state.iconR = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      state.iconR.setSize(96, 96);
      state.iconScene = new THREE.Scene();
      state.iconScene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 1.15));
      var dl = new THREE.DirectionalLight(0xffffff, 0.8);
      dl.position.set(2, 5, 4);
      state.iconScene.add(dl);
      state.iconCam = new THREE.PerspectiveCamera(40, 1, 0.05, 60);
    }
    var tex0 = texUrl || a.tex;
    var obj;
    try {
      if (a.xf) {
        var rawObj = EntityRenderer.build(m, tex0, { texW: a.texW, texH: a.texH, raw: true, noAlphaTest: true });
        var sc = new THREE.Group();
        sc.add(rawObj);
        sc.scale.set(1 / 16, 1 / 16, 1 / 16);
        obj = EntityRenderer.applyXf(sc, a.xf, { yrot: (id === 'bed_foot' ? 180 : 0) });
      } else {
        obj = EntityRenderer.build(m, tex0, { texW: a.texW, texH: a.texH, yUp: !!a.yUp, rot: a.rot, noAlphaTest: true });
      }
    } catch (e) { return ''; }
    tintBannerMeshes(obj, tintHex);
    var box = new THREE.Box3().setFromObject(obj);
    var size = box.getSize(new THREE.Vector3());
    var ctr = box.getCenter(new THREE.Vector3());
    obj.position.sub(ctr);
    var wrap = new THREE.Group();
    wrap.add(obj);
    state.iconScene.add(wrap);
    var r = Math.max(size.x, size.y, size.z) * 1.9 + 0.4;
    state.iconCam.position.set(r * 0.72, r * 0.45, r * 0.85);
    state.iconCam.lookAt(0, 0, 0);
    state.iconR.render(state.iconScene, state.iconCam);
    var url = state.iconR.domElement.toDataURL('image/png');
    if (!state.entIconCanvas) state.entIconCanvas = {};
    try {
      var snap = document.createElement('canvas');
      snap.width = 96; snap.height = 96;
      snap.getContext('2d').drawImage(state.iconR.domElement, 0, 0);
      state.entIconCanvas[ck] = snap;
    } catch (e) {}
    state.iconScene.remove(wrap);
    if (EntityRenderer.dispose) EntityRenderer.dispose(wrap);
    state.entIcons[ck] = url;
    return url;
  }

  function openEntityPicker() {
    if (!state.entAssets) { toast('实体数据还没加载好'); return; }
    dom.entGrid.innerHTML = '';
    var list = entAssetList();
    list.forEach(function (it) {
      var el = document.createElement('div');
      el.className = 'entItem' + (state.entityId === it.id ? ' sel' : '');
      el.dataset.id = it.id;
      var img = document.createElement('img');
      img.src = entIcon(it.id);
      el.appendChild(img);
      var sp = document.createElement('span');
      sp.textContent = (it.a.eid || '').replace('minecraft:', '');
      el.appendChild(sp);
      el.addEventListener('click', function () { selectEntity(it.id); });
      dom.entGrid.appendChild(el);
    });
    dom.entModal.classList.add('show');
  }

  function selectEntity(id) {
    state.entityId = (state.entityId === id) ? null : id;
    if (state.entityId) {          // 选实体 = 换放置目标，方块那边的选中要清掉
      state.catIdx = null;
      refreshSelection();
    }
    state.mode = 'build';
    updateModeBtn();
    var items = dom.entGrid.children;
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('sel', items[i].dataset.id === state.entityId);
    }
    if (state.entityId) {
      toast('已选实体 ' + (state.entAssets[state.entityId].eid || state.entityId) + '，点场景放置');
    } else {
      toast('取消实体，回到方块模式');
    }
    updateHud();
  }

  // ---------------------------------------------------------------- 结构导入（.nbt / .litematic / .schem）
  function propsToObj(pr) {
    if (!pr) return null;
    var out = {}, any = false;
    for (var k in pr) { out[k] = pr[k]; any = true; }
    return any ? out : null;
  }

  /** 原版结构（结构方块导出的 .nbt） */
  function parseStructureFile(root) {
    var pal = (root.palette || []).map(function (p) {
      return { n: p.Name, p: propsToObj(p.Properties) };
    });
    var blocks = [];
    (root.blocks || []).forEach(function (b) {
      var st = pal[b.state];
      if (!st) return;
      var pos = b.pos || [0, 0, 0];
      blocks.push({ x: pos[0], y: pos[1], z: pos[2], n: st.n, p: st.p });
    });
    var ents = [];
    (root.entities || []).forEach(function (e) {
      var pos = e.pos || [0, 0, 0];
      var id = e.nbt && e.nbt.id;
      ents.push({ x: Math.floor(pos[0]), y: Math.floor(pos[1]), z: Math.floor(pos[2]), id: id });
    });
    return { blocks: blocks, ents: ents };
  }

  /** Litematica 投影 */
  function parseLitematic(root) {
    var blocks = [], ents = [];
    var regions = root.Regions || {};
    Object.keys(regions).forEach(function (rk) {
      var r = regions[rk] || {};
      var pos = r.Position || { x: 0, y: 0, z: 0 };
      var sz = r.Size || { x: 0, y: 0, z: 0 };
      var sx = sz.x | 0, sy = sz.y | 0, szz = sz.z | 0;
      if (sx < 0) sx = -sx;
      if (sy < 0) sy = -sy;
      if (szz < 0) szz = -szz;
      if (!sx || !sy || !szz) return;
      var pal = (r.BlockStatePalette || []).map(function (p) {
        return { n: p.Name, p: propsToObj(p.Properties) };
      });
      if (!pal.length) return;
      var longs = r.BlockStates || [];
      var bits = 1;
      while ((1 << bits) < pal.length) bits++;
      if (bits < 2) bits = 2;
      var per = Math.floor(64 / bits);
      var mask = (1n << BigInt(bits)) - 1n;
      var vol = sx * sy * szz;
      for (var i = 0; i < vol; i++) {
        var li = (i / per) | 0;
        var raw = longs[li];
        if (raw === undefined) break;
        var v = Number((BigInt.asUintN(64, BigInt(raw)) >> BigInt((i % per) * bits)) & mask);
        if (!v) continue;
        var st = pal[v];
        if (!st) continue;
        var x = i % sx;
        var z = Math.floor(i / sx) % szz;
        var y = Math.floor(i / (sx * szz));
        blocks.push({ x: x + (pos.x | 0), y: y + (pos.y | 0), z: z + (pos.z | 0), n: st.n, p: st.p });
      }
      (r.Entities || []).forEach(function (e) {
        var p2 = e.Pos || [0, 0, 0];
        ents.push({
          x: Math.floor(p2[0]), y: Math.floor(p2[1]), z: Math.floor(p2[2]),
          id: (e.NBT && e.NBT.id) || null
        });
      });
    });
    return { blocks: blocks, ents: ents };
  }

  /** 把 "minecraft:oak_stairs[facing=north,half=bottom]" 拆成名字 + 属性 */
  function splitStateId(str) {
    var m = /^([^\[]+)(?:\[(.*)\])?$/.exec(String(str || ''));
    if (!m) return null;
    var props = null;
    if (m[2]) {
      props = {};
      m[2].split(',').forEach(function (kv) {
        var i = kv.indexOf('=');
        if (i > 0) props[kv.slice(0, i)] = kv.slice(i + 1);
      });
    }
    return { n: m[1], p: props };
  }

  /** WorldEdit / FAWE 的 Sponge v2 .schem */
  function parseSchemFile(root) {
    var W = root.Width | 0, H = root.Height | 0, L = root.Length | 0;
    var inv = {};
    var pal = root.Palette || {};
    Object.keys(pal).forEach(function (k) { inv[pal[k]] = k; });
    var bd = root.BlockData || [];
    var vals = [], i = 0;
    while (i < bd.length) {
      var v = 0, sh = 0;
      while (true) {
        var b = bd[i++];
        v |= (b & 0x7f) << sh;
        if (!(b & 0x80)) break;
        sh += 7;
        if (sh > 35) break;
      }
      vals.push(v);
    }
    var blocks = [];
    for (var idx = 0; idx < vals.length; idx++) {
      var id = vals[idx];
      if (!id) continue;
      var st = splitStateId(inv[id]);
      if (!st) continue;
      var x = idx % W;
      var z = Math.floor(idx / W) % L;
      var y = Math.floor(idx / (W * L));
      blocks.push({ x: x, y: y, z: z, n: st.n, p: st.p });
    }
    return { blocks: blocks, ents: [] };
  }

  function detectAndParse(root) {
    if (root.Regions) return parseLitematic(root);
    if (root.BlockData && root.Palette) return parseSchemFile(root);
    if (root.blocks && root.palette) return parseStructureFile(root);
    throw new Error('认不出的格式（支持 .nbt / .litematic / .schem）');
  }

  /** 把解析出来的方块灌进世界（必要时自动扩尺寸，保留现有作品） */
  function importBlocks(blocks, ents, label) {
    if (!blocks || !blocks.length) { toast('文件里没有方块'); return; }
    var mx = 0, my = 0, mz = 0;
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].x > mx) mx = blocks[i].x;
      if (blocks[i].y > my) my = blocks[i].y;
      if (blocks[i].z > mz) mz = blocks[i].z;
    }
    var needX = Math.min(128, mx + 1), needY = Math.min(128, my + 1), needZ = Math.min(128, mz + 1);
    if (needX > state.sizes[0] || needY > state.sizes[1] || needZ > state.sizes[2]) {
      var nx = Math.max(state.sizes[0], needX);
      var ny = Math.max(state.sizes[1], needY);
      var nz = Math.max(state.sizes[2], needZ);
      applySize(nx, ny, nz, true);
    }

    var idxByName = {};
    for (var ci = 0; ci < state.catalog.length; ci++) idxByName[state.catalog[ci].n] = ci;

    var added = 0, skipped = 0;
    state.world.beginBatch('导入结构');
    for (i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (b.x < 0 || b.y < 0 || b.z < 0) { skipped++; continue; }
      if (b.x >= state.world.sx || b.y >= state.world.sy || b.z >= state.world.sz) { skipped++; continue; }
      // 结构文件里的名字带命名空间（minecraft:stone），本项目的 catalog 是裸名
      var nm = b.n.indexOf('minecraft:') === 0 ? b.n.slice(10) : b.n;
      var ci2 = idxByName[nm];
      if (ci2 === undefined) { skipped++; continue; }
      state.world.set(b.x, b.y, b.z, nm, b.p || null, ci2);
      added++;
    }
    state.world.endBatch();
    (ents || []).forEach(function (e) {
      if (!e.id) return;
      if (e.x < 0 || e.y < 0 || e.z < 0) return;
      if (e.x >= state.world.sx || e.y >= state.world.sy || e.z >= state.world.sz) return;
      state.world.setEntity(e.x, e.y, e.z, { asset: null, id: e.id, yaw: 0 });
    });
    afterChange();
    toast('导入 ' + label + '：' + added + ' 方块' + (skipped ? '（跳过 ' + skipped + '，可能是当前版本没有的方块）' : ''));
  }

  function importStructuralFile(file) {
    if (!file) return;
    toast('解析中：' + file.name);
    file.arrayBuffer()
      .then(function (buf) { return NBT.gunzip(buf); })
      .then(function (raw) {
        var root = NBT.decode(raw);
        var res = detectAndParse(root);
        importBlocks(res.blocks, res.ents, file.name);
      })
      .catch(function (e) {
        if (window.console) console.error(e);
        toast('导入失败：' + ((e && e.message) ? e.message : e));
      });
  }

  // ---------------------------------------------------------------- 模组导入
  /**
   * 把模组贴图并进现有 atlas（运行时扩容）。
   * textures: { 'modid:block/x': Uint8Array(png) }
   */
  function mergeModAtlas(textures) {
    var names = Object.keys(textures || {});
    if (!names.length) return Promise.resolve(0);
    var CW = 24, COLS = 32, PAD = 4;
    var uv = state.atlas.uv, size = state.atlas.size;
    var occ = {};
    var k;
    for (k in uv) occ[uv[k].x + ',' + uv[k].y] = 1;
    var jobs = [], i = 0;
    names.forEach(function (n) {
      if (uv[n]) return;
      while (occ[((i % COLS) * CW + PAD) + ',' + (((i / COLS) | 0) * CW + PAD)]) i++;
      var x = (i % COLS) * CW + PAD, y = ((i / COLS) | 0) * CW + PAD;
      occ[x + ',' + y] = 1;
      jobs.push({ name: n, x: x, y: y });
      i++;
    });
    if (!jobs.length) return Promise.resolve(0);

    var rows = Math.ceil(i / COLS);
    var W = size[0], H = Math.max(size[1], rows * CW);
    var cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    var g = cv.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(state.atlasImg, 0, 0);

    return new Promise(function (resolve) {
      var left = jobs.length;
      var step = function () {
        if (--left > 0) return;
        jobs.forEach(function (j) { uv[j.name] = { x: j.x, y: j.y }; });
        state.atlas.size = [W, H];
        state.atlasImg = cv;
        if (state.renderer && state.renderer.setAtlas) {
          state.renderer.setAtlas({ cell: 16, pad: 4, cols: 32, size: [W, H], uv: uv, img: cv });
        }
        iconCache.clear();
        resolve(jobs.length);
      };
      jobs.forEach(function (j) {
        var bytes = textures[j.name];
        var url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
        var im = new Image();
        im.onload = function () {
          try { g.drawImage(im, 0, 0, 16, 16, j.x, j.y, 16, 16); } catch (e) {}
          URL.revokeObjectURL(url);
          step();
        };
        im.onerror = function () { URL.revokeObjectURL(url); step(); };
        im.src = url;
      });
    });
  }

  /** 把 parseMod 的报告登记进 catalog / models / 版本列表 */
  function applyModReport(rep, silent) {
    var v = state.versions[state.curVer];
    var added = 0, skipped = 0;
    (rep.blocks || []).forEach(function (b) {
      var full = b.id || (rep.modid + ':' + b.name);
      if (state.catalogByName[full]) { skipped++; return; }
      var texs = b.textures || [];
      var entry = {
        n: full,
        cn: b.cn || b.name,
        top: texs[0] || '',
        side: texs[1] || texs[0] || '',
        st: [],
        def: 0,
        mod: rep.modid            // ★ 记 modid（不是 1），物品库按它分页签
      };
      state.catalog.push(entry);
      state.catalogByName[full] = entry;
      if (!state.models) state.models = {};
      state.models[full] = { els: b.els || [], cube: !!b.cube };
      if (v && v.blocks.indexOf(full) < 0) v.blocks.push(full);
      added++;
    });

    // 模组物品：加进物品库
    var miAdded = 0;
    (rep.items || []).forEach(function (it) {
      var id = it.id || (rep.modid + ':' + it.name);
      for (var k = 0; k < state.modItems.length; k++) if (state.modItems[k].id === id) return;
      state.modItems.push({ id: id, cn: it.cn || it.name, tex: it.tex, modid: rep.modid });
      miAdded++;
    });
    state.itemEntries = null;          // 物品库要重算
    var modInfo = { id: rep.modid, name: rep.name || rep.modid, blocks: added, items: miAdded };
    var mi0 = -1;
    for (var mj = 0; mj < state.mods.length; mj++) {
      if (state.mods[mj].id === rep.modid) { mi0 = mj; break; }
    }
    if (mi0 >= 0) state.mods[mi0] = modInfo;   // ★ 重复导入：覆盖，别再 push 一个
    else state.mods.push(modInfo);
    buildTabs();
    iconCache.clear();
    applyFilter(false);

    if (!silent) {
      var msg = '导入 ' + (rep.name || rep.modid) + '：方块 +' + added + '，物品 +' + miAdded;
      if (skipped) msg += '（重复跳过 ' + skipped + '）';
      toast(msg);
    }
    if (rep.issues && rep.issues.length) dbg('模组问题：' + rep.issues.slice(0, 3).join(' | '));
    return { added: added, skipped: skipped };
  }

  // ---- 已导入模组的持久化 ----
  // ★ 用 localStorage 而不是 IndexedDB：实测这台手机的 WebView 里 IDB 事务经常不回调
  //   （put 之后 oncomplete 永远不来），小模组直接 base64 存 localStorage 更稳。
  var MODS_LS = 'yuneko-mods-v1';
  var MODS_LS_MAX = 4.2 * 1024 * 1024;      // localStorage 一般 5MB，留点余量

  function b64enc(u8) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length)));
    }
    return btoa(s);
  }
  function b64dec(b) {
    var s = atob(b), u = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  }

  /** 把 state.mods 里每个模组的 report 序列化存起来（贴图转 base64） */
  function saveModsLocal(reports) {
    try {
      var packed = (reports || []).map(function (r) {
        var tex = {};
        var u = r.textures || {};
        for (var k in u) tex[k] = b64enc(u[k]);
        return { modid: r.modid, name: r.name, loader: r.loader, report: {
          modid: r.modid, name: r.name, loader: r.loader,
          blocks: r.blocks, items: r.items, issues: r.issues, textures: null
        }, textures: tex };
      });
      var str = JSON.stringify(packed);
      if (str.length > MODS_LS_MAX) {
        if (window.console) console.warn('模组太大，存不下（' + Math.round(str.length / 1024) + 'KB），刷新后要重新导入');
        toast('模组太大，刷新后需重新导入');
        return false;
      }
      localStorage.setItem(MODS_LS, str);
      return true;
    } catch (e) {
      if (window.console) console.warn('模组存档失败', e);
      return false;
    }
  }

  function loadModsLocal() {
    try {
      var raw = localStorage.getItem(MODS_LS);
      if (!raw) return [];
      return JSON.parse(raw).map(function (m) {
        var tex = {};
        for (var k in (m.textures || {})) tex[k] = b64dec(m.textures[k]);
        m.report.textures = tex;
        return m.report;
      });
    } catch (e) {
      return [];
    }
  }

  /** 开机时把上次导入的模组装回来（贴图 + 方块定义） */
  function restoreMods() {
    var list = loadModsLocal();
    if (!list.length) return Promise.resolve(0);
    var seenId = {};
    list = list.filter(function (rep) {
      if (!rep || !rep.modid || seenId[rep.modid]) return false;
      seenId[rep.modid] = 1;
      return true;
    });
    list.forEach(function (rep) { savedReports[rep.modid] = rep; });   // 保留已存的，别被新导入覆盖掉
    var chain = Promise.resolve();
    list.forEach(function (rep) {
      chain = chain.then(function () {
        return mergeModAtlas(rep.textures || {}).then(function () {
          applyModReport(rep, true);
        });
      });
    });
    return chain.then(function () {
      afterChange();          // 存档里如果已经有模组方块，现在才能画出来
      return list.length;
    });
  }

  /** 导入一个 jar/zip 的 ArrayBuffer（浏览器和 __STUDIO 都走这里） */
  var savedReports = {};   // modid -> report（用于整体重写 localStorage）

  function importModBuffer(buf, label) {
    if (!window.ModImport) return Promise.reject(new Error('modimport.js 没加载'));
    toast('解析中：' + (label || 'mod.jar'));
    return window.ModImport.readZip(buf).then(function (z) {
      var rep = window.ModImport.parseMod(z.files, {});
      return mergeModAtlas(rep.textures || {}).then(function () {
        var r = applyModReport(rep);
        savedReports[rep.modid] = rep;
        saveModsLocal(Object.keys(savedReports).map(function (k) { return savedReports[k]; }));
        return { modid: rep.modid, blocks: r.added, items: (rep.items || []).length, issues: rep.issues || [] };
      });
    }).catch(function (e) {
      if (window.console) console.error(e);
      toast('导入失败：' + ((e && e.message) ? e.message : e));
      throw e;
    });
  }

  function importModFile(file) {
    if (!file) return;
    file.arrayBuffer().then(function (buf) { return importModBuffer(buf, file.name); })
      .catch(function () {});
  }

  function bindUI() {
    // 画布：Pointer Events + 滚轮 + 窗口尺寸
    dom.canvas.addEventListener('pointerdown', onPointerDown);
    dom.canvas.addEventListener('pointermove', onPointerMove);
    dom.canvas.addEventListener('pointerup', onPointerUp);
    dom.canvas.addEventListener('pointercancel', onPointerUp);
    dom.canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    // 顶部栏
    if (dom.btnReplace) dom.btnReplace.addEventListener('click', openReplace);
    if (dom.repCancel) dom.repCancel.addEventListener('click', function () { dom.repModal.classList.remove('show'); });
    if (dom.repGo) dom.repGo.addEventListener('click', doReplace);
    if (dom.repFrom) dom.repFrom.addEventListener('change', updateRepInfo);
    if (dom.repFilter) dom.repFilter.addEventListener('input', function () {
      fillReplaceTargets(dom.repFilter.value.trim().toLowerCase(), dom.repTo.value);
    });
    if (dom.entClose) dom.entClose.addEventListener('click', function () { dom.entModal.classList.remove('show'); });
    if (dom.entClear) dom.entClear.addEventListener('click', function () {
      state.entityId = null;
      var items = dom.entGrid.children;
      for (var i = 0; i < items.length; i++) items[i].classList.remove('sel');
      updateHud();
      dom.entModal.classList.remove('show');
    });
    dom.verSelect.addEventListener('change', onVersionChange);
    dom.sizeSelect.addEventListener('change', onSizeChange);
    dom.szCancel.addEventListener('click', closeSizeModal);
    dom.szGo.addEventListener('click', function () {
      var x = parseInt(dom.szX.value, 10);
      var y = parseInt(dom.szY.value, 10);
      var z = parseInt(dom.szZ.value, 10);
      closeSizeModal();
      askSize(x, y, z);
    });

    // 抽屉折叠
    dom.drawerHead.addEventListener('click', function () {
      state.drawerOpen = !state.drawerOpen;
      dom.drawer.classList.toggle('closed', !state.drawerOpen);
    });
    // 搜索（输入即过滤，仅 O(n) 过滤 + 分页渲染，无性能问题）
    dom.catSearch.addEventListener('input', function () {
      applyFilter(false);
    });
    // 特殊方块浮窗
    dom.specialHead.addEventListener('click', function () {
      dom.specialPanel.classList.toggle('closed');
    });
    [dom.spShowBarrier, dom.spShowVoid, dom.spShowLight,
     dom.spPierceBarrier, dom.spPierceVoid, dom.spPierceLight].forEach(function (el) {
      el.addEventListener('change', syncSpecial);
    });

    // 方块状态按钮 -> 状态编辑面板
    if (dom.btnState) {
      dom.btnState.addEventListener('click', function () {
        if (!state.selBlock) return;
        openStateSheet();
      });
    }
    if (dom.stClose) dom.stClose.addEventListener('click', closeStateSheet);
    if (dom.vsClose) dom.vsClose.addEventListener('click', closeVariantPicker);
    if (dom.stDone) dom.stDone.addEventListener('click', closeStateSheet);
    if (dom.stReset) {
      dom.stReset.addEventListener('click', function () {
        if (!state.selBlock) return;
        var v = state.selBlock.v;
        state.world.beginBatch('恢复默认状态');
        state.world.set(state.selBlock.x, state.selBlock.y, state.selBlock.z, v.n, null, v.c);
        state.world.endBatch();
        state.selBlock.v = state.world.get(state.selBlock.x, state.selBlock.y, state.selBlock.z);
        renderStateSheet();
        afterChange();
      });
    }

    // 建造 / 删除 切换 + 长按回选择模式
    var _modeLP = null;
    if (dom.btnImport) {
      dom.btnImport.addEventListener('click', function () {
        if (!window.NBT || !NBT.decode) { toast('NBT 读取器没加载'); return; }
        dom.impFile.click();
      });
    }
    if (dom.impFile) {
      dom.impFile.addEventListener('change', function () {
        var f = this.files && this.files[0];
        this.value = '';
        importStructuralFile(f);
      });
    }
    if (dom.btnMod) {
      dom.btnMod.addEventListener('click', function () {
        if (!window.ModImport) { toast('模组解析模块没加载（js/modimport.js）'); return; }
        dom.modFile.click();
      });
    }
    if (dom.modFile) {
      dom.modFile.addEventListener('change', function () {
        var f = this.files && this.files[0];
        this.value = '';                 // 允许同一个文件再选一次
        importModFile(f);
      });
    }
    if (dom.drawerTitle) {
      dom.drawerTitle.addEventListener('click', function (ev) {
        ev.stopPropagation();            // ★ 别让点击冒泡到 drawerHead（那是折叠抽屉）
        state.libMode = state.libMode === 'item' ? 'block' : 'item';
        if (state.libMode === 'item') state.itemEntries = null;   // 重新按当前版本/模组构建
        closeInlineVariants();
        buildTabs();
        applyFilter(false);
        updateHud();
      });
    }
    dom.btnMode.addEventListener('click', toggleMode);
    dom.btnMode.addEventListener('pointerdown', function () {
      if (_modeLP) clearTimeout(_modeLP);
      _modeLP = setTimeout(function () {
        _modeLP = null;
        enterSelectMode();
      }, 550);
    });
    dom.btnMode.addEventListener('pointerup', function () {
      if (_modeLP) { clearTimeout(_modeLP); _modeLP = null; }
    });
    dom.btnMode.addEventListener('pointercancel', function () {
      if (_modeLP) { clearTimeout(_modeLP); _modeLP = null; }
    });
    // 滚动到底部自动追加
    dom.catGrid.addEventListener('scroll', function () {
      var g = dom.catGrid;
      if (g.scrollTop + g.clientHeight >= g.scrollHeight - 80) {
        var n = state.itemFiltered ? state.itemFiltered.length
          : (state.entFiltered ? state.entFiltered.length : state.filtered.length);
        if (state.rendered < n) renderPage();
      }
    });

    // 工具栏
    dom.btnUndo.addEventListener('click', doUndo);
    dom.btnRedo.addEventListener('click', doRedo);
    dom.btnClear.addEventListener('click', doClear);
    dom.btnNew.addEventListener('click', doNew);
    if (dom.gizmo) {
      dom.gizmo.addEventListener('click', resetView);
      dom.gizmo.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    }
    if (dom.sizeAskModal) {
      dom.sizeKeep.addEventListener('click', function () {
        dom.sizeAskModal.classList.remove('show');
        if (_pendingSize) applySize(_pendingSize[0], _pendingSize[1], _pendingSize[2], true);
        _pendingSize = null;
      });
      dom.sizeClear.addEventListener('click', function () {
        dom.sizeAskModal.classList.remove('show');
        if (_pendingSize) applySize(_pendingSize[0], _pendingSize[1], _pendingSize[2], false);
        _pendingSize = null;
      });
      dom.sizeCancel2.addEventListener('click', function () {
        dom.sizeAskModal.classList.remove('show');
        _pendingSize = null;
        syncSizeSelect();
      });
      dom.sizeAskModal.addEventListener('click', function (e) {
        if (e.target === dom.sizeAskModal) {
          dom.sizeAskModal.classList.remove('show');
          _pendingSize = null;
          syncSizeSelect();
        }
      });
    }
    dom.btnXray.addEventListener('click', toggleXray);
    dom.btnExport.addEventListener('click', openExport);

    // 导出弹窗
    dom.expCancel.addEventListener('click', closeExport);
    if (dom.expFmt) dom.expFmt.addEventListener('change', updateExportUI);
    dom.expGo.addEventListener('click', doExport);
    dom.exportModal.addEventListener('click', function (e) {
      if (e.target === dom.exportModal) closeExport();
    });
  }

  // ---------------------------------------------------------------- F5 主循环
  var _dbgTick = 0;
  function loop() {
    if (state.renderer) state.renderer.render();
    drawGizmo();
    if (++_dbgTick % 60 === 0 && state.renderer && dom.hudGrid) {
      dom.hudGrid.textContent = state.renderer._gridDbg || "-";
    }
    requestAnimationFrame(loop);
  }

  // 启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

