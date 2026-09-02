// 存档层：把 App 的数据写进浏览器 localStorage，照片走 IndexedDB（photo-slot.js）。
// 另外提供整包导出 / 导入，用来做手动备份。
(function () {
  const KEY = 'chouxiang-data-v1';

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
        localStorage.setItem(KEY, JSON.stringify(snapshot));
        return true;
      } catch (e) {
        // 配额满了通常是历史照片太多——照片其实在 IndexedDB，这里只可能是数据本身过大
        console.warn('存档写入失败', e);
        return false;
      }
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
