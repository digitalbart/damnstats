(function () {
  const data = window.DAM_WATCH_DATA;
  const ui = window.DamWatchComponents;
  const MICHIGAN_CENTER = data.michiganCenter;
  const CACHE_TTL_MS = 60 * 60 * 1000;
  const INVENTORY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const CACHE_PREFIX = 'dam-watch-v3';

  const state = {
    map: null,
    markersLayer: null,
    selectedLabelLayer: null,
    alertLayer: null,
    impactLayer: null,
    radarLayer: null,
    stageChart: null,
    chartView: 'dots',
    allDams: [],
    baseDams: [],
    baseGauges: [],
    nimsCameras: [],
    activeAlerts: [],
    floodingImpactFeatures: [],
    weatherOutlook: null,
    selectedDamId: null,
    viewportMode: 'map',
    alertFetchedAt: null,
    weatherFetchedAt: null,
    gaugeFetchedAt: null,
    shouldRevealSelectedCard: false,
    sidebarGaugeHydrating: false,
    sidebarSelection: false,
  };

  const $ = (id) => document.getElementById(id);

  function safeNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || Math.abs(number) > 99999 || number <= -998) return null;
    return number;
  }

  function cacheKey(type, site) {
    return `${CACHE_PREFIX}:${type}:${site.id}`;
  }

  function readCache(key) {
    try {
      const cached = JSON.parse(localStorage.getItem(key) || 'null');
      if (!cached || !cached.fetchedAt || Date.now() - cached.fetchedAt > CACHE_TTL_MS) return null;
      return cached;
    } catch (error) {
      return null;
    }
  }

  function writeCache(key, payload) {
    try {
      localStorage.setItem(key, JSON.stringify({ ...payload, fetchedAt: Date.now() }));
    } catch (error) {
      // Cache writes can fail in private browsing or strict storage modes.
    }
  }

  function readFreshCache(key, ttlMs) {
    try {
      const cached = JSON.parse(localStorage.getItem(key) || 'null');
      if (!cached || !cached.fetchedAt || Date.now() - cached.fetchedAt > ttlMs) return null;
      return cached;
    } catch (error) {
      return null;
    }
  }

  function cacheAgeLabel(fetchedAt) {
    if (!fetchedAt) return 'not fetched yet';
    const minutes = Math.max(0, Math.round((Date.now() - fetchedAt) / 60000));
    if (minutes < 1) return 'just now';
    if (minutes === 1) return '1 minute ago';
    if (minutes < 60) return `${minutes} minutes ago`;
    const hours = Math.round(minutes / 60);
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }

  function cacheAgeTone(fetchedAt) {
    if (!fetchedAt) return 'empty';
    const minutes = Math.max(0, Math.round((Date.now() - fetchedAt) / 60000));
    if (minutes <= 10) return 'fresh';
    if (minutes <= 60) return 'ok';
    return 'stale';
  }

  function freshnessItems(site) {
    const gaugeFetchedAt = state.gaugeFetchedAt || site?.liveGaugeFetchedAt || null;
    return [
      {
        label: 'Gauge',
        age: site?.linkedGaugeId ? cacheAgeLabel(gaugeFetchedAt) : 'no gauge',
        tone: site?.linkedGaugeId ? cacheAgeTone(gaugeFetchedAt) : 'empty',
      },
      {
        label: 'NWS',
        age: cacheAgeLabel(state.alertFetchedAt),
        tone: cacheAgeTone(state.alertFetchedAt),
      },
      {
        label: 'Weather',
        age: cacheAgeLabel(state.weatherFetchedAt),
        tone: cacheAgeTone(state.weatherFetchedAt),
      },
    ];
  }

  function applyInitialUrlState() {
    const params = new URLSearchParams(window.location.search);
    const dam = params.get('dam');
    const view = params.get('view');

    if (['map', 'radar', 'cameras'].includes(view)) state.viewportMode = view;
    if (dam) state.selectedDamId = dam;
  }

  function updateUrlState() {
    const params = new URLSearchParams(window.location.search);
    if (state.selectedDamId) params.set('dam', state.selectedDamId);
    if (state.viewportMode) params.set('view', state.viewportMode);
    const nextUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, '', nextUrl);
  }

  function riverKey(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/\bst[.]?\b/g, 'saint')
      .replace(/\b(river|creek|branch|shoreline)\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function isSameRiver(dam, gauge) {
    const damRiver = riverKey(dam.river);
    const gaugeName = riverKey(gauge.name);
    return Boolean(damRiver && gaugeName && gaugeName.includes(damRiver));
  }

  function haversineMiles(lat1, lon1, lat2, lon2) {
    const toRad = (value) => value * Math.PI / 180;
    const radius = 3958.8;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * radius * Math.asin(Math.sqrt(a));
  }

  function isInteresting(site) {
    return Boolean(site.hazard || site.condition || site.linkedGaugeId || site.countyAlertCount || site.owner || site.cameraFeeds?.length);
  }

  function isHydroSite(site) {
    return /hydro/i.test(`${site.purposes || ''} ${site.owner || ''} ${site.damType || ''}`);
  }

  function attentionScore(site) {
    let score = 0;
    const hazard = String(site.hazard || '').toLowerCase();
    const condition = String(site.condition || '').toLowerCase();

    if (hazard.includes('high')) score += 10;
    else if (hazard.includes('significant')) score += 6;
    else if (hazard.includes('low')) score += 2;

    if (condition.includes('poor') || condition.includes('unsatisfactory')) score += 8;
    else if (condition.includes('fair')) score += 4;
    else if (condition.includes('good')) score += 1;

    if (site.linkedGaugeId) {
      if (site.gaugeConfidence === 'high') score += 4;
      else if (site.gaugeConfidence === 'medium') score += 2;
      else if (site.gaugeConfidence === 'context') score += 1;
      else score += 1;
    }

    if (site.cameraFeeds?.length) score += Math.min(5, site.cameraFeeds.length + 2);
    if (site.countyAlertCount) score += Math.min(6, site.countyAlertCount * 2);

    const floodPercent = Number(site.floodPercent);
    if (Number.isFinite(floodPercent)) {
      if (floodPercent >= 100) score += 12;
      else if (floodPercent >= 90) score += 8;
      else if (floodPercent >= 75) score += 4;
    }

    return score;
  }

  function riskClass(site) {
    const score = attentionScore(site);
    if (score >= 16) return 'high';
    if (score >= 9) return 'medium';
    if (score >= 3) return 'light';
    return 'normal';
  }

  function riskLabel(site) {
    const risk = riskClass(site);
    if (risk === 'high') return 'high';
    if (risk === 'medium') return 'watch';
    if (risk === 'light') return 'linked';
    return 'normal';
  }

  function markerColor(site) {
    const risk = riskClass(site);
    if (risk === 'high') return '#ff7d95';
    if (risk === 'medium') return '#f6c96b';
    if (risk === 'light') return '#7de8e0';
    return '#79f2b2';
  }

  function markerSize(site) {
    const risk = riskClass(site);
    if (risk === 'high') return 18;
    if (risk === 'medium') return 15;
    if (risk === 'light') return 13;
    return 10;
  }

  function hasCoords(site) {
    return Number.isFinite(site?.lat) && Number.isFinite(site?.lon);
  }

  function cleanLookupText(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/\bst[.]?\b/g, 'saint')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b(dam|number|no|the)\b/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function coreName(value) {
    return cleanLookupText(value).replace(/\b(city|upper|lower|west|side|falls|bridge)\b/g, ' ').trim().replace(/\s+/g, ' ');
  }

  function countyMatches(source, match) {
    const sourceCounty = cleanLookupText(source.County || source.county);
    const matchCounty = cleanLookupText(match.County || match.county);
    return !sourceCounty || !matchCounty || sourceCounty === matchCounty;
  }

  function riverMatches(source, match) {
    const sourceRiver = cleanLookupText(source.River || source.river);
    const matchRiver = cleanLookupText(match.River || match.river);
    if (!sourceRiver || !matchRiver) return true;
    if (sourceRiver === matchRiver || sourceRiver.includes(matchRiver) || matchRiver.includes(sourceRiver)) return true;

    const sourceWords = new Set(sourceRiver.split(' ').filter((word) => word.length > 3));
    const shared = matchRiver.split(' ').filter((word) => sourceWords.has(word));
    return shared.length > 0;
  }

  function inventoryScore(source, match) {
    if (!countyMatches(source, match) || !riverMatches(source, match)) return -1;

    const targetName = coreName(source.DamName || source.name);
    const matchNames = [match.DamName, match.OtherDamNames].map(coreName).filter(Boolean);
    let score = 0;
    if (matchNames.some((name) => name === targetName)) score += 8;
    else if (matchNames.some((name) => name.includes(targetName) || targetName.includes(name))) score += 5;

    if (cleanLookupText(source.County || source.county) && countyMatches(source, match)) score += 2;
    if (cleanLookupText(source.River || source.river) && riverMatches(source, match)) score += 2;
    if (/hydro/i.test(`${source.Purposes || ''} ${match.Purposes || ''}`)) score += 1;
    return score;
  }

  function mergeInventoryFields(source, match) {
    if (!match) return source;
    return {
      ...source,
      Dam_ID: source.Dam_ID || match.Dam_ID,
      DamName: source.DamName || match.DamName,
      County: source.County || match.County,
      River: source.River || match.River,
      OwnerName: source.OwnerName || match.OwnerName,
      DownstreamHazardPotential: source.DownstreamHazardPotential || match.DownstreamHazardPotential,
      ConditionAssessment: source.ConditionAssessment || match.ConditionAssessment,
      Latitude: source.Latitude ?? match.Latitude,
      Longitude: source.Longitude ?? match.Longitude,
      DamType: source.DamType || match.DamType,
      Purposes: source.Purposes || match.Purposes,
      inventorySource: match.Dam_ID ? 'EGLE Dam Inventory' : source.inventorySource,
      damInventoryUrl: match.Dam_ID
        ? `${data.links.egleFeatureLayer}/${encodeURIComponent(match.OBJECTID || '')}`
        : source.damInventoryUrl,
    };
  }

  async function fetchInventoryMatch(source) {
    if (!data.links.egleFeatureServer) return null;

    const key = `${CACHE_PREFIX}:egle:${source.id || cleanLookupText(source.DamName || source.name)}`;
    const cached = readFreshCache(key, INVENTORY_CACHE_TTL_MS);
    if (cached) return cached.match || null;

    const target = coreName(source.DamName || source.name);
    if (!target) return null;
    const terms = target.split(' ').filter((word) => word.length > 2).slice(0, 3);
    if (!terms.length) return null;

    const like = terms.map((term) => `UPPER(DamName) LIKE '%${term.toUpperCase()}%'`).join(' AND ');
    const aliasLike = terms.map((term) => `UPPER(OtherDamNames) LIKE '%${term.toUpperCase()}%'`).join(' AND ');
    const where = `(${like}) OR (${aliasLike})`;
    const params = new URLSearchParams({
      f: 'json',
      where,
      outFields: 'OBJECTID,Dam_ID,DamName,OtherDamNames,County,River,Latitude,Longitude,OwnerName,DownstreamHazardPotential,ConditionAssessment,DamType,Purposes',
      returnGeometry: 'false',
      orderByFields: 'DamName',
      resultRecordCount: '25',
    });

    try {
      const response = await fetch(`${data.links.egleFeatureServer}?${params.toString()}`);
      if (!response.ok) throw new Error(`EGLE ${response.status}`);
      const json = await response.json();
      const candidates = (json.features || [])
        .map((feature) => feature.attributes || {})
        .map((match) => ({ match, score: inventoryScore(source, match) }))
        .filter((item) => item.score >= 8)
        .sort((a, b) => b.score - a.score);
      const match = candidates[0]?.match || null;
      writeCache(key, { match });
      return match;
    } catch (error) {
      return null;
    }
  }

  async function enrichDamsFromInventory(rows) {
    const enriched = await Promise.all(rows.map(async (row) => {
      const source = row.attributes || row;
      const needsInventory = source.Latitude === null
        || source.Longitude === null
        || !source.DownstreamHazardPotential
        || !source.ConditionAssessment
        || !source.DamType;
      if (!needsInventory) return row;

      const match = await fetchInventoryMatch(source);
      return mergeInventoryFields(source, match);
    }));
    return enriched;
  }

  function normalizeDams(rows) {
    return rows.map((row, index) => {
      const src = row.attributes || row;
      const id = src.id || `dam-${src.Dam_ID || index + 1}`;
      const cameraFeeds = data.cameraFeeds.filter((feed) => feed.relatedDamIds.includes(id));
      const cameraFeed = cameraFeeds[0] || null;
      const lat = safeNumber(src.Latitude ?? src.lat);
      const lon = safeNumber(src.Longitude ?? src.lon);

      return {
        id,
        kind: 'dam',
        name: src.DamName || src.name || 'Unnamed dam',
        county: src.County || src.county || 'Unknown county',
        river: src.River || src.river || null,
        owner: src.OwnerName || src.owner || null,
        hazard: src.DownstreamHazardPotential || src.hazard || null,
        condition: src.ConditionAssessment || src.condition || null,
        damType: src.DamType || src.damType || null,
        purposes: src.Purposes || src.purposes || null,
        lat,
        lon,
        currentStage: null,
        forecastStage: null,
        stageTrend: [],
        stageLabels: [],
        rtfiImpacts: [],
        rtfiFloodingCount: 0,
        linkedGaugeId: null,
        linkedGaugeName: null,
        linkedGaugeMiles: null,
        gaugeRelation: 'none',
        gaugeConfidence: 'none',
        countyAlertCount: 0,
        cameraFeed,
        cameraFeeds,
        nimsCameras: [],
        sourceLinks: {
          damInventory: src.damInventoryUrl || data.links.egle,
          camera: lat !== null && lon !== null ? `${data.links.mdot}?lat=${lat}&lon=${lon}&zoom=12` : data.links.mdot,
          usgsWebcams: data.links.usgsWebcams,
          noaa: data.links.noaa,
          egle: data.links.egle,
          dnr: data.links.dnr,
          nws: data.links.nws,
          webcam: src.WebcamUrl || cameraFeed?.pageUrl || null,
          webcamEmbed: src.WebcamEmbed || cameraFeed?.embedUrl || null,
        },
      };
    });
  }

  function normalizeGauges(rows) {
    return rows.map((series, index) => {
      const info = series.sourceInfo || series.source || series;
      const rawValues = Array.isArray(series.values) ? series.values : (series.values?.[0]?.value || []);
      const values = rawValues.map((value) => ({
        value: safeNumber(value.value ?? value.stage),
        dateTime: value.dateTime || value.time || null,
      })).filter((value) => value.value !== null);

      const trend = values.slice(-18).map((value) => value.value);
      const labels = values.slice(-18).map((value) => (
        value.dateTime ? new Date(value.dateTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
      ));
      const usgsId = info.siteCode?.[0]?.value || info.usgsId || null;
      const nwpsLid = info.nwpsLid || series.nwpsLid || null;
      const floodStage = safeNumber(series.floodStage ?? series.floodStageFt ?? info.floodStage ?? info.floodStageFt);

      return {
        id: `gauge-${usgsId || index}`,
        usgsId,
        nwpsLid,
        name: info.siteName || info.name || 'USGS gauge',
        lat: safeNumber(info.geoLocation?.geogLocation?.latitude ?? info.lat),
        lon: safeNumber(info.geoLocation?.geogLocation?.longitude ?? info.lon),
        currentStage: trend.length ? trend[trend.length - 1] : null,
        forecastStage: trend.length ? Math.max(...trend.slice(-6)) : null,
        floodStage,
        stageTrend: trend,
        stageLabels: labels,
        observedUpdated: values.length ? values[values.length - 1].dateTime : null,
        sourceLinks: {
          usgs: usgsId ? `https://waterdata.usgs.gov/monitoring-location/${usgsId}/` : data.links.usgsWebcams,
        },
      };
    }).filter((gauge) => gauge.lat !== null && gauge.lon !== null);
  }

  function normalizeOgcLatestStages(payload) {
    const rows = Array.isArray(payload?.features) ? payload.features : [];
    return rows.map((feature, index) => {
      const props = feature.properties || {};
      const coords = feature.geometry?.coordinates || [];
      const usgsId = String(props.monitoring_location_id || '').replace(/^USGS-/, '') || null;
      const value = safeNumber(props.value);
      const lat = safeNumber(coords[1]);
      const lon = safeNumber(coords[0]);
      if (!usgsId || value === null || lat === null || lon === null) return null;
      const label = props.time ? new Date(props.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';

      return {
        id: `gauge-${usgsId || index}`,
        usgsId,
        nwpsLid: null,
        name: `USGS ${usgsId}`,
        lat,
        lon,
        currentStage: value,
        forecastStage: value,
        floodStage: null,
        stageTrend: [value],
        stageLabels: [label],
        observedUpdated: props.time || null,
        sourceLinks: {
          usgs: `https://waterdata.usgs.gov/monitoring-location/${usgsId}/`,
        },
      };
    }).filter(Boolean);
  }

  function normalizeNwpsGaugeIndex(payload) {
    const rows = Array.isArray(payload?.gauges) ? payload.gauges : [];
    return rows.map((gauge) => {
      const stateCode = gauge.state?.abbreviation || '';
      if (stateCode !== 'MI') return null;

      const lid = gauge.lid || null;
      const observed = safeNumber(gauge.status?.observed?.primary);
      const forecast = safeNumber(gauge.status?.forecast?.primary);
      const currentStage = observed ?? forecast;
      const forecastStage = forecast ?? observed;
      const observedTime = gauge.status?.observed?.validTime || null;
      const forecastTime = gauge.status?.forecast?.validTime || null;
      const labelTime = observedTime || forecastTime;
      const label = labelTime ? new Date(labelTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';

      return {
        id: `nwps-${lid}`,
        usgsId: null,
        nwpsLid: lid,
        name: gauge.name || `NWPS ${lid}`,
        lat: safeNumber(gauge.latitude),
        lon: safeNumber(gauge.longitude),
        currentStage,
        forecastStage,
        floodStage: null,
        stageTrend: currentStage !== null ? [currentStage] : [],
        stageLabels: currentStage !== null ? [label] : [],
        observedUpdated: observedTime || forecastTime || null,
        sourceLinks: {
          noaaGauge: lid ? `https://water.noaa.gov/gauges/${encodeURIComponent(lid)}` : data.links.noaa,
        },
      };
    }).filter((gauge) => gauge?.nwpsLid && gauge.lat !== null && gauge.lon !== null);
  }

  function mergeGaugeSets(localGauges, liveGauges) {
    const byId = new Map();
    liveGauges.forEach((gauge) => byId.set(gauge.usgsId || gauge.id, gauge));
    localGauges.forEach((gauge) => {
      const key = gauge.usgsId || gauge.id;
      const live = byId.get(key);
      byId.set(key, live ? {
        ...live,
        name: gauge.name || live.name,
        nwpsLid: gauge.nwpsLid || live.nwpsLid,
        floodStage: gauge.floodStage ?? live.floodStage,
        stageTrend: gauge.stageTrend?.length > 1 ? gauge.stageTrend : live.stageTrend,
        stageLabels: gauge.stageLabels?.length > 1 ? gauge.stageLabels : live.stageLabels,
        sourceLinks: { ...live.sourceLinks, ...gauge.sourceLinks },
      } : gauge);
    });
    return Array.from(byId.values());
  }

  function normalizeNimsCameras(rows) {
    return rows.map((camera) => ({
      id: camera.id || camera.camId,
      camId: camera.camId,
      nwisId: camera.nwisId || null,
      label: camera.label || camera.camName || 'USGS camera',
      provider: camera.provider || 'USGS NIMS',
      view: camera.view || camera.camDesc || 'Official USGS river camera snapshot.',
      lat: safeNumber(camera.lat),
      lon: safeNumber(camera.lon ?? camera.lng),
      pageUrl: camera.pageUrl || (camera.nwisId ? `https://waterdata.usgs.gov/monitoring-location/${camera.nwisId}/` : data.links.usgsWebcams),
      smallDir: camera.smallDir || null,
      thumbDir: camera.thumbDir || null,
      tlDir: camera.tlDir || null,
      timelapseUrl: camera.timelapseUrl || (camera.tlDir && camera.camId ? `${camera.tlDir}${camera.camId}_720.mp4` : null),
      imageUrl: camera.imageUrl || null,
      imageTime: camera.imageTime || null,
      newestImageDT: camera.newestImageDT || null,
    })).filter((camera) => camera.camId && camera.lat !== null && camera.lon !== null);
  }

  function attachNimsCameras(sites, cameras) {
    return sites.map((site) => {
      if (!hasCoords(site)) return { ...site, nimsCameras: [] };
      const nearby = cameras.map((camera) => ({
        ...camera,
        distanceMiles: Number(haversineMiles(site.lat, site.lon, camera.lat, camera.lon).toFixed(1)),
      })).filter((camera) => (
        camera.nwisId === site.linkedGaugeUsgsId
        || camera.distanceMiles <= 8
      )).sort((a, b) => {
        if (a.nwisId === site.linkedGaugeUsgsId && b.nwisId !== site.linkedGaugeUsgsId) return -1;
        if (b.nwisId === site.linkedGaugeUsgsId && a.nwisId !== site.linkedGaugeUsgsId) return 1;
        return a.distanceMiles - b.distanceMiles;
      });
      return { ...site, nimsCameras: nearby.slice(0, 1) };
    });
  }

  function normalizeAlerts(rows) {
    return rows.map((feature, index) => {
      const props = feature.properties || feature;
      return {
        id: feature.id || `alert-${index}`,
        event: props.event || 'Alert',
        severity: props.severity || 'Unknown',
        headline: props.headline || props.description || '',
        description: props.description || '',
        areaDesc: props.areaDesc || '',
        sent: props.sent || props.effective || null,
        web: props['@id'] || feature.id || props.id || null,
        geometry: feature.geometry || props.geometry || null,
      };
    });
  }

  function normalizeRtfiFeatures(payload) {
    const rows = Array.isArray(payload?.features) ? payload.features : (Array.isArray(payload) ? payload : []);
    return rows.map((feature, index) => {
      const props = feature.properties || feature;
      const coords = feature.geometry?.coordinates || [];
      const lon = safeNumber(coords[0] ?? props.longitude ?? props.lon);
      const lat = safeNumber(coords[1] ?? props.latitude ?? props.lat);
      const elevation = safeNumber(props.rp_elevation ?? props.elevation);
      const gageHeight = safeNumber(props.gage_height ?? props.gageHeight);
      return {
        id: String(props.rp_id || props.id || `rtfi-${index}`),
        name: props.rp_name || props.name || 'Impact point',
        siteName: props.site_name || props.siteName || '',
        description: props.description || '',
        nwisId: props.nwis_id || props.nwisId || null,
        nwsId: props.nws_id || props.nwsId || null,
        unit: props.unit || 'ft',
        elevation,
        gageHeight,
        isFlooding: Boolean(props.is_flooding ?? props.isFlooding),
        active: props.active !== false,
        lat,
        lon,
        raw: feature,
      };
    }).filter((feature) => feature.lat !== null && feature.lon !== null);
  }

  function normalizeWeatherOutlook(periods) {
    const nextPeriods = periods.slice(0, 36);
    const popValues = nextPeriods
      .map((period) => safeNumber(period.probabilityOfPrecipitation?.value))
      .filter((value) => value !== null);
    const wetPattern = /rain|showers|thunderstorm|storm|drizzle|snow|sleet/i;
    const wetPeriod = nextPeriods.find((period) => {
      const pop = safeNumber(period.probabilityOfPrecipitation?.value) || 0;
      return pop >= 40 || wetPattern.test(`${period.shortForecast || ''} ${period.detailedForecast || ''}`);
    });
    const first = nextPeriods[0] || {};
    const maxPop = popValues.length ? Math.max(...popValues) : null;
    const summaryPeriod = wetPeriod || first;
    const summary = summaryPeriod.shortForecast || summaryPeriod.detailedForecast || 'No nearby forecast text available.';
    const pop = safeNumber(summaryPeriod.probabilityOfPrecipitation?.value);

    return {
      summary,
      maxPop,
      periodName: summaryPeriod.name || first.name || 'next period',
      precipText: pop !== null ? `${pop}% precipitation` : (maxPop !== null ? `${maxPop}% peak precipitation` : 'precipitation unknown'),
    };
  }

  function normalizeUsgsValues(json) {
    const series = json?.value?.timeSeries?.[0];
    const values = series?.values?.[0]?.value || [];
    return values.map((item) => ({
      value: safeNumber(item.value),
      dateTime: item.dateTime || null,
    })).filter((item) => item.value !== null);
  }

  function normalizeNwpsStageSeries(series, limit, edge = 'last') {
    const rows = Array.isArray(series?.data) ? series.data : [];
    const values = rows.map((item) => ({
      value: safeNumber(item.primary),
      dateTime: item.validTime || null,
    })).filter((item) => item.value !== null && item.dateTime);
    return edge === 'first' ? values.slice(0, limit) : values.slice(-limit);
  }

  function compactNwpsStageFlow(stageflow) {
    return {
      observed: {
        ...stageflow?.observed,
        data: (stageflow?.observed?.data || []).slice(-96),
      },
      forecast: {
        ...stageflow?.forecast,
        data: (stageflow?.forecast?.data || []).slice(0, 96),
      },
    };
  }

  function applyNwpsStageFlow(site, stageflow, fetchedAt) {
    if (!site || !stageflow) return;
    const observed = normalizeNwpsStageSeries(stageflow.observed, 96, 'last');
    const forecast = normalizeNwpsStageSeries(stageflow.forecast, 96, 'first');

    site.nwpsObservedSeries = observed;
    site.nwpsForecastSeries = forecast;
    site.nwpsStageFlowFetchedAt = fetchedAt;

    const latestObserved = observed[observed.length - 1];
    const maxForecast = forecast.length ? Math.max(...forecast.map((item) => item.value)) : null;
    const forecastStage = maxForecast ?? latestObserved?.value ?? site.forecastStage;
    const stats = floodStats(site.floodStage, forecastStage);

    if (latestObserved) {
      site.currentStage = latestObserved.value;
      site.observedUpdated = latestObserved.dateTime;
    }
    site.forecastStage = forecastStage;
    site.floodStage = stats.floodStage;
    site.floodPercent = stats.floodPercent;
    site.floodDistance = stats.floodDistance;
  }

  function floodStats(floodStage, forecastStage) {
    const flood = safeNumber(floodStage);
    const forecast = safeNumber(forecastStage);
    if (flood === null || forecast === null || flood <= 0) {
      return { floodStage: flood, floodPercent: null, floodDistance: null };
    }

    return {
      floodStage: flood,
      floodPercent: Number(((forecast / flood) * 100).toFixed(0)),
      floodDistance: Number((flood - forecast).toFixed(1)),
    };
  }

  function applyFloodStageFromAlerts(site, alerts) {
    if (!site || site.floodStage || !alerts?.length) return;
    const text = alerts.map((alert) => `${alert.headline || ''} ${alert.description || ''}`).join('\n');
    const match = text.match(/flood stage (?:is|of)\s+(\d+(?:\.\d+)?)\s+feet/i);
    const floodStage = match ? safeNumber(match[1]) : null;
    if (!floodStage) return;

    const stats = floodStats(floodStage, site.forecastStage);
    site.floodStage = stats.floodStage;
    site.floodPercent = stats.floodPercent;
    site.floodDistance = stats.floodDistance;
  }

  function applyNwpsGauge(site, gauge, fetchedAt) {
    if (!site || !gauge) return;
    const observed = safeNumber(gauge.status?.observed?.primary);
    const forecast = safeNumber(gauge.status?.forecast?.primary);
    const floodStage = safeNumber(gauge.flood?.categories?.minor?.stage);
    const currentStage = observed ?? site.currentStage;
    const forecastStage = forecast ?? site.forecastStage ?? currentStage;
    const stats = floodStats(floodStage ?? site.floodStage, forecastStage);

    site.currentStage = currentStage;
    site.forecastStage = forecastStage;
    site.floodStage = stats.floodStage;
    site.floodPercent = stats.floodPercent;
    site.floodDistance = stats.floodDistance;
    site.observedUpdated = gauge.status?.observed?.validTime || site.observedUpdated || null;
    site.liveGaugeFetchedAt = fetchedAt;
    site.forecastSource = 'nwps';
    site.nwpsLid = gauge.lid || site.linkedGaugeNwpsLid;
    site.linkedGaugeNwpsLid = site.nwpsLid || site.linkedGaugeNwpsLid;
    site.linkedGaugeUsgsId = gauge.usgsId || site.linkedGaugeUsgsId;
    site.nwpsGaugeName = gauge.name || site.linkedGaugeName;
    site.linkedGaugeName = site.nwpsGaugeName || site.linkedGaugeName;
    site.nwpsHydrographUrl = gauge.images?.hydrograph?.default || null;
    site.nwpsFloodcatUrl = gauge.images?.hydrograph?.floodcat || null;
    site.nwpsFloodCategories = gauge.flood?.categories || null;
    site.nwpsTabularUrl = gauge.lid ? `https://water.noaa.gov/gauges/${encodeURIComponent(gauge.lid)}/tabular` : null;
    site.sourceLinks = {
      ...site.sourceLinks,
      noaaGauge: gauge.lid ? `https://water.noaa.gov/gauges/${encodeURIComponent(gauge.lid)}` : site.sourceLinks?.noaaGauge,
    };
    state.gaugeFetchedAt = fetchedAt;
  }

  function applyGaugeValues(site, values, fetchedAt) {
    if (!values.length) return;
    const recent = values.slice(-18);
    const trend = recent.map((item) => item.value);
    const labels = recent.map((item) => (
      item.dateTime ? new Date(item.dateTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
    ));
    const currentStage = trend[trend.length - 1];
    const forecastStage = site.forecastSource === 'nwps' && site.forecastStage !== null && site.forecastStage !== undefined
      ? site.forecastStage
      : Math.max(...trend.slice(-6));
    const stats = floodStats(site.floodStage, forecastStage);

    site.currentStage = currentStage;
    site.forecastStage = forecastStage;
    site.floodStage = stats.floodStage;
    site.floodPercent = stats.floodPercent;
    site.floodDistance = stats.floodDistance;
    site.stageTrend = trend;
    site.stageLabels = labels;
    site.observedUpdated = values[values.length - 1].dateTime;
    site.liveGaugeFetchedAt = fetchedAt;
    state.gaugeFetchedAt = fetchedAt;
  }

  function mergeDamsAndGauges(dams, gauges, alerts) {
    return dams.map((dam) => {
      let nearest = null;
      let bestDist = Infinity;
      let sameRiver = null;
      let sameRiverDist = Infinity;

      if (hasCoords(dam)) {
        gauges.forEach((gauge) => {
          const miles = haversineMiles(dam.lat, dam.lon, gauge.lat, gauge.lon);
          if (miles < bestDist) {
            bestDist = miles;
            nearest = gauge;
          }
          if (isSameRiver(dam, gauge) && miles < sameRiverDist) {
            sameRiverDist = miles;
            sameRiver = gauge;
          }
        });
      }

      const countyName = String(dam.county || '').toLowerCase();
      const countyAlertCount = alerts.filter((alert) => String(alert.areaDesc || '').toLowerCase().includes(countyName)).length;

      const linkedGauge = nearest && bestDist <= 6 ? nearest : sameRiver;
      const linkedDistance = nearest && bestDist <= 6 ? bestDist : sameRiverDist;
      const gaugeRelation = nearest && bestDist <= 6 ? 'nearby' : 'river-context';

      if (!linkedGauge || linkedDistance > 35) {
        return { ...dam, countyAlertCount, floodStage: null, floodPercent: null, floodDistance: null };
      }

      const currentStage = safeNumber(linkedGauge.currentStage);
      const forecastStage = safeNumber(linkedGauge.forecastStage);
      const stats = floodStats(linkedGauge.floodStage, forecastStage);

      return {
        ...dam,
        linkedGaugeId: linkedGauge.id,
        linkedGaugeUsgsId: linkedGauge.usgsId || null,
        linkedGaugeNwpsLid: linkedGauge.nwpsLid || null,
        linkedGaugeName: linkedGauge.name,
        linkedGaugeMiles: Number(linkedDistance.toFixed(1)),
        gaugeRelation,
        gaugeConfidence: linkedDistance <= 2 ? 'high' : linkedDistance <= 6 ? 'medium' : 'context',
        currentStage,
        forecastStage,
        floodStage: stats.floodStage,
        floodPercent: stats.floodPercent,
        floodDistance: stats.floodDistance,
        stageTrend: linkedGauge.stageTrend || [],
        stageLabels: linkedGauge.stageLabels || [],
        observedUpdated: linkedGauge.observedUpdated || null,
        countyAlertCount,
        sourceLinks: {
          ...dam.sourceLinks,
          usgs: linkedGauge.sourceLinks?.usgs || null,
          noaaGauge: linkedGauge.sourceLinks?.noaaGauge || (linkedGauge.nwpsLid ? `https://water.noaa.gov/gauges/${encodeURIComponent(linkedGauge.nwpsLid)}` : data.links.noaa),
        },
      };
    });
  }

  function getFilteredDams() {
    const query = $('searchInput').value.trim().toLowerCase();
    const quickView = $('quickView').value;
    const sortMode = $('sortMode').value;
    const hideNoGauge = Boolean($('hideNoGaugeInput')?.checked);

    const dams = state.allDams.filter((site) => {
      if (hideNoGauge && !site.linkedGaugeId) return false;
      if (quickView === 'watch' && !isInteresting(site)) return false;
      if (quickView === 'hydro' && !isHydroSite(site)) return false;
      if (quickView === 'linked' && !site.linkedGaugeId) return false;
      if (quickView === 'camera' && !site.cameraFeeds?.length && !site.nimsCameras?.length) return false;
      if (!query) return true;

      const haystack = [
        site.name,
        site.county,
        site.river,
        site.owner,
        site.hazard,
        site.condition,
        site.linkedGaugeName,
        site.damType,
        site.purposes,
        ...(site.cameraFeeds || []).map((feed) => feed.label),
        ...(site.nimsCameras || []).map((camera) => camera.label),
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(query);
    });

    const floodSortValue = (site) => {
      if (site.floodDistance === null || site.floodDistance === undefined) return 9999;
      if (site.floodDistance <= 0) return site.floodDistance - 1000;
      return site.floodDistance;
    };

    dams.sort((a, b) => {
      const byName = String(a.name || '').localeCompare(String(b.name || ''));
      if (sortMode === 'flood') return floodSortValue(a) - floodSortValue(b) || attentionScore(b) - attentionScore(a) || byName;
      if (sortMode === 'gauge') return (a.linkedGaugeMiles ?? 999) - (b.linkedGaugeMiles ?? 999) || attentionScore(b) - attentionScore(a) || byName;
      if (sortMode === 'danger') return attentionScore(b) - attentionScore(a) || floodSortValue(a) - floodSortValue(b) || byName;
      if (quickView === 'camera') return ((b.cameraFeeds?.length || 0) + (b.nimsCameras?.length || 0)) - ((a.cameraFeeds?.length || 0) + (a.nimsCameras?.length || 0)) || attentionScore(b) - attentionScore(a);
      if (quickView === 'hydro') return String(a.river || '').localeCompare(String(b.river || '')) || String(a.name || '').localeCompare(String(b.name || ''));
      return byName;
    });

    return dams;
  }

  function initMap() {
    state.map = L.map('map', { zoomControl: true }).setView(MICHIGAN_CENTER, 7);
    state.map.createPane('hydroPane');
    state.map.getPane('hydroPane').style.zIndex = 250;
    state.map.createPane('radarPane');
    state.map.getPane('radarPane').style.zIndex = 450;
    state.map.createPane('alertPane');
    state.map.getPane('alertPane').style.zIndex = 500;
    state.map.createPane('impactPane');
    state.map.getPane('impactPane').style.zIndex = 520;
    const openStreetMap = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(state.map);
    const usgsTopo = L.tileLayer(data.links.usgsTopoTiles, {
      maxZoom: 16,
      attribution: 'USGS The National Map',
    });
    const usgsImagery = L.tileLayer(data.links.usgsImageryTiles, {
      maxZoom: 16,
      attribution: 'USGS The National Map',
    });
    state.radarLayer = L.tileLayer.wms(data.links.radarWms, {
      layers: 'nexrad-n0r',
      format: 'image/png',
      transparent: true,
      opacity: 0.62,
      pane: 'radarPane',
      attribution: 'Radar &copy; Iowa Environmental Mesonet',
    });
    const hydroLayer = L.tileLayer.wms(data.links.hydroWms, {
      layers: '0',
      format: 'image/png',
      transparent: true,
      opacity: 0.72,
      pane: 'hydroPane',
      attribution: 'Hydrography &copy; USGS The National Map',
    }).addTo(state.map);
    L.control.layers({
      'USGS Topo': usgsTopo,
      'Imagery': usgsImagery,
      'OpenStreetMap': openStreetMap,
    }, {
      Hydro: hydroLayer,
    }, {
      collapsed: true,
      position: 'topleft',
    }).addTo(state.map);
    state.markersLayer = L.layerGroup().addTo(state.map);
    state.selectedLabelLayer = L.layerGroup().addTo(state.map);
    state.alertLayer = L.layerGroup().addTo(state.map);
    state.impactLayer = L.layerGroup().addTo(state.map);
  }

  function alertStyle(alert) {
    const severe = /extreme|severe/i.test(alert.severity || '');
    return {
      pane: 'alertPane',
      color: severe ? '#ff7d95' : '#ffd166',
      weight: severe ? 2 : 1.5,
      opacity: 0.95,
      fillColor: severe ? '#ff7d95' : '#ffd166',
      fillOpacity: severe ? 0.16 : 0.12,
    };
  }

  function alertPopup(alert) {
    const headline = alert.headline || alert.event || 'Active NWS alert';
    return `
      <strong>${ui.esc(alert.event || 'NWS alert')}</strong><br>
      <span>${ui.esc(alert.severity || 'Unknown')}</span><br>
      ${ui.esc(headline).slice(0, 180)}${headline.length > 180 ? '...' : ''}
    `;
  }

  function renderAlertMapOverlays(alerts, site) {
    if (!state.alertLayer) return;
    state.alertLayer.clearLayers();
    if (!site || !hasCoords(site) || !alerts?.length) return;

    const shapedAlerts = alerts.filter((alert) => alert.geometry);
    shapedAlerts.forEach((alert) => {
      const layer = L.geoJSON(alert.geometry, {
        pane: 'alertPane',
        style: alertStyle(alert),
      }).bindPopup(alertPopup(alert));
      layer.addTo(state.alertLayer);
    });

    if (!shapedAlerts.length) {
      L.circle([site.lat, site.lon], {
        pane: 'alertPane',
        radius: 16000,
        color: '#ffd166',
        weight: 1.5,
        opacity: 0.9,
        fillColor: '#ffd166',
        fillOpacity: 0.1,
      }).bindPopup(alertPopup(alerts[0])).addTo(state.alertLayer);
    }
  }

  function isNearMichigan(feature) {
    return feature.lat >= 41 && feature.lat <= 48.8 && feature.lon >= -91.8 && feature.lon <= -82;
  }

  function impactPopup(feature) {
    const delta = feature.elevation !== null && feature.gageHeight !== null
      ? `${Math.abs(feature.gageHeight - feature.elevation).toFixed(1)} ft ${feature.gageHeight >= feature.elevation ? 'over' : 'below'}`
      : '';
    return `
      <strong>${ui.esc(feature.name)}</strong><br>
      <span>${ui.esc(feature.siteName || 'USGS impact point')}</span><br>
      ${delta ? `<span>${ui.esc(delta)} impact height</span><br>` : ''}
      ${ui.esc(feature.description || '').slice(0, 180)}
    `;
  }

  function renderImpactMapOverlays(site) {
    if (!state.impactLayer) return;
    state.impactLayer.clearLayers();

    state.floodingImpactFeatures.filter(isNearMichigan).forEach((feature) => {
      L.circleMarker([feature.lat, feature.lon], {
        pane: 'impactPane',
        radius: 6,
        color: '#ff7d95',
        weight: 2,
        fillColor: '#ff7d95',
        fillOpacity: 0.62,
      }).bindPopup(impactPopup(feature)).addTo(state.impactLayer);
    });

    if (!site?.rtfiImpacts?.length) return;
    site.rtfiImpacts.forEach((feature) => {
      L.circleMarker([feature.lat, feature.lon], {
        pane: 'impactPane',
        radius: feature.isFlooding ? 7 : 5,
        color: feature.isFlooding ? '#ff7d95' : '#ffd166',
        weight: 2,
        fillColor: feature.isFlooding ? '#ff7d95' : '#ffd166',
        fillOpacity: feature.isFlooding ? 0.68 : 0.42,
      }).bindPopup(impactPopup(feature)).addTo(state.impactLayer);
    });
  }

  function renderMarkers(sites) {
    state.markersLayer.clearLayers();
    if (state.selectedLabelLayer) state.selectedLabelLayer.clearLayers();

    sites.forEach((site) => {
      if (!hasCoords(site)) return;
      const size = markerSize(site);
      const icon = L.divIcon({
        className: '',
        html: `<div class="marker-dot" style="background:${markerColor(site)}; width:${size}px; height:${size}px"></div>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      });

      const marker = L.marker([site.lat, site.lon], { icon }).addTo(state.markersLayer);
      marker.on('click', () => selectDam(site.id, true, { sidebar: false }));
      marker.bindPopup(`
        <div>
          <div style="font-weight:800; margin-bottom:4px;">${ui.esc(site.name)}</div>
          <div>${ui.esc(site.county || 'Unknown county')} · ${ui.esc(site.river || 'Dam')}</div>
          <div>${site.linkedGaugeName ? `${site.gaugeRelation === 'river-context' ? 'River context gauge' : 'Nearest gauge'}: <strong>${ui.esc(site.linkedGaugeName)}</strong> (${ui.fmt(site.linkedGaugeMiles)} mi)` : 'No live gauge linked'}</div>
          <div>Attention: <strong>${ui.esc(riskLabel(site))}</strong></div>
          ${site.cameraFeeds?.length ? `<div>Camera: <strong>${ui.esc(site.cameraFeeds[0].label)}</strong></div>` : ''}
        </div>
      `);
    });
  }

  function chartPointLabel(item) {
    if (!item?.dateTime) return '';
    const date = new Date(item.dateTime);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric' });
  }

  function chartLabelKey(item) {
    return item?.dateTime || chartPointLabel(item);
  }

  function buildNwpsChartData(site) {
    const observed = site?.nwpsObservedSeries || [];
    const forecast = site?.nwpsForecastSeries || [];
    if (!observed.length && !forecast.length) return null;

    const points = [...observed, ...forecast].sort((a, b) => new Date(a.dateTime) - new Date(b.dateTime));
    const keys = [];
    const labels = [];
    points.forEach((point) => {
      const key = chartLabelKey(point);
      if (!key || keys.includes(key)) return;
      keys.push(key);
      labels.push(chartPointLabel(point));
    });

    const indexByKey = new Map(keys.map((key, index) => [key, index]));
    const observedData = Array(keys.length).fill(null);
    const forecastData = Array(keys.length).fill(null);
    observed.forEach((point) => {
      const index = indexByKey.get(chartLabelKey(point));
      if (index !== undefined) observedData[index] = point.value;
    });
    forecast.forEach((point) => {
      const index = indexByKey.get(chartLabelKey(point));
      if (index !== undefined) forecastData[index] = point.value;
    });

    return { labels, observedData, forecastData };
  }

  function ensureChart() {
    const frame = document.querySelector('.chart-frame');
    if (!$('stageChart')) {
      frame.querySelector('.dots-chart-panel')?.insertAdjacentHTML('beforeend', '<canvas id="stageChart"></canvas>');
      if (!$('stageChart')) frame.innerHTML = '<canvas id="stageChart"></canvas>';
    }
    if (state.stageChart) return state.stageChart;

    state.stageChart = new Chart($('stageChart'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'Observed stage',
          data: [],
          borderWidth: 2,
          tension: 0.3,
          fill: true,
          pointRadius: 3,
          pointHoverRadius: 5,
          borderColor: '#7de8e0',
          backgroundColor: 'rgba(125, 232, 224, 0.12)',
        }, {
          label: 'Forecast stage',
          data: [],
          borderWidth: 2,
          tension: 0.25,
          fill: false,
          pointRadius: 3,
          pointHoverRadius: 5,
          borderColor: '#9b6df5',
          backgroundColor: 'rgba(155, 109, 245, 0.12)',
        }, {
          label: 'Flood level',
          data: [],
          borderWidth: 2,
          borderDash: [8, 6],
          pointRadius: 0,
          tension: 0,
          fill: false,
          borderColor: '#ff7d95',
          backgroundColor: 'rgba(255, 125, 149, 0.12)',
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: '#eef8f1' } },
          tooltip: {
            callbacks: {
              label: (item) => {
                const value = Number(item.raw);
                const label = item.dataset.label || '';
                return `${label}: ${Number.isFinite(value) ? value.toFixed(1) : item.formattedValue} ft`;
              },
            },
          },
        },
        scales: {
          x: { ticks: { color: '#a5b7ad' }, grid: { color: 'rgba(238, 248, 241, 0.08)' } },
          y: {
            suggestedMin: 0,
            suggestedMax: data.defaultStageLimit,
            ticks: { color: '#a5b7ad' },
            grid: { color: 'rgba(238, 248, 241, 0.08)' },
          },
        },
      },
    });

    return state.stageChart;
  }

  function renderChartShell(site) {
    const frame = document.querySelector('.chart-frame');
    const hasOfficial = Boolean(site?.nwpsHydrographUrl);
    const officialHidden = state.chartView === 'dots' || !hasOfficial;
    const dotsHidden = state.chartView === 'official' && hasOfficial;
    const cacheBust = encodeURIComponent(site?.observedUpdated || site?.liveGaugeFetchedAt || Date.now());
    const graphUrl = hasOfficial ? `${site.nwpsHydrographUrl}?v=${cacheBust}` : '';
    const graphHref = site?.nwpsTabularUrl || site?.sourceLinks?.noaaGauge || graphUrl;

    frame.innerHTML = `
      ${hasOfficial ? `
        <div class="chart-tabs" aria-label="Gauge chart view">
          <button type="button" class="${state.chartView === 'dots' ? 'is-active' : ''}" data-chart-view="dots">Dots</button>
          <button type="button" class="${state.chartView === 'official' ? 'is-active' : ''}" data-chart-view="official">NOAA</button>
        </div>
      ` : ''}
      <div class="dots-chart-panel" ${dotsHidden ? 'hidden' : ''}>
        <canvas id="stageChart"></canvas>
      </div>
      ${hasOfficial ? `
        <a class="official-hydrograph" href="${ui.esc(graphHref)}" target="_blank" rel="noreferrer" ${officialHidden ? 'hidden' : ''}>
          <img src="${ui.esc(graphUrl)}" alt="Official NOAA hydrograph for ${ui.esc(site?.nwpsGaugeName || site?.linkedGaugeName || site?.name || 'selected gauge')}" loading="lazy">
        </a>
      ` : ''}
    `;
    if (state.stageChart) {
      state.stageChart.destroy();
      state.stageChart = null;
    }
  }

  function renderChart(site) {
    $('chartSiteName').textContent = site?.nwpsGaugeName || site?.linkedGaugeName || site?.name || 'No dam selected';
    renderChartShell(site);

    const chart = ensureChart();
    const nwpsChart = buildNwpsChartData(site);

    if (!site?.linkedGaugeId && !site?.linkedGaugeNwpsLid) {
      chart.data.labels = ['No close live gauge'];
      chart.data.datasets[0].data = [0];
      chart.data.datasets[1].data = [];
      chart.data.datasets[2].data = [];
      chart.options.scales.y.suggestedMin = 0;
      chart.options.scales.y.suggestedMax = 10;
      chart.update();
      return;
    }

    const labels = nwpsChart?.labels || site.stageLabels || [];
    const observedData = nwpsChart?.observedData || site.stageTrend || [];
    const forecastData = nwpsChart?.forecastData || [];
    const allValues = [...observedData, ...forecastData].filter((value) => value !== null && value !== undefined);
    const maxValue = Math.max(...allValues, 1);
    chart.data.labels = labels;
    chart.data.datasets[0].data = observedData;
    chart.data.datasets[1].data = forecastData;
    chart.data.datasets[1].hidden = !forecastData.some((value) => value !== null && value !== undefined);
    chart.data.datasets[2].data = site.floodStage ? labels.map(() => site.floodStage) : [];
    chart.data.datasets[2].label = site.floodDistance !== null && site.floodDistance !== undefined
      ? `Flood level (${Math.abs(site.floodDistance).toFixed(1)} ft ${site.floodDistance <= 0 ? 'over' : 'below'})`
      : 'Flood level';
    chart.options.scales.y.suggestedMin = Math.max(0, Math.floor(Math.min(...allValues, site.floodStage || maxValue) - 2));
    chart.options.scales.y.suggestedMax = Math.ceil(Math.max(maxValue, site.floodStage || 0) + 2);
    chart.update();
  }

  function setChartView(view) {
    if (!['dots', 'official'].includes(view)) return;
    state.chartView = view;
    renderTelemetry(state.allDams.find((dam) => dam.id === state.selectedDamId));
  }

  function renderTelemetry(site) {
    $('chartSummaryPanel').innerHTML = ui.chartSummaryPanel(site || {});
    renderChart(site);
  }

  function renderDetails(site) {
    $('detailsPanel').innerHTML = ui.detailsPanel(site, { riskClass, riskLabel }, data.links, {
      showCameraEmbed: true,
      freshness: freshnessItems(site),
    });
    renderImpactMapOverlays(site);
  }

  function renderAlerts(meta = {}) {
    $('statAlerts').textContent = state.activeAlerts.length.toLocaleString();
    $('alertsList').innerHTML = ui.alertsList(state.activeAlerts);
    if (meta.fetchedAt) state.alertFetchedAt = meta.fetchedAt;
    $('alertsUpdated').textContent = meta.message || `NWS point alerts. Last fetched ${cacheAgeLabel(meta.fetchedAt)}.`;
    renderAlertMapOverlays(state.activeAlerts, state.allDams.find((dam) => dam.id === state.selectedDamId));
    renderAlertTray();
  }

  function renderOutlook(site) {
    $('outlookBody').innerHTML = ui.outlookPanel(site, state.weatherOutlook);
  }

  function renderCameraWall() {
    const sitesById = new Map(state.allDams.map((site) => [site.id, site]));
    $('cameraWallList').innerHTML = ui.cameraWall(data.cameraFeeds, sitesById, state.selectedDamId);
    updateUrlState();
  }

  function sparklineSvg(site) {
    const values = (site.stageTrend || []).filter((value) => Number.isFinite(value)).slice(-12);
    if (values.length < 2) {
      return '<svg viewBox="0 0 48 18" aria-hidden="true"><path d="M2 9H46" fill="none" stroke="rgba(255,255,255,.45)" stroke-width="2"/></svg>';
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(0.1, max - min);
    const points = values.map((value, index) => {
      const x = 2 + (index / (values.length - 1)) * 44;
      const y = 16 - ((value - min) / span) * 14;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<svg viewBox="0 0 48 18" aria-hidden="true"><polyline points="${points}" fill="none" stroke="#ff9bae" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  function renderFloodTray() {
    const tray = $('floodTray');
    if (!tray) return;
    const over = state.allDams
      .filter((site) => site.floodDistance !== null && site.floodDistance !== undefined && site.floodDistance <= 0)
      .sort((a, b) => a.floodDistance - b.floodDistance)
      .slice(0, 4);

    tray.hidden = !over.length;
    if (!over.length) {
      tray.innerHTML = '';
      return;
    }

    tray.innerHTML = `
      <span class="flood-tray-label">Over flood</span>
      ${over.map((site) => `
        <button class="flood-chip" type="button" data-flood-dam-id="${ui.esc(site.id)}" title="${ui.esc(site.name)}">
          <span><strong>${ui.esc(site.name)}</strong><span>${Math.abs(site.floodDistance).toFixed(1)} ft over</span></span>
          ${sparklineSvg(site)}
        </button>
      `).join('')}
    `;

    tray.querySelectorAll('[data-flood-dam-id]').forEach((button) => {
      button.addEventListener('click', () => selectDam(button.dataset.floodDamId, true, { sidebar: true }));
    });
  }

  function renderAlertTray() {
    const tray = $('alertTray');
    if (!tray) return;

    const cachedAlerts = state.allDams.flatMap((site) => {
      const cached = readCache(cacheKey('alerts', site));
      const items = cached?.items || [];
      if (!items.length) return [];
      const alert = items.find((item) => /extreme|severe/i.test(item.severity || '')) || items[0];
      return [{
        site,
        alert,
        count: items.length,
        fetchedAt: cached.fetchedAt || 0,
        severe: /extreme|severe/i.test(alert.severity || ''),
      }];
    }).sort((a, b) => (
      Number(b.severe) - Number(a.severe)
      || b.count - a.count
      || b.fetchedAt - a.fetchedAt
    )).slice(0, 2);

    tray.hidden = !cachedAlerts.length;
    if (!cachedAlerts.length) {
      tray.innerHTML = '';
      return;
    }

    tray.innerHTML = `
      <span class="flood-tray-label">Cached NWS</span>
      ${cachedAlerts.map(({ site, alert, count, severe }) => `
        <button class="flood-chip alert-chip${severe ? ' is-severe' : ''}" type="button" data-alert-dam-id="${ui.esc(site.id)}" title="${ui.esc(alert.headline || alert.event || site.name)}">
          <span><strong>${ui.esc(site.name)}</strong><span>${ui.esc(alert.event || 'Alert')}${count > 1 ? ` +${count - 1}` : ''}</span></span>
        </button>
      `).join('')}
    `;

    tray.querySelectorAll('[data-alert-dam-id]').forEach((button) => {
      button.addEventListener('click', () => selectDam(button.dataset.alertDamId, true, { sidebar: true }));
    });
  }

  function setViewportMode(mode) {
    state.viewportMode = mode;
    const isCameras = mode === 'cameras';
    const isRadar = mode === 'radar';
    $('map').hidden = isCameras;
    $('cameraWallPanel').hidden = !isCameras;
    $('radarNote').hidden = !isRadar;
    document.querySelectorAll('[data-viewport-mode]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.viewportMode === mode);
    });
    if (state.radarLayer) {
      if (isRadar && !state.map.hasLayer(state.radarLayer)) state.radarLayer.addTo(state.map);
      if (!isRadar && state.map.hasLayer(state.radarLayer)) state.map.removeLayer(state.radarLayer);
    }
    if (isCameras) {
      renderCameraWall();
    } else {
      setTimeout(() => state.map.invalidateSize(), 50);
    }
    const selected = state.allDams.find((dam) => dam.id === state.selectedDamId);
    if (selected) renderDetails(selected);
    updateUrlState();
  }

  function showSidebarMapLabel(site) {
    if (!state.selectedLabelLayer || !hasCoords(site)) return;
    state.selectedLabelLayer.clearLayers();
    const label = L.divIcon({
      className: '',
      html: `<div class="selected-map-label">${ui.esc(site.name)}</div>`,
      iconSize: [160, 28],
      iconAnchor: [80, 35],
    });
    L.marker([site.lat, site.lon], {
      icon: label,
      interactive: false,
      keyboard: false,
    }).addTo(state.selectedLabelLayer);
  }

  function keepSelectedCardVisible() {
    if (!state.shouldRevealSelectedCard) return;
    state.shouldRevealSelectedCard = false;
    const list = $('damList');
    const card = list.querySelector('.dam-card.is-selected');
    if (!card) return;

    const listRect = list.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const above = cardRect.top < listRect.top + 8;
    const below = cardRect.bottom > listRect.bottom - 8;
    if (!above && !below) return;

    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function renderDamList() {
    const dams = getFilteredDams();
    const previousSelectedId = state.selectedDamId;
    $('resultCount').textContent = `${dams.length} shown`;
    renderMarkers(dams);
    renderFloodTray();
    renderAlertTray();

    if (!dams.length) {
      $('damList').innerHTML = '<p class="empty-state">No dams match the current filters.</p>';
      return;
    }

    if (!dams.find((dam) => dam.id === state.selectedDamId)) {
      state.selectedDamId = dams[0].id;
    }

    $('damList').innerHTML = dams.map((site) => (
      ui.damCard(site, state.selectedDamId, { riskClass, riskLabel })
    )).join('');
    keepSelectedCardVisible();

    document.querySelectorAll('.dam-card').forEach((button) => {
      button.addEventListener('click', () => selectDam(button.dataset.damId, true, { sidebar: true }));
    });

    const selected = state.allDams.find((dam) => dam.id === state.selectedDamId);
    if (selected) {
      if (state.sidebarSelection) showSidebarMapLabel(selected);
      renderDetails(selected);
      renderTelemetry(selected);
      renderOutlook(selected);
      renderCameraWall();
      if (selected.id !== previousSelectedId) refreshSelectedLiveData(selected);
    }
  }

  async function fetchDamAlerts(site) {
    if (!hasCoords(site)) {
      state.activeAlerts = [];
      site.countyAlertCount = 0;
      renderAlerts({ message: 'Add EGLE coordinates to check NWS point alerts for this dam.' });
      return;
    }

    const key = cacheKey('alerts', site);
    const cached = readCache(key);
    if (cached) {
      if (state.selectedDamId !== site.id) return;
      state.activeAlerts = cached.items || [];
      site.countyAlertCount = state.activeAlerts.length;
      applyFloodStageFromAlerts(site, state.activeAlerts);
      renderAlerts({ fetchedAt: cached.fetchedAt });
      renderDetails(site);
      renderTelemetry(site);
      renderDamList();
      renderOutlook(site);
      return;
    }

    $('alertsUpdated').textContent = 'Fetching NWS point alerts...';
    try {
      const url = `https://api.weather.gov/alerts/active?point=${encodeURIComponent(`${site.lat},${site.lon}`)}`;
      const response = await fetch(url, { headers: { Accept: 'application/geo+json' } });
      if (!response.ok) throw new Error(`NWS ${response.status}`);
      const json = await response.json();
      const items = normalizeAlerts(json.features || []);
      if (state.selectedDamId !== site.id) return;
      state.activeAlerts = items;
      site.countyAlertCount = items.length;
      applyFloodStageFromAlerts(site, items);
      writeCache(key, { items });
      renderAlerts({ fetchedAt: Date.now() });
      renderDetails(site);
      renderTelemetry(site);
      renderDamList();
      renderOutlook(site);
    } catch (error) {
      const stale = (() => {
        try {
          return JSON.parse(localStorage.getItem(key) || 'null');
        } catch (cacheError) {
          return null;
        }
      })();
      if (state.selectedDamId !== site.id) return;
      state.activeAlerts = stale?.items || [];
      applyFloodStageFromAlerts(site, state.activeAlerts);
      renderAlerts({
        fetchedAt: stale?.fetchedAt,
        message: stale ? `NWS fetch failed; showing cached data from ${cacheAgeLabel(stale.fetchedAt)}.` : 'NWS alerts are unavailable right now.',
      });
      renderDetails(site);
      renderTelemetry(site);
      renderDamList();
      renderOutlook(site);
    }
  }

  function renderGaugeUpdate(site, options = {}) {
    renderDamList();
    renderCameraWall();
    if (options.listOnly || state.selectedDamId !== site.id) return;
    renderDetails(site);
    renderTelemetry(site);
    renderOutlook(site);
  }

  async function fetchSelectedNwpsStageFlow(site, identifier, options = {}) {
    if (options.listOnly || !identifier) return;
    const selectedOnly = options.selectedOnly !== false;
    const isStillSelected = () => state.selectedDamId === site.id;
    const key = `${CACHE_PREFIX}:nwps-stageflow:${identifier}`;
    const cached = readCache(key);
    if (cached?.stageflow) {
      if (selectedOnly && !isStillSelected()) return;
      applyNwpsStageFlow(site, cached.stageflow, cached.fetchedAt);
      renderGaugeUpdate(site, options);
      return;
    }

    try {
      const response = await fetch(`${data.links.nwpsApi}/gauges/${encodeURIComponent(identifier)}/stageflow`);
      if (!response.ok) throw new Error(`NWPS stageflow ${response.status}`);
      const stageflow = compactNwpsStageFlow(await response.json());
      if (selectedOnly && !isStillSelected()) return;
      const fetchedAt = Date.now();
      writeCache(key, { stageflow });
      applyNwpsStageFlow(site, stageflow, fetchedAt);
      renderGaugeUpdate(site, options);
    } catch (error) {
      // The gauge metadata and USGS fallback still render if the hydrograph series is unavailable.
    }
  }

  async function fetchSelectedGauge(site, options = {}) {
    const selectedOnly = options.selectedOnly !== false;
    const isStillSelected = () => state.selectedDamId === site.id;

    if (!site.linkedGaugeUsgsId && !site.linkedGaugeNwpsLid) {
      if (!options.listOnly) state.gaugeFetchedAt = null;
      return;
    }

    const nwpsIdentifier = site.linkedGaugeNwpsLid || site.linkedGaugeUsgsId;
    if (nwpsIdentifier) {
      const nwpsKey = `${CACHE_PREFIX}:nwps:${nwpsIdentifier}`;
      const cachedNwps = readCache(nwpsKey);
      if (cachedNwps?.missing) {
        // NOAA/NWPS does not have every USGS stage gauge. Avoid hammering misses.
      } else if (cachedNwps?.gauge) {
        if (selectedOnly && !isStillSelected()) return;
        applyNwpsGauge(site, cachedNwps.gauge, cachedNwps.fetchedAt);
        renderGaugeUpdate(site, options);
        await fetchSelectedNwpsStageFlow(site, site.linkedGaugeNwpsLid || nwpsIdentifier, options);
      } else {
        try {
          const response = await fetch(`${data.links.nwpsApi}/gauges/${encodeURIComponent(nwpsIdentifier)}`);
          if (!response.ok) {
            if (response.status === 404) writeCache(nwpsKey, { missing: true });
            throw new Error(`NWPS ${response.status}`);
          }
          const gauge = await response.json();
          if (selectedOnly && !isStillSelected()) return;
          const fetchedAt = Date.now();
          writeCache(nwpsKey, { gauge });
          applyNwpsGauge(site, gauge, fetchedAt);
          renderGaugeUpdate(site, options);
          await fetchSelectedNwpsStageFlow(site, site.linkedGaugeNwpsLid || nwpsIdentifier, options);
        } catch (error) {
          // USGS fallback below still provides observed stage when NWPS is unavailable.
        }
      }
    }

    if (!site.linkedGaugeUsgsId) return;

    const key = `${CACHE_PREFIX}:gauge:${site.linkedGaugeUsgsId}`;
    const cached = readCache(key);
    if (cached?.values?.length) {
      if (selectedOnly && !isStillSelected()) return;
      applyGaugeValues(site, cached.values, cached.fetchedAt);
      renderGaugeUpdate(site, options);
      return;
    }

    try {
      const params = new URLSearchParams({
        format: 'json',
        sites: site.linkedGaugeUsgsId,
        parameterCd: '00065',
        period: 'P1D',
        siteStatus: 'all',
      });
      const response = await fetch(`${data.links.usgsIv}?${params.toString()}`);
      if (!response.ok) throw new Error(`USGS ${response.status}`);
      const json = await response.json();
      const values = normalizeUsgsValues(json);
      if ((selectedOnly && !isStillSelected()) || !values.length) return;
      const fetchedAt = Date.now();
      writeCache(key, { values });
      applyGaugeValues(site, values, fetchedAt);
      renderGaugeUpdate(site, options);
    } catch (error) {
      if (!options.listOnly) state.gaugeFetchedAt = null;
    }
  }

  async function fetchDamWeather(site) {
    if (!hasCoords(site)) {
      state.weatherOutlook = null;
      state.weatherFetchedAt = null;
      renderOutlook(site);
      return;
    }

    const key = cacheKey('weather', site);
    const cached = readCache(key);
    if (cached) {
      if (state.selectedDamId !== site.id) return;
      state.weatherOutlook = cached.outlook || null;
      state.weatherFetchedAt = cached.fetchedAt;
      renderDetails(site);
      renderOutlook(site);
      return;
    }

    try {
      const pointUrl = `https://api.weather.gov/points/${encodeURIComponent(`${site.lat},${site.lon}`)}`;
      const pointResponse = await fetch(pointUrl, { headers: { Accept: 'application/geo+json' } });
      if (!pointResponse.ok) throw new Error(`NWS point ${pointResponse.status}`);
      const pointJson = await pointResponse.json();
      const forecastUrl = pointJson.properties?.forecastHourly || pointJson.properties?.forecast;
      if (!forecastUrl) throw new Error('No NWS forecast URL');

      const forecastResponse = await fetch(forecastUrl, { headers: { Accept: 'application/geo+json' } });
      if (!forecastResponse.ok) throw new Error(`NWS forecast ${forecastResponse.status}`);
      const forecastJson = await forecastResponse.json();
      const outlook = normalizeWeatherOutlook(forecastJson.properties?.periods || []);
      if (state.selectedDamId !== site.id) return;
      state.weatherOutlook = outlook;
      state.weatherFetchedAt = Date.now();
      writeCache(key, { outlook });
      renderDetails(site);
      renderOutlook(site);
    } catch (error) {
      const stale = (() => {
        try {
          return JSON.parse(localStorage.getItem(key) || 'null');
        } catch (cacheError) {
          return null;
        }
      })();
      if (state.selectedDamId !== site.id) return;
      state.weatherOutlook = stale?.outlook || null;
      state.weatherFetchedAt = stale?.fetchedAt || null;
      renderDetails(site);
      renderOutlook(site);
    }
  }

  function parseNimsImageTime(filename) {
    const match = String(filename || '').match(/___(.+?)Z\.jpg$/);
    if (!match) return null;
    const iso = `${match[1].replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3')}Z`;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  async function fetchSelectedNimsCameras(site) {
    const camera = site.nimsCameras?.[0];
    if (!camera?.camId || !camera.smallDir || camera.imageUrl) return;

    const key = `${CACHE_PREFIX}:nims:${camera.camId}`;
    const cached = readCache(key);
    if (cached?.filename) {
      if (state.selectedDamId !== site.id) return;
      camera.imageUrl = `${camera.smallDir}${cached.filename}`;
      camera.imageTime = parseNimsImageTime(cached.filename) || cacheAgeLabel(cached.fetchedAt);
      renderDetails(site);
      return;
    }

    try {
      const params = new URLSearchParams({ camId: camera.camId, limit: '1' });
      const response = await fetch(`${data.links.nimsApi}/listFiles?${params.toString()}`, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`USGS NIMS ${response.status}`);
      const files = await response.json();
      const filename = Array.isArray(files) ? files[0] : null;
      if (!filename || state.selectedDamId !== site.id) return;
      camera.imageUrl = `${camera.smallDir}${filename}`;
      camera.imageTime = parseNimsImageTime(filename) || 'latest image';
      writeCache(key, { filename });
      renderDetails(site);
    } catch (error) {
      // The YouTube tab remains available when the official snapshot cannot be loaded.
    }
  }

  async function fetchStatewideLatestStages() {
    const key = `${CACHE_PREFIX}:usgs:latest-00065-mi`;
    const cached = readCache(key);
    if (cached?.features) return normalizeOgcLatestStages({ features: cached.features });

    const params = new URLSearchParams({
      f: 'json',
      bbox: '-91,41,-82,49',
      filter: "parameter_code='00065'",
      limit: '1000',
    });
    const response = await fetch(`${data.links.usgsOgcLatest}?${params.toString()}`, { headers: { Accept: 'application/geo+json' } });
    if (!response.ok) throw new Error(`USGS OGC ${response.status}`);
    const json = await response.json();
    writeCache(key, { features: json.features || [] });
    return normalizeOgcLatestStages(json);
  }

  async function fetchMichiganNwpsGaugeIndex() {
    const key = `${CACHE_PREFIX}:nwps:mi-index`;
    const cached = readCache(key);
    if (cached?.gauges) return normalizeNwpsGaugeIndex({ gauges: cached.gauges });

    const params = new URLSearchParams({
      'bbox.xmin': '-91',
      'bbox.ymin': '41',
      'bbox.xmax': '-82',
      'bbox.ymax': '49',
      srid: 'EPSG_4326',
    });
    const response = await fetch(`${data.links.nwpsApi}/gauges?${params.toString()}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`NWPS index ${response.status}`);
    const json = await response.json();
    const gauges = (json.gauges || []).filter((gauge) => gauge.state?.abbreviation === 'MI');
    writeCache(key, { gauges });
    return normalizeNwpsGaugeIndex({ gauges });
  }

  function mergeAllGaugeSources(localGauges, liveGauges, nwpsGauges) {
    return mergeGaugeSets(mergeGaugeSets(localGauges, liveGauges), nwpsGauges);
  }

  async function fetchRtfiFloodingImpacts() {
    const key = `${CACHE_PREFIX}:rtfi:flooding`;
    const cached = readCache(key);
    if (cached?.features) {
      state.floodingImpactFeatures = normalizeRtfiFeatures(cached.features);
      renderImpactMapOverlays(state.allDams.find((dam) => dam.id === state.selectedDamId));
      return;
    }

    try {
      const response = await fetch(data.links.rtfiFloodingGeojson, { headers: { Accept: 'application/geo+json' } });
      if (!response.ok) throw new Error(`USGS RT-FI ${response.status}`);
      const json = await response.json();
      state.floodingImpactFeatures = normalizeRtfiFeatures(json);
      writeCache(key, { features: json.features || [] });
      renderImpactMapOverlays(state.allDams.find((dam) => dam.id === state.selectedDamId));
    } catch (error) {
      const stale = (() => {
        try {
          return JSON.parse(localStorage.getItem(key) || 'null');
        } catch (cacheError) {
          return null;
        }
      })();
      state.floodingImpactFeatures = normalizeRtfiFeatures(stale?.features || []);
      renderImpactMapOverlays(state.allDams.find((dam) => dam.id === state.selectedDamId));
    }
  }

  async function fetchSelectedRtfiImpacts(site) {
    if (!site.linkedGaugeUsgsId) return;
    const key = `${CACHE_PREFIX}:rtfi:nwis:${site.linkedGaugeUsgsId}`;
    const cached = readCache(key);
    if (cached?.features) {
      if (state.selectedDamId !== site.id) return;
      const impacts = normalizeRtfiFeatures(cached.features);
      site.rtfiImpacts = impacts;
      site.rtfiFloodingCount = impacts.filter((feature) => feature.isFlooding).length;
      renderDetails(site);
      return;
    }

    try {
      const url = `${data.links.rtfiApi}/referencepoints/nwis/${encodeURIComponent(site.linkedGaugeUsgsId)}`;
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`USGS RT-FI ${response.status}`);
      const json = await response.json();
      if (state.selectedDamId !== site.id) return;
      const features = json.features || json.referencePoints || json.items || (Array.isArray(json) ? json : []);
      const impacts = normalizeRtfiFeatures({ features });
      site.rtfiImpacts = impacts;
      site.rtfiFloodingCount = impacts.filter((feature) => feature.isFlooding).length;
      writeCache(key, { features });
      renderDetails(site);
    } catch (error) {
      const stale = (() => {
        try {
          return JSON.parse(localStorage.getItem(key) || 'null');
        } catch (cacheError) {
          return null;
        }
      })();
      if (state.selectedDamId !== site.id) return;
      const impacts = normalizeRtfiFeatures(stale?.features || []);
      site.rtfiImpacts = impacts;
      site.rtfiFloodingCount = impacts.filter((feature) => feature.isFlooding).length;
      renderDetails(site);
    }
  }

  function refreshSelectedLiveData(site) {
    state.activeAlerts = [];
    state.weatherOutlook = null;
    state.alertFetchedAt = null;
    state.weatherFetchedAt = null;
    state.gaugeFetchedAt = site.liveGaugeFetchedAt || null;
    renderAlerts({ message: 'Checking official NWS alerts for this dam...' });
    renderDetails(site);
    renderOutlook(site);
    fetchSelectedGauge(site);
    fetchDamAlerts(site);
    fetchDamWeather(site);
    fetchSelectedRtfiImpacts(site);
    fetchSelectedNimsCameras(site);
  }

  async function hydrateSidebarGauges() {
    if (state.sidebarGaugeHydrating) return;
    state.sidebarGaugeHydrating = true;

    const seen = new Set();
    const targets = state.allDams
      .filter((site) => site.linkedGaugeUsgsId || site.linkedGaugeNwpsLid)
      .filter((site) => {
        const key = site.linkedGaugeUsgsId || site.linkedGaugeNwpsLid;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    let index = 0;
    const worker = async () => {
      while (index < targets.length) {
        const site = targets[index];
        index += 1;
        await fetchSelectedGauge(site, { selectedOnly: false, listOnly: true });
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(3, targets.length) }, worker));
    } finally {
      state.sidebarGaugeHydrating = false;
      renderFloodTray();
    }
  }

  function fitSites(sites) {
    const mappedSites = sites.filter(hasCoords);
    if (!mappedSites.length) return;
    if (mappedSites.length === 1) {
      state.map.flyTo([mappedSites[0].lat, mappedSites[0].lon], 11, { duration: 0.8 });
      return;
    }
    const bounds = L.latLngBounds(mappedSites.map((site) => [site.lat, site.lon]));
    state.map.fitBounds(bounds.pad(0.18));
  }

  function selectDam(damId, moveMap, options = {}) {
    state.selectedDamId = damId;
    state.shouldRevealSelectedCard = true;
    state.sidebarSelection = Boolean(options.sidebar);
    const site = state.allDams.find((dam) => dam.id === damId);
    if (!site) return;

    if (moveMap && hasCoords(site)) {
      state.map.flyTo([site.lat, site.lon], 11, { duration: 0.85 });
      state.map.closePopup();
      if (options.sidebar) {
        window.setTimeout(() => showSidebarMapLabel(site), 500);
      }
    }

    renderDamList();
    renderDetails(site);
    renderTelemetry(site);
    renderOutlook(site);
    renderCameraWall();
    refreshSelectedLiveData(site);
    setTimeout(() => state.map.invalidateSize(), 60);
  }

  function attachEvents() {
    ['searchInput', 'quickView', 'sortMode', 'hideNoGaugeInput'].forEach((id) => {
      $(id).addEventListener('input', renderDamList);
      $(id).addEventListener('change', renderDamList);
    });

    $('refreshBtn').addEventListener('click', () => {
      $('searchInput').value = '';
      $('quickView').value = 'watch';
      $('sortMode').value = 'danger';
      $('hideNoGaugeInput').checked = false;
      state.selectedDamId = null;
      state.shouldRevealSelectedCard = true;
      refreshAll();
    });

    document.querySelectorAll('[data-viewport-mode]').forEach((button) => {
      button.addEventListener('click', () => setViewportMode(button.dataset.viewportMode));
    });

    document.querySelector('.chart-frame').addEventListener('click', (event) => {
      const button = event.target.closest('[data-chart-view]');
      if (!button) return;
      setChartView(button.dataset.chartView);
    });

    $('jumpDetailsBtn').addEventListener('click', () => {
      $('detailsPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    window.addEventListener('resize', () => {
      window.clearTimeout(attachEvents.resizeTimer);
      attachEvents.resizeTimer = window.setTimeout(() => state.map.invalidateSize(), 140);
    });
  }

  async function loadDams() {
    const rows = await enrichDamsFromInventory(data.dams);
    return normalizeDams(rows);
  }

  async function loadGauges() {
    return normalizeGauges(data.gauges);
  }

  async function loadNimsCameras() {
    return normalizeNimsCameras(data.nimsCameras || []);
  }

  async function loadAlerts() {
    return normalizeAlerts(data.alerts);
  }

  async function refreshAll() {
    $('damList').innerHTML = '<p class="empty-state">Loading local dam data...</p>';
    const [dams, gauges, alerts, nimsCameras] = await Promise.all([loadDams(), loadGauges(), loadAlerts(), loadNimsCameras()]);

    state.activeAlerts = alerts;
    state.weatherOutlook = null;
    state.baseDams = dams;
    state.baseGauges = gauges;
    state.nimsCameras = nimsCameras;
    state.allDams = attachNimsCameras(mergeDamsAndGauges(dams, gauges, alerts), nimsCameras);

    renderDamList();
    renderCameraWall();
    fitSites(state.allDams);
    setTimeout(() => state.map.invalidateSize(), 80);
    setTimeout(() => hydrateSidebarGauges(), 500);
    setTimeout(async () => {
      try {
        const [liveGauges, nwpsGauges] = await Promise.all([
          fetchStatewideLatestStages().catch(() => []),
          fetchMichiganNwpsGaugeIndex().catch(() => []),
        ]);
        state.baseGauges = mergeAllGaugeSources(gauges, liveGauges, nwpsGauges);
        state.allDams = attachNimsCameras(mergeDamsAndGauges(state.baseDams, state.baseGauges, alerts), state.nimsCameras);
        renderDamList();
        hydrateSidebarGauges();
      } catch (error) {
        // Local embedded gauges remain available if the statewide layer is unavailable.
      }
    }, 650);
    setTimeout(() => fetchRtfiFloodingImpacts(), 900);
  }

  function init() {
    applyInitialUrlState();
    initMap();
    ensureChart();
    attachEvents();
    setViewportMode(state.viewportMode);
    refreshAll();
  }

  init();
}());
