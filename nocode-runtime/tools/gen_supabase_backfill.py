#!/usr/bin/env python3
"""Gera backfill.sql (INSERTs idempotentes) a partir dos dados reais da Data API.

Lê data/raw/<api_type>.json (display names), mapeia para field_id→coluna (via user_types),
e emite INSERT ... ON CONFLICT (id) DO NOTHING para cada registro, na ordem de FK.
Casa com o schema de tools/gen_supabase_schema.py (mesma sanitização de identificador).

Uso: python3 tools/gen_supabase_backfill.py [saida.sql]
Default: → supabase/backfill.sql
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import _common as C  # noqa: E402

EXPORT_FILE, APP, SLUG = C.read_config()
RAW = C.app_paths(SLUG)["raw"]  # data/<slug>/raw
# (sem FK real no schema — refs são text — então a ordem de carga é irrelevante)
BUILTINS = {"_id": "id", "Created Date": "created_date", "Modified Date": "modified_date", "Created By": "created_by"}


def ident(name):
    s = re.sub(r"[^0-9a-zA-Z_]", "_", name).lower()
    if re.match(r"^\d", s):
        s = "f_" + s
    return s[:63]


def table_name(internal):
    return "usuario" if internal == "user" else ident(internal)


def field_type_map(user_types):
    """internal_type -> {field_id: value}"""
    out = {}
    for t, d in user_types.items():
        if isinstance(d, dict):
            out[t] = {fid: (f or {}).get("value", "text") for fid, f in (d.get("fields") or {}).items()}
    return out


def display_to_fieldid(internal, user_types):
    fields = (user_types.get(internal) or {}).get("fields", {})
    m = {}
    for fid, f in fields.items():
        disp = f.get("display")
        if disp and disp not in m:
            m[disp] = fid
        m[fid] = fid
    return m


def col_for(fid):
    c = ident(fid)
    return "f_" + c if c in ("id", "created_date", "modified_date", "created_by") else c


def valid_columns(internal, user_types):
    """Colunas que EXISTEM no schema para este tipo (espelha gen_supabase_schema)."""
    cols = {"id", "created_date", "modified_date", "created_by", "_raw"}
    for fid, f in (user_types.get(internal) or {}).get("fields", {}).items():
        if f.get("deleted"):
            continue
        cols.add(col_for(fid))
    if internal == "user":
        cols.add("email")
        cols.add("password")
    return cols


def lit(v, value_type):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if value_type and value_type.startswith("list."):
        items = v if isinstance(v, list) else [v]
        inner = value_type[5:]
        if inner in ("number",):
            arr = ", ".join(str(float(x)) for x in items if x is not None)
            return f"array[{arr}]::double precision[]"
        if inner == "boolean":
            arr = ", ".join("true" if x else "false" for x in items)
            return f"array[{arr}]::boolean[]"
        arr = ", ".join("'" + str(x).replace("'", "''") + "'" for x in items if x is not None)
        return f"array[{arr}]::text[]"
    if value_type == "geographic_address" or isinstance(v, (dict, list)):
        return "'" + json.dumps(v, ensure_ascii=False).replace("'", "''") + "'::jsonb"
    if value_type == "number":
        try:
            return str(float(v))
        except (TypeError, ValueError):
            return "null"
    if value_type == "boolean":
        return "true" if v else "false"
    return "'" + str(v).replace("'", "''") + "'"


def build_option_index(option_sets):
    """set_id -> {display|id|db_value (upper/lower) : db_value canônico}."""
    idx = {}
    for set_id, s in option_sets.items():
        if not isinstance(s, dict):
            continue
        m = {}
        for opt_id, v in (s.get("values") or {}).items():
            dbv = v.get("db_value", opt_id)
            for key in (v.get("display"), opt_id, dbv):
                if key is not None:
                    m[str(key)] = dbv
                    m[str(key).upper()] = dbv
                    m[str(key).lower()] = dbv
        idx[set_id] = m
    return idx


def norm_option(value, set_ref, option_index):
    """Converte display/id da Data API para o db_value canônico."""
    m = option_index.get(set_ref.replace("option.", ""), {})
    if isinstance(value, list):
        return [m.get(str(x), m.get(str(x).upper(), x)) for x in value]
    return m.get(str(value), m.get(str(value).upper(), value))


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "supabase", "backfill.sql")
    data = json.load(open(EXPORT_FILE))
    user_types = data["user_types"]
    ftypes = field_type_map(user_types)
    option_index = build_option_index(data["option_sets"])

    available = C.raw_api_types(RAW)
    API_TO_INTERNAL = C.build_api_to_internal(user_types, available)

    os.makedirs(os.path.dirname(out), exist_ok=True)
    L = ["-- backfill.sql — dados reais da Data API → schema Supabase (idempotente)",
         "-- gerado por tools/gen_supabase_backfill.py", "begin;", ""]

    total = 0
    for api_type in available:
        internal = API_TO_INTERNAL.get(api_type)
        if not internal:
            continue
        path = os.path.join(RAW, f"{api_type}.json")
        if not os.path.exists(path):
            continue
        rows = json.load(open(path))
        tn = table_name(internal)
        mapping = display_to_fieldid(internal, user_types)
        ftype = ftypes.get(internal, {})
        valid = valid_columns(internal, user_types)
        L.append(f"-- {tn}: {len(rows)} registros")
        for r in rows:
            cols, vals = [], []
            extra = {}  # campos sem coluna no schema → _raw jsonb
            seen = set()
            for k, v in r.items():
                if k == "authentication" and internal == "user":
                    email = (v or {}).get("email", {}).get("email")
                    if email:
                        cols.append('"email"')
                        vals.append(lit(email, "text"))
                        seen.add("email")
                    continue
                if k in BUILTINS:
                    cols.append(f'"{BUILTINS[k]}"')
                    vals.append(lit(v, "date" if "Date" in k else "text"))
                    seen.add(BUILTINS[k])
                    continue
                fid = mapping.get(k, k)
                col = col_for(fid)
                if col in valid and col not in seen:
                    vt = ftype.get(fid, "text")
                    # normaliza options (Data API devolve display) → db_value canônico
                    if vt.startswith("option."):
                        v = norm_option(v, vt, option_index)
                    elif vt.startswith("list.option."):
                        v = norm_option(v, vt[5:], option_index)
                    cols.append(f'"{col}"')
                    vals.append(lit(v, vt))
                    seen.add(col)
                else:
                    extra[k] = v
            if extra:
                cols.append('"_raw"')
                vals.append("'" + json.dumps(extra, ensure_ascii=False).replace("'", "''") + "'::jsonb")
            if not cols:
                continue
            L.append(f'insert into "{tn}" ({", ".join(cols)}) values ({", ".join(vals)}) on conflict (id) do nothing;')
            total += 1
        L.append("")

    L.append("commit;")
    open(out, "w").write("\n".join(L))
    size = os.path.getsize(out) / 1024 / 1024
    print(f"backfill.sql -> {out} ({size:.1f} MB, {total} INSERTs)")


if __name__ == "__main__":
    main()
