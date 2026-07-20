(() => {
  "use strict";

  const CATALOG = window.STORM_CATALOG || [];
  const DATASETS = window.STORM_DATASETS || {};
  if (!window.L || !CATALOG.length || !Object.keys(DATASETS).length) {
    document.body.innerHTML = '<p style="padding:2rem;color:white">The storm data or mapping library failed to load.</p>';
    return;
  }

  const stageColors = {
    "Disturbance": "#8296a3",
    "Tropical Wave": "#8296a3",
    "Tropical Depression": "#3ca7e8",
    "Tropical Storm": "#f2c84b",
    "Hurricane": "#ff4d5e",
    "Subtropical Depression": "#3ca7e8",
    "Subtropical Storm": "#f2c84b",
    "Extratropical": "#a37bd7",
    "Remnant Low": "#a37bd7"
  };

  const seriesPalette = ["#ff5f73", "#f3cf64", "#ff8fb1", "#ff9f4a", "#2ecbb3", "#73b7ff"];

  const els = {
    subtitle: document.getElementById("page-subtitle"),
    stormTitle: document.getElementById("storm-title"),
    stormSelect: document.getElementById("storm-select"),
    gaugeCount: document.getElementById("gauge-count"),
    hourCount: document.getElementById("hour-count"),
    local: document.getElementById("time-local"),
    utc: document.getElementById("time-utc"),
    slider: document.getElementById("timeline"),
    play: document.getElementById("play"),
    speed: document.getElementById("speed-select"),
    date: document.getElementById("date-input"),
    dateZone: document.getElementById("date-zone"),
    storm: document.getElementById("storm-card"),
    chart: document.getElementById("water-chart"),
    chartLegend: document.getElementById("chart-legend"),
    chartTime: document.getElementById("chart-time"),
    chartRange: document.getElementById("chart-range"),
    chartWindowSelect: document.getElementById("chart-window-select"),
    chartEarlier: document.getElementById("chart-earlier"),
    chartLater: document.getElementById("chart-later"),
    resetChartWindow: document.getElementById("reset-chart-window"),
    showAllStations: document.getElementById("show-all-stations"),
    hideAllStations: document.getElementById("hide-all-stations"),
    rangeStart: document.getElementById("range-start"),
    rangeLandfall: document.getElementById("range-landfall"),
    rangeEnd: document.getElementById("range-end")
  };

  const map = L.map("map", {
    zoomControl: true,
    preferCanvas: true,
    minZoom: 5,
    maxZoom: 12
  });

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd",
    maxZoom: 20,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
  }).addTo(map);
  L.control.scale({ imperial: true, metric: false }).addTo(map);

  let data = null;
  let times = [];
  let track = [];
  let activeValues = {};
  let stationColors = {};
  let stationMarkers = {};
  let visibleStations = new Set();
  let trackLayer = null;
  let elapsedTrack = null;
  let stormMarker = null;
  let index = 0;
  let timer = null;
  let chart = null;
  let stormConfig = null;
  let chartStartIndex = 0;
  let chartEndIndex = 0;
  let chartWindowHours = null;
  let chartYScale = null;

  function sampleIntervalMinutes() {
    return Math.max(1, Number(data?.metadata?.intervalMinutes) || 60);
  }

  function samplesPerHour() {
    return Math.max(1, Math.round(60 / sampleIntervalMinutes()));
  }

  function hourStep(hours) {
    return Math.max(1, Math.round(hours * 60 / sampleIntervalMinutes()));
  }

  function colorForDeparture(value) {
    if (value == null) return "#6d8593";
    if (value <= 0) return "#4292ff";
    if (value < .5) return "#24c7a6";
    if (value < 1) return "#f3d35b";
    if (value < 2) return "#ff9138";
    return "#ff4d5e";
  }

  function signed(value) {
    if (value == null) return "—";
    return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
  }

  function formatLocal(value) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: data.metadata.localTimezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short"
    }).format(value);
  }

  function formatLocalChart(value) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: data.metadata.localTimezone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(value);
  }

  function formatDateTick(value) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: data.metadata.localTimezone,
      month: "short",
      day: "numeric"
    }).format(value);
  }

  function formatDateTimeTick(value) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: data.metadata.localTimezone,
      month: "short",
      day: "numeric",
      hour: "numeric"
    }).format(value).replace(", ", " ");
  }

  function formatChartRange() {
    const formatter = chartWindowHours != null && chartWindowHours <= 48 ? formatDateTimeTick : formatDateTick;
    return `${formatter(times[chartStartIndex])} – ${formatter(times[chartEndIndex])}`;
  }

  function formatUtc(value) {
    const day = String(value.getUTCDate()).padStart(2, "0");
    const hour = String(value.getUTCHours()).padStart(2, "0");
    const minute = String(value.getUTCMinutes()).padStart(2, "0");
    return `${day}/${hour}${minute} UTC`;
  }

  function formatUtcShort(value) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(value) + " UTC";
  }

  function inputLocalValue(value) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: data.metadata.localTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(value);
    const part = type => parts.find(item => item.type === type).value;
    return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
  }

  function zonedInputToDate(value) {
    const [datePart, timePart] = value.split("T");
    const [year, month, day] = datePart.split("-").map(Number);
    const [hour, minute] = timePart.split(":").map(Number);
    const target = Date.UTC(year, month - 1, day, hour, minute);
    let guess = new Date(target);
    for (let attempt = 0; attempt < 3; attempt++) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: data.metadata.localTimezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      }).formatToParts(guess);
      const part = type => Number(parts.find(item => item.type === type).value);
      const rendered = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
      guess = new Date(guess.getTime() + target - rendered);
    }
    return guess;
  }

  function nearestIndex(value, values = times) {
    if (!values.length) return 0;
    let closest = 0;
    let distance = Math.abs(value - values[0]);
    for (let i = 1; i < values.length; i++) {
      const nextDistance = Math.abs(value - values[i]);
      if (nextDistance < distance) {
        closest = i;
        distance = nextDistance;
      }
    }
    return closest;
  }

  function cleanupStormLayers() {
    if (stormMarker) map.removeLayer(stormMarker);
    if (trackLayer) map.removeLayer(trackLayer);
    if (elapsedTrack) map.removeLayer(elapsedTrack);
    Object.values(stationMarkers).forEach(marker => {
      if (map.hasLayer(marker)) map.removeLayer(marker);
    });
    stormMarker = null;
    trackLayer = null;
    elapsedTrack = null;
    stationMarkers = {};
    els.chart.onpointerdown = null;
    els.chart.onpointermove = null;
    els.chart.onpointerup = null;
    els.chart.onpointercancel = null;
    els.chart.replaceChildren();
    els.chartLegend.replaceChildren();
    chart = null;
  }

  function configureActiveWindow(dataset) {
    const allTimes = dataset.times.map(value => new Date(value));
    const windowStart = new Date(dataset.metadata.eventWindow.displayStart);
    const windowEnd = new Date(dataset.metadata.eventWindow.displayEnd);
    const startIndex = nearestIndex(windowStart, allTimes);
    const endIndex = nearestIndex(windowEnd, allTimes);
    times = allTimes.slice(startIndex, endIndex + 1);
    activeValues = Object.fromEntries(
      dataset.stationOrder.map(id => [id, dataset.stations[id].values.slice(startIndex, endIndex + 1)])
    );
  }

  function updateHeader() {
    const available = data.stationOrder.filter(id => data.stations[id].available).length;
    els.subtitle.textContent = data.metadata.subtitle;
    els.stormTitle.textContent = data.metadata.displayTitle;
    els.gaugeCount.textContent = `${available} ${available === 1 ? "gauge" : "gauges"}`;
    const durationHours = Math.round(((times.length - 1) * sampleIntervalMinutes()) / 60);
    els.hourCount.textContent = `${durationHours} hours · ${sampleIntervalMinutes()}-min data`;
    els.stormSelect.value = data.metadata.id;
    document.title = `${data.metadata.displayTitle} Water-Level Timeline`;
  }

  function configureTimeline() {
    const landfall = new Date(data.metadata.landfallTime);
    els.slider.max = String(times.length - 1);
    els.date.step = String(sampleIntervalMinutes() * 60);
    els.date.min = inputLocalValue(times[0]);
    els.date.max = inputLocalValue(times[times.length - 1]);
    els.dateZone.textContent = new Intl.DateTimeFormat("en-US", {
      timeZone: data.metadata.localTimezone,
      timeZoneName: "short"
    }).formatToParts(landfall).find(part => part.type === "timeZoneName").value;
    els.rangeStart.textContent = formatDateTick(times[0]);
    els.rangeLandfall.textContent = `${formatDateTick(landfall)} landfall`;
    els.rangeEnd.textContent = formatDateTick(times[times.length - 1]);
  }

  function normalizedChartWindowHours(value) {
    if (value == null || value === "full") return null;
    const hours = Number(value);
    const fullSpanHours = Math.max(0, ((times.length - 1) * sampleIntervalMinutes()) / 60);
    if (!Number.isFinite(hours) || hours <= 0 || hours >= fullSpanHours) return null;
    return Math.round(hours);
  }

  function configureChartWindow(hours, centerIndex) {
    const last = Math.max(0, times.length - 1);
    chartWindowHours = normalizedChartWindowHours(hours);
    if (chartWindowHours == null) {
      chartStartIndex = 0;
      chartEndIndex = last;
      return;
    }
    const span = Math.min(hourStep(chartWindowHours), last);
    chartStartIndex = Math.max(0, Math.min(last - span, Math.round(centerIndex - span / 2)));
    chartEndIndex = chartStartIndex + span;
  }

  function updateChartWindowControls() {
    els.chartWindowSelect.value = chartWindowHours == null ? "full" : String(chartWindowHours);
    els.chartEarlier.disabled = chartStartIndex <= 0;
    els.chartLater.disabled = chartEndIndex >= times.length - 1;
    els.chartRange.textContent = formatChartRange();
  }

  function rebuildWaterChart() {
    chart = buildWaterChart();
    updateChartWindowControls();
    renderGauges(index);
  }

  function resetChartWindow() {
    stopPlayback();
    const landfallIndex = nearestIndex(new Date(data.metadata.landfallTime));
    configureChartWindow(stormConfig?.defaultChartWindowHours ?? data.metadata.defaultChartWindowHours ?? null, landfallIndex);
    rebuildWaterChart();
  }

  function shiftChartWindow(direction) {
    if (chartWindowHours == null) return;
    stopPlayback();
    const last = times.length - 1;
    const span = chartEndIndex - chartStartIndex;
    const shift = Math.max(1, Math.round(span * .25)) * direction;
    const nextStart = Math.max(0, Math.min(last - span, chartStartIndex + shift));
    if (nextStart === chartStartIndex) return;
    chartStartIndex = nextStart;
    chartEndIndex = nextStart + span;
    rebuildWaterChart();
  }

  function ensureChartContainsIndex(targetIndex) {
    if (chartWindowHours == null) return false;
    const last = times.length - 1;
    const span = chartEndIndex - chartStartIndex;
    const buffer = Math.max(1, Math.round(span * .1));
    let nextStart = chartStartIndex;
    if (targetIndex <= chartStartIndex && chartStartIndex > 0) {
      nextStart = targetIndex - buffer;
    } else if (targetIndex >= chartEndIndex && chartEndIndex < last) {
      nextStart = targetIndex - (span - buffer);
    }
    nextStart = Math.max(0, Math.min(last - span, nextStart));
    if (nextStart === chartStartIndex) return false;
    chartStartIndex = nextStart;
    chartEndIndex = nextStart + span;
    return true;
  }

  function buildTrackLayers() {
    trackLayer = L.layerGroup().addTo(map);
    L.polyline(track.map(point => [point.lat, point.lon]), {
      color: "#9ab0bd",
      weight: 2,
      opacity: .42,
      dashArray: "4 8"
    }).addTo(trackLayer);

    track.forEach(point => {
      L.circleMarker([point.lat, point.lon], {
        radius: point.record === "L" ? 3.8 : 2.5,
        color: point.record === "L" ? "#f3c967" : "#d6e1e6",
        fillColor: "#071522",
        fillOpacity: 1,
        weight: point.record === "L" ? 1.5 : 1,
        opacity: .78
      })
        .bindTooltip(`${formatUtcShort(point.time)} · ${point.wind ?? "—"} kt${point.record === "L" ? " · landfall" : ""}`, {
          direction: "top",
          opacity: .9
        })
        .addTo(trackLayer);
    });

    elapsedTrack = L.polyline([], {
      color: "#f3c967",
      weight: 3,
      opacity: .9
    }).addTo(map);
  }

  function buildStationMarkers() {
    data.stationOrder.forEach(id => {
      const station = data.stations[id];
      if (!station.available || station.lat == null || station.lon == null) return;
      const marker = L.circleMarker([station.lat, station.lon], {
        radius: 9,
        color: "#fff",
        weight: 2,
        fillColor: "#6f8795",
        fillOpacity: .98
      }).addTo(map);

      marker.bindTooltip("", {
        permanent: true,
        direction: station.tooltipDirection || "auto",
        offset: L.point(station.tooltipOffset || [0, 0]),
        className: "station-tooltip",
        opacity: 1
      });
      marker.on("click", () => {
        map.flyTo([station.lat, station.lon], Math.max(map.getZoom(), 9), { duration: .5 });
      });
      stationMarkers[id] = marker;
    });
  }

  function loadStorm(stormId, updateUrl = true) {
    const nextData = DATASETS[stormId] || DATASETS[CATALOG[0].id];
    if (!nextData) return;
    stopPlayback();
    cleanupStormLayers();
    data = nextData;
    stormConfig = CATALOG.find(storm => storm.id === data.metadata.id) || null;
    configureActiveWindow(data);
    track = data.track.map(point => ({
      time: new Date(point[0]),
      lat: point[1],
      lon: point[2],
      pressure: point[3],
      wind: point[4],
      stage: point[5],
      record: point[6]
    }));
    stationColors = Object.fromEntries(data.stationOrder.map((id, i) => [id, seriesPalette[i % seriesPalette.length]]));
    visibleStations = new Set(data.stationOrder.filter(id => data.stations[id].available));
    chartYScale = null;
    updateHeader();
    configureTimeline();
    map.fitBounds(L.latLngBounds(data.metadata.mapBounds), { padding: [16, 16] });
    buildTrackLayers();
    buildStationMarkers();
    index = nearestIndex(new Date(data.metadata.landfallTime));
    configureChartWindow(stormConfig?.defaultChartWindowHours ?? data.metadata.defaultChartWindowHours ?? null, index);
    chart = buildWaterChart();
    updateChartWindowControls();
    render();
    if (updateUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set("storm", data.metadata.id);
      window.history.replaceState({ storm: data.metadata.id }, "", url);
    }
  }

  function stormAt(value) {
    if (value < track[0].time || value > track[track.length - 1].time) return null;
    let lower = track[0];
    let upper = track[0];
    for (let i = 0; i < track.length - 1; i++) {
      if (value >= track[i].time && value <= track[i + 1].time) {
        lower = track[i];
        upper = track[i + 1];
        break;
      }
    }
    const span = upper.time - lower.time;
    const fraction = span ? (value - lower.time) / span : 0;
    const lerp = (a, b) => a == null || b == null ? a ?? b : a + (b - a) * fraction;
    return {
      lat: lerp(lower.lat, upper.lat),
      lon: lerp(lower.lon, upper.lon),
      pressure: Math.round(lerp(lower.pressure, upper.pressure)),
      wind: Math.round(lerp(lower.wind, upper.wind)),
      stage: fraction === 1 ? upper.stage : lower.stage,
      exact: fraction === 0 || fraction === 1
    };
  }

  function renderStorm(value) {
    const storm = stormAt(value);
    if (stormMarker) {
      map.removeLayer(stormMarker);
      stormMarker = null;
    }
    const elapsed = track.filter(point => point.time <= value).map(point => [point.lat, point.lon]);
    if (storm) elapsed.push([storm.lat, storm.lon]);
    elapsedTrack.setLatLngs(elapsed);

    if (!storm) {
      const before = value < track[0].time;
      els.storm.innerHTML = `<div class="no-storm"><strong>${before ? `Before ${data.metadata.name}'s best track` : `${data.metadata.name} no longer tracked`}</strong><span>${before ? `First NHC best-track point: ${formatUtcShort(track[0].time)}` : `Last NHC best-track point: ${formatUtcShort(track[track.length - 1].time)}`}</span></div>`;
      return;
    }

    const stageColor = stageColors[storm.stage] || "#8096a3";
    const icon = L.divIcon({
      className: "",
      html: `<div class="storm-dot" style="--stage:${stageColor}"></div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    });
    stormMarker = L.marker([storm.lat, storm.lon], { icon, zIndexOffset: 1000 }).addTo(map);
    stormMarker.bindTooltip(
      `<div class="storm-map-label" style="--stage:${stageColor}"><strong>${data.metadata.name} · ${storm.wind ?? "—"} kt</strong><span>${storm.wind == null ? "—" : Math.round(storm.wind * 1.15078) + " mph"} · ${storm.pressure ?? "—"} mb</span></div>`,
      { permanent: true, direction: "top", offset: [0, -13], className: "storm-tooltip", opacity: 1 }
    );
    els.storm.innerHTML = `
      <div class="storm-top">
        <div><div class="eyebrow">NHC BEST TRACK</div><div class="storm-name">${data.metadata.name}</div></div>
        <span class="stage-pill" style="--stage:${stageColor}">${storm.stage}</span>
      </div>
      <div class="storm-metrics">
        <div class="metric"><strong>${storm.wind ?? "—"} kt</strong><span>${storm.wind == null ? "—" : Math.round(storm.wind * 1.15078) + " mph"}</span></div>
        <div class="metric"><strong>${storm.pressure ?? "—"}</strong><span>minimum mb</span></div>
        <div class="metric"><strong>${storm.lat.toFixed(1)}°N</strong><span>${Math.abs(storm.lon).toFixed(1)}°W</span></div>
      </div>
      <div class="storm-note">${storm.exact ? "Official best-track fix" : "Interpolation between official fixes"}</div>`;
  }

  function dynamicChartTicks(measuredWidth) {
    const span = chartEndIndex - chartStartIndex;
    const tickCount = measuredWidth < 390 ? 4 : 5;
    const spanHours = (span * sampleIntervalMinutes()) / 60;
    const formatter = spanHours <= 72 ? formatDateTimeTick : formatDateTick;
    const candidates = Array.from({ length: tickCount }, (_, position) =>
      Math.round(chartStartIndex + (span * position) / Math.max(1, tickCount - 1))
    );
    return [...new Set(candidates)].sort((a, b) => a - b).map((tick, position, list) => ({
      index: tick,
      label: formatter(times[tick]),
      anchor: position === 0 ? "start" : position === list.length - 1 ? "end" : "middle"
    }));
  }

  function valuesInChartWindow(stationIds) {
    const values = [];
    stationIds.forEach(id => {
      for (let i = chartStartIndex; i <= chartEndIndex; i++) {
        const value = activeValues[id][i][0];
        if (value != null) values.push(value);
      }
    });
    return values;
  }

  function calculateChartYScale() {
    const visibleIds = data.stationOrder.filter(id => data.stations[id].available && visibleStations.has(id));
    let observedValues = valuesInChartWindow(visibleIds);
    if (!observedValues.length && chartYScale) return chartYScale;
    if (!observedValues.length) {
      observedValues = valuesInChartWindow(data.stationOrder.filter(id => data.stations[id].available));
    }
    if (!observedValues.length) {
      chartYScale = { yMin: -1, yMax: 1 };
      return chartYScale;
    }
    const rawMin = Math.min(...observedValues);
    const rawMax = Math.max(...observedValues);
    const padding = Math.max(.2, (rawMax - rawMin) * .08);
    const yMin = Math.floor((rawMin - padding) * 2) / 2;
    let yMax = Math.ceil((rawMax + padding) * 2) / 2;
    if (yMax <= yMin) yMax = yMin + 1;
    chartYScale = { yMin, yMax };
    return chartYScale;
  }

  function buildWaterChart() {
    const measuredWidth = Math.round(els.chart.clientWidth || 480);
    const measuredHeight = Math.round(els.chart.clientHeight || 360);
    const size = {
      width: Math.max(320, measuredWidth),
      height: Math.max(260, measuredHeight),
      left: 38,
      right: 12,
      top: 12,
      bottom: 30
    };
    const plotWidth = size.width - size.left - size.right;
    const plotBottom = size.height - size.bottom;
    const plotHeight = plotBottom - size.top;
    const { yMin, yMax } = calculateChartYScale();
    const chartSpan = Math.max(1, chartEndIndex - chartStartIndex);
    const x = i => size.left + ((i - chartStartIndex) / chartSpan) * plotWidth;
    const y = value => size.top + ((yMax - value) / (yMax - yMin)) * plotHeight;
    const yTicks = Array.from({ length: 6 }, (_, i) => yMin + ((yMax - yMin) * i) / 5);

    const pathFor = id => {
      let drawing = false;
      let path = "";
      for (let i = chartStartIndex; i <= chartEndIndex; i++) {
        const value = activeValues[id][i][0];
        if (value == null) {
          drawing = false;
          continue;
        }
        path += `${drawing ? " L" : "M"}${x(i).toFixed(2)},${y(value).toFixed(2)}`;
        drawing = true;
      }
      return path;
    };

    const grid = yTicks.map(value => {
      const py = y(value);
      return `<line class="chart-grid" x1="${size.left}" y1="${py}" x2="${size.width - size.right}" y2="${py}"></line><text class="chart-axis-label" x="${size.left - 5}" y="${py + 3}" text-anchor="end">${value.toFixed(1)}</text>`;
    }).join("");
    const dates = dynamicChartTicks(size.width).map(tick => {
      const px = x(tick.index);
      return `<line class="chart-grid" x1="${px}" y1="${size.top}" x2="${px}" y2="${plotBottom}"></line><text class="chart-axis-label" x="${px}" y="${size.height - 8}" text-anchor="${tick.anchor}">${tick.label}</text>`;
    }).join("");
    const series = data.stationOrder.map(id =>
      `<path class="chart-series${visibleStations.has(id) ? "" : " is-hidden"}" data-series="${id}" d="${pathFor(id)}" stroke="${stationColors[id]}"></path>`
    ).join("");
    const points = data.stationOrder.map(id =>
      `<circle class="chart-point${visibleStations.has(id) ? "" : " is-hidden"}" data-point="${id}" r="3.5" fill="${stationColors[id]}"></circle>`
    ).join("");

    els.chart.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);
    els.chart.innerHTML = `
      <defs><clipPath id="water-chart-clip"><rect x="${size.left}" y="${size.top}" width="${plotWidth}" height="${plotHeight}"></rect></clipPath></defs>
      ${grid}${dates}
      <g clip-path="url(#water-chart-clip)">${series}<line class="chart-cursor" x1="0" y1="${size.top}" x2="0" y2="${plotBottom}"></line>${points}</g>
      <rect class="chart-hit-area" x="${size.left}" y="${size.top}" width="${plotWidth}" height="${plotHeight}"></rect>`;

    els.chartLegend.innerHTML = data.stationOrder.map(id => {
      const station = data.stations[id];
      const available = station.available;
      const checked = available && visibleStations.has(id);
      return `<label class="chart-legend-item${checked ? "" : " is-muted"}${available ? "" : " is-unavailable"}" data-chart-station="${id}" style="--series:${stationColors[id]}"><input class="station-toggle" type="checkbox" data-station="${id}" aria-label="Show ${station.name}"${checked ? " checked" : ""}${available ? "" : " disabled"}><span class="chart-swatch"></span><span class="chart-legend-name">${station.name} <small>${station.datum}</small></span><strong class="chart-legend-value" data-chart-value="${id}">${available ? "—" : "No data"}</strong></label>`;
    }).join("");
    els.chartLegend.querySelectorAll(".station-toggle:not(:disabled)").forEach(toggle => {
      toggle.addEventListener("change", () => {
        setStationVisible(toggle.dataset.station, toggle.checked);
        rebuildWaterChart();
      });
    });

    let dragging = false;
    const seekFromPointer = event => {
      const bounds = els.chart.getBoundingClientRect();
      const viewX = ((event.clientX - bounds.left) / bounds.width) * size.width;
      const fraction = Math.max(0, Math.min(1, (viewX - size.left) / plotWidth));
      const next = chartStartIndex + Math.round(fraction * (chartEndIndex - chartStartIndex));
      stopPlayback();
      setIndex(next, { syncChart: false });
    };
    els.chart.onpointerdown = event => {
      event.preventDefault();
      dragging = true;
      els.chart.setPointerCapture(event.pointerId);
      seekFromPointer(event);
    };
    els.chart.onpointermove = event => { if (dragging) seekFromPointer(event); };
    els.chart.onpointerup = () => { dragging = false; };
    els.chart.onpointercancel = () => { dragging = false; };

    return {
      x,
      y,
      yMin,
      yMax,
      startIndex: chartStartIndex,
      endIndex: chartEndIndex,
      measuredWidth,
      measuredHeight,
      cursor: els.chart.querySelector(".chart-cursor"),
      series: Object.fromEntries(data.stationOrder.map(id => [id, els.chart.querySelector(`[data-series="${id}"]`)])),
      points: Object.fromEntries(data.stationOrder.map(id => [id, els.chart.querySelector(`[data-point="${id}"]`)]))
    };
  }

  function setStationVisible(id, isVisible) {
    if (!data.stations[id].available) return;
    if (isVisible) visibleStations.add(id);
    else visibleStations.delete(id);
  }

  function setAllStationsVisible(isVisible) {
    data.stationOrder.forEach(id => setStationVisible(id, isVisible));
    rebuildWaterChart();
  }

  function renderGauges(i) {
    const selectedTimeIsVisible = i >= chartStartIndex && i <= chartEndIndex;
    data.stationOrder.forEach(id => {
      const station = data.stations[id];
      const [observed, predicted, departure] = activeValues[id][i];
      const isVisible = station.available && visibleStations.has(id);
      const marker = stationMarkers[id];
      const color = colorForDeparture(departure);

      if (marker) {
        if (isVisible && !map.hasLayer(marker)) marker.addTo(map);
        if (!isVisible && map.hasLayer(marker)) map.removeLayer(marker);
        marker.setStyle({ fillColor: color });
        marker.setRadius(8 + Math.min(6, Math.max(0, departure || 0) * 1.8));
        marker.setTooltipContent(
          `<div class="station-map-label" style="--dot:${color}"><div class="name">${station.name}</div><span class="reading">${observed == null ? "—" : observed.toFixed(2) + " ft"}</span><span class="delta">${signed(departure)} ft</span></div>`
        );
        const departureLabel = station.predictionsAvailable ? "Departure from predicted tide" : `Departure from ${station.normal}`;
        marker.bindPopup(
          `<strong>${station.name}</strong><br>Observed: ${observed == null ? "missing" : observed.toFixed(2) + " ft " + station.datum}<br>${departureLabel}: ${signed(departure)} ft${predicted == null ? "" : `<br>Predicted tide: ${predicted.toFixed(2)} ft ${station.datum}`}<br><small>${station.source === "usgs" ? "USGS site" : "NOAA station"} ${id}</small>`
        );
      }

      const legendItem = els.chartLegend.querySelector(`[data-chart-station="${id}"]`);
      const legendValue = els.chartLegend.querySelector(`[data-chart-value="${id}"]`);
      if (!station.available) {
        legendValue.textContent = "No data";
      } else {
        legendValue.textContent = observed == null ? "—" : `${observed.toFixed(2)} ft`;
        legendItem.classList.toggle("is-muted", !isVisible);
        legendItem.querySelector(".station-toggle").checked = isVisible;
      }
      chart.series[id].classList.toggle("is-hidden", !isVisible);
      const point = chart.points[id];
      if (observed == null || !isVisible || !selectedTimeIsVisible) {
        point.classList.add("is-hidden");
      } else {
        point.classList.remove("is-hidden");
        point.setAttribute("cx", chart.x(i));
        point.setAttribute("cy", chart.y(observed));
      }
    });

    chart.cursor.classList.toggle("is-hidden", !selectedTimeIsVisible);
    if (selectedTimeIsVisible) {
      const cursorX = chart.x(i);
      chart.cursor.setAttribute("x1", cursorX);
      chart.cursor.setAttribute("x2", cursorX);
    }
    els.chartTime.textContent = formatLocalChart(times[i]);
    els.chart.setAttribute("aria-label", `${sampleIntervalMinutes()}-minute water levels for ${data.metadata.displayTitle}. Visible range: ${formatLocal(times[chartStartIndex])} through ${formatLocal(times[chartEndIndex])}. Selected time: ${formatLocal(times[i])}.`);
  }

  function render() {
    const value = times[index];
    els.local.textContent = formatLocal(value);
    els.utc.textContent = formatUtc(value);
    els.slider.value = index;
    els.date.value = inputLocalValue(value);
    renderStorm(value);
    renderGauges(index);
    document.querySelectorAll(".jump-button").forEach(button => button.classList.remove("active"));
    if (index === 0) document.getElementById("jump-start").classList.add("active");
    if (index === nearestIndex(new Date(data.metadata.landfallTime))) document.getElementById("jump-landfall").classList.add("active");
  }

  function setIndex(next, { syncChart = true } = {}) {
    index = Math.max(0, Math.min(times.length - 1, next));
    if (syncChart && ensureChartContainsIndex(index)) {
      chart = buildWaterChart();
      updateChartWindowControls();
    }
    render();
    if (index === times.length - 1 && timer) stopPlayback();
  }

  function stopPlayback() {
    clearInterval(timer);
    timer = null;
    els.play.classList.remove("playing");
    els.play.innerHTML = '<span aria-hidden="true">▶</span>';
    els.play.setAttribute("aria-label", "Play timeline");
  }

  function startPlayback() {
    if (index === times.length - 1) setIndex(0);
    timer = setInterval(() => setIndex(index + 1), Number(els.speed.value));
    els.play.classList.add("playing");
    els.play.innerHTML = '<span aria-hidden="true">Ⅱ</span>';
    els.play.setAttribute("aria-label", "Pause timeline");
  }

  function togglePlayback() {
    timer ? stopPlayback() : startPlayback();
  }

  els.stormSelect.innerHTML = CATALOG.map(storm => `<option value="${storm.id}">${storm.name} — ${storm.year}</option>`).join("");
  els.stormSelect.addEventListener("change", event => loadStorm(event.target.value));
  document.getElementById("back-6").addEventListener("click", () => setIndex(index - hourStep(6)));
  document.getElementById("back-1").addEventListener("click", () => setIndex(index - hourStep(1)));
  document.getElementById("forward-1").addEventListener("click", () => setIndex(index + hourStep(1)));
  document.getElementById("forward-6").addEventListener("click", () => setIndex(index + hourStep(6)));
  document.getElementById("jump-start").addEventListener("click", () => setIndex(0));
  document.getElementById("jump-landfall").addEventListener("click", () => setIndex(nearestIndex(new Date(data.metadata.landfallTime))));
  document.getElementById("reset-view").addEventListener("click", () => {
    map.fitBounds(L.latLngBounds(data.metadata.mapBounds), { padding: [16, 16] });
  });
  els.chartWindowSelect.addEventListener("change", event => {
    stopPlayback();
    configureChartWindow(event.target.value, index);
    rebuildWaterChart();
  });
  els.chartEarlier.addEventListener("click", () => shiftChartWindow(-1));
  els.chartLater.addEventListener("click", () => shiftChartWindow(1));
  els.resetChartWindow.addEventListener("click", resetChartWindow);
  els.showAllStations.addEventListener("click", () => setAllStationsVisible(true));
  els.hideAllStations.addEventListener("click", () => setAllStationsVisible(false));
  els.slider.addEventListener("input", event => {
    stopPlayback();
    setIndex(Number(event.target.value));
  });
  els.play.addEventListener("click", togglePlayback);
  els.speed.addEventListener("change", () => {
    if (timer) {
      stopPlayback();
      startPlayback();
    }
  });
  els.date.addEventListener("change", event => {
    if (!event.target.value) return;
    stopPlayback();
    setIndex(nearestIndex(zonedInputToDate(event.target.value)));
  });

  document.addEventListener("keydown", event => {
    if (["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      stopPlayback();
      setIndex(index - hourStep(event.shiftKey ? 6 : 1));
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      stopPlayback();
      setIndex(index + hourStep(event.shiftKey ? 6 : 1));
    }
    if (event.key === " ") {
      event.preventDefault();
      togglePlayback();
    }
  });

  let chartResizeFrame = null;
  const resizeWaterChart = () => {
    if (!chart) return;
    const nextWidth = Math.round(els.chart.clientWidth);
    const nextHeight = Math.round(els.chart.clientHeight);
    if (!nextWidth || !nextHeight) return;
    if (chart.measuredWidth === nextWidth && chart.measuredHeight === nextHeight) return;
    chart = buildWaterChart();
    renderGauges(index);
  };
  const scheduleChartResize = () => {
    if (chartResizeFrame) cancelAnimationFrame(chartResizeFrame);
    chartResizeFrame = requestAnimationFrame(() => {
      chartResizeFrame = null;
      resizeWaterChart();
    });
  };
  if ("ResizeObserver" in window) {
    const chartResizeObserver = new ResizeObserver(scheduleChartResize);
    chartResizeObserver.observe(document.querySelector(".water-chart-wrap"));
  }
  window.addEventListener("resize", () => {
    map.invalidateSize();
    scheduleChartResize();
  });

  const requestedStorm = new URL(window.location.href).searchParams.get("storm");
  const initialStorm = CATALOG.some(storm => storm.id === requestedStorm) ? requestedStorm : CATALOG[0].id;
  loadStorm(initialStorm);
  requestAnimationFrame(() => {
    map.invalidateSize();
    resizeWaterChart();
  });
})();
