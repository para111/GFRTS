// ============================================================
// wg_game 模块化拆分 —— scene.js
// 职责: 场景编排：preload / create / update 主流程
// 来源: wg_game.js 语句区间 1434-9431（自动拆分，勿手工重排语句顺序）
// ============================================================

import { S } from './S.js';
import { canGustafFire, createGustafAssist, exitGustafAiming, fireAttackShell, fireGustafShell, isGustafAimPointValid, updateAttackShells, updateGustafSelectionView, updateGustafShells } from './artillery.js';
import { computeArmorDamage, computeMeleeDamage, damageEnemy, showCombatText, updateCombatTextScale, updateExplosionShake } from './combat.js';
import { clampCameraToWorld, isRedZoneClearanceSafePath, processPlayerPathQueue, syncPlayerMemberParts } from './core.js';
import { advanceEnemyTowards, beginEnemyEndpointIdle, beginEnemyEndpointRoam, beginEnemyHold, beginEnemyTrack, chooseEnemyEndpointRoamTarget, chooseEnemyRoamTarget, decideEnemyActionPoint, getEnemyNextRoutePoint, getEnemyTrackGap, getSafeRouteTarget, isEnemyFarFromTerminal, isEnemyPoseWalkable, isEnemyStuck, isRoutePointClaimed, replanEnemyToNextPoint, rerollEnemyRoute, resumeEnemyRouteToTerminal, separateEnemies, setEnemyAnimation, spawnHeavyReinforcement, spawnRouteWave, steerEnemyTowards, stepEnemyOutOfUnwalkable, syncEnemyFacing, updateEnemyDeath, updateEnemyKnockback, updateEnemyTracking } from './enemy.js';
import { createSpawnHud, createSpawnPoint, drawAttackRangeMarkers, drawFocusCornerBracket, updateEnemyBars, updatePlayerSquadHud, updatePlayerSquadTags, updateSpawnBeaconIdle, updateSpawnHud } from './hud.js';
import { handleWorldClick } from './input.js';
import { endMatch, registerTomatoLeak } from './match.js';
import { getReachablePathNode, getShieldSteeringTarget, getShortestPlayerPath, isRedZonePathCrossed } from './pathfind.js';
import { allTasksComplete, initMissionPanel } from './mission.js';
import { recordModulePerfWindow } from './perf.js';
import { getLivingPlayerMembers, hasActivePlayerSpawnAnimation, playPlayerAttackAnimation, processDeathChargePlanQueue, refreshPlayerAnimation, setPlayerFacing, updatePlayerMemberCharge, updatePlayerSpawnAnimation } from './player-member.js';
import { getPlayerSquadOuterRadius, getSpawnedPlayerSquads, handlePlayerSquadWipe, hasSpawnedPlayerSquad, isPlayerSquadFacingLeft, issuePlayerMoveOrder, resetPlayerMoveProgress, resolvePlayerSquadOrderGoals, sellPlayerSquad, setPlayerSquadVisible, updatePlayerMoveProgress, updatePlayerSquad, updatePlayerSquadRegen } from './player-squad.js';
import { getPlayerUnitRecord, normalizeSpineVersionTags } from './records.js';
import { ACTIVE_ENEMY_RECORD, ATTACK_BLAST_TEXTURE_KEY, ATTACK_SHELL_TEXTURE_KEY, CAMERA_ZOOM_DEFAULT, CAMERA_ZOOM_MAX, CAMERA_ZOOM_MIN, ENEMY_COLLISION_RADIUS, ENEMY_ENDPOINT_IDLE_MAX, ENEMY_ENDPOINT_ROAM_RADIUS, ENEMY_PATROL_RADIUS, ENEMY_PATROL_SLACK, ENEMY_ROUTE_ENTRY_COUNT, ENEMY_SEPARATION_DISTANCE, EXPLOSION_TEXTURE_KEY, FOCUS_BRACKET_ARM, FOCUS_BRACKET_CENTER_OFFSET_Y, FOCUS_BRACKET_OFFSET, FOCUS_BRACKET_RADIUS, FOCUS_BRACKET_SIZE, FOCUS_BRACKET_SPEED, GUSTAF_SHELL_BUTTON_OFFSET, GUSTAF_TRIANGLE_SIZE, GUSTAF_X, GUSTAF_Y, IS_WG2, MAP_DATA, MATCH_DURATION_MS, PLAYER_MEMBER_COLLISION_RADIUS, PLAYER_RED_ARRIVE_DISTANCE, PLAYER_RED_REPLAN_COOLDOWN, PLAYER_RING_HEIGHT, PLAYER_RING_OFFSET_Y, PLAYER_RING_WIDTH, PLAYER_SQUAD_LIMIT, PLAYER_START_POINTS, SELL_BUTTON_BORDER, SELL_BUTTON_FILL, SELL_BUTTON_GAP, SELL_BUTTON_HEIGHT_RATIO, SELL_BUTTON_RADIUS, SELL_BUTTON_TEXT_COLOR, SELL_BUTTON_TEXT_SIZE, SELL_GLOW_ALPHA, SELL_GLOW_BAND, SELL_GLOW_COLOR, SELL_RING_CLEARANCE, SELL_RING_COLOR, SELL_RING_OFFSET_Y, SELL_RING_WIDTH, SHADOW_TEXTURE_KEY, SPAWN_POINT_X, SPAWN_POINT_Y, TARGET_MARKER_BOB_AMPLITUDE, TARGET_MARKER_BOB_SPEED, TARGET_MARKER_RING_HEIGHT, TARGET_MARKER_RING_OFFSET_Y, TARGET_MARKER_RING_WIDTH, TARGET_MARKER_TRIANGLE_H, TARGET_MARKER_TRIANGLE_W, TARGET_MARKER_TRIANGLE_Y, TOMATO_LEAK_RADIUS, UNIT_SPEED, WORLD_HEIGHT, WORLD_WIDTH, enemyRoutes, gustafAimPointer, modulePerf, offscreenNoopUpdate, playerSquads } from './state.js';
import { createAttackShellTexture, createExplosionTexture, createUnitShadowTexture } from './units-visual.js';
import { clearRedQueryCaches, prewarmRedContourCache } from './zones.js';


  // ----------------------------------------------------
  // 2. 预加载阶段：使用 Memory Canvas 生成纯代码纹理
  // ----------------------------------------------------
  function preload() {
    // 加载进度接线：progress 更新底部进度条与百分比文字，complete 隐藏加载屏
    this.load.on('progress', value => {
      const fill = document.getElementById('loadProgressFill');
      const label = document.getElementById('loadProgressText');
      if (fill) fill.style.width = Math.round(value * 100) + '%';
      if (label) label.textContent = '加载中 ' + Math.round(value * 100) + '%';
    });
    this.load.on('complete', () => {
      const overlay = document.getElementById('loadingScreen');
      if (overlay) overlay.style.display = 'none';
    });
    // Daiyan Spine 角色资源（队长）
    this.load.spine({
      key: 'Daiyan',
      jsonURL: '../art/tr_ar/Daiyan/Daiyan.json',
      atlasURL: ['../art/tr_ar/Daiyan/Daiyan.atlas'],
      preMultipliedAlpha: false
    });
    // 图集页面纹理必须注册为 "<骨架key>:<atlas 页名>"，否则 Spine 无法绑定贴图
    this.load.image('Daiyan:Daiyan.png', '../art/tr_ar/Daiyan/Daiyan.png');
    // Vespid 敌方单位 Spine 资源（素材目录已变更为 art/enemy_ar/Vespid），动画名称与我方角色保持一致
    this.load.spine({
      key: 'Vespid',
      jsonURL: '../art/enemy_ar/Vespid/Vespid_s38.json',
      atlasURL: ['../art/enemy_ar/Vespid/Vespid.atlas'],
      preMultipliedAlpha: false
    });
    this.load.image('Vespid:Vespid.png', '../art/enemy_ar/Vespid/Vespid.png');
    // 敌方新兵种 Spine 资源（数值见 unit_database.sql 的 enemy_* 三张表）：
    // 步兵 Guard / Striker / Aegis / Jaeger / Ripper / Prowler、重甲 Smasher / Kratos、支援 Zombie1 / Zombie2 / Strelet
    this.load.spine({ key: 'Guard', jsonURL: '../art/enemy_hg/Guard/Guard_s38.json', atlasURL: ['../art/enemy_hg/Guard/Guard.atlas'], preMultipliedAlpha: false });
    this.load.image('Guard:Guard.png', '../art/enemy_hg/Guard/Guard.png');
    this.load.spine({ key: 'Striker', jsonURL: '../art/enemy_mg/Striker/Striker_s38.json', atlasURL: ['../art/enemy_mg/Striker/Striker.atlas'], preMultipliedAlpha: false });
    this.load.image('Striker:Striker.png', '../art/enemy_mg/Striker/Striker.png');
    this.load.spine({ key: 'Aegis', jsonURL: '../art/enemy_sword/Aegis/Aegis_s38.json', atlasURL: ['../art/enemy_sword/Aegis/Aegis.atlas'], preMultipliedAlpha: false });
    this.load.image('Aegis:Aegis.png', '../art/enemy_sword/Aegis/Aegis.png');
    this.load.spine({ key: 'Jaeger', jsonURL: '../art/enemy_rf/Jaeger/Jaeger_s38.json', atlasURL: ['../art/enemy_rf/Jaeger/Jaeger.atlas'], preMultipliedAlpha: false });
    this.load.image('Jaeger:Jaeger.png', '../art/enemy_rf/Jaeger/Jaeger.png');
    this.load.spine({ key: 'Ripper', jsonURL: '../art/enemy_smg/Ripper/Ripper_s38.json', atlasURL: ['../art/enemy_smg/Ripper/Ripper.atlas'], preMultipliedAlpha: false });
    this.load.image('Ripper:Ripper.png', '../art/enemy_smg/Ripper/Ripper.png');
    this.load.spine({ key: 'Prowler', jsonURL: '../art/enemy_smg/Prowler/Prowler_s38.json', atlasURL: ['../art/enemy_smg/Prowler/Prowler.atlas'], preMultipliedAlpha: false });
    this.load.image('Prowler:Prowler.png', '../art/enemy_smg/Prowler/Prowler.png');
    this.load.spine({ key: 'Smasher', jsonURL: '../art/enemy_sword/Smasher/Smasher_s38.json', atlasURL: ['../art/enemy_sword/Smasher/Smasher.atlas'], preMultipliedAlpha: false });
    this.load.image('Smasher:Smasher.png', '../art/enemy_sword/Smasher/Smasher.png');
    this.load.spine({ key: 'Kratos', jsonURL: '../art/enemy_sword/Kratos/Kratos_s38.json', atlasURL: ['../art/enemy_sword/Kratos/Kratos.atlas'], preMultipliedAlpha: false });
    this.load.image('Kratos:Kratos.png', '../art/enemy_sword/Kratos/Kratos.png');
    this.load.spine({ key: 'Zombie1', jsonURL: '../art/enemy_sword/Zombie/Zombie1_s38.json', atlasURL: ['../art/enemy_sword/Zombie/Zombie1.atlas'], preMultipliedAlpha: false });
    this.load.image('Zombie1:Zombie1.png', '../art/enemy_sword/Zombie/Zombie1.png');
    this.load.spine({ key: 'Zombie2', jsonURL: '../art/enemy_sword/Zombie/Zombie2_s38.json', atlasURL: ['../art/enemy_sword/Zombie/Zombie2.atlas'], preMultipliedAlpha: false });
    this.load.image('Zombie2:Zombie2.png', '../art/enemy_sword/Zombie/Zombie2.png');
    this.load.spine({ key: 'Strelet', jsonURL: '../art/enemy_ar/Strelet/Strelet_s38.json', atlasURL: ['../art/enemy_ar/Strelet/Strelet.atlas'], preMultipliedAlpha: false });
    this.load.image('Strelet:Strelet.png', '../art/enemy_ar/Strelet/Strelet.png');
    // 黄线新敌方单位（2026-09-30 Excel 导入）：Brute_SWAP（剑兵）/ Doppelsoldner、Fortress、
    // Hydra_Deutsch（重甲炮击）/ Cerynitis（支援步枪），美术资产位于 art/enemy_* 对应目录
    this.load.spine({ key: 'Brute_SWAP', jsonURL: '../art/enemy_sword/Brute_SWAP/Brute_SWAP_s38.json', atlasURL: ['../art/enemy_sword/Brute_SWAP/Brute_SWAP.atlas'], preMultipliedAlpha: false });
    this.load.image('Brute_SWAP:Brute_SWAP.png', '../art/enemy_sword/Brute_SWAP/Brute_SWAP.png');
    this.load.spine({ key: 'Doppelsoldner', jsonURL: '../art/enemy_mg/Doppelsoldner/Doppelsoldner_s38.json', atlasURL: ['../art/enemy_mg/Doppelsoldner/Doppelsoldner.atlas'], preMultipliedAlpha: false });
    this.load.image('Doppelsoldner:Doppelsoldner.png', '../art/enemy_mg/Doppelsoldner/Doppelsoldner.png');
    this.load.spine({ key: 'Fortress', jsonURL: '../art/enemy_mg/Fortress/Fortress_s38.json', atlasURL: ['../art/enemy_mg/Fortress/Fortress.atlas'], preMultipliedAlpha: false });
    this.load.image('Fortress:Fortress.png', '../art/enemy_mg/Fortress/Fortress.png');
    this.load.spine({ key: 'Hydra_Deutsch', jsonURL: '../art/enemy_mg/Hydra_Deutsch/Hydra_Deutsch_s38.json', atlasURL: ['../art/enemy_mg/Hydra_Deutsch/Hydra_Deutsch.atlas'], preMultipliedAlpha: false });
    this.load.image('Hydra_Deutsch:Hydra_Deutsch.png', '../art/enemy_mg/Hydra_Deutsch/Hydra_Deutsch.png');
    this.load.spine({ key: 'Cerynitis', jsonURL: '../art/enemy_rf/Cerynitis/Cerynitis_s38.json', atlasURL: ['../art/enemy_rf/Cerynitis/Cerynitis.atlas'], preMultipliedAlpha: false });
    this.load.image('Cerynitis:Cerynitis.png', '../art/enemy_rf/Cerynitis/Cerynitis.png');
    // GustafAssist2：我方永久固定炮击单位（art/build/army_train 三件套，单页图集）
    this.load.spine({ key: 'GustafAssist2', jsonURL: '../art/build/army_train/GustafAssist2_s38.json', atlasURL: ['../art/build/army_train/GustafAssist2.atlas'], preMultipliedAlpha: false });
    this.load.image('GustafAssist2:GustafAssist2.png', '../art/build/army_train/GustafAssist2.png');
    // Jiangyu Spine 角色资源（我方小队成员）
    this.load.spine({
      key: 'Jiangyu',
      jsonURL: '../art/tr_ar/Jiangyu/Jiangyu.json',
      atlasURL: ['../art/tr_ar/Jiangyu/Jiangyu.atlas'],
      preMultipliedAlpha: false
    });
    this.load.image('Jiangyu:Jiangyu.png', '../art/tr_ar/Jiangyu/Jiangyu.png');
    // Qiongjiu Spine 角色资源（我方小队成员）
    this.load.spine({
      key: 'Qiongjiu',
      jsonURL: '../art/tr_ar/Qiongjiu/Qiongjiu.json',
      atlasURL: ['../art/tr_ar/Qiongjiu/Qiongjiu.atlas'],
      preMultipliedAlpha: false
    });
    this.load.image('Qiongjiu:Qiongjiu.png', '../art/tr_ar/Qiongjiu/Qiongjiu.png');
    // ELMO1 小队（Biyoca / Andoris / Groza）Spine 资源
    this.load.spine({ key: 'Biyoca', jsonURL: '../art/tr_ar/Biyoca/Biyoca.json', atlasURL: ['../art/tr_ar/Biyoca/Biyoca.atlas'], preMultipliedAlpha: false });
    this.load.image('Biyoca:Biyoca.png', '../art/tr_ar/Biyoca/Biyoca.png');
    this.load.spine({ key: 'Andoris', jsonURL: '../art/tr_ar/Andoris/Andoris.json', atlasURL: ['../art/tr_ar/Andoris/Andoris.atlas'], preMultipliedAlpha: false });
    this.load.image('Andoris:Andoris.png', '../art/tr_ar/Andoris/Andoris.png');
    this.load.spine({ key: 'Groza', jsonURL: '../art/tr_ar/Groza/Groza.json', atlasURL: ['../art/tr_ar/Groza/Groza.atlas'], preMultipliedAlpha: false });
    this.load.image('Groza:Groza.png', '../art/tr_ar/Groza/Groza.png');
    // GK 小队（Centaureissi / Sharkry / Tololo）Spine 资源
    this.load.spine({ key: 'Centaureissi', jsonURL: '../art/tr_ar/Centaureissi/Centaureissi.json', atlasURL: ['../art/tr_ar/Centaureissi/Centaureissi.atlas'], preMultipliedAlpha: false });
    this.load.image('Centaureissi:Centaureissi.png', '../art/tr_ar/Centaureissi/Centaureissi.png');
    this.load.spine({ key: 'Sharkry', jsonURL: '../art/tr_ar/Sharkry/Sharkry.json', atlasURL: ['../art/tr_ar/Sharkry/Sharkry.atlas'], preMultipliedAlpha: false });
    this.load.image('Sharkry:Sharkry.png', '../art/tr_ar/Sharkry/Sharkry.png');
    this.load.spine({ key: 'Tololo', jsonURL: '../art/tr_ar/Tololo/Tololo.json', atlasURL: ['../art/tr_ar/Tololo/Tololo.atlas'], preMultipliedAlpha: false });
    this.load.image('Tololo:Tololo.png', '../art/tr_ar/Tololo/Tololo.png');
    // ELMO2 小队（Cheeta / Lenna / Soumi）Spine 资源（SMG 系）
    this.load.spine({ key: 'Cheeta', jsonURL: '../art/tr_smg/Cheeta/Cheeta.json', atlasURL: ['../art/tr_smg/Cheeta/Cheeta.atlas'], preMultipliedAlpha: false });
    this.load.image('Cheeta:Cheeta.png', '../art/tr_smg/Cheeta/Cheeta.png');
    this.load.spine({ key: 'Lenna', jsonURL: '../art/tr_smg/Lenna/Lenna.json', atlasURL: ['../art/tr_smg/Lenna/Lenna.atlas'], preMultipliedAlpha: false });
    this.load.image('Lenna:Lenna.png', '../art/tr_smg/Lenna/Lenna.png');
    this.load.spine({ key: 'Soumi', jsonURL: '../art/tr_smg/Soumi/Soumi.json', atlasURL: ['../art/tr_smg/Soumi/Soumi.atlas'], preMultipliedAlpha: false });
    this.load.image('Soumi:Soumi.png', '../art/tr_smg/Soumi/Soumi.png');
    // 我方支援单位（player_support）：coffee 小队（Macqiato / Nemesis 双人纵队）、
    // SF（Agent 单人，开局 skill2 召唤两个分身成三角阵）、404 小队（Clukay / Mishty 双人纵队）
    this.load.spine({ key: 'Macqiato', jsonURL: '../art/tr_rf/Macqiato/Macqiato.json', atlasURL: ['../art/tr_rf/Macqiato/Macqiato.atlas'], preMultipliedAlpha: false });
    this.load.image('Macqiato:Macqiato.png', '../art/tr_rf/Macqiato/Macqiato.png');
    this.load.spine({ key: 'Nemesis', jsonURL: '../art/tr_rf/Nemesis/Nemesis.json', atlasURL: ['../art/tr_rf/Nemesis/Nemesis.atlas'], preMultipliedAlpha: false });
    this.load.image('Nemesis:Nemesis.png', '../art/tr_rf/Nemesis/Nemesis.png');
    this.load.spine({ key: 'Agent', jsonURL: '../art/tr_mg/Agent/Agent_s38.json', atlasURL: ['../art/tr_mg/Agent/Agent.atlas'], preMultipliedAlpha: false });
    this.load.image('Agent:Agent.png', '../art/tr_mg/Agent/Agent.png');
    this.load.spine({ key: 'Clukay', jsonURL: '../art/tr_ar/Clukay/Clukay.json', atlasURL: ['../art/tr_ar/Clukay/Clukay.atlas'], preMultipliedAlpha: false });
    this.load.image('Clukay:Clukay.png', '../art/tr_ar/Clukay/Clukay.png');
    this.load.spine({ key: 'Mishty', jsonURL: '../art/tr_ar/Mishty/Mishty.json', atlasURL: ['../art/tr_ar/Mishty/Mishty.atlas'], preMultipliedAlpha: false });
    this.load.image('Mishty:Mishty.png', '../art/tr_ar/Mishty/Mishty.png');
    // TankM1 重装单位（单兵编队）Spine 资源：攻击动画用 skill1，待机/移动用 wait / move
    this.load.spine({ key: 'TankM1_1001', jsonURL: '../art/tr_heavy/tank/TankM1_1001_s38.json', atlasURL: ['../art/tr_heavy/tank/TankM1_1001.atlas'], preMultipliedAlpha: false });
    this.load.image('TankM1_1001:TankM1_1001.png', '../art/tr_heavy/tank/TankM1_1001.png');
    // Ares 重装单位（单兵编队）Spine 资源：攻击动画 attack，阵亡自爆途中在冲锋 1 秒后切 skill3。
    // 图集页必须用 1024×512 的那张原图：Ares.atlas 头部登记页尺寸为 1024×512，
    // 而同目录下的 Ares.png 只有 502×244（半尺寸副本），Spine 按图集登记的比例取图会取错区域，
    // 「#354034」是 Unity 导出的重名后缀，URL 里的空格与 # 需要转义
    this.load.spine({ key: 'Ares', jsonURL: '../art/tr_heavy/aa02/Ares_s38.json', atlasURL: ['../art/tr_heavy/aa02/Ares.atlas'], preMultipliedAlpha: false });
    this.load.image('Ares:Ares.png', '../art/tr_heavy/aa02/Ares_page.png');
    // Warjack 重装单位（单兵编队）Spine 资源：由两套骨架叠加渲染（Part2 在后、Part1 在前），
    // 近战动画 attack_SP，两套骨架的动画名与根骨骼位置一致，叠加后能严丝合缝
    this.load.spine({ key: 'Warjack_1009_Part2', jsonURL: '../art/tr_heavy/Warjack/Warjack_1009_Part2_s38.json', atlasURL: ['../art/tr_heavy/Warjack/Warjack_1009_Part2.atlas'], preMultipliedAlpha: false });
    this.load.image('Warjack_1009_Part2:Warjack_1009_Part2.png', '../art/tr_heavy/Warjack/Warjack_1009_Part2.png');
    this.load.spine({ key: 'Warjack_1009_Part1', jsonURL: '../art/tr_heavy/Warjack/Warjack_1009_Part1_s38.json', atlasURL: ['../art/tr_heavy/Warjack/Warjack_1009_Part1.atlas'], preMultipliedAlpha: false });
    this.load.image('Warjack_1009_Part1:Warjack_1009_Part1.png', '../art/tr_heavy/Warjack/Warjack_1009_Part1.png');
    this.load.image('battleMap', MAP_DATA.world.backgroundImage || './Stage4-hd.png');
    // 出生界面按钮用图（GRF.png 为黑底素材，使用时按亮度抠底）
    this.load.image('grfLogo', '../art/build/fri/GRF.png');
    this.load.image('grfIcon', '../art/build/fri/GRF1.png');
    this.load.image('grfRS', '../art/build/fri/RS.png');
    // 出兵按钮图标（阵营 Logo 版）：tasa_air -> SSAOU、elmo1 -> Groza、elmo2 -> ElmoG、
    // JF -> Monsoon、GK -> Frostfall、coffee -> Zucchero、SF -> SF、404 -> 404t1
    this.load.image('grfTasaAir', '../art/logo/Img_CampLogo_SSAOU.png');
    this.load.image('grfElmo1', '../art/logo/Img_CampLogo_Groza.png');
    this.load.image('grfElmo2', '../art/logo/Img_CampLogo_ElmoG.png');
    this.load.image('grfJF', '../art/logo/Img_CampLogo_Monsoon.png');
    this.load.image('grfGK', '../art/logo/Img_CampLogo_Frostfall.png');
    // 新兵种子菜单图标：重甲（TankM1 / Ares / Warjack）与重甲子菜单（coffee / SF / 404）
    this.load.image('grfCoffee', '../art/logo/Img_CampLogo_Zucchero.png');
    this.load.image('grfSF', '../art/logo/Img_CampLogo_SF.png');
    this.load.image('grf404', '../art/logo/Img_CampLogo_404t1.png');
    this.load.image('grfTankM1', '../art/tr_heavy/tank/TankM1.png');
    this.load.image('grfAres', '../art/tr_heavy/aa02/Ares.png');
    this.load.image('grfWarjack', '../art/tr_heavy/Warjack/Warjack_1009.png');
    // WG2 大桥贴图（仅 WG2 加载；WG.html 跳过，带宽零开销）
    if (IS_WG2) this.load.image('bridgeTexture', '../art/build/fri/map_3_sp19.png');

    const g = this.make.graphics({ x: 0, y: 0, add: false });

    // 战术移动目标点标记：上方实心蓝色倒三角（尖朝下）+ 下方脚底圆环，组合成一个目标点
    g.clear();
    g.fillStyle(0x3da9ff, 1);
    g.fillTriangle(0, 0, TARGET_MARKER_TRIANGLE_W, 0, TARGET_MARKER_TRIANGLE_W / 2, TARGET_MARKER_TRIANGLE_H);
    g.generateTexture('targetTriangleTexture', TARGET_MARKER_TRIANGLE_W, TARGET_MARKER_TRIANGLE_H);
    g.clear();
    g.lineStyle(2, 0x3da9ff, 0.95);
    g.strokeEllipse(TARGET_MARKER_RING_WIDTH / 2, TARGET_MARKER_RING_HEIGHT / 2, TARGET_MARKER_RING_WIDTH, TARGET_MARKER_RING_HEIGHT);
    g.generateTexture('targetRingTexture', TARGET_MARKER_RING_WIDTH, TARGET_MARKER_RING_HEIGHT);

    // 设置齿轮纹理：外圈 8 齿 + 齿轮主体 + 中孔（游戏画面右上角的设置按钮用）
    g.clear();
    g.fillStyle(0x33373d, 1);
    g.lineStyle(7, 0x33373d, 1);
    for (let tooth = 0; tooth < 8; tooth++) {
      const toothAngle = (Math.PI * 2 * tooth) / 8;
      g.beginPath();
      g.moveTo(22 + Math.cos(toothAngle) * 9, 22 + Math.sin(toothAngle) * 9);
      g.lineTo(22 + Math.cos(toothAngle) * 20, 22 + Math.sin(toothAngle) * 20);
      g.strokePath();
    }
    g.fillCircle(22, 22, 14);
    g.fillStyle(0x9fe3ff, 1);
    g.fillCircle(22, 22, 5.5);
    g.generateTexture('gearTexture', 44, 44);

    // 音乐符号纹理：深色圆底 + 金色八分音符（右上角音乐开关按钮，与齿轮同风格）
    g.clear();
    g.fillStyle(0x33373d, 0.92);
    g.fillCircle(22, 22, 20);
    g.lineStyle(2, 0x9fe3ff, 0.55);
    g.strokeCircle(22, 22, 20);
    g.fillStyle(0xffd93d, 1);
    g.fillEllipse(15, 31, 11, 8);
    g.fillEllipse(29, 27, 11, 8);
    g.lineStyle(3, 0xffd93d, 1);
    g.beginPath();
    g.moveTo(20, 30);
    g.lineTo(20, 12);
    g.moveTo(34, 26);
    g.lineTo(34, 8);
    g.strokePath();
    g.lineStyle(4.5, 0xffd93d, 1);
    g.beginPath();
    g.moveTo(20, 12);
    g.lineTo(34, 8);
    g.strokePath();
    g.generateTexture('musicNoteTexture', 44, 44);

    // 番茄纹理：红果身 + 高光 + 绿色花萼与果柄（顶部居中的防线计数图标用）
    g.clear();
    g.fillStyle(0xe8402a, 1);
    g.fillCircle(20, 24, 14);
    g.fillStyle(0xff6b52, 0.85);
    g.fillEllipse(15, 20, 12, 7);
    g.fillStyle(0x3f9b4f, 1);
    g.fillEllipse(20, 13, 17, 7);
    g.fillStyle(0x2f7a3a, 1);
    g.fillRect(18.5, 5, 3, 7);
    g.generateTexture('tomatoTexture', 40, 40);

    // 出售按钮纹理：正六边形（红色主体 + 黑色 1px 边框），「$」文字单独用 Text 叠加
    g.clear();
    const hexPoints = [];
    for (let i = 0; i < 6; i++) {
      const angle = -Math.PI / 2 + (Math.PI * 2 * i) / 6;
      hexPoints.push({
        x: SELL_BUTTON_RADIUS + SELL_BUTTON_RADIUS * Math.cos(angle),
        y: SELL_BUTTON_RADIUS + SELL_BUTTON_RADIUS * Math.sin(angle)
      });
    }
    g.fillStyle(SELL_BUTTON_FILL, 1);
    g.fillPoints(hexPoints, true);
    g.lineStyle(1, SELL_BUTTON_BORDER, 1);
    g.strokePoints(hexPoints, true);
    g.generateTexture('sellButtonTexture', SELL_BUTTON_RADIUS * 2, SELL_BUTTON_RADIUS * 2);

    // GustafAssist2 炮弹按钮纹理：红色圆钮（黑色边框）+ 钢身铜尖的炮弹图形，
    // 直径是出售按钮的 2 倍（68px）
    g.clear();
    const shellBtnR = SELL_BUTTON_RADIUS * 2;   // 34
    g.fillStyle(0xcc2222, 1);
    g.fillCircle(shellBtnR, shellBtnR, shellBtnR - 2);
    g.lineStyle(2, 0x000000, 1);
    g.strokeCircle(shellBtnR, shellBtnR, shellBtnR - 2);
    // 炮弹图形（直立：铜色尖头朝上、钢色弹身、黑色弹带）
    g.fillStyle(0xd8b24a, 1);
    g.fillTriangle(shellBtnR, 10, shellBtnR - 9, 30, shellBtnR + 9, 30);
    g.fillStyle(0xcfd6dd, 1);
    g.fillRect(shellBtnR - 9, 30, 18, 22);
    g.fillStyle(0x2b2b2b, 1);
    g.fillRect(shellBtnR - 9, 44, 18, 5);
    g.lineStyle(1.5, 0x3a0000, 1);
    g.strokeTriangle(shellBtnR, 10, shellBtnR - 9, 30, shellBtnR + 9, 30);
    g.strokeRect(shellBtnR - 9, 30, 18, 22);
    g.generateTexture('gustafShellButtonTexture', shellBtnR * 2, shellBtnR * 2);

    // GustafAssist2 头顶指示倒三角纹理：红色等边倒三角 + 黑色描边（数字用 Text 叠加）
    g.clear();
    g.fillStyle(0xe8402a, 1);
    g.fillTriangle(1, 4, GUSTAF_TRIANGLE_SIZE - 1, 4, GUSTAF_TRIANGLE_SIZE / 2, GUSTAF_TRIANGLE_SIZE - 6);
    g.lineStyle(2, 0x000000, 1);
    g.strokeTriangle(1, 4, GUSTAF_TRIANGLE_SIZE - 1, 4, GUSTAF_TRIANGLE_SIZE / 2, GUSTAF_TRIANGLE_SIZE - 6);
    g.generateTexture('gustafTriangleTexture', GUSTAF_TRIANGLE_SIZE, GUSTAF_TRIANGLE_SIZE);

    // 侵入异形敌人纹理（红色高亮圆球）
    g.clear();
    g.fillStyle(0xff2e63, 1);
    g.fillCircle(12, 12, 12);
    g.generateTexture('enemyTexture', 24, 24);

  }


  // ----------------------------------------------------
  // 3. 场景构建阶段
  // ----------------------------------------------------
  function create() {
    this.physics.world.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    // 相机不使用 Phaser 自带边界，改为逐帧 clampCameraToWorld()：
    // 自带边界在可视范围超出地图时会把地图顶到左上角，自己夹取可以居中，行为更可控
    this.add.image(WORLD_WIDTH / 2, WORLD_HEIGHT / 2, 'battleMap')
      .setDisplaySize(WORLD_WIDTH, WORLD_HEIGHT)
      .setDepth(-10);

    // 【暂时注释】在地图上显示碰撞/禁入区域以及敌军移动路线（后面还需要用到，恢复时取消下面四行注释即可）
    // 这些内容全程静态，但点是矢量图形时 Phaser 每帧都要重新批处理全部顶点：
    // 屏蔽区按手绘轮廓曲线重绘后，轮廓点从 72 个涨到约 4150 个，逐帧批处理会白吃约 5 毫秒
    // 并带来大量临时分配，因此先把图形画进离屏 Graphics，再烘焙成一张静态贴图。
    // collisionGraphics = this.make.graphics({ x: 0, y: 0, add: false });
    // routeGraphics = this.make.graphics({ x: 0, y: 0, add: false });
    // 两份静态图形烘焙进同一张贴图：地图换成原始像素后整幅贴图约 46MB，
    // 分成两张会白占一倍显存（原深度 -4 / -3 之间没有任何对象，合成顺序不变）
    // mapOverlayLayer = this.add.renderTexture(0, 0, WORLD_WIDTH, WORLD_HEIGHT).setOrigin(0, 0).setDepth(-4);
    // drawMapGuides();

    // A. 物理组与容器初始化
    S.enemiesGroup = this.physics.add.group();
    S.enemyBars = this.add.graphics().setDepth(4);   // 敌方血条共享 Graphics（每帧统一重绘）

    // B. 创建移动目标指示器：每支被选中并下达移动的小队一个「上倒三角 + 下脚底圆环」组合标记。
    // 池的容量对齐小队上限，实际显示数量由每帧按「正在移动的小队数」同步，避免与框选数量不一致
    S.targetMarkers = [];
    for (let index = 0; index < PLAYER_SQUAD_LIMIT; index++) {
      const container = this.add.container(0, 0).setDepth(6);
      const ring = this.add.image(0, TARGET_MARKER_RING_OFFSET_Y, 'targetRingTexture');
      const triangle = this.add.image(0, TARGET_MARKER_TRIANGLE_Y, 'targetTriangleTexture');
      container.add([ring, triangle]);
      container.setVisible(false);
      S.targetMarkers.push({ container, ring, triangle });
    }
    // 集火标记：被集火敌方角色四角的红色直角边线，逐帧重绘
    S.focusMarkGraphics = this.add.graphics().setDepth(3);

    // B2. 出售表现：黄线圆环 + 淡黄色渲染带逐帧重绘（层级放在我方角色之下，不会遮住单位显示）；
    // 每支展开出售面板的小队各有一个六边形「$」按钮，池容量对齐小队上限
    S.sellRingGraphics = this.add.graphics().setDepth(1);
    S.sellButtons = [];
    for (let index = 0; index < PLAYER_SQUAD_LIMIT; index++) {
      const container = this.add.container(0, 0).setDepth(7);
      const icon = this.add.image(0, 0, 'sellButtonTexture');
      const label = this.add.text(0, 0, '$', {
        fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
        fontSize: SELL_BUTTON_TEXT_SIZE + 'px',
        color: SELL_BUTTON_TEXT_COLOR,
        stroke: '#3a0000',
        strokeThickness: 2,
        resolution: 2
      }).setOrigin(0.5);
      container.add([icon, label]);
      container.setVisible(false);
      const zone = this.add.zone(0, 0, SELL_BUTTON_RADIUS * 2, SELL_BUTTON_RADIUS * 2).setOrigin(0.5);
      zone.setInteractive({ useHandCursor: true });
      container.add(zone);       // 让点击区域跟随按钮容器一起移动
      const entry = { container, zone, squad: null };
      zone.on('pointerdown', pointer => {
        if (pointer.button !== 0) return;
        if (!zone.input || !zone.input.enabled) return;
        if (entry.squad) sellPlayerSquad(entry.squad);
      });
      S.sellButtons.push(entry);
    }

    // C. 初始化 RTS 玩家操控小队
    // 每支小队各有自己的隐藏 Arcade 碰撞体（负责整队移动与索敌），画面由 Spine 角色负责渲染。
    // 队伍按需组建：点击 GRF1 出兵时才会新建一支（场上最多同时 6 支），
    // 因此这里只做全局初始化，不再预制小队。
    S.gameScene = this;
    // GustafAssist2：永久固定炮击单位（出生信标左侧 100px，create 时随场景重建）
    createGustafAssist(this);
    normalizeSpineVersionTags(this);
    // 图集与骨架 JSON 清理：部分 Unity 导出的资源里，区域名 / 附件 path / 皮肤附件键
    // 带有尾随空格（如 Striker 的 'leg-l-B '）。spine-ts 解析图集时会修剪区域名，
    // 但骨架 JSON 的 path 不修剪，两边永远差一个空格，附件解析直接抛
    // "Region not found in atlas" 并使页面崩溃。因此在创建任何 Spine 对象之前：
    //   1. 图集文本逐行去掉行尾空白（与运行时行为对齐）；
    //   2. 骨架 JSON 递归修剪所有字符串与对象键的尾随空白（名称 / 路径类字段
    //      本不应有尾随空白，统一修剪后 JSON 内部与图集两侧的引用重新自洽）
    const trimStringsDeep = node => {
      if (Array.isArray(node)) {
        for (let index = 0; index < node.length; index++) {
          const item = node[index];
          if (typeof item === 'string') node[index] = item.replace(/[ \t\r]+$/, '');
          else trimStringsDeep(item);
        }
      } else if (node && typeof node === 'object') {
        Object.keys(node).forEach(key => {
          const item = node[key];
          if (typeof item === 'string') node[key] = item.replace(/[ \t\r]+$/, '');
          else trimStringsDeep(item);
        });
        const keys = Object.keys(node);
        if (keys.some(key => /[ \t\r]$/.test(key))) {
          keys.forEach(key => {
            const trimmedKey = key.replace(/[ \t\r]+$/, '');
            if (trimmedKey !== key) {
              node[trimmedKey] = node[key];
              delete node[key];
            }
          });
        }
      }
    };
    const spineAtlasCache = this.cache.custom.spine;
    spineAtlasCache.getKeys().forEach(key => {
      const entry = spineAtlasCache.get(key);
      if (entry && typeof entry.data === 'string' && /[ \t\r]+$/.test(entry.data)) {
        entry.data = entry.data.split('\n').map(line => line.replace(/[ \t\r]+$/, '')).join('\n');
      }
      const skeletonJson = this.cache.json.get(key);
      if (skeletonJson) trimStringsDeep(skeletonJson);
    });
    // 程序化生成脚下阴影与自爆特效纹理（与出生点光晕一样走 Memory Canvas）。
    // 阴影贴图可能在 createGustafAssist 的守卫里已提前生成（ Gustaf 阴影 Image 已引用它），
    // 这里存在即跳过——remove 会销毁旧 Texture 导致引用它的 Image 渲染时 isGLTexture 崩溃
    if (!this.textures.exists(SHADOW_TEXTURE_KEY)) {
      createUnitShadowTexture(this, SHADOW_TEXTURE_KEY, 128);
    }
    createExplosionTexture(this, EXPLOSION_TEXTURE_KEY, 128);
    createExplosionTexture(this, ATTACK_BLAST_TEXTURE_KEY, 128, true);
    createAttackShellTexture(this, ATTACK_SHELL_TEXTURE_KEY, 64);
    this.input.mouse.disableContextMenu();
    // 选中环与攻击范围圈：每帧清空后为所有被选中的小队重绘，永远可见
    S.selectionCircle = this.add.graphics().setDepth(1);
    S.attackRangeGraphics = this.add.graphics().setDepth(1);
    // 小队血条：每帧根据存活队员的头顶高度重绘，未出兵时隐藏
    S.playerSquadBars = this.add.graphics().setDepth(4).setVisible(false);
    // C2. 出生点信标 + 左上角出生界面（GRF 按钮组）
    createSpawnPoint(this);
    createSpawnHud(this);
    S.playerPoints = PLAYER_START_POINTS;
    const camera = this.cameras.main;
    // 开局用 CAMERA_ZOOM_DEFAULT 缩放（视野是地图上约 1600×900 的一块区域），
    // 世界大于视野，开局先把视角对准我方出生点（不能再默认停在 (0,0) 左上角）；
    // 滚轮可在 CAMERA_ZOOM_MIN~CAMERA_ZOOM_MAX 之间缩放，最小缩放到地图宽度正好铺满视野宽度
    camera.setZoom(CAMERA_ZOOM_DEFAULT);
    camera.centerOn(SPAWN_POINT_X, SPAWN_POINT_Y);
    clampCameraToWorld();
    let isPanning = false;
    let panLast = null;
    this.input.on('wheel', (pointer, over, deltaX, deltaY) => {
      camera.setZoom(Phaser.Math.Clamp(camera.zoom - deltaY * 0.001, CAMERA_ZOOM_MIN, CAMERA_ZOOM_MAX));
      clampCameraToWorld();
    });

    const selectionGraphics = this.add.graphics().setDepth(10);
    let selectionStart = null;
    let isSelecting = false;

    // E. 全局点击处理：左键框选，右键移动，中键拖动视角
    this.input.on('pointerdown', (pointer, currentlyOver) => {
      if (pointer.button === 1) {
        isPanning = true;
        panLast = new Phaser.Math.Vector2(pointer.x, pointer.y);
        return;
      }
      if (pointer.button === 0) {
        selectionStart = new Phaser.Math.Vector2(pointer.worldX, pointer.worldY);
        isSelecting = true;
        selectionGraphics.clear();
        return;
      }
      if (pointer.button === 2) {
        // 这次右键刚用于展开出兵按钮的预览格：不下发移动指令
        if (S.spawnPreviewClickLatch) {
          S.spawnPreviewClickLatch = false;
          return;
        }
        // GustafAssist2 瞄准模式：右键取消瞄准，不下发移动指令
        if (S.gustafAiming) {
          exitGustafAiming();
          return;
        }
        const selected = getSpawnedPlayerSquads().filter(squad => squad.unit.isSelected);
        // 落点整批先算好再下发：红区吸附与落点间距校正需要看到其他小队的落点，
        // 逐支小队各自吸附会把相邻两支挤到同一处
        const goals = resolvePlayerSquadOrderGoals(pointer.worldX, pointer.worldY, selected.length);
        selected.forEach((squad, index) => {
          issuePlayerMoveOrder(squad, this, goals[index].x, goals[index].y);
        });
      }
    });
    this.input.on('pointermove', pointer => {
      // GustafAssist2 瞄准模式：记录指针世界坐标供落点圈逐帧绘制（不拦截拖动视角）
      if (S.gustafAiming) {
        gustafAimPointer.x = pointer.worldX;
        gustafAimPointer.y = pointer.worldY;
      }
      if (isPanning && panLast) {
        camera.scrollX -= (pointer.x - panLast.x) / camera.zoom;
        camera.scrollY -= (pointer.y - panLast.y) / camera.zoom;
        clampCameraToWorld();
        panLast.set(pointer.x, pointer.y);
        return;
      }
      if (!isSelecting || !selectionStart) return;
      const x = Math.min(selectionStart.x, pointer.worldX);
      const y = Math.min(selectionStart.y, pointer.worldY);
      const width = Math.abs(pointer.worldX - selectionStart.x);
      const height = Math.abs(pointer.worldY - selectionStart.y);
      selectionGraphics.clear();
      selectionGraphics.lineStyle(2, 0x4ecca3, 1);
      selectionGraphics.fillStyle(0x4ecca3, 0.15);
      selectionGraphics.fillRect(x, y, width, height);
      selectionGraphics.strokeRect(x, y, width, height);
    });
    this.input.on('pointerup', pointer => {
      if (pointer.button === 1) {
        isPanning = false;
        panLast = null;
        return;
      }
      if (pointer.button === 0 && S.squadTagClickLatch) {
        // 这次左键刚用于点击兵牌选中小队：跳过本层的单击判定，
        // 否则兵牌悬在头顶上方、handleWorldClick 命中空地会把刚选中的小队立刻取消
        S.squadTagClickLatch = false;
        selectionStart = null;
        isSelecting = false;
        selectionGraphics.clear();
        return;
      }
      if (pointer.button === 0 && S.gustafShellClickLatch) {
        // 这次左键刚用于点击「炮弹」按钮进入瞄准：吃掉这次抬起，不下传单击判定
        S.gustafShellClickLatch = false;
        selectionStart = null;
        isSelecting = false;
        selectionGraphics.clear();
        return;
      }
      if (pointer.button === 0 && S.gustafAiming) {
        // 瞄准模式：左键单击有效落点发射并退出；无效落点行内提示、保持瞄准；
        // 左键拖动不视为指令。右键取消在 pointerdown 层处理
        const aimRect = new Phaser.Geom.Rectangle(
          Math.min(selectionStart ? selectionStart.x : pointer.worldX, pointer.worldX),
          Math.min(selectionStart ? selectionStart.y : pointer.worldY, pointer.worldY),
          selectionStart ? Math.abs(pointer.worldX - selectionStart.x) : 0,
          selectionStart ? Math.abs(pointer.worldY - selectionStart.y) : 0
        );
        if (aimRect.width < 8 && aimRect.height < 8) {
          if (isGustafAimPointValid(pointer.worldX, pointer.worldY)) {
            fireGustafShell(this, pointer.worldX, pointer.worldY);
            exitGustafAiming();
          } else {
            showCombatText(this, pointer.worldX, pointer.worldY - 40, '无法炮击该区域', '#ffb347');
          }
        }
        selectionGraphics.clear();
        selectionStart = null;
        isSelecting = false;
        return;
      }
      if (!isSelecting || !selectionStart) return;
      const selection = new Phaser.Geom.Rectangle(
        Math.min(selectionStart.x, pointer.worldX),
        Math.min(selectionStart.y, pointer.worldY),
        Math.abs(pointer.worldX - selectionStart.x),
        Math.abs(pointer.worldY - selectionStart.y)
      );
      const isClick = selection.width < 8 && selection.height < 8;
      if (isClick) {
        handleWorldClick(selectionStart.x, selectionStart.y);
      } else {
        // 框选：框到哪几支小队就选中哪几支（按整队锚点判定）。
        // 兵牌也算命中区：框住头顶的兵牌同样能选中这支小队。
        // 框选同时退出 GustafAssist2 的选中/瞄准（固定单位不参与框选）
        S.gustafSelected = false;
        exitGustafAiming();
        getSpawnedPlayerSquads().forEach(squad => {
          const tagHit = squad.tag && squad.tag.container.visible
            && Phaser.Geom.Rectangle.Contains(selection, squad.tag.container.x, squad.tag.container.y);
          squad.unit.isSelected = tagHit
            || Phaser.Geom.Rectangle.Contains(selection, squad.unit.x, squad.unit.y);
        });
      }
      // 未出兵时小队不显示；出生动画播放期间保持显示，避免中途点击把出生动画藏起来
      playerSquads.forEach(squad => {
        setPlayerSquadVisible(squad, squad.unit.isSpawned || squad.spawnAnimation !== null);
      });
      selectionGraphics.clear();
      selectionStart = null;
      isSelecting = false;
    });

    // E. 开局预热红区等距轮廓缓存：把首次规划才要算的上百毫秒几何计算提前到开局，
    // 第一条跨红区移动指令不再因冷缓存卡顿（必须在敌军出兵之前完成）
    prewarmRedContourCache();

    // F. 敌军出兵节奏：
    //   WG2 子基地模式：地图数据带 spawnBases 且页面注册了 wg2 出兵模块时，
    //   子基地按绿线节奏共同出兵（见 js/wg2/enemy-spawn.js）；
    //   同时并行启用其余路线（black / blue / purple）各自的波次定时器——
    //   绿线本体的路线波次不开（绿线单位只从子基地出）。
    //   setup 返回 false（配置缺失）时自动回退：全部路线波次 + 重甲增援逻辑。
    //   其余地图（WG.html）：白线 / 紫线开局即出，红线开局 30 秒后出；每 5 秒一波，
    //   每波从本线随机兵种池生成 4 个，受「本线单位上限」约束——上限开局 4 个，
    //   每 30 秒 +1，最终 7 个。Smasher / Kratos 独立计算：开局 2 分钟起，
    //   白线 / 红线各自每 2 分钟生成一个，不占用所在路线的出兵上限
    const baseSpawnActive = MAP_DATA.spawnBases && window.__WG2_BASE_SPAWN__ && window.__WG2_BASE_SPAWN__.setup(this, MAP_DATA);
    if (!baseSpawnActive) {
      enemyRoutes.forEach(route => {
        spawnRouteWave(this, route);            // 白 / 紫线开局立即出第一波（红线内部按 startAt 拦截）
        this.time.addEvent({
          delay: 5000,
          loop: true,
          callback: () => spawnRouteWave(this, route)
        });
      });
      // 重甲增援线：由地图数据 heavyRouteNames 指定（WG2：红线 + 蓝线）；
      // 旧图无该字段时回退白线 / 红线（WG.html 行为不变）。
      // 名单里不存在的线名直接跳过，绝不给定时器挂上 undefined 路线
      const heavyRouteNames = MAP_DATA.heavyRouteNames || ['white', 'red'];
      const heavyRoutes = heavyRouteNames
        .map(name => enemyRoutes.find(entry => entry.name === name))
        .filter(Boolean);
      heavyRoutes.forEach(heavyRoute => {
        this.time.addEvent({
          delay: 120000,
          loop: true,
          callback: () => spawnHeavyReinforcement(this, heavyRoute)
        });
      });
    } else {
      // 子基地并行模式：非绿线路线按各自 startAt / 波次间隔（waveIntervalMs，
      // 缺省 5 秒）/ 兵种池 / 上限独立出兵
      enemyRoutes.forEach(route => {
        if (route.name === 'green') return;     // 绿线单位只从子基地出，避免与子基地出兵叠加
        spawnRouteWave(this, route);            // startAt 之前的路线由内部拦截自动跳过
        this.time.addEvent({
          delay: route.waveIntervalMs || 5000,
          loop: true,
          callback: () => spawnRouteWave(this, route)
        });
      });
    }


    // 屏幕上不再显示任何常驻说明文本（伤害飘字等临时提示保持不变）

    // 开局简报门禁：资源加载完成后立即暂停游戏进程（出波 / 计时 / AI 全部冻结，
    // 与设置界面走同一套 pause/resume 通道），并显示 test.png 新兵简报覆盖层。
    // 玩家点击简报上的「开始游戏！」按钮后才 resume 进入游戏进程（按钮接线在 WG.html）。
    this.scene.pause();
    const briefingOverlay = document.getElementById('briefingOverlay');
    if (briefingOverlay) briefingOverlay.style.display = 'flex';

    // 任务面板（WG / WG2 都启用：清单内容按模式区分，见 mission.js）
    initMissionPanel(this);
    // WG2 大桥装配（仅 WG2 且钩子已加载时执行；WG.html 无此钩子自动跳过）
    if (IS_WG2 && window.__WG2_BRIDGE__) {
      window.__WG2_BRIDGE__.setup(this);
    }
  }


  function update(time, delta) {
    const scene = this;
    const perfUpdateStart = performance.now();
    // 红区几何查询的帧内缓存每帧开头清空一次（同帧内单位位置变化不影响按坐标缓存的结果）
    clearRedQueryCaches();
    // 相机夹取：把可视范围限制在地图内（大于地图时兜底居中），避免露出地图以外的空白区域
    clampCameraToWorld();
    // 自爆的相机推拉震动先推进：随后同步浮动文字尺寸时读到的就是本帧最终的相机缩放，
    // 文字仍按屏幕像素保持恒定大小，不会跟着抖动忽大忽小
    updateExplosionShake(delta);
    // 浮动文字的显示尺寸每帧同步一次：相机缩放或窗口大小变化时屏幕尺寸保持恒定
    updateCombatTextScale();
    // 我方自然回血先结算，本帧血条就能反映最新的生命值
    updatePlayerSquadRegen(time, delta);
    // 重装单位的攻击炮弹：延迟到出膛时刻 -> 追踪目标飞行 -> 命中点范围爆炸与结算
    updateAttackShells(time, delta);
    // GustafAssist2 的抛物线炮弹：按飞行时长插值推进，落地爆炸与溅射结算
    updateGustafShells(time);
    // Spine 小队按阵型跟随各自的物理锚点（含红区净空与人员隔离约束）；
    // 传入 delta 让阵型形态与队形旋转按时间缓动，帧率变化时过渡速度保持一致
    // 【分段耗时采样】我方寻路 / 队形与归队 / 自爆规划调度段（见文件上方 modulePerf 说明）
    const perfNavStart = performance.now();
    playerSquads.forEach(squad => updatePlayerSquad(squad, delta));
    // 兵牌逐帧同步：位置 / 缩放（屏幕像素恒定）与选中底色
    updatePlayerSquadTags(scene);
    // 血条耗尽的队员：柔和泛红 -> 脱离阵型冲向最近的敌人（保留移动动画）-> 满 5 秒自爆
    // （阵型摆放已把他们排除在外）
    // 先跑 Tier-1 规划调度（预算内按优先级消化重规划请求），再推进冲锋：
    // 当帧拿到的规划结果当帧生效，与旧同步路径的时序保持一致
    processDeathChargePlanQueue(time);
    playerSquads.slice().forEach(squad => {
      squad.members.slice().forEach(member => {
        if (member.charging) updatePlayerMemberCharge(member, time, delta);
      });
    });
    modulePerf.last.playerNavMs = performance.now() - perfNavStart;
    // 小队再无存活队员：立刻结束这支小队的出战状态（阵亡队员的自爆动画仍会继续演完，
    // 因此要等最后一名队员的冲锋自爆落地、members 清空后才退役整支小队）
    playerSquads.slice().forEach(squad => {
      if (squad.unit && squad.unit.isSpawned && squad.members.length === 0) {
        handlePlayerSquadWipe(squad);
      }
    });
    // 出生动画期间：体型由小到大淡入，落地光环向外扩散，动画播完才允许行动
    if (hasActivePlayerSpawnAnimation()) {
      updatePlayerSpawnAnimation(time);
    } else {
      updateSpawnBeaconIdle(time);
    }
    // 出生界面：按钮永远固定在屏幕左上角，点数与进度每帧刷新
    updateSpawnHud(time, delta);
    // 一局时长推进与胜负判定：截止时刻全部任务完成才胜利。
    // WG 模式下任务=（坚持 8 分钟 + 番茄>0），与旧判定 endMatch(S.tomatoCount > 0) 严格等价；
    // WG2 追加大桥任务（见 mission.js）。场景暂停时不累计
    if (!S.gameEnded) {
      S.matchElapsedMs += delta;
      if (S.matchElapsedMs >= MATCH_DURATION_MS) {
        endMatch(allTasksComplete());
      }
    }
    playerSquads.forEach(squad => {
      if (squad.unit.isMoving && squad.unit.body &&
          Math.abs(squad.unit.body.velocity.x) > 0.01) {
        setPlayerFacing(squad, squad.unit.body.velocity.x < 0);
      }
    });
    S.selectionCircle.clear();
    S.attackRangeGraphics.clear();
    let selectionVisible = false;
    let attackRangeVisible = false;
    playerSquads.forEach(squad => {
      if (!squad.unit.isSpawned || !squad.unit.isSelected) return;
      // 每名存活队员脚下各自一个蓝色圆环，阵型拉开或挤压时都能看清选中范围
      const ringMembers = getLivingPlayerMembers(squad);
      if (ringMembers.length) {
        selectionVisible = true;
        S.selectionCircle.lineStyle(2, 0x3da9ff, 0.95);
        S.selectionCircle.fillStyle(0x3da9ff, 0.18);
        // 脚下圆环尺寸按该兵种记录读取（TankM1 坦克 140×60，步兵 37.5×17），
        // 大型单位的选中圆环随之放大，与车身实际显示尺寸一致
        const ringRecord = getPlayerUnitRecord(squad.unitKey || 'jf');
        const ringWidth = ringRecord.ring_width || PLAYER_RING_WIDTH;
        const ringHeight = ringRecord.ring_height || PLAYER_RING_HEIGHT;
        const ringOffsetY = ringRecord.ring_offset_y === undefined
          ? PLAYER_RING_OFFSET_Y : ringRecord.ring_offset_y;
        ringMembers.forEach(member => {
          const ringX = member.character.x;
          const ringY = member.character.y + ringOffsetY;
          S.selectionCircle.fillEllipse(ringX, ringY, ringWidth, ringHeight);
          S.selectionCircle.strokeEllipse(ringX, ringY, ringWidth, ringHeight);
        });
      }
      attackRangeVisible = true;
      // 黑色边框的短宽白线组成的射程圆（线型由 drawAttackRangeMarkers 内部设置）；
      // 射程按该兵种记录读取（ELMO2 为 250，其余 300）。
      // 圆心绑定单位的实际显示位置（存活队员平均坐标，与选中圆环同一套存活口径）：
      // 被地形卡住时物理体与队员显示位置会分离，按物理体画圈会与单位脱节——
      // 队员显示在哪儿，射程圈就跟到哪儿；全员阵亡时回落到物理体位置
      let rangeCenterX = squad.unit.x;
      let rangeCenterY = squad.unit.y;
      if (ringMembers.length) {
        let sumX = 0;
        let sumY = 0;
        ringMembers.forEach(member => {
          sumX += member.character.x;
          sumY += member.character.y;
        });
        rangeCenterX = sumX / ringMembers.length;
        rangeCenterY = sumY / ringMembers.length;
      }
      drawAttackRangeMarkers(
        S.attackRangeGraphics, rangeCenterX, rangeCenterY,
        getPlayerUnitRecord(squad.unitKey || 'jf').action_range
      );
    });
    S.selectionCircle.setVisible(selectionVisible);
    S.attackRangeGraphics.setVisible(attackRangeVisible);
    // GustafAssist2 每帧视图：头顶倒三角浮动、选中环 + 射程标记、瞄准落点圈
    updateGustafSelectionView(this, time);
    // 小队血条与番号：始终跟在存活队员头顶上方（8 像素间隙，不遮挡人物）
    updatePlayerSquadHud();
    // 我方单位沙盒显示：选中态与实时血量逐帧同步（无选中时内部自动隐藏）
    if (S.sandboxPanelApi) S.sandboxPanelApi.update();

    // 出售表现：双击呼出后，在小队外面画一圈黄色细线圆环（圆环外 20 像素是淡黄色渲染带），
    // 圆环正下方放一个六边形「$」出售按钮。同一时刻只会有一支小队展开出售面板
    S.sellRingGraphics.clear();
    let sellIndex = 0;
    playerSquads.forEach(squad => {
      if (!squad.unit || !squad.unit.isSpawned || !squad.sellPanelOpen) return;
      const outerRadius = getPlayerSquadOuterRadius(squad);
      // 圆环在单位外沿之外再外扩 SELL_RING_CLEARANCE，避免压到角色身上、遮住单位显示；
      // 整体再上移 SELL_RING_OFFSET_Y，与角色视觉重心对齐
      const ringInnerEdge = outerRadius + SELL_RING_CLEARANCE;
      const ringRadius = ringInnerEdge + SELL_RING_WIDTH / 2;
      const ringOuterEdge = ringInnerEdge + SELL_RING_WIDTH;
      const ringCenterX = squad.unit.x;
      const ringCenterY = squad.unit.y - SELL_RING_OFFSET_Y;
      // 淡黄色渲染带：画在圆环外侧，不遮挡单位
      S.sellRingGraphics.lineStyle(SELL_GLOW_BAND, SELL_GLOW_COLOR, SELL_GLOW_ALPHA);
      S.sellRingGraphics.strokeCircle(ringCenterX, ringCenterY, ringOuterEdge + SELL_GLOW_BAND / 2);
      // 黄色圆环细线
      S.sellRingGraphics.lineStyle(SELL_RING_WIDTH, SELL_RING_COLOR, 1);
      S.sellRingGraphics.strokeCircle(ringCenterX, ringCenterY, ringRadius);
      if (sellIndex < S.sellButtons.length) {
        const entry = S.sellButtons[sellIndex++];
        entry.squad = squad;
        // 按钮直径 = 单位高度（2 × 外沿半径）× 比例，随小队实际大小协调缩放
        const diameter = outerRadius * 2 * SELL_BUTTON_HEIGHT_RATIO;
        entry.container.setScale(diameter / (SELL_BUTTON_RADIUS * 2));
        entry.container.setVisible(true);
        entry.container.setPosition(
          ringCenterX,
          ringCenterY + ringOuterEdge + SELL_BUTTON_GAP + diameter / 2
        );
      }
    });
    for (; sellIndex < S.sellButtons.length; sellIndex++) {
      S.sellButtons[sellIndex].container.setVisible(false);
      S.sellButtons[sellIndex].squad = null;
    }

    // GustafAssist2 选中：不画黄环 / 射程 / 屏蔽线，仅在单位正下方显示「炮弹」按钮
    // （直径为出售按钮的 2 倍）。冷却/点数不足时按钮压暗；进入瞄准后按钮层关闭
    if (S.gustafShellButton) {
      const showGustafButton = S.gustafSelected && !S.gustafAiming
        && S.gustafCharacter && S.gustafCharacter.active;
      S.gustafShellButton.container.setVisible(showGustafButton);
      if (showGustafButton) {
        S.gustafShellButton.container.setPosition(GUSTAF_X, GUSTAF_Y + GUSTAF_SHELL_BUTTON_OFFSET);
        S.gustafShellButton.icon.setTint(canGustafFire() ? 0xffffff : 0x777777);
      }
    }

    // 移动目标点标记：每支正在移动的小队一个「上实心蓝倒三角 + 下脚底圆环」组合目标点，
    // 显示数量与当前被选中小队数一致（框选/单选几支就显示几个，多出的标记隐藏）。
    // 倒三角在圆环正上方按 sin 上下浮动，抵达后随 moveTarget 清空一起隐藏
    {
      const bob = Math.sin(time * TARGET_MARKER_BOB_SPEED) * TARGET_MARKER_BOB_AMPLITUDE;
      let markerIndex = 0;
      playerSquads.forEach(squad => {
        if (!squad.unit || !squad.unit.isSpawned || !squad.moveTarget) return;
        if (markerIndex >= S.targetMarkers.length) return;
        const marker = S.targetMarkers[markerIndex++];
        marker.container.setVisible(true);
        marker.container.setPosition(squad.moveTarget.x, squad.moveTarget.y);
        marker.triangle.y = TARGET_MARKER_TRIANGLE_Y + bob;
      });
      for (; markerIndex < S.targetMarkers.length; markerIndex++) {
        S.targetMarkers[markerIndex].container.setVisible(false);
      }
    }

    // 集火标记：被集火敌方角色四角的红色圆角边线，沿各自对角方向向外/向内反复移动 2px。
    // 包围盒固定 50×50，中心对齐角色视觉中心（锚点上方 17 像素）
    S.focusMarkGraphics.clear();
    if (S.focusTarget && S.focusTarget.active && !S.focusTarget.charging &&
        S.focusTarget.character && S.focusTarget.character.active !== false) {
      const character = S.focusTarget.character;
      const cx = character.x;
      const cy = character.y + FOCUS_BRACKET_CENTER_OFFSET_Y;
      const half = FOCUS_BRACKET_SIZE * 0.5;
      const arm = FOCUS_BRACKET_ARM;
      const corner = FOCUS_BRACKET_RADIUS;
      const off = Math.sin(time * FOCUS_BRACKET_SPEED) * FOCUS_BRACKET_OFFSET;
      S.focusMarkGraphics.lineStyle(2, 0xff3333, 0.95);
      // 左上：角点 (cx - half - off, cy - half - off)，向外方向 (-1,-1)，括号开口朝右下
      drawFocusCornerBracket(S.focusMarkGraphics, cx - half - off, cy - half - off, -1, -1, arm, corner);
      // 右上：角点 (cx + half + off, cy - half - off)，向外方向 (1,-1)，括号开口朝左下
      drawFocusCornerBracket(S.focusMarkGraphics, cx + half + off, cy - half - off, 1, -1, arm, corner);
      // 左下：角点 (cx - half - off, cy + half + off)，向外方向 (-1,1)，括号开口朝右上
      drawFocusCornerBracket(S.focusMarkGraphics, cx - half - off, cy + half + off, -1, 1, arm, corner);
      // 右下：角点 (cx + half + off, cy + half + off)，向外方向 (1,1)，括号开口朝左上
      drawFocusCornerBracket(S.focusMarkGraphics, cx + half + off, cy + half + off, 1, 1, arm, corner);
      S.focusMarkGraphics.strokePath();
    }

    // 排队的曲线绕行规划：按帧时间预算推进，多支小队同帧下达指令时不再一次性卡住整帧。
    // 放在移动主循环之前，本帧刚规划好的路径可以立刻被下面的循环使用
    processPlayerPathQueue(scene, time);

    // --------------------------------------------------
    // 逻辑 1：RTS 玩家单位移动与到达距离容差控制（逐小队独立结算）
    // --------------------------------------------------
    playerSquads.forEach(squad => {
      const unit = squad.unit;
      if (!unit.isSpawned || !squad.moveTarget) return;
      // 被冲刺撞中的小队陷入待机：期间原地站定（姿态由动画刷新逻辑维持在 wait），不移动
      if (time < (squad.stunUntil || 0)) {
        unit.body.stop();
        unit.isMoving = false;
        return;
      }
      const origin = { x: unit.x, y: unit.y };
      const stepBudget = Math.max(0.6, UNIT_SPEED * delta / 1000);
      const arriveDistance = Math.max(PLAYER_RED_ARRIVE_DISTANCE, stepBudget * 1.02);
      let waypoint = squad.detourPath[0] || squad.moveTarget;
      if (Phaser.Math.Distance.Between(origin.x, origin.y, waypoint.x, waypoint.y) <= arriveDistance) {
        squad.detourPath.shift();
        waypoint = squad.detourPath[0] || null;
      }
      if (!waypoint) {
        unit.body.reset(squad.moveTarget.x, squad.moveTarget.y);
        squad.moveTarget = null;
        squad.detourPath = [];
        unit.isMoving = false;
        squad.replanKey = null;
        resetPlayerMoveProgress(squad, time);
        // 到达待机位置：开局召唤（SF / Agent）此刻才触发召唤动画（skill2），
        // 播到记录登记的延时分身落地（见 updatePlayerSquad 的 cloneSummon 处理）
        if (squad.pendingSummon) {
          playPlayerAttackAnimation(squad, squad.pendingSummon.animation);
          squad.cloneSummon = {
            startedAt: time,
            delay: squad.pendingSummon.delay,
            count: squad.pendingSummon.count
          };
          squad.pendingSummon = null;
        }
      } else if (updatePlayerMoveProgress(squad, time)) {
        // 终点在死角里、已经贴到最近的可站位置：本帧不再驱动移动
      } else {
        let steer = getShieldSteeringTarget(origin, waypoint, stepBudget);
        if (!steer) {
          // 当前朝向被屏蔽区净空带挡住：只在真正卡住时重新规划，且按冷却限流，
          // 避免「同一个位置反复失败 → 逐帧全量寻路」把主线程拖死
          const replanKey = `${Math.round(origin.x)}:${Math.round(origin.y)}:` +
            `${Math.round(waypoint.x)}:${Math.round(waypoint.y)}`;
          if (replanKey !== squad.replanKey && time >= squad.replanAt) {
            squad.replanKey = replanKey;
            squad.replanAt = time + PLAYER_RED_REPLAN_COOLDOWN;
            const replanned = getShortestPlayerPath(origin, squad.moveTarget);
            if (replanned && replanned.length) {
              squad.detourPath = replanned;
              waypoint = squad.detourPath[0];
              steer = getShieldSteeringTarget(origin, waypoint, stepBudget);
            }
          }
        }
        if (!steer) {
          // 冷却期间也必须继续走：先沿路径往前收敛到一个当前位置可直达的节点（跳过被净空带
          // 挡住的拐点），再退回以最终终点为参照求一次转向。不用「朝最终终点重转向」当第一兜底——
          // 绕行途中最终终点在轮廓另一侧，方向与当前拐点相反，会拉着单位反向横跳
          const reachable = getReachablePathNode(squad, origin);
          if (reachable) {
            waypoint = reachable;
            steer = getShieldSteeringTarget(origin, waypoint, stepBudget);
          }
          if (!steer && waypoint !== squad.moveTarget) {
            steer = getShieldSteeringTarget(origin, squad.moveTarget, stepBudget);
          }
        }
        if (!steer) {
          unit.body.stop();
          unit.isMoving = false;
        } else {
          squad.replanKey = null;
          unit.isMoving = true;
          scene.physics.moveToObject(unit, steer, UNIT_SPEED);
          setPlayerFacing(squad, steer.x < unit.x);
        }
      }
    });

    // 本帧移动状态确定后统一下发动画；攻击动画播放期间由锁保护，不会被这里打断
    playerSquads.forEach(squad => refreshPlayerAnimation(squad));

    // 逻辑 2：玩家单位自动索敌与攻击（未出兵的小队不参与战斗）。
    // 射程与攻击间隔按该兵种记录读取（ELMO2：射程 250 / 间隔 0.4s，其余 300 / 0.5~0.6s）。
    // 移动开火：登记了 attack_while_moving 的兵种（TankM1 坦克）在行进中同样自动开火，
    // 且只锁定「行进方向正面射界内」的敌人（attack_while_moving_arc 为射界半角，未填 = 不限方向），
    // 这样坦克一路推进时会自动打正前方的目标；其余兵种保持原有规则——只有站定才能开火
    playerSquads.forEach(squad => {
      const unit = squad.unit;
      const unitRecord = getPlayerUnitRecord(squad.unitKey || 'jf');
      if (!unit.isSpawned || time < unit.nextAttackAt) return;
      // 被冲刺撞中的小队陷入待机：期间停止攻击（眩晕结束后恢复正常交火节奏）
      if (time < (squad.stunUntil || 0)) return;
      const moveFire = unit.isMoving && (unitRecord.attack_while_moving || 0) === 1;
      if (unit.isMoving && !moveFire) return;
      // 正面射界半角换算成余弦阈值：squad.forward 是逐帧平滑并归一化后的行进方向，
      // 与「指向目标的单位向量」做点积即可判断目标是否落在射界内；-1 表示不限方向
      const arcDegrees = unitRecord.attack_while_moving_arc;
      const arcCos = moveFire && Number.isFinite(arcDegrees) && arcDegrees > 0
        ? Math.cos(Math.min(180, arcDegrees) * Math.PI / 180)
        : -1;
      let closestEnemy = null;
      let minDistance = unitRecord.action_range;
      // 攻击范围判定按每名队员自身的渲染位置结算（不再用队形锚点——阵型展开后
      // 队员与锚点可偏差 60 像素以上，锚点判定会出现「人在圈内挨打/圈外开火」的错位）。
      // 重装单位（队员碰撞半径 >= 50，TankM1 / Ares / Warjack）的判定圈向外扩大 10 像素
      const HEAVY_MEMBER_RADIUS_THRESHOLD = 50;
      const HEAVY_RANGE_JUDGMENT_MARGIN = 10;
      const living = getLivingPlayerMembers(squad);
      const memberJudgment = living.map(member => ({
        member,
        x: member.character.x,
        y: member.character.y,
        radius: unitRecord.action_range +
          ((member.body ? member.body.radius : 0) >= HEAVY_MEMBER_RADIUS_THRESHOLD
            ? HEAVY_RANGE_JUDGMENT_MARGIN : 0),
        // 近战（Warjack）：判定距离 = 队员碰撞体半径 + 敌方碰撞体半径 + melee_range
        meleeReach: squad.meleeAnimation && squad.meleeRange !== null
          ? (member.body ? member.body.radius : (unitRecord.member_collision_radius || PLAYER_MEMBER_COLLISION_RADIUS)) +
            ENEMY_COLLISION_RADIUS + squad.meleeRange
          : 0
      }));
      let meleeEnemy = null;
      let meleeEnemyDistance = Infinity;

      S.enemiesGroup.getChildren().forEach(enemy => {
        if (!enemy.active || enemy.charging) return;
        // 逐队员判定：任一队员的判定圈罩住该敌人即可攻击，并以该队员的位置
        // 作为红区直线与正面射界的判定基准
        let bestMember = null;
        let bestDist = Infinity;
        memberJudgment.forEach(entry => {
          const dist = Phaser.Math.Distance.Between(entry.x, entry.y, enemy.x, enemy.y);
          if (dist < entry.radius && dist < bestDist) {
            bestDist = dist;
            bestMember = entry;
          }
        });
        if (!bestMember) return;
        if (bestDist < bestMember.meleeReach && bestDist < meleeEnemyDistance &&
            !isRedZonePathCrossed(bestMember.x, bestMember.y, enemy.x, enemy.y)) {
          meleeEnemy = enemy;
          meleeEnemyDistance = bestDist;
        }
        // 移动开火：目标必须落在行进方向的正面射界内（坦克不会边跑边朝背后甩炮）
        if (arcCos > -1) {
          const dot = ((enemy.x - bestMember.x) * squad.forward.x +
            (enemy.y - bestMember.y) * squad.forward.y) / (bestDist || 1);
          if (dot < arcCos) return;
        }
        // 红色屏蔽区判定：我方与目标之间的直线只要穿过屏蔽区就无法攻击该目标，
        // 该目标直接跳过（会自动改打其他直线畅通的目标）
        if (isRedZonePathCrossed(bestMember.x, bestMember.y, enemy.x, enemy.y)) return;
        // 集火目标优先：射程覆盖它的我方单位一律优先攻击它（不区分是否被选中）
        if (enemy === S.focusTarget) {
          closestEnemy = enemy;
          minDistance = bestDist;
        } else if (!closestEnemy && bestDist < minDistance) {
          minDistance = bestDist;
          closestEnemy = enemy;
        }
      });

      // 近战优先：身边就有敌人时先招呼近战（数值与远程攻击同一套：同样的伤害公式、
      // 同样的攻击间隔，只是无视护甲、不开炮、命中即结算）。
      // 近战的挥击动作不受「行进中不改写动画」限制——贴身缠斗时动作本身就是最直接的反馈，
      // 且同一条动作未播完时不会重复下发（见 playPlayerAttackAnimation）
      if (meleeEnemy) {
        // 贴身近战豁免面向判定（attack_facing_required 只约束远程开火）：
        // 贴脸的敌人先转身再挥击（attack_SP 动画本身就是转向反馈），等瞄准延迟会让 Warjack 背对敌人干挨打
        if (!unit.isMoving) setPlayerFacing(squad, meleeEnemy.x < unit.x);
        damageEnemy(scene, meleeEnemy, computeMeleeDamage(unitRecord, ACTIVE_ENEMY_RECORD));
        unit.nextAttackAt = time + unitRecord.action_cd * 1000;
        playPlayerAttackAnimation(squad, squad.meleeAnimation);
        return;
      }

      if (closestEnemy) {
        const enemyIsLeft = closestEnemy.x < unit.x;
        // 面向判定（登记了 attack_facing_required 的兵种：Ares / Warjack）：
        // 目标不在面向方向时先自动转身，并等一个完整攻击间隔再打（转身 + 瞄准延迟），
        // 转好面向后每个攻击周期正常开火。朝向按当前 scaleX 实时读取（isPlayerSquadFacingLeft）
        if ((unitRecord.attack_facing_required || 0) === 1 &&
            isPlayerSquadFacingLeft(squad) !== enemyIsLeft) {
          setPlayerFacing(squad, enemyIsLeft);
          unit.nextAttackAt = time + unitRecord.action_cd * 1000;
          return;
        }
        // 站定开火才把朝向转向目标；行进中的朝向由移动逻辑维持（正面射界已保证目标就在前方），
        // 在这里翻转会让坦克一边前进一边掉头
        if (!unit.isMoving) setPlayerFacing(squad, enemyIsLeft);
        // 攻击方式按该兵种记录分两种：
        //   登记了攻击弹丸尺寸的重装单位（TankM1 / Ares / Warjack）-> 发射炮弹
        //   （登记了 attack_blast_radius 的按落点结算范围伤害，没登记的只在落点打单体）
        //   其余兵种 -> 队员齐射，单发伤害按「该兵种记录 vs 敌方记录」实时结算
        // 两种方式的攻击间隔、伤害公式与攻击动画完全相同，只是伤害结算的时机与范围不同
        if ((unitRecord.attack_projectile_size || 0) > 0) {
          fireAttackShell(scene, squad, closestEnemy, unitRecord, living[0]);
        } else {
          const volleyDamage = living.length * computeArmorDamage(unitRecord, ACTIVE_ENEMY_RECORD);
          damageEnemy(scene, closestEnemy, volleyDamage);
        }
        unit.nextAttackAt = time + unitRecord.action_cd * 1000;
        // 行进中开火不改写动画：坦克的 skill1 长 2.53 秒，几乎与 2.8 秒的攻击间隔等长，
        // 若行进中也像站定开火那样接管动画，会与移动动画每 2.8 秒互相打断一次（动画反复闪跳）；
        // 行进中保持移动动画，开火反馈由炮弹出膛与命中爆炸承担
        if (!unit.isMoving) playPlayerAttackAnimation(squad);
      }
    });

    // --------------------------------------------------
    // 逻辑 2b：WG2 大桥集火攻击（仅玩家点击桥体标记集火后生效）。
    // 无敌方目标可打且桥被集火时，射程覆盖桥面的我方单位按同一套
    // 攻击节奏开火；攻击槽位消耗、伤害结算全部在桥体钩子内部处理
    // --------------------------------------------------
    if (S.bridgeFocused && !S.bridgeDestroyed && window.__WG2_BRIDGE__) {
      playerSquads.forEach(squad => {
        const unit = squad.unit;
        const unitRecord = getPlayerUnitRecord(squad.unitKey || 'jf');
        if (!unit.isSpawned || time < unit.nextAttackAt) return;
        if (time < (squad.stunUntil || 0)) return;
        const moveFire = unit.isMoving && (unitRecord.attack_while_moving || 0) === 1;
        if (unit.isMoving && !moveFire) return;
        // 行进开火的正面射界约束同样适用于桥体（与打敌方同一套判定）
        const arcDegrees = unitRecord.attack_while_moving_arc;
        const arcCos = moveFire && Number.isFinite(arcDegrees) && arcDegrees > 0
          ? Math.cos(Math.min(180, arcDegrees) * Math.PI / 180)
          : -1;
        const living = getLivingPlayerMembers(squad);
        const memberJudgment = living.map(member => ({
          member,
          x: member.character.x,
          y: member.character.y,
          radius: unitRecord.action_range +
            ((member.body ? member.body.radius : 0) >= 50 ? 10 : 0)
        }));
        if (arcCos > -1) {
          const rect = window.__WG2_BRIDGE__.getRect();
          const dx = (rect.minX + rect.maxX) / 2 - unit.x;
          const dy = (rect.minY + rect.maxY) / 2 - unit.y;
          const dot = (dx * squad.forward.x + dy * squad.forward.y) / (Math.hypot(dx, dy) || 1);
          if (dot < arcCos) return;
        }
        window.__WG2_BRIDGE__.tryAttack(scene, squad, unit, unitRecord, living, memberJudgment, time);
      });
    }

    // --------------------------------------------------
    // 逻辑 3：敌军沿着 Waypoints 路线自动寻路
    // --------------------------------------------------
    // 【分段耗时采样】敌军追击 / 攻击 / 行军主循环 + 碰撞隔离段（见文件上方 modulePerf 说明）
    const perfCombatStart = performance.now();
    updateEnemyBars(time);   // 敌方血条：每帧统一重绘（共享 Graphics，视野内 + 已受伤）
    // 视野矩形整帧只读一次（此前每敌方读一次，130 单位下是纯重复读取）
    const frameView = S.gameScene.cameras.main.worldView;
    S.enemiesGroup.getChildren().forEach(enemy => {
      if (!enemy.active) return;

      // 血条耗尽的敌人：原地泛红 -> 满 3 秒原地自爆，期间不再走路线逻辑
      if (enemy.charging) {
        updateEnemyDeath(enemy, time);
        return;
      }

      // 被自爆击退：先按匀速位移推进本帧的击退步长（落点照旧过可行走 + 红区安全带校验），
      // 再进入本帧的追踪 / 行军逻辑，被炸飞的单位本身不会因此中断自己的行动
      updateEnemyKnockback(enemy, delta);

      enemy.character.setPosition(enemy.x, enemy.y);

      // 番茄防线：敌方单位踏入我方出生点范围即突破一次（每个单位一生只计一次）。
      // 先做 AABB 快筛再算平方距离，130 单位下每帧只是几次浮点比较
      if (!S.gameEnded && !enemy.leaked && !enemy.charging && enemy.routeState !== 'entering') {
        const leakDX = enemy.x - SPAWN_POINT_X;
        const leakDY = enemy.y - SPAWN_POINT_Y;
        if (leakDX * leakDX + leakDY * leakDY < TOMATO_LEAK_RADIUS * TOMATO_LEAK_RADIUS) {
          enemy.leaked = true;
          registerTomatoLeak(enemy);
          // 突破的敌军已在 registerTomatoLeak 里当场销毁（character/body 已置空并移出编队）：
          // 本帧剩余处理必须全部跳过，否则后面的视野剔除 / 状态机会摸到空引用抛 TypeError，
          // 异常每帧中断整个 update，表现就是游戏进程卡死
          return;
        }
      }

      // 性能：视野剔除——视野外的骨架不参与渲染（AI 与数值照常运算），
      // 130 单位分散在 3795×3026 的地图上，任一时刻视野内通常只有一部分，
      // GPU 与显示列表只处理看得见的单位。附带 120 像素余量防止边缘闪烁
      const view = frameView;
      const onScreen = enemy.x > view.x - 120 && enemy.x < view.right + 120 &&
        enemy.y > view.y - 120 && enemy.y < view.bottom + 120;
      if (enemy.viewVisible !== onScreen) {
        enemy.viewVisible = onScreen;
        enemy.character.setVisible(onScreen);
        // 视野外同时冻结骨骼动画推进（Spine 每帧的 CPU 侧主要开销：动画状态 +
        // 骨骼世界变换，130 骨架下远超逻辑成本）：用空函数替换实例 update，
        // 回到视野内恢复原型方法，动画从冻结处继续播放
        enemy.character.update = onScreen ? S.spineUpdateOriginal : offscreenNoopUpdate;
      }

      // 追踪 / 交火的距离参照：到「最近的存活队员」的距离（与追踪目标点同源），
      // 因此判定射程与开火命中始终指向同一名队员
      const trackGap = getEnemyTrackGap(enemy);
      // 入场阶段：出生点在地图外，此时不做可行走/红区判定，也不参与追击与交火，
      // 只沿入场线走向该路线第一个地图内的节点，走进地图后切回常规路线推进
      if (enemy.routeState === 'entering') {
        const entry = getSafeRouteTarget(enemy);
        if (!entry) {
          // 这条变体没有一个可走的节点：不进入待机循环，直接转入终点自由待机
          beginEnemyEndpointRoam(enemy, time);
          return;
        }
        enemy.waypointIndex = entry.index;
        if (isEnemyPoseWalkable(enemy) ||
            Phaser.Math.Distance.Between(enemy.x, enemy.y, entry.target.x, entry.target.y) < 6) {
          enemy.routeState = 'following';
          enemy.replanTargetKey = null;
          enemy.replanAttemptedKey = null;
        } else if (hasSpawnedPlayerSquad() && trackGap <= enemy.trackRange &&
                   enemy.x >= 0 && enemy.x <= WORLD_WIDTH &&
                   enemy.y >= 0 && enemy.y <= WORLD_HEIGHT) {
          // 兜底：已经走进地图范围（只是当前踩在不可行走的格子上）时，我方人形进入跟踪范围
          // 也要立刻转入追踪交火，避免出现「明明进了射程却只顾赶路、不进攻击逻辑」的空档
          beginEnemyTrack(enemy, time);
          updateEnemyTracking(enemy, time, trackGap, delta);
        } else {
          advanceEnemyTowards(enemy, entry.target, delta);
          syncEnemyFacing(enemy, entry.target);
          setEnemyAnimation(enemy, 'move', true);
        }
        enemy.character.setPosition(enemy.x, enemy.y);
        return;
      }
      // 行动点待机期间先做一次判定：玩家已进入追踪范围就转入追踪，路线被红区挡住就提前改道
      if (enemy.routeState === 'holding') {
        decideEnemyActionPoint(enemy, time, trackGap);
      }
      // 追踪状态独立处理：按 300 像素/秒逼近锁定的我方队员，追到交火距离边缘（100 像素）
      // 就停下交火——人在交火带内姿态恒为攻击动作，重新进入也不经过等待动作；
      // 拉出交火带（100 + 12 = 112 像素）就立刻打断攻击动画转入移动动画；
      // 只有拉开到追踪范围 + 迟滞带（160 + 16 = 176 像素）之外才放弃追踪，
      // 随即从当前位置走向下一个行动点
      if (enemy.routeState === 'tracking') {
        updateEnemyTracking(enemy, time, trackGap, delta);
        enemy.character.setPosition(enemy.x, enemy.y);
        return;
      }
      // 我方单位还没出生时敌军不会对出生点发起攻击；
      // 玩家一进入追踪范围就立即转入智能追踪（逼近还是开火由追踪逻辑按距离决定），
      // 没有任何冷却等待，所以不会出现「明明在射程内却站着不动」的迟滞
      if (hasSpawnedPlayerSquad() && trackGap <= enemy.trackRange) {
        beginEnemyTrack(enemy, time);
        updateEnemyTracking(enemy, time, trackGap, delta);
        enemy.character.setPosition(enemy.x, enemy.y);
        return;
      }

      let currentTarget;
      if (enemy.routeState === 'holding') {
        enemy.body.stop();
        setEnemyAnimation(enemy, 'wait', true);
        // 待机期间发现下一路线节点被红区挡住，就提前转入绕行（不等待机结束）
        const nextRoutePoint = getEnemyNextRoutePoint(enemy);
        const holdingPathBlocked = nextRoutePoint && (
          !isEnemyPoseWalkable(enemy) ||
          !isRedZoneClearanceSafePath({ x: enemy.x, y: enemy.y }, nextRoutePoint)
        );
        if (holdingPathBlocked && replanEnemyToNextPoint(enemy, nextRoutePoint, time)) {
          enemy.routeState = 'detouring';
          currentTarget = enemy.detourPath[0];
        } else if (time < enemy.holdUntil) {
          return;
        } else {
          // 待机结束：先做两轮「周身随机移动」，再回到主路线继续推进
          enemy.replanTargetKey = null;
          enemy.roamTarget = chooseEnemyRoamTarget(enemy);
          if (!enemy.roamTarget) {
            beginEnemyHold(enemy, time);
            return;
          }
          enemy.routeState = 'roaming';
        }
      }

      if (enemy.detourPath.length) {
        currentTarget = enemy.detourPath[0];
        if (Phaser.Math.Distance.Between(enemy.x, enemy.y, currentTarget.x, currentTarget.y) < 6) {
          enemy.detourPath.shift();
          if (!enemy.detourPath.length) {
            enemy.routeState = 'following';
            enemy.replanTargetKey = null;
            enemy.replanAttemptedKey = null;
            currentTarget = getEnemyNextRoutePoint(enemy);
            if (!currentTarget) {
              beginEnemyEndpointRoam(enemy, time);
              return;
            }
          } else {
            currentTarget = enemy.detourPath[0];
          }
        }
      } else if (enemy.routeState === 'roaming') {
        currentTarget = enemy.roamTarget;
        // 巡逻硬约束：任何原因（沿红区滑动、绕行、被友军推挤）导致越出行动点
        // ENEMY_PATROL_RADIUS 范围（隔离推挤再留 45 像素余量）时，立刻把目标改回行动点，
        // 队伍只会折返而不会越跑越远
        if (currentTarget && enemy.actionPointX != null) {
          const fromActionPoint = Phaser.Math.Distance.Between(
            enemy.x, enemy.y, enemy.actionPointX, enemy.actionPointY
          );
          if (fromActionPoint > ENEMY_PATROL_RADIUS + ENEMY_PATROL_SLACK) {
            enemy.roamTarget = { x: enemy.actionPointX, y: enemy.actionPointY };
            currentTarget = enemy.roamTarget;
          }
        }
        if (Phaser.Math.Distance.Between(enemy.x, enemy.y, currentTarget.x, currentTarget.y) < 6) {
          enemy.holdCycles++;
          if (enemy.holdCycles >= 2) {
            enemy.holdCycles = 0;
            if (enemy.routeFinished) {
              beginEnemyEndpointRoam(enemy, time);
              return;
            }
            // 从行动点出发：重新随机挑一条走廊变体，多支敌军不会挤在同一条线上
            rerollEnemyRoute(enemy);
            enemy.routeState = 'following';
            enemy.roamTarget = null;
          } else {
            beginEnemyHold(enemy, time);
          }
          return;
        }
      } else if (enemy.routeState === 'endpoint') {
        // 终点待机的静止阶段：只站桩，不做任何移动计算；静止到期后在终点待机区域里挑下一个落点
        enemy.body.stop();
        setEnemyAnimation(enemy, 'wait', true);
        // 被推到待机区域之外（挤到地图边缘死角、被追踪带走等）时不在这里空等，直接沿路线走回终点
        if (isEnemyFarFromTerminal(enemy) && resumeEnemyRouteToTerminal(enemy)) return;
        if (time < enemy.idleUntil) return;
        const endpointSpot = chooseEnemyEndpointRoamTarget(enemy);
        if (!endpointSpot) {
          // 终点区域暂时挑不出合法落点（红区、边界或友军占满）：再静止一轮
          enemy.idleUntil = time + ENEMY_ENDPOINT_IDLE_MAX;
          return;
        }
        enemy.roamTarget = endpointSpot;
        enemy.routeState = 'endpointRoam';
        currentTarget = endpointSpot;
      } else if (enemy.routeState === 'endpointRoam') {
        // 终点自由待机：在终点 ENEMY_ENDPOINT_ROAM_RADIUS 像素范围内散步，
        // 走到落点就回到静止阶段。越出待机区域（隔离推挤再留一点余量）立刻折返终点，
        // 队伍始终待在终点区域里，不会顺着隔离推挤一路漂出去
        currentTarget = enemy.roamTarget;
        if (!currentTarget) {
          beginEnemyEndpointIdle(enemy, time);
          return;
        }
        // 已经被带到待机区域之外时先回位：沿路线走回终点比朝终点直线插过去更稳（直线可能横穿红区）
        if (isEnemyFarFromTerminal(enemy) && resumeEnemyRouteToTerminal(enemy)) return;
        if (Phaser.Math.Distance.Between(enemy.x, enemy.y, enemy.terminalX, enemy.terminalY) >
            ENEMY_ENDPOINT_ROAM_RADIUS + ENEMY_PATROL_SLACK) {
          enemy.roamTarget = { x: enemy.terminalX, y: enemy.terminalY };
          currentTarget = enemy.roamTarget;
        }
        if (Phaser.Math.Distance.Between(enemy.x, enemy.y, currentTarget.x, currentTarget.y) < 6) {
          beginEnemyEndpointIdle(enemy, time);
          return;
        }
      } else {
        const routeTarget = getSafeRouteTarget(enemy);
        if (!routeTarget) {
          beginEnemyEndpointRoam(enemy, time);
          return;
        }
        enemy.waypointIndex = routeTarget.index;
        currentTarget = routeTarget.target;
        const dist = Phaser.Math.Distance.Between(enemy.x, enemy.y, currentTarget.x, currentTarget.y);
        // 正常以 6 像素判抵达；点被友军占住时（相距不到半个隔离距离）也算抵达，
        // 否则被推挤顶在点外的单位会一直围着这个点抖动，后方队伍跟着一起堵死
        if (dist < 6 || (dist < ENEMY_SEPARATION_DISTANCE * 1.5 && isRoutePointClaimed(enemy, currentTarget))) {
          const reachedIndex = enemy.waypointIndex;
          enemy.waypointIndex++;
          if (enemy.waypointIndex >= enemy.route.length) {
            // 最后一个节点是该路线的终点：到达后不再销毁敌人，
            // 转入「终点 375 像素范围内自由待机」，而不是钉死在这一个点上互相推挤
            beginEnemyEndpointRoam(enemy, time);
            return;
          }
          // 首节点是地图外的入场节点，不计入「每经过两个点位待机一次」的推进节奏
          if (reachedIndex > ENEMY_ROUTE_ENTRY_COUNT &&
              (reachedIndex - ENEMY_ROUTE_ENTRY_COUNT) % 2 === 0) {
            // 每经过两个点位进行两轮“待机五秒 -> 周身随机移动”。
            beginEnemyHold(enemy, time, true);
            return;
          }
          currentTarget = enemy.route[enemy.waypointIndex];
        }
      }

      const wantsMove = Boolean(currentTarget);
      // 直线净空就直接朝目标点走；接近屏蔽区时改走沿红区外沿的滑动点，避免撞上红区急停
      const steeredTarget = wantsMove ? steerEnemyTowards(enemy, currentTarget, delta) : null;
      if (steeredTarget) {
        advanceEnemyTowards(enemy, steeredTarget, delta);
        // 以实际行进方向同步镜像；这一步没有产生位移时才使用路线目标作为后备。
        syncEnemyFacing(enemy, currentTarget);
        setEnemyAnimation(enemy, 'move', true);
      } else {
        enemy.body.stop();
        setEnemyAnimation(enemy, 'wait', true);
        // 站位本身落在不可行走区域时先走出去：否则本帧之后的一切地形判定都会因非法起点判死
        if (stepEnemyOutOfUnwalkable(enemy, delta)) {
          enemy.character.setPosition(enemy.x, enemy.y);
          return;
        }
        if (enemy.routeState === 'roaming') {
          beginEnemyHold(enemy, time);
        } else if (enemy.routeState === 'endpointRoam') {
          // 终点的落点走不过去（被红区或友军挡住）：放弃这个点，静止一轮后再挑
          beginEnemyEndpointIdle(enemy, time);
        } else if (currentTarget) {
          // 行进或待机时碰撞屏蔽区时改走最短安全绕行曲线（内部带重试冷却）
          if (replanEnemyToNextPoint(enemy, currentTarget, time) && enemy.routeState === 'following') {
            enemy.routeState = 'detouring';
          }
        }
      }
      // 卡顿兜底：想走却长时间几乎没有位移说明被屏蔽区或边界卡住，
      // 清掉绕行缓存强制重规划一次；仍然无解就跳过当前路线点，避免敌军永久停在原地。
      // 终点自由待机不做重规划——换一个落点比画绕行曲线更省事，也不会把绕行路径甩到待机区域之外
      if (isEnemyStuck(enemy, time, wantsMove)) {
        if (enemy.routeState === 'endpointRoam') {
          beginEnemyEndpointIdle(enemy, time);
          enemy.character.setPosition(enemy.x, enemy.y);
          return;
        }
        enemy.detourPath = [];
        enemy.replanAttemptedKey = null;
        if (!replanEnemyToNextPoint(enemy, currentTarget, time, true) && enemy.routeState === 'following') {
          const skipped = getSafeRouteTarget(enemy);
          if (skipped) enemy.waypointIndex = skipped.index + 1;
        }
      }
      enemy.character.setPosition(enemy.x, enemy.y);
    });

    // 逻辑 3.5：敌方单位的碰撞隔离——在全部单位完成本帧位移之后统一推挤一次，
    // 避免多个单位沿同一条走廊行军时叠在一起（推挤落点同样经过可行走与红区安全带校验）
    // 【细分埋点】碰撞隔离单独计量：满场单位时的 enemyCombat 段嫌疑之一
    const sepStartedAt = performance.now();
    separateEnemies();
    modulePerf.sub.sepMs += performance.now() - sepStartedAt;
    modulePerf.last.enemyCombatMs = performance.now() - perfCombatStart;

    // 帧末：多部件单位（Warjack）的附加渲染层与主体对齐——主体在本帧被阵型、归队、
    // 冲锋、出生动画、朝向翻转改动的位置 / 缩放 / 透明度 / 可见性，统一在帧末同步一次，
    // 附加层不需要在各处逻辑里单独处理
    playerSquads.forEach(squad => squad.members.forEach(syncPlayerMemberParts));
    // 【分段耗时采样】整帧耗时与 1 秒窗口汇总（帧均值 / 峰值 / FPS）
    modulePerf.last.updateMs = performance.now() - perfUpdateStart;
    recordModulePerfWindow(time);
  }

export { preload, create, update };
