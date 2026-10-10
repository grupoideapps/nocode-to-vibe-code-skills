# nocode-to-prd

Converte um arquivo `.bubble` (o export JSON do app) em um PRD reverso completo, pronto para reconstrução em outra stack.

## Pipeline

```
app.bubble  ──extract.py──►  slices/*.json  ──Claude+PROMPT.md──►  PRD-App.md  ──validate.py──►  ✓
   1.8 MB                       ~410 KB                                ~35 KB
```

## Como rodar

```bash
# 1. Fatiar
python3 extract.py /caminho/app.bubble --out slices

# 2. No Claude Code, abra o projeto e invoque:
#    "use a skill nocode-to-prd para gerar o PRD a partir de slices/"
#    O Claude lê PROMPT.md + slices/*.json e escreve PRD-App.md.

# 3. Validar cobertura
python3 validate.py slices/ PRD-App.md
```

## Arquivos

| Arquivo | Papel |
|---|---|
| `extract.py` | Fatiador Python — 1 input export → 11 slices semânticos |
| `PROMPT.md` | Prompt mestre — 17 seções, fontes, regras, checklist de validação |
| `SKILL.md` | Definição da skill para o Claude Code |
| `validate.py` | Confere cobertura do PRD contra os slices |
| `slices/` | Saída do extractor (gerada) |

## Decisões de design

1. **LLM nunca lê o export cru.** Profundidade recursiva + 1.8MB quebra contexto.
2. **17 seções fixas, fonte primária explícita.** Evita alucinação e omissão.
3. **Slicer é determinístico, prompt é semântico.** Bug no slicer é reproduzível; bug no LLM é mitigado pela checklist.
4. **Enums e endpoints são transcrição literal.** Códigos SEFAZ são exigidos pela Receita — zero criatividade.
5. **Inferência só para o que a plataforma esconde** (schema do banco, privacy rules) — sempre cruzando ≥ 2 fontes.

## Próximo passo

Do PRD para o código: `skills/nocode-component/` (um componente por vez) ou o `nocode-runtime/` na pasta ao lado (o app inteiro renderizado em Next.js).
