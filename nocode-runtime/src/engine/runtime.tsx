'use client';
// Contexto e infraestrutura do runtime client-side.
import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

// useLayoutEffect roda antes do paint (estado inicializado no load aplica sem flash);
// no SSR cai para useEffect para evitar warning do React.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { RuntimeStore, type ElementHandle, type Scope } from './store';
import { evaluate, toBool, type EvalCtx } from './expressions';
import { runWorkflow, type WorkflowEnv } from './workflows';
import { raioToken } from './tema';
import type { NocodeWorkflow, PagePayload } from './types';

export interface RuntimeContextValue {
  store: RuntimeStore;
  env: WorkflowEnv;
  payload: PagePayload;
  pageWidth: number;
  pathData: string | null;
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null);

export function useRuntime(): RuntimeContextValue {
  const v = useContext(RuntimeContext);
  if (!v) throw new Error('useRuntime fora do RuntimeProvider');
  return v;
}

export function makeEvalCtx(rt: RuntimeContextValue, scope: Scope, thisHandle: ElementHandle | null): EvalCtx {
  const query: Record<string, string> = {};
  if (typeof window !== 'undefined') {
    new URLSearchParams(window.location.search).forEach((v, k) => (query[k] = v));
  }
  return {
    store: rt.store,
    scope,
    thisHandle,
    injected: [],
    pageWidth: rt.pageWidth,
    query,
    pathData: rt.pathData,
  };
}

export function RuntimeProvider({
  payload,
  pathData,
  children,
}: {
  payload: PagePayload;
  pathData: string | null;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const store = useMemo(() => new RuntimeStore(payload), [payload]);
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);

  // navegação client-side muda a URL sem re-render — bump re-avalia GetParamFromUrl/conditions
  const searchParams = useSearchParams();
  const pathname = usePathname();
  useEffect(() => {
    store.bump();
  }, [searchParams, pathname, store]);

  const [pageWidth, setPageWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1280);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => setPageWidth(window.innerWidth), 80);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const rtRef = useRef<RuntimeContextValue>(null);

  // ChangePage em rajada (ex.: ButtonClicked + LoggedIn no mesmo ciclo): o último vence,
  // como na plataforma — pushes simultâneos no App Router se perdem na transição pendente.
  // Mesma página + params novos → pushState raso (App Router sincroniza useSearchParams;
  // sem remount, PageLoaded não re-dispara — semântica do "Go to page" da plataforma).
  const navTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const env: WorkflowEnv = useMemo(
    () => ({
      store,
      navigate: (path: string) => {
        if (navTimer.current) clearTimeout(navTimer.current);
        navTimer.current = setTimeout(() => {
          const norm = (s: string) => {
            const p = s.replace(/\/+$/, '') || '/';
            return p === '/index' ? '/' : p;
          };
          const target = norm(path.split('?')[0]);
          if (typeof window !== 'undefined' && norm(window.location.pathname) === target) {
            window.history.pushState(null, '', path);
            return;
          }
          router.push(path);
          // `router.push` disparado durante a hidratação é engolido pelo App Router — medido:
          // o gate do /adm falhava em 2 de 6 acessos e um não-admin ficava dentro do painel.
          // Se a rota não mudou, força navegação de verdade. Um redirect de segurança não pode
          // depender do momento em que o efeito rodou.
          // Uma checagem só não basta: com uma janela de 400ms o gate ainda vazava 1 em 12.
          // Reconferir em três momentos cobre tanto o push engolido quanto o que demora.
          for (const espera of [400, 1200, 2500]) {
            setTimeout(() => {
              if (typeof window === 'undefined') return;
              if (norm(window.location.pathname) !== target) window.location.assign(path);
            }, espera);
          }
        }, 0);
      },
      makeCtx: (scope, thisHandle) => makeEvalCtx(rtRef.current!, scope, thisHandle),
    }),
    [store, router],
  );

  const value: RuntimeContextValue = { store, env, payload, pageWidth, pathData };
  rtRef.current = value;

  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

/** Dispara PageLoaded e observa ConditionTrue de um container (página ou reusable). */
export function ContainerWorkflows({ scope, thisHandle }: { scope: Scope; thisHandle: ElementHandle | null }) {
  const rt = useRuntime();
  const firedRef = useRef(false);
  const condStates = useRef(new Map<string, boolean>());

  const workflows = useMemo(
    () => Object.values(scope.container.workflows ?? {}).filter((w): w is NocodeWorkflow => !!w && typeof w === 'object'),
    [scope.container],
  );

  // PageLoaded antes do paint: estados inicializados no load (SetCustomState) aplicam
  // antes da primeira renderização visível — wizards mostram o passo certo sem flash.
  useIsoLayoutEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    for (const wf of workflows) {
      if (wf.type === 'PageLoaded') {
        void runWorkflow(wf, rt.env, scope, thisHandle);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ConditionTrue: reavaliar a cada mudança de versão
  const version = useSyncExternalStore(rt.store.subscribe, rt.store.getVersion, rt.store.getVersion);

  // LoggedOut / LoggedIn: disparam na montagem conforme o estado da sessão e a cada
  // transição de `currentUser`. Sem isto, o gate do /adm ficava de pé por acidente — quem
  // redirecionava o anônimo era o `ConditionTrue` (`Current User's tipo ≠ admin`), que só dá
  // `true` porque `null ≠ 'admin'` em JS. Ou seja, o painel administrativo dependia de uma
  // comparação sobre valor vazio; acertar essa semântica sem ter o gatilho de verdade abriria
  // o /adm para visitante anônimo. É 1 workflow no app inteiro (`bTVYU`, página adm).
  const authRef = useRef<boolean | null>(null);
  useEffect(() => {
    const logado = rt.store.currentUser != null;
    if (authRef.current === logado) return;
    authRef.current = logado;
    // Na montagem dispara o gatilho que descreve a sessão atual; depois, o do novo estado.
    const alvo = logado ? 'LoggedIn' : 'LoggedOut';
    for (const wf of workflows) {
      if (wf.type === alvo) void runWorkflow(wf, rt.env, scope, thisHandle);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  useEffect(() => {
    for (const wf of workflows) {
      if (wf.type !== 'ConditionTrue') continue;
      const cond = (wf.properties as Record<string, unknown>)?.condition;
      if (cond == null) continue;
      let now = false;
      try {
        now = toBool(evaluate(cond, makeEvalCtx(rt, scope, thisHandle)));
      } catch {
        now = false;
      }
      const prev = condStates.current.get(wf.id) ?? false;
      const runWhen = ((wf.properties as Record<string, unknown>)?.run_when as string) ?? 'every_time';
      if (now && !prev) {
        if (runWhen === 'just_once' && condStates.current.has(`${wf.id}|fired`)) {
          // já disparou
        } else {
          condStates.current.set(`${wf.id}|fired`, true);
          void runWorkflow(wf, rt.env, scope, thisHandle);
        }
      }
      condStates.current.set(wf.id, now);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  return null;
}

/** Camada de toasts do plugin de notificação. */
export function ToastLayer() {
  const rt = useRuntime();
  useSyncExternalStore(rt.store.subscribe, rt.store.getVersion, rt.store.getVersion);
  if (rt.store.toasts.length === 0) return null;
  return (
    <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 5000, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rt.store.toasts.map((t) => (
        <div
          key={t.id}
          style={{
            background: t.bg ?? 'var(--color_surface_default)',
            color: t.fg ?? 'var(--color_text_default)',
            border: `1px solid ${t.border ?? 'var(--ui_separador, rgba(0,0,0,.1))'}`,
            borderRadius: raioToken(8),
            padding: '10px 16px',
            boxShadow: 'var(--ui_shadow_toast, 0 4px 16px rgba(0,0,0,.15))',
            maxWidth: 360,
            fontFamily: 'var(--font_default)',
            fontSize: 14,
          }}
        >
          <div>{t.message}</div>
          {t.sub ? <div style={{ fontSize: 12, opacity: 0.8 }}>{t.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}
