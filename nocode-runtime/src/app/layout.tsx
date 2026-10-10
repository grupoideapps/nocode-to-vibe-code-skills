import './globals.css';
import 'bootstrap-icons/font/bootstrap-icons.css';
import { loadApp, buildTokensCss, buildTemasCss, collectFontFamilies, TEMAS, type Tema } from '@/engine/loader';
import type { ReactNode } from 'react';

export async function generateMetadata() {
  const { appName } = loadApp();
  return { title: appName };
}

/** Um app, um tema, todos os visitantes veem o mesmo. Para voltar ao tema original, basta trocar
 *  TEMA_PADRAO e redeployar.
 *
 *  Sem cookie e sem middleware de propósito: os dois criariam dois estados vivos ao mesmo tempo —
 *  dois visitantes com temas diferentes na mesma produção — que não é o que o cliente quer. */
function temaAtivo(): Tema {
  const v = process.env.TEMA_PADRAO as Tema | undefined;
  return v && (TEMAS as readonly string[]).includes(v) ? v : 'tema-original';
}

export default function RootLayout({ children }: { children: ReactNode }) {
  const { app } = loadApp();
  const tokensCss = buildTokensCss(app);
  const temasCss = buildTemasCss();
  const families = collectFontFamilies(app);
  const fontsHref =
    'https://fonts.googleapis.com/css2?' +
    families
      .map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@300;400;500;600;700;800`)
      .join('&') +
    '&display=swap';

  return (
    <html lang="pt-BR" data-tema={temaAtivo()}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href={fontsHref} />
        {/* Ícones: Font Awesome 4 (legado no-code) + Phosphor + Material Symbols */}
        <link
          rel="stylesheet"
          href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css"
        />
        <link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.1.1/src/regular/style.css" />
        <link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.1.1/src/fill/style.css" />
        {/* `display=block`, não `swap`: o Material Symbols é fonte de LIGADURA — o nome do ícone
            é o conteúdo do elemento. Com `swap`, enquanto a fonte não chega o navegador desenha a
            fallback e o usuário lê "place", "keyboard_arrow_down", "arrow_back_ios" espalhados
            pela tela. Reproduzido em rede lenta: 24 dos 56 ícones de /marketplace saíam como
            palavra. A plataforma não tem esse flash porque serve SVG. */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=block"
        />
        <style dangerouslySetInnerHTML={{ __html: tokensCss }} />
        <style dangerouslySetInnerHTML={{ __html: temasCss }} />
        <style
          dangerouslySetInnerHTML={{
            __html: `.material-symbols-outlined{font-family:'Material Symbols Outlined';font-weight:normal;font-style:normal;display:inline-block;line-height:1;text-transform:none;letter-spacing:normal;word-wrap:normal;white-space:nowrap;direction:ltr}`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
