// Avaliador da linguagem de expressões da plataforma (spec: analysis/02_expressoes.md).
// Pipeline: nó raiz (fonte) → cadeia de Message (operadores/getters) via `next`.
import { isOption, optionStoredValue, type OptionRef, type Thing } from './data';
import type { ElementHandle, RuntimeStore, Scope } from './store';
import type { ExprNode } from './types';

export interface EvalCtx {
  store: RuntimeStore;
  scope: Scope;
  /** elemento dono da expressão (ThisElement / ElementParent / contexto de célula). */
  thisHandle: ElementHandle | null;
  injected: unknown[];
  stepResults?: Map<string, unknown>;
  workflowParams?: Record<string, unknown>;
  workflowError?: { message: string };
  pageWidth: number;
  query: Record<string, string>;
  pathData: string | null;
}

interface HandleRef {
  __handle: true;
  handle: ElementHandle;
}
function isHandleRef(v: unknown): v is HandleRef {
  return !!v && typeof v === 'object' && (v as HandleRef).__handle === true;
}
function isThing(v: unknown): v is Thing {
  return !!v && typeof v === 'object' && typeof (v as Thing)._id === 'string' && !isOption(v) && !isHandleRef(v);
}

const warned = new Set<string>();
function warnOnce(msg: string) {
  if (warned.has(msg)) return;
  warned.add(msg);
  // eslint-disable-next-line no-console
  console.warn('[nocode-runtime]', msg);
}

// ---------------------------------------------------------------- evaluate

export function evaluate(node: unknown, ctx: EvalCtx): unknown {
  if (node == null) return null;
  if (typeof node !== 'object') return node;
  const n = node as ExprNode;
  if (!n.type) return node;

  let value: unknown;
  switch (n.type) {
    case 'TextExpression':
      value = evalTextExpression(n, ctx);
      break;
    case 'Message':
      // Message como raiz (raro): aplica sobre null
      return applyMessageChain(null, n, ctx);
    case 'GetElement':
      value = resolveElementRef(n.properties?.element_id as string, ctx);
      break;
    case 'ThisElement':
      value = n.properties?.element_id
        ? resolveElementRef(n.properties.element_id as string, ctx)
        : ctx.thisHandle
          ? ({ __handle: true, handle: ctx.thisHandle } satisfies HandleRef)
          : null;
      break;
    case 'ElementParent':
      value = elementParentData(ctx);
      break;
    case 'PageData':
      value = pageData((n.properties?.name as string) ?? '', ctx);
      break;
    case 'Breakpoint':
      value = ctx.store.payload.breakpoints[(n.properties?.breakpoint_id as string) ?? ''] ?? 0;
      break;
    case 'Search':
      value = runSearch(n.properties ?? {}, ctx);
      break;
    case 'CurrentUser':
      value = ctx.store.currentUser;
      break;
    case 'CurrentPageItem':
      value = currentPageItem(ctx);
      break;
    case 'CurrentCellsIndex': {
      let s: Scope | null = ctx.scope;
      while (s && s.kind !== 'cell') s = s.parent;
      value = s?.cellIndex ?? 0;
      break;
    }
    case 'InjectedValue':
      value = ctx.injected[ctx.injected.length - 1] ?? null;
      break;
    case 'OneOptionValue':
    case 'OptionValue': {
      const set = (n.properties?.option_set as string) ?? '';
      const key = (n.properties?.option_value as string) ?? '';
      value = key === 'all values' ? ctx.store.options.allOf(set) : ctx.store.options.get(set, key);
      break;
    }
    case 'AllOptionValue':
      value = ctx.store.options.allOf((n.properties?.option_set as string) ?? '');
      break;
    case 'GetParamFromUrl':
      value = getParamFromUrl(n, ctx);
      break;
    case 'ArbitraryText':
      value = evaluate(n.properties?.arbitrary_text, ctx);
      break;
    case 'Empty':
      value = null;
      break;
    case 'PrimitiveLiteral':
      value = n.properties?.value ?? null;
      break;
    case 'PreviousStep':
      value = ctx.stepResults?.get((n.properties?.action_id as string) ?? '') ?? null;
      break;
    case 'CurrentWorkflowItem':
      value = n.properties?.param_id
        ? (ctx.workflowParams?.[n.properties.param_id as string] ?? null)
        : (ctx.workflowError ?? null);
      break;
    case 'CurrentDataItem':
      value = ctx.injected[ctx.injected.length - 1] ?? null;
      break;
    case 'OldDataItem':
      value = null;
      break;
    case 'Formulas': {
      const p = n.properties ?? {};
      if (p.formula_type === 'RandomString') {
        const len = (p.length as number) ?? 10;
        const chars =
          (p.letters !== false ? 'abcdefghijklmnopqrstuvwxyz' : '') + (p.numbers !== false ? '0123456789' : '');
        value = Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      } else value = null;
      break;
    }
    case 'GetDataFromAPI':
      warnOnce(`GetDataFromAPI mock: ${n.properties?.provider}`);
      value = null;
      break;
    default:
      warnOnce(`Nó de expressão não suportado: ${n.type}`);
      value = null;
  }
  if (n.next) return applyMessageChain(value, n.next, ctx);
  return value;
}

function evalTextExpression(n: ExprNode, ctx: EvalCtx): string {
  const entries = n.entries ?? {};
  const keys = Object.keys(entries).sort((a, b) => parseInt(a) - parseInt(b));
  let out = '';
  for (const k of keys) {
    const e = entries[k];
    out += typeof e === 'string' ? e : coerceText(evaluate(e, ctx), ctx);
  }
  return out;
}

// ---------------------------------------------------------------- Message chain

function applyMessageChain(acc: unknown, node: ExprNode | undefined, ctx: EvalCtx): unknown {
  let value = acc;
  let n: ExprNode | undefined = node;
  while (n) {
    if (n.type !== 'Message') {
      value = evaluate(n, ctx);
      n = undefined;
      break;
    }
    value = applyMessage(value, n, ctx);
    n = n.next;
  }
  return value;
}

function applyMessage(acc: unknown, n: ExprNode, ctx: EvalCtx): unknown {
  const name = n.name ?? '';
  const argsRaw = n.args;
  const p = (n.properties ?? {}) as Record<string, unknown>;
  const evalArgs = () => evaluate(argsRaw, ctx);

  switch (name) {
    // ---- comparação / lógica
    case 'equals':
      return looseEquals(acc, evalArgs());
    case 'not_equals':
      return !looseEquals(acc, evalArgs());
    case 'and_':
      return toBool(acc) && toBool(evalArgs());
    case 'or_':
      return toBool(acc) || toBool(evalArgs());
    case 'is_true':
      return toBool(acc) === true;
    case 'is_false':
      return toBool(acc) === false;
    case 'is_empty':
      return isEmpty(acc);
    case 'is_not_empty':
      return !isEmpty(acc);
    case 'contains': {
      const arg = evalArgs();
      if (Array.isArray(acc)) return acc.some((x) => looseEquals(x, arg));
      return coerceText(acc, ctx).toLowerCase().includes(coerceText(arg, ctx).toLowerCase());
    }
    case 'not_contains': {
      const arg = evalArgs();
      if (Array.isArray(acc)) return !acc.some((x) => looseEquals(x, arg));
      return !coerceText(acc, ctx).toLowerCase().includes(coerceText(arg, ctx).toLowerCase());
    }
    case 'less_than':
      return toComparable(acc) < toComparable(evalArgs());
    case 'greater_than':
      return toComparable(acc) > toComparable(evalArgs());
    case 'less_or_equal_than':
      return toComparable(acc) <= toComparable(evalArgs());
    case 'greater_or_equal_than':
      return toComparable(acc) >= toComparable(evalArgs());

    // ---- aritmética
    case 'plus':
      return toNum(acc) + toNum(evalArgs());
    case 'minus':
      return toNum(acc) - toNum(evalArgs());
    case 'times':
      return toNum(acc) * toNum(evalArgs());
    case 'divide': {
      const d = toNum(evalArgs());
      return d === 0 ? 0 : toNum(acc) / d;
    }
    case 'modulo': {
      const d = toNum(evalArgs());
      return d === 0 ? 0 : toNum(acc) % d;
    }
    case 'round': {
      const places = toNum(evalArgs());
      const f = 10 ** places;
      return Math.round(toNum(acc) * f) / f;
    }
    case 'floor':
      return Math.floor(toNum(acc));
    case 'ceil':
      return Math.ceil(toNum(acc));
    case 'convert_to_number': {
      const s = coerceText(acc, ctx).replace(/[^\d.,-]/g, '').replace(',', '.');
      const v = parseFloat(s);
      return Number.isNaN(v) ? 0 : v;
    }
    // Conversão de duração (o `minus` entre duas datas devolve milissegundos).
    // `to_days` faltava e é usado 8 vezes no app: sem ele o "tempo na app-marketplace" caía no
    // default e mostrava "0 Dias" onde a plataforma mostra "6 Meses". A família inteira entra
    // junto — a ausência de uma delas custou um bug silencioso.
    case 'to_seconds':
      return toNum(acc) / 1000;
    case 'to_minutes':
      return toNum(acc) / 60000;
    case 'to_hours':
      return toNum(acc) / 3600000;
    case 'to_days':
      return toNum(acc) / 86400000;
    case 'to_weeks':
      return toNum(acc) / 604800000;

    // ---- listas / agregação
    case 'count':
      return Array.isArray(acc) ? acc.length : acc == null ? 0 : 1;
    case 'sum':
      return (toList(acc) as unknown[]).reduce<number>((s, x) => s + toNum(x), 0);
    case 'max':
      return Math.max(0, ...(toList(acc) as unknown[]).map(toNum));
    case 'first_element':
      return toList(acc)[0] ?? null;
    case 'last_element': {
      const l = toList(acc);
      return l[l.length - 1] ?? null;
    }
    case 'specific_item': {
      const i = toNum(evalArgs());
      return toList(acc)[i - 1] ?? null;
    }
    case 'unique': {
      const seen = new Set<string>();
      return toList(acc).filter((x) => {
        const k = identityKey(x, ctx);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    case 'filtered':
      return applyListOps(toList(acc), p, ctx);
    case 'sorted':
      return sortList(toList(acc), p, ctx);
    case 'group_by':
      return groupBy(toList(acc), p, ctx);
    case 'merged_with': {
      const other = toList(evalArgs());
      const out = [...toList(acc)];
      for (const x of other) if (!out.some((y) => looseEquals(x, y))) out.push(x);
      return out;
    }
    case 'minus_list': {
      const other = toList(evalArgs());
      return toList(acc).filter((x) => !other.some((y) => looseEquals(x, y)));
    }
    case 'minus_element': {
      const e = evalArgs();
      return toList(acc).filter((x) => !looseEquals(x, e));
    }
    case 'plus_element':
      return [...toList(acc), evalArgs()];
    case 'convert_to_list':
      return acc == null ? [] : [acc];
    case 'list_from':
      return toList(acc).slice(toNum(evalArgs()) - 1);
    case 'limit_to':
      return toList(acc).slice(0, toNum(evalArgs()));
    case 'to_range':
      return [acc, evalArgs()];
    case 'join':
      return toList(acc).map((x) => coerceText(x, ctx)).join(coerceText(evalArgs(), ctx));
    case 'random_item': {
      const l = toList(acc);
      return l[Math.floor(Math.random() * l.length)] ?? null;
    }

    // ---- texto
    case 'append':
      return coerceText(acc, ctx) + coerceText(evalArgs(), ctx);
    case 'find_replace': {
      const find = coerceText(evaluate(p.find, ctx), ctx);
      const replace = p.replace !== undefined ? coerceText(evaluate(p.replace, ctx), ctx) : '';
      const s = coerceText(acc, ctx);
      if (!find) return s;
      if (p.use_regex) {
        try {
          return s.replace(new RegExp(find, 'g'), replace);
        } catch {
          return s;
        }
      }
      return s.split(find).join(replace);
    }
    case 'truncated':
      return coerceText(acc, ctx).slice(0, toNum(evalArgs()));
    case 'truncated_right':
      return coerceText(acc, ctx).slice(-toNum(evalArgs()));
    case 'trimmed':
      return coerceText(acc, ctx).trim();
    case 'to_uppercase':
      return coerceText(acc, ctx).toUpperCase();
    case 'to_lowercase':
      return coerceText(acc, ctx).toLowerCase();
    case 'to_capitalized_words':
      return coerceText(acc, ctx).replace(/\p{L}+/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
    case 'split_by':
      return coerceText(acc, ctx).split(coerceText(evaluate(p.separator, ctx), ctx));
    case 'extract_regex': {
      try {
        const re = new RegExp(coerceText(evaluate(p.regex, ctx), ctx), 'g');
        return coerceText(acc, ctx).match(re) ?? [];
      } catch {
        return [];
      }
    }
    case 'length':
      return coerceText(acc, ctx).length;
    case 'url':
      return typeof acc === 'string' ? acc : coerceText(acc, ctx);

    // ---- datas
    case 'plus_days':
      return dateAdd(acc, toNum(evalArgs()), 'day');
    case 'plus_hours':
      return dateAdd(acc, toNum(evalArgs()), 'hour');
    case 'plus_minutes':
      return dateAdd(acc, toNum(evalArgs()), 'minute');
    case 'plus_seconds':
      return dateAdd(acc, toNum(evalArgs()), 'second');
    case 'plus_years':
      return dateAdd(acc, toNum(evalArgs()), 'year');
    case 'change_date': {
      const d = toDate(acc);
      d.setDate(toNum(evalArgs()));
      return d;
    }
    case 'change_hours': {
      const d = toDate(acc);
      d.setHours(toNum(evalArgs()));
      return d;
    }
    case 'change_minutes': {
      const d = toDate(acc);
      d.setMinutes(toNum(evalArgs()));
      return d;
    }
    case 'change_seconds': {
      const d = toDate(acc);
      d.setSeconds(toNum(evalArgs()));
      return d;
    }
    case 'extract_from_date': {
      const d = toDate(acc);
      const comp = p.component_to_extract as string;
      return comp === 'hour' ? d.getHours() : comp === 'date' ? d.getDate() : comp === 'month' ? d.getMonth() + 1 : comp === 'year' ? d.getFullYear() : 0;
    }
    case 'rounded_down': {
      const d = toDate(acc);
      d.setHours(0, 0, 0, 0);
      return d;
    }

    // ---- formatação
    case 'format_number':
      return formatNumber(toNum(acc), p);
    case 'format_date':
      return formatDate(acc, p);
    case 'format_boolean':
    case 'format_boolean_number':
      return toBool(acc) ? evaluate(p.formatting_for_true, ctx) : evaluate(p.formatting_for_false, ctx);
    case 'format_as_text': {
      const list = toList(acc);
      const delim = coerceText(evaluate(p.delimiter, ctx), ctx);
      return list
        .map((item) => {
          ctx.injected.push(item);
          const out = coerceText(evaluate(p.content, ctx), ctx);
          ctx.injected.pop();
          return out;
        })
        .join(delim);
    }
    case 'format_text':
      return encodeURIComponent(coerceText(acc, ctx));

    // ---- getters de elemento
    case 'get_data':
      return handleInputValue(acc, ctx);
    case 'get_group_data':
      return handleGroupData(acc, ctx);
    case 'get_list_data':
      return handleListData(acc, ctx);
    case 'display': {
      if (isOption(acc)) return acc.entry.display ?? acc.entry.key;
      if (isHandleRef(acc)) {
        const v = handleInputValue(acc, ctx);
        return isOption(v) ? (v.entry.display ?? v.entry.key) : coerceText(v, ctx);
      }
      return coerceText(acc, ctx);
    }
    case 'is_hovered':
      return isHandleRef(acc) ? ctx.store.hovered.has(acc.handle.key) : false;
    case 'is_pressed':
      return isHandleRef(acc) ? ctx.store.pressed.has(acc.handle.key) : false;
    case 'is_focused':
      return isHandleRef(acc) ? ctx.store.focusedKey === acc.handle.key : false;
    case 'is_visible':
      return isHandleRef(acc) ? effectiveVisible(acc.handle, ctx) : false;
    case 'isnt_visible':
      return isHandleRef(acc) ? !effectiveVisible(acc.handle, ctx) : true;
    case 'isnt_clickable':
      return false; // estado disabled dinâmico não modelado — workflows tratam
    case 'isnt_valid':
      return false;
    case 'get_pw_strength': {
      // escala 0–100 como o plugin de password strength da plataforma (apps comparam com limiares tipo 70)
      const v = coerceText(handleInputValue(acc, ctx), ctx);
      let s = 0;
      if (v.length >= 8) s += 25;
      if (/[a-z]/.test(v)) s += 15;
      if (/[A-Z]/.test(v)) s += 20;
      if (/[0-9]/.test(v)) s += 20;
      if (/[^A-Za-z0-9]/.test(v)) s += 20;
      return s;
    }
    case 'page_number':
      return isHandleRef(acc) ? (ctx.store.rgPage.get(acc.handle.key) ?? 0) + 1 : 1;

    // ---- user/thing builtins
    case 'logged_in':
      return ctx.store.currentUser != null;
    case 'not_logged_in':
      return ctx.store.currentUser == null;
    case '_id':
      return isThing(acc) ? acc._id : null;
    case 'email':
      return isThing(acc) ? ((acc.email as string) ?? '') : null;
    case 'Created Date':
      return isThing(acc) ? toDate(acc['Created Date']) : null;
    case 'Modified Date':
      return isThing(acc) ? toDate(acc['Modified Date']) : null;
    case 'Created By':
      return isThing(acc) ? ctx.store.db.resolve(acc['Created By']) : null;
    case 'Slug':
      return isThing(acc) ? ((acc.Slug as string) ?? (acc.slug as string) ?? '') : null;
    case 'message':
      return acc && typeof acc === 'object' && 'message' in (acc as object) ? (acc as { message: string }).message : '';
    case 'result':
    case 'resultlist':
    case 'status':
      return acc && typeof acc === 'object' ? ((acc as Record<string, unknown>)[name] ?? null) : null;
    case 'grouping0':
      return acc && typeof acc === 'object' ? ((acc as Record<string, unknown>).grouping0 ?? null) : null;
    case 'agg0':
      return acc && typeof acc === 'object' ? ((acc as Record<string, unknown>).agg0 ?? null) : null;
  }

  // ---- getters dinâmicos por prefixo
  if (name.startsWith('custom.')) return customStateValue(acc, name, ctx);
  if (name.startsWith('param_')) return reusableParam(acc, name.slice(6), ctx);
  if (name.startsWith('_api_c2_') || name.startsWith('_wf_') || name.startsWith('_p_')) {
    return acc && typeof acc === 'object' ? ((acc as Record<string, unknown>)[name] ?? null) : null;
  }
  if (/^get_[A-Z]{2}[A-Za-z]$/.test(name)) {
    // exposed state de plugin (toggle etc.) — usar input value da instância
    return handleInputValue(acc, ctx);
  }

  // ---- campo de dado / atributo de option set
  if (isOption(acc)) {
    // atributo ausente na opção = vazio (atributos são esparsos por opção)
    return resolveOptionAttrValue(acc.set, name, acc.entry[name] ?? null, ctx);
  }
  if (Array.isArray(acc)) {
    const mapped = acc.map((x) => applyMessage(x, { type: 'Message', name }, ctx)).filter((x) => x != null);
    return mapped.flat ? mapped.flat() : mapped;
  }
  if (isThing(acc)) return getField(acc, name, ctx);
  if (isHandleRef(acc)) {
    // getter de campo aplicado a um elemento = aplicado ao seu dado
    const data = handleGroupData(acc, ctx) ?? handleInputValue(acc, ctx);
    if (data != null && data !== acc) return applyMessage(data, { type: 'Message', name }, ctx);
    return null;
  }
  if (acc == null) return null;

  // string que é db_value de option + name que é atributo de algum set → atributo da option
  if (typeof acc === 'string') {
    const opt = ctx.store.options.resolveByAttr(name, acc);
    if (opt) return resolveOptionAttrValue(opt.set, name, opt.entry[name] ?? null, ctx);
  }

  warnOnce(`Operador não suportado: ${name}`);
  return null;
}

/** Resolve o valor de um atributo de option pelo tipo declarado no set (option/list.option/custom). */
function resolveOptionAttrValue(setRef: string, attrName: string, raw: unknown, ctx: EvalCtx): unknown {
  if (raw == null) return null;
  const t = ctx.store.options.attrType(setRef, attrName);
  if (!t) return raw;
  // listas no export podem vir como dict de chaves numéricas
  const asList = (v: unknown): unknown[] =>
    Array.isArray(v)
      ? v
      : v && typeof v === 'object' && Object.keys(v as object).every((k) => /^\d+$/.test(k))
        ? Object.keys(v as Record<string, unknown>)
            .sort((a, b) => parseInt(a) - parseInt(b))
            .map((k) => (v as Record<string, unknown>)[k])
        : [v];
  if (t.startsWith('option.')) {
    return typeof raw === 'string' ? (ctx.store.options.fromStored(t, raw) ?? raw) : raw;
  }
  if (t.startsWith('list.option.')) {
    const set = t.slice(5);
    return asList(raw).map((x) => (typeof x === 'string' ? (ctx.store.options.fromStored(set, x) ?? x) : x));
  }
  if (t.startsWith('custom.') || t === 'user') {
    return typeof raw === 'string' ? (ctx.store.db.resolve(raw) ?? raw) : raw;
  }
  if (t.startsWith('list.')) return asList(raw);
  return raw;
}

// ---------------------------------------------------------------- helpers de elemento

function resolveElementRef(elementId: string | undefined, ctx: EvalCtx): HandleRef | null {
  if (!elementId) return null;
  const h = ctx.store.resolveHandle(elementId, ctx.scope);
  if (h) return { __handle: true, handle: h };
  return null;
}

function defaultVisible(handle: ElementHandle): boolean {
  if (handle.el.type === 'Popup' || handle.el.type === 'GroupFocus') return false;
  return handle.el.properties?.is_visible !== false;
}

/** Visibilidade EFETIVA: considera states condicionais do elemento/style que alteram is_visible
 *  (ex.: "Group Login fica oculto quando o Group Cadastro está visível"). Guard anti-ciclo. */
const visibilityEvalStack = new Set<string>();
function effectiveVisible(handle: ElementHandle, ctx: EvalCtx): boolean {
  const base = ctx.store.visibilityOverride.get(handle.key) ?? defaultVisible(handle);
  if (visibilityEvalStack.has(handle.key)) return base;
  visibilityEvalStack.add(handle.key);
  try {
    type CondState = { condition?: unknown; properties?: Record<string, unknown> };
    let vis: boolean | undefined;
    const styleStates = (ctx.store.payload.styles[handle.el.style ?? ''] as { states?: Record<string, CondState> } | undefined)
      ?.states;
    for (const src of [styleStates, handle.el.states as Record<string, CondState> | undefined]) {
      if (!src) continue;
      for (const st of Object.values(src)) {
        if (!st?.properties || !('is_visible' in st.properties)) continue;
        try {
          if (toBool(evaluate(st.condition, { ...ctx, scope: handle.scope, thisHandle: handle }))) {
            vis = st.properties.is_visible !== false;
          }
        } catch {
          /* condição irresolúvel neste contexto → ignora */
        }
      }
    }
    return vis !== undefined ? vis : base;
  } finally {
    visibilityEvalStack.delete(handle.key);
  }
}

function handleInputValue(acc: unknown, ctx: EvalCtx): unknown {
  if (!isHandleRef(acc)) return null;
  const stored = ctx.store.inputValues.get(acc.handle.key);
  if (stored !== undefined) return stored;
  // valor inicial (content/default) avaliado no contexto do elemento
  const el = acc.handle.el;
  const init = el.properties?.content ?? el.properties?.default;
  if (init != null) {
    return evaluate(init, { ...ctx, scope: acc.handle.scope, thisHandle: acc.handle });
  }
  return null;
}

export function handleGroupData(acc: unknown, ctx: EvalCtx): unknown {
  if (!isHandleRef(acc)) return null;
  return groupDataOf(acc.handle, ctx);
}

function handleListData(acc: unknown, ctx: EvalCtx): unknown[] {
  if (!isHandleRef(acc)) return [];
  const h = acc.handle;
  const ds = h.el.properties?.data_source;
  if (ds == null) return [];
  const v = evaluate(ds, { ...ctx, scope: h.scope, thisHandle: h });
  return toList(v);
}

const groupDataGuard = new Set<string>();

export function groupDataOf(handle: ElementHandle, ctx: EvalCtx): unknown {
  const override = ctx.store.groupDataOverride.get(handle.key);
  if (override !== undefined) return override;
  const ds = handle.el.properties?.data_source;
  if (ds != null) {
    if (groupDataGuard.has(handle.key)) return null;
    groupDataGuard.add(handle.key);
    try {
      return evaluate(ds, { ...ctx, scope: handle.scope, thisHandle: handle });
    } finally {
      groupDataGuard.delete(handle.key);
    }
  }
  if (handle.dataGetter) return handle.dataGetter();
  return undefined; // sem data source
}

// ---------------------------------------------------------------- fontes globais

function pageData(name: string, ctx: EvalCtx): unknown {
  switch (name) {
    case 'Current Page Width':
      return ctx.pageWidth;
    case 'Current Date/Time':
      return new Date();
    case 'Website Home':
      return typeof window !== 'undefined' ? `${window.location.origin}/` : '/';
    case 'This Url':
      return typeof window !== 'undefined' ? window.location.href : '';
    case 'AppVersion':
      return 'live'; // espelha o site publicado (esconde banners de ambiente de teste)
    case 'AppIsTest':
      return false;
    case 'Current Page Name':
      return ctx.store.payload.pageName;
    case 'Page Loaded (Entire)':
      return true;
    default:
      warnOnce(`PageData não suportado: ${name}`);
      return null;
  }
}

/** Resolve o item da página (Current Page Item) a partir do segmento de path. */
function currentPageItem(ctx: EvalCtx): unknown {
  const seg = ctx.pathData;
  if (!seg) return null;
  const itemType = ctx.store.payload.page.properties?.page_item_type as string | undefined;
  if (!itemType || itemType === 'text') return seg;
  return lookupThingBySegment(itemType, seg, ctx);
}

function lookupThingBySegment(typeRef: string, seg: string, ctx: EvalCtx): unknown {
  const list = ctx.store.db.all(typeRef);
  return (
    list.find((t) => t._id === seg) ??
    list.find((t) => (t.Slug as string) === seg || (t.slug as string) === seg) ??
    null
  );
}

function getParamFromUrl(n: ExprNode, ctx: EvalCtx): unknown {
  const p = (n.properties ?? {}) as Record<string, unknown>;
  let raw: string | null = null;
  if (p.type === 'path') {
    raw = ctx.pathData;
  } else {
    const paramName = coerceText(evaluate(p.parameter_name, ctx), ctx);
    raw = paramName ? (ctx.query[paramName] ?? null) : null;
  }
  if (raw == null || raw === '') return null;
  const btype = p.value as string | undefined;
  if (!btype || btype === 'text') return raw;
  if (btype.startsWith('option.')) return ctx.store.options.get(btype, raw) ?? raw;
  if (btype.startsWith('custom.') || btype === 'user') return lookupThingBySegment(btype, raw, ctx);
  if (btype === 'number') return toNum(raw);
  if (btype === 'boolean') return raw === 'true' || raw === 'yes';
  return raw;
}

/** "Parent group's thing": sobe na árvore até achar dado (grupo com data source, célula, reusable). */
function elementParentData(ctx: EvalCtx): unknown {
  let h = ctx.thisHandle?.parentHandle ?? null;
  while (h) {
    const data = groupDataOf(h, ctx);
    if (data !== undefined && data !== null) return data;
    h = h.parentHandle;
  }
  // célula de RG mais próxima
  let s: Scope | null = ctx.scope;
  while (s) {
    if (s.kind === 'cell' && s.cellItem != null) return s.cellItem;
    s = s.parent;
  }
  return null;
}

function customStateValue(acc: unknown, stateKey: string, ctx: EvalCtx): unknown {
  let handle: ElementHandle | null = null;
  if (isHandleRef(acc)) handle = acc.handle;
  else if (acc == null && ctx.thisHandle) handle = ctx.thisHandle;
  if (!handle) return null;
  type Decl = { default_val?: unknown; type?: string };
  const decl =
    (handle.el as { custom_states?: Record<string, Decl> }).custom_states?.[stateKey.replace(/^custom\./, '')] ??
    (handle.scope.container.custom_states as Record<string, Decl> | undefined)?.[stateKey.replace(/^custom\./, '')];
  const stored = ctx.store.getCustomState(handle.key, stateKey);
  const value = stored !== undefined ? stored : (decl?.default_val ?? null);
  // valor persistido como string → resolver para o domínio declarado (option/Thing)
  if (typeof value === 'string' && typeof decl?.type === 'string') {
    if (decl.type.startsWith('option.')) return ctx.store.options.fromStored(decl.type, value) ?? value;
    if (decl.type.startsWith('custom.') || decl.type === 'user') return ctx.store.db.resolve(value) ?? value;
  }
  return value;
}

function reusableParam(acc: unknown, paramId: string, ctx: EvalCtx): unknown {
  // acc pode ser handle da instância (CustomElement) ou do root do reusable
  if (isHandleRef(acc)) {
    const h = acc.handle;
    if (h.el.type === 'CustomElement') {
      const raw = h.el.properties?.[`param_${paramId}`];
      if (raw !== undefined) {
        // avaliado no escopo do PAI da instância
        return evaluate(raw, { ...ctx, scope: h.scope, thisHandle: h.parentHandle });
      }
    }
  }
  // dentro do próprio reusable: busca escopo reusable na cadeia
  let s: Scope | null = ctx.scope;
  while (s) {
    if (s.kind === 'reusable' && s.reusableParams && paramId in s.reusableParams) {
      return (s.reusableParams[paramId] as () => unknown)?.();
    }
    s = s.parent;
  }
  return null;
}

// ---------------------------------------------------------------- Search / constraints

interface ConstraintDef {
  key?: string;
  constraint_type?: string | { type: string };
  value?: unknown;
}

export function runSearch(props: Record<string, unknown>, ctx: EvalCtx): unknown[] {
  const type = (props.type_to_find as string) ?? '';
  let list: unknown[] = [...ctx.store.db.all(type)];
  list = applyConstraints(list, props.constraints as Record<string, ConstraintDef> | undefined, ctx, props.ignore_empty_constraints === true);
  list = applySort(list, props, ctx);
  return list;
}

function applyListOps(list: unknown[], props: Record<string, unknown>, ctx: EvalCtx): unknown[] {
  let out = applyConstraints(list, props.constraints as Record<string, ConstraintDef> | undefined, ctx, props.ignore_empty_constraints === true);
  if (props.sort_field) out = applySort(out, props, ctx);
  return out;
}

function applyConstraints(
  list: unknown[],
  constraints: Record<string, ConstraintDef> | undefined,
  ctx: EvalCtx,
  ignoreEmpty: boolean,
): unknown[] {
  if (!constraints) return list;
  let out = list;
  const keys = Object.keys(constraints).sort((a, b) => parseInt(a) - parseInt(b));
  for (const k of keys) {
    const c = constraints[k];
    if (!c) continue;
    const ctype = typeof c.constraint_type === 'string' ? c.constraint_type : null;

    if (c.key === '_advanced_search_constraint') {
      out = out.filter((item) => {
        ctx.injected.push(item);
        const ok = toBool(evaluate(c.value, ctx));
        ctx.injected.pop();
        return ok;
      });
      continue;
    }
    if (!ctype) continue; // constraint sem tipo → ignorar
    if (ctype === 'is_empty' || ctype === 'is_not_empty') {
      out = out.filter((item) => {
        const fv = getFieldRaw(item, c.key ?? '', ctx);
        return ctype === 'is_empty' ? isEmpty(fv) : !isEmpty(fv);
      });
      continue;
    }
    const target = evaluate(c.value, ctx);
    // "Ignorar constraint vazia" é OPT-IN na plataforma (`ignore_empty_constraints`, o checkbox da
    // busca) — e neste app NENHUMA das 234 buscas o liga: 209 não declaram, 25 declaram
    // `false`. Nós ignorávamos sempre que o valor saía vazio, o que transformava
    // "os produtos DESTE usuário" em "todos os produtos da base".
    //
    // Referência ausente (`null`) e texto vazio (`''`) têm que ser tratados diferente:
    //  - `null` = a coisa não existe (Current User deslogado, Current Page Item sem id na
    //    URL). A constraint vale e não casa com nada. Medido: /perfil anônimo no real mostra
    //    o empty state "Parece que o não anunciou nada ainda", não a base inteira; e o header
    //    mostra "Anuncie aqui" em vez de "Gerenciar comércio".
    //  - `''` = campo de filtro em branco. Aí sim ignorar é o comportamento útil e esperado,
    //    senão a listagem nasce vazia até o usuário digitar algo.
    if (isEmpty(target) && typeof c.value === 'object' && ctype !== 'not equal') {
      if (ignoreEmpty || target === '') continue;
      if (target == null) {
        out = [];
        break;
      }
    }
    out = out.filter((item) => {
      const fv = getFieldRaw(item, c.key ?? '', ctx);
      switch (ctype) {
        case 'equals':
          return looseEquals(resolveStored(fv, c.key ?? '', item, ctx), target);
        case 'not equal':
          return !looseEquals(resolveStored(fv, c.key ?? '', item, ctx), target);
        case 'email_equals':
          return coerceText(fv, ctx).toLowerCase() === coerceText(target, ctx).toLowerCase();
        case 'in': {
          const targets = toList(target);
          return targets.some((t) => looseEquals(resolveStored(fv, c.key ?? '', item, ctx), t));
        }
        case 'contains': {
          const l = toList(fv);
          return l.some((x) => looseEquals(x, target));
        }
        case 'gte':
          return toComparable(fv) >= toComparable(target);
        case 'lte':
          return toComparable(fv) <= toComparable(target);
        case 'gt':
          return toComparable(fv) > toComparable(target);
        case 'lt':
          return toComparable(fv) < toComparable(target);
        default:
          warnOnce(`constraint_type não suportado: ${ctype}`);
          return true;
      }
    });
  }
  return out;
}

function applySort(list: unknown[], props: Record<string, unknown>, ctx: EvalCtx): unknown[] {
  return sortList(list, props, ctx);
}

function sortList(list: unknown[], props: Record<string, unknown>, ctx: EvalCtx): unknown[] {
  let field = props.sort_field as string | undefined;
  if (!field) return list;
  if (field === '_dynamic_sort_field') {
    field = coerceText(evaluate(props.dynamic_sort_field, ctx), ctx);
  }
  const desc = typeof props.descending === 'boolean' ? props.descending : toBool(evaluate(props.descending, ctx));
  const sorted = [...list].sort((a, b) => {
    const va = toComparable(getFieldRaw(a, field!, ctx));
    const vb = toComparable(getFieldRaw(b, field!, ctx));
    return va < vb ? -1 : va > vb ? 1 : 0;
  });
  return desc ? sorted.reverse() : sorted;
}

function groupBy(list: unknown[], props: Record<string, unknown>, ctx: EvalCtx): unknown[] {
  const groupings = Object.values((props.groupings as Record<string, { message?: string }>) ?? {});
  const aggs = Object.values((props.aggregations as Record<string, { fn?: string; message?: string }>) ?? {});
  const field = groupings[0]?.message ?? '';
  const map = new Map<string, { grouping0: unknown; items: unknown[] }>();
  for (const item of list) {
    const gv = getField(item as Thing, field, ctx);
    const k = identityKey(gv, ctx);
    if (!map.has(k)) map.set(k, { grouping0: gv, items: [] });
    map.get(k)!.items.push(item);
  }
  return [...map.values()].map((g) => {
    const out: Record<string, unknown> = { grouping0: g.grouping0 };
    aggs.forEach((a, i) => {
      const vals = g.items.map((it) => toNum(getFieldRaw(it, a.message ?? '', ctx)));
      out[`agg${i}`] = a.fn === 'sum' ? vals.reduce((s, x) => s + x, 0) : vals.length;
    });
    return out;
  });
}

// ---------------------------------------------------------------- campos de Thing

/** Valor cru do campo (sem resolver referências) — para constraints e sort. */
function getFieldRaw(item: unknown, fieldId: string, ctx: EvalCtx): unknown {
  if (item == null || typeof item !== 'object') return null;
  const t = item as Record<string, unknown>;
  if (fieldId === '_id') return t._id;
  const v = t[fieldId];
  if (v !== undefined) {
    // datas ISO → Date para ordenação/comparação
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v);
    return v;
  }
  return null;
}

/** Resolve o valor armazenado para o domínio certo (refs → Things, options → OptionRef). */
function resolveStored(raw: unknown, fieldId: string, item: unknown, ctx: EvalCtx): unknown {
  void item;
  if (raw == null) return null;
  const optMatch = fieldId.match(/_option_(.+)$/);
  if (optMatch && typeof raw === 'string') {
    return ctx.store.options.fromStored(optMatch[1], raw) ?? raw;
  }
  // lista de options (`x_list_option_<set>`): resolver item a item, igual ao campo single.
  // Sem isto o db_value cru vaza para a tela ("caf_" no lugar de "Café") e operadores de
  // lista (:display, :filtered, :first item) passam a operar sobre string, não sobre option.
  if (optMatch && Array.isArray(raw)) {
    return raw.map((x) => (typeof x === 'string' ? (ctx.store.options.fromStored(optMatch[1], x) ?? x) : x));
  }
  if (/(_custom_|_user$|^Created By$)/.test(fieldId) && typeof raw === 'string') {
    return ctx.store.db.resolve(raw) ?? raw;
  }
  if (Array.isArray(raw) && /_list_custom_|_list_user/.test(fieldId)) {
    return raw.map((x) => ctx.store.db.resolve(x) ?? x);
  }
  return raw;
}

/** Getter de campo com resolução de tipo (usado pelo avaliador). */
export function getField(thing: Thing, fieldId: string, ctx: EvalCtx): unknown {
  const raw = getFieldRaw(thing, fieldId, ctx);
  return resolveStored(raw, fieldId, thing, ctx);
}

// ---------------------------------------------------------------- coerções

export function toBool(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v === 'true' || v === 'yes';
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

export function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    // Data em ISO tem que virar timestamp, não `parseFloat`. As datas chegam do banco como
    // string, e `parseFloat("2025-10-24T17:02:14Z")` devolve 2025 — o que fazia
    // `Current Date/Time minus Created Date` calcular sobre o ANO em vez da data.
    // `toComparable` já fazia isso; `toNum`, que é quem a aritmética usa, não.
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).getTime();
    const n = parseFloat(v.replace(',', '.'));
    return Number.isNaN(n) ? 0 : n;
  }
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'boolean') return v ? 1 : 0;
  return 0;
}

function toComparable(v: unknown): number | string {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).getTime();
    return v.toLowerCase();
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v == null) return -Infinity;
  return String(v);
}

export function toList(v: unknown): unknown[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function toDate(v: unknown): Date {
  if (v instanceof Date) return new Date(v.getTime());
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

function dateAdd(v: unknown, n: number, unit: 'day' | 'hour' | 'minute' | 'second' | 'year'): Date {
  const d = toDate(v);
  if (unit === 'day') d.setDate(d.getDate() + n);
  else if (unit === 'hour') d.setTime(d.getTime() + n * 3600000);
  else if (unit === 'minute') d.setTime(d.getTime() + n * 60000);
  else if (unit === 'second') d.setTime(d.getTime() + n * 1000);
  else if (unit === 'year') d.setFullYear(d.getFullYear() + n);
  return d;
}

export function isEmpty(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === 'string') return v === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function identityKey(v: unknown, ctx: EvalCtx): string {
  if (isThing(v)) return `t:${v._id}`;
  if (isOption(v)) return `o:${v.set}:${v.entry.key}`;
  void ctx;
  return `v:${String(v)}`;
}

export function looseEquals(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (isThing(a) && isThing(b)) return a._id === b._id;
  if (isThing(a) && typeof b === 'string') return a._id === b;
  if (typeof a === 'string' && isThing(b)) return a === b._id;
  if (isOption(a) || isOption(b)) {
    const ka = isOption(a) ? [a.entry.key, a.entry.db_value, a.entry.display] : [a];
    const kb = isOption(b) ? [b.entry.key, b.entry.db_value, b.entry.display] : [b];
    return ka.some((x) => x != null && kb.some((y) => y != null && x === y));
  }
  if (a instanceof Date || b instanceof Date) return toNum(a) === toNum(b);
  if (typeof a === 'number' || typeof b === 'number') return toNum(a) === toNum(b);
  if (typeof a === 'boolean' || typeof b === 'boolean') return toBool(a) === toBool(b);
  return a === b;
}

export function coerceText(v: unknown, ctx: EvalCtx): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') {
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100).replace('.', ',');
  }
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (v instanceof Date) return formatDate(v, { formatting_type: 'custom', custom_format: 'dd/mm/yyyy HH:MM' }) as string;
  if (Array.isArray(v)) return v.map((x) => coerceText(x, ctx)).join(', ');
  if (isOption(v)) return v.entry.display ?? v.entry.key;
  if (isHandleRef(v)) {
    const data = handleInputValue(v, ctx);
    return data == null ? '' : coerceText(data, ctx);
  }
  if (isThing(v)) {
    for (const k of ['nome_text', 'nome_completo_text', 'titulo_do_evento_text', 'name_text', 'display']) {
      if (typeof v[k] === 'string' && v[k]) return v[k] as string;
    }
    return v._id;
  }
  return String(v);
}

// ---------------------------------------------------------------- formatação

function formatNumber(n: number, p: Record<string, unknown>): string {
  const decimals = (p.decimal_place as number) ?? 2;
  const decSep = p.decimal_separator === 'comma' ? ',' : '.';
  const thouSep = p.thousand_separator === 'dot' ? '.' : p.thousand_separator === 'comma' ? ',' : p.thousand_separator === 'space' ? ' ' : p.thousand_separator === 'none' ? '' : '.';
  const fixed = Math.abs(n).toFixed(decimals);
  const [intPart, decPart] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, thouSep);
  const sign = n < 0 ? '-' : '';
  const num = decPart !== undefined ? `${grouped}${decSep}${decPart}` : grouped;
  const symbol = (p.currency_symbol as string) ?? '';
  return p.formatting_type === 'currency' ? `${sign}${symbol}${symbol.endsWith(' ') ? '' : ' '}${num}`.replace(`${symbol} `, `${symbol} `) : sign + num;
}

/** Tokens estilo dateFormat (steven levithan): yyyy yy mm dd HH MM ss + literais entre aspas. */
export function formatDate(v: unknown, p: Record<string, unknown>): string {
  const d = toDate(v);
  if (p.formatting_type === 'iso_date') return d.toISOString();
  const fmt = (p.custom_format as string) ?? 'dd/mm/yyyy';
  const pad = (x: number, l = 2) => String(x).padStart(l, '0');
  return fmt.replace(/("[^"]*"|'[^']*'|yyyy|yy|mm|dd|HH|MM|ss)/g, (tok) => {
    switch (tok) {
      case 'yyyy':
        return String(d.getFullYear());
      case 'yy':
        return pad(d.getFullYear() % 100);
      case 'mm':
        return pad(d.getMonth() + 1);
      case 'dd':
        return pad(d.getDate());
      case 'HH':
        return pad(d.getHours());
      case 'MM':
        return pad(d.getMinutes());
      case 'ss':
        return pad(d.getSeconds());
      default:
        return tok.slice(1, -1); // literal entre aspas
    }
  });
}
