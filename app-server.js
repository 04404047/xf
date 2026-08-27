#!/usr/bin/env node
/* 塑料回收收发货管理 — 一体化部署服务器（零依赖，仅用 Node 内置模块）
 *
 * 单进程同时提供：
 *  1) 静态前端：在 / 与 /index.html 提供单文件应用 塑料回收收发货管理.html
 *  2) 中央同步 API：/sync/* 多厂区账本（LWW 合并 + 删除墓碑）
 *
 * 这样部署后，打开 http://<服务器>:PORT 即是「带联网功能的完整网站」，
 * 前端会通过同源探测自动把同步服务器指向本机，无需手动配置。
 *
 * 运行：  node app-server.js                 (默认端口 8787，监听 0.0.0.0)
 *        PORT=8080 SYNC_KEY=xxx node app-server.js
 *
 * 接口：
 *  GET  /sync/health                        -> {ok,count}        (无需鉴权，供前端同源探测)
 *  POST /sync/push  {factory, records[], deleted[]}  -> {ok, serverTime}
 *  GET  /sync/pull?since=T                  -> {ok, records[], deleted[]}
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';
// 默认空密钥 = 免鉴权（适用于同源一体化部署，autoDetectSync 自动连接）。
// 公网多租户部署请务必通过 SYNC_KEY 环境变量设置一个强密钥，并在 App 设置里填同样的密钥。
const SYNC_KEY = process.env.SYNC_KEY || '';
const DATA_FILE = process.env.SYNC_DATA_FILE || path.join(__dirname, 'sync-data.json');
const APP_HTML = path.join(__dirname, 'index.html');

/* ---------- 状态 ---------- */
let ledger = {};        // id -> record
// 墓碑：{id, ts} 数组（ts=删除发生时间，用于增量 pull）；载入时兼容旧版纯字符串数组
let deleted = [];
let usersById = {};     // username -> user（账号主数据，跨厂区同步）
let customersById = {}; // id -> customer（客户主数据，跨厂区同步）
let deletedUsers = [];  // 已删除账号 {username, ts}（墓碑）
let deletedCustomers = []; // 已删除客户 {id, ts}（墓碑）
let financesById = {};  // id -> finance（财务主数据，跨厂区同步，支持老板全局汇总）
let deletedFinances = []; // 已删除财务 {id, ts}（墓碑）
/* —— 价格主数据 / 产品目录 / 库存校正：服务端权威持久化，使各厂独立定价与库存校正跨重启、跨设备一致 ——
   priceBy：按厂区分桶 {Sagamu:{},OPIC:{},Ikeja:{}}；products：成品种类·颜色总目录；
   priceHist：调价历史；invAdjust/invAdjustRaw/invRawEdit/invPelletEdit：库存校正覆盖。 */
let priceBy = { Sagamu: {}, OPIC: {}, Ikeja: {} };
let products = {};
let priceHist = [];
let invAdjust = {};
let invAdjustRaw = {};
let invRawEdit = {};
let invPelletEdit = {};
/* 库存删除墓碑：kind -> {key: deleteTs}。让"删除库存条目"跨设备生效、且不被合并存储复活
   （被删的键在 push 中 absent，Object.assign 合并不会移除它，必须由墓碑显式剔除）。 */
let invDeleted = { raw:{}, pellet:{} };
/* 账号「服务端权威」主数据：username -> {username,name,role,factories,salt,passwordHash,mustChange,updatedTs,deleted}
   所有登录/改密/建号均由服务器落盘，天然跨设备一致（彻底根治党本"换设备登不上/改密不生效"）。
   注意：与 usersById 并存；usersById 保留仅用于旧版业务同步兼容，不参与登录校验。 */
let accounts = {};

/* 墓碑归一化：兼容旧版 ['id1','id2'] 与新版 [{id,ts}] 两种格式，统一为对象数组 */
function normTomb(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(x => (typeof x === 'string' ? { id: x, ts: 0 } : { id: x.id, ts: x.ts || 0 }));
}
try {
  if (fs.existsSync(DATA_FILE)) {
    let raw = fs.readFileSync(DATA_FILE, 'utf8');
    if (raw.startsWith('ENC:')) raw = decryptData(raw.slice(4));
    const d = JSON.parse(raw);
    ledger = d.ledger || {};
    deleted = normTomb(d.deleted);
    usersById = d.usersById || {};
    customersById = d.customersById || {};
    deletedUsers = normTomb(d.deletedUsers);
    deletedCustomers = normTomb(d.deletedCustomers);
    financesById = d.financesById || {};
    deletedFinances = normTomb(d.deletedFinances);
    if (d.accounts && typeof d.accounts === 'object') accounts = d.accounts;
    if (d.priceBy && typeof d.priceBy === 'object') priceBy = d.priceBy;
    if (d.products && typeof d.products === 'object') products = d.products;
    if (Array.isArray(d.priceHist)) priceHist = d.priceHist;
    if (d.invAdjust && typeof d.invAdjust === 'object') invAdjust = d.invAdjust;
    if (d.invAdjustRaw && typeof d.invAdjustRaw === 'object') invAdjustRaw = d.invAdjustRaw;
    if (d.invRawEdit && typeof d.invRawEdit === 'object') invRawEdit = d.invRawEdit;
    if (d.invPelletEdit && typeof d.invPelletEdit === 'object') invPelletEdit = d.invPelletEdit;
    if (d.invDeleted && typeof d.invDeleted === 'object') invDeleted = { raw: (d.invDeleted.raw || {}), pellet: (d.invDeleted.pellet || {}) };
    console.log('[sync] 已载入本地账本：%d 条记录，%d 条删除墓碑；账号 %d；客户 %d；财务 %d',
      Object.keys(ledger).length, deleted.length, Object.keys(usersById).length, Object.keys(customersById).length, Object.keys(financesById).length);
  }
} catch (e) { console.warn('[sync] 载入数据失败，重新开始：', e.message); }

/* ---------- 账号种子（仅首次启动写入；运行时仅存哈希） ---------- */
const SEED_ACCOUNTS = [
  { username: 'boss@xf.com',         name: '黄总（老板）', role: 'boss',         factories: ['Sagamu', 'OPIC', 'Ikeja'], pw: '8wN2JCnDhHFc54W^', mustChange: true },
  { username: 'admin.sagamu@xf.com', name: 'Sagamu 管理员', role: 'factoryAdmin', factories: ['Sagamu'], pw: '6YeiMsxBA#gU2PAD', mustChange: true },
  { username: 'admin.opic@xf.com',   name: 'OPIC 管理员',   role: 'factoryAdmin', factories: ['OPIC'],    pw: '&SFb32Y9YTBzhq#L', mustChange: true },
  { username: 'admin.ikeja@xf.com',  name: 'Ikeja 管理员',  role: 'factoryAdmin', factories: ['Ikeja'],   pw: 'G3VW%7kvh!cK4L7r', mustChange: true },
  { username: 'reg.sagamu@xf.com',   name: 'Sagamu 登记员', role: 'registrar',   factories: ['Sagamu'], pw: 'nQH4uiizAJA@Hpn^', mustChange: true },
  { username: 'auditor@xf.com',      name: '审计员',         role: 'auditor',      factories: ['Sagamu', 'OPIC', 'Ikeja'], pw: '8GaqmC3an8sK&3#B', mustChange: true },
  { username: '管理员',              name: '管理员',         role: 'devAdmin',    factories: ['Sagamu', 'OPIC', 'Ikeja'], pw: 'ZsCt##Ps3JmgwFkz', mustChange: true }
];
const PBKDF2_ITER = 60000;
const PW_V2 = '$pbkdf2$';
function genSaltHex() { return crypto.randomBytes(16).toString('hex'); }
function hashPassword(pw, saltHex) {
  const d = crypto.pbkdf2Sync(Buffer.from(pw, 'utf8'), Buffer.from(saltHex, 'hex'), PBKDF2_ITER, 32, 'sha256');
  return PW_V2 + PBKDF2_ITER + '$' + saltHex + '$' + d.toString('hex');
}
function verifyPassword(pw, saltHex, hashHex) {
  try {
    if (typeof hashHex === 'string' && hashHex.indexOf(PW_V2) === 0) {
      const p = hashHex.split('$');
      const iter = parseInt(p[2], 10) || PBKDF2_ITER;
      const d = crypto.pbkdf2Sync(Buffer.from(pw, 'utf8'), Buffer.from(p[3], 'hex'), iter, 32, 'sha256').toString('hex');
      return d === p[4];
    }
  } catch (e) {}
  return false;
}
function passwordStrong(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return false;
  if (!/[a-zA-Z]/.test(pw)) return false;
  if (!/[0-9]/.test(pw)) return false;
  return true;
}
/* 首次启动若磁盘无账号，写入种子账号（注意：业务 ledger 为空但有账号不视为 firstRun 冲突） */
function seedAccountsIfEmpty() {
  if (Object.keys(accounts).length > 0) return;
  SEED_ACCOUNTS.forEach(a => {
    const salt = genSaltHex();
    accounts[a.username] = {
      username: a.username, name: a.name, role: a.role, factories: a.factories.slice(),
      salt, passwordHash: hashPassword(a.pw, salt), mustChange: !!a.mustChange, updatedTs: Date.now(), deleted: false
    };
  });
  console.log('[auth] 首次启动：初始化默认账号（请尽快登录并修改初始密码）');
  SEED_ACCOUNTS.forEach(a => console.log('       ' + a.username + '  [' + a.role + ']  初始密码: ' + a.pw));
  persist();
}
/* 对外返回账号（登录/me 带 verifier 供离线缓存；列表不带密码） */
function publicUser(a, withVerifier) {
  const o = { username: a.username, name: a.name, role: a.role, factories: a.factories.slice(), mustChange: !!a.mustChange };
  if (withVerifier) o.verifier = a.salt + '$' + a.passwordHash;
  return o;
}

let saveTimer = null;
/* 落盘脱敏：配置了 SYNC_KEY 时，用 AES-256-GCM（密钥由 SYNC_KEY 派生）加密磁盘文件，
   避免明文 JSON（含账号密码哈希）意外泄露；未配置密钥则明文存储并提示风险。 */
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
  if (parts.length !== 3) return str; // 非加密内容（或旧明文）
  try {
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[1], 'base64');
    const enc = Buffer.from(parts[2], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (e) { return str; }
}
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const plain = JSON.stringify({ ledger, deleted, usersById, customersById, deletedUsers, deletedCustomers, financesById, deletedFinances, accounts, priceBy, products, priceHist, invAdjust, invAdjustRaw, invRawEdit, invPelletEdit, invDeleted }, null, 0);
    const packed = encryptData(plain);
    const tmp = DATA_FILE + '.tmp';
    /* 先写临时文件再原子 rename，避免进程崩溃/断电时损坏数据文件 */
    fs.writeFile(tmp, packed.enc ? ('ENC:' + packed.data) : plain, (err) => {
      if (err) { console.warn('[sync] 写入失败：', err.message); return; }
      fs.rename(tmp, DATA_FILE, (e2) => { if (e2) console.warn('[sync] 重命名失败：', e2.message); });
    });
  }, 300);
}

/* ---------- 工具 ---------- */
/* CORS 限源：仅允许与服务器同 Host 的来源（即由本服务器托管的页面），
   阻断任意第三方网站跨站读取/写入同步数据；可用 SYNC_CORS_ORIGIN 显式放行额外源。 */
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
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin',
    'Cache-Control': 'no-store' // 禁止缓存同步 API 响应，避免 /sync/pull 返回陈旧数据导致"清缓存前数据不同步"
  };
  // 同源/白名单来源才回显；否则置 'null' 由浏览器拒绝跨站访问
  headers['Access-Control-Allow-Origin'] = origin || 'null';
  headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Api-Key';
  headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
  res.writeHead(code, headers);
  res.end(body);
}
function authOk(req) {
  // 未配置密钥时为免鉴权模式（同源一体化部署默认），配置后必须密钥匹配
  if (!SYNC_KEY) return true;
  const k = req.headers['x-api-key'];
  return typeof k === 'string' && k === SYNC_KEY;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 32 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.png': 'image/png', '.svg': 'image/svg+xml' };

/* ---------- 合并逻辑（LWW：ts 大者胜；相同则 rev 大者胜） ----------
   墓碑优先：一旦 id 进入 deleted（含老板/开发管理员删除），任何后续推送都
   不得将其复活——这是修复「老板删除后被同步复原」的关键。 */
function mergeRecord(rec) {
  if (!rec || rec.id == null) return;
  if (deleted.indexOf(rec.id) >= 0) return; // 墓碑中的记录永不复活
  const cur = ledger[rec.id];
  const ts = rec.ts || 0, rev = rec.rev || 0;
  const cts = cur ? (cur.ts || 0) : -1, crev = cur ? (cur.rev || 0) : -1;
  if (!cur || ts > cts || (ts === cts && rev > crev)) {
    ledger[rec.id] = rec;
  }
}
/* 账号合并：按 username 做 LWW（updatedTs 大者胜），使新账号可在任意设备登录 */
function mergeUser(u) {
  if (!u || u.username == null) return;
  if (deletedUsers.indexOf(u.username) >= 0) return;
  const cur = usersById[u.username];
  if (!cur || (u.updatedTs || 0) > (cur.updatedTs || 0)) usersById[u.username] = u;
}
/* 客户合并：按 id 做 LWW（updatedTs 大者胜），使分厂客户可在老板账号查看 */
function mergeCustomer(c) {
  if (!c || c.id == null) return;
  if (deletedCustomers.indexOf(c.id) >= 0) return;
  const cur = customersById[c.id];
  if (!cur || (c.updatedTs || 0) > (cur.updatedTs || 0)) customersById[c.id] = c;
}
/* 财务合并：按 id 做 LWW（ts 大者胜），使三厂财务可在老板账号全局汇总 */
function mergeFinance(f) {
  if (!f || f.id == null) return;
  if (deletedFinances.indexOf(f.id) >= 0) return;
  const cur = financesById[f.id];
  if (!cur || (f.ts || 0) > (cur.ts || 0)) financesById[f.id] = f;
}
/* 库存合并（带删除墓碑拦截）：等价于 Object.assign 的"加/覆盖"，但跳过已被 invDeleted 标记删除的键，
   确保某设备在被删后、尚未拉取墓碑前再次 push 旧键时，服务端不会将其复活。 */
function mergeInv(target, src, kind) {
  if (!src || typeof src !== 'object') return;
  Object.keys(src).forEach(function (k) {
    if (invDeleted[kind] && (invDeleted[kind][k] || 0) > 0) return;
    target[k] = src[k];
  });
}

/* ---------- 账号权威：Token 与鉴权 ---------- */
const tokens = {}; // token -> {username, exp}
function issueToken(username) {
  const t = crypto.randomBytes(24).toString('hex');
  tokens[t] = { username, exp: Date.now() + 12 * 3600 * 1000 };
  return t;
}
function authUser(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return null;
  const info = tokens[m[1]];
  if (!info || info.exp < Date.now()) { delete tokens[m[1]]; return null; }
  return accounts[info.username] && !accounts[info.username].deleted ? accounts[info.username] : null;
}
/* 角色权限（最小集，仅用于后端接口保护；前端 RBAC 仍以前端 ROLE_PERMS 为准） */
const ROLE_PERMS = {
  boss: ['account.manage'], devAdmin: ['account.manage'],
  factoryAdmin: ['account.manage'], registrar: [], auditor: []
};
function can(role, perm) { return (ROLE_PERMS[role] || []).includes(perm); }

/* ---------- 路由 ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // CORS 预检
  if (req.method === 'OPTIONS') { sendJSON(res, 204, {}, req); return; }

  // 健康检查（无需鉴权，供前端同源探测自动启用同步）
  if (p === '/sync/health' && req.method === 'GET') {
    sendJSON(res, 200, { ok: true, count: Object.keys(ledger).length, key: !!SYNC_KEY, accounts: Object.keys(accounts).length }, req);
    return;
  }

  /* ================= 账号「服务端权威」API ================= */
  // 登录（服务器校验，天然跨设备一致）
  if (p === '/api/login' && req.method === 'POST') {
    let b; try { b = await readBody(req); } catch (e) { sendJSON(res, 400, { ok: false, error: 'bad json' }, req); return; }
    const u = accounts[(b.username || '').trim()];
    if (!u || u.deleted) { sendJSON(res, 401, { ok: false, error: 'bad_credentials' }, req); return; }
    if (!verifyPassword(b.password || '', u.salt, u.passwordHash)) { sendJSON(res, 401, { ok: false, error: 'bad_credentials' }, req); return; }
    const token = issueToken(u.username);
    sendJSON(res, 200, { ok: true, token, user: publicUser(u, true) }, req);
    return;
  }
  // 当前账号信息（带 verifier 供离线缓存）
  if (p === '/api/me' && req.method === 'GET') {
    const a = authUser(req);
    if (!a) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
    sendJSON(res, 200, { ok: true, user: publicUser(a, true) }, req);
    return;
  }
  // 改密（已认证会话；mustChange 时可免旧密码）
  if (p === '/api/change-password' && req.method === 'POST') {
    const a = authUser(req);
    if (!a) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
    let b; try { b = await readBody(req); } catch (e) { sendJSON(res, 400, { ok: false, error: 'bad json' }, req); return; }
    if (!a.mustChange && !verifyPassword(b.oldPassword || '', a.salt, a.passwordHash)) { sendJSON(res, 400, { ok: false, error: 'old_wrong' }, req); return; }
    if (!passwordStrong(b.newPassword || '')) { sendJSON(res, 400, { ok: false, error: 'weak' }, req); return; }
    const salt = genSaltHex();
    a.salt = salt; a.passwordHash = hashPassword(b.newPassword, salt); a.mustChange = false; a.updatedTs = Date.now();
    persist();
    const token = issueToken(a.username);
    sendJSON(res, 200, { ok: true, token, user: publicUser(a, true) }, req);
    return;
  }
  // 账号列表（需 account.manage）
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
  // 新建/注册账号（需 account.manage；或系统尚无任何账号时自助注册首账号=老板）
  if (p === '/api/accounts' && req.method === 'POST') {
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
    if (accounts[username] && !accounts[username].deleted && !b.forceOverwrite) { sendJSON(res, 409, { ok: false, error: 'exists' }, req); return; }
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
  // 删除账号（需 account.manage；保护 boss/devAdmin）
  if (p.startsWith('/api/accounts/') && req.method === 'DELETE') {
    const a = authUser(req);
    if (!a) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
    if (!can(a.role, 'account.manage')) { sendJSON(res, 403, { ok: false, error: 'forbidden' }, req); return; }
    const target = decodeURIComponent(p.slice('/api/accounts/'.length));
    const t = accounts[target];
    if (!t || t.deleted) { sendJSON(res, 404, { ok: false, error: 'not_found' }, req); return; }
    if (t.role === 'boss' || t.role === 'devAdmin') { sendJSON(res, 400, { ok: false, error: 'protected' }, req); return; }
    t.deleted = true; t.updatedTs = Date.now();
    persist();
    sendJSON(res, 200, { ok: true }, req);
    return;
  }

  // 推送
  if (p === '/sync/push' && req.method === 'POST') {
    if (!authOk(req)) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
    let body;
    try { body = await readBody(req); } catch (e) { sendJSON(res, 400, { ok: false, error: 'bad json' }, req); return; }
    const recs = Array.isArray(body.records) ? body.records : [];
    recs.forEach(mergeRecord);
    const del = Array.isArray(body.deleted) ? body.deleted : [];
    const now = Date.now();
    del.forEach(id => {
      if (id == null) return;
      delete ledger[id];
      if (deleted.findIndex(t => t.id === id) < 0) deleted.push({ id, ts: now });
    });
    // 账号同步
    (Array.isArray(body.users) ? body.users : []).forEach(mergeUser);
    (Array.isArray(body.deletedUsers) ? body.deletedUsers : []).forEach(un => {
      if (un == null) return;
      delete usersById[un];
      if (deletedUsers.findIndex(t => t.id === un) < 0) deletedUsers.push({ id: un, ts: now });
    });
    // 客户同步
    (Array.isArray(body.customers) ? body.customers : []).forEach(mergeCustomer);
    (Array.isArray(body.deletedCustomers) ? body.deletedCustomers : []).forEach(cid => {
      if (cid == null) return;
      delete customersById[cid];
      if (deletedCustomers.findIndex(t => t.id === cid) < 0) deletedCustomers.push({ id: cid, ts: now });
    });
    // 财务同步
    (Array.isArray(body.finances) ? body.finances : []).forEach(mergeFinance);
    (Array.isArray(body.deletedFinances) ? body.deletedFinances : []).forEach(fid => {
      if (fid == null) return;
      delete financesById[fid];
      if (deletedFinances.findIndex(t => t.id === fid) < 0) deletedFinances.push({ id: fid, ts: now });
    });
    /* 价格主数据（按厂区分别并入，Object.assign 合并避免跨厂互相覆盖/清空） */
    if (body.priceBy && typeof body.priceBy === 'object') {
      ['Sagamu', 'OPIC', 'Ikeja'].forEach(fac => {
        if (!priceBy[fac]) priceBy[fac] = {};
        if (body.priceBy[fac] && typeof body.priceBy[fac] === 'object') priceBy[fac] = Object.assign(priceBy[fac], body.priceBy[fac]);
      });
    }
    if (body.products && typeof body.products === 'object' && Object.keys(body.products).length) products = body.products;
    if (Array.isArray(body.priceHist)) priceHist = body.priceHist;
    /* 库存删除墓碑：被删的键在 push body 中 absent，Object.assign 合并不会移除它，
       故先依据 invDeleted 显式剔除（删除时间戳>0 才生效，取较新者），并阻止后续合并重新加回。 */
    const incInvDeleted = (body.invDeleted && typeof body.invDeleted === 'object') ? body.invDeleted : {};
    ['raw', 'pellet'].forEach(function (kind) {
      const rk = incInvDeleted[kind] || {};
      Object.keys(rk).forEach(function (key) {
        const ts = rk[key] || 0;
        invDeleted[kind] = invDeleted[kind] || {};
        if (ts <= 0) {
          /* 客户端显式解除墓碑（重新入库/编辑时发 ts=0 标记）：清除服务端墓碑与残留键，
             随后由下方 mergeInv 用 body 中的新值将该键重新加回。仅此显式信号才允许复活，
             普通同步（body 不含该键的墓碑）不会清除墓碑，从而防止陈旧推送复活已删条目。 */
          if (invDeleted[kind][key]) delete invDeleted[kind][key];
          if (kind === 'raw') { delete invAdjustRaw[key]; delete invRawEdit[key]; }
          else { delete invAdjust[key]; delete invPelletEdit[key]; }
          return;
        }
        if (kind === 'raw') { delete invAdjustRaw[key]; delete invRawEdit[key]; if (body.invAdjustRaw) delete body.invAdjustRaw[key]; if (body.invRawEdit) delete body.invRawEdit[key]; }
        else { delete invAdjust[key]; delete invPelletEdit[key]; if (body.invAdjust) delete body.invAdjust[key]; if (body.invPelletEdit) delete body.invPelletEdit[key]; }
        if ((invDeleted[kind][key] || 0) < ts) invDeleted[kind][key] = ts;
      });
    });
    if (body.invAdjust && typeof body.invAdjust === 'object') mergeInv(invAdjust, body.invAdjust, 'pellet');
    if (body.invAdjustRaw && typeof body.invAdjustRaw === 'object') mergeInv(invAdjustRaw, body.invAdjustRaw, 'raw');
    if (body.invRawEdit && typeof body.invRawEdit === 'object') mergeInv(invRawEdit, body.invRawEdit, 'raw');
    if (body.invPelletEdit && typeof body.invPelletEdit === 'object') mergeInv(invPelletEdit, body.invPelletEdit, 'pellet');
    persist();
    sendJSON(res, 200, { ok: true, serverTime: Date.now(), count: Object.keys(ledger).length }, req);
    return;
  }

  // 拉取（增量：since 之后的变更才返回，避免数据增长后每次全量下发）
  if (p === '/sync/pull' && req.method === 'GET') {
    if (!authOk(req)) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
    let since = parseInt(url.searchParams.get('since') || '0', 10);
    if (!(since > 0)) since = 0;
    const srvTime = Date.now();
    const incRecords = Object.values(ledger).filter(r => (r.ts || 0) > since);
    const incUsers = Object.values(usersById).filter(u => (u.updatedTs || 0) > since);
    const incCustomers = Object.values(customersById).filter(c => (c.updatedTs || 0) > since);
    const incFinances = Object.values(financesById).filter(f => (f.ts || 0) > since);
    // 墓碑：仅返回删除时间晚于 since 的（首次 since=0 全量下发，保证历史清理一致）
    const incDeleted = deleted.filter(t => t.ts > since).map(t => t.id);
    const incDelUsers = deletedUsers.filter(t => t.ts > since).map(t => t.id);
    const incDelCustomers = deletedCustomers.filter(t => t.ts > since).map(t => t.id);
    const incDelFinances = deletedFinances.filter(t => t.ts > since).map(t => t.id);
    sendJSON(res, 200, {
      ok: true,
      serverTime: srvTime,
      since,
      records: incRecords,
      deleted: incDeleted,
      users: incUsers,
      customers: incCustomers,
      deletedUsers: incDelUsers,
      deletedCustomers: incDelCustomers,
      finances: incFinances,
      deletedFinances: incDelFinances,
      priceBy: priceBy,
      products: products,
      priceHist: priceHist,
      invAdjust: invAdjust,
      invAdjustRaw: invAdjustRaw,
      invRawEdit: invRawEdit,
      invPelletEdit: invPelletEdit,
      invDeleted: invDeleted
    }, req);
    return;
  }

  // 静态前端（优先 index.html，兼容标准托管平台；回退到原始文件名）
  if (p === '/' || p === '/index.html') {
    const idx = path.join(__dirname, 'index.html');
    serveFile(res, fs.existsSync(idx) ? idx : APP_HTML, req);
    return;
  }
  // 其它静态文件（可选）
  if (req.method === 'GET') {
    const cand = path.join(__dirname, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (cand.startsWith(__dirname) && fs.existsSync(cand) && fs.statSync(cand).isFile()) {
      serveFile(res, cand, req);
      return;
    }
  }

  sendJSON(res, 404, { ok: false, error: 'not found' }, req);
});

function serveFile(res, file, req) {
  fs.stat(file, (err, st) => {
    if (err) { sendJSON(res, 404, { ok: false, error: 'file not found' }, req); return; }
    const ext = path.extname(file).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // SPA 外壳（html/js/css）禁止强缓存：每次请求都向服务器校验；
    // 重新部署后文件 mtime 变化即返回最新内容，用户无需手动清浏览器缓存。
    if (ext === '.html' || ext === '.js' || ext === '.css') {
      headers['Cache-Control'] = 'no-cache';
      headers['Last-Modified'] = st.mtime.toUTCString();
      const inmMs = req.headers['if-modified-since'] ? Date.parse(req.headers['if-modified-since']) : NaN;
      // 以秒为粒度比较（Last-Modified/If-Modified-Since 仅秒精度）：未变化则回 304，已重新部署（mtime 进入新秒）则回 200 最新内容
      if (!isNaN(inmMs) && Math.floor(inmMs / 1000) >= Math.floor(st.mtimeMs / 1000)) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
    } else {
      // 图片等静态资源可短期缓存（内容通常不随部署变化）
      headers['Cache-Control'] = 'public, max-age=86400';
    }
    fs.readFile(file, (e2, data) => {
      if (e2) { sendJSON(res, 404, { ok: false, error: 'file not found' }, req); return; }
      res.writeHead(200, headers);
      res.end(data);
    });
  });
}

server.listen(PORT, HOST, () => {
  seedAccountsIfEmpty();
  console.log('[app] 一体化部署服务器已启动: http://%s:%d', HOST, PORT);
  console.log('[app] 前端: 打开上方地址即可使用（账号服务端权威，天然跨设备一致）');
  console.log('[sync] API Key: %s', SYNC_KEY);
  console.log('[sync] 多厂区可访问 http://<本机局域网IP>:%d 进行联网', PORT);
});
