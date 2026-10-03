"""从 backend/data/map.json 生成 frontend/js/map_data.js —— 让地图数据只维护一份。

真源：backend/data/map.json（{world, enemyRoutes, collisionRegions}）。
产物：frontend/js/map_data.js（window.MAP_DATA，script 标签数据源）；
http 模式下前端优先用 /api/map 下发的同一份 map.json，两者真源相同。

走廊变体（variants）不入库：它们依赖运行时常量（ENEMY_ROUTE_VARIANT_COUNT 等），
仍由 wg_game.js 在运行时派生并做安全校验。

用法：
    python backend/tools/build_map_data.py            # 从 map.json 生成 frontend/js/map_data.js
    python backend/tools/build_map_data.py --check    # 只校验是否同步（不同步则退出码 1）
"""

import hashlib
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.normpath(os.path.join(TOOLS_DIR, "..", "data"))
FB_DIR = os.path.normpath(os.path.join(TOOLS_DIR, "..", "..", "frontend", "js"))

SOURCE_PATH = os.path.join(DATA_DIR, "map.json")
TARGET_PATH = os.path.join(FB_DIR, "map_data.js")


def render(text):
    data = json.loads(text)

    # 结构断言：三键必须齐全，缺一不可生成
    for key in ("world", "enemyRoutes", "collisionRegions"):
        if key not in data:
            raise SystemExit(f"map.json 缺少必需的键：{key}")
    for key in ("mapBoundary", "walkableBoundary", "redForbiddenZones", "lineSegments"):
        if key not in data["collisionRegions"]:
            raise SystemExit(f"map.json collisionRegions 缺少必需的键：{key}")

    # 一致性断言：mapBoundary 外置后是具体数值（内联版引用 WORLD_WIDTH/WORLD_HEIGHT），
    # 必须等于 world 包络，防止未来改图时 world 与 mapBoundary 漂移
    boundary = data["collisionRegions"]["mapBoundary"]
    world = data["world"]
    expected = [
        {"x": 0, "y": 0},
        {"x": world["width"], "y": 0},
        {"x": world["width"], "y": world["height"]},
        {"x": 0, "y": world["height"]},
    ]
    if boundary != expected:
        raise SystemExit(
            f"map.json 的 collisionRegions.mapBoundary 与 world({world['width']}x{world['height']}) 不一致："
            f"实际为 {boundary}，应为 {expected}")

    if not data["enemyRoutes"]:
        raise SystemExit("map.json 的 enemyRoutes 为空")

    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]

    out = []
    w = out.append
    w("// ============================================================================")
    w("// 本文件由 backend/tools/build_map_data.py 从 backend/data/map.json 自动生成，请勿手工修改！")
    w("// 修改地图数据的流程：编辑 backend/data/map.json -> 运行 `python backend/tools/build_map_data.py`")
    w("// ============================================================================")
    w("")
    w("window.MAP_DATA = {")
    w('  source: "map.json",')
    w(f'  sourceSha1: "{digest}",')
    w("  world: " + json.dumps(data["world"], ensure_ascii=False, separators=(", ", ": ")) + ",")
    w("  // 敌军三波路线（字面量；走廊变体由 wg_game.js 运行时派生）")
    w("  enemyRoutes: " + json.dumps(data["enemyRoutes"], ensure_ascii=False, separators=(", ", ": ")) + ",")
    w("  // 统一碰撞区域配置")
    w("  collisionRegions: " + json.dumps(data["collisionRegions"], ensure_ascii=False, separators=(", ", ": ")))
    w("};")
    w("")
    return "\n".join(out)


def read_or_none(path):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return f.read()
    return None


def main():
    check_only = "--check" in sys.argv[1:]

    with open(SOURCE_PATH, encoding="utf-8") as f:
        text = f.read()

    rendered = render(text)
    existing = read_or_none(TARGET_PATH)

    if check_only:
        if existing == rendered:
            print("map_data.js 与 map.json 已同步")
            return 0
        print("map_data.js 与 map.json 不同步，请运行：python backend/tools/build_map_data.py")
        return 1

    if existing == rendered:
        print("map_data.js 已是最新，无需重写")
    else:
        with open(TARGET_PATH, "w", encoding="utf-8", newline="\n") as f:
            f.write(rendered)
        print("已生成 map_data.js")

    print(f"  源文件：backend/data/map.json（sha1 {hashlib.sha1(text.encode('utf-8')).hexdigest()[:12]}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
