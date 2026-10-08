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
  const updatedAt = num(data.updatedAt);
  view.timeShort = view.time.length > 5 && updatedAt ? view.time.slice(0, 5) : view.time;
  view.badge = '';
  view.badgeShort = '';
  if (loaded.state === 'auth') {
    view.tone = 'danger';
    view.message = '登录已失效，请打开联通 App 刷新';
    view.badge = '需重新登录';
    view.badgeShort = '需登录';
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
    view.badgeShort = '查余额';
  }
  return view;
}

/* ============================== 渲染 ============================== */
// 圆环 + 文字：不用矩形背景。流量用圆形进度条表示剩余比例，话费和语音只用文字。
// 颜色：话费红、通用蓝、定向紫、语音橙，只用在圆环、名称和标题前的红色竖条上，数字用正文色。
// 圆环是内联 SVG 背景图，SVG 里只能用一种颜色，所以圆环颜色选深浅背景上都清楚的中间色。

const C = {
  bg: { light: '#FFFFFF', dark: '#1C1C1E' },
  text: { light: '#1D1D1F', dark: '#FFFFFF' },
  secondary: { light: '#6E6E73', dark: '#AEAEB2' },
  tertiary: { light: '#8E8E93', dark: '#8E8E93' },
  brand: { light: '#E60012', dark: '#FF4D57' },
  warn: { light: '#FF9500', dark: '#FF9F0A' },
  danger: { light: '#FF3B30', dark: '#FF453A' },
};

// tint：文字颜色（深浅各一）；ring：圆环颜色（SVG 用，rgb 三元组）
const THEME = {
  fee: { tint: { light: '#E60012', dark: '#FF5A62' }, ring: '240,40,52', symbol: 'yensign.circle.fill' },
  general: { tint: { light: '#1677FF', dark: '#4D9CFF' }, ring: '47,128,255', symbol: 'antenna.radiowaves.left.and.right' },
  directed: { tint: { light: '#7B4DFF', dark: '#A98EFF' }, ring: '138,99,255', symbol: 'square.grid.2x2.fill' },
  voice: { tint: { light: '#F07800', dark: '#FFA040' }, ring: '255,138,26', symbol: 'phone.fill' },
};

const RING_WARN = '255,149,0';
const RING_DANGER = '255,59,48';

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

function toneColor(tone) {
  return tone === 'danger' ? C.danger : tone === 'warn' ? C.warn : C.tertiary;
}

// Egern 实机排版：一行里只要有带 flex 的子元素，这一行就会吃掉父容器剩下的全部高度，
// 内容贴着顶部，弹性 spacer 分不到空间。所以这类行都指定 height。
// 高度按 iPhone 实测行高估算：含中文的系统字体一行约 1.22 倍字号。
const LINE = 1.22;

function lineH(size) {
  return size * LINE;
}

function unitLift(size, unitSize) {
  return Math.max(0, Math.round((size - unitSize) * 0.2));
}

function amountH(size, unitSize) {
  return Math.max(lineH(size), lineH(unitSize) + unitLift(size, unitSize));
}

// 数字 + 单位：底部对齐，单位按字号差补偿下沉，看起来落在同一基线上
function amount(value, unit, size, color, unitSize) {
  const children = [T(value, size, color || C.text, 'semibold', { minScale: 0.5 })];
  if (unit) {
    const lift = unitLift(size, unitSize);
    children.push({ type: 'stack', padding: [0, 0, lift, 0], children: [T(unit, unitSize, C.secondary, 'regular', { minScale: 0.8 })] });
  }
  return row(children, Math.max(2, Math.round(size / 8)), { alignItems: 'end' });
}

// 固定高度的一行文字；没有内容时也占位，几列的数字和说明才能对齐
function textLine(text, size, color, weight) {
  const h = Math.ceil(lineH(size));
  return text ? row([T(text, size, color, weight || 'regular', { minScale: 0.7 })], 0, { height: h }) : { type: 'stack', height: h, children: [] };
}

function feeColor(view) {
  return view.feeLow ? C.danger : C.text;
}

/* ---------- 圆环 ---------- */

function ringRGB(ratio, base) {
  if (ratio === null || ratio === undefined) return base;
  if (ratio < 0.1) return RING_DANGER;
  if (ratio < 0.2) return RING_WARN;
  return base;
}

// 圆形进度条（SVG）：浅色底环 + 从 12 点钟方向顺时针的剩余弧；没有比例时只画底环
function ringSvg(ratio, rgb) {
  const R = 42;
  const W = 9;
  const track = "<circle cx='50' cy='50' r='" + R + "' fill='none' stroke='rgba(" + rgb + ",0.2)' stroke-width='" + W + "'/>";
  let arc = '';
  if (ratio !== null && ratio !== undefined && ratio > 0) {
    const r = Math.min(1, ratio);
    const color = 'rgb(' + ringRGB(ratio, rgb) + ')';
    arc =
      r >= 0.999
        ? "<circle cx='50' cy='50' r='" + R + "' fill='none' stroke='" + color + "' stroke-width='" + W + "'/>"
        : "<circle cx='50' cy='50' r='" + R + "' fill='none' stroke='" + color + "' stroke-width='" + W + "' stroke-linecap='round' " +
          "stroke-dasharray='" + (2 * Math.PI * R * r).toFixed(2) + " 400' transform='rotate(-90 50 50)'/>";
  }
  return "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>" + track + arc + '</svg>';
}

function pctText(ratio) {
  const p = Math.round(ratio * 100);
  if (ratio > 0 && p < 1) return '<1%';
  if (ratio < 1 && p > 99) return '99%';
  return p + '%';
}

// 圆环里：有比例时显示图标和剩余百分比；没有比例时只显示图标
function ring(c, size, iconSize, pctSize) {
  const p = THEME[c.key];
  const inner =
    c.ratio !== null && c.ratio !== undefined
      ? [
          ...(iconSize ? [icon(p.symbol, iconSize, p.tint)] : []),
          T(pctText(c.ratio), pctSize, C.text, 'semibold', { minScale: 0.6 }),
        ]
      : [icon(p.symbol, iconSize || Math.round(size * 0.36), p.tint)];
  return {
    type: 'stack',
    direction: 'column',
    alignItems: 'center',
    width: size,
    height: size,
    gap: 1,
    backgroundImage: ringSvg(c.ratio, p.ring),
    children: [spacer(), ...inner, spacer()],
  };
}

/* ---------- 内容挑选：各尺寸共用 ---------- */

function feeItem(view) {
  if (!view.fee) return { key: 'fee', short: '话费', label: '话费', value: { v: '--', u: '' }, valueColor: C.tertiary, ratio: null, sub: '', side: '' };
  return { key: 'fee', short: '话费', label: view.fee.title, value: { v: view.fee.value, u: view.fee.unit }, valueColor: feeColor(view), ratio: null, sub: '', side: '' };
}

function voiceItem(view) {
  if (!view.voice) return null;
  return { key: 'voice', short: '语音', label: view.voice.title, value: { v: view.voice.value, u: view.voice.unit }, ratio: null, sub: '', side: '', total: '' };
}

function flowItem(key, g) {
  const name = key === 'general' ? '通用' : '定向';
  if (g.kind === 'limited') {
    return {
      key,
      short: name,
      label: name + '剩余',
      value: g.remain,
      ratio: g.ratio,
      sub: '已用 ' + flowText(g.used),
      side: '共 ' + flowText(g.total) + (g.withUnlimited ? ' · 含不限' : ''),
      total: '共 ' + flowText(g.total),
    };
  }
  const note = g.kind === 'unlimited' ? '不限量' : '未提供总量';
  return { key, short: name, label: name + '已用', value: g.used, ratio: null, sub: note, side: '', total: note };
}

// 流量：有明细时分通用/定向；没有明细时用首页的流量总数
function flowItems(view) {
  const list = ['general', 'directed'].filter((k) => view[k]).map((k) => flowItem(k, view[k]));
  if (list.length || !view.flow) return list;
  return [{ key: 'general', short: '流量', label: view.flow.title, value: { v: view.flow.value, u: view.flow.unit }, ratio: null, sub: '', side: '', total: '' }];
}

// 话费列右边的几列：流量，不满两列时用语音补；语音没单独成列就写在话费下面
function sideItems(view, fee, max) {
  const list = flowItems(view);
  const voice = voiceItem(view);
  if (voice) {
    if (list.length < max) list.push(voice);
    else if (view.fee) fee.sub = '语音 ' + view.voice.value + ' ' + view.voice.unit;
  }
  return list.slice(0, max);
}

// 锁屏的主数字：优先通用剩余
function heroFor(view) {
  const g = view.general;
  if (g && g.kind === 'limited') return { label: '通用剩余', short: '通用', value: g.remain, side: '共 ' + flowText(g.total), ratio: g.ratio, key: 'general' };
  if (g) return { label: '通用已用', short: '通用', value: g.used, side: g.kind === 'unlimited' ? '不限量' : '', ratio: null, key: 'general' };
  if (view.flow) return { label: view.flow.title, short: '流量', value: { v: view.flow.value, u: view.flow.unit }, side: '', ratio: null, key: 'flow' };
  if (view.fee) return { label: view.fee.title, short: '话费', value: { v: view.fee.value, u: view.fee.unit }, valueColor: feeColor(view), side: '', ratio: null, key: 'fee' };
  const d = view.directed;
  if (d) return { label: d.kind === 'limited' ? '定向剩余' : '定向已用', short: '定向', value: d.kind === 'limited' ? d.remain : d.used, side: d.kind === 'limited' ? '共 ' + flowText(d.total) : '', ratio: d.kind === 'limited' ? d.ratio : null, key: 'directed' };
  return null;
}

// 锁屏主数字以外，再挑最多 n 项：话费、定向、语音、流量总数
function extrasFor(view, hero, n) {
  const out = [];
  if (view.fee && hero.key !== 'fee') out.push({ label: '话费', value: { v: view.fee.value, u: view.fee.unit }, valueColor: feeColor(view) });
  const d = view.directed;
  if (d && hero.key !== 'directed') {
    if (d.kind === 'limited') out.push({ label: '定向剩余', value: d.remain });
    else if (d.kind === 'unlimited') out.push({ label: '定向', value: { v: '不限量', u: '' } });
    else out.push({ label: '定向已用', value: d.used });
  }
  if (view.voice) out.push({ label: '语音', value: { v: view.voice.value, u: view.voice.unit } });
  if (view.flow && hero.key !== 'flow' && !view.general) out.push({ label: '流量', value: { v: view.flow.value, u: view.flow.unit } });
  return out.slice(0, n);
}

/* ---------- 公共部件 ---------- */

function brandBar(size) {
  return { type: 'stack', width: 3, height: Math.round(size * 0.92), borderRadius: 1.5, backgroundColor: C.brand, children: [] };
}

// 状态文字：正常是更新时间；查询失败时前面加警示图标；紧凑尺寸有 badge 时用 badge 代替时间
function statusParts(view, size, badge, time) {
  const status = view.tone === 'normal' ? C.tertiary : toneColor(view.tone);
  return [
    ...(view.tone === 'normal' ? [] : [icon('exclamationmark.triangle.fill', size - 1, status)]),
    T(badge || time, size, badge && view.tone === 'normal' ? C.secondary : status, 'regular', { minScale: 0.8 }),
  ];
}

// 小号的标题栏：红色竖条 + 标题 + 时间
function header(view, size) {
  return row([brandBar(size), T(view.title, size, C.text, 'semibold', { minScale: 0.8 }), spacer(), ...statusParts(view, size - 1, view.badgeShort, view.timeShort)], 5, {
    height: Math.ceil(lineH(size)),
  });
}

// 中号/大号的第一列：上面是标题和时间，下面是话费；数字和说明的位置与右边几列对齐
function feeColumn(view, fee, s, compact, height) {
  const badge = compact ? view.badge : '';
  const time = view.suffix && !badge ? view.suffix + ' · ' + view.time : view.time;
  return col(
    [
      row([brandBar(s.title), T(view.title, s.title, C.text, 'semibold', { minScale: 0.7 })], 5, { height: Math.ceil(lineH(s.title)) }),
      row(statusParts(view, s.time, badge, time), 3, { height: Math.ceil(lineH(s.time)) }),
      spacer(),
      amount(fee.value.v, fee.value.u, s.value, fee.valueColor, s.unit),
      textLine(fee.label, s.label, THEME.fee.tint, 'semibold'),
      textLine(fee.sub, s.caption, C.secondary),
      textLine(fee.side, s.caption, C.tertiary),
    ],
    0,
    { flex: 1, height },
  );
}

// 流量/语音列：圆环在上，下面是剩余、名称、已用、总量
function ringColumn(c, s, height) {
  return col(
    [
      ring(c, s.ring, s.ringIcon, s.ringPct),
      spacer(),
      amount(c.value.v, c.value.u, s.value, c.valueColor || C.text, s.unit),
      textLine(c.label, s.label, THEME[c.key].tint, 'semibold'),
      textLine(c.sub, s.caption, C.secondary),
      textLine(c.side, s.caption, C.tertiary),
    ],
    0,
    { flex: 1, height },
  );
}

// 列的高度：圆环、间距、数字、名称、两行说明，再留 2pt 余量
function columnsHeight(s) {
  return Math.ceil(s.ring + s.ringGap + amountH(s.value, s.unit) + lineH(s.label) + lineH(s.caption) * 2) + 2;
}

function columns(view, s, compact) {
  const fee = feeItem(view);
  const items = sideItems(view, fee, 2);
  const height = columnsHeight(s);
  return row([feeColumn(view, fee, s, compact, height), ...items.map((c) => ringColumn(c, s, height))], s.gap, { alignItems: 'start', height });
}

function rootWidget(children, extra) {
  return {
    type: 'widget',
    backgroundColor: C.bg,
    padding: 14,
    gap: 0,
    refreshAfter: new Date(Date.now() + REFRESH_MS).toISOString(),
    children,
    ...(extra || {}),
  };
}

function hasContent(view) {
  return !!(view.fee || view.voice || flowItems(view).length);
}

/* ---------- 主屏幕 ---------- */

// 小号：标题栏、话费，下面两行「圆环 + 剩余」
const SMALL = { title: 12, ring: 32, pct: 9, value: 15, unit: 9, label: 10, fee: 18 };

function smallRow(c, s) {
  return row(
    [
      ring(c, s.ring, 0, s.pct),
      col(
        [
          amount(c.value.v, c.value.u, s.value, c.valueColor || C.text, s.unit),
          row([T(c.short, s.label, THEME[c.key].tint, 'semibold', { minScale: 0.8 }), ...(c.total ? [T(c.total, s.label, C.tertiary, 'regular', { minScale: 0.7 })] : [])], 4),
        ],
        0,
      ),
    ],
    8,
    { height: s.ring },
  );
}

function buildSmall(view) {
  if (!hasContent(view)) return messageView(view, '暂无数据', 'systemSmall');
  const s = SMALL;
  const fee = feeItem(view);
  const rows = flowItems(view);
  const voice = voiceItem(view);
  if (voice && rows.length < 2) rows.push(voice);
  return rootWidget(
    [
      header(view, s.title),
      spacer(),
      row([T('话费', 11, THEME.fee.tint, 'semibold'), spacer(), amount(fee.value.v, fee.value.u, s.fee, fee.valueColor, 10)], 4, {
        height: Math.ceil(amountH(s.fee, 10)),
      }),
      spacer(8),
      col(rows.slice(0, 2).map((c) => smallRow(c, s)), 8),
    ],
    { padding: [11, 12, 11, 12] },
  );
}

const MEDIUM = { title: 13, time: 11, ring: 52, ringIcon: 10, ringPct: 12, ringGap: 6, value: 18, unit: 10, label: 10, caption: 10, gap: 10 };
const LARGE = { title: 15, time: 12, ring: 62, ringIcon: 12, ringPct: 14, ringGap: 8, value: 22, unit: 11, label: 11, caption: 11, gap: 12 };

function buildMedium(view) {
  if (!hasContent(view)) return messageView(view, '暂无数据', 'systemMedium');
  return rootWidget([spacer(), columns(view, MEDIUM, true), spacer()], { padding: [11, 16, 11, 16] });
}

// 大号下半部：一条细分隔线，然后是套餐名和流量包列表（列表里的小圆点和圆环同色）
function packageList(view, maxRows) {
  const pkgs = view.packages.slice(0, Math.max(1, maxRows));
  const more = view.packages.length - pkgs.length;
  return col(
    [
      { type: 'stack', height: 0.5, backgroundColor: { light: '#D1D1D6', dark: '#3A3A3C' }, children: [{ type: 'spacer' }] },
      spacer(6),
      row(
        [
          T('流量包', 12, C.secondary, 'semibold', { minScale: 1 }),
          ...(view.packageName ? [T(view.packageName, 11, C.tertiary, 'regular', { flex: 1, minScale: 0.7 })] : [spacer()]),
          ...(more > 0 ? [T('另有 ' + more + ' 项', 11, C.tertiary, 'regular', { minScale: 1 })] : []),
        ],
        6,
        { height: Math.ceil(lineH(12)) },
      ),
      ...pkgs.map((p) =>
        row(
          [
            { type: 'stack', width: 6, height: 6, borderRadius: 3, backgroundColor: (p.directed ? THEME.directed : THEME.general).tint, children: [] },
            T(p.name, 13, C.text, 'regular', { flex: 1, minScale: 0.75 }),
            T(packageLine(p), 12, C.secondary, 'regular', { minScale: 0.7 }),
          ],
          8,
          { height: Math.ceil(lineH(13)) },
        ),
      ),
    ],
    6,
  );
}

function buildLarge(view) {
  if (!hasContent(view)) return messageView(view, '暂无数据', 'systemLarge');
  // 按小屏 iPhone 大号（内容区约 296pt 高）估算能放下几行流量包
  const maxRows = 5 - (view.message ? 1 : 0);
  const hasList = view.packages.length > 0;
  const message = view.message ? [spacer(8), T(view.message, 12, view.tone === 'normal' ? C.secondary : toneColor(view.tone), 'regular', { minScale: 0.6 })] : [];
  const body = hasList
    ? [spacer(4), columns(view, LARGE, false), spacer(14), packageList(view, maxRows), spacer()]
    : [spacer(), columns(view, LARGE, false), spacer()];
  return rootWidget([...body, ...message], { padding: [14, 16, 14, 16] });
}

/* ---------- 锁屏 ---------- */
// 锁屏小组件由系统按亮度做半透明渲染：白色最清楚，用透明度区分层级
const L = { text: '#FFFFFF', secondary: '#FFFFFFB3', track: '#FFFFFF40' };

function lockBar(ratio) {
  const r = Math.max(0, Math.min(1000, Math.round(ratio * 1000)));
  const children = r <= 0 ? [spacer()] : [{ type: 'stack', flex: r, height: 3, borderRadius: 1.5, backgroundColor: L.text, children: [] }, ...(r < 1000 ? [{ type: 'spacer', flex: 1000 - r }] : [])];
  return { type: 'stack', direction: 'row', height: 3, borderRadius: 1.5, backgroundColor: L.track, children };
}

function lockAmount(value, unit) {
  return row([T(value, 18, L.text, 'semibold', { minScale: 0.5 }), ...(unit ? [T(unit, 11, L.secondary, 'regular', { minScale: 0.8 })] : [])], 2, { alignItems: 'end' });
}

function lockRoot(children, family, extra) {
  return {
    type: 'widget',
    padding: family === 'accessoryInline' ? 0 : 2,
    gap: 2,
    refreshAfter: new Date(Date.now() + REFRESH_MS).toISOString(),
    children,
    ...(extra || {}),
  };
}

// 圆形锁屏的进度环（内联 SVG，按剩余比例画弧）
function ringImage(ratio) {
  const r = 44;
  const len = (2 * Math.PI * r * Math.max(0, Math.min(1, ratio))).toFixed(2);
  return (
    "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>" +
    "<circle cx='50' cy='50' r='44' fill='none' stroke='rgba(255,255,255,0.25)' stroke-width='7'/>" +
    "<circle cx='50' cy='50' r='44' fill='none' stroke='rgb(255,255,255)' stroke-width='7' stroke-linecap='round' " +
    "stroke-dasharray='" + len + " 400' transform='rotate(-90 50 50)'/></svg>"
  );
}

function centered(node) {
  return row([spacer(), node, spacer()]);
}

function shortValue(x) {
  return x.value.v + (x.value.u ? ' ' + x.value.u : '');
}

function buildLock(view, family) {
  const hero = heroFor(view);
  const danger = view.tone === 'danger';
  if (family === 'accessoryInline') {
    let text = view.title;
    if (danger) text = '联通需重新登录';
    else if (hero) {
      const g = view.general;
      const parts = [view.fee ? '话费 ' + view.fee.value + view.fee.unit : ''];
      if (g && g.kind === 'limited') parts.push('通用剩 ' + g.remain.v + g.remain.u);
      else if (hero.key !== 'fee') parts.push(hero.short + ' ' + hero.value.v + hero.value.u);
      text = parts.filter(Boolean).join(' · ') || text;
    }
    return lockRoot([T(text, 12, L.text, 'regular', { minScale: 0.5 })], family);
  }
  if (family === 'accessoryCircular') {
    if (!hero) return lockRoot([spacer(), centered(T('联通', 12, L.text, 'semibold')), spacer()], family);
    return lockRoot(
      [
        spacer(),
        centered(T(hero.short, 9, L.secondary)),
        centered(T(hero.value.v, 16, L.text, 'semibold', { minScale: 0.5 })),
        ...(hero.value.u ? [centered(T(hero.value.u, 9, L.secondary))] : []),
        spacer(),
      ],
      family,
      { padding: 6, gap: 0, ...(hero.ratio !== null ? { backgroundImage: ringImage(hero.ratio) } : {}) },
    );
  }
  if (!hero) return lockRoot([T(view.title, 13, L.text, 'semibold'), T('暂无数据', 12, L.secondary)], family);
  const extras = extrasFor(view, hero, 2);
  const line = danger ? '登录已失效，请打开联通 App' : extras.map((x) => x.label + ' ' + shortValue(x)).join(' · ');
  return lockRoot(
    [
      row([T(hero.label, 12, L.text, 'semibold'), spacer(), T(danger ? '需登录' : view.timeShort, 11, L.secondary)], 4),
      lockAmount(hero.value.v, hero.value.u),
      ...(hero.ratio !== null ? [lockBar(hero.ratio)] : []),
      T(line || ' ', 11, L.secondary, 'regular', { minScale: 0.6 }),
    ],
    family,
  );
}

/* ---------- 引导与提示 ---------- */

function messageView(view, message, family) {
  return messageLayout(view.title, message, view.tone === 'danger' ? 'danger' : 'normal', family);
}

function messageLayout(title, message, tone, family, note) {
  if (family === 'accessoryCircular') {
    return lockRoot([spacer(), centered(T('联通', 13, L.text, 'semibold')), centered(T(tone === 'danger' ? '需登录' : '未就绪', 10, L.secondary)), spacer()], family, {
      padding: 6,
      gap: 1,
    });
  }
  if (family.startsWith('accessory')) {
    return lockRoot([T(title + ' · ' + message, 11, L.text, 'regular', { maxLines: 2, minScale: 0.5 })], family);
  }
  const small = family === 'systemSmall';
  return rootWidget([
    T(title, 13, C.text, 'semibold'),
    spacer(),
    T(message, small ? 15 : 17, tone === 'danger' ? C.danger : C.text, 'semibold', { maxLines: 2, minScale: 0.7 }),
    ...(note ? [spacer(4), T(note, 12, C.secondary, 'regular', { maxLines: 3, minScale: 0.7 })] : []),
  ]);
}

function messageWidget(ctx, message, tone, family) {
  const fam = family || (ctx && ctx.widgetFamily) || 'systemMedium';
  const title = safeTitle(ctx && ctx.env && ctx.env.TITLE) || '中国联通';
  return messageLayout(title, message, tone, fam);
}

function setupWidget(ctx, family) {
  const fam = family || 'systemMedium';
  const title = safeTitle(ctx && ctx.env && ctx.env.TITLE) || '中国联通';
  if (fam.startsWith('accessory')) return messageLayout(title, '打开联通 App 获取登录信息', 'normal', fam);
  const note =
    fam === 'systemSmall'
      ? '打开联通 App 首页查一次余额'
      : '打开联通 App 首页查一次余额，收到「登录信息已就绪」通知即可。需开启 MITM 并信任证书。';
  return messageLayout(title, '还没有登录信息', 'normal', fam, note);
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
