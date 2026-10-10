// Parser BBCode→React para Texts da plataforma: [b] [i] [u] [color=] [size=] [font=] [fa] [hr] [url] [center].
import React, { type ReactNode } from 'react';

const TAG_RE = /\[(\/?)([a-z]+)(?:=([^\]]*))?\]/gi;

interface Frame {
  tag: string | null;
  arg?: string;
  children: ReactNode[];
}

export function renderBBCode(text: string): ReactNode {
  if (!text) return null;
  if (!text.includes('[')) return text;

  const stack: Frame[] = [{ tag: null, children: [] }];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;

  const pushText = (s: string) => {
    if (!s) return;
    const parts = s.split('\n');
    parts.forEach((p, i) => {
      if (i > 0) stack[stack.length - 1].children.push(<br key={`br${key++}`} />);
      if (p) stack[stack.length - 1].children.push(p);
    });
  };

  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text))) {
    pushText(text.slice(last, m.index));
    last = TAG_RE.lastIndex;
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const arg = m[3];

    if (tag === 'hr' && !closing) {
      stack[stack.length - 1].children.push(<hr key={`hr${key++}`} style={{ border: 'none', borderTop: '1px solid var(--ui_divisor_forte, rgba(0,0,0,.12))', margin: '6px 0', width: '100%' }} />);
      continue;
    }
    if (!closing) {
      stack.push({ tag, arg, children: [] });
    } else {
      // fecha até achar o tag correspondente
      const idx = [...stack].reverse().findIndex((f) => f.tag === tag);
      if (idx === -1) continue;
      const frame = stack.splice(stack.length - 1 - idx, 1 + idx);
      const f = frame[0];
      const inner = [...f.children, ...frame.slice(1).flatMap((x) => x.children)];
      stack[stack.length - 1].children.push(wrapTag(f.tag!, f.arg, inner, key++));
    }
  }
  pushText(text.slice(last));
  while (stack.length > 1) {
    const f = stack.pop()!;
    stack[stack.length - 1].children.push(wrapTag(f.tag!, f.arg, f.children, key++));
  }
  return <>{stack[0].children}</>;
}

function wrapTag(tag: string, arg: string | undefined, children: ReactNode[], key: number): ReactNode {
  switch (tag) {
    case 'b':
      return <strong key={key}>{children}</strong>;
    case 'i':
      return <em key={key}>{children}</em>;
    case 'u':
      return <u key={key}>{children}</u>;
    case 'color':
      return (
        <span key={key} style={{ color: normalizaCor(arg) }}>
          {children}
        </span>
      );
    case 'size':
      return (
        <span key={key} style={{ fontSize: fontSizeLegado(arg) }}>
          {children}
        </span>
      );
    case 'font':
      return (
        <span key={key} style={{ fontFamily: arg }}>
          {children}
        </span>
      );
    case 'fa':
      return <i key={key} className={`fa fa-${flatText(children)}`} aria-hidden />;
    case 'url':
      return (
        <a key={key} href={arg ?? flatText(children)} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
          {children}
        </a>
      );
    case 'center':
      return (
        <div key={key} style={{ textAlign: 'center', width: '100%' }}>
          {children}
        </div>
      );
    default:
      return <span key={key}>{children}</span>;
  }
}

// O `[size=N]` da plataforma não é um multiplicador — vira o atributo legado `<font size=N>`, cuja
// escala é uma tabela fixa do navegador, não uma conta. Medido no Chromium e conferido contra
// produção: `[size=2]` (293 usos, o texto corrido de /termos) sai a 13px no app real, enquanto a
// fórmula antiga `N * 8` dava 16px — 23% maior, o que sozinho esticava /termos de 4550 para
// 6085px e ainda gerava scroll horizontal.
const FONT_SIZE_LEGADO: Record<number, string> = {
  1: '10px',
  2: '13px',
  3: '16px',
  4: '18px',
  5: '24px',
  6: '32px',
  7: '48px',
};

function fontSizeLegado(arg: string | undefined): string | undefined {
  const n = parseFloat(arg ?? '');
  if (!Number.isFinite(n)) return undefined;
  // o atributo legado trunca pra inteiro e satura nas pontas: `0.5` → 1 (10px), `8` → 7 (48px).
  const i = Math.min(7, Math.max(1, Math.trunc(n) || 1));
  return FONT_SIZE_LEGADO[i];
}

// O export traz a cor em quatro formas: `#00bf63`, `#00BF63`, `00BF63` (sem `#`, 2 usos) e
// `##00bf63` (`#` duplicado, 9 usos — inclusive no "app-marketplace" da home, que saía preto porque
// o CSS descarta a declaração inválida inteira).
function normalizaCor(arg: string | undefined): string | undefined {
  const s = arg?.trim();
  if (!s) return undefined;
  if (/^#{2,}[0-9a-f]{3,8}$/i.test(s)) return '#' + s.replace(/^#+/, '');
  if (/^[0-9a-f]{3,8}$/i.test(s)) return '#' + s;
  return s;
}

function flatText(children: ReactNode[]): string {
  return children.map((c) => (typeof c === 'string' ? c : '')).join('').trim();
}
