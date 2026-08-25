#!/usr/bin/env node
/* =============================================================================
 * RecycleFlow NG — 一体化部署服务器（零依赖，仅用 Node 内置模块）
 *
 * 设计要点（相较旧版的重大改进）：
 *   1) 账号「服务端权威」：登录 / 改密 / 建号全部在服务器端完成并落盘。
 *      旧版把账号存在各设备 localStorage 再靠同步合并，导致「换设备新账号登
 *      不上、改过的密码新设备不认」——本版从架构上根除该问题：任一设备登录都
 *      直接向服务器校验，账号天然跨设备一致。
 *   2) 业务数据（收发货台账 / 客户 / 财务）沿用 LWW 多厂区同步，墓碑防复活。
 *   3) 落盘可加密：配置 SYNC_KEY 后磁盘文件用 AES-256-GCM 加密。
 *
 * 运行：
 *   node app-server.js                      (默认端口 8787，监听 0.0.0.0)
 *   PORT=8080 SYNC_KEY=xxx node app-server.js
 *
 * 接口：
 *   鉴权（账号服务端权威）
 *     POST /api/login            {username,password}        -> {ok,token,user}
 *     GET  /api/me               (Bearer)                   -> {ok,user}
 *     POST /api/change-password  (Bearer){oldPassword,newPassword} -> {ok}
 *     GET  /api/accounts         (Bearer, account.manage)   -> {ok,accounts:[]}
 *     POST /api/accounts         (Bearer, account.manage)   -> {ok,user}
 *     DELETE /api/accounts/:u    (Bearer, account.manage)   -> {ok}
 *     POST /api/register         {username,...} (首账号为老板，否则需鉴权)
 *   同步（业务数据，LWW）
 *     GET  /sync/health          -> {ok,count,key}
 *     POST /sync/push            -> {ok,serverTime}
 *     GET  /sync/pull?since=T    -> {ok, ...增量}
 * ===========================================================================*/
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';
// 默认空密钥 = 免鉴权（同源一体部署默认）；公网部署务必设置强密钥
const SYNC_KEY = process.env.SYNC_KEY || '';
const DATA_FILE = process.env.SYNC_DATA_FILE || path.join(__dirname, 'sync-data.json');
const APP_HTML = path.join(__dirname, 'index.html');

/* ---------- 密码哈希（与前端离线校验兼容：标准 PBKDF2-HMAC-SHA256, dkLen=32） ---------- */
const PBKDF2_ITER = 60000;
const PW_V2 = '$pbkdf2$';
function genSaltHex() { return crypto.randomBytes(16).toString('hex'); }
function hashPassword(pw, saltHex) {
  const d = crypto.pbkdf2Sync(Buffer.from(pw, 'utf8'), Buffer.from(saltHex, 'hex'), PBKDF2_ITER, 32, 'sha256').toString('hex');
  return PW_V2 + PBKDF2_ITER + '$' + saltHex + '$' + d;
}
function verifyPassword(pw, storedHash) {
  if (!storedHash || storedHash.indexOf(PW_V2) !== 0) return false;
  const p = storedHash.split('$');            // ['', 'pbkdf2', '60000', saltHex, hashHex]
  const saltHex = p[3], hashHex = p[4];
  if (!saltHex || !hashHex) return false;
  const d = crypto.pbkdf2Sync(Buffer.from(pw, 'utf8'), Buffer.from(saltHex, 'hex'), PBKDF2_ITER, 32, 'sha256').toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(d, 'hex'), Buffer.from(hashHex, 'hex'));
  } catch (e) { return false; }
}
function passwordStrong(pw) {
  return typeof pw === 'string' && pw.length >= 8 && /[A-Za-z]/.test(pw) && /\d/.test(pw);
}

/* ---------- 账号种子（仅首次启动写入；运行时只存哈希） ---------- */
const SEED_ACCOUNTS = [
  { username: 'boss@xf.com',         name: '黄总（老板）', role: 'boss',         factories: ['Sagamu', 'OPIC', 'Ikeja'], pw: '8wN2JCnDhHFc54W^', mustChange: true },
  { username: 'admin.sagamu@xf.com', name: 'Sagamu 管理员', role: 'factoryAdmin', factories: ['Sagamu'], pw: '6YeiMsxBA#gU2PAD', mustChange: true },
  { username: 'admin.opic@xf.com',   name: 'OPIC 管理员',   role: 'factoryAdmin', factories: ['OPIC'],    pw: '&SFb32Y9YTBzhq#L', mustChange: true },
  { username: 'admin.ikeja@xf.com',  name: 'Ikeja 管理员',  role: 'factoryAdmin', factories: ['Ikeja'],   pw: 'G3VW%7kvh!cK4L7r', mustChange: true },
  { username: 'reg.sagamu@xf.com',   name: 'Sagamu 登记员', role: 'registrar',   factories: ['Sagamu'], pw: 'nQH4uiizAJA@Hpn^', mustChange: true },
  { username: 'auditor@xf.com',      name: '审计员',         role: 'auditor',      factories: ['Sagamu', 'OPIC', 'Ikeja'], pw: '8GaqmC3an8sK&3#B', mustChange: true },
  { username: '管理员',              name: '管理员',         role: 'devAdmin',    factories: ['Sagamu', 'OPIC', 'Ikeja'], pw: 'ZsCt##Ps3JmgwFkz', mustChange: true }
];
const ROLE_PERMS = {
  boss:        ['view:*', 'customer:*', 'receive', 'ship', 'produce', 'sell', 'inbound', 'crush', 'pricing', 'settings.write', 'audit.view', 'record.delete', 'customer.create', 'customer.edit', 'customer.delete', 'account.manage', 'data.reset', 'view.allFactories', 'announce', 'finance.view', 'finance.manage'],
  devAdmin:    ['view:*', 'customer:*', 'receive', 'ship', 'produce', 'sell', 'inbound', 'crush', 'pricing', 'settings.write', 'audit.view', 'record.delete', 'customer.create', 'customer.edit', 'customer.delete', 'account.manage', 'data.reset', 'view.allFactories', 'announce', 'finance.view', 'finance.manage'],
  factoryAdmin:['view:dashboard', 'view:customers', 'view:receiving', 'view:today', 'view:pricing', 'view:shipping', 'view:crush', 'view:produce', 'view:sell', 'view:logistics', 'view:inventory', 'view:search', 'view:reports', 'view:settings', 'view:custdetail', 'view:finance', 'customer.create', 'customer.edit', 'customer.delete', 'receive', 'ship', 'produce', 'sell', 'pricing', 'record.delete', 'settings.write', 'audit.view', 'finance.view', 'finance.manage'],
  registrar:   ['view:dashboard', 'view:customers', 'view:receiving', 'view:today', 'view:shipping', 'view:search', 'view:custdetail', 'receive', 'ship', 'record.delete'],
  auditor:     ['view:dashboard', 'view:customers', 'view:today', 'view:search', 'view:reports', 'view:settings', 'view:custdetail', 'view:finance', 'audit.view', 'finance.view']
};
function can(role, perm) {
  const p = ROLE_PERMS[role] || [];
  if (p.includes(perm) || p.includes(perm.split(/[:.]/)[0] + ':*')) return true;
  return false;
}

/* ---------- 状态 ---------- */
let accounts = {};        // username -> account（服务端权威）
let tokens = {};          // token -> {username, exp}
let ledger = {};          // id -> record
let deleted = [];         // [{id, ts}]
let customers = {};       // id -> customer
let deletedCustomers = [];
let finances = {};        // id -> finance（含 currency 字段）
let deletedFinances = [];

/* ---------- 落盘（可加密） ---------- */
function deriveKey() {
  if (!SYNC_KEY) return null;
  return crypto.scryptSync(SYNC_KEY, 'recycleflow-sync-v1', 32);
}
function encryptData(plain) {
  const key = deriveKey();
  if (!key) return { enc: false, data: plain };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { enc: true, data: iv.toString('base64') + ':' + tag.toString('base64') + ':' + enc.toString('base64') };
}
function decryptData(str) {
  const key = deriveKey();
  if (!key) return str;
  const parts = str.split(':');
  if (parts.length !== 3) return str;
  try {
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[1], 'base64');
    const enc = Buffer.from(parts[2], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (e) { return str; }
}
function snapshot() {
  return JSON.stringify({ accounts, tokens, ledger, deleted, customers, deletedCustomers, finances, deletedFinances }, null, 0);
}
function loadSnapshot() {
  try {
    if (!fs.existsSync(DATA_FILE)) return false;
    let raw = fs.readFileSync(DATA_FILE, 'utf8');
    if (raw.startsWith('ENC:')) raw = decryptData(raw.slice(4));
    const d = JSON.parse(raw);
    accounts = d.accounts || {};
    tokens = d.tokens || {};
    ledger = d.ledger || {};
    deleted = (d.deleted || []).map(x => (typeof x === 'string' ? { id: x, ts: 0 } : x));
    customers = d.customers || {};
    deletedCustomers = (d.deletedCustomers || []).map(x => (typeof x === 'string' ? { id: x, ts: 0 } : x));
    finances = d.finances || {};
    deletedFinances = (d.deletedFinances || []).map(x => (typeof x === 'string' ? { id: x, ts: 0 } : x));
    return true;
  } catch (e) { console.warn('[sync] 载入数据失败，重新开始：', e.message); return false; }
}
let saveTimer = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const packed = encryptData(snapshot());
    const tmp = DATA_FILE + '.tmp';
    fs.writeFile(tmp, packed.enc ? ('ENC:' + packed.data) : packed.data, (err) => {
      if (err) { console.warn('[sync] 写入失败：', err.message); return; }
      fs.rename(tmp, DATA_FILE, (e2) => { if (e2) console.warn('[sync] 重命名失败：', e2.message); });
    });
  }, 300);
}
function seedIfEmpty() {
  if (Object.keys(accounts).length > 0) return;
  console.log('\n[auth] 首次启动：初始化默认账号（请尽快登录并修改初始密码）');
  SEED_ACCOUNTS.forEach(a => {
    const salt = genSaltHex();
    accounts[a.username] = {
      username: a.username, name: a.name, role: a.role,
      factories: a.factories.slice(), salt, passwordHash: hashPassword(a.pw, salt),
      mustChange: !!a.mustChange, updatedTs: Date.now(), deleted: false
    };
    console.log('        ' + a.username + '  [' + a.role + ']  初始密码: ' + a.pw);
  });
  persist();
}

/* ---------- HTTP 工具 ---------- */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  let o; try { o = new URL(origin); } catch (e) { return null; }
  if (o.protocol !== 'http:' && o.protocol !== 'https:') return null;
  const hostHdr = (req.headers.host || '').toLowerCase();
  const oHost = o.host.toLowerCase();
  if (oHost && hostHdr && oHost === hostHdr) return origin;
  const list = (process.env.SYNC_CORS_ORIGIN || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (list.includes(origin.toLowerCase()) || list.includes(oHost)) return origin;
  return null;
}
function sendJSON(res, code, obj, req) {
  const origin = req ? originAllowed(req) : null;
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin',
    'Access-Control-Allow-Origin': origin || 'null',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 32 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function authUser(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const t = tokens[m[1]];
  if (!t) return null;
  if (t.exp < Date.now()) { delete tokens[m[1]]; return null; }
  const a = accounts[t.username];
  if (!a || a.deleted) return null;
  return a;
}
function publicUser(a, withVerifier) {
  if (!a) return null;
  const u = { username: a.username, name: a.name, role: a.role, factories: a.factories.slice(), mustChange: !!a.mustChange };
  // verifier 仅用于客户端「断网时本地校验密码」，非明文密码，可安全缓存于 localStorage
  if (withVerifier) u.verifier = { salt: a.salt, passwordHash: a.passwordHash };
  return u;
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.png': 'image/png', '.svg': 'image/svg+xml' };

/* ---------- 业务数据 LWW 合并 ---------- */
function mergeRecord(rec) {
  if (!rec || rec.id == null) return;
  if (deleted.some(t => t.id === rec.id)) return;
  const cur = ledger[rec.id];
  const ts = rec.ts || 0, rev = rec.rev || 0;
  const cts = cur ? (cur.ts || 0) : -1, crev = cur ? (cur.rev || 0) : -1;
  if (!cur || ts > cts || (ts === cts && rev > crev)) ledger[rec.id] = rec;
}
function mergeCustomer(c) {
  if (!c || c.id == null) return;
  if (deletedCustomers.some(t => t.id === c.id)) return;
  const cur = customers[c.id];
  if (!cur || (c.updatedTs || 0) > (cur.updatedTs || 0)) customers[c.id] = c;
}
function mergeFinance(f) {
  if (!f || f.id == null) return;
  if (deletedFinances.some(t => t.id === f.id)) return;
  const cur = finances[f.id];
  if (!cur || (f.ts || 0) > (cur.ts || 0)) finances[f.id] = f;
}

/* ---------- 路由 ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'OPTIONS') { sendJSON(res, 204, {}, req); return; }

  /* ===== 鉴权 API ===== */
  if (p === '/api/login' && req.method === 'POST') {
    let b; try { b = await readBody(req); } catch (e) { sendJSON(res, 400, { ok: false, error: 'bad json' }, req); return; }
    const a = accounts[b.username];
    if (!a || a.deleted || !verifyPassword(b.password || '', a.passwordHash)) {
      sendJSON(res, 401, { ok: false, error: 'invalid_credentials' }, req); return;
    }
    const token = crypto.randomBytes(24).toString('hex');
    tokens[token] = { username: a.username, exp: Date.now() + 30 * 24 * 3600 * 1000 };
    persist();
    sendJSON(res, 200, { ok: true, token, user: publicUser(a, true) }, req);
    return;
  }
  if (p === '/api/me' && req.method === 'GET') {
    const a = authUser(req);
    if (!a) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
    sendJSON(res, 200, { ok: true, user: publicUser(a, true) }, req);
    return;
  }
  if (p === '/api/change-password' && req.method === 'POST') {
    const a = authUser(req);
    if (!a) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
    let b; try { b = await readBody(req); } catch (e) { sendJSON(res, 400, { ok: false, error: 'bad json' }, req); return; }
    // 已认证会话下：若账号处于「必须改密」状态（初始密码），可免旧密码校验直接重设
    if (!a.mustChange && !verifyPassword(b.oldPassword || '', a.passwordHash)) { sendJSON(res, 400, { ok: false, error: 'old_wrong' }, req); return; }
    if (!passwordStrong(b.newPassword || '')) { sendJSON(res, 400, { ok: false, error: 'weak' }, req); return; }
    const salt = genSaltHex();
    a.salt = salt; a.passwordHash = hashPassword(b.newPassword, salt); a.mustChange = false; a.updatedTs = Date.now();
    persist();
    sendJSON(res, 200, { ok: true }, req);
    return;
  }
  if (p === '/api/accounts' && req.method === 'GET') {
    const a = authUser(req);
    if (!a) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
    if (!can(a.role, 'account.manage')) { sendJSON(res, 403, { ok: false, error: 'forbidden' }, req); return; }
    const list = Object.values(accounts).filter(x => !x.deleted).map(x => ({
      username: x.username, name: x.name, role: x.role, factories: x.factories.slice(), mustChange: !!x.mustChange
    }));
    sendJSON(res, 200, { ok: true, accounts: list }, req);
    return;
  }
  if (p === '/api/accounts' && req.method === 'POST') {
    // 允许：已鉴权且具 account.manage；或系统尚无任何账号时自助注册首账号（老板）
    let a = authUser(req);
    let b; try { b = await readBody(req); } catch (e) { sendJSON(res, 400, { ok: false, error: 'bad json' }, req); return; }
    const firstRun = Object.values(accounts).filter(x => !x.deleted).length === 0;
    if (!firstRun) {
      if (!a) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
      if (!can(a.role, 'account.manage')) { sendJSON(res, 403, { ok: false, error: 'forbidden' }, req); return; }
    }
    const username = (b.username || '').trim();
    const name = (b.name || '').trim();
    const role = b.role || 'registrar';
    const factories = Array.isArray(b.factories) ? b.factories : [];
    if (!username || !name) { sendJSON(res, 400, { ok: false, error: 'missing' }, req); return; }
    if (!['boss', 'devAdmin', 'factoryAdmin', 'registrar', 'auditor'].includes(role)) { sendJSON(res, 400, { ok: false, error: 'bad_role' }, req); return; }
    if (factories.length === 0) { sendJSON(res, 400, { ok: false, error: 'no_factory' }, req); return; }
    const existing = accounts[username];
    if (existing && !existing.deleted && !b.forceOverwrite) { sendJSON(res, 409, { ok: false, error: 'exists' }, req); return; }
    if (!b.password || !passwordStrong(b.password)) { sendJSON(res, 400, { ok: false, error: 'weak' }, req); return; }
    const salt = genSaltHex();
    accounts[username] = {
      username, name, role, factories: factories.slice(), salt,
      passwordHash: hashPassword(b.password, salt),
      mustChange: firstRun ? false : true, updatedTs: Date.now(), deleted: false
    };
    persist();
    sendJSON(res, 200, { ok: true, user: publicUser(accounts[username]) }, req);
    return;
  }
  if (p.startsWith('/api/accounts/') && req.method === 'DELETE') {
    const a = authUser(req);
    if (!a) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
    if (!can(a.role, 'account.manage')) { sendJSON(res, 403, { ok: false, error: 'forbidden' }, req); return; }
    const target = decodeURIComponent(p.slice('/api/accounts/'.length));
    const t = accounts[target];
    if (!t || t.deleted) { sendJSON(res, 404, { ok: false, error: 'not_found' }, req); return; }
    if (t.role === 'boss' || t.role === 'devAdmin') { sendJSON(res, 400, { ok: false, error: 'protected' }, req); return; }
    if (target === a.username) { sendJSON(res, 400, { ok: false, error: 'self' }, req); return; }
    t.deleted = true; t.updatedTs = Date.now();
    persist();
    sendJSON(res, 200, { ok: true }, req);
    return;
  }
  if (p === '/api/register' && req.method === 'POST') {
    // 转发到 /api/accounts 逻辑（首账号自助注册）
    req.url = '/api/accounts';
    return handleAccountsPost(req, res);
  }

  /* ===== 同步 API（业务数据） ===== */
  if (p === '/sync/health' && req.method === 'GET') {
    sendJSON(res, 200, { ok: true, count: Object.keys(ledger).length, key: !!SYNC_KEY, accounts: Object.values(accounts).filter(x => !x.deleted).length }, req);
    return;
  }
  if (p === '/sync/push' && req.method === 'POST') {
    if (SYNC_KEY) {
      const k = req.headers['x-api-key'];
      if (typeof k !== 'string' || k !== SYNC_KEY) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
    }
    let body; try { body = await readBody(req); } catch (e) { sendJSON(res, 400, { ok: false, error: 'bad json' }, req); return; }
    (Array.isArray(body.records) ? body.records : []).forEach(mergeRecord);
    (Array.isArray(body.deleted) ? body.deleted : []).forEach(id => {
      if (id == null) return; delete ledger[id];
      if (!deleted.some(t => t.id === id)) deleted.push({ id, ts: Date.now() });
    });
    (Array.isArray(body.customers) ? body.customers : []).forEach(mergeCustomer);
    (Array.isArray(body.deletedCustomers) ? body.deletedCustomers : []).forEach(id => {
      if (id == null) return; delete customers[id];
      if (!deletedCustomers.some(t => t.id === id)) deletedCustomers.push({ id, ts: Date.now() });
    });
    (Array.isArray(body.finances) ? body.finances : []).forEach(mergeFinance);
    (Array.isArray(body.deletedFinances) ? body.deletedFinances : []).forEach(id => {
      if (id == null) return; delete finances[id];
      if (!deletedFinances.some(t => t.id === id)) deletedFinances.push({ id, ts: Date.now() });
    });
    persist();
    sendJSON(res, 200, { ok: true, serverTime: Date.now(), count: Object.keys(ledger).length }, req);
    return;
  }
  if (p === '/sync/pull' && req.method === 'GET') {
    if (SYNC_KEY) {
      const k = req.headers['x-api-key'];
      if (typeof k !== 'string' || k !== SYNC_KEY) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
    }
    let since = parseInt(url.searchParams.get('since') || '0', 10);
    if (!(since > 0)) since = 0;
    const srvTime = Date.now();
    sendJSON(res, 200, {
      ok: true, serverTime: srvTime, since,
      records: Object.values(ledger).filter(r => (r.ts || 0) > since),
      deleted: deleted.filter(t => t.ts > since).map(t => t.id),
      customers: Object.values(customers).filter(c => (c.updatedTs || 0) > since),
      deletedCustomers: deletedCustomers.filter(t => t.ts > since).map(t => t.id),
      finances: Object.values(finances).filter(f => (f.ts || 0) > since),
      deletedFinances: deletedFinances.filter(t => t.ts > since).map(t => t.id)
    }, req);
    return;
  }

  /* ===== 静态前端 ===== */
  if (p === '/' || p === '/index.html') {
    const idx = path.join(__dirname, 'index.html');
    serveFile(res, fs.existsSync(idx) ? idx : APP_HTML, req);
    return;
  }
  if (req.method === 'GET') {
    const cand = path.join(__dirname, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (cand.startsWith(__dirname) && fs.existsSync(cand) && fs.statSync(cand).isFile()) {
      serveFile(res, cand, req); return;
    }
  }
  sendJSON(res, 404, { ok: false, error: 'not found' }, req);
});

// /api/register 复用 /api/accounts POST 逻辑
function handleAccountsPost(req, res) {
  // 简化：直接在此实现（与上面 /api/accounts POST 同源）
  (async () => {
    const a = authUser(req);
    let b; try { b = await readBody(req); } catch (e) { sendJSON(res, 400, { ok: false, error: 'bad json' }, req); return; }
    const firstRun = Object.values(accounts).filter(x => !x.deleted).length === 0;
    if (!firstRun) {
      if (!a) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
      if (!can(a.role, 'account.manage')) { sendJSON(res, 403, { ok: false, error: 'forbidden' }, req); return; }
    }
    const username = (b.username || '').trim();
    const name = (b.name || '').trim();
    const role = b.role || 'registrar';
    const factories = Array.isArray(b.factories) ? b.factories : [];
    if (!username || !name) { sendJSON(res, 400, { ok: false, error: 'missing' }, req); return; }
    if (!['boss', 'devAdmin', 'factoryAdmin', 'registrar', 'auditor'].includes(role)) { sendJSON(res, 400, { ok: false, error: 'bad_role' }, req); return; }
    if (factories.length === 0) { sendJSON(res, 400, { ok: false, error: 'no_factory' }, req); return; }
    const existing = accounts[username];
    if (existing && !existing.deleted && !b.forceOverwrite) { sendJSON(res, 409, { ok: false, error: 'exists' }, req); return; }
    if (!b.password || !passwordStrong(b.password)) { sendJSON(res, 400, { ok: false, error: 'weak' }, req); return; }
    const salt = genSaltHex();
    accounts[username] = {
      username, name, role, factories: factories.slice(), salt,
      passwordHash: hashPassword(b.password, salt),
      mustChange: firstRun ? false : true, updatedTs: Date.now(), deleted: false
    };
    persist();
    sendJSON(res, 200, { ok: true, user: publicUser(accounts[username]) }, req);
  })();
}

function serveFile(res, file, req) {
  fs.readFile(file, (err, data) => {
    if (err) { sendJSON(res, 404, { ok: false, error: 'file not found' }, req); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ---------- 启动 ---------- */
loadSnapshot();
seedIfEmpty();
server.listen(PORT, HOST, () => {
  console.log('\n[app] RecycleFlow NG 一体化服务器已启动: http://%s:%d', HOST, PORT);
  console.log('[app] 前端: 打开上方地址即可使用（账号服务端权威，天然跨设备一致）');
  console.log('[sync] API Key: %s', SYNC_KEY ? '(已设置，公网安全)' : '(空=免鉴权，仅建议局域网)');
  console.log('[sync] 多厂区可访问 http://<本机局域网IP>:%d 进行联网\n', PORT);
});
