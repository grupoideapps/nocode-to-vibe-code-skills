#!/usr/bin/env python3
"""gen_prd.py — Gera um PRD reverso do app a partir do export ativo (qualquer app).

Dois produtos (namespaceados por app):
  1. data/<slug>/prd/slices/*.json  — fatias semânticas (espelham nocode-to-prd/extract.py)
  2. docs/PRD-<slug>.md              — PRD DETERMINÍSTICO já preenchido com os fatos do export
                                       (páginas, modelo de dados, enums, workflows, endpoints,
                                       tokens) + contagens REAIS do data/<slug>.sqlite se existir.

Seções que exigem narrativa (user stories, regras de negócio) ficam marcadas como
[ELABORAR VIA LLM] — use tools/prd_prompt.md + os slices para completar numa sessão do Claude.

Uso:
    python3 tools/gen_prd.py                 # usa nocode.config.json
    python3 tools/gen_prd.py ../app.bubble   # força um export
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


def safe(d, *keys, default=None):
    for k in keys:
        if not isinstance(d, dict):
            return default
        d = d.get(k, default)
        if d is default:
            return default
    return d


def extract_workflows(container, scope):
    """Workflows reais ficam no dict `workflows` de cada page/reusable.

    Cada entrada: {type (gatilho), properties.element_id, actions{id: {type,...}}}.
    Retorna lista de {scope, trigger, element_id, actions:[types]}.
    """
    out = []
    wfs = container.get("workflows") if isinstance(container, dict) else None
    if isinstance(wfs, dict):
        for wid, wf in wfs.items():
            if not isinstance(wf, dict):
                continue
            acts = wf.get("actions") or {}
            action_types = [a.get("type") for a in acts.values() if isinstance(a, dict)]
            out.append({
                "scope": scope,
                "wf_id": wid,
                "trigger": wf.get("type"),
                "element_id": safe(wf, "properties", "element_id"),
                "actions": action_types,
            })
    return out


def extract_api_calls(settings):
    calls = []
    for bucket_name in ("client_safe", "secure"):
        ac = safe(settings, bucket_name, "apiconnector2") or {}
        apis = ac.get("apis", ac) if isinstance(ac, dict) else {}
        if not isinstance(apis, dict):
            continue
        for aid, api in apis.items():
            if not isinstance(api, dict):
                continue
            for cid, c in (api.get("calls") or {}).items():
                if not isinstance(c, dict):
                    continue
                calls.append({
                    "source": bucket_name,
                    "api_name": api.get("name") or aid,
                    "call_name": c.get("name") or cid,
                    "method": c.get("method") or c.get("http_method"),
                    "url": c.get("url"),
                })
    return calls


def write_slices(d, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    pages = d.get("pages", {}) or {}
    rds = d.get("element_definitions", {}) or {}
    idx = d.get("_index", {}) or {}

    allwf = []
    for pid, p in pages.items():
        allwf += extract_workflows(p, f"page:{pid}")
    for rid, r in rds.items():
        allwf += extract_workflows(r, f"reusable:{rid}")

    def slim_page(pid, p):
        if not isinstance(p, dict):
            return {"id": pid, "raw": p}
        els = p.get("elements", {}) or {}
        return {
            "id": pid, "name": p.get("name"), "type": p.get("type"),
            "top_elements_count": len(els),
            "workflows": len(extract_workflows(p, f"page:{pid}")),
        }

    dump = lambda n, o: open(os.path.join(out_dir, n), "w").write(json.dumps(o, indent=1, ensure_ascii=False))
    dump("00_meta.json", {k: d.get(k) for k in ("_id", "app_version", "type", "last_change_date", "creation_date")})
    dump("01_pages.json", {"page_name_to_id": idx.get("page_name_to_id", {}),
                           "pages": {pid: slim_page(pid, p) for pid, p in pages.items()}})
    dump("02_reusables.json", {rid: {"id": rid,
                                     "elements_count": len((r.get("elements", {}) or {}) if isinstance(r, dict) else {}),
                                     "workflows": len(extract_workflows(r, f"reusable:{rid}"))} for rid, r in rds.items()})
    dump("03_user_types.json", d.get("user_types", {}))
    dump("04_option_sets.json", d.get("option_sets", {}))
    dump("05_styles.json", d.get("styles", {}))
    cs = safe(d, "settings", "client_safe") or {}
    dump("06_design_tokens.json", {k: cs.get(k) for k in
         ("color_tokens", "font_tokens", "status_bar_color", "default_icon_set", "app_language")})
    dump("07_api_connector.json", extract_api_calls(d.get("settings", {})))
    dump("08_workflows_index.json", allwf)
    return {"pages": pages, "reusables": rds, "workflows": allwf,
            "api_calls": extract_api_calls(d.get("settings", {}))}


def sqlite_counts(sqlite_path):
    if not os.path.exists(sqlite_path):
        return {}
    try:
        conn = sqlite3.connect(sqlite_path)
        tables = [r[0] for r in conn.execute("select name from sqlite_master where type='table'")]
        out = {}
        for t in tables:
            out[t] = conn.execute(f'select count(*) from "{t}"').fetchone()[0]
        conn.close()
        return out
    except Exception:
        return {}


def md_escape(s):
    return str(s).replace("|", "\\|") if s is not None else ""


def main():
    export_ref, app, slug = C.read_config()
    if len(sys.argv) > 1:
        export_ref = sys.argv[1] if os.path.isabs(sys.argv[1]) else os.path.normpath(os.path.join(os.getcwd(), sys.argv[1]))
        slug = C.ident(os.path.splitext(os.path.basename(export_ref))[0])
        app = os.path.splitext(os.path.basename(export_ref))[0]

    d = json.load(open(export_ref))
    P = C.app_paths(slug)
    slices_dir = os.path.join(ROOT, "data", slug, "prd", "slices")
    s = write_slices(d, slices_dir)

    user_types = d.get("user_types", {})
    option_sets = d.get("option_sets", {})
    pages = d.get("pages", {})
    idx = d.get("_index", {}) or {}
    # fonte confiável de nomes: pages[pid].name (o _index costuma vir incompleto)
    name_to_id = {p.get("name", pid): pid for pid, p in pages.items() if isinstance(p, dict)}
    counts = sqlite_counts(P["sqlite"])
    meta_path = os.path.join(P["raw"], "_meta.json")
    api_meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
    exposed_get = api_meta.get("get", [])
    exposed_post = api_meta.get("post", [])

    L = []
    L.append(f"# PRD — {app}")
    L.append("")
    L.append("> PRD reverso **determinístico** gerado de `tools/gen_prd.py` a partir do export.")
    L.append("> Fatos (páginas, dados, enums, workflows, endpoints, tokens) são transcrição literal.")
    L.append("> Seções marcadas `[ELABORAR VIA LLM]` precisam de narrativa — use `tools/prd_prompt.md` + os slices.")
    L.append("")

    # 1. Visão geral
    L.append("## 1. Visão Geral")
    L.append("")
    L.append(f"- **App:** {app} (`{d.get('_id','?')}`)")
    L.append(f"- **Versão:** {d.get('app_version','?')}  |  **Última alteração:** {d.get('last_change_date','?')}")
    npages = len([p for p in pages.values() if isinstance(p, dict)])
    L.append(f"- **Páginas:** {npages}  |  **Reusables:** {len(d.get('element_definitions',{}))}"
             f"  |  **Tipos de dados:** {len(user_types)}  |  **Option sets:** {len(option_sets)}")
    L.append(f"- **Workflows (índice):** {len(s['workflows'])}  |  **Chamadas API connector:** {len(s['api_calls'])}")
    L.append(f"- **Data API expõe:** {len(exposed_get)} tipos GET, {len(exposed_post)} endpoints POST (backend workflows)")
    L.append("")
    L.append("**[ELABORAR VIA LLM]** Proposta de valor, personas, objetivos do produto.")
    L.append("")

    # 2. Mapa de páginas
    L.append("## 2. Mapa de Páginas")
    L.append("")
    L.append("| Página | Path | Elementos top | Workflows |")
    L.append("|---|---|---:|---:|")
    page_wf = {}
    for w in s["workflows"]:
        if w["scope"].startswith("page:"):
            pid = w["scope"][5:]
            page_wf[pid] = page_wf.get(pid, 0) + 1
    for nm, pid in sorted(name_to_id.items()):
        p = pages.get(pid, {})
        nels = len((p or {}).get("elements", {}) or {})
        L.append(f"| {md_escape(nm)} | /{md_escape(nm)} | {nels} | {page_wf.get(pid,0)} |")
    L.append("")

    # 3. Modelo de dados
    L.append("## 3. Modelo de Dados")
    L.append("")
    L.append("Tipo · (linhas reais no SQLite, se houver) · campos `field_id: tipo`. `*` = exposto na Data API.")
    L.append("")
    for key, t in sorted(user_types.items()):
        if not isinstance(t, dict):
            continue
        disp = t.get("display") or key
        exp = " *" if ("exposed_api" in t or t.get("exposed_api")) else ""
        tn = "usuario" if key == "user" else C.ident(key)
        cnt = counts.get(tn, counts.get(key))
        cnt_s = f" — {cnt} linhas" if cnt is not None else ""
        fields = {fid: f for fid, f in (t.get("fields") or {}).items() if not (f or {}).get("deleted")}
        L.append(f"### {md_escape(disp)}{exp}  `({key})`{cnt_s}")
        if fields:
            L.append("")
            L.append("| Campo (field_id) | Tipo no-code |")
            L.append("|---|---|")
            for fid, f in fields.items():
                L.append(f"| {md_escape(fid)} | {md_escape((f or {}).get('value','text'))} |")
        L.append("")

    # 4. Option sets / enums
    L.append("## 4. Option Sets (enums)")
    L.append("")
    for sid, oset in sorted(option_sets.items()):
        if not isinstance(oset, dict):
            continue
        disp = oset.get("display") or sid
        vals = oset.get("values") or {}
        attrs = list((oset.get("attributes") or {}).keys())
        L.append(f"### {md_escape(disp)}  `({sid})`" + (f" — atributos: {', '.join(attrs)}" if attrs else ""))
        L.append("")
        L.append("| db_value | display |")
        L.append("|---|---|")
        for vid, v in vals.items():
            if (v or {}).get("deleted"):
                continue
            L.append(f"| {md_escape((v or {}).get('db_value', vid))} | {md_escape((v or {}).get('display'))} |")
        L.append("")

    # 5. Workflows
    L.append("## 5. Workflows")
    L.append("")
    trig_count, act_count = {}, {}
    for w in s["workflows"]:
        trig_count[w["trigger"]] = trig_count.get(w["trigger"], 0) + 1
        for a in w["actions"]:
            act_count[a] = act_count.get(a, 0) + 1
    total_acts = sum(act_count.values())
    L.append(f"**{len(s['workflows'])} workflows** com **{total_acts} ações** no total.")
    L.append("")
    L.append("**Gatilhos (top):** " + ", ".join(f"`{md_escape(t)}`×{n}" for t, n in
             sorted(trig_count.items(), key=lambda x: -x[1])[:12] if t))
    L.append("")
    L.append("**Tipos de ação (top):** " + ", ".join(f"`{md_escape(a)}`×{n}" for a, n in
             sorted(act_count.items(), key=lambda x: -x[1])[:18] if a))
    L.append("")
    L.append("> Gatilhos/ações com ID `<plugin>x...` são de plugins. Detalhe (condições, parâmetros)")
    L.append("> exige ler `pages.<id>.workflows` no export. **[ELABORAR VIA LLM]** por página crítica.")
    L.append("")

    # 6. API connector (REST externo)
    L.append("## 6. Integrações (API Connector)")
    L.append("")
    if s["api_calls"]:
        L.append("| API | Call | Método | URL |")
        L.append("|---|---|---|---|")
        for c in s["api_calls"]:
            L.append(f"| {md_escape(c['api_name'])} | {md_escape(c['call_name'])} | {md_escape(c.get('method'))} | {md_escape(c.get('url'))} |")
    else:
        L.append("_Nenhuma chamada de API connector encontrada no export._")
    L.append("")

    # 7. Backend workflow endpoints (Data API meta)
    L.append("## 7. Backend Workflow Endpoints (Workflow API)")
    L.append("")
    if exposed_post:
        L.append("Endpoints POST expostos (`/api/1.1/wf/<endpoint>`):")
        L.append("")
        for ep in exposed_post:
            L.append(f"- `{md_escape(ep)}`")
    else:
        L.append("_Sem `_meta.json` (rode `tools/fetch_data.py`) ou nenhum endpoint exposto._")
    L.append("")
    L.append("**[ELABORAR VIA LLM]** Contrato de cada endpoint (params, regras, efeitos colaterais).")
    L.append("")

    # 8. Design tokens
    cs = safe(d, "settings", "client_safe") or {}
    L.append("## 8. Design System (tokens)")
    L.append("")
    ct = cs.get("color_tokens") or {}
    if isinstance(ct, dict) and ct:
        L.append("**Cores:** " + ", ".join(f"`{k}`" for k in list(ct.keys())[:30]))
    L.append(f"- Icon set padrão: `{cs.get('default_icon_set','?')}`  |  Idioma: `{cs.get('app_language','?')}`")
    L.append(f"- Styles nomeados: {len(d.get('styles',{}))}")
    L.append("")

    # 9. Dados reais
    if counts:
        L.append("## 9. Volume de Dados Reais (SQLite)")
        L.append("")
        L.append("| Tabela | Linhas |")
        L.append("|---|---:|")
        for t, n in sorted(counts.items(), key=lambda x: -x[1]):
            L.append(f"| {md_escape(t)} | {n} |")
        L.append("")

    # 10. Lacunas
    L.append("## 10. Lacunas e Inferências (para o LLM)")
    L.append("")
    L.append("- **[ELABORAR VIA LLM]** User stories por página (Given/When/Then).")
    L.append("- **[ELABORAR VIA LLM]** Regras de negócio dos workflows (ler `pages.<id>...workflows` no export).")
    L.append("- **[ELABORAR VIA LLM]** Privacy rules (não exportadas — inferir das chamadas REST).")
    L.append("- **[ELABORAR VIA LLM]** Detalhe dos endpoints de backend (params/efeitos).")
    L.append("")
    L.append(f"> Slices factuais em `data/{slug}/prd/slices/`. Prompt mestre em `tools/prd_prompt.md`.")
    L.append("")

    # esqueleto determinístico — regenerável; o PRD final autoral é docs/PRD-<slug>.md
    out_md = os.path.join(ROOT, "docs", f"PRD-{slug}-auto.md")
    os.makedirs(os.path.dirname(out_md), exist_ok=True)
    open(out_md, "w").write("\n".join(L))
    print(f"PRD (esqueleto) -> {out_md} ({os.path.getsize(out_md)/1024:.0f} KB)")
    print(f"slices -> {slices_dir}")
    print(f"  páginas={npages} tipos={len(user_types)} option_sets={len(option_sets)} "
          f"workflows={len(s['workflows'])} api_calls={len(s['api_calls'])} endpoints_post={len(exposed_post)}")


if __name__ == "__main__":
    main()
