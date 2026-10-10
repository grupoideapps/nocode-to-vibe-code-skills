#!/usr/bin/env python3
"""Puxa todos os dados da Data API da plataforma (version-test) com o token privado.

Pagina cada tipo exposto (cursor + limit), salva raw em data/raw/<tipo>.json.
Lê credenciais de tools/.env (NOCODE_API_ROOT, NOCODE_API_TOKEN).

Uso:
    python3 tools/fetch_data.py            # todos os tipos
    python3 tools/fetch_data.py evento user   # tipos específicos
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import _common as C  # noqa: E402

_, _APP, _SLUG = C.read_config()
RAW_DIR = C.app_paths(_SLUG)["raw"]  # data/<slug>/raw — namespaceado por app

# cap de linhas por tipo (evita travar em tabelas com dezenas de milhares de registros).
# 0 = sem limite. Override por env: NOCODE_MAX_ROWS=0 puxa tudo.
MAX_ROWS = int(os.environ.get("NOCODE_MAX_ROWS", "5000"))


def load_env():
    env = {}
    path = os.path.join(HERE, ".env")
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    env.setdefault("NOCODE_API_ROOT", os.environ.get("NOCODE_API_ROOT", ""))
    env.setdefault("NOCODE_API_TOKEN", os.environ.get("NOCODE_API_TOKEN", ""))
    return env


def api_get(url, token, retries=3):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "ignore")[:300]
            if e.code in (429, 500, 502, 503) and attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
                continue
            raise RuntimeError(f"HTTP {e.code} em {url}: {body}")
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
                continue
            raise RuntimeError(f"Falha de rede em {url}: {e}")


def fetch_type(root, token, type_name, page_size=100):
    results = []
    cursor = 0
    enc_type = urllib.parse.quote(type_name, safe="")  # nomes com ç, (), espaços
    while True:
        url = f"{root}/obj/{enc_type}?limit={page_size}&cursor={cursor}"
        data = api_get(url, token)
        resp = data.get("response", {})
        batch = resp.get("results", [])
        results.extend(batch)
        remaining = resp.get("remaining", 0)
        got = resp.get("count", len(batch))
        print(f"  {type_name}: +{got} (cursor {cursor}, restam {remaining})")
        if remaining <= 0 or got == 0:
            break
        if MAX_ROWS and len(results) >= MAX_ROWS:
            print(f"  {type_name}: atingiu cap {MAX_ROWS} (restavam {remaining}) — parando")
            break
        cursor += got
        time.sleep(0.2)
    return results


def main():
    env = load_env()
    root = env["NOCODE_API_ROOT"].rstrip("/")
    token = env["NOCODE_API_TOKEN"]
    if not root or not token:
        sys.exit("Defina NOCODE_API_ROOT e NOCODE_API_TOKEN em tools/.env")

    os.makedirs(RAW_DIR, exist_ok=True)

    meta = api_get(f"{root}/meta", token)
    json.dump(meta, open(os.path.join(RAW_DIR, "_meta.json"), "w"), ensure_ascii=False, indent=1)
    types = meta.get("get", [])
    print(f"Tipos expostos ({len(types)}): {types}")

    wanted = sys.argv[1:] or types
    summary = {}
    for t in wanted:
        if t not in types:
            print(f"  (pulando {t}: não exposto)")
            continue
        rows = fetch_type(root, token, t)
        json.dump(rows, open(os.path.join(RAW_DIR, f"{t}.json"), "w"), ensure_ascii=False, indent=1)
        summary[t] = len(rows)

    print("\n=== Resumo ===")
    for t, n in summary.items():
        print(f"  {t}: {n} registros")
    json.dump(summary, open(os.path.join(RAW_DIR, "_summary.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
