// <photo-slot id="…" placeholder="…"> — drag/drop or click-to-browse photo slot.
// Stores a downscaled WebP data-URL in IndexedDB keyed by the slot id, so photos
// survive reload on a plain static host (no backend, no design-tool bridge).
// Exposes window.PhotoStore for backup export/import.
(function () {
  const DB = 'chouxiang-photos', STORE = 'photos', MAX = 2400;
  let dbP = null;

  function db() {
    if (dbP) return dbP;
    dbP = new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbP;
  }
  const tx = (mode, fn) => db().then(d => new Promise((res, rej) => {
    const t = d.transaction(STORE, mode), s = t.objectStore(STORE);
    const req = fn(s);
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
  }));

  const cache = {};
  let meta = {};
  const subs = new Set();
  let ready = tx('readonly', s => s.getAllKeys()).then(keys => {
    if (!keys || !keys.length) return;
    return tx('readonly', s => s.getAll()).then(vals => {
      keys.forEach((k, i) => {
        if (k === '__meta') { try { meta = JSON.parse(vals[i]) || {}; } catch (e) { meta = {}; } return; }
        cache[k] = vals[i];
      });
    });
  }).catch(() => {});
  const saveMeta = () => tx('readwrite', s => s.put(JSON.stringify(meta), '__meta')).catch(() => {});
  const stampNow = id => { meta[id] = { t: Date.now() }; };

  const notify = () => subs.forEach(fn => fn());

  // ── 缩略图 ───────────────────────────────────────────
  // 原图（可能好几 MB）只负责保存、同步、在大图查看器里看。
  // 格子和列表一律用小缩略图，而且一次只解一张原图 ——
  // 手机一口气解几十张大图会把页面内存撑爆，iOS 直接杀掉页面。
  const thumbs = {};          // 'id|px' -> { len, src }
  const thumbPending = {};    // 'id|px|len' -> true
  let thumbQ = Promise.resolve();
  const bucketOf = px => px <= 240 ? 240 : px <= 480 ? 480 : px <= 800 ? 800 : 1200;
  const dropThumbs = id => { [240, 480, 800, 1200].forEach(b => { delete thumbs[id + '|' + b]; }); };

  function makeThumb(url, px) {
    return new Promise(res => {
      const im = new Image();
      const done = v => { im.onload = im.onerror = null; im.src = ''; res(v); };
      im.onload = () => {
        try {
          const w = im.naturalWidth, h = im.naturalHeight;
          const k = Math.min(1, px / Math.max(w, h));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
          const g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
          g.drawImage(im, 0, 0, c.width, c.height);
          const out = c.toDataURL('image/jpeg', 0.82);
          c.width = c.height = 0;
          done(out);
        } catch (e) { done(''); }
      };
      im.onerror = () => done('');
      im.src = url;
    });
  }

  // 同步取：有现成的缩略图就直接返回；没有就排队生成（一次一张），
  // 生成完 notify 一下让页面重画。生成中返回空字符串。
  function thumbOf(id, px) {
    const url = cache[id];
    if (!url) return '';
    const b = bucketOf(px || 480);
    const key = id + '|' + b;
    const t = thumbs[key];
    if (t && t.len === url.length) return t.src;
    const pk = key + '|' + url.length;
    if (!thumbPending[pk]) {
      thumbPending[pk] = true;
      thumbQ = thumbQ
        .then(() => new Promise(r => setTimeout(r, 0)))   // 让出主线程，别卡住点击
        .then(async () => {
          const cur = cache[id];
          if (cur && cur.length === url.length) {
            const src = await makeThumb(cur, b);
            if (cache[id] && cache[id].length === url.length) thumbs[key] = { len: url.length, src: src || cur };
          }
        })
        .catch(() => {})
        .then(() => { delete thumbPending[pk]; notify(); });
    }
    return '';
  }

  if (!window.PhotoStore) window.PhotoStore = {
    ready: () => ready,
    all: () => Object.assign({}, cache),
    get: id => cache[id] || null,
    thumb: thumbOf,
    stampOf: id => (meta[id] && meta[id].t) || null,
    // 供同步用：这台设备现在有哪些照片
    ids: () => Object.keys(cache),
    set(id, url) {
      if (url) { cache[id] = url; stampNow(id); saveMeta(); }
      else { delete cache[id]; delete meta[id]; dropThumbs(id); saveMeta(); }
      notify();
      return tx('readwrite', s => url ? s.put(url, id) : s.delete(id))
        .catch(() => {})
        .then(() => { notify(); setTimeout(notify, 40); });
    },
    // 一次塞多张：从 prefix 之后找空号，依次占位
    setMany(prefix, urls) {
      const added = [];
      let n = 0;
      urls.forEach(u => {
        while (cache[prefix + n]) n++;
        cache[prefix + n] = u; stampNow(prefix + n); added.push([prefix + n, u]); n++;
      });
      saveMeta();
      notify();
      return tx('readwrite', s => { added.forEach(p => s.put(p[1], p[0])); })
        .catch(() => {})
        .then(() => { notify(); setTimeout(notify, 40); });
    },
    replaceAll(obj) {
      Object.keys(cache).forEach(k => delete cache[k]);
      Object.keys(thumbs).forEach(k => delete thumbs[k]);
      Object.assign(cache, obj || {});
      notify();
      return tx('readwrite', s => { s.clear(); Object.keys(cache).forEach(k => s.put(cache[k], k)); }).catch(() => {});
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
  };

  // iPhone 上所有浏览器（含 iOS 版 Chrome）底层都是 WebKit，它不能把 canvas 导出成 WebP，
  // 会悄悄改导出 PNG —— 一张 2400px 的照片就是好几 MB。所以先探一下，不支持就用 JPEG。
  let outType = null;
  function pickType() {
    if (outType) return outType;
    try {
      const t = document.createElement('canvas');
      t.width = t.height = 1;
      outType = /^data:image\/webp/.test(t.toDataURL('image/webp', 0.5)) ? 'image/webp' : 'image/jpeg';
    } catch (e) { outType = 'image/jpeg'; }
    return outType;
  }

  async function encode(file) {
    const bmp = await createImageBitmap(file);
    try {
      // 只在超过 MAX 时等比缩小，不看格子多大 —— 点开要看大图的
      const k = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      const g = c.getContext('2d');
      const type = pickType();
      if (type === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }  // JPEG 没有透明，垫白底
      g.drawImage(bmp, 0, 0, c.width, c.height);
      const out = c.toDataURL(type, type === 'image/webp' ? 0.88 : 0.86);
      c.width = c.height = 0;   // 立刻放掉画布内存
      return out;
    } finally { bmp.close && bmp.close(); }
  }

  // ── 大图查看器 ────────────────────────────────────────
  let lb = null;
  function lightbox(urls, index, ids) {
    if (!urls.length) return;
    let i = Math.max(0, Math.min(index || 0, urls.length - 1));
    if (!lb) {
      lb = document.createElement('div');
      lb.setAttribute('data-photo-lightbox', '');
      lb.style.cssText = 'position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;' +
        'background:rgba(32,28,22,.93);touch-action:none;-webkit-tap-highlight-color:transparent';
      lb.innerHTML =
        '<img alt="" style="max-width:94vw;max-height:82vh;border-radius:20px;box-shadow:0 24px 70px rgba(0,0,0,.5);object-fit:contain">' +
        '<button data-x type="button" aria-label="关掉" style="position:absolute;top:max(18px,env(safe-area-inset-top));right:18px;' +
          'width:44px;height:44px;border:none;border-radius:999px;background:rgba(253,248,238,.92);color:#8c491a;' +
          'font:800 17px/1 Nunito,sans-serif;cursor:pointer">✕</button>' +
        '<button data-p type="button" aria-label="上一张" style="position:absolute;left:12px;width:46px;height:46px;border:none;' +
          'border-radius:999px;background:rgba(253,248,238,.86);color:#8c491a;font:800 19px/1 Nunito,sans-serif;cursor:pointer">‹</button>' +
        '<button data-n type="button" aria-label="下一张" style="position:absolute;right:12px;width:46px;height:46px;border:none;' +
          'border-radius:999px;background:rgba(253,248,238,.86);color:#8c491a;font:800 19px/1 Nunito,sans-serif;cursor:pointer">›</button>' +
        '<div style="position:absolute;bottom:max(20px,env(safe-area-inset-bottom));left:0;right:0;display:flex;' +
          'align-items:center;justify-content:center;gap:9px;flex-wrap:wrap;padding:0 16px">' +
          '<span data-c style="padding:7px 15px;border-radius:999px;background:rgba(253,248,238,.9);' +
            'font:800 12px/1 Nunito,\'Noto Sans SC\',sans-serif;color:#4b4438"></span>' +
          '<button data-cover type="button" style="min-height:36px;padding:0 16px;border:none;border-radius:999px;' +
            'background:#c67139;color:#fdf8ee;font:800 12px/1 Nunito,\'Noto Sans SC\',sans-serif;cursor:pointer">设为封面</button>' +
          '</div>';
      document.body.appendChild(lb);
      // 关掉时把大图从 <img> 上拿掉，让浏览器放掉那张原图的解码内存
      const close = () => { lb.style.display = 'none'; lb._urls = null; lb.querySelector('img').removeAttribute('src'); };
      lb.addEventListener('click', e => { if (e.target === lb) close(); });
      lb.querySelector('[data-x]').addEventListener('click', close);
      const step = d => {
        if (!lb._urls) return;
        lb._i = (lb._i + d + lb._urls.length) % lb._urls.length;
        paintLb();
      };
      lb.querySelector('[data-p]').addEventListener('click', e => { e.stopPropagation(); step(-1); });
      lb.querySelector('[data-n]').addEventListener('click', e => { e.stopPropagation(); step(1); });
      lb.querySelector('[data-cover]').addEventListener('click', e => {
        e.stopPropagation();
        const id = lb._ids && lb._ids[lb._i];
        if (!id) return;
        window.dispatchEvent(new CustomEvent('photo-cover', { detail: { id: id } }));
        const b = lb.querySelector('[data-cover]');
        b.textContent = '存好了 · 封面就用它';
        setTimeout(() => { b.textContent = '设为封面'; }, 1600);
      });
      document.addEventListener('keydown', e => {
        if (lb.style.display === 'none') return;
        if (e.key === 'Escape') close();
        if (e.key === 'ArrowLeft') step(-1);
        if (e.key === 'ArrowRight') step(1);
      });
      // 手机上左右滑动翻页
      let x0 = null;
      lb.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
      lb.addEventListener('touchend', e => {
        if (x0 == null) return;
        const dx = e.changedTouches[0].clientX - x0;
        if (Math.abs(dx) > 45) step(dx < 0 ? 1 : -1);
        x0 = null;
      }, { passive: true });
    }
    lb._urls = urls; lb._ids = ids || []; lb._i = i;
    lb.style.display = 'flex';
    paintLb();
  }
  function paintLb() {
    const many = lb._urls.length > 1;
    lb.querySelector('img').src = lb._urls[lb._i];
    lb.querySelector('[data-p]').style.display = many ? 'block' : 'none';
    lb.querySelector('[data-n]').style.display = many ? 'block' : 'none';
    const c = lb.querySelector('[data-c]');
    const id = lb._ids && lb._ids[lb._i];
    const t = id ? window.PhotoStore.stampOf(id) : null;
    const when = t ? new Date(t).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
    const count = many ? (lb._i + 1) + ' / ' + lb._urls.length : '';
    c.textContent = [when, count].filter(Boolean).join(' \u00b7 ');
    c.style.display = c.textContent ? 'block' : 'none';
  }
  window.PhotoStore.view = lightbox;

  // 还没滚到眼前的格子不解图；滚到离屏幕 400px 以内再开始生成缩略图
  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver(entries => entries.forEach(e => {
        if (!e.isIntersecting) return;
        io.unobserve(e.target);
        e.target._seen = true;
        e.target._paint();
      }), { rootMargin: '400px 0px' })
    : null;

  class PhotoSlot extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      const r = this.attachShadow({ mode: 'open' });
      r.innerHTML = `
<style>
  :host{display:block;position:relative;overflow:hidden;cursor:pointer;background:#f0e4cc}
  img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none}
  .ph{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;
      padding:14px;text-align:center;font:700 11.5px/1.45 Nunito,"Noto Sans SC",system-ui,sans-serif;color:rgba(50,40,28,.42)}
  .ph svg{opacity:.4}
  :host([data-filled]) .ph{display:none}
  :host(:hover) .ph{color:rgba(50,40,28,.6)}
  :host([data-over]){outline:3px dashed #c67139;outline-offset:-6px}
  .acts{position:absolute;top:8px;right:8px;display:none;gap:6px;z-index:2}
  :host([data-filled]) .acts{display:flex}
  :host([acts="off"]) .acts{display:none!important}
  .acts button{border:none;border-radius:999px;background:rgba(253,248,238,.94);color:#8c491a;
     font:800 11px/1 Nunito,"Noto Sans SC",sans-serif;cursor:pointer;min-height:26px;padding:0 9px}
  .acts .x{width:26px;height:26px;padding:0;font-size:12px}
  .busy{position:absolute;inset:0;display:none;place-items:center;background:rgba(253,248,238,.7);
        font:800 11px/1 Nunito,"Noto Sans SC",sans-serif;color:#8c491a}
  :host([data-busy]) .busy{display:grid}
</style>
<img alt="">
<div class="ph"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.8" cy="9.2" r="1.6"/><path d="m4 16 4.2-4 3.3 3 3-2.6L20 17"/></svg><span class="cap"></span></div>
<div class="acts"><button class="sw" type="button" aria-label="换一张">换</button><button class="x" type="button" aria-label="去掉这张照片">✕</button></div>
<div class="busy">存一下…</div>`;
      this._img = r.querySelector('img');
      this._cap = r.querySelector('.cap');
      this._cap.textContent = this.getAttribute('placeholder') || '拖张照片进来';
      this.setAttribute('role', 'button');
      this.setAttribute('tabindex', '0');
      this.setAttribute('aria-label', this._cap.textContent);

      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'image/*'; input.multiple = true; input.style.display = 'none';
      this.appendChild(input);
      input.addEventListener('change', () => {
        const files = Array.prototype.slice.call(input.files || []);
        if (files.length) this._ingestMany(files);
        input.value = '';
      });
      this._input = input;

      // 已经有照片的格子：点开看大图；空格子：点开选照片
      this.addEventListener('click', e => {
        if (e.target.closest && e.target.closest('input')) return;
        if (this.hasAttribute('data-filled')) return this._view();
        input.click();
      });
      this.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
      r.querySelector('.x').addEventListener('click', e => {
        e.stopPropagation();
        window.PhotoStore.set(this.id, null);
      });
      r.querySelector('.sw').addEventListener('click', e => { e.stopPropagation(); input.click(); });
      ['dragenter', 'dragover'].forEach(t => this.addEventListener(t, e => {
        e.preventDefault(); this.setAttribute('data-over', '');
      }));
      ['dragleave', 'drop'].forEach(t => this.addEventListener(t, e => {
        e.preventDefault(); this.removeAttribute('data-over');
      }));
      this.addEventListener('drop', e => {
        const fs = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || [])
          .filter(f => /^image\//.test(f.type));
        if (fs.length) this._ingestMany(fs);
      });

      this._unsub = window.PhotoStore.subscribe(() => this._paint());
      window.PhotoStore.ready().then(() => this._paint());
      this._paint();
    }
    disconnectedCallback() { this._unsub && this._unsub(); if (io) io.unobserve(this); }
    static get observedAttributes() { return ['id', 'placeholder', 'prefix', 'acts']; }
    attributeChangedCallback(n) {
      if (!this._built) return;
      if (n === 'placeholder') this._cap.textContent = this.getAttribute('placeholder') || '拖张照片进来';
      this._paint();
    }
    // 同组照片一起看，从当前这张开始
    _view() {
      const url = window.PhotoStore.get(this.id);
      if (!url) return;
      const group = this.getAttribute('data-group');
      let urls = [url], ids = [this.id], idx = 0;
      if (group) {
        const sibs = Array.prototype.slice.call(document.querySelectorAll('photo-slot[data-group="' + group + '"]'))
          .filter(el => window.PhotoStore.get(el.id));
        if (sibs.length) {
          urls = sibs.map(el => window.PhotoStore.get(el.id));
          ids = sibs.map(el => el.id);
          idx = Math.max(0, ids.indexOf(this.id));
        }
      }
      window.PhotoStore.view(urls, idx, ids);
    }

    async _ingestMany(files) {
      if (!this.id) return;
      const prefix = this.getAttribute('prefix');
      this.setAttribute('data-busy', '');
      try {
        const urls = [];
        for (const f of files) {
          try { urls.push(await encode(f)); } catch (err) {}
        }
        if (!urls.length) { this._cap.textContent = '这些读不了，换几张试试'; return; }
        if (urls.length === 1 || !prefix) {
          await window.PhotoStore.set(this.id, urls[0]);
          if (urls.length > 1 && !prefix) {
            // 没给 prefix 时，多余的按自己的 id 加后缀存
            await window.PhotoStore.setMany(this.id + '-x', urls.slice(1));
          }
        } else {
          await window.PhotoStore.setMany(prefix, urls);
        }
      } finally { this.removeAttribute('data-busy'); }
    }

    async _ingest(file) {
      if (!this.id) return;
      this.setAttribute('data-busy', '');
      try {
        const url = await encode(file);
        await window.PhotoStore.set(this.id, url);
      } catch (err) {
        this._cap.textContent = '这张读不了，换一张试试';
      } finally { this.removeAttribute('data-busy'); }
    }
    _paint() {
      const id = this.id;
      const url = id ? window.PhotoStore.get(id) : null;
      if (!url) {
        this._shown = null;
        this._img.removeAttribute('src'); this._img.style.display = 'none'; this.removeAttribute('data-filled');
        return;
      }
      // 先标记「有照片」：占位图收起、点一下能开大图；图本身等滚到眼前再画
      this.setAttribute('data-filled', '');
      if (!this._seen && io) { io.observe(this); return; }
      // 格子里只放缩略图（按格子实际像素挑档），原图留给大图查看器
      const px = Math.max(this.clientWidth, this.clientHeight) * (window.devicePixelRatio || 1);
      const t = window.PhotoStore.thumb(id, px || 480);
      if (!t) return;   // 生成中，好了会 notify 再来一次
      const key = id + '|' + url.length + '|' + t.length;
      if (this._shown === key) return;   // 同一张图不重复设置 src
      this._img.src = t; this._img.style.display = 'block'; this._shown = key;
    }
  }
  if (!customElements.get('photo-slot')) customElements.define('photo-slot', PhotoSlot);
})();
