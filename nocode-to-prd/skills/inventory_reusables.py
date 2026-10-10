#!/usr/bin/env python3
"""
Inventário portável dos reusables de um app no-code.

Não usa hints hardcoded — extrai tudo do export:
  - element_definitions[id].name           ← nome dado pelo dev na plataforma
  - properties.element_type                ← FloatingGroup / Popup / Group
  - properties.wf_folder_list              ← rótulos de pastas de workflow
  - elements (count)                       ← complexidade visual
  - workflows (count + triggers únicos)    ← complexidade lógica

O nome React em PascalCase é derivado de `name` (snake_case / kebab-case / parêntesis viram CamelCase).
"""
import json, sys, re
from pathlib import Path


def to_pascal(name: str | None) -> str:
    if not name: return "Component"
    # Remove parênteses/símbolos, separa por não-alfanum, capitaliza
    parts = re.split(r"[^A-Za-z0-9]+", name)
    parts = [p for p in parts if p]
    if not parts: return "Component"
    return "".join(p[:1].upper() + p[1:] for p in parts)


def classify(rdef: dict, name: str | None) -> str:
    """Heurística de 'tipo' do componente para o consumidor."""
    if not isinstance(rdef, dict): return "?"
    props = rdef.get("properties") or {}
    n_elems = len(rdef.get("elements") or {})
    n_wfs = len(rdef.get("workflows") or {})
    et = props.get("element_type")
    if n_elems == 0 and n_wfs == 0:
        return "vazio"
    if n_elems == 0 and n_wfs > 0:
        return "hook (sem UI)"
    if et == "Popup":
        return "popup"
    if et == "FloatingGroup":
        return "overlay"
    return "componente"


def main():
    if len(sys.argv) < 2:
        print("Uso: inventory_reusables.py <export_file> [--json]"); sys.exit(1)
    d = json.loads(Path(sys.argv[1]).read_text())
    out_json = "--json" in sys.argv
    eds = d.get("element_definitions") or {}

    rows = []
    for rid, r in eds.items():
        if not isinstance(r, dict): continue
        props = r.get("properties") or {}
        wfl = props.get("wf_folder_list") or {}
        name = r.get("name")
        rows.append({
            "id": rid,
            "nome_original": name,
            "react_name": to_pascal(name),
            "element_type": props.get("element_type"),
            "kind": classify(r, name),
            "n_elements": len(r.get("elements") or {}),
            "n_workflows": len(r.get("workflows") or {}),
            "workflow_folders": list(wfl.values()) if isinstance(wfl, dict) else [],
        })

    if out_json:
        print(json.dumps(rows, indent=2, ensure_ascii=False))
        return

    print(f"{'ID':12s} {'Nome original':20s} {'React name':20s} {'Tipo':12s} {'Kind':14s} {'Elems':5s} {'WFs':4s} Workflow folders")
    print("-" * 130)
    for r in rows:
        print(f"{r['id']:12s} {(r['nome_original'] or '—')[:20]:20s} {r['react_name'][:20]:20s} "
              f"{(r['element_type'] or '?')[:12]:12s} {r['kind']:14s} "
              f"{r['n_elements']:5d} {r['n_workflows']:4d} {', '.join(r['workflow_folders'])}")


if __name__ == "__main__":
    main()
