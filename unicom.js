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

// 语音包的总量和剩余（分钟），用来画语音的进度环。优先按每个语音包累加，
// 没有逐包明细时用分组上的 remainResource / userResource。不限量的语音没有比例。
function addVoice(acc, group, seen) {
  const details = Array.isArray(group.details) ? group.details : [];
  let found = false;
  details.forEach((d) => {
    if (!d || typeof d !== 'object') return;
    const id = [str(d.feePolicyId), str(d.addupItemCode), str(d.feePolicyName)].join('#');
    if (seen.has(id)) return;
    seen.add(id);
    found = true;
    if (str(d.limited) === '1') {
      acc.unlimited = true;
      return;
    }
    const total = nonneg(d.total);
    if (total <= 0) return;
    acc.total += total;
    acc.remain += Math.min(nonneg(d.remain), total);
  });
  if (!found) {
    const remain = nonneg(group.remainResource);
    const used = nonneg(group.userResource);
    if (remain + used > 0) {
      acc.total += remain + used;
      acc.remain += remain;
    }
  }
}

function parseDetail(body) {
  checkCode(body, DETAIL_OK);
  const packages = [];
  const seen = new Set();
  const voice = { total: 0, remain: 0, unlimited: false };
  const voiceSeen = new Set();
  Object.keys(body).forEach((key) => {
    const lk = key.toLowerCase();
    if (SKIP_KEYS.includes(lk) || !Array.isArray(body[key])) return;
    body[key].forEach((group) => {
      if (!group || typeof group !== 'object') return;
      const type = str(group.type).toLowerCase();
      if (type === 'voice' && lk === 'resources') {
        addVoice(voice, group, voiceSeen);
        return;
      }
      if (!Array.isArray(group.details)) return;
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
    voice: voice.total > 0 || voice.unlimited ? voice : null,
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

// 流量不分通用/定向：两组合在一起算剩余、总量和比例
function combineAgg(a, b) {
  const out = emptyAgg();
  [a, b].forEach((x) => {
    if (!x || typeof x !== 'object') return;
    Object.keys(out).forEach((k) => {
      out[k] += nonneg(x[k]);
    });
  });
  return out;
}

// 语音剩余比例：数字用首页的剩余分钟（和圆环里显示的一致），总量用明细里的语音包
function voiceRatio(summaryVoice, detailVoice) {
  if (!detailVoice || detailVoice.unlimited || !(num(detailVoice.total) > 0)) return null;
  const remain = summaryVoice && summaryVoice.unit === '分钟' ? num(summaryVoice.value) : num(detailVoice.remain);
  return Math.max(0, Math.min(1, remain / num(detailVoice.total)));
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

  const view = {
    time: beijingTime(num(data.updatedAt), now),
    tone: 'normal',
    status: '',
    fee,
    feeLow: !!(fee && threshold > 0 && fee.unit === '元' && Number(fee.value) < threshold),
    voice: summary.voice || null,
    voiceRatio: voiceRatio(summary.voice, detail && detail.voice),
    flow: summary.flow || null,
    flowGroup: detail ? groupView(combineAgg(detail.general, detail.directed)) : null,
  };

  // 只在异常时显示一个很短的状态：登录失效、查询失败（显示旧数据的时间）、还没抓到号码
  if (loaded.state === 'auth') {
    view.tone = 'danger';
    view.status = '需登录';
  } else if (loaded.state === 'stale') {
    view.tone = 'warn';
    view.status = view.time;
  } else if (loaded.state === 'partial') {
    const at = loaded.failed && loaded.failed.detail ? num(data.detailAt) : num(data.summaryAt);
    view.tone = 'warn';
    view.status = at ? beijingTime(at, now) : '';
  } else if (loaded.state === 'nophone' && !view.fee) {
    view.status = '查余额';
  }
  return view;
}

/* ============================== 渲染 ============================== */
// 极简：没有标题，只有三个大圆环——话费（红）、流量（蓝）、语音（橙）。
// 圆环里是图标和剩余量，圆环下面是单位；靠图标和颜色区分，不写名称。
// 流量和语音按剩余占总量画进度；话费没有总量，画满一圈（余额低于提醒线时变红色警示）。
// 圆环是内联 SVG 背景图，SVG 里只能用一种颜色，所以圆环颜色选深浅背景上都清楚的中间色。

const C = {
  bg: { light: '#FFFFFF', dark: '#1C1C1E' },
  text: { light: '#1D1D1F', dark: '#FFFFFF' },
  secondary: { light: '#6E6E73', dark: '#AEAEB2' },
  warn: { light: '#FF9500', dark: '#FF9F0A' },
  danger: { light: '#FF3B30', dark: '#FF453A' },
};

// tint：图标和文字的颜色（深浅各一）；ring：圆环颜色（SVG 用，rgb 三元组）
const THEME = {
  fee: { tint: { light: '#E60012', dark: '#FF5A62' }, ring: '240,40,52', symbol: 'yensign' },
  flow: { tint: { light: '#1677FF', dark: '#4D9CFF' }, ring: '47,128,255', symbol: 'antenna.radiowaves.left.and.right' },
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

function centered(node) {
  return row([spacer(), node, spacer()]);
}

function toneColor(tone) {
  return tone === 'danger' ? C.danger : tone === 'warn' ? C.warn : C.secondary;
}

// Egern 实机排版：一行里只要有带 flex 的子元素，这一行就会吃掉父容器剩下的全部高度，
// 内容贴着顶部，弹性 spacer 分不到空间。所以带 flex 的行都指定 height。
const LINE = 1.22;

function lineH(size) {
  return size * LINE;
}

/* ---------- 圆环 ---------- */

function ringRGB(ratio, base) {
  if (ratio === null || ratio === undefined) return base;
  if (ratio < 0.1) return RING_DANGER;
  if (ratio < 0.2) return RING_WARN;
  return base;
}

// 圆形进度条（SVG）：浅色底环 + 从 12 点钟方向顺时针的剩余弧
function ringSvg(ratio, rgb, stroke) {
  const W = stroke;
  const R = 50 - W / 2 - 0.5;
  const track = "<circle cx='50' cy='50' r='" + R + "' fill='none' stroke='rgba(" + rgb + ",0.18)' stroke-width='" + W + "'/>";
  let arc = '';
  if (ratio > 0) {
    const r = Math.min(1, ratio);
    const color = 'rgb(' + rgb + ')';
    arc =
      r >= 0.999
        ? "<circle cx='50' cy='50' r='" + R + "' fill='none' stroke='" + color + "' stroke-width='" + W + "'/>"
        : "<circle cx='50' cy='50' r='" + R + "' fill='none' stroke='" + color + "' stroke-width='" + W + "' stroke-linecap='round' " +
          "stroke-dasharray='" + (2 * Math.PI * R * r).toFixed(2) + " 400' transform='rotate(-90 50 50)'/>";
  }
  return "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>" + track + arc + '</svg>';
}

/* ---------- 三项内容 ---------- */

function ratioOrBase(ratio, base) {
  return ratio === null || ratio === undefined ? base : ringRGB(ratio, base);
}

function feeItem(view) {
  const fee = view.fee;
  return {
    key: 'fee',
    value: fee ? fee.value : '--',
    unit: fee ? fee.unit : '',
    // 话费没有总量：画满一圈；低于提醒线时整圈变红并把数字标红
    ratio: fee ? 1 : 0,
    ring: view.feeLow ? RING_DANGER : THEME.fee.ring,
    valueColor: view.feeLow ? C.danger : fee ? C.text : C.secondary,
  };
}

function flowItem(view) {
  const g = view.flowGroup;
  if (g && g.kind === 'limited') return { key: 'flow', value: g.remain.v, unit: g.remain.u, ratio: g.ratio, ring: ringRGB(g.ratio, THEME.flow.ring) };
  if (g && g.kind === 'unlimited') return { key: 'flow', value: '不限', unit: '', ratio: 1, ring: THEME.flow.ring };
  if (view.flow) return { key: 'flow', value: view.flow.value, unit: view.flow.unit, ratio: 1, ring: THEME.flow.ring };
  if (g) return { key: 'flow', value: g.used.v, unit: '已用' + g.used.u, ratio: 0, ring: THEME.flow.ring };
  return { key: 'flow', value: '--', unit: '', ratio: 0, ring: THEME.flow.ring, valueColor: C.secondary };
}

function voiceItem(view) {
  const v = view.voice;
  const ratio = view.voiceRatio;
  return {
    key: 'voice',
    value: v ? v.value : '--',
    unit: v ? v.unit : '',
    // 没有语音包总量时画满一圈
    ratio: v ? (ratio === null ? 1 : ratio) : 0,
    ring: ratioOrBase(ratio, THEME.voice.ring),
    valueColor: v ? C.text : C.secondary,
  };
}

function itemsFor(view) {
  return [feeItem(view), flowItem(view), voiceItem(view)];
}

// 话费（¥ 图标）和语音（电话图标）的单位不写；流量的 GB/MB 要写
function shownUnit(item) {
  if (item.key === 'fee' && item.unit === '元') return '';
  if (item.key === 'voice' && item.unit === '分钟') return '';
  return item.unit;
}

// 一个圆环：图标在上、剩余量在正中、单位在下（没有单位时留空，保证几个圆环的数字对齐）
function ringBlock(item, s) {
  const p = THEME[item.key];
  const unit = shownUnit(item);
  const edge = Math.ceil(Math.max(s.icon, lineH(s.unit)));
  return {
    type: 'stack',
    direction: 'column',
    alignItems: 'center',
    width: s.ring,
    height: s.ring,
    padding: [0, s.inset, 0, s.inset],
    backgroundImage: ringSvg(item.ratio, item.ring, s.stroke),
    children: [
      spacer(),
      row([spacer(), icon(p.symbol, s.icon, p.tint), spacer()], 0, { height: edge }),
      row([spacer(), T(item.value, s.value, item.valueColor || C.text, 'semibold', { minScale: 0.45 }), spacer()], 0, { height: Math.ceil(lineH(s.value)) }),
      row(unit ? [spacer(), T(unit, s.unit, C.secondary, 'regular', { minScale: 0.6 }), spacer()] : [], 0, { height: edge }),
      spacer(),
    ],
  };
}

// 异常状态：一个小警示图标加很短的文字（如「需登录」或旧数据的时间），正常时不显示
function statusBadge(view, size, short) {
  if (!view.status && view.tone === 'normal') return null;
  const color = toneColor(view.tone);
  let text = view.status;
  if (short && text.includes(' ')) text = text.split(' ')[0];
  const parts = [
    ...(view.tone === 'normal' ? [] : [icon('exclamationmark.triangle.fill', size, color)]),
    ...(text ? [T(text, size, color, 'medium', { minScale: 0.6 })] : []),
  ];
  return short ? col(parts.map((x) => centered(x)), 1, { alignItems: 'center' }) : row(parts, 3, { height: Math.ceil(lineH(size)) });
}

function rootWidget(children, extra) {
  return {
    type: 'widget',
    backgroundColor: C.bg,
    padding: 10,
    gap: 0,
    refreshAfter: new Date(Date.now() + REFRESH_MS).toISOString(),
    children,
    ...(extra || {}),
  };
}

// 有状态时在右上角显示，底部留同样高度，圆环仍上下居中
function withStatus(view, size, body) {
  const badge = statusBadge(view, size, false);
  if (!badge) return [spacer(), ...body, spacer()];
  const h = Math.ceil(lineH(size));
  return [row([spacer(), badge], 0, { height: h }), spacer(), ...body, spacer(), spacer(h)];
}

/* ---------- 主屏幕 ---------- */

// 小号：上面一个大的流量圆环，下面话费和语音两个小圆环；右上角留一小块放异常状态
const SMALL_BIG = { ring: 72, stroke: 8, inset: 9, icon: 12, value: 18, unit: 9 };
const SMALL_MINI = { ring: 50, stroke: 6, inset: 7, icon: 9, value: 11, unit: 8 };
const CORNER = 30;

function buildSmall(view) {
  const [fee, flow, voice] = itemsFor(view);
  const badge = statusBadge(view, 9, true);
  const corner = (children) => col(children, 0, { width: CORNER, height: SMALL_BIG.ring, alignItems: 'center' });
  return rootWidget(
    [
      spacer(),
      row([corner([]), spacer(), ringBlock(flow, SMALL_BIG), spacer(), corner(badge ? [badge, spacer()] : [])], 0, { alignItems: 'start', height: SMALL_BIG.ring }),
      spacer(4),
      row([spacer(), ringBlock(fee, SMALL_MINI), spacer(), ringBlock(voice, SMALL_MINI), spacer()], 0, { height: SMALL_MINI.ring }),
      spacer(),
    ],
    { padding: 8 },
  );
}

const MEDIUM = { ring: 92, stroke: 9, inset: 11, icon: 15, value: 22, unit: 11 };
const LARGE = { ring: 128, stroke: 12, inset: 15, icon: 22, value: 32, unit: 14 };

// 中号：三个圆环一排，等距
function buildMedium(view) {
  const [fee, flow, voice] = itemsFor(view);
  const line = row([spacer(), ringBlock(fee, MEDIUM), spacer(), ringBlock(flow, MEDIUM), spacer(), ringBlock(voice, MEDIUM), spacer()], 0, { height: MEDIUM.ring });
  return rootWidget(withStatus(view, 10, [line]), { padding: [10, 10, 10, 10] });
}

// 大号：品字形——上面流量，下面话费和语音
function buildLarge(view) {
  const [fee, flow, voice] = itemsFor(view);
  return rootWidget(
    withStatus(view, 12, [
      row([spacer(), ringBlock(flow, LARGE), spacer()], 0, { height: LARGE.ring }),
      spacer(12),
      row([spacer(), ringBlock(fee, LARGE), spacer(), ringBlock(voice, LARGE), spacer()], 0, { height: LARGE.ring }),
    ]),
    { padding: [14, 16, 14, 16] },
  );
}

/* ---------- 锁屏 ---------- */
// 锁屏小组件由系统按亮度做单色渲染：白色最清楚，用透明度区分层级
const L = { text: '#FFFFFF', secondary: '#FFFFFFB3' };

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

// 锁屏圆环（白色）
function lockRingSvg(ratio) {
  const R = 44;
  const W = 7;
  const track = "<circle cx='50' cy='50' r='" + R + "' fill='none' stroke='rgba(255,255,255,0.25)' stroke-width='" + W + "'/>";
  let arc = '';
  if (ratio > 0) {
    const r = Math.min(1, ratio);
    arc =
      r >= 0.999
        ? "<circle cx='50' cy='50' r='" + R + "' fill='none' stroke='rgb(255,255,255)' stroke-width='" + W + "'/>"
        : "<circle cx='50' cy='50' r='" + R + "' fill='none' stroke='rgb(255,255,255)' stroke-width='" + W + "' stroke-linecap='round' " +
          "stroke-dasharray='" + (2 * Math.PI * R * r).toFixed(2) + " 400' transform='rotate(-90 50 50)'/>";
  }
  return "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>" + track + arc + '</svg>';
}

// 单行锁屏：¥话费 · 流量 · 语音，靠符号和单位区分
function lockPart(item) {
  if (item.value === '--') return '';
  if (item.key === 'fee' && item.unit === '元') return '¥' + item.value;
  return item.value + (item.unit && !/^已用/.test(item.unit) ? item.unit : '');
}

function buildLock(view, family) {
  const [fee, flow, voice] = itemsFor(view);
  const danger = view.tone === 'danger';
  if (family === 'accessoryInline') {
    const text = danger ? '联通需重新登录' : [fee, flow, voice].map(lockPart).filter(Boolean).join(' · ');
    return lockRoot([T(text || '联通', 12, L.text, 'regular', { minScale: 0.5 })], family);
  }
  if (family === 'accessoryCircular') {
    return lockRoot(
      [
        spacer(),
        centered(icon(THEME.flow.symbol, 11, L.text)),
        centered(T(flow.value, 15, L.text, 'semibold', { minScale: 0.5 })),
        ...(flow.unit ? [centered(T(flow.unit, 9, L.secondary, 'regular', { minScale: 0.6 }))] : []),
        spacer(),
      ],
      family,
      { padding: 7, gap: 0, backgroundImage: lockRingSvg(flow.ratio) },
    );
  }
  // 矩形：三行，图标 + 数字
  const line = (item) =>
    row(
      [icon(THEME[item.key].symbol, 11, L.text), T(item.value, 13, L.text, 'semibold', { minScale: 0.6 }), ...(shownUnit(item) ? [T(shownUnit(item), 10, L.secondary, 'regular', { minScale: 0.6 })] : [])],
      4,
      { height: Math.ceil(lineH(13)) },
    );
  return lockRoot(danger ? [line(fee), T('需重新登录', 11, L.secondary)] : [line(fee), line(flow), line(voice)], family, { gap: 1 });
}

/* ---------- 引导与提示 ---------- */

function messageLayout(message, tone, family, note) {
  if (family === 'accessoryCircular') {
    return lockRoot([spacer(), centered(T('联通', 13, L.text, 'semibold')), centered(T(tone === 'danger' ? '需登录' : '未就绪', 10, L.secondary)), spacer()], family, {
      padding: 6,
      gap: 1,
    });
  }
  if (family.startsWith('accessory')) {
    return lockRoot([T('联通 · ' + message, 11, L.text, 'regular', { maxLines: 2, minScale: 0.5 })], family);
  }
  const small = family === 'systemSmall';
  const color = tone === 'danger' ? C.danger : C.secondary;
  return rootWidget([
    spacer(),
    centered(icon(tone === 'danger' ? 'exclamationmark.triangle.fill' : 'simcard', small ? 26 : 30, color)),
    spacer(8),
    centered(T(message, small ? 13 : 15, tone === 'danger' ? C.danger : C.text, 'semibold', { maxLines: 2, minScale: 0.7, textAlign: 'center' })),
    ...(note ? [spacer(4), centered(T(note, 11, C.secondary, 'regular', { maxLines: 2, minScale: 0.7, textAlign: 'center' }))] : []),
    spacer(),
  ]);
}

function messageWidget(ctx, message, tone, family) {
  const fam = family || (ctx && ctx.widgetFamily) || 'systemMedium';
  return messageLayout(message, tone, fam);
}

function setupWidget(ctx, family) {
  const fam = family || 'systemMedium';
  if (fam.startsWith('accessory')) return messageLayout('打开联通 App 获取登录信息', 'normal', fam);
  return messageLayout('还没有登录信息', 'normal', fam, '打开联通 App 首页查一次余额');
}

async function renderWidget(ctx) {
  const family = (ctx && ctx.widgetFamily) || 'systemMedium';
  const loaded = await loadData(ctx);
  if (loaded.state === 'setup') return setupWidget(ctx, family);
  if (!loaded.data) {
    return messageWidget(ctx, loaded.state === 'auth' ? '登录已失效，请打开联通 App' : '查询失败，请稍后重试', loaded.state === 'auth' ? 'danger' : 'normal', family);
  }
  const view = buildView(ctx, loaded);
  if (family.startsWith('accessory')) return buildLock(view, family);
  if (family === 'systemSmall') return buildSmall(view);
  if (family === 'systemLarge' || family === 'systemExtraLarge') return buildLarge(view);
  return buildMedium(view);
}
