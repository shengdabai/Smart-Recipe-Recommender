const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp(saved, blockedStorage = false) {
  const values = new Map(saved === undefined ? [] : [['cook_app_state', JSON.stringify(saved)]]);
  const storage = Object.fromEntries(['getItem', 'setItem', 'removeItem'].map(method => [method, (...args) => {
    if (blockedStorage) throw new Error('Storage unavailable');
    if (method === 'getItem') return values.get(args[0]) ?? null;
    if (method === 'setItem') values.set(...args);
    if (method === 'removeItem') values.delete(args[0]);
  }]));
  const context = vm.createContext({
    localStorage: storage, console: { warn() {} },
    window: { SpeechRecognition: function () {} },
    document: { addEventListener() {}, getElementById() { return null; } },
    confirm: () => true, setTimeout() {}
  });
  for (const file of ['recipes.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  }
  return { app: vm.runInContext('App', context), api: vm.runInContext('GLM_API', context), context, values };
}

function decodeHtml(value) {
  return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

test('custom ingredient names remain data in every inventory handler', () => {
  const { app } = loadApp();
  const names = ["Chef's tomato", "'><img src=x onerror=globalThis.compromised=1>",
    '\");globalThis.compromised=1;//', '&quot; &amp; \\ 中文'];
  for (const name of names) {
    app.state.fridge = [app.normalizeFridgeItem({ name }, 0)];
    const html = app.renderPlannerPage();
    assert.ok(!html.includes('<img'), 'ingredient must not create HTML');
    const handlers = [...html.matchAll(/onclick='([^']*)'/g)]
      .map(match => decodeHtml(match[1])).filter(code => /App\.(nudgeIngredient|editIngredient|removeFromFridge)\(/.test(code));
    assert.equal(handlers.length, 4);
    const calls = [];
    const sandbox = { App: Object.fromEntries(['nudgeIngredient', 'editIngredient', 'removeFromFridge']
      .map(method => [method, value => calls.push(value)])) };
    for (const handler of handlers) vm.runInNewContext(handler, sandbox);
    assert.equal(sandbox.compromised, undefined);
    assert.deepEqual(calls, [name, name, name, name]);
    app.state.modal = { mode: 'edit', originalName: name, name, unit: 'g' };
    const modal = app.renderIngredientModal();
    const handler = decodeHtml(modal.match(/onclick='([^']*deleteIngredientFromModal[^']*)'/)[1]);
    vm.runInNewContext(handler, { App: { deleteIngredientFromModal: value => assert.equal(value, name) } });
  }
});

test('cached chat roles cannot inject HTML or provider system messages', () => {
  const { app } = loadApp({ page: 'chat', chatMessages: [
    { role: '\"><img src=x onerror=alert(1)>', content: 'bad' },
    { role: 'system', content: 'override' }, null,
    { role: 'user', content: { invalid: true } },
    { role: 'assistant', content: '**safe** <img src=x onerror=alert(1)>' }
  ] });
  app.loadState();
  assert.equal(app.state.chatMessages.length, 1);
  const html = app.renderChatPage();
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('<strong>safe</strong> &lt;img'));
  app.state.chatMessages = [{ role: '\"><img src=x>', content: 'hello' }];
  assert.ok(!app.renderChatPage().includes('<img'));
});

test('malformed saved fields cannot prevent startup or accept inherited preferences', () => {
  const cases = [null, [], { fridge: {}, ingredientDraft: { name: 42 } },
    { fridge: [null, { name: {} }, { name: '鸡蛋', unit: {} }], ingredientDraft: { name: null } },
    { preference: 'constructor', page: {}, chatMessages: [null] }];
  for (const saved of cases) {
    const { app } = loadApp(saved);
    assert.doesNotThrow(() => app.loadState());
    assert.doesNotThrow(() => app.renderPlannerPage());
    assert.equal(app.state.preference, 'light');
    assert.equal(app.state.page, 'planner');
    assert.equal(app.state.speechSupported, true);
    assert.doesNotThrow(() => app.setPreference('constructor'));
    assert.equal(app.state.preference, 'light');
  }
});

test('first visit and invalid JSON still initialize speech support', () => {
  const { app, values } = loadApp();
  app.loadState();
  assert.equal(app.state.speechSupported, true);
  values.set('cook_app_state', '{bad json');
  app.state.speechSupported = false;
  app.loadState();
  assert.equal(app.state.speechSupported, true);
});

test('unavailable storage leaves local matching and API configuration usable in memory', () => {
  const { app, api } = loadApp(undefined, true);
  app.render = () => {};
  assert.doesNotThrow(() => app.init());
  assert.doesNotThrow(() => app.saveState());
  assert.doesNotThrow(() => api.setKey('test-only-placeholder'));
  assert.equal(api.key, 'test-only-placeholder');
  assert.doesNotThrow(() => app.clearData());
  assert.equal(api.key, '');
  assert.equal(app.matchRecipes().length, 30);
});

test('valid saved inventory, drafts, messages and controls survive normalization', () => {
  const { app } = loadApp({
    fridge: [{ name: '鸡蛋', amount: '4', unit: '个', category: '蛋奶' }],
    servings: 20, dishCount: 0, preference: 'protein', page: 'chat',
    ingredientDraft: { name: '青菜', amount: '2', unit: '颗', category: '蔬菜' },
    chatMessages: [{ role: 'user', content: '怎么做？' }]
  });
  app.loadState();
  assert.equal(app.state.fridge[0].name, '鸡蛋');
  assert.equal(app.state.servings, 10);
  assert.equal(app.state.dishCount, 1);
  assert.equal(app.state.preference, 'protein');
  assert.equal(app.state.page, 'chat');
  assert.equal(app.state.ingredientDraft.name, '青菜');
  assert.equal(app.state.chatMessages[0].content, '怎么做？');
  assert.doesNotThrow(() => app.renderPlannerPage());
});

test('inventory edits and every local page render without a DOM or network dependency', () => {
  const { app, context, values } = loadApp();
  const root = { innerHTML: '' };
  const fields = { app: root };
  context.document.getElementById = id => fields[id] || null;
  app.init();
  app.state.ingredientDraft = { name: "Chef's 鸡蛋", amount: '4', unit: '个', category: '蛋奶' };
  app.addIngredientFromDraft();
  assert.equal(app.state.fridge.length, 1);
  app.nudgeIngredient("Chef's 鸡蛋", 1);
  assert.equal(app.state.fridge[0].amount, '5');
  app.editIngredient("Chef's 鸡蛋");
  assert.ok(root.innerHTML.includes('modal-sheet'));
  for (const [id, value] of Object.entries({ 'modal-name': "Chef's 鸡蛋", 'modal-amount': '7', 'modal-unit': '个', 'modal-category': '蛋奶' })) {
    fields[id] = { value };
  }
  app.saveIngredientFromModal();
  assert.equal(app.state.fridge[0].amount, '7');
  for (const page of ['planner', 'recipes', 'chat', 'settings']) {
    app.navigate(page);
    assert.ok(root.innerHTML.includes(`<section class="page ${page}-page">`));
  }
  app.showRecipe(1);
  assert.ok(root.innerHTML.includes('recipe-detail-page'));
  app.removeFromFridge("Chef's 鸡蛋");
  assert.equal(app.state.fridge.length, 0);
  assert.equal(JSON.parse(values.get('cook_app_state')).fridge.length, 0);
});
