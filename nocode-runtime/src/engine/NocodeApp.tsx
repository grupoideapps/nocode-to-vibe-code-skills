'use client';
// Raiz do runtime: monta o store, escopo da página e renderiza a árvore.
import React, { useEffect, useMemo, useState } from 'react';
import { ContainerWorkflows, RuntimeProvider, ToastLayer, useRuntime, makeEvalCtx } from './runtime';
import { ElementNode, validChildren } from './elements/ElementNode';
import { coerceText, evaluate } from './expressions';
import type { ParentLayout, Props } from './css';
import type { NocodeElement, PagePayload } from './types';
import type { ElementHandle, Scope } from './store';

export default function NocodeApp({ payload, pathData = null }: { payload: PagePayload; pathData?: string | null }) {
  // evita mismatch de hidratação: runtime depende de window/sessionStorage
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return <div style={{ minHeight: '100vh', background: 'var(--color_background_default, #f7f8f9)' }} />;
  }
  return (
    <RuntimeProvider payload={payload} pathData={pathData}>
      <PageRoot />
      <ToastLayer />
    </RuntimeProvider>
  );
}

function PageRoot() {
  const rt = useRuntime();
  const page = rt.payload.page;
  const props = (page.properties ?? {}) as Props & Record<string, unknown>;

  const pageScope = useMemo<Scope>(
    () => ({ key: 'p', parent: null, kind: 'page', container: page }),
    [page],
  );

  const pageHandle = useMemo<ElementHandle>(
    () => ({
      id: page.id,
      key: `p:${page.id}`,
      el: { id: page.id, type: 'Page', properties: page.properties, elements: page.elements } as NocodeElement,
      scope: pageScope,
      parentHandle: null,
    }),
    [page, pageScope],
  );

  useEffect(() => {
    rt.store.register(pageHandle);
    return () => rt.store.unregister(pageHandle);
  }, [rt.store, pageHandle]);

  // título + backdrop do body
  useEffect(() => {
    const ctx = makeEvalCtx(rt, pageScope, pageHandle);
    if (props.title != null) {
      try {
        const t = coerceText(evaluate(props.title, ctx), ctx);
        if (t) document.title = t;
      } catch {
        /* ignore */
      }
    }
    const body = document.body;
    const style = props.backdrop_background_style as string | undefined;
    if (style === 'gradient') {
      body.style.background = `linear-gradient(to bottom, ${props.backdrop_background_gradient_from ?? 'transparent'}, ${props.backdrop_background_gradient_to ?? 'transparent'})`;
      body.style.backgroundAttachment = 'fixed';
    } else if (style === 'image' && props.backdrop_background_image != null) {
      try {
        const url = coerceText(evaluate(props.backdrop_background_image, ctx), ctx);
        body.style.background = `url("${url.startsWith('//') ? 'https:' + url : url}") center / ${props.backdrop_background_size_cover ? 'cover' : 'auto'} ${props.repeat_background_horizontal || props.repeat_background_vertical ? 'repeat' : 'no-repeat'}`;
        body.style.backgroundAttachment = 'fixed';
      } catch {
        /* ignore */
      }
    } else if (typeof props.backdrop_bgcolor === 'string') {
      body.style.background = props.backdrop_bgcolor;
    } else {
      body.style.background = 'var(--color_background_default)';
    }
    return () => {
      body.style.background = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id]);

  const layout = ((props.container_layout as string) || 'column') as ParentLayout;
  const isLegacy = (props.element_version as number) < 5;

  const pageCss: React.CSSProperties = {
    position: 'relative',
    width: '100%',
    minHeight: `max(${(props.min_height_px as number) ?? 600}px, 100vh)`,
    display: 'flex',
    flexDirection: layout === 'row' ? 'row' : 'column',
    flexWrap: layout === 'row' ? 'wrap' : undefined,
    justifyContent:
      ((layout === 'row' ? props.container_horiz_alignment : props.container_vert_alignment) as string) ?? 'flex-start',
    alignItems: layout === 'row' ? 'flex-start' : 'stretch',
    gap: props.use_gap ? `${(props.row_gap as number) ?? 0}px ${(props.column_gap as number) ?? 0}px` : undefined,
    minWidth: (props.min_width_px as number) ?? undefined,
    margin: '0 auto',
    boxSizing: 'border-box',
  };
  if (isLegacy) {
    pageCss.display = 'block';
    pageCss.maxWidth = (props.width as number) ?? 1080;
    pageCss.position = 'relative';
  }

  const children = useMemo(() => {
    const els = Object.values(page.elements ?? {}).filter(
      (c): c is NocodeElement => !!c && typeof c === 'object' && typeof c.type === 'string',
    );
    return els.sort((a, b) => ((a.properties?.order as number) ?? 9999) - ((b.properties?.order as number) ?? 9999));
  }, [page.elements]);

  return (
    <main className="nc-page" style={pageCss} data-page={rt.payload.pageName}>
      <ContainerWorkflows scope={pageScope} thisHandle={pageHandle} />
      {children.map((c) =>
        isLegacy ? (
          <LegacyAbsolute key={c.id} el={c} scope={pageScope} parentHandle={pageHandle} />
        ) : (
          <ElementNode key={c.id} el={c} scope={pageScope} parentHandle={pageHandle} parentLayout={layout} />
        ),
      )}
    </main>
  );
}

/** Página com engine antiga (element_version 3): posicionamento absoluto. */
function LegacyAbsolute({ el, scope, parentHandle }: { el: NocodeElement; scope: Scope; parentHandle: ElementHandle }) {
  const p = el.properties ?? {};
  return (
    <div
      style={{
        position: 'absolute',
        left: (p.left as number) ?? 0,
        top: (p.top as number) ?? 0,
        width: (p.width as number) ?? 'auto',
        minHeight: (p.height as number) ?? 'auto',
      }}
    >
      <ElementNode el={el} scope={scope} parentHandle={parentHandle} parentLayout="column" />
    </div>
  );
}

export { validChildren };
