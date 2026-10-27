(() => {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const typeSelect = byId('analysis-type');
  const sourceSelect = byId('analysis-source');
  const targetSelect = byId('analysis-target');
  const sourceFeatureSelect = byId('analysis-source-feature');
  const targetFeatureSelect = byId('analysis-target-feature');
  const featurePair = byId('analysis-feature-pair');
  const distanceMethodRow = byId('analysis-distance-method-row');
  const distanceMethodSelect = byId('analysis-distance-method');
  const bufferRow = byId('analysis-buffer-row');
  const bufferDistanceInput = byId('analysis-buffer-distance');
  const bufferUnitSelect = byId('analysis-buffer-unit');
  const resultSelect = byId('analysis-result-select');
  const summary = byId('analysis-summary');
  const resultList = byId('analysis-results');
  const resultExport = byId('analysis-export');
  const resultClear = byId('analysis-clear');
  const analysisRun = byId('analysis-run');
  const crsWarning = byId('analysis-crs-warning');
  const results = new Map();
  let nextResultId = 1;
  let analysisLayers = [];
  let running = false;

  function setStatus(message, state) {
    summary.textContent = message;
    summary.dataset.state = state || 'info';
    summary.setAttribute('role', state === 'error' ? 'alert' : 'status');
  }

  const labels = {
    'point-in-polygon': 'Point in Polygon',
    within: 'Within',
    intersect: 'Intersect',
    buffer: 'Buffer',
    'centroid-within': 'Centroid Within Polygon',
    distance: 'Distance'
  };
  const resultPrefixes = {
    'point-in-polygon': 'PIP_Result_',
    within: 'Within_Result_',
    intersect: 'Intersect_Result_',
    buffer: 'Buffer_Result_',
    'centroid-within': 'Centroid_Result_',
    distance: 'Distance_Result_'
  };

  function safe(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }
  function propsOf(feature) { return feature && feature.properties && typeof feature.properties === 'object' ? feature.properties : {}; }
  function featureLabel(feature, index) {
    const props = propsOf(feature);
    return String(props.name || props.id || 'Feature ' + (index + 1));
  }
  function geometryType(feature) { return feature && feature.geometry ? feature.geometry.type : ''; }
  function isPoint(feature) { return ['Point', 'MultiPoint'].includes(geometryType(feature)); }
  function isPolygon(feature) { return ['Polygon', 'MultiPolygon'].includes(geometryType(feature)); }
  function isLine(feature) { return ['LineString', 'MultiLineString'].includes(geometryType(feature)); }
  function option(select, value, text) {
    const el = document.createElement('option'); el.value = value; el.textContent = text; select.appendChild(el);
  }
  function getLayer(id) { return analysisLayers.find((layer) => layer.id === id) || null; }

  function refreshLayers() {
    const previousSource = sourceSelect.value;
    const previousTarget = targetSelect.value;
    analysisLayers = window.LocalGIS.getLayers();
    [sourceSelect, targetSelect].forEach((select) => {
      const old = select.value;
      select.replaceChildren();
      analysisLayers.forEach((layer) => option(select, layer.id, layer.name + ' (' + layer.features.length + ')'));
      if (analysisLayers.some((layer) => layer.id === old)) select.value = old;
    });
    if (analysisLayers.some((layer) => layer.id === previousSource)) sourceSelect.value = previousSource;
    if (analysisLayers.some((layer) => layer.id === previousTarget)) targetSelect.value = previousTarget;
    refreshFeatureChoices();
    updateCrsWarning();
  }

  function refreshFeatureChoices() {
    [[sourceFeatureSelect, getLayer(sourceSelect.value)], [targetFeatureSelect, getLayer(targetSelect.value)]].forEach(([select, layer]) => {
      const previous = select.value;
      select.replaceChildren();
      option(select, '', '— กรุณาเลือก Feature —');
      if (!layer) return;
      layer.features.forEach((feature, index) => option(select, String(index), featureLabel(feature, index)));
      if (/^\d+$/.test(previous) && Number(previous) < layer.features.length) select.value = previous;
      else select.value = '';
    });
  }

  function updateModeUi() {
    const type = typeSelect.value;
    const usesFeatureChoice = type === 'distance' || type === 'buffer';
    featurePair.hidden = !usesFeatureChoice;
    byId('analysis-target-feature').hidden = type === 'buffer';
    document.querySelector('label[for="analysis-target-feature"]').hidden = type === 'buffer';
    distanceMethodRow.hidden = type !== 'distance';
    bufferRow.hidden = type !== 'buffer';
    targetSelect.disabled = type === 'buffer';
    updateCrsWarning();
  }

  function updateCrsWarning() {
    const source = getLayer(sourceSelect.value);
    const target = getLayer(targetSelect.value);
    const warnings = [];
    [source, target].forEach((layer) => {
      if (layer && layer.crsWarning) warnings.push('ไม่พบข้อมูล CRS — ระบบถือว่าข้อมูลเป็น EPSG:4326 (' + layer.name + ')');
    });
    crsWarning.hidden = !warnings.length;
    crsWarning.textContent = [...new Set(warnings)].join(' | ');
  }

  function selectedFeature(select, layerSelect) {
    const layer = getLayer(layerSelect.value);
    if (!layer || !/^\d+$/.test(select.value)) return null;
    return layer.features[Number(select.value)] || null;
  }
  function cloneProperties(feature) { return JSON.parse(JSON.stringify(propsOf(feature))); }
  function cloneGeometry(feature) { return feature && feature.geometry ? JSON.parse(JSON.stringify(feature.geometry)) : null; }
  function makeResult(geometry, properties) {
    return { type: 'Feature', properties: { ...properties }, geometry: geometry ? JSON.parse(JSON.stringify(geometry)) : null };
  }
  function pointParts(feature) {
    const geom = feature && feature.geometry;
    if (!geom) return [];
    if (geom.type === 'Point') return [turf.point(geom.coordinates)];
    if (geom.type === 'MultiPoint') return geom.coordinates.map((coordinate) => turf.point(coordinate));
    return [];
  }
  function pointInside(point, polygon) {
    return isPolygon(polygon) && turf.booleanPointInPolygon(point, polygon, { ignoreBoundary: false });
  }
  function isWithinTarget(source, target) {
    if (!source.geometry || !target.geometry || !isPolygon(target)) return false;
    if (geometryType(source) === 'MultiPoint') return pointParts(source).every((point) => pointInside(point, target));
    if (geometryType(source) === 'Point') return pointInside(turf.point(source.geometry.coordinates), target);
    return turf.booleanWithin(source, target);
  }

  function baseProperties(type, sourceLayer, targetLayer, source, target) {
    const sourceAttributes = cloneProperties(source);
    const generatedKeys = new Set(['analysis_type','source_layer','target_layer','source_id','target_id','source_feature_id','target_feature_id','source_attributes','target_attributes','feature_id','source_name','target_name','distance_method','distance_m','distance_km','buffer_distance','buffer_distance_m','buffer_unit','area_m2','area_rai','length_m','length_km','analysis_datetime','analysis_time','result_layer']);
    const properties = { ...sourceAttributes,
      analysis_type: labels[type],
      source_layer: sourceLayer.name,
      target_layer: targetLayer ? targetLayer.name : '—',
      source_id: propsOf(source).id ?? null,
      target_id: target ? (propsOf(target).id ?? null) : null,
      source_feature_id: propsOf(source).id ?? null,
      target_feature_id: target ? (propsOf(target).id ?? null) : null,
      source_attributes: sourceAttributes
    };
    Object.keys(sourceAttributes).forEach((key) => {
      if (generatedKeys.has(key)) properties['source_attribute_' + key] = sourceAttributes[key];
    });
    if (type === 'intersect' && target) {
      const targetAttributes = cloneProperties(target);
      properties.target_attributes = targetAttributes;
      Object.entries(targetAttributes).forEach(([key, value]) => {
        const baseKey = 'target_' + key;
        let prefixed = baseKey;
        if (Object.prototype.hasOwnProperty.call(properties, prefixed) || generatedKeys.has(prefixed)) {
          prefixed = 'target_attribute_' + key;
          let suffix = 2;
          while (Object.prototype.hasOwnProperty.call(properties, prefixed) || generatedKeys.has(prefixed)) prefixed = 'target_attribute_' + key + '_' + suffix++;
        }
        properties[prefixed] = value;
      });
    } else if (target) properties.target_attributes = cloneProperties(target);
    return properties;
  }

  function relationResult(type, sourceLayer, targetLayer, source, target, geometry, suffix) {
    const properties = baseProperties(type, sourceLayer, targetLayer, source, target);
    properties.feature_id = propsOf(source).id ?? sourceLayer.name + ':' + (suffix + 1);
    properties.source_name = featureLabel(source, suffix);
    properties.target_name = featureLabel(target, 0);
    return makeResult(geometry, properties);
  }

  async function pointInPolygonResults(sourceLayer, targetLayer) {
    const out = []; let operations = 0;
    for (let sourceIndex = 0; sourceIndex < sourceLayer.features.length; sourceIndex++) {
      const source = sourceLayer.features[sourceIndex];
      for (let pointIndex = 0; pointIndex < pointParts(source).length; pointIndex++) {
        const point = pointParts(source)[pointIndex];
        for (let targetIndex = 0; targetIndex < targetLayer.features.length; targetIndex++) {
          const target = targetLayer.features[targetIndex];
          if (pointInside(point, target)) out.push(relationResult('point-in-polygon', sourceLayer, targetLayer, source, target, point.geometry, sourceIndex + pointIndex + targetIndex));
          if (++operations % 250 === 0) await yieldToBrowser();
        }
      }
    }
    return out;
  }

  async function withinResults(type, sourceLayer, targetLayer) {
    const out = []; let operations = 0;
    for (let index = 0; index < sourceLayer.features.length; index++) {
      const source = sourceLayer.features[index];
      for (let targetIndex = 0; targetIndex < targetLayer.features.length; targetIndex++) {
        const target = targetLayer.features[targetIndex];
        if (target.geometry && source.geometry && isPolygon(target)) {
          let within = false;
          try { within = isWithinTarget(source, target); } catch (_error) { within = false; }
          if (within) out.push(relationResult(type, sourceLayer, targetLayer, source, target, cloneGeometry(source), index + targetIndex));
        }
        if (++operations % 250 === 0) await yieldToBrowser();
      }
    }
    return out;
  }

  function lineParts(feature) {
    if (!feature || !feature.geometry) return [];
    if (feature.geometry.type === 'LineString') return [turf.lineString(feature.geometry.coordinates)];
    if (feature.geometry.type === 'MultiLineString') return feature.geometry.coordinates.map((coords) => turf.lineString(coords));
    if (isPolygon(feature)) {
      const line = turf.polygonToLine(feature);
      return line.type === 'FeatureCollection' ? line.features : [line];
    }
    return [];
  }

  function boundaryParts(feature) {
    if (!feature || !feature.geometry) return [];
    if (isLine(feature)) return lineParts(feature);
    if (isPolygon(feature)) return lineParts(feature);
    return [];
  }

  function intersectionGeometries(first, second) {
    if (!first.geometry || !second.geometry) return [];
    if (isPoint(first) || isPoint(second)) {
      const points = isPoint(first) ? pointParts(first) : pointParts(second);
      const other = isPoint(first) ? second : first;
      return points.filter((point) => turf.booleanIntersects(point, other)).map((point) => point.geometry);
    }
    if (isPolygon(first) && isPolygon(second)) {
      const intersection = turf.intersect(turf.featureCollection([first, second]));
      return intersection ? [intersection.geometry] : [];
    }
    if (isLine(first) && isPolygon(second)) {
      const results = [];
      lineParts(first).forEach((line) => {
        try {
          const boundary = turf.polygonToLine(second);
          const split = turf.lineSplit(line, boundary);
          split.features.forEach((piece) => {
            const middle = turf.along(piece, turf.length(piece, { units: 'kilometers' }) / 2, { units: 'kilometers' });
            if (turf.booleanPointInPolygon(middle, second, { ignoreBoundary: false })) results.push(piece.geometry);
          });
        } catch (_error) { /* invalid/unsupported geometry pair */ }
      });
      return results;
    }
    if (isPolygon(first) && isLine(second)) return intersectionGeometries(second, first);
    if (isLine(first) && isLine(second)) {
      const out = [];
      try { out.push(...turf.lineOverlap(first, second).features.map((feature) => feature.geometry)); } catch (_error) { /* no overlap */ }
      try { out.push(...turf.lineIntersect(first, second).features.map((feature) => feature.geometry)); } catch (_error) { /* no intersection */ }
      return out;
    }
    return [];
  }

  async function intersectResults(sourceLayer, targetLayer) {
    const out = []; let operations = 0;
    for (let index = 0; index < sourceLayer.features.length; index++) {
      const source = sourceLayer.features[index];
      for (let targetIndex = 0; targetIndex < targetLayer.features.length; targetIndex++) {
        const target = targetLayer.features[targetIndex];
        try {
          intersectionGeometries(source, target).forEach((geometry, partIndex) => out.push(relationResult('intersect', sourceLayer, targetLayer, source, target, geometry, index + targetIndex + partIndex)));
        } catch (error) { console.warn('Skipping invalid geometry during intersection', error); }
        if (++operations % 100 === 0) await yieldToBrowser();
      }
    }
    return out;
  }

  async function bufferResults(source, sourceLayer, distance, unit) {
    if (!source || !source.geometry) throw new Error('กรุณาเลือก Source Feature ที่มี Geometry ก่อนสร้าง Buffer');
    if (!sourceLayer || !sourceLayer.features.includes(source)) throw new Error('Source Feature ที่เลือกไม่อยู่ใน Source Layer');
    const distanceKm = unit === 'kilometers' ? distance : distance / 1000;
    let buffered;
    try { buffered = turf.buffer(source, distanceKm, { units: 'kilometers', steps: 32 }); }
    catch (error) { throw new Error('สร้าง Buffer จาก Source Feature ที่เลือกไม่สำเร็จ: ' + error.message); }
    if (!buffered || !buffered.geometry || !isPolygon(buffered)) throw new Error('Geometry ของ Source Feature ที่เลือกไม่สามารถสร้าง Buffer ได้');
    const sourceIndex = sourceLayer.features.indexOf(source);
    const properties = baseProperties('buffer', sourceLayer, null, source, null);
    properties.feature_id = propsOf(source).id ?? sourceLayer.name + ':' + (sourceIndex + 1);
    properties.buffer_distance = distance;
    properties.buffer_distance_m = unit === 'kilometers' ? distance * 1000 : distance;
    properties.buffer_unit = unit === 'kilometers' ? 'กิโลเมตร' : 'เมตร';
    properties.source_name = featureLabel(source, sourceIndex);
    const result = makeResult(buffered.geometry, properties);
    const area = turf.area(result);
    if (!Number.isFinite(area) || area <= 0) throw new Error('Buffer ที่ได้ไม่มีพื้นที่ที่ถูกต้อง');
    return [result];
  }

  async function centroidResults(sourceLayer, targetLayer) {
    const out = []; let operations = 0;
    for (let index = 0; index < sourceLayer.features.length; index++) {
      const source = sourceLayer.features[index];
      if (isPolygon(source)) {
        const center = turf.centroid(source);
        for (let targetIndex = 0; targetIndex < targetLayer.features.length; targetIndex++) {
          const target = targetLayer.features[targetIndex];
          if (isPolygon(target) && pointInside(center, target)) out.push(relationResult('centroid-within', sourceLayer, targetLayer, source, target, center.geometry, index + targetIndex));
          if (++operations % 250 === 0) await yieldToBrowser();
        }
      }
    }
    return out;
  }

  function distanceBetweenPointSets(pointsA, pointsB) {
    let best = Infinity;
    pointsA.forEach((a) => pointsB.forEach((b) => { best = Math.min(best, turf.distance(a, b, { units: 'meters' })); }));
    return best;
  }

  function nearestDistanceMeters(first, second) {
    if (turf.booleanIntersects(first, second)) return 0;
    const firstPoints = pointParts(first);
    const secondPoints = pointParts(second);
    let best = Infinity;
    if (firstPoints.length && secondPoints.length) best = Math.min(best, distanceBetweenPointSets(firstPoints, secondPoints));
    const firstLines = boundaryParts(first);
    const secondLines = boundaryParts(second);
    firstPoints.forEach((point) => secondLines.forEach((line) => { best = Math.min(best, turf.pointToLineDistance(point, line, { units: 'meters' })); }));
    secondPoints.forEach((point) => firstLines.forEach((line) => { best = Math.min(best, turf.pointToLineDistance(point, line, { units: 'meters' })); }));
    const vertices = (line) => {
      const coords = line.geometry.coordinates;
      const out = [];
      const walk = (value) => Array.isArray(value) && (typeof value[0] === 'number' ? out.push(turf.point(value)) : value.forEach(walk));
      walk(coords); return out;
    };
    const nearestPointOnLine = turf.nearestPointOnLine;
    if (typeof nearestPointOnLine !== 'function' && firstLines.length && secondLines.length) {
      throw new Error('Nearest Distance สำหรับ Line/Polygon ต้องใช้ Turf.js ที่มี nearestPointOnLine');
    }
    firstLines.forEach((line) => vertices(line).forEach((point) => {
      secondLines.forEach((targetLine) => { try { best = Math.min(best, turf.distance(point, nearestPointOnLine(targetLine, point), { units: 'meters' })); } catch (_error) {} });
    }));
    secondLines.forEach((line) => vertices(line).forEach((point) => {
      firstLines.forEach((targetLine) => { try { best = Math.min(best, turf.distance(point, nearestPointOnLine(targetLine, point), { units: 'meters' })); } catch (_error) {} });
    }));
    return best;
  }

  function centerOf(feature) { return turf.centroid(feature); }

  function distanceResults(sourceLayer, targetLayer) {
    const source = selectedFeature(sourceFeatureSelect, sourceSelect);
    const target = selectedFeature(targetFeatureSelect, targetSelect);
    if (!source || !target) throw new Error('กรุณาเลือก Source Feature และ Target Feature');
    if (!sourceLayer.features.includes(source) || !targetLayer.features.includes(target)) throw new Error('Geometry ของ Feature ที่เลือกว่าง ไม่รองรับ หรือไม่ถูกต้อง');
    const method = distanceMethodSelect.value;
    const from = centerOf(source);
    const to = centerOf(target);
    if (!isPoint(source) && !isLine(source) && !isPolygon(source)) throw new Error('ไม่สามารถคำนวณระยะทางจาก Geometry นี้ได้');
    if (!isPoint(target) && !isLine(target) && !isPolygon(target)) throw new Error('ไม่สามารถคำนวณระยะทางจาก Geometry นี้ได้');
    let distance;
    try { distance = method === 'nearest' ? nearestDistanceMeters(source, target) : turf.distance(from, to, { units: 'meters' }); }
    catch (error) { console.warn('Distance calculation failed', error); throw new Error('ไม่สามารถคำนวณระยะทางจาก Geometry นี้ได้'); }
    if (!Number.isFinite(distance)) throw new Error('ไม่สามารถคำนวณระยะทางของ Geometry นี้ได้');
    const midpoint = turf.midpoint(from, to);
    const properties = baseProperties('distance', sourceLayer, targetLayer, source, target);
    properties.feature_id = String(propsOf(source).id ?? 'source') + ' → ' + String(propsOf(target).id ?? 'target');
    properties.distance_method = method === 'nearest' ? 'Nearest Distance' : 'Centroid to Centroid';
    properties.distance_m = distance;
    properties.distance_km = distance / 1000;
    return [makeResult(midpoint.geometry, properties)];
  }

  function metricSummary(features) {
    let area = 0; let length = 0; let polygonCount = 0; let lineCount = 0; let skipped = 0;
    const areas = []; const lengths = [];
    features.forEach((feature) => {
       if (!feature.geometry || geometryIsEmpty(feature)) { skipped++; return; }
      try {
        if (isPolygon(feature)) { const value = turf.area(feature); if (Number.isFinite(value) && value > 0) { area += value; areas.push(value); polygonCount++; } else skipped++; }
        else if (isLine(feature)) { const value = turf.length(feature, { units: 'meters' }); if (Number.isFinite(value) && value > 0) { length += value; lengths.push(value); lineCount++; } else skipped++; }
      } catch (_error) { skipped++; }
    });
    return {
      featureCount: features.length, polygonCount, lineCount, skipped,
      area, areaRai: area / 1600,
      averageArea: areas.length ? area / areas.length : 0,
      minArea: areas.length ? Math.min(...areas) : 0,
      maxArea: areas.length ? Math.max(...areas) : 0,
      length, lengthKm: length / 1000,
      averageLength: lengths.length ? length / lengths.length : 0,
      minLength: lengths.length ? Math.min(...lengths) : 0,
      maxLength: lengths.length ? Math.max(...lengths) : 0
    };
  }

  function popupRow(label, value) {
    const display = value == null || value === '' || (typeof value === 'number' && !Number.isFinite(value)) ? '-' : value;
    return '<tr><th>' + safe(label) + '</th><td>' + safe(display) + '</td></tr>';
  }
  function formatted(value, digits) {
    if (value == null || value === '') return '-';
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(digits) : '-';
  }
  function popupContent(feature) {
    const p = propsOf(feature);
    const rows = [];
    rows.push(popupRow('Analysis Type', p.analysis_type));
    rows.push(popupRow('Source Layer', p.source_layer));
    if (p.target_layer && p.target_layer !== '—') rows.push(popupRow('Target Layer', p.target_layer));
    rows.push(popupRow('Feature ID', p.feature_id));
    if (p.analysis_type === labels.intersect || p.analysis_type === labels.distance) {
      rows.push(popupRow('Source ID', p.source_id));
      rows.push(popupRow('Target ID', p.target_id));
    }
    if (p.analysis_type === labels.buffer) {
      rows.push(popupRow('Buffer Distance', p.buffer_distance == null ? '-' : formatted(p.buffer_distance, 2) + ' ' + (p.buffer_unit || '-')));
      rows.push(popupRow('Area (m²)', p.area_m2 == null ? '-' : formatted(p.area_m2, 2)));
      rows.push(popupRow('Area (ไร่)', p.area_rai == null ? '-' : formatted(p.area_rai, 4)));
    }
    if (p.analysis_type === labels.intersect) {
       if (p.area_m2 != null) rows.push(popupRow('Intersection Area (m²)', formatted(p.area_m2, 2)));
       if (p.area_rai != null) rows.push(popupRow('Intersection Area (ไร่)', formatted(p.area_rai, 4)));
      if (p.length_m) rows.push(popupRow('Intersection Length', Number(p.length_m).toFixed(2) + ' m'));
    }
    if (p.analysis_type === labels.distance) {
      rows.push(popupRow('Method', p.distance_method));
      rows.push(popupRow('Distance', formatted(p.distance_m, 2) + ' m'));
      rows.push(popupRow('Distance', formatted(p.distance_km, 4) + ' km'));
    }
    if (p.area_m2 != null && p.analysis_type !== labels.buffer && p.analysis_type !== labels.intersect) rows.push(popupRow('Area', Number(p.area_m2).toFixed(2) + ' m²'));
    if (p.area_rai != null && p.analysis_type !== labels.buffer && p.analysis_type !== labels.intersect) rows.push(popupRow('Area', Number(p.area_rai).toFixed(4) + ' ไร่'));
    if (p.length_m != null && p.analysis_type !== labels.intersect) rows.push(popupRow('Length', Number(p.length_m).toFixed(2) + ' m'));
    return '<div class="analysis-popup-title">' + safe(p.analysis_type || 'Spatial Analysis Result') + '</div><table class="analysis-popup-table">' + rows.join('') + '</table>';
  }

  function nextName(type) {
    const prefix = resultPrefixes[type] || 'Analysis_Result_';
    let number = 1;
    const names = new Set([...results.values()].map((record) => record.name));
    analysisLayers.forEach((layer) => names.add(layer.name));
    while (names.has(prefix + String(number).padStart(3, '0'))) number++;
    return prefix + String(number).padStart(3, '0');
  }

  function describeResult(record) {
    const s = record.stats;
    const lines = [
      'Analysis Type: ' + record.type,
      'Source Layer: ' + record.sourceName,
      'Target Layer: ' + (record.targetName || '—'),
      'Result Layer: ' + record.name,
      'Feature Count: ' + record.inputCount,
      'Result Count: ' + record.features.length
    ];
    if (s.polygonCount) lines.push('Area: ' + s.area.toFixed(2) + ' m² (' + s.areaRai.toFixed(4) + ' ไร่) · Avg ' + s.averageArea.toFixed(2) + ' m² · Min ' + s.minArea.toFixed(2) + ' m² · Max ' + s.maxArea.toFixed(2) + ' m²');
    if (s.lineCount) lines.push('Length: ' + s.length.toFixed(2) + ' m (' + s.lengthKm.toFixed(4) + ' km) · Avg ' + s.averageLength.toFixed(2) + ' m · Min ' + s.minLength.toFixed(2) + ' m · Max ' + s.maxLength.toFixed(2) + ' m');
    if (s.skipped) lines.push('ข้ามการคำนวณพื้นที่/ความยาว: ' + s.skipped + ' features');
    if (record.skippedInputCount) lines.push('ข้าม Feature ต้นทาง/เป้าหมายที่ใช้ไม่ได้: ' + record.skippedInputCount);
    if (record.type === labels.distance && record.features[0]) lines.push('Distance: ' + Number(record.features[0].properties.distance_m).toFixed(2) + ' m (' + Number(record.features[0].properties.distance_km).toFixed(4) + ' km) · ' + record.features[0].properties.distance_method);
    if (record.bufferDistance != null) lines.push('Buffer Distance: ' + record.bufferDistance + ' ' + record.bufferUnit);
    lines.push('Analysis Date/Time: ' + record.analyzedAt);
    return lines.join('\n');
  }

  function refreshResultUi() {
    const old = resultSelect.value;
    resultSelect.replaceChildren();
    resultList.replaceChildren();
    results.forEach((record, id) => {
      option(resultSelect, id, record.name);
      const item = document.createElement('div'); item.className = 'analysis-result-item';
      const name = document.createElement('strong'); name.textContent = record.name;
      const actions = document.createElement('div');
      const zoom = document.createElement('button'); zoom.type = 'button'; zoom.className = 'text-button'; zoom.textContent = 'Zoom'; zoom.addEventListener('click', () => zoomResult(id));
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button danger-button'; remove.textContent = 'ลบ Result'; remove.addEventListener('click', () => deleteResult(id));
      actions.append(zoom, remove); item.append(name, actions); resultList.appendChild(item);
    });
    if (results.has(old)) resultSelect.value = old;
    else if (results.size) resultSelect.value = [...results.keys()].at(-1);
    updateSelectedResultPanel();
  }

  function updateSelectedResultPanel() {
    const record = results.get(resultSelect.value);
    summary.textContent = record ? describeResult(record) : 'ยังไม่มีผลการวิเคราะห์';
    resultExport.disabled = !record;
    byId('analysis-result-type').textContent = record?.type || '—';
    byId('analysis-result-source').textContent = record?.sourceName || '—';
    byId('analysis-result-target').textContent = record?.targetName || '—';
    byId('analysis-result-name').textContent = record?.name || '—';
    byId('analysis-result-count').textContent = record ? record.inputCount.toLocaleString('th-TH') : '—';
    byId('analysis-result-result-count').textContent = record ? record.features.length.toLocaleString('th-TH') : '—';
    const areaStats = record?.stats?.polygonCount ? record.stats.area.toFixed(2) + ' m² / ' + record.stats.areaRai.toFixed(4) + ' ไร่ (เฉลี่ย ' + record.stats.averageArea.toFixed(2) + ', ต่ำสุด ' + record.stats.minArea.toFixed(2) + ', สูงสุด ' + record.stats.maxArea.toFixed(2) + ')' : '—';
    const lengthStats = record?.stats?.lineCount ? record.stats.length.toFixed(2) + ' m / ' + record.stats.lengthKm.toFixed(4) + ' km (เฉลี่ย ' + record.stats.averageLength.toFixed(2) + ', ต่ำสุด ' + record.stats.minLength.toFixed(2) + ', สูงสุด ' + record.stats.maxLength.toFixed(2) + ')' : '—';
    byId('analysis-result-area').textContent = areaStats;
    byId('analysis-result-length').textContent = lengthStats;
    byId('analysis-result-distance').textContent = record?.features[0]?.properties?.distance_m != null ? Number(record.features[0].properties.distance_m).toFixed(2) + ' m / ' + Number(record.features[0].properties.distance_km).toFixed(4) + ' km' : '—';
    byId('analysis-result-buffer').textContent = record?.bufferDistance != null ? record.bufferDistance + ' ' + record.bufferUnit : '—';
    byId('analysis-result-datetime').textContent = record?.analyzedAt || '—';
  }

  function zoomResult(id) {
    const record = results.get(id); if (!record) return;
    const bounds = record.layer.getBounds();
    if (bounds.isValid()) window.LocalGIS.map.fitBounds(bounds, { padding: [35, 35], maxZoom: 17 });
  }
  function deleteResult(id) {
    const record = results.get(id); if (!record) return;
    window.LocalGIS.map.removeLayer(record.layer);
    record.controlRow.remove();
    results.delete(id);
    refreshResultUi();
  }
  function clearResults() {
    if (!results.size) return;
    if (!window.confirm('ต้องการลบผลการวิเคราะห์ทั้งหมดใช่หรือไม่? Source Layer และ Imported Layer จะไม่ถูกลบ')) return;
    [...results.keys()].forEach(deleteResult);
  }

  function addResult(type, sourceLayer, targetLayer, features, inputCount, bufferDistance, bufferUnit, skippedInputCount) {
    const id = 'analysis-result-' + nextResultId++;
    const stamp = new Date();
    const name = nextName(type);
    const metadata = {
      analysis_type: labels[type], source_layer: sourceLayer.name, target_layer: targetLayer ? targetLayer.name : '—',
      analysis_datetime: stamp.toISOString(), source_feature_count: inputCount, result_feature_count: features.length
    };
    features.forEach((feature, index) => {
      const p = feature.properties || (feature.properties = {});
      p.result_layer = name;
      p.analysis_time = stamp.toISOString();
      p.feature_id = p.feature_id ?? p.source_id ?? String(index + 1);
      if (isPolygon(feature)) { p.area_m2 = turf.area(feature); p.area_rai = p.area_m2 / 1600; }
      if (isLine(feature)) { p.length_m = turf.length(feature, { units: 'meters' }); p.length_km = p.length_m / 1000; }
      p.analysis_type = labels[type];
      p.source_layer = sourceLayer.name;
      p.target_layer = targetLayer ? targetLayer.name : '—';
      p.analysis_datetime = stamp.toISOString();
    });
    const collection = { type: 'FeatureCollection', features: JSON.parse(JSON.stringify(features)), metadata };
    const layer = L.geoJSON(collection, {
      style: { color: '#8a4fb2', weight: 2, fillColor: '#b67bd4', fillOpacity: 0.42 },
      pointToLayer: (_feature, latlng) => L.circleMarker(latlng, { radius: 6, color: '#542775', weight: 2, fillColor: '#b67bd4', fillOpacity: 0.9 }),
      onEachFeature: (feature, featureLayer) => featureLayer.bindPopup(popupContent(feature))
    });
    const controlRow = document.createElement('label'); controlRow.className = 'layer-row analysis-layer-row';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = true; checkbox.setAttribute('aria-label', 'แสดง ' + name);
    checkbox.addEventListener('change', () => checkbox.checked ? layer.addTo(window.LocalGIS.map) : window.LocalGIS.map.removeLayer(layer));
    const label = document.createElement('span'); label.textContent = name; controlRow.append(checkbox, label); byId('layer-control').appendChild(controlRow);
    layer.analysisMetadata = metadata;
    layer.resultLayerName = name;
    layer.localGISLayerName = name;
    layer.localGISSource = 'Analysis Result · ' + (metadata.source_layer || '');
    layer.addTo(window.LocalGIS.map);
    const record = {
      id, name, type: labels[type], sourceName: sourceLayer.name, targetName: targetLayer ? targetLayer.name : '', features: JSON.parse(JSON.stringify(features)),
      collection, layer, controlRow, inputCount, skippedInputCount, bufferDistance: bufferDistance ?? null, bufferUnit: bufferUnit || '', stats: metricSummary(features), analyzedAt: stamp.toLocaleString('th-TH'), metadata
    };
    results.set(id, record);
    refreshResultUi(); zoomResult(id); return record;
  }

  function geometryIsEmpty(feature) {
    if (!feature || !feature.geometry) return true;
    if (feature.geometry.type === 'GeometryCollection') return !feature.geometry.geometries?.length;
    return !feature.geometry.coordinates || JSON.stringify(feature.geometry.coordinates).length < 5;
  }
  function hasInvalidLonLat(geometry) {
    let invalid = false;
    const visit = (coordinates) => {
      if (!Array.isArray(coordinates) || invalid) return;
      if (typeof coordinates[0] === 'number') {
        invalid = !Number.isFinite(coordinates[0]) || !Number.isFinite(coordinates[1]) ||
          Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90;
      } else coordinates.forEach(visit);
    };
    if (geometry?.type === 'GeometryCollection') geometry.geometries?.forEach((part) => { if (hasInvalidLonLat(part)) invalid = true; });
    else visit(geometry?.coordinates);
    return invalid;
  }
  function validateLayer(layer, role) {
    if (!layer) throw new Error('กรุณาเลือก ' + role + ' Layer');
    if (!layer.features.length) throw new Error('ไม่พบข้อมูลใน Layer ที่เลือก');
    if (layer.crs && !/^EPSG:4326$/i.test(layer.crs)) throw new Error('ไม่รองรับ CRS ' + layer.crs + ' ใน Spatial Analysis');
    if (layer.features.some((feature) => feature.geometry && hasInvalidLonLat(feature.geometry))) {
      throw new Error(role + ' Layer มีพิกัดอยู่นอกช่วง longitude/latitude ของ EPSG:4326 กรุณาตรวจ CRS หรือแปลงพิกัดก่อนวิเคราะห์');
    }
    const supported = layer.features.filter((feature) => !geometryIsEmpty(feature) && ['Point','MultiPoint','LineString','MultiLineString','Polygon','MultiPolygon'].includes(geometryType(feature)));
    if (!supported.length) throw new Error(role + ' Layer ไม่มี Geometry ที่รองรับ');
    const invalid = supported.filter((feature) => {
      try { return typeof turf.booleanValid === 'function' && !turf.booleanValid(feature); }
      catch (_error) { return true; }
    }).length;
    if (invalid === supported.length) throw new Error(role + ' Layer มี Geometry ไม่ถูกต้อง');
    const emptyCount = layer.features.filter(geometryIsEmpty).length;
    const unsupportedCount = layer.features.length - supported.length - emptyCount;
    const skipped = emptyCount + unsupportedCount + invalid;
    if (skipped) summary.textContent = role + ' Layer: จะข้าม ' + skipped + ' features ที่ Geometry ว่าง ไม่รองรับ หรือไม่ถูกต้อง';
    const invalidSet = new Set();
    supported.forEach((feature) => {
      if (typeof turf.booleanValid !== 'function') return;
      try { if (!turf.booleanValid(feature)) invalidSet.add(feature); } catch (_error) { invalidSet.add(feature); }
    });
    return { ...layer, features: supported.filter((feature) => !invalidSet.has(feature)) };
  }
  function validateType(type, source, target) {
    if (!Object.prototype.hasOwnProperty.call(labels, type)) throw new Error('ไม่รู้จักประเภทการวิเคราะห์: ' + type);
    if (type !== 'buffer' && source.id === target.id) throw new Error('ไม่สามารถวิเคราะห์ Layer เดียวกันได้');
    if (type === 'point-in-polygon' && (!source.features.some(isPoint) || !target.features.some(isPolygon))) throw new Error('Point in Polygon ต้องใช้ Source เป็น Point และ Target เป็น Polygon');
    if (type === 'centroid-within' && (!source.features.some(isPolygon) || !target.features.some(isPolygon))) throw new Error('Centroid Within ต้องใช้ Polygon Layer ทั้ง Source และ Target');
    if (type === 'within' && !target.features.some(isPolygon)) throw new Error('Within ต้องใช้ Target Layer ที่เป็น Polygon');
    if (type === 'distance' && (!source.features.some((f) => isPoint(f) || isLine(f) || isPolygon(f)) || !target.features.some((f) => isPoint(f) || isLine(f) || isPolygon(f)))) throw new Error('Distance ใช้กับ Point, Line หรือ Polygon เท่านั้น');
  }

  function yieldToBrowser() { return new Promise((resolve) => setTimeout(resolve, 0)); }
  async function runAnalysis() {
    if (running) return;
    running = true; analysisRun.disabled = true; setStatus('กำลังตรวจสอบข้อมูลและชั้นข้อมูลที่เลือก...', 'loading');
    try {
      refreshLayers();
      if (!window.turf) throw new Error('โหลด Turf.js ไม่สำเร็จ กรุณาตรวจการเชื่อมต่อ CDN');
      const type = typeSelect.value;
      if (!Object.prototype.hasOwnProperty.call(labels, type)) throw new Error('กรุณาเลือก Analysis Type ที่รองรับ');
      const sourceLayer = getLayer(sourceSelect.value);
      const targetLayer = type === 'buffer' ? null : getLayer(targetSelect.value);
      const validSource = validateLayer(sourceLayer, 'Source');
      const validTarget = targetLayer ? validateLayer(targetLayer, 'Target') : null;
      if (type !== 'buffer' && !targetLayer) throw new Error('กรุณาเลือก Target Layer');
      if (targetLayer) validateType(type, validSource, validTarget);
      if (type === 'buffer' && !selectedFeature(sourceFeatureSelect, sourceSelect)) throw new Error('กรุณาเลือก Source Feature ที่ต้องการสร้าง Buffer');
      if (type === 'distance' && (!selectedFeature(sourceFeatureSelect, sourceSelect) || !selectedFeature(targetFeatureSelect, targetSelect))) throw new Error('กรุณาเลือก Source Feature และ Target Feature สำหรับ Distance');
      setStatus('กำลังวิเคราะห์ ' + labels[type] + ' — Source ' + sourceLayer.features.length.toLocaleString('th-TH') + ' features' + (targetLayer ? ', Target ' + targetLayer.features.length.toLocaleString('th-TH') + ' features' : '') + '…', 'loading');
      await yieldToBrowser();
      let found; let bufferDistance = null; let bufferUnit = '';
      if (!validSource.features.length || (validTarget && !validTarget.features.length)) throw new Error('ไม่พบ Geometry ที่ใช้วิเคราะห์ได้ใน Layer ที่เลือก');
      if (type === 'point-in-polygon') found = await pointInPolygonResults(validSource, validTarget);
      else if (type === 'within') found = await withinResults(type, validSource, validTarget);
      else if (type === 'intersect') found = await intersectResults(validSource, validTarget);
      else if (type === 'buffer') {
        const sourceFeature = selectedFeature(sourceFeatureSelect, sourceSelect);
        if (!sourceFeature) throw new Error('กรุณาเลือก Source Feature ที่ต้องการสร้าง Buffer');
        if (!validSource.features.includes(sourceFeature)) throw new Error('Feature ที่เลือกไม่มี Geometry ที่ใช้สร้าง Buffer ได้');
        bufferDistance = Number(bufferDistanceInput.value);
        if (!Number.isFinite(bufferDistance) || bufferDistance <= 0) throw new Error('ระยะ Buffer ต้องมากกว่า 0');
        bufferUnit = bufferUnitSelect.value;
        found = await bufferResults(sourceFeature, sourceLayer, bufferDistance, bufferUnit);
      } else if (type === 'centroid-within') found = await centroidResults(validSource, validTarget);
      else found = distanceResults(validSource, validTarget);
      await yieldToBrowser();
      if (!found.length) throw new Error(type === 'intersect' ? 'ไม่พบพื้นที่ซ้อนทับระหว่าง Layer ที่เลือก' : 'ไม่พบผลลัพธ์สำหรับเงื่อนไขนี้');
      const skippedInputCount = sourceLayer.features.length - validSource.features.length + (targetLayer ? targetLayer.features.length - validTarget.features.length : 0);
      const currentIds = window.LocalGIS.getLayers().map((layer) => layer.id);
      if (!currentIds.includes(sourceLayer.id) || (targetLayer && !currentIds.includes(targetLayer.id))) throw new Error('Layer ถูกลบระหว่างการวิเคราะห์ กรุณาเลือก Layer ใหม่');
      const record = addResult(type, sourceLayer, targetLayer, found, sourceLayer.features.length, bufferDistance, bufferUnit, skippedInputCount);
      setStatus('วิเคราะห์สำเร็จ — ' + found.length.toLocaleString('th-TH') + ' features ใน ' + record.name + '\n' + describeResult(record), 'success');
      window.LocalGIS.showMessage?.('วิเคราะห์เสร็จแล้ว ' + found.length.toLocaleString('th-TH') + ' features', 'success');
    } catch (error) {
      console.error('Spatial Analysis failed', error); setStatus('วิเคราะห์ไม่สำเร็จ: ' + (error.message || 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ'), 'error');
    } finally { running = false; analysisRun.disabled = false; }
  }

  function exportSelectedResult() {
    const record = results.get(resultSelect.value);
    if (!record) { summary.textContent = 'ไม่มี Result Layer ให้ส่งออก'; return; }
    const cleanFeatures = record.features.map((feature) => JSON.parse(JSON.stringify(feature)));
    const collection = { type: 'FeatureCollection', name: record.name, metadata: record.metadata, features: cleanFeatures };
    const blob = new Blob([JSON.stringify(collection, null, 2)], { type: 'application/geo+json;charset=utf-8' });
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
    anchor.href = url; anchor.download = record.name + '.geojson'; document.body.appendChild(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  typeSelect.addEventListener('change', updateModeUi);
  sourceSelect.addEventListener('change', () => { sourceFeatureSelect.value = ''; refreshFeatureChoices(); updateCrsWarning(); });
  targetSelect.addEventListener('change', () => { targetFeatureSelect.value = ''; refreshFeatureChoices(); updateCrsWarning(); });
  sourceFeatureSelect.addEventListener('change', refreshFeatureChoices);
  byId('analysis-run').addEventListener('click', runAnalysis);
  resultClear.addEventListener('click', clearResults);
  byId('analysis-zoom').addEventListener('click', () => zoomResult(resultSelect.value));
  resultExport.addEventListener('click', exportSelectedResult);
  resultSelect.addEventListener('change', updateSelectedResultPanel);
  window.addEventListener('localgis:layerschange', refreshLayers);
  refreshLayers(); updateModeUi();
})();
