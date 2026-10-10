// Executor de workflows (spec: analysis/03_workflows.md).
// Ações sequenciais e await-áveis; PreviousStep lê resultados por action_id.
import { coerceText, evaluate, isEmpty, toBool, toList, type EvalCtx } from './expressions';
import { isOption, optionStoredValue, type Thing } from './data';
import type { ElementHandle, RuntimeStore, Scope } from './store';
import type { NocodeWorkflow, WorkflowAction } from './types';

export interface WorkflowEnv {
  store: RuntimeStore;
  navigate: (path: string) => void;
  makeCtx: (scope: Scope, thisHandle: ElementHandle | null) => EvalCtx;
}

function sortedActions(wf: NocodeWorkflow): WorkflowAction[] {
  const actions = wf.actions ?? {};
  return Object.keys(actions)
    .sort((a, b) => parseInt(a) - parseInt(b))
    .map((k) => ({ ...actions[k], id: actions[k].id ?? k }));
}

function assignmentValue(v: unknown, ctx: EvalCtx): unknown {
  const out = evaluate(v, ctx);
  if (isOption(out)) return optionStoredValue(out);
  if (out && typeof out === 'object' && '_id' in (out as object)) return (out as Thing)._id;
  if (Array.isArray(out)) {
    return out.map((x) =>
      isOption(x) ? optionStoredValue(x) : x && typeof x === 'object' && '_id' in (x as object) ? (x as Thing)._id : x,
    );
  }
  if (out instanceof Date) return out.toISOString();
  return out;
}

function buildChanges(
  changes: Record<string, { key?: string; value?: unknown; action?: unknown }> | undefined,
  ctx: EvalCtx,
  existing?: Thing | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!changes) return out;
  for (const k of Object.keys(changes).sort((a, b) => parseInt(a) - parseInt(b))) {
    const c = changes[k];
    if (!c?.key) continue;
    const op = typeof c.action === 'string' ? c.action : 'set';
    const val = assignmentValue(c.value, ctx);
    if (op === 'add') {
      const cur = toList(existing?.[c.key] ?? out[c.key]);
      out[c.key] = [...cur, val];
    } else if (op === 'add_list') {
      const cur = toList(existing?.[c.key] ?? out[c.key]);
      out[c.key] = [...cur, ...toList(val)];
    } else if (op === 'remove') {
      const cur = toList(existing?.[c.key] ?? out[c.key]);
      out[c.key] = cur.filter((x) => x !== val);
    } else {
      out[c.key] = val;
    }
  }
  return out;
}

export async function runWorkflow(
  wf: NocodeWorkflow,
  env: WorkflowEnv,
  scope: Scope,
  thisHandle: ElementHandle | null,
  params?: Record<string, unknown>,
  error?: { message: string },
): Promise<Map<string, unknown>> {
  const results = new Map<string, unknown>();
  if ((wf.properties as Record<string, unknown> | undefined)?.workflow_disabled === true) return results;

  const baseCtx = (): EvalCtx => ({
    ...env.makeCtx(scope, thisHandle),
    stepResults: results,
    workflowParams: params,
    workflowError: error,
  });

  const cond = (wf.properties as Record<string, unknown> | undefined)?.condition;
  if (cond != null && !toBool(evaluate(cond, baseCtx()))) return results;

  for (const action of sortedActions(wf)) {
    const ctx = baseCtx();
    const p = (action.properties ?? {}) as Record<string, unknown>;
    if (p.condition != null && !toBool(evaluate(p.condition, ctx))) continue;
    if (action.type === 'TerminateWorkflow') break;
    try {
      const result = await runAction(action, p, ctx, env, scope);
      results.set(action.id, result);
    } catch (e) {
      console.warn('[nocode-runtime] erro em ação', action.type, e);
      // dispara OnPageError do container
      const onError = Object.values(scope.container.workflows ?? {}).find((w) => w.type === 'OnPageError');
      if (onError && wf !== onError) {
        void runWorkflow(onError, env, scope, thisHandle, undefined, { message: String((e as Error)?.message ?? e) });
      }
    }
  }
  return results;
}

async function runAction(
  action: WorkflowAction,
  p: Record<string, unknown>,
  ctx: EvalCtx,
  env: WorkflowEnv,
  scope: Scope,
): Promise<unknown> {
  const store = env.store;
  const resolveTarget = (): ElementHandle | null => {
    if (p.element_id) return store.resolveHandle(p.element_id as string, scope);
    // Sem `element_id`, a ação recai sobre o CONTAINER do workflow — a página ou o reusable
    // onde ele vive. É assim que um reusable define o próprio custom state (o ReusableEl
    // registra um alias com o id da definição justamente para isso). Sem este fallback, o
    // SetCustomState é descartado em silêncio: o carrossel de anunciante calculava as fotos
    // certas e nunca as gravava, renderizando um bloco vazio.
    let s: Scope | null = scope;
    while (s) {
      const id = (s.container as { id?: string })?.id;
      const h = id ? store.resolveHandle(id, s) : null;
      if (h) return h;
      s = s.parent;
    }
    return null;
  };

  switch (action.type) {
    // ---- navegação
    case 'ChangePage': {
      const destId = p.element_id as string;
      const dest = Object.entries(store.payload.pageNames).find(([pid]) => {
        const page = pid;
        return page === destId;
      });
      // pageNames é pid->name, mas ChangePage referencia o campo `id` da página
      let name: string | undefined = dest?.[1];
      if (!name) {
        name = store.payload.pageIdsByElementId?.[destId];
      }
      if (!name) {
        console.warn('[nocode-runtime] ChangePage destino desconhecido', destId);
        return null;
      }
      let path = `/${name === 'index' ? '' : name}`;
      const data = p.data_to_send;
      if (data != null) {
        const v = typeof data === 'string' ? data : evaluate(data, ctx);
        const seg = v && typeof v === 'object' && '_id' in (v as object)
          ? ((v as Thing).Slug as string) || (v as Thing)._id
          : coerceText(v, ctx);
        if (seg) path += `/${encodeURIComponent(seg)}`;
      }
      const qs = new URLSearchParams();
      if (p.keep_current_page_params && typeof window !== 'undefined') {
        new URLSearchParams(window.location.search).forEach((v, k) => qs.set(k, v));
      }
      if (p.add_parameters && p.url_parameters) {
        for (const up of Object.values(p.url_parameters as Record<string, { key?: string; value?: unknown }>)) {
          if (up?.key) qs.set(up.key, coerceText(evaluate(up.value, ctx), ctx));
        }
      }
      const q = qs.toString();
      env.navigate(path + (q ? `?${q}` : ''));
      return null;
    }
    case 'OpenURL': {
      const url = coerceText(evaluate(p.url, ctx), ctx);
      if (typeof window !== 'undefined' && url) {
        if (p.open_in_new_tab) window.open(url, '_blank');
        else window.location.href = url;
      }
      return null;
    }
    case 'RefreshPage':
      if (typeof window !== 'undefined') window.location.reload();
      return null;
    case 'GoPrevious':
      if (typeof window !== 'undefined') window.history.back();
      return null;
    case 'ScrollToElement':
      resolveTarget()?.dom?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return null;

    // ---- elementos
    case 'ShowElement': {
      const h = resolveTarget();
      if (h) store.setVisible(h.key, true);
      return null;
    }
    case 'HideElement': {
      const h = resolveTarget();
      if (h) store.setVisible(h.key, false);
      return null;
    }
    case 'ToggleElement': {
      const h = resolveTarget();
      if (h) {
        const def = h.el.type === 'Popup' || h.el.type === 'GroupFocus' ? false : h.el.properties?.is_visible !== false;
        store.toggleVisible(h.key, def);
      }
      return null;
    }
    case 'ResetGroup': {
      const h = resolveTarget();
      if (h) {
        store.groupDataOverride.delete(h.key);
        store.resetInputsUnder(h.key.split(':')[0]);
      }
      return null;
    }
    case 'ResetInputs':
      store.resetInputsUnder(null);
      return null;
    case 'DisplayGroupData': {
      const h = resolveTarget();
      if (h) {
        const data = evaluate(p.data_source, ctx);
        store.groupDataOverride.set(h.key, data);
        store.bump();
      }
      return null;
    }
    case 'SetFocusToElement':
      resolveTarget()?.dom?.querySelector<HTMLElement>('input,textarea,select,button')?.focus();
      return null;
    case 'AnimateElement': {
      const h = resolveTarget();
      if (h?.dom) {
        const dur = (p.duration as number) ?? 300;
        h.dom.style.transition = `opacity ${dur}ms ease, transform ${dur}ms ease`;
        h.dom.style.opacity = '0';
        h.dom.style.transform = 'translateX(-40px)';
        setTimeout(() => {
          if (h.dom) {
            h.dom.style.opacity = '';
            h.dom.style.transform = '';
          }
        }, dur);
      }
      return null;
    }
    case 'ListShowNext':
    case 'ListShowPrevious': {
      const h = resolveTarget();
      if (h) {
        const cur = store.rgPage.get(h.key) ?? 0;
        store.rgPage.set(h.key, Math.max(0, cur + (action.type === 'ListShowNext' ? 1 : -1)));
        store.bump();
      }
      return null;
    }
    case 'AlertShowMessage': {
      const h = resolveTarget();
      if (h) {
        if (p.change_message && p.message !== undefined) {
          store.alertMessages.set(h.key, coerceText(evaluate(p.message, ctx), ctx));
        }
        const hold = typeof p.hold === 'number' ? p.hold : 2000;
        store.setVisible(h.key, true);
        setTimeout(() => store.setVisible(h.key, false), hold);
      }
      return null;
    }

    // ---- estado
    case 'SetCustomState': {
      const h = resolveTarget();
      if (h && p.custom_state) {
        const value = p.value !== undefined ? evaluate(p.value, ctx) : null;
        store.setCustomState(h.key, p.custom_state as string, value);
        const extra = p.custom_states_values as Record<string, { custom_state?: string; value?: unknown }> | undefined;
        if (extra) {
          for (const ev of Object.values(extra)) {
            if (ev?.custom_state) store.setCustomState(h.key, ev.custom_state, evaluate(ev.value, ctx));
          }
        }
      }
      return null;
    }

    // ---- dados
    case 'NewThing': {
      const type = (p.thing_type as string) ?? '';
      const fields = buildChanges(p.initial_values as Parameters<typeof buildChanges>[0], ctx);
      applySchemaDefaults(type, fields, ctx);
      const created = ctx.store.db.create(type, {
        ...fields,
        'Created By': ctx.store.currentUser?._id ?? null,
      });
      return created;
    }
    case 'ChangeThing': {
      const resolved = evaluate(p.to_change, ctx);
      const target = ctx.store.db.resolve(resolved);
      if (!target) console.warn('[nocode-runtime] ChangeThing: alvo não resolvido', resolved, p.to_change);
      if (target) ctx.store.db.update(target, buildChanges(p.changes as Parameters<typeof buildChanges>[0], ctx, target));
      return target;
    }
    case 'ChangeListOfThings': {
      const list = toList(evaluate(p.to_change, ctx));
      for (const item of list) {
        const t = ctx.store.db.resolve(item);
        if (t) {
          ctx.injected.push(t);
          ctx.store.db.update(t, buildChanges(p.changes as Parameters<typeof buildChanges>[0], ctx, t));
          ctx.injected.pop();
        }
      }
      return list;
    }
    case 'MakeChangeCurrentUser': {
      const u = ctx.store.currentUser;
      if (u) ctx.store.db.update(u, buildChanges(p.changes as Parameters<typeof buildChanges>[0], ctx, u));
      return u;
    }
    case 'DeleteThing': {
      const t = ctx.store.db.resolve(evaluate(p.to_delete, ctx));
      ctx.store.db.delete(t);
      return null;
    }
    case 'DeleteListOfThings': {
      for (const item of toList(evaluate(p.to_delete, ctx))) ctx.store.db.delete(ctx.store.db.resolve(item));
      return null;
    }
    case 'CopyListOfThings': {
      const list = toList(evaluate(p.to_copy, ctx));
      return list.map((item) => {
        const t = ctx.store.db.resolve(item);
        if (!t) return null;
        const { _id, ...rest } = t;
        void _id;
        return ctx.store.db.create((p.type_to_copy as string) ?? (t.__type as string), rest);
      });
    }

    // ---- auth (fake)
    case 'LogIn': {
      const email = coerceText(evaluate(p.email, ctx), ctx);
      return store.logIn(email || 'admin@exemplo.test');
    }
    case 'LogOut':
      store.logOut();
      return null;
    case 'SignUp': {
      const email = coerceText(evaluate(p.email, ctx), ctx);
      const fields = buildChanges(p.changes as Parameters<typeof buildChanges>[0], ctx);
      return store.signUp(email || `novo${Date.now()}@exemplo.test`, fields);
    }
    case 'CreateUserAccount': {
      const email = coerceText(evaluate(p.email, ctx), ctx);
      const fields = buildChanges(p.changes as Parameters<typeof buildChanges>[0], ctx);
      return ctx.store.db.create('user', { email, ...fields });
    }
    case 'SendPasswordResetEmail':
      store.showToast({ message: 'E-mail de redefinição enviado (mock).' });
      return null;
    case 'ResetPassword':
    case 'UpdateCredentials':
      store.showToast({ message: 'Credenciais atualizadas (mock).' });
      return store.currentUser;
    case 'SetTemporaryPassword':
      return 'Temp@123';
    case 'SendMagicLink':
    case 'SendEmail':
      store.showToast({ message: 'E-mail enviado (mock).' });
      return null;

    // ---- fluxo
    case 'TriggerCustomEvent': {
      const ceId = p.custom_event as string;
      const ce = Object.values(scope.container.workflows ?? {}).find((w) => w.id === ceId && w.type === 'CustomEvent');
      if (!ce) {
        console.warn('[nocode-runtime] CustomEvent não encontrado', ceId);
        return null;
      }
      const ceParams: Record<string, unknown> = {};
      const args = p.arguments as Record<string, { param_id?: string; arg_value?: unknown }> | undefined;
      if (args) {
        for (const a of Object.values(args)) {
          if (a?.param_id) ceParams[a.param_id] = evaluate(a.arg_value, ctx);
        }
      }
      const ceResults = await runWorkflow(ce, env, scope, ctx.thisHandle, ceParams);
      return Object.fromEntries(ceResults);
    }
    case 'PauseWFClient':
      await new Promise((r) => setTimeout(r, (p.length as number) ?? 600));
      return null;
    case 'ScheduleAPIEvent':
    case 'ScheduleAPIEventOnList':
      console.info('[nocode-runtime] ScheduleAPIEvent (mock/no-op):', p.api_event);
      return null;

    default:
      break;
  }

  // ---- plugins conhecidos
  if (action.type === '1662221683867x944302965243510800-AAs') {
    // Toast / notification
    store.showToast({
      message: coerceText(evaluate(p.ABC, ctx), ctx) || coerceText(evaluate(p.ABM, ctx), ctx) || 'Notificação',
      sub: p.ABD ? coerceText(evaluate(p.ABD, ctx), ctx) : undefined,
      bg: typeof p.ABH === 'string' ? p.ABH : undefined,
      fg: typeof p.ABI === 'string' ? p.ABI : undefined,
      border: typeof p.ABK === 'string' ? p.ABK : undefined,
    });
    return null;
  }
  if (action.type === '1526912550459x175937239475814400-AAC') {
    // clipboard
    const text = coerceText(evaluate(p.AAD, ctx), ctx);
    if (typeof navigator !== 'undefined' && navigator.clipboard) void navigator.clipboard.writeText(text);
    store.showToast({ message: 'Copiado!' });
    return null;
  }
  if (action.type === '1531310660066x700901076712292400-AAK') {
    // reveal password: alterna type do input com id HTML AAN
    const idAttr = coerceText(evaluate(p.AAN, ctx), ctx);
    if (typeof document !== 'undefined' && idAttr) {
      const inputs = document.querySelectorAll<HTMLInputElement>(`#${CSS.escape(idAttr)} input, input#${CSS.escape(idAttr)}`);
      inputs.forEach((i) => (i.type = i.type === 'password' ? 'text' : 'password'));
    }
    return null;
  }
  if (action.type === '1729605241035x687450859189043200-AAC') {
    store.showToast({ message: 'E-mail enviado (mock).' });
    return null;
  }
  if (action.type.startsWith('apiconnector2-')) {
    console.info('[nocode-runtime] chamada de API (mock):', action.type);
    return { _api_c2_id: 'mock', _api_c2_status: 'OK' };
  }

  console.info('[nocode-runtime] ação não suportada (no-op):', action.type);
  return null;
}

function applySchemaDefaults(type: string, fields: Record<string, unknown>, ctx: EvalCtx) {
  const types = ctx.store.payload.userTypes as Record<string, { fields?: Record<string, { default_val?: unknown }> }>;
  const t = types[type.replace(/^custom\./, '')];
  if (!t?.fields) return;
  for (const [fid, def] of Object.entries(t.fields)) {
    if (def?.default_val !== undefined && fields[fid] === undefined) fields[fid] = def.default_val;
  }
}

export { sortedActions, isEmpty };
