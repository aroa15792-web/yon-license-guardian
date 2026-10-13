import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const script = html.match(/<script nonce="__CSP_NONCE__">([\s\S]*?)<\/script>/)[1];

// Exercise the shipped script without a browser or production network access.
class Element {
  constructor(text = '', hidden = false) {
    this.textContent = text;
    this.hidden = hidden;
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.attributes = {};
    this.scrollTop = 0;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) {
    this.children = children.flatMap(child => child.fragment ? child.children : [child]);
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const nodes = new Map(Array.from(html.matchAll(/<[a-z][\w-]*\b([^>]*\bid="([^"]+)"[^>]*)>([^<]*)/g),
    match => [match[2], new Element(match[3], /\bhidden\b/.test(match[1]))]));
  nodes.get('meter').children = Array.from({ length: 10 }, () => new Element());
  const filters = new Map(Array.from(html.matchAll(/data-filter="([^"]+)"/g), match => {
    const button = new Element(); button.dataset.filter = match[1];
    return [match[1], button];
  }));
  let now = Date.UTC(2026, 0, 1);
  let status = { monitor: { status: 'observing', enabled: true, checkedAt: now - 179_500,
    used: 0, capacity: 10 }, test: null };
  const emptyEvents = { events: [], startedAt: now, lastObservedAt: now,
    retention: { maxEntries: 2000, maxAgeMs: 86_400_000 } };
  const calls = [];
  const intervals = new Map();
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const document = { hidden: false, getElementById: id => nodes.get(id),
    querySelectorAll: () => Array.from(filters.values()), createElement: () => new Element(),
    createTextNode: text => ({ textContent: text }),
    createDocumentFragment: () => Object.assign(new Element(), { fragment: true }),
    addEventListener() {} };
  const context = vm.createContext({ document, window: { addEventListener() {} },
    Date: Clock, AbortController, Intl, setTimeout: () => 1, clearTimeout() {},
    setInterval: (callback, delay) => intervals.set(delay, callback),
    fetch: path => {
      const pending = deferred(); calls.push({ path, ...pending }); return pending.promise;
    } });
  new vm.Script(script).runInContext(context);
  const takeCall = path => {
    const index = calls.findIndex(call => call.path === path);
    assert.notEqual(index, -1, `expected pending ${path} request`);
    return calls.splice(index, 1)[0];
  };
  const response = (ok, value) => ({ ok, json: async () => structuredClone(value) });
  return { nodes, filters, context, emptyEvents, intervals,
    advance: milliseconds => { now += milliseconds; },
    resolveStatus: () => takeCall('/status').resolve(response(true, status)),
    resolveEvents: ok => takeCall('./events').resolve(response(ok, emptyEvents)),
    refresh: () => vm.runInContext('refresh()', context),
    setFreshStatus: () => { status = { ...status, monitor: { ...status.monitor, checkedAt: now } }; },
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('selecting an empty filter before first response settles to an empty state', async () => {
  const ui = harness();
  ui.filters.get('cleanup').listeners.click();
  assert.equal(ui.nodes.get('empty-title').textContent, '正在读取日志');
  ui.resolveStatus(); ui.resolveEvents(true); await settle();
  assert.equal(ui.nodes.get('empty-title').textContent, '这个类型暂时没有记录');
  assert.equal(ui.nodes.get('empty-state').hidden, false);
  assert.equal(ui.nodes.get('event-table').hidden, true);
  assert.equal(ui.nodes.get('log-notice').hidden, true);
  assert.equal(ui.nodes.get('event-count').textContent, '显示 0 / 0 条');
});

test('first log failure followed by an empty response clears the error empty state', async () => {
  const ui = harness();
  ui.filters.get('cleanup').listeners.click();
  ui.resolveStatus(); ui.resolveEvents(false); await settle();
  assert.equal(ui.nodes.get('empty-title').textContent, '日志连接暂时不可用');
  assert.equal(ui.nodes.get('log-notice').hidden, false);
  const refreshing = ui.refresh();
  ui.resolveStatus(); ui.resolveEvents(true); await refreshing;
  assert.equal(ui.nodes.get('empty-title').textContent, '这个类型暂时没有记录');
  assert.equal(ui.nodes.get('log-notice').hidden, true);
  assert.equal(ui.nodes.get('event-count').textContent, '显示 0 / 0 条');
  assert.equal(ui.nodes.get('refresh').disabled, false);
});

test('a valid zero expires while a refresh is still awaiting responses', async () => {
  const ui = harness();
  ui.resolveStatus(); ui.resolveEvents(true); await settle();
  assert.equal(ui.nodes.get('used').textContent, '0');
  assert.equal(ui.nodes.get('connection-text').textContent, '监控中');
  const refreshing = ui.refresh();
  assert.equal(ui.nodes.get('refresh').disabled, true);
  ui.advance(1_000);
  ui.intervals.get(1_000)();
  assert.equal(ui.nodes.get('used').textContent, '—');
  assert.equal(ui.nodes.get('connection-text').textContent, '状态过期');
  assert.equal(ui.nodes.get('refresh').disabled, true);
  assert.notEqual(ui.nodes.get('state').textContent, '状态页连接中断');
  ui.setFreshStatus(); ui.resolveStatus(); ui.resolveEvents(true); await refreshing;
  assert.equal(ui.nodes.get('used').textContent, '0');
  assert.equal(ui.nodes.get('connection-text').textContent, '监控中');
  assert.equal(ui.nodes.get('refresh').disabled, false);
});
