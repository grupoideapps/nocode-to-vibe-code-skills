// [server-only] Monta o payload mínimo para renderizar uma página no client.
import { loadApp, pageName } from './loader';
import { buildSeeds } from './seeds';
import type { NocodeElement, ElementDefinition, PagePayload } from './types';

/** Índice de definições: aceita tanto a chave do dict quanto o campo `id` da definição. */
function buildDefIndex(defs: Record<string, ElementDefinition>): Map<string, { key: string; def: ElementDefinition }> {
  const index = new Map<string, { key: string; def: ElementDefinition }>();
  for (const [key, def] of Object.entries(defs)) {
    if (!def || typeof def !== 'object') continue;
    index.set(key, { key, def });
    if (typeof def.id === 'string') index.set(def.id, { key, def });
  }
  return index;
}

/** Coleta ids de reusables (CustomElement.custom_id) referenciados na árvore, transitivamente. */
function collectDefinitionIds(
  roots: Record<string, NocodeElement> | undefined,
  defIndex: Map<string, { key: string; def: ElementDefinition }>,
  acc: Set<string>,
): void {
  if (!roots) return;
  for (const el of Object.values(roots)) {
    if (!el || typeof el !== 'object') continue;
    if (el.type === 'CustomElement') {
      const cid = el.properties?.custom_id as string | undefined;
      const hit = cid ? defIndex.get(cid) : undefined;
      if (cid && hit && !acc.has(cid)) {
        acc.add(cid);
        collectDefinitionIds(hit.def.elements, defIndex, acc);
      }
    }
    collectDefinitionIds(el.elements, defIndex, acc);
  }
}

export function buildPagePayload(slug: string): PagePayload | null {
  const { app, appName, pagesByName , mapaTokens } = loadApp();
  const pageId = pagesByName[slug];
  if (!pageId) return null;
  const page = app.pages[pageId];

  const defIndex = buildDefIndex(app.element_definitions);
  const defIds = new Set<string>();
  collectDefinitionIds(page.elements, defIndex, defIds);
  const definitions: Record<string, ElementDefinition> = {};
  for (const id of defIds) {
    const hit = defIndex.get(id);
    if (hit) definitions[id] = hit.def;
  }

  const cs = app.settings.client_safe;
  const breakpoints: Record<string, number> = {};
  const rb = (cs.responsive_breakpoints as Record<string, { size?: number }>) || {};
  for (const [bid, b] of Object.entries(rb)) {
    if (typeof b?.size === 'number') breakpoints[bid] = b.size;
  }

  const pageNames: Record<string, string> = {};
  const pageIdsByElementId: Record<string, string> = {};
  for (const [pid, p] of Object.entries(app.pages)) {
    const name = pageName(p, pid);
    pageNames[pid] = name;
    if (p.id) pageIdsByElementId[p.id] = name;
    pageIdsByElementId[pid] = name;
  }

  return {
    appName,
    pageId,
    pageName: pageNames[pageId],
    page,
    definitions,
    styles: app.styles,
    defaultStyles: (cs.default_styles as Record<string, string>) || {},
    optionSets: app.option_sets,
    tokensPorValor: mapaTokens,
    userTypes: app.user_types,
    seeds: buildSeeds(app),
    pageNames,
    pageIdsByElementId,
    breakpoints,
  };
}

export function listPages(): { id: string; name: string }[] {
  const { app } = loadApp();
  return Object.entries(app.pages).map(([pid, p]) => ({ id: pid, name: pageName(p, pid) }));
}
