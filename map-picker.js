// <map-picker> — Leaflet + Nominatim location picker.
// Publishes the chosen place on window as a 'place-pick' CustomEvent:
//   detail = { lat, lon, name, city }
(function () {
  const CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
  const JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
  let loading = null;

  function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (loading) return loading;
    loading = new Promise((res, rej) => {
      if (!document.querySelector('link[data-leaflet]')) {
        const l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = CSS; l.setAttribute('data-leaflet', '');
        document.head.appendChild(l);
      }
      const s = document.createElement('script');
      s.src = JS; s.onload = () => res(window.L); s.onerror = rej;
      document.head.appendChild(s);
    });
    return loading;
  }

  class MapPicker extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      this.style.display = 'block';
      this.innerHTML = `
<div style="display:flex;flex-direction:column;gap:9px">
  <div style="display:flex;gap:7px">
    <input class="mp-q" placeholder="搜地址、店名或城市" aria-label="搜索地点"
      style="flex:1;min-width:0;min-height:46px;padding:0 17px;border:none;border-radius:999px;background:#f6ecd8;font:700 13px/1 Nunito,'Noto Sans SC',sans-serif;color:#3a2617;outline:none">
    <button class="mp-go" type="button"
      style="min-height:46px;padding:0 18px;border:none;border-radius:999px;background:#c67139;color:#fdf8ee;font:800 12.5px/1 Nunito,'Noto Sans SC',sans-serif;cursor:pointer">搜索</button>
  </div>
  <div class="mp-results" style="display:none;flex-direction:column;gap:5px;max-height:132px;overflow:auto"></div>
  <div class="mp-map" style="width:100%;height:196px;border-radius:24px;overflow:hidden;background:#f3e7cf"></div>
  <div class="mp-out" style="font:700 11.5px/1.45 Nunito,'Noto Sans SC',sans-serif;color:rgba(50,40,28,.5)">在地图上点一下，或拖动图钉，就是餐厅的位置</div>
</div>`;
      const q = this.querySelector('.mp-q');
      const results = this.querySelector('.mp-results');
      const out = this.querySelector('.mp-out');
      const lat0 = parseFloat(this.getAttribute('lat'));
      const lon0 = parseFloat(this.getAttribute('lon'));
      const start = isFinite(lat0) && isFinite(lon0) ? [lat0, lon0] : [53.4808, -2.2426];

      const emit = (lat, lon, name, city) => {
        this._val = { lat: lat, lon: lon, name: name || '', city: city || '' };
        out.textContent = (city ? city + ' · ' : '') + lat.toFixed(4) + ', ' + lon.toFixed(4);
        out.style.color = '#6f7f52';
        window.dispatchEvent(new CustomEvent('place-pick', { detail: this._val }));
      };

      loadLeaflet().then(L => {
        const el = this.querySelector('.mp-map');
        const map = L.map(el, { zoomControl: true }).setView(start, isFinite(lat0) ? 14 : 11);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19, attribution: '&copy; OpenStreetMap'
        }).addTo(map);
        el.querySelectorAll('.leaflet-tile-pane').forEach(p => {
          p.style.filter = 'sepia(.42) saturate(.72) brightness(1.06) contrast(.9)';
        });
        const icon = L.divIcon({
          className: '', iconSize: [22, 22], iconAnchor: [11, 11],
          html: '<div style="width:22px;height:22px;border-radius:999px;background:#c67139;border:3px solid #fdf8ee;box-shadow:0 4px 10px rgba(120,70,20,.35)"></div>'
        });
        const pin = L.marker(start, { icon: icon, draggable: true }).addTo(map);
        pin.on('dragend', () => { const p = pin.getLatLng(); emit(p.lat, p.lng, '', ''); });
        map.on('click', e => { pin.setLatLng(e.latlng); emit(e.latlng.lat, e.latlng.lng, '', ''); });
        setTimeout(() => map.invalidateSize(), 120);
        this._map = map; this._pin = pin;
      });

      const search = () => {
        const term = q.value.trim();
        if (!term) return;
        results.style.display = 'flex';
        results.innerHTML = '<span style="font:700 11.5px/1 Nunito,sans-serif;color:rgba(50,40,28,.4);padding:6px 4px">找找看…</span>';
        fetch('https://nominatim.openstreetmap.org/search?format=json&limit=6&accept-language=zh&q=' + encodeURIComponent(term))
          .then(r => r.json())
          .then(list => {
            results.innerHTML = '';
            if (!list.length) {
              results.innerHTML = '<span style="font:700 11.5px/1 Nunito,\'Noto Sans SC\',sans-serif;color:rgba(50,40,28,.4);padding:6px 4px">没找到，换个说法试试</span>';
              return;
            }
            list.forEach(p => {
              const b = document.createElement('button');
              b.type = 'button';
              b.style.cssText = 'text-align:left;border:none;border-radius:15px;background:#f6ecd8;padding:9px 13px;font:700 11.5px/1.4 Nunito,\'Noto Sans SC\',sans-serif;color:rgba(50,40,28,.7);cursor:pointer';
              b.textContent = p.display_name;
              b.onmouseenter = () => { b.style.background = '#eee0c4'; };
              b.onmouseleave = () => { b.style.background = '#f6ecd8'; };
              b.onclick = () => {
                const lat = parseFloat(p.lat), lon = parseFloat(p.lon);
                const parts = p.display_name.split(',').map(s => s.trim());
                if (this._map) { this._map.setView([lat, lon], 15); this._pin.setLatLng([lat, lon]); }
                emit(lat, lon, parts[0], parts.slice(1, 3).join(' '));
                results.style.display = 'none';
              };
              results.appendChild(b);
            });
          })
          .catch(() => {
            results.innerHTML = '<span style="font:700 11.5px/1 Nunito,\'Noto Sans SC\',sans-serif;color:rgba(50,40,28,.4);padding:6px 4px">搜索没连上，可以直接在地图上点</span>';
          });
      };
      this.querySelector('.mp-go').onclick = search;
      q.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); search(); } };
    }
  }

  if (!customElements.get('map-picker')) customElements.define('map-picker', MapPicker);
})();
