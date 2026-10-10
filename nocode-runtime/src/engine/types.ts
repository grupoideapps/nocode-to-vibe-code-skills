// Tipos do modelo export (o JSON que o editor da plataforma gera).
// Estrutura validada por engenharia reversa — ver analysis/*.md.

/** Nó de expressão dinâmica da plataforma (encadeado via `next`, pipeline esquerda→direita). */
export interface ExprNode {
  type: string; // Message | TextExpression | Search | GetElement | CurrentUser | ...
  name?: string; // para Message: operador ou getter de campo
  args?: unknown; // operando direito (literal, ExprNode ou lista)
  properties?: Record<string, unknown>;
  next?: ExprNode;
  entries?: Record<string, string | ExprNode>; // para TextExpression
  is_slidable?: boolean;
}

/** Expressão de texto: concatenação ordenada de literais e ExprNodes. */
export interface TextExpression {
  type: 'TextExpression';
  entries: Record<string, string | ExprNode>;
}

/** Valor de propriedade: literal ou expressão dinâmica. */
export type PropValue = string | number | boolean | ExprNode | TextExpression | null | undefined;

/** Override condicional (conditional do editor). */
export interface ConditionalState {
  type: 'State';
  condition: ExprNode;
  properties: Record<string, PropValue>;
}

/** Elemento da árvore de UI. */
export interface NocodeElement {
  id: string;
  type: string; // Group | Text | Button | ... | CustomElement | <plugin-id>-XXX
  name?: string;
  default_name?: string;
  style?: string; // id em styles{}
  properties: Record<string, PropValue>;
  states?: Record<string, ConditionalState>;
  elements?: Record<string, NocodeElement>;
  workflows?: Record<string, NocodeWorkflow>;
  current_parent?: string;
  // CustomElement (instância de reusable)
  custom_definition_id?: string;
}

/** Ação de workflow. */
export interface WorkflowAction {
  id: string;
  type: string; // ChangePage | SetCustomState | ShowElement | ...
  properties: Record<string, PropValue>;
}

/** Workflow (evento + cadeia de ações). */
export interface NocodeWorkflow {
  id: string;
  type: string; // ButtonClicked | PageLoaded | CustomEvent | ...
  properties: Record<string, PropValue>;
  actions?: Record<string, WorkflowAction>;
}

/** Definição de custom state declarado em página/reusable. */
export interface CustomStateDef {
  name?: string;
  type?: string;
  is_list?: boolean;
  default?: unknown;
  [k: string]: unknown;
}

/** Página do app. */
export interface NocodePage {
  id: string;
  name: string;
  type: string;
  properties: Record<string, PropValue>;
  elements?: Record<string, NocodeElement>;
  workflows?: Record<string, NocodeWorkflow>;
  custom_states?: Record<string, CustomStateDef>;
}

/** Definição de estilo nomeado. */
export interface NocodeStyle {
  id: string;
  type: string;
  display?: string;
  properties: Record<string, PropValue>;
  states?: Record<string, ConditionalState>;
  transitions?: Record<string, { fn: string; duration: number }>;
}

/** Reusable component (element_definitions). */
export interface ElementDefinition {
  id: string;
  name?: string;
  type?: string;
  properties?: Record<string, PropValue>;
  elements?: Record<string, NocodeElement>;
  workflows?: Record<string, NocodeWorkflow>;
  custom_states?: Record<string, CustomStateDef>;
  [k: string]: unknown;
}

/** Campo de um user_type (tabela). */
export interface FieldDef {
  name: string;
  type: string; // text | number | boolean | date | image | option.<set> | custom.<type> | list.<...>
}

/** Arquivo export completo (apenas o que o engine usa). */
export interface NocodeApp {
  pages: Record<string, NocodePage>;
  element_definitions: Record<string, ElementDefinition>;
  styles: Record<string, NocodeStyle>;
  user_types: Record<string, unknown>;
  option_sets: Record<string, unknown>;
  settings: {
    secure?: Record<string, unknown>;
    client_safe: Record<string, unknown>;
  };
  _index?: {
    id_to_path?: Record<string, unknown>;
    page_name_to_id?: Record<string, string>;
  };
  api?: Record<string, unknown>;
}

/** Payload enviado ao client para renderizar uma página. */
export interface PagePayload {
  appName: string;
  pageId: string;
  pageName: string;
  page: NocodePage;
  /** Reusables referenciados (transitivamente) pela página. */
  definitions: Record<string, ElementDefinition>;
  styles: Record<string, NocodeStyle>;
  defaultStyles: Record<string, string>; // element type -> style id
  optionSets: Record<string, unknown>;
  /** valor de cor normalizado → nome do custom property. Necessário no CLIENTE porque
   *  `evalVisualProps` tokeniza cor que nasce de expressão, e essa não passa pelo walk. */
  tokensPorValor: Record<string, string>;
  /** Schema das tabelas (para o mock DB tipar/seedar). */
  userTypes: Record<string, unknown>;
  /** Seeds do mock DB: type -> registros. */
  seeds: Record<string, Record<string, unknown>[]>;
  /** Nomes de todas as páginas (para navegação ChangePage). */
  pageNames: Record<string, string>; // pageId (chave do dict) -> name
  /** ChangePage referencia o campo `id` da página — mapa id -> name. */
  pageIdsByElementId: Record<string, string>;
  breakpoints: Record<string, number>; // breakpoint_id -> px
}
