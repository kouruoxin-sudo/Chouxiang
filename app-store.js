// 存档层：把 App 的数据写进浏览器 localStorage，照片走 IndexedDB（photo-slot.js）。
// 另外提供整包导出 / 导入，用来做手动备份。
(function () {
  const KEY = 'chouxiang-data-v1';
  const RING = 'chouxiang-rollback-v1';   // 本机自动回滚点（只存数据，照片在 IndexedDB 里不动）
  const RING_KEEP = 4;
  const RING_GAP = 20 * 60 * 1000;        // 两个回滚点至少隔 20 分钟
  const RING_MAX = 1200000;               // 数据大到这个程度就不再留回滚点

  function ringRead() {
    try { return JSON.parse(localStorage.getItem(RING) || '[]') || []; } catch (e) { return []; }
  }

  function ringWrite(ring) {
    try {
      if (!ring.length) { localStorage.removeItem(RING); return true; }
      localStorage.setItem(RING, JSON.stringify(ring));
      return true;
    } catch (e) { return false; }
  }

  // 腾地方：丢掉最老的一个回滚点。还能丢就返回 true
  function shrinkRing() {
    const ring = ringRead();
    if (!ring.length) return false;
    ring.pop();
    if (!ringWrite(ring)) { try { localStorage.removeItem(RING); } catch (e) {} }
    return true;
  }

  // 把「覆盖之前那一份」留成回滚点。万一同步或改动把东西弄没了，
  // 可以直接退回几十分钟前的状态。但回滚点永远让位于主存档：
  // 数据大就少留几份，写不下就不留，绝不能把主存档的配额吃掉。
  function keepRollback(prevRaw) {
    try {
      if (!prevRaw || prevRaw.length > RING_MAX) return;
      const ring = ringRead();
      const now = Date.now();
      if (ring.length && now - (ring[0].at || 0) < RING_GAP) return;
      let d = null;
      try { d = JSON.parse(prevRaw); } catch (e) { return; }
      if (!d) return;
      // 数据越大越少留：一共大约不超过主存档的两倍
      const keep = prevRaw.length > 400000 ? 1 : prevRaw.length > 120000 ? 2 : RING_KEEP;
      ring.unshift({
        at: now, raw: prevRaw,
        dishes: (d.dishes || []).length,
        rests: (d.restaurants || []).length,
        days: Object.keys(d.records || {}).length
      });
      while (ring.length > keep) ring.pop();
      // 配额吃紧就先丢最老的，丢到能写下为止；一份也写不下就干脆不留
      while (ring.length) {
        if (ringWrite(ring)) return;
        ring.pop();
      }
      try { localStorage.removeItem(RING); } catch (e) {}
    } catch (e) {}
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  window.AppStore = {
    load() {
      try {
        const raw = localStorage.getItem(KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    },

    // 主存档优先：先把它写进去，配额不够就一层层丢回滚点腾地方；
    // 回滚点是为了防丢数据，绝不能反过来把新存的东西挤没。
    save(snapshot) {
      let prev = null;
      try { prev = localStorage.getItem(KEY); } catch (e) {}
      let body;
      try { body = JSON.stringify(snapshot); } catch (e) { console.warn('存档序列化失败', e); return false; }
      for (;;) {
        try {
          localStorage.setItem(KEY, body);
          keepRollback(prev);
          return true;
        } catch (e) {
          // 先拿回滚点的空间重试；丢完也还写不下，才真的是数据本身超额
          if (!shrinkRing()) { console.warn('存档写入失败', e); return false; }
        }
      }
    },

    // 本机回滚点清单（新的在前）
    rollbacks() {
      return ringRead()
        .map((r, i) => ({ i: i, at: r.at, dishes: r.dishes, rests: r.rests, days: r.days }));
    },

    // 退回某个回滚点：返回那一份数据交给 App 套用（照片不动）
    rollbackTo(i) {
      const ring = ringRead();
      const r = ring[i];
      if (!r || !r.raw) throw new Error('这个回滚点已经不在了');
      const data = JSON.parse(r.raw);
      let prev = null;
      try { prev = localStorage.getItem(KEY); } catch (e) {}
      for (;;) {
        try { localStorage.setItem(KEY, r.raw); break; }
        catch (e) { if (!shrinkRing()) throw new Error('本机存不下了，先清几张照片再试'); }
      }
      keepRollback(prev);
      return { at: r.at, data: data };
    },

    clear() {
      try { localStorage.removeItem(KEY); } catch (e) {}
      return window.PhotoStore ? window.PhotoStore.replaceAll({}) : Promise.resolve();
    },

    // 备份文件 = 数据 + 全部照片，一个 .json 收着就行
    async exportFile(snapshot) {
      const photos = window.PhotoStore ? (await window.PhotoStore.ready(), window.PhotoStore.all()) : {};
      const bundle = { app: '臭翔今天吃什么', version: 1, savedAt: new Date().toISOString(), data: snapshot, photos: photos };
      const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
      const d = new Date();
      const name = '臭翔备份-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.json';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      return { name: name, bytes: blob.size, photos: Object.keys(photos).length };
    },

    // 读回一个备份文件；返回 { data, photos } 交给 App 套用
    importFile(file) {
      return new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = async () => {
          try {
            const b = JSON.parse(fr.result);
            if (!b || !b.data) throw new Error('这不像是臭翔的备份文件');
            if (window.PhotoStore) await window.PhotoStore.replaceAll(b.photos || {});
            window.AppStore.save(b.data);
            res(b);
          } catch (e) { rej(e); }
        };
        fr.onerror = () => rej(new Error('文件读不了'));
        fr.readAsText(file);
      });
    },

    async usage() {
      const raw = localStorage.getItem(KEY) || '';
      let photoBytes = 0, photoCount = 0;
      if (window.PhotoStore) {
        await window.PhotoStore.ready();
        const all = window.PhotoStore.all();
        photoCount = Object.keys(all).length;
        Object.keys(all).forEach(k => { photoBytes += all[k].length; });
      }
      const mb = n => (n / 1048576).toFixed(n < 1048576 ? 2 : 1) + ' MB';
      return { dataLabel: mb(raw.length), photoLabel: mb(photoBytes), photoCount: photoCount };
    }
  };
})();
