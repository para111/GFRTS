// ============================================================
// wg_game 模块化拆分 —— records.js
// 职责: 单位配置记录读取（unit_db 口径）
// 来源: wg_game.js 语句区间 81-7951（自动拆分，勿手工重排语句顺序）
// ============================================================

import { S } from './S.js';
import { ACTIVE_ENEMY_RECORD, ACTIVE_PLAYER_RECORD, ENEMY_UNIT_RECORDS, PLAYER_POINTS_PER_MINUTE, PLAYER_SPAWN_KEYS, PLAYER_STAT_COLUMNS, PLAYER_UNIT_RECORDS, SPAWN_BUTTON_DEPLOY_COST, UNIT_DATABASE, playerSquads } from './state.js';


  // 按 unit_id 取一条单位记录（数据库为空或查不到时返回 null）
  function getUnitRecord(table, unitId) {
    const rows = UNIT_DATABASE[table] || [];
    return rows.find(row => row.unit_id === unitId) || null;
  }


  // 取现役单位的记录：查不到就直接报错，避免后面读到 undefined 才崩
  function requireUnitRecord(table, unitId) {
    const record = getUnitRecord(table, unitId);
    if (!record) {
      const message = `单位数据库缺少记录 ${table}.${unitId}，`
        + '请检查 unit_database.sql 后重新运行 build_unit_db.py。';
      window.alert(message);
      throw new Error(message);
    }
    return record;
  }

  function getEnemyUnitRecord(unitKey) {
    return ENEMY_UNIT_RECORDS[unitKey] || ACTIVE_ENEMY_RECORD;
  }

  function getPlayerUnitRecord(unitKey) {
    return PLAYER_UNIT_RECORDS[unitKey] || ACTIVE_PLAYER_RECORD;
  }


  // 读取记录里的数值列：列缺失、值为 NULL、不是数字、不满足范围约束都会立刻弹窗并抛错。
  // 宁可开局就停在明确的错误上，也不要让 undefined / NaN 混进几何与伤害计算里静默出错
  function readUnitNumber(record, label, column, options) {
    const opts = options || {};
    const value = record[column];
    const fail = reason => {
      const message = `单位数据库的 ${label}.${column} ${reason}。`
        + '请检查 unit_database.sql 后重新运行 build_unit_db.py。';
      window.alert(message);
      throw new Error(message);
    };
    if (value === undefined || value === null) fail('没有填值');
    if (typeof value !== 'number' || Number.isNaN(value)) fail(`不是数值（${String(value)}）`);
    if (opts.integer && !Number.isInteger(value)) fail('必须是整数');
    if (opts.min !== undefined && value < opts.min) fail(`小于允许的最小值 ${opts.min}`);
    if (opts.max !== undefined && value > opts.max) fail(`大于允许的最大值 ${opts.max}`);
    return value;
  }


  // 本线单位上限：开局 capBase 个，每 capGrowthMs 毫秒 +1，最终不超过 capMax
  function getRouteUnitCap(route, time) {
    return Math.min(
      route.capMax,
      route.capBase + Math.floor(Math.max(0, time - (route.startAt || 0)) / route.capGrowthMs)
    );
  }

  function getPlayerStatRatings() {
    if (S.playerStatRatings) return S.playerStatRatings;
    S.playerStatRatings = {};
    PLAYER_STAT_COLUMNS.forEach(([, column]) => {
      const values = PLAYER_SPAWN_KEYS
        .map(key => getPlayerUnitRecord(key)[column])
        .filter(value => typeof value === 'number')
        .sort((a, b) => a - b);
      const lowBound = values[Math.max(0, Math.floor(values.length / 3) - 1)];
      const highBound = values[Math.min(values.length - 1, Math.ceil(values.length * 2 / 3))];
      PLAYER_SPAWN_KEYS.forEach(key => {
        const value = getPlayerUnitRecord(key)[column];
        S.playerStatRatings[key + '.' + column] = value <= lowBound ? 0 : (value >= highBound ? 2 : 1);
      });
    });
    return S.playerStatRatings;
  }


  // 每分钟点数的实际获取速度：基础 120 减去「场上每个单位按 deploy_cost 削减的量」，
  // 因此出兵越多、场上单位越多，攒点越慢（步兵 10 / 重甲 30 / 支援 20，均取自数据库）
  function playerIncomePerMinute() {
    let deployedCost = 0;
    playerSquads.forEach(squad => {
      if (!squad.unit) return;
      const cost = SPAWN_BUTTON_DEPLOY_COST[squad.unitKey || 'jf'];
      if (cost) deployedCost += cost;
    });
    return Math.max(0, PLAYER_POINTS_PER_MINUTE - deployedCost);
  }


  // ----------------------------------------------------
  // 我方步兵小队：三名角色（Qiongjiu / Daiyan / Jiangyu）以正等边三角阵型合并为一个基本单位，
  // 队伍共用一个移动碰撞体（指令、寻路、索敌一律按整队结算），
  // 同时每名队员各自持有一个独立碰撞体（半径 34 像素的圆形判定体），
  // 分别做自己的红区净空、可行走与单位隔离判定；
  // 自由移动时阵型边长 113 像素，站位固定在屏幕上：Qiongjiu 在最上方、Daiyan 在最右边、
  // Jiangyu 在最左边，每次更改终点都会重新回到这一站位；
  // 贴到红色屏蔽区边缘时整队脱离队列自由移动（每名队员各自朝自己那份松散站位前进，
  // 各自贴着安全带绕行），整个队伍脱离红区后再平滑收拢回三角阵型；
  // 两种形态之间为平滑缓动过渡，队员之间绝对不允许小于 38 像素，
  // 最终渲染位置按 PLAYER_MEMBER_ANIM_MAX_STEP 限速缓动，修正量再大也不会跳变；
  // 队长 Daiyan 的属性、索敌与移动逻辑全部保留
  // ----------------------------------------------------
  // 运行时兼容处理：内置 SpinePlugin 的版本号是 "3.8.75"，但它的版本校验会把版本号
  // 恰好等于 "3.8.75" 的导出文件误判为“不受支持”。art/tr_ar 下三名角色正是 3.8.75
  // 导出的，因此在创建任何 Spine 对象之前先把缓存里的版本号归一化，否则资源会被拒绝解析。
  function normalizeSpineVersionTags(scene) {
    ['Daiyan', 'Jiangyu', 'Qiongjiu', 'Vespid',
     'Biyoca', 'Andoris', 'Groza',
     'Centaureissi', 'Sharkry', 'Tololo',
     'Cheeta', 'Lenna', 'Soumi', 'TankM1_1001',
     'Ares', 'Warjack_1009_Part1', 'Warjack_1009_Part2',
     'Macqiato', 'Nemesis', 'Agent', 'Clukay', 'Mishty',
     'Guard', 'Striker', 'Aegis', 'Jaeger', 'Ripper', 'Prowler',
     'Smasher', 'Kratos', 'Zombie1', 'Zombie2', 'Strelet',
     'Brute_SWAP', 'Doppelsoldner', 'Fortress', 'Hydra_Deutsch', 'Cerynitis'].forEach((key) => {
      const spineJson = scene.cache.json.get(key);
      if (spineJson && spineJson.skeleton && spineJson.skeleton.spine === '3.8.75') {
        spineJson.skeleton.spine = '3.8';
      }
    });
  }

export { getUnitRecord, requireUnitRecord, getEnemyUnitRecord, getPlayerUnitRecord, readUnitNumber, getRouteUnitCap, getPlayerStatRatings, playerIncomePerMinute, normalizeSpineVersionTags };
