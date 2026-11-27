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
  const SELECTED_INDEX_HOOK = Symbol.for('bridge.desktop.selectIndexHook');
  const enhanced = new WeakMap();
  const pendingEnhance = new Set();
  const pendingSync = new Set();
  let syncScheduled = false;
  let flushesInTask = 0;
  let resetTaskScheduled = false;
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

  const indexDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
  if (indexDescriptor && indexDescriptor.get && indexDescriptor.set && !HTMLSelectElement.prototype[SELECTED_INDEX_HOOK]) {
    Object.defineProperty(HTMLSelectElement.prototype, SELECTED_INDEX_HOOK, { value: true });
    Object.defineProperty(HTMLSelectElement.prototype, 'selectedIndex', {
      configurable: true,
      enumerable: indexDescriptor.enumerable,
      get() {
        return indexDescriptor.get.call(this);
      },
      set(next) {
        indexDescriptor.set.call(this, next);
        scheduleSync(this);
      },
    });
  }

  function isOwnNode(node) {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    return !!el?.closest?.('.cmb-select, .cmb-select-menu');
  }

  function inDocument(node) {
    return typeof document.contains === 'function' ? document.contains(node) : true;
  }

  function optionsSignature(select) {
    const parts = [`v:${select.value}`];
    for (const opt of select.options) {
      if (opt.hidden) continue;
      parts.push(`${opt.value}\0${opt.textContent}\0${opt.disabled ? '1' : '0'}`);
    }
    return parts.join('\x01');
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
    const nextText = displayText || '\u2014';
    if (label.textContent !== nextText) {
      label.textContent = nextText;
    }
    const isPlaceholder = Boolean(!displayText || (selectedOpt && selectedOpt.value === '' && select.options.length > 1));
    if (label.classList.contains('is-placeholder') !== isPlaceholder) {
      label.classList.toggle('is-placeholder', isPlaceholder);
    }

    const parentHidden = Boolean(select.hidden || select.style?.display === 'none');
    if (Boolean(wrap.hidden) !== parentHidden) {
      wrap.hidden = parentHidden;
    }
    const isDisabled = Boolean(select.disabled);
    if (Boolean(trigger.disabled) !== isDisabled) {
      trigger.disabled = isDisabled;
    }
    const nextTitle = select.title || '';
    if (trigger.title !== nextTitle) {
      trigger.title = nextTitle;
    }
    if (wrap.classList.contains('is-disabled') !== isDisabled) {
      wrap.classList.toggle('is-disabled', isDisabled);
    }
    const isInvalid = select.getAttribute('aria-invalid') === 'true';
    if (wrap.classList.contains('is-invalid') !== isInvalid) {
      wrap.classList.toggle('is-invalid', isInvalid);
    }
    const isUnsaved = select.dataset?.unsaved === 'true';
    if (wrap.classList.contains('is-unsaved') !== isUnsaved) {
      wrap.classList.toggle('is-unsaved', isUnsaved);
    }
    const ariaLabel = select.getAttribute('aria-label') || '';
    const currentAriaLabel = trigger.getAttribute('aria-label') || '';
    if (ariaLabel !== currentAriaLabel) {
      if (ariaLabel) trigger.setAttribute('aria-label', ariaLabel);
      else trigger.removeAttribute('aria-label');
    }

    if (openState && openState.select === select) {
      if (trigger.disabled || wrap.hidden || !inDocument(select)) {
        closeOpenMenu();
      } else {
        const sig = optionsSignature(select);
        if (openState.signature !== sig) {
          openState.signature = sig;
          populateMenu(select, openState.menu);
          positionMenu(trigger, openState.menu);
        }
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
        if (valueDescriptor?.set) valueDescriptor.set.call(select, opt.value);
        else select.value = opt.value;
        syncTrigger(select);
        closeOpenMenu({ restoreFocus: true });
        if (changed) {
          select.dispatchEvent(new Event('input', { bubbles: true }));
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
    if (select.id === 'language' || select.id === 'appearance') menu.classList.add('cmb-select-menu-compact');
    populateMenu(select, menu);
    document.body.append(menu);
    positionMenu(state.trigger, menu);

    state.wrap.classList.add('is-open');
    state.trigger.setAttribute('aria-expanded', 'true');
    openState = {
      select,
      wrap: state.wrap,
      trigger: state.trigger,
      menu,
      signature: optionsSignature(select),
    };

    const active = menu.querySelector('[aria-selected="true"]:not(:disabled)') || menu.querySelector('.cmb-select-option:not(:disabled)');
    active?.focus({ preventScroll: true });
    active?.scrollIntoView?.({ block: 'nearest' });
  }

  function enhance(select) {
    if (!select || select.tagName !== 'SELECT' || enhanced.has(select) || !select.parentNode) return;
    const wrap = document.createElement('div');
    wrap.className = 'cmb-select';
    wrap.dataset.cmbSelect = select.id || '';
    if (select.id === 'language' || select.id === 'appearance') wrap.classList.add('cmb-select-compact');

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

  function resetTaskBudget() {
    flushesInTask = 0;
    resetTaskScheduled = false;
  }

  function flushSync() {
    if (!resetTaskScheduled && typeof setTimeout === 'function') {
      resetTaskScheduled = true;
      setTimeout(resetTaskBudget, 0);
    }
    if (flushesInTask >= 50) {
      syncScheduled = false;
      pendingEnhance.clear();
      pendingSync.clear();
      return;
    }
    flushesInTask++;
    const toEnhance = [...pendingEnhance];
    const toSync = [...pendingSync];
    pendingEnhance.clear();
    pendingSync.clear();
    try {
      for (const select of toEnhance) {
        enhance(select);
      }
      for (const select of toSync) {
        if (!enhanced.has(select) && select.parentNode) enhance(select);
        else syncTrigger(select);
      }
    } finally {
      syncScheduled = false;
    }
    if (pendingEnhance.size || pendingSync.size) {
      scheduleSync();
    }
  }

  function scheduleSync(target) {
    if (target?.tagName === 'SELECT') pendingSync.add(target);
    if (!pendingEnhance.size && !pendingSync.size) return;
    if (syncScheduled) return;
    syncScheduled = true;
    queueMicrotask(flushSync);
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
    for (const record of records) {
      if (isOwnNode(record.target)) continue;
      if (record.type === 'childList') {
        const ownerSelect = record.target.closest?.('select');
        if (ownerSelect) {
          pendingSync.add(ownerSelect);
          continue;
        }
        for (const node of record.addedNodes || []) {
          if (!node || node.nodeType !== 1 || isOwnNode(node)) continue;
          if (node.tagName === 'SELECT') pendingEnhance.add(node);
          else if (node.querySelectorAll) {
            for (const select of node.querySelectorAll('select')) pendingEnhance.add(select);
          }
        }
        for (const node of record.removedNodes || []) {
          if (!node || node.nodeType !== 1 || isOwnNode(node)) continue;
          if (openState && (node === openState.select || node.contains?.(openState.select))) {
            closeOpenMenu();
          }
          const removedSelects = node.tagName === 'SELECT'
            ? [node]
            : [...(node.querySelectorAll?.('select') || [])];
          for (const removed of removedSelects) {
            const state = enhanced.get(removed);
            if (state && !inDocument(removed)) {
              if (state.wrap.parentNode) state.wrap.remove();
              enhanced.delete(removed);
              pendingEnhance.delete(removed);
              pendingSync.delete(removed);
            }
          }
        }
      } else if (record.type === 'attributes') {
        if (record.target.tagName === 'SELECT') {
          pendingSync.add(record.target);
        } else if (record.target.tagName === 'OPTION') {
          const ownerSelect = record.target.closest?.('select');
          if (ownerSelect) pendingSync.add(ownerSelect);
        }
      } else if (record.type === 'characterData') {
        const ownerSelect = record.target.parentElement?.closest?.('select');
        if (ownerSelect) pendingSync.add(ownerSelect);
      }
    }
    if (pendingEnhance.size || pendingSync.size) scheduleSync();
  });

  const startObserver = () => {
    syncAll();
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'hidden', 'style', 'aria-invalid', 'data-unsaved', 'selected'],
      characterData: true,
    });
  };

  if (document.body) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver, { once: true });

  window.BridgeSelects = { enhanceAll, syncAll };
})();
