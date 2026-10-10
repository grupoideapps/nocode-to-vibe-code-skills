#!/usr/bin/env python3
"""
extract.py — Fatia um export (JSON) em slices semanticamente coerentes
que cabem no contexto de um LLM e mapeiam 1:1 com as 17 seções do PRD.

Uso:
    python extract.py <arquivo.bubble> [--out slices/]

Produz em ./slices/:
    00_meta.json              app id, versão, datas, screenshot
    01_pages.json             id_to_path + page_name_to_id + lista de pages com elementos top-level
    02_reusables.json         element_definitions (popups/headers/menus reutilizáveis)
    03_user_types.json        data types da plataforma (User, etc.)
    04_option_sets.json       todos enums com valores e atributos
    05_styles.json            estilos nomeados (botões, inputs, alerts)
    06_design_tokens.json     color_tokens, font_tokens, status_bar_color, spinner_color
    07_api_connector.json     todas chamadas REST configuradas (endpoint, método, params)
    08_workflows_index.json   wf_folder_list por reusable e por page (nome legível dos workflows)
    09_issues.json            issues_list / issues_sub (alertas que a plataforma detectou)
    10_mobile_views.json      views mobile específicas
    INDEX.md                  resumo numérico de cada slice
"""
from __future__ import annotations
import json, sys, os, argparse
from pathlib import Path

def load(p):
    with open(p) as f: return json.load(f)

def safe(d, *keys, default=None):
    for k in keys:
        if not isinstance(d, dict): return default
        d = d.get(k, default)
        if d is default: return default
    return d

def walk_workflows(node, prefix=""):
    """Coleta wf_folder_list embutidos em qualquer profundidade."""
    found = []
    if isinstance(node, dict):
        if "wf_folder_list" in node and isinstance(node["wf_folder_list"], dict):
            for wid, wname in node["wf_folder_list"].items():
                found.append({"path": prefix, "wf_id": wid, "wf_name": wname})
        for k, v in node.items():
            found.extend(walk_workflows(v, f"{prefix}.{k}" if prefix else k))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            found.extend(walk_workflows(v, f"{prefix}[{i}]"))
    return found

def slim_page(page_id, page):
    """Versão enxuta: nome, type, lista de elementos top-level, workflows."""
    elements = page.get("elements", {}) or {}
    top_elements = []
    for eid, e in elements.items():
        if not isinstance(e, dict):
            top_elements.append({"id": eid, "raw": e}); continue
        top_elements.append({
            "id": eid,
            "type": e.get("type"),
            "default_name": e.get("default_name") or safe(e, "properties", "element_type"),
        })
    return {
        "id": page_id,
        "name": page.get("name"),
        "type": page.get("type"),
        "name_settings": page.get("properties", {}).get("page_title"),
        "top_elements_count": len(top_elements),
        "top_elements": top_elements,
        "workflows": walk_workflows(page),
    }

def slim_reusable(rid, rdef):
    if not isinstance(rdef, dict):
        return {"id": rid, "raw": rdef}
    return {
        "id": rid,
        "internal_id": rdef.get("id"),
        "element_type": safe(rdef, "properties", "element_type"),
        "width": safe(rdef, "properties", "width"),
        "height": safe(rdef, "properties", "height"),
        "container_layout": safe(rdef, "properties", "container_layout"),
        "wf_folder_list": safe(rdef, "properties", "wf_folder_list"),
        "states_count": len(rdef.get("states", {}) or {}),
        "elements_count": len(rdef.get("elements", {}) or {}),
        "workflows": walk_workflows(rdef),
    }

def extract_api_calls(settings):
    """Junta apiconnector2 do client_safe + secure."""
    calls = []
    for bucket_name in ("client_safe", "secure"):
        bucket = settings.get(bucket_name, {})
        ac = bucket.get("apiconnector2", {})
        # apiconnector2 normalmente é dict { api_id: { name, calls: { call_id: {...} } } }
        if isinstance(ac, dict):
            apis = ac.get("apis", ac)  # variações de schema
            if isinstance(apis, dict):
                for aid, api in apis.items():
                    if not isinstance(api, dict): continue
                    api_name = api.get("name") or aid
                    api_calls = api.get("calls") or {}
                    if isinstance(api_calls, dict):
                        for cid, c in api_calls.items():
                            if not isinstance(c, dict): continue
                            calls.append({
                                "source": bucket_name,
                                "api_id": aid,
                                "api_name": api_name,
                                "call_id": cid,
                                "call_name": c.get("name") or cid,
                                "method": c.get("method") or c.get("http_method"),
                                "url": c.get("url"),
                                "auth": c.get("authentication"),
                                "params": list((c.get("params") or {}).keys()) if isinstance(c.get("params"), dict) else None,
                                "headers": list((c.get("headers") or {}).keys()) if isinstance(c.get("headers"), dict) else None,
                            })
    return calls

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("export_file")
    ap.add_argument("--out", default="slices")
    args = ap.parse_args()

    d = load(args.export_file)
    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)

    # 00 meta
    (out/"00_meta.json").write_text(json.dumps({
        "app_id": d.get("_id"),
        "app_version": d.get("app_version"),
        "type": d.get("type"),
        "last_change": d.get("last_change"),
        "uid_counter": d.get("uid_counter"),
        "creation_date": d.get("creation_date"),
        "last_change_date": d.get("last_change_date"),
        "favicon": d.get("favicon"),
        "has_screenshot": bool(d.get("screenshot")),
    }, indent=2, ensure_ascii=False))

    # 01 pages
    pages = d.get("pages", {}) or {}
    idx = d.get("_index", {}) or {}
    pages_slim = {pid: slim_page(pid, p) for pid, p in pages.items()}
    (out/"01_pages.json").write_text(json.dumps({
        "page_name_to_id": dict(idx.get("page_name_to_id", {})),
        "id_to_path": dict(idx.get("id_to_path", {})),
        "custom_name_to_id": dict(idx.get("custom_name_to_id", {})),
        "page_name_to_path": dict(idx.get("page_name_to_path", {})),
        "pages": pages_slim,
    }, indent=2, ensure_ascii=False))

    # 02 reusables
    rds = d.get("element_definitions", {}) or {}
    (out/"02_reusables.json").write_text(json.dumps(
        {rid: slim_reusable(rid, r) for rid, r in rds.items()},
        indent=2, ensure_ascii=False))

    # 03 user_types
    (out/"03_user_types.json").write_text(json.dumps(
        d.get("user_types", {}), indent=2, ensure_ascii=False))

    # 04 option_sets
    (out/"04_option_sets.json").write_text(json.dumps(
        d.get("option_sets", {}), indent=2, ensure_ascii=False))

    # 05 styles
    (out/"05_styles.json").write_text(json.dumps(
        d.get("styles", {}), indent=2, ensure_ascii=False))

    # 06 design_tokens
    cs = d.get("settings", {}).get("client_safe", {})
    (out/"06_design_tokens.json").write_text(json.dumps({
        "color_tokens": cs.get("color_tokens"),
        "color_tokens_user": cs.get("color_tokens_user"),
        "color_swatches": cs.get("color_swatches"),
        "font_tokens": cs.get("font_tokens"),
        "default_styles": cs.get("default_styles"),
        "status_bar_color": cs.get("status_bar_color"),
        "spinner_color": cs.get("spinner_color"),
        "default_icon_set": cs.get("default_icon_set"),
        "default_page_title": cs.get("default_page_title"),
        "app_language": cs.get("app_language"),
        "initial_mobile_view": cs.get("initial_mobile_view"),
    }, indent=2, ensure_ascii=False))

    # 07 api_connector
    (out/"07_api_connector.json").write_text(json.dumps(
        extract_api_calls(d.get("settings", {})),
        indent=2, ensure_ascii=False))

    # 08 workflows index
    all_wf = []
    for rid, r in rds.items(): all_wf.extend([{"scope": f"reusable:{rid}", **w} for w in walk_workflows(r)])
    for pid, p in pages.items(): all_wf.extend([{"scope": f"page:{pid}", **w} for w in walk_workflows(p)])
    (out/"08_workflows_index.json").write_text(json.dumps(all_wf, indent=2, ensure_ascii=False))

    # 09 issues
    (out/"09_issues.json").write_text(json.dumps({
        "issues_list": idx.get("issues_list", {}),
        "issues_sub": idx.get("issues_sub", {}),
    }, indent=2, ensure_ascii=False, default=str))

    # 10 mobile views
    (out/"10_mobile_views.json").write_text(json.dumps(
        d.get("mobile_views", {}), indent=2, ensure_ascii=False))

    # INDEX
    lines = ["# Slices index\n"]
    for f in sorted(out.glob("*.json")):
        size_kb = f.stat().st_size / 1024
        lines.append(f"- `{f.name}` — {size_kb:.1f} KB")
    (out/"INDEX.md").write_text("\n".join(lines))
    print("\n".join(lines))

if __name__ == "__main__":
    main()
