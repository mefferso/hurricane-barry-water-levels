(() => {
  "use strict";

  const DATA = window.BARRY_DATA;
  if (!DATA || !window.L) {
    document.body.innerHTML = '<p style="padding:2rem;color:white">The map data or mapping library failed to load.</p>';
    return;
  }

  const times = DATA.times.map(t => new Date(t));
  const stationDirections = {
    "8761927": { direction: "top", offset: [0, -12] },
    "8761724": { direction: "right", offset: [12, 0] },
    "8747437": { direction: "right", offset: [12, 0] },
    "8762075": { direction: "left", offset: [-12, 0] },
    "8762482": { direction: "left", offset: [-12, 0] }
  };

  const stageColors = {
    "Disturbance": "#8296a3",
    "Tropical Depression": "#3ca7e8",
    "Tropical Storm": "#f2c84b",
    "Hurricane": "#ff4d5e",
    "Remnant Low": "#a37bd7"
  };

  const stationSeriesColors = {
    "8761927": "#ff5f73",
    "8761724": "#f3cf64",
    "8747437": "#ff8fb1",
    "8762075": "#ff9f4a",
    "8762482": "#2ecbb3"
  };

  const els = {
    local: document.getElementById("time-local"),
    utc: document.getElementById("time-utc"),
    slider: document.getElementById("timeline"),
    play: document.getElementById("play"),
    speed: document.getElementById("speed-select"),
    date: document.getElementById("date-input"),
    storm: document.getElementById("storm-card"),
    chart: document.getElementById("water-chart"),
    chartLegend: document.getElementById("chart-legend"),
    chartTime: document.getElementById("chart-time"),
    showAllStations: document.getElementById("show-all-stations"),
    hideAllStations: document.getElementById("hide-all-stations")
  };

  const map = L.map("map", {
    zoomControl: true,
    preferCanvas: true,
    minZoom: 5,
    maxZoom: 12
  });

  const coastalView = L.latLngBounds([[27.15, -94.05], [31.2, -86.35]]);
  map.fitBounds(coastalView, { padding: [16, 16] });

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd",
    maxZoom: 20,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
  }).addTo(map);

  L.control.scale({ imperial: true, metric: false }).addTo(map);

  const track = DATA.track.map(p => ({
    time: new Date(p[0]),
    lat: p[1],
    lon: p[2],
    pressure: p[3],
    wind: p[4],
    stage: p[5]
  }));

  L.polyline(track.map(p => [p.lat, p.lon]), {
    color: "#9ab0bd",
    weight: 2,
    opacity: .42,
    dashArray: "4 8"
  }).addTo(map);

  const elapsedTrack = L.polyline([], {
    color: "#f3c967",
    weight: 3,
    opacity: .9
  }).addTo(map);

  track.forEach(p => {
    L.circleMarker([p.lat, p.lon], {
      radius: 2.5,
      color: "#d6e1e6",
      fillColor: "#071522",
      fillOpacity: 1,
      weight: 1,
      opacity: .75
    })
      .bindTooltip(`${formatUtcShort(p.time)} · ${p.wind} kt`, {
        direction: "top",
        opacity: .9
      })
      .addTo(map);
  });

  const stationMarkers = {};
  DATA.stationOrder.forEach(id => {
    const station = DATA.stations[id];
    const opt = stationDirections[id];
    const marker = L.circleMarker([station.lat, station.lon], {
      radius: 9,
      color: "#fff",
      weight: 2,
      fillColor: "#6f8795",
      fillOpacity: .98
    }).addTo(map);

    marker.bindTooltip("", {
      permanent: true,
      direction: opt.direction,
      offset: L.point(opt.offset),
      className: "station-tooltip",
      opacity: 1
    });

    marker.on("click", () => {
      map.flyTo([station.lat, station.lon], Math.max(map.getZoom(), 9), { duration: .5 });
    });

    stationMarkers[id] = marker;
  });

  const visibleStations = new Set(DATA.stationOrder);
  let stormMarker = null;
  let index = nearestIndex(new Date("2019-07-13T15:00:00Z"));
  let timer = null;
  let chart = buildWaterChart();

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

  function formatLocal(date) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short"
    }).format(date);
  }

  function formatUtc(date) {
    const day = String(date.getUTCDate()).padStart(2, "0");
    const hour = String(date.getUTCHours()).padStart(2, "0");
    return `${day}/${hour}00 UTC`;
  }

  function formatUtcShort(date) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date) + " UTC";
  }

  function inputLocalValue(date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date);
    const part = type => parts.find(p => p.type === type).value;
    return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
  }

  function nearestIndex(date) {
    return Math.max(0, Math.min(times.length - 1, Math.round((date - times[0]) / 3600000)));
  }

  function stormAt(date) {
    if (date < track[0].time || date > track[track.length - 1].time) return null;

    let lower = track[0];
    let upper = track[0];
    for (let i = 0; i < track.length - 1; i++) {
      if (date >= track[i].time && date <= track[i + 1].time) {
        lower = track[i];
        upper = track[i + 1];
        break;
      }
    }

    const span = upper.time - lower.time;
    const fraction = span ? (date - lower.time) / span : 0;
    const lerp = (a, b) => a + (b - a) * fraction;

    return {
      lat: lerp(lower.lat, upper.lat),
      lon: lerp(lower.lon, upper.lon),
      pressure: Math.round(lerp(lower.pressure, upper.pressure)),
      wind: Math.round(lerp(lower.wind, upper.wind)),
      stage: fraction === 1 ? upper.stage : lower.stage,
      exact: fraction === 0 || fraction === 1
    };
  }

  function renderStorm(date) {
    const storm = stormAt(date);

    if (stormMarker) {
      map.removeLayer(stormMarker);
      stormMarker = null;
    }

    const elapsed = track.filter(p => p.time <= date).map(p => [p.lat, p.lon]);
    if (storm) elapsed.push([storm.lat, storm.lon]);
    elapsedTrack.setLatLngs(elapsed);

    if (!storm) {
      const before = date < track[0].time;
      els.storm.innerHTML = `<div class="no-storm"><strong>${before ? "Before Barry's best track" : "Barry no longer tracked"}</strong><span>${before ? "First NHC best-track point: Jul 10 at 1200 UTC" : "The remnant low dissipated on Jul 16"}</span></div>`;
      return;
    }

    const stageColor = stageColors[storm.stage] || "#8096a3";
    const icon = L.divIcon({
      className: "",
      html: `<div class="storm-dot" style="--stage:${stageColor}"></div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    });

    stormMarker = L.marker([storm.lat, storm.lon], {
      icon,
      zIndexOffset: 1000
    }).addTo(map);

    stormMarker.bindTooltip(
      `<div class="storm-map-label" style="--stage:${stageColor}"><strong>Barry · ${storm.wind} kt</strong><span>${Math.round(storm.wind * 1.15078)} mph · ${storm.pressure} mb</span></div>`,
      {
        permanent: true,
        direction: "top",
        offset: [0, -13],
        className: "storm-tooltip",
        opacity: 1
      }
    );

    els.storm.innerHTML = `
      <div class="storm-top">
        <div><div class="eyebrow">NHC BEST TRACK</div><div class="storm-name">Barry</div></div>
        <span class="stage-pill" style="--stage:${stageColor}">${storm.stage}</span>
      </div>
      <div class="storm-metrics">
        <div class="metric"><strong>${storm.wind} kt</strong><span>${Math.round(storm.wind * 1.15078)} mph</span></div>
        <div class="metric"><strong>${storm.pressure}</strong><span>minimum mb</span></div>
        <div class="metric"><strong>${storm.lat.toFixed(1)}°N</strong><span>${Math.abs(storm.lon).toFixed(1)}°W</span></div>
      </div>
      <div class="storm-note">${storm.exact ? "Official best-track fix" : "Hourly interpolation between official fixes"}</div>`;
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
    const observedValues = DATA.stationOrder.flatMap(id =>
      DATA.stations[id].values.map(row => row[0]).filter(value => value != null)
    );
    const yMin = Math.floor((Math.min(...observedValues) - .1) * 2) / 2;
    const yMax = Math.ceil((Math.max(...observedValues) + .1) * 2) / 2;
    const x = i => size.left + (i / (times.length - 1)) * plotWidth;
    const y = value => size.top + ((yMax - value) / (yMax - yMin)) * plotHeight;
    const yTicks = Array.from({ length: 6 }, (_, i) => yMin + ((yMax - yMin) * i) / 5);
    const xTicks = [
      { index: 0, label: "Jul 10", anchor: "start" },
      { index: 87, label: "Jul 13", anchor: "middle" },
      { index: 168, label: "Jul 17", anchor: "middle" },
      { index: times.length - 1, label: "Jul 20", anchor: "end" }
    ];

    const pathFor = id => {
      let drawing = false;
      let path = "";
      DATA.stations[id].values.forEach((row, i) => {
        const value = row[0];
        if (value == null) {
          drawing = false;
          return;
        }
        path += `${drawing ? " L" : "M"}${x(i).toFixed(2)},${y(value).toFixed(2)}`;
        drawing = true;
      });
      return path;
    };

    const grid = yTicks.map(value => {
      const py = y(value);
      return `<line class="chart-grid" x1="${size.left}" y1="${py}" x2="${size.width - size.right}" y2="${py}"></line><text class="chart-axis-label" x="${size.left - 5}" y="${py + 3}" text-anchor="end">${value.toFixed(1)}</text>`;
    }).join("");

    const dates = xTicks.map(tick => {
      const px = x(tick.index);
      return `<line class="chart-grid" x1="${px}" y1="${size.top}" x2="${px}" y2="${plotBottom}"></line><text class="chart-axis-label" x="${px}" y="${size.height - 8}" text-anchor="${tick.anchor}">${tick.label}</text>`;
    }).join("");

    const series = DATA.stationOrder.map(id =>
      `<path class="chart-series${visibleStations.has(id) ? "" : " is-hidden"}" data-series="${id}" d="${pathFor(id)}" stroke="${stationSeriesColors[id]}"></path>`
    ).join("");

    const points = DATA.stationOrder.map(id =>
      `<circle class="chart-point${visibleStations.has(id) ? "" : " is-hidden"}" data-point="${id}" r="3.5" fill="${stationSeriesColors[id]}"></circle>`
    ).join("");

    els.chart.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);
    els.chart.innerHTML = `
      <defs><clipPath id="water-chart-clip"><rect x="${size.left}" y="${size.top}" width="${plotWidth}" height="${plotHeight}"></rect></clipPath></defs>
      ${grid}${dates}
      <g clip-path="url(#water-chart-clip)">${series}<line class="chart-cursor" x1="0" y1="${size.top}" x2="0" y2="${plotBottom}"></line>${points}</g>
      <rect class="chart-hit-area" x="${size.left}" y="${size.top}" width="${plotWidth}" height="${plotHeight}"></rect>`;

    els.chartLegend.innerHTML = DATA.stationOrder.map(id => {
      const station = DATA.stations[id];
      const checked = visibleStations.has(id);
      return `<label class="chart-legend-item${checked ? "" : " is-muted"}" data-chart-station="${id}" style="--series:${stationSeriesColors[id]}"><input class="station-toggle" type="checkbox" data-station="${id}" aria-label="Show ${station.name}"${checked ? " checked" : ""}><span class="chart-swatch"></span><span class="chart-legend-name">${station.name} <small>${station.datum}</small></span><strong class="chart-legend-value" data-chart-value="${id}">—</strong></label>`;
    }).join("");

    els.chartLegend.querySelectorAll(".station-toggle").forEach(toggle => {
      toggle.addEventListener("change", () => {
        setStationVisible(toggle.dataset.station, toggle.checked);
        renderGauges(index);
      });
    });

    let dragging = false;
    const seekFromPointer = event => {
      const bounds = els.chart.getBoundingClientRect();
      const viewX = ((event.clientX - bounds.left) / bounds.width) * size.width;
      const next = Math.round(((viewX - size.left) / plotWidth) * (times.length - 1));
      stopPlayback();
      setIndex(next);
    };

    els.chart.onpointerdown = event => {
      dragging = true;
      els.chart.setPointerCapture(event.pointerId);
      seekFromPointer(event);
    };
    els.chart.onpointermove = event => {
      if (dragging) seekFromPointer(event);
    };
    els.chart.onpointerup = () => { dragging = false; };
    els.chart.onpointercancel = () => { dragging = false; };

    return {
      x,
      y,
      measuredWidth,
      measuredHeight,
      cursor: els.chart.querySelector(".chart-cursor"),
      series: Object.fromEntries(DATA.stationOrder.map(id => [id, els.chart.querySelector(`[data-series="${id}"]`)])),
      points: Object.fromEntries(DATA.stationOrder.map(id => [id, els.chart.querySelector(`[data-point="${id}"]`)])),
      top: size.top,
      bottom: plotBottom
    };
  }

  function setStationVisible(id, isVisible) {
    if (isVisible) visibleStations.add(id);
    else visibleStations.delete(id);
  }

  function setAllStationsVisible(isVisible) {
    DATA.stationOrder.forEach(id => setStationVisible(id, isVisible));
    renderGauges(index);
  }

  function renderGauges(i) {
    DATA.stationOrder.forEach(id => {
      const station = DATA.stations[id];
      const [observed, predicted, departure] = station.values[i];
      const color = colorForDeparture(departure);
      const marker = stationMarkers[id];
      const deltaLabel = id === "8762482" ? "Δ Jul 10 mean" : "Δ normal";
      const isVisible = visibleStations.has(id);

      if (isVisible && !map.hasLayer(marker)) marker.addTo(map);
      if (!isVisible && map.hasLayer(marker)) map.removeLayer(marker);

      marker.setStyle({ fillColor: color });
      marker.setRadius(8 + Math.min(6, Math.max(0, departure || 0) * 1.8));
      marker.setTooltipContent(
        `<div class="station-map-label" style="--dot:${color}"><div class="name">${station.name}</div><span class="reading">${observed == null ? "—" : observed.toFixed(2) + " ft"}</span><span class="delta">${signed(departure)} ft</span></div>`
      );

      marker.bindPopup(
        `<strong>${station.name}</strong><br>Observed: ${observed == null ? "missing" : observed.toFixed(2) + " ft " + station.datum}<br>${deltaLabel}: ${signed(departure)} ft${predicted == null ? "" : `<br>Predicted tide: ${predicted.toFixed(2)} ft MHHW`}<br><small>NOAA station ${id}</small>`
      );

      const legendValue = els.chartLegend.querySelector(`[data-chart-value="${id}"]`);
      legendValue.textContent = observed == null ? "—" : `${observed.toFixed(2)} ft`;
      const legendItem = els.chartLegend.querySelector(`[data-chart-station="${id}"]`);
      legendItem.classList.toggle("is-muted", !isVisible);
      legendItem.querySelector(".station-toggle").checked = isVisible;
      chart.series[id].classList.toggle("is-hidden", !isVisible);
      const point = chart.points[id];
      if (observed == null || !isVisible) {
        point.classList.add("is-hidden");
      } else {
        point.classList.remove("is-hidden");
        point.setAttribute("cx", chart.x(i));
        point.setAttribute("cy", chart.y(observed));
      }
    });

    const cursorX = chart.x(i);
    chart.cursor.setAttribute("x1", cursorX);
    chart.cursor.setAttribute("x2", cursorX);
    els.chartTime.textContent = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      month: "short",
      day: "numeric",
      hour: "numeric"
    }).format(times[i]);
    els.chart.setAttribute("aria-label", `Hourly verified water levels for five NOAA gauges. Selected time: ${formatLocal(times[i])}.`);
  }

  function render() {
    const date = times[index];
    els.local.textContent = formatLocal(date);
    els.utc.textContent = formatUtc(date);
    els.slider.value = index;
    els.date.value = inputLocalValue(date);
    renderStorm(date);
    renderGauges(index);

    document.querySelectorAll(".jump-button").forEach(button => button.classList.remove("active"));
    if (index === 0) document.getElementById("jump-start").classList.add("active");
    if (date.getTime() === new Date("2019-07-13T15:00:00Z").getTime()) {
      document.getElementById("jump-landfall").classList.add("active");
    }
  }

  function setIndex(next) {
    index = Math.max(0, Math.min(times.length - 1, next));
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
    if (index === times.length - 1) index = 0;
    timer = setInterval(() => setIndex(index + 1), Number(els.speed.value));
    els.play.classList.add("playing");
    els.play.innerHTML = '<span aria-hidden="true">Ⅱ</span>';
    els.play.setAttribute("aria-label", "Pause timeline");
  }

  function togglePlayback() {
    timer ? stopPlayback() : startPlayback();
  }

  document.getElementById("back-6").addEventListener("click", () => setIndex(index - 6));
  document.getElementById("back-1").addEventListener("click", () => setIndex(index - 1));
  document.getElementById("forward-1").addEventListener("click", () => setIndex(index + 1));
  document.getElementById("forward-6").addEventListener("click", () => setIndex(index + 6));
  document.getElementById("jump-start").addEventListener("click", () => setIndex(0));
  document.getElementById("jump-landfall").addEventListener("click", () => {
    setIndex(nearestIndex(new Date("2019-07-13T15:00:00Z")));
  });
  document.getElementById("reset-view").addEventListener("click", () => {
    map.fitBounds(coastalView, { padding: [16, 16] });
  });
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
    setIndex(nearestIndex(new Date(event.target.value + ":00-05:00")));
  });

  document.addEventListener("keydown", event => {
    if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      stopPlayback();
      setIndex(index - (event.shiftKey ? 6 : 1));
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      stopPlayback();
      setIndex(index + (event.shiftKey ? 6 : 1));
    }
    if (event.key === " ") {
      event.preventDefault();
      togglePlayback();
    }
  });

  let chartResizeFrame = null;
  const resizeWaterChart = () => {
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

  requestAnimationFrame(() => {
    map.invalidateSize();
    resizeWaterChart();
  });
  render();
})();
