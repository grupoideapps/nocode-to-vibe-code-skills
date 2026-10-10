---
name: nocode-to-app
description: Converte QUALQUER arquivo `.bubble` (o JSON que o editor da plataforma gera) em um app Next.js funcional + banco de dados (schema.sql para Supabase/Postgres + backfill.sql com os dados reais). Use SEMPRE que o usuário tiver um arquivo de export e quiser rodar/renderizar o app fora da plataforma, migrar para código próprio, recriar o banco no Supabase, ou popular esse banco com os dados reais via Data API. Ativa com frases como "renderizar o export", "rodar esse app no-code", "converter no-code em next", "migrar da plataforma", "gerar o banco da plataforma", "recriar o app no supabase", "backfill dos dados da plataforma", "parser da plataforma". O motor é o projeto nocode-runtime (interpretador runtime genérico + geradores SQL + endpoints de backend workflow).
---

# Skill: nocode-to-app

Pipeline determinístico que transforma um export em **app Next.js rodável + banco de dados recriável**. O motor vive em `nocode-runtime/` (irmão do export). NÃO gera código por página (codegen) — usa um **interpretador runtime** que lê o JSON e renderiza qualquer app no-code. Geradores SQL e endpoints de backend são determinísticos.

## Goal
Dado um export na pasta, ligar o pipeline e obter: (1) o app real em Next.js navegável, (2) `schema.sql` que recria o banco no Supabase/Postgres, (3) `backfill.sql` que popula esse banco com os dados reais.

## Pré-requisitos
- Node 20+, Python 3, Docker (opcional, só para validar o SQL).
- **OBRIGATÓRIO antes de começar: pedir ao usuário a URL do app + o token da Data API (private key).**
  Sem isso o app renderiza só com seed vazio. Pergunte explicitamente:
  1. URL do app (ex.: `https://app.SEUDOMINIO.com` ou o endereço padrão que a plataforma dá ao app).
  2. Token privado da Data API (Settings → API → "API Tokens").
  Monte o root REMOVENDO `version-test` (os dados ficam em **live**): `https://DOMINIO/api/1.1`.

## Como rodar (pipeline completo)

```bash
cd nocode-runtime
# credenciais da Data API — fica gitignored (PASSO OBRIGATÓRIO)
printf 'NOCODE_API_ROOT=https://app.SEUDOMINIO.com/api/1.1\nNOCODE_API_TOKEN=<token>\n' > tools/.env
#   ^ SEM version-test (dados em live). Domínio próprio ou o endereço padrão do app, sempre terminando em /api/1.1

bash tools/pipeline.sh ../caminho/app.bubble      # orquestra tudo (namespaceia por app)
npm run dev                                        # http://localhost:3777
```

O `pipeline.sh` executa, em ordem: deps → `fetch_data.py` (Data API) → `build_db.py` (SQLite + seed do renderer) → `gen_supabase_schema.py` + `gen_supabase_backfill.py` → typecheck.

**Multi-app:** tudo é namespaceado por slug (basename do export): `data/<slug>/raw/`, `data/<slug>.sqlite`.
`tools/_common.py` deriva slug, paths e o mapa `API_TYPE→user_type` do próprio export (nada hard-coded).
Cap de fetch: `NOCODE_MAX_ROWS=5000` por tipo (default; `NOCODE_MAX_ROWS=0` puxa tudo).

## Etapas (o que cada script faz)

| Script | Entrada | Saída |
|---|---|---|
| `tools/fetch_data.py` | Data API (`/meta` descobre tipos; token em `tools/.env`) | `data/<slug>/raw/*.json` (tipos expostos, cursor; nomes URL-encodados) |
| `tools/build_db.py` | `data/<slug>/raw` + user_types | `data/<slug>.sqlite` + `src/engine/seed-data.json` (amostra GENÉRICA p/ o client) |
| `tools/gen_supabase_schema.py` | user_types + option_sets | `supabase/schema.sql` (CREATE TABLE + option sets seedados + RLS) |
| `tools/gen_supabase_backfill.py` | `data/<slug>/raw` | `supabase/backfill.sql` (INSERTs idempotentes, options normalizadas display→db_value) |
| `tools/gen_prd.py` | export (+ sqlite p/ contagens) | `docs/PRD-<slug>.md` (PRD reverso determinístico) + `data/<slug>/prd/slices/*.json` |
| `tools/diagnose.mjs` | dev server no ar | `data/diagnosis.json` (placeholders/warnings/overflow por página) |

## Validar o SQL (Postgres efêmero)
```bash
docker run -d --name pgtest -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16-alpine
docker cp supabase/schema.sql pgtest:/ && docker exec pgtest psql -U postgres -f /schema.sql
docker cp supabase/backfill.sql pgtest:/ && docker exec pgtest psql -U postgres -f /backfill.sql
# esperado: 0 erros; conferir contagens e um join relacional
docker rm -f pgtest
```

## Aplicar no Supabase real
1. SQL editor do Supabase → cole `supabase/schema.sql` → run.
2. Cole `supabase/backfill.sql` → run (ou `psql` na connection string).
3. Endpoints de backend workflow (`/api/wf/*`) passam a usar Supabase ao setar
   `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_KEY` (senão usam o SQLite local).

## PRD reverso do app (modelo nocode-to-prd, integrado e namespaceado)
`python3 tools/gen_prd.py` gera o **esqueleto determinístico** `docs/PRD-<slug>-auto.md` (visão geral, mapa de
páginas, modelo de dados c/ contagens reais do sqlite, option sets, workflows [gatilhos+ações], API connector,
endpoints de backend, design tokens) + slices em `data/<slug>/prd/slices/`. O **PRD final autoral**
`docs/PRD-<slug>.md` (17 seções: narrativa + regras de negócio + fluxos + contratos) é escrito por LLM **uma
vez** usando `tools/prd_prompt.md` + os slices + o `-auto.md` (não é sobrescrito pelo gerador). Workflows reais ficam em `pages.<id>.workflows` (não `wf_folder_list`).

## Loop de fidelidade (pixel-perfect)
1. `npm run dev` + abrir o site real e o renderer no mesmo viewport.
2. Medir DOM de ambos (cores, fontes, tamanhos, raios) e corrigir no engine **genérico**
   (`src/engine/css.ts`, `elements/ElementNode.tsx`) — correções valem para qualquer export.
3. `node tools/diagnose.mjs` → resolver `topPlaceholders` (plugins) e `topWarns`.
   Plugin IDs da plataforma são globais do marketplace; mapear um plugin no `PluginEl` beneficia todos os apps.

## Loop de qualidade VISUAL com a skill `frontend-design` (parte do processo — sempre rodar)
Após o sweep passar 0/0/0, rode uma rodada de DESIGN (mesmo sem site real de referência — nesse caso a
fonte de verdade é o próprio export: styles, color tokens, layout props):
1. Screenshots de TODAS as telas via Playwright (deslogado, logado, cada seção `?page=`, popups abertos).
2. Invocar a skill **`frontend-design`** e analisar cada screenshot com olhar crítico: cores/bordas
   faltando, colunas que não esticam, textos desalinhados, imagens cortadas, ícones genéricos (fallback),
   botões sem contraste. Para cada anomalia: "o export define isso?" → inspecionar o JSON.
3. Corrigir SEMPRE no engine genérico — a causa típica é convenção nova não suportada (ex.: formato novo
   de `color_tokens_user`; var() CSS indefinida descarta a declaração e some com TODAS as cores custom).
4. **Seed de demonstração**: sem dados reais, popular `seed-data.json` à mão (tenant + listas que alimentam
   kanban/chat) — revela placeholders escondidos em células de RG vazias e deixa o app demonstrável.
5. Re-rodar sweep + screenshots; repetir até excelente. Ver protocolo completo: `COMECE-AQUI.md` §2d.

## Arquitetura do motor (referência)
- Specs do formato do export: `nocode-runtime/analysis/01..08*.md` (layout, expressões, workflows, estilos, dados, plugins, site real, backend workflows). LER antes de mexer no engine.
- Renderer: `src/engine/` (parser, css, expressions, workflows, store, ElementNode).
- Backend: `src/server/db.ts` (camada de dados Supabase|SQLite); cada backend workflow portado vira um route handler em `src/app/api/wf/*`.

## Pegadinhas (aprendidas; valem para qualquer export)
- `CustomElement.custom_id` referencia o **campo `id`** da definição, não a chave do dict (`_index` resolve).
- Largura fixa autoritativa = `min_width_css` (nunca `width`, que é geometria de editor).
- Elementos ocultos **colapsam** por padrão (`display:none`); só `collapse_when_hidden:false` mantém espaço.
- `border_color` sem `border_style` → o editor assume `solid`.
- Defaults de tipo: Text/Input/Button caem em `font_size:14` quando o style não define.
- Data API devolve campos pelo **display** (mapear p/ field_id via user_types) e options pelo **display**
  (normalizar p/ `db_value` no backfill). Email do user fica em `authentication.email.email`.
- `user` é reservado no Postgres → schema usa tabela `usuario` (a data layer traduz).
- Tipos sem coluna no schema vão para `_raw jsonb` (resiliência a campos deletados/novos).
- **Tipo `dateinterval`** = número (ms) → mapear p/ `double precision`, NÃO jsonb (senão seed de inteiro quebra).
- **Coluna jsonb recebendo escalar** (tipo desconhecido em atributo de option set) → `sql_literal` JSON-encoda
  com `::jsonb`. Vale p/ qualquer `value` futuro fora do SCALAR_MAP (ex.: `api.apiconnector2...`).
- **Elementos NATIVOS** que não são Input/Text/Button caem no fallback de plugin: `Video` (YouTube via
  `video_id`), `SliderInput` (`<input type=range>`, `handle_color`→accent). Tratar no switch principal.
- **Plugins comuns do marketplace** (IDs globais — mapear 1x vale p/ todo app): Feather Icon
  `1553889862898x...` (AAP=nome feather), Icon Button `1646133638573x...` (AAD=ícone/normalizar sufixos
  bootstrap `-lg/-fill`, AAE=cor), TinyMCE `1671672447428x...` (AAI=placeholder, AAc=valor → textarea),
  Multi-File `multifileupload-MultiFileInput` (`<input file multiple>`).
- **Utilitários invisíveis** (no-op, somem do placeholder): LocalStorage UX `1617739938396x...`,
  DatesGenerator `1594298820861x...`, CreateFile `1609955761273x...`, AnyTextToList `1671828254560x...`.
- Páginas que renderizam "quase-vazias" no sweep geralmente são **parametrizadas** (precisam de `?param`/
  item na URL) ou têm **redirect em PageLoaded** (ex.: exigem login) — não é bug do renderer.
- Páginas têm chave críptica no dict (`bTxxx`); o nome de rota está em `pages[k].name`.
- **Nome do tipo na Data API** = `display.lower().replace(' ','')` (NÃO a chave interna do user_type, que é
  outra sanitização). Tipos expostos têm a flag `exposed_api` no metadata. `_common.build_api_to_internal`
  deriva `{api_name→internal_key}` do export (em colisão de display, prefere `exposed_api`/não-deletado).
- **URL-encodar o nome do tipo** no fetch (`urllib.parse.quote`): há tipos com ç, parênteses, espaços
  (ex.: `serviços`, `apicontapro(empresas)`) que quebram a URL crua com `UnicodeEncodeError`.
- **Tabelas gigantes** (dezenas de milhares de linhas) travam o fetch sequencial → cap por tipo
  (`NOCODE_MAX_ROWS`, default 5000); todos os tipos ficam representados. `NOCODE_MAX_ROWS=0` puxa tudo.
- **Seed do client é genérico** (agnóstico de domínio): N linhas por tabela (mais recentes) + fechamento de
  referências (ids citados por campos ref são puxados) + senha mock nos users (admins por heurística no topo).
- **Sem FK real no schema** (refs são `text` com comentário) → ordem de carga do backfill é irrelevante.
- `seed-data.json` e `data/<slug>/raw|*.sqlite` contêm PII real → gitignored; regenerados pelo pipeline.
- **Trocar de app:** mate o dev server antigo e suba de novo (`nohup npm run dev >log 2>&1 & disown`; aguarde
  `Ready in`); senão o Next serve o app anterior em cache. Confirme pelo `<title>`.
- **Plugins mapeados (acumulam):** + GetJSON `1512987045178x` (invisível) e Color Picker `1498952719168x`
  (`<input type=color>`), descobertos no app fiscal `app-fiscal`. Cada export novo pode revelar mais —
  ver placeholder por `data-btype` no sweep e mapear no `PluginEl`.
- **Formatação condicional** fica na chave `states` (não `conditions`) — cada item tem `condition` + `properties`
  (ex.: `is_visible:true`). `mergeProps` avalia e aplica. `is_visible:false` → `display:none` (verificado 21/21).
- **Estado no load:** PageLoaded roda ANTES do paint (`useLayoutEffect`), então `SetCustomState` de load aplica
  antes da 1ª renderização → wizards que inicializam no load resolvem (corrigiu o onboarding do app-fiscal).
  Limite: passos que só avançam por clique do usuário ainda exigem interação (render estático não encadeia cliques).
