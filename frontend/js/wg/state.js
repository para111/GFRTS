// ============================================================
// wg_game 模块化拆分 —— state.js
// 职责: 状态与装配：全部顶层状态初始化 / 配置 / Phaser.Game 创建 / window 桥接（保持原始语句顺序）
// 来源: wg_game.js 语句区间 4-10504（自动拆分，勿手工重排语句顺序）
// ============================================================

import { S } from './S.js';
import { damagePlayerMember } from './combat.js';
import { setEnemyAnimation, spawnEnemyRouteUnit } from './enemy.js';
import { handleSpawnOption, readSpawnButtonColumn } from './hud.js';
import { handleWorldClick } from './input.js';
import { getShortestPlayerPath, isClearancePathSafe, resetRedPathStats } from './pathfind.js';
import { getSpawnedPlayerSquads, issuePlayerMoveOrder, resolvePlayerSquadOrderGoals } from './player-squad.js';
import { readUnitNumber, requireUnitRecord } from './records.js';
import { create, preload, update } from './scene.js';
import { correctPointIntoGreenClearance, correctPointOutOfRedClearance, getRedZoneContourEntry, getRedZoneContourNodes, getZoneNearestEdge, isGreenClearanceSafePoint, isRedClearanceSafePoint, isRedClearanceSafeSegment, isShieldClearanceSafePoint, isShieldClearanceSafeSegment, isWalkable } from './zones.js';

  // 数据引导：等待页面内联引导器拉取 /api/units + /api/map；file:// 或引导器缺失时

  // boot 为 null 字段，下方回退到 script 标签数据（unit_db.js / map_data.js）。



  var boot = (window.__WG_loadGameData ? await window.__WG_loadGameData() : { units: null, map: null });


  // 禁用浏览器右键菜单，保留游戏内右键操作
  document.addEventListener('contextmenu', event => event.preventDefault());


  // ----------------------------------------------------
  // 1. 全局配置与基础变量
  // ----------------------------------------------------
  const config = {
    type: Phaser.AUTO,
    width: 1920,
    height: 1080,
    backgroundColor: '#1b1b2f',
    // 性能：120FPS 渲染目标（120Hz 屏幕可满帧运行）+ 高性能 GPU 偏好（130 单位场景吞吐保障）
    fps: { target: 120, min: 30 },
    powerPreference: 'high-performance',
    physics: {
      default: 'arcade',
      arcade: { debug: false }
    },
    scale: {
      // FIT：视野窗口固定 1920×1080 并完整可见。ENVELOP 会把画布放大到铺满整个窗口，
      // 超出 16:9 的部分被裁掉，玩家反而看不全视野范围
      mode: Phaser.Scale.FIT,
      width: 1920,
      height: 1080,
      autoCenter: Phaser.Scale.CENTER_BOTH
    },
    plugins: {
      scene: [
        {
          key: 'SpinePlugin',
          plugin: window.SpinePlugin,
          mapping: 'spine'
        }
      ]
    },
    scene: { preload, create, update }
  };


  new Phaser.Game(config);


  // ----------------------------------------------------
  // 单位数据库（7 张表）
  // 唯一真源是 unit_database.sql：正式字段沿用 RTS.xlsx 的设计——
  //   unit_id / unit_name / cost / build_time / max_hp / armor / move_speed /
  //   action_range / action_value / action_cd / target_type（0 = 敌方单位，1 = 我方单位）/
  //   armor_penetration，另补充代码内使用的静态数值（阵型、碰撞体、红区净空、回血、自爆、动画等）。
  // 我方可招募：步兵 / 重甲 / 支援，另有战场雇佣单位（临时增援）；敌方：步兵 / 重甲 / 支援。
  // 改数值的流程：编辑 unit_database.sql -> 运行 `python build_unit_db.py` 生成 unit_db.js，
  // 本文件只读取与校验，不再内置任何单位数值；下方常量一律从记录派生。
  // 之所以生成 .js 而不是 .json：WG.html 直接用 file:// 打开，fetch 本地 .json 会被 CORS 拦截，
  // 而同目录的 <script src="unit_db.js"> 在 file:// 下可正常加载，因此 unit_db.js 必须与 WG.html 同目录。
  // ----------------------------------------------------
  // 数据源选择：http 下引导器优先取 /api/units（服务器权威），失败/超时/file:// 回退 unit_db.js
  const UNIT_DB = (boot.units && boot.units.database) ? boot.units : window.UNIT_DB;

  if (!UNIT_DB || !UNIT_DB.database) {
    const message = '单位数据库未加载：请先在当前目录运行 `python build_unit_db.py`，'
      + '由 unit_database.sql 生成 unit_db.js（需与 WG.html 同目录）。';
    window.alert(message);
    throw new Error(message);
  }

  if (boot.units && window.UNIT_DB && window.UNIT_DB.sourceSha1
      && window.UNIT_DB.sourceSha1 !== boot.units.sourceSha1) {
    console.warn('[WG] /api/units 与 unit_db.js 版本不一致(script=' + window.UNIT_DB.sourceSha1
      + ', api=' + boot.units.sourceSha1 + ')，已优先使用 API 数据');
  }

  const UNIT_DATABASE = UNIT_DB.database;   // 表名 -> 记录数组（不适用或未填的列不出现在记录里）


  // 地图数据：http 下引导器优先取 /api/map，失败/超时/file:// 回退 map_data.js
  const MAP_DATA = (boot.map && boot.map.collisionRegions) ? boot.map : window.MAP_DATA;

  // WG2 环境识别与全局修正系数（用户指令，仅 WG2 生效；WG.html 走 window.MAP_DATA 不受影响）：
  // WG2.html 引导器把 window.MAP2_DATA 本体作为 boot.map 传入，与旧图对象不同——以此区分环境
  const IS_WG2 = MAP_DATA === window.MAP2_DATA;
  // 全单位渲染缩放修正：在兵种记录 character_scale 基础上减少 0.1
  const WG2_UNIT_SCALE_DELTA = IS_WG2 ? -0.1 : 0;
  // 我方单位渲染缩放修正（方案 A）：基础较大（0.5625），单独多减 0.05 使观感与敌方一致
  const WG2_PLAYER_SCALE_DELTA = IS_WG2 ? -0.15 : 0;
  // 全单位移速修正：与缩放同比 ×0.9，单位变小后「身位/秒」观感与旧图一致
  const WG2_SPEED_FACTOR = IS_WG2 ? 0.9 : 1;
  // 我方单位出生后自动上移距离（出生点右上方 150px 集合，实际位移 150px）
  const WG2_SPAWN_RALLY_LIFT = IS_WG2 ? 150 : 0;
  // WG2 专用：个别兵种的基础渲染缩放覆盖（键 = roster 成员键，命中后替代 unit_db 的 character_scale）。
  // Agent 骨架原生身高约 232px（约为步兵骨架 85px 的 2.7 倍），0.23 的基础缩放叠加 -0.15 修正后
  // 只剩 0.08，观感远小于步兵；按「渲染身高与 JF 步兵一致」实测标定为 0.3
  // （0.3 - 0.15 = 0.15 × 232.4 ≈ 34.9px ≈ 步兵 84.65 × 0.4125 ≈ 34.9px）。WG.html 恒为 null，不变
  const WG2_PLAYER_BASE_SCALE_OVERRIDES = IS_WG2 ? { Agent: 0.3 } : null;

  if (!MAP_DATA || !MAP_DATA.collisionRegions) {
    const message = '地图数据未加载：请运行 `python backend/tools/build_map_data.py`，'
      + '由 backend/data/map.json 生成 map_data.js（需与 WG.html 同目录）。';
    window.alert(message);
    throw new Error(message);
  }


  // 当前场上的兵种：我方步兵 JF、敌方步兵 Vespid
  const ACTIVE_PLAYER_RECORD = requireUnitRecord('player_infantry', 'JF');

  const ACTIVE_ENEMY_RECORD = requireUnitRecord('enemy_infantry', 'Vespid');


  // 敌方各兵种的数据库记录（按路线生成键索引）：新兵种在 enemy_* 三张表登记。
  // 移速 / 射程 / 生命 / 攻击动画 / 冲刺配置等按各自记录读取，Vespid 缺省兜底
  const ENEMY_UNIT_RECORDS = {
    vespid: ACTIVE_ENEMY_RECORD,
    Guard: requireUnitRecord('enemy_infantry', 'Guard'),
    Striker: requireUnitRecord('enemy_infantry', 'Striker'),
    Aegis: requireUnitRecord('enemy_infantry', 'Aegis'),
    Jaeger: requireUnitRecord('enemy_infantry', 'Jaeger'),
    Ripper: requireUnitRecord('enemy_infantry', 'Ripper'),
    Prowler: requireUnitRecord('enemy_infantry', 'Prowler'),
    Smasher: requireUnitRecord('enemy_heavy', 'Smasher'),
    Kratos: requireUnitRecord('enemy_heavy', 'Kratos'),
    Zombie1: requireUnitRecord('enemy_support', 'Zombie1'),
    Zombie2: requireUnitRecord('enemy_support', 'Zombie2'),
    Strelet: requireUnitRecord('enemy_support', 'Strelet'),
    // 黄线新敌方单位（2026-09-30 Excel 导入）：记录缺失时 requireUnitRecord 会开局即报错
    Brute_SWAP: requireUnitRecord('enemy_infantry', 'Brute_SWAP'),
    Doppelsoldner: requireUnitRecord('enemy_heavy', 'Doppelsoldner'),
    Fortress: requireUnitRecord('enemy_heavy', 'Fortress'),
    Hydra_Deutsch: requireUnitRecord('enemy_heavy', 'Hydra_Deutsch'),
    Cerynitis: requireUnitRecord('enemy_support', 'Cerynitis')
  };


  // 我方各兵种的数据库记录（按出兵按钮键索引）：JF / ELMO1 / GK / ELMO2 在 player_infantry 表，
  // TankM1 / Ares / Warjack（重装单兵）在 player_heavy 表，coffee / SF / 404（我方支援）在 player_support 表。
  // roster / max_hp / 伤害 / 回血 / 攻击动画名等数值按各自记录读取，JF 缺省兜底
  const PLAYER_UNIT_RECORDS = {
    jf: ACTIVE_PLAYER_RECORD,
    elmo1: requireUnitRecord('player_infantry', 'ELMO1'),
    elmo2: requireUnitRecord('player_infantry', 'ELMO2'),
    GK: requireUnitRecord('player_infantry', 'GK'),
    TankM1: requireUnitRecord('player_heavy', 'TankM1'),
    Ares: requireUnitRecord('player_heavy', 'Ares'),
    Warjack: requireUnitRecord('player_heavy', 'Warjack'),
    coffee: requireUnitRecord('player_support', 'coffee'),
    SF: requireUnitRecord('player_support', 'SF'),
    '404': requireUnitRecord('player_support', '404'),
    // GustafAssist2：我方永久固定炮击单位（player_merc 唯一记录）
    GustafAssist2: requireUnitRecord('player_merc', 'GustafAssist2')
  };


  // 两边单位共用的取值入口：所有单位数值都在下方按列名实时从数据库记录读出来
  const playerNumber = (column, options) => readUnitNumber(ACTIVE_PLAYER_RECORD, 'player_infantry.JF', column, options);

  const enemyNumber = (column, options) => readUnitNumber(ACTIVE_ENEMY_RECORD, 'enemy_infantry.Vespid', column, options);


  // 移动 / 攻击数值一律取自出战单位的数据库记录，不再另设常量
  // （射程与攻击间隔在索敌循环里按各兵种记录实时读取，见 getPlayerUnitRecord）
  const UNIT_SPEED = ACTIVE_PLAYER_RECORD.move_speed * WG2_SPEED_FACTOR;   // 187.5（人物标定 50×50 后按同比例标定，观感速度不变；WG2 乘 0.9 与缩放同步）


  // 射程提示：沿射程圆均匀排布的短宽白线（带黑色边框），线沿切线方向铺开、彼此留有间隔。
  // 单个标记占用的弧长固定，射程越大数量越多（有上下限）；
  // 线的长宽取固定像素值，因此任何射程下大小一致、只改变数量
  const PLAYER_RANGE_MARKER_COLOR = 0xffffff;            // 白色线芯

  const PLAYER_RANGE_MARKER_OUTLINE_COLOR = 0x000000;    // 黑色边框

  const PLAYER_RANGE_MARKER_WIDTH = 10;                  // 白色线芯宽（像素，固定值）

  const PLAYER_RANGE_MARKER_LENGTH = 10;                 // 线长（像素，固定值，沿切线方向）

  // 黑色边框只占线宽的 10%：线芯 10 像素、黑边每侧 0.5 像素（总宽 11 像素，黑边占约 9%）
  const PLAYER_RANGE_MARKER_OUTLINE_EXTRA = PLAYER_RANGE_MARKER_WIDTH * 0.1 / 2;

  const PLAYER_RANGE_MARKER_SLOT = 28;                   // 单个标记占用的弧长 (px)，决定标记之间的间隔

  const PLAYER_RANGE_MARKER_MIN_COUNT = 16;              // 标记数量下限

  const PLAYER_RANGE_MARKER_MAX_COUNT = 72;              // 标记数量上限


  // 世界尺寸 = 地图贴图 Stage4-hd.png 的原始像素：世界坐标就是贴图像素，
  // 地图 1:1 铺开、不再被拉伸变形（旧版把 3795×3026 的贴图压进 1920×1080，圆被压成椭圆）
  const WORLD_WIDTH = MAP_DATA.world.width;   // 原 3795：地图贴图 Stage4-hd.png 原始像素宽

  const WORLD_HEIGHT = MAP_DATA.world.height; // 原 3026：地图贴图原始像素高

  // 游戏视野（相机窗口）固定为 1920×1080：世界大于视野，其余部分靠中键拖动 / 滚轮缩放查看
  const VIEW_WIDTH = config.width;

  // 最小缩放 = 地图宽度正好铺满视野宽度（1920 / 3795 ≈ 0.5061）：
  // 此时可视范围 1920×2134 完全落在地图 3795×3026 内，任何缩放级别都不会露出地图以外的空白背景
  // （若取高度方向铺满的 1080/3026 ≈ 0.3569 可整图总览，但可视宽度 5380 > 地图宽，两侧会露出空白）
  const CAMERA_ZOOM_MIN = config.width / WORLD_WIDTH;

  const CAMERA_ZOOM_DEFAULT = 1.2;              // 开局缩放：视野是地图上 1600×900 的一块区域（1 倍时恰为 1920×1080）

  const CAMERA_ZOOM_MAX = 3;                    // 最大缩放：镜头贴近屏幕

  // 敌军三波路线：出生点都在地图外，生成后从地图右侧走进地图，再向左侧推进
  const ENEMY_HOLD_DURATION = enemyNumber('hold_duration', { integer: true, min: 0 });

  // 待机巡逻范围：以「当前行动点」（每次进入待机时的位置）为圆心，
  // 巡逻目标与巡逻过程中的位移都不会超出这个半径，敌军不会四处乱跑
  const ENEMY_PATROL_RADIUS = enemyNumber('patrol_radius', { min: 0 });

  const ENEMY_PATROL_MIN_RADIUS = enemyNumber('patrol_min_radius', { min: 0 });

  // 巡逻硬约束的容差：碰撞隔离会把挤在同一个行动点上的单位推开，
  // 留出这点余量，折返判定才不会和隔离推挤互相拉扯
  const ENEMY_PATROL_SLACK = enemyNumber('patrol_slack', { min: 0 });

  // 敌军出生点在地图右边界之外：生成后先沿入场线走进地图，进入地图才切回常规路线逻辑
  const ENEMY_SPAWN_OFFMAP_PADDING = enemyNumber('spawn_offmap_padding', { min: 0 });

  const ENEMY_ROUTE_ENTRY_COUNT = 1;           // 每条路线在地图外新增的入场节点数量

  // 抵达路线终点之后的自由待机：不再把「路径终点」当成唯一落点，
  // 而是把终点当作一个待机区域，单位在区域里随机挑落点散步、走到就随机静止一段时间。
  // 大批单位因此不会全部挤在同一个终点上互相推挤、反复起停，终点区域的移动与几何计算量随之下降
  const ENEMY_ENDPOINT_ROAM_RADIUS = enemyNumber('endpoint_roam_radius', { min: 0 });      // 终点待机区域的半径 (px)

  const ENEMY_ENDPOINT_IDLE_MIN = enemyNumber('endpoint_idle_min', { integer: true, min: 0 });        // 到位后随机静止时长下限 (ms)

  const ENEMY_ENDPOINT_IDLE_MAX = enemyNumber('endpoint_idle_max', { integer: true, min: 0 });        // 到位后随机静止时长上限 (ms)

  // 终点单位被隔离推挤或追踪带到这个距离之外时，不再靠「朝终点直线插过去」回位：
  // 那条直线可能横穿红区，而从地图边缘死角出发时转向判定会一直返回空，单位就永远回不到终点。
  // 超过这个距离直接交回常规路线推进逻辑走回终点（留 4 倍隔离余量，避免边缘单位来回抖动）
  const ENEMY_ENDPOINT_RETURN_DISTANCE = ENEMY_ENDPOINT_ROAM_RADIUS
    + ENEMY_PATROL_SLACK * enemyNumber('endpoint_return_slack_factor', { min: 0 });

  // 移动路线走廊：每条主路线在 ±ENEMY_ROUTE_CORRIDOR 的走廊内生成 5 条随机变体，
  // 单位每次从行动点出发时重新随机挑一条，多支敌军因此不会挤在同一条线上。
  // 走廊收窄到 38 像素（< 40）：右侧出生点附近的可行走带本来就窄，
  // 走廊过宽会把变体节点推出可行走区或推进红区，生成时还会再逐点校验一次。
  // 走廊半宽按需求保持在 40 像素以内，因此不随人物尺寸（50×50）放大：
  // 敌方碰撞半径 20.5 像素时车道比单位还窄，变体节点校验失败会回退到主路线，
  // 只是随机分流的效果变弱，不会把单位推出可行走区
  const ENEMY_ROUTE_CORRIDOR = enemyNumber('route_corridor', { min: 0 });             // 走廊半宽 (px)，变体节点最大偏移 0.98 × 该值

  const ENEMY_ROUTE_VARIANT_COUNT = enemyNumber('route_variant_count', { integer: true, min: 1 });         // 每条主路线的随机变体数量

  // 敌方单位碰撞体半径：隔离距离是「两个半径之和」，单个半径取其一半。
  // 数值取自 unit_database.sql 的 collision_radius 列
  const ENEMY_COLLISION_RADIUS = ACTIVE_ENEMY_RECORD.collision_radius;   // 20.5（11 × 1.875）

  // 单位间碰撞隔离：两个敌方单位贴近到隔离半径以内就互相推开，避免叠成一坨
  const ENEMY_SEPARATION_DISTANCE = ENEMY_COLLISION_RADIUS * 2;  // 单位间的隔离半径 (px)，= 41

  const ENEMY_SEPARATION_STRENGTH = enemyNumber('separation_strength', { min: 0, max: 1 });         // 每帧推开重叠量的比例（各承担一半）

  const ENEMY_SEPARATION_MAX_PUSH = enemyNumber('separation_max_push', { min: 0 });         // 每帧每个单位的最大推挤位移 (px)，避免瞬时弹开

  // 隔离用的空间哈希格子边长：取隔离距离本身，任意一对重叠单位必然落在 3×3 邻域内
  const ENEMY_SEPARATION_CELL = ENEMY_SEPARATION_DISTANCE;

  // 地图内敌方单位数量上限：低于上限按各波次节奏自动补充，达到上限后停止生成。
  // 130 单位场景：分离碰撞走空间哈希、红区查询走帧内缓存、血条走脏检查 + 底缘降频缓存
  const ENEMY_MAX_COUNT = 130;

  const ENEMY_RED_ZONE_CLEARANCE = ACTIVE_ENEMY_RECORD.red_zone_clearance;   // 19

  // 我方每名队员与红色屏蔽区边缘都必须保持 19 像素净空（对应需求里「3 个像素点」的间距要求）：
  // 该值同时决定绕行曲线（沿红区外沿的等距轮廓）与逐帧推离的安全带宽度，
  // 队员各自再按阵型单独校验一次，因此贴近红区行走时也不会有人物挤进屏蔽区
  const PLAYER_RED_ZONE_CLEARANCE = ACTIVE_PLAYER_RECORD.red_zone_clearance;   // 19

  // 我方每名队员与绿色屏蔽区（可行动区轮廓外侧到地图蓝线之间）边缘的净空宽度。
  // 绿色屏蔽区与红色屏蔽区在几何上是同一种东西——「一块禁止进入的多边形区域」，
  // 只是禁区在内（红）还是在外（绿）：因此净空宽度、等距轮廓、贴边滑动全部复用同一套代码，
  // 唯一差别是轮廓偏移的符号（红区外扩、绿边界内推）。
  // 默认与红区取同一数值（19），单独抽成常量是为了以后能独立调整而不用动红区
  const PLAYER_GREEN_ZONE_CLEARANCE = PLAYER_RED_ZONE_CLEARANCE;   // 19

  // 敌军智能追踪参数：我方单位一进入追踪范围（160 像素）就激活追踪，
  // 追踪期间以 150 像素/秒恒定逼近，追到默认攻击范围边缘（停火距离，同一 100 像素）即停住交火；
  // 姿态随距离即时切换：我方人形在攻击范围内时姿态恒为攻击动作（循环保持），
  // 首次进入与重新进入都不经过等待动作，移出攻击范围立刻打断攻击动画转入移动动画；
  // 只有拉开到追踪范围之外才放弃追踪，随即从当前位置走向下一个行动点
  const ENEMY_TRACK_SPEED = ACTIVE_ENEMY_RECORD.move_speed;   // 追踪状态下的移动速度（像素/秒），150

  const ENEMY_TRACK_STOP_DISTANCE = ACTIVE_ENEMY_RECORD.action_range;   // 停火距离：必须与下方的 ENEMY_ATTACK_RANGE 保持同一数值（同取 action_range），追到攻击范围边缘就站定交火

  const ENEMY_REPLAN_COOLDOWN = enemyNumber('replan_cooldown', { integer: true, min: 0 });           // 绕行重规划失败后的重试冷却 (ms)

  const ENEMY_STUCK_TIME = enemyNumber('stuck_time', { integer: true, min: 0 });               // 想走却几乎没动多久判定为被卡住 (ms)

  const ENEMY_STUCK_DISTANCE = enemyNumber('stuck_distance', { min: 0 });              // 被卡住判定所需的位移阈值 (px)

  // 红区绕行参数：直线被红区阻断时，一律改用沿红区外沿 19 像素的等距轮廓曲线抵达终点
  const RED_CLEARANCE_TOLERANCE = 0.001;       // 位置推离/阵型贴边的亚像素容差（保持足额净空）

  // 红区几何查询的帧内记忆化（单表 + 整数键）：isWalkable / isRedClearanceSafePoint 的结果
  // 只取决于坐标与碰撞配置，而 collisionRegions 全程只读，所以同一帧内按坐标缓存不会脏读。
  // 实测 100 单位满编时 isWalkable 每帧被调用 2465 次但只有 720 个唯一坐标、
  // isRedClearanceSafePoint 976 次/594 个唯一坐标——缓存能省掉大部分多边形与线段距离计算。
  // 缓存每帧开头清空一次：既保证不跨帧脏读，也把容量限制在单帧查询量的量级。
  // 两种查询合并进同一张表：低 16 位记「哪些查询已算过」，高 16 位记对应结论，
  // 于是可行走与净空判定共用同一条记录、同一个键（原先各拼一次字符串键、各查一次表）。
  // 坐标按 1/8 像素量化：量化误差 0.125px 远小于 38 像素安全带与路径容差，
  // 而键因此恒为 32 位小整数（SMI），Map 查找不再为字符串做哈希与临时分配。
  // 倍率取 8 而不是 16：单轴索引只有 16 位（±32767），1/16 像素下只能覆盖 ±2048px，
  // 而世界已按地图原始像素铺开到 3795×3026（地图外入场点约 4013），1/8 像素下覆盖 ±4096px 才够用
  const POINT_QUERY_SCALE = 8;

  const POINT_QUERY_AXIS_MIN = -32768;

  const POINT_QUERY_AXIS_MAX = 32767;

  const POINT_QUERY_WALKABLE = 1;               // 低位区：可行走结论已计算

  const POINT_QUERY_WALKABLE_RESULT = 1 << 16;  // 高位区：可行走结论为真

  const POINT_QUERY_RESULT_SHIFT = 16;

  const pointQueryCache = new Map();

  // 净空位按「查询种类」分开分配：红色屏蔽区与绿色屏蔽区用同一套净空宽度数值，
  // 但结论不同（红看「离红区够远」、绿看「在可行动区内侧且离绿边界够远」）。
  // 两者共用同一条 pointQueryCache 记录，所以位必须分开，否则绿区查询会读到红区结论。
  // 两类各占一张表，共享同一个位游标
  const clearanceQueryBits = new Map();         // 'red'|'green' + 净空宽度 → 该净空在低位区占用的位

S.nextClearanceQueryBit = 2;

  // 红区边的格子桶缓存（见 getZoneEdgeGrid）：只由 collisionRegions 的顶点派生，
  // 因此在碰撞区域被编辑时整体重建即可，不需要逐区版本号
S.redZoneEdgeGridCache = new WeakMap();

  const RED_ZONE_GRID_CELL = 32;

  // 红区包围盒 / 等距轮廓缓存与碰撞配置版本号：统一在此声明，确保场景创建阶段
  // （早于下方几何函数所在代码段执行）调用 isWalkable → isZoneBlocked 时已完成初始化
  const redZoneBoundsCache = new WeakMap();

  const redContourCache = new Map();

  const redContourNodeCache = new WeakMap();

S.collisionRegionVersion = 0;

  // 橙色隔离线的包围盒：判定点到线段的距离前先用 O(1) 排除，避免每次查询都对全部线段
  // 做一遍点到线段投影（满编 100 单位时这里是调用量最大的一处）
S.collisionSegmentBoundsCache = null;

S.collisionSegmentBoundsVersion = -1;

  // 绕行候选点（红区/绿边界顶点沿外法线外推 22px）：只由碰撞配置派生、与起点终点无关，
  // 所以按版本号整体缓存，避免每帧重复做数百次外推与可行走查询
S.detourCandidatesCache = [];

S.detourCandidatesVersion = -1;


  // 每帧清空的几何查询缓存。除了点查询表，这里还推进一个帧号：同一帧内所有单位的位置
  // 都不会再变，凡是「只依赖位置」的结论都可以按帧号复用（例如敌方的追击瞄准点）
S.redQueryFrame = 0;


  // 线段净空判定的记忆化（版本级）：结论只取决于两端点位置、净空宽度与 slack，
  // 与帧号、与是谁在走都无关，所以可以跨帧复用，只在碰撞配置被改写时清空。
  // 键用对象同一性而不是拼字符串：两级 WeakMap 免去哈希与临时键分配，
  // 键对象（临时转向点、路径点）随自身被回收，表不会长期膨胀。
  // 一次规划里 relaxed / strict 两轮 A* 与随后的整路径复核会反复判定同一批线段，
  // 缓存后单次规划的红区距离计算量被压到一遍；这是贴边绕行时最大的一处开销
  let segmentZoneMemos = new Map();


  // 绿色屏蔽区（可行动区轮廓外侧）的线段净空记忆化：结构与红区完全一致、单独一张表，
  // 因为两者的判定对象不同（红区是多边形内部、绿区是多边形外侧），键不能混用。
  // 只在碰撞配置被改写时清空
  let greenSegmentMemos = new Map();

  // 线段可行走抽样的记忆化（与上面两张表同构，键用对象同一性）。
  // 严格口径的 A* 复核会对同一批轮廓节点对反复抽样，而长线段一次要抽几十个采样点：
  // 实测盾路由的严格复核单次产生约六千次抽样，是净空规划里除线段距离之外最大的一处开销
S.walkableSegmentMemos = new WeakMap();


  // 单帧内允许执行的整段绕行规划次数上限：队员归队与敌方绕行各一份名额。
  // 三到六名队员同时贴边归队、或敌军成片转向时，逐人整段规划会让单帧开销成倍增长，
  // 于是把同一帧里的多次规划摊到相邻若干帧上。没排上名额的单位本帧沿用既有路径
  // （没有路径时由逐帧安全转向兜底），移动不会中断，只是重规划晚一两帧发生
  const PLAYER_MEMBER_RETURN_PLANS_PER_FRAME = 1;

  const ENEMY_REPLANS_PER_FRAME = 1;

S.memberReturnPlanFrame = -1;

S.memberReturnPlanCount = 0;

S.enemyReplanFrame = -1;

S.enemyReplanCount = 0;


  // 寻路性能度量（仅调试用，经 window.__WG__.pathStats 读取）：
  // 只做累加与赋值，不参与任何判定分支，因此不改变寻路行为。
  // lastPathLen / lastStraightLen 的比值是「是否绕远路」的量化指标，
  // 也是判断贪心近优门槛（Phase 4）与环连通性重构（Phase 5）是否需要启用的依据。
  const redPathStats = {
    planMs: 0,          // 累计整段规划耗时 (ms)
    planCount: 0,       // 整段规划次数
    maxPlanMs: 0,       // 单次规划最大耗时 (ms)
    slideMs: 0,         // 累计沿轮廓滑动耗时 (ms)
    slideCalls: 0,      // 沿轮廓滑动调用次数
    slideHits: 0,       // 其中成功返回转向点的次数
    lastNodes: 0,       // 最近一次规划得到的路径节点数
    lastPathLen: 0,     // 最近一次规划的路径长度 (px)
    lastGreedyLen: 0,   // 最近一次规划中贪心贴边路径长度 (px)，0 表示该路径不可用
    lastStraightLen: 0, // 最近一次规划的起点-终点直线距离 (px)
    noRouteCount: 0,    // 规划失败（无法安全绕行）次数
    lastGreenNodes: 0,  // 最近一次盾路由纳入的绿环节点数（0 表示本次未纳入绿环）
    greenRouteCount: 0  // 盾路由中绿环被纳入 A* 图（并触发贴绿边绕行）的次数
  };

  const RED_CLEARANCE_PATH_SLACK = 0.1;        // 路径可行性判定的放宽量：轮廓弦长误差不会卡死转向

  const PLAYER_RED_STEER_BIAS = playerNumber('red_steer_bias', { min: 0 });          // 沿红区行走时的额外外扩量，保证净空足额

  const RED_CONTOUR_MARGIN = 0.3;              // 轮廓生成时额外外扩的亚像素余量

  const RED_SHIELD_SCAN_STEP = 4;              // 点击屏蔽区时沿屏蔽区边缘找合法落点的采样间距

  const WALKABLE_SHIELD_SCAN_STEP = 8;         // 退化点击时沿可行动区轮廓找内侧落点的采样间距

  const PLAYER_RED_ROUTE_RANGE = playerNumber('red_route_range', { min: 0 });          // “移动路线范围内”的红区判定半径

  const PLAYER_RED_CONTOUR_STEP = 24;          // 红区外沿轮廓采样间距

  const PLAYER_RED_CONTOUR_REPAIR_DEPTH = 4;   // 轮廓环弦过近时的补插递归深度

  // 单个红区环上参与「贴边进/出点」评估的候选采样点数上限：环有数百个采样点，
  // 其中直线距离下界小于当前最优的点可能有上百个，每个都要跑两次线段净空判定。
  // 按直线下界升序只评估最靠前的若干个（几何最优解必然落在离起点/终点最近的这一段），
  // 单环判定量从上千次压到不足百次，多支小队同帧下达移动指令时开销不再线性叠加。
  // 取值必须大于「抽稀后的环节点数」（大块红区实测约 74 点）：上限若小于环节点数，
  // 真正的切点可能落在被截断的尾段里，贴边路线会明显绕远。
  // 升序 + 下界剪枝（见 getRingWalkLeg）本身已保证最优性，这里只作为兜底的规模上限
  const PLAYER_RED_WALK_LEG_CANDIDATE_LIMIT = 192;

  // 每帧用于「曲线绕行规划」的时间预算 (ms)：框选多支小队会在一帧内连续下达多条移动指令，
  // 每条都要跑一轮轮廓搜索，全部挤在同一帧里会明显掉帧；超预算的指令顺延到后续帧，
  // 等待期间小队先按直接转向前进（转向内部自带安全带脱离与沿红区滑动兜底），不会停在原地
  const PLAYER_PATH_FRAME_BUDGET = 4;

  const PLAYER_RED_ARC_STEP = 0.25;            // 凸角等距圆弧的采样角步长（弧度）

  const PLAYER_RED_WALKABLE_SAMPLE_STEP = 16;  // 连线可行动性抽样间距

  // 单条连线的可行动性抽样点数上限：按间距算出的点数超过它时不再增加采样。
  // 上限必须够大：大块红区的绕行弦动辄数百像素，点数被截断到 8 时，超过 128 像素的长弦
  // 一律欠采样——既可能把合法长弦误判为穿出绿色边界（进而整环作废、绕不过去），
  // 也可能漏掉中间一小段越界的弦而放行。32 点可覆盖 512 像素，
  // 且该分支只在最终校验（strict）时执行，点查询本身已按 4 像素键记忆化，开销有界
  const PLAYER_RED_WALKABLE_SAMPLE_MAX = 32;

  const PLAYER_RED_CORRECTION_ITERATIONS = 4;  // 推离红区的迭代次数

  const PLAYER_RED_SLIDE_RANGE = 24;           // 允许沿红区轮廓滑动的最大偏离

  // 沿轮廓滑动的方向迟滞：单位停在「离目标最近的那个轮廓点」附近时，前后两侧弧长几乎相等，
  // 逐帧比较会随亚像素变化来回翻转方向，表现为贴边原地抖动。要求后方弧长比前方短该比例
  // 以上才改走反向，等价点处方向恒定；真正需要折返时（后方明显更短）几帧内仍会正确翻转
  const PLAYER_RED_SLIDE_HYSTERESIS = 0.12;

  const PLAYER_RED_ARRIVE_DISTANCE = 2;        // 途经红区外沿节点的到达判定距离

  const PLAYER_MOVE_STALL_TIMEOUT = playerNumber('move_stall_timeout', { integer: true, min: 0 });      // 队长贴着红区边缘打转、长时间无法靠近终点的判定时长 (ms)

  const PLAYER_MOVE_PROGRESS_EPSILON = playerNumber('move_progress_epsilon', { min: 0 });    // 判定「确实靠近了终点」的最小距离 (px)

  const PLAYER_MOVE_STALL_RETRIES = 3;         // 停滞判定期间允许的重规划次数，用完仍无进展才收队

  // 防卡死限流：贴到红区安全带时，转向失败的位置往往是同一个，重新规划必须限流。
  // 不限流会形成「转向失败 -> 重新规划 -> 下一帧同样失败」的逐帧全量寻路风暴（浏览器卡死的主因），
  // 冷却期间改为继续沿红区轮廓滑动，保证队伍始终有位移、不会停在原地
  const PLAYER_RED_REPLAN_COOLDOWN = 260;            // 队长重新规划的最短间隔 (ms)

  const PLAYER_MEMBER_RETURN_REPLAN_COOLDOWN = 260;  // 队员归队重新规划的最短间隔 (ms)

  const PLAYER_MEMBER_ANIM_IDLE_DELAY = 120;         // 队员原地没有位移多久后把走路循环换成待机 (ms)

  const PLAYER_MEMBER_ANIM_MOVE_EPSILON = 0.05;      // 判定队员「本帧确实移动了」的最小位移 (px)

  // 我方单位动画流程参数
  const PLAYER_ATTACK_ANIMATION_FALLBACK = playerNumber('attack_animation_fallback', { integer: true, min: 0 }); // 取不到攻击动画时长时的兜底锁定时长 (ms)

  const PLAYER_ANIMATION_LOCK_GRACE = playerNumber('animation_lock_grace', { min: 0 });       // 一次性动画尾帧的保留容差 (ms)

  // 动画交叉淡化时长（秒）：攻击与移动/待机互相淡入淡出，切换时不会出现姿势硬切
  const PLAYER_ANIMATION_MIX_ATTACK = playerNumber('animation_mix_attack', { min: 0, max: 1 });     // 攻击 <-> 移动 / 待机

  const PLAYER_ANIMATION_MIX_LOOP = playerNumber('animation_mix_loop', { min: 0, max: 1 });       // 移动 <-> 待机

  // 我方步兵小队编队参数：三名角色各自持有独立的碰撞体（半径固定的圆形判定体），
  // 分别用于各自的红区净空、可行走与单位隔离判定；队伍本身仍共用一个移动碰撞体，
  // 指令、寻路、索敌一律按整队结算，所以整体依然是一个基本单位
  const PLAYER_SQUAD_FORMATION_SIDE = ACTIVE_PLAYER_RECORD.formation_side;   // 113：默认三角阵型的边长（队员相互间距，像素）

  const PLAYER_SQUAD_SEPARATION = ACTIVE_PLAYER_RECORD.member_separation;    // 38：队员之间绝对不允许突破的最小间距（防止叠加）

  // 每名队员的独立碰撞体：半径固定的圆形判定体，位置逐帧跟随本人，不随阵型形态变化
  const PLAYER_MEMBER_COLLISION_RADIUS = ACTIVE_PLAYER_RECORD.member_collision_radius;   // 17（JF 步兵基线）

  // 队员碰撞体与敌方碰撞体的最小圆心距：重叠时双方各承担一半重叠量。
  // 数据库的 member_enemy_separation 列已不在这里读取——运行时按「该队员自己的
  // collision 半径 + 敌方碰撞半径」逐队员计算（见 separatePlayerMembersFromEnemies /
  // separateEnemiesFromPlayerMembers），大型单位（TankM1 90 圆）与步兵（17 圆）各自生效。
  // 数据库列的取值规范仍是「队员碰撞半径 + 敌方碰撞半径」，由 build_unit_db.py 校验
  // 单位隔离每帧对单个单位的最大位移 (px)，避免瞬时弹开
  const PLAYER_MEMBER_SEPARATION_MAX_PUSH = playerNumber('member_separation_max_push', { min: 0 });

  // 队员渲染位置的每帧最大位移 (px)：正常跟随阵型约 6.3 像素/帧（375 × 1/60），完全跟得上；
  // 只有红区净空、越界修正、单位隔离这类可能一次推开几十像素的修正会被摊平到若干帧里，
  // 因此进出红色屏蔽区时不会看到队员位置跳变
  const PLAYER_MEMBER_ANIM_MAX_STEP = playerNumber('member_anim_max_step', { min: 0 });

  // 队员掉队判定：与自己的阵型站位拉开超过该距离，或者走回站位的直线会穿进红区安全带
  // （被红区推挤、被敌人顶开、队形被挤压甩出去等），都判定为掉队，改为自动寻路归队。
  // 归队走的是与队伍同源的曲线路径（沿红区轮廓绕行），不是直线缓动，因此不会穿过屏蔽区
  const PLAYER_MEMBER_RETURN_DISTANCE = playerNumber('member_return_distance', { min: 0 });

  // 归队迟滞：距离收进「触发阈值 × 该比例」以内、且直线回位已经安全时才算归位，
  // 避免在阈值附近反复进出归队状态导致动画来回切换
  const PLAYER_MEMBER_RETURN_EXIT_RATIO = playerNumber('member_return_exit_ratio', { min: 0, max: 1 });

  // 归位时对直线回位通道的要求比触发时更宽 (px)：触发只要 38 像素净空，
  // 退出要 53 像素净空，几何上形成死区，贴着红区边缘行军时不会被判定反复横跳
  const PLAYER_MEMBER_RETURN_EXIT_CLEARANCE = PLAYER_RED_ZONE_CLEARANCE
    + playerNumber('member_return_extra_clearance', { min: 0 });

  // 归队移动速度 (px/s)：比行军速度 (375) 快，队伍继续行军时也追得上
  const PLAYER_MEMBER_RETURN_SPEED = playerNumber('member_return_speed', { min: 0 }) * WG2_SPEED_FACTOR;

  // 归队目标点移动超过该距离才重新规划路径 (px)：队形站位一直在动，
  // 阈值太小会逐帧寻路，太大则归队方向会明显落后于队伍
  const PLAYER_MEMBER_RETURN_REPLAN_DISTANCE = playerNumber('member_return_replan_distance', { min: 0 });

  // 走到距路径拐点该距离以内 (px) 即视为经过该拐点，直接取下一个路径点
  const PLAYER_MEMBER_RETURN_WAYPOINT_RADIUS = playerNumber('member_return_waypoint_radius', { min: 0 });

  // 脱离红区后的归队参数：形态混合回落本质是对位置做插值，每秒收敛量远高于行军速度，
  // 看起来就是队员被「吸」回队列。改为保持当前形态、由每名队员按单位速度自己走回自己的站位
  const PLAYER_SQUAD_REGROUP_ARRIVE = playerNumber('squad_regroup_arrive', { min: 0 });           // 与自己的站位距离小于该值 (px) 即视为已归位

  const PLAYER_SQUAD_REGROUP_CATCHUP_DISTANCE = playerNumber('squad_regroup_catchup_distance', { min: 0 });  // 落后该距离 (px) 后速度线性提升，上限为归队速度

  const PLAYER_SQUAD_REGROUP_STALL_RATIO = playerNumber('squad_regroup_stall_ratio', { min: 0, max: 1 });     // 单帧朝站位靠近量不足预算的该比例即累计卡滞

  const PLAYER_SQUAD_REGROUP_STALL_FRAMES = playerNumber('squad_regroup_stall_frames', { integer: true, min: 0 });      // 连续卡滞帧数达到该值即认定已归位，交给阵型层收尾

  // 自由散开时队员越过「与队形中心最大距离」后的回收速度倍率（相对行军速度）：
  // 用缓动回收代替瞬时夹取，被拉回队伍时不会突然一顿
  const PLAYER_SQUAD_FREE_RETURN_RATIO = playerNumber('squad_free_return_ratio', { min: 0 });

  // 红区安全带挤压时用该值把队员推回，属于兜底的防叠加手段
  const PLAYER_SQUAD_SEPARATION_TARGET = playerNumber('squad_separation_target', { min: 0 });

  const PLAYER_SQUAD_SEPARATION_BUFFER = playerNumber('squad_separation_buffer', { min: 0 });

  // 跨小队队员隔离的最小圆心距：多支小队同时向同一目标点汇聚时，不同小队的队员也必须
  // 保持该间距（队内隔离只约束本队三人）。数值与队内 member_separation 一致，
  // 避免「所有单位点到同一处」时各队阵型互相压进、不同小队的队员叠在一起
  const PLAYER_CROSS_SQUAD_SEPARATION = ACTIVE_PLAYER_RECORD.member_separation;

  // 跨队阵型偏移的低通滤波系数：每帧向「本次需要的平移量」收敛一部分，偏移因此平滑，
  // 不会逐帧被阵型重算拉回而震荡；附近队伍离开后向 0 平滑回位
  const PLAYER_CROSS_SQUAD_LERP = 0.4;

  // 单队阵型偏移上限 (px)：整队平移避让也有限度，避免多个方向的挤压把整队推得远离落点
  const PLAYER_CROSS_SQUAD_MAX_SHIFT = 80;

  // 多支小队同时收到同一个移动指令时，把终点按圆环分摊给各小队：
  // 半径要大于单支小队的阵型占地，否则各小队的阵型仍会互相压进
  const PLAYER_SQUAD_ORDER_SPREAD = playerNumber('squad_order_spread', { min: 0 });

  const PLAYER_SQUAD_ORDER_SEARCH_RINGS = 6;  // 理想落点被挡住时向外搜索的圈数（每圈挪半个 squad_order_spread）

  // 候选方向（相对「理想落点 -> 点击点」的夹角，单位度）：先朝点击点方向挪，再左右交替铺开，最后才背离点击点。
  // 点击点常常贴着急剧内凹的可行动区边界或红区凹口，这时只有往点击点一侧挪才落得下脚
  const PLAYER_SQUAD_ORDER_SEARCH_DIRECTIONS = [180, 150, 210, 120, 240, 90, 270, 60, 300, 30, 330, 0];

  const PLAYER_SQUAD_SEPARATION_PASSES = playerNumber('squad_separation_passes', { integer: true, min: 1 });     // 人员隔离与红区净空的交替求解轮数

  const PLAYER_SQUAD_EDGE_RANGE = playerNumber('squad_edge_range', { min: 0 });            // 判定“已贴到红色屏蔽区边缘”的额外距离（像素）

  const PLAYER_SQUAD_FORMATION_LERP = playerNumber('squad_formation_lerp', { min: 0, max: 1 });     // 行进方向的插值系数，避免拐角时方向跳变

  // 贴红区判定的迟滞区间：进入用 PLAYER_SQUAD_EDGE_RANGE、退出用更大的该值。
  // 两个阈值不同才能避免沿安全带行走时判定来回抖动、队形跟着抽搐
  const PLAYER_SQUAD_EDGE_EXIT_RANGE = playerNumber('squad_edge_exit_range', { min: 0 });

  // 三角阵型 <-> 自由散开的过渡时长 (ms)：散开与收拢共用一个时长。
  // 队员散开时与队形中心的落差最大可达数十像素，收拢阶段若时长过短，单帧位移会远超行军速度、
  // 看着像被“吸”回队列；这里取 560ms，把每秒收敛量摊平到行军速度的两倍以内，过渡更柔和
  const PLAYER_SQUAD_MORPH_DURATION = playerNumber('squad_morph_duration', { integer: true, min: 0 });

  const PLAYER_SQUAD_TRIANGLE_RADIUS = PLAYER_SQUAD_FORMATION_SIDE / Math.sqrt(3); // 正三角形外接圆半径

  // 默认阵型固定按屏幕坐标摆放，与行进方向无关：任何时候都是 Qiongjiu 在三角形最上方、
  // Daiyan 在最右边、Jiangyu 在最左边；每次更改终点都会重新回到这一站位
  const PLAYER_SQUAD_SLOT_OFFSETS = {
    apex: { x: 0, y: -PLAYER_SQUAD_TRIANGLE_RADIUS },                                   // Qiongjiu 最上
    right: { x: PLAYER_SQUAD_FORMATION_SIDE / 2, y: PLAYER_SQUAD_TRIANGLE_RADIUS / 2 },  // Daiyan 最右
    left: { x: -PLAYER_SQUAD_FORMATION_SIDE / 2, y: PLAYER_SQUAD_TRIANGLE_RADIUS / 2 }   // Jiangyu 最左
  };

  // 贴到红区边缘时不再排成一路纵队，而是脱离队列自由移动：每名队员各自朝自己那份
  // 松散站位前进（side 为行进方向的垂直分量、back 为沿行进方向的落后量），
  // 彼此只用 38 像素最小间距隔离，因此可以各走各的、各自贴着安全带绕行；
  // 整个队伍脱离红区后再平滑收拢回三角阵型。
  // 松散站位按「站位」而不是「队员」定义：换站位时队形形状不变，只是站的人不同
  const PLAYER_SQUAD_FREE_SPREAD = playerNumber('squad_free_spread', { min: 0 });          // 自由移动时的横向展开量 (px)

  const PLAYER_SQUAD_FREE_MAX_DISTANCE = playerNumber('squad_free_max_distance', { min: 0 });    // 队员与队形中心的最大距离（保证队伍整体连贯）

  const PLAYER_SQUAD_FREE_OFFSETS = {
    left: { side: -PLAYER_SQUAD_FREE_SPREAD, back: playerNumber('squad_free_back_left') },   // 左侧
    apex: { side: 0, back: playerNumber('squad_free_back_apex') },                         // 中间稍前
    right: { side: PLAYER_SQUAD_FREE_SPREAD, back: playerNumber('squad_free_back_right') }    // 右侧
  };

  // 双人小队（coffee / 404）不走三角阵，只区分头尾——队长（花名册末位）为排头，
  // 队形为横向并排（ROW_*），间距沿用三角阵的边长
  // 双人横队阵型：排头（队长）在右、排尾在左，与三人阵「队长在上」的惯例同理只影响默认站位
  const PLAYER_SQUAD_ROW_SLOT_OFFSETS = {
    head: { x: PLAYER_SQUAD_FORMATION_SIDE / 2, y: 0 },    // 排头（队长）在右
    tail: { x: -PLAYER_SQUAD_FORMATION_SIDE / 2, y: 0 }    // 排尾在左
  };

  // 双人横队贴红区自由移动时的松散站位：头尾沿行进方向的两侧展开
  // （侧向量 = 行进方向垂直分量），不再前后错位，侧向间距沿用三角阵边长，
  // 保证横排站距与整队横队阵型一致；仍由队员隔离与红区净空收尾兜底
  const PLAYER_SQUAD_ROW_FREE_OFFSETS = {
    head: { side: PLAYER_SQUAD_FORMATION_SIDE / 2, back: 0 },
    tail: { side: -PLAYER_SQUAD_FORMATION_SIDE / 2, back: 0 }
  };

  const PLAYER_SQUAD_COLUMN_SLOT_ORDER = ['tail', 'head'];  // 花名册顺序：先排尾，队长（末位）站排头

  // 站位重新分配的门槛：只有队伍已经基本完全散开（该形态下位置由自由位置决定、
  // 与站位无关）时才换站位，换的瞬间任何队员都不会瞬移。低于该值说明只是轻轻擦过
  // 安全带，此时保持原站位，避免出现细微的位置跳变
  const PLAYER_SQUAD_SLOT_SWAP_BLEND = playerNumber('squad_slot_swap_blend', { min: 0, max: 1 });

  // 小队花名册站位映射：队员名与人数在 createPlayerSquad 里按各兵种记录的 roster 列展开
  // （约定最后一项为队长）。按 roster 顺序先建两翼、最后建队长，保证三名队员互相重叠时队长绘制在最上层
  const PLAYER_SQUAD_SLOT_ORDER = ['left', 'apex', 'right'];


  // ----------------------------------------------------
  // 我方出生点（GRF 信标）与环形选择菜单参数
  // 坐标按标注图 → 地图原始像素的换算系数烘焙（见 walkableBoundary 注释）；
  // 新图由 MAP_DATA.world.spawnPoint 数据驱动（WG2），缺省回退旧图烘焙值（WG.html 不变）
  // ----------------------------------------------------
  const SPAWN_POINT_X = (MAP_DATA.world.spawnPoint ? MAP_DATA.world.spawnPoint.x : 632.5);  // 我方单位的出生点坐标

  const SPAWN_POINT_Y = (MAP_DATA.world.spawnPoint ? MAP_DATA.world.spawnPoint.y : 1597.1);

  // 出生后的自动集合点：出生点右侧 150 像素的位置。
  // 落点中心在出生点右侧 SPAWN_RALLY_OFFSET_X，再按小队序号在圆环偏移上做小幅度散布
  const SPAWN_RALLY_OFFSET_X = 150;

  const SPAWN_RALLY_SPREAD = 0.6;

  const SPAWN_BADGE_RADIUS = 49;                // 出生点信标圆形底盘半径（26 × 1.875，正好容纳标定后的三人小队）

  const SPAWN_BADGE_ICON_SCALE = 1.5;           // GRF 徽标图标缩放（按原尺寸放大 1.5 倍）

  const SPAWN_BADGE_PAD_SCALE = 1.5;            // GRF 徽标底盘缩放（不透明底盘随图标同步放大，始终衬住图标）

  const SPAWN_RING_RADIUS = 146.5;              // 出生动画的淡蓝色扩散光环半径（78 × 1.875）

  const SPAWN_RING_COLOR = 0x9fe3ff;            // 淡蓝色：光环描边、按钮描边与图标染色基准

  const SPAWN_PAD_COLOR = 0x0d1b33;             // 信标底盘用的深海蓝

  const SPAWN_GLOW_TEXTURE_SIZE = 256;          // 出生光晕纹理尺寸

  const SPAWN_GLOW_BASE_SCALE = (SPAWN_RING_RADIUS * 2.6) / SPAWN_GLOW_TEXTURE_SIZE;

  const SPAWN_ANIMATION_DURATION = playerNumber('spawn_animation_duration', { integer: true, min: 0 });         // 出生动画时长 (ms)

  const SPAWN_ANIMATION_MIN_SCALE = playerNumber('spawn_animation_min_scale', { min: 0, max: 1 });        // 出生动画起始缩放（相对正常体型）


  // 左上角出生界面：96×96 黑灰渐变矩形按钮 + 点数经济。
  // 96×96 是能完整显示圆形主图、又不会压住战场的最小尺寸：圆形图标按 2 倍分辨率（192px）
  // 生成纹理、文字按 resolution = 2 渲染，缩放后依然清晰不糊。
  const PLAYER_START_POINTS = 300;              // 开局可用点数

  // 番茄防线与一局时长：敌方单位踏入出生点范围即吃掉一个番茄，归零即落败；
  // 8 分钟倒计时结束时番茄还有剩余则胜利
  const TOMATO_START_COUNT = 10;

  const TOMATO_LEAK_RADIUS = 75;                // 敌方进入出生点多远算突破（像素）

  // 一局总时长：WG 8 分钟；WG2 任务要求坚持 10 分钟（仅 IS_WG2 分叉，WG.html 不受影响）
  const MATCH_DURATION_MS = IS_WG2 ? 10 * 60 * 1000 : 8 * 60 * 1000;

  const PLAYER_SELL_REFUND_RATIO = 0.8;         // 主动出售单位时返还招募点数的比例（80%）

  const PLAYER_POINTS_PER_MINUTE = 240;         // 每分钟自动获得的点数

  const PLAYER_SQUAD_LIMIT = 8;                 // 小队数量基数（GRF1 分类的生成上限，同时用于多队落点分摊）

  // 第二层分类按钮（GRF1 / tasa_air / RS）的生成上限：只约束自己下属的第三层出兵按钮，
  // 三个分类互不影响——GRF1 的上限不再连带卡住 tasa_air 与 RS
  const SPAWN_CATEGORY_CAP = { grf1: PLAYER_SQUAD_LIMIT, tasa_air: 5, rs: 2 };

  const SPAWN_HUD_MARGIN = 8;                   // 按钮组距离屏幕左上角的边距（屏幕像素）

  const SPAWN_BUTTON_WIDTH = 96;                // 交互按钮宽（屏幕像素）

  const SPAWN_BUTTON_HEIGHT = 96;               // 交互按钮高（屏幕像素）

  const SPAWN_BUTTON_ICON_TEXTURE_SIZE = 192;   // 按钮圆形图标纹理边长（2× 按钮尺寸）

  const SPAWN_BUTTON_GAP = 8;                   // 按钮之间的间距（屏幕像素）

  const SPAWN_BUTTON_TOP_COLOR = 0x33373d;      // 黑灰渐变：上端深灰

  const SPAWN_BUTTON_BOTTOM_COLOR = 0x0a0b0d;   // 黑灰渐变：下端近黑

  const SPAWN_BUTTON_BORDER_COLOR = 0x9fe3ff;   // 按钮描边：淡蓝

  const SPAWN_HUD_DEPTH = 900;                  // 出生界面绘制层级（高于单位与特效）

  const SPAWN_BUTTON_ALPHA = 1;                 // 全部按钮不透明（兵种均已开放出兵）

  const SPAWN_POINT_TEXT_COLOR = '#ffd9a0';     // 点数文字：淡橙色

  const SPAWN_POINT_TEXT_STROKE = '#1a1206';    // 点数文字描边：深棕黑

  // 交互动画：下级按钮以父按钮（GRF / GRF1）为动画主体，从父按钮位置滑出并淡入，
  // 收起时原路滑回父按钮再淡出；按下按钮时做一次轻微缩放反馈（不影响滑动动画）
  const SPAWN_BUTTON_SLIDE_DURATION = 220;      // 滑入 / 滑出时长 (ms)

  const SPAWN_BUTTON_SLIDE_STAGGER = 40;        // 同层按钮之间错开的延迟 (ms)

  const SPAWN_BUTTON_PRESS_SCALE = 0.92;        // 按下时缩到的比例

  const SPAWN_BUTTON_PRESS_DURATION = 90;       // 按下 / 回弹时长 (ms)

  // 出生界面按钮：图标右上角显示招募消耗、右下角显示已出场队伍数。
  // 两个点数概念都从数据库读取，页面不保留任何写死的数值：
  //   cost        = 招募时真正从玩家可用点数里扣掉的消耗（JF = 40）
  //   deploy_cost = 单位留在场上期间，每分钟可获得的点数上限被削掉的量（步兵 10 / 重甲 30 / 支援 20）
  const SPAWN_BUTTON_UNITS = {
    grf1: ['player_infantry', 'JF'],            // 步兵分类（点击后展开下层的单位列表）
    jf: ['player_infantry', 'JF'],              // 步兵小队（JF）
    elmo1: ['player_infantry', 'ELMO1'],        // ELMO1 小队（Biyoca / Andoris / Groza）
    elmo2: ['player_infantry', 'ELMO2'],        // ELMO2 小队（Cheeta / Lenna / Soumi）
    GK: ['player_infantry', 'GK'],              // GK 小队（Centaureissi / Sharkry / Tololo）
    tasa_air: ['player_heavy', 'tasa_air'],     // 重甲分类（点击后展开 coffee / SF / 404）
    rs: ['player_support', 'mid'],              // RS 分类（图标 RS.png，点击后展开 TankM1 / Ares / Warjack）
    coffee: ['player_support', 'coffee'],       // 我方支援单位（与 mid / 404 同表）
    SF: ['player_support', 'SF'],
    '404': ['player_support', '404'],
    TankM1: ['player_heavy', 'TankM1'],         // 重甲单位
    Ares: ['player_heavy', 'Ares'],
    Warjack: ['player_heavy', 'Warjack']
  };

  const SPAWN_BUTTON_DEPLOY_COST = readSpawnButtonColumn('deploy_cost');

  const SPAWN_BUTTON_RECRUIT_COST = readSpawnButtonColumn('cost');

  // 各兵种可同时出场的数量上限（含训练中）：读数据库 squad_cap 列（JF = 6）
  const SPAWN_BUTTON_SQUAD_CAP = readSpawnButtonColumn('squad_cap');

  if (SPAWN_BUTTON_RECRUIT_COST.jf === null) {
    throw new Error('player_infantry.JF 缺少 cost（招募消耗点数），请检查 unit_database.sql');
  }


  const enemyRoutes = MAP_DATA.enemyRoutes;


  // 每条主路线在 ±ENEMY_ROUTE_CORRIDOR 的走廊内生成 ENEMY_ROUTE_VARIANT_COUNT 条变体：
  // 各条车道的基线从走廊左沿均分到右沿，再叠一层逐点摆动，路线之间不会完全平行；
  // 实际目标仍由 isWalkable 过滤，并在碰撞区域定义之后逐点再做一次安全校验。旧版手工偏移表比路线节点少一项，末节点会算成 NaN 而被跳过，
  // 这里改成按节点数量程序化生成，每条变体的节点数与主路线严格一致。
  const routeLaneRatios = Array.from({ length: ENEMY_ROUTE_VARIANT_COUNT }, (unused, index) => (
    ENEMY_ROUTE_VARIANT_COUNT === 1 ? 0 : (index / (ENEMY_ROUTE_VARIANT_COUNT - 1)) * 2 - 1
  ));

  enemyRoutes.forEach(route => {
    route.variants = routeLaneRatios.map((lane, laneIndex) => route.points.map((point, index) => ({
      x: point.x,
      // 中间车道就是主路线本身，其余车道基线占走廊 82%，剩下 16% 留给摆动，
      // 最外侧车道的偏移量因此不超过走廊半宽（38 × 0.98 ≈ 37 像素，在 40 像素以内）
      y: lane === 0 ? point.y : point.y + lane * ENEMY_ROUTE_CORRIDOR * 0.82 +
         Math.sin((index + laneIndex * 1.7) * 0.9) * ENEMY_ROUTE_CORRIDOR * 0.16
    })));
  });


  // 敌军出生点位于地图外：每条路线变体都在 entrySide 对应边的边界外补一个入场节点，
  // 单位在地图外生成后先沿这条入场线走进地图，抵达第一个地图内节点才切换常规路线逻辑。
  // 入场边由地图数据 route.entrySide 判定（left/right/top/bottom），缺省 right 保持旧图行为；
  // 同边各变体沿边错开，避免多支敌军挤在同一个集结位置。
  enemyRoutes.forEach((route, routeIndex) => {
    route.variants = route.variants.map((points, variantIndex) => {
      const first = points[0];
      const stagger = routeIndex * 24 + variantIndex * 20;
      const side = route.entrySide || 'right';
      const entry = side === 'left' ? { x: -ENEMY_SPAWN_OFFMAP_PADDING - stagger, y: first.y }
        : side === 'top' ? { x: first.x, y: -ENEMY_SPAWN_OFFMAP_PADDING - stagger }
        : side === 'bottom' ? { x: first.x, y: WORLD_HEIGHT + ENEMY_SPAWN_OFFMAP_PADDING + stagger }
        : { x: WORLD_WIDTH + ENEMY_SPAWN_OFFMAP_PADDING + stagger, y: first.y };
      return [entry, ...points];
    });
  });


  // 统一碰撞区域配置：蓝线框选外部为屏蔽区，绿线框选内部到红线外部为可行动区，红线框选内部禁止进出
  const collisionRegions = MAP_DATA.collisionRegions;


  // 走廊变体的安全校验：车道偏移有可能把节点推出可行走区，或者推进红区的安全带之内
  // （右侧出生点附近的可行走带本来就窄，地图外的入场节点也容易斜插到屏蔽区上），
  // 所以这里再逐点校验一遍：不安全的节点一律退回同序号的主路线节点；
  // 入场节点整体位于地图之外，跟随第一个地图内节点对齐（左右入场对齐 Y、上下入场对齐 X），
  // 保证入场线不会斜插进屏蔽区。校验依赖碰撞区域与红区判定，因此放在 collisionRegions 定义之后执行。
  enemyRoutes.forEach(route => {
    const verticalEntry = route.entrySide === 'top' || route.entrySide === 'bottom';
    route.variants = route.variants.map(points => {
      const safePoints = points.map((point, index) => {
        if (index === 0) return { x: point.x, y: point.y };
        const base = route.points[index - 1];
        const safe = isWalkable(point.x, point.y) &&
          isRedClearanceSafePoint(point.x, point.y, ENEMY_RED_ZONE_CLEARANCE);
        return safe ? point : { x: base.x, y: base.y };
      });
      if (verticalEntry) safePoints[0].x = safePoints[1].x;
      else safePoints[0].y = safePoints[1].y;
      return safePoints;
    });
  });



  // RTS 玩家单位状态：我方小队可以同时存在多支（GRF1 每次生成一支），
  // 因此所有小队级状态都收进 squad 对象，逻辑函数统一以 squad 作为第一个参数。
  // 小队字段与原先的整套全局变量一一对应：
  //   unit       隐藏的物理锚点（整队移动与索敌用），isSpawned / isSelected / isMoving 等标记挂在它身上
  //   character  队长 Daiyan 的 Spine 对象，沿用原有动画流程
  //   members    三名队员：{ key, uid, squad, slot, isLeader, character, body, renderX, renderY }
  //   forward    行进方向：三角阵型的站位固定在屏幕上，不受它影响
  //   freeBlend / morphProgress    三角阵型 <-> 自由散开之间的过渡（缓动值与线性进度）
  //   squeezed / freeActive / regrouping   贴红区自由移动与脱区归位的状态机
  //   slotAssignment / slotSwapped 队员 -> 三角站位：只固定「队形形状」，不固定谁站哪个位置
  //   moveTarget / detourPath / replanKey / moveProgress  移动指令与进度看门狗
  //   animName / animLockName / animLockUntil             动画流程状态（重复下发同名动画会重置到第一帧）
  let playerSquads = [];

S.squadSerial = 0;

  // 人物显示尺寸统一标定为 50×50 像素（旧版是 100×100），
  // 因此渲染缩放 = 0.30 × 1.875 = 0.5625、敌方 = 0.145 × 1.875 = 0.272，
  // 两边都在同一比例下缩小，屏幕上的相对大小与原来一致
  const PLAYER_CHARACTER_SCALE = ACTIVE_PLAYER_RECORD.character_scale;   // 0.5625

  const ENEMY_CHARACTER_SCALE = ACTIVE_ENEMY_RECORD.character_scale;     // 0.272

  const ENEMY_SPEED = ACTIVE_ENEMY_RECORD.move_speed;                    // 150（80 × 1.875，与我方 187.5 保持原来的 4:5 速度比）

  const ENEMY_ATTACK_RANGE = ACTIVE_ENEMY_RECORD.action_range;           // 攻击范围 180：我方单位一进入该范围就立即开火（停火距离与之同值）

  // 追踪范围 240 像素（比攻击范围多出 60 像素的追击行程）：
  // 我方单位进入这个范围就激活追踪并开始逼近，追到攻击范围边缘（180 像素，即停火距离）站定交火；
  // 只有拉开到追踪范围之外才放弃追踪，随即从当前位置走向下一个行动点
  const ENEMY_TRACK_RANGE = ACTIVE_ENEMY_RECORD.track_range;   // 240

  const ENEMY_ATTACK_INTERVAL = ACTIVE_ENEMY_RECORD.action_cd * 1000;   // 1.1s -> 1100ms：开火间隔，只节流「伤害结算」，不节流攻击姿态

  // 冲刺近战（Guard / Aegis / Smasher / Kratos）：超时时长（毫秒）。
  // 冲刺一生只能使用一次；冲刺速度与命中眩晕时长按各兵种记录（charge_speed / charge_stun_duration）读取
  const ENEMY_CHARGE_TIMEOUT = 2500;

  // 抵达容差：追踪逼近到停火距离（= 攻击范围）时，站位会因红区推离与步长截断正好停在
  // 180.0000x 像素处，一步都迈不进去。若用严格比较判定「是否进入攻击范围」，
  // 这种站位会被判成「还没进射程」，敌军就永远停在原地不开火。
  // 因此站定判定统一留 4 像素容差：进入攻击范围 + 4 像素即视为到位，立刻进攻击姿态
  const ENEMY_ATTACK_CONTACT_TOLERANCE = enemyNumber('attack_contact_tolerance', { min: 0 });

  // 攻击姿态迟滞带：进入交火按攻击范围（180 像素）判定，维持交火再多给 12 像素。
  // 我方单位在停火距离附近上下移动时，与敌军的距离会反复跨过 180 像素这一条线，
  // 单阈值会让姿态每帧在「攻击 / 移动」之间来回切换（实测 120 帧切换 4 次）。
  // 加上迟滞带后，只有拉开到 192 像素之外才打断攻击动画转入追击，边界微动不再换姿态
  const ENEMY_ATTACK_RELEASE_MARGIN = ACTIVE_ENEMY_RECORD.attack_release_margin;   // 12

  // 追踪范围同样带迟滞：进入追踪按追踪范围（240 像素）判定，
  // 拉开到 256 像素之外才放弃追踪，避免我方单位在 240 像素边界上下微动时
  // 反复「放弃追踪 → 重新追踪」，进而在攻击与待机动画之间来回切换（实测 200 帧切换 3 次）
  const ENEMY_TRACK_RELEASE_MARGIN = ACTIVE_ENEMY_RECORD.track_release_margin;   // 16

  // 攻击姿态规则：只要我方人形还在攻击范围内就循环播放攻击动作，首次进入与重新进入
  // 都直接进攻击动作、不经过等待动作。姿态切换只依赖距离状态，不依赖动画完成回调——
  // 攻击被打断时回调不一定会到来，堆积的监听会让姿态收尾变得不可预期
  const ENEMY_ATTACK_LOOP = enemyNumber('attack_animation_loop', { integer: true, min: 0 }) === 1;


  // ----------------------------------------------------
  // 战斗属性（旧的「固定减伤护甲」公式已废弃）：任一单位造成伤害前先做一次结算，
  // 比较「攻击方破甲值」与「防守方护甲值」——
  //   破甲 >= 护甲：造成等额伤害（action_value），每多出 1 点破甲，本次伤害提升 10%
  //   破甲 <  护甲：每少 1 点破甲，本次伤害减少 10%
  // 我方 JF 破甲 8 / 敌方 Vespid 护甲 8 -> 我方单发 3 点；
  // 敌方破甲 8 / 我方护甲 8 -> 敌方单发 2 点
  // ----------------------------------------------------
  const ARMOR_PENETRATION_STEP = 0.1;    // 破甲与护甲每相差 1 点的伤害增减比例


  // 我方齐射按「每名存活队员各结算一次」，敌方命中我方队员同样单独结算。
  // 双方伤害都在命中时刻按「攻击方记录 vs 防守方记录」实时结算（各兵种破甲/护甲不同，
  // 见索敌循环与敌方攻击处的 computeArmorDamage 调用），不再保留启动期的单一常量
  const ENEMY_MAX_HP = ACTIVE_ENEMY_RECORD.max_hp;


  // 血条：细长条形（圆角细条），位于单位头顶上方 4 像素处；
  // 若当前动作姿态会遮住人物则继续上移。我方绿色、敌方红色。
  // 高度 / 圆角 / 间隙同样按 1.875 标定，与 50×50 的人物保持原来的观感比例
  const HEALTH_BAR_GAP = 4;

  const HEALTH_BAR_HEIGHT = 5.5;

  const HEALTH_BAR_RADIUS = 3;

  const PLAYER_BAR_WIDTH = playerNumber('bar_width', { min: 0 });

  const ENEMY_BAR_WIDTH = enemyNumber('bar_width', { min: 0 });

  const HEALTH_BAR_BG = 0x111111;

  const PLAYER_BAR_COLOR = 0x35d96b;

  const ENEMY_BAR_COLOR = 0xff4d4d;

  // 血条显示规则：双方单位在「未被攻击」时不显示血条（满血即视为未被攻击过；
  // 我方回满血后重新隐藏）。敌方没有回血机制，被打过一次就一直显示。
  // 我方回血参数（regen_delay / regen_per_second）在 updatePlayerSquadRegen 里
  // 按各兵种记录实时读取，不再保留启动期的单一常量

  // 脚下阴影：与敌方单位脚下阴影同款的柔和椭圆。
  // 比例取自敌方 Vespid 美术自带的阴影（约 10.4 × 2.8 像素 / 单位宽约 15.7 像素）
  const SHADOW_TEXTURE_KEY = 'unitShadowTexture';

  const SHADOW_WIDTH_RATIO = playerNumber('shadow_width_ratio', { min: 0 });

  const SHADOW_FLATTEN = playerNumber('shadow_flatten', { min: 0 });

  const SHADOW_ALPHA = playerNumber('shadow_alpha', { min: 0, max: 1 });

  const SHADOW_OFFSET_Y = playerNumber('shadow_offset_y');

  const SHADOW_DEPTH = 1.6;

  // 多部件单位的附加渲染层（后层）层级：压在主体（2）之下、脚下阴影（1.6）之上
  const PLAYER_MEMBER_BACK_PART_DEPTH = 1.9;


  // 我方单位脚下圆环：每名队员各一个，随阵型一起移动
  const PLAYER_RING_WIDTH = playerNumber('ring_width', { min: 0 });

  const PLAYER_RING_HEIGHT = playerNumber('ring_height', { min: 0 });

  const PLAYER_RING_OFFSET_Y = playerNumber('ring_offset_y');


  // 战术移动目标点标记：上方实心蓝色倒三角 + 下方角色脚底圆环 的组合目标点，
  // 每支当前被选中的小队各显示一个（数量与框选/单选的小队数一致）。
  // 倒三角在圆环正上方，按 sin 上下浮动；圆环贴地（脚底），三角悬在其上方
  const TARGET_MARKER_RING_WIDTH = 37.5;      // 脚底圆环宽度 (px)

  const TARGET_MARKER_RING_HEIGHT = 14;       // 脚底圆环高度 (px)

  const TARGET_MARKER_RING_OFFSET_Y = 4;      // 圆环相对落点的下沉量 (px)

  const TARGET_MARKER_TRIANGLE_H = 16;        // 倒三角高度 (px)

  const TARGET_MARKER_TRIANGLE_W = 20;        // 倒三角底边宽度 (px)

  const TARGET_MARKER_TRIANGLE_Y = -26;       // 倒三角相对落点的基准高度（浮动的中位）

  const TARGET_MARKER_BOB_AMPLITUDE = 4;      // 倒三角上下浮动幅度 (px)

  const TARGET_MARKER_BOB_SPEED = 0.006;      // 浮动角速度 (rad/ms)

  // 单击选中我方小队的命中半径：队员散在锚点周围（阵型外接半径约 33px），
  // 取略大于外接半径的距离，点击任意队员都能选中整支小队
  const PLAYER_SINGLE_CLICK_RADIUS = 40;

  // 我方单位尺寸按游戏内标定的 50×50 像素取（视觉半径 25），不读取 Spine JSON 里的骨架画布尺寸；
  // 出售圆环按「队员到锚点最大距离 + 该半径」取外沿，保证整支单位被完整包围
  const PLAYER_MEMBER_VISUAL_RADIUS = 25;

  // 单击敌方单位的命中半径：敌方是 Spine 对象，setInteractive 无参数时 hit area
  // 依赖骨架包围盒，实际不可靠，因此点击判定改为在全局指针事件里按距离检测。
  // 半径取碰撞半径的 1.5 倍，比人物视觉尺寸略大，便于点中
  const ENEMY_CLICK_RADIUS = ENEMY_COLLISION_RADIUS * 1.5;

  // 集火标记：被集火敌方角色四角的红色圆角边线（圆角 L 形括号）。
  // 包围盒固定 50×50（与敌方单位的人物标定尺寸一致），中心对齐角色视觉中心
  const FOCUS_BRACKET_SIZE = 50;               // 包围盒边长 (px)

  const FOCUS_BRACKET_CENTER_OFFSET_Y = -17;   // 包围盒中心相对角色锚点的偏移 (px)

  const FOCUS_BRACKET_ARM = 12;                // 每段圆角边线的长度 (px)

  const FOCUS_BRACKET_RADIUS = 6;              // 圆角边线的圆角半径 (px)

  const FOCUS_BRACKET_OFFSET = 2;              // 单侧移动幅度 (px)，正向向外、负向向内

  const FOCUS_BRACKET_SPEED = 0.008;           // 往复角速度 (rad/ms)

  // 出售：选中我方小队后，单位外圈显示黄色圆环边框（圆环外 20 像素是淡黄色渲染带），
  // 圆环正下方是六边形「$」出售按钮；点击后返还招募点数并让该小队立刻自爆
  const SELL_RING_WIDTH = 2;                   // 黄色圆环细线宽度 (px)

  // 圆环相对单位外沿再外扩的距离：留出余量，保证圆环完整包围单位且不压到角色身上
  const SELL_RING_CLEARANCE = 10;

  // 圆环整体相对单位锚点上移的距离：角色视觉重心在锚点上方，圆环跟着上移才居中
  const SELL_RING_OFFSET_Y = 20;

  const SELL_GLOW_BAND = 10;                   // 圆环外侧淡黄色渲染带宽度 (px)

  const SELL_RING_COLOR = 0xffe14d;            // 黄色圆环颜色

  const SELL_GLOW_COLOR = 0xffe9a8;            // 淡黄色渲染带颜色

  const SELL_GLOW_ALPHA = 0.22;                // 渲染带透明度

  const SELL_BUTTON_RADIUS = 17;               // 六边形按钮外接圆半径基准值 (px)

  const SELL_BUTTON_GAP = 12;                  // 按钮与圆环之间的间距 (px)

  const SELL_BUTTON_FILL = 0xcc2222;           // 按钮主体（红色）

  const SELL_BUTTON_BORDER = 0x000000;         // 按钮边框（黑色 1px）

  const SELL_BUTTON_TEXT_COLOR = '#ffe14d';    // 「$」文字颜色（黄色）

  const SELL_BUTTON_TEXT_SIZE = 16;            // 「$」字号，比标准按钮文本小约 15%

  // 按钮直径与单位高度的比例：整体尺寸随小队实际高度协调缩放
  const SELL_BUTTON_HEIGHT_RATIO = 0.275;

  // 我方步兵小队训练时长：取自数据库 build_time（30 秒）。
  // 阵亡的那一支小队需要这么久才能训练完成并补充回队列——是单位级冷却，
  // 不影响其他存活单位，也不让整个兵种按钮进入训练态
  const PLAYER_SQUAD_BUILD_TIME = ACTIVE_PLAYER_RECORD.build_time * 1000;

  // 双击间隔 (ms)：同一支小队在此时间内被点两次即呼出 / 收起出售圆环
  const DOUBLE_CLICK_MS = 300;


  // ----------------------------------------------------
  // GustafAssist2：我方永久固定炮击单位（player_merc 唯一记录）。
  // 站位在出生信标左侧 100px；不可移动、不可出售，不在 playerSquads 注册表里，
  // 敌方索敌与碰撞天然忽略它。射程 / 溅射 / 弹速 / 冷却 / 破甲 / 炮口骨骼
  // 全部按记录实时读取，代码不写死数值
  // ----------------------------------------------------
  const GUSTAF_RECORD = PLAYER_UNIT_RECORDS.GustafAssist2;

  // 驻位偏移由地图数据 world.gustafOffset 数据驱动（相对出生点，WG2 提取时已选净空最大位），
  // 缺省回退旧图固定偏移（出生信标左侧 340px / 上方 50px）
  const GUSTAF_OFFSET = MAP_DATA.world.gustafOffset || null;

  const GUSTAF_X = GUSTAF_OFFSET ? SPAWN_POINT_X + GUSTAF_OFFSET.x : SPAWN_POINT_X - 340;

  const GUSTAF_Y = GUSTAF_OFFSET ? SPAWN_POINT_Y + GUSTAF_OFFSET.y : SPAWN_POINT_Y - 50;

  const GUSTAF_SHELL_COST = 100;                // 每发炮弹消耗的总点数（头顶三角显示同款数字）

  const GUSTAF_SHELL_COUNT = 2;                 // 每次发射的炮弹数量

  // WG2 专用：Gustaf 爆炸特效抬升参数——火球中心自落点向上抬升（liftRatio × 半径），
  // 渲染层级抬到所有单位显示之上（单位 2 / 血条 4 / 炮弹 5.5 / 旧爆炸 6 之上，伤害数字 8 之下），
  // 并追加少量升腾火团；冲击波环仍留在地面。WG.html 恒为 null，爆炸渲染行为逐位不变
  const GUSTAF_EXPLOSION_ELEVATION = IS_WG2 ? { liftRatio: 0.45, flashDepth: 7.6, puffCount: 3 } : null;

  // 基础伤害 270（数据库 action_value 已直接登记为 300-30 后的数值），
  // 代码不做任何削减，破甲公式与距离衰减按数据库原值计算
  const GUSTAF_NOFIRE_RADIUS = 500;             // 单位周边禁射区半径 (px)

  const GUSTAF_CLICK_RADIUS = 240;              // 点击互动区半径 = 原 120 的 2 倍

  // 互动区不得超出自身碰撞体：记录的 member_collision_radius（200）不够时把碰撞区扩到互动区大小。
  // 碰撞区作为静态圆参与我方队员的每帧隔离，队员永远进不了互动区，
  // 不会出现「想点小队队员却点中了 Gustaf」的不可控选中
  const GUSTAF_BODY_RADIUS = Math.max(
    GUSTAF_RECORD.member_collision_radius || 0,
    GUSTAF_CLICK_RADIUS
  );

  const GUSTAF_SHELL_BUTTON_OFFSET = 150;       // 「炮弹」按钮与单位锚点的纵向偏移（单位正下方）

  const GUSTAF_SHELL_BUTTON_SIZE = SELL_BUTTON_RADIUS * 4;   // 炮弹按钮直径 = 出售按钮的 2 倍 (68px)

  const GUSTAF_TRIANGLE_SIZE = 60;              // 头顶指示倒三角边长

  const GUSTAF_TRIANGLE_GAP = 50;               // 倒三角与单位锚点的间距（上方 50px）


  // 血条耗尽后的连锁反应：整身以柔和速度染成 25% 红 ->
  //   我方：立刻进入移动动画，脱离队伍冲向「移动逻辑范围内」最近的敌人（488 像素/秒，
  //         路线不穿越红色屏蔽区）-> 贴上目标（75 像素圆）立即自爆，
  //         死亡延迟满 5 秒同样立即自爆；碰撞自爆与延迟自爆统一 40 像素圆，
  //         伤害随距离递减（爆心 10 像素内 20 点，每向外扩 10 像素伤害降低 20%）
  //   敌方：原地不动，继续待在自己倒下的位置 -> 满 3 秒原地自爆，5 点范围伤害（20 像素圆）
  const DEATH_TINT_DURATION = ACTIVE_PLAYER_RECORD.death_tint_duration;   // 900

  const DEATH_TINT_STRENGTH = ACTIVE_PLAYER_RECORD.death_tint_strength;   // 0.25

  // 死亡冲锋速度与触发距离都在 updatePlayerMemberCharge 里按各兵种记录实时读取
  // （TankM1 触发距离 90 = 自爆半径、JF 为 37.5），此常量只作读取失败时的缺省兜底
  const DEATH_CHARGE_TRIGGER_DISTANCE = ACTIVE_PLAYER_RECORD.charge_trigger_distance;   // 37.5

  const DEATH_CHARGE_RETARGET_INTERVAL = playerNumber('charge_retarget_interval', { integer: true, min: 0 });  // 索敌失败或目标阵亡后的重新索敌间隔 (ms)

  // 死亡冲锋动画的循环重播周期：登记了死亡冲锋动画的兵种（Ares 的 skill3）全程反复
  // 播放「前 1 秒」的起手动作——skill3 全长超过冲锋最长的 5 秒，一次性播放会停在尾帧。
  // 按时间戳每满该周期才重发一次 setAnimation，不做逐帧轮询，重播开销每队员每秒一次
  const DEATH_CHARGE_ANIM_LOOP_MS = 1000;

  const PLAYER_DETONATE_DELAY = ACTIVE_PLAYER_RECORD.detonate_delay;    // 我方：血条耗尽到自爆 5 秒

  const ENEMY_DETONATE_DELAY = ACTIVE_ENEMY_RECORD.detonate_delay;      // 敌方：血条耗尽到自爆 3 秒

  const ENEMY_EXPLOSION_DAMAGE = ACTIVE_ENEMY_RECORD.detonate_damage;   // 5

  // 自爆范围：一律是以该单位为中心的圆圈面积，不做多余标记
  const PLAYER_EXPLOSION_RADIUS = ACTIVE_PLAYER_RECORD.detonate_radius;        // 我方：自爆半径（碰撞自爆与死亡延迟到点自爆统一 40 像素圆）

  const ENEMY_EXPLOSION_RADIUS = ACTIVE_ENEMY_RECORD.detonate_radius;          // 敌方：阵亡自爆的半径

  // 我方自爆的伤害递减：爆心 10 像素内 20 点，每向外扩 10 像素伤害降低 20%
  //（10~20px 16 点 / 20~30px 12.8 点 / 30~40px 10.24 点）
  const PLAYER_EXPLOSION_CENTER_DAMAGE = ACTIVE_PLAYER_RECORD.detonate_damage;            // 20

  const PLAYER_EXPLOSION_DAMAGE_FALLOFF = ACTIVE_PLAYER_RECORD.detonate_damage_falloff;   // 0.2

  const PLAYER_EXPLOSION_FALLOFF_STEP = ACTIVE_PLAYER_RECORD.detonate_falloff_step;       // 10

  const PLAYER_EXPLOSION_TEXT_COLOR = '#ff2222';   // 自爆伤害数字：鲜红色

  // 自爆时的浮动文本：我方固定一句，敌方从三条里随机挑一条
  const PLAYER_DETONATE_TEXT = '更新世界的锋芒';

  const ENEMY_DETONATE_TEXTS = ['Boom！', 'Crush！', 'Bang!'];

  const ENEMY_DETONATE_TEXT_COLOR = '#ffb347';

  // 自爆屏幕震动：只有镜头贴近屏幕（缩放达到 EXPLOSION_SHAKE_MIN_ZOOM 以上）时才出现，
  // 镜头离得远时视野大，抖动反而看不出来。
  // 抖动方式是相机沿视线方向「垂直向内 / 垂直向外」推拉（缩放往复），
  // 不做横向平移，所以地图内容不会位移、也不会露出地图外，
  // 浮动文字等按屏幕像素固定的显示仍会在同一帧内反向补偿，尺寸不受影响
  const EXPLOSION_SHAKE_MIN_ZOOM = 1.8;        // 触发震动所需的最小相机缩放

  const EXPLOSION_SHAKE_DURATION = 420;        // 一次震动的总时长 (ms)

  const EXPLOSION_SHAKE_AMPLITUDE = 0.0075;    // 推拉幅度（相对当前缩放的比值），强度适中偏弱

  const EXPLOSION_SHAKE_CYCLES = 3;            // 往复次数（向内 / 向外各算半次）

  // 被自爆命中的敌方单位：沿爆心连线被推开 10 像素，全程 0.5 秒（约 20 像素/秒）
  const ENEMY_KNOCKBACK_DISTANCE = enemyNumber('knockback_distance', { min: 0 });

  const ENEMY_KNOCKBACK_DURATION = enemyNumber('knockback_duration', { integer: true, min: 0 });

  const EXPLOSION_TEXTURE_KEY = 'unitExplosionTexture';

  // 坦克炮弹命中爆炸专用贴图：亮区铺满整块爆炸圈（见 createExplosionTexture 的 filled 档位）
  const ATTACK_BLAST_TEXTURE_KEY = 'unitAttackBlastTexture';

  // 攻击炮弹表现：出膛时机、飞行速度、炮口骨骼、弹丸尺寸全部按兵种记录读取
  //（unit_database.sql 的 attack_projectile_launch_ratio / _speed / _bone / _size / _muzzle_* 列，
  //  TankM1 = 动画播到 10% 出膛、速度 1200 像素/秒、出膛点取骨架 muzzle 骨骼）；
  // 命中点按兵种的 attack_blast_radius 结算范围伤害。
  // 下面这组常量只是「记录未填时」的代码兜底默认值，正常配置的单位不会用到
  const ATTACK_SHELL_TEXTURE_KEY = 'attackShellTexture';

  const ATTACK_PROJECTILE_DEFAULT_SPEED = 1200;          // 弹丸飞行速度（像素/秒）

  const ATTACK_PROJECTILE_DEFAULT_LAUNCH_RATIO = 0.5;    // 出膛时刻占攻击动画时长的比例

  const ATTACK_PROJECTILE_DEFAULT_MUZZLE_FORWARD = 70;   // 无炮口骨骼时沿射向自单位锚点前移（像素）

  const ATTACK_PROJECTILE_DEFAULT_MUZZLE_HEIGHT = 60;    // 无炮口骨骼时自单位锚点上移（像素）

  const ATTACK_SHELL_DEPTH = 5.5;                        // 炮弹渲染层级（单位之上、爆炸特效之下）


  // 游戏对象容器组
S.enemiesGroup = undefined;

S.enemyBars = undefined;

S.targetMarkers = [];

S.focusTarget = null;

// WG2 大桥（仅 wg2/bridge.js 读写；WG 恒为 false/null）：集火开关与桥梁存亡
S.bridgeFocused = false;

S.bridgeDestroyed = false;

S.focusMarkGraphics = undefined;

S.selectionCircle = undefined;

S.attackRangeGraphics = undefined;

S.playerSquadBars = undefined;

  let collisionGraphics;       // 离屏绘制用（不加入显示列表）

  let routeGraphics;           // 离屏绘制用（不加入显示列表）

  let mapOverlayLayer;         // 烘焙后的静态贴图：蓝色外框、绿区、红区、隔离线与三条进军路线


  // 出生点信标 / 出生界面 运行时对象
S.spawnBadge = undefined;

S.spawnBadgePad = undefined;

S.spawnGlow = undefined;

S.spawnFlashGraphics = undefined;

S.spawnFlashAnimation = null;

  // 左上角出生界面（屏幕像素固定大小：位置与缩放每帧按相机反向补偿）
S.spawnHudRoot = null;

S.settingsGear = null;

S.musicNote = null;

S.tomatoHud = null;

S.tomatoHudText = null;

S.matchTimerText = null;

S.matchTimerLastSecond = -1;

S.tomatoCount = TOMATO_START_COUNT;

S.matchElapsedMs = 0;

S.gameEnded = false;

  // Spine 视野剔除用：原型 update 引用（恢复用）与视野外冻结占位
S.spineUpdateOriginal = null;

  const offscreenNoopUpdate = function () {};

S.spawnHudButtons = [];

S.spawnHudExpanded = false;

  // 当前展开到第二层的分类（null = 只看第一层）：GRF -> GRF1（步兵）-> JF 逐层点开才出兵
S.spawnHudCategory = null;

S.playerPoints = 0;

S.gameScene = null;

  // 出售表现：黄线圆环 + 淡黄色渲染带（每帧重绘），以及跟随各支选中小队的六边形「$」按钮池
S.sellRingGraphics = undefined;

S.sellButtons = [];

  // 训练中的单位（单位级冷却，而不是整个兵种按钮）：每阵亡一支小队就压入一条记录，
  // 到期后自动移除并把名额还回队列
  let trainingSquads = [];

  // 双击检测：同一支小队在 DOUBLE_CLICK_MS 内被点两次即呼出 / 收起出售圆环
S.lastClickSquad = null;

S.lastClickAt = -Infinity;

  // 输入拦截标记（游戏对象事件先于场景级 pointer 事件触发，先到者设标记、场景层消费）：
  // spawnPreviewClickLatch — 右键出兵按钮展开预览格时吃掉这次右键，不再下发射击/移动指令；
  // squadTagClickLatch — 点击兵牌选中小队时吃掉同一次左键抬起的「空地取消选中」
S.spawnPreviewClickLatch = false;

S.squadTagClickLatch = false;

  // GustafAssist2 运行时状态（create 时重建，场景重启自动复位）
S.gustafCharacter = null;

S.gustafIndicator = null;

S.gustafShellButton = null;

S.gustafAimGraphics = null;

S.gustafSelected = false;

S.gustafAiming = false;

S.gustafNextFireAt = 0;

S.gustafShellClickLatch = false;

S.gustafShells = [];

  let gustafAimPointer = { x: 0, y: 0 };// 瞄准时指针的世界坐标


  // 复用的端点对象：原先每次调用都为每条隔离线新建两个点对象并走一次 Array.some 闭包，
  // 满编时这里是每帧数百次的临时分配（GC 压力的一处来源），改成复用探针 + 普通循环
  const collisionCrossProbeStart = { x: 0, y: 0 };

  const collisionCrossProbeEnd = { x: 0, y: 0 };


  // 复用的端点对象，避免每次穿越判定都为全部红区边新建临时点
  const redCrossProbeStart = { x: 0, y: 0 };

  const redCrossProbeEnd = { x: 0, y: 0 };


  // 屏蔽环描述符：红区（禁区在多边形内部，轮廓外扩）与绿边界（禁区在多边形外侧，轮廓内推）
  // 在几何算法上完全同构，差别只有「偏移符号」与「用哪一套净空判定 / 推离修正」。
  // 收进描述符之后，轮廓生成、A* 候选节点、贴边滑动都只认描述符，不再关心是红还是绿。
  // 绿环的节点用「盾」判定过滤（红 ∧ 绿）：落在红区里的那段绿轮廓会被整段剔除，
  // 缺口由 A* 自行当作墙处理（该段本来就被红环覆盖，见文件末尾的已知局限说明）
  const RED_SHIELD_RING = {
    offsetSign: 1,
    pointSafe: isRedClearanceSafePoint,
    segmentSafe: isRedClearanceSafeSegment,
    correct: correctPointOutOfRedClearance
  };

  const GREEN_SHIELD_RING = {
    offsetSign: -1,
    pointSafe: isShieldClearanceSafePoint,
    segmentSafe: isShieldClearanceSafeSegment,
    correct: correctPointIntoGreenClearance
  };


  // 贴边滑动用的环列表：红环在前、绿环在后（红环顺序不能变，既有行为依赖它）。
  // 只有我方单位会带绿环；绿环带 gated 标记，用一趟「先探最近边、远则跳过」的前置门
  // 免掉对数百个绿轮廓采样点的最近点扫描——绿多边形占全图一半，内部点距边界可达数百像素。
  // 环列表只由碰撞区域版本决定，缓存复用，避免逐帧逐单位新建对象
S.shieldSlideRingsCache = { version: -1, red: null, shield: null };


  // 可交战目标：优先沿用已锁定的队员（只要仍存活且直线畅通），
  // 只有在锁定对象阵亡、被红色屏蔽区挡住、或尚未锁定时才重新挑选最近的可见队员。
  // 目标锁定是抖动的第二道防线：三名队员只相隔十几像素，若每帧都重新挑「最近」，
  // 目标点会在队员之间来回跳变十几像素，姿态也跟着在攻击与移动之间闪
  // 每帧一份的存活队员清单（scanOrdinal 按全体队员递增，含阵亡者，用于距离并列时的稳定次序）：
  // 队员位置在敌方主循环开始前就已定型，帧内不会再变，因此整帧只构建一次、全场敌人共享。
  // 帧中发生的阵亡（敌方半程伤害结算）不重建清单：队员仍留在清单里，由
  // isPlayerMemberVisibleTo 的存活检查过滤——与旧实现逐帧过滤的选人结论一致
S.memberScanListFrame = -1;
S.sightTestMemoVersion = -1;

  const memberScanList = [];

  const memberScanDistances = [];

  const memberScanOrder = [];

  // 敌方视线判定记忆化：键 = 双端量化坐标（1px）打包的数字，值 = 该线段在当前红区
  // 几何下是否畅通。静止对峙时敌我坐标逐帧不变，跨帧直接命中，免去每次全量
  // 红区多边形相交测试；同帧内重复判定（锁定检查 + 排序扫描 + 结算重选）同样命中。
  // 红区几何变化（appendRedForbiddenZone 等）时 collisionRegionVersion 递增，
  // isEnemySightClearCached 检测到版本变化即整体作废重建，结论永不串版本。
  // Map 容量上限 16384：行军中的敌人每帧产生新键，超限整体清空重建（成本微不足道）
  const sightTestMemo = new Map();


  // 追踪目标点：锁定「直线畅通且距离最近的一名存活队员」，追击与开火命中同一个人，
  // 不会出现「追着 A 却把子弹打向 B」的错位；
  // 全部队员都被红色屏蔽区挡住时返回 null，表示敌方已失去可交战目标
  // （P0 敌方追踪微优化：返回复用的共享点对象。两个调用方 getEnemyTrackGap /
  // updateEnemyTracking 都是即取即用、只读取 x/y，不会保留引用——全场 130 敌人
  // 每帧 2 次的临时对象分配原本是追踪路径上最主要的 GC 来源）
  const enemyTrackAimPoint = { x: 0, y: 0 };


  // 自爆屏幕震动：相机沿视线方向推拉（缩放往复），爆心越大抖得越明显。
  // 镜头没贴近屏幕（缩放低于阈值）时直接不抖，只记录本次震动的参数，逐帧推进交给 updateExplosionShake
S.explosionShake = null;


  // ---- 自爆冲锋规划调度器（算量优先级调度 · Tier-1 预算层）----
  // 三个自爆/追踪进程的算量优先级：
  //   P0 敌方追踪（每帧 × 全场敌人，战斗关键路径，不可延迟）——Tier-0 实时层，每帧必跑，不设预算；
  //   P1 我方自爆的「索敌 + 完整寻路」（单次最坏数十毫秒，多名队员同帧阵亡时突发叠加）——本调度器；
  //   P2 敌方自爆（每帧 O(1)，极廉价）——Tier-0 实时层，维持现状。
  // P1 不再在 updatePlayerMemberCharge 内同步执行，而是入队，由每帧预算调度：
  //   优先级 0 = 首发规划（刚进入自爆、还没有目标或目标已阵亡，要求尽快拿到目标），
  //   优先级 1 = 周期重规划（已有存活目标，仅按 300ms 间隔刷新「最近可达者」）；
  // 同级按入队先后 FIFO（sort 稳定）。本帧预算用尽后剩余请求顺延到下一帧。
  // 等待期间队员沿用现有目标与路径继续冲锋——与现状一致：目标阵亡后本来就要等
  // 到下一个重规划点才会换目标，顺延 1~3 帧（≤50ms）相对 300ms 节流与 5 秒引爆延迟
  // 没有可观测的表现差异；最坏情况下把「同帧连环卡顿」摊薄成「多帧各承担一小段」。
  const DEATH_CHARGE_PLAN_BUDGET_MS = 3;   // 每帧允许规划占用的 CPU 时间（16.6ms 帧内给 Tier-0 与渲染留足余量）

  const deathChargePlanQueue = [];

  const deathChargePlanStats = { lastFramePlans: 0, lastFrameDeferred: 0, queued: 0 };


  // 分离用的空间哈希：键为格子坐标，值为该格内单位在 movers 中的下标。帧内复用不新建。
  const enemySeparationGrid = new Map();


  // ----------------------------------------------------
  // 屏幕文字统一尺寸：画面里所有会出现的文字（伤害数字、自爆提示、出兵与寻路提示）
  // 都走 showCombatText，这里把它们的显示大小统一按「屏幕像素」固定下来。
  // 相机可在 CAMERA_ZOOM_MIN~CAMERA_ZOOM_MAX（约 0.51~3 倍）之间缩放，画布还会被 FIT 模式按视口再缩放一次，
  // 直接用世界字号的话，同一句伤害数字在不同窗口大小、不同缩放级别、不同设备
  // 上会忽大忽小；做法是用 1 / (相机缩放 × 画布显示比例) 反向补偿显示缩放，
  // 使文字在任何情况下都恒定占 COMBAT_TEXT_FONT_SIZE 个屏幕像素，
  // 同时把纹理分辨率设为设备像素比，让纹理像素与屏幕物理像素一一对应，
  // 这样即便在 4K / 高 DPI 屏上被放大也不会发虚。
  // ----------------------------------------------------
  const COMBAT_TEXT_FONT_SIZE = 14;        // 屏幕上的固定字号（像素）

  const COMBAT_TEXT_RISE = 26;             // 屏幕上固定的上浮距离（像素）

  const COMBAT_TEXT_DURATION = 700;        // 停留时长 (ms)

  const COMBAT_TEXT_MAX_RESOLUTION = 4;    // 纹理分辨率上限，设备像素比很高时避免浪费显存

  const COMBAT_TEXT_FONT_FAMILY = "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif";

  const combatTexts = [];                  // 存活中的浮动文字，每帧同步一次显示尺寸


  // 性能：同屏飘字上限。130 单位混战时伤害数字可能每秒新增上百个，
  // Text 的创建 / 销毁是 Canvas 级开销（含排版测量与渐变 tween），
  // 超限后直接丢弃新飘字（最早的一批正在淡出），用个别数字的缺失换稳定帧时间
  const COMBAT_TEXT_MAX_COUNT = 48;


  // Spine 骨架的 getBounds 返回「骨架局部坐标」（+y 向上，且已乘上骨架自身缩放），
  // 换算成屏幕像素还要再乘 |character.scaleY| / |skeleton.scaleY|。
  // 由此得到角色当前姿态的真实头顶/脚底，血条才能稳定贴头顶上方 8 像素且不会遮挡人物。
  // 骨架包围盒探针：复用同一对对象，省掉每次取包围盒都要新建的两个对象与两个 setter 闭包
  const skeletonBoundsOffset = { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; } };

  const skeletonBoundsSize = { w: 0, h: 0, set(w, h) { this.w = w; this.h = h; } };


  // ----------------------------------------------------
  // 重装单位（TankM1）的攻击炮弹：攻击动画开始后延迟出膛 -> 追踪目标飞行 -> 命中点范围爆炸。
  // 炮弹只记录「发射时刻的兵种记录、兵力倍率与目标引用」，不持有队员 / 小队引用：
  // 发射后小队被出售、阵亡或移动都不影响已出膛的炮弹，也不会产生空引用。
  // 命中点按兵种记录的 attack_blast_radius 结算范围伤害——爆心伤害 = 该兵种单发伤害，
  // 每向外扩 attack_blast_falloff_step 像素递减 attack_blast_falloff 比例（与自爆同一套算式）
  // ----------------------------------------------------
  const attackShells = [];   // 场上飞行中的攻击炮弹


  // 左上角出生界面：GRF 主按钮（显示可用点数与每分钟点数）。
  // 点击 GRF 展开第一层：左侧竖排 GRF1（步兵）/ tasa_air（重甲）/ mid（支援）；
  // 再点击某个分类展开第二层：右侧竖排对应兵种的子菜单（第一个与 GRF 平行，往下依次排列）：
  //   grf1      -> elmo1 / elmo2 / JF / GK
  //   tasa_air  -> coffee / SF / 404
  //   rs        -> TankM1 / Ares / Warjack
  // 展开 / 收起时下级按钮都以父按钮（GRF 或分类按钮）为动画主体：从父按钮位置滑出、淡入，
  // 收起时原路滑回父按钮再淡出，同层按钮按行号错开出场。
  // 未实现的兵种（elmo1/elmo2/GK）半透明并提示尚未开放；新兵种子菜单同样半透明，
  // 但按 JF 的格式显示右上角费用、右下角已出场/上限
  // ── 单位预览格（出兵按钮悬停显示）──────────────────────────────────────────────
  // 出兵按钮右侧的固定显示格：上半按队形摆出该单位的全部队员（待机 'wait' 动画，
  // 不跑移动/索敌逻辑，性能开销只有几个 Spine 骨架），下半显示六项基础数值的
  // 低 / 中 / 高评级。评级阈值在首次悬停时按全部可出兵记录的三分位距计算一次。
  const PLAYER_SPAWN_KEYS = ['jf', 'elmo1', 'elmo2', 'GK', 'coffee', 'SF', '404', 'TankM1', 'Ares', 'Warjack'];

  const PLAYER_STAT_COLUMNS = [
    ['伤害', 'action_value'],
    ['射程', 'action_range'],
    ['移速', 'move_speed'],
    ['护甲', 'armor'],
    ['破甲', 'armor_penetration'],
    ['生命', 'max_hp']
  ];

  const PLAYER_STAT_RATING_LABELS = ['低', '中', '高'];

  const PLAYER_STAT_RATING_COLORS = ['#7ec9ff', '#ffd479', '#ff8f7b'];

S.playerStatRatings = null;

  // ── 出兵预览格的显示特例 ──
  // 预览镜像：Agent / Ares 的预览骨架水平镜像（scaleX 取负），朝向与战场观感一致
  const SPAWN_PREVIEW_MIRROR_KEYS = { SF: true, Ares: true };

  // 重装单位（TankM1 / Ares / Warjack，按碰撞半径 ≥ 50 判定，与战场重装口径一致）
  // 骨架内容偏上（脚底贴近原点），预览格中整体下移该像素量，避免头顶超出上半区显示框
  const SPAWN_PREVIEW_HEAVY_RADIUS = 50;

  const SPAWN_PREVIEW_HEAVY_DROP = 26;


  // ── 我方单位沙盒显示 ──
  // 选中我方小队时在屏幕右下角展开的长方形面板：左区展示该兵种的队形（待机动画），
  // 右区上半为实时血量、下半为与出兵预览格同一套口径的六维评级。
  // 面板是纯表现层：只读小队状态，不参与任何模拟判定；
  // 兵种未变化时只刷新血量文本，不重建骨架；取消选中即销毁骨架释放 Spine 实例
  const SANDBOX_PANEL_WIDTH = 316;

  const SANDBOX_PANEL_HEIGHT = 138;

  const SANDBOX_PANEL_MARGIN = 12;        // 距屏幕右下角的边距（屏幕像素）

  const SANDBOX_UNIT_ZONE_WIDTH = 126;    // 左区（单位展示）宽度

S.sandboxPanelApi = null;


  // 多小队同帧规划队列：框选 n 支小队会在同一帧里连续下发 n 条移动指令，
  // 每条都要跑一轮轮廓搜索，帧耗时随小队数线性增长，小队一多就明显掉帧。
  // 这里把「路径规划」这一步排进队列，在主循环里按每帧时间预算执行：
  // 队列对每支小队只保留最新一条指令（后下达的覆盖先前的），长度不会超过在场小队数。
  // 排队期间小队已经按直接转向前进（转向内部自带安全带脱离与沿红区滑动兜底），不会停在原地。
  const playerPathQueue = [];

S.playerPathBudgetFrame = -1;

S.playerPathBudgetUsed = 0;

S.playerPathPlannedInFrame = 0;


  // ── 兵牌（我方小队头顶的单位标识）──────────────────────────────────────────────
  // 每支出战小队在头顶上方 50 屏幕像素处挂一块兵牌（含整体上移的 25px）：贴该兵种出兵按钮的圆形图标。
  // 蓝底白框 = 当前被选中，灰底白框 = 未选中；点击兵牌即选中该小队（框选走原有
  // 整队判定，锚点就在兵牌正下方，天然覆盖）。尺寸按屏幕像素恒定（40~56px，
  // 且不超过队员实际渲染高度），随相机缩放反向换算，缩放只改 container.scale。
  const SQUAD_TAG_ICON_TEXTURES = {
    jf: 'jfHudIcon', elmo1: 'elmo1HudIcon', elmo2: 'elmo2HudIcon', GK: 'gkHudIcon',
    coffee: 'coffeeHudIcon', SF: 'sfHudIcon', '404': 'hud404Icon',
    TankM1: 'tankHudIcon', Ares: 'aresHudIcon', Warjack: 'warjackHudIcon'
  };

  const SQUAD_TAG_BASE_SIZE = 40;    // 兵牌内部绘制尺寸（缩放前的像素）

  const SQUAD_TAG_MAX_SCREEN = 56;   // 兵牌屏幕尺寸上限

  const SQUAD_TAG_HEAD_GAP = 50;     // 队员头顶到兵牌的屏幕间距（原 25，按需求整体上移 25px 后为 50）


  // ----------------------------------------------------
  // 三大核心逻辑分段帧耗时监控（仅调试用，经 window.__WG__.frameStats 读取）：
  //   playerNavMs   —— 我方寻路 / 队形与归队 / 自爆规划调度段（updatePlayerSquad + 冲锋推进）
  //   enemyCombatMs —— 敌军追击 / 攻击 / 行军主循环 + 碰撞隔离段
  //   updateMs      —— 整帧 update 耗时
  // 采样只做 performance.now 差值与累加，不参与任何判定分支，主逻辑零改动。
  // 按 1 秒窗口汇出「上一帧耗时 / 窗口均值 / 窗口峰值 / 帧数与 FPS」：
  // 144fps 预算约 6.9ms/帧，两段均值持续逼近或超过 8~10ms 时结合具体段位排查热点；
  // 60fps 设备预算 16.6ms，同一套数据按设备刷新率解读即可。
  // ----------------------------------------------------
  const MODULE_PERF_WINDOW_MS = 1000;

  const modulePerf = {
    windowStartedAt: 0,
    frames: 0,
    last: { playerNavMs: 0, enemyCombatMs: 0, updateMs: 0, sub: null },
    acc: { playerNavMs: 0, enemyCombatMs: 0, updateMs: 0 },
    avg: { playerNavMs: 0, enemyCombatMs: 0, updateMs: 0, fps: 0, sub: null },
    max: { playerNavMs: 0, enemyCombatMs: 0, updateMs: 0, sub: null },
    // 细分耗时累加器（帧内累计，帧末由 recordModulePerfWindow 归档并清零）：
    // memberPlanMs  队员归队全量寻路   dcMs       死亡冲锋规划队列
    // formationMs   阵型摆放/跨队挤压  regroupMs  归队整队推进
    // freeMoveMs    红区边自由移动     sepMs      敌方碰撞隔离
    // targetingMs   敌方选目标         steerMs    敌方转向
    // replanMs      敌方路径重规划
    sub: {
      memberPlanMs: 0, memberPlans: 0, dcMs: 0, dcPlans: 0,
      formationMs: 0, regroupMs: 0, freeMoveMs: 0,
      sepMs: 0, targetingMs: 0, steerMs: 0, replanMs: 0
    }
  };


  // ----------------------------------------------------
  // 浏览器测试钩子（仅调试用）：暴露场景、小队状态与最小寻路测试接口，
  // 供集成浏览器通过 window.__WG__ 出兵、下达移动指令并读取抵达结果。
  // ----------------------------------------------------
  window.__WG__ = {
    get scene() { return S.gameScene; },
    get squads() { return playerSquads; },
    // 只读的几何断言：落点是否可行走 / 是否满足 19 像素红区净空
    walkable: (x, y) => isWalkable(x, y),
    safe: (x, y) => isRedClearanceSafePoint(x, y, PLAYER_RED_ZONE_CLEARANCE),
    // 只读：两块红区多边形（供离线几何断言与调试绘制）
    redZones: () => collisionRegions.redForbiddenZones.map(zone => zone.map(point => ({ x: point.x, y: point.y }))),
    // 只读：寻路性能度量快照
    pathStats: () => Object.assign({}, redPathStats),
    resetPathStats: () => { resetRedPathStats(); return true; },
    // 只读：帧率与渲染统计（game 实例挂在场景上：gameScene.game）
    perf: () => {
      const loop = S.gameScene && S.gameScene.game ? S.gameScene.game.loop : null;
      return {
        fps: loop ? loop.actualFps : 0,
        delta: loop ? loop.delta : 0
      };
    },
    // 只读：三大核心逻辑分段帧耗时（上一帧 / 1 秒窗口均值 / 1 秒窗口峰值 / 窗口内帧数）。
    // playerNavMs = 我方寻路 / 队形段；enemyCombatMs = 敌军追击攻击段；updateMs = 整帧
    frameStats: () => ({
      last: Object.assign({}, modulePerf.last),
      avg: Object.assign({}, modulePerf.avg),
      max: Object.assign({}, modulePerf.max),
      frames: modulePerf.frames
    }),
    // 只读：我方死亡冲锋规划调度器状态（本帧已规划数 / 被预算顺延数 / 队列积压）。
    // queued 持续 > 0 说明 3ms 帧预算下 A* 请求积压，配合 frameStats().avg.playerNavMs 判断
    deathCharge: () => Object.assign({}, deathChargePlanStats),
    // 测试用：清空场上敌军。出生点位于敌军活动区内，多场景验证需要可控环境
    clearEnemies: () => {
      if (!S.enemiesGroup) return 0;
      const list = S.enemiesGroup.getChildren().slice();
      list.forEach(enemy => enemy.destroy());
      return list.length;
    },
    // 测试用：把指定兵种（不传则场上所有已出场小队）的存活队员打到 0 血，触发阵亡冲锋自爆。
    // 走的是真实受击路径 damagePlayerMember，与在战场上被打死完全同一条流程
    woundSquad: (unitKey) => {
      let count = 0;
      playerSquads.slice().forEach(squad => {
        if (!squad.unit || !squad.unit.isSpawned) return;
        if (unitKey && squad.unitKey !== unitKey) return;
        squad.members.slice().forEach(member => {
          if (!member.alive) return;
          damagePlayerMember(S.gameScene, member, member.hp + 1);
          count += 1;
        });
      });
      return count;
    },
    // 通过左上角出兵按钮的同一代码路径出 1 支小队
    spawn: () => handleSpawnOption('jf'),
    // 测试用：按出兵按钮的同一代码路径出指定兵种（'TankM1' 等）
    spawnUnit: (key) => handleSpawnOption(key),
    // 测试用：在 (x, y) 起向右按 30 像素间隔放 count 个敌军（沿用波次出兵的同一生成路径，
    // 落位后转入长时间原地待机），供溅射范围 / 伤害递减这类需要可控敌群的验证
    spawnTestEnemies: (x, y, count) => {
      const total = Math.max(1, count || 1);
      let placed = 0;
      for (let index = 0; index < total; index++) {
        // 生成函数没有返回值（波次出兵也不需要它），因此从敌军组末尾取刚新增的那一个
        const before = S.enemiesGroup.getChildren().length;
        spawnEnemyRouteUnit(S.gameScene, enemyRoutes[0]);
        const list = S.enemiesGroup.getChildren();
        if (list.length <= before) break;   // 达到兵力上限等情况下没有真的生成
        const enemy = list[list.length - 1];
        // 先停住入场阶段的行军速度，再把单位落到指定位置
        enemy.body.stop();
        enemy.x = x + index * 30;
        enemy.y = y;
        enemy.character.setPosition(enemy.x, enemy.y);
        enemy.routeState = 'holding';
        enemy.holdUntil = S.gameScene.time.now + 600000;
        enemy.actionPointX = enemy.x;
        enemy.actionPointY = enemy.y;
        enemy.stuckX = enemy.x;
        enemy.stuckY = enemy.y;
        setEnemyAnimation(enemy, 'wait', true);
        placed += 1;
      }
      return placed;
    },
    // 性能压测：把场上敌军补到 target 个（默认 130），按三条路线混编随机挑兵种，
    // 落点散布在路线起点的 ±260/±180 范围内避免全部叠在同一点；供集成浏览器性能测试
    stressTo: (target) => {
      const goal = target || 130;
      let added = 0;
      let guard = 0;
      while (guard < 500) {
        const alive = S.enemiesGroup.getChildren().filter(enemy => enemy.active).length;
        if (alive >= goal) break;
        const route = enemyRoutes[guard % enemyRoutes.length];
        const unitKey = route.unitKeys[Math.floor(Math.random() * route.unitKeys.length)];
        const before = S.enemiesGroup.getChildren().length;
        const enemy = spawnEnemyRouteUnit(S.gameScene, route, unitKey);
        if (!enemy || S.enemiesGroup.getChildren().length <= before) break;   // 触发兵力上限
        enemy.body.stop();
        enemy.x = Phaser.Math.Clamp(enemy.x + Phaser.Math.Between(-260, 260), 60, WORLD_WIDTH - 60);
        enemy.y = Phaser.Math.Clamp(enemy.y + Phaser.Math.Between(-180, 180), 60, WORLD_HEIGHT - 60);
        enemy.character.setPosition(enemy.x, enemy.y);
        added += 1;
        guard += 1;
      }
      return added;
    },
    // 只读：性能快照（帧率 / 实体数 / 飘字 / JS 堆），供集成浏览器采样
    perfSnapshot: () => {
      const loop = S.gameScene && S.gameScene.game ? S.gameScene.game.loop : null;
      const memory = window.performance && performance.memory
        ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null;
      return {
        fps: loop ? Math.round(loop.actualFps * 10) / 10 : 0,
        enemies: S.enemiesGroup.getChildren().filter(enemy => enemy.active).length,
        squads: playerSquads.length,
        texts: combatTexts.length,
        heapMB: memory
      };
    },
    // 只读：自爆冲锋规划调度器状态（上一帧执行的规划数 / 顺延数 / 当前排队数），
    // 供集成浏览器验证 Tier-1 帧预算调度是否按预期消化队列
    planQueue: () => ({
      queued: deathChargePlanStats.queued,
      lastFramePlans: deathChargePlanStats.lastFramePlans,
      lastFrameDeferred: deathChargePlanStats.lastFrameDeferred,
      budgetMs: DEATH_CHARGE_PLAN_BUDGET_MS
    }),
    // 只读：飞行中的攻击炮弹（位置 / 落点 / 是否已出膛 / 出膛时刻 / 该兵种的溅射半径与弹丸尺寸）
    shells: () => attackShells.map(shell => ({
      x: Math.round(shell.x),
      y: Math.round(shell.y),
      impact: [Math.round(shell.impactX), Math.round(shell.impactY)],
      launched: !!shell.sprite,
      launchAt: Math.round(shell.launchAt),
      now: S.gameScene ? Math.round(S.gameScene.time.now) : 0,
      radius: shell.record.attack_blast_radius || 0,
      size: shell.record.attack_projectile_size || 0
    })),
    // 只读：场上敌军的血量与位置（验证溅射伤害随爆心距离递减）
    enemies: () => (S.enemiesGroup ? S.enemiesGroup.getChildren() : []).map(enemy => ({
      x: Math.round(enemy.x),
      y: Math.round(enemy.y),
      hp: Math.round(enemy.hp * 10) / 10,
      maxHp: enemy.maxHp,
      charging: !!enemy.charging
    })),
    // 选中全部已出场小队
    selectAll: () => {
      getSpawnedPlayerSquads().forEach(squad => { squad.unit.isSelected = true; });
    },
    // 对全部已选中小队下达移动到 (x, y) 的指令（与右键落点分配完全同路径）
    moveSelectedTo: (x, y) => {
      const selected = getSpawnedPlayerSquads().filter(squad => squad.unit.isSelected);
      const goals = resolvePlayerSquadOrderGoals(x, y, selected.length);
      selected.forEach((squad, index) => {
        squad.__wgGoal = goals[index];
        issuePlayerMoveOrder(squad, S.gameScene, goals[index].x, goals[index].y);
      });
      return goals;
    },
    // 读取当前寻路状态：位置 / 目标 / 剩余节点 / 到目标距离 / 是否在移动
    report: () => playerSquads.filter(squad => squad.unit && squad.unit.isSpawned).map(squad => {
      const goal = squad.moveTarget || squad.__wgGoal || null;
      return {
        id: squad.id,
        sel: !!squad.unit.isSelected,
        x: Math.round(squad.unit.x),
        y: Math.round(squad.unit.y),
        target: squad.moveTarget ? [Math.round(squad.moveTarget.x), Math.round(squad.moveTarget.y)] : null,
        goal: goal ? [Math.round(goal.x), Math.round(goal.y)] : null,
        goalDist: goal
          ? Math.round(Math.hypot(goal.x - squad.unit.x, goal.y - squad.unit.y))
          : 0,
        nodes: squad.detourPath.length,
        moving: !!squad.unit.isMoving,
        members: squad.members.filter(m => m.alive && m.character).map(m => [
          Math.round(m.character.x), Math.round(m.character.y)
        ])
      };
    }),
    // 在世界坐标处模拟一次单击（走与真实点击完全相同的命中判定）
    clickAt: (x, y) => {
      const hit = handleWorldClick(x, y);
      return hit
        ? { enemy: !!hit.enemy, squad: hit.squad ? hit.squad.id : null, focused: !!hit.focused }
        : null;
    },
    // 读取当前点数、训练中单位数与最快完成的那一支的剩余训练时间（毫秒）
    economy: () => ({
      points: Math.floor(S.playerPoints),
      trainingCount: trainingSquads.length,
      nextReadyRemain: trainingSquads.length
        ? Math.max(0, Math.round(trainingSquads[0].readyAt - (S.gameScene ? S.gameScene.time.now : 0)))
        : 0
    }),
    // 读取可见的出售按钮及其页面坐标（用于验证点击出售）
    sellButtons: () => {
      const cam = S.gameScene.cameras.main;
      const canvas = S.gameScene.game.canvas;
      const cssScale = canvas.clientWidth / 1920;
      const rect = canvas.getBoundingClientRect();
      return S.sellButtons.filter(entry => entry.container.visible).map(entry => ({
        squadId: entry.squad ? entry.squad.id : null,
        cssX: Math.round((rect.x + ((entry.container.x - cam.scrollX - cam.width / 2) * cam.zoom + cam.width / 2) * cssScale) * 10) / 10,
        cssY: Math.round((rect.y + ((entry.container.y - cam.scrollY - cam.height / 2) * cam.zoom + cam.height / 2) * cssScale) * 10) / 10
      }));
    },
    // 读取左上角出兵按钮的状态与屏幕坐标（含可点击性），便于验证展开动画期间的点击隔离
    hudButtons: () => {
      const cam = S.gameScene.cameras.main;
      const canvas = S.gameScene.game.canvas;
      const cssScale = canvas.clientWidth / 1920;
      const rect = canvas.getBoundingClientRect();
      return S.spawnHudButtons.map(button => {
        const matrix = button.container.getWorldTransformMatrix();
        const worldX = matrix.tx;
        const worldY = matrix.ty;
        // 世界坐标 -> 游戏内部屏幕坐标（1920×1080 空间）-> 页面 CSS 坐标
        const screenX = (worldX - cam.scrollX - cam.width / 2) * cam.zoom + cam.width / 2;
        const screenY = (worldY - cam.scrollY - cam.height / 2) * cam.zoom + cam.height / 2;
        return {
          key: button.key,
          visible: button.container.visible,
          enabled: !!(button.hitArea && button.hitArea.input && button.hitArea.input.enabled),
          // 角标文字（右上角 / 右下角）：验证费用与名额上限显示
          top: button.topLabel ? button.topLabel.text : null,
          bottom: button.bottomLabel ? button.bottomLabel.text : null,
          cssX: Math.round((rect.x + screenX * cssScale) * 10) / 10,
          cssY: Math.round((rect.y + screenY * cssScale) * 10) / 10
        };
      });
    },
    // 读取目标点标记状态：显示数 / 位置 / 倒三角浮动偏移
    markers: () => S.targetMarkers.map(m => ({
      v: m.container.visible,
      x: Math.round(m.container.x),
      y: Math.round(m.container.y),
      triY: Math.round(m.triangle.y * 10) / 10
    })),
    // 读取集火目标与敌方单位状态
    focus: () => ({
      target: S.focusTarget
        ? { x: Math.round(S.focusTarget.x), y: Math.round(S.focusTarget.y), active: S.focusTarget.active }
        : null,
      enemies: S.enemiesGroup.getChildren().filter(e => e.active).map(e => ({
        x: Math.round(e.x), y: Math.round(e.y), hp: Math.round(e.hp)
      }))
    }),
    // ---- 绿色屏蔽区 / 盾判定（仅供验证） ----
    // 只读：点是否满足绿色屏蔽区净空（可行动区内侧且距边界 ≥ 绿净空）
    greenSafe: (x, y) => isGreenClearanceSafePoint(x, y, PLAYER_GREEN_ZONE_CLEARANCE),
    // 只读：点是否同时满足红区与绿色屏蔽区净空（我方单位的判定口径）
    shieldSafe: (x, y) => isShieldClearanceSafePoint(x, y, PLAYER_RED_ZONE_CLEARANCE),
    // 只读：点到可行动区轮廓折线的精确距离（无符号，正数也可能落在屏蔽区外侧）
    greenClearance: (x, y) => getZoneNearestEdge(collisionRegions.walkableBoundary, x, y).distance,
    // 只读：可行动区轮廓多边形（绿线）
    boundary: () => collisionRegions.walkableBoundary.map(point => ({ x: point.x, y: point.y })),
    // 只读：按我方单位口径规划一条路径（不驱动任何单位）
    planPath: (sx, sy, ex, ey) => {
      const path = getShortestPlayerPath({ x: sx, y: sy }, { x: ex, y: ey });
      return path ? path.map(point => ({ x: point.x, y: point.y })) : null;
    },
    // 只读：整条路径是否满足盾净空（严格口径）
    shieldPathSafe: (sx, sy, path) => !!path && path.length && isClearancePathSafe(
      { x: sx, y: sy }, path, PLAYER_RED_ZONE_CLEARANCE, true, isShieldClearanceSafeSegment
    ),
    // 只读：屏蔽环规模统计（轮廓采样点数 / A* 候选节点数 / 不安全弦数）。
    // 绿环的 unsafeChords 恒为 1，且必定是横跨 x≈3774.7、y∈[1057,1897] 的那条弦：
    // 那条带整段落在红区 2 内部，不存在任何安全站位，绿轮廓被过滤后留下一个缺口，
    // 缺口两端被补插流程连成一条「墙」（该段本就被红环覆盖）。A* 与贴边行走
    // 都会用线段净空判定否决它，因此它不会出现在任何返回的路径里
    ringStats: () => {
      const greenNodes = getRedZoneContourNodes(
        collisionRegions.walkableBoundary, PLAYER_GREEN_ZONE_CLEARANCE, GREEN_SHIELD_RING
      );
      let greenUnsafeChords = 0;
      for (let index = 0; index < greenNodes.length; index++) {
        const next = greenNodes[(index + 1) % greenNodes.length];
        if (greenNodes.length > 1 &&
          !isShieldClearanceSafeSegment(greenNodes[index], next, PLAYER_GREEN_ZONE_CLEARANCE)) {
          greenUnsafeChords += 1;
        }
      }
      return {
        red: collisionRegions.redForbiddenZones.map(zone => ({
          contour: getRedZoneContourEntry(zone, PLAYER_RED_ZONE_CLEARANCE).points.length,
          nodes: getRedZoneContourNodes(zone, PLAYER_RED_ZONE_CLEARANCE).length
        })),
        green: {
          contour: getRedZoneContourEntry(
            collisionRegions.walkableBoundary,
            PLAYER_GREEN_ZONE_CLEARANCE,
            GREEN_SHIELD_RING.offsetSign,
            GREEN_SHIELD_RING.pointSafe,
            GREEN_SHIELD_RING.correct
          ).points.length,
          nodes: greenNodes.length,
          unsafeChords: greenUnsafeChords,
          nodeLimit: PLAYER_RED_WALK_LEG_CANDIDATE_LIMIT
        }
      };
    },
    // 只读：敌方行军状态（验证「仅我方单位」的改动边界）
    enemyReport: () => S.enemiesGroup.getChildren().filter(e => e.active).map(e => ({
      x: Math.round(e.x),
      y: Math.round(e.y),
      hp: Math.round(e.hp),
      routeState: e.routeState || null,
      waypointIndex: Number.isFinite(e.waypointIndex) ? e.waypointIndex : null,
      nodes: e.detourPath ? e.detourPath.length : 0
    }))
  };


  // ---- 全局桥接导出 ------------------------------------------------------
  // 主脚本原为页面内联顶层代码，随后的设置界面/性能面板脚本以 typeof 守卫读取下列
  // 顶层词法绑定；包装进 IIFE 后它们不再是全局，这里用只读 getter 桥接（外部只读不写）。
  // 必须保持在 IIFE 末尾定义：此时所有绑定已初始化，读取不会触发 TDZ。
  Object.defineProperty(window, 'ENEMY_MAX_COUNT', { configurable: true, get: function () { return ENEMY_MAX_COUNT; } });

  Object.defineProperty(window, 'playerSquads', { configurable: true, get: function () { return playerSquads; } });

  Object.defineProperty(window, 'enemiesGroup', { configurable: true, get: function () { return S.enemiesGroup; } });

  Object.defineProperty(window, 'gameScene', { configurable: true, get: function () { return S.gameScene; } });

  Object.defineProperty(window, 'combatTexts', { configurable: true, get: function () { return combatTexts; } });

export { ACTIVE_ENEMY_RECORD, ACTIVE_PLAYER_RECORD, ARMOR_PENETRATION_STEP, ATTACK_BLAST_TEXTURE_KEY, ATTACK_PROJECTILE_DEFAULT_LAUNCH_RATIO, ATTACK_PROJECTILE_DEFAULT_MUZZLE_FORWARD, ATTACK_PROJECTILE_DEFAULT_MUZZLE_HEIGHT, ATTACK_PROJECTILE_DEFAULT_SPEED, ATTACK_SHELL_DEPTH, ATTACK_SHELL_TEXTURE_KEY, CAMERA_ZOOM_DEFAULT, CAMERA_ZOOM_MAX, CAMERA_ZOOM_MIN, COMBAT_TEXT_DURATION, COMBAT_TEXT_FONT_FAMILY, COMBAT_TEXT_FONT_SIZE, COMBAT_TEXT_MAX_COUNT, COMBAT_TEXT_MAX_RESOLUTION, COMBAT_TEXT_RISE, DEATH_CHARGE_ANIM_LOOP_MS, DEATH_CHARGE_PLAN_BUDGET_MS, DEATH_CHARGE_RETARGET_INTERVAL, DEATH_CHARGE_TRIGGER_DISTANCE, DEATH_TINT_DURATION, DEATH_TINT_STRENGTH, DOUBLE_CLICK_MS, ENEMY_ATTACK_CONTACT_TOLERANCE, ENEMY_ATTACK_INTERVAL, ENEMY_ATTACK_LOOP, ENEMY_ATTACK_RANGE, ENEMY_ATTACK_RELEASE_MARGIN, ENEMY_BAR_COLOR, ENEMY_BAR_WIDTH, ENEMY_CHARACTER_SCALE, ENEMY_CHARGE_TIMEOUT, ENEMY_CLICK_RADIUS, ENEMY_COLLISION_RADIUS, ENEMY_DETONATE_DELAY, ENEMY_DETONATE_TEXTS, ENEMY_DETONATE_TEXT_COLOR, ENEMY_ENDPOINT_IDLE_MAX, ENEMY_ENDPOINT_IDLE_MIN, ENEMY_ENDPOINT_RETURN_DISTANCE, ENEMY_ENDPOINT_ROAM_RADIUS, ENEMY_EXPLOSION_DAMAGE, ENEMY_EXPLOSION_RADIUS, ENEMY_HOLD_DURATION, ENEMY_KNOCKBACK_DISTANCE, ENEMY_KNOCKBACK_DURATION, ENEMY_MAX_COUNT, ENEMY_MAX_HP, ENEMY_PATROL_MIN_RADIUS, ENEMY_PATROL_RADIUS, ENEMY_PATROL_SLACK, ENEMY_RED_ZONE_CLEARANCE, ENEMY_REPLANS_PER_FRAME, ENEMY_REPLAN_COOLDOWN, ENEMY_ROUTE_CORRIDOR, ENEMY_ROUTE_ENTRY_COUNT, ENEMY_ROUTE_VARIANT_COUNT, ENEMY_SEPARATION_CELL, ENEMY_SEPARATION_DISTANCE, ENEMY_SEPARATION_MAX_PUSH, ENEMY_SEPARATION_STRENGTH, ENEMY_SPAWN_OFFMAP_PADDING, ENEMY_SPEED, ENEMY_STUCK_DISTANCE, ENEMY_STUCK_TIME, ENEMY_TRACK_RANGE, ENEMY_TRACK_RELEASE_MARGIN, ENEMY_TRACK_SPEED, ENEMY_TRACK_STOP_DISTANCE, ENEMY_UNIT_RECORDS, EXPLOSION_SHAKE_AMPLITUDE, EXPLOSION_SHAKE_CYCLES, EXPLOSION_SHAKE_DURATION, EXPLOSION_SHAKE_MIN_ZOOM, EXPLOSION_TEXTURE_KEY, FOCUS_BRACKET_ARM, FOCUS_BRACKET_CENTER_OFFSET_Y, FOCUS_BRACKET_OFFSET, FOCUS_BRACKET_RADIUS, FOCUS_BRACKET_SIZE, FOCUS_BRACKET_SPEED, GREEN_SHIELD_RING, GUSTAF_BODY_RADIUS, GUSTAF_CLICK_RADIUS, GUSTAF_EXPLOSION_ELEVATION, GUSTAF_NOFIRE_RADIUS, GUSTAF_RECORD, GUSTAF_SHELL_BUTTON_OFFSET, GUSTAF_SHELL_BUTTON_SIZE, GUSTAF_SHELL_COST, GUSTAF_SHELL_COUNT, GUSTAF_TRIANGLE_GAP, GUSTAF_TRIANGLE_SIZE, GUSTAF_X, GUSTAF_Y, HEALTH_BAR_BG, HEALTH_BAR_GAP, HEALTH_BAR_HEIGHT, HEALTH_BAR_RADIUS, IS_WG2, MAP_DATA, MATCH_DURATION_MS, WG2_PLAYER_BASE_SCALE_OVERRIDES, WG2_PLAYER_SCALE_DELTA, MODULE_PERF_WINDOW_MS, PLAYER_ANIMATION_LOCK_GRACE, PLAYER_ANIMATION_MIX_ATTACK, PLAYER_ANIMATION_MIX_LOOP, PLAYER_ATTACK_ANIMATION_FALLBACK, PLAYER_BAR_COLOR, PLAYER_BAR_WIDTH, PLAYER_CHARACTER_SCALE, PLAYER_CROSS_SQUAD_LERP, PLAYER_CROSS_SQUAD_MAX_SHIFT, PLAYER_CROSS_SQUAD_SEPARATION, PLAYER_DETONATE_DELAY, PLAYER_DETONATE_TEXT, PLAYER_EXPLOSION_CENTER_DAMAGE, PLAYER_EXPLOSION_DAMAGE_FALLOFF, PLAYER_EXPLOSION_FALLOFF_STEP, PLAYER_EXPLOSION_RADIUS, PLAYER_EXPLOSION_TEXT_COLOR, PLAYER_GREEN_ZONE_CLEARANCE, PLAYER_MEMBER_ANIM_IDLE_DELAY, PLAYER_MEMBER_ANIM_MAX_STEP, PLAYER_MEMBER_ANIM_MOVE_EPSILON, PLAYER_MEMBER_BACK_PART_DEPTH, PLAYER_MEMBER_COLLISION_RADIUS, PLAYER_MEMBER_RETURN_DISTANCE, PLAYER_MEMBER_RETURN_EXIT_CLEARANCE, PLAYER_MEMBER_RETURN_EXIT_RATIO, PLAYER_MEMBER_RETURN_PLANS_PER_FRAME, PLAYER_MEMBER_RETURN_REPLAN_COOLDOWN, PLAYER_MEMBER_RETURN_REPLAN_DISTANCE, PLAYER_MEMBER_RETURN_SPEED, PLAYER_MEMBER_RETURN_WAYPOINT_RADIUS, PLAYER_MEMBER_SEPARATION_MAX_PUSH, PLAYER_MEMBER_VISUAL_RADIUS, PLAYER_MOVE_PROGRESS_EPSILON, PLAYER_MOVE_STALL_RETRIES, PLAYER_MOVE_STALL_TIMEOUT, PLAYER_PATH_FRAME_BUDGET, PLAYER_POINTS_PER_MINUTE, PLAYER_RANGE_MARKER_COLOR, PLAYER_RANGE_MARKER_LENGTH, PLAYER_RANGE_MARKER_MAX_COUNT, PLAYER_RANGE_MARKER_MIN_COUNT, PLAYER_RANGE_MARKER_OUTLINE_COLOR, PLAYER_RANGE_MARKER_OUTLINE_EXTRA, PLAYER_RANGE_MARKER_SLOT, PLAYER_RANGE_MARKER_WIDTH, PLAYER_RED_ARC_STEP, PLAYER_RED_ARRIVE_DISTANCE, PLAYER_RED_CONTOUR_REPAIR_DEPTH, PLAYER_RED_CONTOUR_STEP, PLAYER_RED_CORRECTION_ITERATIONS, PLAYER_RED_REPLAN_COOLDOWN, PLAYER_RED_ROUTE_RANGE, PLAYER_RED_SLIDE_HYSTERESIS, PLAYER_RED_SLIDE_RANGE, PLAYER_RED_STEER_BIAS, PLAYER_RED_WALKABLE_SAMPLE_MAX, PLAYER_RED_WALKABLE_SAMPLE_STEP, PLAYER_RED_WALK_LEG_CANDIDATE_LIMIT, PLAYER_RED_ZONE_CLEARANCE, PLAYER_RING_HEIGHT, PLAYER_RING_OFFSET_Y, PLAYER_RING_WIDTH, PLAYER_SELL_REFUND_RATIO, PLAYER_SINGLE_CLICK_RADIUS, PLAYER_SPAWN_KEYS, PLAYER_SQUAD_BUILD_TIME, PLAYER_SQUAD_COLUMN_SLOT_ORDER, PLAYER_SQUAD_EDGE_EXIT_RANGE, PLAYER_SQUAD_EDGE_RANGE, PLAYER_SQUAD_FORMATION_LERP, PLAYER_SQUAD_FORMATION_SIDE, PLAYER_SQUAD_FREE_MAX_DISTANCE, PLAYER_SQUAD_FREE_OFFSETS, PLAYER_SQUAD_FREE_RETURN_RATIO, PLAYER_SQUAD_FREE_SPREAD, PLAYER_SQUAD_LIMIT, PLAYER_SQUAD_MORPH_DURATION, PLAYER_SQUAD_ORDER_SEARCH_DIRECTIONS, PLAYER_SQUAD_ORDER_SEARCH_RINGS, PLAYER_SQUAD_ORDER_SPREAD, PLAYER_SQUAD_REGROUP_ARRIVE, PLAYER_SQUAD_REGROUP_CATCHUP_DISTANCE, PLAYER_SQUAD_REGROUP_STALL_FRAMES, PLAYER_SQUAD_REGROUP_STALL_RATIO, PLAYER_SQUAD_ROW_FREE_OFFSETS, PLAYER_SQUAD_ROW_SLOT_OFFSETS, PLAYER_SQUAD_SEPARATION, PLAYER_SQUAD_SEPARATION_BUFFER, PLAYER_SQUAD_SEPARATION_PASSES, PLAYER_SQUAD_SEPARATION_TARGET, PLAYER_SQUAD_SLOT_OFFSETS, PLAYER_SQUAD_SLOT_ORDER, PLAYER_SQUAD_SLOT_SWAP_BLEND, PLAYER_SQUAD_TRIANGLE_RADIUS, PLAYER_START_POINTS, PLAYER_STAT_COLUMNS, PLAYER_STAT_RATING_COLORS, PLAYER_STAT_RATING_LABELS, PLAYER_UNIT_RECORDS, POINT_QUERY_AXIS_MAX, POINT_QUERY_AXIS_MIN, POINT_QUERY_RESULT_SHIFT, POINT_QUERY_SCALE, POINT_QUERY_WALKABLE, POINT_QUERY_WALKABLE_RESULT, RED_CLEARANCE_PATH_SLACK, RED_CLEARANCE_TOLERANCE, RED_CONTOUR_MARGIN, RED_SHIELD_RING, RED_SHIELD_SCAN_STEP, RED_ZONE_GRID_CELL, SANDBOX_PANEL_HEIGHT, SANDBOX_PANEL_MARGIN, SANDBOX_PANEL_WIDTH, SANDBOX_UNIT_ZONE_WIDTH, SELL_BUTTON_BORDER, SELL_BUTTON_FILL, SELL_BUTTON_GAP, SELL_BUTTON_HEIGHT_RATIO, SELL_BUTTON_RADIUS, SELL_BUTTON_TEXT_COLOR, SELL_BUTTON_TEXT_SIZE, SELL_GLOW_ALPHA, SELL_GLOW_BAND, SELL_GLOW_COLOR, SELL_RING_CLEARANCE, SELL_RING_COLOR, SELL_RING_OFFSET_Y, SELL_RING_WIDTH, SHADOW_ALPHA, SHADOW_DEPTH, SHADOW_FLATTEN, SHADOW_OFFSET_Y, SHADOW_TEXTURE_KEY, SHADOW_WIDTH_RATIO, SPAWN_ANIMATION_DURATION, SPAWN_ANIMATION_MIN_SCALE, SPAWN_BADGE_ICON_SCALE, SPAWN_BADGE_PAD_SCALE, SPAWN_BADGE_RADIUS, SPAWN_BUTTON_ALPHA, SPAWN_BUTTON_BORDER_COLOR, SPAWN_BUTTON_BOTTOM_COLOR, SPAWN_BUTTON_DEPLOY_COST, SPAWN_BUTTON_GAP, SPAWN_BUTTON_HEIGHT, SPAWN_BUTTON_ICON_TEXTURE_SIZE, SPAWN_BUTTON_PRESS_DURATION, SPAWN_BUTTON_PRESS_SCALE, SPAWN_BUTTON_RECRUIT_COST, SPAWN_BUTTON_SLIDE_DURATION, SPAWN_BUTTON_SLIDE_STAGGER, SPAWN_BUTTON_SQUAD_CAP, SPAWN_BUTTON_TOP_COLOR, SPAWN_BUTTON_UNITS, SPAWN_BUTTON_WIDTH, SPAWN_CATEGORY_CAP, SPAWN_GLOW_BASE_SCALE, SPAWN_GLOW_TEXTURE_SIZE, SPAWN_HUD_DEPTH, SPAWN_HUD_MARGIN, SPAWN_PAD_COLOR, SPAWN_POINT_TEXT_COLOR, SPAWN_POINT_TEXT_STROKE, SPAWN_POINT_X, SPAWN_POINT_Y, SPAWN_PREVIEW_HEAVY_DROP, SPAWN_PREVIEW_HEAVY_RADIUS, SPAWN_PREVIEW_MIRROR_KEYS, SPAWN_RALLY_OFFSET_X, SPAWN_RALLY_SPREAD, SPAWN_RING_COLOR, SPAWN_RING_RADIUS, SQUAD_TAG_BASE_SIZE, SQUAD_TAG_HEAD_GAP, SQUAD_TAG_ICON_TEXTURES, SQUAD_TAG_MAX_SCREEN, TARGET_MARKER_BOB_AMPLITUDE, TARGET_MARKER_BOB_SPEED, TARGET_MARKER_RING_HEIGHT, TARGET_MARKER_RING_OFFSET_Y, TARGET_MARKER_RING_WIDTH, TARGET_MARKER_TRIANGLE_H, TARGET_MARKER_TRIANGLE_W, TARGET_MARKER_TRIANGLE_Y, TOMATO_LEAK_RADIUS, TOMATO_START_COUNT, UNIT_DATABASE, UNIT_DB, UNIT_SPEED, VIEW_WIDTH, WALKABLE_SHIELD_SCAN_STEP, WORLD_HEIGHT, WORLD_WIDTH, attackShells, boot, clearanceQueryBits, collisionCrossProbeEnd, collisionCrossProbeStart, collisionGraphics, collisionRegions, combatTexts, config, deathChargePlanQueue, deathChargePlanStats, enemyNumber, enemyRoutes, enemySeparationGrid, enemyTrackAimPoint, greenSegmentMemos, gustafAimPointer, mapOverlayLayer, memberScanDistances, memberScanList, memberScanOrder, modulePerf, offscreenNoopUpdate, playerNumber, playerPathQueue, playerSquads, pointQueryCache, redContourCache, redContourNodeCache, redCrossProbeEnd, redCrossProbeStart, redPathStats, redZoneBoundsCache, routeGraphics, routeLaneRatios, segmentZoneMemos, skeletonBoundsOffset, skeletonBoundsSize, sightTestMemo, trainingSquads, WG2_SPAWN_RALLY_LIFT, WG2_SPEED_FACTOR, WG2_UNIT_SCALE_DELTA };
