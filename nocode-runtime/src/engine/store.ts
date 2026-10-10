// Store reativo global do runtime: estados, visibilidade, inputs, registry de instâncias.
// Modelo: qualquer mutação bumpa `version`; a página re-renderiza e re-avalia expressões.
import { MockDB, OptionSets, getSessionDB, type Thing } from './data';
import type { NocodeElement, NocodePage, ElementDefinition, PagePayload } from './types';

/** Escopo de avaliação: página → instância de reusable → célula de RG (aninháveis). */
export interface Scope {
  key: string;
  parent: Scope | null;
  kind: 'page' | 'reusable' | 'cell';
  /** Container estático dono dos workflows deste escopo (página ou definição de reusable). */
  container: NocodePage | ElementDefinition;
  /** Para cell: item e índice (1-based). */
  cellItem?: unknown;
  cellIndex?: number;
  /** Para reusable: instância (CustomElement) e escopo onde os param_* devem ser avaliados. */
  reusableParams?: Record<string, unknown>;
  reusableInstanceKey?: string;
}

export interface ElementHandle {
  id: string;
  key: string; // scope.key + ':' + id — chave de estado da instância
  el: NocodeElement;
  scope: Scope;
  parentHandle: ElementHandle | null;
  /** dom node para scroll/focus */
  dom?: HTMLElement | null;
  /** fonte de dado sintética (célula de RG, instância de reusable) */
  dataGetter?: () => unknown;
}

type Listener = () => void;

export class RuntimeStore {
  version = 0;
  private listeners = new Set<Listener>();

  db: MockDB;
  options: OptionSets;
  payload: PagePayload;

  currentUser: Thing | null = null;
  customStates = new Map<string, unknown>(); // `${handleKey}|${stateKey}` -> value
  visibilityOverride = new Map<string, boolean>(); // handleKey -> visible
  alertMessages = new Map<string, string>(); // handleKey -> mensagem do AlertShowMessage (change_message)
  inputValues = new Map<string, unknown>(); // handleKey -> value
  inputResetCounter = new Map<string, number>(); // handleKey -> reset epoch
  groupDataOverride = new Map<string, unknown>(); // handleKey -> thing/data
  rgPage = new Map<string, number>(); // handleKey -> page index (0-based)
  hovered = new Set<string>(); // handleKeys
  pressed = new Set<string>();
  focusedKey: string | null = null;
  toasts: { id: number; message: string; sub?: string; bg?: string; fg?: string; border?: string }[] = [];
  alerts = new Map<string, boolean>();

  /** registry: elementId -> instâncias vivas */
  registry = new Map<string, Set<ElementHandle>>();

  constructor(payload: PagePayload) {
    this.payload = payload;
    // CANONICO: getSessionDB aqui ainda e o MockDB sem seeds por parametro — a arquitetura
    // de banco real (snapshot Supabase -> payload.seeds -> espelho) e propagacao PENDENTE,
    // registrada no handoff do app-marketplace. So a linha abaixo diverge do repo do app-marketplace.
    this.db = getSessionDB();
    this.db.addOnChange(() => this.bump());
    this.options = new OptionSets(payload.optionSets);
    // sessão persistida (auth fake)
    if (typeof window !== 'undefined') {
      const uid = window.sessionStorage.getItem('nc_current_user');
      if (uid) this.currentUser = this.db.byId.get(uid) ?? null;
      // diagnóstico: scripts de QA inspecionam o estado via window.__ncStore
      const w = window as unknown as Record<string, unknown>;
      w.__ncStore = this;
      (w.__ncStores as unknown[] | undefined)?.push(this) ?? (w.__ncStores = [this]);
    }
  }

  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = () => this.version;

  bump() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  // ---- registry ----
  register(handle: ElementHandle) {
    if (!this.registry.has(handle.id)) this.registry.set(handle.id, new Set());
    this.registry.get(handle.id)!.add(handle);
  }
  unregister(handle: ElementHandle) {
    this.registry.get(handle.id)?.delete(handle);
  }

  /** Resolve a instância de `elementId` mais próxima do escopo de origem. */
  resolveHandle(elementId: string, fromScope: Scope | null): ElementHandle | null {
    const set = this.registry.get(elementId);
    if (!set || set.size === 0) return null;
    if (set.size === 1 || !fromScope) return set.values().next().value ?? null;
    // melhor = maior prefixo de escopo em comum
    let best: ElementHandle | null = null;
    let bestScore = -1;
    const chain: string[] = [];
    for (let s: Scope | null = fromScope; s; s = s.parent) chain.push(s.key);
    for (const h of set) {
      let score = 0;
      for (let s: Scope | null = h.scope; s; s = s.parent) {
        const idx = chain.indexOf(s.key);
        if (idx >= 0) {
          score = 1000 - idx + s.key.length / 10000;
          break;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = h;
      }
    }
    return best;
  }

  // ---- estado de instâncias ----
  setCustomState(handleKey: string, stateKey: string, value: unknown) {
    this.customStates.set(`${handleKey}|${stateKey}`, value);
    this.bump();
  }
  getCustomState(handleKey: string, stateKey: string): unknown {
    return this.customStates.get(`${handleKey}|${stateKey}`);
  }
  setVisible(handleKey: string, visible: boolean) {
    this.visibilityOverride.set(handleKey, visible);
    this.bump();
  }
  toggleVisible(handleKey: string, fallbackCurrent: boolean) {
    const cur = this.visibilityOverride.get(handleKey) ?? fallbackCurrent;
    this.setVisible(handleKey, !cur);
  }
  setInputValue(handleKey: string, value: unknown) {
    this.inputValues.set(handleKey, value);
    this.bump();
  }
  resetInputsUnder(prefix: string | null) {
    if (prefix == null) {
      this.inputValues.clear();
      this.inputResetCounter = new Map(
        [...this.inputResetCounter].map(([k, v]) => [k, v + 1]),
      );
    } else {
      for (const k of [...this.inputValues.keys()]) if (k.startsWith(prefix)) this.inputValues.delete(k);
      for (const k of [...this.groupDataOverride.keys()]) if (k.startsWith(prefix)) this.groupDataOverride.delete(k);
    }
    this.bump();
  }
  setHovered(handleKey: string, on: boolean) {
    const had = this.hovered.has(handleKey);
    if (on === had) return;
    if (on) this.hovered.add(handleKey);
    else this.hovered.delete(handleKey);
    this.bump();
  }
  setPressed(handleKey: string, on: boolean) {
    if (on) this.pressed.add(handleKey);
    else this.pressed.delete(handleKey);
    this.bump();
  }
  setFocused(handleKey: string | null) {
    this.focusedKey = handleKey;
    this.bump();
  }

  // ---- auth ----
  /**
   * Login por e-mail.
   *
   * ⚠️ A senha ainda NÃO é verificada: a Data API da plataforma nunca expõe o hash, então os 309
   * usuários migrados vieram com `password` vazio. Enquanto a auth real não existe (task #20),
   * qualquer senha entra — por isso isto só funciona em desenvolvimento.
   *
   * Havia aqui um fallback para `users[0]` quando o e-mail não batia. Com base real de 309
   * pessoas, isso logava o testador como um usuário QUALQUER sem nenhum aviso — dá para passar
   * uma sessão inteira mexendo na conta de outra pessoa achando que é a sua. E-mail que não
   * existe agora falha, como na plataforma.
   */
  logIn(email: string): Thing | null {
    const alvo = email.trim().toLowerCase();
    const user = this.db
      .all('user')
      .find((u) => typeof u.email === 'string' && (u.email as string).toLowerCase() === alvo);
    if (!user) {
      this.showToast({ message: 'E-mail ou senha inválidos.' });
      return null;
    }
    if (process.env.NODE_ENV === 'production') {
      // Em produção, entrar sem conferir senha seria bypass de autenticação.
      this.showToast({ message: 'Login indisponível: autenticação ainda não configurada.' });
      return null;
    }
    this.currentUser = user;
    if (typeof window !== 'undefined') window.sessionStorage.setItem('nc_current_user', user._id);
    this.bump();
    return user;
  }
  signUp(email: string, fields: Record<string, unknown>): Thing {
    // `tipo_option_typeuser` é o campo do app-marketplace. Havia aqui
    // `tipo_de_usu_rio_option_tipo_de_usu_rio`, que é de outro app — o usuário nascia sem tipo e
    // o app não conseguia distinguir Produtor / Trabalhador / Empresa.
    const user = this.db.create('user', { email, ativo_boolean: true, ...fields });
    this.currentUser = user;
    if (typeof window !== 'undefined') window.sessionStorage.setItem('nc_current_user', user._id);
    this.bump();
    return user;
  }
  logOut() {
    this.currentUser = null;
    if (typeof window !== 'undefined') window.sessionStorage.removeItem('nc_current_user');
    this.bump();
  }

  // ---- toasts ----
  private toastId = 1;
  showToast(t: Omit<RuntimeStore['toasts'][number], 'id'>) {
    const id = this.toastId++;
    this.toasts.push({ id, ...t });
    this.bump();
    setTimeout(() => {
      this.toasts = this.toasts.filter((x) => x.id !== id);
      this.bump();
    }, 5000);
  }
}
