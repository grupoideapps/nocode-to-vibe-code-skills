# Camada de temas (troca de template de design)

Todo valor visual do render sai como `var(--token, <valor original do export>)`. Enquanto
nenhum tema redefinir um token, o app renderiza exatamente como a plataforma renderizava — essa é
a propriedade que sustenta a paridade.

- **`tema-original`** não é arquivo: é emitido **em runtime** por
  `buildTemaOriginal()` (`loader.ts`), a partir da MESMA coleta do walk que tokenizou o
  export do app. Token e fallback saem da mesma variável — divergir é impossível.
- **Este diretório é o único ponto por-cliente.** O tema alternativo de cada app (aqui o stub
  `tema-cliente.ts`) é autorado à mão a partir do inventário (`tools/inventario_tema.py` →
  `docs/tema-inventario.html`), que emite os MESMOS ids de token do walk (FNV-1a base36).
- O tema ativo vem da env `TEMA_PADRAO` → `<html data-tema="...">` (`layout.tsx`). Os dois
  blocos `:root[data-tema]` vão sempre na página; quem decide é o atributo.
- Portões de QA que acompanham a camada: `test-tema-identidade.mjs` (nada quebrou — CSS
  computado idêntico à baseline), `test-tema-cobertura.mjs` (a camada existe — nada cru no
  style inline; os dois são complementares e um NÃO substitui o outro), `test-tema-cor-crua.mjs`
  e `test-tema-contraste.mjs` (AA por par real).

Origem: projeto app-marketplace, spec 004 (troca de template), 08/2026. Lições de medição no ledger
daquele projeto (`.superpowers/sdd/plan/progress.md`).
