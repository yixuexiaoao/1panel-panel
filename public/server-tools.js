// 单台服务器的文件和定时任务管理，远端内容一律按纯文本显示。
const joinPath = (directory, name) => `${directory === '/' ? '' : directory}/${name}`;
const parentPath = (value) => value.slice(0, value.lastIndexOf('/')) || '/';
const entryName = (value) => {
  const name = value;
  if (!name.trim() || name === '.' || name === '..' || /[\/\0]/.test(name)) throw new Error('名称不能为空，且不能包含 / 或空字符');
  return name;
};

export function renderServerFiles(main, ctx) {
  const { server, h, fill, api, toast, busy, modal, confirmDialog, field, fmtBytes, fmtTime, canWrite } = ctx;
  const prefix = `/api/servers/${encodeURIComponent(server.id)}/files`;
  const [route, queryString] = location.hash.split('?');
  const initialQuery = new URLSearchParams(queryString);
  let directory = initialQuery.get('path') || '/';
  let favorites = [];
  let activeUpload;
  let uploading = false;
  let stopUpload = false;
  let uploadMaxBytes = 100 * 1024 * 1024;
  let page = 1;
  let request = 0;
  let disposed = false;
  let directoryReady = false;
  const pathInput = h('input', { class: 'file-address', type: 'text', value: directory, 'aria-label': '目录路径', placeholder: '/绝对路径' });
  const searchInput = h('input', { type: 'search', value: initialQuery.get('q') || '', placeholder: '搜索当前目录', 'aria-label': '搜索当前目录' });
  const showHidden = h('input', { type: 'checkbox', checked: initialQuery.get('showHidden') !== 'false', onchange: busy(async () => { page = 1; await reload(); }) });
  const favoriteList = h('div', { class: 'file-favorite-list' });
  const favoritesStatus = h('div', { class: 'muted', role: 'status' });
  const favoriteButton = h('button', { class: 'btn', type: 'button', disabled: true, onclick: () => addFavorite() }, '收藏此目录');
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => { if (fileInput.files.length) void uploadFiles([...fileInput.files]); } });
  const uploadButton = h('button', { class: 'btn primary', type: 'button', disabled: true, onclick: () => fileInput.click() }, '上传文件');
  const transfers = h('section', { class: 'file-transfers', hidden: true, 'aria-label': '上传记录' });
  const transferList = h('div', { class: 'file-transfer-list' });
  const transferDestination = h('span', { class: 'muted file-path-label' });
  const stopButton = h('button', { class: 'btn small', type: 'button', onclick: () => { stopUpload = true; activeUpload?.abort(); } }, '停止上传');
  const breadcrumbs = h('nav', { class: 'server-breadcrumb', 'aria-label': '文件路径' });
  const list = h('div', { class: 'card' });
  const pages = h('div', { class: 'toolbar server-file-pagination' });
  const status = h('div', { class: 'muted', role: 'status' });
  const operationNotice = h('div', { class: 'file-operation-notice', role: 'status' });
  const createFileButton = h('button', { class: 'btn', type: 'button', disabled: true, onclick: () => createEntry(false) }, '新建文件');
  const createDirectoryButton = h('button', { class: 'btn', type: 'button', disabled: true, onclick: () => createEntry(true) }, '新建目录');

  function drawFavorites() {
    fill(favoriteList, favorites.length ? favorites.map((item) => h('div', { class: 'file-favorite' },
      h('button', { class: `btn link${item.path === directory ? ' active' : ''}`, title: item.path, onclick: busy(() => navigate(item.path)) }, item.name || item.path),
      canWrite() && h('button', { class: 'btn link', title: `移除收藏 ${item.name || item.path}`, 'aria-label': `移除收藏 ${item.name || item.path}`, onclick: busy(async () => {
        await api('DELETE', `${prefix}/favorites/${encodeURIComponent(item.id)}`);
        await loadFavorites();
      }) }, '×'))) : h('p', { class: 'muted' }, '尚未收藏目录'));
    favoriteButton.disabled = !directoryReady || favorites.some((item) => item.path === directory);
    favoriteButton.textContent = favorites.some((item) => item.path === directory) ? '已收藏' : '收藏此目录';
  }

  async function loadFavorites() {
    try {
      const items = await api('GET', `${prefix}/favorites`);
      if (disposed) return;
      favorites = items;
      favoritesStatus.textContent = '';
      drawFavorites();
    } catch (error) {
      if (!disposed) favoritesStatus.textContent = `收藏读取失败：${error.message}`;
    }
  }

  function addFavorite() {
    if (!directoryReady || disposed) return;
    const selectedPath = directory;
    modal('收藏目录', h('div', null, h('p', { class: 'mono file-path-label' }, selectedPath)),
      [{ label: '收藏', onClick: async () => {
        await api('POST', `${prefix}/favorites`, { path: selectedPath });
        await loadFavorites();
        toast('目录已收藏');
      } }]);
  }

  function uploadOne(file, destination, update) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      activeUpload = xhr;
      const query = new URLSearchParams({ path: destination, name: file.name });
      xhr.open('POST', `${prefix}/upload?${query}`);
      xhr.setRequestHeader('X-Requested-With', 'opf');
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.timeout = 30 * 60 * 1000;
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) update(event.loaded, event.total);
      };
      xhr.onload = () => {
        let result;
        try { result = JSON.parse(xhr.responseText); } catch { /* 保留 HTTP 错误信息 */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(result?.error || `上传失败（HTTP ${xhr.status}）`));
      };
      xhr.onerror = () => reject(new Error('上传连接中断，请刷新目录核对文件'));
      xhr.ontimeout = () => reject(new Error('上传等待超时，请刷新目录核对文件'));
      xhr.onabort = () => reject(new Error('已停止，请刷新目录核对是否已收到文件'));
      xhr.send(file);
    });
  }

  async function uploadFiles(files) {
    if (!directoryReady || disposed || uploading) return;
    const destination = directory;
    transferDestination.textContent = destination;
    fill(transferList);
    uploading = true;
    stopUpload = false;
    uploadButton.disabled = true;
    stopButton.disabled = false;
    transfers.hidden = false;
    let completed = 0;
    for (const file of files) {
      const progress = h('progress', { max: file.size || 1, value: 0, 'aria-label': `${file.name} 上传进度` });
      const message = h('span', { class: 'muted' }, '等待上传');
      const row = h('div', { class: 'file-transfer' }, h('span', { class: 'file-transfer-name', title: file.name }, file.name),
        h('span', { class: 'muted' }, fmtBytes(file.size)), progress, message);
      transferList.append(row);
      if (disposed || stopUpload) { message.textContent = '已停止'; continue; }
      try {
        entryName(file.name);
        if (file.size > uploadMaxBytes) throw new Error(`文件超过单文件 ${fmtBytes(uploadMaxBytes)} 上限`);
        message.textContent = '上传中…';
        await uploadOne(file, destination, (loaded, total) => {
          progress.max = total || 1;
          progress.value = loaded;
          message.textContent = loaded === total ? '服务器处理中…' : `${Math.floor(loaded / total * 100)}%`;
        });
        progress.value = progress.max;
        message.textContent = '上传成功';
        message.className = 'file-transfer-success';
        completed++;
      } catch (error) {
        message.textContent = error.message;
        message.className = 'error';
      } finally {
        activeUpload = null;
      }
    }
    uploading = false;
    stopButton.disabled = true;
    fileInput.value = '';
    if (!disposed) {
      uploadButton.disabled = !directoryReady;
      await reload();
      toast(`上传完成：${completed} / ${files.length} 个文件成功`);
    }
  }

  function drawBreadcrumbs() {
    let current = '';
    fill(breadcrumbs, h('button', { class: 'btn link', onclick: busy(() => navigate('/')) }, '/'),
      directory.split('/').filter(Boolean).map((part) => {
        current += `/${part}`;
        const destination = current;
        return h('button', { class: 'btn link', onclick: busy(() => navigate(destination)) }, part);
      }));
  }

  async function navigate(value) {
    if (!value.startsWith('/') || value.includes('\0')) throw new Error('请输入以 / 开头的绝对目录路径');
    if (value !== directory) searchInput.value = '';
    directory = value.replace(/\/+$/, '') || '/';
    page = 1;
    pathInput.value = directory;
    await reload();
  }

  async function editFile(item) {
    const result = await api('GET', `${prefix}/content?path=${encodeURIComponent(item.path)}`);
    if (disposed) return;
    const content = String(result.content ?? '');
    if (content.includes('\0')) throw new Error('此文件含二进制内容，请在原面板中查看');
    const damagedText = content.includes('\uFFFD') || /[\uD800-\uDFFF]/u.test(content);
    const editable = canWrite() && !item.isSymlink && !damagedText;
    const crlf = content.includes('\r\n') && !/(^|[^\r])\n/u.test(content);
    const editor = h('textarea', { class: 'server-text-preview mono', value: content, rows: 20,
      spellcheck: false, readOnly: !editable, 'aria-label': '文件内容' });
    const initialText = editor.value;
    modal(item.path, h('div', null,
      h('div', { class: 'muted' }, `${fmtBytes(result.size)} · 文本内容`),
      item.isSymlink && h('p', { class: 'muted' }, '符号链接仅供查看，请打开目标文件后编辑'),
      damagedText && h('p', { class: 'error' }, '内容含无效或无法确认的 UTF-8 字符，已设为只读'), editor),
    editable ? [{ label: '保存文件', onClick: async () => {
      if (editor.value === initialText) return;
      const updated = crlf ? editor.value.replace(/\r?\n/g, '\r\n') : editor.value;
      const body = { path: item.path, content: updated };
      if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 1024 * 1024) {
        throw new Error('文本内容超过保存上限（含路径的请求体最多 1 MiB），请在原面板保存此文件');
      }
      await api('POST', `${prefix}/save`, body);
      toast('文件已保存');
      await reload();
    } }] : [], { wide: true });
  }

  function createEntry(isDir) {
    if (!directoryReady || disposed) return;
    const folder = directory;
    const name = h('input', { type: 'text', required: true, autocomplete: 'off' });
    modal(isDir ? '新建目录' : '新建文件', h('div', null,
      h('p', { class: 'muted server-file-path' }, folder), field('名称', name)),
    [{ label: '创建', onClick: async () => {
      await api('POST', `${prefix}/create`, { path: joinPath(folder, entryName(name.value)), isDir });
      toast(isDir ? '目录已创建' : '文件已创建');
      await reload();
    } }]);
  }

  function renameEntry(item) {
    const name = h('input', { type: 'text', value: item.name, required: true, autocomplete: 'off' });
    modal('重命名', field('新名称', name), [{ label: '重命名', onClick: async () => {
      const newName = joinPath(parentPath(item.path), entryName(name.value));
      if (newName === item.path) return;
      await api('POST', `${prefix}/rename`, { oldName: item.path, newName });
      toast('名称已更新');
      await reload();
    } }]);
  }

  function reportJob(job) {
    if (job.status === 'failed') {
      const message = job.items?.find((item) => item.status === 'failed')?.message;
      throw new Error(message || '操作失败，请在任务页查看详情');
    }
    fill(operationNotice, h('span', null, job.status === 'running' ? '操作已提交，进度和结果请在任务页查看。' : '操作已处理，可在任务页查看结果。'),
      ' ', h('a', { href: '#/jobs' }, '查看任务'));
  }

  function transferEntry(item, operation) {
    const destination = h('input', { type: 'text', value: parentPath(item.path), placeholder: '/目标目录', required: true });
    const label = operation === 'copy' ? '复制' : '移动';
    modal(`${label}文件${item.isDir ? '夹' : ''}`, h('div', null,
      h('p', { class: 'mono file-path-label' }, item.path), field('目标目录', destination)),
      [{ label, onClick: async () => {
        if (!destination.value.startsWith('/')) throw new Error('目标目录必须为绝对路径');
        reportJob(await api('POST', `${prefix}/transfer`, { path: item.path, destination: destination.value, operation }));
        await reload();
      } }]);
  }

  function changeMode(item) {
    const mode = h('input', { type: 'text', value: /^[0-7]{3,4}$/.test(item.mode) ? item.mode : '', placeholder: item.isDir ? '0755' : '0644', required: true });
    modal('修改权限', h('div', null, h('p', { class: 'mono file-path-label' }, item.path),
      field('八进制权限', mode, '仅修改此条目，填写 3 或 4 位八进制数，如 0644 或 0755')),
      [{ label: '保存权限', onClick: async () => {
        if (!/^[0-7]{3,4}$/.test(mode.value)) throw new Error('权限应为 3 或 4 位八进制数');
        await api('POST', `${prefix}/mode`, { path: item.path, mode: mode.value });
        toast('权限已更新');
        await reload();
      } }]);
  }

  function changeOwner(item) {
    const user = h('input', { type: 'text', value: item.user || '', required: true });
    const group = h('input', { type: 'text', value: item.group || '', required: true });
    modal('修改所有者', h('div', null, h('p', { class: 'mono file-path-label' }, item.path),
      field('用户', user), field('用户组', group), h('p', { class: 'muted' }, '仅修改此条目')),
      [{ label: '保存所有者', onClick: async () => {
        if (!user.value.trim() || !group.value.trim()) throw new Error('请填写用户和用户组');
        await api('POST', `${prefix}/owner`, { path: item.path, user: user.value.trim(), group: group.value.trim() });
        toast('所有者已更新');
        await reload();
      } }]);
  }

  function compressEntry(item) {
    const destination = h('input', { type: 'text', value: parentPath(item.path), required: true });
    const name = h('input', { type: 'text', value: `${item.name}.zip`, required: true });
    const format = h('select', { 'aria-label': '压缩格式', onchange: () => {
      name.value = name.value.replace(/\.(zip|tar\.gz)$/i, '') + (format.value === 'zip' ? '.zip' : '.tar.gz');
    } }, h('option', { value: 'zip' }, 'ZIP'), h('option', { value: 'tar.gz' }, 'TAR.GZ'));
    modal('压缩', h('div', null, h('p', { class: 'mono file-path-label' }, item.path),
      field('保存目录', destination), field('压缩文件名', name), field('压缩格式', format)),
      [{ label: '开始压缩', onClick: async () => {
        entryName(name.value);
        if (!destination.value.startsWith('/')) throw new Error('保存目录必须为绝对路径');
        reportJob(await api('POST', `${prefix}/compress`, { path: item.path, destination: destination.value, name: name.value, format: format.value }));
        await reload();
      } }]);
  }

  function decompressEntry(item) {
    const formats = ['zip', 'tar.gz', 'tar', '7z', 'rar', 'tar.bz2'];
    const detected = [...formats].sort((left, right) => right.length - left.length).find((value) => item.name.toLowerCase().endsWith(`.${value}`)) || 'zip';
    const stem = item.name.toLowerCase().endsWith(`.${detected}`) ? item.name.slice(0, -(detected.length + 1)) : item.name;
    const destination = h('input', { type: 'text', value: joinPath(parentPath(item.path), `${stem || 'archive'}-解压`), required: true });
    const format = h('select', { 'aria-label': '解压格式' }, formats.map((value) => h('option', { value, selected: value === detected }, value.toUpperCase())));
    modal('解压', h('div', null, h('p', { class: 'mono file-path-label' }, item.path),
      field('目标目录', destination, '选择一个新建或空目录'), field('压缩格式', format)),
      [{ label: '开始解压', onClick: async () => {
        if (!destination.value.startsWith('/')) throw new Error('目标目录必须为绝对路径');
        reportJob(await api('POST', `${prefix}/decompress`, { path: item.path, destination: destination.value, format: format.value }));
        await reload();
      } }]);
  }

  function moreActions(item) {
    const actions = [
      ['重命名', () => renameEntry(item)],
      ['复制到…', () => transferEntry(item, 'copy')],
      ['移动到…', () => transferEntry(item, 'move')],
      ['修改权限', () => changeMode(item)],
      ['修改所有者', () => changeOwner(item)],
      ['压缩…', () => compressEntry(item)],
      ...(!item.isDir && /\.(zip|tar\.gz|tar|7z|rar|tar\.bz2)$/i.test(item.name) ? [['解压到…', () => decompressEntry(item)]] : []),
      ...(item.path.split('/').filter(Boolean).length > 1 ? [['删除', () => deleteEntry(item), true]] : []),
    ];
    let close;
    close = modal(item.name, h('div', { class: 'file-more-actions' }, actions.map(([label, action, danger]) =>
      h('button', { class: `btn${danger ? ' danger' : ''}`, onclick: busy(async () => { close(); await action(); }) }, label))));
  }

  async function deleteEntry(item) {
    if (!await confirmDialog(item.isDir ? '删除目录' : '删除文件',
      `${item.path}${item.isDir ? ' 及其中内容' : ''}将被删除。`, { danger: true, label: '删除' })) return;
    await api('POST', `${prefix}/delete`, { path: item.path, isDir: item.isDir });
    toast('已删除');
    await reload();
  }

  async function reload() {
    const token = ++request;
    directoryReady = false;
    createFileButton.disabled = true;
    createDirectoryButton.disabled = true;
    uploadButton.disabled = true;
    favoriteButton.disabled = true;
    fill(list, h('div', { class: 'empty' }, '正在读取目录…'));
    fill(pages);
    status.textContent = '正在读取目录…';
    try {
      const params = new URLSearchParams({ path: directory, page, q: searchInput.value.trim(), showHidden: showHidden.checked });
      const data = await api('GET', `${prefix}?${params}`);
      if (disposed || token !== request) return;
      directory = data.path || directory;
      uploadMaxBytes = data.uploadMaxBytes || uploadMaxBytes;
      page = data.page || page;
      pathInput.value = directory;
      if (location.hash.split('?')[0] === route) {
        const query = new URLSearchParams({ path: directory });
        if (searchInput.value.trim()) query.set('q', searchInput.value.trim());
        if (!showHidden.checked) query.set('showHidden', 'false');
        history.replaceState(null, '', directory === '/' && query.size === 1 ? route : `${route}?${query}`);
      }
      directoryReady = true;
      createFileButton.disabled = !canWrite();
      createDirectoryButton.disabled = !canWrite();
      uploadButton.disabled = !canWrite() || uploading;
      drawFavorites();
      drawBreadcrumbs();
      status.textContent = `共 ${data.total || 0} 项`;
      fill(list, data.items?.length ? h('table', null,
        h('thead', null, h('tr', null, ['名称', '类型', '大小', '权限', '修改时间', '操作'].map((title) => h('th', null, title)))),
        h('tbody', null, data.items.map((item) => h('tr', null,
          h('td', null, h('button', { class: 'btn link server-file-path', onclick: busy(() => item.isDir ? navigate(item.path) : editFile(item)) }, item.name)),
          h('td', null, item.isSymlink ? '符号链接' : item.isDir ? '目录' : '文件'),
          h('td', null, item.isDir ? '-' : fmtBytes(item.size)),
          h('td', { class: 'mono' }, item.mode || '-'),
          h('td', null, fmtTime(item.modTime)),
          h('td', null, h('div', { class: 'actions' },
            !item.isDir && h('button', { class: 'btn small', onclick: busy(() => editFile(item)) }, canWrite() && !item.isSymlink ? '编辑' : '查看'),
            !item.isDir && h('a', { class: 'btn small', href: `${prefix}/download?${new URLSearchParams({ path: item.path })}`, download: item.name }, '下载'),
            canWrite() && !item.isSymlink && h('button', { class: 'btn small', onclick: () => moreActions(item) }, '更多')))))))
        : h('div', { class: 'empty' }, '此目录为空'));
      const pageSize = data.pageSize || 100;
      fill(pages, h('button', { class: 'btn small', disabled: page <= 1, onclick: busy(async () => { page--; await reload(); }) }, '上一页'),
        h('span', { class: 'muted' }, `第 ${page} 页`),
        h('button', { class: 'btn small', disabled: page * pageSize >= data.total, onclick: busy(async () => { page++; await reload(); }) }, '下一页'));
    } catch (error) {
      if (disposed || token !== request) return;
      status.textContent = '目录读取失败';
      fill(list, h('div', { class: 'empty error', role: 'alert' }, error.message));
      fill(pages);
    }
  }

  fill(transfers, h('div', { class: 'toolbar' }, h('strong', null, '上传记录'), transferDestination,
    h('span', { class: 'spacer' }), stopButton), transferList);
  const body = h('div', { class: 'file-browser-main' },
    h('form', { class: 'toolbar file-address-bar', onsubmit: busy(async (event) => {
      event.preventDefault();
      await navigate(pathInput.value);
    }) }, h('button', { class: 'btn', type: 'button', onclick: busy(() => navigate(parentPath(directory))) }, '上一级'),
      pathInput, h('button', { class: 'btn', type: 'submit' }, '打开'),
      h('button', { class: 'btn', type: 'button', onclick: busy(reload) }, '刷新')),
    h('div', { class: 'toolbar' }, breadcrumbs, h('span', { class: 'spacer' }), canWrite() && favoriteButton),
    h('div', { class: 'toolbar' }, canWrite() && uploadButton, canWrite() && fileInput,
      canWrite() && createFileButton, canWrite() && createDirectoryButton,
      h('span', { class: 'spacer' }),
      h('form', { class: 'toolbar file-search', onsubmit: busy(async (event) => { event.preventDefault(); page = 1; await reload(); }) },
        searchInput, h('button', { class: 'btn', type: 'submit' }, '搜索')),
      h('label', { class: 'file-hidden-toggle' }, showHidden, '显示隐藏文件')),
    status, operationNotice, list, pages, transfers);
  fill(main, h('div', { class: 'file-browser' },
    h('details', { class: 'card file-favorites', open: true }, h('summary', null, '目录收藏'), favoriteList, favoritesStatus), body));
  void reload();
  void loadFavorites();
  return () => { disposed = true; request++; stopUpload = true; activeUpload?.abort(); };

}

export function renderServerCronjobs(main, ctx) {
  const { server, h, fill, api, toast, busy, modal, confirmDialog, canWrite, fmtTime } = ctx;
  const prefix = `/api/servers/${encodeURIComponent(server.id)}`;
  const list = h('div', { class: 'card' });
  const status = h('div', { class: 'muted', role: 'status' });
  let disposed = false;
  let request = 0;
  const statusLabels = { Enable: '已启用', Disable: '已停用', Waiting: '等待中', Running: '运行中', Success: '成功', Failed: '失败', Canceled: '已取消' };
  const statusName = (value) => statusLabels[value] || value || '-';

  async function records(job) {
    const body = h('div', { class: 'muted' }, '正在读取执行记录…');
    modal(`${job.name} · 执行记录`, body, [], { wide: true });
    try {
      const items = await api('GET', `${prefix}/cronjobs/${job.id}/records`);
      if (disposed || !body.isConnected) return;
      fill(body, items.length ? h('table', null,
        h('thead', null, h('tr', null, ['开始时间', '状态', '信息', '日志'].map((title) => h('th', null, title)))),
        h('tbody', null, items.map((record) => h('tr', null,
          h('td', null, fmtTime(record.startTime)), h('td', null, statusName(record.status)),
          h('td', null, record.message || '-'),
          h('td', null, h('button', { class: 'btn small', onclick: busy(async () => {
            const log = await api('GET', `${prefix}/records/${record.id}/log`);
            if (disposed || !body.isConnected) return;
            modal('执行日志', h('pre', { class: 'server-text-preview mono' }, log || '暂无日志'), [], { wide: true });
          }) }, '查看日志')))))) : h('div', { class: 'empty' }, '最近 30 天暂无执行记录'));
    } catch (error) {
      if (!disposed && body.isConnected) fill(body, h('div', { class: 'error', role: 'alert' }, error.message));
    }
  }

  async function run(job) {
    if (!await confirmDialog('执行定时任务', `立即在 ${server.name} 执行“${job.name}”？`, { label: '执行' })) return;
    await api('POST', `${prefix}/cronjobs/${job.id}/run`);
    toast('已提交执行，可在执行记录中查看结果');
    await reload();
  }

  async function remove(job) {
    if (!await confirmDialog('删除定时任务', `删除“${job.name}”及面板关联的执行记录？备份数据将保留。`,
      { danger: true, label: '删除任务' })) return;
    await api('POST', `${prefix}/cronjobs/${job.id}/delete`, { cleanData: false });
    toast('定时任务已删除');
    await reload();
  }

  async function reload() {
    const token = ++request;
    status.textContent = '正在读取定时任务…';
    try {
      const items = await api('GET', `${prefix}/cronjobs`);
      if (disposed || token !== request) return;
      status.textContent = `共 ${items.length} 项任务`;
      fill(list, items.length ? h('table', null,
        h('thead', null, h('tr', null, ['任务', '类型', '调度', '状态', '最近执行', '操作'].map((title) => h('th', null, title)))),
        h('tbody', null, items.map((job) => h('tr', null,
          h('td', null, job.name, job.temp && h('span', { class: 'badge' }, 'Fleet 临时任务')),
          h('td', null, job.type || '-'), h('td', { class: 'mono' }, job.spec || '-'),
          h('td', null, statusName(job.status)),
          h('td', null, statusName(job.lastRecordStatus), h('div', { class: 'muted small' }, job.lastRecordTime || '-')),
          h('td', null, h('div', { class: 'actions' },
            h('button', { class: 'btn small', onclick: busy(() => records(job)) }, '执行记录'),
            job.script && h('button', { class: 'btn small', onclick: () => modal('任务脚本',
              h('pre', { class: 'server-text-preview mono' }, job.script), [], { wide: true }) }, '查看脚本'),
            canWrite() && !job.temp && [
              h('button', { class: 'btn small', onclick: busy(() => run(job)) }, '执行'),
              h('button', { class: 'btn small', onclick: busy(async () => {
                const enable = job.status !== 'Enable';
                await api('POST', `${prefix}/cronjobs/${job.id}/status`, { enable });
                toast(enable ? '任务已启用' : '任务已停用');
                await reload();
              }) }, job.status === 'Enable' ? '停用' : '启用'),
              h('button', { class: 'btn small danger', onclick: busy(() => remove(job)) }, '删除'),
            ])))))) : h('div', { class: 'empty' }, '此服务器暂无定时任务'));
    } catch (error) {
      if (disposed || token !== request) return;
      status.textContent = '定时任务读取失败';
      fill(list, h('div', { class: 'empty error', role: 'alert' }, error.message));
    }
  }

  fill(main, h('div', { class: 'toolbar' },
    h('button', { class: 'btn', onclick: busy(reload) }, '刷新任务'), status), list);
  void reload();
  return () => { disposed = true; request++; };
}
