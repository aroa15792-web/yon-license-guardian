import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import KeyTable from './node_modules/@novnc/novnc/core/input/keysym.js';

const target = 'https://c3.yonyoucloud.com/iuap-apcom-workbench/manager/#/measuringBilling?locale=zh_CN';
const template = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const script = template.match(/<script type="module"[^>]*>([\s\S]*?)<\/script>/)[1]
  .replace(/^\s*import .*;$/gm, '');

function fixture({ sendFailure = false, holdDelay = false, onSend } = {}) {
  const elements = new Map();
  let connection;
  let resume;
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      disabled: ['connect', 'disconnect', 'license-dashboard', 'yonyou-login',
        'remote-text', 'send-remote-text', 'remote-tab', 'remote-enter'].includes(id),
      value: '',
      textContent: id === 'vnc-config' ? '{"password":"synthetic"}' : '',
      dataset: {}, listeners: new Map(), remove() {},
      addEventListener(event, handler) { this.listeners.set(event, handler); },
    });
    return elements.get(id);
  };
  class RFB {
    constructor() { connection = this; this.listeners = new Map(); this.keys = []; }
    addEventListener(event, handler) { this.listeners.set(event, handler); }
    emit(event, detail = {}) { return this.listeners.get(event)?.({ detail }); }
    sendKey(...args) {
      this.keys.push(args);
      onSend?.(...args);
      if (sendFailure && args[1] === 'KeyL') throw new Error('synthetic failed key');
    }
    focus() { this.focused = true; }
  }
  vm.runInNewContext(script, {
    RFB, KeyTable, initLogging: level => assert.equal(level, 'none'),
    document: { getElementById: element }, location: { host: '127.0.0.1:19080' },
    setTimeout(callback, delay) {
      assert.equal(delay, 150);
      if (holdDelay) resume = callback;
      else queueMicrotask(callback);
    },
  });
  return { element, connection, click: (id = 'license-dashboard') => element(id).listeners.get('click')(),
    resume: () => resume() };
}

test('fixed login and dashboard buttons are connected-only and share one navigation lock', async () => {
  assert.match(template, /<button id="license-dashboard" disabled>应用许可看板<\/button>/);
  assert.match(template, /<button id="yonyou-login" disabled>用友登录<\/button>/);
  const destinations = [['license-dashboard', target], ['yonyou-login', 'https://www.yonyoucloud.com/']];
  for (const [id, url] of destinations) {
    const ui = fixture({ holdDelay: true });
    await ui.click(id);
    assert.equal(ui.connection.keys.length, 0);
    ui.connection.emit('connect');
    for (const [button] of destinations) assert.equal(ui.element(button).disabled, false);
    const navigation = ui.click(id);
    for (const [button] of destinations) {
      assert.equal(ui.element(button).disabled, true);
      await ui.click(button);
    }
    ui.resume();
    await navigation;
    assert.deepEqual(ui.connection.keys, [
      [KeyTable.XK_Control_L, 'ControlLeft', true],
      [KeyTable.XK_l, 'KeyL'],
      [KeyTable.XK_Control_L, 'ControlLeft', false],
      ...Array.from(url, character => [character.codePointAt(0)]),
      [KeyTable.XK_Return, 'Enter'],
    ]);
    assert.equal(ui.connection.focused, true);
    for (const [button] of destinations) assert.equal(ui.element(button).disabled, false);
    ui.connection.emit('disconnect', { clean: true });
    for (const [button] of destinations) assert.equal(ui.element(button).disabled, true);
  }
});

test('failed address-bar key still releases Control and sends no navigation or automatic retry', async () => {
  const ui = fixture({ sendFailure: true });
  ui.connection.emit('connect');
  await ui.click();
  assert.deepEqual(ui.connection.keys, [
    [KeyTable.XK_Control_L, 'ControlLeft', true],
    [KeyTable.XK_l, 'KeyL'],
    [KeyTable.XK_Control_L, 'ControlLeft', false],
  ]);
  assert.equal(ui.element('status').dataset.state, 'error');
  assert.equal(ui.element('license-dashboard').disabled, false);
  assert.equal(ui.element('yonyou-login').disabled, false);
});

test('disconnect while the address bar takes focus cancels URL typing', async () => {
  const ui = fixture({ holdDelay: true });
  ui.connection.emit('connect');
  const navigation = ui.click();
  ui.connection.emit('disconnect', { clean: false });
  ui.resume();
  await navigation;
  assert.equal(ui.connection.keys.length, 3);
  assert.equal(ui.element('license-dashboard').disabled, true);
  assert.equal(ui.element('yonyou-login').disabled, true);
});

test('masked remote text clears before the first key and sends exact Latin-1 and Unicode keysyms', async () => {
  const input = template.match(/<input id="remote-text"[^>]*>/)[0];
  assert.match(input, /type="password"/);
  assert.match(input, /autocomplete="off"/);
  assert.doesNotMatch(input, /\bvalue=/);
  assert.match(template, /<button id="send-remote-text" disabled>发送文本<\/button>/);
  const observations = [];
  const controls = ['license-dashboard', 'yonyou-login', 'remote-text', 'send-remote-text', 'remote-tab', 'remote-enter'];
  const ui = fixture({ onSend: () => observations.push({
    value: ui.element('remote-text').value,
    disabled: controls.map(id => ui.element(id).disabled),
  }) });
  ui.connection.emit('connect');
  ui.element('remote-text').value = 'Aé中🙂';
  await ui.click('send-remote-text');
  assert.deepEqual(ui.connection.keys, [[0x41], [0xe9], [0x1000000 + 0x4e2d], [0x1000000 + 0x1f642]]);
  for (const observation of observations) {
    assert.equal(observation.value, '');
    assert.deepEqual(observation.disabled, controls.map(() => true));
  }
  assert.equal(ui.element('remote-text').value, '');
  assert.equal(ui.element('status').dataset.state, 'connected');
  assert.doesNotMatch(ui.element('status').textContent, /Aé中🙂/);
  for (const id of controls) assert.equal(ui.element(id).disabled, false);
});

test('remote input refuses disconnected or busy sends and cancels after a disconnect', async () => {
  const disconnected = fixture();
  disconnected.element('remote-text').value = 'synthetic';
  await disconnected.click('send-remote-text');
  await disconnected.click('remote-tab');
  await disconnected.click('remote-enter');
  assert.equal(disconnected.element('remote-text').value, '');
  assert.equal(disconnected.connection.keys.length, 0);

  const busy = fixture({ holdDelay: true });
  busy.connection.emit('connect');
  const navigation = busy.click('yonyou-login');
  busy.element('remote-text').value = 'synthetic';
  await busy.click('send-remote-text');
  await busy.click('remote-tab');
  await busy.click('remote-enter');
  assert.equal(busy.connection.keys.length, 3);
  assert.equal(busy.element('remote-text').value, '');
  busy.connection.emit('disconnect', { clean: true });
  busy.resume();
  await navigation;

  const interrupted = fixture({ onSend: () => interrupted.connection.emit('disconnect', { clean: false }) });
  interrupted.connection.emit('connect');
  interrupted.element('remote-text').value = 'AB';
  await interrupted.click('send-remote-text');
  assert.deepEqual(interrupted.connection.keys, [[0x41]]);
  assert.equal(interrupted.element('remote-text').value, '');
  assert.equal(interrupted.element('send-remote-text').disabled, true);
});

test('connected Tab and Enter controls send only their fixed RFB keys', async () => {
  const ui = fixture();
  ui.connection.emit('connect');
  await ui.click('remote-tab');
  await ui.click('remote-enter');
  assert.deepEqual(ui.connection.keys, [[KeyTable.XK_Tab, 'Tab'], [KeyTable.XK_Return, 'Enter']]);
});
