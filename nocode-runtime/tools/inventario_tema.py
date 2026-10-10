#!/usr/bin/env python3
"""Inventário de tokens de tema a partir do export.

Emite dois artefatos:
  tema-inventario.md    tabela: token, valor, refs, chaves, onde aparece
  tema-inventario.html  o mesmo com swatch de cor — é o que permite autorar o mapa do DS

Destino final: nocode-runtime/tools/inventario_tema.py (task #9, passo 7).
"""
import json, re, sys, collections, hashlib, html
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import read_config

# read_config() devolve a TUPLA (export_path_abs, app_name, slug) — não um dict.
EXPORT_FILE, _app_name, _slug = read_config()

COLOR_RE = re.compile(r'^\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))\s*$')
VAR_RE   = re.compile(r'var\(\s*(--[A-Za-z0-9_]+)')


def normalizar(v: str) -> str:
    """Forma canônica rgba(r,g,b,a). #00BF63 ≡ #00bf63 ≡ rgba(0,191,99,1)."""
    v = v.strip()
    m = re.match(r'^#([0-9a-fA-F]{3})$', v)
    if m:
        v = '#' + ''.join(c * 2 for c in m.group(1))
    m = re.match(r'^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$', v)
    if m:
        # arredondamento estilo JS (Math.round), não o bancário do Python
        r, g, b = (int(float(m.group(i)) + 0.5) for i in (1, 2, 3))
        a = 1.0 if m.group(4) is None else int(float(m.group(4)) * 1000 + 0.5) / 1000
        return f'rgba({r},{g},{b},{a:g})'
    m = re.match(r'^#([0-9a-fA-F]{6})$', v)
    if m:
        n = int(m.group(1), 16)
        return f'rgba({(n >> 16) & 255},{(n >> 8) & 255},{n & 255},1)'
    m = re.match(r'^#([0-9a-fA-F]{8})$', v)
    if m:
        n = int(m.group(1), 16)
        return f'rgba({(n >> 24) & 255},{(n >> 16) & 255},{(n >> 8) & 255},{int((n & 255) / 255 * 1000 + 0.5) / 1000:g})'
    return v.lower()


def hash8(s: str) -> str:
    """Replica tema.ts#hashToken: FNV-1a 32-bit em BASE36, 8 chars.
    O walk é a autoridade sobre nomes de token (plan Task 9) — a versão sha1-hex
    original autorou um mapa com ids que o runtime nunca emitiria."""
    h = 0x811C9DC5
    for ch in s:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    digits = '0123456789abcdefghijklmnopqrstuvwxyz'
    out = ''
    n = h
    while n:
        out = digits[n % 36] + out
        n //= 36
    return (out or '0').rjust(8, '0')[-8:]


def hexof(rgba: str) -> str:
    m = re.match(r'^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$', rgba)
    if not m:
        return '#888888'
    return '#%02X%02X%02X' % (int(m.group(1)), int(m.group(2)), int(m.group(3)))


def alpha(rgba: str) -> float:
    m = re.match(r'^rgba\(\d+,\d+,\d+,([\d.]+)\)$', rgba)
    return float(m.group(1)) if m else 1.0


def luminancia(rgba: str) -> float:
    m = re.match(r'^rgba\((\d+),(\d+),(\d+)', rgba)
    if not m:
        return 0.5
    def canal(c):
        c = int(c) / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (canal(m.group(i)) for i in (1, 2, 3))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contraste(a: str, b: str) -> float:
    la, lb = luminancia(a), luminancia(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


# ---------------------------------------------------------------- coleta
app = json.load(open(EXPORT_FILE))
cs = app.get('settings', {}).get('client_safe', {})

# 1. tokens declarados no app: nome CSS -> (valor normalizado, rótulo humano)
tokens = {}
for grupo, defs in (cs.get('color_tokens') or {}).items():
    for variante, valor in (defs or {}).items():
        if isinstance(valor, str):
            tokens[f'--color_{grupo}_{variante}'] = (normalizar(valor), grupo)
for variante, defs in (cs.get('color_tokens_user') or {}).items():
    for tid, d in (defs or {}).items():
        if isinstance(d, dict) and isinstance(d.get('rgba'), str):
            tokens[f'--color_{tid}_{variante}'] = (normalizar(d['rgba']), d.get('name') or tid)

valor2token = {}
for nome, (val, _rot) in tokens.items():
    valor2token.setdefault(val, nome)

# 2. varredura com atribuição de origem
refs_token = collections.Counter()                       # --color_x -> nº refs
cru        = collections.Counter()                       # valor normalizado -> nº refs
chaves     = collections.defaultdict(collections.Counter)  # valor|token -> {chave: n}
origem     = collections.defaultdict(collections.Counter)  # valor|token -> {página: n}
raios      = collections.Counter()
raios_org  = collections.defaultdict(collections.Counter)
sombras    = collections.Counter()
fontes     = collections.Counter()
dinamicas  = collections.Counter()

COR_KEYS = {
    'bgcolor', 'font_color', 'border_color', 'icon_color', 'boxshadow_color',
    'placeholder_color', 'separator_color', 'greyout_color', 'backdrop_bgcolor',
    'background_gradient_from', 'background_gradient_to', 'background_color_if_empty_image',
    'tag_font_color', 'tag_border_color', 'tag_delete_color', 'spinner_color',
    'backdrop_color', 'border_color_top', 'border_color_right', 'border_color_bottom',
    'border_color_left',
}


def varrer(node, onde):
    if isinstance(node, list):
        for x in node:
            varrer(x, onde)
        return
    if not isinstance(node, dict):
        return

    if isinstance(node.get('border_roundness'), (int, float)):
        raios[node['border_roundness']] += 1
        raios_org[node['border_roundness']][onde] += 1
    for lado in ('top', 'right', 'bottom', 'left'):
        v = node.get(f'border_roundness_{lado}')
        if isinstance(v, (int, float)):
            raios[v] += 1
            raios_org[v][onde] += 1

    est = node.get('boxshadow_style')
    if est and est != 'none':
        chave = (est, node.get('boxshadow_horizontal'), node.get('boxshadow_vertical'),
                 node.get('boxshadow_blur'), node.get('boxshadow_spread'), node.get('boxshadow_color'))
        sombras[chave] += 1

    for k, v in node.items():
        if isinstance(v, str):
            if COLOR_RE.match(v):
                n = normalizar(v)
                cru[n] += 1
                chaves[n][k] += 1
                origem[n][onde] += 1
            else:
                for m in VAR_RE.finditer(v):
                    t = m.group(1)
                    if t.startswith('--color_'):
                        refs_token[t] += 1
                        chaves[t][k] += 1
                        origem[t][onde] += 1
            if k in ('font_face', 'font_family') and not v.startswith('var('):
                fam = v.split(':::')[0].strip()
                if fam:
                    fontes[fam] += 1
        else:
            if k in COR_KEYS and isinstance(v, dict):
                dinamicas[k] += 1
            varrer(v, onde)


def nome_pagina(pid, page):
    return page.get('name') or (page.get('properties') or {}).get('page_name') or pid


# ESCOPO — só o que o engine de fato renderiza. Medido em 06/08/2026:
#   pages 1.228 · element_definitions 1.559 · styles 205 · option_sets 75  = 3.067 refs
# Ficam DE FORA, por decisão medida e não por descuido:
#   mobile_views (1.001 refs!) — as built-in mobile views do editor. NENHUM arquivo de src/
#     referencia a chave; o renderer web usa pages/element_definitions/styles. Tokenizá-las
#     inflaria o inventário em 1/3 com cor que nunca chega à tela.
#   settings (68) — são os VALORES dos próprios color_tokens. Tokenizar seria circular.
for pid, page in (app.get('pages') or {}).items():
    if isinstance(page, dict):
        varrer(page, nome_pagina(pid, page))
for did, d in (app.get('element_definitions') or {}).items():
    # o bag traz lixo escalar junto dos reusables (ex.: `length`) — só dict é definição
    if isinstance(d, dict):
        varrer(d, '↻ ' + str(d.get('name') or did))
varrer(app.get('styles') or {}, '(style)')
# option_sets CHEGA à tela — payload.ts:77 e wf-runner.ts:66 passam app.option_sets ao runtime
for sid, s in (app.get('option_sets') or {}).items():
    if isinstance(s, dict):
        varrer(s, '⚙ ' + str(s.get('display') or s.get('name') or sid))

# 3. consolidar: cada cor crua vira token existente (se o valor bate) ou token gerado
linhas = []
for val, n in cru.items():
    existente = valor2token.get(val)
    if existente:
        # religada ao token da plataforma — soma nas refs dele, não vira token novo
        refs_token[existente] += n
        for k, c in chaves[val].items():
            chaves[existente][k] += c
        for o, c in origem[val].items():
            origem[existente][o] += c
    else:
        linhas.append((f'--c_{hash8(val)}', val, n, 'gerado', ''))

for nome, (val, rot) in tokens.items():
    if refs_token.get(nome):
        linhas.append((nome, val, refs_token[nome], 'no-code', rot))

linhas.sort(key=lambda r: -r[2])

# ---------------------------------------------------------------- saída
BRANCO, PRETO = 'rgba(255,255,255,1)', 'rgba(0,0,0,1)'
total_refs = sum(r[2] for r in linhas)

md = []
md.append('# Inventário de tokens de tema — app-marketplace\n')
md.append(f'Gerado do export · {len(linhas)} tokens de cor · {total_refs} referências\n')
md.append('`no-code` = token que já existe no app (nome do editor na última coluna). '
          '`gerado` = cor crua sem token, recebe `--c_<hash>`.\n')
md.append('| Token | Valor | Refs | Origem | Nome na plataforma | Chaves | Onde mais aparece | AA/branco | AA/preto |')
md.append('|---|---|---:|---|---|---|---|---:|---:|')
for nome, val, n, orig, rot in linhas:
    ks = ', '.join(f'{k}×{c}' for k, c in chaves[nome if orig == 'no-code' else val].most_common(3))
    on = ', '.join(f'{o}' for o, _ in origem[nome if orig == 'no-code' else val].most_common(3))
    cb, cp = contraste(val, BRANCO), contraste(val, PRETO)
    md.append(f'| `{nome}` | `{val}` | {n} | {orig} | {rot} | {ks} | {on} | {cb:.1f} | {cp:.1f} |')

md.append('\n## Raio\n')
md.append('| Valor | Usos | Onde mais aparece |')
md.append('|---:|---:|---|')
for v, n in raios.most_common():
    md.append(f'| {v} | {n} | ' + ', '.join(o for o, _ in raios_org[v].most_common(3)) + ' |')

md.append('\n## Sombra\n')
md.append('| h | v | blur | spread | cor | Usos |')
md.append('|---:|---:|---:|---:|---|---:|')
for (est, h, v, bl, sp, cor), n in sombras.most_common():
    md.append(f'| {h or 0} | {v or 0} | {bl or 0} | {sp or 0} | `{cor}` | {n} |')

md.append('\n## Fonte\n')
md.append('| Família | Usos |')
md.append('|---|---:|')
for f, n in fontes.most_common():
    md.append(f'| {f} | {n} |')

md.append('\n## Cores que nascem de expressão dinâmica\n')
md.append('Não estão no JSON como string — tratadas em `evalVisualProps`, não no walk do loader.\n')
md.append('| Chave | Ocorrências |')
md.append('|---|---:|')
for k, n in dinamicas.most_common():
    md.append(f'| `{k}` | {n} |')

open('docs/tema-inventario.md', 'w').write('\n'.join(md) + '\n')

# HTML com swatch
h = ['<!doctype html><meta charset=utf-8><title>Inventário de tokens — app-marketplace</title>',
     '<style>body{font:14px/1.5 system-ui;margin:24px;background:#fafafa;color:#1f1f1f}'
     'table{border-collapse:collapse;width:100%;background:#fff}'
     'th,td{border:1px solid #e4e4e2;padding:6px 8px;text-align:left;vertical-align:middle}'
     'th{background:#f2f2f2;position:sticky;top:0}'
     '.sw{width:56px;height:28px;border:1px solid rgba(0,0,0,.15);border-radius:4px;'
     'background-image:linear-gradient(45deg,#ddd 25%,transparent 25%,transparent 75%,#ddd 75%),'
     'linear-gradient(45deg,#ddd 25%,transparent 25%,transparent 75%,#ddd 75%);'
     'background-size:10px 10px;background-position:0 0,5px 5px}'
     '.sw i{display:block;width:100%;height:100%;border-radius:3px}'
     'code{font:12px ui-monospace,monospace}.n{text-align:right}'
     '.ruim{color:#B23B3B;font-weight:600}.bom{color:#185C38}</style>',
     f'<h1>Inventário de tokens de tema</h1><p>{len(linhas)} tokens · {total_refs} referências. '
     'Contraste calculado contra branco e contra preto — <span class=ruim>vermelho</span> reprova AA (&lt;4.5:1) nos dois.</p>',
     '<table><tr><th>Swatch</th><th>Token</th><th>Valor</th><th class=n>Refs</th><th>Origem</th>'
     '<th>Nome na plataforma</th><th>Chaves</th><th>Onde</th><th class=n>/branco</th><th class=n>/preto</th></tr>']
for nome, val, n, orig, rot in linhas:
    key = nome if orig == 'no-code' else val
    ks = ', '.join(f'{k}×{c}' for k, c in chaves[key].most_common(3))
    on = ', '.join(o for o, _ in origem[key].most_common(3))
    cb, cp = contraste(val, BRANCO), contraste(val, PRETO)
    cls = 'ruim' if max(cb, cp) < 4.5 else 'bom'
    h.append(f'<tr><td><div class=sw><i style="background:{val}"></i></div></td>'
             f'<td><code>{html.escape(nome)}</code></td><td><code>{val}</code><br><code>{hexof(val)}</code>'
             + (f' <small>α{alpha(val):g}</small>' if alpha(val) != 1 else '') + '</td>'
             f'<td class=n>{n}</td><td>{orig}</td><td>{html.escape(str(rot))}</td>'
             f'<td><small>{html.escape(ks)}</small></td><td><small>{html.escape(on)}</small></td>'
             f'<td class="n {cls}">{cb:.1f}</td><td class="n {cls}">{cp:.1f}</td></tr>')
h.append('</table>')
open('docs/tema-inventario.html', 'w').write('\n'.join(h))

print(f'tokens de cor: {len(linhas)} | referências: {total_refs}')
print(f'  de token da plataforma: {sum(1 for r in linhas if r[3] == "no-code")}')
print(f'  gerados (--c_*):    {sum(1 for r in linhas if r[3] == "gerado")}')
print(f'raios: {len(raios)} | sombras: {len(sombras)} | fontes: {len(fontes)} | dinâmicas: {sum(dinamicas.values())}')
print('escrito: docs/tema-inventario.md, docs/tema-inventario.html')
