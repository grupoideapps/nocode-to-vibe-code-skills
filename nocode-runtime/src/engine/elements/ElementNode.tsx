'use client';
// Renderer recursivo de elementos no-code.
import React, { useEffect, useMemo, useRef } from 'react';
import { childCss, computeCss, containerCss, normalizeAssetUrl, paddingCss, transitionsCss, visualCss, type ParentLayout, type Props } from '../css';
import { coerceText, evaluate, toBool, toList, groupDataOf, type EvalCtx } from '../expressions';
import { isOption } from '../data';
import { corToken, chaveDeCor, raioToken } from '../tema';
import { runWorkflow } from '../workflows';
import { makeEvalCtx, useRuntime, ContainerWorkflows, type RuntimeContextValue } from '../runtime';
import { renderBBCode } from '../bbcode';
import { NocodeIcon } from '../icons';
import type { NocodeElement, NocodeWorkflow, ConditionalState, ElementDefinition, PropValue } from '../types';
import type { ElementHandle, Scope } from '../store';

// ---------------------------------------------------------------- helpers

const CLICK_EVENT_EXCLUDE = new Set([
  'InputChanged',
  'PageLoaded',
  'ConditionTrue',
  'CustomEvent',
  'PopupOpened',
  'PopupClosed',
  'OnPageError',
]);

function validChildren(el: NocodeElement): NocodeElement[] {
  const children = Object.values(el.elements ?? {}).filter(
    (c): c is NocodeElement => !!c && typeof c === 'object' && typeof (c as NocodeElement).type === 'string',
  );
  return children.sort(
    (a, b) => ((a.properties?.order as number) ?? 9999) - ((b.properties?.order as number) ?? 9999),
  );
}

interface MergedResult {
  props: Props;
  /** chaves alteradas por states ativos */
  stateKeys: Set<string>;
  rawProps: Record<string, PropValue>;
}

// Props visuais que o editor da plataforma aceita como EXPRESSÃO dinâmica. Chegam como objeto
// no export e precisam virar string antes de ir para css.ts — visualCss/containerCss
// assumem valores já avaliados (ex.: normalizeAssetUrl faz url.startsWith).
const VISUAL_EXPR_PROPS = new Set([
  'background_image',
  'bgcolor',
  'font_color',
  'border_color',
  'icon_color',
  'max_width_css',
  'min_width_css',
]);

/** Achata um bag de props cruas resolvendo as expressões visuais. Use SEMPRE antes de
 *  passar props para o css.ts — inclusive para props de definição de reusable. */
function evalVisualProps(raw: Record<string, PropValue>, ctx: EvalCtx): Props {
  const props: Props = {};
  const mapa = ctx.store.payload.tokensPorValor;
  for (const [k, v] of Object.entries(raw)) {
    if (v !== null && typeof v === 'object') {
      if (VISUAL_EXPR_PROPS.has(k)) {
        try {
          const texto = coerceText(evaluate(v, ctx), ctx);
          // O editor da plataforma permite EXPRESSÃO em font_color/border_color/icon_color/bgcolor. Quando
          // isso acontece o valor nasce aqui, no render — nunca passou pelo walk do loader, que só
          // enxerga string no export — e este é o único ponto onde pode virar token.
          // Medido em 06/08: o app-marketplace não usa nenhuma (os ~77 objetos sob essas chaves no
          // export são todos `transitions` — {fn, duration}, já consumidos por transitionsCss —
          // não `TextExpression`). A proteção aqui é preventiva: este engine é propagado para um
          // repo canônico que serve outros apps no-code, e o editor permite a expressão mesmo sem
          // este app exercitá-la — por isso não tem cobertura de teste neste app.
          props[k] = typeof texto === 'string' && chaveDeCor(k) ? corToken(texto, mapa) : texto;
        } catch {
          props[k] = undefined;
        }
      }
      // demais expressões (text, data_source, placeholder...) ficam em raw
    } else {
      props[k] = v as Props[string];
    }
  }
  return props;
}

// Defaults do runtime da plataforma por tipo de elemento (aplicados antes do style nomeado).
// Validado contra o site real: Text/Input/Button caem em 14px quando o style não define font_size.
const TYPE_DEFAULTS: Record<string, Record<string, PropValue>> = {
  Text: { font_size: 14, line_height: 1.4, font_color: 'var(--color_text_default)' },
  // tema ev5: Button sem font_color usa o contraste do primário (texto branco sobre bg primary)
  Button: { font_size: 14, line_height: 1.4, font_color: 'var(--color_primary_contrast_default)' },
  Input: { font_size: 14, line_height: 1.4 },
  MultiLineInput: { font_size: 14, line_height: 1.4 },
  Dropdown: { font_size: 14, line_height: 1.4 },
  DateInput: { font_size: 14, line_height: 1.4 },
  Link: { font_size: 14, line_height: 1.4 },
};

function mergeProps(rt: RuntimeContextValue, el: NocodeElement, handle: ElementHandle): MergedResult {
  const styleId = el.style ?? rt.payload.defaultStyles[el.type];
  const styleDef = styleId ? rt.payload.styles[styleId] : undefined;
  const raw: Record<string, PropValue> = {
    ...(TYPE_DEFAULTS[el.type] ?? {}),
    ...(styleDef?.properties ?? {}),
    ...(el.properties ?? {}),
  };
  const stateKeys = new Set<string>();
  const ctx = makeEvalCtx(rt, handle.scope, handle);

  const applyStates = (states: Record<string, ConditionalState> | undefined) => {
    if (!states) return;
    for (const s of Object.values(states)) {
      if (!s || typeof s !== 'object' || !s.condition) continue;
      let active = false;
      try {
        active = toBool(evaluate(s.condition, ctx));
      } catch {
        active = false;
      }
      if (active) {
        for (const [k, v] of Object.entries(s.properties ?? {})) {
          raw[k] = v;
          stateKeys.add(k);
        }
      }
    }
  };
  // Estados do estilo só se aplicam quando o elemento REFERENCIA o estilo. Elemento sem
  // `style` é destacado na plataforma e não herda estado nenhum — o fallback de defaultStyles
  // existe só para propriedades base. Aplicá-los a destacados dava hover fantasma: os 67
  // Buttons sem estilo deste app (todos com bgcolor próprio) ganhavam o is_hovered→primary
  // do Button_filled_light_primary_ — o "Button Login azul no hover" reportado em 07/08 (§17).
  applyStates(el.style ? styleDef?.states : undefined);
  applyStates(el.states);

  // resolve expressões em props visuais/escalares
  const props = evalVisualProps(raw, ctx);
  return { props, stateKeys, rawProps: raw };
}

function findWorkflows(scope: Scope, elementId: string): NocodeWorkflow[] {
  return Object.values(scope.container.workflows ?? {}).filter(
    (w): w is NocodeWorkflow =>
      !!w &&
      typeof w === 'object' &&
      (w.properties as Record<string, unknown> | undefined)?.element_id === elementId,
  );
}

function useHandle(el: NocodeElement, scope: Scope, parentHandle: ElementHandle | null, aliasId?: string) {
  const rt = useRuntime();
  const handle = useMemo<ElementHandle>(
    () => ({ id: el.id, key: `${scope.key}:${el.id}`, el, scope, parentHandle, dom: null }),
    [el, scope, parentHandle],
  );
  const alias = useMemo(() => (aliasId ? { ...handle, id: aliasId } : null), [handle, aliasId]);
  // Registro no RENDER, além do efeito: `PageLoaded` dispara em `useLayoutEffect`, que roda
  // ANTES de qualquer `useEffect`. Registrando só no efeito, TODA ação de carregamento que
  // mira um elemento (`SetCustomState`, `ShowElement`, …) resolvia handle nulo e era
  // descartada em silêncio — é o que sumia com o botão "Anuncie aqui" do header, cuja
  // visibilidade depende do `ondeestou_` que o PageLoaded da página grava no header.
  // `register` guarda num Set e o `handle` é memoizado, então re-registrar é idempotente.
  rt.store.register(handle);
  if (alias) rt.store.register(alias);
  useEffect(() => {
    rt.store.register(handle);
    if (alias) rt.store.register(alias);
    return () => {
      rt.store.unregister(handle);
      if (alias) rt.store.unregister(alias);
    };
  }, [rt.store, handle, alias]);
  return handle;
}

// ---------------------------------------------------------------- principal

export function ElementNode({
  el,
  scope,
  parentHandle,
  parentLayout,
}: {
  el: NocodeElement;
  scope: Scope;
  parentHandle: ElementHandle | null;
  parentLayout: ParentLayout;
}) {
  const rt = useRuntime();
  const handle = useHandle(el, scope, parentHandle);
  const domRef = useRef<HTMLDivElement | null>(null);
  handle.dom = domRef.current;

  const { props, stateKeys, rawProps } = mergeProps(rt, el, handle);
  const ctx = makeEvalCtx(rt, scope, handle);

  // visibilidade
  // Alert: oculto até a ação AlertShowMessage disparar (comportamento nativo da plataforma)
  const defaultVisible =
    el.type === 'Popup' || el.type === 'GroupFocus' || el.type === 'Alert' ? false : el.properties?.is_visible !== false;
  const visible = stateKeys.has('is_visible')
    ? props.is_visible !== false
    : (rt.store.visibilityOverride.get(handle.key) ?? defaultVisible);

  // eventos PopupOpened/Closed
  const prevVisible = useRef(visible);
  useEffect(() => {
    if (prevVisible.current !== visible && el.type === 'Popup') {
      const evType = visible ? 'PopupOpened' : 'PopupClosed';
      for (const wf of findWorkflows(scope, el.id).filter((w) => w.type === evType)) {
        void runWorkflow(wf, rt.env, scope, handle);
      }
    }
    prevVisible.current = visible;
  }, [visible, el.id, el.type, scope, rt.env, handle]);

  // clique
  const clickWorkflows = useMemo(
    () => findWorkflows(scope, el.id).filter((w) => !CLICK_EVENT_EXCLUDE.has(w.type)),
    [scope, el.id],
  );
  const onClick =
    clickWorkflows.length > 0
      ? (e: React.MouseEvent) => {
          e.stopPropagation();
          for (const wf of clickWorkflows) void runWorkflow(wf, rt.env, scope, handle);
        }
      : undefined;

  // hover tracking só quando alguma condition usa is_hovered/is_pressed
  const needsHover = useMemo(() => {
    const s = JSON.stringify(el.states ?? {}) + JSON.stringify(rt.payload.styles[el.style ?? '']?.states ?? {});
    return s.includes('is_hovered') || s.includes('is_pressed');
  }, [el, rt.payload.styles]);

  const hoverProps = needsHover
    ? {
        onMouseEnter: () => rt.store.setHovered(handle.key, true),
        onMouseLeave: () => {
          rt.store.setHovered(handle.key, false);
          rt.store.setPressed(handle.key, false);
        },
        onMouseDown: () => rt.store.setPressed(handle.key, true),
        onMouseUp: () => rt.store.setPressed(handle.key, false),
      }
    : {};

  // ---- overlays especiais
  if (el.type === 'Popup') {
    return (
      <PopupEl
        el={el}
        handle={handle}
        scope={scope}
        props={props}
        rawProps={rawProps}
        visible={visible}
        domRef={domRef}
        onClick={onClick}
      />
    );
  }
  if (el.type === 'GroupFocus') {
    return <GroupFocusEl el={el} handle={handle} scope={scope} props={props} visible={visible} domRef={domRef} />;
  }

  const css = computeCss(props, parentLayout);
  // altura % em filho DIRETO da página: % não resolve contra pai sem height definida.
  // 100% → align-self:stretch (estica à altura real da página, que é ≥ viewport e cresce
  // com o conteúdo — ex.: coluna lateral de login). Outros % → fração da altura mínima.
  if (parentHandle?.el.type === 'Page') {
    const pageMin = (rt.payload.page.properties?.min_height_px as number) ?? 600;
    for (const k of ['height', 'minHeight'] as const) {
      const v = css[k];
      if (typeof v === 'string' && /^[\d.]+%$/.test(v)) {
        const pct = parseFloat(v) / 100;
        if (pct === 1) {
          delete css[k];
          css.alignSelf = 'stretch';
        } else {
          css[k] = `calc(max(${pageMin}px, 100vh) * ${pct})`;
        }
      }
    }
  }
  if (el.type === 'FloatingGroup') {
    css.position = 'fixed';
    css.left = 0;
    css.right = 0;
    css.zIndex = 900;
    if (props.floating_reference === 'both') {
      css.top = 0;
      css.bottom = 0;
    } else if (props.floating_reference === 'bottom') {
      css.bottom = 0;
    } else {
      css.top = 0;
    }
    css.width = '100%';
  }

  // Na plataforma "Collapse this element's height when hidden" é opt-in: sem a chave o elemento
  // oculto CONTINUA ocupando o espaço. O export confirma a leitura — a chave aparece como
  // `false` explícito 94 vezes, então ausente e `false` têm que se comportar igual (aqui,
  // 3353 ausentes + 94 falsos = 'keep'; 4839 verdadeiros = 'collapse').
  // Medido em /planos mobile: o real deixa 2 elementos ocultos reservando altura e tem 67
  // `display:none`; com o padrão anterior ('collapse') nós reservávamos 0 e colapsávamos 92.
  const hiddenAttr = !visible ? (props.collapse_when_hidden === true ? 'collapse' : 'keep') : undefined;
  const transition = transitionsCss(
    (el as { transitions?: Record<string, { fn: string; duration: number }> }).transitions ??
      rt.payload.styles[el.style ?? '']?.transitions,
  );
  if (transition) css.transition = transition;
  if (onClick) css.cursor = 'pointer';
  if (typeof props.zindex === 'number' && (parentLayout === 'relative' || parentLayout === 'fixed' || el.type === 'FloatingGroup'))
    css.zIndex = props.zindex;

  const layout = ((props.container_layout as string) || 'column') as ParentLayout;
  const children = validChildren(el);

  // Container do layout ANTIGO da plataforma (`container_layout: 'relative'`): os filhos viram
  // `position: absolute` e saem do fluxo, então o pai não cresce sozinho. Com `fit_height`
  // a plataforma cresce o container para conter os filhos posicionados — reproduzimos medindo
  // a extensão vertical deles (top + altura). Sem isto o conteúdo vaza para fora do card.
  if (layout === 'relative' && props.fit_height === true && children.length) {
    let fundo = 0;
    for (const c of children) {
      const cp = c.properties ?? {};
      const top = typeof cp.top === 'number' ? cp.top : 0;
      const alt = parseFloat(String(cp.min_height_css ?? cp.height ?? 0)) || 0;
      fundo = Math.max(fundo, top + alt);
    }
    const atual = parseFloat(String(css.minHeight ?? 0)) || 0;
    if (fundo > atual) css.minHeight = fundo;
  }

  const common = {
    ref: domRef,
    style: css,
    onClick,
    ...hoverProps,
    'data-bid': el.id,
    'data-bname': el.name ?? el.default_name,
    'data-bhidden': hiddenAttr,
  };

  switch (el.type) {
    case 'Group':
    case 'FloatingGroup':
    case 'Shape':
      return (
        <div {...common} className="nc-el">
          {children.map((c) => (
            <ElementNode key={c.id} el={c} scope={scope} parentHandle={handle} parentLayout={layout} />
          ))}
        </div>
      );

    case 'Text': {
      const text = coerceText(evaluate(rawProps.text, ctx), ctx);
      // O corte por Nº de linhas (`max_height_css`) chega aqui em `css` como `-webkit-box` +
      // `line-clamp`. Mas `line-clamp` SÓ funciona com `display: -webkit-box`, e o
      // `vertical_centering` logo abaixo troca o display para `flex` — o clamp virava letra
      // morta e o texto vazava por cima do elemento seguinte (títulos dos cards de serviço se
      // sobrepondo à descrição: span de 50px numa caixa de 26px).
      // Os dois não cabem no mesmo elemento, então o clamp desce para o <span> interno e o
      // container fica livre para centralizar.
      const clamp: React.CSSProperties = {};
      if (css.WebkitLineClamp !== undefined) {
        clamp.display = '-webkit-box';
        clamp.WebkitBoxOrient = 'vertical';
        clamp.WebkitLineClamp = css.WebkitLineClamp;
        clamp.overflow = 'hidden';
        delete css.display;
        delete css.WebkitBoxOrient;
        delete css.WebkitLineClamp;
      }
      if (props.vertical_centering) {
        css.display = 'flex';
        css.flexDirection = 'column';
        css.justifyContent = 'center';
      }
      return (
        <div {...common} className="nc-el nc-text">
          {/* `pre-wrap` é o que a plataforma aplica em `.elemento-de-texto.Text`: preserva as quebras
              do conteúdo e ainda quebra linha por largura. Sem isso o navegador colapsa o `\n`
              num espaço — no export há 17 textos com quebra de linha e 7 deles não passam pelo
              BBCode (o parser só insere `<br>` quando há colchete), então saíam corridos. */}
          <span style={{ width: '100%', whiteSpace: 'pre-wrap', ...clamp }}>{renderBBCode(text)}</span>
        </div>
      );
    }

    case 'Button': {
      const text = coerceText(evaluate(rawProps.text, ctx), ctx);
      const icon = typeof rawProps.icon === 'string' ? rawProps.icon : undefined;
      const disabled = stateKeys.has('button_disabled') ? toBool(props.button_disabled) : toBool(rawProps.button_disabled);
      css.display = 'flex';
      css.flexDirection = 'row';
      css.alignItems = 'center';
      // default da plataforma: texto de Button centralizado (flex-start só com font_alignment left)
      css.justifyContent =
        (props.button_horiz_alignment as string) ??
        (props.font_alignment === 'left' ? 'flex-start' : props.font_alignment === 'right' ? 'flex-end' : 'center');
      css.gap = (props.button_gap as number) ?? 6;
      if (disabled) {
        // 0.6 é só fallback: quando o elemento declara um conditional state pro estado
        // desabilitado (ex.: `isnt_clickable` com `opacity: 50`), `childCss` já converteu esse
        // valor e sobrescrevê-lo aqui apagava a opacidade que a plataforma realmente aplica.
        if (css.opacity === undefined) css.opacity = 0.6;
        css.cursor = 'not-allowed';
      }
      // `button_type` decide o CONTEÚDO do botão na plataforma:
      //   'icon'       → só o ícone; o `text` é ignorado. É comum sobrar texto residual
      //                  quando o botão foi duplicado de um com label (ex.: os botões de
      //                  compartilhar, que guardam text "Ver").
      //   'label'      → só o texto, mesmo que haja `icon` definido.
      //   'label_icon' → ícone + texto.
      //   AUSENTE      → só o texto. O `icon` no JSON é resíduo do editor e NÃO é exibido:
      //                  são 146 botões assim neste app, incluindo os de Login/Cadastro dos
      //                  popups, que mostravam uma estrela inexistente no app real.
      const buttonType = props.button_type as string | undefined;
      const showIcon = buttonType === 'icon' || buttonType === 'label_icon';
      const showText = buttonType !== 'icon';
      // tamanho do glifo: `icon_size` quando declarado (41 botões), senão acompanha a
      // tipografia do próprio botão — nunca um literal fixo.
      const iconNode =
        icon && showIcon ? (
          <NocodeIcon
            icon={icon}
            size={(props.icon_size as number) ?? (props.font_size as number) ?? 14}
            color={(props.icon_color as string) ?? (props.font_color as string)}
          />
        ) : null;
      return (
        <div
          {...common}
          className="nc-el nc-button"
          role="button"
          onClick={disabled ? undefined : onClick}
        >
          {showIcon && props.icon_placement !== 'right' && iconNode}
          {showText && <span>{renderBBCode(text)}</span>}
          {showIcon && props.icon_placement === 'right' && iconNode}
        </div>
      );
    }

    case 'Icon': {
      const icon = typeof rawProps.icon === 'string' ? rawProps.icon : coerceText(evaluate(rawProps.icon, ctx), ctx);
      const sizeRaw = parseInt(String(props.min_height_css ?? props.height ?? 16));
      const padding = ((props.padding_top as number) ?? 0) + ((props.padding_bottom as number) ?? 0);
      // A plataforma desenha o glifo ocupando a ALTURA ÚTIL do elemento (caixa menos padding).
      // Havia aqui um `- 8` arbitrário que encolhia TODO ícone do app: medições contra
      // produção davam 24→12, 16→10, 20→12, 60→52. Só o padding é descontado.
      const size = Math.max(1, (Number.isNaN(sizeRaw) ? 16 : sizeRaw) - padding);
      css.display = 'flex';
      css.alignItems = 'center';
      css.justifyContent = 'center';
      return (
        <div {...common} className="nc-el nc-icon">
          <NocodeIcon icon={icon} size={size} color={(props.icon_color as string) ?? 'var(--color_primary_default)'} />
        </div>
      );
    }

    case 'Image': {
      const src = coerceText(evaluate(rawProps.src, ctx), ctx);
      // `rescale` → contain, `zoom` → cover, propriedade AUSENTE → fill. O default aqui era
      // contain, mas produção desenha `object-fit: fill` nas imagens sem a propriedade (a logo
      // do header entre elas, que saía 6px deslocada) — e no app real não aparece um único
      // `object-fit` que não seja um desses três. São 28 imagens sem a propriedade, 16
      // `rescale` e 30 `zoom`.
      const fitMode = props.stretch_or_rescale as string | undefined;
      const fit =
        fitMode === 'rescale' ? 'contain' : fitMode === undefined || fitMode === 'stretch' ? 'fill' : 'cover';
      if (props.use_aspect_ratio && props.aspect_ratio_width && props.aspect_ratio_height) {
        css.aspectRatio = `${props.aspect_ratio_width} / ${props.aspect_ratio_height}`;
      }
      return (
        <div {...common} className="nc-el nc-image" style={{ ...css, overflow: 'hidden' }}>
          {src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={normalizeAssetUrl(src)}
              alt={el.name ?? ''}
              style={{ width: '100%', height: '100%', objectFit: fit, borderRadius: css.borderRadius }}
            />
          ) : null}
        </div>
      );
    }

    case 'RepeatingGroup':
      return (
        <RepeatingGroupEl el={el} handle={handle} scope={scope} props={props} rawProps={rawProps} css={css} domRef={domRef} hiddenAttr={hiddenAttr} />
      );

    case 'Table':
      return (
        <TableEl el={el} handle={handle} scope={scope} props={props} rawProps={rawProps} css={css} domRef={domRef} hiddenAttr={hiddenAttr} />
      );

    case 'CustomElement':
      return (
        <ReusableEl el={el} handle={handle} scope={scope} props={props} css={css} domRef={domRef} onClick={onClick} hiddenAttr={hiddenAttr} />
      );

    case 'HTML': {
      const html = coerceText(evaluate(rawProps.html, ctx), ctx);
      if (rawProps.useiframe) {
        return (
          <div {...common} className="nc-el">
            <iframe srcDoc={html} style={{ width: '100%', height: '100%', border: 'none' }} title={el.name ?? 'html'} />
          </div>
        );
      }
      return <div {...common} className="nc-el" dangerouslySetInnerHTML={{ __html: html }} />;
    }

    case 'SliderInput': {
      // elemento nativo da plataforma — slider simples (0..100 por padrão)
      const min = props.default_min_value != null ? Number(props.default_min_value) : 0;
      const max = props.default_max_value != null ? Number(props.default_max_value) : 100;
      const accent = (props.handle_color as string) ?? 'var(--color_primary_default)';
      const stored = rt.store.inputValues.get(handle.key);
      const value = stored != null ? Number(stored) : Number(props.default_value ?? min);
      return (
        <div {...common} className="nc-el" style={{ ...css, display: 'flex', alignItems: 'center' }}>
          <input
            type="range"
            min={Number.isNaN(min) ? 0 : min}
            max={Number.isNaN(max) ? 100 : max}
            defaultValue={Number.isNaN(value) ? min : value}
            onChange={(e) => rt.store.setInputValue(handle.key, Number(e.target.value))}
            style={{ width: '100%', accentColor: accent }}
          />
        </div>
      );
    }

    case 'Video': {
      // elemento nativo da plataforma — video_id é um ID do YouTube por padrão (ou URL completa)
      const vid = coerceText(evaluate(rawProps.video_id, ctx), ctx).trim();
      const radius = raioToken(props.border_roundness != null ? Number(props.border_roundness) : 0);
      let src = '';
      if (/^https?:\/\//i.test(vid)) {
        const ytm = vid.match(/(?:youtu\.be\/|v=)([\w-]{6,})/);
        src = ytm ? `https://www.youtube.com/embed/${ytm[1]}` : vid;
      } else if (vid) {
        src = `https://www.youtube.com/embed/${vid}`;
      }
      return (
        <div {...common} className="nc-el" style={{ ...css, overflow: 'hidden', borderRadius: radius }}>
          {src ? (
            <iframe
              src={src}
              style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              title={el.name ?? 'video'}
            />
          ) : null}
        </div>
      );
    }

    case 'Link': {
      const text = coerceText(evaluate(rawProps.text, ctx), ctx);
      const url = coerceText(evaluate(rawProps.url, ctx), ctx);
      return (
        <div {...common} className="nc-el">
          <a href={url || '#'} target={rawProps.open_in_new_tab ? '_blank' : undefined} rel="noreferrer">
            {renderBBCode(text)}
          </a>
        </div>
      );
    }

    case 'Alert': {
      // AlertShowMessage com change_message=true troca o texto exibido
      const text = rt.store.alertMessages.get(handle.key) ?? coerceText(evaluate(rawProps.text, ctx), ctx);
      if (!visible) return null;
      return (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 4000,
            padding: '12px 16px',
            textAlign: 'center',
            background: (props.bgcolor as string) ?? 'var(--color_primary_default)',
            color: (props.font_color as string) ?? 'var(--ui_on_primary, #fff)',
            fontFamily: 'var(--font_default)',
          }}
        >
          {text}
        </div>
      );
    }

    case 'Input':
    case 'MultiLineInput':
    case 'DateInput':
    case 'Dropdown':
    case 'Checkbox':
    case 'RadioButtons':
    case 'AutocompleteDropdown':
    case 'PictureInput':
    case 'FileInput':
      return (
        <InputEl
          el={el}
          handle={handle}
          scope={scope}
          props={props}
          rawProps={rawProps}
          css={css}
          domRef={domRef}
          hoverProps={hoverProps}
          hiddenAttr={hiddenAttr}
        />
      );

    default:
      return (
        <PluginEl el={el} handle={handle} scope={scope} props={props} rawProps={rawProps} css={css} domRef={domRef} onClick={onClick} hiddenAttr={hiddenAttr} />
      );
  }
}

// ---------------------------------------------------------------- Popup

function PopupEl({
  el,
  handle,
  scope,
  props,
  rawProps,
  visible,
  domRef,
  onClick,
}: {
  el: NocodeElement;
  handle: ElementHandle;
  scope: Scope;
  props: Props;
  rawProps: Record<string, PropValue>;
  visible: boolean;
  domRef: React.RefObject<HTMLDivElement | null>;
  onClick?: (e: React.MouseEvent) => void;
}) {
  void rawProps;
  const rt = useRuntime();
  const children = validChildren(el);
  const layout = ((props.container_layout as string) || 'column') as ParentLayout;

  const boxCss: React.CSSProperties = {
    ...containerCss(props),
    ...visualCss(props),
    // `visualCss` cobre fundo/borda/sombra/fonte, mas NÃO espaçamento — isso mora em
    // `spacingCss`, que só roda via `childCss`, e um Popup não é filho de ninguém no fluxo.
    // O padding declarado no estilo (`Popup_standard_popup_`: 24/24/28/24) era descartado, e o
    // popup saía com padding 0: texto colado na borda, X na quina e a caixa 74px mais baixa
    // que a de produção.
    ...paddingCss(props),
    boxSizing: 'border-box',
    position: 'relative',
    width: '100%',
    maxWidth: (props.max_width_css as string) ?? '500px',
    minWidth: (props.min_width_css as string) ?? undefined,
    minHeight: (props.min_height_css as string) ?? undefined,
    maxHeight: '92vh',
    overflowY: 'auto',
    // A plataforma NÃO centraliza o popup na vertical: medido em produção, ele sai
    // `position: fixed; top: 100px` com centralização só horizontal (`margin: 0 519px`).
    // Nós centralizávamos nos dois eixos e o modal ficava 122px abaixo do real.
    // `marginBottom: auto` mantém o topo fixo mas deixa o modal encolher/rolar quando for
    // alto demais — com `align-items: flex-start` no overlay, centralizar mataria isso.
    // Ressalva: os 100px vêm de UM popup medido (o único alcançável sem login); se aparecer
    // outro com topo diferente, isto vira uma função da altura, não uma constante.
    marginTop: 100,
    marginBottom: 'auto',
    marginLeft: 'auto',
    marginRight: 'auto',
  };
  if (boxCss.paddingTop === undefined && typeof props.padding !== 'string') boxCss.padding = 16;

  const content = (
    // `nc-popup` marca a CAIXA do popup (o equivalente ao `.elemento-de-texto.Popup` do
    // no-code). Sem um marcador estável não dá para comparar popup contra produção de forma
    // sistemática — e popup é justamente o que a varredura de páginas não alcança.
    <div
      ref={domRef}
      style={boxCss}
      onClick={(e) => e.stopPropagation()}
      data-bid={el.id}
      data-bname={el.name ?? el.default_name}
      className="nc-el nc-popup"
    >
      {children.map((c) => (
        <ElementNode key={c.id} el={c} scope={scope} parentHandle={handle} parentLayout={layout} />
      ))}
    </div>
  );

  if (!visible) {
    // mantém montado p/ estados, mas invisível
    return <div style={{ display: 'none' }}>{content}</div>;
  }

  const canClose = props.prevent_user_from_closing_through_esc !== true;
  return (
    <div
      className="nc-popup-overlay"
      style={{
        background: (props.greyout_color as string) ?? 'var(--ui_overlay, rgba(0,0,0,0.6))',
        backdropFilter: props.greyout_blur ? `blur(${props.greyout_blur}px)` : undefined,
        // topo, não centro — ver o comentário do `marginTop` em `boxCss`
        alignItems: 'flex-start',
        overflowY: 'auto',
      }}
      onClick={
        canClose
          ? (e) => {
              e.stopPropagation();
              rt.store.setVisible(handle.key, false);
            }
          : undefined
      }
    >
      {content}
      {onClick ? null : null}
    </div>
  );
}

// ---------------------------------------------------------------- GroupFocus

function GroupFocusEl({
  el,
  handle,
  scope,
  props,
  visible,
  domRef,
}: {
  el: NocodeElement;
  handle: ElementHandle;
  scope: Scope;
  props: Props;
  visible: boolean;
  domRef: React.RefObject<HTMLDivElement | null>;
}) {
  const rt = useRuntime();
  const children = validChildren(el);
  const layout = ((props.container_layout as string) || 'column') as ParentLayout;
  const [rect, setRect] = React.useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!visible) return;
    const ref = rt.store.resolveHandle((el.properties?.reference as string) ?? '', scope);
    const r = ref?.dom?.getBoundingClientRect();
    if (r) {
      setRect({
        left: r.left + ((el.properties?.offset_left as number) ?? 0),
        top: r.bottom + ((el.properties?.offset_top as number) ?? 0),
      });
    } else {
      setRect({ left: 100, top: 100 });
    }
  }, [visible, el.properties, rt.store, scope]);

  if (!visible) {
    return (
      <div style={{ display: 'none' }}>
        <div ref={domRef}>
          {children.map((c) => (
            <ElementNode key={c.id} el={c} scope={scope} parentHandle={handle} parentLayout={layout} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 950 }} onClick={() => rt.store.setVisible(handle.key, false)}>
      <div
        ref={domRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          left: rect?.left ?? 0,
          top: rect?.top ?? 0,
          ...containerCss(props),
          ...visualCss(props),
          // mesmo caso do Popup: fora do fluxo, `childCss` não roda e o padding do
          // estilo se perderia.
          ...paddingCss(props),
          minWidth: (props.min_width_css as string) ?? undefined,
          maxWidth: (props.max_width_css as string) ?? undefined,
          boxShadow: 'var(--ui_shadow_popup, 0 8px 24px rgba(0,0,0,.18))',
        }}
        data-bid={el.id}
      >
        {children.map((c) => (
          <ElementNode key={c.id} el={c} scope={scope} parentHandle={handle} parentLayout={layout} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- RepeatingGroup

// Janela progressiva do RepeatingGroup, medida em produção (/produtores, mobile): o app real
// desenha 27 células e estende de 10 em 10 conforme o usuário rola —
// 27 → 37 → 47 → 57 → 67, com a página indo de 6.563 para 15.857px. Não é um teto: a lista
// tem 174 produtores e todos continuam alcançáveis.
const JANELA_INICIAL = 27;
const LOTE = 10;

function RepeatingGroupEl({
  el,
  handle,
  scope,
  props,
  rawProps,
  css,
  domRef,
  hiddenAttr,
}: {
  el: NocodeElement;
  handle: ElementHandle;
  scope: Scope;
  props: Props;
  rawProps: Record<string, PropValue>;
  css: React.CSSProperties;
  domRef: React.RefObject<HTMLDivElement | null>;
  hiddenAttr?: string;
}) {
  const rt = useRuntime();
  const ctx = makeEvalCtx(rt, scope, handle);
  let list: unknown[] = [];
  try {
    list = toList(evaluate(rawProps.data_source, ctx));
  } catch (e) {
    console.warn('[nocode-runtime] data_source de RG falhou', el.id, e);
  }

  const fixedRows = props.fixed_rows === true;
  const rows = (props.rows as number) ?? 0;
  const columns = (props.columns as number) ?? 1;

  // "Vitrine": `fixed_rows` + `cell_min_width_css` sem `fixed_columns` — no-code encaixa
  // quantas células couberem numa linha só (grade calculada pelo NAVEGADOR, não por nós).
  // Confirmado no app real: a seção "Trabalhadores:" da home mostra 5 cards lado a lado
  // preenchendo a largura, sem seta de navegação — é o padrão "prévia" de todo card de
  // vitrine (CardTrabalhador/CardVaga/CardEmpresa/CardProdutos/CardServicos/CardPromocao/
  // Propriedades), distinto do `rows:1,fixed_rows:false` das listagens dedicadas (§ vertical,
  // já corrigido) e do `rows:5` sem `cell_min_width_css` das telas de gerenciamento (lista
  // vertical genuína, sem grade — permanece coluna).
  const cellMinW = typeof props.cell_min_width_css === 'string' && props.cell_min_width_css ? props.cell_min_width_css : undefined;
  const isVitrineRow = fixedRows && cellMinW !== undefined && props.fixed_columns !== true;

  // `container_layout` é a declaração AUTORITATIVA do responsive engine da plataforma.
  // `rows`/`columns` são resquício do engine antigo (fixed layout) e só valem como
  // heurística quando o layout NÃO foi declarado — senão um RG declarado 'column' com
  // rows:1 vira carrossel horizontal e as células estouram a largura do pai.
  const declaredLayout = typeof props.container_layout === 'string' ? props.container_layout : undefined;
  const layout = (declaredLayout ?? 'column') as ParentLayout;
  // rows:1 sem fixed_rows = "uma linha" → células fluem na horizontal (ex.: kanban)
  const singleRow = declaredLayout === undefined && (props.rows as number) === 1 && props.fixed_rows !== true;
  const horizontal =
    props.scroll_direction === 'flex_row' || props.scroll_direction === 'horizontal' || layout === 'row' || singleRow || isVitrineRow;

  // Numa vitrine, o Nº de colunas é calculado pelo NAVEGADOR (auto-fill/flex), não por
  // nós — cortar a lista em JS via `rows*columns` (o que fazíamos antes) mostrava só 1
  // item quando `columns` não estava declarado. Deixamos a lista inteira fluir e o
  // `overflow:hidden` da linha única corta visualmente o que não coube.
  const pageSize = fixedRows && rows > 0 && !isVitrineRow ? rows * Math.max(1, columns) : 0;
  const page = rt.store.rgPage.get(handle.key) ?? 0;
  let slice = pageSize > 0 ? list.slice(page * pageSize, (page + 1) * pageSize) : list;

  // Teto de células da vitrine. Ela é uma linha só que CORTA o excedente (`overflow-x:
  // hidden`), então renderizar a lista inteira só inflava o DOM: o /index saía com 16.685 nós
  // contra 780 do real, com RGs de até 109 células onde o real desenha 5 — em celular, que é
  // onde o app é usado. O teto é o que caberia na tela mais larga plausível mais folga, e por
  // isso nunca esconde nada que estivesse visível. NÃO se aplica à variante que rola
  // (`fixed_columns`), onde cortar sumiria com conteúdo alcançável pelo usuário.
  if (isVitrineRow && slice.length > 0) {
    const minW = parseFloat(cellMinW ?? '200') || 200;
    const teto = Math.ceil(2560 / minW) + 2;
    if (slice.length > teto) slice = slice.slice(0, teto);
  }

  // Janela progressiva das listas longas. A plataforma desenha um punhado de células e estende
  // conforme o usuário rola; nós desenhávamos a lista inteira, e a diferença não é sutil —
  // medido contra produção: /perfil saía 29.026px mais alto, /produtores 20.017, /produtos
  // 14.003. Uma página de 30 mil pixels no celular não passa por "igual à plataforma".
  // Cortar aqui é seguro porque a janela CRESCE: o sentinela abaixo da última célula dispara
  // o próximo lote assim que entra na viewport, então nada fica inalcançável — é o oposto do
  // corte fixo da vitrine, que só vale lá porque aquilo não rola.
  const virtualiza = !isVitrineRow && pageSize === 0;
  const [janela, setJanela] = React.useState(JANELA_INICIAL);
  const sentinelaRef = React.useRef<HTMLDivElement | null>(null);
  const total = slice.length;
  React.useEffect(() => {
    setJanela(JANELA_INICIAL); // lista trocou (filtro, busca, outra página) → volta à janela inicial
  }, [el.id, total]);
  React.useEffect(() => {
    const node = sentinelaRef.current;
    if (!virtualiza || !node || janela >= total) return;
    const io = new IntersectionObserver((entradas) => {
      if (entradas.some((e) => e.isIntersecting)) setJanela((j) => Math.min(total, j + LOTE));
    }, { rootMargin: '200px' }); // adianta o lote pouco antes do fim, como o real
    io.observe(node);
    return () => io.disconnect();
  }, [virtualiza, janela, total]);
  if (virtualiza && total > janela) slice = slice.slice(0, janela);

  const rgCss: React.CSSProperties = { ...css, display: 'flex', flexDirection: horizontal ? 'row' : 'column' };

  // RG que declara `cell_min_width_css` tem o Nº de colunas calculado pelo NAVEGADOR a partir
  // da largura disponível — então ele precisa ocupar o pai inteiro, e a plataforma ignora nele o
  // `fit_width`/`horiz_alignment`/`container_horiz_alignment` do elemento. Medido no
  // `RG Categorias` de /marketplace: declara `fit_width: true` + alinhamento `center` nos dois
  // eixos, e produção mesmo assim o renderiza com 1334px (a largura do pai), `justify-content:
  // normal` e as células em colunas fixas de 126px a partir da esquerda. Sem isto o
  // `align-self: center` travava a largura no conteúdo (722px) e jogava a fileira inteira de
  // categorias 306px para a direita. São 7 RGs com essa combinação.
  if (cellMinW !== undefined) {
    rgCss.alignSelf = 'stretch';
    rgCss.width = '100%';
    rgCss.justifyContent = undefined;
  }

  if (horizontal) {
    // vitrine = 1 linha fixa, sem scroll (itens que não couberem ficam ocultos — é o
    // "Ver tudo" que leva pra listagem completa); demais horizontais (carrossel/kanban)
    // continuam roláveis.
    rgCss.overflowX = isVitrineRow ? 'hidden' : 'auto';
    rgCss.flexWrap = 'nowrap';
    rgCss.maxWidth = '100%';
    rgCss.minWidth = 0;
    // nunca crescer além do pai — células rolam. Quando o RG dimensiona as colunas pelo
    // navegador (`cell_min_width_css`), o `100%` acima já é exatamente a largura do pai, e
    // zerar aqui devolveria a largura de conteúdo.
    if (cellMinW === undefined) rgCss.width = undefined;
  } else if (props.max_height_css) {
    // RG vertical com teto de altura: no real ele rola dentro da caixa. Sem `overflow-y` o
    // flexbox comprimia as células (que não têm `flex-shrink: 0` no ramo vertical) até a
    // altura da borda — as 81 linhas de `testcompression` viravam faixas de 8px sobrepostas,
    // ilegíveis e sem como rolar. Atinge também `RG AI_Mensagens` e `RG Automacoes` do admin.
    rgCss.overflowY = 'auto';
  }
  const cellGap = (props.row_cell_gap as number) ?? (props.column_cell_gap as number);
  if (cellGap !== undefined) rgCss.gap = cellGap;

  if (props.masonry === true || (props.fixed_columns === true && columns > 1) || props.auto_fit_column === true) {
    rgCss.display = 'grid';
    const minW = (props.cell_min_width_css as string) ?? '200px';
    rgCss.gridTemplateColumns = props.auto_fit_column
      ? `repeat(auto-fill, minmax(${minW}, 1fr))`
      : `repeat(${Math.max(1, columns)}, minmax(0, 1fr))`;
    delete rgCss.flexDirection;
  }

  const sepStyle = props.separator_style as string | undefined;
  const cellChildren = validChildren(el);

  return (
    <div ref={domRef} style={rgCss} className="nc-el nc-rg" data-bid={el.id} data-bname={el.name ?? el.default_name} data-bhidden={hiddenAttr}>
      {slice.map((item, i) => {
        const cellScope: Scope = {
          key: `${handle.key}#${page * (pageSize || 1000) + i}`,
          parent: scope,
          kind: 'cell',
          container: scope.container,
          cellItem: item,
          cellIndex: page * (pageSize || 0) + i + 1,
        };
        const cellHandle: ElementHandle = {
          id: `${el.id}#cell`,
          key: cellScope.key,
          el: { id: `${el.id}#cell`, type: 'Group', properties: {} },
          scope: cellScope,
          parentHandle: handle,
          dataGetter: () => item,
        } as ElementHandle & { dataGetter: () => unknown };
        const cellCss: React.CSSProperties = {
          position: 'relative',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: (props.container_layout as 'row' | 'column') || 'column',
          minHeight: (props.cell_min_height_css as string) ?? undefined,
          minWidth: (props.cell_min_width_css as string) ?? undefined,
          // célula de RG nunca encolhe, em nenhuma direção: na plataforma ela é dimensionada pelo
          // conteúdo. Era `horizontal ? 0 : undefined`, e o `undefined` no ramo vertical deixava
          // o flexbox espremer as células até sumirem quando o RG tinha teto de altura.
          flexShrink: 0,
          // vitrine: células crescem para preencher a linha (5 cards ocupando a largura
          // toda, como no app real) em vez de ficarem espremidas no min-width com sobra
          // de espaço vazio à direita.
          flexGrow: isVitrineRow ? 1 : undefined,
          gap: props.use_gap ? `${(props.row_gap as number) ?? 0}px ${(props.column_gap as number) ?? 0}px` : undefined,
          borderBottom:
            !horizontal && sepStyle && sepStyle !== 'none' && i < slice.length - 1
              ? `${(props.separator_width as number) ?? 1}px ${sepStyle} ${(props.separator_color as string) ?? 'var(--ui_separador, rgba(0,0,0,.1))'}`
              : undefined,
        };
        return (
          <div key={i} style={cellCss} className="nc-rg-cell">
            <CellRegister handle={cellHandle} />
            {cellChildren.map((c) => (
              <ElementNode key={c.id} el={c} scope={cellScope} parentHandle={cellHandle} parentLayout={layout === 'row' ? 'row' : 'column'} />
            ))}
          </div>
        );
      })}
      {slice.length === 0 ? <div style={{ minHeight: 8 }} /> : null}
      {/* Sentinela da janela progressiva: entra na viewport → carrega o próximo lote.
          `flexShrink: 0` porque a célula do RG também tem, e sem isso ele seria espremido a
          zero num container com teto de altura e nunca dispararia. */}
      {virtualiza && janela < total ? (
        <div ref={sentinelaRef} aria-hidden style={{ minHeight: 1, flexShrink: 0 }} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- Table (elemento nativo, ev5)
// Estrutura no export: filhos TableMainAxis (colunas; axis_index + min_width_css),
// TableCrossAxis (linhas; cross_axis_repeat = linha-template iterada pelo data_source)
// e TableCell (cell_main_axis_id referencia o campo `id` do TableMainAxis).

function TableEl({
  el,
  handle,
  scope,
  props,
  rawProps,
  css,
  domRef,
  hiddenAttr,
}: {
  el: NocodeElement;
  handle: ElementHandle;
  scope: Scope;
  props: Props;
  rawProps: Record<string, PropValue>;
  css: React.CSSProperties;
  domRef: React.RefObject<HTMLDivElement | null>;
  hiddenAttr?: string;
}) {
  const rt = useRuntime();
  const ctx = makeEvalCtx(rt, scope, handle);
  const kids = Object.values(el.elements ?? {}).filter(
    (c): c is NocodeElement => !!c && typeof c === 'object' && typeof (c as NocodeElement).type === 'string',
  );
  const cols = kids
    .filter((c) => c.type === 'TableMainAxis')
    .sort((a, b) => ((a.properties?.axis_index as number) ?? 0) - ((b.properties?.axis_index as number) ?? 0));
  const rowDefs = kids
    .filter((c) => c.type === 'TableCrossAxis')
    .sort((a, b) => ((a.properties?.axis_index as number) ?? 0) - ((b.properties?.axis_index as number) ?? 0));

  let list: unknown[] = [];
  try {
    list = toList(evaluate(rawProps.data_source, ctx));
  } catch (e) {
    console.warn('[nocode-runtime] data_source de Table falhou', el.id, e);
  }

  const template = cols
    .map((c) => {
      const w = (c.properties?.min_width_css as string) || '';
      if (!w) return 'minmax(60px, 1fr)';
      return c.properties?.single_width ? w : `minmax(${w}, 1fr)`;
    })
    .join(' ');

  const renderRow = (
    rowEl: NocodeElement,
    rowScope: Scope,
    rowParent: ElementHandle,
    key: React.Key,
    extraCss?: React.CSSProperties,
  ) => {
    const rp = rowEl.properties ?? {};
    const cells = Object.values(rowEl.elements ?? {}).filter(
      (c): c is NocodeElement => !!c && typeof c === 'object' && (c as NocodeElement).type === 'TableCell',
    );
    const rowCss: React.CSSProperties = {
      display: 'grid',
      gridTemplateColumns: template,
      minHeight: (rp.min_height_css as string) ?? undefined,
      background: rp.background_style === 'bgcolor' ? (rp.bgcolor as string) : undefined,
      ...(rp.make_sticky ? { position: 'sticky' as const, top: 0, zIndex: 2 } : {}),
      ...extraCss,
    };
    return (
      <div key={key} style={rowCss} className="nc-table-row">
        {cols.map((col) => {
          const cell = cells.find((c) => c.properties?.cell_main_axis_id === col.id);
          if (!cell) return <div key={col.id} />;
          const layout: 'row' | 'column' = (cell.properties?.container_layout as string) === 'column' ? 'column' : 'row';
          const cellCss: React.CSSProperties = {
            position: 'relative',
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: layout,
            alignItems: props.vertical_centering ? 'center' : undefined,
            minWidth: 0,
            overflow: 'hidden',
          };
          return (
            <div key={col.id} style={cellCss} className="nc-table-cell">
              {validChildren(cell).map((c) => (
                <ElementNode key={c.id} el={c} scope={rowScope} parentHandle={rowParent} parentLayout={layout} />
              ))}
            </div>
          );
        })}
      </div>
    );
  };

  const out: React.ReactNode[] = [];
  for (const rowEl of rowDefs) {
    if (rowEl.properties?.cross_axis_repeat) {
      list.forEach((item, i) => {
        const cellScope: Scope = {
          key: `${handle.key}#${rowEl.id}#${i}`,
          parent: scope,
          kind: 'cell',
          container: scope.container,
          cellItem: item,
          cellIndex: i + 1,
        };
        const cellHandle: ElementHandle = {
          id: `${el.id}#cell`,
          key: cellScope.key,
          el: { id: `${el.id}#cell`, type: 'Group', properties: {} },
          scope: cellScope,
          parentHandle: handle,
          dataGetter: () => item,
        } as ElementHandle & { dataGetter: () => unknown };
        out.push(
          <React.Fragment key={`${rowEl.id}#${i}`}>
            <CellRegister handle={cellHandle} />
            {renderRow(rowEl, cellScope, cellHandle, `${rowEl.id}#${i}#row`, {
              borderBottom: i < list.length - 1 ? '1px solid var(--ui_divisor, rgba(0,0,0,.06))' : undefined,
            })}
          </React.Fragment>,
        );
      });
    } else {
      out.push(renderRow(rowEl, scope, handle, rowEl.id));
    }
  }

  return (
    <div
      ref={domRef}
      style={{ ...css, display: 'flex', flexDirection: 'column', overflow: 'auto' }}
      className="nc-el nc-table"
      data-bid={el.id}
      data-bname={el.name ?? el.default_name}
      data-bhidden={hiddenAttr}
    >
      {out}
      {list.length === 0 ? <div style={{ minHeight: 8 }} /> : null}
    </div>
  );
}

function CellRegister({ handle }: { handle: ElementHandle }) {
  const rt = useRuntime();
  useEffect(() => {
    rt.store.register(handle);
    return () => rt.store.unregister(handle);
  }, [rt.store, handle]);
  return null;
}

// ---------------------------------------------------------------- Reusable (CustomElement)

function ReusableEl({
  el,
  handle,
  scope,
  props,
  css,
  domRef,
  onClick,
  hiddenAttr,
}: {
  el: NocodeElement;
  handle: ElementHandle;
  scope: Scope;
  props: Props;
  css: React.CSSProperties;
  domRef: React.RefObject<HTMLDivElement | null>;
  onClick?: (e: React.MouseEvent) => void;
  hiddenAttr?: string;
}) {
  const rt = useRuntime();
  const defId = el.properties?.custom_id as string | undefined;
  const def: ElementDefinition | undefined = defId ? rt.payload.definitions[defId] : undefined;

  // Reusable ancorado numa borda da viewport (header/bottom nav) sai do fluxo com
  // `position: fixed`. Sem devolver esse espaço, o conteúdo da página corre POR BAIXO dele:
  // o nav cobre o rodapé dos cards e o header cobre o topo. Medimos a altura real e
  // renderizamos um espaçador na posição original do elemento.
  //
  // A condição tem que ser a MESMA que decide fixar (definição `FloatingGroup`) — senão o
  // espaçador reserva espaço para um header que rola junto com a página, empurrando todo o
  // conteúdo para baixo sem motivo.
  //
  // Só vale para o topo. Um grupo ancorado no RODAPÉ é declarado na ordem em que o editor o
  // colocou — no /index ele vem logo depois do header —, então o espaçador caía no MEIO da
  // página e empurrava tudo 60px para baixo. Medido: o real e o nosso terminam com os mesmos
  // 257px de folga abaixo do último conteúdo (é padding de página, não espaçador), e a página
  // inteira saía 60px mais alta só por causa disso. O rodapé fixo não precisa de reserva.
  const floatRefDecl = ((def?.properties as Props | undefined)?.floating_reference
    ?? el.properties?.floating_reference) as string | undefined;
  const ancorado =
    (def?.properties as Props | undefined)?.element_type === 'FloatingGroup' &&
    floatRefDecl === 'top';
  const [alturaFixa, setAlturaFixa] = React.useState(0);
  useEffect(() => {
    const node = domRef.current;
    if (!ancorado || !node) return;
    // O espaçador só empurra conteúdo se houver conteúdo DEPOIS dele. Quando o editor declara
    // o header por último (é o caso do /minhaconta), o espaçador cai no fim da página e vira
    // altura morta: medido contra produção, a página saía 1394 onde o real dá 1294, com TODOS
    // os elementos já batendo no pixel. Sem irmão seguinte, não reserva nada.
    const temConteudoDepois = () => {
      let irmao = node.nextElementSibling;
      while (irmao) {
        if (irmao.getAttribute('data-espacador') == null && irmao.getBoundingClientRect().height > 0) return true;
        irmao = irmao.nextElementSibling;
      }
      return false;
    };
    const medir = () => setAlturaFixa(temConteudoDepois() ? node.getBoundingClientRect().height : 0);
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(node);
    return () => ro.disconnect();
  }, [ancorado, domRef]);

  const reusableScope = useMemo<Scope | null>(() => {
    if (!def) return null;
    const params: Record<string, () => unknown> = {};
    const decls = (def.properties?.parameters as unknown as Record<string, { param_id?: string; default_value?: unknown }>) ?? {};
    for (const decl of Object.values(decls)) {
      const pid = decl?.param_id;
      if (!pid) continue;
      params[pid] = () => {
        const raw = el.properties?.[`param_${pid}`];
        const parentCtx = makeEvalCtx(rt, scope, handle.parentHandle);
        if (raw !== undefined) return evaluate(raw, parentCtx);
        if (decl.default_value !== undefined) return evaluate(decl.default_value, parentCtx);
        return null;
      };
    }
    return {
      key: `${handle.key}/d`,
      parent: scope,
      kind: 'reusable',
      container: def,
      reusableParams: params,
      reusableInstanceKey: handle.key,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def, el, scope, handle.key]);

  // registra alias com o id da definição (GetElement "este reusable")
  // Alias com o id da DEFINIÇÃO — é como `GetElement "este reusable"` e as ações sem
  // `element_id` encontram o container.
  const alias = useMemo<ElementHandle | null>(
    () => (def?.id ? { ...handle, id: def.id, scope: reusableScope ?? scope } : null),
    [def?.id, handle, reusableScope, scope],
  );
  // Registrado DURANTE O RENDER, não em effect: o `PageLoaded` do próprio reusable é
  // disparado pelo ContainerWorkflows (filho) num layout effect, que roda ANTES do
  // useEffect deste componente. Registrando só no effect, o workflow não acha o alvo e o
  // SetCustomState do container é descartado em silêncio — era o que deixava o carrossel
  // de anunciante vazio: as fotos eram calculadas e nunca gravadas.
  if (alias) rt.store.register(alias);
  useEffect(() => () => { if (alias) rt.store.unregister(alias); }, [alias, rt.store]);

  if (!def || !reusableScope) {
    return (
      <div ref={domRef} style={css} className="nc-plugin-placeholder">
        reusable {defId ?? '?'} indisponível
      </div>
    );
  }

  // props da DEFINIÇÃO do reusable também podem ser expressão (ex.: background_image
  // ligado ao CurrentUser's foto_image) — avaliar no escopo do próprio reusable.
  const defProps = evalVisualProps(
    (def.properties ?? {}) as Record<string, PropValue>,
    makeEvalCtx(rt, reusableScope, handle),
  );

  // reusable do tipo Popup: oculto por padrão, abre como overlay via Show/Hide na instância
  if (defProps.element_type === 'Popup') {
    const popupVisible = rt.store.visibilityOverride.get(handle.key) ?? false;
    const innerLayoutP = ((defProps.container_layout as string) || 'column') as ParentLayout;
    const boxCss: React.CSSProperties = {
      ...containerCss(defProps),
      ...visualCss(defProps),
      boxSizing: 'border-box',
      position: 'relative',
      width: '100%',
      maxWidth: (props.max_width_css as string) ?? (defProps.max_width_px ? `${defProps.max_width_px}px` : '500px'),
      minWidth: (props.min_width_css as string) ?? (defProps.min_width_px ? `${defProps.min_width_px}px` : undefined),
      minHeight: (props.min_height_css as string) ?? undefined,
      maxHeight: '92vh',
      overflowY: 'auto',
      margin: 'auto',
      background: 'var(--color_surface_default)',
      borderRadius: raioToken(10),
      padding: defProps.padding_top === undefined ? 16 : undefined,
    };
    const kids = validChildren(def as unknown as NocodeElement);
    const body = (
      <div ref={domRef} style={boxCss} onClick={(e) => e.stopPropagation()} data-bid={el.id} data-def={defId}>
        <ContainerWorkflows scope={reusableScope} thisHandle={handle} />
        {kids.map((c) => (
          <ElementNode key={c.id} el={c} scope={reusableScope} parentHandle={handle} parentLayout={innerLayoutP} />
        ))}
      </div>
    );
    if (!popupVisible) return <div style={{ display: 'none' }}>{body}</div>;
    return (
      <div
        className="nc-popup-overlay"
        style={{ background: 'var(--ui_overlay, rgba(0,0,0,0.6))', alignItems: 'center' }}
        onClick={() => rt.store.setVisible(handle.key, false)}
      >
        {body}
      </div>
    );
  }
  const innerLayout = ((defProps.container_layout as string) || 'column') as ParentLayout;
  const innerCss: React.CSSProperties = {
    ...containerCss(defProps),
    ...visualCss(defProps),
    boxSizing: 'border-box',
    position: 'relative',
    width: '100%',
    minHeight: '100%',
  };
  // O root de um reusable, quando não tem NEM `background_style` NEM `bgcolor` declarados
  // (nem estilo nomeado — `def.style` ausente), renderiza BRANCO opaco na plataforma: é o fundo
  // padrão do canvas do editor, não transparência. Verificado no app em produção — o
  // bottom-nav (`Footer`) não declara bg nenhum e ainda é branco, cobrindo o conteúdo por
  // baixo. Sem isto o nav/header fixo ficam transparentes e o texto da página passa por
  // trás deles. Escopado ao ROOT do reusable (não a elementos comuns, que corretamente
  // ficam transparentes por padrão — só o "canvas" do reusable tem esse default da plataforma).
  if (
    innerCss.backgroundColor === undefined &&
    defProps.background_style === undefined &&
    defProps.bgcolor === undefined
  ) {
    innerCss.backgroundColor = 'var(--ui_surface, rgba(255,255,255,1))';
  }

  // Quem FIXA na viewport é o `element_type` da DEFINIÇÃO, não o nome nem a instância.
  //
  // O `floating_reference: 'top'` que aparece em 56 instâncias é resíduo do editor: na plataforma,
  // um reusable só flutua se a definição for `FloatingGroup`. Só 6 das 53 definições deste app
  // são (`Footer`, `FooterMobile`, `Menu`, `headerProdutos`, `header_editarconta`,
  // `offline_banner`); `header`, `Header_comun`, `HeaderTermos&Condicoes` e `Header_mobile(i)`
  // são `Group` comum e ROLAM com a página.
  //
  // Verificado nos dois apps a 1366x768, rolando 900px: `/marketplace` (usa `header`, Group) não
  // tem nada fixo no topo em produção; `/produtos` (usa `headerProdutos`, FloatingGroup) tem um
  // header fixo de 77px. A heurística antiga (`def.name` contém "head") fixava os dois.
  //
  // A borda vem do `floating_reference` da definição, com fallback na instância — as definições
  // FloatingGroup deste app nem sempre declaram a borda (`headerProdutos` não declara; a
  // instância diz 'top').
  const defEhFlutuante = (def.properties as Props | undefined)?.element_type === 'FloatingGroup';
  const floatRef = ((def.properties as Props | undefined)?.floating_reference
    ?? el.properties?.floating_reference) as string | undefined;
  const outerCss = { ...css };
  if (defEhFlutuante && floatRef === 'top') {
    outerCss.position = 'fixed' as const;
    outerCss.top = 0;
    outerCss.left = 0;
    outerCss.right = 0;
    outerCss.zIndex = 900;
  } else if (defEhFlutuante && (floatRef === 'bottom' || floatRef === 'both')) {
    // bottom nav: sem isto o reusable cai no fluxo e, em páginas onde vem cedo na ordem,
    // aparece colado no topo sobre o header; nas longas, só aparece ao rolar até o fim.
    outerCss.position = 'fixed' as const;
    outerCss.left = 0;
    outerCss.right = 0;
    outerCss.bottom = 0;
    outerCss.zIndex = 900;
    if (floatRef === 'both') outerCss.top = 0;
  }

  const children = validChildren(def as unknown as NocodeElement);
  const corpo = (
    <div ref={domRef} style={outerCss} className="nc-el nc-reusable" data-bid={el.id} data-def={defId} onClick={onClick} data-bhidden={hiddenAttr}>
      <div style={innerCss}>
        <ContainerWorkflows scope={reusableScope} thisHandle={handle} />
        {children.map((c) => (
          <ElementNode key={c.id} el={c} scope={reusableScope} parentHandle={handle} parentLayout={innerLayout} />
        ))}
      </div>
    </div>
  );
  // devolve ao fluxo o espaço que o elemento ancorado ocuparia (ver comentário no topo)
  if (ancorado && outerCss.position === 'fixed' && alturaFixa > 0) {
    return (
      <>
        {corpo}
        <div aria-hidden="true" style={{ height: alturaFixa, flexShrink: 0 }} data-espacador={defId} />
      </>
    );
  }
  return corpo;
}

// ---------------------------------------------------------------- Inputs

function InputEl({
  el,
  handle,
  scope,
  props,
  rawProps,
  css,
  domRef,
  hoverProps,
  hiddenAttr,
}: {
  el: NocodeElement;
  handle: ElementHandle;
  scope: Scope;
  props: Props;
  rawProps: Record<string, PropValue>;
  css: React.CSSProperties;
  domRef: React.RefObject<HTMLDivElement | null>;
  hoverProps: Record<string, unknown>;
  hiddenAttr?: string;
}) {
  const rt = useRuntime();
  const ctx = makeEvalCtx(rt, scope, handle);
  const placeholder = rawProps.placeholder != null ? coerceText(evaluate(rawProps.placeholder, ctx), ctx) : '';
  const uniqueId = rawProps.unique_id != null ? coerceText(evaluate(rawProps.unique_id, ctx), ctx) : undefined;
  const stored = rt.store.inputValues.get(handle.key);
  const disabled = toBool(evaluate(rawProps.disabled, ctx));

  const changeWorkflows = useMemo(
    () => findWorkflows(scope, el.id).filter((w) => w.type === 'InputChanged'),
    [scope, el.id],
  );
  const fireChanged = () => {
    for (const wf of changeWorkflows) void runWorkflow(wf, rt.env, scope, handle);
  };
  const setValue = (v: unknown) => {
    rt.store.setInputValue(handle.key, v);
  };

  const innerStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    border: 'none',
    outline: 'none',
    background: 'transparent',
    fontFamily: css.fontFamily,
    fontSize: css.fontSize ?? 14,
    fontWeight: css.fontWeight,
    color: css.color ?? 'var(--color_text_default)',
    padding: 0,
  };

  const focusProps = {
    onFocus: () => rt.store.setFocused(handle.key),
    onBlur: () => {
      rt.store.setFocused(null);
      fireChanged();
    },
  };

  const wrapper = (inner: React.ReactNode) => (
    <div
      ref={domRef}
      id={uniqueId}
      style={
        {
          ...css,
          display: 'flex',
          alignItems: 'center',
          // `::placeholder` é pseudo-elemento: não dá para estilizar por `style` inline. A cor
          // vai como custom property e a regra em globals.css a consome — sem isso o
          // placeholder saía no cinza padrão do Chromium em vez da cor do estilo da plataforma.
          ...(typeof props.placeholder_color === 'string'
            ? { '--ph-color': props.placeholder_color }
            : null),
        } as React.CSSProperties
      }
      className="nc-el nc-input"
      data-bhidden={hiddenAttr}
      data-bid={el.id}
      data-bname={el.name ?? el.default_name}
      {...hoverProps}
    >
      {inner}
    </div>
  );

  switch (el.type) {
    case 'MultiLineInput':
      // O wrapper é `display:flex; align-items:center`, então `height:100%` no textarea não
      // resolvia contra nada e ele ficava com as 2 linhas do conteúdo, deixando ~60px da caixa
      // mortos. `align-self:stretch` + `flex:1` fazem a área de digitação ocupar a caixa toda.
      return wrapper(
        <textarea
          style={{ ...innerStyle, resize: 'none', height: 'auto', alignSelf: 'stretch', flex: '1 1 auto' }}
          placeholder={placeholder}
          value={(stored as string) ?? coerceText(evaluate(rawProps.content, ctx), ctx)}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled}
          {...focusProps}
        />,
      );

    case 'DateInput': {
      const isDateTime = rawProps.input_type === 'date_time';
      return wrapper(
        <input
          type={isDateTime ? 'datetime-local' : 'date'}
          style={innerStyle}
          value={(stored as string) ?? ''}
          onChange={(e) => {
            setValue(e.target.value ? new Date(e.target.value) : null);
          }}
          disabled={disabled}
          {...focusProps}
        />,
      );
    }

    case 'Dropdown':
    case 'AutocompleteDropdown': {
      let options: { label: string; value: unknown }[] = [];
      if (rawProps.choices_style === 'dynamic' || rawProps.data_source != null) {
        const list = toList(evaluate(rawProps.data_source, ctx));
        options = list.map((item) => {
          let label: string;
          if (rawProps.option_display_expression != null) {
            ctx.injected.push(item);
            label = coerceText(evaluate(rawProps.option_display_expression, ctx), ctx);
            ctx.injected.pop();
          } else {
            label = coerceText(item, ctx);
          }
          return { label, value: item };
        });
      } else if (typeof rawProps.choices === 'string') {
        options = (rawProps.choices as string)
          .split('\n')
          .filter(Boolean)
          .map((line) => ({ label: line, value: line }));
      }
      const selIdx = options.findIndex((o) => {
        const v = o.value;
        if (stored == null) return false;
        if (isOption(v) && isOption(stored)) return v.entry.key === (stored as typeof v).entry.key;
        if (v && typeof v === 'object' && '_id' in (v as object) && stored && typeof stored === 'object' && '_id' in (stored as object))
          return (v as { _id: string })._id === (stored as { _id: string })._id;
        return v === stored;
      });
      // default
      const defaultIdx =
        selIdx === -1 && rawProps.default != null
          ? (() => {
              const d = evaluate(rawProps.default, ctx);
              return options.findIndex((o) => {
                if (isOption(o.value) && isOption(d)) return o.value.entry.key === (d as typeof o.value).entry.key;
                return o.value === d;
              });
            })()
          : -1;
      const effIdx = selIdx >= 0 ? selIdx : defaultIdx;
      return wrapper(
        <select
          style={{ ...innerStyle, appearance: 'auto' as const, cursor: 'pointer' }}
          value={effIdx >= 0 ? String(effIdx) : ''}
          onChange={(e) => {
            const idx = parseInt(e.target.value);
            setValue(Number.isNaN(idx) ? null : options[idx]?.value);
            setTimeout(fireChanged, 0);
          }}
          disabled={disabled}
          {...focusProps}
        >
          <option value="" disabled hidden>
            {placeholder || 'Selecione...'}
          </option>
          {options.map((o, i) => (
            <option key={i} value={String(i)}>
              {o.label}
            </option>
          ))}
        </select>,
      );
    }

    case 'Checkbox': {
      const label = rawProps.label != null ? coerceText(evaluate(rawProps.label, ctx), ctx) : '';
      return wrapper(
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: css.fontSize ?? 14, color: css.color }}>
          <input
            type="checkbox"
            checked={toBool(stored)}
            onChange={(e) => {
              setValue(e.target.checked);
              setTimeout(fireChanged, 0);
            }}
            disabled={disabled}
            style={{ accentColor: 'var(--color_primary_default)' }}
          />
          {label}
        </label>,
      );
    }

    case 'RadioButtons': {
      let options: { label: string; value: unknown }[] = [];
      if (typeof rawProps.choices === 'string') {
        options = (rawProps.choices as string).split('\n').filter(Boolean).map((l) => ({ label: l, value: l }));
      } else if (rawProps.data_source != null) {
        options = toList(evaluate(rawProps.data_source, ctx)).map((item) => ({ label: coerceText(item, ctx), value: item }));
      }
      return wrapper(
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${(rawProps.columns as number) ?? 1}, 1fr)`, gap: 6, width: '100%' }}>
          {options.map((o, i) => (
            <label key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: css.fontSize ?? 14, color: css.color }}>
              <input
                type="radio"
                checked={stored === o.value || coerceText(stored, ctx) === o.label}
                onChange={() => {
                  setValue(o.value);
                  setTimeout(fireChanged, 0);
                }}
                style={{ accentColor: 'var(--color_primary_default)' }}
              />
              {o.label}
            </label>
          ))}
        </div>,
      );
    }

    case 'PictureInput':
    case 'FileInput': {
      const src = rawProps.src != null ? coerceText(evaluate(rawProps.src, ctx), ctx) : '';
      const current = (stored as string) ?? src;
      return wrapper(
        <label
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            overflow: 'hidden',
            minHeight: 40,
            backgroundImage: current ? `url("${normalizeAssetUrl(current)}")` : undefined,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            color: css.color,
            fontSize: 13,
          }}
        >
          {!current && (placeholder || 'Enviar arquivo')}
          <input
            type="file"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                setValue(URL.createObjectURL(f));
                setTimeout(fireChanged, 0);
              }
            }}
          />
        </label>,
      );
    }

    default: {
      // Input
      const fmt = rawProps.content_format as string | undefined;
      const type = fmt === 'password' ? 'password' : fmt === 'email' ? 'email' : 'text';
      const inputMode = fmt && ['int_number', 'float_number', 'currency', 'numerical_ref'].includes(fmt) ? 'decimal' : undefined;
      const initial = rawProps.content != null ? coerceText(evaluate(rawProps.content, ctx), ctx) : '';
      return wrapper(
        <input
          type={type}
          inputMode={inputMode}
          style={innerStyle}
          placeholder={placeholder}
          value={stored !== undefined ? coerceText(stored, ctx) : initial}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled}
          {...focusProps}
        />,
      );
    }
  }
}

// ---------------------------------------------------------------- Plugins

// Player de Lottie via lottie-web (carregado sob demanda do CDN). Fallback: check-circle verde.
function LottiePlayer({ url }: { url: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = React.useState(false);
  useEffect(() => {
    if (!url || !ref.current) return;
    let anim: { destroy: () => void } | null = null;
    let cancelled = false;
    const load = async () => {
      try {
        const w = window as unknown as { lottie?: { loadAnimation: (o: object) => { destroy: () => void } } };
        if (!w.lottie) {
          await new Promise<void>((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js';
            s.onload = () => resolve();
            s.onerror = () => reject(new Error('lottie load failed'));
            document.head.appendChild(s);
          });
        }
        if (cancelled || !ref.current || !w.lottie) return;
        anim = w.lottie.loadAnimation({ container: ref.current, renderer: 'svg', loop: true, autoplay: true, path: url });
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    void load();
    return () => {
      cancelled = true;
      anim?.destroy();
    };
  }, [url]);
  if (failed || !url) return <NocodeIcon icon="feather check-circle" size={48} color="var(--color_success_default)" />;
  return <div ref={ref} style={{ width: '100%', height: '100%' }} />;
}

const HEROICON_TO_FEATHER: Record<string, string> = {
  'building-office': 'home',
  'building-office-2': 'home',
  home: 'home',
  'user-group': 'users',
  users: 'users',
  user: 'user',
  'currency-dollar': 'dollar-sign',
  banknotes: 'dollar-sign',
  'calendar-days': 'calendar',
  calendar: 'calendar',
  ticket: 'tag',
  'chart-bar': 'bar-chart-2',
  cog: 'settings',
  'cog-6-tooth': 'settings',
  'arrow-left-on-rectangle': 'log-out',
  'arrow-right-on-rectangle': 'log-in',
  'magnifying-glass': 'search',
  'x-mark': 'x',
  plus: 'plus',
  'qr-code': 'grid',
  'squares-2x2': 'grid',
  bell: 'bell',
  envelope: 'mail',
  'chevron-down': 'chevron-down',
  'chevron-right': 'chevron-right',
  'chevron-left': 'chevron-left',
  'ellipsis-vertical': 'more-vertical',
  trash: 'trash-2',
  pencil: 'edit-2',
  'pencil-square': 'edit',
  eye: 'eye',
  'eye-slash': 'eye-off',
  'check-circle': 'check-circle',
  'information-circle': 'info',
  'exclamation-triangle': 'alert-triangle',
  church: 'home',
  'heart': 'heart',
  'baby': 'smile',
  'identification': 'credit-card',
  'credit-card': 'credit-card',
  wallet: 'credit-card',
  'device-phone-mobile': 'smartphone',
  link: 'link',
  'cloud-arrow-up': 'upload-cloud',
  'arrow-path': 'refresh-cw',
  'clipboard-document': 'clipboard',
  'document-text': 'file-text',
  'table-cells': 'grid',
  'list-bullet': 'list',
  funnel: 'filter',
  'lock-closed': 'lock',
};

function PluginEl({
  el,
  handle,
  scope,
  props,
  rawProps,
  css,
  domRef,
  onClick,
  hiddenAttr,
}: {
  el: NocodeElement;
  handle: ElementHandle;
  scope: Scope;
  props: Props;
  rawProps: Record<string, PropValue>;
  css: React.CSSProperties;
  domRef: React.RefObject<HTMLDivElement | null>;
  onClick?: (e: React.MouseEvent) => void;
  hiddenAttr?: string;
}) {
  const rt = useRuntime();
  const ctx = makeEvalCtx(rt, scope, handle);
  const common = { ref: domRef, style: css, onClick, 'data-bid': el.id, 'data-btype': el.type, 'data-bhidden': hiddenAttr };

  // plugins de utilidade invisíveis (Toolbox Expression/ListofNumbers, FuseSearch,
  // CurrentCell, MaskInput controller, etc.) — não ocupam espaço visual
  const INVISIBLE_PLUGIN_PREFIXES = [
    '1488796042609x768734193128308700', // Toolbox
    '1642860987916x663125148641001500', // FuseSearch
    '1621620842517x631518911144919000', // CurrentCell
    '1609444246883x924984661248573400', // MaskInput controller
    '1611420341171x644172687243214800', // util
    '1518210929812x400234755795189800', // util PageLoaded
    '1531310660066x700901076712292400', // reveal password controller
    '1648430145817x673906689668022300', // element → PDF/IMG (download de ingresso)
    '1515542335452x628730204959539200', // Search & Autocorrect (fuzzy search controller)
    '1617739938396x841575603972341800', // LocalStorage UX (utilitário invisível)
    '1594298820861x867298332432138200', // Dates Generator (utilitário invisível)
    '1609955761273x917979328551059500', // CreateFile / Databases (utilitário invisível)
    '1671828254560x731779951069495300', // AnyTextToList (conversor texto→lista, invisível)
    '1512987045178x955858951313817600', // GetJSON (busca/parse de JSON, utilitário invisível)
    '1676907361630x802158243928080400', // IP Address finder (utilitário invisível)
    '1633100358403x239657077467774980', // CountDown timer (dispara evento, sem visual)
    '1560368242016x296188327396638700', // Card Validator (valida nº de cartão, invisível)
    '1577723723112x940641204980154400', // RG Reverse Scroll (controla scroll de RG, invisível)
    '1616505732428x765409544138915800', // PWA (install prompt / service worker, sem visual)
    '1627152028063x152738721905770500', // Image Compressor (comprime antes do upload, invisível)
    '1633128679598x797103101413949400', // ViaCep (consulta CEP → preenche endereço, invisível)
    'draggableui-DroppedOn', // Drag&Drop: listener de evento "dropped on" (sem visual)
  ];
  if (INVISIBLE_PLUGIN_PREFIXES.some((p) => el.type.startsWith(p))) {
    return <div ref={domRef} style={{ display: 'none' }} data-bid={el.id} data-btype={el.type} />;
  }

  // Plugins-CONTAINER (drag&drop e afins): têm filhos próprios + data_source/group_type —
  // renderizam como Group comum (o dado do grupo resolve via groupDataOf, drag estático).
  if (el.type.startsWith('draggableui-Dropzone') || el.type.startsWith('draggableui-DroppableGroup')) {
    const layout = ((props.container_layout as string) || 'column') as ParentLayout;
    return (
      <div {...common} className="nc-el" style={css}>
        {validChildren(el).map((c) => (
          <ElementNode key={c.id} el={c} scope={scope} parentHandle={handle} parentLayout={layout} />
        ))}
      </div>
    );
  }

  // Icon plugin (1649513217691x... v3.2.1) — prop ABH = nome do ícone, ABK = cor, ABJ = tamanho
  if (el.type.startsWith('1649513217691x427261680952541200')) {
    const name = rawProps.ABH != null ? coerceText(evaluate(rawProps.ABH, ctx), ctx) : 'circle';
    const size = (props.ABJ as number) ?? (parseInt(String(props.min_height_css ?? 24)) || 24);
    const color = typeof props.ABK === 'string' ? props.ABK : 'var(--color_text_default)';
    // nome cru (ex.: "search") → tentar feather (set dominante do app); fallback fa
    const icon = /\s/.test(name) ? name : `feather ${name}`;
    return (
      <div {...common} className="nc-el" style={{ ...css, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <NocodeIcon icon={icon} size={Math.max(12, size)} color={color} />
      </div>
    );
  }

  // AudioPlayer (1624266878789x...) — ACy = URL do áudio, ADC = cor de destaque
  if (el.type.startsWith('1624266878789x498778585697091600')) {
    const src = rawProps.ACy != null ? coerceText(evaluate(rawProps.ACy, ctx), ctx).trim() : '';
    return (
      <div {...common} className="nc-el" style={{ ...css, display: 'flex', alignItems: 'center' }}>
        <audio controls src={src ? normalizeAssetUrl(src) : undefined} style={{ width: '100%', height: 36 }} />
      </div>
    );
  }

  // VideoPlayer (1603892204719x...) — AAF = URL do vídeo (arquivo ou YouTube)
  if (el.type.startsWith('1603892204719x873816525564805100')) {
    const src = rawProps.AAF != null ? coerceText(evaluate(rawProps.AAF, ctx), ctx).trim() : '';
    const ytm = src.match(/(?:youtu\.be\/|v=)([\w-]{6,})/);
    return (
      <div {...common} className="nc-el" style={{ ...css, overflow: 'hidden' }}>
        {ytm ? (
          <iframe
            src={`https://www.youtube.com/embed/${ytm[1]}`}
            style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
            allowFullScreen
            title={el.name ?? 'video'}
          />
        ) : src ? (
          <video controls src={normalizeAssetUrl(src)} style={{ width: '100%', height: '100%', display: 'block' }} />
        ) : null}
      </div>
    );
  }

  // Feather Icon plugin (1553889862898x... v1.x) — prop AAP = nome do ícone feather nativo
  if (el.type.startsWith('1553889862898x186125300131692540')) {
    const name = rawProps.AAP != null ? coerceText(evaluate(rawProps.AAP, ctx), ctx) : 'circle';
    const sizeRaw = parseInt(String(props.min_height_css ?? props.min_width_css ?? props.height ?? 18));
    const size = Number.isNaN(sizeRaw) ? 18 : sizeRaw;
    const color = typeof props.AAQ === 'string' ? props.AAQ : 'currentColor';
    return (
      <div {...common} className="nc-el" style={{ ...css, display: 'flex', alignItems: 'center', justifyContent: 'center', color }}>
        <NocodeIcon icon={`feather ${name || 'circle'}`} size={Math.max(12, size)} color={color} />
      </div>
    );
  }

  // Icon Button plugin (1646133638573x...) — AAD = nome do ícone, AAE = cor
  if (el.type.startsWith('1646133638573x643162624276561900')) {
    const raw = rawProps.AAD != null ? coerceText(evaluate(rawProps.AAD, ctx), ctx) : 'circle';
    // nomes podem vir de outros sets (ex. "plus-lg" do bootstrap) → normaliza p/ feather
    const name = raw.replace(/-(lg|sm|fill|outline)$/, '') || 'circle';
    const color = typeof props.AAE === 'string' ? props.AAE : 'currentColor';
    const sizeRaw = parseInt(String(props.min_height_css ?? props.height ?? 20));
    return (
      <div {...common} className="nc-el" style={{ ...css, display: 'flex', alignItems: 'center', justifyContent: 'center', color, cursor: onClick ? 'pointer' : undefined }}>
        <NocodeIcon icon={`feather ${name}`} size={Math.max(12, Number.isNaN(sizeRaw) ? 20 : sizeRaw)} color={color} />
      </div>
    );
  }

  // Color Picker (1498952719168x...) — seletor de cor nativo
  if (el.type.startsWith('1498952719168x889602776416649200')) {
    const stored = rt.store.inputValues.get(handle.key);
    const value = typeof stored === 'string' && /^#/.test(stored) ? stored : '#000000';
    return (
      <div {...common} className="nc-el" style={{ ...css, display: 'flex', alignItems: 'center' }}>
        <input
          type="color"
          defaultValue={value}
          onChange={(e) => rt.store.setInputValue(handle.key, e.target.value)}
          style={{ width: '100%', height: '100%', minHeight: 28, border: 'none', background: 'none', padding: 0, cursor: 'pointer' }}
        />
      </div>
    );
  }

  // Multi-File Uploader (multifileupload-MultiFileInput) — input de múltiplos arquivos
  if (el.type === 'multifileupload-MultiFileInput') {
    return (
      <div {...common} className="nc-el" style={{ ...css, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <input type="file" multiple style={{ width: '100%', fontSize: 13 }} />
      </div>
    );
  }

  // File & MultiFile Uploader (1643847782395x...) — AAg = extensões aceitas ("png, jpeg"),
  // AAi = máximo de arquivos, max_size = limite em MB.
  if (el.type.startsWith('1643847782395x597625793912766500')) {
    const exts = rawProps.AAg != null ? coerceText(evaluate(rawProps.AAg, ctx), ctx) : '';
    const accept = String(exts || '')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)
      .map((e) => (e.startsWith('.') || e.includes('/') ? e : `image/${e}`))
      .join(',');
    const maxFiles = Number(rawProps.AAi ?? 0);
    return (
      <div {...common} className="nc-el" style={{ ...css, display: 'flex', alignItems: 'center' }}>
        <input
          type="file"
          multiple={maxFiles !== 1}
          accept={accept || undefined}
          onChange={(e) => rt.store.setInputValue(handle.key, e.target.files?.[0]?.name ?? '')}
          style={{ width: '100%', fontSize: 13 }}
        />
      </div>
    );
  }

  // Base64 → imagem (1649557104915x...) — AAE = string base64 (ex.: QR de pagamento),
  // AAM/AAN = largura/altura em px definidas no editor.
  if (el.type.startsWith('1649557104915x413031042613248000')) {
    const b64 = rawProps.AAE != null ? coerceText(evaluate(rawProps.AAE, ctx), ctx) : '';
    const raw = String(b64 || '').trim();
    const src = raw && !raw.startsWith('data:') && !raw.startsWith('http') ? `data:image/png;base64,${raw}` : raw;
    const w = Number(rawProps.AAM ?? 0) || undefined;
    const h = Number(rawProps.AAN ?? 0) || undefined;
    return (
      <div {...common} className="nc-el" style={{ ...css, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="" width={w} height={h} style={{ maxWidth: '100%', objectFit: 'contain' }} />
        ) : null}
      </div>
    );
  }

  // TinyMCE rich text editor (1671672447428x...) — AAI = placeholder, AAc = valor/template
  // Literal de raio/borda NÃO tokenizado de propósito: 0 elementos deste tipo em app.pages,
  // app.mobile_views ou app.element_definitions (verificado varrendo o export inteiro em 07/08).
  // Se este tipo passar a ser usado em alguma das 27 páginas, tokenizar como o select2 abaixo.
  if (el.type.startsWith('1671672447428x598559844342169600')) {
    const ph = rawProps.AAI != null ? coerceText(evaluate(rawProps.AAI, ctx), ctx) : '';
    const val = rawProps.AAc != null ? coerceText(evaluate(rawProps.AAc, ctx), ctx) : '';
    return (
      <div {...common} className="nc-el" style={{ ...css, overflow: 'auto', border: '1px solid rgba(0,0,0,.15)', borderRadius: 6, padding: 8, background: '#fff', color: 'var(--color_text_default)', fontSize: 14 }}>
        {val || <span style={{ opacity: 0.45 }}>{ph}</span>}
      </div>
    );
  }

  // Toggle/Switch plugin (1660311476391x... v4.2.0) — prop AAE = cor do ativo
  // Raio não tokenizado de propósito: 0 elementos deste tipo em todo o export (verificado 07/08).
  if (el.type.startsWith('1660311476391x288865870778204160')) {
    const stored = toBool(rt.store.inputValues.get(handle.key));
    const activeColor = typeof props.AAE === 'string' ? props.AAE : 'var(--color_primary_default)';
    return (
      <div {...common} className="nc-el" style={{ ...css, display: 'flex', alignItems: 'center' }}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            rt.store.setInputValue(handle.key, !stored);
          }}
          style={{ width: 44, height: 24, borderRadius: 12, background: stored ? activeColor : 'rgba(0,0,0,.2)', position: 'relative', transition: 'background 150ms', flexShrink: 0 }}
        >
          <span style={{ position: 'absolute', top: 2, left: stored ? 22 : 2, width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: 'left 150ms' }} />
        </button>
      </div>
    );
  }

  // LottieFiles (1676280573614x... v2.0.0) — prop AAG = URL do .json. Anima via lottie-web (CDN).
  if (el.type.startsWith('1676280573614x891677842206097400')) {
    const url = rawProps.AAG != null ? normalizeAssetUrl(coerceText(evaluate(rawProps.AAG, ctx), ctx)) : '';
    return (
      <div {...common} className="nc-el" style={{ ...css, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <LottiePlayer url={url} />
      </div>
    );
  }

  // OutlineIcon (Heroicons) — prop AAH = nome do ícone
  if (el.type.startsWith('1618916043803x877032991371296800')) {
    const name = rawProps.AAH != null ? coerceText(evaluate(rawProps.AAH, ctx), ctx) : 'square';
    const feather = HEROICON_TO_FEATHER[name] ?? 'circle';
    const sizeRaw = parseInt(String(props.min_height_css ?? props.height ?? 22));
    css.display = 'flex';
    css.alignItems = 'center';
    css.justifyContent = 'center';
    const color = (rawProps.AAJ as string) ?? (rawProps.AAI as string) ?? 'var(--color_text_default)';
    return (
      <div {...common} className="nc-el">
        <NocodeIcon icon={`feather ${feather}`} size={Math.max(14, (Number.isNaN(sizeRaw) ? 22 : sizeRaw) - 4)} color={typeof color === 'string' ? color : undefined} />
      </div>
    );
  }

  // Ionic icon
  if (el.type === 'ionic-IonicIcon') {
    const name = (rawProps.icon as string) ?? 'ion-android-search';
    return (
      <div {...common} className="nc-el" style={{ ...css, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <NocodeIcon icon={name} size={18} />
      </div>
    );
  }

  // Ionic toggle — não aparece direto em app.pages, mas /adm instancia os reusables
  // adm_agente/adm_conversas/adm_automacoes, que contêm este tipo (verificado 07/08). Tokenizado.
  if (el.type === 'ionic-IonicToggle') {
    const stored = toBool(rt.store.inputValues.get(handle.key));
    return (
      <div {...common} className="nc-el" style={{ ...css, display: 'flex', alignItems: 'center' }}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            rt.store.setInputValue(handle.key, !stored);
          }}
          style={{
            width: 44,
            height: 24,
            borderRadius: raioToken(12),
            background: stored ? 'var(--color_success_default)' : 'rgba(0,0,0,.2)',
            position: 'relative',
            transition: 'background 150ms',
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 2,
              left: stored ? 22 : 2,
              width: 20,
              height: 20,
              // '50%' é a forma do knob (círculo), não um raio configurável do editor da plataforma —
              // border_roundness nunca assume porcentagem no export. Fora do escopo de raioToken.
              borderRadius: '50%',
              background: '#fff',
              transition: 'left 150ms',
            }}
          />
        </button>
      </div>
    );
  }

  // select2 MultiDropdown — renderiza em /login, /gerenciar_martketplace e /adm (via reusables
  // adm_agente/adm_conversas/adm_automacoes). --ui_borda_select é um token NOVO (não reaproveita
  // --ui_separador, cujo fallback é .1): o valor de hoje aqui é .15, e unificar mudaria a aparência.
  if (el.type === 'select2-MultiDropdown') {
    const list = toList(evaluate(rawProps.data_source, ctx));
    return (
      <div {...common} className="nc-el">
        <select multiple style={{ width: '100%', minHeight: 38, border: '1px solid var(--ui_borda_select, rgba(0,0,0,.15))', borderRadius: raioToken(6) }}>
          {list.map((item, i) => (
            <option key={i}>{coerceText(item, ctx)}</option>
          ))}
        </select>
      </div>
    );
  }

  // Spreadsheet / CSV (1608827595218x... v1.6.4) — AAF/AAG = colunas (linhas separadas por \n)
  if (el.type.startsWith('1608827595218x711669301717762000')) {
    const cols = typeof rawProps.AAF === 'string' ? (rawProps.AAF as string).split('\n').filter(Boolean) : [];
    return (
      <div {...common} className="nc-el" style={{ ...css, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              {cols.map((c, i) => (
                <th key={i} style={{ border: '1px solid rgba(0,0,0,.12)', padding: '4px 8px', background: 'var(--color_background_default)', textAlign: 'left' }}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {cols.map((_, i) => (
                <td key={i} style={{ border: '1px solid rgba(0,0,0,.12)', padding: '4px 8px', height: 28 }} />
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    );
  }

  // progressbar
  // Raio não tokenizado de propósito: 0 elementos deste tipo em todo o export (verificado 07/08).
  if (el.type === 'progressbar-ProgressBar') {
    const pct = (rawProps.AAD != null ? Number(coerceText(evaluate(rawProps.AAD, ctx), ctx)) : 50) || 50;
    return (
      <div {...common} className="nc-el" style={{ ...css, background: 'rgba(0,0,0,.08)', borderRadius: 6, overflow: 'hidden', minHeight: 8 }}>
        <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', minHeight: 8, background: 'var(--color_primary_default)' }} />
      </div>
    );
  }

  // chart
  // Raio não tokenizado de propósito: 0 elementos deste tipo em todo o export (verificado 07/08).
  if (el.type === 'chartjs-LineBarChart') {
    return (
      <div
        {...common}
        className="nc-el"
        style={{ ...css, display: 'flex', alignItems: 'flex-end', gap: 4, padding: 8, minHeight: 120 }}
      >
        {[40, 65, 35, 80, 55, 70, 45, 90].map((h, i) => (
          <div key={i} style={{ flex: 1, height: `${h}%`, background: 'rgba(var(--color_primary_default_rgb), .65)', borderRadius: 3 }} />
        ))}
      </div>
    );
  }

  // QRCode generator
  if (el.type.startsWith('1618741364806x569268886741188600')) {
    return (
      <div {...common} className="nc-el" style={{ ...css, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div
          style={{
            width: '80%',
            aspectRatio: '1/1',
            background:
              'repeating-conic-gradient(#000 0% 25%, #fff 0% 50%) 0 0/ 14px 14px',
            border: '6px solid #fff',
            outline: '1px solid rgba(0,0,0,.2)',
          }}
        />
      </div>
    );
  }

  // fallback genérico
  const label = el.name ?? el.default_name ?? el.type.slice(0, 18);
  return (
    <div {...common} className="nc-el nc-plugin-placeholder">
      {label}
    </div>
  );
}

export { findWorkflows, validChildren };
