(() => {
  'use strict';

  const input = document.getElementById('gis-file-input');
  const status = document.getElementById('gis-import-status');
  const layerList = document.getElementById('gis-imported-layers');
  const tablePanel = document.getElementById('attribute-panel');
  const tableSelect = document.getElementById('attribute-layer-select');
  const tableTitle = document.getElementById('attribute-summary');
  const tableHead = document.getElementById('attribute-head');
  const tableBody = document.getElementById('attribute-body');
  const pageStatus = document.getElementById('attribute-page');
  const previousPage = document.getElementById('attribute-prev');
  const nextPage = document.getElementById('attribute-next');
  const palette = ['#d35d45', '#277da1', '#7a5ab8', '#16866d', '#c27a1b', '#c04c8b', '#596b2f', '#4267ac'];
  const imported = new Map();
  const STORAGE_DB = 'localgis-imported-data';
  const STORAGE_STORE = 'layers';
  let storageDbPromise = null;
  let restoreStarted = false;
  const labelPositionCache = new WeakMap();
  let selected = null;
  let activeTableId = '';
  const pageByLayer = new Map();
  const pageSize = 100;
  const LABEL_MIN_DISTANCE = 48;
  const missingFilesMessage = 'กรุณาเลือกไฟล์ Shapefile ให้ครบ (.shp, .shx, .dbf และ .prj)';
  const unknownCrsMessage = 'ไม่สามารถตรวจสอบระบบพิกัดของข้อมูลได้ กรุณาตรวจสอบไฟล์ .prj';

  function setStatus(message, kind) {
    status.textContent = message || '';
    status.className = 'hint gis-import-status' + (kind ? ' ' + kind : '');
  }
  function openStorageDb() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB is unavailable'));
    if (!storageDbPromise) storageDbPromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(STORAGE_DB, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORAGE_STORE)) db.createObjectStore(STORAGE_STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open IndexedDB'));
      request.onblocked = () => reject(new Error('IndexedDB upgrade is blocked'));
    }).catch((error) => { storageDbPromise = null; throw error; });
    return storageDbPromise;
  }
  function saveImportedLayer(record) {
    return openStorageDb().then((db) => new Promise((resolve, reject) => {
      const transaction = db.transaction(STORAGE_STORE, 'readwrite');
      transaction.objectStore(STORAGE_STORE).put({
        id: record.id,
        name: record.name,
        crs: record.crs,
        savedAt: Date.now(),
        collection: { type: 'FeatureCollection', features: record.features }
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Could not save imported layer'));
      transaction.onabort = () => reject(transaction.error || new Error('Saving imported layer was aborted'));
    }));
  }
  function readSavedLayers() {
    return openStorageDb().then((db) => new Promise((resolve, reject) => {
      const transaction = db.transaction(STORAGE_STORE, 'readonly');
      const request = transaction.objectStore(STORAGE_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error('Could not read saved layers'));
    }));
  }
  function removeSavedLayer(id) {
    return openStorageDb().then((db) => new Promise((resolve, reject) => {
      const transaction = db.transaction(STORAGE_STORE, 'readwrite');
      transaction.objectStore(STORAGE_STORE).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Could not delete saved layer'));
      transaction.onabort = () => reject(transaction.error || new Error('Deleting saved layer was aborted'));
    }));
  }
  function extension(filename) {
    const index = filename.lastIndexOf('.');
    return index < 0 ? '' : filename.slice(index).toLowerCase();
  }
  function stem(filename) {
    const index = filename.lastIndexOf('.');
    return (index < 0 ? filename : filename.slice(0, index)).trim();
  }
  function groupSelectedFiles(files) {
    const groups = new Map();
    for (const file of files) {
      const ext = extension(file.name);
      if (!['.shp', '.shx', '.dbf', '.prj', '.cpg'].includes(ext)) continue;
      const name = stem(file.name);
      const key = name.toLocaleLowerCase();
      if (!groups.has(key)) groups.set(key, { name, parts: {} });
      groups.get(key).parts[ext] = () => file.arrayBuffer();
    }
    return [...groups.values()];
  }
  async function groupZip(file) {
    const archive = await JSZip.loadAsync(await file.arrayBuffer());
    const groups = new Map();
    Object.values(archive.files).forEach((entry) => {
      if (entry.dir) return;
      const ext = extension(entry.name);
      if (!['.shp', '.shx', '.dbf', '.prj', '.cpg'].includes(ext)) return;
       const normalizedPath = entry.name.replace(/\\/g, '/');
       const basename = normalizedPath.split('/').pop();
       const name = stem(basename);
       const key = normalizedPath.slice(0, normalizedPath.lastIndexOf('/') + 1).toLocaleLowerCase() + name.toLocaleLowerCase();
       if (!groups.has(key)) groups.set(key, { name, parts: {} });
      groups.get(key).parts[ext] = () => entry.async('arraybuffer');
    });
    return [...groups.values()];
  }
  function validateGroups(groups) {
    if (!groups.length) throw new Error(missingFilesMessage);
    for (const group of groups) {
      for (const ext of ['.shp', '.shx', '.dbf', '.prj']) {
        if (!group.parts[ext]) throw new Error(missingFilesMessage);
      }
    }
  }
  function identifyCrs(prjText) {
    const text = String(prjText || '').trim();
    if (!text) throw new Error(unknownCrsMessage);
    const epsgMatches = [...text.matchAll(/(?:AUTHORITY|ID)\s*\[\s*["']EPSG["']\s*,\s*["']?(\d+)/ig)];
    let epsg = epsgMatches.length ? Number(epsgMatches[epsgMatches.length - 1][1]) : null;
    const utm = text.match(/UTM[\s_]+Zone[\s_]+(\d{1,2})\s*([NS])/i);
    const wgs84 = /WGS[\s_]*1984|WGS[\s_]*84/i.test(text);
    if (!epsg && utm && wgs84) {
      const zone = Number(utm[1]);
      if (zone >= 1 && zone <= 60) epsg = (utm[2].toUpperCase() === 'N' ? 32600 : 32700) + zone;
    }
    if (epsg === 4326 || (!epsg && wgs84 && /GEOGCS|GEOGCRS/i.test(text) && !/PROJCS|PROJCRS/i.test(text))) {
      return { code: 'EPSG:4326', input: 'EPSG:4326', label: 'EPSG:4326 (WGS 84)' };
    }
    if (epsg && ((epsg >= 32601 && epsg <= 32660) || (epsg >= 32701 && epsg <= 32760))) {
      const zone = epsg % 100;
      if (!proj4.defs('EPSG:' + epsg)) {
        proj4.defs('EPSG:' + epsg, '+proj=utm +zone=' + zone + (epsg >= 32700 ? ' +south' : '') + ' +datum=WGS84 +units=m +no_defs +type=crs');
      }
      return { code: 'EPSG:' + epsg, input: 'EPSG:' + epsg, label: 'EPSG:' + epsg + ' (UTM Zone ' + zone + (epsg >= 32700 ? 'S' : 'N') + ')' };
    }
    if (epsg && proj4.defs('EPSG:' + epsg)) {
      return { code: 'EPSG:' + epsg, input: 'EPSG:' + epsg, label: 'EPSG:' + epsg };
    }
    try {
      proj4(text, 'EPSG:4326');
      return { code: null, input: text, label: 'WKT (.prj)' };
    } catch (error) {
      throw new Error(unknownCrsMessage);
    }
  }
  function transformCoordinates(coordinates, transform) {
    if (!Array.isArray(coordinates)) return coordinates;
    if (typeof coordinates[0] === 'number') {
      const xy = transform.forward([coordinates[0], coordinates[1]]);
      if (!Number.isFinite(xy[0]) || !Number.isFinite(xy[1]) || Math.abs(xy[0]) > 180 || Math.abs(xy[1]) > 90) {
        throw new Error('ไม่สามารถระบุระบบพิกัดได้');
      }
      return [xy[0], xy[1], ...coordinates.slice(2)];
    }
    return coordinates.map((part) => transformCoordinates(part, transform));
  }
  function transformCollection(collection, crs) {
    if (!collection || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
      throw new Error('ไม่สามารถอ่าน Shapefile ได้');
    }
    if (crs.code === 'EPSG:4326') return collection;
    const transform = proj4(crs.input, 'EPSG:4326');
    collection.features.forEach((feature) => {
      const geometry = feature.geometry;
      if (!geometry) return;
      if (geometry.type === 'GeometryCollection') {
        geometry.geometries.forEach((item) => {
          if (item && item.coordinates) item.coordinates = transformCoordinates(item.coordinates, transform);
        });
      } else if (geometry.coordinates) {
        geometry.coordinates = transformCoordinates(geometry.coordinates, transform);
      }
    });
    return collection;
  }
  function allCoordinates(geometry, visit) {
    if (!geometry) return;
    if (geometry.type === 'GeometryCollection') geometry.geometries.forEach((part) => allCoordinates(part, visit));
    else {
      const walk = (coordinates) => {
        if (!Array.isArray(coordinates)) return;
        if (typeof coordinates[0] === 'number') visit(coordinates);
        else coordinates.forEach(walk);
      };
      walk(geometry.coordinates);
    }
  }
  function geometrySummary(collection) {
    const types = new Set();
    collection.features.forEach((feature) => {
      if (feature.geometry) types.add(feature.geometry.type);
    });
    return types.size ? [...types].join(', ') : 'Unknown';
  }
  function propertyNames(features) {
    return [...new Set(features.flatMap((feature) => Object.keys(feature.properties || {})))];
  }
  function hasLabelValue(value) {
    if (value === null || value === undefined) return false;
    const text = String(value).trim();
    return !!text && !/^(null|undefined)$/i.test(text);
  }
  function detectHouseField(fields) {
    const normalized = (field) => field.toLocaleLowerCase().replace(/[\s_-]+/g, '');
    const aliases = ['บ้านเลขที่', 'hseno', 'houseno', 'housenumber', 'address', 'houseid'];
    return fields.find((field) => aliases.includes(normalized(field)) || /บ้าน.*เลขที่/.test(field)) || '';
  }
  function featureLabelPosition(feature) {
    if (labelPositionCache.has(feature)) return labelPositionCache.get(feature);
    const geometry = feature.geometry;
    if (!geometry) { labelPositionCache.set(feature, null); return null; }
    if (geometry.type === 'Point' && Array.isArray(geometry.coordinates)) {
      const position = L.latLng(geometry.coordinates[1], geometry.coordinates[0]);
      labelPositionCache.set(feature, position);
      return position;
    }
    if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
      if (window.turf && typeof window.turf.pointOnFeature === 'function') {
        try {
          const pointFeature = window.turf.pointOnFeature(feature);
          const coordinates = pointFeature && pointFeature.geometry && pointFeature.geometry.coordinates;
          if (Array.isArray(coordinates) && Number.isFinite(coordinates[0]) && Number.isFinite(coordinates[1])) {
            const position = L.latLng(coordinates[1], coordinates[0]);
            labelPositionCache.set(feature, position);
            return position;
          }
        } catch (error) {
          console.warn('Turf pointOnFeature failed; using interior-point fallback', error);
        }
      }
      const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
      let bestPoint = null;
      polygons.forEach((rings) => {
        const outer = rings && rings[0];
        if (!outer || outer.length < 4) return;
        const points = outer.slice(0, -1);
        const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
        let sumX = 0, sumY = 0;
        points.forEach((point) => {
          bounds.minX = Math.min(bounds.minX, point[0]); bounds.maxX = Math.max(bounds.maxX, point[0]);
          bounds.minY = Math.min(bounds.minY, point[1]); bounds.maxY = Math.max(bounds.maxY, point[1]);
          sumX += point[0]; sumY += point[1];
        });
        const { minX, maxX, minY, maxY } = bounds;
        const insideRing = (ring, x, y) => {
          let inside = false;
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const a = ring[i], b = ring[j];
            if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
          }
          return inside;
        };
        const insidePolygon = (x, y) => insideRing(outer, x, y) && !rings.slice(1).some((hole) => insideRing(hole, x, y));
        if (bestPoint) return;
        const candidates = [
          [sumX / points.length, sumY / points.length],
          [(minX + maxX) / 2, (minY + maxY) / 2]
        ];
        for (const [x, y] of candidates) {
          if (insidePolygon(x, y)) { bestPoint = [x, y]; break; }
        }
        if (!bestPoint) {
          for (let ix = 1; ix < 8 && !bestPoint; ix += 1) for (let iy = 1; iy < 8; iy += 1) {
            const x = minX + (maxX - minX) * ix / 8;
            const y = minY + (maxY - minY) * iy / 8;
            if (insidePolygon(x, y)) { bestPoint = [x, y]; break; }
          }
        }
      });
      const position = bestPoint ? L.latLng(bestPoint[1], bestPoint[0]) : null;
      labelPositionCache.set(feature, position);
      return position;
    }
    labelPositionCache.set(feature, null);
    return null;
  }
  function clearLabelGroups(groupKey) {
    const map = window.LocalGIS.map;
    imported.forEach((record) => {
      const group = record[groupKey];
      if (!group) return;
      group.clearLayers();
      if (map.hasLayer(group)) map.removeLayer(group);
    });
  }
  function renderLabels(record, field, group, status, labelType, polygonsOnly = false) {
    const map = window.LocalGIS.map;
    const candidates = [];
    let featuresWithValue = 0;
    let positionedFeatures = 0;
    record.features.forEach((feature) => {
      if (polygonsOnly && (!feature.geometry || !/^(Polygon|MultiPolygon)$/.test(feature.geometry.type))) return;
      const value = (feature.properties || {})[field];
      if (!hasLabelValue(value)) return;
      featuresWithValue += 1;
      const position = featureLabelPosition(feature);
      if (position) {
        positionedFeatures += 1;
        if (map.getBounds().contains(position)) candidates.push({ value, position });
      }
    });
    if (!featuresWithValue) {
      status.textContent = 'ฟิลด์ ' + field + ' ไม่มีค่าใน Features · จำนวนป้าย: 0';
      return;
    }
    if (!positionedFeatures) {
      status.textContent = 'ไม่พบตำแหน่ง Point/Polygon ที่สร้างป้ายได้ · จำนวนป้าย: 0';
      return;
    }
    if (!candidates.length) {
      status.textContent = 'ไม่พบ Feature ในขอบเขตแผนที่ปัจจุบัน · มีค่า ' + featuresWithValue.toLocaleString('th-TH') + ' · จำนวนป้าย: 0';
      return;
    }
    const accepted = new Map();
    const zoom = map.getZoom();
    const collisionDistance = labelType === 'parcel'
      ? (zoom >= 18 ? 0 : 18)
      : (zoom >= 19 ? 0 : LABEL_MIN_DISTANCE);
    if (!map.getPane('gisFeatureLabelPane')) {
      const pane = map.createPane('gisFeatureLabelPane');
      pane.style.zIndex = '650';
      pane.style.pointerEvents = 'none';
    }
    let created = 0;
    candidates.forEach((item) => {
      const point = map.latLngToLayerPoint(item.position);
      if (collisionDistance > 0) {
        const cellX = Math.floor(point.x / collisionDistance);
        const cellY = Math.floor(point.y / collisionDistance);
        for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
          const neighbors = accepted.get((cellX + dx) + ':' + (cellY + dy)) || [];
          if (neighbors.some((other) => point.distanceTo(other) < collisionDistance)) return;
        }
        const key = cellX + ':' + cellY;
        if (!accepted.has(key)) accepted.set(key, []);
        accepted.get(key).push(point);
      }
      const labelClass = labelType === 'zone' ? 'zone-moo-label' : (labelType === 'parcel' ? 'parcel-code-label' : 'house-number-label');
      const icon = L.divIcon({ className: labelClass, html: '<span>' + escapeHtml(String(item.value)) + '</span>', iconSize: [1, 1], iconAnchor: [0, 0] });
      L.marker(item.position, { icon, pane: 'gisFeatureLabelPane', interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(group);
      created += 1;
    });
    group.addTo(map);
    status.textContent = 'สร้างป้าย ' + created.toLocaleString('th-TH') + ' / ' + candidates.length.toLocaleString('th-TH') +
      ' รายการในขอบเขต · มีค่า ' + featuresWithValue.toLocaleString('th-TH') + ' · Zoom ' + map.getZoom();
  }
  function refreshHouseLabels() {
    clearLabelGroups('labelLayer');
    const record = imported.get(houseLayerSelect.value);
    if (!houseLabelsEnabled) { labelCountStatus.textContent = 'ปิดป้ายอยู่ · จำนวนป้าย: 0'; return; }
    if (!record) { labelCountStatus.textContent = 'ยังไม่มี Imported Layer · จำนวนป้าย: 0'; return; }
    if (!houseFieldSelect.value) { labelCountStatus.textContent = 'กรุณาเลือกฟิลด์จาก Properties · จำนวนป้าย: 0'; return; }
    if (!record.checkbox.checked) { labelCountStatus.textContent = 'Layer นี้ปิดอยู่ · จำนวนป้าย: 0'; return; }
    renderLabels(record, houseFieldSelect.value, record.labelLayer, labelCountStatus, 'house');
  }
  function refreshZoneLabels() {
    clearLabelGroups('zoneLabelLayer');
    const record = imported.get(zoneLayerSelect.value);
    if (!zoneLabelsEnabled) { zoneLabelCount.textContent = 'ปิดป้าย Zone อยู่ · จำนวนป้าย: 0'; return; }
    if (!record) { zoneLabelCount.textContent = 'ยังไม่มี Imported Layer ที่เลือก · จำนวนป้าย: 0'; return; }
    if (!zoneFieldSelect.value) { zoneLabelCount.textContent = 'ไม่พบหรือยังไม่ได้เลือกฟิลด์ moo_no · จำนวนป้าย: 0'; return; }
    if (!record.checkbox.checked) { zoneLabelCount.textContent = 'Layer นี้ปิดอยู่ · จำนวนป้าย: 0'; return; }
    renderLabels(record, zoneFieldSelect.value, record.zoneLabelLayer, zoneLabelCount, 'zone', true);
  }

  const parcelLayerSelect = document.createElement('select');
  const parcelFieldSelect = document.createElement('select');
  const parcelLabelToggle = document.createElement('button');
  const parcelLabelCount = document.createElement('p');
  const parcelFieldExamples = document.createElement('p');
  let parcelLabelsEnabled = false;
  let userSelectedParcelLayer = false;
  let parcelDefaultApplied = false;
  function detectParcelField(features) {
    return propertyNames(features).includes('P_parcel_c') ? 'P_parcel_c' : '';
  }
  function refreshParcelLabels() {
    clearLabelGroups('parcelLabelLayer');
    const record = imported.get(parcelLayerSelect.value);
    if (!parcelLabelsEnabled) { parcelLabelCount.textContent = 'ปิด Label Parcel · จำนวนป้าย: 0'; return; }
    if (!record) { parcelLabelCount.textContent = 'ยังไม่มี Imported Parcel Layer · จำนวนป้าย: 0'; return; }
    if (!record.checkbox.checked) { parcelLabelCount.textContent = 'Layer นี้ปิดอยู่ · จำนวนป้าย: 0'; return; }
    const field = parcelFieldSelect.value;
    if (!field) { parcelLabelCount.textContent = 'ไม่พบฟิลด์รหัสแปลง · จำนวนป้าย: 0'; return; }
    if (window.LocalGIS.map.getZoom() < 17) {
      const count = record.features.filter((feature) => feature.geometry && /^(Polygon|MultiPolygon)$/.test(feature.geometry.type) && hasLabelValue((feature.properties || {})[field])).length;
      parcelLabelCount.textContent = 'ซูมเข้าอย่างน้อยระดับ 17 เพื่อแสดง Label · Feature ที่มีค่า ' + count.toLocaleString('th-TH') + ' · Label บนแผนที่ 0';
      return;
    }
    renderLabels(record, field, record.parcelLabelLayer, parcelLabelCount, 'parcel', true);
  }
  function refreshParcelLabelControls() {
    const previousLayer = parcelLayerSelect.value;
    parcelLayerSelect.replaceChildren();
    imported.forEach((record) => {
      if (!/^parcel[-_ ]?edit$/i.test(record.name.trim()) || !detectParcelField(record.features)) return;
      const option = document.createElement('option');
      option.value = record.id;
      option.textContent = 'Imported: ' + record.name;
      parcelLayerSelect.appendChild(option);
    });
    const parcelRecord = [...imported.values()].find((record) => /^parcel[-_ ]?edit$/i.test(record.name.trim()) && detectParcelField(record.features));
    if (!userSelectedParcelLayer && parcelRecord) parcelLayerSelect.value = parcelRecord.id;
    else if ([...parcelLayerSelect.options].some((option) => option.value === previousLayer)) parcelLayerSelect.value = previousLayer;
    else if (parcelLayerSelect.options.length) parcelLayerSelect.selectedIndex = 0;
    const record = imported.get(parcelLayerSelect.value);
    const field = record ? detectParcelField(record.features) : '';
    parcelFieldSelect.replaceChildren();
    const fields = record ? propertyNames(record.features) : [];
    if (field) { const option = document.createElement('option'); option.value = field; option.textContent = field; parcelFieldSelect.appendChild(option); }
    if (field) parcelFieldSelect.value = field;
    const parcelFeatures = record && field ? record.features.filter((feature) => feature.geometry && /^(Polygon|MultiPolygon)$/.test(feature.geometry.type) && hasLabelValue((feature.properties || {})[field])) : [];
    const count = parcelFeatures.length;
    const samples = [...new Set(parcelFeatures.slice(0, 20).map((feature) => String(feature.properties[field]).trim()))].slice(0, 3);
    parcelFieldExamples.textContent = record
      ? 'Layer ' + record.name + ' · Key จริง: ' + (field || 'ไม่พบฟิลด์รหัสแปลง') + ' · Polygon ที่มีค่า: ' + count.toLocaleString('th-TH') + ' · ตัวอย่าง: ' + (samples.join(', ') || 'ไม่มี') + ' · Properties: ' + fields.join(', ')
      : 'ตรวจไม่พบ Imported Layer ที่มี Key รหัสแปลงจาก Properties';
    const parcelEdit = record && /^parcel[-_ ]?edit$/i.test(record.name.trim());
    if (parcelEdit && field && !parcelDefaultApplied && !userSelectedParcelLayer) { parcelLabelsEnabled = true; parcelDefaultApplied = true; }
    parcelLabelToggle.disabled = !record;
    if (!record) parcelLabelsEnabled = false;
    parcelLabelToggle.textContent = parcelLabelsEnabled ? 'ปิด Label Parcel' : 'เปิด Label Parcel';
    parcelLabelToggle.setAttribute('aria-pressed', String(parcelLabelsEnabled));
    refreshParcelLabels();
  }
  function buildParcelLabelControls() {
    const panel = document.createElement('div');
    panel.className = 'parcel-label-panel';
    const title = document.createElement('strong'); title.textContent = 'Label แปลงที่ดิน';
    const layerLabel = document.createElement('label'); layerLabel.textContent = 'Imported Parcel Layer';
    parcelLayerSelect.setAttribute('aria-label', 'เลือก Layer Parcel-Edit สำหรับ Label P_parcel_c');
    layerLabel.appendChild(parcelLayerSelect);
    const fieldLabel = document.createElement('label'); fieldLabel.textContent = 'ฟิลด์รหัสแปลง (Properties)';
    parcelFieldSelect.setAttribute('aria-label', 'Attribute Field P_parcel_c');
    fieldLabel.appendChild(parcelFieldSelect);
    parcelLabelToggle.type = 'button';
    parcelLabelToggle.className = 'parcel-label-button';
    parcelLabelCount.className = 'hint parcel-label-count';
    parcelFieldExamples.className = 'hint parcel-field-examples';
    panel.append(title, layerLabel, fieldLabel, parcelLabelToggle, parcelLabelCount, parcelFieldExamples);
    document.getElementById('layer-control').appendChild(panel);
    parcelLayerSelect.addEventListener('change', () => {
      userSelectedParcelLayer = true;
      parcelLabelsEnabled = false;
      refreshParcelLabelControls();
    });
    parcelLabelToggle.addEventListener('click', () => {
      if (parcelLabelToggle.disabled) return;
      parcelLabelsEnabled = !parcelLabelsEnabled;
      parcelLabelToggle.textContent = parcelLabelsEnabled ? 'ปิด Label Parcel' : 'เปิด Label Parcel';
      parcelLabelToggle.setAttribute('aria-pressed', String(parcelLabelsEnabled));
      refreshParcelLabels();
    });
    parcelFieldSelect.addEventListener('change', refreshParcelLabels);
    refreshParcelLabelControls();
  }

  const houseLayerSelect = document.createElement('select');
  const houseFieldSelect = document.createElement('select');
  const houseLabelToggle = document.createElement('button');
  const labelCountStatus = document.createElement('p');
  let houseLabelsEnabled = false;
  let userSelectedHouseLayer = false;
  let houseDefaultApplied = false;
  const houseFieldExamples = document.createElement('p');
  const zoneLayerSelect = document.createElement('select');
  const zoneFieldSelect = document.createElement('select');
  const zoneLabelToggle = document.createElement('button');
  const zoneLabelCount = document.createElement('p');
  const zoneFieldExamples = document.createElement('p');
  let zoneLabelsEnabled = false;
  let userSelectedZoneLayer = false;
  let zoneDefaultApplied = false;
  function refreshHouseLabelControls() {
    const previousLayer = houseLayerSelect.value;
    houseLayerSelect.replaceChildren();
    imported.forEach((record) => {
      const option = document.createElement('option');
      option.value = record.id;
      option.textContent = 'Imported: ' + record.name;
      houseLayerSelect.appendChild(option);
    });
    const buildingEdit = [...imported.values()].find((item) => item.name.trim().replace(/\s*\(\d+\)$/, '').toLocaleLowerCase() === 'building-edit');
    if (!userSelectedHouseLayer && buildingEdit) houseLayerSelect.value = buildingEdit.id;
    else if (imported.has(previousLayer)) houseLayerSelect.value = previousLayer;
    else if (imported.size) houseLayerSelect.value = imported.keys().next().value;
    const record = imported.get(houseLayerSelect.value);
    const previousField = houseFieldSelect.value;
    houseFieldSelect.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = ''; placeholder.textContent = 'เลือกฟิลด์จาก Properties';
    houseFieldSelect.appendChild(placeholder);
    if (record) propertyNames(record.features).forEach((field) => {
      const samples = record.features.map((feature) => (feature.properties || {})[field])
        .filter(hasLabelValue).slice(0, 2);
      const option = document.createElement('option');
      option.value = field;
      option.textContent = field + (samples.length ? ' — ' + samples.map(displayValue).join(', ') : '');
      houseFieldSelect.appendChild(option);
    });
    const fields = record ? propertyNames(record.features) : [];
    const hseNoField = fields.find((field) => field.toLocaleLowerCase().replace(/[\s_-]+/g, '') === 'hseno');
    if (record && buildingEdit && record.id === buildingEdit.id && hseNoField) {
      houseFieldSelect.value = hseNoField;
      if (!houseDefaultApplied && !userSelectedHouseLayer) {
        houseLabelsEnabled = true;
        houseDefaultApplied = true;
      }
    } else if (record && previousLayer === record.id && fields.includes(previousField)) houseFieldSelect.value = previousField;
    else if (record) houseFieldSelect.value = detectHouseField(fields);
    const detectedField = record ? detectHouseField(propertyNames(record.features)) : '';
    houseFieldExamples.textContent = record
      ? (detectedField ? 'ตรวจพบฟิลด์ที่อาจเป็นบ้านเลขที่: ' + detectedField + ' · ' : 'ไม่พบชื่อฟิลด์บ้านเลขที่ที่รู้จัก · ') +
        'ฟิลด์ที่พบ: ' + (propertyNames(record.features).join(', ') || 'ไม่มี')
      : 'นำเข้า Layer เพื่อดูฟิลด์ Properties';
    houseLabelToggle.disabled = !record || !houseFieldSelect.value;
    if (houseLabelToggle.disabled) houseLabelsEnabled = false;
    houseLabelToggle.textContent = houseLabelsEnabled ? 'ปิดป้ายบ้านเลขที่' : 'เปิดป้ายบ้านเลขที่';
    houseLabelToggle.setAttribute('aria-pressed', String(houseLabelsEnabled));
    refreshHouseLabels();
  }
  function buildHouseLabelControls() {
    const panel = document.createElement('div');
    panel.className = 'house-label-panel';
    const title = document.createElement('strong'); title.textContent = 'ป้ายบ้านเลขที่';
    const layerLabel = document.createElement('label'); layerLabel.textContent = 'Imported Layer';
    houseLayerSelect.setAttribute('aria-label', 'เลือก Imported Layer สำหรับป้ายบ้านเลขที่');
    layerLabel.appendChild(houseLayerSelect);
    const fieldLabel = document.createElement('label'); fieldLabel.textContent = 'ฟิลด์ Properties';
    houseFieldSelect.setAttribute('aria-label', 'เลือกฟิลด์ Properties สำหรับป้ายบ้านเลขที่');
    fieldLabel.appendChild(houseFieldSelect);
    houseLabelToggle.type = 'button';
    houseLabelToggle.className = 'house-label-button';
    houseLabelToggle.setAttribute('aria-label', 'เปิดป้ายบ้านเลขที่');
    houseFieldExamples.className = 'hint house-field-examples';
    labelCountStatus.className = 'hint house-label-count';
    panel.append(title, layerLabel, fieldLabel, houseLabelToggle, labelCountStatus, houseFieldExamples);
    document.getElementById('layer-control').appendChild(panel);
    houseLayerSelect.addEventListener('change', () => {
      userSelectedHouseLayer = true;
      houseLabelsEnabled = false;
      houseFieldSelect.value = '';
      refreshHouseLabelControls();
    });
    houseFieldSelect.addEventListener('change', () => {
      houseLabelToggle.disabled = !houseFieldSelect.value;
      if (!houseFieldSelect.value) houseLabelsEnabled = false;
      houseLabelToggle.textContent = houseLabelsEnabled ? 'ปิดป้ายบ้านเลขที่' : 'เปิดป้ายบ้านเลขที่';
      houseLabelToggle.setAttribute('aria-pressed', String(houseLabelsEnabled));
      refreshHouseLabels();
    });
    houseLabelToggle.addEventListener('click', () => {
      if (houseLabelToggle.disabled) return;
      houseLabelsEnabled = !houseLabelsEnabled;
      houseLabelToggle.textContent = houseLabelsEnabled ? 'ปิดป้ายบ้านเลขที่' : 'เปิดป้ายบ้านเลขที่';
      houseLabelToggle.setAttribute('aria-pressed', String(houseLabelsEnabled));
      houseLabelToggle.setAttribute('aria-label', houseLabelToggle.textContent);
      refreshHouseLabels();
    });
    refreshHouseLabelControls();
  }
  function refreshZoneLabelControls() {
    const previousLayer = zoneLayerSelect.value;
    zoneLayerSelect.replaceChildren();
    imported.forEach((record) => {
      const option = document.createElement('option');
      option.value = record.id;
      option.textContent = 'Imported: ' + record.name;
      zoneLayerSelect.appendChild(option);
    });
    const zoneRecord = [...imported.values()].find((record) => /zone/i.test(record.name));
    if (!userSelectedZoneLayer && zoneRecord) zoneLayerSelect.value = zoneRecord.id;
    else if (imported.has(previousLayer)) zoneLayerSelect.value = previousLayer;
    else if (imported.size) zoneLayerSelect.value = imported.keys().next().value;
    const record = imported.get(zoneLayerSelect.value);
    const fields = record ? propertyNames(record.features) : [];
    const mooNoField = fields.find((field) => field.toLocaleLowerCase().replace(/[\s_-]+/g, '') === 'moono');
    zoneFieldSelect.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = ''; placeholder.textContent = 'เลือกฟิลด์ moo_no';
    zoneFieldSelect.appendChild(placeholder);
    if (record && mooNoField) {
      const samples = record.features.map((feature) => (feature.properties || {})[mooNoField]).filter(hasLabelValue).slice(0, 2);
      const option = document.createElement('option');
      option.value = mooNoField;
      option.textContent = mooNoField + (samples.length ? ' — ' + samples.map(displayValue).join(', ') : '');
      zoneFieldSelect.appendChild(option);
      zoneFieldSelect.value = mooNoField;
    }
    if (record && zoneRecord && record.id === zoneRecord.id && mooNoField && !zoneDefaultApplied && !userSelectedZoneLayer) {
      zoneLabelsEnabled = true;
      zoneDefaultApplied = true;
    }
    zoneFieldExamples.textContent = record
      ? (zoneRecord ? 'พบ Layer ' + zoneRecord.name + ' · ' : 'ไม่พบ Layer ที่มีชื่อ Zone · ') +
        (mooNoField ? 'พบฟิลด์ moo_no · ' : 'ไม่พบฟิลด์ moo_no · ') + 'กำลังดู ' + record.name + ' · ฟิลด์ที่พบ: ' + (fields.join(', ') || 'ไม่มี')
      : 'ยังไม่มี Imported Layer · Layer ใน data/zones/zones.geojson คือ sample_zones และไม่มีฟิลด์ moo_no';
    zoneLabelToggle.disabled = !record || !mooNoField || !zoneFieldSelect.value;
    if (zoneLabelToggle.disabled) zoneLabelsEnabled = false;
    zoneLabelToggle.textContent = zoneLabelsEnabled ? 'ปิด Label Zone' : 'เปิด Label Zone';
    zoneLabelToggle.setAttribute('aria-pressed', String(zoneLabelsEnabled));
    refreshZoneLabels();
  }
  function buildZoneLabelControls() {
    const panel = document.createElement('div');
    panel.className = 'zone-label-panel';
    const title = document.createElement('strong'); title.textContent = 'Label หมู่บ้าน (Zone)';
    const layerLabel = document.createElement('label'); layerLabel.textContent = 'Imported Layer';
    zoneLayerSelect.setAttribute('aria-label', 'เลือก Imported Zone Layer');
    layerLabel.appendChild(zoneLayerSelect);
    const fieldLabel = document.createElement('label'); fieldLabel.textContent = 'ฟิลด์ Label';
    zoneFieldSelect.setAttribute('aria-label', 'เลือกฟิลด์ moo_no สำหรับ Zone Label');
    fieldLabel.appendChild(zoneFieldSelect);
    zoneLabelToggle.type = 'button';
    zoneLabelToggle.className = 'zone-label-button';
    zoneLabelToggle.setAttribute('aria-label', 'เปิด Label Zone');
    zoneLabelCount.className = 'hint zone-label-count';
    zoneFieldExamples.className = 'hint zone-field-examples';
    panel.append(title, layerLabel, fieldLabel, zoneLabelToggle, zoneLabelCount, zoneFieldExamples);
    document.getElementById('layer-control').appendChild(panel);
    zoneLayerSelect.addEventListener('change', () => {
      userSelectedZoneLayer = true;
      zoneLabelsEnabled = false;
      zoneFieldSelect.value = '';
      refreshZoneLabelControls();
    });
    zoneFieldSelect.addEventListener('change', () => {
      zoneLabelToggle.disabled = !zoneFieldSelect.value;
      if (!zoneFieldSelect.value) zoneLabelsEnabled = false;
      zoneLabelToggle.textContent = zoneLabelsEnabled ? 'ปิด Label Zone' : 'เปิด Label Zone';
      zoneLabelToggle.setAttribute('aria-pressed', String(zoneLabelsEnabled));
      refreshZoneLabels();
    });
    zoneLabelToggle.addEventListener('click', () => {
      if (zoneLabelToggle.disabled) return;
      zoneLabelsEnabled = !zoneLabelsEnabled;
      zoneLabelToggle.textContent = zoneLabelsEnabled ? 'ปิด Label Zone' : 'เปิด Label Zone';
      zoneLabelToggle.setAttribute('aria-pressed', String(zoneLabelsEnabled));
      zoneLabelToggle.setAttribute('aria-label', zoneLabelToggle.textContent);
      refreshZoneLabels();
    });
    refreshZoneLabelControls();
  }
  async function parseGroup(group) {
    const prjText = new TextDecoder('utf-8').decode(await group.parts['.prj']());
    const crs = identifyCrs(prjText);
    const shpBuffer = await group.parts['.shp']();
    const dbfBuffer = await group.parts['.dbf']();
    const shxBuffer = await group.parts['.shx']();
    const inputData = { shp: shpBuffer, dbf: dbfBuffer, shx: shxBuffer };
    if (group.parts['.cpg']) inputData.cpg = await group.parts['.cpg']();
    let collection = await shp(inputData);
    if (Array.isArray(collection)) collection = collection[0];
    collection = transformCollection(collection, crs);
    if (!collection.features.length) throw new Error('ไม่สามารถอ่าน Shapefile ได้');
    return { collection, crs };
  }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }
  function displayValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number' && Number.isFinite(value)) {
      return new Intl.NumberFormat('th-TH', { maximumFractionDigits: 6 }).format(value);
    }
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }
  function propertyValueHtml(key, value, properties) {
    if (String(key).toLowerCase() === 'photo' && value) {
      const filename = displayValue(value).replace(/\\/g, '/').split('/').pop();
      const href = 'DCIM/' + encodeURIComponent(filename);
      const printButton = window.PhotoLabel?.buttonHtml(filename, properties) || '';
      return '<a href="' + href + '" target="_blank" rel="noopener">' + escapeHtml(filename) + '</a>' + printButton;
    }
    return escapeHtml(displayValue(value));
  }
  function propertyRows(feature) {
    const properties = feature.properties || {};
    return Object.entries(properties)
      .filter(([key]) => !/^(geometry|the_geom|shape|bbox|_layerName|_importedLayerId)$/i.test(key) && !key.startsWith('__'))
      .map(([key, value]) => '<div class="popup-row"><b>' + escapeHtml(key) + ':</b> ' + propertyValueHtml(key, value, properties) + '</div>')
      .join('');
  }
  function pointIcon(color, active) {
    const iconColor = active ? '#f05a28' : color;
    return L.divIcon({
      className: 'imported-point-icon',
      html: '<span style="--marker-color:' + iconColor + '"></span>',
      iconSize: [18, 18],
      iconAnchor: [9, 9]
    });
  }
  function applyFeatureStyle(layer, color) {
    if (layer.setStyle) {
      layer.setStyle({ color, fillColor: color, weight: 2, fillOpacity: 0.28 });
    } else if (layer.setIcon && layer.feature) {
      layer.setIcon(pointIcon(color, selected && selected.layer === layer));
    }
  }
  function clearSelectionHighlight() {
    if (!selected) return;
    applyFeatureStyle(selected.layer, selected.record.color);
    selected = null;
  }
  function highlightLayer(layer, record, active) {
    if (layer.setStyle) {
      if (active) layer.setStyle({ color: '#f05a28', fillColor: '#ffb15c', weight: 4, fillOpacity: 0.48 });
      else applyFeatureStyle(layer, record.color);
    } else if (layer.setIcon) {
      layer.setIcon(pointIcon(record.color, active));
    }
  }
  function cleanFeature(feature) {
    const clone = JSON.parse(JSON.stringify(feature));
    delete clone._layerName;
    delete clone._importedLayerId;
    return clone;
  }
  function popupHtml(feature) {
    const title = feature.properties && (feature.properties.name || feature.properties.id);
    return '<div class="popup-title">' + escapeHtml(title || 'ข้อมูลฟีเจอร์') + '</div>' + propertyRows(feature) +
      '<button class="popup-export" type="button" data-imported-export>ส่งออก GeoJSON</button>';
  }
  function selectImportedFeature(feature, layer, record) {
    clearSelectionHighlight();
    selected = { feature, layer, record };
    highlightLayer(layer, record, true);
    window.LocalGIS.selectFeature(feature, true);
  }
  function focusImportedFeature(feature) {
    const record = imported.get(feature._importedLayerId);
    if (!record) return;
    record.layer.eachLayer((layer) => {
      if (layer.feature === feature) {
        selectImportedFeature(feature, layer, record);
        const checkbox = record.controlRow && record.controlRow.querySelector('input[type="checkbox"]');
        if (checkbox && !checkbox.checked) {
          checkbox.checked = true;
          record.layer.addTo(window.LocalGIS.map);
          refreshHouseLabels();
          refreshZoneLabels();
          refreshParcelLabels();
        }
        if (layer.openPopup) layer.openPopup();
      }
    });
  }
  function bindImportedFeature(feature, layer, record) {
    feature._layerName = 'Imported: ' + record.name;
    feature._importedLayerId = record.id;
    feature._localgisCrs = 'EPSG:4326';
    feature._localgisCrsWarning = false;
    layer.bindPopup(popupHtml(feature));
    layer.on('mouseover', () => {
      if (!selected || selected.layer !== layer) highlightLayer(layer, record, true);
    });
    layer.on('mouseout', () => {
      if (!selected || selected.layer !== layer) highlightLayer(layer, record, false);
    });
    layer.on('click', () => selectImportedFeature(feature, layer, record));
    layer.on('popupopen', (event) => {
      const button = event.popup.getElement().querySelector('[data-imported-export]');
      if (button) button.addEventListener('click', () => exportFeatures([feature], record.name));
    });
  }
  function addControlRow(record) {
    const label = document.createElement('label');
    label.className = 'layer-row imported-layer-row';
    label.dataset.importedLayerId = record.id;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.setAttribute('aria-label', 'แสดง ' + record.name);
    record.checkbox = checkbox;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) record.layer.addTo(window.LocalGIS.map);
      else window.LocalGIS.map.removeLayer(record.layer);
      refreshHouseLabels();
      refreshZoneLabels();
      refreshParcelLabels();
    });
    const text = document.createElement('span');
    text.textContent = 'Imported: ' + record.name;
    label.append(checkbox, text);
    document.getElementById('layer-control').appendChild(label);
    record.controlRow = label;
  }
  function addLayerCard(record) {
    const card = document.createElement('article');
    card.className = 'imported-layer-card';
    card.dataset.importedLayerId = record.id;
    const heading = document.createElement('div');
    heading.className = 'imported-layer-heading';
    const title = document.createElement('strong');
    title.textContent = record.name;
    const color = document.createElement('input');
    color.type = 'color';
    color.value = record.color;
    color.title = 'เปลี่ยนสี Layer';
    color.setAttribute('aria-label', 'เปลี่ยนสี ' + record.name);
    color.addEventListener('input', () => {
      record.color = color.value;
      record.layer.eachLayer((layer) => applyFeatureStyle(layer, record.color));
      if (selected && selected.record === record) highlightLayer(selected.layer, record, true);
    });
    heading.append(title, color);
    const summary = document.createElement('p');
    summary.className = 'hint imported-summary';
    summary.textContent = 'Geometry: ' + record.geometry + ' · Features: ' +
      new Intl.NumberFormat('th-TH').format(record.features.length) + ' · CRS: ' + record.crs;
    const actions = document.createElement('div');
    actions.className = 'imported-layer-actions';
    const zoomLabel = document.createElement('label');
    zoomLabel.className = 'hint';
    const zoomCheckbox = document.createElement('input');
    zoomCheckbox.type = 'checkbox';
    zoomCheckbox.checked = true;
    zoomCheckbox.setAttribute('aria-label', 'Zoom to Layer ' + record.name);
    zoomLabel.append(zoomCheckbox, document.createTextNode(' Zoom to Layer'));
    record.zoomCheckbox = zoomCheckbox;
    const zoomButton = document.createElement('button');
    zoomButton.type = 'button'; zoomButton.className = 'text-button'; zoomButton.textContent = 'Zoom to Layer';
    zoomButton.addEventListener('click', () => {
      if (!record.layer.getBounds().isValid()) return setStatus('Layer นี้ไม่มีขอบเขตสำหรับซูม', 'error');
      record.checkbox.checked = true;
      record.layer.addTo(window.LocalGIS.map);
      refreshHouseLabels();
      refreshZoneLabels();
      window.LocalGIS.zoomToLayerBounds(record.layer, { maxZoom: 19 });
    });
    const tableButton = document.createElement('button');
    tableButton.type = 'button'; tableButton.className = 'text-button'; tableButton.textContent = 'ตารางข้อมูล';
    tableButton.addEventListener('click', () => showTable(record.id));
    const exportButton = document.createElement('button');
    exportButton.type = 'button'; exportButton.className = 'text-button'; exportButton.textContent = 'Export Layer';
    exportButton.addEventListener('click', () => exportFeatures(record.features, record.name));
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button'; deleteButton.className = 'text-button danger-button'; deleteButton.textContent = 'ลบ Layer';
    deleteButton.addEventListener('click', () => deleteLayer(record.id));
    actions.append(zoomLabel, zoomButton, tableButton, exportButton, deleteButton);
    card.append(heading, summary, actions);
    layerList.appendChild(card);
    record.card = card;
  }
  function registerLayer(name, collection, crs, { persist = true, preferredId = '' } = {}) {
    let id = preferredId || name.toLocaleLowerCase().replace(/[^\p{L}\p{N}-]+/gu, '-');
    const baseId = id || 'layer';
    let suffix = 2;
    while (imported.has(id)) id = baseId + '-' + suffix++;
    const record = {
      id, name, collection, features: collection.features,
      geometry: geometrySummary(collection), crs: crs.label || 'EPSG:4326',
      color: palette[imported.size % palette.length], layer: null,
      labelLayer: L.layerGroup(),
      zoneLabelLayer: L.layerGroup(),
      parcelLabelLayer: L.layerGroup()
    };
    const layer = L.geoJSON(collection, {
      style: () => ({ color: record.color, fillColor: record.color, weight: 2, fillOpacity: 0.28 }),
      pointToLayer: (_feature, latlng) => L.marker(latlng, { icon: pointIcon(record.color, false) }),
      onEachFeature: (feature, featureLayer) => bindImportedFeature(feature, featureLayer, record)
    });
    record.layer = layer;
    layer.localGISLayerName = 'Imported: ' + name;
    layer.localGISSource = name;
    imported.set(id, record);
    record.features.forEach((feature) => {
      feature._layerName = 'Imported: ' + name;
      feature._importedLayerId = id;
      feature._localgisCrs = 'EPSG:4326';
      feature._localgisCrsWarning = false;
      window.LocalGIS.features.push(feature);
    });
    layer.addTo(window.LocalGIS.map);
    window.dispatchEvent(new CustomEvent('localgis:layerschange'));
    addControlRow(record);
    addLayerCard(record);
    refreshHouseLabelControls();
    refreshZoneLabelControls();
    refreshParcelLabelControls();
    refreshTableSelector();
    if (record.zoomCheckbox.checked) {
      window.dispatchEvent(new CustomEvent('localgis:importedlayer', { detail: { layer } }));
      window.setTimeout(() => window.LocalGIS.map.invalidateSize(), 100);
    }
    setStatus('นำเข้า ' + name + ' สำเร็จ: ' + record.features.length + ' ฟีเจอร์', 'success');
    showTable(id);
    if (persist) saveImportedLayer(record).then(() => {
      if (imported.has(id)) setStatus('นำเข้า ' + name + ' สำเร็จ และบันทึกไว้ในเบราว์เซอร์แล้ว', 'success');
    }).catch((error) => {
      console.error('Could not persist imported GIS layer', error);
      setStatus('นำเข้าแล้ว แต่บันทึกไว้ใช้ครั้งถัดไปไม่ได้ โปรดตรวจสอบพื้นที่จัดเก็บของเบราว์เซอร์', 'error');
    });
    return record;
  }
  function refreshTableSelector() {
    const previous = tableSelect.value;
    tableSelect.replaceChildren();
    imported.forEach((record) => {
      const option = document.createElement('option');
      option.value = record.id; option.textContent = record.name;
      tableSelect.appendChild(option);
    });
    if (imported.has(previous)) tableSelect.value = previous;
    else if (imported.size) tableSelect.value = imported.keys().next().value;
    tablePanel.hidden = imported.size === 0;
    if (imported.size) renderTable();
  }
  function showTable(id) {
    if (!imported.has(id)) return;
    activeTableId = id;
    tableSelect.value = id;
    pageByLayer.set(id, 0);
    tablePanel.hidden = false;
    renderTable();
    tablePanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function renderTable() {
    const record = imported.get(tableSelect.value || activeTableId);
    if (!record) return;
    activeTableId = record.id;
    const columns = [...new Set(record.features.flatMap((feature) => Object.keys(feature.properties || {})))]
      .filter((key) => !/^(geometry|the_geom|shape|bbox|_layerName|_importedLayerId)$/i.test(key) && !key.startsWith('__'));
    const page = pageByLayer.get(record.id) || 0;
    const pages = Math.max(1, Math.ceil(record.features.length / pageSize));
    const start = page * pageSize;
    tableTitle.textContent = record.name + ' · ' + record.geometry + ' · ' +
      new Intl.NumberFormat('th-TH').format(record.features.length) + ' ฟีเจอร์ · ' + record.crs;
    tableHead.replaceChildren();
    const headerRow = document.createElement('tr');
    columns.forEach((key) => { const th = document.createElement('th'); th.textContent = key; headerRow.appendChild(th); });
    const rowAction = document.createElement('th'); rowAction.textContent = 'แผนที่'; headerRow.appendChild(rowAction);
    tableHead.appendChild(headerRow);
    tableBody.replaceChildren();
    record.features.slice(start, start + pageSize).forEach((feature, index) => {
      const row = document.createElement('tr');
      columns.forEach((key) => { const cell = document.createElement('td'); cell.textContent = displayValue((feature.properties || {})[key]); row.appendChild(cell); });
      const action = document.createElement('td');
      const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.textContent = 'Zoom';
      button.addEventListener('click', () => window.LocalGIS.focusFeature(feature));
      action.appendChild(button); row.appendChild(action);
      row.addEventListener('dblclick', () => window.LocalGIS.focusFeature(feature));
      row.dataset.featureIndex = String(start + index);
      tableBody.appendChild(row);
    });
    pageStatus.textContent = 'หน้า ' + (page + 1) + ' / ' + pages + ' · ' +
      (record.features.length ? (start + 1) : 0) + '–' + Math.min(start + pageSize, record.features.length) +
      ' จาก ' + new Intl.NumberFormat('th-TH').format(record.features.length);
    previousPage.disabled = page <= 0;
    nextPage.disabled = page >= pages - 1;
  }
  function deleteLayer(id) {
    const record = imported.get(id);
    if (!record) return;
    if (selected && selected.record === record) {
      clearSelectionHighlight();
      window.LocalGIS.selectFeature(null, true);
    }
    window.LocalGIS.map.removeLayer(record.layer);
    window.LocalGIS.map.removeLayer(record.labelLayer);
    window.LocalGIS.map.removeLayer(record.zoneLabelLayer);
    window.LocalGIS.map.removeLayer(record.parcelLabelLayer);
    record.labelLayer.clearLayers();
    record.zoneLabelLayer.clearLayers();
    record.parcelLabelLayer.clearLayers();
    record.controlRow.remove();
    record.card.remove();
    record.features.forEach((feature) => {
      const index = window.LocalGIS.features.indexOf(feature);
      if (index >= 0) window.LocalGIS.features.splice(index, 1);
      delete feature._layerName;
      delete feature._importedLayerId;
    });
    imported.delete(id);
    removeSavedLayer(id).catch((error) => {
      console.error('Could not remove saved GIS layer', error);
      setStatus('ลบ Layer จากแผนที่แล้ว แต่ลบข้อมูลที่บันทึกไว้ไม่สำเร็จ', 'error');
    });
    pageByLayer.delete(id);
    refreshHouseLabelControls();
    refreshZoneLabelControls();
    refreshParcelLabelControls();
    window.dispatchEvent(new CustomEvent('localgis:layerschange'));
    refreshTableSelector();
    setStatus('ลบ Layer ' + record.name + ' จากแผนที่และหน่วยความจำแล้ว ไฟล์ต้นฉบับไม่ได้เปลี่ยนแปลง', 'success');
  }

  async function restorePersistedLayers() {
    if (restoreStarted) return;
    restoreStarted = true;
    setStatus('กำลังเรียกคืน Layer ที่บันทึกไว้ในเบราว์เซอร์...', 'loading');
    try {
      const savedLayers = await readSavedLayers();
      savedLayers.sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
      let restoredCount = 0;
      savedLayers.forEach((saved) => {
        if (!saved || !saved.name || !saved.collection || saved.collection.type !== 'FeatureCollection' || !Array.isArray(saved.collection.features)) return;
        try {
          registerLayer(saved.name, saved.collection, { label: saved.crs || 'EPSG:4326' }, {
            persist: false, preferredId: saved.id || ''
          });
          restoredCount += 1;
        } catch (error) {
          console.error('Could not restore saved GIS layer', error);
        }
      });
      setStatus(restoredCount
        ? 'เรียกคืนข้อมูล ' + restoredCount.toLocaleString('th-TH') + ' Layer จากเบราว์เซอร์แล้ว'
        : 'ยังไม่มี Layer ที่บันทึกไว้ในเบราว์เซอร์ ให้นำเข้าข้อมูล GIS ก่อน', 'success');
    } catch (error) {
      restoreStarted = false;
      console.error('Could not restore saved GIS layers', error);
      setStatus('ไม่สามารถเรียกคืนข้อมูลที่บันทึกไว้ได้ เบราว์เซอร์อาจปิดกั้นพื้นที่จัดเก็บ', 'error');
    }
  }
  function exportFeatures(features, name) {
    const collection = { type: 'FeatureCollection', features: features.map(cleanFeature) };
    const blob = new Blob([JSON.stringify(collection, null, 2)], { type: 'application/geo+json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = (String(name || 'gis-data').replace(/[^\w-]+/g, '-') || 'gis-data') + '.geojson';
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportSelected() {
    const feature = window.LocalGIS.getSelectedFeature();
    if (!feature) return setStatus('กรุณาเลือกฟีเจอร์ก่อนส่งออก', 'error');
    exportFeatures([feature], feature.properties && (feature.properties.id || feature.properties.name) || 'selected-feature');
  }
  function exportLayer() {
    const record = imported.get(tableSelect.value || activeTableId);
    if (!record) return setStatus('กรุณาเลือก Layer ก่อนส่งออก', 'error');
    exportFeatures(record.features, record.name);
  }
  function exportAll() {
    const features = [...imported.values()].flatMap((record) => record.features);
    if (!features.length) return setStatus('ยังไม่มีข้อมูลนำเข้าให้ส่งออก', 'error');
    exportFeatures(features, 'all-imported-layers');
  }
  async function importZip(file) {
    const groups = await groupZip(file);
    validateGroups(groups);
    return groups;
  }
  async function importSelection(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    setStatus('กำลังอ่านข้อมูลใน Browser ของคุณ...', 'loading');
    try {
      const zipFiles = files.filter((file) => extension(file.name) === '.zip');
      let groups;
      if (zipFiles.length) {
        if (files.length !== 1) throw new Error(missingFilesMessage);
        groups = await importZip(zipFiles[0]);
      } else {
        groups = groupSelectedFiles(files);
        validateGroups(groups);
      }
      let importedCount = 0;
      for (const group of groups) {
        try {
          const parsed = await parseGroup(group);
          registerLayer(group.name, parsed.collection, parsed.crs);
          importedCount += 1;
        } catch (error) {
          console.error('Shapefile import failed', error);
          if (error.message === unknownCrsMessage || error.message === 'ไม่สามารถระบุระบบพิกัดได้') {
            setStatus(unknownCrsMessage + ' ' + group.name, 'error');
          } else {
            setStatus('ไม่สามารถอ่าน Shapefile ได้: ' + group.name, 'error');
          }
        }
      }
      if (!importedCount && !status.classList.contains('error')) setStatus('ไม่สามารถอ่าน Shapefile ได้', 'error');
      else if (importedCount > 1) setStatus('นำเข้าข้อมูลสำเร็จ ' + importedCount + ' Layers', 'success');
    } catch (error) {
      setStatus(error.message === missingFilesMessage ? missingFilesMessage : 'ไม่สามารถอ่าน Shapefile ได้', 'error');
    } finally {
      input.value = '';
    }
  }

  window.LocalGISImports = {
    getLayer: (id) => imported.get(id)?.layer || null,
    clearSelectionHighlight,
    focusFeature: focusImportedFeature,
    deleteLayer
  };
  window.addEventListener('localgis:authenticated', restorePersistedLayers);
  if (!document.getElementById('gis-app').hidden) restorePersistedLayers();
  buildHouseLabelControls();
  buildZoneLabelControls();
  buildParcelLabelControls();
  window.LocalGIS.map.on('zoomend moveend', () => { refreshHouseLabels(); refreshZoneLabels(); refreshParcelLabels(); });
  document.getElementById('gis-import-button').addEventListener('click', () => input.click());
  input.addEventListener('change', () => importSelection(input.files));
  document.getElementById('export-selected-import').addEventListener('click', exportSelected);
  document.getElementById('export-current-layer').addEventListener('click', exportLayer);
  document.getElementById('export-all-imported').addEventListener('click', exportAll);
  tableSelect.addEventListener('change', () => { pageByLayer.set(tableSelect.value, 0); renderTable(); });
  previousPage.addEventListener('click', () => { const page = pageByLayer.get(activeTableId) || 0; pageByLayer.set(activeTableId, Math.max(0, page - 1)); renderTable(); });
  nextPage.addEventListener('click', () => { const record = imported.get(activeTableId); if (!record) return; const page = pageByLayer.get(activeTableId) || 0; pageByLayer.set(activeTableId, Math.min(Math.ceil(record.features.length / pageSize) - 1, page + 1)); renderTable(); });
})();
