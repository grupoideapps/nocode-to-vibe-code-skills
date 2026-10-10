# nocode-to-vibe-code-skills

O que eu uso para tirar apps de uma plataforma no-code e levar para código próprio, com Claude Code.

Não converte de forma instantânea. É um ponto de partida que já me poupou muito trabalho em apps reais: você sai do arquivo `.bubble` do app com um PRD completo, um app Next.js navegável e o banco recriado no Supabase, e termina o resto na mão.

Por [Luan Bonadie](https://grupoidecomunicacao.com/luanbonadie).

## O que tem aqui

| Pasta | Entrada → saída | Como funciona |
|---|---|---|
| [`nocode-to-prd/`](nocode-to-prd/) | `.bubble` → PRD reverso de 17 seções | Um script Python fatia o arquivo em 11 partes menores; o Claude escreve o PRD seguindo um prompt mestre; outro script confere a cobertura. |
| [`nocode-runtime/tools/gen_prd.py`](nocode-runtime/tools/gen_prd.py) | `.bubble` → PRD determinístico | Sem LLM: páginas, modelo de dados, option sets, workflows e endpoints saem direto do arquivo. As seções de narrativa ficam marcadas para completar depois. |
| [`nocode-runtime/`](nocode-runtime/) | `.bubble` → app Next.js + `schema.sql` + `backfill.sql` | Um interpretador lê o JSON do arquivo e renderiza as páginas, os estilos, as expressões e os workflows. Os geradores recriam o banco no Supabase/Postgres com os dados reais. |
| [`nocode-to-prd/skills/nocode-component/`](nocode-to-prd/skills/nocode-component/) | reusable → componente React | Para converter um componente por vez: gera um pacote (árvore, estados, workflows e briefing) e o Claude escreve o componente. |
| [`skills/`](skills/) | skill do Claude Code | `nocode-to-app` opera o `nocode-runtime` de ponta a ponta. |

## Por onde começar

Exporte o arquivo `.bubble` do seu app pelo editor da plataforma.

**Só quero o PRD**

```bash
cd nocode-to-prd
python3 extract.py /caminho/meu-app.bubble --out slices
# no Claude Code: "use a skill nocode-to-prd para gerar o PRD a partir de slices/"
python3 validate.py slices/ PRD-MeuApp.md
```

**Quero o app rodando fora da plataforma**

```bash
cd nocode-runtime
npm install
bash tools/pipeline.sh ../meu-app.bubble # grava o nocode.config.json e gera app, banco e PRD
npm run dev                               # http://localhost:3777
```

O passo a passo completo, com as armadilhas que já encontrei, está em [`nocode-runtime/COMECE-AQUI.md`](nocode-runtime/COMECE-AQUI.md).

**Instalar as skills no Claude Code**

```bash
cp -r skills/nocode-to-app ~/.claude/skills/
cp -r nocode-to-prd ~/.claude/skills/nocode-to-prd
```

## O que ainda fica por sua conta

- **Backend workflows**: não são convertidos. Cada um é portado à mão para um route handler.
- **Plugins visuais** (gráficos, QR code, cropper): viram placeholder até você mapear.
- **Privacy rules**: o runtime ignora; a segurança de verdade você define no RLS do Supabase.
- **Versão da plataforma**: o formato do export muda com o tempo. Se algo quebrar num app mais novo ou mais antigo, a seção 8 do `COMECE-AQUI.md` explica onde olhar.

## Cuidado com dados

O arquivo `.bubble`, o token da Data API, o SQLite e o `backfill.sql` carregam dados reais dos seus usuários. Os `.gitignore` deste repositório já deixam tudo isso de fora; não force a inclusão.

Os exemplos nos documentos citam apps com nomes trocados (`app-eventos`, `app-whatsapp`, `app-fiscal`, `app-crm`). Nenhum dado, tela ou regra de negócio de cliente está aqui.

## Requisitos

Python 3, Node 20 ou mais recente e Claude Code. Docker é opcional, só para validar o SQL num Postgres descartável.

## Licença

[MIT](LICENSE). Use, adapte e distribua à vontade, mantendo o aviso de copyright.

Este projeto é independente e não tem vínculo com nenhuma plataforma no-code.
