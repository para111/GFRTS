// ============================================================
// wg_game 模块化拆分 —— artillery.js
// 职责: 炮兵/列车炮：炮弹与辅助瞄准
// 来源: wg_game.js 语句区间 6172-6541（自动拆分，勿手工重排语句顺序）
// ============================================================

import { S } from './S.js';
import { damageEnemy, showCombatText, spawnExplosion } from './combat.js';
import { getPlayerAttackBlastDamage } from './core.js';
import { getLivingPlayerMembers, getPlayerAnimationDurationMs } from './player-member.js';
import { getSpawnedPlayerSquads } from './player-squad.js';
import { ACTIVE_ENEMY_RECORD, ATTACK_BLAST_TEXTURE_KEY, ATTACK_PROJECTILE_DEFAULT_LAUNCH_RATIO, ATTACK_PROJECTILE_DEFAULT_MUZZLE_FORWARD, ATTACK_PROJECTILE_DEFAULT_MUZZLE_HEIGHT, ATTACK_PROJECTILE_DEFAULT_SPEED, ATTACK_SHELL_DEPTH, ATTACK_SHELL_TEXTURE_KEY, GUSTAF_EXPLOSION_ELEVATION, GUSTAF_NOFIRE_RADIUS, GUSTAF_RECORD, GUSTAF_SHELL_BUTTON_SIZE, GUSTAF_SHELL_COST, GUSTAF_SHELL_COUNT, GUSTAF_TRIANGLE_GAP, GUSTAF_TRIANGLE_SIZE, GUSTAF_X, GUSTAF_Y, SHADOW_TEXTURE_KEY, attackShells, gustafAimPointer } from './state.js';
import { createUnitShadowTexture, forEachMemberPart, getCharacterMuzzlePoint } from './units-visual.js';
// WG2 全局修正：渲染缩放 -0.1（WG.html 恒为 0，见 state.js）
import { IS_WG2, WG2_UNIT_SCALE_DELTA } from './state.js';


  // 发射一发炮弹：先只登记弹道数据，到「攻击动画播完」那一刻才真正生成弹丸贴图
  function fireAttackShell(scene, squad, target, record, member) {
    if (!scene || !scene.sys || !scene.sys.isActive()) return;
    if (!target || !target.active || target.charging) return;
    if (!squad.unit || !squad.unit.isSpawned) return;
    const memberCount = getLivingPlayerMembers(squad).length;
    if (memberCount <= 0) return;
    // 出膛时刻 = 攻击动画时长（TankM1 的 skill1 约 2.53 秒）× 记录里的
    // attack_projectile_launch_ratio（TankM1 = 0.1，动画刚播到十分之一就出膛）；
    // 动画时长取不到时由 getPlayerAnimationDurationMs 走记录里的兜底值
    const animationMs = getPlayerAnimationDurationMs(squad, squad.attackAnimation || 'attack');
    const launchRatio = Number.isFinite(record.attack_projectile_launch_ratio)
      ? record.attack_projectile_launch_ratio
      : ATTACK_PROJECTILE_DEFAULT_LAUNCH_RATIO;
    const launchDelay = animationMs * launchRatio;
    attackShells.push({
      scene,
      record,
      // 弹丸飞行速度（像素/秒）按兵种记录，发射时定档，飞行途中不再变化
      speed: Number.isFinite(record.attack_projectile_speed)
        ? record.attack_projectile_speed
        : ATTACK_PROJECTILE_DEFAULT_SPEED,
      // 只记队员引用用于读炮口骨骼；骨骼失效时退回锚点估算，不会出现空引用
      member: member || null,
      memberCount,
      target,
      x: squad.unit.x,
      y: squad.unit.y,
      // 落点：目标还活着时逐帧修正，目标阵亡/离场则停在最后一次记录的位置
      impactX: target.x,
      impactY: target.y,
      launchAt: scene.time.now + launchDelay,
      sprite: null
    });
  }


  // 炮弹出膛：从炮管末端（muzzle 骨骼）射出，骨架取不到时退回「锚点 + 按射向前移抬高」的估算位置
  function launchAttackShell(shell) {
    const dx = shell.impactX - shell.x;
    const dy = shell.impactY - shell.y;
    const distance = Math.hypot(dx, dy) || 1;
    const dirX = dx / distance;
    const dirY = dy / distance;
    // 炮口骨骼逐部件查找：多部件单位（Warjack）的炮口可能登记在后层部件上，谁有就用谁。
    // attack_projectile_bone 支持逗号分隔多块骨骼（Ares = muzzle1,muzzle2 双臂手炮）：
    // 每块骨骼按「逐部件查找，谁有就用谁」各取一个出膛点，多块骨骼时选距目标落点最近的；
    // 全部取不到时退回下面的锚点估算
    let muzzle = null;
    if (shell.member) {
      const boneNames = String(shell.record.attack_projectile_bone || '')
        .split(',')
        .map(name => name.trim())
        .filter(Boolean);
      const candidates = boneNames.map(boneName => {
        let point = null;
        forEachMemberPart(shell.member, part => {
          if (!point) point = getCharacterMuzzlePoint(part, boneName);
        });
        return point;
      }).filter(Boolean);
      if (candidates.length === 1) {
        muzzle = candidates[0];
      } else if (candidates.length > 1) {
        muzzle = candidates.reduce((best, point) =>
          Math.hypot(point.x - shell.impactX, point.y - shell.impactY) <
          Math.hypot(best.x - shell.impactX, best.y - shell.impactY) ? point : best
        );
      }
    }
    if (muzzle) {
      shell.x = muzzle.x;
      shell.y = muzzle.y;
    } else {
      // 记录没登记炮口骨骼（或骨架已失效）时，按射向从锚点估算出膛点
      const muzzleForward = Number.isFinite(shell.record.attack_projectile_muzzle_forward)
        ? shell.record.attack_projectile_muzzle_forward
        : ATTACK_PROJECTILE_DEFAULT_MUZZLE_FORWARD;
      const muzzleHeight = Number.isFinite(shell.record.attack_projectile_muzzle_height)
        ? shell.record.attack_projectile_muzzle_height
        : ATTACK_PROJECTILE_DEFAULT_MUZZLE_HEIGHT;
      shell.x += dirX * muzzleForward;
      shell.y += dirY * muzzleForward - muzzleHeight;
    }
    const projectileSize = shell.record.attack_projectile_size || 8;
    shell.sprite = shell.scene.add.image(shell.x, shell.y, ATTACK_SHELL_TEXTURE_KEY)
      .setDepth(ATTACK_SHELL_DEPTH)
      .setDisplaySize(projectileSize, projectileSize)
      .setRotation(Math.atan2(shell.impactY - shell.y, shell.impactX - shell.x));
  }


  // 炮弹落地：以落点为爆心播放爆炸特效，并按 attack_blast_radius 结算范围伤害。
  // 每名敌人按自己的护甲单独结算（与齐射、自爆同一套破甲公式），再按到爆心的距离分档递减
  function resolveAttackShellImpact(shell, x, y) {
    const scene = shell.scene;
    const record = shell.record;
    if (shell.sprite) {
      shell.sprite.destroy();
      shell.sprite = null;
    }
    // WG2 大桥弹丸：目标是桥体时只对桥结算耐久伤害（不溅射敌人）
    if (shell.target && shell.target.isBridge && window.__WG2_BRIDGE__) {
      window.__WG2_BRIDGE__.damage(getPlayerAttackBlastDamage(0, record, ACTIVE_ENEMY_RECORD, shell.memberCount));
      return;
    }
    const radius = record.attack_blast_radius || 0;
    if (!(radius > 0)) {
      // 没有溅射半径的兵种（Warjack 的 5 像素小弹丸）：落点只打单体、不播爆炸特效，
      // 伤害沿用同一套破甲公式（等于爆心伤害），与齐射单发一致
      const target = shell.target;
      if (target && target.active && !target.charging) {
        damageEnemy(scene, target, getPlayerAttackBlastDamage(0, record, ACTIVE_ENEMY_RECORD, shell.memberCount));
      }
      return;
    }
    // 命中爆炸用「铺满」贴图：光团一直铺到爆炸圈边缘，视觉范围与伤害范围一致
    spawnExplosion(scene, x, y, radius, ATTACK_BLAST_TEXTURE_KEY);
    S.enemiesGroup.getChildren().slice().forEach(enemy => {
      if (!enemy.active || enemy.charging) return;
      const distance = Phaser.Math.Distance.Between(x, y, enemy.x, enemy.y);
      if (distance > radius) return;
      damageEnemy(
        scene,
        enemy,
        getPlayerAttackBlastDamage(distance, record, ACTIVE_ENEMY_RECORD, shell.memberCount)
      );
    });
  }


  // 每帧推进所有在飞的炮弹：到点出膛 -> 逐帧修正落点 -> 命中即引爆
  function updateAttackShells(time, delta) {
    if (!attackShells.length) return;
    const travelScale = Math.max(0, delta) / 1000;
    for (let index = attackShells.length - 1; index >= 0; index--) {
      const shell = attackShells[index];
      const scene = shell.scene;
      if (!scene || !scene.sys || !scene.sys.isActive()) {
        if (shell.sprite) shell.sprite.destroy();
        attackShells.splice(index, 1);
        continue;
      }
      if (time < shell.launchAt) continue;
      if (!shell.sprite) {
        // 出膛这一帧只放置弹丸，位移从下一帧开始，弹丸不会被瞬移到目标身上
        launchAttackShell(shell);
        continue;
      }
      // 目标还活着就实时修正落点，打移动目标不会凭空落空
      if (shell.target && shell.target.active && !shell.target.charging) {
        shell.impactX = shell.target.x;
        shell.impactY = shell.target.y;
      }
      const dx = shell.impactX - shell.x;
      const dy = shell.impactY - shell.y;
      const distance = Math.hypot(dx, dy);
      const travel = shell.speed * travelScale;
      if (distance <= travel) {
        resolveAttackShellImpact(shell, shell.impactX, shell.impactY);
        attackShells.splice(index, 1);
        continue;
      }
      shell.x += dx / distance * travel;
      shell.y += dy / distance * travel;
      shell.sprite.setPosition(shell.x, shell.y);
      shell.sprite.setRotation(Math.atan2(dy, dx));
    }
  }


  // ----------------------------------------------------
  // GustafAssist2（我方永久固定炮击单位）：
  //   单击选中 -> 脚下蓝色选中环 +「炮弹」按钮（单位正下方，直径是出售按钮的 2 倍），
  //   不画黄环 / 射程标记 / 屏蔽线；
  //   点炮弹按钮 -> 按钮所属层面关闭，进入瞄准：仅溅射大小的落点圈渐变淡红跟随指针，
  //   除单位周边 500px 禁射区外全图可发射（禁射区不做视觉描线），
  //   左键有效落点发射、右键取消；
  //   炮弹走自适应抛物线（弧高随射程增大），落地按溅射半径结算范围伤害并扣 100 点数。
  //   独特机制「范围命中」：每次发射 2 发炮弹，各自在红色命中区（溅射半径圆）内随机取落点；
  //   出膛时机 = 攻击动画时长 × 数据库 attack_projectile_launch_ratio（当前 0.3）；
  //   基础伤害以数据库登记值 270 结算（无代码削减）。
  //   冷却（记录 action_cd）与点数不足时按钮压暗、点击给行内提示，点数永不为负
  // ----------------------------------------------------
  function createGustafAssist(scene) {
    S.gustafSelected = false;
    S.gustafAiming = false;
    S.gustafNextFireAt = 0;
    S.gustafShellClickLatch = false;
    S.gustafShells = [];
    const scale = (GUSTAF_RECORD.character_scale || 0.528) + WG2_UNIT_SCALE_DELTA;
    try {
      S.gustafCharacter = scene.add.spine(GUSTAF_X, GUSTAF_Y, 'GustafAssist2', 'wait', true);
      // 朝向按环境区分：WG 沿用原版 wg_game.js L6358 的水平镜像（scaleX 取负）；
      // WG2 按该环境用户指令保持 scaleX 取正。炮口骨骼 worldX 随骨架 scaleX 自动翻转，
      // 弹道出膛点两种朝向都无需额外处理
      S.gustafCharacter.setScale(IS_WG2 ? scale : -scale, scale);
    } catch (error) {
      // 素材缺失兜底：占位圆盘让选中/炮击功能保持可用，不阻塞整局
      S.gustafCharacter = scene.add.image(GUSTAF_X, GUSTAF_Y, 'enemyTexture').setScale(6).setTint(0x8899aa);
      console.warn('GustafAssist2 Spine 加载失败，已退回占位显示', error);
    }
    S.gustafCharacter.setDepth(2);
    // 阴影贴图守卫：create() 里 Gustaf 创建早于程序化纹理生成段，贴图缺失时
    // Phaser 会渲染成 32x32 __MISSING 绿色占位方块（WG2 右下角实测复现），
    // 这里缺了就现场补一张，与 scene.js createUnitShadowTexture 同参
    if (!scene.textures.exists(SHADOW_TEXTURE_KEY)) {
      createUnitShadowTexture(scene, SHADOW_TEXTURE_KEY, 128);
    }
    scene.add.image(GUSTAF_X, GUSTAF_Y + 8, SHADOW_TEXTURE_KEY)
      .setDepth(1.6)
      .setDisplaySize(170, 60)
      .setAlpha(0.32);
    // 头顶指示：红色倒三角 + 黄色「100」（黑色描边），常显、上下浮动
    S.gustafIndicator = scene.add.container(GUSTAF_X, GUSTAF_Y - GUSTAF_TRIANGLE_GAP - GUSTAF_TRIANGLE_SIZE).setDepth(6);
    const triangle = scene.add.image(0, 0, 'gustafTriangleTexture');
    const label = scene.add.text(0, -8, String(GUSTAF_SHELL_COST), {
      fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
      fontSize: '20px',
      color: '#ffe14d',
      stroke: '#000000',
      strokeThickness: 3,
      resolution: 2
    }).setOrigin(0.5);
    S.gustafIndicator.add([triangle, label]);
    // 「炮弹」按钮单例：选中时显示在黄环正下方（出售按钮原位），点击进入瞄准
    const container = scene.add.container(0, 0).setDepth(7).setVisible(false);
    const icon = scene.add.image(0, 0, 'gustafShellButtonTexture');
    container.add(icon);
    const zone = scene.add.zone(0, 0, GUSTAF_SHELL_BUTTON_SIZE, GUSTAF_SHELL_BUTTON_SIZE).setOrigin(0.5);
    zone.setInteractive({ useHandCursor: true });
    container.add(zone);
    zone.on('pointerdown', pointer => {
      if (pointer.button !== 0) return;
      S.gustafShellClickLatch = true;
      tryEnterGustafAiming();
    });
    S.gustafShellButton = { container, icon };
    // 瞄准层：仅溅射落点圈逐帧重绘（无描线 / 屏蔽区静态层）
    S.gustafAimGraphics = scene.add.graphics().setDepth(1);
  }


  // 当前是否可发射：冷却结束且点数足够
  function canGustafFire() {
    return !!S.gameScene && S.gameScene.time.now >= S.gustafNextFireAt && S.playerPoints >= GUSTAF_SHELL_COST;
  }


  // 进入瞄准模式：静态层烘焙一次（不逐帧重画几百个描线点，保帧率）
  function tryEnterGustafAiming() {
    if (!S.gustafSelected || S.gustafAiming || !S.gameScene || !S.gustafCharacter) return;
    if (S.gameScene.time.now < S.gustafNextFireAt) {
      showCombatText(S.gameScene, GUSTAF_X, GUSTAF_Y - 170, '炮弹冷却中', '#ffb347');
      return;
    }
    if (S.playerPoints < GUSTAF_SHELL_COST) {
      showCombatText(S.gameScene, GUSTAF_X, GUSTAF_Y - 170, '点数不足', '#ffb347');
      return;
    }
    S.gustafAiming = true;
    gustafAimPointer.x = GUSTAF_X;
    gustafAimPointer.y = GUSTAF_Y + GUSTAF_NOFIRE_RADIUS;
  }


  // 退出瞄准模式：清掉瞄准落点圈
  function exitGustafAiming() {
    S.gustafAiming = false;
    if (S.gustafAimGraphics) S.gustafAimGraphics.clear();
  }


  // 落点有效性：除单位周边禁射区外全图可发射
  function isGustafAimPointValid(x, y) {
    return Phaser.Math.Distance.Between(x, y, GUSTAF_X, GUSTAF_Y) > GUSTAF_NOFIRE_RADIUS;
  }


  // 发射炮弹：点击即扣点数并进入冷却，攻击动画播放到一半时才真正出膛——
  // 每次发射 GUSTAF_SHELL_COUNT 发，各发在以目标点为中心的红色命中区
  // （溅射半径圆）内按均匀圆分布随机取落点（「范围命中」机制），
  // 出膛点取那一刻的 muzzle 骨骼（起手完成、炮口抬起姿态）。弧高随射程自适应增大
  function fireGustafShell(scene, tx, ty) {
    if (!scene || !S.gustafCharacter || !S.gustafCharacter.active) return;
    const now = scene.time.now;
    S.gustafNextFireAt = now + (GUSTAF_RECORD.action_cd || 0) * 1000;
    S.playerPoints = Math.max(0, S.playerPoints - GUSTAF_SHELL_COST);
    // 播一遍攻击动画后回待机（时长按骨架数据读取，取不到用 1.2s 兜底）
    let durationMs = 1200;
    try {
      const animName = GUSTAF_RECORD.attack_animation_name || 'attack';
      S.gustafCharacter.setAnimation(0, animName, false);
      if (S.gustafCharacter.skeleton && S.gustafCharacter.skeleton.data &&
          typeof S.gustafCharacter.skeleton.data.findAnimation === 'function') {
        const animDef = S.gustafCharacter.skeleton.data.findAnimation(animName);
        if (animDef && animDef.duration) durationMs = animDef.duration * 1000;
      }
      scene.time.delayedCall(durationMs + 60, () => {
        if (S.gustafCharacter && S.gustafCharacter.active && S.gustafCharacter.setAnimation) {
          S.gustafCharacter.setAnimation(0, 'wait', true);
        }
      });
    } catch (error) { /* 动画失败不影响弹道结算 */ }
    // 出膛时机 = 攻击动画时长 × 记录里的 attack_projectile_launch_ratio（与 TankM1 同一口径，
    // 数值由数据库登记，代码不写死）；届时再取炮口骨骼，让炮弹从炮口抬起姿态的位置飞出
    scene.time.delayedCall(Math.max(1, durationMs * (Number.isFinite(GUSTAF_RECORD.attack_projectile_launch_ratio)
      ? GUSTAF_RECORD.attack_projectile_launch_ratio
      : ATTACK_PROJECTILE_DEFAULT_LAUNCH_RATIO)), () => {
      if (!scene.sys || !scene.sys.isActive()) return;
      if (!S.gustafCharacter || !S.gustafCharacter.active) return;
      let sx = GUSTAF_X;
      let sy = GUSTAF_Y - (GUSTAF_RECORD.attack_projectile_muzzle_height || 60);
      const muzzle = getCharacterMuzzlePoint(S.gustafCharacter, GUSTAF_RECORD.attack_projectile_bone);
      if (muzzle) {
        sx = muzzle.x;
        sy = muzzle.y;
      }
      const speed = GUSTAF_RECORD.attack_projectile_speed || 1400;
      const size = GUSTAF_RECORD.attack_projectile_size || 50;
      const spread = GUSTAF_RECORD.attack_blast_radius || 200;
      for (let shellIndex = 0; shellIndex < GUSTAF_SHELL_COUNT; shellIndex++) {
        // 均匀圆分布：r 取 sqrt(rand) 保证落点在命中区内面积均匀，不向圆心扎堆
        const angle = Math.random() * Math.PI * 2;
        const radius = spread * Math.sqrt(Math.random());
        const landX = tx + Math.cos(angle) * radius;
        const landY = ty + Math.sin(angle) * radius;
        const distance = Phaser.Math.Distance.Between(sx, sy, landX, landY);
        S.gustafShells.push({
          scene,
          sprite: scene.add.image(sx, sy, ATTACK_SHELL_TEXTURE_KEY)
            .setDepth(ATTACK_SHELL_DEPTH)
            .setDisplaySize(size, size),
          sx, sy, tx: landX, ty: landY,
          startedAt: scene.time.now,
          flightMs: Phaser.Math.Clamp((distance / speed) * 1000, 700, 2200),
          arc: distance * 0.3 + 140
        });
      }
    });
  }


  // 炮弹落地：爆炸特效（与坦克炮弹同款铺满贴图）+ 溅射半径内按破甲公式分档递减结算。
  // WG2 大桥：落点在桥面上时额外对桥结算耐久伤害，敌军溅射与爆炸照常执行——
  // 敌军从桥上经过时，一发炮弹同时杀伤桥面敌军与桥体本身
  function resolveGustafShellImpact(shell) {
    if (shell.sprite) {
      shell.sprite.destroy();
      shell.sprite = null;
    }
    const radius = GUSTAF_RECORD.attack_blast_radius || 200;
    // WG2：爆炸火球抬升到所有单位与桥体显示之上（state.js GUSTAF_EXPLOSION_ELEVATION，
    // 渲染层级 7.6 > 桥体 -8）；WG 传 null，走原版脚下平铺渲染
    spawnExplosion(shell.scene, shell.tx, shell.ty, radius, ATTACK_BLAST_TEXTURE_KEY, GUSTAF_EXPLOSION_ELEVATION);
    // WG2 大桥：落点在桥面上时按爆心伤害对桥结算一次耐久（每发炮弹结算一次）
    if (window.__WG2_BRIDGE__ && window.__WG2_BRIDGE__.hitTest(shell.tx, shell.ty)) {
      window.__WG2_BRIDGE__.damage(getPlayerAttackBlastDamage(0, GUSTAF_RECORD, ACTIVE_ENEMY_RECORD, 1));
    }
    S.enemiesGroup.getChildren().slice().forEach(enemy => {
      if (!enemy.active || enemy.charging) return;
      const d = Phaser.Math.Distance.Between(shell.tx, shell.ty, enemy.x, enemy.y);
      if (d > radius) return;
      damageEnemy(
        shell.scene,
        enemy,
        // 直接按数据库记录结算（action_value 已登记为 270，无代码侧削减）
        getPlayerAttackBlastDamage(d, GUSTAF_RECORD, ACTIVE_ENEMY_RECORD, 1)
      );
    });
  }


  // 逐帧推进抛物线炮弹：位置按参数 t 插值，y 叠加 4·arc·t·(1−t) 的抛物弧；
  // 朝向按瞬时速度解析式（水平分量恒定，竖直分量 = 线性项 − 抛物线导数），贴轨迹不跳变
  function updateGustafShells(time) {
    if (!S.gustafShells.length) return;
    for (let index = S.gustafShells.length - 1; index >= 0; index--) {
      const shell = S.gustafShells[index];
      const scene = shell.scene;
      if (!scene || !scene.sys || !scene.sys.isActive()) {
        if (shell.sprite) shell.sprite.destroy();
        S.gustafShells.splice(index, 1);
        continue;
      }
      const t = Phaser.Math.Clamp((time - shell.startedAt) / shell.flightMs, 0, 1);
      const px = shell.sx + (shell.tx - shell.sx) * t;
      const groundY = shell.sy + (shell.ty - shell.sy) * t;
      const py = groundY - shell.arc * 4 * t * (1 - t);
      const tSec = shell.flightMs / 1000;
      const vx = (shell.tx - shell.sx) / tSec;
      const vy = (shell.ty - shell.sy) / tSec - shell.arc * 4 * (1 - 2 * t) / tSec;
      shell.sprite.setPosition(px, py);
      shell.sprite.setRotation(Math.atan2(vy, vx));
      if (t >= 1) {
        resolveGustafShellImpact(shell);
        S.gustafShells.splice(index, 1);
      }
    }
  }


  // 每帧视图同步：头顶倒三角浮动、选中环 + 射程标记、瞄准落点圈。
  // 单选不变式：任何小队处于选中/出售态时，Gustaf 退出选中与瞄准
  function updateGustafSelectionView(scene, time) {
    if (!S.gustafCharacter || !S.gustafCharacter.active || !S.gustafIndicator) return;
    const anySquadSelected = getSpawnedPlayerSquads().some(
      squad => squad.unit.isSelected || squad.sellPanelOpen
    );
    if (anySquadSelected) {
      S.gustafSelected = false;
      exitGustafAiming();
    }
    const bob = Math.sin(time * 0.004) * 6;
    S.gustafIndicator.setPosition(GUSTAF_X, GUSTAF_Y - GUSTAF_TRIANGLE_GAP - GUSTAF_TRIANGLE_SIZE + bob);
    if (S.gustafSelected) {
      S.selectionCircle.setVisible(true);
      S.selectionCircle.lineStyle(2, 0x3da9ff, 0.95);
      S.selectionCircle.fillStyle(0x3da9ff, 0.18);
      S.selectionCircle.fillEllipse(GUSTAF_X, GUSTAF_Y + 26, 190, 66);
      S.selectionCircle.strokeEllipse(GUSTAF_X, GUSTAF_Y + 26, 190, 66);
    }
    if (S.gustafAiming && S.gustafAimGraphics) {
      const g = S.gustafAimGraphics;
      g.clear();
      const x = gustafAimPointer.x;
      const y = gustafAimPointer.y;
      const r = GUSTAF_RECORD.attack_blast_radius || 200;
      if (isGustafAimPointValid(x, y)) {
        // 渐变淡红：三档同心填充，边缘最淡、爆心最浓
        g.fillStyle(0xff5555, 0.05);
        g.fillCircle(x, y, r);
        g.fillStyle(0xff5555, 0.08);
        g.fillCircle(x, y, r * 0.66);
        g.fillStyle(0xff5555, 0.12);
        g.fillCircle(x, y, r * 0.33);
        g.lineStyle(2.5, 0xff3333, 1);
        g.strokeCircle(x, y, r);
      } else {
        // 无效落点：只显示淡描边示意
        g.lineStyle(1.5, 0xff3333, 0.35);
        g.strokeCircle(x, y, r);
      }
    }
  }

export { fireAttackShell, launchAttackShell, resolveAttackShellImpact, updateAttackShells, createGustafAssist, canGustafFire, tryEnterGustafAiming, exitGustafAiming, isGustafAimPointValid, fireGustafShell, resolveGustafShellImpact, updateGustafShells, updateGustafSelectionView };
