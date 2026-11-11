/**
 * DeskFlow DSH Plugin (server side)
 *
 * 把 Deskflow 键鼠共享能力做成 DeepSeek Harness 插件：
 * - 局域网自动发现：UDP 40801 广播，协议与 Deskflow fork 内置 C++ 版一致
 *   （{proto:'deepseek-harness', ver:1, instance, name, port, leaving}，1.5s 周期，6s 超时）
 * - 角色协商连接：Web 面板里选服务端/客户端，写 Deskflow QSettings ini 后拉起 deskflow.exe
 * - RPC：/api/deskflow（status/peers/discovery/connect/stop/scan），供 client.js 面板调用
 * - Tools：deskflow_status / deskflow_scan_peers / deskflow_connect / deskflow_disconnect
 */

import dgram from 'dgram';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { randomUUID } from 'crypto';

export const inject = ['tools', 'connection'];

// ─── 常量 ────────────────────────────────────────────────────────────────────
const DISCOVERY_PORT = 40801;
const ANNOUNCE_INTERVAL_MS = 1500;
const PEER_TIMEOUT_MS = 6000;
const DISCOVERY_PROTO = 'deepseek-harness';

const DEFAULT_BACKEND_DIR = `${os.homedir()}/.dsh/deskflow-backend`;
const DEFAULT_CORE_PORT = 24800;

function confPath() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'DeepSeek Harness', 'DeepSeek Harness.conf');
}

// 服务端配置文件（synergy 格式），与 QSettings conf 同目录
function serverConfPath() {
  return path.join(path.dirname(confPath()), 'deskflow-server.conf');
}

function backendDir(config) {
  return (typeof config?.backendDir === 'string' && config.backendDir) || DEFAULT_BACKEND_DIR;
}

function coreExePath(config) {
  return path.join(backendDir(config), 'deskflow-core.exe');
}

function guiExePath(config) {
  return path.join(backendDir(config), 'deskflow.exe');
}

function launchMode(config) {
  return config?.launchMode === 'gui' ? 'gui' : 'headless';
}

// 对端屏幕相对本机服务端屏幕的方向
function layoutDir(config) {
  return ['right', 'left', 'top', 'bottom'].includes(config?.layout) ? config.layout : 'right';
}

// ─── 发现状态（模块级，随 DSH host 进程存续）─────────────────────────────────
const instanceId = randomUUID();
const selfName = os.hostname();
// 插件版本（与 package.json 同步；status 返回给面板显示 "Host vX"，排查 host 未重载）
const PLUGIN_VERSION = '1.1.0';
const peers = new Map(); // instance -> {instance, name, ip, port, lastSeen}

let socket = null;
let announceTimer = null;
let pruneTimer = null;
let restartTimer = null;
let deskflowChild = null;
let corePort = DEFAULT_CORE_PORT;
let discoveryEnabled = true; // 自动发现开关（RPC discovery 控制广播与记录）

// ─── UDP 发现（复刻 C++ LanDiscovery 协议）──────────────────────────────────
function broadcastTargets() {
  const targets = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list || []) {
      if (it.family === 'IPv4' && !it.internal && it.broadcast) targets.add(it.broadcast);
    }
  }
  return [...targets];
}

function announce(leaving = false) {
  if (!socket) return;
  if (!discoveryEnabled && !leaving) return; // 关闭发现：停止广播（退出时的 leaving 除外）
  const msg = Buffer.from(JSON.stringify({
    proto: DISCOVERY_PROTO,
    ver: 1,
    instance: instanceId,
    name: selfName,
    port: corePort,
    leaving,
  }));
  for (const target of broadcastTargets()) {
    try { socket.send(msg, DISCOVERY_PORT, target); } catch { /* 忽略单接口发送失败 */ }
  }
}

function stopDiscovery() {
  if (announceTimer) { clearInterval(announceTimer); announceTimer = null; }
  if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (socket) {
    try { announce(true); } catch { /* 尽力而为 */ }
    try { socket.close(); } catch { /* already closed */ }
    socket = null;
  }
}

function startDiscovery(config) {
  if (socket) return;
  corePort = Number(config?.port) > 0 ? Number(config.port) : DEFAULT_CORE_PORT;
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket = sock;
  sock.on('message', (buf, rinfo) => {
    if (!discoveryEnabled) return; // 关闭发现：包仍接收但忽略不记录
    let msg;
    try { msg = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.proto !== DISCOVERY_PROTO || typeof msg.instance !== 'string' || !msg.instance) return;
    if (msg.instance === instanceId) return; // 过滤自己（含 C++ 端共享端口场景）
    if (msg.leaving) { peers.delete(msg.instance); return; }
    peers.set(msg.instance, {
      instance: msg.instance,
      name: typeof msg.name === 'string' && msg.name ? msg.name : 'unknown',
      ip: rinfo.address,
      port: Number(msg.port) > 0 ? Number(msg.port) : DEFAULT_CORE_PORT,
      lastSeen: Date.now(),
    });
  });
  sock.on('error', () => {
    // 绑定失败（端口被独占）等情况：10s 后重试
    stopDiscovery();
    restartTimer = setTimeout(() => { if (discoveryEnabled) { try { startDiscovery(config); } catch { /* 保持静默 */ } } }, 10000);
  });
  sock.bind(DISCOVERY_PORT, () => {
    try { sock.setBroadcast(true); } catch { /* 部分平台默认已允许 */ }
  });
  announceTimer = setInterval(() => announce(false), ANNOUNCE_INTERVAL_MS);
  pruneTimer = setInterval(prunePeers, 2000);
  announce(false);
}

function prunePeers() {
  const now = Date.now();
  for (const [k, v] of peers) {
    if (now - v.lastSeen > PEER_TIMEOUT_MS) peers.delete(k);
  }
}

// ─── 发现开关（面板「自动发现」）─────────────────────────────────────────────
// 关闭：停广播/清空 peers（socket 保持监听但忽略新包）；开启：恢复广播与记录。
function setDiscovery(on, config) {
  discoveryEnabled = !!on;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (!discoveryEnabled) {
    if (announceTimer) { clearInterval(announceTimer); announceTimer = null; }
    if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
    peers.clear();
  } else if (socket) {
    if (!announceTimer) announceTimer = setInterval(() => announce(false), ANNOUNCE_INTERVAL_MS);
    if (!pruneTimer) pruneTimer = setInterval(prunePeers, 2000);
    announce(false);
  } else {
    try { startDiscovery(config); } catch { /* 保持静默 */ }
  }
  return discoveryEnabled;
}

function peerList() {
  const now = Date.now();
  return [...peers.values()]
    .filter(p => now - p.lastSeen <= PEER_TIMEOUT_MS)
    .map(p => ({ instance: p.instance, name: p.name, ip: p.ip, port: p.port, ageMs: now - p.lastSeen }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Deskflow conf（QSettings ini）写入 ─────────────────────────────────────
// 键：core/coreMode（0=None 1=Client 2=Server）、client/remoteHost、gui/startCoreWithGui
// 采用"就地更新 + 缺失追加"的方式打补丁，保留原文件其他键与 BOM。
function patchConf(updates) {
  const file = confPath();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* 首次运行可能不存在 */ }
  const hadBom = text.charCodeAt(0) === 0xFEFF;
  if (hadBom) text = text.slice(1);

  const lines = text.split(/\r?\n/);
  const pending = new Map(Object.entries(updates).map(([sec, kvs]) => [sec, new Map(Object.entries(kvs))]));

  let current = '';
  for (let i = 0; i < lines.length; i++) {
    const secM = lines[i].match(/^\s*\[([^\]]+)\]\s*$/);
    if (secM) { current = secM[1].trim(); continue; }
    const kvM = lines[i].match(/^\s*([^=\[\];#]+?)\s*=/);
    if (!kvM) continue;
    const key = kvM[1].trim();
    const secKvs = pending.get(current);
    if (secKvs && secKvs.has(key)) {
      lines[i] = `${key}=${secKvs.get(key)}`;
      secKvs.delete(key);
      if (secKvs.size === 0) pending.delete(current);
    }
  }

  const append = [];
  for (const [sec, kvs] of pending) {
    append.push(`[${sec}]`);
    for (const [k, v] of kvs) append.push(`${k}=${v}`);
  }
  const out = lines.filter((l, i) => !(i === lines.length - 1 && l === '')).concat(append);
  const body = out.join('\r\n') + '\r\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, (hadBom ? '\uFEFF' : '') + body, 'utf8');
  return file;
}

// 服务端角色：登记屏幕。core 的 Config::read 从通用配置的 [computer_N] 分组读取已知屏幕
// （Settings::knownComputers），server config 文件的 links 只能引用这里出现过的名字。
// 同时更新 [internalConfig] screens 网格（fork GUI 兼容）。
// Computer::loadSettings 只读 name，其余键走默认值。
function addServerScreen(peerName) {
  if (!peerName) return false;
  const file = confPath();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  const hadBom = text.charCodeAt(0) === 0xFEFF;
  const body = hadBom ? text.slice(1) : text;
  const lines = body.split(/\r?\n/);

  // 1) internalConfig 网格：对端占一个空位（或扩容），保持 GUI 兼容
  let inSection = false;
  let size = 0;
  const names = new Map(); // index -> line number
  let sizeLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const secM = lines[i].match(/^\s*\[([^\]]+)\]\s*$/);
    if (secM) { inSection = secM[1].trim() === 'internalConfig'; continue; }
    if (!inSection) continue;
    const szM = lines[i].match(/^\s*screens\\size\s*=\s*(\d+)\s*$/);
    if (szM) { size = parseInt(szM[1], 10); sizeLine = i; continue; }
    const nmM = lines[i].match(/^\s*screens\\(\d+)\\name\s*=(.*)$/);
    if (nmM) names.set(parseInt(nmM[1], 10), i);
  }
  if (size > 0 && sizeLine >= 0) {
    let done = false;
    // 已存在同名屏幕则跳过
    for (const [, lineIdx] of names) {
      const m = lines[lineIdx].match(/=(.*)$/);
      if (m && m[1].trim() === peerName) { done = true; break; }
    }
    if (!done) {
      // 找第一个空位
      for (let i = 1; i <= size; i++) {
        if (!names.has(i)) continue;
        const m = lines[names.get(i)].match(/^(\s*screens\\\d+\\name\s*=)\s*$/);
        if (m) {
          lines[names.get(i)] = `${m[1]}${peerName}`;
          done = true;
          break;
        }
      }
      // 无空位：扩容
      if (!done) {
        lines[sizeLine] = `screens\\size=${size + 1}`;
        lines.splice(sizeLine + 1, 0, `screens\\${size + 1}\\name=${peerName}`);
      }
    }
    writeConfFile(file, hadBom, lines);
  }

  // 2) [computer_N] 分组：core 已知屏幕清单（服务端自身 + 对端）
  const existing = new Map(); // N -> name
  let section = '';
  for (const line of lines) {
    const secM = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (secM) { section = secM[1].trim(); continue; }
    const cm = section.match(/^computer_(\d+)$/);
    if (cm) {
      const nmM = line.match(/^\s*name\s*=(.*)$/);
      if (nmM) existing.set(parseInt(cm[1], 10), nmM[1].trim());
    }
  }
  const wanted = [selfName, peerName].filter(Boolean);
  const missing = wanted.filter((n) => ![...existing.values()].includes(n));
  if (missing.length > 0) {
    let next = existing.size > 0 ? Math.max(...existing.keys()) + 1 : 1;
    const extra = [];
    for (const name of missing) extra.push(`[computer_${next++}]`, `name=${name}`, '');
    // 追加到文件末尾（保留最后一行换行）
    const trimmed = [...lines];
    while (trimmed.length && trimmed[trimmed.length - 1] === '') trimmed.pop();
    fs.writeFileSync(file, (hadBom ? '\uFEFF' : '') + trimmed.join('\r\n') + '\r\n' + extra.join('\r\n'), 'utf8');
  }
  return true;
}

function writeConfFile(file, hadBom, lines) {
  const out = lines.filter((l, i) => !(i === lines.length - 1 && l === ''));
  fs.writeFileSync(file, (hadBom ? '\uFEFF' : '') + out.join('\r\n') + '\r\n', 'utf8');
}

function readCoreMode() {
  try {
    const text = fs.readFileSync(confPath(), 'utf8').replace(/^\uFEFF/, '');
    let current = '';
    for (const line of text.split(/\r?\n/)) {
      const secM = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (secM) { current = secM[1].trim(); continue; }
      if (current === 'core') {
        const m = line.match(/^\s*coreMode\s*=\s*(\d+)/);
        if (m) return parseInt(m[1], 10);
      }
    }
  } catch { /* ignore */ }
  return 0;
}

// ─── 进程管理 ────────────────────────────────────────────────────────────────
function killDeskflowChild() {
  if (deskflowChild) {
    try { deskflowChild.kill(); } catch { /* ignore */ }
    deskflowChild = null;
    return true;
  }
  return false;
}

async function launchProcess(config, exe, args, label, { killImage = null } = {}) {
  if (!fs.existsSync(exe)) {
    return { ok: false, message: `未找到后端：${exe}（可在插件配置 backendDir 中指定）` };
  }
  if (deskflowChild) {
    killDeskflowChild();
    await new Promise(r => setTimeout(r, 800));
  }
  // 清理孤儿实例（DSH 重启后 detached 进程脱离句柄；同机只应有一个 core/GUI 实例）
  if (killImage && process.platform === 'win32') {
    try {
      execSync(`taskkill /F /IM ${killImage}`, { stdio: 'ignore', timeout: 5000 });
      await new Promise(r => setTimeout(r, 500));
    } catch { /* 没有旧实例则忽略 */ }
  }
  try {
    // detached：后台核心独立于 DSH 生命周期，DSH 重启不影响键鼠共享
    deskflowChild = spawn(exe, args, { detached: true, stdio: 'ignore' });
    deskflowChild.on('exit', () => { deskflowChild = null; });
    deskflowChild.unref();
    return { ok: true, pid: deskflowChild.pid, message: `${label}已启动（PID ${deskflowChild.pid}，后台运行）` };
  } catch (e) {
    deskflowChild = null;
    return { ok: false, message: `启动失败：${e?.message || e}` };
  }
}

// 服务端屏幕配置（synergy 格式，与 GUI operator<< 输出一致的结构）。
// 屏幕名用 hostname（与 core 默认自命名一致），对端屏幕按 layout 方向链接。
function writeServerConfig(config, clientName) {
  const serverName = selfName;
  const layout = layoutDir(config);
  const opposite = { right: 'left', left: 'right', top: 'bottom', bottom: 'top' }[layout];
  // 注意：本版本 screens 存放在通用配置（conf 的 [screens] 数组，见 addServerScreen），
  // server config 文件只承载 links + options（与 GUI operator<< 输出一致）
  const body =
    `section: links\n` +
    `\t${serverName}:\n` +
    `\t\t${layout} = ${clientName}\n` +
    `\t${clientName}:\n` +
    `\t\t${opposite} = ${serverName}\n` +
    `end\n\n` +
    `section: options\n` +
    `end\n\n`;
  const file = serverConfPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

// headless：直接拉起 deskflow-core 后台进程（无 GUI 窗口）
async function launchHeadless(config, role, peerName) {
  const exe = coreExePath(config);
  const conf = confPath();
  const args = ['-s', conf];
  if (role === 'server') {
    const serverConf = writeServerConfig(config, peerName);
    patchConf({
      server: { externalConfig: 'true', externalConfigFile: serverConf.replace(/\\/g, '/') },
    });
    return await launchProcess(config, exe, ['server', ...args], '键鼠共享服务端核心', { killImage: 'deskflow-core.exe' });
  }
  return await launchProcess(config, exe, ['client', ...args], '键鼠共享客户端核心', { killImage: 'deskflow-core.exe' });
}

// gui：拉起 Deskflow GUI 窗口（由 GUI 自行管理 core）
async function launchGui(config, role) {
  return await launchProcess(config, guiExePath(config), [], 'Deskflow 窗口', { killImage: 'deskflow.exe' });
}

// ─── 连接动作：写 conf + 拉起后端 ────────────────────────────────────────────
async function connect(args, config) {
  const role = args?.role === 'client' ? 'client' : args?.role === 'server' ? 'server' : null;
  if (!role) return { ok: false, message: 'role 必须是 server 或 client' };

  let ip = typeof args?.peerIp === 'string' && args.peerIp ? args.peerIp : null;
  if (!ip && typeof args?.ip === 'string' && args.ip.trim()) ip = args.ip.trim(); // 纯 IP 手动直连
  if (!ip && typeof args?.peerInstance === 'string') {
    const p = peers.get(args.peerInstance);
    if (p) ip = p.ip;
  }
  if (role === 'client' && !ip) return { ok: false, message: 'client 角色需要指定对端（peerInstance、peerIp 或 ip）' };

  let peerName = null;
  // 服务端角色：把对端屏幕名登记进 server config（对齐 C++ 版 applyLanRole 的 addClient）
  if (role === 'server') {
    if (typeof args?.peerInstance === 'string' && peers.get(args.peerInstance)) {
      peerName = peers.get(args.peerInstance).name;
    } else if (ip) {
      for (const p of peers.values()) if (p.ip === ip) { peerName = p.name; break; }
    }
    if (!peerName && ip) peerName = ip; // 纯 IP 直连：以 IP 作为对端屏幕名（peer={ip, name:ip}）
    try { addServerScreen(peerName || args?.peerName); } catch { /* 失败不阻断连接 */ }
  }

  const updates = {
    core: { coreMode: role === 'server' ? 2 : 1, computerName: selfName },
    gui: { startCoreWithGui: true },
    // headless 无证书生成能力，LAN 场景统一关闭 TLS（对端插件写入相同设置）
    security: { tlsEnabled: 'false' },
  };
  if (role === 'client') updates.client = { remoteHost: ip };

  let file;
  try { file = patchConf(updates); } catch (e) {
    return { ok: false, message: `写入配置失败：${e?.message || e}` };
  }
  const launched = launchMode(config) === 'gui'
    ? await launchGui(config, role)
    : await launchHeadless(config, role, peerName || ip);
  return {
    ok: launched.ok,
    role,
    peer: role === 'client' ? ip : '（所有客户端）',
    mode: launchMode(config),
    confPath: file,
    deskflow: launched,
    message: launched.ok
      ? (role === 'server'
        ? `本机作为服务端，共享键鼠；后台核心已启动（对端：${peerName || '未指定'}，方向：${layoutDir(config)}）`
        : `本机作为客户端，连接 ${ip}；后台核心已启动`)
      : launched.message,
  };
}

// ─── cordis apply ────────────────────────────────────────────────────────────
function isRecord(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function renderJson(_args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

export function apply(ctx, config) {
  const pluginConfig = config || {};

  try { startDiscovery(pluginConfig); } catch (e) {
    console.warn('[deskflow] discovery start failed:', e?.message || e);
  }
  // host 进程退出时广播 leaving，对端立即摘除本机
  try { process.once('exit', () => { try { announce(true); } catch { /* ignore */ } }); } catch { /* ignore */ }

  // ── 面板 RPC：/api/deskflow ──
  if (ctx?.connection?.fetch?.register) {
    ctx.connection.fetch.register({
      path: '/api/deskflow',
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        let message;
        try { message = await request.json(); }
        catch {
          return Response.json({ type: 'server-response', rpcId: 'invalid-request', result: { ok: false, error: { code: 'bad-request', message: 'Body is not JSON', details: {} } } });
        }
        const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request';
        const call = message?.payload;
        const method = call?.method;
        // 兼容两种载荷形状：{method, ...args}（扁平）与 {method, payload:{...args}}（嵌套）
        const rpcArgs = isRecord(call?.payload) ? call.payload : call;

        const reply = (result) => Response.json({ type: 'server-response', rpcId, result });

        if (!isRecord(message) || message.type !== 'client-request' || typeof message.rpcId !== 'string'
            || !['/api/deskflow', 'deskflow'].includes(message.method)
            || !isRecord(call) || typeof method !== 'string') {
          return reply({ ok: false, error: { code: 'bad-request', message: 'Invalid DeskFlow management request', details: {} } });
        }

        try {
          switch (method) {
            case 'status': {
              return reply({
                ok: true,
                result: {
                  instance: instanceId,
                  name: selfName,
                  version: PLUGIN_VERSION,
                  discovering: !!socket,
                  discoveryEnabled,
                  peerCount: peerList().length,
                  coreMode: readCoreMode(),
                  deskflowRunning: !!deskflowChild,
                  deskflowPid: deskflowChild?.pid || null,
                  deskflowPath: coreExePath(pluginConfig),
                  launchMode: launchMode(pluginConfig),
                  confPath: confPath(),
                  port: corePort,
                },
              });
            }
            case 'peers': {
              return reply({ ok: true, result: { instance: instanceId, peers: peerList() } });
            }
            case 'scan': {
              announce(false);
              return reply({ ok: true, result: { instance: instanceId, peers: peerList() } });
            }
            case 'discovery': {
              if (typeof rpcArgs?.enabled !== 'boolean') {
                return reply({ ok: false, error: { code: 'bad-request', message: 'enabled 必须是 boolean', details: {} } });
              }
              const enabled = setDiscovery(rpcArgs.enabled, pluginConfig);
              return reply({ ok: true, result: { ok: true, enabled } });
            }
            case 'connect': {
              const r = await connect(rpcArgs, pluginConfig);
              return reply({ ok: r.ok, result: r });
            }
            case 'stop': {
              const killed = killDeskflowChild();
              try { patchConf({ core: { coreMode: 0 } }); } catch { /* ignore */ }
              return reply({ ok: true, result: { stopped: true, killedProcess: killed, message: killed ? '已停止本机管理的 Deskflow 进程' : '没有由插件启动的 Deskflow 进程' } });
            }
            default:
              return reply({ ok: false, error: { code: 'unknown-method', message: `Unknown method: ${method}`, details: {} } });
          }
        } catch (e) {
          return reply({ ok: false, error: { code: 'handler-failed', message: e?.message || 'handler failed', details: {} } });
        }
      },
    });
  }

  // ── AI 工具注册 ──
  ctx.tools.register({
    name: 'deskflow_status',
    description: '查询键鼠共享（Deskflow）状态：局域网发现是否运行、发现的设备列表、当前角色（coreMode）、Deskflow 进程是否在跑。',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute() {
      return {
        discovering: !!socket,
        self: { instance: instanceId, name: selfName, port: corePort },
        peers: peerList(),
        coreMode: readCoreMode(),
        coreModeName: { 0: '未连接', 1: '客户端', 2: '服务端' }[readCoreMode()] || '未知',
        deskflowRunning: !!deskflowChild,
        deskflowPid: deskflowChild?.pid || null,
        deskflowPath: coreExePath(pluginConfig),
        launchMode: launchMode(pluginConfig),
      };
    },
  });

  ctx.tools.register({
    name: 'deskflow_scan_peers',
    description: '立即广播一次局域网发现并等待约 2.5 秒，返回当前发现的所有键鼠共享设备（需对端也安装了本插件或 Deskflow fork）。',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute() {
      announce(false);
      await new Promise(r => setTimeout(r, 2500));
      return { discovering: !!socket, peers: peerList() };
    },
  });

  ctx.tools.register({
    name: 'deskflow_connect',
    description: '连接键鼠共享。role=server 时本机共享键鼠给局域网设备；role=client 时本机使用对端键鼠（需提供对端 IP 或 discovery 返回的 instance）。写 Deskflow 配置后自动拉起 Deskflow。',
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['server', 'client'], description: 'server=本机作为服务端共享键鼠；client=本机作为客户端使用对方键鼠' },
        peerInstance: { type: 'string', description: '对端 instance id（deskflow_scan_peers 返回）' },
        peerIp: { type: 'string', description: '对端 IP（与 peerInstance 二选一，client 角色必填其一）' },
      },
      required: ['role'],
    },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute(args) { return await connect(args, pluginConfig); },
  });

  ctx.tools.register({
    name: 'deskflow_disconnect',
    description: '断开键鼠共享：停止插件启动的 Deskflow 进程并把角色置回未连接。',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute() {
      const killed = killDeskflowChild();
      try { patchConf({ core: { coreMode: 0 } }); } catch { /* ignore */ }
      return { stopped: true, killedProcess: killed, message: killed ? '已停止 Deskflow' : '没有由插件启动的 Deskflow 进程' };
    },
  });
}
