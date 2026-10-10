#!/usr/bin/env python3
"""Helpers compartilhados pelos tools — genéricos para QUALQUER export.

Responsabilidades:
- Resolver o export ativo (nocode.config.json) e um slug por app.
- Namespacear artefatos por app: data/<slug>/raw, data/<slug>.sqlite.
- Derivar dinamicamente o mapa {api_type_name -> internal_user_type_key} a partir
  do próprio export (nome na Data API = display.lower().sem-espaços; flag exposed_api).
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def ident(name: str) -> str:
    s = re.sub(r"[^0-9a-zA-Z_]", "_", str(name)).lower()
    if re.match(r"^\d", s):
        s = "f_" + s
    return s[:63]


def read_config():
    """Lê nocode.config.json → (export_path_abs, app_name, slug)."""
    cfg_path = os.path.join(ROOT, "nocode.config.json")
    cfg = json.load(open(cfg_path)) if os.path.exists(cfg_path) else {}
    export_ref = os.environ.get("NOCODE_FILE") or cfg.get("exportFile") or "../meu-app.bubble"
    export_abs = export_ref if os.path.isabs(export_ref) else os.path.normpath(os.path.join(ROOT, export_ref))
    app_name = cfg.get("appName") or os.path.splitext(os.path.basename(export_abs))[0]
    slug = ident(os.path.splitext(os.path.basename(export_abs))[0]) or "app"
    return export_abs, app_name, slug


def app_paths(slug: str):
    """Caminhos namespaceados por app (não colidem entre exports diferentes)."""
    return {
        "raw": os.path.join(ROOT, "data", slug, "raw"),
        "sqlite": os.path.join(ROOT, "data", f"{slug}.sqlite"),
        "seed": os.path.join(ROOT, "src", "engine", "seed-data.json"),
        "schema": os.path.join(ROOT, "supabase", "schema.sql"),
        "backfill": os.path.join(ROOT, "supabase", "backfill.sql"),
    }


def api_name_of(display: str) -> str:
    """Nome do tipo na Data API da plataforma = display em minúsculas, sem espaços."""
    return str(display or "").lower().replace(" ", "")


def build_api_to_internal(user_types: dict, available=None) -> dict:
    """{api_type_name -> internal_key}, derivado do export.

    - api_type_name = api_name_of(type.display).
    - Em colisão de display, prefere o tipo com flag exposed_api, depois não-deletado.
    - Se `available` (lista de nomes vindos do /meta ou dos arquivos raw) for dada,
      restringe o mapa a esses nomes.
    """
    candidates = {}  # api_name -> list[(internal_key, exposed, deleted)]
    for key, t in user_types.items():
        if not isinstance(t, dict):
            continue
        disp = t.get("display") or key
        api = api_name_of(disp)
        exposed = "exposed_api" in t or bool(t.get("exposed_api"))
        deleted = bool(t.get("deleted"))
        candidates.setdefault(api, []).append((key, exposed, deleted))

    avail = set(available) if available is not None else None
    out = {}
    for api, lst in candidates.items():
        if avail is not None and api not in avail:
            continue
        # preferência: exposto > não-deletado > primeiro
        lst_sorted = sorted(lst, key=lambda x: (not x[1], x[2]))
        out[api] = lst_sorted[0][0]
    # 'user' é sempre o tipo user
    if avail is None or "user" in avail:
        if "user" in user_types:
            out["user"] = "user"
    return out


def raw_api_types(raw_dir: str):
    """Nomes de tipo a partir dos arquivos data/<slug>/raw/*.json (ignora _meta/_summary)."""
    if not os.path.isdir(raw_dir):
        return []
    return [
        os.path.splitext(f)[0]
        for f in os.listdir(raw_dir)
        if f.endswith(".json") and not f.startswith("_")
    ]


if __name__ == "__main__":
    # CLI auxiliar p/ o pipeline.sh: imprime caminhos do app ativo
    import sys

    _, _app, _slug = read_config()
    p = app_paths(_slug)
    if "--raw" in sys.argv:
        print(os.path.relpath(p["raw"], ROOT))
    elif "--slug" in sys.argv:
        print(_slug)
    elif "--sqlite" in sys.argv:
        print(os.path.relpath(p["sqlite"], ROOT))
    else:
        print(_slug)
