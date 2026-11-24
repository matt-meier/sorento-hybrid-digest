(function () {
  "use strict";

  const CACHE_KEY = "sorento_hybrid_data_v1";
  const SVG_NS = "http://www.w3.org/2000/svg";

  let appData = null;
  let gasMode = "actual"; // "actual" or "ne"

  const tooltip = document.getElementById("chart-tooltip");
  const statusBanner = document.getElementById("status-banner");

  function showStatus(msg) {
    if (!statusBanner) return;
    statusBanner.textContent = msg;
    statusBanner.classList.remove("hidden");
  }

  function hideStatus() {
    if (!statusBanner) return;
    statusBanner.classList.add("hidden");
  }

  function showTip(evt, html) {
    if (!tooltip) return;
    tooltip.innerHTML = html;
    tooltip.classList.add("visible");
    moveTip(evt);
  }

  function moveTip(evt) {
    if (!tooltip) return;
    const pad = 12;
    const rect = tooltip.getBoundingClientRect();
    let x = evt.clientX + pad;
    let y = evt.clientY + pad;
    if (x + rect.width > window.innerWidth - 8) {
      x = evt.clientX - rect.width - pad;
    }
    if (y + rect.height > window.innerHeight - 8) {
      y = evt.clientY - rect.height - pad;
    }
    tooltip.style.left = Math.max(8, x) + "px";
    tooltip.style.top = Math.max(8, y) + "px";
  }

  function hideTip() {
    if (!tooltip) return;
    tooltip.classList.remove("visible");
  }

  function el(tag, attrs, parent) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        node.setAttribute(k, String(v));
      }
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  function fmtCurrency(v, digits = 2) {
    if (v === null || v === undefined || Number.isNaN(v)) return "--";
    return "$" + Number(v).toLocaleString("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
  }

  function fmtInt(v) {
    if (v === null || v === undefined || Number.isNaN(v)) return "--";
    return Number(v).toLocaleString("en-US");
  }

  async function fetchJsonWithTimeout(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: "no-cache" });
      if (!res.ok) {
        throw new Error("HTTP " + res.status);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadDashboardData() {
    try {
      const payload = await fetchJsonWithTimeout("./data.json", 6000);
      if (!payload || !Array.isArray(payload.fillups) || !Array.isArray(payload.maintenance_log)) {
        throw new Error("Invalid data.json structure");
      }
      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify(payload));
      } catch (_) {}
      hideStatus();
      return payload;
    } catch (err) {
      try {
        const cached = sessionStorage.getItem(CACHE_KEY);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (parsed && Array.isArray(parsed.fillups)) {
            showStatus("Showing cached vehicle data because live ./data.json could not be refreshed.");
            return parsed;
          }
        }
      } catch (_) {}
      showStatus("Unable to load ./data.json (" + err.message + "). Serve over HTTP (python -m http.server 8000) or verify GitHub Pages deployment.");
      return null;
    }
  }

  function hydrateTopSummary(data) {
    const s = data.summary;
    const m = data.meta;
    const pctBelowAaa = Math.round((1 - s.tco_cpm / s.benchmarks.aaa_medium_suv_2026_cpm) * 100);

    document.getElementById("main-headline").textContent =
      Math.round(s.miles_driven / 1000) + "K Miles at " + fmtCurrency(s.tco_cpm, 2) +
      "/Mile: 2022 Kia Sorento Hybrid Runs " + pctBelowAaa + "% Below National SUV Costs";

    document.getElementById("main-subtitle").textContent =
      m.start_date + " to " + m.end_date + "  |  " + fmtInt(s.miles_driven) +
      " miles driven  |  " + fmtInt(s.fillup_count) + " fill-ups  |  " +
      fmtInt(s.maintenance_count) + " maintenance visits  |  Hybrid dashboard and ownership digest";

    document.getElementById("kpi-cpm").textContent = fmtCurrency(s.tco_cpm, 2) + " / mi";
    document.getElementById("kpi-cpm-sub").textContent = "All-In TCO (" + fmtCurrency(s.operating_cpm, 2) + " Operating)";

    document.getElementById("kpi-mpg").textContent = s.true_mpg.toFixed(1) + " MPG";
    document.getElementById("kpi-mpg-sub").textContent = "True Lifetime (" + fmtInt(Math.round(s.total_gallons)) + " gal)";

    document.getElementById("kpi-ppg").textContent = fmtCurrency(s.weighted_ppg, 2) + " / gal";
    document.getElementById("kpi-ppg-sub").textContent = "Weighted Avg (" + fmtCurrency(s.total_gas_cost, 0) + " Fuel)";

    document.getElementById("kpi-maint").textContent = fmtCurrency(s.total_maintenance_cost, 0);
    document.getElementById("kpi-maint-sub").textContent = "Maintenance (" + (s.maintenance_cpm * 100).toFixed(1) + "¢ / mi)";

    document.getElementById("milestone-strip").textContent =
      "Milestone Pace: " + fmtInt(s.miles_driven) + " miles logged through " + m.end_date +
      " (~150,000 miles projected " + s.proj_150k_year + ")  |  Automated Sync: GitHub Action updates sanitized data.json daily (VIN stripped)";
  }

  /* 1. COST BENCHMARKS BAR CHART */
  function renderBenchmarks(data) {
    const container = document.getElementById("chart-benchmarks");
    container.innerHTML = "";
    const s = data.summary;

    const rows = [
      {
        label: "AAA Medium SUV (2026)",
        cents: s.benchmarks.aaa_medium_suv_2026_cpm * 100,
        tag: (s.benchmarks.aaa_medium_suv_2026_cpm * 100).toFixed(1) + "¢/mi",
        color: "#6B7280",
        detail: "AAA 2026 Your Driving Costs medium SUV national benchmark at 15K+ mi/yr."
      },
      {
        label: "IRS Standard Rate (2026)",
        cents: s.benchmarks.irs_h2_2026_cpm * 100,
        tag: (s.benchmarks.irs_h2_2026_cpm * 100).toFixed(1) + "¢/mi",
        color: "#9CA3AF",
        detail: "IRS H2 2026 standard business mileage reimbursement rate."
      },
      {
        label: "Sorento All-In TCO",
        cents: s.tco_cpm * 100,
        tag: (s.tco_cpm * 100).toFixed(1) + "¢/mi (" + fmtCurrency(s.tco_total, 0) + ")",
        color: "#0058A6",
        detail: "Includes gas, maintenance, insurance, taxes, washes, and logged depreciation across " + fmtInt(s.miles_driven) + " miles."
      },
      {
        label: "Sorento Operating Only",
        cents: s.operating_cpm * 100,
        tag: (s.operating_cpm * 100).toFixed(1) + "¢/mi (" + fmtCurrency(s.operating_total, 0) + ")",
        color: "#02BFE7",
        detail: "Out-of-pocket operating expenses (gas, maintenance, insurance, taxes, car washes) excluding depreciation."
      }
    ];

    const W = 540, H = 248;
    const padL = 165, padR = 128, padT = 16, padB = 14;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const maxVal = 105;

    const svg = el("svg", { viewBox: "0 0 " + W + " " + H }, container);
    const step = plotH / rows.length;

    el("line", {
      x1: padL, y1: padT, x2: padL, y2: padT + plotH,
      stroke: "#CBD5E1", "stroke-width": 1
    }, svg);

    rows.forEach((r, idx) => {
      const cy = padT + idx * step + step / 2;
      const barH = 26;
      const barW = Math.max(4, (r.cents / maxVal) * plotW);

      const lbl = el("text", {
        x: padL - 10, y: cy + 4,
        "text-anchor": "end",
        fill: "#1F2937",
        "font-size": "12",
        "font-weight": "700"
      }, svg);
      lbl.textContent = r.label;

      const rect = el("rect", {
        x: padL, y: cy - barH / 2,
        width: barW, height: barH,
        rx: 4, fill: r.color,
        style: "cursor:pointer"
      }, svg);

      const valTxt = el("text", {
        x: padL + barW + 8, y: cy + 4,
        fill: "#112E51",
        "font-size": "11.5",
        "font-weight": "700"
      }, svg);
      valTxt.textContent = r.tag;

      rect.addEventListener("mouseenter", (e) => {
        rect.setAttribute("opacity", "0.85");
        showTip(e, "<strong>" + r.label + "</strong><br>" + r.tag + "<br>" + r.detail);
      });
      rect.addEventListener("mousemove", moveTip);
      rect.addEventListener("mouseleave", () => {
        rect.setAttribute("opacity", "1");
        hideTip();
      });
    });
  }

  /* 2. GAS PRICE OVER TIME + INDIVIDUAL FILL-UPS + NEBRASKA NORMALIZATION */
  function renderGasChart(data) {
    const container = document.getElementById("chart-gas-time");
    container.innerHTML = "";

    const isNorm = gasMode === "ne";
    const monthly = data.monthly_gas;
    const fillups = data.fillups;

    const titleEl = document.getElementById("gas-chart-title");
    const subEl = document.getElementById("gas-chart-sub");

    if (isNorm) {
      titleEl.textContent = "NE-Normalized Gas Prices Smooth Out West Coast Spike";
      subEl.textContent = "Out-of-state fill-ups scaled to Nebraska baseline ($" +
        data.summary.ne_baseline_ppg.toFixed(2) + "/gal) | Gas chart only";
    } else {
      titleEl.textContent = "Gas Price Peaked at $4.65/gal on West Coast Trip";
      subEl.textContent = "Area: monthly weighted $/gal | Dots: " + fillups.length + " individual fill-ups (hover for details)";
    }

    const W = 540, H = 248;
    const padL = 40, padR = 18, padT = 16, padB = 26;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const parseDate = (dStr) => new Date(dStr + "T00:00:00").getTime();
    const allDates = fillups.map((f) => parseDate(f.date));
    const minT = Math.min(...allDates);
    const maxT = Math.max(...allDates);
    const spanT = Math.max(1, maxT - minT);

    const minY = 1.8;
    const maxY = isNorm ? 5.2 : 7.0;

    const xScale = (ts) => padL + ((ts - minT) / spanT) * plotW;
    const yScale = (val) => padT + plotH - ((val - minY) / (maxY - minY)) * plotH;

    const svg = el("svg", { viewBox: "0 0 " + W + " " + H }, container);

    // Y axis ticks
    const yTicks = isNorm ? [2, 3, 4, 5] : [2, 3, 4, 5, 6, 7];
    yTicks.forEach((v) => {
      const y = yScale(v);
      el("line", {
        x1: padL - 4, y1: y, x2: padL, y2: y,
        stroke: "#94A3B8", "stroke-width": 1
      }, svg);
      const t = el("text", {
        x: padL - 7, y: y + 4,
        "text-anchor": "end",
        fill: "#5A6577",
        "font-size": "11"
      }, svg);
      t.textContent = "$" + v;
    });

    el("line", {
      x1: padL, y1: padT, x2: padL, y2: padT + plotH,
      stroke: "#CBD5E1", "stroke-width": 1
    }, svg);
    el("line", {
      x1: padL, y1: padT + plotH, x2: padL + plotW, y2: padT + plotH,
      stroke: "#CBD5E1", "stroke-width": 1
    }, svg);

    // Year ticks
    [2022, 2023, 2024, 2025, 2026].forEach((yr) => {
      const ts = new Date(yr + "-07-01T00:00:00").getTime();
      if (ts >= minT && ts <= maxT) {
        const x = xScale(ts);
        const t = el("text", {
          x: x, y: padT + plotH + 16,
          "text-anchor": "middle",
          fill: "#5A6577",
          "font-size": "11"
        }, svg);
        t.textContent = String(yr);
      }
    });

    // Monthly area & line path
    const pts = monthly
      .map((m) => {
        const val = isNorm ? m.ppg_ne : m.ppg;
        if (val === null || val === undefined) return null;
        return {
          x: xScale(parseDate(m.ym + "-15")),
          y: yScale(val),
          val: val,
          ym: m.ym
        };
      })
      .filter(Boolean);

    if (pts.length > 1) {
      const lineD = pts.map((p, idx) => (idx === 0 ? "M" : "L") + p.x.toFixed(1) + "," + p.y.toFixed(1)).join(" ");
      const baseY = padT + plotH;
      const areaD = lineD + " L" + pts[pts.length - 1].x.toFixed(1) + "," + baseY +
        " L" + pts[0].x.toFixed(1) + "," + baseY + " Z";

      el("path", {
        d: areaD,
        fill: "#0058A6",
        "fill-opacity": "0.14"
      }, svg);

      el("path", {
        d: lineD,
        fill: "none",
        stroke: "#0058A6",
        "stroke-width": "2.2",
        "stroke-linejoin": "round"
      }, svg);
    }

    // Weighted average reference line
    const avgVal = isNorm ? data.summary.ne_baseline_ppg : data.summary.weighted_ppg;
    const avgY = yScale(avgVal);
    el("line", {
      x1: padL, y1: avgY, x2: padL + plotW, y2: avgY,
      stroke: "#EF9921", "stroke-width": "1.4", "stroke-dasharray": "5,4"
    }, svg);

    const avgLbl = el("text", {
      x: padL + 74, y: avgY - 6,
      fill: "#B45309",
      "font-size": "10.5",
      "font-weight": "700"
    }, svg);
    avgLbl.textContent = fmtCurrency(avgVal, 2) + (isNorm ? " NE baseline" : " weighted avg");

    // West Coast context annotation in actual mode
    if (!isNorm) {
      const peakX = xScale(parseDate("2022-07-15"));
      const peakY = yScale(4.65);
      el("line", {
        x1: peakX + 4, y1: peakY - 2, x2: peakX + 52, y2: peakY - 24,
        stroke: "#EF9921", "stroke-width": "1.2"
      }, svg);
      el("rect", {
        x: peakX + 52, y: peakY - 40, width: 192, height: 32,
        rx: 5, fill: "#FFFBEB", stroke: "#F59E0B", "stroke-width": "1"
      }, svg);
      const ann1 = el("text", {
        x: peakX + 60, y: peakY - 26,
        fill: "#112E51", "font-size": "10", "font-weight": "700"
      }, svg);
      ann1.textContent = "Jul 2022 West Coast Road Trip";
      const ann2 = el("text", {
        x: peakX + 60, y: peakY - 14,
        fill: "#78350F", "font-size": "9.5"
      }, svg);
      ann2.textContent = "Monthly high $4.65 (CA peak $6.60)";
    }

    // Individual fill-up dots underneath / interactive hover
    fillups.forEach((f) => {
      const val = isNorm ? f.ppg_ne : f.ppg;
      if (val === null || val === undefined) return;
      const cx = xScale(parseDate(f.date));
      const cy = yScale(val);
      const isWestPeak = !isNorm && f.ppg >= 6.0;

      const dot = el("circle", {
        cx: cx.toFixed(1),
        cy: cy.toFixed(1),
        r: isWestPeak ? "5" : "3.1",
        fill: isWestPeak ? "#EF9921" : "#02BFE7",
        "fill-opacity": isWestPeak ? "0.95" : "0.52",
        stroke: isWestPeak ? "#112E51" : "none",
        "stroke-width": isWestPeak ? "1.1" : "0",
        style: "cursor:pointer"
      }, svg);

      dot.addEventListener("mouseenter", (e) => {
        dot.setAttribute("r", "6");
        dot.setAttribute("fill", "#EF9921");
        dot.setAttribute("fill-opacity", "1");
        const normNote = f.state !== "NE"
          ? "<br>NE-Normalized: " + fmtCurrency(f.ppg_ne, 2) + "/gal"
          : "";
        showTip(
          e,
          "<strong>" + f.date + " &bull; " + f.brand + "</strong><br>" +
          f.city_state + "<br>" +
          "Actual: <strong>" + fmtCurrency(f.ppg, 2) + "/gal</strong> (" +
          (f.gallons ? f.gallons.toFixed(2) + " gal, " + fmtCurrency(f.cost, 2) : "") + ")" +
          normNote +
          (f.mileage ? "<br>Odometer: " + fmtInt(f.mileage) + " mi" : "")
        );
      });
      dot.addEventListener("mousemove", moveTip);
      dot.addEventListener("mouseleave", () => {
        dot.setAttribute("r", isWestPeak ? "5" : "3.1");
        dot.setAttribute("fill", isWestPeak ? "#EF9921" : "#02BFE7");
        dot.setAttribute("fill-opacity", isWestPeak ? "0.95" : "0.52");
        hideTip();
      });
    });
  }

  /* 3. FILL-UP LOCATIONS MAP + TOP BRANDS SUMMARY */
  function renderLocations(data) {
    const container = document.getElementById("chart-locations");
    container.innerHTML = "";
    const fillups = data.fillups;

    const W = 540, H = 248;
    const svg = el("svg", { viewBox: "0 0 " + W + " " + H }, container);

    // Simplified continental US silhouette scaled to [-126..-67 lon, 24..50 lat]
    const minLon = -126.5, maxLon = -67.0;
    const minLat = 24.0, maxLat = 50.2;
    const mapX = 14, mapY = 10, mapW = 345, mapH = 224;

    const projX = (lon) => mapX + ((lon - minLon) / (maxLon - minLon)) * mapW;
    const projY = (lat) => mapY + mapH - ((lat - minLat) / (maxLat - minLat)) * mapH;

    const usOutline = [
      [-124.6, 48.4], [-124.2, 46.2], [-122.4, 41.9], [-120.5, 37.8], [-117.1, 32.5],
      [-114.6, 32.7], [-111.0, 31.3], [-104.0, 32.0], [-102.0, 29.8], [-97.1, 25.9],
      [-94.5, 29.7], [-89.2, 29.2], [-83.5, 30.7], [-80.2, 25.4], [-81.4, 30.7],
      [-75.5, 35.8], [-74.0, 40.7], [-70.0, 41.8], [-67.1, 44.9], [-71.5, 45.0],
      [-79.0, 43.3], [-83.0, 42.3], [-84.8, 46.5], [-92.1, 46.8], [-95.1, 49.0],
      [-104.0, 49.0], [-114.0, 49.0], [-123.0, 49.0]
    ];

    const polyStr = usOutline.map((p) => projX(p[0]).toFixed(1) + "," + projY(p[1]).toFixed(1)).join(" ");
    el("polygon", {
      points: polyStr,
      fill: "#F1F5F9",
      stroke: "#CBD5E1",
      "stroke-width": "1.2"
    }, svg);

    // Aggregate fill-ups by rounded 0.25-deg cluster for clean proportional bubbles
    const clusters = new Map();
    fillups.forEach((f) => {
      if (f.lat === null || f.lon === null) return;
      const key = (Math.round(f.lat * 4) / 4) + "," + (Math.round(f.lon * 4) / 4);
      if (!clusters.has(key)) {
        clusters.set(key, {
          lat: f.lat,
          lon: f.lon,
          city_state: f.city_state,
          state: f.state,
          fills: 0,
          gallons: 0,
          spend: 0
        });
      }
      const c = clusters.get(key);
      c.fills += 1;
      c.gallons += f.gallons || 0;
      c.spend += f.cost || 0;
    });

    const clusterList = Array.from(clusters.values()).sort((a, b) => a.fills - b.fills);
    clusterList.forEach((c) => {
      const cx = projX(c.lon);
      const cy = projY(c.lat);
      const r = Math.min(18, 3.5 + Math.sqrt(c.fills) * 1.45);
      const isHomeHub = c.state === "NE" || c.state === "MO";

      const circle = el("circle", {
        cx: cx.toFixed(1),
        cy: cy.toFixed(1),
        r: r.toFixed(1),
        fill: isHomeHub ? "#0058A6" : "#EF9921",
        "fill-opacity": "0.75",
        stroke: "#112E51",
        "stroke-width": "0.8",
        style: "cursor:pointer"
      }, svg);

      circle.addEventListener("mouseenter", (e) => {
        circle.setAttribute("fill-opacity", "1");
        showTip(
          e,
          "<strong>" + c.city_state + "</strong><br>" +
          "Fill-ups: <strong>" + c.fills + "</strong> (" + c.gallons.toFixed(1) + " gal)<br>" +
          "Total Spend: " + fmtCurrency(c.spend, 2)
        );
      });
      circle.addEventListener("mousemove", moveTip);
      circle.addEventListener("mouseleave", () => {
        circle.setAttribute("fill-opacity", "0.75");
        hideTip();
      });
    });

    // Proportional circle size legend (per tableau-viz-standards)
    const legY = 216;
    [1, 25, 100].forEach((cnt, idx) => {
      const lx = 26 + idx * 54;
      const lr = Math.min(18, 3.5 + Math.sqrt(cnt) * 1.45);
      el("circle", {
        cx: lx, cy: legY - lr + 6, r: lr.toFixed(1),
        fill: "none", stroke: "#64748B", "stroke-width": "1"
      }, svg);
      const lt = el("text", {
        x: lx + lr + 4, y: legY + 6,
        fill: "#5A6577", "font-size": "9.5"
      }, svg);
      lt.textContent = cnt + (cnt === 1 ? " fill" : " fills");
    });

    // Right-side Top Brands mini ranking inside card
    const panelX = 368;
    const hdr = el("text", {
      x: panelX, y: 24,
      fill: "#112E51", "font-size": "11.5", "font-weight": "700"
    }, svg);
    hdr.textContent = "Top Stations by Visits";

    const topBrands = data.top_brands.slice(0, 5);
    const maxFills = topBrands.length ? topBrands[0].fills : 1;
    topBrands.forEach((b, idx) => {
      const by = 44 + idx * 38;
      const shortName = b.brand.replace(" Gas Station", "");
      const nameTxt = el("text", {
        x: panelX, y: by,
        fill: "#1F2937", "font-size": "11", "font-weight": "600"
      }, svg);
      nameTxt.textContent = shortName + " (" + b.fills + ")";

      const bw = Math.max(6, (b.fills / maxFills) * 108);
      el("rect", {
        x: panelX, y: by + 5, width: bw, height: 10,
        rx: 3, fill: idx === 0 ? "#0058A6" : "#02BFE7"
      }, svg);

      const pTxt = el("text", {
        x: panelX + bw + 6, y: by + 13,
        fill: "#5A6577", "font-size": "10", "font-weight": "600"
      }, svg);
      pTxt.textContent = fmtCurrency(b.ppg, 2);
    });
  }

  /* 4. SCROLLABLE LATO MAINTENANCE TABLE */
  function renderMaintenanceTable(data, filterText) {
    const tbody = document.getElementById("maint-tbody");
    tbody.innerHTML = "";
    const q = (filterText || "").trim().toLowerCase();

    const rows = data.maintenance_log.filter((item) => {
      if (!q) return true;
      return (
        item.action.toLowerCase().includes(q) ||
        item.vendor.toLowerCase().includes(q) ||
        (item.notes && item.notes.toLowerCase().includes(q)) ||
        item.date.includes(q)
      );
    });

    rows.forEach((item) => {
      const tr = document.createElement("tr");
      const costDisplay = item.cost !== null && item.cost !== undefined
        ? fmtCurrency(item.cost, 2)
        : (item.est_cost ? fmtCurrency(item.est_cost, 2) + "*" : "--");

      const noteHtml = item.notes ? '<span class="note-pill">' + escapeHtml(item.notes) + "</span>" : "";

      tr.innerHTML =
        "<td>" + escapeHtml(item.date) + "</td>" +
        '<td class="num">' + fmtInt(item.mileage) + "</td>" +
        "<td><strong>" + escapeHtml(item.action) + "</strong>" + noteHtml + "</td>" +
        "<td>" + escapeHtml(item.vendor) + "</td>" +
        '<td class="num">' + costDisplay + "</td>";
      tbody.appendChild(tr);
    });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* 5. DIGEST Q1 CHART: CUMULATIVE FUEL SPEND (HYBRID VS 26 MPG GAS) */
  function renderDigestQ1(data) {
    const container = document.getElementById("chart-q1");
    container.innerHTML = "";
    const fillups = data.fillups;

    let cumMiles = 0;
    let cumHybrid = 0;
    let cumGas = 0;
    const series = [];

    fillups.forEach((f) => {
      const m = f.miles_traveled || 0;
      const c = f.cost || 0;
      const ppg = f.ppg || data.summary.weighted_ppg;
      cumMiles += m;
      cumHybrid += c;
      cumGas += (m / data.summary.epa_non_hybrid) * ppg;
      series.push({ miles: cumMiles, hybrid: cumHybrid, gas: cumGas });
    });

    const W = 500, H = 138;
    const padL = 44, padR = 54, padT = 16, padB = 22;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const maxM = Math.max(1, cumMiles);
    const maxC = Math.max(1, cumGas * 1.08);

    const xS = (m) => padL + (m / maxM) * plotW;
    const yS = (c) => padT + plotH - (c / maxC) * plotH;

    const svg = el("svg", { viewBox: "0 0 " + W + " " + H }, container);

    [0, 5000, 10000, 15000].forEach((v) => {
      if (v <= maxC) {
        const y = yS(v);
        const t = el("text", {
          x: padL - 6, y: y + 3, "text-anchor": "end", fill: "#5A6577", "font-size": "9.5"
        }, svg);
        t.textContent = "$" + (v / 1000) + "K";
      }
    });

    [0, 25000, 50000, 75000, 100000].forEach((m) => {
      if (m <= maxM) {
        const x = xS(m);
        const t = el("text", {
          x: x, y: padT + plotH + 14, "text-anchor": "middle", fill: "#5A6577", "font-size": "9.5"
        }, svg);
        t.textContent = (m / 1000) + "K";
      }
    });

    const gasD = series.map((p, i) => (i === 0 ? "M" : "L") + xS(p.miles).toFixed(1) + "," + yS(p.gas).toFixed(1)).join(" ");
    const hybD = series.map((p, i) => (i === 0 ? "M" : "L") + xS(p.miles).toFixed(1) + "," + yS(p.hybrid).toFixed(1)).join(" ");

    const areaPts = series.map((p) => xS(p.miles).toFixed(1) + "," + yS(p.gas).toFixed(1)).join(" ") + " " +
      series.slice().reverse().map((p) => xS(p.miles).toFixed(1) + "," + yS(p.hybrid).toFixed(1)).join(" ");
    el("polygon", { points: areaPts, fill: "#02BFE7", "fill-opacity": "0.22" }, svg);

    el("path", { d: gasD, fill: "none", stroke: "#6B7280", "stroke-width": "1.6", "stroke-dasharray": "4,3" }, svg);
    el("path", { d: hybD, fill: "none", stroke: "#0058A6", "stroke-width": "2.1" }, svg);

    const last = series[series.length - 1];
    if (last) {
      const gLbl = el("text", {
        x: xS(last.miles) + 5, y: yS(last.gas) + 3, fill: "#4B5563", "font-size": "9.5", "font-weight": "700"
      }, svg);
      gLbl.textContent = "$" + (last.gas / 1000).toFixed(1) + "K Gas";

      const hLbl = el("text", {
        x: xS(last.miles) + 5, y: yS(last.hybrid) + 4, fill: "#0058A6", "font-size": "9.5", "font-weight": "700"
      }, svg);
      hLbl.textContent = "$" + (last.hybrid / 1000).toFixed(1) + "K Hybrid";
    }
  }

  /* 6. DIGEST Q2 CHART: WAREHOUSE CLUB VS OTHER STATIONS */
  function renderDigestQ2(data) {
    const container = document.getElementById("chart-q2");
    container.innerHTML = "";
    const cs = data.summary.club_savings;

    const bars = [
      {
        label: "Other Stations (" + cs.nonclub_fills + " fills)",
        val: cs.nonclub_ppg,
        color: "#9CA3AF",
        sub: fmtInt(Math.round(cs.nonclub_gallons)) + " gal"
      },
      {
        label: "Sam's & Costco (" + cs.club_fills + " fills)",
        val: cs.club_ppg,
        color: "#0058A6",
        sub: fmtInt(Math.round(cs.club_gallons)) + " gal"
      }
    ];

    const W = 500, H = 138;
    const padL = 175, padR = 110, padT = 18, padB = 18;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const maxV = 4.0;

    const svg = el("svg", { viewBox: "0 0 " + W + " " + H }, container);
    const step = plotH / bars.length;

    bars.forEach((b, idx) => {
      const cy = padT + idx * step + step / 2;
      const bw = (b.val / maxV) * plotW;

      const lbl = el("text", {
        x: padL - 10, y: cy + 4, "text-anchor": "end", fill: "#1F2937", "font-size": "11", "font-weight": "700"
      }, svg);
      lbl.textContent = b.label;

      el("rect", {
        x: padL, y: cy - 13, width: bw, height: 26, rx: 4, fill: b.color
      }, svg);

      const valTxt = el("text", {
        x: padL + bw + 8, y: cy + 4, fill: "#112E51", "font-size": "11", "font-weight": "700"
      }, svg);
      valTxt.textContent = fmtCurrency(b.val, 2) + "/gal (" + b.sub + ")";
    });
  }

  /* 7. DIGEST Q3 CHART: SEASONAL TRUE MPG BY MONTH */
  function renderDigestQ3(data) {
    const container = document.getElementById("chart-q3");
    container.innerHTML = "";
    const seas = data.seasonal_mpg;
    const avgMpg = data.summary.true_mpg;

    const W = 500, H = 138;
    const padL = 34, padR = 14, padT = 16, padB = 22;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const minY = 28, maxY = 41;

    const yS = (v) => padT + plotH - ((v - minY) / (maxY - minY)) * plotH;
    const svg = el("svg", { viewBox: "0 0 " + W + " " + H }, container);

    [30, 35, 40].forEach((v) => {
      const y = yS(v);
      const t = el("text", {
        x: padL - 6, y: y + 3, "text-anchor": "end", fill: "#5A6577", "font-size": "9.5"
      }, svg);
      t.textContent = String(v);
    });

    const colW = plotW / seas.length;
    seas.forEach((m, idx) => {
      if (!m.true_mpg) return;
      const bx = padL + idx * colW + colW * 0.18;
      const bw = colW * 0.64;
      const by = yS(m.true_mpg);
      const bh = padT + plotH - by;

      const isSummer = [6, 7, 8].includes(m.month_num);
      const isWinter = [12, 1, 2, 3].includes(m.month_num);
      const fill = isSummer ? "#02BFE7" : (isWinter ? "#93C5FD" : "#0058A6");

      const rect = el("rect", {
        x: bx.toFixed(1), y: by.toFixed(1), width: bw.toFixed(1), height: bh.toFixed(1),
        rx: 3, fill: fill, style: "cursor:pointer"
      }, svg);

      rect.addEventListener("mouseenter", (e) => {
        showTip(
          e,
          "<strong>" + m.month + " (All Years Combined)</strong><br>" +
          "True Efficiency: <strong>" + m.true_mpg.toFixed(1) + " MPG</strong><br>" +
          fmtInt(Math.round(m.miles)) + " mi across " + m.fills + " fill-ups"
        );
      });
      rect.addEventListener("mousemove", moveTip);
      rect.addEventListener("mouseleave", hideTip);

      const mTxt = el("text", {
        x: (bx + bw / 2).toFixed(1), y: padT + plotH + 14,
        "text-anchor": "middle", fill: "#5A6577", "font-size": "9.5"
      }, svg);
      mTxt.textContent = m.month[0];
    });

    const avgY = yS(avgMpg);
    el("line", {
      x1: padL, y1: avgY, x2: padL + plotW, y2: avgY,
      stroke: "#EF9921", "stroke-width": "1.3", "stroke-dasharray": "4,3"
    }, svg);
  }

  /* 8. DIGEST Q4 CHART: TOP MAINTENANCE COST DRIVERS */
  function renderDigestQ4(data) {
    const container = document.getElementById("chart-q4");
    container.innerHTML = "";
    const top = data.maintenance_breakdown.slice(0, 5);

    const W = 500, H = 138;
    const padL = 148, padR = 64, padT = 10, padB = 10;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const maxV = top.length ? top[0].cost * 1.05 : 2500;

    const svg = el("svg", { viewBox: "0 0 " + W + " " + H }, container);
    const step = plotH / Math.max(1, top.length);

    top.forEach((item, idx) => {
      const cy = padT + idx * step + step / 2;
      const bw = Math.max(4, (item.cost / maxV) * plotW);

      const lbl = el("text", {
        x: padL - 8, y: cy + 3.5, "text-anchor": "end", fill: "#1F2937", "font-size": "10", "font-weight": "700"
      }, svg);
      lbl.textContent = item.action;

      el("rect", {
        x: padL, y: cy - 7, width: bw, height: 14,
        rx: 3, fill: idx === 0 ? "#EF9921" : "#9CA3AF"
      }, svg);

      const valTxt = el("text", {
        x: padL + bw + 6, y: cy + 3.5, fill: "#112E51", "font-size": "10", "font-weight": "700"
      }, svg);
      valTxt.textContent = fmtCurrency(item.cost, 0);
    });
  }

  function wireControls() {
    const btnActual = document.getElementById("btn-gas-actual");
    const btnNe = document.getElementById("btn-gas-ne");
    const filterInput = document.getElementById("maint-filter");

    btnActual.addEventListener("click", () => {
      if (gasMode === "actual") return;
      gasMode = "actual";
      btnActual.classList.add("active");
      btnNe.classList.remove("active");
      if (appData) renderGasChart(appData);
    });

    btnNe.addEventListener("click", () => {
      if (gasMode === "ne") return;
      gasMode = "ne";
      btnNe.classList.add("active");
      btnActual.classList.remove("active");
      if (appData) renderGasChart(appData);
    });

    filterInput.addEventListener("input", () => {
      if (appData) renderMaintenanceTable(appData, filterInput.value);
    });
  }

  async function init() {
    wireControls();
    appData = await loadDashboardData();
    if (!appData) return;

    hydrateTopSummary(appData);
    renderBenchmarks(appData);
    renderGasChart(appData);
    renderLocations(appData);
    renderMaintenanceTable(appData, "");
    renderDigestQ1(appData);
    renderDigestQ2(appData);
    renderDigestQ3(appData);
    renderDigestQ4(appData);
  }

  init();
})();
