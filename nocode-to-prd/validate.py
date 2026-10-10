#!/usr/bin/env python3
"""
validate.py — Confere se um PRD gerado cobre todos os elementos dos slices.

Uso:
    python3 validate.py slices/ PRD-App.md

Reporta:
    - endpoints em 07_api_connector.json não citados no PRD
    - option sets em 04_option_sets.json não citados
    - pages em page_name_to_id não citadas
    - reusables em 02_reusables.json não citados
"""
import json, sys, re
from pathlib import Path

def main():
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(1)
    slices = Path(sys.argv[1])
    prd = Path(sys.argv[2]).read_text().lower()

    missing = {"endpoints": [], "option_sets": [], "pages": [], "reusables": []}

    # endpoints — pelo nome da call
    calls = json.loads((slices/"07_api_connector.json").read_text())
    for c in calls:
        name = (c.get("call_name") or "").lower()
        if name and name not in prd:
            missing["endpoints"].append(name)

    # option sets — pelo nome do set
    osets = json.loads((slices/"04_option_sets.json").read_text())
    for k, v in osets.items():
        n = (v.get("display") if isinstance(v, dict) else None) or k
        if n.lower() not in prd:
            missing["option_sets"].append(n)

    # pages — pelo nome legível
    p = json.loads((slices/"01_pages.json").read_text())
    for name in (p.get("page_name_to_id") or {}).keys():
        if name.lower() not in prd:
            missing["pages"].append(name)

    # reusables — pelo id (pouco confiável; melhor por nome se existir)
    rs = json.loads((slices/"02_reusables.json").read_text())
    for rid, r in rs.items():
        wfl = (r.get("wf_folder_list") or {})
        names = list(wfl.values()) if isinstance(wfl, dict) else []
        if names and not any(n.lower() in prd for n in names if isinstance(n, str)):
            missing["reusables"].append(rid)

    total_missing = sum(len(v) for v in missing.values())
    print(f"=== validação ===")
    for k, v in missing.items():
        print(f"  {k}: {len(v)} faltando" + (f"  → {v[:5]}{'…' if len(v)>5 else ''}" if v else ""))
    print(f"=== total: {total_missing} itens ausentes ===")
    sys.exit(0 if total_missing == 0 else 2)

if __name__ == "__main__":
    main()
