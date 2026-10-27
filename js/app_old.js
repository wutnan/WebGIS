(() => {
  'use strict';

  const HOME = [18.70, 100.70];
  const HOME_ZOOM = 13;
  const map = L.map('map', { zoomControl: false, doubleClickZoom: false }).setView(HOME, HOME_ZOOM);
  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' });
  const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles &copy; Esri' });
  osm.addTo(map);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);

  const layerDefinitions = [
    { id: 'boundaries', name: 'ขอบเขตพื้นที่', url: 'data/boundaries/boundaries.geojson', style: { color: '#cf7159', weight: 3, dashArray: '7 5', fillColor: '#f3a183', fillOpacity: 0.08 } },
    { id: 'buildings', name: 'อาคาร', url: 'data/buildings/buildings.geojson', style: { color: '#27556d', weight: 1.5, fillColor: '#417b9a', fillOpacity: 0.82 } },
    { id: 'parcels', name: 'แปลงที่ดิน', url: 'data/parcels/parcels.geojson', style: { color: '#56a783', weight: 2, fillColor: '#a9daba', fillOpacity: 0.35 } },
    { id: 'zones', name: 'เขตการใช้ประโยชน์', url: 'data/zones/zones.geojson', style: { color: '#bb963e', weight: 2, fillColor: '#e9c76c', fillOpacity: 0.32 } }
  ];
  const featureLayers = new Map();
  const features = [];
  let selectedFeature = null;
  let measureMode = null;
  let measurePoints = [];
  let measureLine = null;
  let measureMarkers = [];
  let messageTimer;

  const byId = (id) => document.getElementById(id);
  function showMessage(message) {
    const el = byId('map-message');
    el.textContent = message;
    el.classList.add('visible');
    window.clearTimeout(messageTimer);
    messageTimer = window.setTimeout(() => el.classList.remove('visible'), 2800);
  }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }
  function selectFeature(feature) {
    selectedFeature = feature;
    byId('export-button').disabled = false;
    const props = feature.properties || {};
    byId('selection-status').textContent = 'เลือก: ' + (props.name || props.id || 'ฟีเจอร์');
  }
  function popupContent(feature, layerName) {
    const props = feature.properties || {};
    const rows = Object.entries(props).filter(([key]) => key !== 'name').map(([key, value]) => `<div class="popup-row"><b>${escapeHtml(key)}:</b> ${escapeHtml(value)}</div>`).join('');
    return `<div class="popup-title">${escapeHtml(props.name || layerName)}</div>${rows}<button class="popup-export" type="button" data-export-feature>ส่งออก GeoJSON</button>`;
  }
  function featureName(feature) {
    const props = feature.properties || {};
    return String(props.name || props.id || 'ฟีเจอร์ไม่มีชื่อ');
  }
  function onEachFeature(feature, layer, definition) {
    feature._layerName = definition.name;
    feature._localgisCrs = definition.crs || 'EPSG:4326';
    feature._localgisCrsWarning = !!definition.crsWarning;
    features.push(feature);
    layer.bindPopup(popupContent(feature, definition.name));
    layer.on('click', () => selectFeature(feature));
    layer.on('popupopen', (event) => {
      const button = event.popup.getElement().querySelector('[data-export-feature]');
      if (button) button.addEventListener('click', () => exportFeature(feature));
    });
  }
  function renderLayerControl() {
    const control = byId('layer-control');
    const baseRow = document.createElement('label');
    baseRow.className = 'layer-row';
    const title = document.createElement('strong');
    title.textContent = 'แผนที่';
    title.style.cssText = 'width:42px;color:#81918d;font-size:10px';
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'เลือกแผนที่พื้นฐาน');
    select.style.cssText = 'flex:1;min-width:0;border:1px solid #dfe8e3;border-radius:6px;padding:6px;font:inherit;font-size:11px;color:#425b55;background:#fff';
    [['osm', 'OpenStreetMap'], ['satellite', 'Satellite']].forEach(([value, label]) => {
      const option = document.createElement('option'); option.value = value; option.textContent = label; select.appendChild(option);
    });
    select.addEventListener('change', () => {
      if (select.value === 'satellite') { map.removeLayer(osm); satellite.addTo(map); }
      else { map.removeLayer(satellite); osm.addTo(map); }
    });
    baseRow.append(title, select); control.appendChild(baseRow);
    layerDefinitions.forEach((definition) => {
      const label = document.createElement('label'); label.className = 'layer-row';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = false;
      checkbox.setAttribute('aria-label', definition.name);
      definition.checkbox = checkbox;
      checkbox.addEventListener('change', async () => {
        const layer = featureLayers.get(definition.id);
        if (!checkbox.checked) { if (layer) map.removeLayer(layer); return; }
        if (layer) layer.addTo(map); else await loadGeoJson(definition);
      });
      const text = document.createElement('span'); text.textContent = definition.name;
      label.append(checkbox, text); control.appendChild(label);
    });
  }
  async function loadGeoJson(definition) {
    try {
      const response = await fetch(definition.url);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error('รูปแบบ GeoJSON ไม่ถูกต้อง');
      const hasCrs = !!data.crs;
      definition.crs = hasCrs ? (data.crs.properties?.name || data.crs.name || 'GeoJSON CRS') : 'EPSG:4326';
      definition.crsWarning = !hasCrs;
      const layer = L.geoJSON(data, { style: definition.style, onEachFeature: (feature, featureLayer) => onEachFeature(feature, featureLayer, definition) });
      featureLayers.set(definition.id, layer);
      if (definition.checkbox?.checked) layer.addTo(map);
      window.dispatchEvent(new CustomEvent('localgis:layerschange'));
    } catch (error) {
      console.error('โหลดชั้นข้อมูล ' + definition.name + ' ไม่สำเร็จ', error);
      showMessage('โหลดชั้นข้อมูล ' + definition.name + ' ไม่สำเร็จ');
    }
  }
  function walkCoordinates(coordinates, visit) {
    if (!Array.isArray(coordinates)) return;
    if (typeof coordinates[0] === 'number') visit(coordinates);
    else coordinates.forEach((child) => walkCoordinates(child, visit));
  }
  function walkGeometry(geometry, visit) {
    if (!geometry) return;
    if (geometry.type === 'GeometryCollection') geometry.geometries.forEach((part) => walkGeometry(part, visit));
    else walkCoordinates(geometry.coordinates, visit);
  }
  function searchFeatures(query) {
    const normalized = query.trim().toLocaleLowerCase();
    const resultsEl = byId('search-results'); resultsEl.replaceChildren(); resultsEl.className = 'search-results';
    if (!normalized) { resultsEl.textContent = 'กรุณาพิมพ์คำค้นหา'; return; }
    const matches = features.filter((feature) => Object.values(feature.properties || {}).some((value) => String(value).toLocaleLowerCase().includes(normalized)));
    if (!matches.length) { resultsEl.textContent = 'ไม่พบข้อมูลที่ตรงกัน'; resultsEl.className = 'search-results hint'; return; }
    matches.slice(0, 20).forEach((feature) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'result-button';
      button.innerHTML = `${escapeHtml(featureName(feature))}<span class="result-kind">${escapeHtml(feature._layerName)}</span>`;
      button.addEventListener('click', () => focusFeature(feature)); resultsEl.appendChild(button);
    });
  }
  function focusFeature(feature) {
    let bounds = null;
    walkGeometry(feature.geometry, (coordinate) => {
      const point = L.latLng(coordinate[1], coordinate[0]); bounds = bounds ? bounds.extend(point) : L.latLngBounds(point, point);
    });
    if (!bounds) return;
    const definition = layerDefinitions.find((item) => item.name === feature._layerName);
    const layerGroup = featureLayers.get(definition?.id);
    if (layerGroup && !map.hasLayer(layerGroup)) layerGroup.addTo(map);
    map.fitBounds(bounds, { maxZoom: 17, padding: [35, 35] });
    if (layerGroup) layerGroup.eachLayer((child) => { if (child.feature === feature) child.openPopup(); });
    selectFeature(feature);
  }
  function exportFeature(feature) {
    if (!feature) return;
    const cleanFeature = JSON.parse(JSON.stringify(feature)); delete cleanFeature._layerName;
    const blob = new Blob([JSON.stringify({ type: 'FeatureCollection', features: [cleanFeature] }, null, 2)], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${String((feature.properties || {}).id || 'feature').replace(/[^\w-]+/g, '-')}.geojson`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function setMeasureMode(mode) {
    clearMeasure(); measureMode = mode;
    document.querySelectorAll('.measure-button').forEach((button) => button.classList.toggle('active', button.id === `${mode}-button`));
    byId('measure-status').textContent = mode ? 'โหมด' + (mode === 'distance' ? 'วัดระยะทาง' : 'วัดพื้นที่') + ': คลิกเพิ่มจุด ดับเบิลคลิกเพื่อจบ' : 'เลือกเครื่องมือแล้วคลิกจุดบนแผนที่ ดับเบิลคลิกเพื่อจบ';
    map.getContainer().style.cursor = mode ? 'crosshair' : '';
  }
  function haversine(a, b) {
    const rad = (value) => value * Math.PI / 180;
    const dLat = rad(b.lat - a.lat); const dLng = rad(b.lng - a.lng);
    const value = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 6371008.8 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
  }
  const formatDistance = (meters) => meters >= 1000 ? (meters / 1000).toFixed(2) + ' กม.' : meters.toFixed(1) + ' ม.';
  function polygonArea(points) {
    let area = 0;
    points.forEach((point, index) => {
      const next = points[(index + 1) % points.length];
      area += (next.lng - point.lng) * Math.PI / 180 * (2 + Math.sin(point.lat * Math.PI / 180) + Math.sin(next.lat * Math.PI / 180));
    });
    return Math.abs(area * 6378137 * 6378137 / 2);
  }
  function updateMeasurement() {
    if (measureLine) map.removeLayer(measureLine);
    measureMarkers.forEach((marker) => map.removeLayer(marker)); measureMarkers = [];
    const points = measurePoints.map((point) => L.latLng(point.lat, point.lng));
    if (points.length > 1) {
      measureLine = measureMode === 'area' && points.length > 2
        ? L.polygon(points, { color: '#e4763c', weight: 3, dashArray: '6 5', fillColor: '#e4763c', fillOpacity: 0.12 }).addTo(map)
        : L.polyline(points, { color: '#e4763c', weight: 3, dashArray: '6 5' }).addTo(map);
      measureMarkers = points.map((point) => L.circleMarker(point, { radius: 4, color: '#fff', weight: 2, fillColor: '#e4763c', fillOpacity: 1 }).addTo(map));
    }
    if (measureMode === 'distance' && points.length > 1) {
      let total = 0; for (let i = 1; i < points.length; i += 1) total += haversine(points[i - 1], points[i]);
    byId('measure-status').textContent = 'เลือกเครื่องมือแล้วคลิกจุดบนแผนที่ ดับเบิลคลิกเพื่อจบ';
    } else if (measureMode === 'area' && points.length > 2) {
      const area = polygonArea(points);
      byId('measure-status').textContent = 'พื้นที่ประมาณ ' + (area >= 1e6 ? (area / 1e6).toFixed(3) + ' ตร.กม.' : area.toFixed(1) + ' ตร.ม.') + ' · เพิ่มจุดหรือดับเบิลคลิกเพื่อจบ';
    }
  }
  function clearMeasure() {
    measurePoints = [];
    if (measureLine) { map.removeLayer(measureLine); measureLine = null; }
    measureMarkers.forEach((marker) => map.removeLayer(marker)); measureMarkers = [];
    if (measureMode) { measureMode = null; map.getContainer().style.cursor = ''; }
    document.querySelectorAll('.measure-button').forEach((button) => button.classList.remove('active'));
    byId('measure-status').textContent = 'Select a tool, click points on the map, and double-click to finish.';
  }

  map.on('mousemove', (event) => { byId('coordinates').textContent = 'ละติจูด ' + event.latlng.lat.toFixed(5) + ' · ลองจิจูด ' + event.latlng.lng.toFixed(5); });
  map.on('click', (event) => { if (measureMode) { measurePoints.push(event.latlng); updateMeasurement(); } });
  map.on('dblclick', () => { if (measureMode) { measureMode = null; map.getContainer().style.cursor = ''; document.querySelectorAll('.measure-button').forEach((button) => button.classList.remove('active')); } });
  renderLayerControl();
  byId('zoom-in').addEventListener('click', () => map.zoomIn());
  byId('zoom-out').addEventListener('click', () => map.zoomOut());
  byId('home-button').addEventListener('click', () => map.setView(HOME, HOME_ZOOM));
  byId('fullscreen-button').addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement) await document.querySelector('.map-wrap').requestFullscreen(); else await document.exitFullscreen();
      window.setTimeout(() => map.invalidateSize(), 100);
    } catch (error) { showMessage('เบราว์เซอร์ไม่อนุญาตให้เปิดเต็มหน้าจอ'); }
  });
  document.addEventListener('fullscreenchange', () => window.setTimeout(() => map.invalidateSize(), 100));
  byId('distance-button').addEventListener('click', () => setMeasureMode('distance'));
  byId('area-button').addEventListener('click', () => setMeasureMode('area'));
  byId('clear-measure').addEventListener('click', clearMeasure);
  byId('export-button').addEventListener('click', () => exportFeature(selectedFeature));
  byId('search-button').addEventListener('click', () => searchFeatures(byId('search-input').value));
  byId('search-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') searchFeatures(event.currentTarget.value); });
  const sidebar = byId('sidebar'); const scrim = byId('mobile-scrim'); const menuButton = byId('menu-toggle');
  function toggleSidebar(open) { sidebar.classList.toggle('open', open); scrim.classList.toggle('visible', open); menuButton.setAttribute('aria-expanded', String(open)); }
  menuButton.addEventListener('click', () => toggleSidebar(!sidebar.classList.contains('open')));
  scrim.addEventListener('click', () => toggleSidebar(false));
  window.addEventListener('resize', () => map.invalidateSize());

  function selectFeature(feature, importedSelection) {
    if (!importedSelection && window.LocalGISImports) window.LocalGISImports.clearSelectionHighlight();
    selectedFeature = feature || null;
    byId('export-button').disabled = !selectedFeature;
    byId('selection-status').textContent = selectedFeature
      ? 'เลือก: ' + ((selectedFeature.properties || {}).name || (selectedFeature.properties || {}).id || 'ฟีเจอร์')
      : 'ยังไม่ได้เลือกฟีเจอร์';
  }
  function focusFeature(feature) {
    if (!feature || !feature.geometry) return;
    let bounds = null;
    walkGeometry(feature.geometry, (coordinate) => {
      const point = L.latLng(coordinate[1], coordinate[0]);
      bounds = bounds ? bounds.extend(point) : L.latLngBounds(point, point);
    });
    if (!bounds) return;
    let group;
    if (feature._importedLayerId && window.LocalGISImports) group = window.LocalGISImports.getLayer(feature._importedLayerId);
    else {
      const definition = layerDefinitions.find((item) => item.name === feature._layerName);
      if (definition) group = featureLayers.get(definition.id);
    }
    if (group && !map.hasLayer(group)) group.addTo(map);
    map.fitBounds(bounds, { maxZoom: 17, padding: [35, 35] });
    if (feature._importedLayerId && window.LocalGISImports) window.LocalGISImports.focusFeature(feature);
    else {
      if (group) group.eachLayer((child) => { if (child.feature === feature && child.openPopup) child.openPopup(); });
      selectFeature(feature, false);
    }
  }
  function exportFeature(feature) {
    if (!feature) return;
    const cleanFeature = JSON.parse(JSON.stringify(feature));
    delete cleanFeature._layerName;
    delete cleanFeature._importedLayerId;
    const blob = new Blob([JSON.stringify({ type: 'FeatureCollection', features: [cleanFeature] }, null, 2)], { type: 'application/geo+json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = String((feature.properties || {}).id || 'feature').replace(/[^\w-]+/g, '-') + '.geojson';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  window.LocalGIS = {
    map, features, selectFeature, focusFeature, exportFeature,
    getSelectedFeature: () => selectedFeature,
    showMessage,
    getLayers: () => {
      const grouped = new Map();
      features.forEach((feature) => {
        const name = feature._layerName || 'ข้อมูล';
        const id = feature._importedLayerId ? 'import:' + feature._importedLayerId : 'base:' + name;
        if (!grouped.has(id)) grouped.set(id, { id, name, features: [], crs: 'EPSG:4326', crsWarning: false });
        grouped.get(id).features.push(feature);
        grouped.get(id).crs = feature._localgisCrs || grouped.get(id).crs;
        grouped.get(id).crsWarning = grouped.get(id).crsWarning || !!feature._localgisCrsWarning;
      });
      return [...grouped.values()];
    }
  };

})();
