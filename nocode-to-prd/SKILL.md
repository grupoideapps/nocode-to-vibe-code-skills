---
name: nocode-to-prd
description: Converte um arquivo `.bubble` (o export JSON do app) em um PRD reverso completo de 17 seções, pronto para reconstruir o app em outra stack. Use quando o usuário tiver um arquivo de export e quiser uma especificação textual exaustiva (páginas, dados, enums, endpoints, fluxos, regras). Ativa com frases como "gerar PRD a partir da plataforma", "documentar app no-code", "engenharia reversa de no-code", "extrair spec do export".
---

# Skill: nocode-to-prd

## Quando usar
- Usuário possui um arquivo `.bubble` (JSON gerado pelo editor).
- Usuário quer um documento que descreva 100% do app sem depender da plataforma.
- Etapa anterior a uma migração para Next.js / PHP / outra stack.

## Como usar (algoritmo determinístico)

### Passo 1 — Slice
```bash
cd nocode-to-prd
python3 extract.py <caminho/para/app.bubble> --out slices
```
Gera `slices/00_meta.json` ... `slices/10_mobile_views.json` + `INDEX.md`.

### Passo 2 — Gerar PRD
Carregue `PROMPT.md` como instrução do sistema e os 11 slices como contexto. O LLM produz um único `PRD-<App>.md` seguindo as 17 seções.

Como executar dentro do Claude Code:
1. `Read` em `PROMPT.md` (regras e estrutura).
2. `Read` em cada slice em ordem: meta → tokens → mobile → user_types → option_sets → api_connector → reusables → workflows_index → pages → styles → issues.
3. Escreva o PRD seção por seção, validando contra a checklist no final do `PROMPT.md`.
4. `Write` em `PRD-<App>.md`.

### Passo 3 — Validar
```bash
python3 validate.py slices/ PRD-<App>.md
```
(Opcional — script de checagem: conta endpoints, enums, pages e compara com o PRD.)

## Por que funciona

O export cru tem ~1.8MB e estrutura recursiva profunda — não cabe eficientemente no contexto. O slicer Python:
- **Reduz 4–5×** mantendo a semântica.
- **Separa por seção do PRD** — cada chamada de LLM lê só o slice relevante.
- **Achata workflows** — `wf_folder_list` é varrido recursivamente e indexado.
- **Normaliza endpoints** — `apiconnector2` de `client_safe` + `secure` num único array.

O `PROMPT.md` ancora o LLM em 17 seções fixas com fontes obrigatórias, evitando alucinação e omissão.

## Limites conhecidos
- Workflows da plataforma (eventos e ações) só são recuperados pelo **nome**. Lógica detalhada precisa de leitura manual de `pages.<id>.elements.<id>.workflows` no JSON original quando a seção exige detalhe.
- Privacy rules da plataforma não estão expostas no export — inferir das chamadas REST e marcar como inferência.
- Plugins customizados aparecem em `settings.client_safe.plugins` mas só com IDs — listar como "plugin externo" sem expandir.

## Próxima etapa (depois do PRD)
O PRD é o input da skill **`nocode-to-code`** (a criar) que gera código Next.js ou PHP a partir do mesmo conjunto de slices + o PRD validado.
