// Mock DB in-memory + auth fake. Seeds de analysis/05_modelo_dados.md (seed-data.json).
// Things são objetos planos; referências guardam _id; options guardam db_value (ou key).
import seedData from './seed-data.json';

export type Thing = Record<string, unknown> & { _id: string };

export interface OptionEntry {
  key: string;
  display?: string;
  db_value?: string;
  sort_factor?: number;
  [attr: string]: unknown;
}

export interface OptionRef {
  __option: true;
  set: string; // sem prefixo 'option.'
  entry: OptionEntry;
}

let idCounter = 1;
export function newRecordId(): string {
  return `${Date.now()}x${String(900000000000000000 + idCounter++).slice(0, 18)}`;
}

export class MockDB {
  tables = new Map<string, Thing[]>();
  byId = new Map<string, Thing>();
  private listeners = new Set<() => void>();
  private onChange: () => void;

  /** Singleton de sessão: cada RuntimeStore (remount/navegação) registra seu bump. */
  addOnChange(fn: () => void) {
    this.listeners.add(fn);
  }

  constructor(onChange: () => void) {
    this.onChange = () => {
      onChange();
      for (const fn of this.listeners) fn();
    };
    for (const [type, rows] of Object.entries(seedData as Record<string, Record<string, unknown>[]>)) {
      const list: Thing[] = [];
      for (const row of rows) {
        const thing = { ...row } as Thing;
        if (!thing._id) thing._id = newRecordId();
        (thing as Record<string, unknown>).__type = type;
        list.push(thing);
        this.byId.set(thing._id, thing);
      }
      this.tables.set(type, list);
    }
  }

  /** 'custom.eventos' | 'user' → nome da tabela */
  static tableName(typeToFind: string): string {
    return typeToFind.replace(/^custom\./, '');
  }

  all(typeToFind: string): Thing[] {
    return this.tables.get(MockDB.tableName(typeToFind)) ?? [];
  }

  resolve(idOrThing: unknown): Thing | null {
    if (idOrThing == null) return null;
    if (typeof idOrThing === 'string') return this.byId.get(idOrThing) ?? null;
    if (typeof idOrThing === 'object' && '_id' in (idOrThing as object)) return idOrThing as Thing;
    return null;
  }

  create(typeToFind: string, fields: Record<string, unknown>): Thing {
    const table = MockDB.tableName(typeToFind);
    const thing: Thing = {
      _id: newRecordId(),
      'Created Date': new Date().toISOString(),
      'Modified Date': new Date().toISOString(),
      'Created By': null,
      __type: table,
      ...fields,
    };
    if (!this.tables.has(table)) this.tables.set(table, []);
    this.tables.get(table)!.push(thing);
    this.byId.set(thing._id, thing);
    this.onChange();
    return thing;
  }

  update(thing: Thing | null, changes: Record<string, unknown>): Thing | null {
    if (!thing) return null;
    Object.assign(thing, changes, { 'Modified Date': new Date().toISOString() });
    this.onChange();
    return thing;
  }

  delete(thing: Thing | null) {
    if (!thing) return;
    const table = (thing as Record<string, unknown>).__type as string;
    const list = this.tables.get(table);
    if (list) {
      const i = list.indexOf(thing);
      if (i >= 0) list.splice(i, 1);
    }
    this.byId.delete(thing._id);
    this.onChange();
  }
}

/** Índice de option sets: resolve opção por key OU db_value OU display. */
export class OptionSets {
  private sets: Record<string, { display?: string; values?: Record<string, Record<string, unknown>>; attributes?: Record<string, unknown> }>;

  constructor(optionSets: Record<string, unknown>) {
    this.sets = optionSets as OptionSets['sets'];
  }

  setName(ref: string): string {
    return ref.replace(/^option\./, '');
  }

  get(setRef: string, optionKeyOrValue: string): OptionRef | null {
    const set = this.sets[this.setName(setRef)];
    if (!set?.values) return null;
    const values = set.values;
    let key = optionKeyOrValue;
    if (!values[key]) {
      const found = Object.entries(values).find(
        ([, v]) => v.db_value === optionKeyOrValue || v.display === optionKeyOrValue,
      );
      if (!found) return null;
      key = found[0];
    }
    return { __option: true, set: this.setName(setRef), entry: { key, ...values[key] } as OptionEntry };
  }

  allOf(setRef: string): OptionRef[] {
    const set = this.sets[this.setName(setRef)];
    if (!set?.values) return [];
    return Object.entries(set.values)
      .map(([key, v]) => ({ __option: true as const, set: this.setName(setRef), entry: { key, ...v } as OptionEntry }))
      .sort((a, b) => ((a.entry.sort_factor as number) ?? 0) - ((b.entry.sort_factor as number) ?? 0));
  }

  /** Tenta resolver um valor persistido (db_value/key) para OptionRef de um set conhecido. */
  fromStored(setRef: string, stored: unknown): OptionRef | null {
    if (stored == null) return null;
    if (typeof stored === 'object' && (stored as OptionRef).__option) return stored as OptionRef;
    if (typeof stored === 'string') return this.get(setRef, stored);
    return null;
  }

  hasAttribute(attrName: string): boolean {
    return Object.values(this.sets).some(
      (s) => s && typeof s === 'object' && s.attributes && attrName in (s.attributes as object),
    );
  }

  /** Tipo declarado de um atributo do set (ex.: 'text', 'option.X', 'list.option.X'). */
  attrType(setRef: string, attrName: string): string | null {
    const set = this.sets[this.setName(setRef)];
    const decl = set?.attributes?.[attrName] as { value?: string } | undefined;
    return decl?.value ?? null;
  }

  /** Resolve valor persistido (db_value/key/display) em qualquer set que declare o atributo. */
  resolveByAttr(attrName: string, stored: string): OptionRef | null {
    for (const [setKey, s] of Object.entries(this.sets)) {
      if (!s || typeof s !== 'object' || !s.attributes || !(attrName in (s.attributes as object))) continue;
      const ref = this.get(setKey, stored);
      if (ref) return ref;
    }
    return null;
  }
}

// Banco da sessão: singleton no client para sobreviver a remounts/navegação
// (na plataforma real o banco é server-side; um MockDB por página perderia dados criados).
// No SSR cada render ganha instância efêmera (sem estado compartilhado entre requests).
let sessionDB: MockDB | null = null;
export function getSessionDB(): MockDB {
  if (typeof window === 'undefined') return new MockDB(() => {});
  if (!sessionDB) sessionDB = new MockDB(() => {});
  return sessionDB;
}

export function isOption(v: unknown): v is OptionRef {
  return !!v && typeof v === 'object' && (v as OptionRef).__option === true;
}

export function optionStoredValue(o: OptionRef): string {
  return (o.entry.db_value as string) ?? o.entry.key;
}
