// ============================================================
// wg_game 模块化拆分 —— combat.js
// 职责: 战斗结算：伤害/爆炸/染色/飘字/震屏
// 来源: wg_game.js 语句区间 1174-6091（自动拆分，勿手工重排语句顺序）
// ============================================================

import { S } from './S.js';
import { getPlayerExplosionDamage } from './core.js';
import { applyEnemyKnockback, beginEnemyDeath } from './enemy.js';
import { beginPlayerMemberDeath, getAllLivingPlayerMembers } from './player-member.js';
import { ARMOR_PENETRATION_STEP, ATTACK_BLAST_TEXTURE_KEY, COMBAT_TEXT_DURATION, COMBAT_TEXT_FONT_FAMILY, COMBAT_TEXT_FONT_SIZE, COMBAT_TEXT_MAX_COUNT, COMBAT_TEXT_MAX_RESOLUTION, COMBAT_TEXT_RISE, ENEMY_DETONATE_TEXTS, ENEMY_DETONATE_TEXT_COLOR, ENEMY_EXPLOSION_DAMAGE, ENEMY_EXPLOSION_RADIUS, EXPLOSION_SHAKE_AMPLITUDE, EXPLOSION_SHAKE_CYCLES, EXPLOSION_SHAKE_DURATION, EXPLOSION_SHAKE_MIN_ZOOM, EXPLOSION_TEXTURE_KEY, PLAYER_DETONATE_TEXT, PLAYER_EXPLOSION_RADIUS, PLAYER_EXPLOSION_TEXT_COLOR, VIEW_WIDTH, combatTexts } from './state.js';


  // 一次攻击的伤害结算：diff 为破甲与护甲之差，按线性比例增减（差值 0 时即等额伤害），
  // 下限为 0，破甲远低于护甲时不会打出负数伤害
  function computeArmorDamage(attackerRecord, defenderRecord) {
    if (!attackerRecord || !defenderRecord) return 0;
    const diff = attackerRecord.armor_penetration - defenderRecord.armor;
    return Math.max(0, attackerRecord.action_value * (1 + ARMOR_PENETRATION_STEP * diff));
  }


  // 近战伤害：数值与远程攻击共用同一套公式（同样的 action_value / armor_penetration），
  // 区别只在 melee_ignore_armor = 1 的兵种（Warjack）把防守方护甲视为 0，即该攻击无视护甲
  function computeMeleeDamage(attackerRecord, defenderRecord) {
    if (!attackerRecord || !defenderRecord) return 0;
    const armor = attackerRecord.melee_ignore_armor === 1 ? 0 : defenderRecord.armor;
    const diff = attackerRecord.armor_penetration - armor;
    return Math.max(0, attackerRecord.action_value * (1 + ARMOR_PENETRATION_STEP * diff));
  }

  function shakeCameraForExplosion(scene, radius) {
    const camera = scene && scene.cameras ? scene.cameras.main : null;
    if (!camera) return;
    if (camera.zoom < EXPLOSION_SHAKE_MIN_ZOOM) return;
    // 上一段抖动还没结束时：若相机缩放仍是它写入的推拉值（玩家没动过滚轮），
    // 就沿用它的基准缩放，避免把抖动中的临时缩放当成新基准而累积偏移；
    // 玩家在抖动期间改过缩放时则以当前缩放为准
    const prev = S.explosionShake && S.explosionShake.camera === camera ? S.explosionShake : null;
    const reuse = prev && Math.abs(camera.zoom - prev.appliedZoom) <= 0.0005 ? prev.baseZoom : camera.zoom;
    const scale = Phaser.Math.Clamp(radius / PLAYER_EXPLOSION_RADIUS, 0.5, 1.25);
    S.explosionShake = {
      camera: camera,
      baseZoom: reuse,
      appliedZoom: camera.zoom,
      elapsed: 0,
      duration: EXPLOSION_SHAKE_DURATION * scale,
      amplitude: EXPLOSION_SHAKE_AMPLITUDE * scale
    };
  }


  // 震动逐帧推进：按「基准缩放 × (1 ± 幅度)」推拉相机，幅度随时间衰减，结束时精确还原基准缩放。
  // 抖动期间玩家用滚轮改了缩放，则以新缩放为基准继续抖，避免结束时把镜头强行拉回旧值
  function updateExplosionShake(delta) {
    const shake = S.explosionShake;
    if (!shake) return;
    const camera = shake.camera;
    if (!camera || !camera.scene) {
      S.explosionShake = null;
      return;
    }
    if (Math.abs(camera.zoom - shake.appliedZoom) > 0.0005) {
      shake.baseZoom = camera.zoom;
    }
    shake.elapsed += Math.max(0, delta);
    const progress = shake.duration > 0 ? shake.elapsed / shake.duration : 1;
    if (progress >= 1) {
      camera.setZoom(shake.baseZoom);
      S.explosionShake = null;
      return;
    }
    const decay = 1 - progress * progress;
    const wave = Math.sin(progress * Math.PI * 2 * EXPLOSION_SHAKE_CYCLES);
    const zoom = shake.baseZoom * (1 + shake.amplitude * decay * wave);
    camera.setZoom(zoom);
    shake.appliedZoom = zoom;
  }


  // 自爆结算：只对敌对阵营生效，不会波及同阵营单位。
  // 影响范围是以爆心为圆心的圆圈面积，半径由调用方给出（我方统一 40 / 敌方 20）。
  // 我方自爆按距离递减伤害、命中者被击退，并触发一次屏幕震动；伤害数字用鲜红色标出
  function detonateUnit(scene, x, y, faction, radius, record) {
    const blastRadius = Math.max(0, radius || (faction === 'player' ? PLAYER_EXPLOSION_RADIUS : ENEMY_EXPLOSION_RADIUS));
    // 自爆爆炸动画必须覆盖到自身的作用范围：使用铺满档贴图（贴图尺寸 = 爆炸圆直径，
    // 第一帧就铺满），与坦克炮弹命中爆炸同款，视觉范围与 detonate_radius 的伤害判定范围一致
    spawnExplosion(scene, x, y, blastRadius, ATTACK_BLAST_TEXTURE_KEY);
    if (faction === 'player') {
      showCombatText(scene, x, y - 28, PLAYER_DETONATE_TEXT, PLAYER_EXPLOSION_TEXT_COLOR);
      shakeCameraForExplosion(scene, blastRadius);
      S.enemiesGroup.getChildren().slice().forEach(enemy => {
        if (!enemy.active || enemy.charging) return;
        const distance = Phaser.Math.Distance.Between(x, y, enemy.x, enemy.y);
        if (distance > blastRadius) return;
        damageEnemy(scene, enemy, getPlayerExplosionDamage(distance, record), PLAYER_EXPLOSION_TEXT_COLOR);
        // 被炸死（转入阵亡待爆）的单位不再击退，倒下的敌人不该被推走
        if (enemy.active && !enemy.charging) applyEnemyKnockback(enemy, x, y);
      });
      return;
    }
    showCombatText(
      scene,
      x,
      y - 28,
      ENEMY_DETONATE_TEXTS[Math.floor(Math.random() * ENEMY_DETONATE_TEXTS.length)],
      ENEMY_DETONATE_TEXT_COLOR
    );
    getAllLivingPlayerMembers().forEach(member => {
      if (Phaser.Math.Distance.Between(x, y, member.character.x, member.character.y) <= blastRadius) {
        damagePlayerMember(scene, member, ENEMY_EXPLOSION_DAMAGE);
      }
    });
  }


  // ---- 敌方单位 ----

  // textColor 只影响浮动伤害数字的颜色：普通攻击沿用原来的黄色，
  // 自爆伤害传入鲜红色（PLAYER_EXPLOSION_TEXT_COLOR）以便和常规伤害区分开
  function damageEnemy(scene, enemy, damage, textColor = '#fce38a') {
    if (!enemy || !enemy.active || enemy.charging || enemy.deathStarted) return;
    // 被攻击标记：血条从此常显（即使血量回满也不隐藏），未被攻击的单位永不显示血条
    enemy.barRevealed = true;
    enemy.hp = Math.max(0, enemy.hp - damage);
    showCombatText(scene, enemy.x, enemy.y - 34, `-${Math.round(damage * 10) / 10}`, textColor);
    if (enemy.hp <= 0) {
      beginEnemyDeath(enemy);
      return;
    }
  }


  // ---- 我方队员 ----

  function damagePlayerMember(scene, member, damage) {
    if (!member || !member.alive || !member.character) return;
    member.hp = Math.max(0, member.hp - damage);
    // 受击即重新计时：5 秒内不再挨打才会开始回血
    member.lastDamagedAt = scene.time.now;
    showCombatText(scene, member.character.x, member.character.y - 34, `-${Math.round(damage * 10) / 10}`, '#ff6b6b');
    if (member.hp <= 0) beginPlayerMemberDeath(member);
  }


  // 世界坐标到屏幕像素的总缩放：相机缩放 × 画布在页面上的显示比例
  function getCombatTextWorldScale(scene) {
    const camera = scene.cameras.main;
    const canvas = scene.game.canvas;
    // canvas 的 CSS 宽度对应的是游戏分辨率宽度（config.width = 1920，即视野宽度），
    // 不是世界宽度（世界等于地图原始像素 3795×3026），两者不能混用
    const canvasScale = canvas && canvas.clientWidth ? canvas.clientWidth / VIEW_WIDTH : 1;
    return Phaser.Math.Clamp((camera ? camera.zoom : 1) * canvasScale, 0.001, 1000);
  }


  // 每帧同步：滚轮缩放相机或改变窗口大小时，已在场上的文字屏幕尺寸保持恒定
  function updateCombatTextScale() {
    for (let i = combatTexts.length - 1; i >= 0; i--) {
      const label = combatTexts[i];
      if (!label.active) {
        combatTexts.splice(i, 1);
        continue;
      }
      const targetScale = 1 / getCombatTextWorldScale(label.scene);
      if (Math.abs(label.scaleX - targetScale) > 0.0001) {
        label.setScale(targetScale);
      }
    }
  }

  function showCombatText(scene, x, y, text, color) {
    if (combatTexts.length >= COMBAT_TEXT_MAX_COUNT) return;
    const worldScale = getCombatTextWorldScale(scene);
    const label = scene.add.text(x, y, text, {
      fontFamily: COMBAT_TEXT_FONT_FAMILY,
      fontSize: COMBAT_TEXT_FONT_SIZE + 'px',
      color,
      fontStyle: 'bold',
      stroke: '#111111',
      strokeThickness: 3,
      resolution: Phaser.Math.Clamp(window.devicePixelRatio || 1, 1, COMBAT_TEXT_MAX_RESOLUTION)
    }).setOrigin(0.5).setDepth(8);
    label.setScale(1 / worldScale);
    combatTexts.push(label);
    scene.tweens.add({
      targets: label,
      y: y - COMBAT_TEXT_RISE / worldScale,
      alpha: 0,
      duration: COMBAT_TEXT_DURATION,
      onComplete: () => {
        const index = combatTexts.indexOf(label);
        if (index >= 0) combatTexts.splice(index, 1);
        label.destroy();
      }
    });
  }


  // 死亡染色：Spine 插件没有提供 tint 接口，这里直接按「槽位基础色 -> 正红」插值，
  // 保留原来的明暗关系，观感是整个人物慢慢泛红而不是糊成一块红布
  function applyDeathTint(character, strength) {
    if (!character || !character.skeleton) return;
    // 召唤分身的常驻红色覆盖（__baseRedAmount = 覆盖比例，SF 分身 0.25）：
    // 叠在死亡染色之前，死亡泛红从叠加后的程度继续加深，
    // 不会先褪回原色再重新泛红；插值方式保留槽位原本的明暗细节
    const baseRed = Phaser.Math.Clamp(character.__baseRedAmount || 0, 0, 1);
    const amount = Phaser.Math.Clamp(baseRed + (1 - baseRed) * Phaser.Math.Clamp(strength, 0, 1), 0, 1);
    // 渲染量化早退：槽位色最终按 8-bit 渲染，amount 变化不足 1/255 时任何通道的
    // 显示值都不可能改变（各通道对 amount 的导数绝对值 ≤ 1），跳过重写毫无视觉差异。
    // 高刷设备上泛红进度每帧步长（144fps 约 0.002）低于该阈值，绝大多数帧不再逐槽位重写；
    // 60fps 设备步长（约 0.007）高于阈值，逐帧照常、行为不变。
    // 缓存挂 character 实例随对象回收，无泄漏；首次调用 __deathTintAmount 为 undefined
    // 与任何数值比较为 false，必执行
    if (Math.abs(amount - (character.__deathTintAmount || -1)) < 0.00392) return;
    const slots = character.skeleton.slots;
    if (!character.__deathBaseColors) {
      character.__deathBaseColors = slots.map(slot => (
        slot && slot.color ? [slot.color.r, slot.color.g, slot.color.b] : null
      ));
    }
    slots.forEach((slot, index) => {
      const base = character.__deathBaseColors[index];
      if (!base || !slot || !slot.color) return;
      slot.color.r = base[0] + (1 - base[0]) * amount;
      slot.color.g = base[1] * (1 - amount);
      slot.color.b = base[2] * (1 - amount);
    });
    character.__deathTintAmount = amount;
  }


  // 爆炸表现：光团从第一帧就铺满整个爆炸区域（贴图尺寸 = 爆炸圆直径），
  // 再向外轻轻扩张并淡出；同时叠一圈从爆心扩散到爆炸半径的冲击波圆环，
  // 让「爆炸动画覆盖整个爆炸区域」在视觉上一目了然。
  // textureKey 用于换用不同铺满程度的贴图：坦克炮弹命中爆炸与所有单位的自爆
  // 均使用铺满档（ATTACK_BLAST_TEXTURE_KEY），未传时兜底用基础档
  // options 仅 WG2 的 Gustaf 爆炸传入（state.js GUSTAF_EXPLOSION_ELEVATION）：
  //   liftRatio  —— 火球中心自落点向上抬升（× 半径），盖在单位身体之上而不是平铺在脚下
  //   flashDepth —— 火球渲染层级（抬到所有单位显示之上）
  //   puffCount  —— 追加的升腾火团数量（短生命周期，onComplete 自毁，无常驻对象）
  // 缺省（WG 全部爆炸、WG2 其余爆炸）时三个值都走原值，渲染行为逐位不变
  function spawnExplosion(scene, x, y, radius, textureKey, options) {
    if (!scene || !scene.sys || !scene.sys.isActive()) return;
    const lift = options && options.liftRatio ? radius * options.liftRatio : 0;
    const flashDepth = (options && options.flashDepth) || 6;
    const diameter = Math.max(8, radius * 2);
    const flash = scene.add.image(x, y - lift, textureKey || EXPLOSION_TEXTURE_KEY)
      .setDepth(flashDepth)
      .setDisplaySize(diameter, diameter)
      .setAlpha(0.95);
    scene.tweens.add({
      targets: flash,
      displayWidth: diameter * 1.3,
      displayHeight: diameter * 1.3,
      alpha: 0,
      duration: 420,
      ease: 'Cubic.easeOut',
      onComplete: () => flash.destroy()
    });

    // 升腾火团：小号光团自火球中心随机散开、上浮并放大淡出（视觉上把爆炸「立」起来）
    const puffCount = (options && options.puffCount) || 0;
    for (let puffIndex = 0; puffIndex < puffCount; puffIndex++) {
      const puff = scene.add.image(
        x + Phaser.Math.Between(-radius, radius) * 0.28,
        y - lift,
        textureKey || EXPLOSION_TEXTURE_KEY
      )
        .setDepth(flashDepth - 0.01)
        .setDisplaySize(diameter * 0.38, diameter * 0.38)
        .setAlpha(0.75);
      scene.tweens.add({
        targets: puff,
        y: puff.y - radius * (0.3 + Math.random() * 0.2),
        displayWidth: diameter * 0.62,
        displayHeight: diameter * 0.62,
        alpha: 0,
        delay: puffIndex * 70,
        duration: 460,
        ease: 'Cubic.easeOut',
        onComplete: () => puff.destroy()
      });
    }

    const ringRadius = Math.max(4, radius);
    const ring = scene.add.graphics({ x, y }).setDepth(6.1);
    const wave = { r: diameter * 0.35 };
    scene.tweens.add({
      targets: wave,
      r: ringRadius,
      duration: 380,
      ease: 'Cubic.easeOut',
      onUpdate: () => {
        ring.clear();
        ring.lineStyle(3, 0xff5533, Phaser.Math.Clamp(0.85 * (1 - wave.r / ringRadius), 0.12, 0.85));
        ring.strokeCircle(0, 0, wave.r);
      },
      onComplete: () => ring.destroy()
    });
  }

export { computeArmorDamage, computeMeleeDamage, shakeCameraForExplosion, updateExplosionShake, detonateUnit, damageEnemy, damagePlayerMember, getCombatTextWorldScale, updateCombatTextScale, showCombatText, applyDeathTint, spawnExplosion };
