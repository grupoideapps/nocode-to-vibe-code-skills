#!/usr/bin/env bash
# Pipeline completo: export → app Next + SQLite + schema.sql + backfill.sql
# Uso: bash tools/pipeline.sh [caminho/app.bubble]
# Se omitido, usa nocode.config.json#exportFile.
set -euo pipefail
cd "$(dirname "$0")/.."

EXPORT_FILE="${1:-}"
if [ -n "$EXPORT_FILE" ]; then
  printf '{\n  "exportFile": "%s",\n  "appName": "%s"\n}\n' "$EXPORT_FILE" "$(basename "${EXPORT_FILE%.*}")" > nocode.config.json
  echo "→ nocode.config.json apontando para $EXPORT_FILE"
fi

echo "==> 1/5 deps"
[ -d node_modules ] || npm install

# diretório de raw namespaceado por app (data/<slug>/raw)
RAW_DIR="$(python3 tools/_common.py --raw 2>/dev/null || true)"
[ -z "$RAW_DIR" ] && RAW_DIR="data/raw"

echo "==> 2/5 dados reais (Data API)"
if [ -f tools/.env ]; then
  python3 tools/fetch_data.py || echo "  (fetch falhou — seguindo com dados existentes)"
else
  echo "  (sem tools/.env — pulando fetch; app renderiza com seed existente ou vazio)"
fi

echo "==> 3/5 SQLite + seed do renderer"
[ -d "$RAW_DIR" ] && python3 tools/build_db.py || echo "  (sem $RAW_DIR — pulando build_db)"

echo "==> 4/5 schema.sql + backfill.sql (Supabase)"
python3 tools/gen_supabase_schema.py
[ -d "$RAW_DIR" ] && python3 tools/gen_supabase_backfill.py || echo "  (sem $RAW_DIR — backfill pulado)"

echo "==> 5/6 PRD reverso (docs/PRD-<slug>.md + slices)"
python3 tools/gen_prd.py || echo "  (gen_prd falhou — seguindo)"

echo "==> 6/6 typecheck"
npx tsc --noEmit && echo "  typecheck OK"

cat <<'EOF'

✅ Pipeline concluído. Artefatos:
   • App Next:        npm run dev   → http://localhost:3777
   • Banco de testes: data/<slug>.sqlite (better-sqlite3)
   • Schema Supabase: supabase/schema.sql      (rode no SQL editor)
   • Backfill dados:  supabase/backfill.sql    (rode após o schema)
   • PRD (esqueleto): docs/PRD-<slug>-auto.md  (fatos; regenerável. PRD final autoral = docs/PRD-<slug>.md)

Para validar fidelidade:  node tools/diagnose.mjs   (com o dev server no ar)
EOF
