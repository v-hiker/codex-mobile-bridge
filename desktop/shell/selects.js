'use strict';
// Replace native OS <select> widgets in the desktop controller with a uniform custom listbox
// while preserving native <select> DOM nodes, .value, and change listeners for existing logic/tests.
(() => {
  if (
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    typeof MutationObserver !== 'function' ||
    typeof HTMLSelectElement === 'undefined'
  ) {
    return;
  }

  const VALUE_HOOK = Symbol.for('bridge.desktop.selectValueHook');
  const enhanced = new WeakMap();
  const pendingSync = new Set();
  let syncScheduled = false;
  let openState = null;

  const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  if (valueDescriptor && valueDescriptor.get && valueDescriptor.set && !HTMLSelectElement.prototype[VALUE_HOOK]) {
    Object.defineProperty(HTMLSelectElement.prototype, VALUE_HOOK, { value: true });
    Object.defineProperty(HTMLSelectElement.prototype, 'value', {
      configurable: true,
      enumerable: valueDescriptor.enumerable,
      get() {
        return valueDescriptor.get.call(this);
      },
      set(next) {
        valueDescriptor.set.call(this, next);
        scheduleSync(this);
      },
    });
  }

  function svgEl(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  function buildChevron() {
    const svg = svgEl('svg', {
      class: 'cmb-select-chevron',
      viewBox: '0 0 16 16',
      width: '14',
      height: '14',
      'aria-hidden': 'true',
    });
    svg.append(
      svgEl('path', {
        d: 'M4.25 6.25 8 10l3.75-3.75',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1.6',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      })
    );
    return svg;
  }

  function buildGlobe() {
    const svg = svgEl('svg', {
      class: 'cmb-select-leading',
      viewBox: '0 0 16 16',
      width: '14',
      height: '14',
      'aria-hidden': 'true',
    });
    svg.append(
      svgEl('circle', { cx: '8', cy: '8', r: '6', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.35' }),
      svgEl('path', {
        d: 'M2.3 8h11.4M8 2c1.7 1.7 2.5 3.7 2.5 6s-.8 4.3-2.5 6c-1.7-1.7-2.5-3.7-2.5-6S6.3 3.7 8 2z',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1.25',
      })
    );
    return svg;
  }

  function buildCheck() {
    const svg = svgEl('svg', {
      class: 'cmb-select-check',
      viewBox: '0 0 16 16',
      width: '14',
      height: '14',
      'aria-hidden': 'true',
    });
    svg.append(
      svgEl('path', {
        d: 'M3.5 8.2 6.6 11.2 12.6 4.8',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1.7',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      })
    );
    return svg;
  }

  function closeOpenMenu({ restoreFocus = false } = {}) {
    if (!openState) return;
    const state = openState;
    openState = null;
    state.trigger.setAttribute('aria-expanded', 'false');
    state.wrap.classList.remove('is-open');
    state.menu.remove();
    if (restoreFocus && !state.trigger.disabled && document.contains(state.trigger)) {
      state.trigger.focus({ preventScroll: true });
    }
  }

  function positionMenu(trigger, menu) {
    const rect = trigger.getBoundingClientRect();
    const gap = 6;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const minW = Math.max(Math.round(rect.width), trigger.closest('.cmb-select-compact') ? 132 : 160);
    menu.style.minWidth = minW + 'px';
    menu.style.maxWidth = Math.max(240, vw - 24) + 'px';
    menu.style.left = Math.max(12, Math.min(rect.left, vw - minW - 12)) + 'px';

    const spaceBelow = vh - rect.bottom - gap - 12;
    const spaceAbove = rect.top - gap - 12;
    const openUp = spaceBelow < 190 && spaceAbove > spaceBelow;
    const avail = Math.max(120, openUp ? spaceAbove : spaceBelow);
    menu.style.maxHeight = Math.min(280, avail) + 'px';
    menu.dataset.openUp = String(openUp);

    if (openUp) {
      menu.style.top = 'auto';
      menu.style.bottom = Math.round(vh - rect.top + gap) + 'px';
    } else {
      menu.style.bottom = 'auto';
      menu.style.top = Math.round(rect.bottom + gap) + 'px';
    }
  }

  function syncTrigger(select) {
    const state = enhanced.get(select);
    if (!state) return;
    const { wrap, trigger, label } = state;
    const selectedOpt =
      select.selectedOptions?.[0] ||
      [...select.options].find((o) => o.value === select.value) ||
      select.options[0] ||
      null;
    const displayText = selectedOpt ? selectedOpt.textContent.trim() : '';
    label.textContent = displayText || '\u2014';
    label.classList.toggle('is-placeholder', !displayText || (selectedOpt && selectedOpt.value === '' && select.options.length > 1));

    const parentHidden = select.hidden || select.style.display === 'none';
    wrap.hidden = parentHidden;
    trigger.disabled = !!select.disabled;
    trigger.title = select.title || '';
    wrap.classList.toggle('is-disabled', !!select.disabled);
    wrap.classList.toggle('is-invalid', select.getAttribute('aria-invalid') === 'true');
    wrap.classList.toggle('is-unsaved', select.dataset.unsaved === 'true');
    const ariaLabel = select.getAttribute('aria-label');
    if (ariaLabel) trigger.setAttribute('aria-label', ariaLabel);

    if (openState && openState.select === select) {
      if (trigger.disabled || wrap.hidden || !document.contains(select)) {
        closeOpenMenu();
      } else {
        populateMenu(select, openState.menu);
        positionMenu(trigger, openState.menu);
      }
    }
  }

  function populateMenu(select, menu) {
    const currentValue = select.value;
    const items = [];
    for (const opt of select.options) {
      if (opt.hidden) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cmb-select-option';
      btn.setAttribute('role', 'option');
      const selected = opt.value === currentValue;
      btn.setAttribute('aria-selected', String(selected));
      if (opt.disabled) btn.disabled = true;
      btn.dataset.value = opt.value;

      const text = document.createElement('span');
      text.className = 'cmb-select-option-label';
      text.textContent = opt.textContent;
      btn.append(text, buildCheck());

      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (opt.disabled || select.disabled) return;
        const changed = select.value !== opt.value;
        valueDescriptor.set.call(select, opt.value);
        syncTrigger(select);
        closeOpenMenu({ restoreFocus: true });
        if (changed) {
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      };
      items.push(btn);
    }
    menu.replaceChildren(...items);
  }

  function openMenu(select) {
    const state = enhanced.get(select);
    if (!state || state.trigger.disabled) return;
    if (openState && openState.select === select) {
      closeOpenMenu({ restoreFocus: true });
      return;
    }
    closeOpenMenu();

    const menu = document.createElement('div');
    menu.className = 'cmb-select-menu';
    menu.setAttribute('role', 'listbox');
    if (select.id === 'language') menu.classList.add('cmb-select-menu-compact');
    populateMenu(select, menu);
    document.body.append(menu);
    positionMenu(state.trigger, menu);

    state.wrap.classList.add('is-open');
    state.trigger.setAttribute('aria-expanded', 'true');
    openState = { select, wrap: state.wrap, trigger: state.trigger, menu };

    const active = menu.querySelector('[aria-selected="true"]:not(:disabled)') || menu.querySelector('.cmb-select-option:not(:disabled)');
    active?.focus({ preventScroll: true });
    active?.scrollIntoView?.({ block: 'nearest' });
  }

  function enhance(select) {
    if (!select || select.tagName !== 'SELECT' || enhanced.has(select) || !select.parentNode) return;
    const wrap = document.createElement('div');
    wrap.className = 'cmb-select';
    wrap.dataset.cmbSelect = select.id || '';
    if (select.id === 'language') wrap.classList.add('cmb-select-compact');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'cmb-select-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    const label = document.createElement('span');
    label.className = 'cmb-select-label';
    if (select.id === 'language') trigger.append(buildGlobe());
    trigger.append(label, buildChevron());
    wrap.append(trigger);

    select.classList.add('cmb-native-select');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    select.after(wrap);

    enhanced.set(select, { wrap, trigger, label });

    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu(select);
    });

    trigger.addEventListener('keydown', (e) => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        openMenu(select);
      }
    });

    select.addEventListener('focus', () => {
      if (!trigger.disabled && !wrap.hidden) trigger.focus({ preventScroll: true });
    });

    syncTrigger(select);
  }

  function enhanceAll(root = document) {
    if (!root?.querySelectorAll) return;
    if (root.tagName === 'SELECT') {
      enhance(root);
      return;
    }
    for (const select of root.querySelectorAll('select')) enhance(select);
  }

  function syncAll() {
    enhanceAll(document);
    for (const select of document.querySelectorAll('select')) syncTrigger(select);
  }

  function scheduleSync(target) {
    if (target?.tagName === 'SELECT') pendingSync.add(target);
    if (syncScheduled) return;
    syncScheduled = true;
    queueMicrotask(() => {
      syncScheduled = false;
      enhanceAll(document);
      if (pendingSync.size) {
        for (const select of pendingSync) syncTrigger(select);
        pendingSync.clear();
      } else {
        for (const select of document.querySelectorAll('select')) syncTrigger(select);
      }
    });
  }

  document.addEventListener('change', (e) => {
    if (e.target?.tagName === 'SELECT') syncTrigger(e.target);
  }, true);

  document.addEventListener('pointerdown', (e) => {
    if (!openState) return;
    if (openState.menu.contains(e.target) || openState.wrap.contains(e.target)) return;
    closeOpenMenu();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!openState) return;
    const { menu } = openState;
    const options = [...menu.querySelectorAll('.cmb-select-option:not(:disabled)')];
    const current = options.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeOpenMenu({ restoreFocus: true });
    } else if (e.key === 'Tab') {
      closeOpenMenu();
    } else if (e.key === 'ArrowDown' && options.length) {
      e.preventDefault();
      options[(current + 1) % options.length].focus({ preventScroll: true });
    } else if (e.key === 'ArrowUp' && options.length) {
      e.preventDefault();
      options[(current - 1 + options.length) % options.length].focus({ preventScroll: true });
    } else if (e.key === 'Home' && options.length) {
      e.preventDefault();
      options[0].focus({ preventScroll: true });
    } else if (e.key === 'End' && options.length) {
      e.preventDefault();
      options[options.length - 1].focus({ preventScroll: true });
    }
  }, true);

  window.addEventListener('resize', () => {
    if (openState) positionMenu(openState.trigger, openState.menu);
  });
  window.addEventListener('scroll', (e) => {
    if (openState && !openState.menu.contains(e.target)) closeOpenMenu();
  }, true);

  const observer = new MutationObserver((records) => {
    let sawAll = false;
    for (const record of records) {
      if (record.type === 'childList') {
        const select = record.target.closest?.('select');
        if (select) pendingSync.add(select);
        else sawAll = true;
      } else if (record.type === 'attributes') {
        if (record.target.tagName === 'SELECT') pendingSync.add(record.target);
      } else if (record.type === 'characterData') {
        const select = record.target.parentElement?.closest?.('select');
        if (select) pendingSync.add(select);
      }
    }
    if (sawAll || pendingSync.size) scheduleSync();
  });

  const startObserver = () => {
    syncAll();
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'hidden', 'aria-invalid', 'data-unsaved', 'selected'],
      characterData: true,
    });
  };

  if (document.body) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver, { once: true });

  window.BridgeSelects = { enhanceAll, syncAll };
})();
