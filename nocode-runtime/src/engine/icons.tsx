// Dispatcher de ícones: 'feather x' | 'fa fa-x' | 'phosphor regular x' | 'material outlined x' | 'ionic outline x' | 'ion-android-x'.
import feather from 'feather-icons';
import React from 'react';

const ION_LEGACY_MAP: Record<string, string> = {
  'ion-android-search': 'fa fa-search',
  'ion-android-warning': 'fa fa-warning',
  'ion-ios-keypad': 'fa fa-th',
};

export function NocodeIcon({ icon, size, color }: { icon: string; size?: number; color?: string }) {
  if (!icon) return null;
  // `height` + `overflow: hidden` prendem a caixa do ícone ao tamanho pedido. Sem isso, a
  // line box das fontes de ícone (Material Symbols, Font Awesome) fica ~10% mais alta que o
  // font-size por causa do ascender/descender — espaço invisível, mas que conta no
  // scrollHeight e vaza pra fora do container da plataforma (medido: caixa 32px, glifo 35px).
  // Só a altura é fixada: travar a largura recortaria glifos não-quadrados do FA.
  const style: React.CSSProperties = {
    fontSize: size,
    color,
    lineHeight: 1,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: size,
    overflow: 'hidden',
  };

  if (icon.startsWith('ion-')) {
    const mapped = ION_LEGACY_MAP[icon] ?? 'fa fa-circle';
    return <i className={mapped} style={style} aria-hidden />;
  }
  if (icon.startsWith('fa ')) {
    return <i className={icon} style={style} aria-hidden />;
  }
  const parts = icon.split(/\s+/);
  const set = parts[0];

  if (set === 'feather') {
    const name = parts.slice(1).join('-');
    const def = (feather.icons as Record<string, { toSvg: (attrs?: object) => string }>)[name];
    if (def) {
      const svg = def.toSvg({ width: size ?? 16, height: size ?? 16, ...(color ? { stroke: color } : {}) });
      return <span style={{ ...style, alignItems: 'center' }} dangerouslySetInnerHTML={{ __html: svg }} aria-hidden />;
    }
    return null;
  }
  if (set === 'bootstrap') {
    // Bootstrap Icons (font oficial via bootstrap-icons.css) — 'bootstrap chat-text' → 'bi bi-chat-text'
    const name = parts.slice(1).join('-');
    return <i className={`bi bi-${name}`} style={style} aria-hidden />;
  }
  if (set === 'phosphor') {
    const variant = parts[1] === 'fill' ? 'ph-fill' : 'ph';
    const name = parts.slice(2).join('-') || parts[1];
    return <i className={`${variant} ph-${name}`} style={style} aria-hidden />;
  }
  if (set === 'material') {
    const variante = parts[1];
    const name = parts.slice(2).join('_') || parts[1];
    // Material Symbols é fonte variável: o preenchimento é o eixo FILL, não outra família.
    // A variante vinha sendo ignorada e os 11 ícones `material filled` saíam como contorno —
    // entre eles a estrela da nota de avaliação, que no real é sólida.
    // `filled` é o eixo FILL; `bold` é o eixo wght — eixos distintos da mesma fonte.
    const eixos = [`'FILL' ${variante === 'filled' ? 1 : 0}`];
    if (variante === 'bold') eixos.push("'wght' 700");
    return (
      <span
        className="material-symbols-outlined"
        style={{ ...style, fontSize: size ?? 18, fontVariationSettings: eixos.join(', ') }}
        aria-hidden
      >
        {name}
      </span>
    );
  }
  if (set === 'ionic') {
    // poucos usos — aproximar com feather/fa. Nomes de Ionicons que não existem 1:1 no
    // feather (nome muda, não é ausência de ícone): sem o de-para, cai no fallback
    // genérico `fa-circle-o` — foi o que apareceu como um círculo vazio sem sentido no
    // "X" de fechar de 35 popups do app (verificado: `close` não existe no feather, o
    // equivalente é `x`).
    const name = parts.slice(2).join('-');
    const featherEq: Record<string, string> = {
      'add-circle': 'plus-circle',
      save: 'save',
      mail: 'mail',
      'add-circle-outline': 'plus-circle',
      close: 'x',
      'checkmark-circle': 'check-circle',
      exit: 'log-out',
    };
    const fname = featherEq[name] ?? name;
    const def = (feather.icons as Record<string, { toSvg: (attrs?: object) => string }>)[fname];
    if (def) {
      const svg = def.toSvg({ width: size ?? 16, height: size ?? 16, ...(color ? { stroke: color } : {}) });
      return <span style={{ ...style, alignItems: 'center' }} dangerouslySetInnerHTML={{ __html: svg }} aria-hidden />;
    }
  }
  return <i className="fa fa-circle-o" style={style} aria-hidden />;
}
