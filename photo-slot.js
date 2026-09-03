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
  const subs = new Set();
  let ready = tx('readonly', s => s.getAllKeys()).then(keys => {
    if (!keys || !keys.length) return;
    return tx('readonly', s => s.getAll()).then(vals => {
      keys.forEach((k, i) => { cache[k] = vals[i]; });
    });
  }).catch(() => {});

  const notify = () => subs.forEach(fn => fn());

  if (!window.PhotoStore) window.PhotoStore = {
    ready: () => ready,
    all: () => Object.assign({}, cache),
    get: id => cache[id] || null,
    set(id, url) {
      if (url) cache[id] = url; else delete cache[id];
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
        cache[prefix + n] = u; added.push([prefix + n, u]); n++;
      });
      notify();
      return tx('readwrite', s => { added.forEach(p => s.put(p[1], p[0])); })
        .catch(() => {})
        .then(() => { notify(); setTimeout(notify, 40); });
    },
    replaceAll(obj) {
      Object.keys(cache).forEach(k => delete cache[k]);
      Object.assign(cache, obj || {});
      notify();
      return tx('readwrite', s => { s.clear(); Object.keys(cache).forEach(k => s.put(cache[k], k)); }).catch(() => {});
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
  };

  async function encode(file) {
    const bmp = await createImageBitmap(file);
    try {
      // 只在超过 MAX 时等比缩小，不看格子多大 —— 点开要看大图的
      const k = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return c.toDataURL('image/webp', 0.88);
    } finally { bmp.close && bmp.close(); }
  }

  // ── 大图查看器 ────────────────────────────────────────
  let lb = null;
  function lightbox(urls, index) {
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
        '<span data-c style="position:absolute;bottom:max(20px,env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);' +
          'padding:7px 15px;border-radius:999px;background:rgba(253,248,238,.9);' +
          'font:800 12px/1 Nunito,"Noto Sans SC",sans-serif;color:#4b4438"></span>';
      document.body.appendChild(lb);
      const close = () => { lb.style.display = 'none'; lb._urls = null; };
      lb.addEventListener('click', e => { if (e.target === lb) close(); });
      lb.querySelector('[data-x]').addEventListener('click', close);
      const step = d => {
        if (!lb._urls) return;
        lb._i = (lb._i + d + lb._urls.length) % lb._urls.length;
        paintLb();
      };
      lb.querySelector('[data-p]').addEventListener('click', e => { e.stopPropagation(); step(-1); });
      lb.querySelector('[data-n]').addEventListener('click', e => { e.stopPropagation(); step(1); });
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
    lb._urls = urls; lb._i = i;
    lb.style.display = 'flex';
    paintLb();
  }
  function paintLb() {
    const many = lb._urls.length > 1;
    lb.querySelector('img').src = lb._urls[lb._i];
    lb.querySelector('[data-p]').style.display = many ? 'block' : 'none';
    lb.querySelector('[data-n]').style.display = many ? 'block' : 'none';
    const c = lb.querySelector('[data-c]');
    c.textContent = many ? (lb._i + 1) + ' / ' + lb._urls.length : '';
    c.style.display = many ? 'block' : 'none';
  }
  window.PhotoStore.view = lightbox;

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
    disconnectedCallback() { this._unsub && this._unsub(); }
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
      let urls = [url], idx = 0;
      if (group) {
        const sibs = Array.prototype.slice.call(document.querySelectorAll('photo-slot[data-group="' + group + '"]'))
          .map(el => window.PhotoStore.get(el.id)).filter(Boolean);
        if (sibs.length) { urls = sibs; idx = Math.max(0, sibs.indexOf(url)); }
      }
      window.PhotoStore.view(urls, idx);
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
      const url = this.id ? window.PhotoStore.get(this.id) : null;
      if (url) { this._img.src = url; this._img.style.display = 'block'; this.setAttribute('data-filled', ''); }
      else { this._img.removeAttribute('src'); this._img.style.display = 'none'; this.removeAttribute('data-filled'); }
    }
  }
  if (!customElements.get('photo-slot')) customElements.define('photo-slot', PhotoSlot);
})();
