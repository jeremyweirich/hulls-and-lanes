// A tiny DOM helper in place of a UI framework. Screens build their elements
// once with h() and update text and classes directly when state changes.

type Child = Node | string | number | null | undefined | false;
export type Children = Child | Children[];
type Props = Record<string, unknown> & {
  class?: string;
  style?: string;
  on?: Record<string, (e: any) => void>;
};

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, props: Props | null = null, ...children: Children[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'on') {
        for (const [ev, fn] of Object.entries(value as Record<string, (e: Event) => void>)) el.addEventListener(ev, fn);
      } else if (key === 'class') {
        el.className = String(value);
      } else if (key === 'style') {
        el.setAttribute('style', String(value));
      } else if (key in el && typeof value !== 'string') {
        (el as any)[key] = value;
      } else {
        el.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  append(el, children);
  return el;
}

function append(el: HTMLElement, children: Children[]): void {
  for (const c of children) {
    if (Array.isArray(c)) append(el, c);
    else if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  }
}

/** Replaces an element's children. */
export function fill(el: HTMLElement, ...children: Children[]): HTMLElement {
  el.textContent = '';
  append(el, children);
  return el;
}

/** A modal sheet that slides up from the bottom, within thumb reach. Returns a close function. */
export function sheet(title: string, body: Node, onClose?: () => void): () => void {
  const close = () => {
    backdrop.remove();
    onClose?.();
  };
  const backdrop = h('div', { class: 'backdrop', on: { click: (e: Event) => { if (e.target === backdrop) close(); } } },
    h('div', { class: 'sheet', role: 'dialog', 'aria-label': title },
      h('div', { class: 'sheet-head' }, h('h2', null, title), h('button', { class: 'icon', 'aria-label': 'Close', on: { click: close } }, '✕')),
      body));
  document.body.append(backdrop);
  return close;
}

let toastTimer = 0;
/** A short message near the bottom of the screen. */
export function toast(text: string, kind: 'info' | 'bad' = 'info'): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.textContent = text;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el!.className = ''; }, 2200);
}

export interface Screen {
  readonly el: HTMLElement;
  /** Called after the element is in the document. */
  mounted?(): void;
  dispose?(): void;
}
