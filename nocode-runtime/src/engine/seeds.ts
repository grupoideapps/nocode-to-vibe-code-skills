// [server-only] Seeds do mock DB. Gera registros plausíveis por user_type a partir do schema.
// Será substituído/estendido pelos seeds curados em analysis/05_modelo_dados.md.
import type { NocodeApp } from './types';

export function buildSeeds(app: NocodeApp): Record<string, Record<string, unknown>[]> {
  // Placeholder: seeds curados entram aqui após a análise do modelo de dados.
  void app;
  return {};
}
