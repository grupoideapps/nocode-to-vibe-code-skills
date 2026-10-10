// [server-only] Carrega e indexa o arquivo de export. Cache em escopo de módulo.
import fs from 'node:fs';
import path from 'node:path';
import type { NocodeApp, NocodePage } from './types';
import { corToken, chaveDeCor, construirMapaTokens, raioToken, fonteToken, type MapaTokens } from './tema';
import { temaCliente } from './temas/tema-cliente';

export const TEMAS = ['tema-original', 'tema-cliente'] as const;
export type Tema = (typeof TEMAS)[number];

interface ColetaTema {
  /** nome do custom property -> valor original, para os tokens de cor gerados (`--c_*`) */
  cores: Map<string, string>;
  /** valores distintos de border_roundness */
  raios: Set<number>;
  /** famílias de fonte declaradas cruas */
  fontes: Set<string>;
  /** nº de substituições, para conferir contra o inventário */
  substituicoes: number;
}

interface LoadedApp {
  app: NocodeApp;
  appName: string;
  /** page name (slug) -> pageId */
  pagesByName: Record<string, string>;
  filePath: string;
  mapaTokens: MapaTokens;
  coleta: ColetaTema;
}

let cache: LoadedApp | null = null;

function resolveExportPath(): { file: string; appName: string } {
  const root = process.cwd();
  const cfgPath = path.join(root, 'nocode.config.json');
  let file = process.env.NOCODE_FILE || '';
  let appName = 'App';
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (!file && cfg.exportFile) file = cfg.exportFile;
    if (cfg.appName) appName = cfg.appName;
  }
  if (!file) throw new Error('Defina NOCODE_FILE ou nocode.config.json#exportFile');
  if (!path.isAbsolute(file)) file = path.resolve(root, file);
  return { file, appName };
}

/** Reescreve IN-PLACE toda string de cor em `var(--token, <original>)` E coleta o que viu.
 *
 *  Coletar aqui, e não num gerador à parte, é o que torna impossível o tema `tema-original`
 *  divergir do fallback: os dois saem da mesma variável, na mesma passada.
 *
 *  Só as quatro chaves que o engine de fato renderiza — medido em 06/08/2026: `mobile_views`
 *  sozinha tem 1.001 referências de cor e NENHUM arquivo de `src/` lê essa chave; `settings`
 *  guarda os valores dos próprios color tokens e tokenizá-la seria circular. */
function tokenizarCores(app: NocodeApp, mapa: MapaTokens): ColetaTema {
  const coleta: ColetaTema = { cores: new Map(), raios: new Set(), fontes: new Set(), substituicoes: 0 };

  const visitar = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const x of node) visitar(x);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;

    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number' && !Number.isNaN(v) && /^border_roundness(_(top|right|bottom|left))?$/.test(k)) {
        coleta.raios.add(v);
        continue;
      }
      if (typeof v === 'string') {
        if ((k === 'font_face' || k === 'font_family') && !v.startsWith('var(')) {
          const fam = v.split(':::')[0].trim();
          if (fam) coleta.fontes.add(fam);
          continue;
        }
        if (!chaveDeCor(k)) continue;
        const t = corToken(v, mapa);
        if (t === v) continue;
        obj[k] = t;
        coleta.substituicoes++;
        // `var(--nome, original)` -> guarda o par para o tema fiel
        const m = /^var\((--[A-Za-z0-9_]+), (.*)\)$/.exec(t);
        if (m && m[1].startsWith('--c_')) coleta.cores.set(m[1], m[2]);
      } else {
        visitar(v);
      }
    }
  };

  visitar(app.pages);
  visitar(app.element_definitions);
  visitar(app.styles);
  visitar(app.option_sets);
  return coleta;
}

export function loadApp(): LoadedApp {
  if (cache) return cache;
  const { file, appName } = resolveExportPath();
  const raw = fs.readFileSync(file, 'utf8');
  const app = JSON.parse(raw) as NocodeApp;

  const pagesByName: Record<string, string> = {};
  for (const [pid, page] of Object.entries(app.pages || {})) {
    const name = pageName(page, pid);
    pagesByName[name] = pid;
  }

  const mapaTokens = construirMapaTokens(app.settings?.client_safe ?? {});
  const coleta = tokenizarCores(app, mapaTokens);
  console.log(
    `[tema] ${coleta.substituicoes} cores tokenizadas · ${coleta.cores.size} tokens gerados · ` +
    `${coleta.raios.size} raios · ${coleta.fontes.size} fontes`,
  );

  cache = { app, appName, pagesByName, filePath: file, mapaTokens, coleta };
  return cache;
}

export function pageName(page: NocodePage, pid: string): string {
  return (page.name as string) || (page.properties?.page_name as string) || pid;
}

/** CSS custom properties a partir dos tokens do app (cores + fontes). */
export function buildTokensCss(app: NocodeApp): string {
  const cs = app.settings?.client_safe || {};
  const lines: string[] = [];
  const emitColor = (name: string, variants: Record<string, string>) => {
    for (const [variant, value] of Object.entries(variants || {})) {
      if (typeof value !== 'string') continue;
      lines.push(`--color_${name}_${variant}: ${value};`);
      const rgb = rgbaToRgbTriple(value);
      if (rgb) lines.push(`--color_${name}_${variant}_rgb: ${rgb};`);
    }
  };
  for (const key of ['color_tokens', 'color_tokens_user'] as const) {
    const tokens = cs[key] as Record<string, Record<string, unknown>> | undefined;
    if (!tokens) continue;
    for (const [a, b] of Object.entries(tokens)) {
      if (!b || typeof b !== 'object') continue;
      const vals = Object.values(b);
      // formato novo (2025+): {variant: {tokenId: {rgba, name, deleted}}}; antigo: {name: {variant: 'rgba(...)'}}
      const isNewFormat = vals.length > 0 && vals.every((v) => v != null && typeof v === 'object');
      if (isNewFormat) {
        for (const [tokenId, def] of Object.entries(b as Record<string, { rgba?: string }>)) {
          if (typeof def?.rgba === 'string') emitColor(tokenId, { [a]: def.rgba });
        }
      } else {
        emitColor(a, b as Record<string, string>);
      }
    }
  }
  const fontTokens = (cs.font_tokens as Record<string, string>) || {};
  for (const [name, family] of Object.entries(fontTokens)) {
    lines.push(`--font_${name}: '${family}', sans-serif;`);
  }
  // tokens órfãos (referenciados mas deletados do app) — fallback da escala Grey
  const emitted = lines.join('\n');
  if (!emitted.includes('--color_cmOyD_')) {
    lines.push('--color_cmOyD_default: rgba(208,213,221,1);', '--color_cmOyD_default_rgb: 208, 213, 221;');
  }
  if (!emitted.includes('--color_cmOyH_')) {
    lines.push('--color_cmOyH_default: rgba(52,64,84,1);', '--color_cmOyH_default_rgb: 52, 64, 84;');
  }
  return `:root {\n  ${lines.join('\n  ')}\n}`;
}

function rgbaToRgbTriple(value: string): string | null {
  const m = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return `${m[1]}, ${m[2]}, ${m[3]}`;
  const hex = value.match(/^#([0-9a-f]{6})/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
  }
  return null;
}

/** Chrome do runtime — cor que NÃO vem do export, cravada no caminho de render (Task 5).
 *  O valor aqui é o mesmo do fallback de cada `var()`; existe para o tema DS poder trocá-lo. */
const UI_PADRAO: [string, string][] = [
  ['--ui_surface', 'rgba(255,255,255,1)'],
  ['--ui_on_primary', '#fff'],
  ['--ui_overlay', 'rgba(0,0,0,0.6)'],
  ['--ui_separador', 'rgba(0,0,0,.1)'],
  ['--ui_divisor', 'rgba(0,0,0,.06)'],
  ['--ui_divisor_forte', 'rgba(0,0,0,.12)'],
  ['--ui_shadow_cor', 'rgba(0,0,0,0.2)'],
  ['--ui_shadow_popup', '0 8px 24px rgba(0,0,0,.18)'],
  ['--ui_shadow_toast', '0 4px 16px rgba(0,0,0,.15)'],
];

/** O design system fiel à plataforma, emitido da MESMA coleta que produziu os fallbacks.
 *
 *  Autocontido de propósito: repete os `--color_*` do `:root` base para que o bloco possa ser
 *  extraído sozinho (`npm run tema:dump`), auditado e diffado contra o `tema-cliente` token a token. Os valores são os mesmos, então a
 *  repetição não cria risco.
 *
 *  `--sh_override` NÃO é emitido: sem ele, cada elemento fica com a sombra do próprio fallback,
 *  que é o comportamento fiel. */
export function buildTemaOriginal(): string {
  const { app, coleta } = loadApp();
  const L: string[] = [':root[data-tema="tema-original"] {'];

  L.push('  /* tokens declarados no app */');
  // reaproveita a emissão do :root base, tirando o seletor e a indentação
  const base = buildTokensCss(app).replace(/^:root \{\n/, '').replace(/\n\}$/, '');
  L.push(base);

  L.push('', '  /* cores sem token no app */');
  for (const [nome, valor] of [...coleta.cores].sort()) L.push(`  ${nome}: ${valor};`);

  L.push('', '  /* raio */');
  for (const n of [...coleta.raios].sort((a, b) => a - b)) {
    // raioToken devolve `var(--r_12, 12px)`; aqui interessa só o nome
    const nome = /^var\((--[A-Za-z0-9_]+),/.exec(raioToken(n))![1];
    L.push(`  ${nome}: ${n}px;`);
  }

  L.push('', '  /* fonte */');
  for (const f of [...coleta.fontes].sort()) {
    const nome = /^var\((--[A-Za-z0-9_]+),/.exec(fonteToken(f))![1];
    L.push(`  ${nome}: '${f}';`);
  }

  L.push('', '  /* chrome do runtime */');
  for (const [nome, valor] of UI_PADRAO) L.push(`  ${nome}: ${valor};`);

  L.push('}');
  return L.join('\n');
}

/** Os dois blocos vão SEMPRE na página; quem decide é o `data-tema` do <html>.
 *  Custa ~120 linhas de CSS e paga em alternar no devtools durante uma call com o cliente, testar
 *  os dois na mesma sessão de browser, e ter a troca dinâmica de pé para o Nível 3. */
export function buildTemasCss(): string {
  return `${buildTemaOriginal()}\n${temaCliente}`;
}

/** Inventário de famílias de fonte usadas no app (styles + elementos), para o <link> do Google Fonts. */
export function collectFontFamilies(app: NocodeApp): string[] {
  const families = new Set<string>();
  const fontTokens = (app.settings?.client_safe?.font_tokens as Record<string, string>) || {};
  for (const fam of Object.values(fontTokens)) families.add(fam);

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    for (const key of ['font_face', 'font_family']) {
      const v = obj[key];
      if (typeof v === 'string' && v && !v.startsWith('var(')) {
        const fam = v.split(':::')[0].trim();
        if (fam && !fam.startsWith('var(')) families.add(fam);
      }
    }
    for (const v of Object.values(obj)) visit(v);
  };
  visit(app.styles);
  for (const page of Object.values(app.pages || {})) visit(page);
  for (const def of Object.values(app.element_definitions || {})) visit(def);
  families.delete('length' as never);
  return [...families].filter((f) => f && f.toLowerCase() !== 'inherit');
}
