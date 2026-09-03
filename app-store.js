// 存档层：把 App 的数据写进浏览器 localStorage，照片走 IndexedDB（photo-slot.js）。
// 另外提供整包导出 / 导入，用来做手动备份。
(function () {
  const KEY = 'chouxiang-data-v1';
  const RING = 'chouxiang-rollback-v1';   // 本机自动回滚点（只存数据，照片在 IndexedDB 里不动）
  const RING_KEEP = 4;
  const RING_GAP = 20 * 60 * 1000;        // 两个回滚点至少隔 20 分钟

  // 每次覆盖存档前，把「覆盖之前那一份」留成回滚点。
  // 万一同步或改动把东西弄没了，可以直接退回几十分钟前的状态。
  function keepRollback(prevRaw) {
    if (!prevRaw) return;
    let ring = [];
    try { ring = JSON.parse(localStorage.getItem(RING) || '[]') || []; } catch (e) { ring = []; }
    const now = Date.now();
    if (ring.length && now - (ring[0].at || 0) < RING_GAP) return;
    let d = null;
    try { d = JSON.parse(prevRaw); } catch (e) { return; }
    if (!d) return;
    ring.unshift({
      at: now, raw: prevRaw,
      dishes: (d.dishes || []).length,
      rests: (d.restaurants || []).length,
      days: Object.keys(d.records || {}).length
    });
    while (ring.length > RING_KEEP) ring.pop();
    // 配额吃紧就先丢最老的，丢到能写下为止
    while (ring.length) {
      try { localStorage.setItem(RING, JSON.stringify(ring)); return; }
      catch (e) { ring.pop(); }
    }
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  window.AppStore = {
    load() {
      try {
        const raw = localStorage.getItem(KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    },

    save(snapshot) {
      try {
        keepRollback(localStorage.getItem(KEY));
        localStorage.setItem(KEY, JSON.stringify(snapshot));
        return true;
      } catch (e) {
        // 配额满了通常是历史照片太多——照片其实在 IndexedDB，这里只可能是数据本身过大
        console.warn('存档写入失败', e);
        return false;
      }
    },

    // 本机回滚点清单（新的在前）
    rollbacks() {
      try {
        return (JSON.parse(localStorage.getItem(RING) || '[]') || [])
          .map((r, i) => ({ i: i, at: r.at, dishes: r.dishes, rests: r.rests, days: r.days }));
      } catch (e) { return []; }
    },

    // 退回某个回滚点：返回那一份数据交给 App 套用（照片不动）
    rollbackTo(i) {
      let ring = [];
      try { ring = JSON.parse(localStorage.getItem(RING) || '[]') || []; } catch (e) { ring = []; }
      const r = ring[i];
      if (!r || !r.raw) throw new Error('这个回滚点已经不在了');
      const data = JSON.parse(r.raw);
      keepRollback(localStorage.getItem(KEY));
      localStorage.setItem(KEY, r.raw);
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
