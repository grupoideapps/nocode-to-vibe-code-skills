import { buildPagePayload, listPages } from '@/engine/payload';
import NocodeApp from '@/engine/NocodeApp';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function CatchAll({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = await params;
  const pageSlug = slug?.[0] ?? 'index';

  const payload = buildPagePayload(pageSlug);
  if (!payload) {
    const pages = listPages();
    return (
      <main style={{ padding: 32, fontFamily: 'monospace' }}>
        <h1>Página &quot;{pageSlug}&quot; não encontrada</h1>
        <p>Páginas disponíveis no export:</p>
        <ul>
          {pages.map((p) => (
            <li key={p.id}>
              <Link href={`/${p.name}`} style={{ textDecoration: 'underline' }}>
                /{p.name}
              </Link>
            </li>
          ))}
        </ul>
      </main>
    );
  }

  return <NocodeApp payload={payload} pathData={slug?.[1] ? decodeURIComponent(slug[1]) : null} />;
}
