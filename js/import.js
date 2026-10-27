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
  let selected = null;
  let activeTableId = '';
  const pageByLayer = new Map();
  const pageSize = 100;
  const missingFilesMessage = 'กรุณาเลือกไฟล์ Shapefile ให้ครบ (.shp, .shx, .dbf และ .prj)';
  const unknownCrsMessage = 'ไม่สามารถตรวจสอบระบบพิกัดของข้อมูลได้ กรุณาตรวจสอบไฟล์ .prj';

  function setStatus(message, kind) {
    status.textContent = message || '';
    status.className = 'hint gis-import-status' + (kind ? ' ' + kind : '');
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
  function propertyRows(feature) {
    const properties = feature.properties || {};
    return Object.entries(properties)
      .filter(([key]) => !/^(geometry|the_geom|shape|bbox|_layerName|_importedLayerId)$/i.test(key) && !key.startsWith('__'))
      .map(([key, value]) => '<div class="popup-row"><b>' + escapeHtml(key) + ':</b> ' + escapeHtml(displayValue(value)) + '</div>')
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
      record.layer.addTo(window.LocalGIS.map);
      window.LocalGIS.zoomToLayerBounds(record.layer);
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
  function registerLayer(name, collection, crs) {
    let id = name.toLocaleLowerCase().replace(/[^\p{L}\p{N}-]+/gu, '-');
    const baseId = id || 'layer';
    let suffix = 2;
    while (imported.has(id)) id = baseId + '-' + suffix++;
    const record = {
      id, name, collection, features: collection.features,
      geometry: geometrySummary(collection), crs: crs.label,
      color: palette[imported.size % palette.length], layer: null
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
    refreshTableSelector();
    if (record.zoomCheckbox.checked) {
      window.dispatchEvent(new CustomEvent('localgis:importedlayer', { detail: { layer } }));
      window.setTimeout(() => window.LocalGIS.map.invalidateSize(), 100);
    }
    setStatus('นำเข้า ' + name + ' สำเร็จ: ' + record.features.length + ' ฟีเจอร์', 'success');
    showTable(id);
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
    record.controlRow.remove();
    record.card.remove();
    record.features.forEach((feature) => {
      const index = window.LocalGIS.features.indexOf(feature);
      if (index >= 0) window.LocalGIS.features.splice(index, 1);
      delete feature._layerName;
      delete feature._importedLayerId;
    });
    imported.delete(id);
    pageByLayer.delete(id);
    window.dispatchEvent(new CustomEvent('localgis:layerschange'));
    refreshTableSelector();
    setStatus('ลบ Layer ' + record.name + ' จากแผนที่และหน่วยความจำแล้ว ไฟล์ต้นฉบับไม่ได้เปลี่ยนแปลง', 'success');
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
  document.getElementById('gis-import-button').addEventListener('click', () => input.click());
  input.addEventListener('change', () => importSelection(input.files));
  document.getElementById('export-selected-import').addEventListener('click', exportSelected);
  document.getElementById('export-current-layer').addEventListener('click', exportLayer);
  document.getElementById('export-all-imported').addEventListener('click', exportAll);
  tableSelect.addEventListener('change', () => { pageByLayer.set(tableSelect.value, 0); renderTable(); });
  previousPage.addEventListener('click', () => { const page = pageByLayer.get(activeTableId) || 0; pageByLayer.set(activeTableId, Math.max(0, page - 1)); renderTable(); });
  nextPage.addEventListener('click', () => { const record = imported.get(activeTableId); if (!record) return; const page = pageByLayer.get(activeTableId) || 0; pageByLayer.set(activeTableId, Math.min(Math.ceil(record.features.length / pageSize) - 1, page + 1)); renderTable(); });
})();
