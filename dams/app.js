(function () {
  const data = window.DAM_WATCH_DATA;
  const ui = window.DamWatchComponents;
  const MICHIGAN_CENTER = data.michiganCenter;
  const CACHE_TTL_MS = 60 * 60 * 1000;
  const CACHE_PREFIX = 'dam-watch-v2';

  const state = {
    map: null,
    markersLayer: null,
    radarLayer: null,
    stageChart: null,
    allDams: [],
    activeAlerts: [],
    weatherOutlook: null,
    selectedDamId: null,
    viewportMode: 'map',
    alertFetchedAt: null,
    weatherFetchedAt: null,
    gaugeFetchedAt: null,
  };

  const $ = (id) => document.getElementById(id);

  function safeNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || Math.abs(number) > 99999) return null;
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

  function normalizeDams(rows) {
    return rows.map((row, index) => {
      const src = row.attributes || row;
      const id = src.id || `dam-${src.Dam_ID || index + 1}`;
      const cameraFeeds = data.cameraFeeds.filter((feed) => feed.relatedDamIds.includes(id));
      const cameraFeed = cameraFeeds[0] || null;
      const lat = safeNumber(src.Latitude || src.lat);
      const lon = safeNumber(src.Longitude || src.lon);

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
        linkedGaugeId: null,
        linkedGaugeName: null,
        linkedGaugeMiles: null,
        gaugeConfidence: 'none',
        countyAlertCount: 0,
        cameraFeed,
        cameraFeeds,
        sourceLinks: {
          damInventory: src.damInventoryUrl || data.links.egle,
          camera: `${data.links.mdot}?lat=${lat}&lon=${lon}&zoom=12`,
          usgsWebcams: data.links.usgsWebcams,
          noaa: data.links.noaa,
          egle: data.links.egle,
          dnr: data.links.dnr,
          nws: data.links.nws,
          webcam: src.WebcamUrl || cameraFeed?.pageUrl || null,
          webcamEmbed: src.WebcamEmbed || cameraFeed?.embedUrl || null,
        },
      };
    }).filter((dam) => dam.lat !== null && dam.lon !== null);
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

      return {
        id: `gauge-${usgsId || index}`,
        usgsId,
        name: info.siteName || info.name || 'USGS gauge',
        lat: safeNumber(info.geoLocation?.geogLocation?.latitude || info.lat),
        lon: safeNumber(info.geoLocation?.geogLocation?.longitude || info.lon),
        currentStage: trend.length ? trend[trend.length - 1] : null,
        forecastStage: trend.length ? Math.max(...trend.slice(-6)) : null,
        stageTrend: trend,
        stageLabels: labels,
        observedUpdated: values.length ? values[values.length - 1].dateTime : null,
        sourceLinks: {
          usgs: usgsId ? `https://waterdata.usgs.gov/monitoring-location/${usgsId}/` : data.links.usgsWebcams,
        },
      };
    }).filter((gauge) => gauge.lat !== null && gauge.lon !== null);
  }

  function normalizeAlerts(rows) {
    return rows.map((feature, index) => {
      const props = feature.properties || feature;
      return {
        id: feature.id || `alert-${index}`,
        event: props.event || 'Alert',
        severity: props.severity || 'Unknown',
        headline: props.headline || props.description || '',
        areaDesc: props.areaDesc || '',
        sent: props.sent || props.effective || null,
        web: props['@id'] || feature.id || props.id || null,
      };
    });
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

  function applyGaugeValues(site, values, fetchedAt) {
    if (!values.length) return;
    const recent = values.slice(-18);
    const trend = recent.map((item) => item.value);
    const labels = recent.map((item) => (
      item.dateTime ? new Date(item.dateTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
    ));
    const currentStage = trend[trend.length - 1];
    const forecastStage = Math.max(...trend.slice(-6));
    const floodStage = Number((Math.max(...trend) + 2.5).toFixed(1));

    site.currentStage = currentStage;
    site.forecastStage = forecastStage;
    site.floodStage = floodStage;
    site.floodPercent = Number(((forecastStage / floodStage) * 100).toFixed(0));
    site.floodDistance = Number((floodStage - forecastStage).toFixed(1));
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

      gauges.forEach((gauge) => {
        const miles = haversineMiles(dam.lat, dam.lon, gauge.lat, gauge.lon);
        if (miles < bestDist) {
          bestDist = miles;
          nearest = gauge;
        }
      });

      const countyName = String(dam.county || '').toLowerCase();
      const countyAlertCount = alerts.filter((alert) => String(alert.areaDesc || '').toLowerCase().includes(countyName)).length;

      if (!nearest || bestDist > 6) {
        return { ...dam, countyAlertCount, floodStage: null, floodPercent: null, floodDistance: null };
      }

      const values = (nearest.stageTrend || []).filter((value) => Number.isFinite(value));
      const currentStage = safeNumber(nearest.currentStage);
      const forecastStage = safeNumber(nearest.forecastStage);
      const floodStage = values.length ? Number((Math.max(...values) + 2.5).toFixed(1)) : null;
      const floodPercent = floodStage && forecastStage ? Number(((forecastStage / floodStage) * 100).toFixed(0)) : null;
      const floodDistance = floodStage && forecastStage ? Number((floodStage - forecastStage).toFixed(1)) : null;

      return {
        ...dam,
        linkedGaugeId: nearest.id,
        linkedGaugeUsgsId: nearest.usgsId || null,
        linkedGaugeName: nearest.name,
        linkedGaugeMiles: Number(bestDist.toFixed(1)),
        gaugeConfidence: bestDist <= 2 ? 'high' : bestDist <= 4 ? 'medium' : 'low',
        currentStage,
        forecastStage,
        floodStage,
        floodPercent,
        floodDistance,
        stageTrend: nearest.stageTrend || [],
        stageLabels: nearest.stageLabels || [],
        observedUpdated: nearest.observedUpdated || null,
        countyAlertCount,
        sourceLinks: {
          ...dam.sourceLinks,
          usgs: nearest.sourceLinks?.usgs || null,
          noaaGauge: nearest.sourceLinks?.usgs || data.links.noaa,
        },
      };
    });
  }

  function getFilteredDams() {
    const query = $('searchInput').value.trim().toLowerCase();
    const quickView = $('quickView').value;
    const sortMode = $('sortMode').value;

    const dams = state.allDams.filter((site) => {
      if (quickView === 'watch' && !isInteresting(site)) return false;
      if (quickView === 'linked' && !site.linkedGaugeId) return false;
      if (quickView === 'camera' && !site.cameraFeeds?.length) return false;
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
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(query);
    });

    const floodSortValue = (site) => {
      if (site.floodDistance === null || site.floodDistance === undefined) return 9999;
      if (site.floodDistance <= 0) return site.floodDistance - 1000;
      return site.floodDistance;
    };

    dams.sort((a, b) => {
      if (sortMode === 'flood') return floodSortValue(a) - floodSortValue(b) || attentionScore(b) - attentionScore(a);
      if (sortMode === 'gauge') return (a.linkedGaugeMiles ?? 999) - (b.linkedGaugeMiles ?? 999) || attentionScore(b) - attentionScore(a);
      if (sortMode === 'danger') return attentionScore(b) - attentionScore(a) || floodSortValue(a) - floodSortValue(b);
      if (quickView === 'camera') return (b.cameraFeeds?.length || 0) - (a.cameraFeeds?.length || 0) || attentionScore(b) - attentionScore(a);
      return String(a.name || '').localeCompare(String(b.name || ''));
    });

    return dams;
  }

  function initMap() {
    state.map = L.map('map', { zoomControl: true }).setView(MICHIGAN_CENTER, 7);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(state.map);
    state.radarLayer = L.tileLayer.wms(data.links.radarWms, {
      layers: 'nexrad-n0r',
      format: 'image/png',
      transparent: true,
      opacity: 0.62,
      attribution: 'Radar &copy; Iowa Environmental Mesonet',
    });
    state.markersLayer = L.layerGroup().addTo(state.map);
  }

  function renderMarkers(sites) {
    state.markersLayer.clearLayers();

    sites.forEach((site) => {
      const size = markerSize(site);
      const icon = L.divIcon({
        className: '',
        html: `<div class="marker-dot" style="background:${markerColor(site)}; width:${size}px; height:${size}px"></div>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      });

      const marker = L.marker([site.lat, site.lon], { icon }).addTo(state.markersLayer);
      marker.on('click', () => selectDam(site.id, true));
      marker.bindPopup(`
        <div>
          <div style="font-weight:800; margin-bottom:4px;">${ui.esc(site.name)}</div>
          <div>${ui.esc(site.county || 'Unknown county')} · ${ui.esc(site.river || 'Dam')}</div>
          <div>${site.linkedGaugeName ? `Nearest gauge: <strong>${ui.esc(site.linkedGaugeName)}</strong> (${ui.fmt(site.linkedGaugeMiles)} mi)` : 'No close live gauge linked'}</div>
          <div>Attention: <strong>${ui.esc(riskLabel(site))}</strong></div>
          ${site.cameraFeeds?.length ? `<div>Camera: <strong>${ui.esc(site.cameraFeeds[0].label)}</strong></div>` : ''}
        </div>
      `);
    });
  }

  function ensureChart() {
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
          borderColor: '#7de8e0',
          backgroundColor: 'rgba(125, 232, 224, 0.12)',
        }, {
          label: 'Estimated flood level',
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
        plugins: { legend: { labels: { color: '#eef8f1' } } },
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

  function renderChart(site) {
    const chart = ensureChart();
    $('chartSiteName').textContent = site?.name || 'No dam selected';

    if (!site?.linkedGaugeId || !site.stageTrend?.length) {
      chart.data.labels = ['No close live gauge'];
      chart.data.datasets[0].data = [0];
      chart.data.datasets[1].data = [];
      chart.options.scales.y.suggestedMin = 0;
      chart.options.scales.y.suggestedMax = 10;
      chart.update();
      return;
    }

    const maxValue = Math.max(...site.stageTrend, 1);
    chart.data.labels = site.stageLabels;
    chart.data.datasets[0].data = site.stageTrend;
    chart.data.datasets[1].data = site.floodStage ? site.stageTrend.map(() => site.floodStage) : [];
    chart.options.scales.y.suggestedMin = 0;
    chart.options.scales.y.suggestedMax = Math.ceil(Math.max(maxValue, site.floodStage || 0) + 2);
    chart.update();
  }

  function renderTelemetry(site) {
    $('chartSummaryPanel').innerHTML = ui.chartSummaryPanel(site || {});
    renderChart(site);
  }

  function renderDetails(site) {
    $('detailsPanel').innerHTML = ui.detailsPanel(site, { riskClass, riskLabel }, data.links, {
      showCameraEmbed: state.viewportMode !== 'cameras',
      freshness: freshnessItems(site),
    });
  }

  function renderAlerts(meta = {}) {
    $('statAlerts').textContent = state.activeAlerts.length.toLocaleString();
    $('alertsList').innerHTML = ui.alertsList(state.activeAlerts);
    if (meta.fetchedAt) state.alertFetchedAt = meta.fetchedAt;
    $('alertsUpdated').textContent = meta.message || `NWS point alerts. Last fetched ${cacheAgeLabel(meta.fetchedAt)}.`;
  }

  function renderOutlook(site) {
    $('outlookBody').innerHTML = ui.outlookPanel(site, state.weatherOutlook);
  }

  function renderCameraWall() {
    const sitesById = new Map(state.allDams.map((site) => [site.id, site]));
    $('cameraWallList').innerHTML = ui.cameraWall(data.cameraFeeds, sitesById, state.selectedDamId);
    updateUrlState();
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

  function renderDamList() {
    const dams = getFilteredDams();
    const previousSelectedId = state.selectedDamId;
    $('resultCount').textContent = `${dams.length} shown`;
    renderMarkers(dams);

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

    document.querySelectorAll('.dam-card').forEach((button) => {
      button.addEventListener('click', () => selectDam(button.dataset.damId, true));
    });

    const selected = state.allDams.find((dam) => dam.id === state.selectedDamId);
    if (selected) {
      renderDetails(selected);
      renderTelemetry(selected);
      renderOutlook(selected);
      renderCameraWall();
      if (selected.id !== previousSelectedId) refreshSelectedLiveData(selected);
    }
  }

  async function fetchDamAlerts(site) {
    const key = cacheKey('alerts', site);
    const cached = readCache(key);
    if (cached) {
      if (state.selectedDamId !== site.id) return;
      state.activeAlerts = cached.items || [];
      site.countyAlertCount = state.activeAlerts.length;
      renderAlerts({ fetchedAt: cached.fetchedAt });
      renderDetails(site);
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
      writeCache(key, { items });
      renderAlerts({ fetchedAt: Date.now() });
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
      state.activeAlerts = stale?.items || [];
      renderAlerts({
        fetchedAt: stale?.fetchedAt,
        message: stale ? `NWS fetch failed; showing cached data from ${cacheAgeLabel(stale.fetchedAt)}.` : 'NWS alerts are unavailable right now.',
      });
      renderDetails(site);
      renderOutlook(site);
    }
  }

  async function fetchSelectedGauge(site) {
    if (!site.linkedGaugeUsgsId) {
      state.gaugeFetchedAt = null;
      return;
    }

    const key = `${CACHE_PREFIX}:gauge:${site.linkedGaugeUsgsId}`;
    const cached = readCache(key);
    if (cached?.values?.length) {
      if (state.selectedDamId !== site.id) return;
      applyGaugeValues(site, cached.values, cached.fetchedAt);
      renderDamList();
      renderCameraWall();
      renderOutlook(site);
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
      if (state.selectedDamId !== site.id || !values.length) return;
      const fetchedAt = Date.now();
      writeCache(key, { values });
      applyGaugeValues(site, values, fetchedAt);
      renderDamList();
      renderCameraWall();
      renderOutlook(site);
    } catch (error) {
      state.gaugeFetchedAt = null;
    }
  }

  async function fetchDamWeather(site) {
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
  }

  function fitSites(sites) {
    if (!sites.length) return;
    if (sites.length === 1) {
      state.map.flyTo([sites[0].lat, sites[0].lon], 11, { duration: 0.8 });
      return;
    }
    const bounds = L.latLngBounds(sites.map((site) => [site.lat, site.lon]));
    state.map.fitBounds(bounds.pad(0.18));
  }

  function selectDam(damId, moveMap) {
    state.selectedDamId = damId;
    const site = state.allDams.find((dam) => dam.id === damId);
    if (!site) return;

    if (moveMap) {
      state.map.flyTo([site.lat, site.lon], 11, { duration: 0.85 });
      state.map.closePopup();
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
    ['searchInput', 'quickView', 'sortMode'].forEach((id) => {
      $(id).addEventListener('input', renderDamList);
      $(id).addEventListener('change', renderDamList);
    });

    $('refreshBtn').addEventListener('click', () => {
      $('searchInput').value = '';
      $('quickView').value = 'watch';
      $('sortMode').value = 'danger';
      state.selectedDamId = null;
      refreshAll();
    });

    document.querySelectorAll('[data-viewport-mode]').forEach((button) => {
      button.addEventListener('click', () => setViewportMode(button.dataset.viewportMode));
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
    return normalizeDams(data.dams);
  }

  async function loadGauges() {
    return normalizeGauges(data.gauges);
  }

  async function loadAlerts() {
    return normalizeAlerts(data.alerts);
  }

  async function refreshAll() {
    $('damList').innerHTML = '<p class="empty-state">Loading local dam data...</p>';
    const [dams, gauges, alerts] = await Promise.all([loadDams(), loadGauges(), loadAlerts()]);

    state.activeAlerts = alerts;
    state.weatherOutlook = null;
    state.allDams = mergeDamsAndGauges(dams, gauges, alerts);

    renderDamList();
    renderCameraWall();
    fitSites(state.allDams);
    setTimeout(() => state.map.invalidateSize(), 80);
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
