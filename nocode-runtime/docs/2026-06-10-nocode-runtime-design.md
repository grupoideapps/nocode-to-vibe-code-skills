# no-code Runtime Renderer — Design

**Data:** 2026-06-10
**Objetivo:** Um projeto Next.js que lê um arquivo de export (o JSON que o editor da plataforma gera) e renderiza o app completo e funcional — páginas, layout responsivo, estilos, navegação, estados e workflows client-side — sem depender da plataforma.

**Alvo de validação:** `apps/app-eventos/app-eventos.bubble` (app https://app.exemplo.com/ — gestão de igrejas/eventos, 26 páginas, 6.321 elementos, 822 workflows).

## Decisão central: interpretador runtime, não gerador de código

Duas abordagens foram consideradas:

1. **Codegen (transpiler):** gerar arquivos `.tsx` por página/componente a partir do JSON.
   - Contra: 6.321 elementos → milhares de arquivos/linhas gerados; qualquer bug exige re-geração; expressões dinâmicas da plataforma não viram código legível; fidelidade depende de templates cobrirem todo caso.
2. **Interpretador runtime (escolhida):** um engine genérico em React que recebe a árvore de elementos do JSON e a renderiza dinamicamente — exatamente como o próprio runtime da plataforma faz.
   - Pró: o JSON é a fonte de verdade; cobertura cresce por *tipo de elemento/operador*, não por página; o mesmo engine renderiza qualquer export (o arquivo é parâmetro); bugs se corrigem em um lugar.
   - Contra: payload por página maior (até ~860KB na página `adm`) — aceitável.

O app usa o **novo engine responsivo da plataforma** (`new_responsive: true`): containers flexbox (`container_layout: column|row`, gaps, paddings, min/max width), o que mapeia 1:1 para CSS moderno. Isso torna a interpretação fiel viável.

## Arquitetura

```
nocode-runtime/
├── nocode.config.json            # caminho do export (default: ../apps/app-eventos/app-eventos.bubble)
├── analysis/                     # specs de engenharia reversa do formato (geradas por agentes)
├── src/
│   ├── app/
│   │   ├── layout.tsx            # injeta tokens CSS (--color_*, --font_*), Google Fonts, FA icons
│   │   ├── globals.css           # reset + classes base do engine
│   │   └── [[...slug]]/page.tsx  # rota catch-all: /<page_name> → render da página no-code
│   └── engine/
│       ├── types.ts              # tipos do modelo export normalizado
│       ├── loader.ts             # [server] lê+indexa o export (cache em módulo)
│       ├── payload.ts            # [server] monta payload por página: árvore + reusables usados
│       │                         #   + styles + tokens + option_sets + seeds
│       ├── css.ts                # properties+style → React CSSProperties (puro, isomórfico)
│       ├── expressions.ts        # avaliador da árvore de expressões (Message chains etc.)
│       ├── data.ts               # mock DB in-memory seedado de user_types + auth fake
│       ├── workflows.ts          # executor de ações (navegação, estados, show/hide, CRUD mock)
│       ├── runtime.tsx           # React context: custom states, visibilidade, inputs, usuário
│       └── elements/             # 1 componente React por tipo de elemento no-code + registry
└── docs/                         # este design + notas
```

### Fluxo de renderização

1. **Server (RSC):** `loader.ts` lê o export uma vez (cache), `payload.ts` extrai para a página pedida: árvore de elementos, definições de reusables referenciadas (transitivamente), styles, tokens, option sets, seeds do mock DB.
2. **Client:** `<NocodeApp payload>` monta o runtime context e renderiza recursivamente via `elements/registry.tsx`.
3. Cada elemento: calcula CSS base (style ref + properties) + avalia `states` condicionais (visibilidade, overrides responsivos/hover) + registra workflows como handlers.

### Avaliador de expressões

Árvores `{type, name, args, properties, next}` avaliadas esquerda→direita (pipeline). Suporte a: literais e `TextExpression` (concatenação de entries), operadores (`equals`, `and_`, `count`, `filtered`, `format_*`, …), getters de campo (`<field>_<type>`), custom states (`custom.<state>`), fontes (`Search`, `CurrentUser`, `GetElement`, `ElementParent`, `ThisElement`, `PageData`, `Breakpoint`, `GetParamFromUrl`, `OptionValue`, `CurrentCellsIndex`, `InjectedValue`…). Operador desconhecido → log + valor neutro (nunca quebra o render).

### Workflows

Eventos client-side (`ButtonClicked`, `InputChanged`, `PageLoaded`, `ConditionTrue`, `CustomEvent`) executam cadeias de ações em ordem. Suportadas de verdade: `ChangePage`, `OpenURL`, `Show/Hide/ToggleElement`, `SetCustomState`, `ResetGroup/Inputs`, `DisplayGroupData`, `ListShowNext/Previous`, `ScrollToElement`, `TerminateWorkflow`, `TriggerCustomEvent`, `PauseWFClient`, `AlertShowMessage`, CRUD (`NewThing/ChangeThing/DeleteThing/...`) sobre o mock DB, auth fake (`LogIn/LogOut/SignUp`). Ações server-only (`ScheduleAPIEvent`, `apiconnector2-*`, plugins) → stub com log visível no console.

### Dados

Sem acesso ao banco real da plataforma. `data.ts` cria um banco in-memory por `user_type`, seedado com registros realistas (pt-BR) para que `Search`/RepeatingGroups exibam conteúdo. Auth fake: `LogIn` aceita qualquer credencial e seta um usuário seed como `CurrentUser`.

### Fidelidade e testes

- Dev server na porta 3777; verificação via Chrome DevTools MCP (screenshots + console).
- Ground truth: HTML/fontes/cores do site real https://app.exemplo.com/ (página de login pública).
- Critério de pronto: todas as 26 páginas renderizam sem erro fatal; login (index) visualmente fiel ao site real; navegação entre páginas, popups, tabs por custom state e RGs com dados mock funcionando.

## Fora de escopo (explícito)

- Backend real (Supabase/REST), pagamentos, e-mails, API workflows da plataforma.
- Pixel-perfection absoluta de plugins de terceiros (render por aproximação ou placeholder rotulado).

## Riscos e mitigação

- **Operadores/elementos não mapeados:** fallback que nunca quebra (placeholder + console.warn) + iteração guiada por logs.
- **Payload grande (`adm` 861KB):** aceitável em dev; se necessário, comprimir removendo chaves de editor (`lock_in_editor`, comentários).
- **Expressões cross-página (`GetElement` para elemento de outra página):** resolver via `_index.id_to_path`; se elemento não está na página atual, retornar vazio.
