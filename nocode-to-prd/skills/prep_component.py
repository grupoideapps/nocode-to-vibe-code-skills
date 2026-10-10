#!/usr/bin/env python3
"""
prep_component.py — Extrai a subárvore de UM reusable do export cru e a
achata num pacote JSON pequeno + um briefing markdown para o LLM.

Por que existe: slices/02_reusables.json só tem metadados rasos. Para o LLM
gerar um React component fiel, precisa ver a árvore de elementos completa
(props de cor/tamanho/layout), os states e os workflows. Mas o subtree cru
do export vem com muito ruído visual (coordenadas, styles repetidos, etc).
Este script normaliza.

Uso:
    python3 prep_component.py <export_file> <reusable_id> [--out out_dir]

Saídas em out_dir/<reusable_id>/:
    tree.json      — árvore enxuta (1 nó = id, type, name, layout, style refs, children)
    states.json    — states com nome legível e condição achatada
    workflows.json — workflows (id, nome, trigger, ações resumidas)
    briefing.md    — texto curto descrevendo o componente p/ o LLM
"""
from __future__ import annotations
import json, sys, argparse, re
from pathlib import Path

# Propriedades visuais relevantes (mantém) — descarta o resto pra reduzir ruído
KEEP_PROPS = {
    "element_type", "width", "height", "min_width_px", "min_height_px",
    "default_width", "container_layout", "row_gap", "column_gap",
    "padding_top", "padding_right", "padding_bottom", "padding_left",
    "horiz_alignment", "vert_alignment", "background_style", "bgcolor",
    "border_color", "border_style", "border_width", "border_roundness",
    "boxshadow_color", "boxshadow_horizontal", "boxshadow_vertical",
    "boxshadow_blur", "boxshadow_spread", "boxshadow_style",
    "text", "placeholder", "font_weight", "font_size", "color",
    "icon", "is_visible", "collapse_when_hidden", "left", "top", "zindex",
}

def flatten_node(eid, node, depth=0):
    if not isinstance(node, dict):
        return {"id": eid, "raw": node}
    props = node.get("properties") or {}
    kept = {k: props.get(k) for k in KEEP_PROPS if k in props}
    out = {
        "id": eid,
        "type": node.get("type") or props.get("element_type"),
        "name": node.get("default_name") or props.get("element_type"),
        "props": kept,
    }
    children = node.get("elements") or {}
    if children:
        out["children"] = [flatten_node(cid, c, depth+1) for cid, c in children.items()]
    return out

def stringify_expr(node, depth=0):
    """Achata as expressões aninhadas da plataforma (DataSource/Message) em texto."""
    if not isinstance(node, dict): return repr(node)
    if depth > 6: return "…"
    t = node.get("type"); n = node.get("name")
    parts = []
    if t: parts.append(t)
    if n and n != t: parts.append(f":{n}")
    args = node.get("args")
    if isinstance(args, dict):
        for k, v in args.items():
            if k == "next": continue
            parts.append(f" {k}={stringify_expr(v, depth+1)}")
    elif args is not None:
        parts.append(f"({args})")
    nxt = node.get("next")
    if nxt:
        parts.append(" → " + stringify_expr(nxt, depth+1))
    return "".join(parts)

def flatten_states(rdef):
    out = []
    for sid, state in (rdef.get("states") or {}).items():
        if not isinstance(state, dict): continue
        out.append({
            "id": sid,
            "name": state.get("name") or state.get("display"),
            "type": state.get("type"),
            "condition": stringify_expr(state.get("condition") or {}),
            "properties": list((state.get("properties") or {}).keys()),
        })
    return out

def find_workflows(rdef):
    """Procura workflows embutidos no reusable e devolve sumário."""
    found = []
    wfl = (rdef.get("properties") or {}).get("wf_folder_list") or {}
    # Os workflows reais ficam em 'workflows' ou achatados no JSON; varremos.
    raw_wfs = rdef.get("workflows") or {}
    if isinstance(raw_wfs, dict):
        for wid, wf in raw_wfs.items():
            if not isinstance(wf, dict): continue
            actions = wf.get("actions") or {}
            found.append({
                "id": wid,
                "name": wfl.get(wid) or wf.get("name") or wid,
                "trigger": wf.get("trigger") or wf.get("type"),
                "actions": [
                    {"id": aid, "type": a.get("action_type") or a.get("type") if isinstance(a, dict) else "?"}
                    for aid, a in actions.items()
                ],
            })
    # Fallback: se não tem 'workflows', só lista os nomes do folder_list
    if not found and wfl:
        found = [{"id": wid, "name": name, "trigger": "?", "actions": []} for wid, name in wfl.items()]
    return found

def briefing(rid, rdef, tree, states, workflows) -> str:
    props = rdef.get("properties") or {}
    nome_original = rdef.get("name") or "(sem nome)"
    el_type = props.get("element_type")
    w = props.get("width") or props.get("default_width")
    h = props.get("min_height_px") or props.get("height")
    n_children = sum(1 for _ in walk(tree))
    wfl = props.get("wf_folder_list") or {}
    wf_folders = ", ".join(wfl.values()) if isinstance(wfl, dict) else ""
    wf_triggers = sorted({w.get("trigger") for w in workflows if w.get("trigger")})
    return f"""# Reusable `{nome_original}` (id `{rid}`)

| Campo | Valor |
|---|---|
| **Nome na plataforma** (source of truth) | `{nome_original}` |
| **Tipo no-code** | {el_type} |
| **no-code id** (não-portável, só rastreio) | `{rid}` |
| **Dimensões** | width={w}, height={h} |
| **Container layout** | {props.get("container_layout")} |
| **Elementos (incluindo descendentes)** | {n_children} |
| **States** | {len(states)} |
| **Workflows totais** | {len(workflows)} |
| **Workflow triggers únicos** | {", ".join(wf_triggers) or "—"} |
| **Workflow folder labels** | {wf_folders or "—"} |

**Como nomear o componente React**: derive de `{nome_original}` (snake_case/kebab/parens → PascalCase). Ignore o id `{rid}` — ele muda a cada export e entre apps.

Use `tree.json` para hierarquia visual, `states.json` para reatividade, `workflows.json` para eventos (cada ação tipo `apiconnector2-<api>.<call>` deve ser cruzada com `_endpoints.ts` ou movida para server action no pai).
"""

def walk(node):
    yield node
    for c in node.get("children", []) or []:
        yield from walk(c)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("export_file")
    ap.add_argument("reusable_id")
    ap.add_argument("--out", default="component_pack")
    args = ap.parse_args()

    d = json.loads(Path(args.export_file).read_text())
    eds = d.get("element_definitions") or {}
    rdef = eds.get(args.reusable_id)
    if not isinstance(rdef, dict):
        print(f"ERRO: reusable {args.reusable_id} não encontrado ou inválido"); sys.exit(1)

    out = Path(args.out) / args.reusable_id
    out.mkdir(parents=True, exist_ok=True)

    tree = flatten_node(args.reusable_id, rdef)
    states = flatten_states(rdef)
    workflows = find_workflows(rdef)

    (out/"tree.json").write_text(json.dumps(tree, indent=2, ensure_ascii=False))
    (out/"states.json").write_text(json.dumps(states, indent=2, ensure_ascii=False))
    (out/"workflows.json").write_text(json.dumps(workflows, indent=2, ensure_ascii=False))
    (out/"briefing.md").write_text(briefing(args.reusable_id, rdef, tree, states, workflows))
    print(f"✓ {out}/")

if __name__ == "__main__":
    main()
