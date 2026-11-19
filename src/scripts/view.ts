/**
 * View switch (Study guide / Explanation only / Text only) and the print button.
 * The view lives in `data-view` on <html> and on each guide root; CSS does the rest.
 * Kept in localStorage and readable from `?view=`.
 */
const VIEWS = ['guide', 'explanation', 'text'] as const;
type View = (typeof VIEWS)[number];
const KEY = 'shy-view';

const isView = (v: string | null | undefined): v is View => VIEWS.some((x) => x === v);

function initialView(): View {
  try {
    const fromUrl = new URLSearchParams(location.search).get('view');
    if (isView(fromUrl)) return fromUrl;
    const saved = localStorage.getItem(KEY);
    if (isView(saved)) return saved;
  } catch {
    /* storage blocked */
  }
  return 'guide';
}

function apply(view: View, persist: boolean): void {
  document.documentElement.dataset['view'] = view;
  for (const root of document.querySelectorAll<HTMLElement>('[data-guide-root]')) root.dataset['view'] = view;
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-view-btn]')) {
    const on = btn.dataset['viewBtn'] === view;
    btn.setAttribute('aria-checked', String(on));
    btn.tabIndex = on ? 0 : -1;
  }
  if (!persist) return;
  try {
    localStorage.setItem(KEY, view);
  } catch {
    /* storage blocked */
  }
  try {
    const url = new URL(location.href);
    if (url.searchParams.has('view')) {
      url.searchParams.set('view', view);
      history.replaceState(history.state, '', url);
    }
  } catch {
    /* ignore */
  }
}

apply(initialView(), false);

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const btn = target.closest<HTMLButtonElement>('[data-view-btn]');
  if (btn && isView(btn.dataset['viewBtn'])) {
    apply(btn.dataset['viewBtn'], true);
    return;
  }
  if (target.closest('[data-print]')) window.print();
});

// Arrow keys move within the radiogroup.
document.addEventListener('keydown', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.matches('[data-view-btn]')) return;
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const group = [...(target.parentElement?.querySelectorAll<HTMLButtonElement>('[data-view-btn]') ?? [])];
  const i = group.indexOf(target as HTMLButtonElement);
  const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
  const next = group[(i + step + group.length) % group.length];
  if (next && isView(next.dataset['viewBtn'])) {
    apply(next.dataset['viewBtn'], true);
    next.focus();
  }
});
