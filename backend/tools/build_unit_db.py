"""从 unit_database.sql 生成 units.json 与 unit_db.py 数据 —— 让单位数值只维护一份。

唯一真源：backend/source/unit_database.sql（与 unit_database.xlsx 同目录，手工维护）。
本脚本一次性产出三个产物并保持同步：
    1. backend/data/units.json          —— 后端 /api/units 接口下发（http 模式数据源）
    2. frontend/js/unit_db.js           —— window.UNIT_DB（script 标签数据源）
    3. backend/data/unit_database.sql   —— 真源镜像（仅供后端侧参考，--check 校验其与真源一致）

用法：
    python backend/tools/build_unit_db.py            # 从真源 SQL 重新生成全部产物
    python backend/tools/build_unit_db.py --check    # 只校验三者是否与真源同步（不同步则退出码 1）
    python build_unit_db.py                          # 兼容旧入口（项目根薄壳）：转发到本脚本
"""

import hashlib
import json
import os
import re
import shutil
import sys

sys.stdout.reconfigure(encoding="utf-8")

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.normpath(os.path.join(TOOLS_DIR, ".."))
PROJECT_ROOT = os.path.normpath(os.path.join(BACKEND_DIR, ".."))
DATA_DIR = os.path.join(BACKEND_DIR, "data")
SOURCE_DIR = DATA_DIR                                           # 真源已并入 data/（source/ 目录已取消）
FRONTEND_JS = os.path.join(PROJECT_ROOT, "frontend", "js")      # 前端脚本目录

# 真源与产物路径
SQL_PATH = os.path.join(SOURCE_DIR, "unit_database.sql")        # 唯一可编辑真源
JSON_PATH = os.path.join(DATA_DIR, "units.json")                # 产物 1：API 数据
JS_PATH = os.path.join(FRONTEND_JS, "unit_db.js")               # 产物 2：script 标签数据
MIRROR_SQL_PATH = SQL_PATH                                      # 真源即在此目录，镜像概念取消

# 表名 -> (阵营, 兵种类别)：由表名唯一确定，不入库，生成时补齐
TABLE_META = {
    "player_infantry": ("player", "infantry"),
    "player_heavy": ("player", "heavy_tank"),
    "player_support": ("player", "medic"),
    "player_merc": ("player", "inf_temp"),
    "enemy_infantry": ("enemy", "infantry"),
    "enemy_heavy": ("enemy", "heavy_tank"),
    "enemy_support": ("enemy", "medic"),
}

# 现役单位：WG.html 运行时按这两个 unit_id 取记录。
# 现役单位必须填满所有列（页面上每个数值都来自这里），其余兵种可以先只填已知字段。
ACTIVE_UNITS = {"player_infantry": "JF", "enemy_infantry": "Vespid"}

# 出生界面按钮对应的兵种：部署扣点必须入库（WG.html 直接读 deploy_cost）
DEPLOY_UNITS = [
    ("player_infantry", "JF"),
    ("player_heavy", "tasa_air"),
    ("player_support", "mid"),
]

# 数值型类型（其余按字符串处理）
NUMERIC_TYPES = ("INT", "FLOAT", "REAL", "DOUBLE", "NUMERIC", "DECIMAL")


def strip_comment(line):
    return line.split("--", 1)[0]


def parse_sql(text):
    """返回 (tables, columns, rows)：

    tables  = [表名, ...]（按 SQL 出现顺序）
    columns = [(列名, 类型, 注释, 是否 NOT NULL), ...]（所有表结构一致，取第一张表）
    rows    = {表名: [{列名: 值}, ...]}
    """
    clean = "\n".join(strip_comment(line) for line in text.splitlines())

    tables = []
    columns = []
    for match in re.finditer(r"CREATE\s+TABLE\s+(\w+)\s*\((.*?)\n\s*\);", clean, re.S):
        table = match.group(1)
        tables.append(table)
        if columns:
            continue
        for line in match.group(2).splitlines():
            body = line.strip().rstrip(",").strip()
            if not body:
                continue
            name_match = re.match(r"(\w+)\s+(.*)$", body)
            if not name_match:
                continue
            col_name, rest = name_match.group(1), name_match.group(2)
            col_type = rest.split()[0]
            columns.append((col_name, col_type, "NOT NULL" in rest))

    if not tables:
        raise SystemExit("unit_database.sql 中没有解析到 CREATE TABLE 语句")

    rows = {table: [] for table in tables}
    for match in re.finditer(r"INSERT\s+INTO\s+(\w+)\s*\((.*?)\)\s*VALUES\s*\((.*?)\)\s*;", clean, re.S):
        table = match.group(1)
        if table not in rows:
            raise SystemExit(f"INSERT 指向未知的表：{table}")
        names = [n.strip() for n in match.group(2).split(",")]
        values = [v.strip().rstrip(",").strip() for v in match.group(3).splitlines() if v.strip()]
        if len(names) != len(values):
            raise SystemExit(f"{table}: 列数 {len(names)} 与值数 {len(values)} 不一致")
        record = {}
        for name, raw in zip(names, values):
            record[name] = parse_value(name, raw)
        rows[table].append(record)

    return tables, columns, rows


def parse_value(name, raw):
    if raw.upper() == "NULL":
        return None
    if len(raw) >= 2 and raw[0] == "'" and raw[-1] == "'":
        text = raw[1:-1].replace("''", "'")
        if name == "roster":
            # 全角逗号容错：Excel 里手输名单容易打成「，」，统一按半角逗号分隔
            text = text.replace("，", ",")
            return [part.strip() for part in text.split(",") if part.strip()]
        return text
    if re.fullmatch(r"-?\d+", raw):
        return int(raw)
    if re.fullmatch(r"-?\d*\.\d+(?:[eE][-+]?\d+)?", raw):
        return float(raw)
    raise SystemExit(f"无法解析的值：{raw}")


def validate(tables, columns, rows):
    """构建期一致性校验：结构、数值、以及跨表派生关系。"""
    problems = []

    expected = [name for name, _, _ in columns]
    for table in tables:
        if table not in TABLE_META:
            problems.append(f"表 {table} 未在 TABLE_META 中登记")
    for table in TABLE_META:
        if table not in tables:
            problems.append(f"缺少表 {table}")

    for table, records in rows.items():
        seen_ids = set()
        for record in records:
            unit_id = record.get("unit_id")
            if not unit_id:
                problems.append(f"{table}: 存在没有 unit_id 的记录")
                continue
            tag = f"{table}/{unit_id}"
            if unit_id in seen_ids:
                problems.append(f"{tag} 重复定义（unit_id 必须唯一）")
            seen_ids.add(unit_id)

            unknown = [name for name in record if name not in expected]
            if unknown:
                problems.append(f"{tag} 含未定义的列：{unknown}")
            for name, col_type, not_null in columns:
                value = record.get(name)
                if value is None:
                    if not_null and name in record:
                        problems.append(f"{tag} 的必填列 {name} 显式写成了 NULL")
                    continue
                if col_type.upper().startswith(NUMERIC_TYPES) and not isinstance(value, (int, float)):
                    problems.append(f"{tag}.{name} 应为数值，实为 {value!r}")
            if record.get("deploy_cost") is not None and record["deploy_cost"] < 0:
                problems.append(f"{tag}.deploy_cost 不能为负")
            if record.get("squad_size") and record.get("roster"):
                if len(record["roster"]) != record["squad_size"]:
                    problems.append(
                        f"{tag} 的 squad_size={record['squad_size']} "
                        f"与 roster 人数 {len(record['roster'])} 不一致")

            if (table, unit_id) in ACTIVE_UNITS.items():
                # 现役单位必须在 INSERT 里写全所有列（不适用的列显式写 NULL），
                # 这样「表里新增了一列却忘了给现役单位填」在构建期就会报出来
                missing = [name for name in expected if name not in record]
                if missing:
                    problems.append(f"现役单位 {tag} 缺少列：{missing}")

    for table, unit_id in ACTIVE_UNITS.items():
        found = [r for r in rows.get(table, []) if r.get("unit_id") == unit_id]
        if not found:
            problems.append(f"现役单位缺失：{table} / {unit_id}")

    for table, unit_id in DEPLOY_UNITS:
        record = next((r for r in rows.get(table, []) if r.get("unit_id") == unit_id), None)
        if record is None:
            problems.append(f"出生界面按钮对应的兵种缺失：{table} / {unit_id}")
        elif record.get("deploy_cost") is None:
            problems.append(f"出生界面按钮对应的兵种 {table}/{unit_id} 没有填 deploy_cost")

    # 「队员与敌方单位的隔离距离」= 我方队员碰撞半径 + 敌方碰撞半径
    player = next((r for r in rows.get("player_infantry", []) if r.get("unit_id") == ACTIVE_UNITS["player_infantry"]), None)
    enemy = next((r for r in rows.get("enemy_infantry", []) if r.get("unit_id") == ACTIVE_UNITS["enemy_infantry"]), None)
    if player and enemy:
        expect = player["member_collision_radius"] + enemy["collision_radius"]
        if player["member_enemy_separation"] != expect:
            problems.append(
                f"player_infantry/{player['unit_id']}.member_enemy_separation="
                f"{player['member_enemy_separation']}，应为队员半径 {player['member_collision_radius']} "
                f"+ 敌方半径 {enemy['collision_radius']} = {expect}")
        if player["roster"] and len(player["roster"]) != player["squad_size"]:
            problems.append("我方步兵花名册人数与编队人数不一致")

    return problems


def js_value(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, list):
        return "[" + ", ".join("'" + item.replace("'", "\\'") + "'" for item in value) + "]"
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def render_json(text, tables, columns, rows):
    """构建与 unit_db.js 中 window.UNIT_DB 完全同构的对象，输出 JSON。"""
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]
    database = {}
    for table in tables:
        records = []
        for record in rows.get(table, []):
            cleaned = {}
            for name, _, _ in columns:
                value = record.get(name)
                if value is None:
                    continue  # 不适用或未填的列不出现在记录里（与 render_js 一致）
                cleaned[name] = value
            records.append(cleaned)
        database[table] = records
    return {
        "source": "unit_database.sql",
        "sourceSha1": digest,
        "database": database,
    }


def render_js(text, tables, columns, rows):
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]
    out = []
    w = out.append
    w("// ============================================================================")
    w("// 本文件由 build_unit_db.py 从 unit_database.sql 自动生成，请勿手工修改！")
    w("// 修改单位数值的流程：编辑 unit_database.sql -> 运行 `python build_unit_db.py`")
    w("// ============================================================================")
    w("")
    w("window.UNIT_DB = {")
    w("  source: 'unit_database.sql',")
    w(f"  sourceSha1: '{digest}',")
    w("  // 单位数值：数据库记录（不适用或未填的列不出现在记录里）")
    w("  database: {")
    for table in tables:
        faction, category = TABLE_META[table]
        records = rows.get(table, [])
        w(f"    // {table}：阵营 {faction}，类别 {category}")
        w(f"    {table}: [")
        for record in records:
            w("      {")
            for name, _, _ in columns:
                value = record.get(name)
                if value is None:
                    continue
                w(f"        {name}: {js_value(value)},")
            w("      },")
        w("    ],")
    w("  }")
    w("};")
    w("")
    return "\n".join(out)


def read_or_none(path):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return f.read()
    return None


def write_if_changed(path, content):
    if read_or_none(path) == content:
        return False
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(content)
    return True


def main():
    check_only = "--check" in sys.argv[1:]

    with open(SQL_PATH, encoding="utf-8") as f:
        text = f.read()

    tables, columns, rows = parse_sql(text)
    problems = validate(tables, columns, rows)

    if problems:
        print("SQL 校验未通过：")
        for problem in problems:
            print("  -", problem)
        return 1

    payload = render_json(text, tables, columns, rows)
    rendered_json = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    rendered_js = render_js(text, tables, columns, rows)

    existing_json = read_or_none(JSON_PATH)
    existing_js = read_or_none(JS_PATH)
    existing_mirror = read_or_none(MIRROR_SQL_PATH)

    if check_only:
        ok = True
        if existing_json == rendered_json:
            print("units.json 与 unit_database.sql 已同步")
        else:
            print("units.json 与 unit_database.sql 不同步，请运行：python backend/tools/build_unit_db.py")
            ok = False
        if existing_js == rendered_js:
            print("unit_db.js 与 unit_database.sql 已同步")
        else:
            print("unit_db.js 与 unit_database.sql 不同步，请运行：python backend/tools/build_unit_db.py")
            ok = False
        if existing_mirror == text:
            print("镜像 unit_database.sql 与真源一致")
        else:
            print("镜像 backend/data/unit_database.sql 与真源 backend/source/unit_database.sql 不一致（真源为准），请运行：python backend/tools/build_unit_db.py")
            ok = False
        return 0 if ok else 1

    changed_json = write_if_changed(JSON_PATH, rendered_json)
    changed_js = write_if_changed(JS_PATH, rendered_js)
    changed_mirror = write_if_changed(MIRROR_SQL_PATH, text)
    if changed_json:
        print("已生成 units.json")
    else:
        print("units.json 已是最新，无需重写")
    if changed_js:
        print("已生成 unit_db.js")
    else:
        print("unit_db.js 已是最新，无需重写")
    if changed_mirror:
        print("已同步镜像 unit_database.sql")
    else:
        print("镜像 unit_database.sql 已是最新，无需重写")

    print(f"  源文件：backend/data/unit_database.sql（sha1 {hashlib.sha1(text.encode('utf-8')).hexdigest()[:12]}）")
    print(f"  表数量：{len(tables)}，列数量：{len(columns)}")
    for table in tables:
        records = rows.get(table, [])
        ids = ", ".join(str(r.get("unit_id")) for r in records) or "（暂无数据）"
        print(f"  {table:16} {len(records)} 行  {ids}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
