#!/usr/bin/env python3
"""Baixa os ARQUIVOS do CDN da plataforma referenciados pelos dados já puxados.

Por que existe: o export e a Data API só guardam URLs — os bytes vivem em
no CDN da plataforma (`<hash>.cdn.<domínio>`), que **morre junto com a conta da plataforma**. Sem reidratar esses
arquivos em storage próprio, o app migrado perde todas as fotos no dia do cancelamento.

O host é constante por app (`<hash>.cdn.<domínio>`); só o caminho `/f<ts>x<id>/<nome>`
muda. Guardamos esse caminho como chave — é ele que vira o path no Supabase Storage,
mantendo o de-para reversível.

Entrada : data/<slug>/raw/*.json   (produzidos por fetch_data.py)
Saída   : data/<slug>/files/<f...x.../nome>      — os bytes
          data/<slug>/files-manifest.json        — {url_original: {path, bytes, tipo, campo}}

Uso:  python3 tools/fetch_files.py            # baixa o que faltar (idempotente)
      python3 tools/fetch_files.py --dry-run  # só inventaria e estima volume
"""
import concurrent.futures
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import _common as C  # noqa: E402

EXPORT_FILE, APP, SLUG = C.read_config()
RAW = C.app_paths(SLUG)["raw"]
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "data", SLUG, "files")
MANIFEST = os.path.join(ROOT, "data", SLUG, "files-manifest.json")

# a vírgula PRECISA estar excluída: campos de lista de imagem guardam "url1,url2" numa
# única string — sem isso o separador entra no nome do arquivo e a URL retorna 403.
CDN_HOST = r'[a-f0-9]{16,}\.cdn\.[a-z0-9-]+\.io'  # <hash>.cdn.<domínio da plataforma>
URL_RE = re.compile(r'(?:https?:)?//' + CDN_HOST + r'/[^\s"\'\\,\]]+')
PATH_RE = re.compile(r'(?<!\.io)/f\d{10,}x\d+/[^\s"\'\\,\]]+')
WORKERS = 6
RETRIES = 3


def inventario():
    """{url_or_path: {'tipo','campo'}} — varre os raw/*.json em busca de referências."""
    achados = {}

    def scan(v, tipo, campo):
        if isinstance(v, str):
            hits = URL_RE.findall(v) or PATH_RE.findall(v)
            for m in hits:
                achados.setdefault(m, {"tipo": tipo, "campo": campo})
        elif isinstance(v, list):
            for x in v:
                scan(x, tipo, campo)
        elif isinstance(v, dict):
            for k, x in v.items():
                scan(x, tipo, campo or k)

    for f in sorted(os.listdir(RAW)):
        if not f.endswith(".json"):
            continue
        dados = json.load(open(os.path.join(RAW, f)))
        if not isinstance(dados, list):
            continue
        for row in dados:
            if isinstance(row, dict):
                for k, v in row.items():
                    scan(v, f[:-5], k)
    return achados


def host_do_app():
    """Descobre o host do CDN a partir das próprias referências (constante por app)."""
    for f in sorted(os.listdir(RAW)):
        if not f.endswith(".json"):
            continue
        m = re.search(r"//(" + CDN_HOST + r")", open(os.path.join(RAW, f)).read())
        if m:
            return f"https://{m.group(1)}"
    return None


def url_completa(ref, host):
    if ref.startswith("//"):
        return "https:" + ref
    if ref.startswith("http"):
        return ref
    return (host or "") + ref


def chave(ref):
    """Caminho estável /f<ts>x<id>/<nome>, sem querystring — vira o path no storage."""
    ref = ref.split("?")[0]
    m = re.search(r"/f\d{10,}x\d+/.+$", ref)
    return (m.group(0) if m else "/" + ref.rsplit("/", 1)[-1]).lstrip("/")


def baixar(item, host):
    ref, meta = item
    rel = chave(ref)
    destino = os.path.join(OUT, rel)
    if os.path.exists(destino) and os.path.getsize(destino) > 0:
        return rel, os.path.getsize(destino), "cache"
    os.makedirs(os.path.dirname(destino), exist_ok=True)
    for tentativa in range(RETRIES):
        try:
            req = urllib.request.Request(url_completa(ref, host), headers={"User-Agent": "nocode-runtime/1.0"})
            with urllib.request.urlopen(req, timeout=90) as r:
                dados = r.read()
            tmp = destino + ".part"
            with open(tmp, "wb") as fh:
                fh.write(dados)
            os.replace(tmp, destino)
            return rel, len(dados), "ok"
        except Exception as e:
            if tentativa == RETRIES - 1:
                return rel, 0, f"ERRO: {str(e)[:60]}"
    return rel, 0, "ERRO"


def main():
    achados = inventario()
    host = host_do_app()
    print(f"App {APP} (slug={SLUG}) — {len(achados)} arquivo(s) distinto(s) referenciados")
    print(f"host do CDN: {host}")
    if "--dry-run" in sys.argv:
        for ref, m in list(achados.items())[:5]:
            print(f"   ex: {m['tipo']}.{m['campo']:16} -> {chave(ref)}")
        return

    os.makedirs(OUT, exist_ok=True)
    manifest, total, falhas, cache = {}, 0, [], 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(baixar, it, host): it for it in achados.items()}
        for i, fut in enumerate(concurrent.futures.as_completed(futs), 1):
            ref, meta = futs[fut]
            rel, n, status = fut.result()
            if status.startswith("ERRO"):
                falhas.append((rel, status))
            else:
                total += n
                cache += 1 if status == "cache" else 0
                manifest[ref] = {"path": rel, "bytes": n, "tipo": meta["tipo"], "campo": meta["campo"]}
            if i % 25 == 0 or i == len(achados):
                print(f"  {i}/{len(achados)}  ({total/1024/1024:.0f} MB)")

    json.dump(manifest, open(MANIFEST, "w"), ensure_ascii=False, indent=1)
    print(f"\narquivos -> {OUT}  ({total/1024/1024:.0f} MB, {len(manifest)} arquivos, {cache} já em cache)")
    print(f"manifesto -> {MANIFEST}")
    if falhas:
        print(f"\n{len(falhas)} FALHA(S) — re-rodar o script tenta de novo só as que faltam:")
        for rel, st in falhas[:10]:
            print(f"   {rel}: {st}")


if __name__ == "__main__":
    main()
