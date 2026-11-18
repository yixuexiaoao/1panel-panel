// 1Panel Fleet 前端。所有来自面板的数据都经 textContent 渲染，不拼接 HTML。
import { renderServerFiles, renderServerCronjobs } from './server-tools.js';

const state = {
  me: null,
  servers: [],
  selected: new Set(),
  filter: { q: '', group: '' },
  timer: null,
  cleanup: null,
};

// ---------- 基础工具 ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : String(kid));
  }
  return el;
}
const $ = (sel, root = document) => root.querySelector(sel);
/** 替换子节点；与 h() 一样接受嵌套数组并忽略空值 */
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return el;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'opf' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') {
    renderLogin();
    throw new Error(json.error || '未登录');
  }
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json.data;
}

function toast(message, bad = false) {
  const el = h('div', { class: `toast${bad ? ' bad' : ''}`, role: 'status' }, message);
  $('#toast-root').append(el);
  setTimeout(() => el.remove(), bad ? 6000 : 3500);
}

/** 包装异步点击：防重复提交、统一报错 */
function busy(fn) {
  return async (ev) => {
    const btn = ev?.currentTarget;
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;
    try {
      await fn(ev);
    } catch (e) {
      toast(e.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  };
}

function modal(title, body, buttons = [], { wide = false } = {}) {
  const close = () => overlay.remove();
  const overlay = h('div', { class: 'overlay', onkeydown: (e) => e.key === 'Escape' && close() },
    h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('header', null, title),
      h('div', { class: 'body' }, body),
      h('footer', null,
        h('button', { class: 'btn', onclick: close }, buttons.length ? '取消' : '关闭'),
        buttons.map((b) => h('button', {
          class: `btn ${b.danger ? 'danger' : 'primary'}`,
          onclick: busy(async () => { if ((await b.onClick()) !== false) close(); }),
        }, b.label)))));
  $('#modal-root').append(overlay);
  (overlay.querySelector('input, textarea, select') || overlay.querySelector('button'))?.focus();
  return close;
}

function confirmDialog(title, message, { danger = false, label = '确认' } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    const overlayClose = modal(title, h('div', null, message), [{ label, danger, onClick: () => { ok = true; } }]);
    const root = $('#modal-root').lastElementChild;
    new MutationObserver((_, obs) => {
      if (!root.isConnected) { obs.disconnect(); resolve(ok); }
    }).observe($('#modal-root'), { childList: true });
    void overlayClose;
  });
}

const field = (label, input, hint) => h('label', { class: 'field' }, h('span', null, label), input, hint && h('span', { class: 'hint' }, hint));
// 内部含多个复选框时不能用 label 包裹，否则点击任意位置都会切换第一个复选框
const block = (label, el) => h('div', { class: 'field' }, h('span', null, label), el);
const check = (label, input) => h('label', { class: 'check' }, input, label);

function fmtBytes(n) {
  if (!n) return '0';
  const units = ['B', 'K', 'M', 'G', 'T', 'P'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i > 2 ? 1 : 0)}${units[i]}`;
}
function fmtUptime(sec) {
  if (!sec) return '-';
  const d = Math.floor(sec / 86400);
  const hr = Math.floor((sec % 86400) / 3600);
  return d > 0 ? `${d} 天 ${hr} 时` : `${hr} 时 ${Math.floor((sec % 3600) / 60)} 分`;
}
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '-');

function meter(percent, title) {
  if (percent == null) return h('span', { class: 'muted' }, '-');
  const p = Math.max(0, Math.min(100, percent));
  const level = p >= 90 ? 'bad' : p >= 75 ? 'warn' : '';
  return h('div', { class: 'meter', title: title || '' },
    h('div', { class: 'track' }, h('div', { class: `fill ${level}`, style: { width: `${p}%` } })),
    h('span', { class: 'pct' }, `${p.toFixed(0)}%`));
}

/** 目标服务器多选框，仅列出在线服务器 */
function serverPicker(preselect = []) {
  const online = state.servers.filter((s) => s.status.state === 'online');
  const pre = new Set(preselect);
  const boxes = online.map((s) => h('input', { type: 'checkbox', value: s.id, checked: pre.has(s.id) }));
  const all = h('input', { type: 'checkbox', onchange: () => boxes.forEach((b) => (b.checked = all.checked)) });
  const el = h('div', { class: 'picker' },
    online.length
      ? [h('label', { class: 'head' }, all, `全选（${online.length} 台在线）`),
        online.map((s, i) => h('label', null, boxes[i], s.name, s.group && h('span', { class: 'muted' }, `· ${s.group}`)))]
      : h('div', { class: 'muted' }, '没有在线的服务器'));
  return { el, value: () => boxes.filter((b) => b.checked).map((b) => b.value) };
}

/** 展示批量操作结果；未完成的转入任务页 */
function showJob(job) {
  if (job.status === 'running') {
    toast('操作仍在进行，已转入后台，可在“任务”页查看');
    return;
  }
  const failed = job.items.filter((i) => i.status === 'failed');
  if (!failed.length && job.items.length === 1) return toast(job.items[0].message || '操作成功');
  modal(`${job.title}：成功 ${job.items.length - failed.length} / 失败 ${failed.length}`, jobTable(job), [], { wide: true });
}

const JOB_BADGE = { pending: ['等待', ''], running: ['进行中', 'warn'], success: ['成功', 'ok'], failed: ['失败', 'bad'] };
function jobTable(job) {
  return h('table', null,
    h('thead', null, h('tr', null, h('th', null, '服务器'), h('th', null, '状态'), h('th', null, '信息'))),
    h('tbody', null, job.items.map((it) => h('tr', null,
      h('td', null, it.name),
      h('td', null, h('span', { class: `badge ${JOB_BADGE[it.status][1]}` }, JOB_BADGE[it.status][0])),
      h('td', null, it.message || '')))));
}

// ---------- 登录 ----------
function renderLogin() {
  clearInterval(state.timer);
  state.cleanup?.();
  state.cleanup = null;
  state.me = null;
  $('#modal-root').replaceChildren();
  const user = h('input', { type: 'text', autocomplete: 'username', value: 'admin', required: true });
  const pass = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const err = h('div', { class: 'error', role: 'alert' });
  const form = h('form', {
    class: 'login',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      try {
        await api('POST', '/api/login', { username: user.value, password: pass.value });
        await boot();
      } catch (ex) {
        err.textContent = ex.message;
      }
    },
  },
  h('h1', null, '1Panel Fleet'),
  field('用户名', user),
  field('密码', pass),
  err,
  h('button', { class: 'btn primary', type: 'submit', style: { width: '100%', justifyContent: 'center' } }, '登录'));
  $('#app').replaceChildren(h('div', { class: 'login-wrap' }, form));
  pass.focus();
}

// ---------- 外壳与路由 ----------
const VIEWS = [
  ['servers', '服务器', viewServers],
  ['containers', '跨服务器容器', viewContainers],
  ['jobs', '任务', viewJobs],
  ['audit', '操作日志', viewAudit],
];

function renderShell() {
  const current = location.hash.replace(/^#\/?/, '').split('?')[0] || 'servers';
  const detail = current.match(/^servers\/([^/]+)(?:\/([^/]+))?$/);
  const view = VIEWS.find((v) => v[0] === current) || VIEWS[0];
  clearInterval(state.timer);
  state.cleanup?.();
  state.cleanup = null;
  fill($('#modal-root'));
  const main = h('main');
  $('#app').replaceChildren(
    h('div', { class: 'topbar' },
      h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), '1Panel Fleet'),
      h('nav', { class: 'nav' }, VIEWS.map(([id, label]) => h('a', { href: `#/${id}`, class: id === view[0] ? 'active' : '' }, label))),
      h('div', { class: 'right' },
        state.me.readOnly && h('span', { class: 'badge warn' }, '只读模式'),
        h('span', null, `v${state.me.version}`),
        h('button', { class: 'btn small', onclick: busy(async () => { await api('POST', '/api/logout'); renderLogin(); }) }, '退出'))),
    main);
  if (detail) {
    try {
      viewServer(main, decodeURIComponent(detail[1]), detail[2] || 'overview');
    } catch {
      fill(main, h('div', { class: 'empty' }, '服务器地址无效'));
    }
  } else view[2](main);
}

const canWrite = () => !state.me.readOnly;
const serverHref = (id, tab = 'overview') => `#/servers/${encodeURIComponent(id)}/${tab}`;

// ---------- 单机管理 ----------
async function viewServer(main, serverId, selectedTab) {
  fill(main, h('div', { class: 'empty' }, '加载服务器…'));
  try {
    await loadServers();
    if (!main.isConnected) return;
    const server = state.servers.find((s) => s.id === serverId);
    if (!server) return fill(main, h('div', { class: 'empty' }, '服务器不存在或已移除。', h('a', { href: '#/servers' }, '返回服务器列表')));
    const tabs = [['overview', '概览'], ['containers', '容器'], ['composes', 'Compose 编排'], ['files', '文件'], ['cronjobs', '定时任务']];
    const tab = tabs.some(([id]) => id === selectedTab) ? selectedTab : 'overview';
    const status = server.status;
    const content = h('section', { class: 'server-content', 'aria-label': `${server.name} ${tabs.find(([id]) => id === tab)[1]}` });
    fill(main,
      h('div', { class: 'server-header' },
        h('div', null,
          h('a', { class: 'back-link', href: '#/servers' }, '← 服务器列表'),
          h('h1', null, server.name, ' ', h('span', { class: `badge ${status.state === 'online' ? 'ok' : status.state === 'offline' ? 'bad' : ''}` }, status.state === 'online' ? '在线' : status.state === 'offline' ? '离线' : '待检查')),
          h('div', { class: 'muted' }, [server.group, server.url, status.version].filter(Boolean).join(' · '))),
        h('div', { class: 'toolbar' },
          h('button', { class: 'btn', onclick: busy(async () => {
            await api('POST', `/api/servers/${server.id}/refresh`);
            if (main.isConnected) renderShell();
          }) }, '刷新状态'),
          h('a', { class: 'btn', href: server.url, target: '_blank', rel: 'noopener noreferrer' }, '打开原面板 ↗'))),
      status.error && h('div', { class: 'banner', role: 'status' }, status.error),
      h('nav', { class: 'server-tabs', 'aria-label': '单机管理' }, tabs.map(([id, label]) =>
        h('a', { href: serverHref(server.id, id), class: id === tab ? 'active' : '', 'aria-current': id === tab ? 'page' : null }, label))),
      content);
    if (tab === 'containers' || tab === 'composes') {
      viewContainers(content, { server, tab });
    } else if (tab === 'files' || tab === 'cronjobs') {
      const ctx = { server, h, fill, api, toast, busy, modal, confirmDialog, field, block, check, fmtBytes, fmtTime, canWrite };
      state.cleanup = (tab === 'files' ? renderServerFiles : renderServerCronjobs)(content, ctx);
    } else renderServerOverview(content, server);
  } catch (e) {
    if (main.isConnected) fill(main, h('div', { class: 'empty' }, e.message));
  }
}

function renderServerOverview(main, server) {
  const status = server.status;
  const stat = (label, value) => h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value));
  const load = status.load?.map((n) => n == null ? '-' : Number(n).toFixed(2)).join(' / ') || '-';
  const detail = (label, value) => h('div', { class: 'server-fact' }, h('dt', null, label), h('dd', null, value || '-'));
  main.append(
    h('div', { class: 'stats' },
      stat('CPU', status.cpu == null ? '-' : `${status.cpu.toFixed(0)}%`),
      stat('内存', status.mem?.percent == null ? '-' : `${status.mem.percent.toFixed(0)}%`),
      stat('运行时间', fmtUptime(status.uptime)),
      stat('容器', status.containers ? `${status.containers.running} / ${status.containers.total}` : '-')),
    h('div', { class: 'server-overview-grid' },
      h('section', { class: 'card server-info' }, h('h2', null, '系统信息'),
        h('dl', null, detail('主机名', status.hostname), detail('操作系统', status.os), detail('架构 / 内核', [status.arch, status.kernel].filter(Boolean).join(' / ')),
          detail('CPU 核心', status.cpuCores), detail('内存使用', status.mem ? `${fmtBytes(status.mem.used)} / ${fmtBytes(status.mem.total)}` : ''),
          detail('负载 1 / 5 / 15 分钟', load), detail('最后检查', fmtTime(status.checkedAt)), detail('备注', server.note))),
      h('section', { class: 'card server-info' }, h('h2', null, '磁盘使用'),
        status.disks?.length ? status.disks.map((disk) => h('div', { class: 'server-disk' }, h('div', { class: 'toolbar' }, h('strong', null, disk.path), h('span', { class: 'spacer' }), `${fmtBytes(disk.used)} / ${fmtBytes(disk.total)}`), meter(disk.percent))) : h('p', { class: 'muted' }, '暂无磁盘信息'))),
    h('div', { class: 'server-shortcuts' },
      [['containers', '管理容器', '查看运行状态、启动和停止容器'], ['composes', '管理编排', '部署和维护 Compose 项目'], ['files', '管理文件', '浏览目录、查看和编辑文件'], ['cronjobs', '管理定时任务', '查看执行记录、日志和调度状态']].map(([tab, title, description]) =>
        h('a', { class: 'card server-shortcut', href: serverHref(server.id, tab) }, h('strong', null, title), h('span', { class: 'muted' }, description)))));
}

// ---------- 服务器 ----------
async function loadServers() {
  state.servers = await api('GET', '/api/servers');
  const ids = new Set(state.servers.map((s) => s.id));
  for (const id of state.selected) if (!ids.has(id)) state.selected.delete(id);
}

function viewServers(main) {
  const statsEl = h('div', { class: 'stats' });
  const tableEl = h('div', { class: 'card' });
  const groupSel = h('select', { 'aria-label': '分组筛选', onchange: () => { state.filter.group = groupSel.value; draw(); } });
  const search = h('input', { type: 'search', placeholder: '搜索名称 / 地址 / 主机名', value: state.filter.q, oninput: () => { state.filter.q = search.value; draw(); } });
  const upgradeBtn = h('button', { class: 'btn', onclick: () => upgradeDialog() }, '批量升级');

  main.append(
    statsEl,
    h('div', { class: 'toolbar' },
      search, groupSel, h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: busy(async () => { state.servers = await api('POST', '/api/refresh', { checkUpgrade: true }); draw(); toast('已刷新并检查更新'); }) }, '刷新并检查更新'),
      canWrite() && upgradeBtn,
      canWrite() && h('button', { class: 'btn primary', onclick: () => serverDialog() }, '添加服务器')),
    tableEl);

  function visible() {
    const q = state.filter.q.trim().toLowerCase();
    return state.servers.filter((s) =>
      (!state.filter.group || (s.group || '未分组') === state.filter.group) &&
      (!q || [s.name, s.url, s.status.hostname, s.note].some((v) => String(v || '').toLowerCase().includes(q))));
  }

  function draw() {
    const all = state.servers;
    const online = all.filter((s) => s.status.state === 'online');
    const offline = all.filter((s) => s.status.state === 'offline').length;
    const upgradable = all.filter((s) => s.status.upgrade?.newVersion).length;
    const running = online.reduce((n, s) => n + (s.status.containers?.running || 0), 0);
    const stat = (label, value, cls = '') => h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: `value ${cls}` }, value));
    fill(statsEl, 
      stat('服务器', all.length),
      stat('在线', online.length),
      stat('离线', offline, offline ? 'bad' : ''),
      stat('可升级', upgradable, upgradable ? 'warn' : ''),
      stat('运行中容器', running));

    const groups = [...new Set(all.map((s) => s.group || '未分组'))].sort();
    fill(groupSel, h('option', { value: '' }, '全部分组'), groups.map((g) => h('option', { value: g, selected: g === state.filter.group }, g)));
    upgradeBtn.textContent = state.selected.size ? `批量升级（${state.selected.size}）` : '批量升级';

    const list = visible();
    if (!all.length) {
      fill(tableEl, h('div', { class: 'empty' }, '还没有服务器。点击右上角“添加服务器”，填入面板地址和 API Key。'));
      return;
    }
    const allBox = h('input', {
      type: 'checkbox', 'aria-label': '全选',
      checked: list.length > 0 && list.every((s) => state.selected.has(s.id)),
      onchange: () => { list.forEach((s) => (allBox.checked ? state.selected.add(s.id) : state.selected.delete(s.id))); draw(); },
    });
    const rows = [];
    for (const g of groups) {
      const members = list.filter((s) => (s.group || '未分组') === g);
      if (!members.length) continue;
      if (groups.length > 1) rows.push(h('tr', { class: 'group-row' }, h('td', { colSpan: 11 }, `${g}（${members.length}）`)));
      rows.push(...members.map(serverRow));
    }
    fill(tableEl, h('table', null,
      h('thead', null, h('tr', null,
        h('th', null, allBox), h('th', null, '名称'), h('th', null, '状态'), h('th', null, '版本'), h('th', null, '系统'),
        h('th', null, 'CPU'), h('th', null, '内存'), h('th', null, '磁盘'), h('th', null, '负载'), h('th', null, '容器'), h('th', null, ''))),
      h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colSpan: 11, class: 'empty' }, '没有匹配的服务器')))));
  }

  function serverRow(s) {
    const st = s.status;
    const on = st.state === 'online';
    const disk = (st.disks || []).reduce((a, d) => (!a || d.percent > a.percent ? d : a), null);
    const diskTitle = (st.disks || []).map((d) => `${d.path}  ${fmtBytes(d.used)} / ${fmtBytes(d.total)}`).join('\n');
    const box = h('input', {
      type: 'checkbox', 'aria-label': `选择 ${s.name}`, checked: state.selected.has(s.id),
      onchange: () => { box.checked ? state.selected.add(s.id) : state.selected.delete(s.id); draw(); },
    });
    return h('tr', null,
      h('td', null, box),
      h('td', { class: 'name-cell' },
        h('div', null, h('a', { href: serverHref(s.id), title: '进入服务器管理' }, s.name)),
        h('div', { class: 'sub' }, [st.hostname, s.note].filter(Boolean).join(' · ') || s.url)),
      h('td', null, on
        ? h('span', { class: 'badge ok', title: `运行 ${fmtUptime(st.uptime)}\n检查于 ${fmtTime(st.checkedAt)}` }, '在线')
        : h('span', { class: `badge ${st.state === 'offline' ? 'bad' : ''}`, title: st.error || '' }, st.state === 'offline' ? '离线' : '未检查'),
      !on && st.error && h('div', { class: 'sub muted', style: { fontSize: '12px', maxWidth: '220px' } }, st.error)),
      h('td', { class: 'num' }, st.version || '-', ' ',
        st.upgrade?.newVersion && h('span', { class: 'badge warn', title: `可升级到 ${st.upgrade.newVersion}` }, `→ ${st.upgrade.newVersion}`)),
      h('td', { class: 'wrap', title: [st.os, st.arch, st.kernel].filter(Boolean).join(' / ') }, on ? st.os || '-' : '-'),
      h('td', null, on ? meter(st.cpu, `${st.cpuCores} 核`) : '-'),
      h('td', null, on ? meter(st.mem?.percent, `${fmtBytes(st.mem?.used)} / ${fmtBytes(st.mem?.total)}`) : '-'),
      h('td', null, on && disk ? meter(disk.percent, diskTitle) : '-'),
      h('td', { class: 'num' }, on && st.load?.[0] != null ? st.load.map((n) => Number(n).toFixed(2)).join(' ') : '-'),
      h('td', { class: 'num' }, on && st.containers
        ? h('a', { href: serverHref(s.id, 'containers') }, `${st.containers.running} / ${st.containers.total}`)
        : '-'),
      h('td', { class: 'actions' },
        h('a', { class: 'btn link', href: serverHref(s.id) }, '管理'),
        h('button', { class: 'btn link', onclick: busy(async () => { const r = await api('POST', `/api/servers/${s.id}/refresh`); Object.assign(s, r); draw(); }) }, '刷新'),
        canWrite() && h('button', { class: 'btn link', onclick: () => serverDialog(s) }, '编辑'),
        canWrite() && h('button', { class: 'btn link danger', onclick: busy(() => removeServer(s)) }, '删除')));
  }

  async function removeServer(s) {
    if (!(await confirmDialog('删除服务器', `确定从列表中移除“${s.name}”吗？只会删除本程序里的记录，不影响服务器本身。`, { danger: true, label: '删除' }))) return;
    await api('DELETE', `/api/servers/${s.id}`);
    await loadServers();
    draw();
  }

  function serverDialog(s) {
    const f = {
      name: h('input', { type: 'text', value: s?.name || '', maxLength: 60 }),
      url: h('input', { type: 'text', value: s?.url || '', placeholder: 'https://example.com:10086' }),
      apiKey: h('input', { type: 'password', autocomplete: 'off', placeholder: s ? '留空表示不修改' : '' }),
      keyId: h('input', { type: 'text', value: s?.keyId || '', placeholder: '可选' }),
      group: h('input', { type: 'text', value: s?.group || '', maxLength: 40, placeholder: '可选，如：生产' }),
      note: h('input', { type: 'text', value: s?.note || '', maxLength: 200, placeholder: '可选' }),
      skipTls: h('input', { type: 'checkbox', checked: !!s?.skipTls }),
    };
    modal(s ? '编辑服务器' : '添加服务器', h('div', null,
      h('div', { class: 'grid2' }, field('名称', f.name), field('分组', f.group)),
      field('面板地址', f.url, '只填协议、域名或 IP、端口，不要带安全入口路径'),
      field('API Key', f.apiKey, '在面板“面板设置 → API 接口”中开启并复制；需把本程序的出口 IP 加入白名单'),
      h('div', { class: 'grid2' }, field('Key ID', f.keyId, '面板启用多个 API Key 时填写'), field('备注', f.note)),
      check('跳过 TLS 证书校验（面板使用自签名证书时勾选）', f.skipTls)),
    [{
      label: '保存并测试连接',
      onClick: async () => {
        const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));
        const saved = await (s ? api('PUT', `/api/servers/${s.id}`, body) : api('POST', '/api/servers', body));
        await loadServers();
        draw();
        if (saved.status.state === 'online') toast(`连接成功：${saved.status.version || ''} ${saved.status.hostname || ''}`);
        else toast(`已保存，但连接失败：${saved.status.error}`, true);
      },
    }]);
  }

  function upgradeDialog() {
    const candidates = state.servers.filter((s) => state.selected.has(s.id));
    const pool = candidates.length ? candidates : state.servers;
    const targets = pool.filter((s) => s.status.state === 'online' && s.status.upgrade?.newVersion);
    if (!targets.length) return toast(candidates.length ? '所选服务器没有可用更新' : '没有可升级的服务器，可先点击“刷新并检查更新”');
    const channel = h('select', null,
      h('option', { value: 'new' }, '面板推荐的升级版本（上表目标版本）'),
      h('option', { value: 'latest' }, '面板给出的最新版本（latestVersion）'));
    modal('批量升级 1Panel', h('div', null,
      h('p', null, `将升级以下 ${targets.length} 台服务器。升级期间面板会重启，面板页面短暂不可用，已运行的容器和网站不受影响。`),
      h('table', null,
        h('thead', null, h('tr', null, h('th', null, '服务器'), h('th', null, '当前版本'), h('th', null, '目标版本'))),
        h('tbody', null, targets.map((s) => h('tr', null, h('td', null, s.name), h('td', null, s.status.version), h('td', null, s.status.upgrade.newVersion))))),
      h('div', { style: { marginTop: '14px' } }, field('升级通道', channel))),
    [{
      label: `升级 ${targets.length} 台`,
      onClick: async () => {
        await api('POST', '/api/upgrade', { serverIds: targets.map((s) => s.id), channel: channel.value });
        location.hash = '#/jobs';
      },
    }], { wide: true });
  }

  const tick = () => loadServers().then(draw).catch((e) => console.warn(e));
  tick();
  state.timer = setInterval(() => { if (!$('#modal-root').childElementCount) tick(); }, 15000);
}

// ---------- 容器 ----------
const STATE_BADGE = { running: 'ok', exited: 'bad', dead: 'bad', paused: 'warn', restarting: 'warn', created: '' };

function viewContainers(main, { server, tab: initialTab = 'containers' } = {}) {
  let tab = initialTab;
  let groups = [];
  let requestVersion = 0;
  const picked = new Map(); // `${serverId}\n${name}` -> { serverId, name }
  const preset = server?.id || 'all';

  const serverSel = h('select', { 'aria-label': '服务器', hidden: !!server, onchange: () => reload() });
  const stateSel = h('select', { 'aria-label': '状态', hidden: tab !== 'containers', onchange: () => reload() },
    [['all', '全部状态'], ['running', '运行中'], ['exited', '已停止'], ['paused', '已暂停'], ['restarting', '重启中'], ['created', '已创建']]
      .map(([v, l]) => h('option', { value: v }, l)));
  const search = h('input', { type: 'search', placeholder: '按名称搜索', onkeydown: (e) => e.key === 'Enter' && reload() });
  const tabsEl = h('div', { class: 'tabs', hidden: !!server });
  const batchEl = h('span');
  const listEl = h('div', { class: 'card' });
  const deployButton = h('button', { class: 'btn primary', hidden: tab !== 'composes', onclick: () => composeDialog() }, '部署 Compose');
  const createButton = h('button', { class: 'btn primary', hidden: tab !== 'containers', onclick: () => createDialog() }, '创建容器');

  main.append(
    tabsEl,
    h('div', { class: 'toolbar' },
      serverSel, stateSel, search, h('button', { class: 'btn', onclick: () => reload() }, '查询'), batchEl,
      h('span', { class: 'spacer' }),
      canWrite() && h('button', { class: 'btn', onclick: () => pullDialog() }, '拉取镜像'),
      canWrite() && deployButton,
      canWrite() && createButton),
    listEl);

  function drawTabs() {
    deployButton.hidden = tab !== 'composes';
    createButton.hidden = tab !== 'containers';
    fill(tabsEl, [['containers', '容器'], ['composes', 'Compose 编排']].map(([id, label]) =>
      h('button', { class: id === tab ? 'active' : '', onclick: () => { tab = id; stateSel.hidden = id !== 'containers'; picked.clear(); drawTabs(); reload(); } }, label)));
  }

  async function reload() {
    const version = ++requestVersion;
    picked.clear();
    fill(batchEl);
    fill(listEl, h('div', { class: 'empty' }, '加载中…'));
    try {
      const q = new URLSearchParams({ server: server?.id || serverSel.value || 'all', name: search.value.trim() });
      if (tab === 'containers') q.set('state', stateSel.value);
      const result = await api('GET', `/api/${tab}?${q}`);
      if (!main.isConnected || version !== requestVersion) return;
      groups = result;
      draw();
    } catch (e) {
      if (main.isConnected && version === requestVersion) fill(listEl, h('div', { class: 'empty' }, e.message));
    }
  }

  function draw() {
    drawBatch();
    const errors = groups.filter((g) => g.error);
    const rows = groups.flatMap((g) => g.items.map((it) => (tab === 'containers' ? containerRow(g, it) : composeRow(g, it))));
    const head = tab === 'containers'
      ? ['', '服务器', '名称', '镜像', '状态', '端口', '运行时长', '来源', '']
      : ['服务器', '名称', '容器', '路径', '创建时间', ''];
    fill(listEl, 
      errors.length ? h('div', { class: 'banner', style: { margin: '12px' } }, errors.map((g) => h('div', null, `${g.serverName}：${g.error}`))) : null,
      h('table', null,
        h('thead', null, h('tr', null, head.map((t) => h('th', null, t)))),
        h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colSpan: head.length, class: 'empty' }, '没有数据')))));
  }

  function drawBatch() {
    if (tab !== 'containers' || !canWrite() || !picked.size) return fill(batchEl);
    const targets = () => {
      const by = new Map();
      for (const p of picked.values()) by.set(p.serverId, [...(by.get(p.serverId) || []), p.name]);
      return [...by].map(([serverId, names]) => ({ serverId, names }));
    };
    fill(batchEl, 
      h('span', { class: 'muted' }, `已选 ${picked.size} 个：`),
      [['start', '启动'], ['stop', '停止'], ['restart', '重启']].map(([op, label]) =>
        h('button', { class: 'btn small', onclick: busy(() => operate(targets(), op, `${picked.size} 个容器`)) }, label)));
  }

  async function operate(targets, operation, what) {
    const risky = ['stop', 'restart', 'kill', 'remove'].includes(operation);
    const LABEL = { start: '启动', stop: '停止', restart: '重启', remove: '删除' };
    if (risky && !(await confirmDialog(`${LABEL[operation]}容器`,
      operation === 'remove' ? `确定删除 ${what} 吗？容器内未挂载到主机的数据会丢失，且无法恢复。` : `确定${LABEL[operation]} ${what} 吗？`,
      { danger: operation === 'remove', label: LABEL[operation] }))) return;
    showJob(await api('POST', '/api/containers/operate', { targets, operation }));
    await reload();
  }

  function containerRow(g, c) {
    const key = `${g.serverId}\n${c.name}`;
    const one = [{ serverId: g.serverId, names: [c.name] }];
    const box = h('input', {
      type: 'checkbox', 'aria-label': `选择 ${c.name}`,
      onchange: () => { box.checked ? picked.set(key, { serverId: g.serverId, name: c.name }) : picked.delete(key); drawBatch(); },
    });
    const running = c.state === 'running';
    return h('tr', null,
      h('td', null, canWrite() && box),
      h('td', null, server ? g.serverName : h('a', { href: serverHref(g.serverId, 'containers') }, g.serverName)),
      h('td', null, c.name),
      h('td', { class: 'wrap mono', title: c.imageName }, c.imageName),
      h('td', null, h('span', { class: `badge ${STATE_BADGE[c.state] ?? ''}` }, c.state)),
      h('td', { class: 'wrap mono', title: (c.ports || []).join('\n') }, (c.ports || []).join(', ') || '-'),
      h('td', { class: 'num' }, c.runTime || '-'),
      h('td', null, c.isFromApp ? h('span', { class: 'badge', title: c.appInstallName || c.appName }, '应用商店') : c.isFromCompose ? h('span', { class: 'badge' }, 'Compose') : h('span', { class: 'muted' }, '独立')),
      h('td', { class: 'actions' }, canWrite() && [
        running
          ? h('button', { class: 'btn link', onclick: busy(() => operate(one, 'stop', c.name)) }, '停止')
          : h('button', { class: 'btn link', onclick: busy(() => operate(one, 'start', c.name)) }, '启动'),
        h('button', { class: 'btn link', onclick: busy(() => operate(one, 'restart', c.name)) }, '重启'),
        h('button', { class: 'btn link', onclick: () => upgradeContainerDialog(g, c) }, '升级'),
        h('button', { class: 'btn link danger', onclick: busy(() => operate(one, 'remove', c.name)) }, '删除'),
      ]));
  }

  function composeRow(g, c) {
    const op = (operation, label, danger) => h('button', {
      class: `btn link${danger ? ' danger' : ''}`,
      onclick: busy(async () => {
        if (operation !== 'up' && operation !== 'start' && !(await confirmDialog(`${label}编排`,
          operation === 'down' ? `确定对“${c.name}”执行 down 吗？编排内的容器会被停止并移除，数据卷与 compose 文件保留。` : `确定${label}“${c.name}”吗？`,
          { danger, label }))) return;
        showJob(await api('POST', '/api/composes/operate', { serverId: g.serverId, name: c.name, path: c.path, operation }));
        await reload();
      }),
    }, label);
    return h('tr', null,
      h('td', null, server ? g.serverName : h('a', { href: serverHref(g.serverId, 'composes') }, g.serverName)),
      h('td', null, c.name, ' ', c.createdBy === 'Apps' && h('span', { class: 'badge' }, '应用商店')),
      h('td', { class: 'num' }, `${c.runningCount ?? 0} / ${c.containerCount ?? 0}`),
      h('td', { class: 'wrap mono', title: c.path }, c.path || '-'),
      h('td', { class: 'num' }, c.createdAt || '-'),
      h('td', { class: 'actions' }, canWrite() && [op('up', '启动'), op('restart', '重启'), op('stop', '停止'), op('down', 'Down', true)]));
  }

  const defaultTargets = () => (server?.id ? [server.id] : serverSel.value && serverSel.value !== 'all' ? [serverSel.value] : []);
  const targetPicker = () => server
    ? { el: h('div', { class: 'muted' }, server.name), value: () => [server.id] }
    : serverPicker(defaultTargets());

  function upgradeContainerDialog(g, c) {
    const image = h('input', { type: 'text', value: c.imageName || '' });
    const force = h('input', { type: 'checkbox', checked: true });
    modal(`升级容器 ${c.name}`, h('div', null,
      h('p', { class: 'muted' }, `服务器：${g.serverName}。面板会用新镜像重建该容器，原有的端口、挂载、环境变量配置保留。`),
      field('目标镜像', image, '保持镜像名不变并勾选强制拉取，可更新到同标签的最新镜像'),
      check('强制拉取镜像', force)),
    [{
      label: '升级',
      onClick: async () => {
        showJob(await api('POST', '/api/containers/upgrade', { targets: [{ serverId: g.serverId, names: [c.name] }], image: image.value.trim(), forcePull: force.checked }));
        await reload();
      },
    }]);
  }

  function createDialog() {
    const picker = targetPicker();
    const f = {
      name: h('input', { type: 'text', placeholder: 'my-app' }),
      image: h('input', { type: 'text', placeholder: 'nginx:1.27' }),
      ports: h('textarea', { rows: 2, placeholder: '8080:80\n127.0.0.1:5353:53/udp' }),
      volumes: h('textarea', { rows: 2, placeholder: '/opt/my-app/data:/data\n/etc/localtime:/etc/localtime:ro' }),
      env: h('textarea', { rows: 2, placeholder: 'TZ=Asia/Shanghai' }),
      restartPolicy: h('select', null, ['unless-stopped', 'always', 'on-failure', 'no'].map((v) => h('option', { value: v }, v))),
      network: h('input', { type: 'text', value: 'bridge' }),
      forcePull: h('input', { type: 'checkbox' }),
    };
    modal('创建容器', h('div', null,
      block('目标服务器', picker.el),
      h('div', { class: 'grid2' }, field('容器名称', f.name), field('镜像', f.image)),
      field('端口映射', f.ports, '每行一条：主机端口:容器端口[/udp]'),
      field('目录挂载', f.volumes, '每行一条：主机目录或卷名:/容器目录[:ro]'),
      field('环境变量', f.env, '每行一条：KEY=VALUE'),
      h('div', { class: 'grid2' }, field('重启策略', f.restartPolicy), field('网络', f.network)),
      check('强制拉取镜像', f.forcePull)),
    [{
      label: '创建',
      onClick: async () => {
        const spec = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));
        showJob(await api('POST', '/api/containers/create', { serverIds: picker.value(), spec }));
        await reload();
      },
    }], { wide: true });
  }

  function composeDialog() {
    const picker = targetPicker();
    const name = h('input', { type: 'text', placeholder: 'my-stack' });
    const file = h('textarea', { rows: 12, placeholder: 'services:\n  web:\n    image: nginx:1.27\n    ports:\n      - "8080:80"\n    restart: unless-stopped' });
    const env = h('textarea', { rows: 3, placeholder: 'KEY=VALUE（可选，写入 .env）' });
    const force = h('input', { type: 'checkbox' });
    modal('部署 Compose 编排', h('div', null,
      block('目标服务器', picker.el),
      field('编排名称', name, '小写字母、数字、_ -；同时作为面板中的目录名'),
      field('docker-compose.yml', file),
      field('环境变量', env),
      check('强制拉取镜像', force)),
    [{
      label: '部署',
      onClick: async () => {
        showJob(await api('POST', '/api/composes/create', { serverIds: picker.value(), name: name.value.trim(), file: file.value, env: env.value, forcePull: force.checked }));
        tab = 'composes';
        stateSel.hidden = true;
        drawTabs();
        await reload();
      },
    }], { wide: true });
  }

  function pullDialog() {
    const picker = targetPicker();
    const image = h('input', { type: 'text', placeholder: 'redis:7' });
    modal(server ? '拉取镜像' : '批量拉取镜像', h('div', null, block('目标服务器', picker.el), field('镜像', image)),
      [{ label: '拉取', onClick: async () => showJob(await api('POST', '/api/images/pull', { serverIds: picker.value(), image: image.value.trim() })) }]);
  }

  (async () => {
    try {
      if (!server) await loadServers();
    } catch (e) {
      return fill(listEl, h('div', { class: 'empty' }, e.message));
    }
    if (!main.isConnected) return;
    fill(serverSel, h('option', { value: 'all' }, '全部服务器'),
      state.servers.map((s) => h('option', { value: s.id, selected: s.id === preset }, s.name)));
    drawTabs();
    reload();
  })();
}

// ---------- 任务 ----------
function viewJobs(main) {
  const el = h('div');
  main.append(el);
  async function load() {
    const jobs = await api('GET', '/api/jobs');
    if (!jobs.length) return fill(el, h('div', { class: 'card' }, h('div', { class: 'empty' }, '暂无任务。批量升级、批量部署等操作会显示在这里（程序重启后清空）。')));
    fill(el, jobs.map((j) => {
      const ok = j.items.filter((i) => i.status === 'success').length;
      const failed = j.items.filter((i) => i.status === 'failed').length;
      return h('div', { class: 'card', style: { marginBottom: '14px' } },
        h('div', { class: 'toolbar', style: { padding: '12px 14px 0', margin: '0' } },
          h('strong', null, j.title),
          h('span', { class: `badge ${JOB_BADGE[j.status][1]}` }, JOB_BADGE[j.status][0]),
          h('span', { class: 'muted' }, `成功 ${ok} · 失败 ${failed} · 共 ${j.items.length}`),
          h('span', { class: 'spacer' }),
          h('span', { class: 'muted' }, `${j.user} · ${fmtTime(j.createdAt)}`)),
        jobTable(j));
    }));
    return jobs.some((j) => j.status === 'running');
  }
  const tick = () => load().catch((e) => console.warn(e));
  tick();
  state.timer = setInterval(tick, 3000);
}

// ---------- 操作日志 ----------
async function viewAudit(main) {
  const card = h('div', { class: 'card' }, h('div', { class: 'empty' }, '加载中…'));
  main.append(card);
  try {
    const list = await api('GET', '/api/audit');
    fill(card, h('table', null,
      h('thead', null, h('tr', null, ['时间', '用户', '来源 IP', '操作', '详情'].map((t) => h('th', null, t)))),
      h('tbody', null, list.length
        ? list.map((a) => h('tr', null, h('td', { class: 'num' }, fmtTime(a.time)), h('td', null, a.user), h('td', { class: 'mono' }, a.ip), h('td', null, a.action), h('td', null, a.detail)))
        : h('tr', null, h('td', { colSpan: 5, class: 'empty' }, '暂无记录')))));
  } catch (e) {
    fill(card, h('div', { class: 'empty' }, e.message));
  }
}

// ---------- 启动 ----------
async function boot() {
  try {
    state.me = await api('GET', '/api/me');
  } catch {
    return; // api() 已切到登录页
  }
  renderShell();
}
window.addEventListener('hashchange', () => state.me && renderShell());
boot();
