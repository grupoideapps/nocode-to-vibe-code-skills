// Camada de dados server-side para os backend workflows (route handlers /api/wf/*).
// Usa Supabase se configurado (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_KEY);
// senão cai no SQLite local (data/app-eventos.sqlite) gerado de tools/build_db.py.
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type Row = Record<string, unknown>;

export interface DataLayer {
  get(table: string, id: string): Promise<Row | null>;
  findOne(table: string, where: Record<string, unknown>): Promise<Row | null>;
  find(table: string, where: Record<string, unknown>, opts?: { limit?: number; orderBy?: string; desc?: boolean }): Promise<Row[]>;
  insert(table: string, row: Row): Promise<Row>;
  update(table: string, id: string, patch: Row): Promise<Row | null>;
  readonly backend: 'supabase' | 'sqlite';
}

function recordId(): string {
  return `${Date.now()}x${String(Math.floor(Math.random() * 1e18)).padStart(18, '0')}`;
}

// ---- Supabase ----
class SupabaseLayer implements DataLayer {
  readonly backend = 'supabase' as const;
  private c: SupabaseClient;
  constructor(url: string, key: string) {
    this.c = createClient(url, key, { auth: { persistSession: false } });
  }
  // 'user' é reservado no Postgres → o schema gerado usa 'usuario'
  private t(table: string) {
    return table === 'user' ? 'usuario' : table;
  }
  async get(table: string, id: string) {
    table = this.t(table);
    const { data } = await this.c.from(table).select('*').eq('id', id).maybeSingle();
    return (data as Row) ?? null;
  }
  async findOne(table: string, where: Record<string, unknown>) {
    table = this.t(table);
    let q = this.c.from(table).select('*');
    for (const [k, v] of Object.entries(where)) q = q.eq(k, v as string);
    const { data } = await q.limit(1).maybeSingle();
    return (data as Row) ?? null;
  }
  async find(table: string, where: Record<string, unknown>, opts?: { limit?: number; orderBy?: string; desc?: boolean }) {
    table = this.t(table);
    let q = this.c.from(table).select('*');
    for (const [k, v] of Object.entries(where)) q = q.eq(k, v as string);
    if (opts?.orderBy) q = q.order(opts.orderBy, { ascending: !opts.desc });
    if (opts?.limit) q = q.limit(opts.limit);
    const { data } = await q;
    return (data as Row[]) ?? [];
  }
  async insert(table: string, row: Row) {
    table = this.t(table);
    const withId = { id: recordId(), created_date: new Date().toISOString(), modified_date: new Date().toISOString(), ...row };
    const { data } = await this.c.from(table).insert(withId).select().single();
    return (data as Row) ?? withId;
  }
  async update(table: string, id: string, patch: Row) {
    table = this.t(table);
    const { data } = await this.c.from(table).update({ ...patch, modified_date: new Date().toISOString() }).eq('id', id).select().maybeSingle();
    return (data as Row) ?? null;
  }
}

// ---- SQLite (better-sqlite3) ----
type SqliteDb = {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
    run: (...a: unknown[]) => unknown;
  };
};

class SqliteLayer implements DataLayer {
  readonly backend = 'sqlite' as const;
  private db: SqliteDb;
  private knownCols = new Map<string, Set<string>>();
  // o SQLite de build_db.py prefixa colunas com "c_" + sanitização
  private col(c: string) {
    return 'c_' + c.replace(/\W/g, '_');
  }
  constructor(db: SqliteDb) {
    this.db = db;
  }
  private cols(table: string): Set<string> {
    let s = this.knownCols.get(table);
    if (!s) {
      const rows = this.db.prepare(`select name from pragma_table_info('${table}')`).all() as { name: string }[];
      s = new Set(rows.map((r) => r.name));
      this.knownCols.set(table, s);
    }
    return s;
  }
  /** garante que a coluna exista (cria via ALTER TABLE) — robustez para campos novos. */
  private ensureCol(table: string, col: string) {
    const s = this.cols(table);
    if (!s.has(col)) {
      try {
        this.db.prepare(`alter table "${table}" add column "${col}" text`).run();
      } catch {
        /* corrida — outra inserção já criou */
      }
      s.add(col);
    }
  }
  /** SQLite só aceita number|string|bigint|buffer|null. */
  private bind(v: unknown): unknown {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v !== null && typeof v === 'object') return JSON.stringify(v);
    return v;
  }
  private parse(row: Row | undefined): Row | null {
    if (!row) return null;
    const out: Row = {};
    for (const [k, v] of Object.entries(row)) {
      const key = k.replace(/^c_/, '');
      let val: unknown = v;
      if (typeof v === 'string' && (v.startsWith('[') || v.startsWith('{'))) {
        try {
          val = JSON.parse(v);
        } catch {
          /* keep string */
        }
      }
      out[key] = val;
    }
    return out;
  }
  async get(table: string, id: string) {
    const r = this.db.prepare(`select * from "${table}" where ${this.col('_id')} = ?`).get(id) as Row;
    return this.parse(r);
  }
  async findOne(table: string, where: Record<string, unknown>) {
    return (await this.find(table, where, { limit: 1 }))[0] ?? null;
  }
  async find(table: string, where: Record<string, unknown>, opts?: { limit?: number; orderBy?: string; desc?: boolean }) {
    const keys = Object.keys(where);
    const cond = keys.map((k) => `${this.col(k)} = ?`).join(' and ') || '1=1';
    let sql = `select * from "${table}" where ${cond}`;
    if (opts?.orderBy) sql += ` order by ${this.col(opts.orderBy)} ${opts.desc ? 'desc' : 'asc'}`;
    if (opts?.limit) sql += ` limit ${opts.limit}`;
    const rows = this.db.prepare(sql).all(...keys.map((k) => where[k])) as Row[];
    return rows.map((r) => this.parse(r)!).filter(Boolean);
  }
  async insert(table: string, row: Row) {
    const full = { _id: recordId(), 'Created Date': new Date().toISOString(), 'Modified Date': new Date().toISOString(), ...row };
    const cols = Object.keys(full);
    cols.forEach((c) => this.ensureCol(table, this.col(c)));
    const sql = `insert into "${table}" (${cols.map((c) => this.col(c)).join(', ')}) values (${cols.map(() => '?').join(', ')})`;
    const vals = cols.map((c) => this.bind((full as Row)[c]));
    this.db.prepare(sql).run(...vals);
    return full as Row;
  }
  async update(table: string, id: string, patch: Row) {
    const cols = Object.keys(patch);
    if (cols.length) {
      cols.forEach((c) => this.ensureCol(table, this.col(c)));
      const sql = `update "${table}" set ${cols.map((c) => `${this.col(c)} = ?`).join(', ')} where ${this.col('_id')} = ?`;
      const vals = cols.map((c) => this.bind(patch[c]));
      this.db.prepare(sql).run(...vals, id);
    }
    return this.get(table, id);
  }
}

let cached: DataLayer | null = null;

export function getDb(): DataLayer {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (url && key) {
    cached = new SupabaseLayer(url, key);
    return cached;
  }
  // fallback SQLite local — caminho por app (data/<slug>.sqlite), derivado do nocode.config.json
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3') as new (p: string) => SqliteDb;
  cached = new SqliteLayer(new Database(sqlitePath()));
  return cached;
}

/** Resolve data/<slug>.sqlite a partir do nocode.config.json (ou env SQLITE_FILE). */
function sqlitePath(): string {
  const envp = process.env.SQLITE_FILE;
  if (envp) return path.isAbsolute(envp) ? envp : path.join(process.cwd(), envp);
  let slug = 'app';
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'nocode.config.json'), 'utf8'));
    const base = String(cfg.exportFile || '').split('/').pop() || '';
    slug = base.replace(/\.[^.]+$/, '').replace(/[^0-9a-zA-Z_]/g, '_').toLowerCase() || 'app';
  } catch {
    /* sem config — usa default */
  }
  return path.join(process.cwd(), 'data', `${slug}.sqlite`);
}

export { recordId };
