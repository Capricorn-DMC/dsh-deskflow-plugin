// ─── DeskFlow DSH 插件客户端（Web UI）────────────────────────────────────────
// 双协议加载器：
//   新 DSH: window.__ModuleLoader__.load({ id, factory(require) })
//   旧 DSH: module.exports = { inject, apply(ctx) }
// UI：sidebar.footer.action 注册常驻按钮（左侧栏底部，Settings 旁），
//     点击弹出浮动面板（设备列表 / 连接状态）；发现新设备时自动弹出角色协商 modal。
(function () {
  const mod = (require) => {
    const React = require('react');
    const h = React.createElement;
    let ReactDOM = null;
    try { ReactDOM = require('react-dom'); } catch { /* 降级为非 portal 渲染 */ }

    // UI 版本（与 package.json version 同步；面板底部显示 "UI vX / Host vY" 用于排查 host 未重载）
    const UI_VERSION = '1.3.1';

    // 真实 cordis ctx 在 apply() 捕获；组件不通过 props 读它
    let realCtx = null;

    // ─── 主题 token（DSW alias，深浅色自适应）─────────────────────────────
    const T = {
      bgLayer1: '#141b24',
      bgLayer2: '#1c2530',
      borderL1: '#2a3644',
      borderL2: '#33414f',
      text: '#e9f1f8',
      text2: '#a8bac8',
      text3: '#74879a',
      accent: '#2f81f7',
      accentSoft: 'rgba(47, 129, 247, 0.16)',
      success: '#3fb950',
      error: '#f85149',
    };
    const FONT = 'var(--dsw-font-family, system-ui, sans-serif)';
    // 毛玻璃主题下 bg-layer-* 常带透明度，直接做面板/卡片背景会让文字发虚看不清。
    // rgb(from … / 1) 剥掉透明度转为不透明色（Chrome 119+）；
    // 老内核不识别时该声明被忽略，自动退回 background 简写里的原变量值。
    const opaque = (c) => `rgb(from ${c} r g b / 1)`;

    const s = {
      railBtn: { width: 36, height: 36, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.text2, padding: 0 },
      railBtnActive: { background: T.accentSoft, color: T.accent },
      wideBtn: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13, fontFamily: FONT, color: T.text2 },
      panel: { position: 'fixed', left: 64, bottom: 12, width: 340, maxHeight: 520, overflowY: 'auto', background: T.bgLayer1, backgroundColor: opaque(T.bgLayer1), border: `1px solid ${T.borderL1}`, borderRadius: 14, boxShadow: '0 8px 32px rgba(0,0,0,0.25)', padding: 16, fontFamily: FONT, fontSize: 13, color: T.text, zIndex: 9999 },
      overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT },
      modal: { width: 400, background: T.bgLayer1, backgroundColor: opaque(T.bgLayer1), border: `1px solid ${T.borderL1}`, borderRadius: 14, boxShadow: '0 12px 48px rgba(0,0,0,0.35)', padding: 22, color: T.text },
      sectionTitle: { fontSize: 13, fontWeight: 600, margin: '0 0 8px 0', color: T.text, display: 'flex', alignItems: 'center', gap: 6 },
      peerCard: { padding: 10, background: T.bgLayer2, backgroundColor: opaque(T.bgLayer2), borderRadius: 8, border: `1px solid ${T.borderL1}`, marginBottom: 8 },
      peerName: { fontSize: 13, fontWeight: 600, color: T.text },
      peerMeta: { fontSize: 11, color: T.text3, fontFamily: 'monospace', marginTop: 2 },
      btnPrimary: { padding: '6px 12px', borderRadius: 6, border: 'none', background: T.accent, color: '#fff', fontSize: 12, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap' },
      btnSecondary: { padding: '5px 10px', borderRadius: 6, border: `1px solid ${T.borderL2}`, background: T.bgLayer2, backgroundColor: opaque(T.bgLayer2), color: T.text, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' },
      btnDanger: { padding: '5px 10px', borderRadius: 6, border: `1px solid ${T.error}`, background: 'transparent', color: T.error, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' },
      badge: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 500 },
      badgeOk: { background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 15%, transparent)', color: T.success },
      badgeErr: { background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 15%, transparent)', color: T.error },
      msgOk: { padding: '8px 12px', borderRadius: 8, fontSize: 12, marginBottom: 10, background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)', color: T.success, border: '1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 30%, transparent)' },
      msgErr: { padding: '8px 12px', borderRadius: 8, fontSize: 12, marginBottom: 10, background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)', color: T.error, border: '1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent)' },
      msgWarn: { padding: '8px 12px', borderRadius: 8, fontSize: 12, marginBottom: 10, background: 'color-mix(in srgb, var(--dsw-alias-state-warning-primary, #d97706) 12%, transparent)', color: 'var(--dsw-alias-state-warning-primary, #d97706)', border: '1px solid color-mix(in srgb, var(--dsw-alias-state-warning-primary, #d97706) 30%, transparent)' },
      empty: { textAlign: 'center', padding: '18px 8px', color: T.text3, fontSize: 12, lineHeight: 1.6 },
      note: { fontSize: 11, color: T.text3, margin: '8px 0 0 0', lineHeight: 1.5 },
      input: { width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: 6, border: `1px solid ${T.borderL2}`, background: T.bgLayer2, backgroundColor: opaque(T.bgLayer2), color: T.text, fontSize: 12, fontFamily: FONT, outline: 'none' },
      toggle: { position: 'relative', width: 34, height: 19, borderRadius: 10, border: `1px solid ${T.borderL2}`, background: T.bgLayer2, backgroundColor: opaque(T.bgLayer2), cursor: 'pointer', padding: 0, flexShrink: 0 },
      toggleOn: { background: T.accent, borderColor: T.accent },
      toggleKnob: { position: 'absolute', top: 1, left: 1, width: 15, height: 15, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.2)', transition: 'left 0.15s ease' },
      toggleKnobOn: { left: 16 },
    };

    // ─── Host RPC ───────────────────────────────────────────────────────────
    const hostCall = async (method, payload) => {
      const c = realCtx;
      if (!c) return { ok: false, error: { message: 'ctx 未就绪' } };
      const connection = c.get ? c.get('connection') : c.connection;
      if (connection?.rpc?.call) {
        try {
          const ret = await connection.rpc.call('/api', 'deskflow', { method, payload: payload || {} });
          // DSH 契约：成功 {ok:true, value}；失败 {ok:false, error:{code,message,details}}
          // 面板内部契约：{ok, result} / {ok:false, error}
          if (ret?.ok === true) return { ok: true, result: ret.value };
          if (ret?.ok === false) return { ok: false, error: ret.error };
          return { ok: false, error: { code: 'bad-shape', message: 'RPC 返回形状异常', details: {} } };
        } catch (e) {
          return { ok: false, error: { code: 'rpc-threw', message: `${e?.name || 'Error'}: ${e?.message || e}`, details: {} } };
        }
      }
      return { ok: false, error: { message: 'ctx.connection.rpc 不可用' } };
    };

    const CORE_MODE_NAMES = { 0: '未连接', 1: '客户端', 2: '服务端' };

    // ─── 角色协商弹窗 ───────────────────────────────────────────────────────
    function NegotiationModal({ peer, busy, onPick, onClose }) {
      return h('div', { style: s.overlay, onClick: (e) => { if (e.target === e.currentTarget && !busy) onClose(); } },
        h('div', { style: s.modal },
          h('div', { style: { fontSize: 26, marginBottom: 6 } }, '⌨🖱'),
          h('div', { style: { fontSize: 16, fontWeight: 600, marginBottom: 4 } }, '发现局域网设备'),
          h('div', { style: { fontSize: 13, color: T.text2, marginBottom: 14 } },
            h('span', { style: { fontWeight: 600, color: T.text } }, peer.name),
            `（${peer.ip}）也安装了键鼠共享插件，选择连接方式：`),
          h('button', {
            disabled: busy, onClick: () => onPick('server'), style: { ...s.btnPrimary, display: 'block', width: '100%', padding: '12px 16px', marginBottom: 10, textAlign: 'left', fontSize: 13, opacity: busy ? 0.5 : 1 },
          },
            h('div', { style: { fontWeight: 600 } }, '🖥 本机作为服务端'),
            h('div', { style: { fontSize: 11, fontWeight: 400, opacity: 0.85, marginTop: 2 } }, `用本机的键盘鼠标控制 ${peer.name}`)),
          h('button', {
            disabled: busy, onClick: () => onPick('client'), style: { ...s.btnSecondary, display: 'block', width: '100%', padding: '12px 16px', textAlign: 'left', fontSize: 13 },
          },
            h('div', { style: { fontWeight: 600 } }, '💻 本机作为客户端'),
            h('div', { style: { fontSize: 11, color: T.text2, marginTop: 2 } }, `使用 ${peer.name} 的键盘鼠标控制本机`)),
          h('div', { style: { marginTop: 12, textAlign: 'center' } },
            h('button', { disabled: busy, onClick: onClose, style: { ...s.btnSecondary, border: 'none', background: 'transparent', color: T.text3 } }, '暂不连接')),
        ));
    }

    // ─── 侧栏按钮（常驻挂载；负责轮询发现 + 面板/弹窗 portal）──────────────
    function DeskflowSidebarAction() {
      const [panelOpen, setPanelOpen] = React.useState(false);
      const [wide, setWide] = React.useState(null); // ownerProps.wire 不可靠时先自适应
      const [peers, setPeers] = React.useState([]);
      const [status, setStatus] = React.useState(null);
      const [modalPeer, setModalPeer] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [msg, setMsg] = React.useState(null);
      const [manualIp, setManualIp] = React.useState('');
      const seenRef = React.useRef(null);
      const firstPollRef = React.useRef(true);
      // 自动发现开关：本地乐观状态（点击立即翻转），refresh 拿到 host 真实态后归位
      const [discOverride, setDiscOverride] = React.useState(null);
      const discoveryOn = discOverride !== null
        ? discOverride
        : (status ? status.discoveryEnabled !== false : true);

      const refresh = React.useCallback(async () => {
        const res = await hostCall('peers');
        const list = (res?.ok && res?.result?.peers) || [];
        const st = await hostCall('status');
        if (st?.ok && st?.result) { setStatus(st.result); setDiscOverride(null); }
        setPeers(list);

        // 首轮只建立基线，之后发现新设备 → 弹协商窗
        if (firstPollRef.current) {
          seenRef.current = new Set(list.map(p => p.instance));
          firstPollRef.current = false;
        } else if (seenRef.current) {
          const fresh = list.find(p => !seenRef.current.has(p.instance));
          if (fresh) {
            list.forEach(p => seenRef.current.add(p.instance));
            setModalPeer(fresh);
            setPanelOpen(true);
          }
        }
        list.forEach(p => seenRef.current && seenRef.current.add(p.instance));
      }, []);

      React.useEffect(() => {
        let disposed = false;
        let timer = null;
        const tick = async () => {
          if (disposed) return;
          try { await refresh(); } catch { /* host 未就绪，下轮重试 */ }
          if (!disposed) timer = window.setTimeout(tick, 2500);
        };
        tick();
        return () => { disposed = true; if (timer) clearTimeout(timer); };
      }, [refresh]);

      const doConnect = async (role, peer) => {
        setBusy(true);
        setMsg(null);
        const res = await hostCall('connect', { role, peerInstance: peer?.instance, peerIp: peer?.ip });
        setBusy(false);
        const r = res?.result;
        if (res?.ok && r?.ok) {
          setMsg(r.warning
            ? { type: 'warn', text: `${r.message}；⚠ ${r.warning}` }
            : { type: 'ok', text: r.message });
          setModalPeer(null);
          refresh();
        } else {
          setMsg({ type: 'err', text: (r && r.message) || res?.error?.message || '连接失败' });
        }
      };

      const doDisconnect = async () => {
        setBusy(true);
        const res = await hostCall('stop');
        setBusy(false);
        if (res?.ok) { setMsg({ type: 'ok', text: (res.result && res.result.message) || '已断开' }); refresh(); }
        else setMsg({ type: 'err', text: res?.error?.message || '断开失败' });
      };

      const doToggleDiscovery = async () => {
        if (busy) return;
        setBusy(true);
        setMsg(null);
        setDiscOverride(!discoveryOn); // 乐观翻转，立即反映在按钮上
        const res = await hostCall('discovery', { enabled: !discoveryOn });
        setBusy(false);
        if (res?.ok) { setMsg({ type: 'ok', text: discoveryOn ? '已关闭自动发现' : '已开启自动发现' }); refresh(); }
        else { setDiscOverride(null); setMsg({ type: 'err', text: res?.error?.message || '操作失败' }); }
      };

      // 一键放行防火墙：host 弹 UAC 提权（用户在系统弹窗确认），完成后重新检测
      const doAllowFirewall = async () => {
        if (busy) return;
        setBusy(true);
        setMsg({ type: 'warn', text: '请在系统弹出的管理员授权窗口中点「是」…' });
        const res = await hostCall('firewall', { action: 'allow' });
        setBusy(false);
        if (res?.ok) setMsg({ type: 'ok', text: res.result?.message || '防火墙已放行' });
        else setMsg({ type: 'err', text: res?.error?.message || '放行失败' });
        refresh();
      };

      // 显式启动服务端：优先用已发现的对端（含其主机名，供服务端屏幕名单匹配），否则用手动 IP
      const doStartServer = async () => {
        if (busy) return;
        const target = peers[0]
          ? { peer: { name: peers[0].name, ip: peers[0].ip } }
          : (manualIp.trim() ? { ip: manualIp.trim() } : null);
        if (!target) { setMsg({ type: 'err', text: '启动服务端需要指定对端：等待发现设备出现，或在下方填写对端 IP' }); return; }
        setBusy(true); setMsg(null);
        const res = await hostCall('connect', { role: 'server', ...target });
        setBusy(false);
        if (res?.ok) { setMsg({ type: 'ok', text: '服务端已启动，等待对端客户端接入' }); refresh(); }
        else setMsg({ type: 'err', text: res?.error?.message || '启动失败' });
      };

      const doConnectIp = async (role) => {
        const ip = manualIp.trim();
        if (!ip) { setMsg({ type: 'err', text: '请先输入对端 IP' }); return; }
        setBusy(true);
        setMsg(null);
        const res = await hostCall('connect', { role, ip });
        setBusy(false);
        const r = res?.result;
        if (res?.ok && r?.ok) { setMsg({ type: 'ok', text: r.message }); refresh(); }
        else setMsg({ type: 'err', text: (r && r.message) || res?.error?.message || '连接失败' });
      };

      const isRail = wide === false;
      const connected = status && (status.coreMode === 1 || status.coreMode === 2);

      const btn = h('button', {
        title: '键鼠共享（DeskFlow）',
        style: { ...(isRail ? s.railBtn : s.wideBtn), ...(panelOpen ? s.railBtnActive : {}) },
        onClick: () => setPanelOpen(v => !v),
      },
        h('span', { style: { fontSize: isRail ? 18 : 15, lineHeight: 1 } }, isRail ? '⌨' : '⌨ 键鼠共享'),
        !isRail && peers.length > 0
          ? h('span', { style: { ...s.badge, ...s.badgeOk, marginLeft: 'auto' } }, `${peers.length} 台设备`)
          : null,
      );

      const panel = panelOpen ? h('div', { style: s.panel },
        // 头部
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 } },
          h('div', { style: { fontSize: 16, fontWeight: 600, flex: 1 } }, '键鼠共享'),
          h('span', { style: { ...s.badge, ...(status ? s.badgeOk : s.badgeErr) } },
            status ? '● 已启动' : '● 未连接'),
          h('button', { onClick: () => setPanelOpen(false), style: { ...s.btnSecondary, border: 'none', background: 'transparent', color: T.text3, padding: '2px 6px' } }, '✕'),
        ),

        msg ? h('div', { style: msg.type === 'ok' ? s.msgOk : msg.type === 'warn' ? s.msgWarn : s.msgErr }, msg.text) : null,
        // 发现服务异常（如端口被占用）时才提示，自动重试中
        status?.discoveryError ? h('div', { style: s.msgErr }, `发现服务异常：${status.discoveryError}（自动重试中）`) : null,

        // 防火墙未放行：对端连不进来（UDP 40801 发现 / TCP 24800 键鼠连接），一键放行（UAC 提权）
        status?.firewall && status.firewall.allOk === false ? h('div', { style: s.msgWarn },
          h('div', null, '⚠ 防火墙未放行，对端可能无法发现或连接本机'),
          h('button', {
            onClick: doAllowFirewall, disabled: busy,
            style: { ...s.btnPrimary, marginTop: 8, opacity: busy ? 0.5 : 1 },
          }, '一键放行（需管理员授权）')) : null,

        // 当前连接状态
        status ? h('div', { style: { ...s.peerCard, display: 'flex', alignItems: 'center', gap: 8 } },
          h('div', { style: { flex: 1 } },
            h('div', { style: { fontSize: 12, fontWeight: 600 } }, `本机角色：${CORE_MODE_NAMES[status.coreMode] || '未知'}`),
            h('div', { style: { fontSize: 11, color: T.text3, marginTop: 2 } },
              status.deskflowRunning ? `后台核心运行中（PID ${status.deskflowPid}）` : '空闲（点下方按钮启动）')),
          connected && !busy
            ? h('button', { onClick: doDisconnect, disabled: busy, style: s.btnDanger }, '断开')
            : !busy
              ? h('button', { onClick: doStartServer, style: s.btnPrimary }, '启动服务端')
              : null,
        ) : null,

        // 自动发现开关
        h('div', { style: { ...s.peerCard, display: 'flex', alignItems: 'center', gap: 8 } },
          h('div', { style: { flex: 1 } },
            h('div', { style: { fontSize: 12, fontWeight: 600 } }, '自动发现'),
            h('div', { style: { fontSize: 11, color: T.text3, marginTop: 2 } },
              discoveryOn ? '正在广播并搜索局域网设备' : '已关闭：不广播，也不记录新设备')),
          h('button', {
            onClick: doToggleDiscovery,
            disabled: busy,
            title: discoveryOn ? '关闭自动发现' : '开启自动发现',
            style: { ...s.toggle, ...(discoveryOn ? s.toggleOn : {}), opacity: busy ? 0.5 : 1 },
          }, h('span', { style: { ...s.toggleKnob, ...(discoveryOn ? s.toggleKnobOn : {}) } })),
        ),

        // 设备列表
        h('div', { style: { ...s.sectionTitle, marginTop: 14 } },
          h('span', null, '局域网设备'),
          h('span', { style: { ...s.badge, background: T.bgLayer2, backgroundColor: opaque(T.bgLayer2), color: T.text3 } }, `${peers.length}`)),
        !discoveryOn
          ? h('div', { style: s.empty }, '发现已关闭', h('br'), '打开上方「自动发现」开关以搜索局域网设备')
          : peers.length === 0
            ? h('div', { style: s.empty }, '正在搜索局域网内安装了本插件的设备…', h('br'), '对端电脑需安装 DeepSeek Harness 并启用本插件')
            : peers.map(p => h('div', { key: p.instance, style: s.peerCard },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('div', { style: s.peerName }, p.name),
                  h('div', { style: s.peerMeta }, `${p.ip}:${p.port}`)),
                h('button', { onClick: () => doConnect('server', p), disabled: busy, style: s.btnPrimary, title: '本机作为服务端：用本机键鼠控制对方' }, '服务端'),
                h('button', { onClick: () => doConnect('client', p), disabled: busy, style: s.btnSecondary, title: '本机作为客户端：使用对方键鼠' }, '客户端'),
              ))),

        // 手动连接（无需发现，直接指定 IP）
        h('div', { style: { ...s.sectionTitle, marginTop: 14 } }, h('span', null, '手动连接')),
        h('div', { style: s.peerCard },
          h('input', {
            value: manualIp,
            onChange: (e) => setManualIp(e.target.value),
            placeholder: '对端 IP，如 192.168.1.23',
            style: s.input,
          }),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
            h('button', { onClick: () => doConnectIp('server'), disabled: busy, style: { ...s.btnPrimary, flex: 1 }, title: '本机作为服务端：用本机键鼠控制该 IP 的设备' }, '作为服务端连接'),
            h('button', { onClick: () => doConnectIp('client'), disabled: busy, style: { ...s.btnSecondary, flex: 1 }, title: '本机作为客户端：使用该 IP 设备的键鼠' }, '作为客户端连接'),
          ),
        ),

        h('p', { style: s.note }, '选择"服务端"= 用本机键鼠控制对方；"客户端"= 使用对方键鼠。连接后在后台无窗口运行。'),

        // 版本号（renderer 与 host 可能不同步，用于排查）
        h('div', { style: { fontSize: 10, color: T.text3, textAlign: 'center', marginTop: 10 } },
          `UI v${UI_VERSION} / Host v${status?.version || '?'}`),
      ) : null;

      const modal = modalPeer
        ? h(NegotiationModal, {
            peer: modalPeer, busy,
            onPick: (role) => doConnect(role, modalPeer),
            onClose: () => setModalPeer(null),
          })
        : null;

      // portal 到 body，避免被侧栏裁剪；react-dom 不可用时降级内联
      const portal = (node) => {
        if (ReactDOM?.createPortal && typeof document !== 'undefined') {
          return ReactDOM.createPortal(node, document.body);
        }
        return node;
      };

      return h('div', null, btn, portal(panel), portal(modal));
    }

    // ─── Slot 注册 ─────────────────────────────────────────────────────────
    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        realCtx = ctx;

        const registerAction = () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'deskflow-share',
          order: 90,
          label: '键鼠共享',
        }, DeskflowSidebarAction);

        if (ctx.slots && ctx.slots.inject) {
          ctx.slots.inject('sidebar.footer.action', registerAction);
          return;
        }

        // 旧版 DSH V0.2.x：直接注册，缺 API 时降级不抛错
        const slots = ctx.slots;
        if (slots && slots.register) {
          try { registerAction(); } catch (e) {
            console.warn('[deskflow] sidebar.footer.action 注册失败:', e);
          }
        }
      },
    };
  };

  // ── 新 DSH：__ModuleLoader__ ──
  if (typeof window !== 'undefined' && window.__ModuleLoader__ && window.__ModuleLoader__.load) {
    window.__ModuleLoader__.load({
      id: '@local/deskflow',
      factory: (require) => mod(require),
    });
  } else if (typeof module !== 'undefined' && module.exports) {
    // ── 旧 DSH V0.2.x ──
    module.exports = {
      inject: ['slots', 'connection'],
      apply(ctx) {
        const r = (typeof require === 'function') ? require('react') : (window.React || null);
        if (!r) {
          console.error('[deskflow] React unavailable in old-DSH client context; skipping UI registration.');
          return;
        }
        const boundRequire = (name) => (name === 'react' ? r : ((typeof require === 'function') ? require(name) : null));
        const modOut = mod(boundRequire);
        modOut.apply(ctx);
      },
    };
  } else {
    console.warn('[deskflow] No known client module protocol detected.');
  }
})();
