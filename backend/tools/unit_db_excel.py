"""unit_database.sql <-> unit_database.xlsx 双向转换：Excel 里改完数值可以直接导回 SQL。

用法：
    python unit_db_excel.py --export   # unit_database.sql -> unit_database.xlsx（导出全部单位表）
    python unit_db_excel.py --import   # unit_database.xlsx -> unit_database.sql，并自动重建 units.json
    python unit_db_excel.py --check    # 只比对 Excel 与 SQL 的差异，不写任何文件

Excel 结构（转置格式：一列一个单位，一行一个字段）：
    每个单位表一个 Sheet（player_infantry / player_heavy / ... / enemy_support），Sheet 内：
      第 1 行        表名 + 中文说明
      第 2 行（X 轴） A2 = '字段 \\ 单位'，B2 = '中文说明'，C 列起每列一个单位（表头 = unit_id）
      第 3 行起（Y 轴）A 列 = 字段英文名（与 unit_database.sql 的列名完全一致，导入时按它定位），
                      B 列 = 中文说明（取自建表注释），C 列起 = 该字段在每个单位上的数值
    空单元格与「—」都表示 NULL；另有两张非数据 Sheet「总览」「说明」，导入时自动忽略。
    读取时自动识别布局：本格式与行式旧格式（一行一个单位）都能导入。

导入规则：
    - 已存在的单位：沿用它在 SQL 里原本登记的列集合，只覆盖取值。
      Excel 里有值、SQL 原本没登记的列会被补上；原本登记、Excel 留空的列写回 NULL。
    - SQL 里没有的单位：按 Sheet 所属的表追加一条新记录（登记全部列）。
    - 写入前先用 unit_database.sql 自带的校验规则（build_unit_db.py）自检，
      不通过就报错退出、原文件一个字节都不动。
"""

import os
import re
import subprocess
import sys

import openpyxl
from openpyxl.styles import Alignment, Font

import build_unit_db as db

sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.normpath(os.path.join(ROOT, "..", "data"))
SOURCE_DIR = DATA_DIR                                          # 真源已并入 data/（source/ 目录已取消）
SQL_PATH = os.path.join(SOURCE_DIR, "unit_database.sql")        # 真源（手工维护）
XLSX_PATH = os.path.join(SOURCE_DIR, "unit_database.xlsx")      # 真源配套 Excel（手工维护）
BUILD_SCRIPT = os.path.join(ROOT, "build_unit_db.py")

NULL_CELL = "—"                     # Excel 里表示 NULL 的占位符（空单元格同样视为 NULL）
NON_DATA_SHEETS = ("总览", "说明")
COLUMN_LINE_WIDTH = 78              # 多行列名折行宽度（与 unit_database.sql 现有排版接近）
NUMERIC_TYPES = db.NUMERIC_TYPES

INSERT_RE = re.compile(
    r"INSERT\s+INTO\s+(\w+)\s*\(([^)]*)\)\s*VALUES\s*\((.*?)\)\s*;", re.S
)


# ---------------------------------------------------------------------------
# 建表结构：列名 / 类型 / 中文说明（各表结构一致，取第一张表）
# ---------------------------------------------------------------------------
def read_schema(text):
    """返回 [(列名, 类型, 中文说明), ...]，顺序与 unit_database.sql 一致。"""
    block = re.search(r"CREATE\s+TABLE\s+\w+\s*\((.*?)\n\s*\);", text, re.S)
    if not block:
        raise SystemExit("unit_database.sql 里没有解析到 CREATE TABLE")
    columns = []
    for line in block.group(1).splitlines():
        body = line.strip()
        if not body or body.startswith("--"):
            continue
        comment = ""
        if "--" in line:
            body, comment = line.split("--", 1)
            body, comment = body.strip(), comment.strip()
        body = body.rstrip(",").strip()
        parts = body.split(None, 1)
        if len(parts) < 2:
            continue
        name, rest = parts[0], parts[1]
        col_type = rest.split()[0]
        columns.append((name, col_type, comment))
    if not columns:
        raise SystemExit("unit_database.sql 的建表语句里没有解析到列定义")
    return columns


def is_numeric(col_type):
    return col_type.upper().startswith(NUMERIC_TYPES)


# ---------------------------------------------------------------------------
# 取值 <-> 单元格
# ---------------------------------------------------------------------------
def to_cell(value):
    """SQL 取值 -> Excel 单元格：None 写成占位符，数值保持数值型便于直接算。
    列表（roster）按 SQL 里的写法拼回去（逗号后不加空格），保证导回后逐字节一致。"""
    if value is None:
        return NULL_CELL
    if isinstance(value, list):
        return ",".join(str(item) for item in value)
    return value


def parse_number(raw, col_type, where):
    if isinstance(raw, bool):
        raise SystemExit(f"{where} 需要数值，实为布尔值")
    if isinstance(raw, (int, float)):
        number = raw
    else:
        text = str(raw).strip()
        try:
            number = int(text) if re.fullmatch(r"-?\d+", text) else float(text)
        except ValueError:
            raise SystemExit(f"{where} 需要数值，实为 {text!r}")
    # 声明为 INT 的列在实际数据里也可能写小数（例如 action_value = 2.5），
    # 因此只在确实取整时才转成整数，其余按原样保留，不强行报错
    if col_type.upper().startswith("INT") and isinstance(number, float) and abs(number - round(number)) < 1e-9:
        number = int(round(number))
    return number


def from_cell(raw, col_type, where):
    """Excel 单元格 -> SQL 取值：空单元格与「—」都是 NULL。"""
    if raw is None:
        return None
    if isinstance(raw, str):
        text = raw.strip()
        if text == "" or text == NULL_CELL:
            return None
        if is_numeric(col_type):
            return parse_number(text, col_type, where)
        return text
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return parse_number(raw, col_type, where)
    return str(raw)


def render_value(value):
    """SQL 取值 -> SQL 字面量（字符串加单引号；整数不带小数点）。"""
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, list):
        # roster 这类逗号分隔的列表：按 SQL 里的写法拼回去（逗号后不加空格）
        return "'" + ",".join(str(item) for item in value) + "'"
    if isinstance(value, float):
        if abs(value - round(value)) < 1e-9:
            return str(int(round(value)))
        return repr(round(value, 10))
    return "'" + str(value).replace("\\", "\\\\").replace("'", "''") + "'"


# ---------------------------------------------------------------------------
# 导出：unit_database.sql -> unit_database.xlsx
# ---------------------------------------------------------------------------
def export():
    with open(SQL_PATH, encoding="utf-8") as handle:
        text = handle.read()
    tables, _, rows = db.parse_sql(text)
    schema = read_schema(text)

    workbook = openpyxl.Workbook()
    overview = workbook.active
    overview.title = "总览"
    overview.append(["表名", "阵营 / 类别", "单位数", "单位列表"])
    for table in tables:
        faction, category = db.TABLE_META[table]
        records = rows.get(table, [])
        ids = ", ".join(str(record.get("unit_id")) for record in records) or "（暂无数据）"
        overview.append([table, f"{faction} / {category}", len(records), ids])

    header_font = Font(bold=True)
    for table in tables:
        sheet = workbook.create_sheet(table)
        faction, category = db.TABLE_META[table]
        records = rows.get(table, [])
        sheet.cell(1, 1, f'表名: {table}（{faction} / {category}）').font = header_font
        # 转置布局：X 轴表头 = 每个单位的 unit_id（一列一个单位），Y 轴 = 字段（英文名 + 中文说明 + 数值）
        sheet.cell(2, 1, '字段 \\ 单位').font = header_font
        sheet.cell(2, 2, '中文说明').font = header_font
        for col_index, record in enumerate(records, start=3):
            sheet.cell(2, col_index, to_cell(record.get('unit_id'))).font = header_font
        for row_index, (name, _, comment) in enumerate(schema, start=3):
            sheet.cell(row_index, 1, name).font = header_font
            description_cell = sheet.cell(row_index, 2, comment)
            description_cell.font = Font(italic=True, color='808080')
            description_cell.alignment = Alignment(wrap_text=False)
            for col_index, record in enumerate(records, start=3):
                sheet.cell(row_index, col_index, to_cell(record.get(name)))
        sheet.freeze_panes = 'C3'          # 冻结字段名列与说明列、前两行，纵向滚动时仍看得见表头
        sheet.column_dimensions['A'].width = 26
        sheet.column_dimensions['B'].width = 46
        for column in sheet.iter_cols(min_row=2, max_row=2):
            letter = column[0].column_letter
            if letter not in ('A', 'B'):
                sheet.column_dimensions[letter].width = 14

    guide = workbook.create_sheet("说明")
    for line in [
        "unit_database.xlsx —— 单位数据表（可导出 / 可导回 unit_database.sql）",
        "",
        "布局（转置格式）：一列一个单位，一行一个字段。",
        "  X 轴：第 2 行为表头，C 列起每列一个单位（表头 = unit_id）",
        "  Y 轴：A 列 = 字段英文名，B 列 = 中文说明，C 列起 = 各单位在该字段上的数值",
        "",
        "工作流：",
        "  1. 在对应 Sheet 里改数值（按列改单位：顺着字段名那一行找到单位所在的列）",
        "  2. 运行 python unit_db_excel.py --import   把改动写回 unit_database.sql",
        "     （脚本会顺带重建 units.json，经后端 /api/units 下发，刷新页面即可生效）",
        "  3. 想先看差异不写文件：python unit_db_excel.py --check",
        "  4. 想用最新的 SQL 覆盖本表：python unit_db_excel.py --export",
        "",
        "填写规则：",
        "  - 空单元格与「—」都表示 NULL（该字段不填值）",
        "  - A 列字段名、第 2 行 unit_id 表头与 Sheet 名请勿改动，导入时按它们定位",
        "  - 新增单位：在第 2 行表头右侧追加一列并填 unit_id，不能与同表其他单位重复",
        "  - 「总览」「说明」两张 Sheet 只供阅读，导入时自动忽略",
        "",
        "表与 Sheet 的对应：",
    ]:
        guide.append([line])
    for table in tables:
        faction, category = db.TABLE_META[table]
        guide.append([f"  {table}  阵营 {faction} / 类别 {category}   {len(rows.get(table, []))} 个单位"])
    guide.column_dimensions["A"].width = 96

    workbook.save(XLSX_PATH)
    print(f"已导出 {os.path.basename(XLSX_PATH)}")
    for table in tables:
        print(f"  {table:16} {len(rows.get(table, []))} 行")
    print(f"  列数：{len(schema)}")
    return 0


# ---------------------------------------------------------------------------
# 读取 Excel（自动识别两种布局：
#   转置格式：一列一个单位（X 轴表头 = unit_id），一行一个字段（Y 轴 = 英文名 + 说明 + 数值）
#   行式旧格式：一行一个单位（第 2 行列名、第 3 行说明、第 4 行起数据）
# 两种布局都返回 {表名: ([(序号, 列名), ...], [ {列名: 取值}, ... ])}，导入逻辑完全共用
# ---------------------------------------------------------------------------
def read_sheet_transposed(sheet):
    """解析转置格式：第 2 行为表头（A2 = '字段 \\ 单位'），C 列起每列一个单位；
    A 列自第 3 行起为字段英文名，B 列为中文说明（导入忽略）。"""
    unit_columns = []
    for column in range(3, sheet.max_column + 1):
        value = sheet.cell(2, column).value
        if value is None or str(value).strip() == '':
            continue
        unit_columns.append(column)
    fields = []
    for row in range(3, sheet.max_row + 1):
        name = sheet.cell(row, 1).value
        if name is None or str(name).strip() == '':
            continue
        fields.append((row, str(name).strip()))
    records = []
    for column in unit_columns:
        record = {}
        for row, name in fields:
            record[name] = sheet.cell(row, column).value
        if all(value is None or str(value).strip() == '' for value in record.values()):
            continue                       # 整列空白：跳过
        records.append(record)
    columns = [(index, name) for index, (_, name) in enumerate(fields, start=1)]
    return columns, records


def read_sheet_row_based(sheet):
    """解析行式旧格式：列名行为第一列 = 'unit_id' 的那一行，其下一行为中文说明，再往下每行一个单位。"""
    header_row = None
    for row in range(1, min(6, sheet.max_row) + 1):
        if str(sheet.cell(row, 1).value or '').strip() == 'unit_id':
            header_row = row
            break
    if header_row is None:
        raise SystemExit(f'{sheet.subtitle}: 找不到列名行（第一列应为 unit_id）')
    columns = []
    for column in range(1, sheet.max_column + 1):
        value = sheet.cell(header_row, column).value
        if value is None or str(value).strip() == '':
            continue
        columns.append((column, str(value).strip()))
    records = []
    for row in range(header_row + 2, sheet.max_row + 1):   # 列名行下面是中文说明行
        record = {}
        for column, name in columns:
            record[name] = sheet.cell(row, column).value
        if all(value is None or str(value).strip() == '' for value in record.values()):
            continue                                       # 整行空白：跳过
        records.append(record)
    return columns, records


def read_excel():
    """返回 {表名: ([(序号, 列名), ...], [ {列名: 取值}, ... ])}，只读 7 张单位表。"""
    workbook = openpyxl.load_workbook(XLSX_PATH, data_only=True)
    result = {}
    for sheet_name in workbook.sheetnames:
        if sheet_name in NON_DATA_SHEETS:
            continue
        if sheet_name not in db.TABLE_META:
            # 预留的设计稿 Sheet（例如尚在整理的新兵种表）：不参与导入，只提示一句
            print(f"  跳过未登记的表 Sheet：{sheet_name}")
            continue
        sheet = workbook[sheet_name]
        if str(sheet.cell(2, 1).value or '').strip() == '字段 \\ 单位':
            columns, records = read_sheet_transposed(sheet)
        else:
            columns, records = read_sheet_row_based(sheet)
        result[sheet_name] = (columns, records)
    for table in db.TABLE_META:
        if table not in result:
            raise SystemExit(f"Excel 缺少表 Sheet：{table}")
    return result


# ---------------------------------------------------------------------------
# 导入：unit_database.xlsx -> unit_database.sql
# ---------------------------------------------------------------------------
def split_top_level(text):
    """按顶层逗号切分（跳过单引号内的逗号，roster 这类带逗号的字符串不会被切错）。"""
    parts = []
    buffer = []
    in_string = False
    index = 0
    while index < len(text):
        char = text[index]
        if in_string:
            buffer.append(char)
            if char == "'":
                if index + 1 < len(text) and text[index + 1] == "'":
                    buffer.append(text[index + 1])
                    index += 2
                    continue
                in_string = False
        elif char == "'":
            in_string = True
            buffer.append(char)
        elif char == ",":
            parts.append("".join(buffer))
            buffer = []
        else:
            buffer.append(char)
        index += 1
    parts.append("".join(buffer))
    return [part.strip() for part in parts]


def unwrap(token):
    if len(token) >= 2 and token[0] == "'" and token[-1] == "'":
        return token[1:-1].replace("''", "'")
    return token


def wrap_columns(columns):
    """多行列名：按宽度折行，尽量与 unit_database.sql 现有排版一致。"""
    lines = []
    current = ""
    for name in columns:
        candidate = f"{current}, {name}" if current else name
        if current and len(candidate) > COLUMN_LINE_WIDTH:
            lines.append("  " + current + ",")
            current = name
        else:
            current = candidate
    if current:
        lines.append("  " + current)
    return "\n".join(lines)


def render_insert(table, columns, values, multiline_columns, multiline_values, original_columns_text=None):
    """生成一条 INSERT。列集合没变时原样沿用 SQL 里已有的列名排版，
    这样「只改了一个数值」的导入只会在文件里产生一行 diff。"""
    if original_columns_text is not None:
        column_text = original_columns_text
    elif multiline_columns:
        column_text = wrap_columns(columns)
    else:
        column_text = ", ".join(columns)
    if multiline_columns:
        header = f"INSERT INTO {table} (\n{column_text}\n)"
    else:
        header = f"INSERT INTO {table} ({column_text})"
    if multiline_values:
        value_text = ",\n".join("  " + render_value(value) for value in values)
        return f"{header} VALUES (\n{value_text}\n);"
    return f"{header} VALUES ({', '.join(render_value(value) for value in values)});"


def build_new_sql(text, excel):
    schema = read_schema(text)
    type_of = {name: col_type for name, col_type, _ in schema}
    order = {name: index for index, (name, _, _) in enumerate(schema)}
    schema_names = [name for name, _, _ in schema]

    matches = list(INSERT_RE.finditer(text))
    table_create_end = {}
    for match in re.finditer(r"CREATE\s+TABLE\s+(\w+)\s*\(.*?\n\s*\);", text, re.S):
        table_create_end[match.group(1)] = match.end()

    targets = []
    used_ids = {}
    for match in matches:
        table = match.group(1)
        columns = [name.strip() for name in match.group(2).split(",") if name.strip()]
        raw_values = split_top_level(match.group(3))
        if len(columns) != len(raw_values):
            raise SystemExit(f"{table}: 列数 {len(columns)} 与值数 {len(raw_values)} 不一致")
        if "unit_id" not in columns:
            raise SystemExit(f"{table}: INSERT 缺少 unit_id 列")
        unit_id = unwrap(raw_values[columns.index("unit_id")])
        if unit_id in used_ids:
            raise SystemExit(f"{table}/{unit_id}: unit_database.sql 里重复定义")
        used_ids[unit_id] = table
        raw_columns = match.group(2)
        targets.append({
            "table": table,
            "unit_id": unit_id,
            "columns": columns,
            "start": match.start(),
            "end": match.end(),
            "multiline_columns": "\n" in raw_columns,
            "multiline_values": "\n" in match.group(3),
            # 原始列名排版（去掉首尾换行、保留内部换行）：列集合没变时原样写回
            "columns_text": raw_columns.strip("\n") if "\n" in raw_columns else raw_columns.strip(),
            "values": dict(zip(columns, raw_values)),
        })

    appended = []
    replacements = []
    for table, (columns, records) in excel.items():
        for record in records:
            sheet_columns = [name for _, name in columns]
            for name in sheet_columns:
                if name not in type_of:
                    raise SystemExit(f"{table}: Excel 里有未定义的列 {name}")
            unit_id = record.get("unit_id")
            unit_id = "" if unit_id is None else str(unit_id).strip()
            if not unit_id:
                raise SystemExit(f"{table}: 有一行没有填 unit_id")
            values = {}
            for name in sheet_columns:
                where = f"{table}/{unit_id}.{name}"
                cell = record.get(name)
                # roster 名单容错：Excel 里手输的全角逗号统一规范成半角再写进 SQL
                if name == "roster" and isinstance(cell, str) and "，" in cell:
                    cell = cell.replace("，", ",")
                values[name] = from_cell(cell, type_of[name], where)
            target = next((item for item in targets if item["table"] == table
                           and item["unit_id"] == unit_id), None)
            if target is None:
                owner = used_ids.get(unit_id)
                if owner and owner != table:
                    raise SystemExit(f"{unit_id}: 已存在于表 {owner}，不能重复登记到 {table}")
                if unit_id in [item[1] for item in appended]:
                    raise SystemExit(f"{table}/{unit_id}: Excel 里重复了一行")
                appended.append((table, unit_id, values))
                continue
            # 沿用 SQL 原本登记的列集合；Excel 里有值的列若原本没登记就补上
            final_columns = list(target["columns"])
            for name in schema_names:
                if name in values and values[name] is not None and name not in final_columns:
                    final_columns.append(name)
            final_columns.sort(key=lambda name: order.get(name, 999))
            final_values = []
            for name in final_columns:
                if name in values:
                    final_values.append(values[name])
                else:
                    # 表格里根本没有这一列（表格比 unit_database.sql 旧）：保留 SQL 原值，
                    # 不要把后来新增字段的数据清空
                    raw = target["values"].get(name)
                    final_values.append(None if raw is None else db.parse_value(name, raw))
            replacements.append((target, final_columns, final_values))

    new_text = text
    for target, final_columns, final_values in sorted(replacements, key=lambda item: item[0]["start"], reverse=True):
        same_columns = final_columns == target["columns"]
        rendered = render_insert(
            target["table"], final_columns, final_values,
            target["multiline_columns"], target["multiline_values"],
            target["columns_text"] if same_columns else None
        )
        new_text = new_text[:target["start"]] + rendered + new_text[target["end"]:]

    for table, unit_id, values in appended:
        final_columns = [name for name in schema_names if values.get(name) is not None] or ["unit_id"]
        if "unit_id" not in final_columns:
            final_columns.insert(0, "unit_id")
        final_values = [unit_id if name == "unit_id" else values.get(name) for name in final_columns]
        rendered = render_insert(table, final_columns, final_values, True, True)
        # 追加锚点必须在「替换后的当前文本」上重新定位：前面的原位替换可能拉长 / 缩短
        # 同表已有 INSERT 的长度，最初按原文记录的 match.end() 偏移此时已经失效，
        # 沿用旧偏移会把新记录插进别的记录中间、写坏整条 INSERT
        anchor = None
        for match in INSERT_RE.finditer(new_text):
            if match.group(1) == table:
                anchor = match.end()
        if anchor is None:
            create = re.search(r"CREATE\s+TABLE\s+" + table + r"\s*\(.*?\n\s*\);", new_text, re.S)
            if create is None:
                raise SystemExit(f"{table}: 找不到可插入新记录的位置")
            anchor = create.end()
        new_text = new_text[:anchor] + "\n" + rendered + "\n" + new_text[anchor:]
        print(f"  新增记录：{table}/{unit_id}")

    return new_text


def diff_rows(before_text, after_text):
    """比对两份 SQL 的单位取值差异，返回 [(表/单位, 列, 旧值, 新值), ...]。"""
    _, _, before = db.parse_sql(before_text)
    _, _, after = db.parse_sql(after_text)
    changes = []
    for table, records in after.items():
        old_map = {record.get("unit_id"): record for record in before.get(table, [])}
        for record in records:
            unit_id = record.get("unit_id")
            old = old_map.get(unit_id)
            if old is None:
                changes.append((f"{table}/{unit_id}", "(整条记录)", "不存在", "新增"))
                continue
            for name, value in record.items():
                if old.get(name) != value:
                    changes.append((f"{table}/{unit_id}", name, old.get(name), value))
    for table, records in before.items():
        after_ids = {record.get("unit_id") for record in after.get(table, [])}
        for record in records:
            if record.get("unit_id") not in after_ids:
                changes.append((f"{table}/{record.get('unit_id')}", "(整条记录)", "存在", "被删除"))
    return changes


def import_from_excel(check_only, skip_tables=()):
    with open(SQL_PATH, encoding="utf-8") as handle:
        text = handle.read()
    excel = read_excel()
    for name in skip_tables:
        if name in excel:
            print(f"  按参数跳过表：{name}")
            excel.pop(name)
    new_text = build_new_sql(text, excel)

    # 写入前先按 unit_database.sql 自带的规则校验，避免把坏数据写进唯一真源
    tables, columns, rows = db.parse_sql(new_text)
    problems = db.validate(tables, columns, rows)
    if problems:
        print("导入内容未通过 unit_database.sql 的校验，原文件未改动：")
        for problem in problems:
            print("  -", problem)
        return 1

    changes = diff_rows(text, new_text)
    if check_only:
        if not changes:
            print("Excel 与 unit_database.sql 已一致，没有差异")
        else:
            print(f"Excel 与 unit_database.sql 有 {len(changes)} 处差异：")
            for target, name, old, new in changes[:40]:
                print(f"  {target} {name}: {old} -> {new}")
            if len(changes) > 40:
                print(f"  ...（其余 {len(changes) - 40} 处略）")
        return 0

    if not changes:
        print("Excel 与 unit_database.sql 已一致，无需写回")
        return 0

    with open(SQL_PATH, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(new_text)
    print(f"已写回 unit_database.sql（{len(changes)} 处改动）")
    for target, name, old, new in changes[:20]:
        print(f"  {target} {name}: {old} -> {new}")
    if len(changes) > 20:
        print(f"  ...（其余 {len(changes) - 20} 处略）")

    print("重建 units.json：")
    result = subprocess.run([sys.executable, BUILD_SCRIPT], cwd=ROOT)
    return result.returncode


def main():
    global XLSX_PATH
    args = sys.argv[1:]
    # 可选：--xlsx <路径> 指定本次读写的 Excel 文件（默认 unit_database.xlsx）
    if "--xlsx" in args:
        index = args.index("--xlsx")
        if index + 1 >= len(args):
            raise SystemExit("--xlsx 后面要跟文件路径")
        XLSX_PATH = os.path.abspath(args[index + 1])
    # 可选：--skip-table <表名>（逗号分隔可多个）本次导入忽略这些表
    skip_tables = []
    if "--skip-table" in args:
        index = args.index("--skip-table")
        if index + 1 >= len(args):
            raise SystemExit("--skip-table 后面要跟表名（逗号分隔可多个）")
        skip_tables = [n.strip() for n in args[index + 1].split(",") if n.strip()]
    if "--export" in args:
        return export()
    if "--import" in args:
        return import_from_excel(False, skip_tables)
    if "--check" in args:
        return import_from_excel(True, skip_tables)
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main())