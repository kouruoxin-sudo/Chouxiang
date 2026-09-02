// 云同步 v2：登录 + 一行一改 + 实时推送。
// 原则还是「本地优先」——App 永远先读写本地，云端在后台追平。
// 每一条（一道菜 / 一家店 / 某天某人的记录）是云端的一行，谁写谁那行，两个人不会互相盖掉。
(function () {
  const CFG_KEY = 'chouxiang-cloud-cfg';
  const META_KEY = 'chouxiang-cloud-meta2';
  const WHO_KEY = 'chouxiang-who';
  const TABLE = 'entries';
  const BUCKET = 'photos';
  const CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

  let client = null, clientKey = '', me = null, channel = null;
  const subs = new Set(), authSubs = new Set(), rowSubs = new Set();
  const state = { status: 'off', message: '还没连云端', lastSync: null, pending: 0, live: false };

  const readJSON = (k, fb) => { try { return JSON.parse(localStorage.getItem(k)) || fb; } catch (e) { return fb; } };
  const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  function emit(patch) {
    Object.assign(state, patch || {});
    subs.forEach(fn => fn(Object.assign({}, state)));
  }

  // 地址和 key 存在这台设备上，只用填一次。
  // cloud-config.js 里填了的话，新设备打开就自动认，连拄都不用拄。
  function cfg() {
    const c = readJSON(CFG_KEY, { url: '', key: '' });
    if (!c.url && window.CLOUD_DEFAULT && window.CLOUD_DEFAULT.url) {
      const d = { url: String(window.CLOUD_DEFAULT.url).trim(), key: String(window.CLOUD_DEFAULT.key || '').trim() };
      if (d.url && d.key) { writeJSON(CFG_KEY, d); return d; }
    }
    return c;
  }
  function meta() { return readJSON(META_KEY, { hashes: {}, photos: {}, pulledAt: null }); }
  const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h + ':' + s.length; };

  async function getClient() {
    const c = cfg();
    if (!c.url || !c.key) return null;
    const sig = c.url + '|' + c.key;
    if (client && clientKey === sig) return client;
    const mod = await import(/* webpackIgnore: true */ CDN);
    client = mod.createClient(c.url.replace(/\/+$/, ''), c.key, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'chouxiang-auth' }
    });
    clientKey = sig;
    client.auth.onAuthStateChange((_e, session) => {
      me = (session && session.user) || null;
      authSubs.forEach(fn => fn(me));
      if (!me) closeLive();
    });
    const { data } = await client.auth.getSession();
    me = (data && data.session && data.session.user) || null;
    return client;
  }

  // Supabase 暂停时返回的是网络错误或 503——统一当成「离线」，不当成出错
  function classify(err) {
    const m = String((err && err.message) || err || '');
    if (/fetch|network|Failed to fetch|timeout|503|502|paused/i.test(m)) {
      return { status: 'offline', message: 'Supabase 连不上（可能被暂停了），先用本地的' };
    }
    if (/JWT|not authenticated|permission|policy|row-level/i.test(m)) {
      return { status: 'error', message: '云端不让写：先登录，或者检查一下 RLS 白名单' };
    }
    return { status: 'error', message: '同步出错：' + m };
  }

  const dataUrlToBlob = u => fetch(u).then(r => r.blob());
  const blobToDataUrl = b => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(b);
  });

  function closeLive() {
    if (channel && client) { try { client.removeChannel(channel); } catch (e) {} }
    channel = null;
    emit({ live: false });
  }

  window.CloudSync = {
    state: () => Object.assign({}, state),
    config: cfg,
    configured() { const c = cfg(); return !!(c.url && c.key); },
    user: () => me,
    who: () => localStorage.getItem(WHO_KEY) || '',
    setWho(w) { try { localStorage.setItem(WHO_KEY, w || ''); } catch (e) {} },

    setConfig(url, key) {
      writeJSON(CFG_KEY, { url: (url || '').trim(), key: (key || '').trim() });
      client = null; me = null; closeLive();
      emit(this.configured()
        ? { status: 'connecting', message: '正在连…' }
        : { status: 'off', message: '还没连云端' });
    },

    disconnect() {
      if (client) { try { client.auth.signOut(); } catch (e) {} }
      localStorage.removeItem(CFG_KEY);
      localStorage.removeItem(META_KEY);
      client = null; me = null; closeLive();
      emit({ status: 'off', message: '已断开云端，数据还在这台设备上', lastSync: null });
    },

    // 连接码：一串字，对方粘一下就连上了
    code() {
      const c = cfg();
      if (!c.url || !c.key) return '';
      try { return 'CX1.' + btoa(unescape(encodeURIComponent(c.url + '|' + c.key)))
        .replace(/\+/g, '-').replace(/\//g, '_'); } catch (e) { return ''; }
    },

    applyCode(str) {
      const s = String(str || '').trim().replace(/^CX1\./, '');
      if (!s) throw new Error('连接码是空的');
      let plain = '';
      try { plain = decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))); }
      catch (e) { throw new Error('这个连接码不对'); }
      const parts = plain.split('|');
      if (parts.length !== 2 || !/^https?:\/\//.test(parts[0])) throw new Error('这个连接码不对');
      this.setConfig(parts[0], parts[1]);
      return { url: parts[0], key: parts[1] };
    },

    subscribe(fn) { subs.add(fn); fn(Object.assign({}, state)); return () => subs.delete(fn); },
    onAuth(fn) { authSubs.add(fn); fn(me); return () => authSubs.delete(fn); },
    onRemoteRow(fn) { rowSubs.add(fn); return () => rowSubs.delete(fn); },

    // ── 登录 ─────────────────────────────────────────────
    async init() {
      const sb = await getClient();
      if (!sb) return null;
      authSubs.forEach(fn => fn(me));
      return me;
    },

    async signIn(email, password) {
      const sb = await getClient();
      if (!sb) throw new Error('先填 Supabase 地址和 key');
      const { data, error } = await sb.auth.signInWithPassword({
        email: (email || '').trim(), password: password || ''
      });
      if (error) {
        if (/invalid login/i.test(error.message)) throw new Error('邮箱或密码不对');
        throw error;
      }
      me = data.user;
      emit({ status: 'connecting', message: '登录好了，正在同步…' });
      return me;
    },

    async signOut() {
      const sb = await getClient();
      if (sb) await sb.auth.signOut();
      me = null; closeLive();
      emit({ status: 'connecting', message: '已退出登录' });
    },

    // ── 一行一改 ─────────────────────────────────────────
    // rows: { key: { kind, who, payload } }
    async pullRows() {
      const sb = await getClient();
      if (!sb || !me) return null;
      emit({ status: 'connecting', message: '正在读云端…' });
      const { data, error } = await sb.from(TABLE).select('key, kind, who, owner, payload, deleted, updated_at');
      if (error) throw error;
      const m = meta();
      const out = {};
      (data || []).forEach(r => {
        m.hashes[r.key] = r.deleted ? '__deleted' : hash(JSON.stringify(r.payload));
        if (!r.deleted) out[r.key] = { kind: r.kind, who: r.who, payload: r.payload, mine: r.owner === me.id };
      });
      m.pulledAt = Date.now();
      writeJSON(META_KEY, m);
      await this.pullPhotos();
      emit({ status: 'online', message: '已和云端对齐', lastSync: Date.now(), pending: 0 });
      return out;
    },

    // 只推变过的行；别人的行不动
    async pushRows(rows) {
      const sb = await getClient();
      if (!sb || !me) return;
      const m = meta();
      const up = [];
      Object.keys(rows).forEach(k => {
        const h = hash(JSON.stringify(rows[k].payload));
        if (m.hashes[k] === h) return;
        up.push({
          key: k, kind: rows[k].kind, who: rows[k].who || this.who(),
          owner: me.id, payload: rows[k].payload, deleted: false,
          updated_at: new Date().toISOString()
        });
        m.hashes[k] = h;
      });
      // 我自己删掉的行，云端标记删除
      const gone = Object.keys(m.hashes).filter(k => !rows[k] && m.hashes[k] !== '__deleted' && this.ownKey(k));
      gone.forEach(k => {
        up.push({ key: k, kind: k.split(':')[0], who: this.who(), owner: me.id, payload: {}, deleted: true, updated_at: new Date().toISOString() });
        m.hashes[k] = '__deleted';
      });
      if (up.length) {
        emit({ status: 'connecting', message: '正在写云端…', pending: up.length });
        for (let i = 0; i < up.length; i += 40) {
          const { error } = await sb.from(TABLE).upsert(up.slice(i, i + 40), { onConflict: 'key' });
          if (error) throw error;
        }
      }
      writeJSON(META_KEY, m);
      await this.pushPhotos();
      emit({ status: 'online', message: up.length ? '已同步 ' + up.length + ' 条改动' : '云端已是最新', lastSync: Date.now(), pending: 0 });
    },

    // 我能删的行：菜谱 / 餐厅是两个人共用的，带对方名字的记录行不许我碰
    ownKey(k) {
      const w = this.who();
      if (!w) return false;
      const other = w === 'cai' ? 'guo' : 'cai';
      return k.slice(-(other.length + 1)) !== ':' + other;
    },

    async pullPhotos() {
      const sb = await getClient();
      if (!sb || !window.PhotoStore) return;
      await window.PhotoStore.ready();
      const local = window.PhotoStore.all();
      const { data: files, error } = await sb.storage.from(BUCKET).list('', { limit: 1000 });
      if (error) return;
      for (const f of files || []) {
        const id = f.name.replace(/\.webp$/, '');
        if (local[id]) continue;
        const { data: blob } = await sb.storage.from(BUCKET).download(f.name);
        if (blob) await window.PhotoStore.set(id, await blobToDataUrl(blob));
      }
    },

    async pushPhotos() {
      const sb = await getClient();
      if (!sb || !window.PhotoStore) return;
      await window.PhotoStore.ready();
      const m = meta();
      const local = window.PhotoStore.all();
      let n = 0;
      for (const id of Object.keys(local)) {
        const stamp = local[id].length;
        if (m.photos[id] === stamp) continue;
        const blob = await dataUrlToBlob(local[id]);
        const { error } = await sb.storage.from(BUCKET).upload(id + '.webp', blob, { upsert: true, contentType: 'image/webp' });
        if (!error) { m.photos[id] = stamp; n++; }
      }
      writeJSON(META_KEY, m);
      if (n) emit({ message: '又传了 ' + n + ' 张照片' });
    },

    // ── 实时 ─────────────────────────────────────────────
    async live() {
      const sb = await getClient();
      if (!sb || !me || channel) return;
      channel = sb.channel('chouxiang-entries')
        .on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, p => {
          const r = p.new || {};
          if (!r.key || r.owner === me.id) return;   // 自己的改动不用提醒自己
          const m = meta();
          m.hashes[r.key] = r.deleted ? '__deleted' : hash(JSON.stringify(r.payload));
          writeJSON(META_KEY, m);
          rowSubs.forEach(fn => fn({ key: r.key, kind: r.kind, who: r.who, payload: r.payload, deleted: !!r.deleted }));
        })
        .subscribe(s => emit({ live: s === 'SUBSCRIBED' }));
    },

    // 开机同步：先拉后推；任何一步失败都退回本地模式，不打断使用
    async syncNow(rows, applyRemote) {
      if (!this.configured()) return;
      try {
        await getClient();
        if (!me) { emit({ status: 'off', message: '还没登录' }); return; }
        const remote = await this.pullRows();
        if (remote && applyRemote) applyRemote(remote);
        await this.pushRows(rows());
        this.live();
      } catch (e) {
        emit(classify(e));
      }
    },

    async pushQuiet(rows) {
      if (!this.configured() || !me) return;
      try { await this.pushRows(rows); } catch (e) { emit(classify(e)); }
    },

    // 建表 / 白名单 / 照片桶的 SQL，用户复制到 Supabase SQL Editor 跑一次
    setupSQL: [
      '-- 1) 一行一改的数据表',
      'create table if not exists entries (',
      '  key text primary key,',
      '  kind text not null,',
      '  who text,',
      '  owner uuid not null default auth.uid(),',
      '  payload jsonb not null default \'{}\'::jsonb,',
      '  deleted boolean not null default false,',
      '  updated_at timestamptz not null default now()',
      ');',
      '',
      '-- 2) 只有名单里的两个人能进（在 Authentication → Users 里抄 UID）',
      'create table if not exists allowed_users (uid uuid primary key, name text);',
      "-- insert into allowed_users values ('菜菜的-UID','菜菜'),('果果的-UID','果果');",
      '',
      'alter table entries enable row level security;',
      'alter table allowed_users enable row level security;',
      'drop policy if exists "read all" on entries;',
      'drop policy if exists "write own" on entries;',
      'drop policy if exists "update own" on entries;',
      'create policy "read all" on entries for select to authenticated',
      '  using (auth.uid() in (select uid from allowed_users));',
      'create policy "write own" on entries for insert to authenticated',
      '  with check (owner = auth.uid() and auth.uid() in (select uid from allowed_users));',
      '-- 菜谱和餐厅是两个人共用的，所以更新只看白名单；记录行的 key 带名字，天然不会撞',
      'create policy "update own" on entries for update to authenticated',
      '  using (auth.uid() in (select uid from allowed_users))',
      '  with check (auth.uid() in (select uid from allowed_users));',
      '',
      '-- 3) 实时推送',
      'alter publication supabase_realtime add table entries;',
      '',
      '-- 4) 照片桶：私有。没登录的人连图片地址都打不开',
      "insert into storage.buckets (id, name, public) values ('photos','photos',false)",
      '  on conflict (id) do update set public = false;',
      'drop policy if exists "photos read" on storage.objects;',
      'drop policy if exists "photos write" on storage.objects;',
      'create policy "photos read" on storage.objects for select to authenticated',
      "  using (bucket_id = 'photos' and auth.uid() in (select uid from allowed_users));",
      'create policy "photos write" on storage.objects for all to authenticated',
      "  using (bucket_id = 'photos' and auth.uid() in (select uid from allowed_users))",
      "  with check (bucket_id = 'photos' and auth.uid() in (select uid from allowed_users));",
      '',
      '-- 5) 最后一步（在网页后台点）：Authentication → Sign In / Providers → Email',
      '--    把 “Allow new users to sign up” 关掉，只留你们俩。'
    ].join('\n')
  };
})();
