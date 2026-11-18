// 操作模板：内置常用运维脚本 + 用户自定义脚本。脚本中的 {{key}} 会替换为参数值（按 shell 单引号转义）。
import { HttpError } from './util.js';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_SCRIPT = 64 * 1024;
export const TIMEOUT_MIN = 10;
export const TIMEOUT_MAX = 7200;

/** 识别包管理器的公共片段 */
const PKG = `if command -v apt-get >/dev/null 2>&1; then PM=apt
elif command -v dnf >/dev/null 2>&1; then PM=dnf
elif command -v yum >/dev/null 2>&1; then PM=yum
elif command -v apk >/dev/null 2>&1; then PM=apk
else echo "未识别的包管理器（支持 apt / dnf / yum / apk）"; exit 1; fi
echo "包管理器：$PM"`;

const YES_NO = [
  { value: 'no', label: '否' },
  { value: 'yes', label: '是' },
];

export const BUILTIN_TEMPLATES = [
  {
    id: 'builtin:check-updates',
    name: '查看可更新的软件包',
    category: '系统补丁',
    description: '刷新软件源并列出可升级的软件包，不做任何修改。',
    timeoutSec: 600,
    params: [],
    script: `${PKG}
case "$PM" in
  apt) apt-get update -qq >/dev/null 2>&1; apt list --upgradable 2>/dev/null | tail -n +2 ;;
  dnf) dnf -q check-update || [ $? -eq 100 ] ;;
  yum) yum -q check-update || [ $? -eq 100 ] ;;
  apk) apk update -q && apk list -u ;;
esac`,
  },
  {
    id: 'builtin:upgrade-system',
    name: '升级系统补丁',
    category: '系统补丁',
    description: '非交互方式升级系统软件包，保留现有配置文件；结束后提示是否需要重启。不会自动重启。',
    dangerous: true,
    timeoutSec: 3600,
    params: [{ key: 'securityOnly', label: '仅安全更新（apt 需已安装 unattended-upgrades；dnf / yum 使用 --security）', default: 'no', options: YES_NO }],
    script: `${PKG}
export DEBIAN_FRONTEND=noninteractive
SEC={{securityOnly}}
case "$PM" in
  apt)
    apt-get update -q
    if [ "$SEC" = yes ] && command -v unattended-upgrade >/dev/null 2>&1; then
      unattended-upgrade -v
    else
      [ "$SEC" = yes ] && echo "未安装 unattended-upgrades，改为完整升级"
      apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade
    fi
    apt-get -y -q autoremove ;;
  dnf) if [ "$SEC" = yes ]; then dnf -y upgrade --security; else dnf -y upgrade; fi ;;
  yum) if [ "$SEC" = yes ]; then yum -y update --security; else yum -y update; fi ;;
  apk) apk update && apk upgrade ;;
esac
echo "----"
if [ -f /var/run/reboot-required ]; then echo "提示：需要重启以完成更新"
elif command -v needs-restarting >/dev/null 2>&1 && ! needs-restarting -r >/dev/null 2>&1; then echo "提示：需要重启以完成更新"
else echo "无需重启"; fi`,
  },
  {
    id: 'builtin:reboot',
    name: '重启服务器',
    category: '系统补丁',
    description: '10 秒后重启服务器。重启期间面板与网站不可用。',
    dangerous: true,
    timeoutSec: 60,
    params: [],
    script: `nohup sh -c 'sleep 10; reboot' >/dev/null 2>&1 &
echo "已安排在 10 秒后重启"`,
  },
  {
    id: 'builtin:sys-info',
    name: '系统概况',
    category: '巡检',
    description: '运行时长、负载、内存、占用 CPU 最高的进程。',
    timeoutSec: 60,
    params: [],
    script: `uptime
echo; free -h
echo; ps aux --sort=-%cpu 2>/dev/null | head -n 11 || ps aux | head -n 11`,
  },
  {
    id: 'builtin:disk-usage',
    name: '磁盘占用',
    category: '巡检',
    description: '各分区使用率，以及指定目录下占用最大的子目录。',
    timeoutSec: 300,
    params: [{ key: 'dir', label: '统计目录', default: '/' }],
    script: `df -hT -x tmpfs -x devtmpfs -x overlay 2>/dev/null || df -h
echo; echo "目录占用（前 15）："
du -xh --max-depth=1 {{dir}} 2>/dev/null | sort -rh | head -n 15`,
  },
  {
    id: 'builtin:ports',
    name: '监听端口',
    category: '巡检',
    description: '列出正在监听的 TCP / UDP 端口及进程。',
    timeoutSec: 60,
    params: [],
    script: 'ss -tulnp 2>/dev/null || netstat -tulnp',
  },
  {
    id: 'builtin:logins',
    name: '最近登录记录',
    category: '巡检',
    description: '最近成功登录与失败登录各 20 条。',
    timeoutSec: 60,
    params: [],
    script: `echo "成功登录："; last -n 20 -a 2>/dev/null || echo "（无 last 命令）"
echo; echo "失败登录："; lastb -n 20 -a 2>/dev/null || echo "（无记录或无 lastb 命令）"`,
  },
  {
    id: 'builtin:time-status',
    name: '时间同步状态',
    category: '巡检',
    description: '查看系统时间与 NTP 同步状态（面板 API 鉴权依赖两端时间一致）。',
    timeoutSec: 60,
    params: [],
    script: `date
timedatectl status 2>/dev/null
command -v chronyc >/dev/null 2>&1 && chronyc tracking`,
  },
  {
    id: 'builtin:docker-prune',
    name: '清理 Docker 无用数据',
    category: '清理',
    description: '删除已停止的容器、未使用的网络、悬空镜像和构建缓存；可选同时删除所有未被使用的镜像。',
    dangerous: true,
    timeoutSec: 1800,
    params: [{ key: 'allImages', label: '同时删除所有未被容器使用的镜像', default: 'no', options: YES_NO }],
    script: `docker system df
echo "----"
if [ {{allImages}} = yes ]; then docker system prune -af; else docker system prune -f; fi
echo "----"
docker system df`,
  },
  {
    id: 'builtin:journal-vacuum',
    name: '清理系统日志',
    category: '清理',
    description: '只保留最近 N 天的 systemd journal 日志。',
    dangerous: true,
    timeoutSec: 600,
    params: [{ key: 'days', label: '保留天数', default: '7' }],
    script: `journalctl --disk-usage
journalctl --vacuum-time={{days}}d
journalctl --disk-usage`,
  },
  {
    id: 'builtin:service',
    name: '管理 systemd 服务',
    category: '服务',
    description: '对指定服务执行 status / restart / start / stop。',
    dangerous: true,
    timeoutSec: 120,
    params: [
      { key: 'service', label: '服务名', default: 'nginx' },
      {
        key: 'action', label: '操作', default: 'status',
        options: ['status', 'restart', 'start', 'stop', 'reload'].map((v) => ({ value: v, label: v })),
      },
    ],
    script: `A={{action}}
if [ "$A" != status ]; then systemctl "$A" {{service}} || exit 1; fi
systemctl --no-pager status {{service}} | head -n 20`,
  },
];

export const shellQuote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

/** 用参数值替换脚本中的 {{key}}；未提供的参数取默认值，选项型参数必须是预设值之一 */
export function renderScript(tpl, values = {}) {
  const params = tpl.params || [];
  const vals = new Map();
  for (const p of params) {
    const raw = (Object.hasOwn(values, p.key) ? values[p.key] : undefined) ?? p.default ?? '';
    const v = typeof raw === 'string' ? raw : String(raw);
    if (v.length > 1000) throw new HttpError(400, `参数“${p.label || p.key}”过长`);
    if (p.options && !p.options.some((o) => o.value === v)) throw new HttpError(400, `参数“${p.label || p.key}”的值无效`);
    vals.set(p.key, v);
  }
  return tpl.script.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (m, k) => (vals.has(k) ? shellQuote(vals.get(k)) : m));
}

export const clampTimeout = (v, def = 600) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, n)) : def;
};

/** 校验并规范化用户提交的自定义模板 */
export function parseTemplate(b) {
  const s = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const name = s(b.name, 60);
  if (!name) throw new HttpError(400, '名称不能为空');
  const script = typeof b.script === 'string' ? b.script.replace(/\r\n/g, '\n') : '';
  if (!script.trim()) throw new HttpError(400, '脚本不能为空');
  if (Buffer.byteLength(script) > MAX_SCRIPT) throw new HttpError(400, '脚本过长（上限 64KB）');
  const params = (Array.isArray(b.params) ? b.params : []).slice(0, 20).map((p) => {
    const key = s(p?.key, 40);
    if (!KEY_RE.test(key)) throw new HttpError(400, `参数名“${key}”无效：只能包含字母、数字、下划线，且不能以数字开头`);
    const options = Array.isArray(p.options)
      ? p.options.map((o) => ({ value: s(o?.value, 1000), label: s(o?.label, 1000) }))
      : s(p.options, 1000).split(/[,，]/).map((o) => ({ value: o.trim(), label: o.trim() }));
    const choices = options.filter((o) => o.value).map((o) => ({ ...o, label: o.label || o.value }));
    const def = s(p.default, 1000);
    if (choices.length && def && !choices.some((o) => o.value === def)) throw new HttpError(400, `参数“${key}”的默认值不在可选值中`);
    return { key, label: s(p.label, 100) || key, default: def || choices[0]?.value || '', ...(choices.length ? { options: choices } : {}) };
  });
  if (new Set(params.map((p) => p.key)).size !== params.length) throw new HttpError(400, '参数名不能重复');
  return {
    name,
    category: s(b.category, 30) || '自定义',
    description: s(b.description, 300),
    script,
    params,
    timeoutSec: clampTimeout(b.timeoutSec),
    dangerous: !!b.dangerous,
  };
}
