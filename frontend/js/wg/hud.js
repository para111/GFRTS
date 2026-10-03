// ============================================================
// wg_game 模块化拆分 —— hud.js
// 职责: HUD：血条/兵牌/出兵面板/标记/地图指引
// 来源: wg_game.js 语句区间 184-8265（自动拆分，勿手工重排语句顺序）
// ============================================================

import { S } from './S.js';
import { getCombatTextWorldScale, showCombatText } from './combat.js';
import { updateMissionHud } from './mission.js';
import { beginPlayerSpawn, getAllLivingPlayerMembers, getLivingPlayerMembers } from './player-member.js';
import { countPlayerSquadsInCategory, countPlayerSquadsOf, getSpawnedPlayerSquads } from './player-squad.js';
import { getPlayerStatRatings, getPlayerUnitRecord, playerIncomePerMinute, readUnitNumber, requireUnitRecord } from './records.js';
import { createSandboxPanel } from './sandbox.js';
import { ENEMY_BAR_COLOR, HEALTH_BAR_BG, HEALTH_BAR_GAP, HEALTH_BAR_HEIGHT, HEALTH_BAR_RADIUS, MATCH_DURATION_MS, PLAYER_BAR_COLOR, PLAYER_BAR_WIDTH, PLAYER_CHARACTER_SCALE, PLAYER_RANGE_MARKER_COLOR, PLAYER_RANGE_MARKER_LENGTH, PLAYER_RANGE_MARKER_MAX_COUNT, PLAYER_RANGE_MARKER_MIN_COUNT, PLAYER_RANGE_MARKER_OUTLINE_COLOR, PLAYER_RANGE_MARKER_OUTLINE_EXTRA, PLAYER_RANGE_MARKER_SLOT, PLAYER_RANGE_MARKER_WIDTH, PLAYER_SQUAD_BUILD_TIME, PLAYER_START_POINTS, PLAYER_STAT_COLUMNS, PLAYER_STAT_RATING_COLORS, PLAYER_STAT_RATING_LABELS, SPAWN_BADGE_ICON_SCALE, SPAWN_BADGE_PAD_SCALE, SPAWN_BADGE_RADIUS, SPAWN_BUTTON_ALPHA, SPAWN_BUTTON_BORDER_COLOR, SPAWN_BUTTON_BOTTOM_COLOR, SPAWN_BUTTON_GAP, SPAWN_BUTTON_HEIGHT, SPAWN_BUTTON_ICON_TEXTURE_SIZE, SPAWN_BUTTON_PRESS_DURATION, SPAWN_BUTTON_PRESS_SCALE, SPAWN_BUTTON_RECRUIT_COST, SPAWN_BUTTON_SLIDE_DURATION, SPAWN_BUTTON_SLIDE_STAGGER, SPAWN_BUTTON_SQUAD_CAP, SPAWN_BUTTON_TOP_COLOR, SPAWN_BUTTON_UNITS, SPAWN_BUTTON_WIDTH, SPAWN_CATEGORY_CAP, SPAWN_GLOW_BASE_SCALE, SPAWN_GLOW_TEXTURE_SIZE, SPAWN_HUD_DEPTH, SPAWN_HUD_MARGIN, SPAWN_PAD_COLOR, SPAWN_POINT_TEXT_COLOR, SPAWN_POINT_TEXT_STROKE, SPAWN_POINT_X, SPAWN_POINT_Y, SPAWN_PREVIEW_HEAVY_DROP, SPAWN_PREVIEW_HEAVY_RADIUS, SPAWN_PREVIEW_MIRROR_KEYS, SPAWN_RING_COLOR, SQUAD_TAG_BASE_SIZE, SQUAD_TAG_HEAD_GAP, SQUAD_TAG_ICON_TEXTURES, SQUAD_TAG_MAX_SCREEN, playerSquads, trainingSquads } from './state.js';
import { createCircularTexture, createSpawnGlowTexture, getCharacterVerticalMetrics, resolveUnitRenderParts } from './units-visual.js';
// WG2 全局修正：出兵预览缩放与我方场上单位同步（WG2 为 -0.15，WG.html 恒为 0，见 state.js）
import { WG2_PLAYER_SCALE_DELTA } from './state.js';


  // 射程圆上的短宽白线：中点落在射程圆上、沿切线铺开，选中时逐帧重绘。
  // 分两遍画（先黑边框打底、再白色线芯覆盖），得到黑色边框的白色线；
  // 标记固定不转（自转动画已按需求移除），每帧只随圆心/半径变化
  function drawAttackRangeMarkers(graphics, centerX, centerY, radius) {
    const count = Phaser.Math.Clamp(
      Math.round((Math.PI * 2 * radius) / PLAYER_RANGE_MARKER_SLOT),
      PLAYER_RANGE_MARKER_MIN_COUNT,
      PLAYER_RANGE_MARKER_MAX_COUNT
    );
    for (let pass = 0; pass < 2; pass++) {
      const outline = pass === 0;
      const extra = outline ? PLAYER_RANGE_MARKER_OUTLINE_EXTRA : 0;
      const halfLength = PLAYER_RANGE_MARKER_LENGTH / 2 + extra;
      graphics.lineStyle(
        PLAYER_RANGE_MARKER_WIDTH + extra * 2,
        outline ? PLAYER_RANGE_MARKER_OUTLINE_COLOR : PLAYER_RANGE_MARKER_COLOR,
        1
      );
      graphics.beginPath();
      for (let index = 0; index < count; index += 1) {
        const angle = (Math.PI * 2 * index) / count;
        const dirX = Math.cos(angle);
        const dirY = Math.sin(angle);
        // 线沿切线铺开（切线 = 半径方向转 90°），所以线始终与射程圆相切
        const lineX = centerX + dirX * radius;
        const lineY = centerY + dirY * radius;
        const offsetX = -dirY * halfLength;
        const offsetY = dirX * halfLength;
        graphics.moveTo(lineX - offsetX, lineY - offsetY);
        graphics.lineTo(lineX + offsetX, lineY + offsetY);
      }
      graphics.strokePath();
    }
  }


  // 集火标记的单个角括号：以角点 (bx, by) 为基准画一条 L 形的红色圆角边线。
  // ox/oy 是该角「向外」的对角方向（±1），两条臂都朝框内延伸 arm 像素，
  // 拐角处用半径 radius 的圆弧过渡（圆角），形成开口朝向角色中心的括号。
  // 调用方已把动画偏移代入角点坐标，因此整条括号随动画沿对角方向平移（向外/向内反复）
  function drawFocusCornerBracket(graphics, bx, by, ox, oy, arm, radius) {
    const ix = -ox;   // 朝框内的方向
    const iy = -oy;
    const cx = bx + ix * radius;   // 圆角圆心
    const cy = by + iy * radius;
    // 水平臂：从最远端到圆角起点
    graphics.moveTo(bx + ix * arm, by);
    graphics.lineTo(bx + ix * radius, by);
    // 圆角圆弧：从 (bx + ix·r, by) 转到 (bx, by + iy·r)，扫过 90°。
    // 圆心到两端的角度分别是 -iy·90° 与 ix>0 ? 180° : 0°；
    // ix 与 iy 同号时角度递减、异号时递增（两种情况都正好扫过 90°）
    const startAngle = -iy * Math.PI / 2;
    const sweep = ix === iy ? -Math.PI / 2 : Math.PI / 2;
    const segments = 4;
    for (let step = 1; step <= segments; step++) {
      const angle = startAngle + sweep * (step / segments);
      graphics.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
    }
    // 垂直臂：从圆角终点到最远端
    graphics.lineTo(bx, by + iy * arm);
  }

  // 按列名批量读取按钮对应单位的数值：尚未开放、记录里还没登记该列的兵种取 null（角标不显示）
  function readSpawnButtonColumn(column) {
    const map = {};
    Object.keys(SPAWN_BUTTON_UNITS).forEach(key => {
      const [table, unitId] = SPAWN_BUTTON_UNITS[key];
      const record = requireUnitRecord(table, unitId);
      const value = record[column];
      map[key] = (value === undefined || value === null)
        ? null
        : readUnitNumber(record, `${table}.${unitId}`, column, { integer: true, min: 0 });
    });
    return map;
  }


  function drawMapGuides() {
    // 【暂时注释】屏蔽区与敌方路线的地图叠加显示（后面还需要用到，恢复时取消本函数体内的注释即可）
    // collisionGraphics.clear();
    //
    // // 蓝线外框到绿线外部为屏蔽区，绿线内部为可行动区
    // collisionGraphics.lineStyle(4, 0x36b8ff, 0.95);
    // collisionGraphics.strokePoints(collisionRegions.mapBoundary, true);
    // drawPolygon(collisionGraphics, getSmoothClosedPath(collisionRegions.walkableBoundary), 0x4ecca3, 0x4ecca3, 0.06, 3);
    // // 红色区域是禁入区
    // collisionRegions.redForbiddenZones.forEach(zone => {
    //   drawPolygon(collisionGraphics, getSmoothClosedPath(zone), 0xff2e63, 0xff2e63, 0.2, 3);
    // });
    // collisionRegions.lineSegments.forEach(segment => {
    //   const thickness = segment.thickness || 10;
    //   collisionGraphics.lineStyle(thickness, 0xffa62b, 0.8);
    //   collisionGraphics.beginPath();
    //   collisionGraphics.moveTo(segment.start.x, segment.start.y);
    //   collisionGraphics.lineTo(segment.end.x, segment.end.y);
    //   collisionGraphics.strokePath();
    //   collisionGraphics.lineStyle(2, 0xffd166, 1);
    //   collisionGraphics.beginPath();
    //   collisionGraphics.moveTo(segment.start.x, segment.start.y);
    //   collisionGraphics.lineTo(segment.end.x, segment.end.y);
    //   collisionGraphics.strokePath();
    // });
    //
    // routeGraphics.clear();
    // const routeStyles = {
    //   white: { color: 0xffffff, alpha: 0.95 },
    //   purple: { color: 0x8e44ad, alpha: 0.95 },
    //   red: { color: 0xff2e63, alpha: 0.95 }
    // };
    // enemyRoutes.forEach(route => {
    //   const style = routeStyles[route.name];
    //   (route.variants || [route.points]).forEach((variant, variantIndex) => {
    //     routeGraphics.lineStyle(variantIndex === 0 ? 4 : 2, style.color, variantIndex === 0 ? style.alpha : 0.35);
    //     routeGraphics.beginPath();
    //     variant.forEach((point, index) => {
    //       if (index === 0) routeGraphics.moveTo(point.x, point.y);
    //       else routeGraphics.lineTo(point.x, point.y);
    //     });
    //     routeGraphics.strokePath();
    //   });
    //
    //   route.points.forEach((point, index) => {
    //     routeGraphics.fillStyle(style.color, 1);
    //     routeGraphics.fillCircle(point.x, point.y, index === 0 ? 7 : 5);
    //     routeGraphics.lineStyle(1, 0x111111, 0.9);
    //     routeGraphics.strokeCircle(point.x, point.y, index === 0 ? 7 : 5);
    //   });
    // });
    //
    // // 把两份静态图形按原顺序烘焙进同一张贴图（红色屏蔽区叠在绿色可行动区之上，进军路线再叠在最上层）
    // if (mapOverlayLayer) {
    //   mapOverlayLayer.clear();
    //   mapOverlayLayer.draw(collisionGraphics);
    //   mapOverlayLayer.draw(routeGraphics);
    // }
  }


  // 敌方单位血条：红底细长条形。显示规则：未被攻击永不显示；一旦被攻击
  // （damageEnemy 置 barRevealed）就常显，直到死亡自爆离场——即使血量回满也不隐藏。
  // 防抖：骨骼包围盒随动画上下起伏，旧版按 120ms 缓存重算包围盒，血条会跟着逐帧跳动；
  // 改为单位首次可见时一次性记录「根位置 → 头顶血条底缘」的固定偏移（barAnchorOffset），
  // 之后血条只随单位根位置平移，与骨骼动画完全解耦，观感稳定。
  // 性能：所有条共用一个 Graphics（130 单位下省掉 130 个显示对象与逐对象遍历），
  // 每帧清空后只重绘「视野内 + 已被攻击」的条；包围盒每单位只算一次。
  // 视野外的单位直接跳过（配合视野剔除）
  function updateEnemyBars(time) {
    if (!S.enemyBars) return;
    const entries = [];
    const list = S.enemiesGroup.getChildren();
    for (let index = 0; index < list.length; index++) {
      const enemy = list[index];
      if (!enemy.active || enemy.charging || enemy.viewVisible === false) continue;
      // 血条锚点：每单位只算一次（首次可见帧），此后固定为根位置相对偏移
      if (enemy.barAnchorOffset === null || enemy.barAnchorOffset === undefined) {
        const bottom = getUnitHealthBarBottom(enemy.character);
        if (bottom !== null && bottom !== undefined) {
          enemy.barAnchorOffset = enemy.y - bottom;
        }
      }
      if (!enemy.barRevealed) continue;
      if (enemy.barAnchorOffset === null || enemy.barAnchorOffset === undefined) continue;
      entries.push(enemy);
    }
    S.enemyBars.clear();
    S.enemyBars.setVisible(entries.length > 0);
    entries.forEach(enemy => {
      const ratio = Phaser.Math.Clamp(enemy.hp / enemy.maxHp, 0, 1);
      drawHealthBar(S.enemyBars, enemy.x, enemy.y - enemy.barAnchorOffset, enemy.barWidth, HEALTH_BAR_HEIGHT, ratio, ENEMY_BAR_COLOR);
    });
  }


  // 我方小队 HUD：逐人绿色细长条形血条。
  // 未被攻击（或已回满血）的队员不显示血条，一旦挨打就出现，回满后重新隐藏
  function updatePlayerSquadHud() {
    if (!S.playerSquadBars) return;
    const injured = getAllLivingPlayerMembers().filter(member => member.hp < member.maxHp);
    S.playerSquadBars.clear();
    S.playerSquadBars.setVisible(injured.length > 0);
    if (!injured.length) return;
    injured.forEach(member => {
      const bottomY = getUnitHealthBarBottom(member.character);
      // 血条宽度按该队员所属兵种记录（TankM1 为 120，步兵约 40）
      const barWidth = (getPlayerUnitRecord(member.squad ? member.squad.unitKey : 'jf').bar_width) ||
        PLAYER_BAR_WIDTH;
      drawHealthBar(
        S.playerSquadBars,
        member.character.x,
        bottomY,
        barWidth,
        HEALTH_BAR_HEIGHT,
        member.hp / member.maxHp,
        PLAYER_BAR_COLOR
      );
    });
  }


  // 细长条形血条：深色底 + 按血量比例填充的彩色前景（自左向右生长），
  // bottomY 为血条底边，整条血条都位于该位置之上
  function drawHealthBar(graphics, centerX, bottomY, width, height, ratio, color) {
    if (!graphics) return;
    const progress = Phaser.Math.Clamp(ratio, 0, 1);
    const topY = bottomY - height;
    const leftX = centerX - width / 2;
    const radius = Math.min(HEALTH_BAR_RADIUS, height / 2);
    graphics.fillStyle(HEALTH_BAR_BG, 0.85);
    graphics.fillRoundedRect(leftX - 1, topY - 1, width + 2, height + 2, radius + 1);
    if (progress <= 0) return;
    const fillWidth = Math.max(1, width * progress);
    graphics.fillStyle(color, 1);
    graphics.fillRoundedRect(leftX, topY, fillWidth, height, radius);
  }


  // 血条锚点：默认贴在角色当前姿态头顶上方 HEALTH_BAR_GAP 处；
  // 骨架信息取不到时退化为按显示高度估算，保证血条始终在人物上方不遮挡
  function getUnitHealthBarBottom(character) {
    if (!character) return null;
    const metrics = getCharacterVerticalMetrics(character);
    if (metrics) return metrics.top - HEALTH_BAR_GAP;
    const fallbackHeight = character.displayHeight ? Math.abs(character.displayHeight) : 50;
    return character.y - fallbackHeight - HEALTH_BAR_GAP;
  }


  // 出生点信标：圆形底盘 + GRF 徽标 + 淡蓝色外圈（纯地图标记，出兵改由左上角按钮触发）
  function createSpawnPoint(scene) {
    createCircularTexture(scene, 'grfLogo', 'spawnBadgeTexture', SPAWN_BADGE_RADIUS * 2, {
      keyBlack: true,
      keyBlackThreshold: 24,
      fit: 0.92
    });
    createSpawnGlowTexture(scene, 'spawnGlowTexture', SPAWN_GLOW_TEXTURE_SIZE);

    S.spawnGlow = scene.add.image(SPAWN_POINT_X, SPAWN_POINT_Y, 'spawnGlowTexture')
      .setDepth(-2.5)
      .setScale(SPAWN_GLOW_BASE_SCALE)
      .setAlpha(0.26);

    S.spawnBadgePad = scene.add.graphics().setDepth(-2.2);
    // GRF 徽标底盘：不透明深海蓝圆盘，半径按原尺寸放大两倍（正好衬住放大后的徽标图标）
    S.spawnBadgePad.fillStyle(SPAWN_PAD_COLOR, 1);
    S.spawnBadgePad.fillCircle(SPAWN_POINT_X, SPAWN_POINT_Y, SPAWN_BADGE_RADIUS * SPAWN_BADGE_PAD_SCALE);
    S.spawnBadgePad.lineStyle(2.5, SPAWN_RING_COLOR, 0.95);
    S.spawnBadgePad.strokeCircle(SPAWN_POINT_X, SPAWN_POINT_Y, SPAWN_BADGE_RADIUS * SPAWN_BADGE_PAD_SCALE);

    S.spawnBadge = scene.add.image(SPAWN_POINT_X, SPAWN_POINT_Y, 'spawnBadgeTexture')
      .setDepth(-2)
      .setScale(SPAWN_BADGE_ICON_SCALE);   // GRF 图标放大两倍，出生点更醒目

    S.spawnFlashGraphics = scene.add.graphics().setDepth(3).setVisible(false);
  }


  // 黑灰渐变的 50×70 按钮：渐变底 + 描边 + 圆形图标 + 角标文字。
  // 返回的对象带 setEnabled / setLabel 之类的轻量接口，供每帧刷新用。
  function createSpawnButton(scene, options) {
    const width = SPAWN_BUTTON_WIDTH;
    const height = SPAWN_BUTTON_HEIGHT;
    const container = scene.add.container(0, 0);
    const background = scene.add.graphics();
    // 背景绘制：normal（常规）/ hover（悬停）。训练期间底色保持不透明，
    // 只在底色之上叠加逆时针的进度填充，不影响底色显示
    const drawBackground = mode => {
      background.clear();
      const hover = mode === 'hover';
      const topColor = hover ? 0x4a5058 : SPAWN_BUTTON_TOP_COLOR;
      const bottomColor = hover ? 0x14161a : SPAWN_BUTTON_BOTTOM_COLOR;
      background.fillGradientStyle(topColor, topColor, bottomColor, bottomColor, 1, 1, 1, 1);
      background.fillRect(-width / 2, -height / 2, width, height);
      background.lineStyle(2, SPAWN_BUTTON_BORDER_COLOR, hover ? 1 : (options.borderAlpha === undefined ? 0.9 : options.borderAlpha));
      background.strokeRect(-width / 2, -height / 2, width, height);
      background.lineStyle(1, 0xffffff, hover ? 0.18 : 0.12);
      background.strokeRect(-width / 2 + 3, -height / 2 + 3, width - 6, height - 6);
    };
    drawBackground('normal');
    container.add(background);

    // 训练进度：从按钮顶部起逆时针扫过的扇形填充，叠加在底色之上
    const progressGraphics = scene.add.graphics();
    progressGraphics.setAlpha(0);      // 平时不可见，进入训练态时缓动淡入
    container.add(progressGraphics);

    const icon = scene.add.image(0, 0, options.texture);
    const iconSize = Math.min(width, height) * 0.66;
    const scale = iconSize / Math.max(icon.width, icon.height);
    icon.setScale(scale);
    container.add(icon);

    const makeLabel = (x, y, size) => {
      const label = scene.add.text(x, y, '', {
        fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
        fontSize: size + 'px',
        color: SPAWN_POINT_TEXT_COLOR,
        stroke: SPAWN_POINT_TEXT_STROKE,
        strokeThickness: 3,
        resolution: 2                      // 文字按 2 倍分辨率渲染，缩放后依然清晰
      }).setOrigin(1, y < 0 ? 0 : 1);
      container.add(label);
      return label;
    };
    const labelPad = 5;
    const topLabel = options.topLabel ? makeLabel(width / 2 - labelPad, -height / 2 + labelPad, 16) : null;
    const bottomLabel = options.bottomLabel ? makeLabel(width / 2 - labelPad, height / 2 - labelPad, 13) : null;
    // 静态角标（分类按钮右上角的 INF / SUP / VEH 兵种标签，固定文字不走 setText）
    if (options.cornerText) {
      container.add(scene.add.text(width / 2 - labelPad, -height / 2 + labelPad, options.cornerText, {
        fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
        fontSize: '15px',
        fontStyle: 'bold',
        color: '#dff3ff',
        stroke: SPAWN_POINT_TEXT_STROKE,
        strokeThickness: 3,
        resolution: 2
      }).setOrigin(1, 0));
    }

    const baseAlpha = options.alpha === undefined ? SPAWN_BUTTON_ALPHA : options.alpha;
    container.setAlpha(baseAlpha);
    container.setVisible(options.visible !== false);
    scene.add.existing(container);

    // 按下反馈：缩放写在独立的代理对象上，避免与「滑入 / 滑出」动画（改 x / y / alpha）互相打断
    const pressProxy = { scale: 1 };
    const tweenPress = target => {
      scene.tweens.killTweensOf(pressProxy);
      scene.tweens.add({
        targets: pressProxy,
        scale: target,
        duration: SPAWN_BUTTON_PRESS_DURATION,
        ease: 'Quad.easeOut',
        onUpdate: () => container.setScale(pressProxy.scale)
      });
    };

    const hitArea = scene.add.zone(0, 0, width, height).setOrigin(0.5);
    hitArea.setInteractive({ useHandCursor: true });
    container.add(hitArea);
    hitArea.on('pointerover', () => {
      if (!hitArea.input || !hitArea.input.enabled) return;
      drawBackground('hover');
      icon.setScale(scale * 1.08);
      if (options.onHover) options.onHover(true);
    });
    hitArea.on('pointerout', () => {
      tweenPress(1);
      drawBackground('normal');
      icon.setScale(scale);
      if (options.onHover) options.onHover(false);
    });
    hitArea.on('pointerdown', pointer => {
      // 右键回调（出兵按钮 = 展开单位预览格）需在左键守卫之前分发；
      // 游戏对象事件先于场景级 pointerdown 触发，onContextMenu 里可以安全设置拦截标记
      if (pointer.button === 2 && options.onContextMenu) {
        options.onContextMenu();
        return;
      }
      if (pointer.button !== 0) return;
      // 按钮未完全显示（展开 / 收起动画进行中）时一律不响应点击，
      // 避免动画没播完、按钮还没展开到位就出兵
      if (!hitArea.input || !hitArea.input.enabled) return;
      tweenPress(SPAWN_BUTTON_PRESS_SCALE);
      options.onClick();
    });
    hitArea.on('pointerup', () => tweenPress(1));
    // 初始可交互状态跟随可见性：不可见的按钮（尚未展开）不能点
    hitArea.input.enabled = options.visible !== false;

    // 训练状态：底色保持不透明，只在底色之上叠加逆时针扫过的进度填充。
    // 进入 / 退出训练态时用 0.5 秒缓动淡入淡出，过渡自然
    let trainingActive = false;
    const setTraining = active => {
      const next = active === true;
      if (next === trainingActive) return;
      trainingActive = next;
      scene.tweens.killTweensOf(progressGraphics);
      scene.tweens.add({
        targets: progressGraphics,
        alpha: next ? 1 : 0,
        duration: 500,
        ease: 'Cubic.easeOut'
      });
    };
    // 进度填充：从按钮顶部起逆时针扫过的扇形。弧上的采样点逐个裁剪进按钮矩形，
    // 保证填充严格限制在按钮内部（不会溢出到四角之外），也不遮挡按钮底色
    const setProgress = value => {
      progressGraphics.clear();
      const progress = Phaser.Math.Clamp(value || 0, 0, 1);
      if (progress <= 0) return;
      const radius = Math.hypot(width, height) / 2;   // 足够覆盖整个按钮
      const start = -Math.PI / 2;                     // 从正上方开始
      const sweep = -Math.PI * 2 * progress;          // 逆时针扫过
      const steps = 48;
      const points = [{ x: 0, y: 0 }];
      for (let i = 0; i <= steps; i++) {
        const angle = start + sweep * (i / steps);
        points.push({
          x: Phaser.Math.Clamp(Math.cos(angle) * radius, -width / 2, width / 2),
          y: Phaser.Math.Clamp(Math.sin(angle) * radius, -height / 2, height / 2)
        });
      }
      progressGraphics.fillStyle(0xffcc33, 0.32);
      progressGraphics.fillPoints(points, true);
    };

    return {
      key: options.key,
      container,
      hitArea,
      topLabel,
      bottomLabel,
      baseAlpha,
      setTraining,
      setProgress,
      setText: (top, bottom) => {
        if (topLabel && top !== undefined) topLabel.setText(top);
        if (bottomLabel && bottom !== undefined) bottomLabel.setText(bottom);
      }
    };
  }

  function createSpawnPreviewPanel(scene, hudRoot) {
    const width = 232;
    const height = 300;
    // centerX/centerY 相对 HUD root：展开位置在右列出兵按钮（x=152）右侧
    const centerX = SPAWN_BUTTON_WIDTH * 2 + SPAWN_BUTTON_GAP * 2 + 12 + width / 2;
    const root = scene.add.container(centerX, height / 2)
      .setDepth(SPAWN_HUD_DEPTH)
      .setVisible(false);
    hudRoot.add(root);
    const bg = scene.add.graphics();
    bg.fillStyle(0x0d1117, 0.92);
    bg.fillRoundedRect(-width / 2, -height / 2, width, height, 10);
    bg.lineStyle(2, 0x9fe3ff, 0.9);
    bg.strokeRoundedRect(-width / 2, -height / 2, width, height, 10);
    root.add(bg);
    // 上半：队形预览（队员 Spine 骨架，待机动画）
    const previewZone = scene.add.container(0, -height / 4 + 6);
    root.add(previewZone);
    // 下半：六维数值评级（2 列 × 3 行）
    const statLabels = [];
    PLAYER_STAT_COLUMNS.forEach(([label], index) => {
      const column = Math.floor(index / 3);
      const row = index % 3;
      const cellX = -width / 2 + 16 + column * (width / 2 - 8);
      const cellY = 8 + row * 46;
      root.add(scene.add.text(cellX, cellY, label, {
        fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
        fontSize: '15px', color: '#c9d6e5', resolution: 2
      }));
      const rating = scene.add.text(cellX + width / 2 - 40, cellY - 2, '', {
        fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
        fontSize: '17px', fontStyle: 'bold', color: '#ffffff', resolution: 2
      }).setOrigin(1, 0);
      root.add(rating);
      statLabels.push(rating);
    });
    const ratings = getPlayerStatRatings();
    return {
      show(unitKey) {
        const record = getPlayerUnitRecord(unitKey);
        previewZone.removeAll(true);
        const roster = Array.isArray(record.roster) && record.roster.length ? record.roster : ['JF'];
        const scale = (record.character_scale || PLAYER_CHARACTER_SCALE) + WG2_PLAYER_SCALE_DELTA;
        const side = record.formation_side || 56;
        // 按队形摆位：3 人三角（队长上、两翼下），2 人横向并排（coffee / 404 统一），1 人居中
        const slots = roster.length === 3
          ? [[0, -side * 0.55], [-side * 0.58, side * 0.45], [side * 0.58, side * 0.45]]
          : roster.length === 2 ? [[-34, 0], [38, 0]] : [[0, 0]];
        // 重装单位整体下移（容器 y 不受 formation 缩放影响，位移量即预览格像素）
        const formation = scene.add.container(0,
          (record.member_collision_radius || 0) >= SPAWN_PREVIEW_HEAVY_RADIUS ? SPAWN_PREVIEW_HEAVY_DROP : 0);
        previewZone.add(formation);
        roster.forEach((name, index) => {
          const slot = slots[index] || slots[0];
          resolveUnitRenderParts(record, name).forEach(partKey => {
            try {
              const part = scene.add.spine(slot[0], slot[1], partKey, 'wait', true);
              // Agent / Ares 预览镜像：scaleX 取负
              part.setScale(SPAWN_PREVIEW_MIRROR_KEYS[unitKey] ? -scale : scale, scale);
              formation.add(part);
            } catch (error) { /* 骨架缺失时跳过该部件，其余部件照常展示 */ }
          });
        });
        // 越界缩进：按整体包围盒把队形缩进上半区（只缩一次，不逐帧）
        let mainPart = null;
        for (const part of formation.list) {
          if (part.getBounds) mainPart = part;
        }
        if (mainPart) {
          try {
            const bounds = mainPart.getBounds();
            if (bounds.height > 0 && bounds.width > 0) {
              const fit = Math.min(1, (height / 2 - 26) / bounds.height, (width - 30) / bounds.width);
              formation.setScale(fit);
            }
          } catch (error) { /* 包围盒异常时保持原缩放，不影响悬停显示 */ }
        }
        PLAYER_STAT_COLUMNS.forEach(([, column], index) => {
          const level = ratings[unitKey + '.' + column];
          statLabels[index].setText(PLAYER_STAT_RATING_LABELS[level === undefined ? 1 : level]);
          statLabels[index].setColor(PLAYER_STAT_RATING_COLORS[level === undefined ? 1 : level]);
        });
        root.setVisible(true);
      },
      hide() {
        root.setVisible(false);
        previewZone.removeAll(true);
      }
    };
  }

  function createSpawnHud(scene) {
    createCircularTexture(scene, 'grfLogo', 'grfHudIcon', SPAWN_BUTTON_ICON_TEXTURE_SIZE, { keyBlack: true, keyBlackThreshold: 24, fit: 0.94 });
    createCircularTexture(scene, 'grfIcon', 'grf1HudIcon', SPAWN_BUTTON_ICON_TEXTURE_SIZE, { keyBlack: true, keyBlackThreshold: 24, fit: 0.94 });
    createCircularTexture(scene, 'grfTasaAir', 'tasaHudIcon', SPAWN_BUTTON_ICON_TEXTURE_SIZE, { fit: 0.94 });
    createCircularTexture(scene, 'grfRS', 'rsHudIcon', SPAWN_BUTTON_ICON_TEXTURE_SIZE, { keyBlack: true, keyBlackThreshold: 24, fit: 0.94 });
    // 阵营 Logo 素材全部是透明底 PNG，直接按非透明区裁剪（keyBlack 会误伤 logo 内部的深色像素）
    createCircularTexture(scene, 'grfElmo1', 'elmo1HudIcon', SPAWN_BUTTON_ICON_TEXTURE_SIZE, { fit: 0.94 });
    createCircularTexture(scene, 'grfElmo2', 'elmo2HudIcon', SPAWN_BUTTON_ICON_TEXTURE_SIZE, { fit: 0.94 });
    createCircularTexture(scene, 'grfGK', 'gkHudIcon', SPAWN_BUTTON_ICON_TEXTURE_SIZE, { fit: 0.94 });
    createCircularTexture(scene, 'grfJF', 'jfHudIcon', SPAWN_BUTTON_ICON_TEXTURE_SIZE, { fit: 0.94 });
    // 新兵种图标：coffee 是黑底素材需要抠底；其余是透明底素材，直接按非透明区裁剪
    createCircularTexture(scene, 'grfCoffee', 'coffeeHudIcon', SPAWN_BUTTON_ICON_TEXTURE_SIZE, { fit: 0.94 });
    createCircularTexture(scene, 'grfSF', 'sfHudIcon', SPAWN_BUTTON_ICON_TEXTURE_SIZE, { fit: 0.94 });
    createCircularTexture(scene, 'grf404', 'hud404Icon', SPAWN_BUTTON_ICON_TEXTURE_SIZE, { fit: 0.94 });
    createCircularTexture(scene, 'grfTankM1', 'tankHudIcon', SPAWN_BUTTON_ICON_TEXTURE_SIZE, { fit: 0.94 });
    createCircularTexture(scene, 'grfAres', 'aresHudIcon', SPAWN_BUTTON_ICON_TEXTURE_SIZE, { fit: 0.94 });
    createCircularTexture(scene, 'grfWarjack', 'warjackHudIcon', SPAWN_BUTTON_ICON_TEXTURE_SIZE, { fit: 0.94 });

    const root = scene.add.container(0, 0).setDepth(SPAWN_HUD_DEPTH);
    // 出兵按钮预览格（上半队形待机展示 / 下半六维评级）：右键按钮展开，左键出兵时收起。
    // 必须挂进 HUD root（每帧跟随相机重定位），直接加场景会落进世界坐标系，屏幕上看不到
    const spawnPreviewPanel = createSpawnPreviewPanel(scene, root);
    // 我方单位沙盒显示：直接挂在场景层，每帧按相机可视范围自行贴到屏幕右下角
    S.sandboxPanelApi = createSandboxPanel(scene);
    const step = SPAWN_BUTTON_HEIGHT + SPAWN_BUTTON_GAP;
    const columnX = SPAWN_BUTTON_WIDTH / 2;
    const rightColumnX = SPAWN_BUTTON_WIDTH + SPAWN_BUTTON_GAP + SPAWN_BUTTON_WIDTH / 2;
    const firstY = SPAWN_BUTTON_HEIGHT / 2;

    const grfButton = createSpawnButton(scene, {
      key: 'grf',
      texture: 'grfHudIcon',
      topLabel: true,
      bottomLabel: true,
      onClick: () => {
        S.spawnHudExpanded = !S.spawnHudExpanded;
        if (!S.spawnHudExpanded) {
          S.spawnHudCategory = null;      // 收起时同时退回第一层
          spawnPreviewPanel.hide();     // 收起整个按钮栏时，三级按钮的预览格一并收回
        }
        updateSpawnHudVisibility();
      }
    });
    grfButton.row = 0;
    grfButton.container.setPosition(columnX, firstY);
    root.add(grfButton.container);

    S.spawnHudButtons = [grfButton];

    // GRF 下方竖排（第一层）：grf1（步兵）→ tasa_air（重甲）→ rs（支援），全是分类按钮，均不透明
    const leftColumn = [
      { key: 'grf1', texture: 'grf1HudIcon', row: 1, alpha: 1, isCategory: true, corner: 'INF' },
      { key: 'tasa_air', texture: 'tasaHudIcon', row: 2, alpha: 1, isCategory: true, corner: 'SUP' },
      { key: 'rs', texture: 'rsHudIcon', row: 3, alpha: 1, isCategory: true, corner: 'VEH' }
    ];
    // 右侧竖排（第二层，点开某个分类才出现）：第一个与 GRF 平行，其余按顺序往下排列。
    // 每个分类各有一组按钮，共用同一组行位（同一时刻只显示一个分类）
    const rightColumn = [
      // 步兵分类（grf1）：elmo1 / ELMO2 / JF / GK 四支出兵小队，与 JF 同格式（不透明、费用 + 上限角标）
      { key: 'elmo1', texture: 'elmo1HudIcon', row: 0, alpha: 1, category: 'grf1', unit: true },
      { key: 'elmo2', texture: 'elmo2HudIcon', row: 1, alpha: 1, category: 'grf1', unit: true },
      { key: 'jf', texture: 'jfHudIcon', row: 2, alpha: 1, category: 'grf1', unit: true },
      { key: 'GK', texture: 'gkHudIcon', row: 3, alpha: 1, category: 'grf1', unit: true },
      // 重甲分类（tasa_air）：coffee / SF / 404，不透明、JF 角标格式
      { key: 'coffee', texture: 'coffeeHudIcon', row: 0, alpha: 1, category: 'tasa_air', unit: true },
      { key: 'SF', texture: 'sfHudIcon', row: 1, alpha: 1, category: 'tasa_air', unit: true },
      { key: '404', texture: 'hud404Icon', row: 2, alpha: 1, category: 'tasa_air', unit: true },
      // 支援分类（rs）：TankM1 / Ares / Warjack，不透明、JF 角标格式
      { key: 'TankM1', texture: 'tankHudIcon', row: 0, alpha: 1, category: 'rs', unit: true },
      { key: 'Ares', texture: 'aresHudIcon', row: 1, alpha: 1, category: 'rs', unit: true },
      { key: 'Warjack', texture: 'warjackHudIcon', row: 2, alpha: 1, category: 'rs', unit: true }
    ];
    // 第三层出兵按钮：右上角显示招募费用，右下角显示「已出场 / 该兵种上限」；
    // 第二层分类按钮（grf1 / tasa_air / rs）：只保留右下角的名额角标，不显示费用
    //（分类按钮本身不扣点，扣点只发生在第三层出兵按钮）
    const buildEntry = layout => {
      const isUnitButton = layout.unit === true;
      return createSpawnButton(scene, {
        key: layout.key,
        texture: layout.texture,
        alpha: layout.alpha,
        topLabel: isUnitButton,
        bottomLabel: isUnitButton || layout.isCategory === true,
        cornerText: layout.corner,
        // 左键出兵：同时收起预览格（出完兵不需要再看数值面板）
        onClick: () => {
          spawnPreviewPanel.hide();
          handleSpawnOption(layout.key);
        },
        // 右键出兵按钮：在按钮右侧展开该单位的预览格（上半队形待机 + 下半六维评级）。
        // 设置拦截标记吃掉这次右键，避免场景层把它当成「框选部队右键移动」指令
        onContextMenu: isUnitButton
          ? () => {
              S.spawnPreviewClickLatch = true;
              spawnPreviewPanel.show(layout.key);
            }
          : null
      });
    };
    leftColumn.forEach(layout => {
      const button = buildEntry(layout);
      button.row = layout.row;
      button.isCategory = true;
      button.category = layout.key;
      button.container.setPosition(columnX, firstY + step * layout.row);
      root.add(button.container);
      S.spawnHudButtons.push(button);
    });
    rightColumn.forEach(layout => {
      const button = buildEntry(layout);
      button.row = layout.row;
      button.category = layout.category;
      button.container.setPosition(rightColumnX, firstY + step * layout.row);
      root.add(button.container);
      S.spawnHudButtons.push(button);
    });

    // 滑动动画的起止点：home 是静止位置，origin 是父按钮的位置（动画主体）；
    // 出场按行号自上而下错开，收起时反过来（自下而上）错开
    const slideParent = {
      grf1: 'grf', tasa_air: 'grf', rs: 'grf',
      elmo1: 'grf1', elmo2: 'grf1', jf: 'grf1', GK: 'grf1',
      coffee: 'tasa_air', SF: 'tasa_air', '404': 'tasa_air',
      TankM1: 'rs', Ares: 'rs', Warjack: 'rs'
    };
    S.spawnHudButtons.forEach(button => {
      const parentKey = slideParent[button.key];
      const parent = parentKey ? S.spawnHudButtons.find(entry => entry.key === parentKey) : null;
      button.row = button.row || 0;
      button.homeX = button.container.x;
      button.homeY = button.container.y;
      button.originX = parent ? parent.container.x : button.homeX;
      button.originY = parent ? parent.container.y : button.homeY;
      button.slideDelay = button.row * SPAWN_BUTTON_SLIDE_STAGGER;
      button.slideDelayBack = (3 - button.row) * SPAWN_BUTTON_SLIDE_STAGGER;
      button.slideTween = null;
    });

    S.spawnHudRoot = root;
    // 设置齿轮（视野右上角常驻）：点击后暂停游戏进程并打开设置界面（音量 / 回退主界面）
    S.settingsGear = scene.add.image(0, 0, 'gearTexture')
      .setDepth(SPAWN_HUD_DEPTH + 1)
      .setInteractive({ useHandCursor: true });
    S.settingsGear.on('pointerup', pointer => {
      // Phaser 的 GameObject pointerup 对任意按键释放都会触发（含右键/中键），
      // 不守卫的话：中键拖视角 / 右键拖动结束落在齿轮上就会误开设置界面并暂停游戏
      if (pointer.button !== 0) return;
      if (S.gameScene) S.gameScene.scene.pause();   // 停止游戏进程（设置界面是 DOM 覆盖层，不受暂停影响）
      const overlay = document.getElementById('settingsOverlay');
      if (overlay) overlay.style.display = 'flex';
    });
    // 音乐开关（齿轮左侧常驻）：默认开启，点击切换背景音乐的播放与静音
    S.musicNote = scene.add.image(0, 0, 'musicNoteTexture')
      .setDepth(SPAWN_HUD_DEPTH + 1)
      .setInteractive({ useHandCursor: true });
    S.musicNote.on('pointerup', pointer => {
      if (pointer.button !== 0) return;        // 同齿轮：只认左键释放
      const bgm = window.__TomatoBGM;
      const isOn = bgm ? bgm.toggle() : false;
      S.musicNote.setTint(isOn ? 0xffffff : 0x556677);
      S.musicNote.setAlpha(isOn ? 1 : 0.6);
    });
    // 番茄防线 HUD（屏幕顶部居中，一行平行排列）：倒计时在前 + 间隔 + 番茄图标 + ×N 计数，
    // 随相机反向补偿固定为屏幕尺寸
    S.tomatoHud = scene.add.container(0, 0);
    // 倒计时在前（左侧）：总时长按模式（WG 8 分钟 / WG2 10 分钟），最后 30 秒变红提示
    const initialTotalSeconds = Math.ceil(MATCH_DURATION_MS / 1000);
    S.matchTimerText = scene.add.text(-80, 0,
      Math.floor(initialTotalSeconds / 60) + ':' + String(initialTotalSeconds % 60).padStart(2, '0'), {
      fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
      fontSize: '26px',
      fontStyle: 'bold',
      color: '#ffffff',
      stroke: '#20232a',
      strokeThickness: 5,
      resolution: 2
    }).setOrigin(0, 0.5);
    S.tomatoHud.add(S.matchTimerText);
    // 番茄点数在后（右侧），与倒计时隔开一段距离
    const tomatoIcon = scene.add.image(14, 0, 'tomatoTexture');
    S.tomatoHudText = scene.add.text(40, 0, '×' + S.tomatoCount, {
      fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
      fontSize: '30px',
      fontStyle: 'bold',
      color: '#ffffff',
      stroke: '#20232a',
      strokeThickness: 5,
      resolution: 2
    }).setOrigin(0, 0.5);
    S.tomatoHud.add(tomatoIcon);
    S.tomatoHud.add(S.tomatoHudText);
    S.tomatoHud.setDepth(SPAWN_HUD_DEPTH + 1);
    updateSpawnHudVisibility(false);    // 首帧直接落到终态，不播动画
  }


  // 展开状态：GRF 主按钮常驻；第一层 grf1 / tasa_air / rs 在展开 GRF 时出现，
  // 右侧的第二层按钮还要再选中对应分类才出现（每分类一组，共用行位）。
  // animate === false 时直接落到终态（首帧与状态恢复用），不播动画
  function updateSpawnHudVisibility(animate) {
    const withAnimation = animate !== false;
    const activeCategory = S.spawnHudExpanded ? S.spawnHudCategory : null;
    setSpawnButtonVisible('grf1', S.spawnHudExpanded, withAnimation);
    setSpawnButtonVisible('tasa_air', S.spawnHudExpanded, withAnimation);
    setSpawnButtonVisible('rs', S.spawnHudExpanded, withAnimation);
    S.spawnHudButtons.forEach(button => {
      if (button.isCategory || !button.category) return;
      setSpawnButtonVisible(button.key, button.category === activeCategory, withAnimation);
    });
  }


  // 显示 / 隐藏下级按钮：显示时从父按钮（GRF 或 GRF1）的位置滑到自己的位置并淡入，
  // 隐藏时原路滑回父按钮、淡出后再收起；状态没变化时直接返回，重复点击不会重播动画
  function setSpawnButtonVisible(key, visible, animate = true) {
    const button = S.spawnHudButtons.find(entry => entry.key === key);
    if (!button || button.slideVisible === visible) return;
    button.slideVisible = visible;
    const container = button.container;
    if (button.slideTween) {
      button.slideTween.stop();
      button.slideTween = null;
    }
    if (!animate || !S.gameScene) {
      container.setPosition(button.homeX, button.homeY);
      container.setAlpha(button.baseAlpha);
      container.setScale(1);
      container.setVisible(visible);
      setSpawnButtonInteractive(button, visible);
      return;
    }
    if (visible) {
      // 展开动画期间先禁用点击：按钮要完全滑出、淡入到位后才允许出兵
      setSpawnButtonInteractive(button, false);
      container.setVisible(true);
      container.setPosition(button.originX, button.originY);
      container.setAlpha(0);
      button.slideTween = S.gameScene.tweens.add({
        targets: container,
        x: button.homeX,
        y: button.homeY,
        alpha: button.baseAlpha,
        duration: SPAWN_BUTTON_SLIDE_DURATION,
        delay: button.slideDelay,
        ease: 'Cubic.easeOut',
        onComplete: () => {
          button.slideTween = null;
          setSpawnButtonInteractive(button, true);
        }
      });
      return;
    }
    setSpawnButtonInteractive(button, false);
    button.slideTween = S.gameScene.tweens.add({
      targets: container,
      x: button.originX,
      y: button.originY,
      alpha: 0,
      duration: SPAWN_BUTTON_SLIDE_DURATION,
      delay: button.slideDelayBack,
      ease: 'Cubic.easeIn',
      onComplete: () => {
        button.slideTween = null;
        container.setVisible(false);
        container.setAlpha(button.baseAlpha);
        container.setPosition(button.homeX, button.homeY);
      }
    });
  }


  // 按钮可点击性：只有完全显示（展开动画结束、按钮已就位）的按钮才能响应点击。
  // 收起动画期间与尚未展开的按钮一律禁用，避免动画没播完就出兵
  function setSpawnButtonInteractive(button, enabled) {
    if (button && button.hitArea && button.hitArea.input) {
      button.hitArea.input.enabled = enabled;
    }
  }


  // 出生界面每帧刷新：位置与缩放按相机反向补偿，保证按钮始终是固定屏幕像素尺寸
  function updateSpawnHud(time, delta) {
    if (!S.spawnHudRoot) return;
    const camera = S.gameScene.cameras.main;
    const worldScale = getCombatTextWorldScale(S.gameScene);
    if (worldScale > 0) S.spawnHudRoot.setScale(1 / worldScale);
    // 可视区左上角用 scrollX / scrollY 反推（camera.worldView 要到渲染阶段才更新，
    // 拖视角时会滞后一帧，按钮就会跟着画面轻微晃动）
    const margin = worldScale > 0 ? SPAWN_HUD_MARGIN / worldScale : 0;
    const viewLeft = camera.scrollX + (camera.width - camera.width / camera.zoom) / 2;
    const viewTop = camera.scrollY + (camera.height - camera.height / camera.zoom) / 2;
    S.spawnHudRoot.setPosition(viewLeft + margin, viewTop + margin);
    // 设置齿轮跟随视野右上角，与出生界面同一套相机反向补偿：
    // 缩放取 1/worldScale 保证齿轮始终是固定屏幕像素尺寸（不随画面放缩改变），
    // 右缘距屏幕右上角固定 8 像素（margin 为换算后的世界单位边距）
    if (S.settingsGear && worldScale > 0) {
      S.settingsGear.setScale(1 / worldScale);
      S.settingsGear.setPosition(
        viewLeft + camera.width / camera.zoom - margin - 22 / worldScale,
        viewTop + margin + 22 / worldScale
      );
    }
    // 音乐开关跟随齿轮左侧：固定屏幕尺寸，与齿轮保持 8 像素间距
    if (S.musicNote && worldScale > 0) {
      S.musicNote.setScale(1 / worldScale);
      S.musicNote.setPosition(
        viewLeft + camera.width / camera.zoom - margin - (22 + 44 + 8) / worldScale,
        viewTop + margin + 22 / worldScale
      );
    }
    // 番茄防线 HUD 固定在屏幕顶部居中（与齿轮同一行高）：番茄计数与倒计时平行排列
    if (S.tomatoHud && worldScale > 0) {
      S.tomatoHud.setScale(1 / worldScale);
      S.tomatoHud.setPosition(
        viewLeft + camera.width / camera.zoom / 2,
        viewTop + margin + 22 / worldScale
      );
      // 倒计时按秒去重刷新，暂停时自然冻结；最后 30 秒变红提示
      const remainingSeconds = Math.max(0, Math.ceil((MATCH_DURATION_MS - S.matchElapsedMs) / 1000));
      if (remainingSeconds !== S.matchTimerLastSecond) {
        S.matchTimerLastSecond = remainingSeconds;
        const minutes = Math.floor(remainingSeconds / 60);
        const seconds = remainingSeconds % 60;
        S.matchTimerText.setText(minutes + ':' + String(seconds).padStart(2, '0'));
        S.matchTimerText.setColor(remainingSeconds <= 30 ? '#ff6b52' : '#ffffff');
      }
    }
    // 任务面板（右上角，齿轮与音乐按钮正下方）：位置跟随相机 + 内容按秒去重刷新
    updateMissionHud(worldScale);
    const income = playerIncomePerMinute();
    S.playerPoints = Math.min(
      PLAYER_START_POINTS + income * 60,
      S.playerPoints + (income * delta) / 60000
    );
    const grfButton = S.spawnHudButtons.find(entry => entry.key === 'grf');
    if (grfButton) grfButton.setText(String(Math.floor(S.playerPoints)), '+' + income + '/m');
    // 训练队列推进：到期的单位自动训练完成，把名额还回队列
    while (trainingSquads.length && trainingSquads[0].readyAt <= time) trainingSquads.shift();
    // 第二层分类按钮（GRF1 / tasa_air / RS）：右下角显示「本分类已占用 / 本分类上限」，
    // 只统计自己下属的出兵按钮；右上角的费用角标已移除（扣点只发生在第三层出兵按钮）
    Object.keys(SPAWN_CATEGORY_CAP).forEach(key => {
      const button = S.spawnHudButtons.find(entry => entry.key === key);
      if (!button) return;
      button.setText(undefined, countPlayerSquadsInCategory(key) + '/' + SPAWN_CATEGORY_CAP[key]);
    });
    // 出兵按钮：右上角显示费用，右下角显示「已出场 + 训练中 / 该兵种上限」；
    // 正在训练时用该兵种最快完成的那一支做逆时针填充提示
    const spawnUnitKeys = ['jf', 'elmo1', 'elmo2', 'GK', 'coffee', 'SF', '404', 'TankM1', 'Ares', 'Warjack'];
    spawnUnitKeys.forEach(key => {
      const button = S.spawnHudButtons.find(entry => entry.key === key);
      if (!button) return;
      const cap = SPAWN_BUTTON_SQUAD_CAP[key];
      const count = countPlayerSquadsOf(key);
      const nextReady = trainingSquads
        .filter(entry => entry.unitKey === key)
        .reduce((min, entry) => Math.min(min, entry.readyAt), Infinity);
      const training = Number.isFinite(nextReady) && nextReady > time;
      button.setTraining(training);
      button.setProgress(training ? 1 - (nextReady - time) / PLAYER_SQUAD_BUILD_TIME : 0);
      button.setText(String(SPAWN_BUTTON_RECRUIT_COST[key]), count + '/' + cap);
    });
  }


  // 出生界面按钮：分类按钮（grf1 / tasa_air / rs）只负责展开 / 收起第二层；
  // 出兵按钮（jf / coffee / SF / 404 / TankM1 / Ares / Warjack）真正扣点并组建小队。
  // 占用名额按「该兵种已出场 + 训练中」计算，分别受全局小队上限与各兵种上限约束
  function handleSpawnOption(key) {
    // 分类按钮：只负责展开 / 收起第二层，本身不扣点
    if (key === 'grf1' || key === 'tasa_air' || key === 'rs') {
      S.spawnHudCategory = S.spawnHudCategory === key ? null : key;
      updateSpawnHudVisibility();
      return;
    }
    const cost = SPAWN_BUTTON_RECRUIT_COST[key];
    if (cost === null || cost === undefined) {
      showCombatText(S.gameScene, SPAWN_POINT_X, SPAWN_POINT_Y - SPAWN_BADGE_RADIUS - 18, key + ' 尚未开放', '#9fe3ff');
      return;
    }
    // 分类名额：只受该兵种所属分类的上限约束（GRF1 / tasa_air / RS 各自独立）。
    // 原先的全局小队上限挂在 GRF1 上，会连带卡住 tasa_air 与 RS，这里已改为分类口径
    const unitButton = S.spawnHudButtons.find(entry => entry.key === key);
    const category = unitButton ? unitButton.category : null;
    const categoryCap = category ? SPAWN_CATEGORY_CAP[category] : 0;
    if (categoryCap > 0 && countPlayerSquadsInCategory(category) >= categoryCap) {
      showCombatText(
        S.gameScene,
        SPAWN_POINT_X,
        SPAWN_POINT_Y - SPAWN_BADGE_RADIUS - 18,
        '该分类已达上限',
        '#9fe3ff'
      );
      return;
    }
    // 该兵种上限（读数据库 squad_cap 列）
    const cap = SPAWN_BUTTON_SQUAD_CAP[key];
    if (cap !== null && cap !== undefined && countPlayerSquadsOf(key) >= cap) {
      showCombatText(S.gameScene, SPAWN_POINT_X, SPAWN_POINT_Y - SPAWN_BADGE_RADIUS - 18, '该兵种已达上限', '#9fe3ff');
      return;
    }
    if (S.playerPoints < cost) {
      showCombatText(S.gameScene, SPAWN_POINT_X, SPAWN_POINT_Y - SPAWN_BADGE_RADIUS - 18, '点数不足', '#ff8866');
      return;
    }
    S.playerPoints -= cost;
    beginPlayerSpawn(key);
  }


  // 没有出生动画时信标光晕的待机呼吸；三个分类都满额时收敛，提示暂时不能出兵
  function updateSpawnBeaconIdle(time) {
    const allCategoriesFull = Object.keys(SPAWN_CATEGORY_CAP)
      .every(key => countPlayerSquadsInCategory(key) >= SPAWN_CATEGORY_CAP[key]);
    if (allCategoriesFull) {
      S.spawnGlow.setAlpha(0.1);
      S.spawnGlow.setScale(SPAWN_GLOW_BASE_SCALE * 0.9);
      return;
    }
    const pulse = 0.5 + 0.5 * Math.sin(time * 0.0022);
    S.spawnGlow.setAlpha(0.18 + 0.14 * pulse);
    S.spawnGlow.setScale(SPAWN_GLOW_BASE_SCALE * (0.94 + 0.08 * pulse));
  }

  function drawSquadTagBackground(squad) {
    const tag = squad.tag;
    const selected = !!(squad.unit && squad.unit.isSelected);
    if (tag.lastSelected === selected) return;   // 状态没变不重绘
    tag.lastSelected = selected;
    const half = SQUAD_TAG_BASE_SIZE / 2;
    tag.bg.clear();
    tag.bg.fillStyle(selected ? 0x1f6fe0 : 0x4a5058, 0.95);
    tag.bg.fillRoundedRect(-half, -half, SQUAD_TAG_BASE_SIZE, SQUAD_TAG_BASE_SIZE, 8);
    tag.bg.lineStyle(2, 0xffffff, 0.95);
    tag.bg.strokeRoundedRect(-half, -half, SQUAD_TAG_BASE_SIZE, SQUAD_TAG_BASE_SIZE, 8);
  }

  function createSquadTag(scene, squad) {
    const bg = scene.add.graphics();
    const icon = scene.add.image(0, 0, SQUAD_TAG_ICON_TEXTURES[squad.unitKey] || 'jfHudIcon');
    icon.setScale((SQUAD_TAG_BASE_SIZE - 9) / Math.max(icon.width, icon.height));
    const zone = scene.add.zone(0, 0, SQUAD_TAG_BASE_SIZE, SQUAD_TAG_BASE_SIZE)
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    zone.on('pointerup', pointer => {
      if (pointer.button !== 0) return;
      // 点击兵牌 = 选中这块兵牌对应的小队（单选，覆盖其他小队的选中态）。
      // 设置拦截标记：随后场景层 pointerup 的空地单击判定不再执行，
      // 否则兵牌悬在头顶上方、命中空地会把刚选中的小队立刻取消
      S.squadTagClickLatch = true;
      getSpawnedPlayerSquads().forEach(other => {
        if (other.unit) other.unit.isSelected = other === squad;
      });
    });
    const container = scene.add.container(0, 0, [bg, icon, zone]).setDepth(11);
    squad.tag = { container, bg, lastSelected: null };
    drawSquadTagBackground(squad);
  }

  function updatePlayerSquadTags(scene) {
    const camera = scene.cameras.main;
    playerSquads.forEach(squad => {
      // 未出战 / 队员全灭（退役进行中）的整队隐藏兵牌
      if (!squad.unit || !squad.unit.isSpawned || !squad.members.length) {
        if (squad.tag) squad.tag.container.setVisible(false);
        return;
      }
      // 兵牌只锚定存活队员：出售 / 阵亡队员在进入冲锋自爆的瞬间就交出碰撞体（body = null），
      // 但要等自爆结束才从 members 移除。直接取 members[0] 会读到已交出的碰撞体，
      // 在 update 主循环内逐帧抛 TypeError 中断整个游戏步进（出售功能与兵牌的冲突点）；
      // 全员阵亡 / 自爆期间整队按退役处理，兵牌直接隐藏
      const member = getLivingPlayerMembers(squad)[0];
      if (!member) {
        if (squad.tag) squad.tag.container.setVisible(false);
        return;
      }
      if (!squad.tag) createSquadTag(scene, squad);
      const tag = squad.tag;
      // 队员实际渲染大小：隔离碰撞体按渲染像素标定，直径即渲染宽度的可靠代理
      const renderH = member.body ? member.body.radius * 2 : 120;
      const tagScreen = Math.max(SQUAD_TAG_BASE_SIZE, Math.min(SQUAD_TAG_MAX_SCREEN, renderH * camera.zoom));
      tag.container.setScale(tagScreen / camera.zoom / SQUAD_TAG_BASE_SIZE);
      // 位置：第一存活队员头顶上方 50 屏幕像素（间距与兵牌本体都按屏幕像素恒定）
      const headTop = member.renderY - (member.body ? member.body.radius : 60);
      const tagWorldSize = tagScreen / camera.zoom;
      tag.container.setPosition(squad.unit.x, headTop - SQUAD_TAG_HEAD_GAP / camera.zoom - tagWorldSize / 2);
      tag.container.setVisible(true);
      drawSquadTagBackground(squad);
    });
  }

export { drawAttackRangeMarkers, drawFocusCornerBracket, readSpawnButtonColumn, drawMapGuides, updateEnemyBars, updatePlayerSquadHud, drawHealthBar, getUnitHealthBarBottom, createSpawnPoint, createSpawnButton, createSpawnPreviewPanel, createSpawnHud, updateSpawnHudVisibility, setSpawnButtonVisible, setSpawnButtonInteractive, updateSpawnHud, handleSpawnOption, updateSpawnBeaconIdle, drawSquadTagBackground, createSquadTag, updatePlayerSquadTags };
