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

  if (!window.CloudSync) window.CloudSync = {
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
      const wanted = [];
      let sawManifest = false;
      let sawPhotoState = false;
      const activePhotos = [];
      const deletedPhotos = [];
      (data || []).forEach(r => {
        m.hashes[r.key] = r.deleted ? '__deleted' : hash(JSON.stringify(r.payload));
        // 每张照片都有一行独立状态；它比旧的设备照片清单优先。
        if (r.kind === 'photo' || r.key.indexOf('photo:') === 0) {
          sawPhotoState = true;
          const id = (r.payload && r.payload.id) || r.key.slice(6);
          const box = r.deleted ? deletedPhotos : activePhotos;
          if (id && box.indexOf(id) < 0) box.push(id);
          return;
        }
        // 删除行也必须交给页面。旧逻辑在这里直接 return，导致 applyRows 永远
        // 收不到 tombstone，云端删除后本地对象就可能被下一次同步重新加入。
        out[r.key] = {
          kind: r.kind, who: r.who, payload: r.deleted ? {} : r.payload,
          mine: r.owner === me.id, deleted: !!r.deleted
        };
        if (r.deleted) return;
        if (r.kind === 'photos') {
          sawManifest = true;
          (r.payload.ids || []).forEach(id => { if (wanted.indexOf(id) < 0) wanted.push(id); });
        }
      });
      // 本机刚拍还没推上去的照片也算「要保留」，不然会被误删
      const localUnsynced = [];
      (window.PhotoStore && window.PhotoStore.ids ? window.PhotoStore.ids() : []).forEach(id => {
        if (!(m.photos || {})[id]) localUnsynced.push(id);
        if (!(m.photos || {})[id] && wanted.indexOf(id) < 0) wanted.push(id);
      });
      activePhotos.forEach(id => { if (wanted.indexOf(id) < 0) wanted.push(id); });
      const blocked = new Set(deletedPhotos.concat(m.pendingPhotoDeletes || []));
      const resolvedWanted = wanted.filter(id => !blocked.has(id));
      // 用户在本机重新上传同一个格子时，这是比旧 tombstone 更新的操作。
      localUnsynced.forEach(id => { if (resolvedWanted.indexOf(id) < 0) resolvedWanted.push(id); });
      m.wanted = (sawManifest || sawPhotoState) ? resolvedWanted : null;
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
      const gone = Object.keys(m.hashes).filter(k => k.indexOf('photo:') !== 0
        && !rows[k] && m.hashes[k] !== '__deleted' && this.ownKey(k));
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

    // 明确告诉云端「这几行删了」——不依赖本地 hash 记录，删除一定推得上去
    async markDeleted(keys, photoIds) {
      const sb = await getClient();
      if (!sb || !me || !keys || !keys.length) return false;
      const m = meta();
      const up = keys.map(k => ({
        key: k, kind: k.split(':')[0], who: this.who(), owner: me.id,
        payload: {}, deleted: true, updated_at: new Date().toISOString()
      }));
      const { error } = await sb.from(TABLE).upsert(up, { onConflict: 'key' });
      if (error) { emit(classify(error)); return false; }
      keys.forEach(k => { m.hashes[k] = '__deleted'; });
      // 关联照片也写独立 tombstone，不能只删 Storage 对象。
      if (photoIds && photoIds.length) {
        await this.markPhotosDeleted(photoIds);
      }
      writeJSON(META_KEY, m);
      emit({ status: 'online', message: '删除已同步', lastSync: Date.now() });
      return true;
    },

    // 照片删除队列先落本地，再写 entries tombstone。离线时队列保留，
    // 下次同步会先补写删除，绝不会先把旧照片拉回来。
    async markPhotosDeleted(photoIds) {
      const ids = (photoIds || []).filter((id, i, a) => id && a.indexOf(id) === i);
      if (!ids.length) return true;
      let m = meta();
      m.pendingPhotoDeletes = (m.pendingPhotoDeletes || []).concat(ids)
        .filter((id, i, a) => a.indexOf(id) === i);
      ids.forEach(id => { if (m.photos) delete m.photos[id]; });
      writeJSON(META_KEY, m);

      const sb = await getClient();
      if (!sb || !me) return false;
      const now = new Date().toISOString();
      const rows = ids.map(id => ({
        key: 'photo:' + id, kind: 'photo', who: this.who(), owner: me.id,
        payload: { id: id }, deleted: true, updated_at: now
      }));
      const { error } = await sb.from(TABLE).upsert(rows, { onConflict: 'key' });
      if (error) { emit(classify(error)); return false; }
      try { await sb.storage.from(BUCKET).remove(ids.map(id => id + '.webp')); } catch (e) {}

      m = meta();
      m.pendingPhotoDeletes = (m.pendingPhotoDeletes || []).filter(id => ids.indexOf(id) < 0);
      ids.forEach(id => {
        m.hashes['photo:' + id] = '__deleted';
        if (m.photos) delete m.photos[id];
      });
      writeJSON(META_KEY, m);
      emit({ status: 'online', message: '照片删除已同步', lastSync: Date.now() });
      return true;
    },

    async flushPhotoDeletes() {
      const ids = meta().pendingPhotoDeletes || [];
      return ids.length ? this.markPhotosDeleted(ids) : true;
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
      const m0 = meta();
      const synced = m0.photos || {};
      // 云端清单（两个人的合集）就是真相：清单里没有、但本机同步过的 → 是被谁删了
      const wanted = m0.wanted || null;
      if (wanted) {
        const keep = {};
        wanted.forEach(id => { keep[id] = 1; });
        Object.keys(local).forEach(id => {
          if (!keep[id] && synced[id]) window.PhotoStore.set(id, null);
        });
      }
      const { data: files, error } = await sb.storage.from(BUCKET).list('', { limit: 1000 });
      if (error) { state.photoErr = '读照片桶失败：' + error.message; throw error; }
      state.photoErr = '';
      for (const f of files || []) {
        const id = f.name.replace(/\.webp$/, '');
        if (window.PhotoStore.get(id)) continue;
        if (wanted && wanted.indexOf(id) < 0) continue;
        const { data: blob } = await sb.storage.from(BUCKET).download(f.name);
        if (blob) await window.PhotoStore.set(id, await blobToDataUrl(blob));
      }
    },

    async pushPhotos() {
      const sb = await getClient();
      if (!sb || !window.PhotoStore) return;
      // 桶里有、但两个人的清单里都没有的文件 → 已经被删了，清掉
      const mm = meta();
      const wanted = mm.wanted;
      if (wanted) {
        const keep = {};
        wanted.forEach(id => { keep[id] = 1; });
        const ls = await sb.storage.from(BUCKET).list('', { limit: 1000 });
        const orphans = (ls.data || [])
          .map(f => f.name.replace(/\.webp$/, ''))
          .filter(id => id !== '__probe' && !keep[id]);
        if (orphans.length) {
          await sb.storage.from(BUCKET).remove(orphans.map(id => id + '.webp'));
          orphans.forEach(id => { if (mm.photos) delete mm.photos[id]; });
          writeJSON(META_KEY, mm);
        }
      }
      await window.PhotoStore.ready();
      const m = meta();
      const local = window.PhotoStore.all();
      let n = 0;
      const activeRows = [];
      for (const id of Object.keys(local)) {
        const stamp = local[id].length;
        if (m.photos[id] === stamp) continue;
        const blob = await dataUrlToBlob(local[id]);
        const { error } = await sb.storage.from(BUCKET).upload(id + '.webp', blob, { upsert: true, contentType: 'image/webp' });
        if (error) { state.photoErr = '传照片失败：' + error.message; throw error; }
        state.photoErr = '';
        m.photos[id] = stamp; n++;
        const payload = { id: id };
        activeRows.push({
          key: 'photo:' + id, kind: 'photo', who: this.who(), owner: me.id,
          payload: payload, deleted: false, updated_at: new Date().toISOString()
        });
        m.hashes['photo:' + id] = hash(JSON.stringify(payload));
      }
      if (activeRows.length) {
        const { error } = await sb.from(TABLE).upsert(activeRows, { onConflict: 'key' });
        if (error) throw error;
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
        const sb = await getClient();
        // 有会话但模块里还没拿到 user 时（刷新后常见），先补一次
        if (!me && sb) {
          try { const { data } = await sb.auth.getUser(); me = data && data.user; } catch (e) {}
        }
        if (!me) { emit({ status: 'connecting', message: '地址已填好 · 还差登录（下面输邮箱密码）' }); return; }
        // 删除优先于 pull，避免旧照片清单把刚删的照片下载回来。
        await this.flushPhotoDeletes();
        // 只要这台设备完成过一次云端基线同步，就先推本机快照。
        // 这样列表删项、清空数组、删除一次打卡等「payload 内部的删除」
        // 不会在 pull-first 流程中先被旧云端快照覆盖。
        const hadBaseline = !!meta().pulledAt;
        if (hadBaseline) await this.pushRows(rows());
        const remote = await this.pullRows();
        if (remote && applyRemote) applyRemote(remote);
        await this.pushRows(rows());
        this.live();
      } catch (e) {
        emit(classify(e));
      }
    },

    // 自检：一步步定位到底卡在哪儿，直接给出能照抄的修复 SQL
    async diagnose() {
      const c = cfg();
      if (!c.url || !c.key) return { ok: false, why: '还没填 Supabase 地址和 key。' };
      let sb;
      try { sb = await getClient(); } catch (e) { return { ok: false, why: '连不上 Supabase：' + (e.message || e) }; }
      if (!sb) return { ok: false, why: 'Supabase 客户端没起来，检查一下地址是不是 https://xxx.supabase.co。' };
      if (!me) {
        try { const { data } = await sb.auth.getUser(); me = data && data.user; } catch (e) {}
      }
      if (!me) return { ok: false, why: '还没登录。用菜菜或果果的邮箱密码登录一次。' };
      const uid = me.id;
      // 白名单
      const wl = await sb.from('allowed_users').select('uid, name');
      if (wl.error) {
        if (/does not exist|relation/i.test(wl.error.message)) {
          return { ok: false, why: 'allowed_users 表还没建 —— 那段 SQL 没跑成功。回 Supabase 的 SQL Editor 重跑一次。', uid: uid };
        }
        return { ok: false, why: '读白名单被拦住了：' + wl.error.message, uid: uid };
      }
      const rows = wl.data || [];
      const mine = rows.some(r => String(r.uid) === String(uid));
      if (!mine && rows.length === 0) {
        // 表里其实有数据，只是 allowed_users 开了 RLS 又没给 select 策略，客户端一行都读不到
        return {
          ok: false, uid: uid,
          why: '白名单表读不出来 —— allowed_users 开了行级安全，但没给「可以读」的策略，所以连你自己那一行也看不见（entries 的策略也因此全部失效）。跑下面这段就好：',
          sql: 'drop policy if exists "read whitelist" on allowed_users;\n'
             + 'create policy "read whitelist" on allowed_users\n'
             + '  for select to authenticated using (true);'
        };
      }
      if (!mine) {
        return {
          ok: false, uid: uid,
          why: '白名单里有 ' + rows.length + ' 行，但没有你这个 UID。跑下面这一行补上（已经存在会报错，那就说明填的是别的 UID）：',
          sql: "insert into allowed_users values ('" + uid + "','" + (localStorage.getItem(WHO_KEY) === 'guo' ? '果果' : '菜菜') + "')\n  on conflict (uid) do nothing;"
        };
      }
      // 读
      const rd = await sb.from(TABLE).select('key').limit(1);
      if (rd.error) return { ok: false, uid: uid, why: '读 entries 被拦住了：' + rd.error.message };
      // 写
      const probe = { key: '__probe__' + uid.slice(0, 8), kind: 'probe', who: 'probe', owner: uid, payload: {}, deleted: true, updated_at: new Date().toISOString() };
      const wr = await sb.from(TABLE).upsert(probe, { onConflict: 'key' });
      if (wr.error) return { ok: false, uid: uid, why: '写 entries 被拦住了：' + wr.error.message };
      try { await sb.from(TABLE).delete().eq('key', probe.key); } catch (e) {}
      // 照片桶：列目录 + 传一张 1 像素图 + 删掉
      const ls = await sb.storage.from(BUCKET).list('', { limit: 1 });
      if (ls.error) {
        return {
          ok: false, uid: uid,
          why: '数据同步没问题，但照片桶读不了（' + ls.error.message + '）—— 这就是「文字同步了、照片没同步」的原因。把下面这段跑一次：',
          sql: "insert into storage.buckets (id, name, public) values ('photos','photos',false)\n"
             + '  on conflict (id) do update set public = false;\n'
             + 'drop policy if exists "photos read" on storage.objects;\n'
             + 'drop policy if exists "photos write" on storage.objects;\n'
             + 'create policy "photos read" on storage.objects for select to authenticated\n'
             + "  using (bucket_id = 'photos' and auth.uid() in (select uid from allowed_users));\n"
             + 'create policy "photos write" on storage.objects for all to authenticated\n'
             + "  using (bucket_id = 'photos' and auth.uid() in (select uid from allowed_users))\n"
             + "  with check (bucket_id = 'photos' and auth.uid() in (select uid from allowed_users));"
        };
      }
      const tiny = new Blob([new Uint8Array([82,73,70,70])], { type: 'image/webp' });
      const up2 = await sb.storage.from(BUCKET).upload('__probe.webp', tiny, { upsert: true, contentType: 'image/webp' });
      if (up2.error) {
        return {
          ok: false, uid: uid,
          why: '照片桶能读但不能写（' + up2.error.message + '）—— 照片同步会卡住。把上面那段照片桶的 SQL 跑一次：',
          sql: 'drop policy if exists "photos write" on storage.objects;\n'
             + 'create policy "photos write" on storage.objects for all to authenticated\n'
             + "  using (bucket_id = 'photos' and auth.uid() in (select uid from allowed_users))\n"
             + "  with check (bucket_id = 'photos' and auth.uid() in (select uid from allowed_users));"
        };
      }
      try { await sb.storage.from(BUCKET).remove(['__probe.webp']); } catch (e) {}
      // 自检通过就把状态一并翻成已连接，别让界面还停在「还没连云端」
      emit({ status: 'online', message: '自检通过 · 已连上云端', lastSync: Date.now(), pending: 0 });
      this.live();
      return { ok: true, uid: uid, why: '一切正常：登录、白名单、数据读写、照片桶读写都通了。' };
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
      'drop policy if exists "read whitelist" on allowed_users;',
      'create policy "read whitelist" on allowed_users for select to authenticated using (true);',
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
