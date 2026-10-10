# nocode-runtime

**Pipeline export → app Next.js funcional + banco de dados.** Lê um arquivo `.bubble` (o JSON que o editor da plataforma gera) e produz: (1) o app completo navegável em Next.js (renderer runtime genérico), (2) `schema.sql` que recria o banco no Supabase/Postgres, (3) `backfill.sql` com os dados reais do seu app (via Data API da plataforma).

Pipeline de uma linha: `bash tools/pipeline.sh ../caminho/app.bubble`. Para outro export, troque o arquivo — o engine é genérico. Ver a skill **`nocode-to-app`**.

## Renderer

Renderiza o app completo e navegável — páginas, layout responsivo, estilos, expressões dinâmicas, workflows e dados (reais via Data API ou mock) — sem depender da plataforma.

Usado em apps reais de domínios diferentes (eventos e ingressos, automação de WhatsApp, fiscal, CRM e marketplace), com layouts das versões 4 e 5 do engine responsivo da plataforma.

## Como rodar

```bash
cd nocode-runtime
npm install
npm run dev        # http://localhost:3777
```

O arquivo de export é configurado em `nocode.config.json` (ou env `NOCODE_FILE`):

```json
{ "exportFile": "../meu-app.bubble", "appName": "meu-app" }
```

Rotas: `/<nome-da-pagina>[/<slug-ou-id-do-item>]`. Página inexistente lista todas as páginas disponíveis.

**Login mock:** qualquer e-mail e senha funcionam; o primeiro usuário do seed entra como administrador.

## Dados reais (Data API + SQLite local)

O renderer roda com **dados reais** puxados da Data API do app (`tools/`):

```bash
# token em tools/.env (gitignored): NOCODE_API_ROOT, NOCODE_API_TOKEN
python3 tools/fetch_data.py      # pagina os tipos expostos → data/raw/*.json
python3 tools/build_db.py        # → data/<slug>.sqlite (completo) + src/engine/seed-data.json (amostra)
```

- `data/<slug>.sqlite` — **banco completo**, 1 tabela por tipo, para testes/queries SQL.
- `src/engine/seed-data.json` — amostra relacional enxuta que o renderer carrega no client. Campos da Data API (display) são mapeados para os `field_id` do export; e-mail do user extraído de `authentication.email.email`.
- Tudo gitignored (`tools/.env`, `data/raw/`, `*.sqlite`) — token e PII não vão para versionamento.

## Arquitetura

```
src/engine/
├── loader.ts        [server] lê+indexa o export (cache); gera CSS de tokens e lista de fontes
├── payload.ts       [server] payload por página: árvore + reusables (transitivo) + styles + seeds
├── seed-data.json   mock DB (vem vazio; o build_db.py preenche com a amostra do seu app)
├── types.ts         tipos do formato do export
├── css.ts           properties+style → CSS (engine responsivo v5 → flexbox)
├── expressions.ts   avaliador da árvore de expressões (Message chains, Search, options, etc.)
├── data.ts          MockDB in-memory + OptionSets + auth fake
├── store.ts         store reativo: custom states, visibilidade, inputs, registry de instâncias
├── workflows.ts     executor de ações (navegação, estados, CRUD mock, toasts, plugins)
├── runtime.tsx      React context + PageLoaded/ConditionTrue + camada de toasts
├── NocodeApp.tsx    raiz: backdrop, título, escopo de página
├── bbcode.tsx       parser BBCode dos Texts ([b][color][fa][hr][url]...)
├── icons.tsx        dispatcher de ícones (feather/fa4/phosphor/material/ionic)
└── elements/ElementNode.tsx  renderer recursivo (Group, Text, Button, Input, RG, Popup,
                              reusables, FloatingGroup, GroupFocus, plugins)
```

As notas de engenharia reversa do formato do export (layout, expressões, workflows, estilos e modelo de dados) foram escritas em cima de apps de clientes e por isso não estão neste repositório. O que generaliza está no `COMECE-AQUI.md` (seções 8 e 9).

## O que funciona

- **Layout**: engine responsivo da plataforma (column/row/relative/fixed, gaps, min/max, fit/fixed/fluid por eixo, breakpoints via `Current Page Width`), página 404 legada (absoluta).
- **Estilos**: styles nomeados, tokens de cor (`--color_*_default[_rgb]`), Google Fonts, hover/focus/invalid, transitions, BBCode em Texts, 5 sets de ícones.
- **Expressões**: pipeline completo (comparação, lógica, aritmética, listas, texto, datas, `format_*` com moeda BR e dateFormat), Search com constraints + advanced, custom states, parâmetros de reusable, option sets com atributos, getters de campo com resolução relacional.
- **Workflows**: ButtonClicked/InputChanged/PageLoaded/ConditionTrue/CustomEvent/PopupOpened…, ações de navegação (ChangePage com path data + query params), Show/Hide/Toggle, SetCustomState, Display/ResetGroup, CRUD no mock DB, auth fake (LogIn/SignUp/LogOut com sessão em sessionStorage), toasts do plugin de notificação, clipboard, paginação de RG.
- **Reusables**: instâncias `CustomElement` (via `custom_id` → campo `id` da definição), parâmetros `param_*` lazy, reusables tipo Popup (overlay), headers flutuantes.
- **Dados**: mock DB seedado com a amostra do seu app: RepeatingGroups, somas em moeda, datas formatadas e filtros funcionam de verdade.

## Banco de dados (Supabase) + backend workflows

```bash
python3 tools/gen_supabase_schema.py    # → supabase/schema.sql (1 tabela por tipo + option sets, com RLS)
python3 tools/gen_supabase_backfill.py  # → supabase/backfill.sql (INSERTs com os dados reais, options normalizadas)
```

Validado em Postgres real (Docker): schema e backfill aplicam com **0 erros**; joins relacionais e option sets resolvem por FK canônica. Aplicar no Supabase: cole `schema.sql` e depois `backfill.sql` no SQL editor.

**Backend workflows:** não são convertidos sozinhos. Cada um é portado à mão para um route handler em `src/app/api/wf/<nome>/route.ts`, usando a camada de dados de `src/server/db.ts` (Supabase se `NEXT_PUBLIC_SUPABASE_URL` e `SUPABASE_SERVICE_KEY` estiverem definidos, senão o SQLite local). Os que eu portei eram regra de negócio de cliente e ficaram de fora.

## Diagnóstico de fidelidade

`node tools/diagnose.mjs / /login /painel` (com dev server no ar) visita as rotas informadas e reporta placeholders, warnings e overflow.

## Limitações conhecidas

- **Pagamentos e integrações externas**: não vêm prontos; entram junto com os backend workflows que você portar. `ScheduleAPIEvent` no renderer é mock/no-op.
- **Plugins visuais complexos**: QR code (placeholder visual), chart.js (barras fake), scanner de QR, image cropper → placeholders. Plugins de utilidade invisíveis (Toolbox Expression, FuseSearch, MaskInput controller) são no-op.
- Privacy rules ignoradas (mock roda como admin).
- `isnt_valid`/`isnt_clickable` simplificados (sem engine de validação completa).

## Usar com outro app no-code

1. Gere o arquivo `.bubble` no editor da plataforma.
2. Aponte `nocode.config.json` para o arquivo.
3. Ajuste `src/engine/seed-data.json` para as tabelas do novo app (ou deixe vazio — telas renderizam com listas vazias).
4. `npm run dev`.
