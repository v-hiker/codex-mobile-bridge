'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SELECTS_SRC = fs.readFileSync(path.resolve(__dirname, '../desktop/shell/selects.js'), 'utf8');

function createHarness() {
  const observers = new Set();
  let observerBatches = 0;
  let scheduledDeliveries = false;
  let microtaskQueue = [];
  let maxBatchTurns = 500;

  function enqueueMutation(target, record) {
    for (const obs of observers) {
      if (!obs.target) continue;
      let match = target === obs.target;
      if (!match && obs.options.subtree) {
        let cur = target?.parentNode;
        while (cur) {
          if (cur === obs.target) {
            match = true;
            break;
          }
          cur = cur.parentNode;
        }
      }
      if (!match) continue;
      if (record.type === 'childList' && !obs.options.childList) continue;
      if (record.type === 'attributes') {
        if (!obs.options.attributes) continue;
        if (obs.options.attributeFilter && !obs.options.attributeFilter.includes(record.attributeName)) continue;
      }
      if (record.type === 'characterData' && !obs.options.characterData) continue;
      obs.records.push({
        target,
        addedNodes: [],
        removedNodes: [],
        attributeName: null,
        ...record,
      });
      if (!scheduledDeliveries) {
        scheduledDeliveries = true;
        microtaskQueue.push(deliverMutations);
      }
    }
  }

  function deliverMutations() {
    scheduledDeliveries = false;
    for (const obs of observers) {
      if (!obs.records.length) continue;
      const batch = obs.records.splice(0, obs.records.length);
      observerBatches++;
      obs.callback(batch, obs);
    }
  }

  function flushMicrotasks(limit = maxBatchTurns) {
    let turns = 0;
    while (microtaskQueue.length) {
      if (turns >= limit) {
        throw new Error(`Microtask queue did not settle within ${limit} turns (infinite loop)`);
      }
      turns++;
      const batch = microtaskQueue.splice(0, microtaskQueue.length);
      for (const fn of batch) fn();
    }
    return turns;
  }

  class Event {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = Boolean(init.bubbles);
      this.defaultPrevented = false;
      this.propagationStopped = false;
      this.target = null;
      this.currentTarget = null;
    }
    preventDefault() {
      this.defaultPrevented = true;
    }
    stopPropagation() {
      this.propagationStopped = true;
    }
  }

  function matchesSimpleSelector(el, part) {
    let s = part.trim();
    if (!s || el?.nodeType !== 1) return false;
    const negations = [];
    s = s.replace(/:not\(([^)]+)\)/g, (_, inner) => {
      negations.push(inner.trim());
      return '';
    });
    const attrs = [];
    s = s.replace(/\[([^\]]+)\]/g, (_, expr) => {
      attrs.push(expr.trim());
      return '';
    });
    const classes = [];
    s = s.replace(/\.([a-zA-Z0-9_-]+)/g, (_, cls) => {
      classes.push(cls);
      return '';
    });
    if (s.includes(':disabled')) {
      s = s.replace(':disabled', '');
      if (!el.disabled) return false;
    }
    const tag = s.trim().toUpperCase();
    if (tag && el.tagName !== tag) return false;
    for (const cls of classes) {
      if (!el.classList.contains(cls)) return false;
    }
    for (const expr of attrs) {
      const eq = expr.indexOf('=');
      if (eq === -1) {
        if (el.getAttribute(expr) === null) return false;
      } else {
        const name = expr.slice(0, eq).trim();
        const val = expr.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (el.getAttribute(name) !== val) return false;
      }
    }
    for (const neg of negations) {
      if (matchesSimpleSelector(el, neg)) return false;
    }
    return true;
  }

  class NodeListWrapper {
    constructor(el) {
      this._el = el;
    }
    _tokens() {
      return String(this._el._attrs.get('class') || '')
        .split(/\s+/)
        .filter(Boolean);
    }
    _save(tokens) {
      this._el.setAttribute('class', tokens.join(' '));
    }
    contains(cls) {
      return this._tokens().includes(cls);
    }
    add(...items) {
      const tokens = this._tokens();
      for (const cls of items) {
        if (cls && !tokens.includes(cls)) tokens.push(cls);
      }
      this._save(tokens);
    }
    remove(...items) {
      const removeSet = new Set(items);
      this._save(this._tokens().filter((t) => !removeSet.has(t)));
    }
    toggle(cls, force) {
      const has = this.contains(cls);
      const want = force === undefined ? !has : Boolean(force);
      if (want && !has) this.add(cls);
      else if (!want && has) this.remove(cls);
      return want;
    }
  }

  class Element {
    constructor(tagName) {
      this.nodeType = 1;
      this.tagName = String(tagName).toUpperCase();
      this.parentNode = null;
      this.childNodes = [];
      this._attrs = new Map();
      this._listeners = new Map();
      this._textContent = '';
      this.textContentWrites = 0;
      this.classList = new NodeListWrapper(this);
      this.tabIndex = 0;
      this._disabled = false;
      this._hidden = false;
      this._title = '';
      const self = this;
      this.style = new Proxy(
        { _map: {} },
        {
          get(target, prop) {
            return target._map[prop] ?? '';
          },
          set(target, prop, value) {
            target._map[prop] = String(value);
            enqueueMutation(self, { type: 'attributes', attributeName: 'style' });
            return true;
          },
        }
      );
      this.dataset = new Proxy(
        {},
        {
          get(_, prop) {
            const attr = 'data-' + String(prop).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
            return self.getAttribute(attr) ?? undefined;
          },
          set(_, prop, value) {
            const attr = 'data-' + String(prop).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
            self.setAttribute(attr, String(value));
            return true;
          },
        }
      );
    }
    get parentElement() {
      return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
    }
    get children() {
      return this.childNodes.filter((n) => n.nodeType === 1);
    }
    get nextElementSibling() {
      if (!this.parentNode) return null;
      const sibs = this.parentNode.children;
      const idx = sibs.indexOf(this);
      return idx >= 0 ? sibs[idx + 1] || null : null;
    }
    get id() {
      return this.getAttribute('id') || '';
    }
    set id(v) {
      this.setAttribute('id', String(v));
    }
    get className() {
      return this.getAttribute('class') || '';
    }
    set className(v) {
      this.setAttribute('class', v == null ? '' : String(v));
    }
    get hidden() {
      return this._hidden;
    }
    set hidden(v) {
      const next = Boolean(v);
      this._hidden = next;
      if (next) this.setAttribute('hidden', '');
      else this.removeAttribute('hidden');
    }
    get disabled() {
      return this._disabled;
    }
    set disabled(v) {
      const next = Boolean(v);
      this._disabled = next;
      if (next) this.setAttribute('disabled', '');
      else this.removeAttribute('disabled');
    }
    get title() {
      return this._title;
    }
    set title(v) {
      this._title = String(v ?? '');
      this.setAttribute('title', this._title);
    }
    get textContent() {
      if (this.childNodes.length) {
        return this.childNodes.map((c) => c.textContent).join('');
      }
      return this._textContent;
    }
    set textContent(v) {
      this.textContentWrites++;
      const removed = this.childNodes.splice(0, this.childNodes.length);
      for (const node of removed) node.parentNode = null;
      this._textContent = v == null ? '' : String(v);
      // Mirror Chromium Blink: assigning textContent always replaces child nodes and enqueues childList.
      enqueueMutation(this, { type: 'childList', removedNodes: removed });
    }
    setAttribute(name, value) {
      const key = String(name);
      this._attrs.set(key, String(value));
      if (key === 'disabled') this._disabled = true;
      if (key === 'hidden') this._hidden = true;
      enqueueMutation(this, { type: 'attributes', attributeName: key });
    }
    getAttribute(name) {
      const key = String(name);
      return this._attrs.has(key) ? this._attrs.get(key) : null;
    }
    removeAttribute(name) {
      const key = String(name);
      const existed = this._attrs.delete(key);
      if (key === 'disabled') this._disabled = false;
      if (key === 'hidden') this._hidden = false;
      if (existed) enqueueMutation(this, { type: 'attributes', attributeName: key });
    }
    append(...nodes) {
      for (const n of nodes) {
        if (!n || typeof n === 'string') continue;
        if (n.parentNode) n.remove();
        n.parentNode = this;
        this.childNodes.push(n);
        enqueueMutation(this, { type: 'childList', addedNodes: [n] });
      }
    }
    prepend(...nodes) {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (!n || typeof n === 'string') continue;
        if (n.parentNode) n.remove();
        n.parentNode = this;
        this.childNodes.unshift(n);
        enqueueMutation(this, { type: 'childList', addedNodes: [n] });
      }
    }
    after(...nodes) {
      if (!this.parentNode) return;
      const parent = this.parentNode;
      let idx = parent.childNodes.indexOf(this);
      for (const n of nodes) {
        if (!n || typeof n === 'string') continue;
        if (n.parentNode) n.remove();
        idx = parent.childNodes.indexOf(this) + 1;
        n.parentNode = parent;
        parent.childNodes.splice(idx, 0, n);
        enqueueMutation(parent, { type: 'childList', addedNodes: [n] });
      }
    }
    replaceChildren(...nodes) {
      const removed = this.childNodes.splice(0, this.childNodes.length);
      for (const r of removed) r.parentNode = null;
      const added = [];
      for (const n of nodes) {
        if (!n || typeof n === 'string') continue;
        if (n.parentNode) n.remove();
        n.parentNode = this;
        this.childNodes.push(n);
        added.push(n);
      }
      enqueueMutation(this, { type: 'childList', addedNodes: added, removedNodes: removed });
    }
    remove() {
      if (!this.parentNode) return;
      const parent = this.parentNode;
      const idx = parent.childNodes.indexOf(this);
      if (idx !== -1) parent.childNodes.splice(idx, 1);
      this.parentNode = null;
      enqueueMutation(parent, { type: 'childList', removedNodes: [this] });
    }
    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentNode;
      }
      return false;
    }
    matches(selector) {
      return selector.split(',').some((sel) => matchesSimpleSelector(this, sel));
    }
    closest(selector) {
      let cur = this;
      while (cur && cur.nodeType === 1) {
        if (cur.matches(selector)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    querySelectorAll(selector) {
      const results = [];
      const visit = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType !== 1) continue;
          if (child.matches(selector)) results.push(child);
          visit(child);
        }
      };
      visit(this);
      return results;
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
    addEventListener(type, fn, capture = false) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push({ fn, capture: Boolean(capture) });
    }
    dispatchEvent(event) {
      event.target = this;
      const chain = [];
      let cur = this;
      while (cur) {
        chain.push(cur);
        cur = cur.parentNode;
      }
      chain.push(documentObj, windowObj);
      for (let i = chain.length - 1; i >= 0; i--) {
        const node = chain[i];
        const list = node._listeners?.get(event.type) || [];
        for (const item of list) {
          if (item.capture) {
            event.currentTarget = node;
            item.fn.call(node, event);
            if (event.propagationStopped) return !event.defaultPrevented;
          }
        }
      }
      for (const node of chain) {
        event.currentTarget = node;
        const propHandler = node['on' + event.type];
        if (typeof propHandler === 'function') propHandler.call(node, event);
        const list = node._listeners?.get(event.type) || [];
        for (const item of list) {
          if (!item.capture) {
            item.fn.call(node, event);
            if (event.propagationStopped) return !event.defaultPrevented;
          }
        }
        if (!event.bubbles || event.propagationStopped) break;
      }
      return !event.defaultPrevented;
    }
    click() {
      const ev = new Event('click', { bubbles: true });
      if (typeof this.onclick === 'function') this.onclick(ev);
      if (!ev.propagationStopped) this.dispatchEvent(ev);
    }
    focus() {
      documentObj.activeElement = this;
      const ev = new Event('focus', { bubbles: false });
      this.dispatchEvent(ev);
    }
    scrollIntoView() {}
    getBoundingClientRect() {
      return { left: 20, top: 20, right: 180, bottom: 56, width: 160, height: 36 };
    }
  }

  class HTMLSelectElement extends Element {
    constructor() {
      super('SELECT');
      this._explicitValue = undefined;
    }
    get options() {
      return this.querySelectorAll('option');
    }
    get selectedOptions() {
      const opts = this.options;
      if (!opts.length) return [];
      const selected = opts.find((o) => o._selected);
      if (selected) return [selected];
      if (this._explicitValue !== undefined) {
        const byVal = opts.find((o) => o.value === this._explicitValue);
        return byVal ? [byVal] : [];
      }
      return [opts[0]];
    }
    get value() {
      if (this._explicitValue !== undefined) {
        const match = this.options.find((o) => o.value === this._explicitValue);
        return match ? match.value : '';
      }
      return this.selectedOptions[0]?.value ?? '';
    }
    set value(next) {
      const str = String(next);
      this._explicitValue = str;
      for (const opt of this.options) opt._selected = opt.value === str;
    }
    get selectedIndex() {
      const cur = this.selectedOptions[0];
      return cur ? this.options.indexOf(cur) : -1;
    }
    set selectedIndex(idx) {
      const i = Number(idx);
      const opts = this.options;
      this._explicitValue = opts[i]?.value;
      opts.forEach((opt, index) => {
        opt._selected = index === i;
      });
    }
  }

  class HTMLOptionElement extends Element {
    constructor(text = '', value = '') {
      super('OPTION');
      this._value = value;
      this._textContent = text;
      this._selected = false;
    }
    get value() {
      return this._value;
    }
    set value(v) {
      this._value = String(v);
    }
    get selected() {
      return this._selected;
    }
    set selected(v) {
      this._selected = Boolean(v);
    }
  }

  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.target = null;
      this.options = {};
      this.records = [];
    }
    observe(target, options) {
      this.target = target;
      this.options = options || {};
      observers.add(this);
    }
    disconnect() {
      observers.delete(this);
    }
  }

  const html = new Element('HTML');
  const body = new Element('BODY');
  html.append(body);

  const docListeners = new Map();
  const documentObj = {
    nodeType: 9,
    documentElement: { clientWidth: 1120, clientHeight: 860 },
    body,
    activeElement: body,
    _listeners: docListeners,
    createElement(tag) {
      const upper = String(tag).toUpperCase();
      if (upper === 'SELECT') return new HTMLSelectElement();
      if (upper === 'OPTION') return new HTMLOptionElement();
      return new Element(upper);
    },
    createElementNS(_ns, tag) {
      return new Element(tag);
    },
    querySelectorAll(sel) {
      return body.querySelectorAll(sel);
    },
    querySelector(sel) {
      return body.querySelector(sel);
    },
    contains(other) {
      return html.contains(other);
    },
    addEventListener(type, fn, capture = false) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push({ fn, capture: Boolean(capture) });
    },
  };

  const winListeners = new Map();
  const windowObj = {
    innerWidth: 1120,
    innerHeight: 860,
    _listeners: winListeners,
    addEventListener(type, fn, capture = false) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push({ fn, capture: Boolean(capture) });
    },
  };

  const context = {
    window: windowObj,
    document: documentObj,
    MutationObserver,
    HTMLSelectElement,
    Event,
    Symbol,
    WeakMap,
    Set,
    Math,
    Object,
    String,
    Array,
    Number,
    Boolean,
    setTimeout: () => 0,
    queueMicrotask(fn) {
      microtaskQueue.push(fn);
    },
  };
  windowObj.window = windowObj;
  windowObj.document = documentObj;
  vm.createContext(context);

  function loadSelects() {
    vm.runInContext(SELECTS_SRC, context);
    flushMicrotasks();
  }

  return {
    window: windowObj,
    document: documentObj,
    body,
    loadSelects,
    flushMicrotasks,
    metrics: () => ({ observerBatches }),
    resetMetrics: () => {
      observerBatches = 0;
    },
  };
}

test('selects MutationObserver settles immediately without microtask loop or redundant label writes', () => {
  const h = createHarness();
  const select = h.document.createElement('select');
  select.id = 'language';
  const zh = h.document.createElement('option');
  zh.value = 'zh';
  zh.textContent = '简体中文';
  const en = h.document.createElement('option');
  en.value = 'en';
  en.textContent = 'English';
  select.append(zh, en);
  select.value = 'zh';
  h.body.append(select);

  h.loadSelects();

  const wrap = h.body.querySelector('.cmb-select');
  assert.ok(wrap, 'custom .cmb-select wrapper inserted');
  const label = wrap.querySelector('.cmb-select-label');
  assert.equal(label.textContent, '简体中文');
  const initialWrites = label.textContentWrites;
  assert.equal(initialWrites, 1);

  h.resetMetrics();

  // Simulate unrelated DOM mutations on document.body (as performed by layout.js and renderer updates).
  for (let i = 0; i < 5; i++) {
    const notice = h.document.createElement('div');
    notice.textContent = `unrelated-${i}`;
    h.body.append(notice);
  }
  const turns = h.flushMicrotasks(20);
  assert.ok(turns <= 5, `expected microtasks to settle in <= 5 turns, got ${turns}`);
  assert.equal(label.textContentWrites, initialWrites, 'unchanged label.textContent must not be rewritten');
  assert.ok(h.metrics().observerBatches <= 2, 'unrelated mutations must not bounce back through observer');

  // Re-running syncAll when state has not changed must perform zero DOM writes on label.
  h.window.BridgeSelects.syncAll();
  assert.equal(h.flushMicrotasks(20), 0);
  assert.equal(label.textContentWrites, initialWrites);
});

test('selects tracks dynamic selects, value, selectedIndex, option text, disabled, and removal', () => {
  const h = createHarness();
  h.loadSelects();

  const container = h.document.createElement('div');
  const select = h.document.createElement('select');
  select.id = 'dynamic-channel';
  const o1 = h.document.createElement('option');
  o1.value = 'stable';
  o1.textContent = 'Stable';
  const o2 = h.document.createElement('option');
  o2.value = 'preview';
  o2.textContent = 'Preview';
  select.append(o1, o2);
  container.append(select);
  h.body.append(container);

  const enhanceTurns = h.flushMicrotasks(20);
  assert.ok(enhanceTurns <= 5, `dynamic enhance took ${enhanceTurns} turns`);

  const wrap = container.querySelector('.cmb-select');
  assert.ok(wrap, 'dynamically added <select> must be enhanced');
  const trigger = wrap.querySelector('.cmb-select-trigger');
  const label = wrap.querySelector('.cmb-select-label');
  assert.equal(label.textContent, 'Stable');

  select.value = 'preview';
  assert.ok(h.flushMicrotasks(20) <= 5);
  assert.equal(label.textContent, 'Preview');

  select.selectedIndex = 0;
  assert.ok(h.flushMicrotasks(20) <= 5);
  assert.equal(label.textContent, 'Stable');

  o1.textContent = '稳定版（Stable）';
  assert.ok(h.flushMicrotasks(20) <= 5);
  assert.equal(label.textContent, '稳定版（Stable）');

  select.disabled = true;
  assert.ok(h.flushMicrotasks(20) <= 5);
  assert.equal(trigger.disabled, true);
  assert.equal(wrap.classList.contains('is-disabled'), true);

  // Removing only the native <select> cleans up its orphaned wrapper cleanly.
  select.remove();
  assert.ok(h.flushMicrotasks(20) <= 5);
  assert.equal(container.querySelector('.cmb-select'), null);
});

test('selects custom menu updates native select, emits input+change, and closes cleanly', () => {
  const h = createHarness();
  const select = h.document.createElement('select');
  select.id = 'auth-mode';
  const p = h.document.createElement('option');
  p.value = 'password';
  p.textContent = '账号密码';
  const n = h.document.createElement('option');
  n.value = 'none';
  n.textContent = '免密访问';
  select.append(p, n);
  select.value = 'password';
  h.body.append(select);

  h.loadSelects();

  const fired = [];
  select.addEventListener('input', () => fired.push('input'));
  select.addEventListener('change', () => fired.push('change'));

  const trigger = h.body.querySelector('.cmb-select-trigger');
  const label = h.body.querySelector('.cmb-select-label');
  trigger.click();

  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  const menu = h.body.querySelector('.cmb-select-menu');
  assert.ok(menu, 'listbox menu appended to body');
  const options = menu.querySelectorAll('.cmb-select-option');
  assert.equal(options.length, 2);
  assert.equal(options[0].getAttribute('aria-selected'), 'true');
  assert.equal(options[1].getAttribute('aria-selected'), 'false');

  options[1].click();

  assert.equal(select.value, 'none');
  assert.equal(label.textContent, '免密访问');
  assert.deepEqual(fired, ['input', 'change']);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(h.body.querySelector('.cmb-select-menu'), null);
});
