// <photo-slot id="…" placeholder="…"> — drag/drop or click-to-browse photo slot.
// Stores a downscaled WebP data-URL in IndexedDB keyed by the slot id, so photos
// survive reload on a plain static host (no backend, no design-tool bridge).
// Exposes window.PhotoStore for backup export/import.
(function () {
  const DB = 'chouxiang-photos', STORE = 'photos', MAX = 1400;
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

  window.PhotoStore = {
    ready: () => ready,
    all: () => Object.assign({}, cache),
    get: id => cache[id] || null,
    set(id, url) {
      if (url) cache[id] = url; else delete cache[id];
      notify();
      return tx('readwrite', s => url ? s.put(url, id) : s.delete(id)).catch(() => {});
    },
    replaceAll(obj) {
      Object.keys(cache).forEach(k => delete cache[k]);
      Object.assign(cache, obj || {});
      notify();
      return tx('readwrite', s => { s.clear(); Object.keys(cache).forEach(k => s.put(cache[k], k)); }).catch(() => {});
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
  };

  async function encode(file, targetW) {
    const bmp = await createImageBitmap(file);
    try {
      const cap = Math.min(MAX, Math.max(360, (targetW || 600) * 2));
      const k = Math.min(1, cap / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return c.toDataURL('image/webp', 0.82);
    } finally { bmp.close && bmp.close(); }
  }

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
  .x{position:absolute;top:8px;right:8px;width:28px;height:28px;border:none;border-radius:999px;display:none;
     background:rgba(253,248,238,.92);color:#8c491a;font:800 13px/1 Nunito,sans-serif;cursor:pointer;z-index:2}
  :host([data-filled]:hover) .x{display:block}
  .busy{position:absolute;inset:0;display:none;place-items:center;background:rgba(253,248,238,.7);
        font:800 11px/1 Nunito,"Noto Sans SC",sans-serif;color:#8c491a}
  :host([data-busy]) .busy{display:grid}
</style>
<img alt="">
<div class="ph"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.8" cy="9.2" r="1.6"/><path d="m4 16 4.2-4 3.3 3 3-2.6L20 17"/></svg><span class="cap"></span></div>
<button class="x" type="button" aria-label="去掉这张照片">✕</button>
<div class="busy">存一下…</div>`;
      this._img = r.querySelector('img');
      this._cap = r.querySelector('.cap');
      this._cap.textContent = this.getAttribute('placeholder') || '拖张照片进来';
      this.setAttribute('role', 'button');
      this.setAttribute('tabindex', '0');
      this.setAttribute('aria-label', this._cap.textContent);

      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'image/*'; input.style.display = 'none';
      this.appendChild(input);
      input.addEventListener('change', () => { if (input.files[0]) this._ingest(input.files[0]); input.value = ''; });

      this.addEventListener('click', e => { if (e.target.closest && e.target.closest('input')) return; input.click(); });
      this.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
      r.querySelector('.x').addEventListener('click', e => {
        e.stopPropagation();
        window.PhotoStore.set(this.id, null);
      });
      ['dragenter', 'dragover'].forEach(t => this.addEventListener(t, e => {
        e.preventDefault(); this.setAttribute('data-over', '');
      }));
      ['dragleave', 'drop'].forEach(t => this.addEventListener(t, e => {
        e.preventDefault(); this.removeAttribute('data-over');
      }));
      this.addEventListener('drop', e => {
        const f = e.dataTransfer && e.dataTransfer.files[0];
        if (f && /^image\//.test(f.type)) this._ingest(f);
      });

      this._unsub = window.PhotoStore.subscribe(() => this._paint());
      ready.then(() => this._paint());
      this._paint();
    }
    disconnectedCallback() { this._unsub && this._unsub(); }
    static get observedAttributes() { return ['id', 'placeholder']; }
    attributeChangedCallback(n) {
      if (!this._built) return;
      if (n === 'placeholder') this._cap.textContent = this.getAttribute('placeholder') || '拖张照片进来';
      this._paint();
    }
    async _ingest(file) {
      if (!this.id) return;
      this.setAttribute('data-busy', '');
      try {
        const url = await encode(file, this.clientWidth);
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
