/*
 * 中国联通余量 · Egern 小组件
 *
 * 同一个脚本按 Egern 传入的 ctx 分三种用途：
 *   http_request  联通 App 首页查询余额（queryUserInfoSeven）时，记录 Cookie 和手机号；
 *                 App 自动登录（onLine.htm）时，从表单里记录 appId / token_online
 *   http_response App 自动登录返回时，记录新的 token_online 和下发的 Cookie
 *   generic       渲染小组件；Cookie 失效时用 token_online 自动续登一次
 *
 * 登录信息只保存在本机 Egern 的 ctx.storage 中，只发往联通自己的接口。
 * 接口参考：IBL3ND/module（queryUserInfoSeven）、pangpangyunshu/ChinaUnicom（流量明细与续登）。
 */

const ORIGIN = 'https://m.client.10010.com';
const API = {
  summary: ORIGIN + '/mobileserviceimportant/home/queryUserInfoSeven',
  detail: ORIGIN + '/servicequerybusiness/operationservice/queryOcsPackageFlowLeftContentRevisedInJune',
  online: ORIGIN + '/mobileService/onLine.htm',
};
const MATCH = {
  summary: /^https:\/\/m\.client\.10010\.com\/mobileserviceimportant\/home\/queryUserInfoSeven(?:[?#]|$)/,
  online: /^https:\/\/(?:m\.client|loginxhm)\.10010\.com\/mobileService\/onLine\.htm(?:[?#]|$)/,
};
const UA = 'ChinaUnicom.x CFNetwork iOS/16.3';
const SUMMARY_VERSION = 'iphone_c@10.0100';
const ONLINE_VERSION = 'iphone_c@9.0100';
const PREFIX = 'shuijiao.unicom.v1.';
const HTTP_TIMEOUT = 8000;
const FRESH_MS = 5 * 60 * 1000; // 5 分钟内直接用缓存，避免多个尺寸同时刷新时重复请求
const REFRESH_MS = 30 * 60 * 1000; // 建议 iOS 30 分钟后刷新
const AUTH_RETRY_MS = 60 * 60 * 1000; // 登录失效后 1 小时内不再用旧凭据反复请求
const RELOGIN_GAP_MS = 10 * 60 * 1000; // 两次自动续登至少间隔 10 分钟
const PHONE_RE = /^1[3-9]\d{9}$/;
const AUTH_CODES = ['999999', '999998'];
const DETAIL_OK = ['0000', '0'];
const ONLINE_OK = ['0', '0000'];

/* ============================== 入口 ============================== */

export default async function (ctx) {
  if (ctx && ctx.request && ctx.response) return captureOnlineResponse(ctx);
  if (ctx && ctx.request && ctx.request.url) {
    if (MATCH.online.test(String(ctx.request.url))) return captureOnlineRequest(ctx);
    try {
      captureSummaryRequest(ctx);
    } catch (e) {
      // 抓取失败不能影响联通 App 的原请求
    }
    return undefined;
  }
  try {
    return await renderWidget(ctx);
  } catch (e) {
    return messageWidget(ctx, '小组件出错，请稍后重试', 'danger');
  }
}

/* ============================== 小工具 ============================== */

function str(v) {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function nonneg(v) {
  return Math.max(0, num(v));
}

function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

async function readText(resp) {
  try {
    if (resp && typeof resp.text === 'function') return String(await resp.text());
  } catch (e) {}
  return '';
}

function fail(kind) {
  const e = new Error(kind);
  e.kind = kind;
  return e;
}

function queryParam(url, name) {
  const m = String(url).match(new RegExp('[?&]' + name + '=([^&#]*)', 'i'));
  if (!m) return '';
  try {
    return decodeURIComponent(m[1].replace(/\+/g, ' ')).trim();
  } catch (e) {
    return '';
  }
}

function formEncode(obj) {
  return Object.keys(obj)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]))
    .join('&');
}

function isTrue(v) {
  return v === true || ['true', '1', 'on', 'yes'].includes(String(v).trim().toLowerCase());
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

// 固定按北京时间显示；不是今天的数据带上日期
function beijingTime(ts, now) {
  if (!ts) return '--:--';
  const d = new Date(ts + 8 * 3600 * 1000);
  const n = new Date((now || Date.now()) + 8 * 3600 * 1000);
  const hm = pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
  const sameDay =
    d.getUTCFullYear() === n.getUTCFullYear() &&
    d.getUTCMonth() === n.getUTCMonth() &&
    d.getUTCDate() === n.getUTCDate();
  return sameDay ? hm : pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' + hm;
}

function headerValues(headers, name) {
  if (!headers) return [];
  const lname = name.toLowerCase();
  try {
    if (typeof headers.getAll === 'function') {
      const all = headers.getAll(name);
      if (Array.isArray(all)) return all.map(String).filter(Boolean);
    }
  } catch (e) {}
  let v;
  try {
    if (typeof headers.get === 'function') v = headers.get(name);
  } catch (e) {}
  if (v === undefined || v === null) {
    try {
      const key = Object.keys(headers).find((k) => k.toLowerCase() === lname);
      v = key === undefined ? undefined : headers[key];
    } catch (e) {}
  }
  if (v === undefined || v === null || v === '') return [];
  return (Array.isArray(v) ? v : [v]).map(String).filter(Boolean);
}

/* ============================== 存储 ============================== */

const store = {
  getJSON(ctx, key) {
    try {
      const v = ctx.storage.getJSON(PREFIX + key);
      return v && typeof v === 'object' ? v : null;
    } catch (e) {
      return null;
    }
  },
  setJSON(ctx, key, value) {
    try {
      ctx.storage.setJSON(PREFIX + key, value);
    } catch (e) {}
  },
  remove(ctx, key) {
    try {
      ctx.storage.delete(PREFIX + key);
    } catch (e) {}
  },
};

function readAuth(ctx) {
  const a = store.getJSON(ctx, 'auth') || {};
  return {
    cookie: str(a.cookie),
    phone: PHONE_RE.test(str(a.phone)) ? str(a.phone) : '',
    token: str(a.token),
    appId: str(a.appId),
    capturedAt: num(a.capturedAt),
    authFailedAt: num(a.authFailedAt),
    reloginAt: num(a.reloginAt),
    notified: str(a.notified),
  };
}

function writeAuth(ctx, auth) {
  store.setJSON(ctx, 'auth', auth);
}

/* ============================== Cookie ============================== */

function cookiePairs(header) {
  const out = [];
  String(header || '')
    .split(';')
    .forEach((part) => {
      const i = part.indexOf('=');
      if (i <= 0) return;
      const name = part.slice(0, i).trim();
      const value = part.slice(i + 1).trim();
      if (!name || /[\s,;=]/.test(name) || /[\r\n]/.test(value)) return;
      out.push([name, value]);
    });
  return out;
}

// 多个 Set-Cookie 被合并成一行时按 ", 名称=" 拆开（Expires 里的逗号后面不是 名称=）
function splitSetCookie(values) {
  const out = [];
  (values || []).forEach((v) =>
    String(v)
      .split(/,(?=\s*[^;,=\s]+=)/)
      .forEach((s) => {
        if (s.trim()) out.push(s.trim());
      }),
  );
  return out;
}

function mergeCookies(base, requestHeader, setCookieValues) {
  const jar = new Map();
  cookiePairs(base).forEach(([k, v]) => jar.set(k, v));
  cookiePairs(requestHeader).forEach(([k, v]) => jar.set(k, v));
  splitSetCookie(setCookieValues).forEach((line) => {
    const segs = line.split(';');
    const first = cookiePairs(segs[0])[0];
    if (!first) return;
    const attrs = ';' + segs.slice(1).join(';') + ';';
    const removed = first[1] === '' || /;\s*max-age\s*=\s*(?:0|-\d+)\s*;/i.test(attrs);
    if (removed) jar.delete(first[0]);
    else jar.set(first[0], first[1]);
  });
  return Array.from(jar, ([k, v]) => k + '=' + v).join('; ');
}

/* ============================== 抓取 ============================== */

function readiness(auth) {
  if (!auth.cookie) return '';
  const relogin = auth.token && auth.appId;
  if (auth.phone && relogin) return 'full';
  if (auth.phone) return 'cookie';
  return relogin ? 'token' : 'partial';
}

// token/partial 不单独通知：App 启动时先自动登录、随后首页查余额，会紧接着升到 full
const READY_TEXT = {
  full: '登录信息已就绪，Cookie 过期会自动续登',
  cookie: '已获取登录信息。想开启自动续登：从后台划掉联通 App 再重新打开一次',
};

// 只在就绪程度变化或登录失效后恢复时通知，平时打开 App 不打扰
function saveCaptured(ctx, old, next) {
  const level = readiness(next);
  const recovered = old.authFailedAt > 0;
  if (READY_TEXT[level] && (level !== old.notified || recovered)) {
    next.notified = level;
    writeAuth(ctx, next);
    try {
      ctx.notify({
        title: '中国联通余量',
        body: (recovered ? '登录信息已更新。' : '') + READY_TEXT[level],
        sound: false,
      });
    } catch (e) {}
    return;
  }
  writeAuth(ctx, next);
}

// 换了号码：旧号码的 Cookie、续登信息和缓存都不能再用
function baseFor(ctx, old, phone) {
  if (!old.phone || !phone || phone === old.phone) return old;
  store.remove(ctx, 'cache');
  return { ...old, cookie: '', token: '', appId: '', notified: '', authFailedAt: 0, reloginAt: 0 };
}

function captureSummaryRequest(ctx) {
  const url = String(ctx.request.url || '');
  if (!MATCH.summary.test(url)) return;
  const header = headerValues(ctx.request.headers, 'cookie').join('; ');
  if (!header || /[\r\n]/.test(header)) return;
  const phoneParam = queryParam(url, 'desmobiel');
  const old = readAuth(ctx);
  const phone = PHONE_RE.test(phoneParam) ? phoneParam : old.phone;
  const base = baseFor(ctx, old, phone);
  const cookie = mergeCookies(base.cookie, header, []);
  if (!cookie) return;
  if (cookie === old.cookie && phone === old.phone && !old.authFailedAt) return;
  saveCaptured(ctx, old, { ...base, cookie, phone, capturedAt: Date.now(), authFailedAt: 0 });
}

// 从 App 自动登录的表单（或 JSON）里取字段
function formField(text, name) {
  const json = parseJSON(text);
  if (json && typeof json === 'object') return str(json[name]);
  return queryParam('?' + String(text || '').replace(/^\?/, ''), name);
}

// 表单是 URL 编码的纯 ASCII；有非 ASCII 字节就放弃解析
function asciiText(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] > 0x7e || (bytes[i] < 0x20 && bytes[i] !== 0x0a && bytes[i] !== 0x0d && bytes[i] !== 0x09)) return '';
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

async function captureOnlineRequest(ctx) {
  // 按原始字节读取并原样放回，保证 App 的登录请求一个字节都不变
  let bytes;
  try {
    if (typeof ctx.request.arrayBuffer !== 'function') return undefined;
    bytes = new Uint8Array(await ctx.request.arrayBuffer());
  } catch (e) {
    return undefined;
  }
  try {
    const text = bytes.length <= 65536 ? asciiText(bytes) : '';
    const appId = formField(text, 'appId');
    const token = formField(text, 'token_online');
    const old = readAuth(ctx);
    if (appId && /^[\w.\-+/=]{4,256}$/.test(appId) && (appId !== old.appId || (token && !old.token))) {
      writeAuth(ctx, { ...old, appId, token: old.token || token });
    }
  } catch (e) {}
  return { body: bytes };
}

async function captureOnlineResponse(ctx) {
  const url = String(ctx.request.url || '');
  if (!MATCH.online.test(url)) return undefined;
  let text;
  try {
    text = await ctx.response.text();
  } catch (e) {
    return undefined;
  }
  if (typeof text !== 'string') return undefined;
  try {
    handleOnlineBody(ctx, url, text);
  } catch (e) {}
  // 响应体已被读取，原样交还给 App
  return { body: text };
}

function handleOnlineBody(ctx, url, text) {
  const body = parseJSON(text);
  if (!body || typeof body !== 'object') return;
  if (!ONLINE_OK.includes(str(body.code))) return;
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  const token = str(body.token_online) || str(data.token_online);
  if (!token) return;
  const old = readAuth(ctx);
  const mobile = str(body.desmobile) || str(data.desmobile);
  const phone = PHONE_RE.test(mobile) ? mobile : old.phone;
  const base = baseFor(ctx, old, phone);
  const appId = str(body.appId) || str(data.appId) || queryParam(url, 'appId') || old.appId;
  const cookie = mergeCookies(
    base.cookie,
    headerValues(ctx.request.headers, 'cookie').join('; '),
    headerValues(ctx.response.headers, 'set-cookie'),
  );
  if (!cookie) return;
  if (token === old.token && appId === old.appId && cookie === old.cookie && phone === old.phone && !old.authFailedAt) return;
  saveCaptured(ctx, old, { ...base, token, appId, cookie, phone, capturedAt: Date.now(), authFailedAt: 0 });
}

/* ============================== 查询 ============================== */

async function callApi(ctx, method, url, options) {
  let resp;
  try {
    resp = await ctx.http[method](url, { timeout: HTTP_TIMEOUT, credentials: 'omit', ...options });
  } catch (e) {
    throw fail('NET');
  }
  if (!resp) throw fail('NET');
  if (resp.status === 401 || resp.status === 403) throw fail('AUTH');
  if (resp.status !== 200) throw fail('NET');
  const text = (await readText(resp)).trim();
  // Cookie 无效时联通直接返回裸文本 999999
  if (AUTH_CODES.includes(text)) throw fail('AUTH');
  const body = parseJSON(text);
  if (!body || typeof body !== 'object') throw fail('BAD');
  return { body, resp };
}

function checkCode(body, okCodes) {
  const code = str(body.code);
  if (okCodes.includes(code)) return;
  const desc = str(body.desc) || str(body.dsc) || str(body.message);
  if (AUTH_CODES.includes(code) || /登录|cookie|身份|token/i.test(desc)) throw fail('AUTH');
  throw fail('API');
}

const UNITS = ['元', '分钟', '分', 'MB', 'GB', 'TB', 'KB', 'M', 'G', 'T', '条'];

function cleanTitle(v, fallback) {
  const s = str(v);
  if (!s || s.length > 10 || /[\u0000-\u001f\u007f]/.test(s)) return fallback;
  return s;
}

function pickResource(obj, valueKey, titleKey, title, unit) {
  if (!obj || typeof obj !== 'object') return null;
  const value = str(obj[valueKey]);
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) return null;
  const u = str(obj.newUnit);
  return { title: cleanTitle(obj[titleKey], title), value, unit: UNITS.includes(u) ? u : unit };
}

function parseSummary(body) {
  checkCode(body, ['Y']);
  const out = {
    fee: pickResource(body.feeResource, 'feePersent', 'dynamicFeeTitle', '剩余话费', '元'),
    voice: pickResource(body.voiceResource, 'voicePersent', 'dynamicVoiceTitle', '剩余语音', '分钟'),
    flow: pickResource(body.flowResource, 'flowPersent', 'dynamicFlowTitle', '剩余流量', 'MB'),
  };
  if (!out.fee && !out.voice && !out.flow) throw fail('BAD');
  return out;
}

const SKIP_KEYS = ['usepercent', 'accountbar', 'summary'];
const SKIP_TYPES = ['voice', 'smslist', 'unsharedsmslist', 'unsharedvoicelist'];
const DIRECTED_RE = /免流|定向|畅视/;

function normalizePackage(d, resourceKey, type) {
  if (!d || typeof d !== 'object') return null;
  const policyName = str(d.feePolicyName);
  const itemName = str(d.addUpItemName);
  const itemCode = str(d.addupItemCode);
  let id = str(d.feePolicyId) + (itemCode ? '#' + itemCode : '');
  if (!id) id = policyName || itemName;
  if (!id) return null;
  if (type === 'unsharedflowlist') id += '#unshared';

  let used = d.use;
  const vice = Array.isArray(d.viceCardlist) ? d.viceCardlist : [];
  if (vice.length > 1) {
    const mine = vice.find((c) => c && str(c.currentLoginFlag) === '1');
    if (mine && str(mine.use) !== '') used = mine.use;
  }
  used = nonneg(used);
  const exceed = nonneg(d.xexceedvalue);
  if (used <= 0 && exceed > 0) used = exceed;

  const directed =
    itemCode === '40008' ||
    itemName === '套餐内专享免费流量' ||
    resourceKey === 'mlresources' ||
    DIRECTED_RE.test(policyName) ||
    DIRECTED_RE.test(itemName);

  return {
    id,
    name: (policyName || itemName || '流量包').slice(0, 40),
    directed,
    unlimited: str(d.limited) === '1',
    used,
    remain: nonneg(d.remain),
    total: nonneg(d.total),
    endDate: str(d.endDate) || str(d.endXsbDate),
  };
}

function emptyAgg() {
  return { count: 0, limited: 0, unlimited: 0, used: 0, remain: 0, total: 0 };
}

function parseDetail(body) {
  checkCode(body, DETAIL_OK);
  const packages = [];
  const seen = new Set();
  Object.keys(body).forEach((key) => {
    const lk = key.toLowerCase();
    if (SKIP_KEYS.includes(lk) || !Array.isArray(body[key])) return;
    body[key].forEach((group) => {
      if (!group || typeof group !== 'object' || !Array.isArray(group.details)) return;
      const type = str(group.type).toLowerCase();
      if (SKIP_TYPES.includes(type)) return;
      group.details.forEach((d) => {
        const p = normalizePackage(d, lk, type);
        if (!p || seen.has(p.id)) return;
        seen.add(p.id);
        packages.push(p);
      });
    });
  });

  const general = emptyAgg();
  const directed = emptyAgg();
  packages.forEach((p) => {
    const a = p.directed ? directed : general;
    a.count += 1;
    a.used += p.used;
    if (p.unlimited) a.unlimited += 1;
    else if (p.total > 0) {
      a.limited += 1;
      a.remain += Math.min(p.remain, p.total);
      a.total += p.total;
    }
  });

  // 没有逐包明细时，用接口汇总的已用量兜底
  const summary = body.summary && typeof body.summary === 'object' ? body.summary : {};
  if (!packages.length) {
    const sum = nonneg(summary.sum);
    const free = nonneg(summary.freeFlow);
    if (sum > 0 || free > 0) {
      general.count = 1;
      general.used = Math.max(0, sum - free);
      if (free > 0) {
        directed.count = 1;
        directed.used = free;
      }
    }
  }

  return {
    packageName: str(body.packageName).slice(0, 30),
    general,
    directed,
    packages: packages.slice(0, 30),
  };
}

async function fetchSummary(ctx, auth) {
  const url =
    API.summary +
    '?version=' + SUMMARY_VERSION +
    '&desmobiel=' + encodeURIComponent(auth.phone) +
    '&showType=0';
  const { body } = await callApi(ctx, 'get', url, {
    headers: { 'User-Agent': UA, Cookie: auth.cookie, Accept: 'application/json' },
  });
  return parseSummary(body);
}

async function fetchDetail(ctx, auth) {
  const { body } = await callApi(ctx, 'post', API.detail, {
    headers: { 'User-Agent': UA, Cookie: auth.cookie, Accept: 'application/json' },
  });
  return parseDetail(body);
}

function settle(promise) {
  return promise.then(
    (value) => ({ ok: true, value }),
    (e) => ({ ok: false, error: (e && e.kind) || 'NET' }),
  );
}

async function queryAll(ctx, auth) {
  const [s, d] = await Promise.all([
    auth.phone ? settle(fetchSummary(ctx, auth)) : Promise.resolve({ ok: false, error: 'NOPHONE' }),
    settle(fetchDetail(ctx, auth)),
  ]);
  return { s, d, auth: s.error === 'AUTH' || d.error === 'AUTH' };
}

// 用 token_online 换新 Cookie；返回新凭据，token 无效返回 null，网络失败抛出
async function relogin(ctx, auth) {
  if (!auth.token || !auth.appId) return null;
  const { body, resp } = await callApi(ctx, 'post', API.online, {
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: formEncode({ appId: auth.appId, token_online: auth.token, version: ONLINE_VERSION }),
  }).catch((e) => {
    if (e.kind === 'NET') throw e;
    return { body: null, resp: null };
  });
  if (!body || !ONLINE_OK.includes(str(body.code))) return null;
  // 续登可能轮换 token_online，即使没有下发 Cookie 也要先保存新 token
  const setCookies = resp ? headerValues(resp.headers, 'set-cookie') : [];
  const latest = readAuth(ctx);
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  const next = {
    ...latest,
    cookie: mergeCookies(latest.cookie || auth.cookie, '', setCookies),
    token: str(body.token_online) || str(data.token_online) || latest.token || auth.token,
    authFailedAt: 0,
    reloginAt: Date.now(),
  };
  writeAuth(ctx, next);
  return setCookies.length ? readAuth(ctx) : null;
}

async function loadData(ctx) {
  const now = Date.now();
  let auth = readAuth(ctx);
  const cached = store.getJSON(ctx, 'cache');
  const cache = cached && (!auth.phone || !cached.phone || cached.phone === auth.phone) ? cached : null;

  if (!auth.cookie) return { state: 'setup', data: null, auth };
  if (auth.authFailedAt && now - auth.authFailedAt < AUTH_RETRY_MS) return { state: 'auth', data: cache, auth };
  if (cache && cache.complete && now - num(cache.updatedAt) < FRESH_MS && now >= num(cache.updatedAt)) {
    return { state: 'ok', data: cache, auth };
  }

  let result = await queryAll(ctx, auth);
  let netDuringRelogin = false;
  if (result.auth) {
    let fresh = null;
    // 另一个小组件实例可能刚刚续登过
    const latest = readAuth(ctx);
    if (latest.cookie && latest.cookie !== auth.cookie) fresh = latest;
    else if (!auth.reloginAt || Date.now() - auth.reloginAt >= RELOGIN_GAP_MS || Date.now() < auth.reloginAt) {
      try {
        fresh = await relogin(ctx, auth);
      } catch (e) {
        netDuringRelogin = true;
      }
    }
    if (fresh) {
      auth = fresh;
      result = await queryAll(ctx, auth);
    }
  }
  // 两个接口都没查到、且有接口明确报登录失效，才算登录失效；只有一个接口失效按部分失败处理
  const authFailed = result.auth && !netDuringRelogin && !result.s.ok && !result.d.ok;
  if (authFailed) {
    const latest = readAuth(ctx);
    if (latest.cookie === auth.cookie) writeAuth(ctx, { ...latest, authFailedAt: Date.now() });
  }

  const prev = cache || {};
  const t = Date.now();
  const data = {
    phone: auth.phone || str(prev.phone),
    summary: result.s.ok ? result.s.value : prev.summary || null,
    summaryAt: result.s.ok ? t : num(prev.summaryAt),
    detail: result.d.ok ? result.d.value : prev.detail || null,
    detailAt: result.d.ok ? t : num(prev.detailAt),
    updatedAt: result.s.ok || result.d.ok ? t : num(prev.updatedAt),
    complete: result.s.ok && result.d.ok,
  };
  if (result.s.ok || result.d.ok) store.setJSON(ctx, 'cache', data);

  const hasData = !!(data.summary || data.detail);
  let state;
  if (authFailed) state = 'auth';
  else if (result.s.ok && result.d.ok) state = 'ok';
  else if (result.d.ok && result.s.error === 'NOPHONE') state = 'nophone';
  else if (result.s.ok || result.d.ok) state = 'partial';
  else state = hasData ? 'stale' : 'error';
  return { state, data: hasData ? data : null, auth, failed: { summary: !result.s.ok && result.s.error !== 'NOPHONE', detail: !result.d.ok } };
}

/* ============================== 展示数据 ============================== */

function trimNum(n, digits) {
  return String(Number(n.toFixed(digits)));
}

function fmtFlow(mb) {
  const n = nonneg(mb);
  if (n < 1024) return { v: trimNum(n, n < 10 ? 2 : n < 100 ? 1 : 0), u: 'MB' };
  const g = n / 1024;
  if (g < 1024) return { v: trimNum(g, g < 10 ? 2 : g < 100 ? 1 : 0), u: 'GB' };
  const t = g / 1024;
  return { v: trimNum(t, t < 10 ? 2 : 1), u: 'TB' };
}

const flowText = (f) => (f ? f.v + f.u : '--');

function groupView(agg) {
  if (!agg || !agg.count) return null;
  const used = fmtFlow(agg.used);
  if (!agg.limited) {
    return { kind: agg.unlimited ? 'unlimited' : 'usedOnly', used, remain: null, total: null, ratio: null, withUnlimited: false };
  }
  return {
    kind: 'limited',
    used,
    remain: fmtFlow(agg.remain),
    total: fmtFlow(agg.total),
    ratio: agg.total > 0 ? Math.max(0, Math.min(1, agg.remain / agg.total)) : null,
    withUnlimited: agg.unlimited > 0,
  };
}

function packageLine(p) {
  if (p.unlimited) return '已用 ' + flowText(fmtFlow(p.used)) + ' · 不限';
  if (p.total > 0) return '剩 ' + flowText(fmtFlow(Math.min(p.remain, p.total))) + ' / ' + flowText(fmtFlow(p.total));
  return '已用 ' + flowText(fmtFlow(p.used));
}

function safeTitle(v) {
  const s = str(v);
  if (!s || /[\u0000-\u001f\u007f]/.test(s)) return '';
  return Array.from(s).slice(0, 12).join('');
}

function lowFeeThreshold(v) {
  const s = str(v);
  if (!/^\d+(?:\.\d+)?$/.test(s)) return 10;
  return Number(s);
}

function buildView(ctx, loaded) {
  const env = (ctx && ctx.env) || {};
  const now = Date.now();
  const data = loaded.data || {};
  const summary = data.summary || {};
  const detail = data.detail || null;
  const threshold = lowFeeThreshold(env.LOW_FEE);
  const fee = summary.fee || null;
  const phone = loaded.auth && loaded.auth.phone ? loaded.auth.phone : str(data.phone);

  const view = {
    title: safeTitle(env.TITLE) || '中国联通',
    suffix: isTrue(env.SHOW_PHONE_SUFFIX) && PHONE_RE.test(phone) ? '尾号' + phone.slice(-4) : '',
    time: beijingTime(num(data.updatedAt), now),
    tone: 'normal',
    message: '',
    fee,
    feeLow: !!(fee && threshold > 0 && fee.unit === '元' && Number(fee.value) < threshold),
    voice: summary.voice || null,
    flow: summary.flow || null,
    hasDetail: !!detail,
    general: detail ? groupView(detail.general) : null,
    directed: detail ? groupView(detail.directed) : null,
    packages: detail && Array.isArray(detail.packages) ? detail.packages : [],
    packageName: detail ? str(detail.packageName) : '',
  };

  // message 给大号底部整行显示；badge 给小号/中号放在标题右侧（替代时间），避免多占一行
  view.badge = '';
  if (loaded.state === 'auth') {
    view.tone = 'danger';
    view.message = '登录已失效，请打开联通 App 刷新';
    view.badge = '需重新登录';
  } else if (loaded.state === 'stale') {
    view.tone = 'warn';
    view.message = '查询失败，显示 ' + view.time + ' 的数据';
  } else if (loaded.state === 'partial') {
    const which = loaded.failed && loaded.failed.detail ? '流量明细' : '话费语音';
    const at = which === '流量明细' ? num(data.detailAt) : num(data.summaryAt);
    view.tone = 'warn';
    view.message = which + '查询失败' + (at ? '，显示 ' + beijingTime(at, now) + ' 的数据' : '');
  } else if (loaded.state === 'nophone' && !view.fee) {
    view.message = '在联通 App 首页查一次余额以显示话费';
    view.badge = '去 App 查余额';
  }
  return view;
}

/* ============================== 渲染 ============================== */

const C = {
  bg: { light: '#FFFFFF', dark: '#1C1C1E' },
  card: { light: '#F2F2F7', dark: '#2C2C2E' },
  text: { light: '#1C1C1E', dark: '#FFFFFF' },
  sub: { light: '#6E6E73', dark: '#AEAEB2' },
  faint: { light: '#8E8E93', dark: '#8E8E93' },
  track: { light: '#E5E5EA', dark: '#3A3A3C' },
  brand: { light: '#E60012', dark: '#FF453A' },
  general: { light: '#007AFF', dark: '#0A84FF' },
  directed: { light: '#34C759', dark: '#30D158' },
  warn: { light: '#FF9500', dark: '#FF9F0A' },
  danger: { light: '#FF3B30', dark: '#FF453A' },
};

const GROUPS = [
  { key: 'general', label: '通用', color: C.general },
  { key: 'directed', label: '定向', color: C.directed },
];

function T(text, size, color, weight, extra) {
  return {
    type: 'text',
    text: String(text),
    font: { size, weight: weight || 'regular' },
    textColor: color || C.text,
    maxLines: 1,
    minScale: 0.6,
    ...(extra || {}),
  };
}

function row(children, gap, extra) {
  return { type: 'stack', direction: 'row', alignItems: 'center', gap: gap || 0, children, ...(extra || {}) };
}

function col(children, gap, extra) {
  return { type: 'stack', direction: 'column', alignItems: 'start', gap: gap || 0, children, ...(extra || {}) };
}

function spacer(length) {
  return length === undefined ? { type: 'spacer' } : { type: 'spacer', length };
}

function icon(name, size, color) {
  return { type: 'image', src: 'sf-symbol:' + name, width: size, height: size, color };
}

function alpha(color, aa) {
  return { light: color.light + aa, dark: color.dark + aa };
}

function ratioColor(ratio, base) {
  if (ratio === null) return base;
  if (ratio < 0.1) return C.danger;
  if (ratio < 0.2) return C.warn;
  return base;
}

// 剩余比例条：有总量时按剩余/总量填充；纯不限量画满一条浅色
function bar(g, color, h) {
  const r = g.kind === 'limited' && g.ratio !== null ? Math.round(g.ratio * 1000) : g.kind === 'unlimited' ? 1000 : 0;
  const fillColor = g.kind === 'unlimited' ? alpha(color, '59') : ratioColor(g.ratio, color);
  const children =
    r <= 0
      ? [spacer()]
      : [
          { type: 'stack', flex: r, height: h, borderRadius: h / 2, backgroundColor: fillColor, children: [] },
          ...(r < 1000 ? [{ type: 'spacer', flex: 1000 - r }] : []),
        ];
  return { type: 'stack', direction: 'row', height: h, borderRadius: h / 2, backgroundColor: C.track, children };
}

function toneColor(tone) {
  return tone === 'danger' ? C.danger : tone === 'warn' ? C.warn : C.faint;
}

// 右侧：更新时间；查询失败时时间前加警示图标（表示是旧数据），紧凑尺寸用 badge 替换时间
function header(view, s, compact) {
  const badge = compact ? view.badge : '';
  const color = view.tone === 'normal' ? (badge ? C.sub : C.faint) : toneColor(view.tone);
  const showSuffix = view.suffix && !(compact && badge && s.narrow);
  return row(
    [
      icon('simcard.fill', s.icon, C.brand),
      T(view.title, s.title, C.text, 'semibold'),
      ...(showSuffix ? [T(view.suffix, s.time, C.sub, 'medium', { minScale: 0.8 })] : []),
      spacer(),
      ...(view.tone === 'normal' ? [] : [icon('exclamationmark.triangle.fill', s.time, color)]),
      T(badge || view.time, s.time, color, view.tone === 'normal' ? 'regular' : 'medium', { minScale: 0.8 }),
    ],
    4,
  );
}

function footer(view, size) {
  if (!view.message) return [];
  return [T(view.message, size, view.tone === 'normal' ? C.sub : toneColor(view.tone), 'medium', { minScale: 0.6 })];
}

function feeValueColor(view) {
  return view.feeLow ? C.danger : C.text;
}

function valueUnit(value, unit, size, color, unitSize) {
  return row([T(value, size, color, 'semibold'), T(unit, unitSize, C.sub, 'medium', { minScale: 1 })], 2, { alignItems: 'end' });
}

function groupMain(g) {
  if (g.kind === 'limited') return g.remain;
  if (g.kind === 'unlimited') return { v: '不限量', u: '' };
  return g.used;
}

function groupMainLabel(g) {
  return g.kind === 'limited' ? '剩' : g.kind === 'unlimited' ? '' : '已用';
}

// 中号/大号的流量分组：标题+剩余、比例条、已用/总量
function groupBlock(def, g, s) {
  const main = groupMain(g);
  const left = g.kind === 'limited' ? '已用 ' + flowText(g.used) : g.kind === 'unlimited' ? '已用 ' + flowText(g.used) : '无总量信息';
  const right = g.kind === 'limited' ? '共 ' + flowText(g.total) + (g.withUnlimited ? ' · 含不限' : '') : g.kind === 'unlimited' ? '不限量' : '';
  return col(
    [
      row(
        [
          T(def.label, s.label, def.color, 'semibold', { minScale: 1 }),
          spacer(),
          ...(groupMainLabel(g) ? [T(groupMainLabel(g), s.small, C.sub, 'medium', { minScale: 1 })] : []),
          T(main.v, s.value, C.text, 'semibold'),
          ...(main.u ? [T(main.u, s.small, C.sub, 'medium', { minScale: 1 })] : []),
        ],
        3,
        { alignItems: 'end' },
      ),
      bar(g, def.color, s.bar),
      row([T(left, s.small, C.faint), spacer(), T(right, s.small, C.faint)], 4),
    ],
    s.groupGap,
  );
}

// 小号的流量行：标题、剩余/总量、比例条
function groupCompact(def, g, s) {
  let text;
  if (g.kind === 'limited') text = flowText(g.remain) + ' / ' + flowText(g.total);
  else if (g.kind === 'unlimited') text = '不限 · 已用 ' + flowText(g.used);
  else text = '已用 ' + flowText(g.used);
  return col(
    [
      row([T(def.label, s.small, def.color, 'semibold', { minScale: 1 }), spacer(), T(text, s.small, C.text, 'medium')], 4),
      bar(g, def.color, 4),
    ],
    3,
  );
}

function presentGroups(view) {
  return GROUPS.map((def) => ({ def, g: view[def.key] })).filter((x) => x.g);
}

function summaryFlowRow(view, s) {
  if (!view.flow) return [];
  return [row([T(view.flow.title, s.small, C.sub), spacer(), T(view.flow.value + view.flow.unit, s.small, C.text, 'semibold')], 4)];
}

function rootWidget(children, extra) {
  return {
    type: 'widget',
    backgroundColor: C.bg,
    padding: [12, 14, 12, 14],
    gap: 6,
    refreshAfter: new Date(Date.now() + REFRESH_MS).toISOString(),
    children,
    ...(extra || {}),
  };
}

function buildSmall(view) {
  const s = { icon: 13, title: 13, time: 10, small: 11, narrow: true };
  const fee = view.fee
    ? col([T(view.fee.title, 10, C.sub, 'medium'), valueUnit(view.fee.value, view.fee.unit, 22, feeValueColor(view), 11)], 0)
    : col([T('话费', 10, C.sub, 'medium'), T('--', 22, C.faint, 'semibold')], 0);
  const voice = view.voice
    ? [spacer(), col([T('语音', 10, C.sub, 'medium'), T(view.voice.value + (view.voice.unit === '分钟' ? '分' : view.voice.unit), 13, C.text, 'semibold')], 0, { alignItems: 'end' })]
    : [];
  const groups = presentGroups(view);
  const flows = groups.length ? groups.map(({ def, g }) => groupCompact(def, g, s)) : summaryFlowRow(view, s);
  return rootWidget([header(view, s, true), row([fee, ...voice], 4, { alignItems: 'end' }), spacer(), ...flows], {
    padding: [11, 13, 11, 13],
    gap: 4,
  });
}

function buildMedium(view) {
  const s = { icon: 14, title: 14, time: 11, label: 12, value: 15, small: 10, bar: 5, groupGap: 3 };
  const left = col(
    [
      T(view.fee ? view.fee.title : '话费', 11, C.sub, 'medium'),
      view.fee ? valueUnit(view.fee.value, view.fee.unit, 28, feeValueColor(view), 12) : T('--', 28, C.faint, 'semibold'),
      spacer(2),
      ...(view.voice ? [row([T(view.voice.title, 11, C.sub), spacer(), T(view.voice.value + view.voice.unit, 11, C.text, 'semibold')], 4)] : []),
      ...summaryFlowRow(view, { small: 11 }),
    ],
    2,
    { flex: 4 },
  );
  const groups = presentGroups(view);
  const right = col(
    groups.length
      ? groups.map(({ def, g }) => groupBlock(def, g, s))
      : [T(view.hasDetail ? '没有流量包' : '流量明细暂不可用', 11, C.sub)],
    6,
    { flex: 6 },
  );
  return rootWidget([header(view, s, true), row([left, right], 14, { alignItems: 'start' }), spacer()], {
    padding: [11, 14, 11, 14],
  });
}

function capsule(item, fallbackTitle, valueColor) {
  return col(
    [
      T(item ? item.title : fallbackTitle, 10, C.sub, 'medium'),
      item ? valueUnit(item.value, item.unit, 18, valueColor || C.text, 10) : T('--', 18, C.faint, 'semibold'),
    ],
    2,
    { flex: 1, padding: [8, 10, 8, 10], backgroundColor: C.card, borderRadius: 12 },
  );
}

function buildLarge(view) {
  const s = { icon: 16, title: 16, time: 12, label: 13, value: 17, small: 11, bar: 6, groupGap: 4 };
  const groups = presentGroups(view);
  // 按小屏 iPhone 大号约 324pt 高度保守估算：少一个分组或没有套餐名/提示行，就多列几个流量包
  const maxRows = (view.message ? 2 : 3) + (groups.length < 2 ? 2 : 0) + (view.packageName ? 0 : 1);
  const pkgs = view.packages.slice(0, maxRows);
  const more = view.packages.length - pkgs.length;
  const list = pkgs.length
    ? [
        col(
          [
            row([T('流量包', 11, C.sub, 'medium'), spacer(), ...(more > 0 ? [T('另有 ' + more + ' 项', 10, C.faint)] : [])], 4),
            ...pkgs.map((p) =>
              row(
                [
                  { type: 'stack', width: 6, height: 6, borderRadius: 3, backgroundColor: p.directed ? C.directed : C.general, children: [] },
                  T(p.name, 11, C.text, 'regular', { flex: 1, minScale: 0.7 }),
                  T(packageLine(p), 11, C.sub, 'medium', { minScale: 0.7 }),
                ],
                6,
              ),
            ),
          ],
          4,
        ),
      ]
    : [];
  return rootWidget(
    [
      header(view, s),
      ...(view.packageName ? [T(view.packageName, 11, C.sub)] : []),
      row([capsule(view.fee, '话费', feeValueColor(view)), capsule(view.voice, '语音'), capsule(view.flow, '流量')], 8, { alignItems: 'start' }),
      ...(groups.length ? groups.map(({ def, g }) => groupBlock(def, g, s)) : [T(view.hasDetail ? '没有流量包' : '流量明细暂不可用', 11, C.sub)]),
      spacer(),
      ...list,
      ...footer(view, 11),
    ],
    { padding: [14, 16, 14, 16], gap: 7 },
  );
}

function lockRoot(children, family) {
  return {
    type: 'widget',
    padding: family === 'accessoryInline' ? 0 : 2,
    gap: 1,
    refreshAfter: new Date(Date.now() + REFRESH_MS).toISOString(),
    children,
  };
}

function shortFee(view) {
  return view.fee ? '话费 ' + view.fee.value + view.fee.unit : '';
}

function shortGroup(label, g) {
  if (!g) return '';
  if (g.kind === 'limited') return label + '剩 ' + flowText(g.remain);
  if (g.kind === 'unlimited') return label + '不限';
  return label + '已用 ' + flowText(g.used);
}

function buildLock(view, family) {
  if (family === 'accessoryInline') {
    const parts = view.tone === 'danger' ? ['联通需重新登录'] : [shortFee(view), shortGroup('通用', view.general) || (view.flow ? view.flow.title + ' ' + view.flow.value + view.flow.unit : '')];
    return lockRoot([T(parts.filter(Boolean).join(' · ') || view.title, 12, C.text, 'medium', { minScale: 0.5 })], family);
  }
  if (family === 'accessoryCircular') {
    const g = view.general;
    let label = '话费';
    let main = view.fee ? { v: view.fee.value, u: view.fee.unit } : { v: '--', u: '' };
    if (g && g.kind === 'limited') {
      label = '通用';
      main = g.remain;
    }
    return lockRoot(
      [
        spacer(),
        row([spacer(), T(label, 9, C.sub, 'medium'), spacer()]),
        row([spacer(), T(main.v, 15, C.text, 'bold', { minScale: 0.5 }), spacer()]),
        ...(main.u ? [row([spacer(), T(main.u, 9, C.sub, 'medium'), spacer()])] : []),
        spacer(),
      ],
      family,
    );
  }
  const line2 = [view.fee ? view.fee.value + view.fee.unit : '', view.voice ? '语音 ' + view.voice.value + view.voice.unit : ''].filter(Boolean).join(' · ');
  const line3 = [shortGroup('通用', view.general), shortGroup('定向', view.directed)].filter(Boolean).join(' · ') ||
    (view.flow ? view.flow.title + ' ' + view.flow.value + view.flow.unit : '');
  return lockRoot(
    [
      row([icon('simcard.fill', 11, C.text), T(view.title, 12, C.text, 'semibold'), spacer(), T(view.tone === 'danger' ? '需登录' : view.time, 10, C.sub)], 3),
      T(line2 || '话费 --', 12, C.text, 'medium'),
      T(view.tone === 'danger' ? '登录失效，请打开联通 App' : line3 || '流量 --', 11, C.sub, 'medium'),
    ],
    family,
  );
}

function messageWidget(ctx, message, tone, family) {
  const fam = family || (ctx && ctx.widgetFamily) || 'systemMedium';
  const title = safeTitle(ctx && ctx.env && ctx.env.TITLE) || '中国联通';
  const color = tone === 'danger' ? C.danger : C.sub;
  if (fam.startsWith('accessory')) {
    return lockRoot([T(fam === 'accessoryCircular' ? '联通' : title + ' · ' + message, 11, C.text, 'medium', { maxLines: 2, minScale: 0.5 })], fam);
  }
  return rootWidget([
    row([icon('simcard.fill', 14, C.brand), T(title, 14, C.text, 'semibold')], 4),
    spacer(),
    T(message, 12, color, 'medium', { maxLines: 3, minScale: 0.7 }),
    spacer(),
  ]);
}

function setupWidget(ctx, family) {
  const fam = family || 'systemMedium';
  if (fam.startsWith('accessory')) return messageWidget(ctx, '打开联通 App 获取登录信息', 'normal', fam);
  const small = fam === 'systemSmall';
  const title = safeTitle(ctx && ctx.env && ctx.env.TITLE) || '中国联通';
  return rootWidget([
    row([icon('simcard.fill', 14, C.brand), T(title, 14, C.text, 'semibold')], 4),
    spacer(),
    T('还没有登录信息', small ? 13 : 15, C.text, 'semibold'),
    T(small ? '打开联通 App 首页，等通知提示已获取' : '打开联通 App 首页查一次余额，收到「已获取登录信息」通知即可', 11, C.sub, 'regular', { maxLines: 3, minScale: 0.7 }),
    T('需开启 MITM 并信任证书', 10, C.faint, 'regular', { maxLines: 2 }),
    spacer(),
  ]);
}

async function renderWidget(ctx) {
  const family = (ctx && ctx.widgetFamily) || 'systemMedium';
  const loaded = await loadData(ctx);
  if (loaded.state === 'setup') return setupWidget(ctx, family);
  if (!loaded.data) {
    return messageWidget(ctx, loaded.state === 'auth' ? '登录已失效，请打开联通 App 刷新' : '查询失败，请稍后重试', loaded.state === 'auth' ? 'danger' : 'normal', family);
  }
  const view = buildView(ctx, loaded);
  if (family.startsWith('accessory')) return buildLock(view, family);
  if (family === 'systemSmall') return buildSmall(view);
  if (family === 'systemLarge' || family === 'systemExtraLarge') return buildLarge(view);
  return buildMedium(view);
}
