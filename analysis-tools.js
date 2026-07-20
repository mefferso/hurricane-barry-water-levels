(() => {
  "use strict";

  const CATALOG = window.STORM_CATALOG || [];
  const DATASETS = window.STORM_DATASETS || {};
  const mainStormSelect = document.getElementById("storm-select");
  const timeline = document.getElementById("timeline");

  const els = {
    summaryLabel: document.getElementById("summary-storm-label"),
    summaryBody: document.querySelector("#event-summary-table tbody"),
    summaryMethod: document.getElementById("summary-method"),
    compareStorm: document.getElementById("comparison-storm-select"),
    compareStation: document.getElementById("comparison-station-select"),
    compareMetric: document.getElementById("comparison-metric-select"),
    compareWindow: document.getElementById("comparison-window-select"),
    compareSwap: document.getElementById("swap-comparison"),
    comparePrimaryLabel: document.getElementById("comparison-primary-label"),
    compareChart: document.getElementById("comparison-chart"),
    compareHover: document.getElementById("comparison-hover"),
    compareInsights: document.getElementById("comparison-insights")
  };

  if (!CATALOG.length || !Object.keys(DATASETS).length || !mainStormSelect || !timeline || Object.values(els).some(value => !value)) {
    return;
  }

  const HOUR_MS = 60 * 60 * 1000;
  const state = {
    comparisonStormId: null,
    stationId: null,
    metric: "departure",
    window: "120:72",
    chart: null,
    resizeFrame: null
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;"
    })[character]);
  }

  function datasetFor(id) {
    return DATASETS[id] || null;
  }

  function primaryDataset() {
    return datasetFor(mainStormSelect.value) || datasetFor(CATALOG[0].id);
  }

  function intervalMinutes(dataset) {
    return Math.max(1, Number(dataset?.metadata?.intervalMinutes) || 60);
  }

  function nearestIndex(target, dates) {
    if (!dates.length) return 0;
    let closest = 0;
    let distance = Math.abs(target - dates[0]);
    for (let index = 1; index < dates.length; index++) {
      const nextDistance = Math.abs(target - dates[index]);
      if (nextDistance < distance) {
        closest = index;
        distance = nextDistance;
      }
    }
    return closest;
  }

  function activeSlice(dataset) {
    const allTimes = dataset.times.map(value => new Date(value));
    const windowStart = new Date(dataset.metadata.eventWindow.displayStart);
    const windowEnd = new Date(dataset.metadata.eventWindow.displayEnd);
    const startIndex = nearestIndex(windowStart, allTimes);
    const endIndex = nearestIndex(windowEnd, allTimes);
    return {
      startIndex,
      endIndex,
      times: allTimes.slice(startIndex, endIndex + 1)
    };
  }

  function formatLocalCompact(date, dataset) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: dataset.metadata.localTimezone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short"
    }).format(date);
  }

  function formatRelative(hours, { compact = false } = {}) {
    if (!Number.isFinite(hours)) return "—";
    const sign = hours < -0.05 ? "−" : "+";
    const absolute = Math.abs(hours);
    if (absolute < 0.05) return "T+0h";
    const roundedTenths = Math.round(absolute * 10) / 10;
    if (compact && roundedTenths >= 48 && Math.abs(roundedTenths % 24) < 0.05) {
      return `T${sign}${Math.round(roundedTenths / 24)}d`;
    }
    if (roundedTenths >= 24) {
      const days = Math.floor(roundedTenths / 24);
      const remaining = Math.round((roundedTenths - days * 24) * 10) / 10;
      return remaining ? `T${sign}${days}d ${remaining}h` : `T${sign}${days}d`;
    }
    return `T${sign}${Number.isInteger(roundedTenths) ? roundedTenths.toFixed(0) : roundedTenths.toFixed(1)}h`;
  }

  function formatDuration(hours) {
    if (!Number.isFinite(hours) || hours <= 0) return "0h";
    if (hours < 1) return `${Math.round(hours * 60)}m`;
    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      const remaining = Math.round((hours - days * 24) * 10) / 10;
      return remaining ? `${days}d ${remaining}h` : `${days}d`;
    }
    const rounded = Math.round(hours * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}h`;
  }

  function finiteValue(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function hourlyDepartures(stationValues, slice) {
    const buckets = new Map();
    stationValues.forEach((values, index) => {
      const departure = values?.[2];
      if (!finiteValue(departure)) return;
      const hour = Math.floor(slice.times[index].getTime() / HOUR_MS) * HOUR_MS;
      if (!buckets.has(hour)) buckets.set(hour, []);
      buckets.get(hour).push(departure);
    });
    return [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([hour, values]) => ({ time: new Date(hour), departure: median(values) }));
  }

  function summaryForStation(dataset, stationId, slice) {
    const station = dataset.stations[stationId];
    const thresholds = dataset.metadata.eventWindow?.thresholds || {};
    const onsetThreshold = Number(thresholds.onset_threshold_ft) || 0.35;
    const onsetHours = Math.max(1, Math.ceil(Number(thresholds.onset_consecutive_hours) || 3));
    const landfall = new Date(dataset.metadata.landfallTime);
    const stationValues = station.values.slice(slice.startIndex, slice.endIndex + 1);
    const hourly = hourlyDepartures(stationValues, slice);

    let runLength = 0;
    let runStartTime = null;
    let riseTime = null;
    let previousHour = null;
    let peakIndex = null;
    let peakDeparture = -Infinity;

    hourly.forEach(point => {
      const isConsecutive = previousHour == null || Math.abs(point.time - previousHour - HOUR_MS) < 1000;
      if (!isConsecutive) {
        runLength = 0;
        runStartTime = null;
      }
      if (point.departure >= onsetThreshold) {
        if (!runLength) runStartTime = point.time;
        runLength += 1;
        if (riseTime == null && runLength >= onsetHours) riseTime = runStartTime;
      } else {
        runLength = 0;
        runStartTime = null;
      }
      previousHour = point.time;
    });

    stationValues.forEach((values, index) => {
      const departure = values?.[2];
      if (finiteValue(departure) && departure > peakDeparture) {
        peakDeparture = departure;
        peakIndex = index;
      }
    });

    const peakTime = peakIndex == null ? null : slice.times[peakIndex];
    const hoursAboveOne = hourly.filter(point => point.departure >= 1).length;
    return {
      station,
      stationId,
      riseTime,
      peakTime,
      peakDeparture: peakIndex == null ? null : peakDeparture,
      peakSliceIndex: peakIndex,
      relativePeakHours: peakTime ? (peakTime - landfall) / HOUR_MS : null,
      hoursAboveOne,
      onsetThreshold,
      onsetHours
    };
  }

  function renderSummary() {
    const dataset = primaryDataset();
    if (!dataset) return;
    const slice = activeSlice(dataset);
    const summaries = dataset.stationOrder
      .filter(id => dataset.stations[id]?.available)
      .map(id => summaryForStation(dataset, id, slice));

    els.summaryLabel.textContent = dataset.metadata.displayTitle;
    const threshold = summaries[0]?.onsetThreshold ?? 0.35;
    const hours = summaries[0]?.onsetHours ?? 3;
    els.summaryMethod.textContent = `Sustained rise is the first ${hours} consecutive hourly median departures at or above +${threshold.toFixed(2)} ft. Time at +1 ft counts hourly median intervals and may include separate episodes.`;

    if (!summaries.length) {
      els.summaryBody.innerHTML = '<tr><td colspan="6" class="analysis-empty">No available gauges for this event.</td></tr>';
      return;
    }

    els.summaryBody.innerHTML = summaries.map(summary => {
      const canJump = summary.peakSliceIndex != null;
      const riseText = summary.riseTime ? formatLocalCompact(summary.riseTime, dataset) : "Not reached";
      const peakText = summary.peakDeparture == null ? "—" : `${summary.peakDeparture >= 0 ? "+" : ""}${summary.peakDeparture.toFixed(2)} ft`;
      const peakTimeText = summary.peakTime ? formatLocalCompact(summary.peakTime, dataset) : "—";
      return `<tr${canJump ? ` class="summary-jump-row" tabindex="0" role="button" data-peak-index="${summary.peakSliceIndex}" aria-label="Jump to ${escapeHtml(summary.station.name)} peak"` : ""}>
        <td><strong>${escapeHtml(summary.station.name)}</strong><small>${escapeHtml(summary.station.datum || "")}</small></td>
        <td>${escapeHtml(riseText)}</td>
        <td class="summary-number">${peakText}</td>
        <td>${escapeHtml(peakTimeText)}</td>
        <td class="summary-number">${formatRelative(summary.relativePeakHours)}</td>
        <td class="summary-number">${formatDuration(summary.hoursAboveOne)}</td>
      </tr>`;
    }).join("");
  }

  function jumpToSummaryRow(row) {
    const peakIndex = Number(row?.dataset?.peakIndex);
    if (!Number.isInteger(peakIndex)) return;
    timeline.value = String(peakIndex);
    timeline.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function chooseDefaultComparison(primaryId) {
    const preferred = primaryId === "barry-2019" ? "ida-2021" : "barry-2019";
    if (datasetFor(preferred)) return preferred;
    return CATALOG.find(storm => storm.id !== primaryId && datasetFor(storm.id))?.id || null;
  }

  function populateComparisonStorms() {
    els.compareStorm.innerHTML = CATALOG
      .filter(storm => datasetFor(storm.id))
      .map(storm => `<option value="${escapeHtml(storm.id)}">${escapeHtml(storm.name)} — ${storm.year}</option>`)
      .join("");
  }

  function metricIndex(metric) {
    return metric === "observed" ? 0 : 2;
  }

  function stationHasMetric(dataset, stationId, metric) {
    const station = dataset?.stations?.[stationId];
    if (!station?.available) return false;
    const index = metricIndex(metric);
    return station.values.some(values => finiteValue(values?.[index]));
  }

  function commonStations(primary, comparison, metric) {
    return primary.stationOrder.filter(id =>
      comparison.stations[id] && stationHasMetric(primary, id, metric) && stationHasMetric(comparison, id, metric)
    );
  }

  function renderStationOptions(primary, comparison) {
    const stations = commonStations(primary, comparison, state.metric);
    const previous = state.stationId || els.compareStation.value;
    els.compareStation.innerHTML = stations.map(id => {
      const station = primary.stations[id];
      return `<option value="${escapeHtml(id)}">${escapeHtml(station.name)}</option>`;
    }).join("");
    state.stationId = stations.includes(previous) ? previous : stations.find(id => /new canal/i.test(primary.stations[id].name)) || stations[0] || null;
    els.compareStation.value = state.stationId || "";
    els.compareStation.disabled = !stations.length;
    return stations;
  }

  function relativeRange(dataset) {
    const landfall = new Date(dataset.metadata.landfallTime).getTime();
    return [
      (new Date(dataset.times[0]).getTime() - landfall) / HOUR_MS,
      (new Date(dataset.times[dataset.times.length - 1]).getTime() - landfall) / HOUR_MS
    ];
  }

  function comparisonDomain(primary, comparison) {
    if (state.window !== "full") {
      const [before, after] = state.window.split(":").map(Number);
      return [-before, after];
    }
    const primaryRange = relativeRange(primary);
    const comparisonRange = relativeRange(comparison);
    const min = Math.max(primaryRange[0], comparisonRange[0]);
    const max = Math.min(primaryRange[1], comparisonRange[1]);
    return min < max ? [min, max] : [Math.min(primaryRange[0], comparisonRange[0]), Math.max(primaryRange[1], comparisonRange[1])];
  }

  function comparisonSeries(dataset, stationId, metric, domain) {
    const landfall = new Date(dataset.metadata.landfallTime).getTime();
    const values = dataset.stations[stationId].values;
    const valuePosition = metricIndex(metric);
    const points = [];
    for (let index = 0; index < dataset.times.length; index++) {
      const time = new Date(dataset.times[index]);
      const relativeHour = (time.getTime() - landfall) / HOUR_MS;
      if (relativeHour < domain[0] - 0.001 || relativeHour > domain[1] + 0.001) continue;
      const rawValue = values[index]?.[valuePosition];
      points.push({
        relativeHour,
        value: finiteValue(rawValue) ? rawValue : null,
        time
      });
    }
    return points;
  }

  function validPoints(points) {
    return points.filter(point => finiteValue(point.value));
  }

  function peakPoint(points) {
    return validPoints(points).reduce((peak, point) => !peak || point.value > peak.value ? point : peak, null);
  }

  function nearestValidPoint(points, targetHour) {
    const valid = validPoints(points);
    if (!valid.length) return null;
    let low = 0;
    let high = valid.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (valid[middle].relativeHour < targetHour) low = middle + 1;
      else high = middle;
    }
    const candidate = valid[low];
    const previous = low > 0 ? valid[low - 1] : null;
    return previous && Math.abs(previous.relativeHour - targetHour) < Math.abs(candidate.relativeHour - targetHour) ? previous : candidate;
  }

  function comparisonMetricLabel() {
    return state.metric === "observed" ? "Verified height" : "Departure from normal";
  }

  function pathForSeries(points, x, y, expectedIntervalHours) {
    let path = "";
    let drawing = false;
    let previousHour = null;
    points.forEach(point => {
      const gap = previousHour == null ? 0 : point.relativeHour - previousHour;
      if (!finiteValue(point.value) || gap > expectedIntervalHours * 1.75) {
        drawing = false;
        previousHour = point.relativeHour;
        return;
      }
      path += `${drawing ? " L" : "M"}${x(point.relativeHour).toFixed(2)},${y(point.value).toFixed(2)}`;
      drawing = true;
      previousHour = point.relativeHour;
    });
    return path;
  }

  function xTickLabel(hours) {
    return formatRelative(hours, { compact: true });
  }

  function renderComparisonInsights(primary, comparison, primaryPoints, comparisonPoints) {
    const primaryPeak = peakPoint(primaryPoints);
    const comparisonPeak = peakPoint(comparisonPoints);
    if (!primaryPeak || !comparisonPeak) {
      els.compareInsights.innerHTML = '<div class="analysis-empty">Not enough common data to calculate peak differences.</div>';
      return;
    }
    const difference = primaryPeak.value - comparisonPeak.value;
    const lag = primaryPeak.relativeHour - comparisonPeak.relativeHour;
    const metric = state.metric === "observed" ? "height" : "departure";
    const differencePhrase = Math.abs(difference) < 0.005
      ? "The window peaks are equal."
      : `${primary.metadata.name}'s peak ${metric} is ${Math.abs(difference).toFixed(2)} ft ${difference > 0 ? "higher" : "lower"}.`;
    const lagPhrase = Math.abs(lag) < 0.05
      ? "The peaks occur at the same landfall-relative time."
      : `${primary.metadata.name}'s peak occurs ${formatDuration(Math.abs(lag))} ${lag > 0 ? "later" : "earlier"}.`;

    els.compareInsights.innerHTML = `
      <div class="comparison-stat primary"><span>${escapeHtml(primary.metadata.displayTitle)}</span><strong>${primaryPeak.value.toFixed(2)} ft</strong><small>${formatRelative(primaryPeak.relativeHour)}</small></div>
      <div class="comparison-stat comparison"><span>${escapeHtml(comparison.metadata.displayTitle)}</span><strong>${comparisonPeak.value.toFixed(2)} ft</strong><small>${formatRelative(comparisonPeak.relativeHour)}</small></div>
      <div class="comparison-stat narrative"><span>Window comparison</span><strong>${escapeHtml(differencePhrase)}</strong><small>${escapeHtml(lagPhrase)}</small></div>`;
  }

  function renderComparisonChart(primary, comparison, stationId) {
    const domain = comparisonDomain(primary, comparison);
    const primaryPoints = comparisonSeries(primary, stationId, state.metric, domain);
    const comparisonPoints = comparisonSeries(comparison, stationId, state.metric, domain);
    const allValues = [...validPoints(primaryPoints), ...validPoints(comparisonPoints)].map(point => point.value);
    renderComparisonInsights(primary, comparison, primaryPoints, comparisonPoints);

    const width = Math.max(420, Math.round(els.compareChart.clientWidth || 760));
    const height = Math.max(290, Math.round(els.compareChart.clientHeight || 340));
    const margin = { left: 50, right: 16, top: 20, bottom: 38 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const plotBottom = margin.top + plotHeight;

    if (!allValues.length) {
      els.compareChart.setAttribute("viewBox", `0 0 ${width} ${height}`);
      els.compareChart.innerHTML = `<text class="comparison-empty-label" x="${width / 2}" y="${height / 2}" text-anchor="middle">No common ${escapeHtml(comparisonMetricLabel().toLowerCase())} data in this window.</text>`;
      els.compareHover.textContent = "Choose another station, metric, or comparison window.";
      state.chart = null;
      return;
    }

    let rawMin = Math.min(...allValues);
    let rawMax = Math.max(...allValues);
    if (state.metric === "departure") {
      rawMin = Math.min(rawMin, 0);
      rawMax = Math.max(rawMax, 0);
    }
    const padding = Math.max(0.2, (rawMax - rawMin) * 0.08);
    const yMin = Math.floor((rawMin - padding) * 2) / 2;
    let yMax = Math.ceil((rawMax + padding) * 2) / 2;
    if (yMax <= yMin) yMax = yMin + 1;

    const x = hour => margin.left + ((hour - domain[0]) / (domain[1] - domain[0])) * plotWidth;
    const y = value => margin.top + ((yMax - value) / (yMax - yMin)) * plotHeight;
    const yTicks = Array.from({ length: 6 }, (_, index) => yMin + ((yMax - yMin) * index) / 5);
    const xTicks = Array.from({ length: 7 }, (_, index) => domain[0] + ((domain[1] - domain[0]) * index) / 6);

    const yGrid = yTicks.map(value => {
      const py = y(value);
      return `<line class="comparison-grid" x1="${margin.left}" y1="${py}" x2="${width - margin.right}" y2="${py}"></line><text class="comparison-axis-label" x="${margin.left - 7}" y="${py + 3}" text-anchor="end">${value.toFixed(1)}</text>`;
    }).join("");
    const xGrid = xTicks.map((value, index) => {
      const px = x(value);
      const anchor = index === 0 ? "start" : index === xTicks.length - 1 ? "end" : "middle";
      return `<line class="comparison-grid" x1="${px}" y1="${margin.top}" x2="${px}" y2="${plotBottom}"></line><text class="comparison-axis-label" x="${px}" y="${height - 11}" text-anchor="${anchor}">${xTickLabel(value)}</text>`;
    }).join("");

    const primaryPath = pathForSeries(primaryPoints, x, y, intervalMinutes(primary) / 60);
    const comparisonPath = pathForSeries(comparisonPoints, x, y, intervalMinutes(comparison) / 60);
    const primaryPeak = peakPoint(primaryPoints);
    const comparisonPeak = peakPoint(comparisonPoints);
    const peakMarkup = [
      primaryPeak ? `<circle class="comparison-peak primary" cx="${x(primaryPeak.relativeHour)}" cy="${y(primaryPeak.value)}" r="4.5"><title>${escapeHtml(primary.metadata.displayTitle)} peak: ${primaryPeak.value.toFixed(2)} ft at ${formatRelative(primaryPeak.relativeHour)}</title></circle>` : "",
      comparisonPeak ? `<circle class="comparison-peak comparison" cx="${x(comparisonPeak.relativeHour)}" cy="${y(comparisonPeak.value)}" r="4.5"><title>${escapeHtml(comparison.metadata.displayTitle)} peak: ${comparisonPeak.value.toFixed(2)} ft at ${formatRelative(comparisonPeak.relativeHour)}</title></circle>` : ""
    ].join("");
    const landfallMarkup = domain[0] <= 0 && domain[1] >= 0
      ? `<line class="comparison-landfall" x1="${x(0)}" y1="${margin.top}" x2="${x(0)}" y2="${plotBottom}"></line><text class="comparison-landfall-label" x="${x(0) + 5}" y="${margin.top + 12}">LANDFALL</text>`
      : "";

    els.compareChart.setAttribute("viewBox", `0 0 ${width} ${height}`);
    els.compareChart.setAttribute("aria-label", `${comparisonMetricLabel()} comparison for ${primary.stations[stationId].name}, aligned to each storm's landfall.`);
    els.compareChart.innerHTML = `
      <defs><clipPath id="comparison-chart-clip"><rect x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}"></rect></clipPath></defs>
      ${yGrid}${xGrid}${landfallMarkup}
      <g clip-path="url(#comparison-chart-clip)">
        <path class="comparison-series primary" d="${primaryPath}"></path>
        <path class="comparison-series comparison" d="${comparisonPath}"></path>
        ${peakMarkup}
        <line class="comparison-cursor is-hidden" x1="0" y1="${margin.top}" x2="0" y2="${plotBottom}"></line>
      </g>
      <rect class="comparison-hit-area" x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}"></rect>`;

    state.chart = {
      domain,
      x,
      width,
      margin,
      plotWidth,
      primary,
      comparison,
      primaryPoints,
      comparisonPoints,
      cursor: els.compareChart.querySelector(".comparison-cursor")
    };
    els.compareHover.innerHTML = `<span class="comparison-hint">Move across the chart for values. Click to move the primary viewer to that landfall-relative time.</span>`;
  }

  function renderComparison() {
    const primary = primaryDataset();
    if (!primary) return;

    if (!state.comparisonStormId || state.comparisonStormId === primary.metadata.id || !datasetFor(state.comparisonStormId)) {
      state.comparisonStormId = chooseDefaultComparison(primary.metadata.id);
    }
    els.compareStorm.value = state.comparisonStormId || "";
    const comparison = datasetFor(state.comparisonStormId);
    els.comparePrimaryLabel.textContent = primary.metadata.displayTitle;
    els.compareMetric.value = state.metric;
    els.compareWindow.value = state.window;

    if (!comparison) {
      els.compareChart.innerHTML = "";
      els.compareInsights.innerHTML = '<div class="analysis-empty">No comparison storm is available.</div>';
      return;
    }

    const stations = renderStationOptions(primary, comparison);
    if (!stations.length || !state.stationId) {
      els.compareChart.innerHTML = "";
      els.compareInsights.innerHTML = '<div class="analysis-empty">These storms do not have a common available gauge for the selected metric.</div>';
      els.compareHover.textContent = "Try verified height or choose another storm.";
      return;
    }
    renderComparisonChart(primary, comparison, state.stationId);
  }

  function renderAllAnalysis() {
    renderSummary();
    renderComparison();
  }

  function chartHourFromPointer(event) {
    if (!state.chart) return null;
    const bounds = els.compareChart.getBoundingClientRect();
    const viewX = ((event.clientX - bounds.left) / bounds.width) * state.chart.width;
    const fraction = Math.max(0, Math.min(1, (viewX - state.chart.margin.left) / state.chart.plotWidth));
    return state.chart.domain[0] + fraction * (state.chart.domain[1] - state.chart.domain[0]);
  }

  function updateComparisonHover(relativeHour) {
    if (!state.chart || relativeHour == null) return;
    const primaryPoint = nearestValidPoint(state.chart.primaryPoints, relativeHour);
    const comparisonPoint = nearestValidPoint(state.chart.comparisonPoints, relativeHour);
    const cursorX = state.chart.x(relativeHour);
    state.chart.cursor.classList.remove("is-hidden");
    state.chart.cursor.setAttribute("x1", cursorX);
    state.chart.cursor.setAttribute("x2", cursorX);

    const valueMarkup = (dataset, point, className) => point
      ? `<span class="comparison-hover-value ${className}"><b>${escapeHtml(dataset.metadata.name)}</b> ${point.value.toFixed(2)} ft <small>${formatLocalCompact(point.time, dataset)}</small></span>`
      : `<span class="comparison-hover-value ${className}"><b>${escapeHtml(dataset.metadata.name)}</b> no data</span>`;
    els.compareHover.innerHTML = `<strong>${formatRelative(relativeHour)}</strong>${valueMarkup(state.chart.primary, primaryPoint, "primary")}${valueMarkup(state.chart.comparison, comparisonPoint, "comparison")}`;
  }

  function jumpPrimaryToRelative(relativeHour) {
    const dataset = primaryDataset();
    if (!dataset || !Number.isFinite(relativeHour)) return;
    const target = new Date(new Date(dataset.metadata.landfallTime).getTime() + relativeHour * HOUR_MS);
    const slice = activeSlice(dataset);
    const index = nearestIndex(target, slice.times);
    timeline.value = String(index);
    timeline.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function scheduleComparisonResize() {
    if (state.resizeFrame) cancelAnimationFrame(state.resizeFrame);
    state.resizeFrame = requestAnimationFrame(() => {
      state.resizeFrame = null;
      renderComparison();
    });
  }

  populateComparisonStorms();
  state.comparisonStormId = chooseDefaultComparison(mainStormSelect.value);

  els.summaryBody.addEventListener("click", event => jumpToSummaryRow(event.target.closest("[data-peak-index]")));
  els.summaryBody.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest("[data-peak-index]");
    if (!row) return;
    event.preventDefault();
    jumpToSummaryRow(row);
  });

  mainStormSelect.addEventListener("change", () => {
    if (state.comparisonStormId === mainStormSelect.value) state.comparisonStormId = chooseDefaultComparison(mainStormSelect.value);
    renderAllAnalysis();
  });
  els.compareStorm.addEventListener("change", event => {
    state.comparisonStormId = event.target.value;
    renderComparison();
  });
  els.compareStation.addEventListener("change", event => {
    state.stationId = event.target.value;
    renderComparison();
  });
  els.compareMetric.addEventListener("change", event => {
    state.metric = event.target.value;
    renderComparison();
  });
  els.compareWindow.addEventListener("change", event => {
    state.window = event.target.value;
    renderComparison();
  });
  els.compareSwap.addEventListener("click", () => {
    const oldPrimary = mainStormSelect.value;
    const nextPrimary = state.comparisonStormId;
    if (!nextPrimary || nextPrimary === oldPrimary) return;
    state.comparisonStormId = oldPrimary;
    mainStormSelect.value = nextPrimary;
    mainStormSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  els.compareChart.addEventListener("pointermove", event => updateComparisonHover(chartHourFromPointer(event)));
  els.compareChart.addEventListener("pointerleave", () => {
    state.chart?.cursor?.classList.add("is-hidden");
    els.compareHover.innerHTML = '<span class="comparison-hint">Move across the chart for values. Click to move the primary viewer to that landfall-relative time.</span>';
  });
  els.compareChart.addEventListener("click", event => {
    const relativeHour = chartHourFromPointer(event);
    if (relativeHour != null) jumpPrimaryToRelative(relativeHour);
  });

  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(scheduleComparisonResize);
    observer.observe(els.compareChart.parentElement);
  } else {
    window.addEventListener("resize", scheduleComparisonResize);
  }

  renderAllAnalysis();
})();
