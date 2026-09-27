/**
 * Client half of the dsh-sync bundle.
 *
 * Registers one Settings page driving the Host half's four routes. All colors
 * come from the theme tokens the Theme provider lists; spacing and radius use
 * literals because no theme token exposes them.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-sync',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    const NS = 'dsh-sync';

    /** Item keys are stable identifiers from the Host; labels are localized here. */
    const ITEM_TEXT = {
      sessions: ['item.sessions', 'item.sessions.hint'],
      attachments: ['item.attachments', 'item.attachments.hint'],
      profiles: ['item.profiles', 'item.profiles.hint'],
      homeConfig: ['item.homeConfig', 'item.homeConfig.hint'],
      credentials: ['item.credentials', 'item.credentials.hint'],
      workspaceState: ['item.workspaceState', 'item.workspaceState.hint'],
      providerCache: ['item.providerCache', 'item.providerCache.hint'],
      pluginModules: ['item.pluginModules', 'item.pluginModules.hint'],
    };

    const zh = {
      'nav': '同步',
      'title': '跨机同步',
      'lead': '把本机的会话记录与配置同步到云端，并在多台机器之间保持一致。',
      'status.heading': '当前状态',
      'status.rclone': 'rclone',
      'status.missing': '未安装',
      'status.install': '在终端运行 winget install Rclone.Rclone 即可安装。',
      'status.local': '本机状态目录',
      'status.work': '工作目录',
      'status.filters': '排除规则（自动生成）',
      'status.last': '上次运行',
      'status.never': '尚未运行',
      'status.conflicts': '冲突副本',
      'status.loading': '读取中…',
      'target.heading': '同步目标',
      'target.remote': '云盘',
      'target.subpath': '云端目录',
      'target.none': '还没有配置任何 remote，先用下面的「配置云盘」建一个。',
      'scope.heading': '同步内容',
      'scope.lead': '选择要把哪些内容带到其它机器。关掉的项会写进排除规则，云端与本机都不会同步它。',
      'scope.save': '保存',
      'scope.saved': '已保存，排除规则已重新生成',
      'scope.dirty': '有未保存的更改',
      'scope.extra': '额外的排除规则',
      'scope.extra.hint': '每行一条，语法同 rclone 过滤器，例如 - /profiles/sdk/**',
      'scope.compare': '变更比较方式',
      'scope.compare.hint': '默认 size,modtime。若预览每次都显示大量改动，说明云端不支持修改时间，可改为 size。',
      'scope.conflict': '冲突处理',
      'scope.conflict.hint': 'none 会把两边都保留成 .conflictN 副本；其它值自动挑一个赢家。',
      'scope.maxDelete': '删除上限（%）',
      'webdav.heading': '配置云盘',
      'webdav.lead': '用 rclone 直接建一个 WebDAV remote，不用去终端跑交互式配置。',
      'webdav.preset': '服务商',
      'webdav.preset.nutstore': '坚果云',
      'webdav.preset.other': '其它 WebDAV',
      'webdav.name': '名称',
      'webdav.url': 'WebDAV 地址',
      'webdav.user': '账号',
      'webdav.pass': '应用密码',
      'webdav.create': '创建 remote',
      'webdav.nutstoreHint': '坚果云必须在「账户信息 → 安全选项 → 添加应用密码」生成专用密码，登录密码不能用于 WebDAV。',
      'webdav.creating': '正在创建…',
      'webdav.created': 'remote 已创建，可以在上面的云盘列表里选它了',
      'webdav.failed': '创建失败',
      'action.heading': '操作',
      'action.preview': '预览改动',
      'action.sync': '立即同步',
      'action.seed': '首次播种',
      'action.refresh': '刷新',
      'action.retry': '重试',
      'seed.mode': '播种赢家',
      'seed.hint': '在配置最完整的机器上用 path1；其它机器接入时用 path2，让云端配置统一本机。',
      'busy.running': '正在运行，请稍候…',
      'output.heading': '运行输出',
      'conflict.heading': '存在冲突副本',
      'conflict.hint': '两边都改过的文件各自保留了一份。核对内容后手动合并，再删除多余的副本。',
      'error.state': '无法读取同步状态',
      'error.settings': '保存失败',
      'item.sessions': '会话记录',
      'item.sessions.hint': '每个会话一份仅追加日志',
      'item.attachments': '附件',
      'item.attachments.hint': '会话引用的图片与文件',
      'item.profiles': 'Profile 配置',
      'item.profiles.hint': '组合包、补丁层与锁文件',
      'item.homeConfig': '根级配置文件',
      'item.homeConfig.hint': 'DSH 主目录下的 cordis.patch.yml 与 AGENTS.md',
      'item.credentials': '密钥',
      'item.credentials.hint': '明文 API key；默认每台机器各自填写',
      'item.workspaceState': '工作区状态',
      'item.workspaceState.hint': '侧栏分组与派生缓存；会从会话头自动重建',
      'item.providerCache': '厂商缓存',
      'item.providerCache.hint': '带过期时间的上传记录；按需重建',
      'item.pluginModules': '插件依赖',
      'item.pluginModules.hint': 'node_modules：平台相关二进制与绝对路径链接',
      'item.tag.derived': '派生',
      'webdav.vendor': '服务商类型',
      'webdav.vendor.hint': '只有 Nextcloud / ownCloud 系支持修改时间；纯 WebDAV 服务器下建议把比较方式改成 size。',
    };

    const en = {
      'nav': 'Sync',
      'title': 'Cross-machine sync',
      'lead': 'Sync this machine\'s sessions and configuration to the cloud and keep several machines consistent.',
      'status.heading': 'Current state',
      'status.rclone': 'rclone',
      'status.missing': 'Not installed',
      'status.install': 'Install it with winget install Rclone.Rclone in a terminal.',
      'status.local': 'Local state directory',
      'status.work': 'Working directory',
      'status.filters': 'Exclusion rules (generated)',
      'status.last': 'Last run',
      'status.never': 'Never run',
      'status.conflicts': 'Conflict copies',
      'status.loading': 'Loading…',
      'target.heading': 'Sync target',
      'target.remote': 'Cloud remote',
      'target.subpath': 'Cloud directory',
      'target.none': 'No remote configured yet. Create one under Configure cloud storage below.',
      'scope.heading': 'Sync scope',
      'scope.lead': 'Choose what travels to your other machines. A disabled slice is written into the exclusion rules and is never synced, on either side.',
      'scope.save': 'Save',
      'scope.saved': 'Saved; the exclusion rules were regenerated',
      'scope.dirty': 'Unsaved changes',
      'scope.extra': 'Extra exclusion rules',
      'scope.extra.hint': 'One per line, same syntax as rclone filters, for example - /profiles/sdk/**',
      'scope.compare': 'Change comparison',
      'scope.compare.hint': 'Defaults to size,modtime. If every preview lists a large number of changes, the server does not report modification times; use size instead.',
      'scope.conflict': 'Conflict handling',
      'scope.conflict.hint': 'none keeps both sides as .conflictN copies; any other value picks a winner automatically.',
      'scope.maxDelete': 'Deletion ceiling (%)',
      'webdav.heading': 'Configure cloud storage',
      'webdav.lead': 'Create a WebDAV remote through rclone without running its interactive setup in a terminal.',
      'webdav.preset': 'Provider',
      'webdav.preset.nutstore': 'Nutstore (坚果云)',
      'webdav.preset.other': 'Other WebDAV',
      'webdav.name': 'Name',
      'webdav.url': 'WebDAV URL',
      'webdav.user': 'Account',
      'webdav.pass': 'App password',
      'webdav.create': 'Create remote',
      'webdav.nutstoreHint': 'Nutstore requires a dedicated app password from Account information -> Security options -> Add app password. The login password does not work over WebDAV.',
      'webdav.creating': 'Creating…',
      'webdav.created': 'Remote created; pick it in the cloud remote list above',
      'webdav.failed': 'Creation failed',
      'action.heading': 'Actions',
      'action.preview': 'Preview changes',
      'action.sync': 'Sync now',
      'action.seed': 'First-time seed',
      'action.refresh': 'Refresh',
      'action.retry': 'Retry',
      'seed.mode': 'Resync winner',
      'seed.hint': 'Use path1 on the machine holding the most complete state; use path2 when joining from another machine so the cloud copy wins.',
      'busy.running': 'Running, please wait…',
      'output.heading': 'Run output',
      'conflict.heading': 'Conflict copies present',
      'conflict.hint': 'Files changed on both sides were kept as separate copies. Review, merge by hand, then delete the extra copies.',
      'error.state': 'Could not read sync state',
      'error.settings': 'Save failed',
      'item.sessions': 'Sessions',
      'item.sessions.hint': 'One append-only log per session',
      'item.attachments': 'Attachments',
      'item.attachments.hint': 'Images and files referenced by sessions',
      'item.profiles': 'Profile configuration',
      'item.profiles.hint': 'Bundles, patch layers, and lockfiles',
      'item.homeConfig': 'Home-level config files',
      'item.homeConfig.hint': 'cordis.patch.yml and AGENTS.md at the DSH home root',
      'item.credentials': 'Credentials',
      'item.credentials.hint': 'Plaintext API keys; each machine fills its own by default',
      'item.workspaceState': 'Workspace state',
      'item.workspaceState.hint': 'Sidebar grouping and derived caches; rebuilt from session headers',
      'item.providerCache': 'Provider cache',
      'item.providerCache.hint': 'Expiring vendor upload records; rebuilt on demand',
      'item.pluginModules': 'Plugin dependencies',
      'item.pluginModules.hint': 'node_modules: platform-specific binaries and absolute links',
      'item.tag.derived': 'derived',
      'webdav.vendor': 'Server type',
      'webdav.vendor.hint': 'Only Nextcloud and ownCloud report modification times; on a plain WebDAV server switch the comparison to size.',
    };

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: '20px', fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
      title: { margin: 0, fontSize: '16px', fontWeight: 500 },
      lead: { margin: 0, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
      heading: { margin: 0, fontSize: '13px', fontWeight: 500 },
      card: {
        display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px 16px',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      row: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '16px' },
      rowLabel: { flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary)' },
      rowValue: { textAlign: 'right', wordBreak: 'break-all' },
      controls: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' },
      field: { display: 'flex', alignItems: 'center', gap: '8px' },
      input: {
        fontSize: '13px', padding: '6px 8px', borderRadius: '6px', minWidth: '160px',
        border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
      },
      textarea: {
        fontSize: '12px', padding: '8px', borderRadius: '6px', width: '100%', minHeight: '64px',
        border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit', resize: 'vertical',
        boxSizing: 'border-box',
      },
      button: {
        fontSize: '13px', fontWeight: 500, padding: '6px 12px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)', cursor: 'pointer',
      },
      buttonPrimary: {
        fontSize: '13px', fontWeight: 500, padding: '6px 12px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-bg-base)', cursor: 'pointer',
      },
      buttonDisabled: { opacity: 0.6, cursor: 'default' },
      notice: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
        padding: '10px 12px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)',
      },
      errorText: { color: 'var(--dsw-alias-state-error-primary)' },
      okText: { color: 'var(--dsw-alias-state-success-primary)' },
      warnText: { color: 'var(--dsw-alias-state-warn-primary)' },
      toggleList: { display: 'flex', flexDirection: 'column', gap: '2px' },
      toggle: {
        display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '7px 0',
        cursor: 'pointer',
      },
      toggleText: { display: 'flex', flexDirection: 'column', gap: '2px' },
      toggleName: { display: 'flex', alignItems: 'center', gap: '6px' },
      hint: { color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 },
      tag: {
        fontSize: '11px', padding: '1px 6px', borderRadius: '4px',
        border: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-secondary)',
      },
      tagWarn: { borderColor: 'var(--dsw-alias-state-warn-primary)', color: 'var(--dsw-alias-state-warn-primary)' },
      output: {
        margin: 0, padding: '12px', borderRadius: '6px', fontSize: '12px', lineHeight: 1.5,
        border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)',
        maxHeight: '320px', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      },
      conflictList: { margin: 0, padding: '0 0 0 18px', display: 'flex', flexDirection: 'column', gap: '4px' },
      conflictItem: { wordBreak: 'break-all', color: 'var(--dsw-alias-label-secondary)' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '10px' },
    };

    function Row(label, value, key) {
      return h('div', { style: S.row, key },
        h('span', { style: S.rowLabel }, label),
        h('span', { style: S.rowValue }, value));
    }

    function Note(note, t, onRetry) {
      if (note === null) return null;
      const tone = note.kind === 'error' ? S.errorText : note.kind === 'ok' ? S.okText : S.warnText;
      return h('div', { style: S.notice },
        h('span', { style: { lineHeight: 1.5, ...tone } }, note.text),
        onRetry ? h('button', { style: S.button, onClick: onRetry }, t('action.retry')) : null);
    }

    function SyncSection() {
      const ctx = SyncSection.ctx;
      const [, setTick] = useState(0);
      const [state, setState] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [output, setOutput] = useState('');
      const [remote, setRemote] = useState('');
      const [subpath, setSubpath] = useState('dsh');
      const [resyncMode, setResyncMode] = useState('path1');
      const [draft, setDraft] = useState(null);
      const [dirty, setDirty] = useState(false);
      const [saveNote, setSaveNote] = useState(null);
      const [remoteNote, setRemoteNote] = useState(null);
      const [creating, setCreating] = useState(false);
      const [webdav, setWebdav] = useState({
        preset: 'nutstore',
        name: 'nutstore',
        url: 'https://dav.jianguoyun.com/dav/',
        user: '',
        pass: '',
        vendor: 'other',
      });
      const t = ctx.locale.bind(NS);

      useEffect(() => ctx.locale.subscribe(() => setTick(value => value + 1)), []);

      const load = useCallback(async () => {
        try {
          const response = await fetch('api/dsh-sync.state');
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const next = await response.json();
          setState(next);
          setError(null);
          setRemote(current => current !== '' ? current : (next.rclone.remotes[0] ?? ''));
          setSubpath(current => current !== 'dsh' ? current : (next.settings.target.split(':')[1] || current));
          setDraft(current => current ?? next.settings);
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        }
      }, []);

      useEffect(() => { void load(); }, [load]);

      const patchDraft = useCallback(patch => {
        setDraft(current => ({ ...current, ...patch }));
        setDirty(true);
        setSaveNote(null);
      }, []);

      const save = useCallback(async () => {
        setBusy(true);
        try {
          const response = await fetch('api/dsh-sync.settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(draft),
          });
          const result = await response.json();
          if (response.ok && result.ok) {
            setDraft(result.settings);
            setDirty(false);
            setSaveNote({ kind: 'ok', text: t('scope.saved') });
            void load();
          } else {
            setSaveNote({ kind: 'error', text: t('error.settings') + '：' + (result.error ?? response.status) });
          }
        } catch (cause) {
          setSaveNote({ kind: 'error', text: t('error.settings') + '：' + String(cause?.message ?? cause) });
        } finally {
          setBusy(false);
        }
      }, [draft, load, t]);

      const createRemote = useCallback(async () => {
        setCreating(true);
        setRemoteNote(null);
        try {
          const response = await fetch('api/dsh-sync.remote', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              name: webdav.name,
              url: webdav.url,
              user: webdav.user,
              pass: webdav.pass,
              vendor: webdav.preset === 'nutstore' ? 'other' : webdav.vendor,
            }),
          });
          const result = await response.json();
          if (response.ok && result.ok) {
            setRemoteNote({ kind: 'ok', text: t('webdav.created') });
            setWebdav(current => ({ ...current, pass: '' }));
            setRemote(result.remote);
            void load();
          } else {
            setRemoteNote({ kind: 'error', text: t('webdav.failed') + '：' + (result.error ?? response.status) });
          }
          if (typeof result.output === 'string' && result.output !== '') setOutput(result.output);
        } catch (cause) {
          setRemoteNote({ kind: 'error', text: t('webdav.failed') + '：' + String(cause?.message ?? cause) });
        } finally {
          setCreating(false);
        }
      }, [webdav, load, t]);

      const runAction = useCallback(async action => {
        setBusy(true);
        setOutput('');
        try {
          const response = await fetch('api/dsh-sync.run', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, target: remote + subpath, resyncMode }),
          });
          const result = await response.json();
          setOutput(result.output ?? result.error ?? '');
          setError(response.ok ? null : (result.error ?? 'HTTP ' + response.status));
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy(false);
          void load();
        }
      }, [remote, subpath, resyncMode, load]);

      const ready = state !== null && state.rclone.installed && state.rclone.remotes.length > 0;
      const conflicts = state?.conflicts ?? [];
      const items = state?.items ?? [];
      const settings = draft ?? state?.settings ?? null;

      return h('div', { style: S.page },
        h('h2', { style: S.title }, t('title')),
        h('p', { style: S.lead }, t('lead')),

        Note(error === null ? null : { kind: 'error', text: t('error.state') + '：' + error }, t, () => { void load(); }),

        h('section', { style: S.card },
          h('h3', { style: S.heading }, t('status.heading')),
          Row(t('status.rclone'),
            state === null ? t('status.loading')
              : state.rclone.installed ? state.rclone.version
                : t('status.missing') + ' — ' + t('status.install'), 'rclone'),
          Row(t('status.local'), state?.localRoot ?? '—', 'local'),
          Row(t('status.work'), state?.workDir ?? '—', 'work'),
          Row(t('status.filters'), state?.filtersPath ?? '—', 'filters'),
          Row(t('status.last'),
            state?.lastRun ? state.lastRun.name + ' · ' + new Date(state.lastRun.at).toLocaleString() : t('status.never'),
            'last'),
          Row(t('status.conflicts'), String(state?.conflictCount ?? 0), 'conflicts')),

        h('section', { style: S.card },
          h('h3', { style: S.heading }, t('target.heading')),
          state !== null && state.rclone.remotes.length === 0
            ? h('p', { style: { ...S.hint, ...S.warnText } }, t('target.none'))
            : h('div', { style: S.controls },
              h('label', { style: S.field },
                h('span', { style: S.rowLabel }, t('target.remote')),
                h('select', {
                  style: S.input, value: remote, disabled: busy,
                  onChange: event => setRemote(event.target.value),
                }, (state?.rclone.remotes ?? []).map(name => h('option', { key: name, value: name }, name)))),
              h('label', { style: S.field },
                h('span', { style: S.rowLabel }, t('target.subpath')),
                h('input', {
                  style: S.input, value: subpath, disabled: busy, spellCheck: false,
                  onChange: event => setSubpath(event.target.value),
                })))),

        settings !== null && h('section', { style: S.card },
          h('h3', { style: S.heading }, t('scope.heading')),
          h('p', { style: S.hint }, t('scope.lead')),
          h('div', { style: S.toggleList }, items.map(item => {
            const text = ITEM_TEXT[item.key] ?? [item.key, item.key];
            const on = settings.sync[item.key] === true;
            return h('label', { key: item.key, style: S.toggle },
              h('input', {
                type: 'checkbox', checked: on, disabled: busy,
                onChange: event => patchDraft({ sync: { ...settings.sync, [item.key]: event.target.checked } }),
              }),
              h('span', { style: S.toggleText },
                h('span', { style: S.toggleName },
                  h('span', null, t(text[0])),
                  item.secret ? h('span', { style: { ...S.tag, ...S.tagWarn } }, t('item.credentials')) : null,
                  item.derived ? h('span', { style: S.tag }, t('item.tag.derived')) : null),
                h('span', { style: S.hint }, t(text[1]))));
          })),
          h('label', { style: { ...S.toggleText, gap: '6px' } },
            h('span', { style: S.rowLabel }, t('scope.extra')),
            h('textarea', {
              style: S.textarea, value: settings.extraExcludes.join('\n'), disabled: busy,
              spellCheck: false,
              onChange: event => patchDraft({ extraExcludes: event.target.value.split('\n') }),
            }),
            h('span', { style: S.hint }, t('scope.extra.hint'))),
          h('div', { style: S.grid },
            h('label', { style: S.toggleText },
              h('span', { style: S.rowLabel }, t('scope.compare')),
              h('select', {
                style: S.input, value: settings.compare, disabled: busy,
                onChange: event => patchDraft({ compare: event.target.value }),
              }, (state?.compareModes ?? []).map(mode => h('option', { key: mode, value: mode }, mode))),
              h('span', { style: S.hint }, t('scope.compare.hint'))),
            h('label', { style: S.toggleText },
              h('span', { style: S.rowLabel }, t('scope.conflict')),
              h('select', {
                style: S.input, value: settings.conflictResolve, disabled: busy,
                onChange: event => patchDraft({ conflictResolve: event.target.value }),
              }, (state?.conflictModes ?? []).map(mode => h('option', { key: mode, value: mode }, mode))),
              h('span', { style: S.hint }, t('scope.conflict.hint'))),
            h('label', { style: S.toggleText },
              h('span', { style: S.rowLabel }, t('scope.maxDelete')),
              h('input', {
                style: S.input, type: 'number', min: 0, max: 100, value: settings.maxDelete, disabled: busy,
                onChange: event => patchDraft({ maxDelete: Number(event.target.value) }),
              }))),
          h('div', { style: S.controls },
            h('button', {
              style: busy || !dirty ? { ...S.buttonPrimary, ...S.buttonDisabled } : S.buttonPrimary,
              disabled: busy || !dirty,
              onClick: () => { void save(); },
            }, t('scope.save')),
            dirty ? h('span', { style: { ...S.hint, ...S.warnText } }, t('scope.dirty')) : null),
          Note(saveNote, t)),

        h('section', { style: S.card },
          h('h3', { style: S.heading }, t('webdav.heading')),
          h('p', { style: S.hint }, t('webdav.lead')),
          h('div', { style: S.grid },
            h('label', { style: S.toggleText },
              h('span', { style: S.rowLabel }, t('webdav.preset')),
              h('select', {
                style: S.input, value: webdav.preset, disabled: creating,
                onChange: event => {
                  const preset = event.target.value;
                  setWebdav(current => preset === 'nutstore'
                    ? { ...current, preset, name: 'nutstore', url: 'https://dav.jianguoyun.com/dav/' }
                    : { ...current, preset, name: 'webdav', url: 'https://' });
                },
              }, [
                h('option', { key: 'nutstore', value: 'nutstore' }, t('webdav.preset.nutstore')),
                h('option', { key: 'other', value: 'other' }, t('webdav.preset.other')),
              ])),
            webdav.preset === 'other' ? h('label', { style: S.toggleText },
              h('span', { style: S.rowLabel }, t('webdav.vendor')),
              h('select', {
                style: S.input, value: webdav.vendor, disabled: creating,
                onChange: event => setWebdav(current => ({ ...current, vendor: event.target.value })),
              }, ['other', 'nextcloud', 'owncloud', 'infinitescale', 'fastmail', 'sharepoint', 'sharepoint-ntlm', 'rclone']
                .map(vendor => h('option', { key: vendor, value: vendor }, vendor))),
              h('span', { style: S.hint }, t('webdav.vendor.hint'))) : null,
            h('label', { style: S.toggleText },
              h('span', { style: S.rowLabel }, t('webdav.name')),
              h('input', {
                style: S.input, value: webdav.name, disabled: creating, spellCheck: false,
                onChange: event => setWebdav(current => ({ ...current, name: event.target.value })),
              })),
            h('label', { style: S.toggleText },
              h('span', { style: S.rowLabel }, t('webdav.url')),
              h('input', {
                style: S.input, value: webdav.url, disabled: creating, spellCheck: false,
                onChange: event => setWebdav(current => ({ ...current, url: event.target.value })),
              })),
            h('label', { style: S.toggleText },
              h('span', { style: S.rowLabel }, t('webdav.user')),
              h('input', {
                style: S.input, value: webdav.user, disabled: creating, spellCheck: false,
                onChange: event => setWebdav(current => ({ ...current, user: event.target.value })),
              })),
            h('label', { style: S.toggleText },
              h('span', { style: S.rowLabel }, t('webdav.pass')),
              h('input', {
                style: S.input, type: 'password', value: webdav.pass, disabled: creating,
                onChange: event => setWebdav(current => ({ ...current, pass: event.target.value })),
              }))),
          webdav.preset === 'nutstore' ? h('p', { style: { ...S.hint, ...S.warnText } }, t('webdav.nutstoreHint')) : null,
          h('div', { style: S.controls },
            h('button', {
              style: creating ? { ...S.button, ...S.buttonDisabled } : S.button,
              disabled: creating,
              onClick: () => { void createRemote(); },
            }, creating ? t('webdav.creating') : t('webdav.create'))),
          Note(remoteNote, t)),

        h('section', { style: S.card },
          h('h3', { style: S.heading }, t('action.heading')),
          h('div', { style: S.controls },
            h('label', { style: S.field },
              h('span', { style: S.rowLabel }, t('seed.mode')),
              h('select', {
                style: S.input, value: resyncMode, disabled: busy,
                onChange: event => setResyncMode(event.target.value),
              }, (state?.resyncModes ?? ['path1', 'path2']).map(mode => h('option', { key: mode, value: mode }, mode)))),
            h('button', {
              style: busy || !ready ? { ...S.button, ...S.buttonDisabled } : S.button,
              disabled: busy || !ready,
              onClick: () => { void runAction('preview'); },
            }, t('action.preview')),
            h('button', {
              style: busy || !ready ? { ...S.buttonPrimary, ...S.buttonDisabled } : S.buttonPrimary,
              disabled: busy || !ready,
              onClick: () => { void runAction('sync'); },
            }, t('action.sync')),
            h('button', {
              style: busy || !ready ? { ...S.button, ...S.buttonDisabled } : S.button,
              disabled: busy || !ready,
              onClick: () => { void runAction('seed'); },
            }, t('action.seed')),
            h('button', {
              style: busy ? { ...S.button, ...S.buttonDisabled } : S.button,
              disabled: busy,
              onClick: () => { void load(); },
            }, t('action.refresh'))),
          h('p', { style: S.hint }, t('seed.hint')),
          busy ? h('p', { style: S.hint }, t('busy.running')) : null),

        conflicts.length > 0 && h('section', { style: S.card },
          h('h3', { style: { ...S.heading, ...S.warnText } }, t('conflict.heading')),
          h('p', { style: S.hint }, t('conflict.hint')),
          h('ul', { style: S.conflictList },
            conflicts.map(path => h('li', { key: path, style: S.conflictItem }, path)))),

        output !== '' && h('section', { style: S.card },
          h('h3', { style: S.heading }, t('output.heading')),
          h('pre', { style: S.output }, output)));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        SyncSection.ctx = ctx;
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-sync: dictionaries');
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-sync',
          order: 25,
          label: () => ctx.locale.bind(NS)('nav'),
        }, SyncSection));
      },
    };
  },
});
