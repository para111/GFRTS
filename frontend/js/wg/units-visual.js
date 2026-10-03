// ============================================================
// wg_game 模块化拆分 —— units-visual.js
// 职责: 单位视觉通用：部件遍历/贴图/朝向/锚点
// 来源: wg_game.js 语句区间 4532-8296（自动拆分，勿手工重排语句顺序）
// ============================================================

import { PLAYER_CHARACTER_SCALE, SHADOW_DEPTH, SHADOW_FLATTEN, SHADOW_TEXTURE_KEY, SHADOW_WIDTH_RATIO, skeletonBoundsOffset, skeletonBoundsSize } from './state.js';


  // 逐帧朝向缩放守卫：Spine setScale 会脏化变换并在渲染前重算世界变换，
  // 而朝向在绝大多数帧并不变化（130+ 单位 × 60fps 的冗余写全浪费在这里）。
  // 缓存挂在实例上随对象一起销毁，无泄漏；全部逐帧朝向 setScale 写点统一走这里。
  // 注意：只用于「值来自成员/敌人自身朝向」的写点，一次性尺寸初始化不经过此函数
  function applyFacingScale(character, scaleX, scaleY) {
    if (character.__facingScaleX === scaleX && character.__facingScaleY === scaleY) return;
    character.__facingScaleX = scaleX;
    character.__facingScaleY = scaleY;
    character.setScale(scaleX, scaleY);
  }


  // ----------------------------------------------------
  // 出生点（GRF 信标）与环形选择菜单
  // 地图上的 GRF 信标就是我方出生点：左键点击后展开一圈淡蓝色虚线圆环，圆环上按
  // 倒三角摆放三张圆形图片（GRF1 在左、mid 在右、tasa_air 在下方），每张圆形图片
  // 外面包裹一圈淡蓝色线条；再次点击 GRF1 图标，单位在出生点出生并播放出生动画，
  // 动画播完后自动前出到第一个目标点。未出兵前右键移动、索敌与被攻击判定全部关闭。
  // ----------------------------------------------------

  // 把一张图片处理成圆形纹理：先按有效像素求包围盒（黑底素材先按亮度抠掉纯黑背景），
  // 再等比缩放放入圆形裁剪区，保证圆形图片完整不变形
  function createCircularTexture(scene, sourceKey, targetKey, size, options) {
    const config = options || {};
    const source = scene.textures.get(sourceKey).getSourceImage();
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = source.width;
    sourceCanvas.height = source.height;
    const sourceCtx = sourceCanvas.getContext('2d');
    sourceCtx.drawImage(source, 0, 0);
    const pixels = sourceCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
    const data = pixels.data;
    const keyThreshold = config.keyBlack ? (config.keyBlackThreshold || 24) : -1;
    let minX = sourceCanvas.width;
    let minY = sourceCanvas.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < sourceCanvas.height; y++) {
      for (let x = 0; x < sourceCanvas.width; x++) {
        const index = (y * sourceCanvas.width + x) * 4;
        if (keyThreshold >= 0) {
          const luma = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
          if (luma <= keyThreshold) data[index + 3] = 0;
        }
        if (data[index + 3] > 8) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) {
      minX = 0;
      minY = 0;
      maxX = sourceCanvas.width - 1;
      maxY = sourceCanvas.height - 1;
    }
    if (keyThreshold >= 0) sourceCtx.putImageData(pixels, 0, 0);

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const fit = size * (config.fit || 0.9);
    const scale = Math.min(fit / boxWidth, fit / boxHeight);
    const drawWidth = boxWidth * scale;
    const drawHeight = boxHeight * scale;
    ctx.drawImage(
      sourceCanvas,
      minX, minY, boxWidth, boxHeight,
      (size - drawWidth) / 2, (size - drawHeight) / 2, drawWidth, drawHeight
    );
    ctx.restore();
    if (scene.textures.exists(targetKey)) scene.textures.remove(targetKey);
    scene.textures.addCanvas(targetKey, canvas);
  }


  // 淡蓝色径向渐变光晕，用作出生点的呼吸底光与出生动画的能量
  function createSpawnGlowTexture(scene, key, size) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(159, 227, 255, 0.95)');
    gradient.addColorStop(0.45, 'rgba(120, 205, 255, 0.42)');
    gradient.addColorStop(1, 'rgba(90, 180, 255, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    if (scene.textures.exists(key)) scene.textures.remove(key);
    scene.textures.addCanvas(key, canvas);
  }


  // 脚下阴影纹理：由中心向外淡出的柔和深色椭圆，与我方/敌方单位脚下的阴影观感一致
  function createUnitShadowTexture(scene, key, size) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const radius = size / 2;
    const gradient = ctx.createRadialGradient(radius, radius, 0, radius, radius, radius);
    gradient.addColorStop(0, 'rgba(6, 10, 16, 0.92)');
    gradient.addColorStop(0.5, 'rgba(6, 10, 16, 0.55)');
    gradient.addColorStop(1, 'rgba(6, 10, 16, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(radius, radius, radius, 0, Math.PI * 2);
    ctx.fill();
    if (scene.textures.exists(key)) scene.textures.remove(key);
    scene.textures.addCanvas(key, canvas);
  }


  // 爆炸特效纹理：白心 -> 橙红 -> 透明的径向渐变。
  // filled = true 走「铺满」档位：亮区一直铺到接近贴图边缘，整块爆炸范围都被光团盖住。
  // 坦克炮弹的命中爆炸用它——伤害圈就是视觉上的爆炸圈，外圈不能只剩一点微光
  function createExplosionTexture(scene, key, size, filled) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const radius = size / 2;
    const gradient = ctx.createRadialGradient(radius, radius, 0, radius, radius, radius);
    if (filled) {
      gradient.addColorStop(0, 'rgba(255, 252, 226, 0.99)');
      gradient.addColorStop(0.45, 'rgba(255, 222, 142, 0.95)');
      gradient.addColorStop(0.78, 'rgba(255, 172, 88, 0.88)');
      gradient.addColorStop(0.93, 'rgba(255, 122, 56, 0.55)');
      gradient.addColorStop(1, 'rgba(255, 88, 40, 0)');
    } else {
      gradient.addColorStop(0, 'rgba(255, 250, 220, 0.98)');
      gradient.addColorStop(0.35, 'rgba(255, 186, 90, 0.82)');
      gradient.addColorStop(0.7, 'rgba(255, 96, 48, 0.42)');
      gradient.addColorStop(1, 'rgba(255, 60, 30, 0)');
    }
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(radius, radius, radius, 0, Math.PI * 2);
    ctx.fill();
    if (scene.textures.exists(key)) scene.textures.remove(key);
    scene.textures.addCanvas(key, canvas);
  }


  // 攻击炮弹纹理：暖色曳光光晕 + 亮钢色细长弹身 + 铜色尖头 + 橙色尾焰，弹头朝 +x。
  // 高分辨率绘制（细节在缩放后仍然干净），场上按 attack_projectile_size（TankM1 = 8 像素）显示，
  // 由 setRotation 对齐飞行方向。程序化生成的目的是与既有特效纹理（阴影 / 自爆 / 光晕）保持一致，
  // 不引入额外的外部图片依赖，8 像素显示下与任何外部素材观感一致。
  function createAttackShellTexture(scene, key, size) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const midY = size / 2;
    // 曳光光晕：保证缩到 8 像素后仍是一颗清晰的亮弹
    const glow = ctx.createRadialGradient(size * 0.62, midY, 0, size * 0.62, midY, size * 0.46);
    glow.addColorStop(0, 'rgba(255, 245, 210, 0.98)');
    glow.addColorStop(0.35, 'rgba(255, 196, 110, 0.72)');
    glow.addColorStop(0.75, 'rgba(255, 140, 50, 0.26)');
    glow.addColorStop(1, 'rgba(255, 120, 40, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);
    // 弹身：细长圆柱 + 尖头
    ctx.fillStyle = '#e6ecf2';
    ctx.beginPath();
    ctx.moveTo(size * 0.95, midY);
    ctx.lineTo(size * 0.78, midY - size * 0.13);
    ctx.lineTo(size * 0.24, midY - size * 0.13);
    ctx.lineTo(size * 0.24, midY + size * 0.13);
    ctx.lineTo(size * 0.78, midY + size * 0.13);
    ctx.closePath();
    ctx.fill();
    // 尖头：铜色
    ctx.fillStyle = '#f2b45c';
    ctx.beginPath();
    ctx.moveTo(size * 0.95, midY);
    ctx.lineTo(size * 0.78, midY - size * 0.13);
    ctx.lineTo(size * 0.78, midY + size * 0.13);
    ctx.closePath();
    ctx.fill();
    // 尾焰：弹体后方的橙色短拖尾
    ctx.fillStyle = 'rgba(255, 168, 72, 0.85)';
    ctx.beginPath();
    ctx.moveTo(size * 0.24, midY - size * 0.1);
    ctx.lineTo(size * 0.03, midY);
    ctx.lineTo(size * 0.24, midY + size * 0.1);
    ctx.closePath();
    ctx.fill();
    if (scene.textures.exists(key)) scene.textures.remove(key);
    scene.textures.addCanvas(key, canvas);
  }


  // 在角色脚下放一个椭圆阴影（尺寸按角色显示宽度等比换算，与敌方单位脚下阴影同款）
  function createUnitShadow(scene, character) {
    const displayWidth = character && character.displayWidth
      ? Math.abs(character.displayWidth)
      : PLAYER_CHARACTER_SCALE * 90;
    const width = Math.max(8, displayWidth * SHADOW_WIDTH_RATIO);
    const shadow = scene.add.image(character.x, character.y, SHADOW_TEXTURE_KEY);
    shadow.setDepth(SHADOW_DEPTH);
    shadow.setDisplaySize(width, Math.max(2, width * SHADOW_FLATTEN));
    shadow.setAlpha(0);
    return shadow;
  }


  function getCharacterVerticalMetrics(character) {
    if (!character || !character.skeleton) return null;
    const skeleton = character.skeleton;
    const offset = skeletonBoundsOffset;
    const size = skeletonBoundsSize;
    offset.set(0, 0);
    size.set(0, 0);
    try {
      skeleton.getBounds(offset, size);
    } catch (error) {
      return null;
    }
    if (!(size.h > 0)) return null;
    const skeletonScaleY = Math.abs(skeleton.scaleY) || Math.abs(character.scaleY) || 1;
    const unitToPixel = Math.abs(character.scaleY) / skeletonScaleY;
    return {
      top: character.y - (offset.y + size.h - skeleton.y) * unitToPixel,
      bottom: character.y - (offset.y - skeleton.y) * unitToPixel,
      halfWidth: Math.abs(size.w * unitToPixel) / 2
    };
  }


  // 队员骨架上的「炮口」骨骼世界坐标（屏幕像素）：TankM1 的骨架带一根 muzzle 骨骼，
  // 正好标在炮管末端，读它就能让炮弹从炮管里射出（骨骼坐标随动画一起走，开炮姿态也跟着变）。
  // 换算沿用血条那一套口径：骨架坐标 -> 屏幕像素要乘 |character.scaleY| / |skeleton.scaleY|、
  // y 轴向上取反；root 骨骼在本口径下正好落在角色锚点上（已实测校准）。
  // 朝向翻转由骨架自身的 scaleX 承担，worldX 已经带镜像，因此 x 不需要再判朝向。
  // 取不到骨骼（骨架已销毁、或该兵种没有 muzzle 骨骼）时返回 null，由调用方退回按射向估算的出膛点
  function getCharacterMuzzlePoint(character, boneName) {
    if (!boneName) return null;   // 记录没登记炮口骨骼 = 该兵种用兜底偏移估算出膛点
    if (!character || character.active === false || !character.skeleton) return null;
    const skeleton = character.skeleton;
    if (typeof skeleton.findBone !== 'function') return null;
    const bone = skeleton.findBone(boneName);
    if (!bone) return null;
    const skeletonScaleY = Math.abs(skeleton.scaleY) || Math.abs(character.scaleY) || 1;
    const unitToPixel = Math.abs(character.scaleY) / skeletonScaleY;
    if (!Number.isFinite(unitToPixel) || unitToPixel <= 0) return null;
    // 水平镜像的单位（scaleX < 0）：渲染翻转走外层变换矩阵、不进入 bone.worldX，
    // 炮口局部偏移需按镜像因子取反，保证炮弹从视觉正确的一侧出膛
    const mirror = character.scaleX < 0 ? -1 : 1;
    const x = character.x + mirror * (bone.worldX - skeleton.x) * unitToPixel;
    const y = character.y - (bone.worldY - skeleton.y) * unitToPixel;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }


  // 单位的渲染部件（Spine 骨架 key，按「后 -> 前」排列）：登记了 render_parts 的多部件单位
  // （Warjack = Part2 后层 + Part1 前层）取列里的全部部件，最后一项是承载位置/朝向/判定的主体；
  // 其余单位没有该列，主体就是花名册里登记的骨架 key（TankM1_1001 / Ares / Daiyan ...）
  function resolveUnitRenderParts(unitRecord, rosterKey) {
    const raw = unitRecord ? unitRecord.render_parts : null;
    if (typeof raw === 'string' && raw.trim()) {
      const keys = raw.split(',').map(key => key.trim()).filter(Boolean);
      if (keys.length) return keys;
    }
    return [rosterKey];
  }


  // 队员的全部骨架：主体在最前，附加层（多部件单位的后层）依 render_parts 的顺序排在其后。
  // 附加层只负责显示，位置/朝向/缩放等一切都跟随主体
  function getMemberParts(member) {
    if (!member) return [];
    const parts = [];
    if (member.character && member.character.active !== false) parts.push(member.character);
    (member.extraParts || []).forEach(part => {
      if (part && part.active !== false) parts.push(part);
    });
    return parts;
  }


  function forEachMemberPart(member, callback) {
    getMemberParts(member).forEach(callback);
  }


  // 队员的朝向缩放：默认素材原图朝右，向左移动时把 scaleX 取负做镜像；
  // 登记 art_facing_left 的兵种（Ares）原图朝左，镜像方向相反，否则画面上是「倒着走」
  function isMemberArtFacingLeft(member) {
    return !!(member.squad && member.squad.artFacingLeft === true);
  }


  function getMemberFacingScaleX(member, isLeft) {
    const mirrored = !!isLeft !== isMemberArtFacingLeft(member);
    return mirrored ? -member.visualScale : member.visualScale;
  }


  // 从当前的 scaleX 反推「此刻实际朝向哪一边」：镜像状态与「原图朝左」相同时实际朝右
  function isMemberFacingLeft(member) {
    const mirrored = !!(member.character && member.character.scaleX < 0);
    return mirrored !== isMemberArtFacingLeft(member);
  }


  function forEachPlayerCharacter(squad, callback) {
    if (squad.members.length) {
      squad.members.forEach(member => {
        // 阵亡冲锋中的队员已脱离小队，动画由各自的冲锋逻辑单独下发
        if (member.alive === false) return;
        // 多部件单位的所有部件都要下发（动画、交叉淡化、缩放都是一整套）
        forEachMemberPart(member, callback);
      });
    } else if (squad.character && squad.character.active !== false) {
      callback(squad.character);
    }
  }

export { applyFacingScale, createCircularTexture, createSpawnGlowTexture, createUnitShadowTexture, createExplosionTexture, createAttackShellTexture, createUnitShadow, getCharacterVerticalMetrics, getCharacterMuzzlePoint, resolveUnitRenderParts, getMemberParts, forEachMemberPart, isMemberArtFacingLeft, getMemberFacingScaleX, isMemberFacingLeft, forEachPlayerCharacter };
