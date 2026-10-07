import test from 'node:test';
import assert from 'node:assert/strict';
import run from '../unicom.js';
import { makeCtx, makeStorage, makeRequest, makeResponse, validateDSL, texts, FAMILIES } from './helpers.js';

const PREFIX = 'shuijiao.unicom.v1.';
const PHONE = '18612345678';
const SUMMARY_URL =
  'https://m.client.10010.com/mobileserviceimportant/home/queryUserInfoSeven?version=iphone_c@10.0100&desmobiel=' + PHONE + '&showType=0';
const ONLINE_URL = 'https://m.client.10010.com/mobileService/onLine.htm';

function summaryBody() {
  return {
    code: 'Y',
    feeResource: { dynamicFeeTitle: '剩余话费', feePersent: '45.67', newUnit: '元' },
    voiceResource: { dynamicVoiceTitle: '剩余语音', voicePersent: '120', newUnit: '分钟' },
    flowResource: { dynamicFlowTitle: '剩余通用流量', flowPersent: '12.5', newUnit: 'GB' },
  };
}

function detailBody() {
  return {
    code: '0000',
    packageName: '大王卡 39 元',
    summary: { sum: '33280', freeFlow: '15360' },
    resources: [
      {
        type: 'flow',
        details: [
          { feePolicyId: 'p1', feePolicyName: '国内通用流量', total: '30720', remain: '12800', use: '17920', limited: '0', endDate: '2026-10-31' },
          { feePolicyId: 'p2', feePolicyName: '腾讯视频畅视流量', total: '0', remain: '0', use: '5120', limited: '1' },
        ],
      },
      { type: 'Voice', details: [{ feePolicyId: 'v1', feePolicyName: '国内语音', total: '200', remain: '120', use: '80' }] },
    ],
    mlresources: [
      {
        type: 'flow',
        details: [{ feePolicyId: 'p3', feePolicyName: '专属免流', addupItemCode: '40008', total: '20480', remain: '10240', use: '10240', limited: '0' }],
      },
    ],
    usePercent: [{ details: [{ feePolicyId: 'x' }] }],
  };
}

function authStore(extra) {
  return makeStorage({
    [PREFIX + 'auth']: JSON.stringify({ cookie: 'sid=old; ecs_token=t1', phone: PHONE, token: 'tok1', appId: 'app1', notified: 'full', ...extra }),
  });
}

function happyRoute(method, url) {
  if (url.startsWith('https://m.client.10010.com/mobileserviceimportant/home/queryUserInfoSeven')) return { body: summaryBody() };
  if (url.includes('queryOcsPackageFlowLeftContentRevisedInJune')) return { body: detailBody() };
  throw new Error('unexpected ' + url);
}

function findText(node, text) {
  if (node.type === 'text' && node.text === text) return node;
  for (const c of node.children || []) {
    const hit = findText(c, text);
    if (hit) return hit;
  }
  return null;
}

function hasWarnIcon(node) {
  if (node.type === 'image' && node.src === 'sf-symbol:exclamationmark.triangle.fill') return true;
  return (node.children || []).some(hasWarnIcon);
}

function auth(storage) {
  return storage.getJSON(PREFIX + 'auth');
}

/* ---------------- 抓取 ---------------- */

test('首页查余额请求：记录 Cookie 和手机号，原请求放行', async () => {
  const { ctx, notes, calls } = makeCtx({
    request: makeRequest(SUMMARY_URL, { Cookie: 'sid=abc; ecs_token=xyz' }),
  });
  const ret = await run(ctx);
  assert.equal(ret, undefined);
  assert.equal(calls.length, 0);
  const a = auth(ctx.storage);
  assert.equal(a.phone, PHONE);
  assert.equal(a.cookie, 'sid=abc; ecs_token=xyz');
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /已获取登录信息/);

  // 同样的请求再来一次不重复通知
  const again = makeCtx({ storage: ctx.storage, request: makeRequest(SUMMARY_URL, { Cookie: 'sid=abc; ecs_token=xyz' }) });
  await run(again.ctx);
  assert.equal(again.notes.length, 0);
});

test('不匹配的请求、没有 Cookie、非法号码都不写入', async () => {
  for (const [url, headers] of [
    ['https://m.client.10010.com/other?desmobiel=' + PHONE, { Cookie: 'a=b' }],
    [SUMMARY_URL, {}],
    ['https://evil.example.com/mobileserviceimportant/home/queryUserInfoSeven?desmobiel=' + PHONE, { Cookie: 'a=b' }],
  ]) {
    const { ctx } = makeCtx({ request: makeRequest(url, headers) });
    assert.equal(await run(ctx), undefined);
    assert.equal(auth(ctx.storage), null);
  }
  const bad = makeCtx({ request: makeRequest(SUMMARY_URL.replace(PHONE, '123'), { Cookie: 'a=b' }) });
  await run(bad.ctx);
  assert.equal(auth(bad.ctx.storage).phone, '');
});

test('自动登录：请求里记 appId，响应里记 token_online 和 Set-Cookie，请求/响应体原样返回', async () => {
  const storage = makeStorage({ [PREFIX + 'auth']: JSON.stringify({ cookie: 'sid=abc', phone: PHONE, notified: 'cookie' }) });
  const form = 'appId=APP-123&token_online=TOKEN-OLD&version=iphone_c%409.0100';
  const req = makeCtx({ storage, request: { ...makeRequest(ONLINE_URL, { Cookie: 'sid=abc; c_id=1' }, form), method: 'POST' } });
  const passed = await run(req.ctx);
  assert.deepEqual(Buffer.from(passed.body).toString(), form); // 原样放回
  assert.equal(auth(storage).appId, 'APP-123');
  assert.equal(auth(storage).token, 'TOKEN-OLD');
  assert.equal(req.notes.length, 0);

  const bodyText = JSON.stringify({ code: '0', token_online: 'TOKEN-NEW', desmobile: PHONE, list: [] });
  const { ctx, notes } = makeCtx({
    storage,
    request: makeRequest(ONLINE_URL, { Cookie: 'sid=abc; c_id=1' }),
    response: makeResponse(
      { 'Set-Cookie': ['ecs_token=NEW; Path=/; Domain=10010.com; Expires=Fri, 06-Nov-26 14:57:52 GMT; HttpOnly', 'c_id=; Max-Age=0; Path=/'] },
      bodyText,
    ),
  });
  const ret = await run(ctx);
  assert.deepEqual(ret, { body: bodyText });
  const a = auth(storage);
  assert.equal(a.token, 'TOKEN-NEW');
  assert.equal(a.appId, 'APP-123');
  assert.equal(a.cookie, 'sid=abc; ecs_token=NEW');
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /自动续登/);
});

test('登录请求体含非 ASCII 字节：不解析，按原字节放回', async () => {
  const raw = new Uint8Array([0x61, 0x70, 0x70, 0x49, 0x64, 0x3d, 0xff, 0xfe, 0x00, 0x41]);
  const { ctx } = makeCtx({
    request: { method: 'POST', url: ONLINE_URL, headers: {}, arrayBuffer: async () => raw.buffer.slice(0) },
  });
  const ret = await run(ctx);
  assert.deepEqual(Array.from(ret.body), Array.from(raw));
  assert.equal(auth(ctx.storage), null);
});

test('多个 Set-Cookie 被合并成一行时也能正确拆分', async () => {
  const storage = makeStorage({ [PREFIX + 'auth']: JSON.stringify({ cookie: 'sid=abc', phone: PHONE, appId: 'A1' }) });
  const merged = 'ecs_token=E1; Path=/; Expires=Fri, 06-Nov-26 14:57:52 GMT; HttpOnly, jsessionid=J1; Path=/';
  const { ctx } = makeCtx({
    storage,
    request: makeRequest(ONLINE_URL, {}),
    response: { status: 200, headers: { 'set-cookie': merged }, text: async () => JSON.stringify({ code: '0', token_online: 'T' }) },
  });
  await run(ctx);
  assert.equal(auth(storage).cookie, 'sid=abc; ecs_token=E1; jsessionid=J1');
});

test('自动登录失败的响应不写入，但仍原样放行', async () => {
  const bodyText = JSON.stringify({ code: '1', dsc: '请使用短信验证码重新登录' });
  const { ctx } = makeCtx({
    request: makeRequest(ONLINE_URL, { Cookie: 'sid=abc' }, 'appId=APP'),
    response: makeResponse({}, bodyText),
  });
  assert.deepEqual(await run(ctx), { body: bodyText });
  assert.equal(auth(ctx.storage), null);
});

test('换了号码时清掉旧号码的 Cookie、续登信息和缓存', async () => {
  const storage = authStore();
  storage.setJSON(PREFIX + 'cache', { phone: PHONE, summary: {}, updatedAt: Date.now() });
  const other = '13012345678';
  const { ctx } = makeCtx({ storage, request: makeRequest(SUMMARY_URL.replace(PHONE, other), { Cookie: 'sid=zzz' }) });
  await run(ctx);
  const a = auth(storage);
  assert.equal(a.phone, other);
  assert.equal(a.cookie, 'sid=zzz'); // 不混入旧号码的 ecs_token
  assert.equal(a.token, '');
  assert.equal(a.appId, '');
  assert.equal(storage.getJSON(PREFIX + 'cache'), null);
});

/* ---------------- 小组件 ---------------- */

test('没有登录信息：各尺寸都显示引导，且不发请求', async () => {
  for (const family of FAMILIES) {
    const { ctx, calls } = makeCtx({ family });
    const w = validateDSL(await run(ctx));
    assert.equal(calls.length, 0);
    assert.ok(texts(w).join('').length > 0);
  }
});

test('正常查询：各尺寸 DSL 合法，数值和分组正确', async () => {
  for (const family of FAMILIES) {
    const storage = authStore();
    const { ctx, calls } = makeCtx({ storage, family, route: happyRoute, env: { SHOW_PHONE_SUFFIX: 'true' } });
    const w = validateDSL(await run(ctx));
    const all = texts(w).join('|');
    assert.equal(calls.length, 2, family);
    const summaryCall = calls.find((c) => c.url.includes('queryUserInfoSeven'));
    assert.equal(summaryCall.method, 'get');
    assert.equal(summaryCall.url, SUMMARY_URL);
    assert.equal(summaryCall.options.headers.Cookie, 'sid=old; ecs_token=t1');
    assert.equal(summaryCall.options.credentials, 'omit');
    const detailCall = calls.find((c) => c.url.includes('queryOcsPackage'));
    assert.equal(detailCall.method, 'post');

    if (family === 'systemMedium' || family === 'systemLarge' || family === 'systemExtraLarge') {
      assert.match(all, /45\.67/);
      assert.match(all, /通用/);
      assert.match(all, /定向/);
      assert.match(all, /12\.5\|GB/); // 通用剩余 12800MB
      assert.match(all, /共 30GB/);
      assert.match(all, /已用 17\.5GB/);
      assert.match(all, /共 20GB · 含不限/); // 定向：有限 20G + 一个不限包
      assert.match(all, /已用 15GB/); // 定向已用 5120+10240
      assert.match(all, /尾号5678/);
      assert.doesNotMatch(all, /18612345678/);
    }
    if (family === 'systemLarge') {
      assert.match(all, /大王卡 39 元/);
      assert.match(all, /腾讯视频畅视流量/);
      assert.match(all, /剩 12\.5GB \/ 30GB/);
      assert.doesNotMatch(all, /国内语音/); // 语音资源不算流量包
    }
    if (family === 'systemSmall') {
      assert.match(all, /通用剩余\|共 30GB\|12\.5\|GB/);
      assert.match(all, /话费\|45\.67\|元/);
      assert.match(all, /定向剩余\|10\|GB/);
    }
    if (family === 'systemMedium') assert.match(all, /语音 120 分钟/); // 三列放不下时，语音并入话费列
    if (family === 'accessoryInline') assert.match(all, /话费 45\.67元 · 通用剩 12\.5GB/);
    if (family === 'accessoryRectangular') {
      assert.match(all, /通用剩余\|.*\|12\.5\|GB/);
      assert.match(all, /话费 45\.67 元 · 定向剩余 10 GB/);
    }
    if (family === 'accessoryCircular') assert.match(all, /通用\|12\.5\|GB/);
    const cache = storage.getJSON(PREFIX + 'cache');
    assert.equal(cache.complete, true);
  }
});

// Egern 实机：行里有带 flex 的子元素时，这一行会吃掉剩余高度，弹性 spacer 分不到空间，内容被挤到顶部
function flexRowsWithoutHeight(node, path = 'root', out = []) {
  const kids = node.children || [];
  if (node.type === 'stack' && (node.direction || 'row') === 'row' && !node.height && kids.some((k) => k.flex && k.type !== 'spacer')) out.push(path);
  kids.forEach((k, i) => flexRowsWithoutHeight(k, path + '.' + i, out));
  return out;
}

test('含 flex 子元素的行都固定了高度，内容不会被挤到顶部', async () => {
  const routes = [happyRoute, (m, u) => (u.includes('queryUserInfoSeven') ? { body: summaryBody() } : { status: 502, body: 'x' })];
  for (const route of routes) {
    for (const family of FAMILIES) {
      const { ctx } = makeCtx({ storage: authStore(), family, route });
      const w = validateDSL(await run(ctx));
      assert.deepEqual(flexRowsWithoutHeight(w), [], family);
    }
  }
});

test('5 分钟内的完整缓存直接使用，不重复请求', async () => {
  const storage = authStore();
  await run(makeCtx({ storage, family: 'systemMedium', route: happyRoute }).ctx);
  const second = makeCtx({ storage, family: 'systemSmall', route: happyRoute });
  validateDSL(await run(second.ctx));
  assert.equal(second.calls.length, 0);
});

test('Cookie 失效（裸 999999）时用 token_online 续登并重查', async () => {
  const storage = authStore();
  let online = 0;
  const { ctx, calls } = makeCtx({
    storage,
    family: 'systemMedium',
    route(method, url, options) {
      const fresh = /ecs_token=FRESH/.test(options.headers && options.headers.Cookie);
      if (url.includes('queryUserInfoSeven')) return fresh ? { body: summaryBody() } : { body: '999999' };
      if (url.includes('queryOcsPackage')) return fresh ? { body: detailBody() } : { body: '999999' };
      if (url === ONLINE_URL) {
        online += 1;
        assert.equal(method, 'post');
        assert.match(options.body, /appId=app1/);
        assert.match(options.body, /token_online=tok1/);
        return { headers: { 'Set-Cookie': ['ecs_token=FRESH; Path=/; HttpOnly'] }, body: { code: '0', token_online: 'tok2' } };
      }
      throw new Error(url);
    },
  });
  const w = validateDSL(await run(ctx));
  assert.equal(online, 1);
  assert.equal(calls.length, 5);
  const a = auth(storage);
  assert.equal(a.cookie, 'sid=old; ecs_token=FRESH');
  assert.equal(a.token, 'tok2');
  assert.equal(a.authFailedAt, 0);
  assert.match(texts(w).join('|'), /45\.67/);
  assert.doesNotMatch(texts(w).join('|'), /失效/);
});

test('续登成功但没下发新 Cookie：保存新 token，10 分钟内不再续登', async () => {
  const storage = authStore();
  let online = 0;
  const route = (method, url) => {
    if (url === ONLINE_URL) {
      online += 1;
      return { body: { code: '0', token_online: 'tok-rotated' } };
    }
    return { body: '999999' };
  };
  const first = makeCtx({ storage, family: 'systemMedium', route });
  validateDSL(await run(first.ctx));
  assert.equal(online, 1);
  assert.equal(auth(storage).token, 'tok-rotated');
  assert.ok(auth(storage).reloginAt > 0);
  assert.ok(auth(storage).authFailedAt > 0);
  // 1 小时内不再请求；即使清掉失效标记，10 分钟内也不再续登
  storage.setJSON(PREFIX + 'auth', { ...auth(storage), authFailedAt: 0 });
  const second = makeCtx({ storage, family: 'systemMedium', route });
  validateDSL(await run(second.ctx));
  assert.equal(online, 1);
  assert.equal(second.calls.length, 2);
});

test('只有一个接口报登录失效：按部分失败处理，不标记登录失效', async () => {
  const storage = authStore({ token: '', appId: '' });
  const { ctx } = makeCtx({
    storage,
    family: 'systemMedium',
    route(method, url) {
      if (url.includes('queryUserInfoSeven')) return { body: summaryBody() };
      return { body: '999999' };
    },
  });
  const all = texts(validateDSL(await run(ctx))).join('|');
  assert.match(all, /45\.67/);
  assert.equal(auth(storage).authFailedAt || 0, 0);
});

test('Cookie 失效且没有续登信息：提示重新登录，1 小时内不再用旧凭据请求', async () => {
  const storage = authStore({ token: '', appId: '' });
  const route = () => ({ body: '999999' });
  const first = makeCtx({ storage, family: 'systemMedium', route });
  const w = validateDSL(await run(first.ctx));
  assert.equal(first.calls.length, 2);
  assert.match(texts(w).join('|'), /登录已失效/);
  assert.ok(auth(storage).authFailedAt > 0);

  const second = makeCtx({ storage, family: 'systemSmall', route });
  validateDSL(await run(second.ctx));
  assert.equal(second.calls.length, 0);

  // 重新打开 App 抓到新 Cookie 后立即恢复
  const cap = makeCtx({ storage, request: makeRequest(SUMMARY_URL, { Cookie: 'sid=new' }) });
  await run(cap.ctx);
  assert.equal(auth(storage).authFailedAt, 0);
  assert.equal(cap.notes.length, 1);
  assert.match(cap.notes[0].body, /已更新/);
  const third = makeCtx({ storage, family: 'systemMedium', route: happyRoute });
  validateDSL(await run(third.ctx));
  assert.equal(third.calls.length, 2);
});

test('续登 token 也失效：标记登录失效，有缓存时继续显示旧数据', async () => {
  const storage = authStore();
  storage.setJSON(PREFIX + 'cache', { phone: PHONE, summary: { fee: { title: '剩余话费', value: '9.5', unit: '元' } }, summaryAt: 1, updatedAt: 1, complete: false });
  const { ctx } = makeCtx({
    storage,
    family: 'systemMedium',
    route(method, url) {
      if (url === ONLINE_URL) return { body: { code: '1', dsc: '请使用短信验证码重新登录' } };
      return { body: '999999' };
    },
  });
  const w = validateDSL(await run(ctx));
  const all = texts(w).join('|');
  assert.match(all, /9\.5/);
  assert.match(all, /需重新登录/);
  assert.ok(hasWarnIcon(w));
  assert.ok(auth(storage).authFailedAt > 0);
  const large = makeCtx({ storage, family: 'systemLarge', route: () => ({ body: '999999' }) });
  assert.match(texts(validateDSL(await run(large.ctx))).join('|'), /登录已失效，请打开联通 App 刷新/);
});

test('网络失败：不标记登录失效，显示缓存并提示', async () => {
  const storage = authStore();
  storage.setJSON(PREFIX + 'cache', { phone: PHONE, summary: summaryBody() && { fee: { title: '剩余话费', value: '45.67', unit: '元' } }, summaryAt: 1000, updatedAt: 1000, complete: false });
  const { ctx } = makeCtx({
    storage,
    family: 'systemMedium',
    route() {
      throw new Error('timeout');
    },
  });
  const w = validateDSL(await run(ctx));
  const all = texts(w).join('|');
  assert.ok(hasWarnIcon(w));
  assert.match(all, /45\.67/);
  assert.equal(auth(storage).authFailedAt || 0, 0);
  const large = makeCtx({ storage, family: 'systemLarge', route() { throw new Error('timeout'); } });
  assert.match(texts(validateDSL(await run(large.ctx))).join('|'), /查询失败，显示 01-01 08:00 的数据/);
});

test('续登请求网络失败：不误判为登录失效', async () => {
  const storage = authStore();
  const { ctx } = makeCtx({
    storage,
    family: 'systemMedium',
    route(method, url) {
      if (url === ONLINE_URL) throw new Error('timeout');
      return { body: '999999' };
    },
  });
  const w = validateDSL(await run(ctx));
  assert.equal(auth(storage).authFailedAt || 0, 0);
  // 没有缓存：整张显示「查询失败」，不能显示成登录失效
  assert.match(texts(w).join('|'), /查询失败，请稍后重试/);
  assert.doesNotMatch(texts(w).join('|'), /登录/);
});

test('只有明细接口失败：话费正常显示，并提示明细失败', async () => {
  const storage = authStore();
  const { ctx } = makeCtx({
    storage,
    family: 'systemMedium',
    route(method, url) {
      if (url.includes('queryUserInfoSeven')) return { body: summaryBody() };
      return { status: 502, body: 'bad gateway' };
    },
  });
  const w = validateDSL(await run(ctx));
  const all = texts(w).join('|');
  assert.match(all, /45\.67/);
  assert.ok(hasWarnIcon(w));
  assert.match(all, /剩余通用流量\|12\.5\|GB/); // 退回汇总接口的流量总数
  const large = makeCtx({ storage, family: 'systemLarge', route(method, url) {
    if (url.includes('queryUserInfoSeven')) return { body: summaryBody() };
    return { status: 502, body: 'bad gateway' };
  } });
  // 大号：5 分钟内有完整缓存？没有（明细失败），所以会重新请求并给出完整提示
  assert.match(texts(validateDSL(await run(large.ctx))).join('|'), /流量明细查询失败/);
});

test('联通维护等业务错误码：不当成登录失效', async () => {
  const storage = authStore();
  const { ctx } = makeCtx({
    storage,
    family: 'systemSmall',
    route(method, url) {
      if (url.includes('queryUserInfoSeven')) return { body: summaryBody() };
      return { body: { code: '4114030182', desc: '系统维护' } };
    },
  });
  validateDSL(await run(ctx));
  assert.equal(auth(storage).authFailedAt || 0, 0);
});

test('只有续登信息、还没抓到号码：显示流量明细并提示查一次余额', async () => {
  const storage = makeStorage({ [PREFIX + 'auth']: JSON.stringify({ cookie: 'ecs_token=x', token: 't', appId: 'a' }) });
  const { ctx, calls } = makeCtx({ storage, family: 'systemMedium', route: happyRoute });
  const all = texts(validateDSL(await run(ctx))).join('|');
  assert.equal(calls.length, 1);
  assert.match(all, /去 App 查余额/);
  assert.match(all, /共 30GB/);
});

test('异常输入不让小组件崩溃', async () => {
  const storage = authStore();
  const weird = [
    { body: { code: 'Y', feeResource: { feePersent: 'abc' } } },
    { body: { code: '0000', resources: 'x', mlresources: [{ details: [null, 1, { remain: 'NaN' }] }] } },
    { body: 'not json' },
  ];
  for (const r of weird) {
    for (const family of FAMILIES) {
      storage.delete(PREFIX + 'cache');
      const s2 = authStore();
      const { ctx } = makeCtx({ storage: s2, family, route: () => r });
      validateDSL(await run(ctx));
    }
  }
});

test('存储损坏时也能渲染', async () => {
  const storage = makeStorage();
  storage.getJSON = () => {
    throw new Error('corrupt');
  };
  for (const family of FAMILIES) {
    const { ctx } = makeCtx({ storage, family });
    validateDSL(await run(ctx));
  }
});

test('自定义标题和话费提醒线', async () => {
  const storage = authStore();
  const { ctx } = makeCtx({ storage, family: 'systemMedium', route: happyRoute, env: { TITLE: '主卡', LOW_FEE: '50' } });
  const w = validateDSL(await run(ctx));
  assert.match(texts(w).join('|'), /主卡/);
  const fee = findText(w, '45.67');
  assert.ok(fee && fee.textColor.light === '#FF3B30', '话费低于 50 元应标红');
  const normal = makeCtx({ storage: authStore(), family: 'systemMedium', route: happyRoute });
  assert.equal(findText(validateDSL(await run(normal.ctx)), '45.67').textColor.light, '#1D1D1F');
});
