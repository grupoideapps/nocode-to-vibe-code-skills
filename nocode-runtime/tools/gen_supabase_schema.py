#!/usr/bin/env python3
"""Gera schema.sql (Postgres/Supabase) a partir de user_types + option_sets do export.

- Cada user_type → tabela. field_id = nome da coluna.
- Tipos no-code → Postgres (ver TYPE_MAP). Referências (custom.<t>/user) → text (guarda o _id da plataforma).
- Listas (list.X) → arrays Postgres (text[]/numeric[]) — Things viram text[] de ids.
- option.<set> → text + comentário (valores controlados pela tabela os_<set>).
- option_sets → tabelas `os_<set>` (id, db_value, display, sort_factor, + atributos) populadas.
- Built-ins em toda tabela: id (PK, text — _id da plataforma), created_date, modified_date, created_by.
- RLS habilitado com policy permissiva (ajustar depois) — comporta-se como o app (que ignora privacy).

Uso: python3 tools/gen_supabase_schema.py [caminho/app.bubble] [saida.sql]
Default: ../apps/app-eventos/app-eventos.bubble → supabase/schema.sql
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# no-code field type (value) → Postgres
SCALAR_MAP = {
    "text": "text",
    "number": "double precision",
    "boolean": "boolean",
    "date": "timestamptz",
    "dateinterval": "double precision",  # no-code guarda intervalo de tempo como número (ms)
    "image": "text",
    "file": "text",
    "geographic_address": "jsonb",
    "date_range": "jsonb",  # {start,end} da Data API — jsonb é mais robusto que tstzrange
    "user": "text",  # FK lógica para usuario(id)
}


def ident(name: str) -> str:
    """Sanitiza um field_id para identificador Postgres seguro (mantém legível)."""
    s = re.sub(r"[^0-9a-zA-Z_]", "_", name).lower()
    if re.match(r"^\d", s):
        s = "f_" + s
    return s[:63]


def pg_type(value: str) -> tuple[str, str | None]:
    """Retorna (tipo_postgres, comentario) para um value de campo no-code."""
    if value in SCALAR_MAP:
        return SCALAR_MAP[value], ("ref->usuario.id" if value == "user" else None)
    if value.startswith("custom."):
        return "text", f"ref->{ident(value[7:])}.id"
    if value.startswith("option."):
        return "text", f"option->os_{ident(value[7:])}.db_value"
    if value.startswith("list."):
        inner = value[5:]
        if inner == "text":
            return "text[]", None
        if inner == "number":
            return "double precision[]", None
        if inner == "boolean":
            return "boolean[]", None
        if inner == "user" or inner.startswith("custom."):
            tgt = "usuario" if inner == "user" else ident(inner[7:])
            return "text[]", f"ref-list->{tgt}.id"
        if inner.startswith("option."):
            return "text[]", f"option-list->os_{ident(inner[7:])}.db_value"
        return "text[]", None
    return "jsonb", f"tipo desconhecido: {value}"


# tipos internos viram nomes de tabela amigáveis (sem prefixo custom., user especial)
def table_name(internal: str) -> str:
    return "usuario" if internal == "user" else ident(internal)


def main():
    sys.path.insert(0, HERE)
    import _common as C
    cfg_export, _app, _slug = C.read_config()
    src = sys.argv[1] if len(sys.argv) > 1 else cfg_export
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "supabase", "schema.sql")
    data = json.load(open(src))
    user_types = data["user_types"]
    option_sets = data["option_sets"]

    os.makedirs(os.path.dirname(out), exist_ok=True)
    L = []
    L.append("-- schema.sql — gerado de export por tools/gen_supabase_schema.py")
    L.append("-- Postgres / Supabase. Rode no SQL editor ou via migration.")
    L.append("-- Estratégia: ids = text (formato da plataforma <ts>x<rand>); refs como text (FK lógica).")
    L.append("")
    L.append("begin;")
    L.append("")

    # ---- option sets como tabelas ----
    L.append("-- ===== Option sets =====")
    for set_id, s in option_sets.items():
        if not isinstance(s, dict):
            continue
        tn = f"os_{ident(set_id)}"
        attrs = s.get("attributes", {}) or {}
        # mapeia ident(coluna) -> (raw_attr_key, pg_type); ident() pode colidir → mantém o 1º
        attr_meta = {}
        for a, d in attrs.items():
            col = ident(a)
            if col in ("id", "db_value", "display", "sort_factor") or col in attr_meta:
                continue
            attr_meta[col] = (a, pg_type((d or {}).get("value", "text"))[0])
        coltype = {"sort_factor": "double precision"}
        cols = ["id text primary key", "db_value text", "display text", "sort_factor double precision"]
        for col, (_raw, t) in attr_meta.items():
            cols.append(f"{col} {t}")
            coltype[col] = t
        L.append(f'create table if not exists "{tn}" (')
        L.append("  " + ",\n  ".join(cols))
        L.append(");")
        # seed das opções (valores são fixos no app)
        for opt_id, v in (s.get("values") or {}).items():
            row = {
                "id": opt_id,
                "db_value": v.get("db_value", opt_id),
                "display": v.get("display"),
                "sort_factor": v.get("sort_factor"),
            }
            for col, (raw, _t) in attr_meta.items():
                row[col] = v.get(raw)
            keys = ", ".join(f'"{k}"' for k in row)
            vals = ", ".join(sql_literal(row[k], coltype.get(k)) for k in row)
            L.append(f'insert into "{tn}" ({keys}) values ({vals}) on conflict (id) do nothing;')
        L.append("")

    # ---- tabelas de dados ----
    L.append("-- ===== Data types =====")
    deferred_fk = []
    for internal, d in user_types.items():
        if not isinstance(d, dict):
            continue
        tn = table_name(internal)
        cols = [
            "id text primary key",
            "created_date timestamptz default now()",
            "modified_date timestamptz default now()",
            "created_by text",
        ]
        if internal == "user":
            # built-ins de autenticação da plataforma (não aparecem em fields)
            cols.append('"email" text')
            cols.append('"password" text')  # mock/hash conforme a nova stack
        comments = []
        for fid, f in (d.get("fields") or {}).items():
            if f.get("deleted"):
                continue
            col = ident(fid)
            if col in ("id", "created_date", "modified_date", "created_by"):
                col = "f_" + col
            t, cmt = pg_type(f.get("value", "text"))
            cols.append(f'"{col}" {t}')
            if cmt:
                comments.append((col, cmt, fid))
        cols.append('"_raw" jsonb')  # campos não mapeados (deletados/built-ins de auth)
        L.append(f'create table if not exists "{tn}" (')
        L.append("  " + ",\n  ".join(cols))
        L.append(");")
        for col, cmt, fid in comments:
            L.append(f"comment on column \"{tn}\".\"{col}\" is '{cmt} (no-code:{fid})';")
        L.append("")

    # ---- RLS permissiva (o app ignora privacy rules) ----
    L.append("-- ===== RLS (permissiva — ajuste conforme as privacy rules reais) =====")
    all_tables = [table_name(t) for t, d in user_types.items() if isinstance(d, dict)]
    all_tables += [f"os_{ident(s)}" for s, d in option_sets.items() if isinstance(d, dict)]
    for tn in all_tables:
        L.append(f'alter table "{tn}" enable row level security;')
        L.append(f'create policy "{tn}_all" on "{tn}" for all using (true) with check (true);')
    L.append("")

    # ---- Grant de base para o service_role ----
    # RLS e GRANT são camadas independentes no Postgres: `enable row level security` +
    # policy NÃO dão acesso à tabela por si só, mesmo pra service_role (que ignora RLS via
    # BYPASSRLS, mas ainda precisa do GRANT de objeto). Sem isto, toda query do backend
    # (que autentica como service_role) falha com "permission denied for table X" — só
    # aparece ao testar contra um projeto Supabase real, não é visível rodando local.
    # anon/authenticated ficam DE PROPÓSITO sem grant: a policy acima é permissiva
    # (`using (true)`), então dar grant a eles exporia todas as linhas de toda tabela pra
    # qualquer request client-side. Modelo do projeto é thin client / fat server — só o
    # backend (service_role) fala com o Supabase; o browser nunca acessa direto.
    L.append("-- ===== Grants (service_role = único papel com acesso; anon/authenticated ficam de fora —")
    L.append("--       thin client / fat server, toda leitura/escrita passa pelo backend) =====")
    L.append("grant usage on schema public to service_role;")
    L.append("grant all on all tables in schema public to service_role;")
    L.append("")
    L.append("commit;")

    open(out, "w").write("\n".join(L))
    n_tables = len(all_tables)
    print(f"schema.sql -> {out}")
    print(f"  {len([t for t in user_types.values() if isinstance(t,dict)])} tabelas de dados")
    print(f"  {len([s for s in option_sets.values() if isinstance(s,dict)])} tabelas de option set")
    print(f"  {n_tables} tabelas no total, RLS habilitado")


def as_list(v):
    """Listas no export vêm como dict de chaves numéricas ({'0': x, '1': y}) ou list."""
    if isinstance(v, list):
        return v
    if isinstance(v, dict) and v and all(re.fullmatch(r"\d+", str(k)) for k in v):
        return [v[k] for k in sorted(v, key=lambda x: int(x))]
    return None


def sql_literal(v, pgtype=None):
    if v is None:
        return "null"
    # coluna jsonb: qualquer valor (escalar/dict/list) vira literal JSON tipado
    if pgtype == "jsonb":
        return "'" + json.dumps(v, ensure_ascii=False).replace("'", "''") + "'::jsonb"
    # coluna array: lista da plataforma (ou escalar solto) vira array[...] tipado
    if pgtype and pgtype.endswith("[]"):
        items = as_list(v)
        if items is None:
            items = [v]
        elems = []
        for x in items:
            if x is None:
                elems.append("null")
            elif isinstance(x, bool):
                elems.append("true" if x else "false")
            elif isinstance(x, (int, float)):
                elems.append(str(x))
            else:
                elems.append("'" + str(x).replace("'", "''") + "'")
        return "array[" + ", ".join(elems) + "]::" + pgtype
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, (dict, list)):
        return "'" + json.dumps(v, ensure_ascii=False).replace("'", "''") + "'"
    return "'" + str(v).replace("'", "''") + "'"


if __name__ == "__main__":
    main()
