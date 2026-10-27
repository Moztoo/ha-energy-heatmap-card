/**
 * Energy Consumption Heatmap Card - Theme-Aware Native Home Assistant Card
 * X-Axis: Hour of Day (00:00 - 23:00)
 * Y-Axis: Day (Configurable period in days + date navigation)
 * Supports selecting meter source, custom day range, metric (Energy Wh/kWh vs Peak W),
 * thermal/accent color scales, daily totals column, and hourly average profile row.
 */
class EnergyHeatmapCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._days = 14;
    this._offsetDays = 0;
    this._selectedSourceId = "grid";
    this._metric = "energy"; // "energy" (Wh / avg W) | "peak" (max W)
    this._palette = "thermal"; // "thermal" | "source"
    this._compact = false;
    this._loading = false;
    this._statsCache = null;
    this._lastFetchKey = "";
    this._lastFetchTime = 0;
    this._selectedCell = null;
    this._sources = [];
  }

  static get DEFAULT_SOURCES() {
    return [
      {
        id: "grid",
        name: "Main Grid (Total)",
        short: "Main Grid",
        icon: "⚡",
        color: "#38bdf8",
        power_entity: "sensor.main_grid_power",
        energy_entity: "sensor.main_grid_total_energy",
      },
      {
        id: "studio",
        name: "Studio (Total)",
        short: "Studio",
        icon: "🖥️",
        color: "#ff62c0",
        power_entity: "sensor.studio_socket_power",
        energy_entity: "sensor.studio_socket_energy",
      },
      {
        id: "studio_desk",
        name: "Studio (Net Desk)",
        short: "Desk Net",
        icon: "💻",
        color: "#f472b6",
        power_entity: "sensor.studio_socket_power",
        energy_entity: "sensor.studio_socket_energy",
        subtract_power_entities: ["sensor.3d_printer_power"],
        subtract_energy_entities: ["sensor.3d_printer_total_energy"],
      },
      {
        id: "printer",
        name: "3D Printer",
        short: "3D Printer",
        icon: "🖨️",
        color: "#00bcd4",
        power_entity: "sensor.3d_printer_power",
        energy_entity: "sensor.3d_printer_total_energy",
      },
      {
        id: "server",
        name: "Server Rack",
        short: "Server",
        icon: "🖧",
        color: "#bd9dff",
        power_entity: "sensor.server_socket_power",
        energy_entity: "sensor.server_socket_energy",
      },
      {
        id: "tv",
        name: "Living Room TV",
        short: "TV",
        icon: "📺",
        color: "#ffd363",
        power_entity: "sensor.tv_socket_power",
        energy_entity: "sensor.tv_socket_energy",
      },
      {
        id: "other",
        name: "Other (Untracked)",
        short: "Other",
        icon: "🔌",
        color: "#94a3b8",
        power_entity: "sensor.main_grid_power",
        energy_entity: "sensor.main_grid_total_energy",
        subtract_power_entities: [
          "sensor.studio_socket_power",
          "sensor.server_socket_power",
          "sensor.tv_socket_power",
        ],
        subtract_energy_entities: [
          "sensor.studio_socket_energy",
          "sensor.server_socket_energy",
          "sensor.tv_socket_energy",
        ],
      },
    ];
  }

  static getStubConfig() {
    return {
      title: "Energy Consumption · Heatmap",
      default_days: 14,
      default_source: "grid",
      default_metric: "energy",
      palette: "thermal",
      compact: false,
      refresh_interval: 120,
      sources: EnergyHeatmapCard.DEFAULT_SOURCES,
    };
  }

  setConfig(config) {
    this._config = {
      title: "Energy Consumption · Heatmap",
      default_days: 14,
      default_source: "grid",
      default_metric: "energy",
      palette: "thermal",
      compact: false,
      refresh_interval: 120,
      ...config,
    };

    this._days = Math.max(1, Math.min(180, Number(this._config.default_days) || 14));
    this._selectedSourceId = this._config.default_source || "grid";
    this._metric = this._config.default_metric === "peak" ? "peak" : "energy";
    this._palette = this._config.palette === "source" ? "source" : "thermal";
    this._compact = Boolean(this._config.compact);

    if (Array.isArray(this._config.sources) && this._config.sources.length > 0) {
      this._sources = this._config.sources.map((s, idx) => ({
        id: s.id || `src_${idx}`,
        name: s.name || s.power_entity || s.energy_entity || `Meter ${idx + 1}`,
        short: s.short || s.name || `M${idx + 1}`,
        icon: s.icon || "⚡",
        color: s.color || "#38bdf8",
        power_entity: s.power_entity || null,
        energy_entity: s.energy_entity || null,
        subtract_power_entities: Array.isArray(s.subtract_power_entities)
          ? s.subtract_power_entities
          : [],
        subtract_energy_entities: Array.isArray(s.subtract_energy_entities)
          ? s.subtract_energy_entities
          : [],
      }));
    } else {
      this._sources = EnergyHeatmapCard.DEFAULT_SOURCES;
    }

    if (!this._sources.some((s) => s.id === this._selectedSourceId)) {
      this._selectedSourceId = this._sources[0]?.id || "grid";
    }

    this._buildSkeleton();
    if (this._hass) {
      this._fetchStatistics(true);
    }
  }

  set hass(hass) {
    const firstLoad = !this._hass;
    this._hass = hass;
    if (!this._config) return;

    const now = Date.now();
    const refreshMs = (this._config.refresh_interval || 120) * 1000;
    if (firstLoad || now - this._lastFetchTime > refreshMs) {
      this._fetchStatistics(false);
    } else {
      this._updateLivePills();
    }
  }

  getCardSize() {
    return this._compact ? 7 : 10;
  }

  getGridOptions() {
    return {
      columns: 12,
      min_columns: 6,
      rows: "auto",
    };
  }

  _getActiveSource() {
    return (
      this._sources.find((s) => s.id === this._selectedSourceId) ||
      this._sources[0]
    );
  }

  _numState(entityId, fallback = null) {
    if (!this._hass || !entityId) return fallback;
    const st = this._hass.states[entityId];
    if (!st) return fallback;
    const val = parseFloat(st.state);
    return Number.isFinite(val) ? val : fallback;
  }

  _getLiveWatts(source) {
    if (!source || !this._hass || !source.power_entity) return null;
    const baseW = this._numState(source.power_entity, null);
    if (baseW === null) return null;

    if (Array.isArray(source.subtract_power_entities) && source.subtract_power_entities.length > 0) {
      let subW = 0;
      for (const subId of source.subtract_power_entities) {
        subW += this._numState(subId, 0) || 0;
      }
      return Math.max(0, baseW - subW);
    }
    return Math.max(0, baseW);
  }

  _fmtPower(watts) {
    if (watts === null || watts === undefined || !Number.isFinite(watts)) return "—";
    const w = Math.max(0, Number(watts));
    if (w >= 1000) return `${(w / 1000).toFixed(2)} kW`;
    return `${Math.round(w)} W`;
  }

  _fmtEnergyWh(wh) {
    if (wh === null || wh === undefined || !Number.isFinite(wh)) return "—";
    const v = Math.max(0, Number(wh));
    if (v >= 1000) return `${(v / 1000).toFixed(2)} kWh`;
    return `${Math.round(v)} Wh`;
  }

  _fmtCellShort(val) {
    if (val === null || val === undefined || !Number.isFinite(val) || val <= 0) return "";
    if (val >= 1000) return `${(val / 1000).toFixed(1)}k`;
    return `${Math.round(val)}`;
  }

  _openMoreInfo(entityId) {
    if (!entityId) return;
    this.dispatchEvent(
      new CustomEvent("hass-more-info", {
        detail: { entityId },
        bubbles: true,
        composed: true,
      })
    );
  }

  _parseTs(raw) {
    if (typeof raw === "number") {
      return raw < 1e11 ? raw * 1000 : raw;
    }
    return new Date(raw).getTime();
  }

  _dayKey(dateObj) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, "0");
    const d = String(dateObj.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  _formatDayLabel(dateObj) {
    const todayKey = this._dayKey(new Date());
    const key = this._dayKey(dateObj);
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const dow = dayNames[dateObj.getDay()];
    const dd = String(dateObj.getDate()).padStart(2, "0");
    const mon = monthNames[dateObj.getMonth()];
    const isWeekend = dateObj.getDay() === 0 || dateObj.getDay() === 6;
    const isToday = key === todayKey;
    return {
      text: isToday ? `Today · ${dd} ${mon}` : `${dow} ${dd} ${mon}`,
      shortText: isToday ? `Today ${dd}` : `${dow} ${dd}`,
      fullText: `${dow} ${dd} ${mon} ${dateObj.getFullYear()}`,
      isWeekend,
      isToday,
    };
  }

  _getAllRequiredEntityIds() {
    const set = new Set();
    for (const s of this._sources) {
      if (s.power_entity) set.add(s.power_entity);
      if (s.energy_entity) set.add(s.energy_entity);
      if (Array.isArray(s.subtract_power_entities)) {
        for (const id of s.subtract_power_entities) {
          if (id) set.add(id);
        }
      }
      if (Array.isArray(s.subtract_energy_entities)) {
        for (const id of s.subtract_energy_entities) {
          if (id) set.add(id);
        }
      }
    }
    return Array.from(set);
  }

  async _fetchStatistics(force = false) {
    if (!this._hass) return;

    const now = new Date();
    const endDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    endDay.setDate(endDay.getDate() - this._offsetDays);

    const startDay = new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate(), 0, 0, 0, 0);
    startDay.setDate(startDay.getDate() - (this._days - 1));

    const fetchKey = `${this._days}_${this._offsetDays}`;
    if (!force && this._loading && this._lastFetchKey === fetchKey) return;

    this._loading = true;
    this._lastFetchKey = fetchKey;
    this._lastFetchTime = Date.now();
    this._setLoadingState(true);

    const statIds = this._getAllRequiredEntityIds();

    try {
      const hourlyPromise = this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: startDay.toISOString(),
        end_time: endDay.toISOString(),
        statistic_ids: statIds,
        period: "hour",
        types: ["mean", "max", "min", "change"],
      });

      let liveHourPromise = Promise.resolve(null);
      if (this._offsetDays === 0) {
        const currentHourStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0, 0);
        liveHourPromise = this._hass
          .callWS({
            type: "recorder/statistics_during_period",
            start_time: currentHourStart.toISOString(),
            end_time: now.toISOString(),
            statistic_ids: statIds,
            period: "5minute",
            types: ["mean", "max", "min", "change"],
          })
          .catch(() => null);
      }

      const [hourlyRes, liveHourRes] = await Promise.all([hourlyPromise, liveHourPromise]);
      this._statsCache = {
        startDay,
        endDay,
        hourly: hourlyRes || {},
        live5m: liveHourRes || {},
      };
    } catch (err) {
      console.error("[EnergyHeatmapCard] Error fetching recorder statistics:", err);
    } finally {
      this._loading = false;
      this._setLoadingState(false);
      this._renderHeatmap();
    }
  }

  _buildEntityHourlyMap(entityId, isEnergySensor = false) {
    const map = new Map();
    if (!entityId || !this._statsCache) return map;

    const hourlyList = this._statsCache.hourly?.[entityId] || [];
    for (const item of hourlyList) {
      const ts = this._parseTs(item.start);
      const d = new Date(ts);
      const key = `${this._dayKey(d)}_${d.getHours()}`;
      if (isEnergySensor) {
        const chg = typeof item.change === "number" ? Math.max(0, item.change * 1000) : null;
        if (chg !== null) {
          map.set(key, { wh: chg, mean: chg, max: chg, min: chg });
        }
      } else {
        const mean = typeof item.mean === "number" ? Math.max(0, item.mean) : null;
        const max = typeof item.max === "number" ? Math.max(0, item.max) : mean;
        const min = typeof item.min === "number" ? Math.max(0, item.min) : mean;
        if (mean !== null || max !== null) {
          map.set(key, { wh: mean ?? 0, mean: mean ?? 0, max: max ?? 0, min: min ?? 0 });
        }
      }
    }

    if (this._offsetDays === 0) {
      const liveList = this._statsCache.live5m?.[entityId] || [];
      if (liveList.length > 0) {
        const now = new Date();
        const liveKey = `${this._dayKey(now)}_${now.getHours()}`;
        if (isEnergySensor) {
          let sumWh = 0;
          let count = 0;
          for (const b of liveList) {
            if (typeof b.change === "number") {
              sumWh += Math.max(0, b.change * 1000);
              count++;
            }
          }
          if (count > 0) {
            map.set(liveKey, { wh: sumWh, mean: sumWh, max: sumWh, min: sumWh, isLive: true });
          }
        } else {
          let sumMean = 0;
          let countMean = 0;
          let maxW = 0;
          let minW = Infinity;
          for (const b of liveList) {
            if (typeof b.mean === "number") {
              sumMean += Math.max(0, b.mean);
              countMean++;
            }
            if (typeof b.max === "number" && b.max > maxW) maxW = b.max;
            if (typeof b.min === "number" && b.min < minW) minW = Math.max(0, b.min);
          }
          if (countMean > 0) {
            const avgW = sumMean / countMean;
            map.set(liveKey, {
              wh: avgW,
              mean: avgW,
              max: Math.max(avgW, maxW),
              min: Number.isFinite(minW) ? minW : avgW,
              isLive: true,
            });
          }
        }
      }
    }

    return map;
  }

  _computeSourceMatrix(source) {
    const now = new Date();
    const todayKey = this._dayKey(now);
    const currentHour = now.getHours();

    const daysList = [];
    for (let i = 0; i < this._days; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      d.setDate(d.getDate() - this._offsetDays - i);
      daysList.push({
        date: d,
        key: this._dayKey(d),
        label: this._formatDayLabel(d),
      });
    }

    const basePowerMap = this._buildEntityHourlyMap(source.power_entity, false);
    const baseEnergyMap = this._buildEntityHourlyMap(source.energy_entity, true);
    const subPowerMaps = (source.subtract_power_entities || []).map((id) =>
      this._buildEntityHourlyMap(id, false)
    );
    const subEnergyMaps = (source.subtract_energy_entities || []).map((id) =>
      this._buildEntityHourlyMap(id, true)
    );
    const hasSub = subPowerMaps.length > 0 || subEnergyMaps.length > 0;

    const cellGetter = (k) => {
      const p = basePowerMap.get(k);
      const e = baseEnergyMap.get(k);
      if (!p && !e) return null;

      if (!hasSub) {
        const wh = p ? p.wh : e.wh;
        const mean = p ? p.mean : e.wh;
        const max = p ? p.max : e.wh;
        const min = p ? p.min : e.wh;
        return { wh, mean, max, min, isLive: Boolean(p?.isLive || e?.isLive) };
      }

      let subMean = 0;
      for (const sm of subPowerMaps) {
        subMean += sm.get(k)?.mean || 0;
      }
      let subEnergyWh = 0;
      for (const se of subEnergyMaps) {
        subEnergyWh += se.get(k)?.wh || 0;
      }

      const wh = p
        ? Math.max(0, p.wh - subMean)
        : Math.max(0, (e?.wh || 0) - subEnergyWh);
      const mean = p ? Math.max(0, p.mean - subMean) : wh;
      const max = p ? Math.max(mean, p.max - subMean) : wh;
      const min = p ? Math.max(0, p.min - subMean) : wh;
      return { wh, mean, max, min, isLive: Boolean(p?.isLive || e?.isLive) };
    };

    const liveW = this._getLiveWatts(source);
    const rows = [];
    const allValues = [];
    const hourlySums = new Array(24).fill(0);
    const hourlyCounts = new Array(24).fill(0);

    let totalPeriodWh = 0;
    let validDaysCount = 0;
    let peakCell = null;

    for (const dayInfo of daysList) {
      const cells = [];
      let dayTotalWh = 0;
      let dayPeakW = 0;
      let dayValidHours = 0;

      for (let h = 0; h < 24; h++) {
        const isFuture = dayInfo.key === todayKey && h > currentHour;
        const isCurrentHour = dayInfo.key === todayKey && h === currentHour;
        const k = `${dayInfo.key}_${h}`;
        let data = isFuture ? null : cellGetter(k);

        if (isCurrentHour && !data && liveW !== null) {
          data = { wh: liveW, mean: liveW, max: liveW, min: liveW, isLive: true };
        }

        const val = data ? (this._metric === "peak" ? data.max : data.wh) : null;
        if (data && val !== null) {
          dayTotalWh += data.wh;
          if (data.max > dayPeakW) dayPeakW = data.max;
          dayValidHours++;
          allValues.push(val);
          hourlySums[h] += val;
          hourlyCounts[h]++;

          if (!peakCell || val > peakCell.val) {
            peakCell = {
              dayKey: dayInfo.key,
              dayLabel: dayInfo.label.text,
              hour: h,
              val,
              wh: data.wh,
              mean: data.mean,
              max: data.max,
              min: data.min,
            };
          }
        }

        cells.push({
          dayKey: dayInfo.key,
          dayLabel: dayInfo.label,
          hour: h,
          isFuture,
          isCurrentHour,
          data,
          val,
        });
      }

      if (dayValidHours > 0) {
        totalPeriodWh += dayTotalWh;
        validDaysCount++;
      }

      rows.push({
        ...dayInfo,
        cells,
        dayTotalWh,
        dayPeakW,
        dayValidHours,
      });
    }

    const hourlyAvgs = hourlySums.map((sum, h) =>
      hourlyCounts[h] > 0 ? sum / hourlyCounts[h] : 0
    );

    let bestHourIdx = 0;
    for (let h = 1; h < 24; h++) {
      if (hourlyAvgs[h] > hourlyAvgs[bestHourIdx]) bestHourIdx = h;
    }

    const sorted = [...allValues].filter((v) => v > 0).sort((a, b) => a - b);
    const maxVal = sorted.length > 0 ? sorted[sorted.length - 1] : 100;
    const p96Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.96));
    const scaleMax =
      sorted.length > 8
        ? Math.max(sorted[p96Idx] * 1.08, maxVal * 0.75, 10)
        : Math.max(maxVal, 10);
    const minVal = sorted.length > 0 ? sorted[0] : 0;

    const maxDayWh = Math.max(10, ...rows.map((r) => r.dayTotalWh));

    return {
      rows,
      hourlyAvgs,
      totalPeriodWh,
      avgDailyWh: validDaysCount > 0 ? totalPeriodWh / validDaysCount : 0,
      peakCell,
      bestHourIdx,
      bestHourAvg: hourlyAvgs[bestHourIdx] || 0,
      minVal,
      maxVal,
      scaleMax,
      maxDayWh,
    };
  }

  _getCellBackground(val, scaleMax, sourceColor) {
    if (val === null || val === undefined || !Number.isFinite(val)) {
      return {
        bg: "rgba(128, 128, 128, 0.05)",
        fg: "var(--ehc-text-muted)",
        border: "transparent",
      };
    }
    if (val <= 0.4) {
      return {
        bg: "rgba(128, 128, 128, 0.10)",
        fg: "var(--ehc-text-secondary)",
        border: "transparent",
      };
    }

    const ratio = Math.max(0, Math.min(1, val / Math.max(1, scaleMax)));
    const t = Math.pow(ratio, 0.82);

    if (this._palette === "source") {
      const pct = Math.round(14 + t * 82);
      return {
        bg: `color-mix(in srgb, ${sourceColor} ${pct}%, rgba(20, 22, 30, 0.65))`,
        fg: t > 0.55 ? "#ffffff" : "var(--ehc-text-primary)",
        border: t > 0.8 ? `color-mix(in srgb, ${sourceColor} 85%, #ffffff)` : "transparent",
      };
    }

    const stops = [
      { pos: 0.0, r: 30, g: 45, b: 68 },
      { pos: 0.22, r: 14, g: 136, b: 168 },
      { pos: 0.45, r: 16, g: 185, b: 129 },
      { pos: 0.68, r: 245, g: 158, b: 11 },
      { pos: 0.86, r: 249, g: 115, b: 22 },
      { pos: 1.0, r: 239, g: 68, b: 68 },
    ];

    let lower = stops[0];
    let upper = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (t >= stops[i].pos && t <= stops[i + 1].pos) {
        lower = stops[i];
        upper = stops[i + 1];
        break;
      }
    }
    const span = Math.max(0.0001, upper.pos - lower.pos);
    const localT = (t - lower.pos) / span;
    const r = Math.round(lower.r + (upper.r - lower.r) * localT);
    const g = Math.round(lower.g + (upper.g - lower.g) * localT);
    const b = Math.round(lower.b + (upper.b - lower.b) * localT);

    return {
      bg: `rgb(${r}, ${g}, ${b})`,
      fg: t > 0.35 ? "#ffffff" : "#e2e8f0",
      border: t > 0.88 ? "rgba(255,255,255,0.45)" : "transparent",
    };
  }

  _setLoadingState(isLoading) {
    const loader = this.shadowRoot?.getElementById("ehc-loader");
    if (loader) {
      loader.classList.toggle("visible", Boolean(isLoading));
    }
  }

  _updateLivePills() {
    if (!this.shadowRoot || !this._hass) return;
    for (const src of this._sources) {
      const el = this.shadowRoot.querySelector(`[data-live-src="${src.id}"]`);
      if (el) {
        const w = this._getLiveWatts(src);
        el.textContent = w !== null ? this._fmtPower(w) : "";
      }
    }
  }

  _buildSkeleton() {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: var(--ha-card-header-font-family, var(--primary-font-family, inherit));
          --ehc-bg: var(--ha-card-background, var(--card-background-color, #23242b));
          --ehc-surface: var(--secondary-background-color, rgba(128, 128, 128, 0.08));
          --ehc-surface-hover: var(--input-fill-color, rgba(128, 128, 128, 0.16));
          --ehc-divider: var(--divider-color, rgba(128, 128, 128, 0.18));
          --ehc-text-primary: var(--primary-text-color, #e4e4e7);
          --ehc-text-secondary: var(--secondary-text-color, #94a3b8);
          --ehc-text-muted: rgba(148, 163, 184, 0.5);
          --ehc-accent: var(--primary-color, #38bdf8);
        }

        ha-card {
          background: var(--ehc-bg);
          border-radius: var(--ha-card-border-radius, 12px);
          border-width: var(--ha-card-border-width, 1px);
          border-style: var(--ha-card-border-style, solid);
          border-color: var(--ha-card-border-color, var(--ehc-divider));
          box-shadow: var(--ha-card-box-shadow, none);
          padding: 16px;
          color: var(--ehc-text-primary);
          overflow: hidden;
          position: relative;
        }
        ha-card.compact {
          padding: 12px 14px;
        }

        .header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 10px;
          flex-wrap: wrap;
          margin-bottom: 12px;
        }
        .title-wrap {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .status-dot {
          width: 9px;
          height: 9px;
          border-radius: 50%;
          background: var(--ehc-accent);
          box-shadow: 0 0 8px var(--ehc-accent);
          flex-shrink: 0;
        }
        .title {
          font-size: 1rem;
          font-weight: 600;
          color: var(--ha-card-header-color, var(--ehc-text-primary));
          line-height: 1.2;
        }
        .subtitle {
          font-size: 0.72rem;
          color: var(--ehc-text-secondary);
          margin-top: 2px;
        }
        ha-card.compact .subtitle {
          display: none;
        }

        .header-controls {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
        }

        .pill-group {
          display: inline-flex;
          align-items: center;
          background: var(--ehc-surface);
          border: 1px solid var(--ehc-divider);
          border-radius: 999px;
          padding: 2px;
          gap: 2px;
        }

        button.btn {
          appearance: none;
          border: 1px solid transparent;
          background: transparent;
          color: var(--ehc-text-secondary);
          font-family: inherit;
          font-size: 0.7rem;
          font-weight: 600;
          padding: 3px 8px;
          border-radius: 999px;
          cursor: pointer;
          transition: all 0.15s ease;
          white-space: nowrap;
          line-height: 1.2;
        }
        button.btn:hover:not(:disabled) {
          color: var(--ehc-text-primary);
          background: var(--ehc-surface-hover);
        }
        button.btn:disabled {
          opacity: 0.35;
          cursor: default;
        }
        button.btn.active {
          background: color-mix(in srgb, var(--ehc-accent) 20%, transparent);
          color: var(--ehc-accent);
          border-color: color-mix(in srgb, var(--ehc-accent) 45%, transparent);
        }

        .days-stepper {
          display: inline-flex;
          align-items: center;
          gap: 2px;
          font-size: 0.7rem;
          font-weight: 600;
          color: var(--ehc-text-primary);
          padding: 0 4px;
        }

        .sources-bar {
          display: flex;
          align-items: center;
          gap: 6px;
          overflow-x: auto;
          padding-bottom: 4px;
          margin-bottom: 12px;
          scrollbar-width: thin;
        }
        .sources-bar::-webkit-scrollbar {
          height: 4px;
        }
        .sources-bar::-webkit-scrollbar-thumb {
          background: var(--ehc-divider);
          border-radius: 4px;
        }

        button.source-chip {
          appearance: none;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          background: var(--ehc-surface);
          border: 1px solid var(--ehc-divider);
          border-radius: 10px;
          padding: 5px 10px;
          color: var(--ehc-text-secondary);
          font-family: inherit;
          font-size: 0.74rem;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.15s ease;
          flex-shrink: 0;
        }
        button.source-chip:hover {
          background: var(--ehc-surface-hover);
          color: var(--ehc-text-primary);
        }
        button.source-chip.active {
          color: var(--ehc-text-primary);
          background: color-mix(in srgb, var(--chip-color, var(--ehc-accent)) 16%, var(--ehc-surface));
          border-color: color-mix(in srgb, var(--chip-color, var(--ehc-accent)) 65%, transparent);
          box-shadow: 0 2px 8px color-mix(in srgb, var(--chip-color, var(--ehc-accent)) 18%, transparent);
        }
        .chip-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: var(--chip-color, var(--ehc-accent));
        }
        .chip-live {
          font-size: 0.67rem;
          font-weight: 700;
          padding: 1px 5px;
          border-radius: 6px;
          background: rgba(0, 0, 0, 0.22);
          color: var(--chip-color, var(--ehc-accent));
        }

        .kpi-grid {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 8px;
          margin-bottom: 12px;
        }
        ha-card.compact .kpi-grid {
          display: none;
        }
        @media (max-width: 520px) {
          .kpi-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }
        .kpi-box {
          background: var(--ehc-surface);
          border: 1px solid var(--ehc-divider);
          border-radius: 10px;
          padding: 8px 10px;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .kpi-label {
          font-size: 0.66rem;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--ehc-text-secondary);
        }
        .kpi-val {
          font-size: 0.95rem;
          font-weight: 700;
          color: var(--ehc-text-primary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .kpi-sub {
          font-size: 0.66rem;
          color: var(--ehc-text-secondary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .matrix-outer {
          position: relative;
          width: 100%;
          overflow-x: auto;
          padding-bottom: 2px;
        }
        .matrix-table {
          width: 100%;
          min-width: 520px;
          border-collapse: separate;
          border-spacing: 2px;
          user-select: none;
        }

        .hour-th {
          font-size: 0.62rem;
          font-weight: 600;
          color: var(--ehc-text-secondary);
          text-align: center;
          padding-bottom: 4px;
          width: 3.3%;
        }
        .hour-th.now-col {
          color: var(--ehc-accent);
          font-weight: 800;
        }
        .day-th {
          font-size: 0.68rem;
          font-weight: 600;
          color: var(--ehc-text-secondary);
          text-align: left;
          padding-right: 6px;
          white-space: nowrap;
          width: 86px;
        }
        .day-th.today {
          color: var(--ehc-accent);
          font-weight: 700;
        }
        .day-th.weekend {
          color: var(--ehc-text-primary);
        }
        .total-th {
          font-size: 0.62rem;
          font-weight: 600;
          color: var(--ehc-text-secondary);
          text-align: right;
          padding-left: 6px;
          white-space: nowrap;
          width: 58px;
        }

        .hm-cell {
          position: relative;
          height: 22px;
          border-radius: 4px;
          text-align: center;
          vertical-align: middle;
          font-size: 0.55rem;
          font-weight: 600;
          cursor: pointer;
          transition: transform 0.1s ease, box-shadow 0.1s ease;
          padding: 0;
          overflow: hidden;
        }
        ha-card.compact .hm-cell {
          height: 17px;
          font-size: 0;
        }
        .hm-cell.dense {
          height: 15px;
          font-size: 0;
        }
        .hm-cell.ultra-dense {
          height: 10px;
          font-size: 0;
          border-radius: 2px;
        }
        .hm-cell:hover {
          transform: scale(1.14);
          z-index: 5;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
          outline: 1.5px solid #ffffff;
        }
        .hm-cell.selected {
          outline: 2px solid #ffffff;
          z-index: 4;
        }
        .hm-cell.future {
          background: repeating-linear-gradient(
            -45deg,
            rgba(128, 128, 128, 0.03),
            rgba(128, 128, 128, 0.03) 3px,
            rgba(128, 128, 128, 0.07) 3px,
            rgba(128, 128, 128, 0.07) 6px
          ) !important;
          cursor: default;
        }
        .hm-cell.live-now {
          outline: 1.5px dashed var(--ehc-accent);
        }

        .day-total-td {
          padding-left: 6px;
          vertical-align: middle;
          white-space: nowrap;
        }
        .day-total-wrap {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 5px;
        }
        .day-total-bar-bg {
          width: 24px;
          height: 6px;
          background: var(--ehc-surface);
          border-radius: 999px;
          overflow: hidden;
          flex-shrink: 0;
        }
        .day-total-bar-fill {
          height: 100%;
          border-radius: 999px;
        }
        .day-total-txt {
          font-size: 0.65rem;
          font-weight: 600;
          color: var(--ehc-text-primary);
          min-width: 44px;
          text-align: right;
        }

        .profile-row td {
          padding-top: 5px;
        }
        .profile-cell {
          height: 16px;
          border-radius: 3px;
          text-align: center;
          font-size: 0.52rem;
          font-weight: 700;
        }

        .footer-bar {
          margin-top: 10px;
          padding-top: 10px;
          border-top: 1px solid var(--ehc-divider);
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
        }
        .inspect-box {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 0.74rem;
          color: var(--ehc-text-secondary);
          min-height: 22px;
          flex: 1;
        }
        .inspect-badge {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 2px 8px;
          border-radius: 6px;
          font-weight: 700;
          font-size: 0.72rem;
          background: var(--ehc-surface);
          color: var(--ehc-text-primary);
          border: 1px solid var(--ehc-divider);
        }

        .legend-wrap {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 0.66rem;
          color: var(--ehc-text-secondary);
        }
        .legend-gradient {
          width: 96px;
          height: 8px;
          border-radius: 999px;
          border: 1px solid var(--ehc-divider);
        }
        .legend-gradient.thermal {
          background: linear-gradient(90deg, #1e2d44 0%, #0e88a8 22%, #10b981 45%, #f59e0b 68%, #f97316 86%, #ef4444 100%);
        }

        .loader-badge {
          font-size: 0.66rem;
          color: var(--ehc-accent);
          opacity: 0;
          transition: opacity 0.2s ease;
        }
        .loader-badge.visible {
          opacity: 1;
        }
      </style>

      <ha-card id="card-root">
        <div class="header">
          <div class="title-wrap">
            <span class="status-dot" id="header-dot"></span>
            <div>
              <div style="display:flex;align-items:center;gap:8px;">
                <span class="title" id="card-title">Energy Consumption · Heatmap</span>
                <span class="loader-badge" id="ehc-loader">Updating…</span>
              </div>
              <div class="subtitle" id="card-subtitle">X-axis: Hour of day (00h–23h) · Y-axis: Day</div>
            </div>
          </div>

          <div class="header-controls">
            <div class="pill-group" title="Select period in days">
              <button class="btn" data-days="7">7d</button>
              <button class="btn" data-days="14">14d</button>
              <button class="btn" data-days="30">30d</button>
              <button class="btn" data-days="60">60d</button>
              <button class="btn" data-days="90">90d</button>
              <span class="days-stepper">
                <button class="btn" id="btn-days-dec" title="Fewer days">−</button>
                <span id="lbl-custom-days">14d</span>
                <button class="btn" id="btn-days-inc" title="More days">+</button>
              </span>
            </div>

            <div class="pill-group" title="Shift day window">
              <button class="btn" id="btn-nav-prev" title="Previous period">◀</button>
              <button class="btn" id="btn-nav-today" title="Back to Today">Today</button>
              <button class="btn" id="btn-nav-next" title="Next period">▶</button>
            </div>

            <div class="pill-group" title="Metric to display">
              <button class="btn" data-metric="energy">Wh / Mean</button>
              <button class="btn" data-metric="peak">W Peak</button>
            </div>

            <div class="pill-group">
              <button class="btn" id="btn-palette" title="Change color scale">🔥 Thermal</button>
              <button class="btn" id="btn-compact" title="Compact mode">Compact</button>
            </div>
          </div>
        </div>

        <div class="sources-bar" id="sources-bar"></div>

        <div class="kpi-grid" id="kpi-grid">
          <div class="kpi-box">
            <span class="kpi-label">Period Energy</span>
            <span class="kpi-val" id="kpi-total">—</span>
            <span class="kpi-sub" id="kpi-total-sub">—</span>
          </div>
          <div class="kpi-box">
            <span class="kpi-label">Daily Average</span>
            <span class="kpi-val" id="kpi-daily">—</span>
            <span class="kpi-sub" id="kpi-daily-sub">—</span>
          </div>
          <div class="kpi-box">
            <span class="kpi-label">Peak Hour</span>
            <span class="kpi-val" id="kpi-peak">—</span>
            <span class="kpi-sub" id="kpi-peak-sub">—</span>
          </div>
          <div class="kpi-box">
            <span class="kpi-label">Highest Typical Hour</span>
            <span class="kpi-val" id="kpi-habit">—</span>
            <span class="kpi-sub" id="kpi-habit-sub">—</span>
          </div>
        </div>

        <div class="matrix-outer">
          <table class="matrix-table" id="matrix-table"></table>
        </div>

        <div class="footer-bar">
          <div class="inspect-box" id="inspect-box">
            <span>Hover or tap a cell (Day, Hour) to inspect its detailed consumption.</span>
          </div>
          <div class="legend-wrap">
            <span id="legend-min">0 Wh</span>
            <div class="legend-gradient thermal" id="legend-bar"></div>
            <span id="legend-max">—</span>
          </div>
        </div>
      </ha-card>
    `;

    this.shadowRoot.querySelectorAll("[data-days]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._days = Number(btn.getAttribute("data-days")) || 14;
        this._selectedCell = null;
        this._fetchStatistics(true);
      });
    });

    this.shadowRoot.getElementById("btn-days-dec")?.addEventListener("click", () => {
      const step = this._days > 30 ? 7 : this._days > 14 ? 2 : 1;
      this._days = Math.max(3, this._days - step);
      this._selectedCell = null;
      this._fetchStatistics(true);
    });

    this.shadowRoot.getElementById("btn-days-inc")?.addEventListener("click", () => {
      const step = this._days >= 30 ? 7 : this._days >= 14 ? 2 : 1;
      this._days = Math.min(180, this._days + step);
      this._selectedCell = null;
      this._fetchStatistics(true);
    });

    this.shadowRoot.getElementById("btn-nav-prev")?.addEventListener("click", () => {
      this._offsetDays += Math.max(1, Math.round(this._days / 2));
      this._selectedCell = null;
      this._fetchStatistics(true);
    });

    this.shadowRoot.getElementById("btn-nav-today")?.addEventListener("click", () => {
      if (this._offsetDays !== 0) {
        this._offsetDays = 0;
        this._selectedCell = null;
        this._fetchStatistics(true);
      }
    });

    this.shadowRoot.getElementById("btn-nav-next")?.addEventListener("click", () => {
      this._offsetDays = Math.max(0, this._offsetDays - Math.max(1, Math.round(this._days / 2)));
      this._selectedCell = null;
      this._fetchStatistics(true);
    });

    this.shadowRoot.querySelectorAll("[data-metric]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._metric = btn.getAttribute("data-metric") || "energy";
        this._renderHeatmap();
      });
    });

    this.shadowRoot.getElementById("btn-palette")?.addEventListener("click", () => {
      this._palette = this._palette === "thermal" ? "source" : "thermal";
      this._renderHeatmap();
    });

    this.shadowRoot.getElementById("btn-compact")?.addEventListener("click", () => {
      this._compact = !this._compact;
      this._renderHeatmap();
    });
  }

  _renderSourcesBar(activeSource) {
    const bar = this.shadowRoot.getElementById("sources-bar");
    if (!bar) return;

    bar.innerHTML = this._sources
      .map((src) => {
        const isActive = src.id === activeSource.id;
        const liveW = this._getLiveWatts(src);
        const liveTxt = liveW !== null ? this._fmtPower(liveW) : "";
        return `
          <button class="source-chip ${isActive ? "active" : ""}"
                  data-src-id="${src.id}"
                  style="--chip-color: ${src.color};"
                  title="${src.name}">
            <span class="chip-dot"></span>
            <span>${src.icon} ${src.short}</span>
            <span class="chip-live" data-live-src="${src.id}">${liveTxt}</span>
          </button>
        `;
      })
      .join("");

    bar.querySelectorAll("[data-src-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-src-id");
        if (id && id !== this._selectedSourceId) {
          this._selectedSourceId = id;
          this._selectedCell = null;
          this._renderHeatmap();
        }
      });
      btn.addEventListener("dblclick", () => {
        const id = btn.getAttribute("data-src-id");
        const src = this._sources.find((s) => s.id === id);
        if (src?.power_entity) this._openMoreInfo(src.power_entity);
      });
    });
  }

  _updateInspectBar(cell, row, hourlyAvg, source) {
    const box = this.shadowRoot.getElementById("inspect-box");
    if (!box) return;

    if (!cell || !cell.data) {
      box.innerHTML = `<span>Hover or tap a cell <strong>(Day, Hour)</strong> to see Wh consumption, mean and peak power. Double-click a meter to open its native history.</span>`;
      return;
    }

    const hStart = String(cell.hour).padStart(2, "0") + ":00";
    const hEnd = String((cell.hour + 1) % 24).padStart(2, "0") + ":00";
    const d = cell.data;
    const dayPct = row && row.dayTotalWh > 0 ? Math.round((d.wh / row.dayTotalWh) * 100) : 0;
    const metricVal = this._metric === "peak" ? d.max : d.wh;
    const diffPct = hourlyAvg > 0 ? Math.round(((metricVal - hourlyAvg) / hourlyAvg) * 100) : 0;
    const diffStr =
      hourlyAvg > 0
        ? `${diffPct >= 0 ? "+" : ""}${diffPct}% vs avg ${hStart}`
        : "";

    box.innerHTML = `
      <span class="inspect-badge" style="border-color:${source.color};">
        ${source.icon} ${cell.dayLabel.text} · ${hStart}–${hEnd}
      </span>
      <span>Energy: <strong style="color:var(--ehc-text-primary);">${this._fmtEnergyWh(d.wh)}</strong> (${dayPct}% of day)</span>
      <span>Mean: <strong>${this._fmtPower(d.mean)}</strong> · Peak: <strong style="color:#f97316;">${this._fmtPower(d.max)}</strong></span>
      ${diffStr ? `<span>(${diffStr})</span>` : ""}
    `;
  }

  _renderHeatmap() {
    if (!this.shadowRoot || !this._config) return;

    const activeSource = this._getActiveSource();
    const cardRoot = this.shadowRoot.getElementById("card-root");
    if (cardRoot) {
      cardRoot.classList.toggle("compact", this._compact);
      cardRoot.style.setProperty("--ehc-accent", activeSource.color);
    }

    const titleEl = this.shadowRoot.getElementById("card-title");
    if (titleEl) {
      titleEl.textContent = this._config.title || "Energy Consumption · Heatmap";
    }

    const liveW = this._getLiveWatts(activeSource);
    const subEl = this.shadowRoot.getElementById("card-subtitle");
    if (subEl) {
      const livePart = liveW !== null ? ` · Now: ${this._fmtPower(liveW)}` : "";
      subEl.textContent = `${activeSource.name} · Last ${this._days} days${livePart}`;
    }

    this.shadowRoot.querySelectorAll("[data-days]").forEach((btn) => {
      btn.classList.toggle("active", Number(btn.getAttribute("data-days")) === this._days);
    });
    const lblDays = this.shadowRoot.getElementById("lbl-custom-days");
    if (lblDays) lblDays.textContent = `${this._days}d`;

    const btnToday = this.shadowRoot.getElementById("btn-nav-today");
    const btnNext = this.shadowRoot.getElementById("btn-nav-next");
    if (btnToday) btnToday.classList.toggle("active", this._offsetDays === 0);
    if (btnNext) btnNext.disabled = this._offsetDays === 0;

    this.shadowRoot.querySelectorAll("[data-metric]").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-metric") === this._metric);
    });

    const btnPalette = this.shadowRoot.getElementById("btn-palette");
    if (btnPalette) {
      btnPalette.textContent = this._palette === "thermal" ? "🔥 Thermal" : "🎨 Meter";
      btnPalette.classList.toggle("active", this._palette === "source");
    }

    const btnCompact = this.shadowRoot.getElementById("btn-compact");
    if (btnCompact) btnCompact.classList.toggle("active", this._compact);

    this._renderSourcesBar(activeSource);

    const matrix = this._computeSourceMatrix(activeSource);

    const setTxt = (id, txt) => {
      const el = this.shadowRoot.getElementById(id);
      if (el) el.textContent = txt;
    };

    setTxt("kpi-total", `${(matrix.totalPeriodWh / 1000).toFixed(2)} kWh`);
    setTxt("kpi-total-sub", `${matrix.rows.length} days · ${activeSource.short}`);

    const avgContinuousW = matrix.avgDailyWh / 24;
    setTxt("kpi-daily", `${(matrix.avgDailyWh / 1000).toFixed(2)} kWh/d`);
    setTxt("kpi-daily-sub", `~ ${this._fmtPower(avgContinuousW)} continuous`);

    if (matrix.peakCell) {
      const ph = String(matrix.peakCell.hour).padStart(2, "0") + ":00";
      setTxt(
        "kpi-peak",
        this._metric === "peak"
          ? this._fmtPower(matrix.peakCell.max)
          : this._fmtEnergyWh(matrix.peakCell.wh)
      );
      setTxt("kpi-peak-sub", `${matrix.peakCell.dayLabel} at ${ph}`);
    } else {
      setTxt("kpi-peak", "—");
      setTxt("kpi-peak-sub", "No data");
    }

    const bhStart = String(matrix.bestHourIdx).padStart(2, "0") + ":00";
    const bhEnd = String((matrix.bestHourIdx + 1) % 24).padStart(2, "0") + ":00";
    setTxt("kpi-habit", `${bhStart} – ${bhEnd}`);
    setTxt(
      "kpi-habit-sub",
      `Avg: ${
        this._metric === "peak"
          ? this._fmtPower(matrix.bestHourAvg)
          : this._fmtEnergyWh(matrix.bestHourAvg)
      }`
    );

    const unitSuffix = this._metric === "peak" ? "W" : "Wh";
    setTxt("legend-min", `0 ${unitSuffix}`);
    setTxt(
      "legend-max",
      this._metric === "peak"
        ? this._fmtPower(matrix.scaleMax)
        : this._fmtEnergyWh(matrix.scaleMax)
    );
    const legendBar = this.shadowRoot.getElementById("legend-bar");
    if (legendBar) {
      if (this._palette === "source") {
        legendBar.className = "legend-gradient";
        legendBar.style.background = `linear-gradient(90deg, rgba(20,22,30,0.7) 0%, ${activeSource.color} 100%)`;
      } else {
        legendBar.className = "legend-gradient thermal";
        legendBar.style.background = "";
      }
    }

    const table = this.shadowRoot.getElementById("matrix-table");
    if (!table) return;

    const nowHour = new Date().getHours();
    const densityClass =
      this._days > 45 ? "ultra-dense" : this._days > 21 ? "dense" : "";
    const showCellNumbers = this._days <= 16 && !this._compact;

    let theadHtml = `<thead><tr><th class="day-th">Day \\ Hour</th>`;
    for (let h = 0; h < 24; h++) {
      const isNowCol = this._offsetDays === 0 && h === nowHour;
      theadHtml += `<th class="hour-th ${isNowCol ? "now-col" : ""}">${String(h).padStart(2, "0")}</th>`;
    }
    theadHtml += `<th class="total-th">${this._metric === "peak" ? "Day Peak" : "Day Total"}</th></tr></thead>`;

    let tbodyHtml = `<tbody>`;
    for (let rIdx = 0; rIdx < matrix.rows.length; rIdx++) {
      const row = matrix.rows[rIdx];
      const lblClass = [
        "day-th",
        row.label.isToday ? "today" : "",
        row.label.isWeekend ? "weekend" : "",
      ]
        .filter(Boolean)
        .join(" ");

      tbodyHtml += `<tr><td class="${lblClass}" title="${row.label.fullText}">${row.label.text}</td>`;

      for (let h = 0; h < 24; h++) {
        const cell = row.cells[h];
        if (cell.isFuture) {
          tbodyHtml += `<td class="hm-cell future ${densityClass}" title="Future hour"></td>`;
          continue;
        }
        const styleInfo = this._getCellBackground(
          cell.val,
          matrix.scaleMax,
          activeSource.color
        );
        const isSel =
          this._selectedCell &&
          this._selectedCell.dayKey === cell.dayKey &&
          this._selectedCell.hour === cell.hour;
        const classes = [
          "hm-cell",
          densityClass,
          cell.isCurrentHour ? "live-now" : "",
          isSel ? "selected" : "",
        ]
          .filter(Boolean)
          .join(" ");

        const cellTxt = showCellNumbers ? this._fmtCellShort(cell.val) : "";
        const hStr = `${String(h).padStart(2, "0")}:00`;
        const tooltip = cell.data
          ? `${row.label.text} (${hStr}) · Energy: ${this._fmtEnergyWh(
              cell.data.wh
            )} · Mean: ${this._fmtPower(cell.data.mean)} · Peak: ${this._fmtPower(
              cell.data.max
            )}`
          : `${row.label.text} (${hStr}) · No data`;

        tbodyHtml += `<td class="${classes}"
          data-r="${rIdx}" data-h="${h}"
          style="background:${styleInfo.bg};color:${styleInfo.fg};"
          title="${tooltip}">${cellTxt}</td>`;
      }

      const barPct = Math.max(
        0,
        Math.min(100, (row.dayTotalWh / matrix.maxDayWh) * 100)
      );
      const rightTxt =
        this._metric === "peak"
          ? this._fmtPower(row.dayPeakW)
          : `${(row.dayTotalWh / 1000).toFixed(2)} kWh`;

      tbodyHtml += `
        <td class="day-total-td" title="Day total: ${this._fmtEnergyWh(row.dayTotalWh)} · Peak: ${this._fmtPower(row.dayPeakW)}">
          <div class="day-total-wrap">
            <div class="day-total-bar-bg">
              <div class="day-total-bar-fill" style="width:${barPct.toFixed(1)}%;background:${activeSource.color};"></div>
            </div>
            <span class="day-total-txt">${rightTxt}</span>
          </div>
        </td>
      </tr>`;
    }

    tbodyHtml += `<tr class="profile-row"><td class="day-th" style="font-weight:700;color:var(--ehc-text-primary);">Avg / h</td>`;
    for (let h = 0; h < 24; h++) {
      const avgVal = matrix.hourlyAvgs[h];
      const styleInfo = this._getCellBackground(
        avgVal,
        matrix.scaleMax,
        activeSource.color
      );
      const txt = showCellNumbers ? this._fmtCellShort(avgVal) : "";
      const hStr = `${String(h).padStart(2, "0")}:00`;
      tbodyHtml += `<td class="profile-cell" style="background:${styleInfo.bg};color:${styleInfo.fg};" title="Average at ${hStr}: ${
        this._metric === "peak"
          ? this._fmtPower(avgVal)
          : this._fmtEnergyWh(avgVal)
      }">${txt}</td>`;
    }
    tbodyHtml += `<td class="day-total-td"><div class="day-total-wrap"><span class="day-total-txt" style="color:var(--ehc-text-secondary);">${(
      matrix.avgDailyWh / 1000
    ).toFixed(2)} kWh/d</span></div></td></tr>`;

    tbodyHtml += `</tbody>`;
    table.innerHTML = theadHtml + tbodyHtml;

    table.querySelectorAll(".hm-cell[data-r]").forEach((td) => {
      const rIdx = Number(td.getAttribute("data-r"));
      const hIdx = Number(td.getAttribute("data-h"));
      const row = matrix.rows[rIdx];
      const cell = row?.cells?.[hIdx];

      td.addEventListener("mouseenter", () => {
        if (!this._selectedCell) {
          this._updateInspectBar(cell, row, matrix.hourlyAvgs[hIdx], activeSource);
        }
      });

      td.addEventListener("click", () => {
        if (
          this._selectedCell &&
          this._selectedCell.dayKey === cell.dayKey &&
          this._selectedCell.hour === cell.hour
        ) {
          this._selectedCell = null;
          td.classList.remove("selected");
        } else {
          table.querySelectorAll(".hm-cell.selected").forEach((el) =>
            el.classList.remove("selected")
          );
          this._selectedCell = { dayKey: cell.dayKey, hour: cell.hour };
          td.classList.add("selected");
          this._updateInspectBar(cell, row, matrix.hourlyAvgs[hIdx], activeSource);
        }
      });
    });

    table.addEventListener("mouseleave", () => {
      if (!this._selectedCell) {
        this._updateInspectBar(null, null, 0, activeSource);
      }
    });

    if (this._selectedCell) {
      const pinnedRow = matrix.rows.find((r) => r.key === this._selectedCell.dayKey);
      const pinnedCell = pinnedRow?.cells?.[this._selectedCell.hour];
      if (pinnedCell) {
        this._updateInspectBar(
          pinnedCell,
          pinnedRow,
          matrix.hourlyAvgs[this._selectedCell.hour],
          activeSource
        );
      }
    } else if (matrix.rows[0]?.cells?.[nowHour]?.data) {
      const todayRow = matrix.rows[0];
      this._updateInspectBar(
        todayRow.cells[nowHour],
        todayRow,
        matrix.hourlyAvgs[nowHour],
        activeSource
      );
    }
  }
}

if (!customElements.get("energy-heatmap-card")) {
  customElements.define("energy-heatmap-card", EnergyHeatmapCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "energy-heatmap-card",
  name: "Energy Consumption Heatmap Card",
  description:
    "Hour-of-day (X) vs Day (Y) electrical consumption heatmap with selectable meter source and day period",
});
