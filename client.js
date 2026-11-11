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

    // 真实 cordis ctx 在 apply() 捕获；组件不通过 props 读它
    let realCtx = null;

    // ─── 主题 token（DSW alias，深浅色自适应）─────────────────────────────
    const T = {
      bgLayer1: 'var(--dsw-alias-bg-layer-1)',
      bgLayer2: 'var(--dsw-alias-bg-layer-2)',
      borderL1: 'var(--dsw-alias-border-l1)',
      borderL2: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      text2: 'var(--dsw-alias-label-secondary)',
      text3: 'var(--dsw-alias-label-tertiary)',
      accent: 'var(--dsw-alias-brand-primary)',
      accentSoft: 'var(--dsw-alias-brand-primary-soft)',
      success: 'var(--dsw-alias-state-success-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
    };
    const FONT = 'var(--dsw-font-family, system-ui, sans-serif)';

    const s = {
      railBtn: { width: 36, height: 36, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.text2, padding: 0 },
      railBtnActive: { background: T.accentSoft, color: T.accent },
      wideBtn: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13, fontFamily: FONT, color: T.text2 },
      panel: { position: 'fixed', left: 64, bottom: 12, width: 340, maxHeight: 520, overflowY: 'auto', background: T.bgLayer1, border: `1px solid ${T.borderL1}`, borderRadius: 14, boxShadow: '0 8px 32px rgba(0,0,0,0.25)', padding: 16, fontFamily: FONT, fontSize: 13, color: T.text, zIndex: 9999 },
      overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT },
      modal: { width: 400, background: T.bgLayer1, border: `1px solid ${T.borderL1}`, borderRadius: 14, boxShadow: '0 12px 48px rgba(0,0,0,0.35)', padding: 22, color: T.text },
      sectionTitle: { fontSize: 13, fontWeight: 600, margin: '0 0 8px 0', color: T.text, display: 'flex', alignItems: 'center', gap: 6 },
      peerCard: { padding: 10, background: T.bgLayer2, borderRadius: 8, border: `1px solid ${T.borderL1}`, marginBottom: 8 },
      peerName: { fontSize: 13, fontWeight: 600, color: T.text },
      peerMeta: { fontSize: 11, color: T.text3, fontFamily: 'monospace', marginTop: 2 },
      btnPrimary: { padding: '6px 12px', borderRadius: 6, border: 'none', background: T.accent, color: '#fff', fontSize: 12, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap' },
      btnSecondary: { padding: '5px 10px', borderRadius: 6, border: `1px solid ${T.borderL2}`, background: T.bgLayer2, color: T.text, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' },
      btnDanger: { padding: '5px 10px', borderRadius: 6, border: `1px solid ${T.error}`, background: 'transparent', color: T.error, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' },
      badge: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 500 },
      badgeOk: { background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 15%, transparent)', color: T.success },
      badgeErr: { background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 15%, transparent)', color: T.error },
      msgOk: { padding: '8px 12px', borderRadius: 8, fontSize: 12, marginBottom: 10, background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)', color: T.success, border: '1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 30%, transparent)' },
      msgErr: { padding: '8px 12px', borderRadius: 8, fontSize: 12, marginBottom: 10, background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)', color: T.error, border: '1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent)' },
      empty: { textAlign: 'center', padding: '18px 8px', color: T.text3, fontSize: 12, lineHeight: 1.6 },
      note: { fontSize: 11, color: T.text3, margin: '8px 0 0 0', lineHeight: 1.5 },
    };

    // ─── Host RPC ───────────────────────────────────────────────────────────
    const hostCall = async (method, payload) => {
      const c = realCtx;
      if (!c) return { ok: false, error: { message: 'ctx 未就绪' } };
      const connection = c.get ? c.get('connection') : c.connection;
      if (connection?.rpc?.call) {
        try {
          return await connection.rpc.call('/api', 'deskflow', { method, payload: payload || {} });
        } catch (e) {
          return { ok: false, error: { message: `${e?.name || 'Error'}: ${e?.message || e}` } };
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
      const seenRef = React.useRef(null);
      const firstPollRef = React.useRef(true);

      const refresh = React.useCallback(async () => {
        const res = await hostCall('peers');
        const list = (res?.ok && res?.result?.peers) || [];
        const st = await hostCall('status');
        if (st?.ok && st?.result) setStatus(st.result);
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
          setMsg({ type: 'ok', text: r.message });
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
          h('span', { style: { ...s.badge, ...(status?.discovering ? s.badgeOk : s.badgeErr) } },
            status?.discovering ? '● 发现中' : '● 未运行'),
          h('button', { onClick: () => setPanelOpen(false), style: { ...s.btnSecondary, border: 'none', background: 'transparent', color: T.text3, padding: '2px 6px' } }, '✕'),
        ),

        msg ? h('div', { style: msg.type === 'ok' ? s.msgOk : s.msgErr }, msg.text) : null,

        // 当前连接状态
        status ? h('div', { style: { ...s.peerCard, display: 'flex', alignItems: 'center', gap: 8 } },
          h('div', { style: { flex: 1 } },
            h('div', { style: { fontSize: 12, fontWeight: 600 } }, `本机角色：${CORE_MODE_NAMES[status.coreMode] || '未知'}`),
            h('div', { style: { fontSize: 11, color: T.text3, marginTop: 2 } },
              status.deskflowRunning ? `后台核心运行中（PID ${status.deskflowPid}）` : '后台核心未运行')),
          connected && !busy
            ? h('button', { onClick: doDisconnect, disabled: busy, style: s.btnDanger }, '断开')
            : null,
        ) : null,

        // 设备列表
        h('div', { style: { ...s.sectionTitle, marginTop: 14 } },
          h('span', null, '局域网设备'),
          h('span', { style: { ...s.badge, background: T.bgLayer2, color: T.text3 } }, `${peers.length}`)),
        peers.length === 0
          ? h('div', { style: s.empty }, '正在搜索局域网内安装了本插件的设备…', h('br'), '对端电脑需安装 DeepSeek Harness 并启用本插件')
          : peers.map(p => h('div', { key: p.instance, style: s.peerCard },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('div', { style: s.peerName }, p.name),
                  h('div', { style: s.peerMeta }, `${p.ip}:${p.port}`)),
                h('button', { onClick: () => doConnect('server', p), disabled: busy, style: s.btnPrimary, title: '本机作为服务端：用本机键鼠控制对方' }, '服务端'),
                h('button', { onClick: () => doConnect('client', p), disabled: busy, style: s.btnSecondary, title: '本机作为客户端：使用对方键鼠' }, '客户端'),
              ))),

        h('p', { style: s.note }, '选择"服务端"= 用本机键鼠控制对方；"客户端"= 使用对方键鼠。连接后在后台无窗口运行。'),
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
