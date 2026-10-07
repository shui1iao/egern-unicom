// 模拟 Egern 运行时：ctx.storage / ctx.http / ctx.notify / Headers，以及 DSL 结构校验
import assert from 'node:assert/strict';

export class Headers {
  constructor(init) {
    this.map = new Map();
    for (const [k, v] of Object.entries(init || {})) {
      for (const item of Array.isArray(v) ? v : [v]) this.append(k, item);
    }
  }
  append(k, v) {
    const key = k.toLowerCase();
    if (!this.map.has(key)) this.map.set(key, []);
    this.map.get(key).push(String(v));
  }
  get(k) {
    const v = this.map.get(k.toLowerCase());
    return v ? v.join(', ') : null;
  }
  getAll(k) {
    return (this.map.get(k.toLowerCase()) || []).slice();
  }
  has(k) {
    return this.map.has(k.toLowerCase());
  }
}

export function makeStorage(initial) {
  const data = new Map(Object.entries(initial || {}));
  return {
    data,
    get: (k) => (data.has(k) ? data.get(k) : null),
    set: (k, v) => data.set(k, String(v)),
    getJSON: (k) => (data.has(k) ? JSON.parse(data.get(k)) : null),
    setJSON: (k, v) => data.set(k, JSON.stringify(v)),
    delete: (k) => data.delete(k),
  };
}

function response(spec) {
  const body = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
  let used = false;
  const once = () => {
    if (used) throw new Error('body already used');
    used = true;
    return body;
  };
  return {
    status: spec.status === undefined ? 200 : spec.status,
    headers: new Headers(spec.headers || {}),
    text: async () => once(),
    json: async () => JSON.parse(once()),
  };
}

// route(method, url, options) 返回 {status, headers, body} 或抛错模拟网络失败
export function makeCtx({ storage, route, env, family, request, response: resp } = {}) {
  const calls = [];
  const notes = [];
  const http = {};
  for (const m of ['get', 'post', 'put', 'delete', 'head', 'options', 'patch']) {
    http[m] = async (url, options) => {
      calls.push({ method: m, url, options: options || {} });
      if (!route) throw new Error('unexpected request ' + url);
      return response(await route(m, url, options || {}));
    };
  }
  const ctx = {
    env: env || {},
    storage: storage || makeStorage(),
    http,
    notify: (o) => notes.push(o),
    widgetFamily: family,
  };
  if (request) ctx.request = request;
  if (resp) ctx.response = resp;
  return { ctx, calls, notes };
}

export function makeRequest(url, headers, bodyText) {
  return {
    method: 'GET',
    url,
    headers: new Headers(headers || {}),
    text: async () => bodyText || '',
    arrayBuffer: async () => new TextEncoder().encode(bodyText || '').buffer,
  };
}

export function makeResponse(headers, bodyText) {
  return {
    status: 200,
    headers: new Headers(headers || {}),
    text: async () => bodyText,
    json: async () => JSON.parse(bodyText),
  };
}

/* ---------------- DSL 校验（按 egernapp.com 小组件文档） ---------------- */

const TYPES = ['widget', 'stack', 'text', 'image', 'spacer', 'date'];
const COMMON = ['type', 'url', 'opacity', 'flex', 'shadowColor', 'shadowRadius', 'shadowOffset'];
const ALLOWED = {
  widget: [...COMMON, 'children', 'padding', 'gap', 'backgroundColor', 'backgroundGradient', 'backgroundImage', 'refreshAfter'],
  stack: [...COMMON, 'children', 'direction', 'alignItems', 'width', 'height', 'padding', 'gap', 'backgroundColor', 'backgroundGradient', 'backgroundImage', 'borderRadius', 'borderWidth', 'borderColor'],
  text: [...COMMON, 'text', 'font', 'textColor', 'textAlign', 'maxLines', 'minScale'],
  image: [...COMMON, 'src', 'color', 'resizeMode', 'resizable', 'width', 'height', 'borderRadius', 'borderWidth', 'borderColor'],
  spacer: [...COMMON, 'length'],
  date: [...COMMON, 'date', 'format', 'font', 'textColor', 'textAlign', 'maxLines', 'minScale'],
};
const FONT_SIZES = ['largeTitle', 'title', 'title2', 'title3', 'headline', 'body', 'callout', 'subheadline', 'footnote', 'caption1', 'caption2'];
const WEIGHTS = ['ultraLight', 'thin', 'light', 'regular', 'medium', 'semibold', 'bold', 'heavy', 'black'];
const COLOR_RE = /^(#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?|rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*[\d.]+\s*\))$/;

function isColor(c) {
  if (typeof c === 'string') return COLOR_RE.test(c);
  return !!c && typeof c === 'object' && COLOR_RE.test(c.light) && COLOR_RE.test(c.dark) && Object.keys(c).length === 2;
}

function finite(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

export function validateDSL(node, path = 'root', isRoot = true) {
  assert.ok(node && typeof node === 'object', path + ' 不是对象');
  assert.ok(TYPES.includes(node.type), path + ' 未知类型 ' + node.type);
  if (isRoot) assert.equal(node.type, 'widget', '根节点必须是 widget');
  else assert.notEqual(node.type, 'widget', path + ' widget 只能做根节点');
  for (const k of Object.keys(node)) {
    assert.ok(ALLOWED[node.type].includes(k), `${path} (${node.type}) 不支持属性 ${k}`);
    assert.notEqual(node[k], undefined, `${path}.${k} 是 undefined`);
  }
  for (const k of ['flex', 'gap', 'width', 'height', 'length', 'borderWidth', 'opacity', 'maxLines', 'minScale']) {
    if (k in node) assert.ok(finite(node[k]) && node[k] >= 0, `${path}.${k} 非法: ${node[k]}`);
  }
  if ('flex' in node) assert.ok(node.flex > 0, `${path}.flex 必须 > 0`);
  if ('minScale' in node) assert.ok(node.minScale <= 1, `${path}.minScale > 1`);
  if ('opacity' in node) assert.ok(node.opacity <= 1, `${path}.opacity > 1`);
  if ('borderRadius' in node) assert.ok(node.borderRadius === 'auto' || (finite(node.borderRadius) && node.borderRadius >= 0), `${path}.borderRadius`);
  if ('padding' in node) {
    const p = node.padding;
    assert.ok(finite(p) || (Array.isArray(p) && [2, 4].includes(p.length) && p.every(finite)), `${path}.padding 非法`);
  }
  for (const k of ['backgroundColor', 'textColor', 'color', 'borderColor', 'shadowColor']) {
    if (k in node) assert.ok(isColor(node[k]), `${path}.${k} 颜色非法: ${JSON.stringify(node[k])}`);
  }
  if ('font' in node) {
    const f = node.font;
    assert.ok(FONT_SIZES.includes(f.size) || (finite(f.size) && f.size > 0), `${path}.font.size`);
    if (f.weight) assert.ok(WEIGHTS.includes(f.weight), `${path}.font.weight`);
  }
  if ('direction' in node) assert.ok(['row', 'column'].includes(node.direction), `${path}.direction`);
  if ('alignItems' in node) assert.ok(['start', 'end', 'center'].includes(node.alignItems), `${path}.alignItems`);
  if ('refreshAfter' in node) assert.ok(!Number.isNaN(Date.parse(node.refreshAfter)), `${path}.refreshAfter`);
  if (node.type === 'text') assert.equal(typeof node.text, 'string', `${path}.text 必须是字符串`);
  if (node.type === 'text') assert.ok(!/undefined|NaN|null|\[object/.test(node.text), `${path}.text 含异常值: ${node.text}`);
  if (node.type === 'image') assert.ok(/^(sf-symbol:[a-z0-9.]+|data:)/.test(node.src), `${path}.src`);
  if (node.type === 'widget' || node.type === 'stack') {
    assert.ok(Array.isArray(node.children), `${path}.children 必须是数组`);
    node.children.forEach((c, i) => validateDSL(c, `${path}.${i}`, false));
  } else {
    assert.ok(!('children' in node), `${path} 不应有 children`);
  }
  return node;
}

export function texts(node, out = []) {
  if (node.type === 'text') out.push(node.text);
  (node.children || []).forEach((c) => texts(c, out));
  return out;
}

export const FAMILIES = [
  'systemSmall',
  'systemMedium',
  'systemLarge',
  'systemExtraLarge',
  'accessoryCircular',
  'accessoryRectangular',
  'accessoryInline',
];
