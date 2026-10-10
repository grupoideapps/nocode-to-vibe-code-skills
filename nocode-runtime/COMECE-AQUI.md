# 🚀 COMECE AQUI — Parser de export no-code → App Next.js + Banco + PRD

> **Documento fundamental.** Leia isto para retomar/testar o parser em qualquer sessão nova.
> **Objetivo:** pegar **qualquer** arquivo `.bubble` (o JSON que o editor da plataforma gera) e produzir, de forma genérica:
> **(1)** o app real navegável em Next.js, **(2)** o banco recriável no Supabase (`schema.sql` + `backfill.sql`),
> **(3)** um **PRD reverso**. Nada hard-coded para um app só. Motor = interpretador runtime (lê o JSON e
> renderiza), NÃO codegen.
>
> **Validado em apps reais** (app-eventos ev5 / app-whatsapp ev4 / app-fiscal ev5; nomes trocados), todos
> **0 erros JS · 0 overflow · 0 placeholders**. Cobertura cresce por tipo-de-elemento e por operador, não por app.

---

## ⚡ TL;DR — testar um app novo do zero

```bash
cd "nocode-runtime"

# 1. (peça URL+token ao usuário — passo OBRIGATÓRIO, ver §0). Sem token, pule esta linha.
printf 'NOCODE_API_ROOT=https://app.SEUDOMINIO.com/api/1.1\nNOCODE_API_TOKEN=<token>\n' > tools/.env

# 2. pipeline completo (aponta o config + gera app, banco, PRD)
bash tools/pipeline.sh ../caminho/app.bubble

# 3. suba o dev server — numa sessão Claude use Bash run_in_background:true (ver §1.1, NÃO use nohup)
#    npm run dev   → http://localhost:3777

# 4. verifique: sweep das páginas (§2a) + valide SQL no Postgres (§2b)
```

Meta de aprovação: **0 erros JS / 0 overflow / 0 placeholders** no sweep e **0 erros** ao aplicar
`schema.sql`+`backfill.sql` no Postgres.

---

## 0. Pré-requisito OBRIGATÓRIO — sempre pergunte antes de começar

Antes de rodar o parser num app, **peça ao usuário** (não invente, não adivinhe):

1. **URL do app** — ex.: `https://app.SEUDOMINIO.com` (domínio próprio) ou o endereço padrão que a plataforma dá ao app.
2. **Token privado da Data API** — no editor da plataforma: **Settings → API → API Tokens → private key**.

Monte o root **SEM `version-test`** (os dados de produção ficam em **live**; já houve confusão com isso):

```
NOCODE_API_ROOT=https://app.SEUDOMINIO.com/api/1.1     # termina em /api/1.1, sem /obj e sem /wf
NOCODE_API_TOKEN=<token>
```

Grave em `tools/.env` (já é **gitignored**). Sem token: o app renderiza com seed vazio (sem dados reais,
sem `backfill.sql`, sem contagens no PRD) — útil só para validar render+schema. Com token: pixel-perfect e banco completo.

> A Data API expõe um endpoint `GET /api/1.1/meta` que lista os tipos (`get`) e os backend workflows
> (`post`). O `fetch_data.py` usa isso para descobrir tudo sozinho — você não precisa saber os tipos de antemão.

---

## 1. Rodar o pipeline completo

```bash
cd nocode-runtime
bash tools/pipeline.sh ../caminho/app.bubble     # escreve nocode.config.json + orquestra tudo
```

Ordem interna do `pipeline.sh` (6 passos): deps → `fetch_data` (Data API) → `build_db` (SQLite + seed do
renderer) → `gen_supabase_schema` + `gen_supabase_backfill` → `gen_prd` → typecheck (`tsc --noEmit`).

**Namespace por app** (slug = basename do export, ex. `app-whatsapp`): `data/<slug>/raw/`,
`data/<slug>.sqlite`, `data/<slug>/prd/`, e `docs/PRD-<slug>*.md`. Apps **não se sobrescrevem** — trocar é só
apontar para outro export. Os únicos artefatos compartilhados (sobrescritos a cada run) são
`supabase/schema.sql`, `supabase/backfill.sql` e `src/engine/seed-data.json` — eles refletem o app ATIVO.

Flags úteis:
- `NOCODE_MAX_ROWS=5000` (default) — cap de linhas por tipo no fetch, p/ não travar em tabelas de dezenas de
  milhares. `NOCODE_MAX_ROWS=0 bash tools/pipeline.sh ...` puxa **tudo**.
- Rodar só uma etapa: `python3 tools/gen_supabase_schema.py`, `python3 tools/gen_prd.py`, etc. (todos leem
  o app ativo do `nocode.config.json`).

### 1.1 ⚠️ Subir e gerenciar o dev server (lição operacional importante)

Numa sessão do Claude, **`nohup npm run dev & disown` NÃO sobrevive** entre chamadas de Bash (o processo é
morto quando a tool retorna). O jeito **confiável** é a flag **`run_in_background: true`** da tool Bash — o
harness mantém o processo vivo entre turnos.

**Ritual para (re)subir o server — faça sempre que TROCAR de app** (senão o Next serve o app anterior em cache):

```bash
# 1) matar qualquer server antigo e liberar a porta
pkill -9 -f "next" 2>/dev/null; sleep 2
(lsof -ti:3777 2>/dev/null | xargs -r kill -9) 2>/dev/null; sleep 1

# 2) subir com run_in_background:true  →  npm run dev > /tmp/dev.log 2>&1

# 3) aguardar ficar pronto (faça num Bash separado, com polling):
until curl -s -o /dev/null -w "%{http_code}" http://localhost:3777/ 2>/dev/null | grep -q 200; do sleep 1; done

# 4) CONFIRME que serve o app certo pelo <title>:
curl -s http://localhost:3777/ | grep -oE "<title>[^<]*</title>" | head -1
```

Se o `<title>` mostrar o app errado, o server velho ficou no ar — repita o passo 1. Comandos `pkill`/`lsof`
podem retornar exit 1 quando não há nada para matar; isso é normal, não é erro.

---

## 2. Verificar se ficou bom (loop de qualidade)

### a) Sweep de páginas — meta: 0 erros / 0 overflow / 0 placeholders

Com o dev server no ar, crie **`ec-sweep.mjs` dentro de `nocode-runtime/`** (precisa do `node_modules` local)
e rode `node ec-sweep.mjs`. Esta versão é **config-driven** (lê o app ativo do `nocode.config.json`):

```js
import { chromium } from 'playwright';
import fs from 'node:fs';
const cfg = JSON.parse(fs.readFileSync('nocode.config.json', 'utf8'));
const d = JSON.parse(fs.readFileSync(cfg.exportFile, 'utf8'));
const names = [...new Set(Object.values(d.pages).map((p) => p?.name).filter(Boolean))];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
let E = 0, O = 0, P = 0, blank = [];
const phTypes = {};
for (const p of names) {
  const page = await ctx.newPage();
  const er = [];
  page.on('console', (m) => { if (m.type() === 'error') er.push(m.text().slice(0, 140)); });
  page.on('pageerror', (e) => er.push('PE:' + String(e).slice(0, 140)));
  try { await page.goto(`http://localhost:3777/${p}`, { waitUntil: 'networkidle', timeout: 30000 }); }
  catch (e) { er.push('GOTO'); }
  await page.waitForTimeout(500);
  let m = { ph: 0, ovf: 0, vis: 0, txt: 0, phl: [] };
  try {
    m = await page.evaluate(() => ({
      ph: document.querySelectorAll('.nc-plugin-placeholder').length,
      ovf: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      vis: [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2; }).length,
      txt: document.body.innerText.trim().length,
      phl: [...document.querySelectorAll('.nc-plugin-placeholder')].map((e) => `${e.textContent.trim().slice(0, 24)}|${e.getAttribute('data-btype')}`),
    }));
  } catch { er.push('redirect'); }
  E += er.length; O += m.ovf > 0 ? 1 : 0; P += m.ph; if (m.vis < 5) blank.push(p);
  for (const t of m.phl) phTypes[t] = (phTypes[t] || 0) + 1;
  const flag = er.length || m.ovf > 0 || m.ph ? ' ⚠' : '';
  console.log(`/${p.padEnd(28)} vis=${String(m.vis).padStart(5)} txt=${String(m.txt).padStart(5)} ph=${m.ph} ovf=${m.ovf}${flag}`);
  for (const e of er.slice(0, 2)) console.log('   ' + e);
  await page.close();
}
await browser.close();
console.log(`\n${cfg.appName}: páginas=${names.length} erros=${E} overflow=${O} placeholders=${P} quase-vazias=${blank.length} [${blank.join(',')}]`);
if (Object.keys(phTypes).length) { console.log('placeholders por tipo:'); for (const [t, n] of Object.entries(phTypes)) console.log(`  ${n}× ${t}`); }
```

**Como interpretar:**

| Sinal | Significado | O que fazer |
|---|---|---|
| `ph` > 0 | plugin/elemento sem handler (vira caixa cinza com o nome) | pegue o `data-btype` (impresso em "placeholders por tipo") e mapeie no `ElementNode.tsx` — ver §3. IDs de plugin são **globais do marketplace** → mapear 1× vale p/ todo app futuro |
| `ovf` > 0 | overflow horizontal | bug de CSS em `src/engine/css.ts` (largura/flex) |
| erro JS no console | exceção de runtime | abrir o caso; mas **redirect em `PageLoaded` NÃO é erro** (o sweep marca `redirect` — é página que exige login/param) |
| `vis` baixo / `txt`=0 | página "quase-vazia" | normalmente **parametrizada** (precisa `?param`/item na URL) ou **redirect** por exigir login — não é bug |
| placeholder transiente | aparece num run e some no outro | plugin que renderiza tarde no load assíncrono — reverifique antes de tratar como bug |

Para reproduzir um placeholder específico, abra a página e leia `data-btype` do `.nc-plugin-placeholder`.

### b) Validar o SQL em Postgres efêmero — meta: 0 erros

```bash
docker rm -f pgtest 2>/dev/null
docker run -d --name pgtest -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16-alpine
until docker exec pgtest pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
docker cp supabase/schema.sql   pgtest:/schema.sql   && docker exec pgtest psql -U postgres -q -f /schema.sql   2>&1 | grep -i error
docker cp supabase/backfill.sql pgtest:/backfill.sql && docker exec pgtest psql -U postgres -q -f /backfill.sql 2>&1 | grep -i error
docker exec pgtest psql -U postgres -tAc "select count(*) from information_schema.tables where table_schema='public';"   # nº de tabelas
docker exec pgtest psql -U postgres -tAc "select count(*) from usuario;"                                                 # users reais
docker rm -f pgtest
```

Nenhuma linha após os `grep -i error` = 0 erros. Confira também um join relacional faz sentido (ex.: contar
linhas de uma tabela-filha que referencia outra).

### c) Comparação visual / pixel-perfect (opcional, com token)

Abra o site real e o renderer no mesmo viewport (1280×900), tire screenshots e meça o DOM (cores, fontes,
tamanhos, raios). Corrija **no engine genérico** (`css.ts`, `ElementNode.tsx`) — correções valem p/ qualquer
export. Login mock: qualquer senha funciona; admins reais no topo do seed.

### d) Loop de qualidade visual SEM o site real (skill `frontend-design` integrada)

Quando não há site de referência (app sem token / fora do ar), a **fonte de verdade é o próprio export**
(styles, color tokens, layout props). Protocolo validado no app-crm:

1. **Screenshots de todas as telas** via Playwright (logado e deslogado, popups abertos, cada seção de SPA
   `?page=`) — um script `ec-shots.mjs` com login + fechamento de onboarding.
2. **Análise com olhar de design** (skill `frontend-design`): para CADA anomalia visual (cor faltando, caixa
   sem borda, coluna que não estica, texto desalinhado, imagem cortada, ícone genérico), perguntar:
   "o export define isso?" → inspecionar styles/tokens/props do elemento no JSON.
3. **Corrigir SEMPRE no engine genérico** — a causa quase nunca é o app, é convenção não suportada
   (token em formato novo, default do editor não replicado, operador não avaliado).
4. Re-rodar sweep (0/0/0) + screenshots e comparar antes/depois.
5. **Seed de demonstração**: sem dados reais, enriquecer `seed-data.json` à mão (kanban com colunas,
   conversas, mensagens) revela elementos que só renderizam com dados (placeholders escondidos em células
   de RG!) e deixa o app demonstrável.

---

## 3. 🔌 Cookbook — mapear um plugin/elemento que virou placeholder

Tudo acontece em **`src/engine/elements/ElementNode.tsx`**. Três casos:

**1) Plugin de UTILIDADE invisível** (busca/converte dados, sem visual) → adicione o prefixo do ID em
`INVISIBLE_PLUGIN_PREFIXES` (vira `display:none`). Já lá: Toolbox, FuseSearch, MaskInput, reveal-password,
LocalStorage, DatesGenerator, CreateFile, AnyTextToList, **GetJSON**, etc.

**2) Plugin VISUAL** → adicione um handler dentro de `PluginEl` (casa por `el.type.startsWith('<pluginId>')`).
As props ficam em `rawProps.AAx` (chaves tipo `AAB`, `AAP`…); descubra quais inspecionando o export
(procure o elemento por `default_name` e veja `properties`). Template:

```tsx
// Meu Plugin (1234567890123x...) — AAP = nome, AAE = cor
if (el.type.startsWith('1234567890123x000000000000000000')) {
  const name = rawProps.AAP != null ? coerceText(evaluate(rawProps.AAP, ctx), ctx) : 'circle';
  const color = typeof props.AAE === 'string' ? props.AAE : 'currentColor';
  return (
    <div {...common} className="nc-el" style={{ ...css, display: 'flex', alignItems: 'center', justifyContent: 'center', color }}>
      <NocodeIcon icon={`feather ${name}`} size={16} color={color} />
    </div>
  );
}
```

Já mapeados em `PluginEl`: Feather Icon `1553889862898x`, Icon plugin `1649513217691x`, Icon Button
`1646133638573x`, Toggle `1660311476391x`, LottieFiles `1676280573614x`, OutlineIcon/Heroicons
`1618916043803x`, Spreadsheet `1608827595218x`, QRCode `1618741364806x`, TinyMCE `1671672447428x`,
Color Picker `1498952719168x`, Multi-File `multifileupload-MultiFileInput`, Ionic icon/toggle, select2, progressbar, chartjs.

**3) Elemento NATIVO da plataforma** (não é plugin: `type` é uma palavra como `Video`, `SliderInput`) → adicione um
`case` no switch principal de `ElementNode` (perto de `case 'HTML'`). Já lá: `Video` (YouTube via `video_id`),
`SliderInput` (`<input type=range>`), além de Group/Text/Button/Input/Image/RepeatingGroup/Link/Popup/etc.

**Como achar o ID e as props de um elemento** (Python, ad-hoc):

```python
import json, re
d = json.load(open('../caminho/app.bubble'))
def walk(n):
    if isinstance(n, dict):
        t, nm = n.get('type'), n.get('default_name') or n.get('name')
        if isinstance(t, str) and re.match(r'^\d{13}x\d', t) and 'NOME_DO_PLUGIN' in str(nm):
            print(t, '→', {k: str(v)[:60] for k, v in n.get('properties', {}).items()}); return
        for v in n.values(): walk(v)
    elif isinstance(n, list):
        [walk(v) for v in n]
walk(d.get('pages', {})); walk(d.get('element_definitions', {}))
```

Sempre rode `npx tsc --noEmit` depois de editar o engine. O dev server recompila sozinho (~1-2s) — re-rode o sweep.

### 3.1 Visibilidade condicional, custom states e wizards

- **Formatação condicional** fica na chave **`states`** de cada elemento (NÃO `conditions`!). Cada item tem
  `condition` (expressão) + `properties` (ex.: `is_visible:true`, cor, texto). `mergeProps` avalia e aplica.
- **`is_visible:false`** → o elemento vira `data-bhidden` → `display:none` (colapsa). Verificado: 21/21 ocultos
  realmente somem. Isso funciona; **não confunda** "passo de wizard sobreposto" com "visibilidade quebrada".
- **Estado no load:** os workflows **`PageLoaded` rodam ANTES do paint** (`useLayoutEffect` em
  `runtime.tsx#ContainerWorkflows`), então `SetCustomState` de carga aplica antes da 1ª renderização → wizards
  que inicializam estado no load resolvem o passo certo (corrigiu o onboarding do app-fiscal).
- **Limite remanescente:** passos que só avançam por **clique do usuário** no meio do fluxo exigem interação —
  um render estático não encadeia cliques.

---

## 4. PRD reverso do app (modelo `nocode-to-prd`, integrado)

```bash
python3 tools/gen_prd.py          # usa o export do nocode.config.json
```

Gera **dois artefatos**:

- `docs/PRD-<slug>-auto.md` — **esqueleto determinístico** (visão geral, mapa de páginas com nº de workflows,
  modelo de dados com **contagens reais do sqlite**, option sets, workflows com gatilhos+tipos de ação, API
  connector, endpoints de backend, design tokens). **Regenerado a cada run — nunca edite à mão.**
- `data/<slug>/prd/slices/*.json` — slices factuais por seção (pages, user_types, option_sets, api_connector,
  workflows_index, etc.).

O **PRD final autoral** `docs/PRD-<slug>.md` (17 seções: narrativa + regras de negócio + fluxos + contratos)
é escrito por **LLM uma vez**, carregando `tools/prd_prompt.md` + os slices + o `-auto.md`, e **não é
sobrescrito** pelo gerador.

---

## 5. Aplicar no Supabase real (deploy do banco)

1. SQL editor do Supabase → cole `supabase/schema.sql` → run (cria 1 tabela por user_type + `os_<set>` por
   option set + RLS permissiva; `user`→`usuario` por ser reservado no Postgres).
2. Cole `supabase/backfill.sql` → run (INSERTs idempotentes `ON CONFLICT (id) DO NOTHING`; options
   normalizadas display→db_value). Ou `psql` na connection string.
3. Os endpoints `/api/wf/*` passam a usar Supabase ao setar **`NEXT_PUBLIC_SUPABASE_URL` +
   `SUPABASE_SERVICE_KEY`** (senão usam o SQLite local `data/<slug>.sqlite`).

---

## 6. Mapa do que está onde

| Caminho | Papel |
|---|---|
| `nocode.config.json` | aponta o export ATIVO (`exportFile`, `appName`) — o slug sai daqui |
| `tools/_common.py` | **núcleo genérico**: slug, paths namespaceados, e `build_api_to_internal` (mapa `API_TYPE→user_type` derivado do export) + CLI `--raw/--slug/--sqlite` |
| `tools/fetch_data.py` | Data API → `data/<slug>/raw/*.json` (descobre tipos via `/meta`; URL-encoda nomes; cap `NOCODE_MAX_ROWS`) |
| `tools/build_db.py` | raw → `data/<slug>.sqlite` (completo) + `src/engine/seed-data.json` (amostra genérica p/ o client) |
| `tools/gen_supabase_schema.py` | export → `supabase/schema.sql` |
| `tools/gen_supabase_backfill.py` | raw → `supabase/backfill.sql` |
| `tools/gen_prd.py` | export (+sqlite) → `docs/PRD-<slug>-auto.md` + slices |
| `tools/prd_prompt.md` | prompt mestre de 17 seções p/ o PRD autoral |
| `tools/pipeline.sh` | orquestrador (6 passos) |
| `src/engine/` | renderer: `loader`, `payload`, `css`, `expressions`, `workflows`, `store`, `runtime.tsx`, `bbcode`, `icons`, **`elements/ElementNode.tsx`** |
| `src/server/db.ts` | data layer Supabase\|SQLite (resolve o sqlite por slug do config) |
| `src/app/api/wf/*` | endpoints de backend workflow: você cria um por workflow portado (não vêm neste repositório) |
| `docs/PRD-*.md` | PRDs gerados |

**Skills:** `nocode-to-app` (este pipeline) · `nocode-to-prd` (PRD standalone, também integrado aqui).

**Stack:** Next.js 15 + React 19 + TS, better-sqlite3, @supabase/supabase-js, Playwright, Python 3, Docker
(só p/ validar SQL). Porta dev: **3777**.

---

## 7. Estado atual validado (o que esperar)

4 apps de domínios/versões diferentes, todos **0 erros JS / 0 overflow / 0 placeholders**:

| App | export | ev | Domínio | Render | Banco |
|---|---|---|---|---|---|
| **app-eventos** | `../apps/app-eventos/app-eventos.bubble` | 5 | eventos/ingressos | 26 págs; pixel-perfect login/checkout; checkout ponta a ponta | schema+backfill validados |
| **app-whatsapp** | `../apps/app-whatsapp/app-whatsapp.bubble` | 4 | automação WhatsApp | 30 págs | 14 tipos; **111 tabelas, backfill com dados reais**; PRD autoral |
| **app-fiscal** | `../apps/app-fiscal/app-fiscal.bubble` | 5 | fiscal/NF-e | 13 págs | 29 tabelas (sem token → render+schema); só 3 user_types (dados vêm via API connector) + 26 option sets SEFAZ |
| **app-crm** | `../apps/app-crm/app-crm.bubble` | 5 | CRM WhatsApp+IA | 5 págs (SPA via `?page=`); E2E Playwright: login→app, navegação sidebar, popups, onboarding persistente | 17 tipos + 16 option sets; **33 tabelas, schema 0 erros** (sem token → seed mínimo manual, ver §9) |

"Quase-vazias" esperadas (não são bug): páginas parametrizadas (`?param`/item) ou que redirecionam por exigir
login. Ex.: app-whatsapp → paretto/formulario/link/qrcode/chat; app-eventos → termos-politicas.

---

## 8. ⚠️ O export muda conforme a VERSÃO da plataforma (princípio central)

A plataforma evolui ao longo dos anos e o formato do export muda junto. **Dois exports de épocas diferentes
guardam as mesmas coisas de formas diferentes.** Nunca assuma convenção única — **sonde** (probe) e trate as
variantes. Medido neste repo:

| | criado | `element_version` | workflows reais | `wf_folder_list` |
|---|---|---|---|---|
| app-whatsapp | fev/2024 | **4** (responsivo legado) | `pages.<id>.workflows` (dict) = 590 | 0 |
| app-eventos | set/2024 | **5** (flexbox novo) | `pages.<id>.workflows` (dict) = 824 | 4 (só pastas) |

- **Workflows reais sempre no dict `workflows`** de cada page/reusable. `wf_folder_list` é só organização de
  pastas (0 em apps antigos). Extrair do `workflows` (cada item: `{type: gatilho, properties.element_id, actions{}}`).
- **`element_version`** (4 legado, 5 flexbox) define o engine de layout. O renderer lida com os dois; ao
  depurar layout, cheque qual o app usa.
- **Regra de ouro:** ao ler qualquer campo, prefira **derivar/probe** a hard-codar. App novo com convenção nova
  → trate sem quebrar a antiga e atualize `analysis/`.

Como sondar a versão e contagens de um app:
```python
import json
d = json.load(open('../caminho/app.bubble'))
def ev(n, depth=0):
    if depth>6: return None
    if isinstance(n,dict):
        if 'element_version' in n: return n['element_version']
        for v in n.values():
            r=ev(v,depth+1)
            if r is not None: return r
    elif isinstance(n,list):
        for v in n[:5]:
            r=ev(v,depth+1)
            if r is not None: return r
print('element_version', ev(d.get('pages',{})), '| pages', len(d.get('pages',{})),
      '| user_types', len(d.get('user_types',{})), '| option_sets', len(d.get('option_sets',{})))
```

---

## 9. Pegadinhas que generalizam (já corrigidas — NÃO regrida)

**Dados / banco:**
- Nome do tipo na Data API = `display.lower().replace(' ','')` (NÃO a chave interna do user_type). Expostos têm
  flag `exposed_api`. Mapa derivado em `_common.build_api_to_internal` (em colisão de display, prefere
  `exposed_api`/não-deletado). Valida no app-whatsapp: 14/14 tipos mapeados sozinhos.
- **URL-encodar** o nome do tipo no fetch (`urllib.parse.quote`): há `serviços`, `apicontapro(empresas)` que dão
  `UnicodeEncodeError` na URL crua.
- Tabelas gigantes (dezenas de milhares; ex. `contato` ~78k) travam o fetch sequencial → cap `NOCODE_MAX_ROWS`.
- Tipo `dateinterval` = número (ms) → `double precision`, NÃO jsonb. Coluna `jsonb` recebendo escalar →
  JSON-encodar (`::jsonb`) — robustez p/ tipos desconhecidos (ex.: `api.apiconnector2...`).
- `user` é reservado no Postgres → tabela vira `usuario` (a data layer traduz). Email do user fica em
  `authentication.email.email`. Campos sem coluna no schema → `_raw jsonb`.
- Sem FK real no schema (refs = `text`) → ordem de carga do backfill é irrelevante.
- Data API devolve campos por **display** (mapear p/ field_id via user_types) e options por **display**
  (normalizar p/ db_value no backfill).
- **Atributo de option set que é LISTA** vem no export como dict de chaves numéricas (`{"0": "cnPMr", ...}`)
  → `sql_literal` converte p/ `array[...]::text[]` (senão "malformed array literal" no Postgres).
- **App sem token e sem dados**: escreva um seed mínimo à mão em `src/engine/seed-data.json` (chaves = chaves
  internas dos user_types; campos = field_ids). O login mock cai no primeiro user do seed → inclua 1 user
  admin + a Thing "tenant" (ex.: empresa) referenciada, com os vínculos nos dois sentidos.

**Render / engine:**
- Elementos **nativos** fora de Input/Text/Button caem no fallback de plugin: já há `Video`, `SliderInput`, **`Table`**
  (ev5: filhos `TableMainAxis`=colunas com `axis_index`+`min_width_css`; `TableCrossAxis`=linhas, a com
  `cross_axis_repeat` itera o `data_source`; `TableCell.cell_main_axis_id` referencia o **campo `id`** do
  `TableMainAxis`). Renderizado como CSS grid em `TableEl`.
- Ícones nativos `icon: "bootstrap X"` = **Bootstrap Icons** (font `bi bi-X`; pacote `bootstrap-icons`
  importado no `layout.tsx`). Mapear set novo no `NocodeIcon` (`icons.tsx`).
- **`Alert` é oculto por default** (como Popup/GroupFocus) — só aparece via `AlertShowMessage`, que respeita
  `hold` (ms) e `change_message` (texto vai em `store.alertMessages`). Sem isso, todo Alert vira faixa "Texto" fixa.
- **Banco da sessão é singleton** (`getSessionDB` em `data.ts`): remount/navegação NÃO zera dados criados
  (cada `RuntimeStore` registra seu bump via `addOnChange`). Sem isso, `ChangeThing` "não persiste" porque o
  próximo mount recria o MockDB do seed (StrictMode cria 2 stores por mount; 6–8 por sessão é normal).
- **Navegação client-side**: `RuntimeProvider` bumpa o store quando `useSearchParams`/`usePathname` mudam
  (senão `GetParamFromUrl` avalia com URL defasada e seções de SPA `?page=` ficam trocadas). `ChangePage` é
  debounced (rajada → último vence, semântica no-code) e mudança de params na MESMA página usa
  `history.pushState` raso (App Router sincroniza; `PageLoaded` não re-dispara — igual à plataforma; `router.push`
  para a mesma rota é engolido pela transição pendente).
- **Atributos de option set são tipados** (`attributes.<a>.value`: `text|number|option.X|list.option.X|custom.X`):
  o engine resolve o valor cru pelo tipo declarado (`resolveOptionAttrValue`) em 3 entradas — acesso via
  OptionRef, custom state com `type` declarado e fallback string db_value (`OptionSets.resolveByAttr`). Sem isso,
  `Plano's Título` devolve null e listas de options viram strings cruas (`[object Object]` em textos).
- Plugins **invisíveis** novos (app-crm): IP finder `1676907361630x`, CountDown `1633100358403x`,
  CardValidator `1560368242016x`, RG Reverse Scroll `1577723723112x`.
- Diagnóstico nos testes Playwright: `window.__ncStore` (e `__ncStores[]`) expõem o estado do runtime.
- **`get_pw_strength` é escala 0–100** (plugin de password strength da plataforma) — apps comparam com limiares
  tipo `< 70 → botão disabled`. Escore 0–4 deixava QUALQUER senha "fraca" e o CADASTRAR morto p/ sempre.
  Sintoma típico: clique no botão não dispara workflow nenhum → cheque states com `button_disabled`.

**Fidelidade visual (rodada pixel-perfect do app-crm — tudo genérico):**
- **`color_tokens_user` tem DOIS formatos** (§8 vale p/ tokens!): antigo `{name: {variant: 'rgba(...)'}}` e
  novo (2025+) `{variant: {tokenId: {rgba, name, deleted}}}`. `buildTokensCss` detecta os dois. Sintoma do
  formato não suportado: **var() indefinida descarta a declaração inteira** → bordas/cores custom somem do
  app TODO (inputs sem caixa, cards sem borda) sem nenhum erro no console.
- **`GetElement(X).is_visible`** avalia a visibilidade EFETIVA (inclui states condicionais do alvo via
  `effectiveVisible`, com guard anti-ciclo) — padrão "grupo Login some quando grupo Cadastro visível".
- **Altura `100%` em filho direto da página** → `align-self: stretch` (a % não resolve contra pai sem height;
  stretch estica à altura real da página, que cresce com o conteúdo). Coluna lateral de login full-height.
- **Image: default do editor é "Rescale"** → `object-fit: contain` quando `stretch_or_rescale` ausente
  (cover cortava logos quadradas com `use_aspect_ratio`).
- **Button defaults do tema ev5**: `font_color: var(--color_primary_contrast_default)` (texto branco sobre
  primário) e **texto centralizado** (`justify-content: center` salvo `font_alignment` left/right).
- **RG com `rows: 1`** (sem `fixed_rows`) = "uma linha" → células fluem na HORIZONTAL (kanban do CRM).
  Conferido: RGs verticais têm `rows: None`, nunca 1.
- **Plugins-CONTAINER** (`draggableui-Dropzone`, `draggableui-DroppableGroup`): têm filhos + data_source —
  renderizar como Group comum (filhos + groupDataOf); `draggableui-DroppedOn` é listener invisível.
  Drag&drop em si é interação não-estática (limite conhecido).
- Plugins de mídia mapeados: **AudioPlayer** `1624266878789x` (ACy=URL → `<audio controls>`) e
  **VideoPlayer** `1603892204719x` (AAF=URL → `<video>`/embed YouTube).
- Placeholders podem se ESCONDER em células de RG vazias — só aparecem com dados no seed. Sempre teste
  com seed de demonstração populado (ver §2d).
- Plugins mapeados (IDs globais do marketplace): ver §3. Mapear 1× vale p/ todo app.
- `CustomElement.custom_id` referencia o **campo `id`** da definição (não a chave do dict).
- Largura fixa autoritativa = `min_width_css` (nunca `width`, que é geometria de editor).
- `border_color` sem `border_style` → editor assume `solid`. Defaults de tipo Text/Input/Button: `font_size:14`.
- Formatação condicional fica na chave **`states`** (não `conditions`). `PageLoaded` roda antes do paint (§3.1).
- Páginas: nome de rota em `pages[pid].name` (o `_index.page_name_to_id` vem incompleto).

**Operacional:**
- Trocar de app → **mate o dev server e suba de novo** (§1.1); senão o Next serve o anterior em cache. Confirme pelo `<title>`.
- Dev server numa sessão Claude: use **Bash `run_in_background:true`** (`nohup & disown` morre entre comandos).
- PII (token, `data/<slug>/raw`, `*.sqlite`, `backfill.sql`, `seed-data.json`) é **gitignored** — nunca commitar.

---

## 10. Troubleshooting rápido

| Sintoma | Causa provável | Fix |
|---|---|---|
| `<title>` mostra app errado | server velho em cache | ritual de restart (§1.1) |
| HTTP 000 / página em branco no screenshot | server ainda compilando | aguarde `until curl ... 200` antes de capturar |
| `placeholders > 0` | plugin/elemento sem handler | §3 (pegue `data-btype`, mapeie no `ElementNode.tsx`) |
| schema falha `is of type jsonb but expression is integer` | tipo desconhecido virou jsonb mas o valor é escalar | já tratado (dateinterval→numérico; `sql_literal` JSON-encoda jsonb) — se aparecer outro, estenda `SCALAR_MAP` |
| fetch trava num tipo enorme | tabela com dezenas de milhares | `NOCODE_MAX_ROWS` (default 5000) |
| `UnicodeEncodeError` no fetch | nome de tipo com acento/parêntese | já tratado (URL-encode) |
| backfill com 0 linhas numa tabela | mapa API→interno não casou | confira `display` do tipo vs nome em `_meta.json#get` |
| página "quase-vazia" | parametrizada ou redirect de login | esperado, não é bug |
| wizard mostra passos sobrepostos | passos avançam por clique do usuário | limite de render estático (§3.1) |

---

## 11. Próximos alvos (se pedirem "100%")

- Portar os **endpoints de backend workflow** p/ `src/app/api/wf/*` (ex.: app-whatsapp expõe 68 POST; nomes e
  parâmetros em `data/<slug>/raw/_meta.json` e no PRD §14).
- Completar as seções `[ELABORAR VIA LLM]` do PRD autoral (`tools/prd_prompt.md` + slices).
- Mais páginas pixel-perfect contra o site real.
- Wizards interativos: simular cliques de "Next" para validar passos além do inicial.
