#!/usr/bin/env python3
"""Converte os dados crus da Data API (data/raw/*.json) para:

  1. data/app-eventos.sqlite  — banco completo (1 tabela por tipo interno), p/ testes/queries.
  2. src/engine/seed-data.json — amostra enxuta (relacional) que o renderer carrega no client.

Mapeia os nomes de campo da Data API (display) para o `field_id` do export, usando
user_types do app-eventos.bubble. Tipos API → tipos internos via API_TO_INTERNAL.
"""
import json
import os
import re
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import _common as C  # noqa: E402

EXPORT_FILE, APP, SLUG = C.read_config()
_P = C.app_paths(SLUG)
RAW = _P["raw"]            # data/<slug>/raw
SQLITE = _P["sqlite"]      # data/<slug>.sqlite
SEED = _P["seed"]          # src/engine/seed-data.json (app ativo)

BUILTINS = {"_id", "Created Date", "Modified Date", "Created By", "Slug"}

# Acima disto, uma data URI é podada do seed do client (ver write_seed). 40 KB cobre
# ícone/thumb legítimo e corta foto de câmera colada inline.
DATA_URI_MAX = 40 * 1024


def display_to_fieldid(internal_type, user_types):
    """Mapa display->field_id para um tipo interno (built-ins passam direto)."""
    fields = (user_types.get(internal_type) or {}).get("fields", {})
    m = {}
    for fid, f in fields.items():
        disp = f.get("display")
        if disp and disp not in m:
            m[disp] = fid
        m[fid] = fid  # caso a API já devolva o field_id
    return m


def remap_row(row, mapping, internal_type):
    out = {}
    for k, v in row.items():
        if k in BUILTINS:
            out[k] = v
        else:
            out[mapping.get(k, k)] = v
    # User: extrair email built-in de authentication.email.email
    if internal_type == "user":
        auth = row.get("authentication") or {}
        email = (auth.get("email") or {}).get("email")
        if email:
            out["email"] = email
        out.pop("authentication", None)
    return out


def main():
    exp = json.load(open(EXPORT_FILE))
    user_types = exp["user_types"]

    # mapa API->interno derivado do export (genérico), restrito ao que foi baixado
    available = C.raw_api_types(RAW)
    API_TO_INTERNAL = C.build_api_to_internal(user_types, available)
    print(f"App: {APP} (slug={SLUG}) — {len(available)} tipos em {RAW}")

    os.makedirs(os.path.dirname(SQLITE), exist_ok=True)
    if os.path.exists(SQLITE):
        os.remove(SQLITE)
    conn = sqlite3.connect(SQLITE)

    full = {}  # internal_type -> [rows remapeados]
    for api_type in available:
        internal = API_TO_INTERNAL.get(api_type)
        if not internal:
            print(f"  (sem tipo interno p/ '{api_type}' — pulando)")
            continue
        path = os.path.join(RAW, f"{api_type}.json")
        if not os.path.exists(path):
            continue
        rows = json.load(open(path))
        mapping = display_to_fieldid(internal, user_types)
        remapped = [remap_row(r, mapping, internal) for r in rows]
        full[internal] = remapped

        # SQLite: colunas = união de chaves; valores escalares direto, listas/dicts como JSON
        cols = []
        seen = set()
        for r in remapped:
            for k in r:
                if k not in seen:
                    seen.add(k)
                    cols.append(k)
        safe = {c: "c_" + re.sub(r"\W", "_", c) for c in cols}
        # Tipo exposto na Data API mas SEM nenhum registro → nenhuma coluna inferida, e
        # `CREATE TABLE x ()` é SQL inválido. Cria a tabela só com _id para preservar a
        # estrutura (o backfill/PRD continuam listando o tipo) em vez de abortar o build.
        if not cols:
            conn.execute(f'CREATE TABLE "{internal}" (c__id TEXT)')
            print(f"  {internal}: 0 linhas (tipo exposto e vazio — tabela criada só com _id)")
            continue
        conn.execute(f'CREATE TABLE "{internal}" ({", ".join(f"{safe[c]} TEXT" for c in cols)})')
        for r in remapped:
            vals = []
            for c in cols:
                v = r.get(c)
                vals.append(json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v)
            conn.execute(
                f'INSERT INTO "{internal}" ({", ".join(safe[c] for c in cols)}) VALUES ({", ".join("?" for _ in cols)})',
                vals,
            )
        print(f"  {internal}: {len(remapped)} linhas, {len(cols)} colunas")
    conn.commit()
    conn.close()
    print(f"SQLite -> {SQLITE}")

    write_seed(full)


def write_seed(full, cap=150, ref_budget=400):
    """Amostra enxuta e GENÉRICA p/ o client (qualquer export).

    Estratégia agnóstica de domínio:
    - até `cap` linhas por tabela (prioriza mais recentes por Created Date);
    - fecha referências: ids citados por campos de referência das linhas incluídas
      são puxados das tabelas de origem (até `ref_budget` extras por tabela);
    - todo user recebe `password` de teste e os primeiros viram logáveis.
    """
    by_id = {}  # _id -> (table, row)
    for t, rows in full.items():
        for r in rows:
            if r.get("_id"):
                by_id[r["_id"]] = (t, r)

    def recent_key(r):
        return str(r.get("Created Date") or r.get("Modified Date") or "")

    seed = {}
    included_ids = set()
    for t, rows in full.items():
        picked = sorted(rows, key=recent_key, reverse=True)[:cap]
        seed[t] = picked
        for r in picked:
            if r.get("_id"):
                included_ids.add(r["_id"])

    # fecha referências: qualquer string que seja _id conhecido e ainda não incluída
    extra_by_table = {}
    for t, rows in seed.items():
        for r in rows:
            for v in r.values():
                vals = v if isinstance(v, list) else [v]
                for x in vals:
                    if isinstance(x, str) and x in by_id and x not in included_ids:
                        src_t, src_r = by_id[x]
                        bucket = extra_by_table.setdefault(src_t, [])
                        if len(bucket) < ref_budget:
                            bucket.append(src_r)
                            included_ids.add(x)
    for t, extra in extra_by_table.items():
        seed.setdefault(t, [])
        seed[t].extend(extra)

    # auth mock: senha de teste; admins (heurística por campo option contendo 'admin') no topo
    users = seed.get("user", [])
    def is_admin(u):
        for k, val in u.items():
            if isinstance(val, str) and "admin" in val.lower():
                return True
        return False
    admins = [u for u in users if is_admin(u)]
    for a in reversed(admins[:6]):
        if a in users:
            users.remove(a)
        users.insert(0, a)
    for u in users:
        u.setdefault("password", "Senha@123")
    seed["user"] = users

    # Data URIs gigantes (imagem colada inline em vez de subir pro CDN) explodem o seed:
    # no app-marketplace, 9 fotos base64 levavam o arquivo de ~2 MB para 25 MB — e o seed é
    # IMPORTADO NO BUNDLE do client. O dado íntegro continua no SQLite e no backfill.sql
    # (que é o que vai para o Supabase); aqui só o renderer precisa ser leve.
    podadas = [0, 0]

    def podar(v):
        if isinstance(v, str):
            if v.startswith("data:") and len(v) > DATA_URI_MAX:
                podadas[0] += 1
                podadas[1] += len(v)
                return ""
            return v
        if isinstance(v, list):
            return [podar(x) for x in v]
        if isinstance(v, dict):
            return {k: podar(x) for k, x in v.items()}
        return v

    seed = {t: [{k: podar(v) for k, v in r.items()} for r in rows] for t, rows in seed.items()}

    json.dump(seed, open(SEED, "w"), ensure_ascii=False, indent=1)
    size = os.path.getsize(SEED) / 1024
    print(f"seed-data.json -> {SEED} ({size:.0f} KB)")
    if podadas[0]:
        print(f"    ({podadas[0]} data URI(s) acima de {DATA_URI_MAX // 1024} KB podadas do seed, "
              f"-{podadas[1] / 1024 / 1024:.1f} MB — dado íntegro segue no SQLite e no backfill.sql)")
    nonempty = {t: len(rows) for t, rows in seed.items() if rows}
    for t, n in sorted(nonempty.items(), key=lambda x: -x[1])[:20]:
        print(f"    {t}: {n}")


if __name__ == "__main__":
    main()
