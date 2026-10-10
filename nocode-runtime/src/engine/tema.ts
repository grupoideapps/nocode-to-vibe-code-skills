// Indireção de valores visuais para tokens CSS trocáveis por tema.
//
// NENHUMA função aqui sabe qual tema está ativo. Elas só produzem `var(--token, <valor original>)`.
// Quem decide é o bloco `:root[data-tema=…]` emitido em `layout.tsx`.
//
// Isomórfico de propósito: o walk de cor estática roda no servidor (loader.ts), mas raio, sombra,
// fonte e a cor DINÂMICA são tokenizados no cliente (css.ts, ElementNode.tsx). Por isso o hash é
// JS puro e não `node:crypto`.

export const EH_COR = /^\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))\s*$/;

/** Forma canônica `rgba(r,g,b,a)`. `#00BF63` ≡ `#00bf63` ≡ `rgb(0,191,99)`. null se não for cor. */
export function normalizarCor(valor: string): string | null {
  if (typeof valor !== 'string') return null;
  const v = valor.trim();
  if (!EH_COR.test(v)) return null;

  const m3 = /^#([0-9a-fA-F]{3})$/.exec(v);
  const hex = m3 ? '#' + [...m3[1]].map((c) => c + c).join('') : v;

  const mf = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(hex);
  if (mf) {
    const [r, g, b] = [1, 2, 3].map((i) => Math.round(Number(mf[i])));
    // Arredonda a 3 casas decimais para: (1) sincronizar com o ramo hex8; (2) manter bytes de alfa
    // adjacentes (127≠128) distintos; (3) garantir que cores computadas dinamicamente (expressões
    // da plataforma) mantenham tokens estáveis quando trocam de tema.
    const a = mf[4] === undefined ? 1 : Math.round(Number(mf[4]) * 1000) / 1000;
    return `rgba(${r},${g},${b},${a})`;
  }
  const m6 = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (m6) {
    const n = parseInt(m6[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},1)`;
  }
  const m8 = /^#([0-9a-fA-F]{8})$/.exec(hex);
  if (m8) {
    const n = parseInt(m8[1], 16);
    // 3 casas decimais para manter bytes de alfa adjacentes distintos (127≠128) e sincronizar com
    // cores em formato rgba() — matches Chrome's #RRGGBBAA serialization
    const a = Math.round(((n & 255) / 255) * 1000) / 1000;
    return `rgba(${(n >>> 24) & 255},${(n >> 16) & 255},${(n >> 8) & 255},${a})`;
  }
  return null;
}

/** FNV-1a de 32 bits em base36, 8 chars. Determinístico e isomórfico — não usa node:crypto. */
export function hashToken(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(8, '0').slice(-8);
}

/** valor normalizado → nome do custom property já declarado pelo app. */
export type MapaTokens = Record<string, string>;

/** Lê `settings.client_safe` e indexa os color tokens do app PELO VALOR. */
export function construirMapaTokens(clientSafe: Record<string, unknown>): MapaTokens {
  const mapa: MapaTokens = {};
  const registra = (nome: string, bruto: unknown) => {
    if (typeof bruto !== 'string') return;
    const n = normalizarCor(bruto);
    // primeiro a registrar vence: mantém o resultado estável quando dois tokens têm o mesmo valor
    if (n && !mapa[n]) mapa[n] = nome;
  };

  const builtin = clientSafe.color_tokens as Record<string, Record<string, unknown>> | undefined;
  for (const [grupo, variantes] of Object.entries(builtin ?? {})) {
    for (const [variante, valor] of Object.entries(variantes ?? {})) {
      registra(`--color_${grupo}_${variante}`, valor);
    }
  }

  const user = clientSafe.color_tokens_user as
    | Record<string, Record<string, { rgba?: string; deleted?: boolean }>>
    | undefined;
  for (const [variante, defs] of Object.entries(user ?? {})) {
    for (const [tid, def] of Object.entries(defs ?? {})) {
      if (!def || typeof def !== 'object' || def.deleted) continue;
      registra(`--color_${tid}_${variante}`, def.rgba);
    }
  }
  return mapa;
}

/** `#00BF63` → `var(--color_bTHgk_default, #00BF63)`. Não-cor volta intacta. */
export function corToken(original: string, mapa: MapaTokens): string {
  const n = normalizarCor(original);
  if (!n) return original;
  const nome = mapa[n] ?? `--c_${hashToken(n)}`;
  // o fallback carrega o valor ORIGINAL, não o normalizado: computam igual e reescrever seria
  // mais uma chance de errar sem ganho nenhum.
  return `var(${nome}, ${original})`;
}

/** `12` → `var(--r_12, 12px)`. */
export function raioToken(n: number): string {
  const id = String(n).replace('.', '_').replace('-', 'n');
  return `var(--r_${id}, ${n}px)`;
}

/** UM token para todas as sombras — `tema-original` não o define e cada elemento fica com a sua
 *  pelo fallback; `tema-cliente` define uma linha e as 39 viram a `--shadow-card` do DS.
 *
 *  Não é `--sh_<hash da string>` de propósito: o `css.ts` monta a sombra a partir das props JÁ
 *  MESCLADAS (style + elemento + conditional states), então a string final não existe em lugar
 *  nenhum do export e nenhum pré-gerador poderia enumerá-la. Um style com `blur:16` que o
 *  elemento sobrescreve para `8` produz em runtime uma terceira string — e a falha seria silenciosa.
 *  O DESIGN.md §4 pede uma sombra só, então granularidade aqui não vale o furo. */
export function sombraToken(sombra: string): string {
  return `var(--sh_override, ${sombra})`;
}

/** `Open Sans` → `var(--ff_open_sans, 'Open Sans')`. */
export function fonteToken(familia: string): string {
  const slug = familia.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `var(--ff_${slug}, '${familia}')`;
}

// Chaves cujo valor-cor deve ser tokenizado pelo walk do loader. Derivado da medição de 06/08:
// tudo que contém "color" (bgcolor, font_color, icon_color, border_color_bottom, tag_font_color…)
// mais as que não contêm e apareceram com cor no export.
const CHAVES_COR_EXTRA = new Set([
  'background_gradient_from', 'background_gradient_to', 'border', 'default', 'color2',
]);

/** `AAf`, `AAJ`, `AAa`… são props opacas de plugin da plataforma e carregam cor. */
const CHAVE_PLUGIN = /^AA[A-Za-z]$/;

export function chaveDeCor(k: string): boolean {
  return /color/i.test(k) || CHAVES_COR_EXTRA.has(k) || CHAVE_PLUGIN.test(k);
}
