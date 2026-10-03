// 性能基准：130 敌方单位场景下的纯逻辑热路径实测（Node 环境）
// ① 空间哈希分离碰撞 ② 目标判定（队员测距） ③ 血条脏检查
// 与 WG.html 内的实现逐行同构，测得的是每帧 CPU 逻辑耗时（不含渲染与 GPU）
const ENEMY_COUNT = 130;
const MEMBER_COUNT = 12;                 // 4 支三人小队
const CELL = 41;                         // ENEMY_SEPARATION_DISTANCE
const SEP_DIST = 41;
const FRAMES = 600;

// 随机布点（地图 3795×3026 内的一条行军走廊附近，保证有真实的邻域密度）
function makeEnemies() {
  const list = [];
  for (let i = 0; i < ENEMY_COUNT; i++) {
    list.push({
      x: 1400 + Math.random() * 1200,
      y: 800 + Math.random() * 900,
      vx: 0, vy: 0,
      pushX: 0, pushY: 0,
      hp: 40 + Math.random() * 100,
      maxHp: 140,
      hpBarShown: Math.random() < 0.4,
      hpBarX: 0, hpBarBottom: 0, hpBarRatio: 0.5,
      barBottomCache: 0, barBottomCacheUntil: 0,
      charging: false, active: true, body: { radius: 20.5 }
    });
  }
  return list;
}

// ① 分离碰撞（与 separateEnemies 同构：空间哈希 3×3 邻域 + 推挤累加）
function separationFrame(enemies, grid) {
  grid.clear();
  const movers = enemies;
  for (let i = 0; i < movers.length; i++) {
    const e = movers[i];
    e.pushX = 0; e.pushY = 0;
    const key = Math.floor(e.x / CELL) + ':' + Math.floor(e.y / CELL);
    const bucket = grid.get(key);
    if (bucket) bucket.push(i); else grid.set(key, [i]);
  }
  let pairs = 0;
  for (let i = 0; i < movers.length; i++) {
    const first = movers[i];
    const cellX = Math.floor(first.x / CELL);
    const cellY = Math.floor(first.y / CELL);
    for (let gx = cellX - 1; gx <= cellX + 1; gx++) {
      for (let gy = cellY - 1; gy <= cellY + 1; gy++) {
        const bucket = grid.get(gx + ':' + gy);
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k++) {
          const j = bucket[k];
          if (j <= i) continue;
          const second = movers[j];
          let dx = second.x - first.x;
          let dy = second.y - first.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= SEP_DIST * SEP_DIST) continue;
          pairs++;
          let d = Math.sqrt(d2);
          if (d < 0.0001) { dx = 1; dy = 0; d = 1; }
          const overlap = (SEP_DIST - d) * 0.5;
          const pushX = dx / d * overlap;
          const pushY = dy / d * overlap;
          first.pushX -= pushX; first.pushY -= pushY;
          second.pushX += pushX; second.pushY += pushY;
        }
      }
    }
  }
  for (let i = 0; i < movers.length; i++) {
    movers[i].x += movers[i].pushX;
    movers[i].y += movers[i].pushY;
  }
  return pairs;
}

// ② 目标判定（与 findNearestVisiblePlayerMember 的测距部分同构：每敌人扫全部队员）
function targetingFrame(enemies, members) {
  let found = 0;
  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i];
    let best = Infinity;
    for (let m = 0; m < members.length; m++) {
      const d = Math.hypot(enemy.x - members[m].x, enemy.y - members[m].y);
      if (d < best) { best = d; }
    }
    if (best < 450) found++;
  }
  return found;
}

// ③ 血条脏检查（与 updateEnemyHealthBar 的缓存路径同构）
function healthBarsFrame(enemies, time) {
  let redraw = 0;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.charging || e.hp >= e.maxHp) continue;
    if (e.barBottomCacheUntil === undefined || time >= e.barBottomCacheUntil) {
      e.barBottomCacheUntil = time + 120;
      e.barBottomCache = e.y - 40;         // 骨骼包围盒的替代（缓存命中时根本不进这里）
    }
    const ratio = e.hp / e.maxHp;
    if (!e.hpBarShown || e.hpBarX !== e.x || e.hpBarBottom !== e.barBottomCache || e.hpBarRatio !== ratio) {
      e.hpBarShown = true; e.hpBarX = e.x; e.hpBarBottom = e.barBottomCache; e.hpBarRatio = ratio;
      redraw++;
    }
  }
  return redraw;
}

// ---- 基准执行 ----
const enemies = makeEnemies();
const members = [];
for (let i = 0; i < MEMBER_COUNT; i++) {
  members.push({ x: 900 + Math.random() * 900, y: 800 + Math.random() * 1200 });
}
const grid = new Map();
let sepMs = 0, targetMs = 0, barsMs = 0, maxFrame = 0, pairsTotal = 0, inRange = 0;
for (let frame = 0; frame < FRAMES; frame++) {
  const t0 = process.hrtime.bigint();
  const pairs = separationFrame(enemies, grid);
  const t1 = process.hrtime.bigint();
  inRange += targetingFrame(enemies, members);
  const t2 = process.hrtime.bigint();
  healthBarsFrame(enemies, frame * 16.7);
  const t3 = process.hrtime.bigint();
  sepMs += Number(t1 - t0) / 1e6;
  targetMs += Number(t2 - t1) / 1e6;
  barsMs += Number(t3 - t2) / 1e6;
  pairsTotal += pairs;
  maxFrame = Math.max(maxFrame, Number(t3 - t0) / 1e6);
  enemies.forEach(e => { e.x += (Math.random() - 0.5) * 2; e.y += (Math.random() - 0.5) * 2; });
}
console.log('==== 130 敌方单位 · 纯逻辑热路径基准（Node ' + process.version + '，' + FRAMES + ' 帧）====');
console.log('分离碰撞(空间哈希): 平均 ' + (sepMs / FRAMES).toFixed(3) + ' ms/帧，重叠对均值 ' + Math.round(pairsTotal / FRAMES));
console.log('目标判定(队员测距): 平均 ' + (targetMs / FRAMES).toFixed(3) + ' ms/帧，射程内目标均值 ' + Math.round(inRange / FRAMES));
console.log('血条脏检查(含降频缓存): 平均 ' + (barsMs / FRAMES).toFixed(3) + ' ms/帧');
const logic = (sepMs + targetMs + barsMs) / FRAMES;
console.log('逻辑合计: ' + logic.toFixed(3) + ' ms/帧，占 120FPS 帧预算(8.3ms)的 ' + (logic / 8.3 * 100).toFixed(1) + '%');
console.log('单帧峰值: ' + maxFrame.toFixed(3) + ' ms');

