(function () {
  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]));
  }

  function fmt(value, digits = 1) {
    const number = Number(value);
    if (!Number.isFinite(number) || Math.abs(number) > 99999) return '--';
    return number.toFixed(digits);
  }

  function riskPill(site, riskClass, riskLabel) {
    return `<span class="risk-pill risk-${esc(riskClass(site))}">${esc(riskLabel(site))}</span>`;
  }

  function floodMargin(site) {
    if (site.floodDistance === null || site.floodDistance === undefined) return '--';
    if (site.floodDistance <= 0) return `${Math.abs(site.floodDistance).toFixed(1)} ft over`;
    return `${site.floodDistance.toFixed(1)} ft below`;
  }

  function floodMarginTone(site) {
    if (site.floodDistance === null || site.floodDistance === undefined) return '';
    return site.floodDistance <= 0 ? 'tone-rose' : 'tone-mint';
  }

  function chartSummaryPanel(site) {
    return `
      <div class="mini-metric">
        <span>Observed</span>
        <strong>${fmt(site.currentStage)} ft</strong>
      </div>
      <div class="mini-metric">
        <span>Forecast</span>
        <strong>${fmt(site.forecastStage)} ft</strong>
      </div>
      <div class="mini-metric">
        <span>Flood level</span>
        <strong>${site.floodStage ? `${fmt(site.floodStage)} ft` : '--'}</strong>
      </div>
      <div class="mini-metric">
        <span>Difference</span>
        <strong class="${floodMarginTone(site)}">${floodMargin(site)}</strong>
      </div>
    `;
  }

  function dangerBar(site) {
    if (!site.floodStage || !site.forecastStage) {
      return '<div class="danger-bar danger-none" aria-label="No flood comparison available"><span style="width: 10%"></span></div>';
    }

    const percent = Number(site.floodPercent) || (site.forecastStage / site.floodStage) * 100;
    const overFeet = site.floodDistance <= 0 ? Math.abs(site.floodDistance) : 0;
    const width = Math.min(100, Math.max(6, percent + overFeet * 8));
    let tone = 'danger-low';
    if (site.floodDistance <= 0) tone = 'danger-over';
    else if (percent >= 90) tone = 'danger-high';
    else if (percent >= 75) tone = 'danger-watch';

    const label = site.floodDistance <= 0
      ? `${overFeet.toFixed(1)} ft over flood level`
      : `${floodMargin(site)} flood level`;
    return `<div class="danger-bar ${tone}" aria-label="${esc(label)}"><span style="width: ${fmt(width, 0)}%"></span></div>`;
  }

  function damCard(site, selectedId, helpers) {
    const selected = site.id === selectedId ? ' is-selected' : '';
    const camera = site.cameraFeeds?.length ? `<span class="camera-pill">${site.cameraFeeds.length} cam${site.cameraFeeds.length > 1 ? 's' : ''}</span>` : '';
    const gauge = site.linkedGaugeName ? `Gauge ${fmt(site.linkedGaugeMiles)} mi` : 'No close gauge';
    const flood = site.floodStage ? `Flood ${fmt(site.floodStage)} ft` : 'No flood level';
    const margin = site.floodDistance !== null && site.floodDistance !== undefined
      ? `<span class="${floodMarginTone(site)}">${floodMargin(site)}</span>`
      : '';
    const condition = [site.hazard ? `Hazard: ${site.hazard}` : '', site.condition ? `Condition: ${site.condition}` : '']
      .filter(Boolean)
      .join(' · ');

    return `
      <button class="dam-card${selected}" data-dam-id="${esc(site.id)}" type="button">
        ${dangerBar(site)}
        <div class="card-top">
          <div>
            <div class="dam-name">${esc(site.name)}</div>
            <div class="subtle">${esc(site.county || 'Unknown county')} · ${esc(site.river || 'Dam')}</div>
          </div>
          ${riskPill(site, helpers.riskClass, helpers.riskLabel)}
        </div>
        <div class="dam-card-line">
          <span>${esc(gauge)}</span>
          <span>${esc(flood)}</span>
          ${margin}
          ${camera}
        </div>
        ${condition ? `<div class="small-copy">${esc(condition)}</div>` : ''}
      </button>
    `;
  }

  function selectedCameraPreview(site, links, showEmbed) {
    const feeds = site.cameraFeeds || [];
    if (!feeds.length) return '';
    const feed = feeds[0];
    const cameraBody = showEmbed
      ? `<iframe class="selected-camera-frame" src="${esc(feed.embedUrl)}" title="${esc(feed.label)} live camera"
          loading="lazy" referrerpolicy="strict-origin-when-cross-origin"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
          allowfullscreen></iframe>`
      : '<p class="small-copy"><strong>Camera view:</strong> Playing in the Cameras viewport above.</p>';

    return `
      <div class="copy-block">
        <div class="card-top">
          <div>
            <h3>${esc(feed.label)}</h3>
            <p class="subtle">${esc(feed.view || feed.note)}</p>
          </div>
          <span class="camera-pill">Live cam</span>
        </div>
        ${cameraBody}
      </div>
    `;
  }

  function cameraWallCard(feed, site) {
    if (!site) return '';
    const difference = floodMargin(site);
    const differenceTone = floodMarginTone(site);

    return `
      <article class="camera-wall-card">
        <div class="card-top">
          <div>
            <h3>${esc(feed.label)}</h3>
            <p class="subtle">${esc(feed.group || 'Public camera')} · ${esc(site.name)}</p>
          </div>
          <span class="camera-pill">${esc(feed.provider)}</span>
        </div>
        <iframe class="camera-wall-frame" src="${esc(feed.embedUrl)}" title="${esc(feed.label)} live camera"
          loading="lazy" referrerpolicy="strict-origin-when-cross-origin"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
          allowfullscreen></iframe>
        <div class="camera-wall-meta">
          <span class="info-badge">${esc(site.name)}</span>
          <span class="info-badge">Flood ${site.floodStage ? `${fmt(site.floodStage)} ft` : '--'}</span>
          <span class="info-badge ${differenceTone}">${difference}</span>
        </div>
        <p class="small-copy">${esc(feed.view || feed.note)}</p>
        <div class="tab-row">
          <a class="link-button" href="${esc(feed.pageUrl)}" target="_blank" rel="noreferrer">Open source</a>
        </div>
      </article>
    `;
  }

  function cameraWall(feeds, sitesById) {
    if (!feeds.length) return '<p class="empty-state">No verified camera feeds are configured yet.</p>';
    return feeds.map((feed) => cameraWallCard(feed, sitesById.get(feed.relatedDamIds[0]))).join('');
  }

  function smartCameraWall(feeds, sitesById, selectedId) {
    const selectedFeeds = feeds.filter((feed) => feed.relatedDamIds.includes(selectedId));
    const otherFeeds = feeds.filter((feed) => !feed.relatedDamIds.includes(selectedId));
    const ordered = [...selectedFeeds, ...otherFeeds];
    return cameraWall(ordered, sitesById);
  }

  function alertsList(alerts) {
    if (!alerts.length) return '<p class="empty-state">No active NWS alerts for the selected dam right now.</p>';

    return alerts.slice(0, 24).map((alert) => {
      const severityClass = alert.severity === 'Extreme' || alert.severity === 'Severe' ? 'risk-high' : 'risk-medium';
      const sent = alert.sent ? new Date(alert.sent).toLocaleString() : '';
      return `
        <article class="alert-card">
          <div class="alert-top">
            <div class="alert-title">${esc(alert.event)}</div>
            <span class="risk-pill ${severityClass}">${esc(alert.severity)}</span>
          </div>
          <div class="subtle">${esc(alert.areaDesc)}</div>
          <p>${esc(alert.headline).slice(0, 220)}${alert.headline.length > 220 ? '...' : ''}</p>
          <div class="card-top small-copy">
            <span>${esc(sent)}</span>
            ${alert.web ? `<a href="${esc(alert.web)}" target="_blank" rel="noreferrer">Open alert</a>` : ''}
          </div>
        </article>
      `;
    }).join('');
  }

  function outlookPanel(site, weather) {
    const trend = (site.stageTrend || []).filter((value) => Number.isFinite(value)).slice(-6);
    const delta = trend.length >= 2 ? trend[trend.length - 1] - trend[0] : 0;
    const pop = Number(weather?.maxPop);
    const wetSignal = Number.isFinite(pop) && pop >= 55;
    let score = 0;
    if (delta > 0.15) score += 1;
    if (delta > 0.5) score += 1;
    if (delta < -0.15) score -= 1;
    if (wetSignal) score += 1;
    if (site.countyAlertCount) score += 1;

    let title = 'Likely steady';
    let tone = 'outlook-steady';
    if (site.floodDistance !== null && site.floodDistance <= 0 && score >= 0) {
      title = 'Already over flood level';
      tone = 'outlook-high';
    } else if (score >= 2) {
      title = 'Likely rising';
      tone = 'outlook-rise';
    } else if (score === 1) {
      title = 'May rise';
      tone = 'outlook-watch';
    } else if (score < 0) {
      title = 'Likely falling';
      tone = 'outlook-fall';
    }

    const trendText = Math.abs(delta) < 0.15
      ? 'Gauge trend is mostly flat'
      : `Gauge is ${delta > 0 ? 'up' : 'down'} ${Math.abs(delta).toFixed(1)} ft recently`;
    const weatherText = weather
      ? `${esc(weather.periodName || 'Forecast')}: ${esc(weather.summary)}${weather.precipText ? `, ${esc(weather.precipText)}` : ''}.`
      : 'Weather forecast unavailable right now.';

    return `
      <div class="outlook-card ${tone}">
        <span>Forecast estimate</span>
        <strong>${esc(title)}</strong>
        <p>${esc(trendText)}. ${weatherText}</p>
      </div>
    `;
  }

  function freshnessPanel(items = []) {
    if (!items.length) return '';
    return `
      <div class="freshness-panel" aria-label="Data freshness">
        ${items.map((item) => `
          <span class="freshness-item">
            <i class="freshness-dot freshness-${esc(item.tone)}" aria-hidden="true"></i>
            <b>${esc(item.label)}</b>
            ${esc(item.age)}
          </span>
        `).join('')}
      </div>
    `;
  }

  function detailsPanel(site, helpers, links, options = {}) {
    const feeds = site.cameraFeeds || [];
    const feed = feeds[0] || null;
    const linksHtml = [
      site.sourceLinks?.damInventory ? ['Inventory', site.sourceLinks.damInventory] : null,
      site.sourceLinks?.usgs ? ['Gauge', site.sourceLinks.usgs] : null,
      feed ? ['Camera', feed.pageUrl] : null,
      ['NOAA water', site.sourceLinks?.noaaGauge || links.noaa],
    ].filter(Boolean).map(([label, href]) => (
      `<a class="link-button" href="${esc(href)}" target="_blank" rel="noreferrer">${esc(label)}</a>`
    )).join('');

    return `
      <div class="detail-top">
        <div>
          <p class="eyebrow">Selected dam</p>
          <h2 class="detail-title">${esc(site.name)}</h2>
          <p class="subtle">Dam · ${esc(site.county || 'Unknown county')}${site.river ? ` · ${esc(site.river)}` : ''}</p>
        </div>
        ${riskPill(site, helpers.riskClass, helpers.riskLabel)}
      </div>

      ${freshnessPanel(options.freshness)}

      ${selectedCameraPreview(site, links, options.showCameraEmbed !== false)}

      <div class="fact-grid">
        <div class="fact-row"><span>Gauge</span><strong>${site.linkedGaugeName ? `${esc(site.linkedGaugeName)}${site.linkedGaugeMiles !== null && site.linkedGaugeMiles !== undefined ? ` · ${fmt(site.linkedGaugeMiles)} mi` : ''}` : 'None nearby'}</strong></div>
        <div class="fact-row"><span>Current</span><strong>${fmt(site.currentStage)} ft</strong></div>
        <div class="fact-row"><span>Forecast</span><strong>${fmt(site.forecastStage)} ft</strong></div>
        <div class="fact-row"><span>Flood level</span><strong>${site.floodStage ? `${fmt(site.floodStage)} ft` : '--'}</strong></div>
        <div class="fact-row"><span>Difference</span><strong class="${floodMarginTone(site)}">${floodMargin(site)}</strong></div>
      </div>

      <div class="tab-row">${linksHtml}</div>
    `;
  }

  window.DamWatchComponents = {
    esc,
    fmt,
    chartSummaryPanel,
    damCard,
    cameraWall: smartCameraWall,
    alertsList,
    outlookPanel,
    detailsPanel,
  };
}());
