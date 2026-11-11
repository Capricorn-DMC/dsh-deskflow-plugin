/**
 * DeskFlow DSH Plugin (server side)
 *
 * 把 Deskflow 键鼠共享能力做成 DeepSeek Harness 插件：
 * - 局域网自动发现：UDP 40801 广播，协议与 Deskflow fork 内置 C++ 版一致
 *   （{proto:'deepseek-harness', ver:1, instance, name, port, leaving}，1.5s 周期，6s 超时）
 * - 角色协商连接：Web 面板里选服务端/客户端，写 Deskflow QSettings ini 后拉起 deskflow.exe
 * - RPC：/api/deskflow（status/peers/discovery/connect/stop/scan/diagnose），供 client.js 面板调用
 * - Tools：deskflow_status / deskflow_scan_peers / deskflow_connect / deskflow_disconnect / deskflow_doctor
 */

import dgram from 'dgram';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync, execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url)); // ESM 下等价 __dirname

export const inject = ['tools', 'connection'];

// ─── 常量 ────────────────────────────────────────────────────────────────────
const DISCOVERY_PORT = 40801;
const ANNOUNCE_INTERVAL_MS = 1500;
const PEER_TIMEOUT_MS = 6000;
const DISCOVERY_PROTO = 'deepseek-harness';

const LOCAL_BACKEND_DIR = path.join(PLUGIN_DIR, 'backend');
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
  // 优先用插件自带的 backend/ 目录（clone 即用，无需解压）；缺失时回退配置目录
  if (fs.existsSync(path.join(LOCAL_BACKEND_DIR, 'deskflow-core.exe'))) return LOCAL_BACKEND_DIR;
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
const PLUGIN_VERSION = '1.4.0';
const peers = new Map(); // instance -> {instance, name, ip, port, lastSeen}

let socket = null;
let announceTimer = null;
let pruneTimer = null;
let restartTimer = null;
let deskflowChild = null;
let corePort = DEFAULT_CORE_PORT;
let discoveryEnabled = true; // 自动发现开关（RPC discovery 控制广播与记录）
let discoveryError = null;   // 发现 socket 绑定失败原因（如端口被旧 DSH 实例占用）

// ─── 单播兜底（VPN 场景）─────────────────────────────────────────────────────
// 对端开 VPN（TUN 网卡抢默认路由）时，全局/定向广播可能进隧道而到不了物理局域网。
// 兜底：除广播外，对「配置的静态对端」+「见过的对端 IP」直接单播 announce——
// 单播按最长前缀匹配路由，一般不受 VPN 影响；双方任一方能收到即可互相发现。
const PEERS_CACHE = path.join(os.homedir(), '.dsh', 'deskflow-peers.json');
let staticPeers = [];       // cordis 配置 staticPeers: ['192.168.100.101', ...]
let knownIps = new Set();   // 见过的对端 IP（持久化，断电重启用单播补路）

function loadPeersCache() {
  try {
    const arr = JSON.parse(fs.readFileSync(PEERS_CACHE, 'utf8'));
    if (Array.isArray(arr)) knownIps = new Set(arr.filter((x) => typeof x === 'string' && x));
  } catch { /* 首次运行或文件损坏则忽略 */ }
}

function savePeersCache() {
  try {
    fs.mkdirSync(path.dirname(PEERS_CACHE), { recursive: true });
    fs.writeFileSync(PEERS_CACHE, JSON.stringify([...knownIps], null, 2), 'utf8');
  } catch { /* 尽力而为 */ }
}

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
  // 单播兜底：静态对端 + 见过的对端 IP（VPN/广播异常场景仍可互相发现）
  for (const ip of new Set([...staticPeers, ...knownIps])) {
    try { socket.send(msg, DISCOVERY_PORT, ip); } catch { /* ignore */ }
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
  staticPeers = Array.isArray(config?.staticPeers)
    ? config.staticPeers.filter((x) => typeof x === 'string' && x) : [];
  loadPeersCache();
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
    if (!knownIps.has(rinfo.address)) { knownIps.add(rinfo.address); savePeersCache(); }
    peers.set(msg.instance, {
      instance: msg.instance,
      name: typeof msg.name === 'string' && msg.name ? msg.name : 'unknown',
      ip: rinfo.address,
      port: Number(msg.port) > 0 ? Number(msg.port) : DEFAULT_CORE_PORT,
      lastSeen: Date.now(),
    });
  });
  sock.on('error', (e) => {
    // 绑定失败（端口被独占）等情况：记录原因（status 暴露给面板）+ 10s 后重试
    discoveryError = String(e && e.message || e);
    stopDiscovery();
    restartTimer = setTimeout(() => { if (discoveryEnabled) { try { startDiscovery(config); } catch (err) { discoveryError = String(err && err.message || err); } } }, 10000);
  });
  sock.bind(DISCOVERY_PORT, () => {
    discoveryError = null; // 绑定成功，清除历史错误
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
    try { startDiscovery(config); } catch (e) { discoveryError = String(e && e.message || e); }
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

// ─── 防火墙放行（Windows）────────────────────────────────────────────────────
// 插件安装（link / junction）拿不到管理员权限，无法静默改防火墙；
// 采用「检测 + 一键放行」：检测走 netsh（普通权限即可），放行弹 UAC 由用户确认执行。
const FW_RULES = [
  { name: 'DSH Deskflow Discovery', proto: 'UDP', port: DISCOVERY_PORT },
  { name: 'DSH Deskflow Core', proto: 'TCP', port: DEFAULT_CORE_PORT },
];
let fwCache = null; // { rules: { <ruleName>: bool } }，status 读缓存，check/allow 刷新

function checkFirewall() {
  const rules = {};
  for (const r of FW_RULES) {
    let out = '';
    try {
      out = String(spawnSync('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${r.name}`],
        { encoding: 'utf8', timeout: 8000, windowsHide: true }).stdout || '');
    } catch { /* netsh 不可用按未放行处理 */ }
    rules[r.name] = out.includes(r.name); // 规则存在时输出含规则名；缺失时输出"没有与指定标准相匹配的规则"
  }
  fwCache = { rules };
  return rules;
}

function firewallState() {
  if (!fwCache) return null;
  return { rules: fwCache.rules, allOk: FW_RULES.every((r) => fwCache.rules[r.name]) };
}

function allowFirewall() {
  // 删旧加新保证幂等；两条规则一个脚本一次 UAC 弹窗
  const script = FW_RULES.map((r) =>
    `netsh advfirewall firewall delete rule name="${r.name}" | Out-Null\r\n` +
    `netsh advfirewall firewall add rule name="${r.name}" dir=in action=allow protocol=${r.proto} localport=${r.port}`
  ).join('\r\n');
  const tmp = path.join(os.tmpdir(), `dsh-deskflow-fw-${Date.now()}.ps1`);
  fs.writeFileSync(tmp, script, 'utf8');
  try {
    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-Command',
      `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${tmp}'`,
    ], { encoding: 'utf8', timeout: 120000, windowsHide: true });
    const rules = checkFirewall();
    const allOk = FW_RULES.every((x) => rules[x.name]);
    if (allOk) return { ok: true, rules, message: '防火墙已放行（UDP 40801 / TCP 24800）' };
    return {
      ok: false,
      rules,
      message: r?.status === 0
        ? '放行未生效：可能被组策略或杀毒软件拦截，请手动添加防火墙规则'
        : '已取消管理员授权，防火墙未修改',
    };
  } catch (e) {
    return { ok: false, message: `放行失败：${e?.message || e}` };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
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

// ─── 运行环境自检：提权状态 / 多实例 ─────────────────────────────────────────
// Windows 下这两件事都会直接造成"连接成功但键鼠不动"，现象容易和网络问题混淆：
//  · 未提权：进程无法 SendInput/SetCursorPos 注入指针，切过去后光标钉在屏幕边缘，一推就被弹回
//  · 多实例：同名客户端重复连接，服务端日志 `a client with name "x" is already connected` 后互踢
// 两者还会叠加：旧实例是提权启动、新进程没提权时 taskkill 会失败，"清理孤儿"形同虚设
let elevatedCache = null;
function isElevated() {
  if (elevatedCache !== null) return elevatedCache;
  if (process.platform !== 'win32') {
    elevatedCache = typeof process.getuid === 'function' ? process.getuid() === 0 : null;
    return elevatedCache;
  }
  // net session 仅管理员可执行，比 spawn 一个 PowerShell 快一个数量级
  try {
    execSync('net session', { stdio: 'ignore', timeout: 3000, windowsHide: true });
    elevatedCache = true;
  } catch {
    elevatedCache = false;
  }
  return elevatedCache;
}

function listImagePids(image) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${image}" /FO CSV /NH`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const pids = [];
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^"[^"]+","(\d+)"/);
      if (m) pids.push(Number(m[1]));
    }
    return pids;
  } catch {
    return null;
  }
}

// 结束同镜像的全部残留实例，并复查是否真的清干净（taskkill 对提权进程会静默失败）
function cleanupInstances(image) {
  const before = listImagePids(image);
  if (before === null) return { image, supported: false, before: 0, remaining: 0, ok: true };
  if (before.length === 0) return { image, supported: true, before: 0, remaining: 0, ok: true };
  try {
    execSync(`taskkill /F /IM ${image}`, { stdio: 'ignore', timeout: 5000, windowsHide: true });
  } catch { /* 没有实例或权限不足，交给下面的复查判断 */ }
  const after = listImagePids(image) || [];
  return {
    image,
    supported: true,
    before: before.length,
    remaining: after.length,
    remainingPids: after,
    ok: after.length === 0,
  };
}

function instanceWarnings(check) {
  if (!check || !check.remaining) return [];
  const hint = isElevated() === false ? '（当前未以管理员运行，无法结束提权进程——这正是多实例的常见来源）' : '';
  return [`残留 ${check.remaining} 个旧的 ${check.image} 实例未能结束${hint}，会导致同名客户端互踢、切屏抖动，请在任务管理器手动结束`];
}

async function launchProcess(config, exe, args, label, { killImage = null } = {}) {
  if (!fs.existsSync(exe)) {
    return { ok: false, message: `未找到后端：${exe}（插件自带 backend/ 目录缺失，可在插件配置 backendDir 中指定）` };
  }
  if (deskflowChild) {
    killDeskflowChild();
    await new Promise(r => setTimeout(r, 800));
  }
  // 清理孤儿实例（DSH 重启后 detached 进程脱离句柄；同机只应有一个 core/GUI 实例）
  // 注意：taskkill 结束提权进程需要管理员权限，失败后必须复查再决定是否继续
  let instanceCheck = null;
  if (killImage && process.platform === 'win32') {
    instanceCheck = cleanupInstances(killImage);
    if (instanceCheck.before > 0) await new Promise(r => setTimeout(r, 500));
  }
  try {
    // detached：后台核心独立于 DSH 生命周期，DSH 重启不影响键鼠共享；
    // stdout/stderr 落盘到 ~/.dsh/deskflow-core.log（每次启动截断），供排障与面板展示
    const logPath = path.join(os.homedir(), '.dsh', 'deskflow-core.log');
    let logFd = -1;
    try {
      logFd = fs.openSync(logPath, 'w');
    } catch { /* 打不开就退化为 ignore */ }
    const stdio = logFd >= 0 ? ['ignore', logFd, logFd] : 'ignore';
    deskflowChild = spawn(exe, args, { detached: true, stdio });
    deskflowChild.on('exit', () => {
      deskflowChild = null;
      if (logFd >= 0) { try { fs.closeSync(logFd); } catch { /* ignore */ } logFd = -1; }
    });
    deskflowChild.unref();
    return { ok: true, pid: deskflowChild.pid, logPath, instanceCheck, message: `${label}已启动（PID ${deskflowChild.pid}，后台运行）` };
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
      server: {
        externalConfig: 'true',
        externalConfigFile: serverConf.replace(/\\/g, '/'),
        // 心跳检测：服务端解析 server config 的 options 段时注入 kOptionHeartbeat
        // （Config.cpp readSectionOptions 从主 conf 读这两个键），
        // 客户端失联约 3 个心跳周期即被剔除，避免 core 异常退出后服务端残留僵尸会话"假在线"
        enableHeartbeat: 'true',
        heartbeat: '5000',
      },
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

  // 启动后随结果回传的自检警告，按"最容易踩坑"的顺序排列
  const warnings = [];

  // 1) 提权：Windows 下未提权无法注入键盘鼠标，是"连上了但光标不动"的第一嫌疑
  if (isElevated() === false) {
    warnings.push('当前 DSH 未以管理员权限运行：Windows 下这类进程无法注入键盘鼠标，常见表现是切过去后光标卡在屏幕边缘被弹回——请右键「以管理员身份运行」重启 DSH');
  }

  // 2) 多实例：旧实例没清干净会让同名客户端互踢，表现为切屏抖动、偶发断线
  for (const w of instanceWarnings(launched?.instanceCheck)) warnings.push(w);

  // 3) 防火墙：服务端缺入站 TCP 24800 时对端连不上——"连接成功"但键鼠不通
  {
    const fw = firewallState() || (checkFirewall(), firewallState());
    if (fw && !fw.allOk) {
      const missing = FW_RULES.filter((r) => !fw.rules[r.name]).map((r) => `${r.proto} ${r.port}`).join(' / ');
      warnings.push(`防火墙未放行 ${missing}，对端可能无法连接（可在面板点「一键放行」）`);
    }
  }

  return {
    ok: launched.ok,
    role,
    peer: role === 'client' ? ip : '（所有客户端）',
    mode: launchMode(config),
    confPath: file,
    deskflow: launched,
    elevated: isElevated(),
    warning: warnings[0] || null,
    warnings,
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
  // 启动后后台检测一次防火墙状态（status 读缓存，不阻塞 apply）
  setTimeout(() => { try { if (process.platform === 'win32') checkFirewall(); } catch { /* ignore */ } }, 1500);
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
                value: {
                  instance: instanceId,
                  name: selfName,
                  version: PLUGIN_VERSION,
                  discovering: !!socket,
                  discoveryEnabled,
                  discoveryError,
                  peerCount: peerList().length,
                  coreMode: readCoreMode(),
                  deskflowRunning: !!deskflowChild,
                  deskflowPid: deskflowChild?.pid || null,
                  deskflowPath: coreExePath(pluginConfig),
                  backendReady: fs.existsSync(coreExePath(pluginConfig)),
                  elevated: isElevated(),
                  coreInstances: (listImagePids('deskflow-core.exe') || []).length,
                  firewall: firewallState(),
                  confPath: confPath(),
                  port: corePort,
                },
              });
            }
            case 'peers': {
              return reply({ ok: true, value: { instance: instanceId, peers: peerList() } });
            }
            case 'scan': {
              announce(false);
              return reply({ ok: true, value: { instance: instanceId, peers: peerList() } });
            }
            case 'discovery': {
              if (typeof rpcArgs?.enabled !== 'boolean') {
                return reply({ ok: false, error: { code: 'bad-request', message: 'enabled 必须是 boolean', details: {} } });
              }
              const enabled = setDiscovery(rpcArgs.enabled, pluginConfig);
              return reply({ ok: true, value: { ok: true, enabled } });
            }
            case 'firewall': {
              // action=allow：弹 UAC 提权放行（用户在系统弹窗确认）；默认 check：普通权限检测
              if (rpcArgs?.action === 'allow') {
                const r = allowFirewall();
                return reply(r.ok
                  ? { ok: true, value: r }
                  : { ok: false, error: { code: 'firewall-allow-failed', message: r.message || '放行失败', details: { rules: r.rules || {} } } });
              }
              const rules = checkFirewall();
              return reply({ ok: true, value: { rules, allOk: FW_RULES.every((x) => rules[x.name]) } });
            }
            case 'connect': {
              const r = await connect(rpcArgs, pluginConfig);
              if (r?.ok) return reply({ ok: true, value: r });
              return reply({ ok: false, error: { code: 'connect-failed', message: r?.message || '连接失败', details: {} } });
            }
            case 'diagnose': {
              // 一键自检：把"连上了但键鼠不动"的两大本地成因（未提权 / 多实例）当场查清楚
              const corePids = listImagePids('deskflow-core.exe');
              const guiPids = listImagePids('deskflow.exe');
              const coreCount = corePids === null ? null : corePids.length;
              const guiCount = guiPids === null ? null : guiPids.length;
              const issues = [];
              if (isElevated() === false) issues.push('未以管理员运行：无法注入键鼠，客户端光标会卡在屏幕边缘');
              if (coreCount !== null && coreCount > 1) issues.push(`本机有 ${coreCount} 个 deskflow-core.exe 实例，同名客户端会互踢（PID ${corePids.join(', ')}）`);
              if (guiCount !== null && guiCount > 1) issues.push(`本机有 ${guiCount} 个 deskflow.exe 实例（PID ${guiPids.join(', ')}）`);
              const fw = firewallState();
              if (fw && !fw.allOk) issues.push('防火墙未放行 24800，对端可能连不上');
              return reply({
                ok: true,
                value: {
                  healthy: issues.length === 0,
                  issues,
                  elevated: isElevated(),
                  platform: process.platform,
                  corePids: corePids || [],
                  guiPids: guiPids || [],
                  coreMode: readCoreMode(),
                  coreRunning: !!deskflowChild,
                  port: corePort,
                  firewall: fw,
                },
              });
            }
            case 'stop': {
              const killed = killDeskflowChild();
              // 顺带清掉脱离句柄的孤儿实例，否则"停止"后再连接会出现两个同名客户端
              const cleanup = process.platform === 'win32' ? cleanupInstances('deskflow-core.exe') : null;
              try { patchConf({ core: { coreMode: 0 } }); } catch { /* ignore */ }
              return reply({
                ok: true,
                value: {
                  stopped: true,
                  killedProcess: killed,
                  cleanup,
                  message: killed || cleanup?.before
                    ? `已停止 Deskflow（清理残留实例 ${cleanup?.before || 0} 个）`
                    : '没有由插件启动的 Deskflow 进程',
                },
              });
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
    name: 'deskflow_doctor',
    description: '自检键鼠共享环境：检查当前进程是否以管理员运行（Windows 未提权会导致键鼠无法注入、光标卡在屏幕边缘）、本机是否有多个 deskflow 实例（同名客户端互踢会导致切屏抖动和偶发断线）、防火墙 24800 是否放行。出现"连接成功但鼠标不动"时先跑这个。',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute() {
      const corePids = listImagePids('deskflow-core.exe');
      const guiPids = listImagePids('deskflow.exe');
      const issues = [];
      if (isElevated() === false) issues.push('未以管理员运行：无法注入键鼠，客户端光标会卡在屏幕边缘');
      if ((corePids || []).length > 1) issues.push(`本机有 ${corePids.length} 个 deskflow-core.exe 实例，同名客户端会互踢`);
      if ((guiPids || []).length > 1) issues.push(`本机有 ${guiPids.length} 个 deskflow.exe 实例`);
      const fw = firewallState();
      if (fw && !fw.allOk) issues.push('防火墙未放行 24800，对端可能连不上');
      return {
        healthy: issues.length === 0,
        issues,
        elevated: isElevated(),
        platform: process.platform,
        corePids: corePids || [],
        guiPids: guiPids || [],
        coreRunning: !!deskflowChild,
        coreMode: readCoreMode(),
        firewall: fw,
      };
    },
  });

  ctx.tools.register({
    name: 'deskflow_disconnect',
    description: '断开键鼠共享：停止插件启动的 Deskflow 进程、清理残留孤儿实例，并把角色置回未连接。',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute() {
      const killed = killDeskflowChild();
      const cleanup = process.platform === 'win32' ? cleanupInstances('deskflow-core.exe') : null;
      try { patchConf({ core: { coreMode: 0 } }); } catch { /* ignore */ }
      return {
        stopped: true,
        killedProcess: killed,
        cleanup,
        message: killed || cleanup?.before
          ? `已停止 Deskflow（清理残留实例 ${cleanup?.before || 0} 个）`
          : '没有由插件启动的 Deskflow 进程',
      };
    },
  });
}
