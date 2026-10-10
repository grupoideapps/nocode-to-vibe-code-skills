// Conversão de properties da plataforma (engine responsivo v5) → React CSSProperties.
// Regras derivadas de analysis/01_layout_responsivo.md e analysis/04_estilos_tokens.md.
import type { CSSProperties } from 'react';
import { raioToken, sombraToken, fonteToken } from './tema';

export type Primitive = string | number | boolean | null | undefined;
export type Props = Record<string, Primitive>;

export type ParentLayout = 'row' | 'column' | 'relative' | 'fixed' | 'page' | 'overlay';

const px = (v: Primitive): string | undefined =>
  typeof v === 'number' ? `${v}px` : typeof v === 'string' && v ? v : undefined;

/** font_face: '<Família>:::<variant>' — variant: 'regular' | '' | peso numérico | 'italic'. */
export function parseFontFace(face: string | undefined): { family?: string; weight?: string; italic?: boolean } {
  if (!face || typeof face !== 'string') return {};
  const [family, variant = ''] = face.split(':::');
  const italic = /italic/.test(variant);
  const num = variant.match(/\d+/)?.[0];
  return {
    family: family || undefined,
    weight: num || (variant === 'regular' || variant === '' ? '400' : undefined),
    italic,
  };
}

export function fontCss(p: Props): CSSProperties {
  const css: CSSProperties = {};
  const face = parseFontFace(p.font_face as string | undefined);
  const family = (p.font_family as string) || face.family;
  if (family) {
    css.fontFamily = family.startsWith('var(')
      ? family
      : `${fonteToken(family)}, var(--font_default), sans-serif`;
  }
  const weight = (p.font_weight as string) || face.weight || (p.bold === true ? '700' : undefined);
  if (weight) css.fontWeight = weight;
  if (face.italic || p.italic === true) css.fontStyle = 'italic';
  if (p.underline === true) css.textDecoration = 'underline';
  if (typeof p.font_size === 'number') css.fontSize = p.font_size;
  if (typeof p.line_height === 'number') css.lineHeight = p.line_height;
  if (typeof p.letter_spacing === 'number') css.letterSpacing = `${p.letter_spacing}px`;
  if (typeof p.font_color === 'string') css.color = p.font_color;
  if (typeof p.font_alignment === 'string') css.textAlign = p.font_alignment as CSSProperties['textAlign'];
  return css;
}

function backgroundCss(p: Props, css: CSSProperties) {
  // background_style ausente + bgcolor presente → tratar como bgcolor
  const style = (p.background_style as string) ?? (p.bgcolor ? 'bgcolor' : undefined);
  // `background_style: 'none'` na plataforma significa "sem COR de fundo" — NÃO "sem imagem".
  // Se `background_image` tem valor, ela aparece assim mesmo. Verificado contra o app em
  // produção: os três carrosséis de anunciante (Banner, BannerMercado, BannerPlano)
  // declaram 'none' e exibem a imagem. Sem isto o banner renderiza como um bloco vazio —
  // e ele é receita da plataforma, requisito explícito do cliente.
  const imgDireta = typeof p.background_image === 'string' && p.background_image ? p.background_image : undefined;
  if (style !== 'image' && imgDireta) {
    applyBackgroundImage(p, css, imgDireta);
    return;
  }
  if (style === 'none') return;
  if (style === 'bgcolor' || (!style && p.bgcolor)) {
    // default do editor da plataforma quando bgcolor não foi customizado: branco
    css.backgroundColor = typeof p.bgcolor === 'string' ? p.bgcolor : 'var(--ui_surface, rgba(255,255,255,1))';
  } else if (style === 'gradient') {
    const dir = p.background_gradient_direction === 'left' ? 'to left' : 'to bottom';
    css.background = `linear-gradient(${dir}, ${p.background_gradient_from ?? 'transparent'}, ${p.background_gradient_to ?? 'transparent'})`;
  } else if (style === 'image') {
    const img = p.background_image as string | undefined; // já avaliado para string
    if (img) {
      applyBackgroundImage(p, css, img);
    } else if (typeof (p.background_color_if_empty_image ?? p.bgcolor) === 'string') {
      css.backgroundColor = (p.background_color_if_empty_image ?? p.bgcolor) as string;
    }
  }
}

function applyBackgroundImage(p: Props, css: CSSProperties, img: string) {
  css.backgroundImage = `url("${normalizeAssetUrl(img)}")`;
  // Ausente também é `cover` — é o default da plataforma, não `contain`. Medido nos cards de
  // "Destaques para você" em /marketplace: a caixa bate (260x140 nos dois), mas com `contain`
  // a foto encolhia para uma faixa central e deixava o card vazio dos lados. 36 das 53
  // imagens de fundo do app não declaram a propriedade.
  css.backgroundSize = p.background_size_cover === false ? 'contain' : 'cover';
  css.backgroundPosition = p.center_background !== false ? 'center' : undefined;
  css.backgroundRepeat = 'no-repeat';
  if (typeof p.bgcolor === 'string') css.backgroundColor = p.bgcolor;
}

export function normalizeAssetUrl(url: string): string {
  if (url.startsWith('//')) return 'https:' + url;
  return url;
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const;
// border_roundness_* são CANTOS em sentido horário: top=TL, right=TR, bottom=BR, left=BL
const CORNER_MAP: Record<string, keyof CSSProperties> = {
  top: 'borderTopLeftRadius',
  right: 'borderTopRightRadius',
  bottom: 'borderBottomRightRadius',
  left: 'borderBottomLeftRadius',
};

function borderCss(p: Props, css: CSSProperties) {
  if (p.four_border_style === true) {
    for (const side of SIDES) {
      const st = p[`border_style_${side}`] as string | undefined;
      if (st && st !== 'none') {
        const cap = side[0].toUpperCase() + side.slice(1);
        (css as Record<string, unknown>)[`border${cap}`] =
          `${(p[`border_width_${side}`] as number) ?? 1}px ${st} ${(p[`border_color_${side}`] as string) ?? 'transparent'}`;
      }
    }
  } else {
    // border_color sem border_style → editor assume solid
    const style = (p.border_style as string) ?? (p.border_color ? 'solid' : undefined);
    if (style && style !== 'none') {
      css.border = `${(p.border_width as number) ?? 1}px ${style} ${(p.border_color as string) ?? 'transparent'}`;
    }
  }
  const corners = SIDES.filter((s) => p[`border_roundness_${s}`] !== undefined);
  if (corners.length > 0) {
    for (const s of SIDES) {
      (css as Record<string, unknown>)[CORNER_MAP[s] as string] = raioToken((p[`border_roundness_${s}`] as number) ?? 0);
    }
  } else if (typeof p.border_roundness === 'number') {
    css.borderRadius = raioToken(p.border_roundness);
  }
}

function shadowCss(p: Props, css: CSSProperties) {
  const style = p.boxshadow_style as string | undefined;
  if (!style || style === 'none') return;
  const inset = style === 'inset' ? 'inset ' : '';
  // A sombra é tokenizada INTEIRA, não em cinco números soltos: assim o tema troca por
  // `--shadow-card` do DS numa linha só. São 15 sombras distintas no app.
  const sombra = `${inset}${(p.boxshadow_horizontal as number) ?? 0}px ${(p.boxshadow_vertical as number) ?? 0}px ${(p.boxshadow_blur as number) ?? 0}px ${(p.boxshadow_spread as number) ?? 0}px ${(p.boxshadow_color as string) ?? 'var(--ui_shadow_cor, rgba(0,0,0,0.2))'}`;
  css.boxShadow = sombraToken(sombra);
}

/** Só o padding. Elemento fora do fluxo (Popup, GroupFocus) não passa por `childCss`, então
 *  precisa aplicá-lo por conta própria — senão o padding declarado no ESTILO é descartado.
 *  Era o que deixava o popup de login com padding 0 onde produção usa 24/24/28/24. */
export function paddingCss(p: Props): CSSProperties {
  const css: CSSProperties = {};
  const padH = p.padding_horizontal as number | undefined;
  const padV = p.padding_vertical as number | undefined;
  if (p.padding_top !== undefined || padV !== undefined) css.paddingTop = (p.padding_top as number) ?? padV;
  if (p.padding_bottom !== undefined || padV !== undefined) css.paddingBottom = (p.padding_bottom as number) ?? padV;
  if (p.padding_left !== undefined || padH !== undefined) css.paddingLeft = (p.padding_left as number) ?? padH;
  if (p.padding_right !== undefined || padH !== undefined) css.paddingRight = (p.padding_right as number) ?? padH;
  if (typeof p.padding === 'string') css.padding = p.padding; // styles usam "8px 16px"
  return css;
}

function spacingCss(p: Props, css: CSSProperties) {
  Object.assign(css, paddingCss(p));
  if (p.margin_top !== undefined) css.marginTop = p.margin_top as number;
  if (p.margin_bottom !== undefined) css.marginBottom = p.margin_bottom as number;
  if (p.margin_left !== undefined) css.marginLeft = p.margin_left as number;
  if (p.margin_right !== undefined) css.marginRight = p.margin_right as number;
}

/** CSS do elemento como CONTAINER (display flex etc.). */
export function containerCss(p: Props): CSSProperties {
  const css: CSSProperties = {};
  const layout = (p.container_layout as string) || 'column';
  if (layout === 'row' || layout === 'column') {
    css.display = 'flex';
    css.flexDirection = layout as 'row' | 'column';
    if (layout === 'row') css.flexWrap = 'wrap';
    const justify = layout === 'row' ? p.container_horiz_alignment : p.container_vert_alignment;
    if (typeof justify === 'string') css.justifyContent = justify;
    css.alignItems = 'stretch';
    if (p.use_gap === true) {
      css.gap = `${(p.row_gap as number) ?? 0}px ${(p.column_gap as number) ?? 0}px`;
    }
  } else if (layout === 'relative') {
    // "Align to parent" do editor responsivo: a plataforma emite `display: grid` com uma única
    // célula, todos os filhos empilhados nela e esticando na largura. Medido em
    // /redirectplans mobile — real: grid, filhos `position: relative` com 358px (390 menos os
    // 32 de padding); nosso, quando isto era `position: relative` + filho absoluto:
    // 195px e 183px, com o título quebrando em 3 linhas em vez de 2.
    // São só 8 elementos no app inteiro, todos sem `element_version` declarado.
    css.display = 'grid';
    css.position = 'relative';
  } else if (layout === 'fixed') {
    css.position = 'relative';
  }
  if (p.overflow_scroll === true) css.overflowY = 'auto';
  return css;
}

/** CSS do elemento como FILHO do pai (sizing + align-self + margens). */
export function childCss(p: Props, parent: ParentLayout): CSSProperties {
  const css: CSSProperties = {};

  if (parent === 'relative') {
    // Filho de "Align to parent": todos empilhados na MESMA célula, largura cheia e altura de
    // conteúdo, posicionados pelo `nonant_alignment`. Não dá para reaproveitar
    // `applyWidth(…, 'cross')` aqui: no flexbox `align-self` é o eixo horizontal, no grid é o
    // vertical — reusá-lo aplicava `align-self: stretch` e esticava os filhos para os 820px da
    // linha inteira em vez dos 120/44 de conteúdo do real.
    css.gridArea = '1 / 1';
    css.position = 'relative';
    if (typeof p.zindex === 'number') css.zIndex = p.zindex;

    const min = px(p.min_width_css);
    const max = px(p.max_width_css);
    if (p.single_width === true) {
      const w = min ?? px(p.width) ?? 'auto';
      css.width = w;
    } else if (p.fit_width === true) {
      css.width = 'fit-content';
    } else {
      css.width = '100%';
    }
    if (min) css.minWidth = min;
    if (max) css.maxWidth = max;
    if (p.single_height === true) css.height = px(p.min_height_css) ?? px(p.height) ?? 'auto';
    else if (px(p.min_height_css)) css.minHeight = px(p.min_height_css);

    // Alinhamento nos dois eixos, como o real emite (`justify-self`/`align-self` por nonant).
    // Com a largura já explícita, `justify-self: center` não encolhe a caixa.
    const mapa: Record<string, 'start' | 'center' | 'end'> = { a: 'start', b: 'center', c: 'end' };
    const nonant = typeof p.nonant_alignment === 'string' ? p.nonant_alignment : 'aa';
    css.justifySelf = mapa[nonant[0]] ?? 'start';
    css.alignSelf = mapa[nonant[1]] ?? 'start';
    spacingCss(p, css);
    return css;
  }

  if (parent === 'fixed') {
    css.position = 'absolute';
    if (typeof p.zindex === 'number') css.zIndex = p.zindex;
    if (p.left !== undefined) css.left = p.left as number;
    if (p.top !== undefined) css.top = p.top as number;
    applyWidth(css, p, 'free');
    applyHeight(css, p, 'free');
    spacingCss(p, css);
    return css;
  }

  // align-self (cross axis)
  const align = parent === 'row' ? p.vert_alignment : p.horiz_alignment;
  if (typeof align === 'string') css.alignSelf = align;

  applyWidth(css, p, parent === 'row' ? 'main' : 'cross');
  applyHeight(css, p, parent === 'column' || parent === 'page' ? 'main' : 'cross');
  spacingCss(p, css);
  if (typeof p.opacity === 'number') css.opacity = p.opacity / 100;
  return css;
}

function applyWidth(css: CSSProperties, p: Props, axis: 'main' | 'cross' | 'free') {
  const min = px(p.min_width_css);
  const max = px(p.max_width_css);
  if (p.single_width === true) {
    const w = min ?? px(p.width) ?? 'auto';
    css.width = w;
    css.minWidth = w;
    css.maxWidth = w;
    css.flexShrink = 0;
  } else if (p.fit_width === true) {
    css.width = 'fit-content';
    if (min) css.minWidth = min;
    if (max) css.maxWidth = max;
    if (axis === 'main') {
      css.flexGrow = 0;
      css.flexShrink = 0;
    }
  } else {
    // fluid
    if (axis === 'main') {
      // `width` é a largura de CANVAS do editor, não uma base de layout: usá-la como
      // `flex-basis` fazia dois filhos de 250px somarem 500 num container de 308 e quebrarem
      // linha. Na plataforma o elemento fluido parte de zero e cresce dentro do que sobra,
      // respeitando `max_width_css`. Com base 0, UF e Cidade de /minhaconta saem 60px e 232px
      // lado a lado — exatamente o que produção mede.
      css.flex = '1 1 0%';
      css.minWidth = min ?? '0px';
      if (max) css.maxWidth = max;
    } else {
      // cross axis (pai column): stretch — flexbox desconta margens automaticamente
      const align = css.alignSelf as string | undefined;
      if (!max || !align || align === 'stretch') css.alignSelf = 'stretch';
      else css.width = '100%';
      if (min) css.minWidth = min;
      if (max) css.maxWidth = max;
    }
  }
}

/** A plataforma NUNCA deixa conteúdo vazar de um `max_height_css`: ele contém.
 *
 *  Em TEXTO, trunca com reticências — verificado no app em produção, onde um título de 59
 *  caracteres aparece como "Consultoria agronômica..." (25). O nº de linhas exibidas é
 *  `max-height ÷ altura de linha`. Reproduzimos com line-clamp.
 *
 *  Em CONTAINER (sem font_size), simplesmente corta.
 *
 *  Sem isto o conteúdo transborda com `overflow: visible` e sobrepõe o elemento de baixo —
 *  foi o que quebrou as listagens em desktop. */
function containMaxHeight(css: CSSProperties, p: Props, max: string) {
  css.maxHeight = max;
  css.overflow = 'hidden';
  const fontSize = typeof p.font_size === 'number' ? p.font_size : undefined;
  if (!fontSize) return; // container: cortar basta
  const lh = typeof p.line_height === 'number' ? p.line_height : 1.4;
  const maxPx = parseFloat(max);
  if (!Number.isFinite(maxPx)) return; // max em %, vh… não dá para contar linhas
  const linhas = Math.max(1, Math.floor(maxPx / (fontSize * lh)));
  css.display = '-webkit-box';
  css.WebkitBoxOrient = 'vertical';
  css.WebkitLineClamp = linhas;
}

function applyHeight(css: CSSProperties, p: Props, axis: 'main' | 'cross' | 'free') {
  const min = px(p.min_height_css);
  const max = px(p.max_height_css);
  if (p.single_height === true) {
    const h = min ?? px(p.height) ?? 'auto';
    css.height = h;
    css.minHeight = h;
    css.flexShrink = 0;
    if (max) containMaxHeight(css, p, max);
  } else if (p.fit_height === true) {
    css.height = 'auto';
    if (min) css.minHeight = min;
    if (max) containMaxHeight(css, p, max);
  } else {
    // fluid height
    if (axis === 'main') css.flexGrow = 1;
    if (min) css.minHeight = min;
    if (max) containMaxHeight(css, p, max);
  }
}

/** nonant: 2 letras [h][v]; a=início, b=centro, c=fim. */
function anchorNonant(css: CSSProperties, nonant: string) {
  const h = nonant?.[0] ?? 'a';
  const v = nonant?.[1] ?? 'a';
  let tx = '';
  let ty = '';
  if (h === 'a') css.left = 0;
  else if (h === 'c') css.right = 0;
  else {
    css.left = '50%';
    tx = '-50%';
  }
  if (v === 'a') css.top = 0;
  else if (v === 'c') css.bottom = 0;
  else {
    css.top = '50%';
    ty = '-50%';
  }
  if (tx || ty) css.transform = `translate(${tx || '0'}, ${ty || '0'})`;
}

/** CSS visual (background, borda, sombra, tipografia, z-index em overlays). */
export function visualCss(p: Props): CSSProperties {
  const css: CSSProperties = {};
  backgroundCss(p, css);
  borderCss(p, css);
  shadowCss(p, css);
  Object.assign(css, fontCss(p));
  return css;
}

/** transitions {prop: {fn, duration}} → CSS transition. */
export function transitionsCss(transitions: Record<string, { fn: string; duration: number }> | undefined): string | undefined {
  if (!transitions) return undefined;
  const MAP: Record<string, string> = {
    background_style: 'background-color',
    border_color: 'border-color',
    font_color: 'color',
    margin_left: 'margin-left',
    width_css: 'width',
    height_css: 'height',
    icon_color: 'color',
    boxshadow_style: 'box-shadow',
  };
  const parts = Object.entries(transitions)
    .map(([prop, t]) => `${MAP[prop] ?? 'all'} ${t.duration ?? 200}ms ${t.fn ?? 'ease'}`);
  return parts.length ? parts.join(', ') : undefined;
}

/** Compoẽ o CSS completo de um elemento já com props mescladas (style+inline+states). */
export function computeCss(p: Props, parent: ParentLayout): CSSProperties {
  const css: CSSProperties = { ...childCss(p, parent), ...containerCss(p), ...visualCss(p) };
  css.boxSizing = 'border-box';
  css.position = css.position ?? 'relative';
  return css;
}
