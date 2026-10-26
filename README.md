# ha-energy-heatmap-card

A theme-aware custom Lovelace Web Component for **Home Assistant** (`custom:energy-heatmap-card`) that visualizes historical electrical power and energy consumption as a 2D heatmap with **Hour of Day (`00:00` – `23:00`)** on the **X-axis** and **Day** on the **Y-axis**.

## Features

- **2D Hour × Day Heatmap Matrix:**
  - **X-Axis (`00` – `23`):** Hourly bins across the day, highlighting the current live hour and displaying a bottom **`Prom / h`** summary row with the average hourly consumption profile.
  - **Y-Axis (Days):** Configurable window of days (`7d`, `14d`, `30d`, `60d`, `90d`, or custom `3d`–`180d` via `− / +` stepper) with `◀ / Hoy / ▶` historical window navigation and a right-hand **Daily Total (`kWh`)** / **Daily Peak (`W`)** bar column.
- **Interactive Meter / Data Source Selector:**
  - Switch between multiple configured power/energy meters directly from the card toolbar, complete with real-time wattage badges.
  - Supports **computed net loads** via `subtract_power_entities` and `subtract_energy_entities` (for example, isolating net Studio desk consumption by subtracting a nested 3D printer, or computing untracked household consumption by subtracting sub-meters from the main grid breaker).
- **Long-Term Recorder Statistics + Live Hour Blending:**
  - Queries `recorder/statistics_during_period` (`period: "hour"`) for fast, multi-month historical rendering, and automatically blends `period: "5minute"` short-term statistics (and live entity state) for the ongoing hour.
- **Dual Metric & Color Scale Modes:**
  - Toggle between **Hourly Energy / Mean Power (`Wh / Media`)** and **Hourly Peak Power (`W Pico`)**.
  - Toggle between a multi-stop **Thermal (`🔥 Térmico`)** heatmap palette and a **Meter Accent (`🎨 Medidor`)** color scale.
  - Includes a 4-card KPI summary strip, interactive cell hover/click inspection bar, and **Compact Mode**.

---

## Installation

### Manual Installation

1. Copy [`energy-heatmap-card.js`](./energy-heatmap-card.js) into your Home Assistant `www` directory:
   ```bash
   /config/www/community/energy-heatmap-card/energy-heatmap-card.js
   ```
2. Register the resource in **Settings → Dashboards → ⋮ (top right) → Resources**:
   - **URL:** `/local/community/energy-heatmap-card/energy-heatmap-card.js?v=1.0.0`
   - **Resource type:** `JavaScript Module`

---

## Configuration

```yaml
type: custom:energy-heatmap-card
title: Consumo Eléctrico · Heatmap
default_days: 14
default_source: grid
default_metric: energy
palette: thermal
compact: false
refresh_interval: 120
sources:
  - id: grid
    name: Main Grid (Total)
    short: Main Grid
    icon: "⚡"
    color: "#38bdf8"
    power_entity: sensor.main_grid_power
    energy_entity: sensor.main_grid_total_energy
  - id: studio
    name: Studio (Total)
    short: Studio
    icon: "🖥️"
    color: "#ff62c0"
    power_entity: sensor.studio_socket_power
    energy_entity: sensor.studio_socket_energy
  - id: studio_desk
    name: Studio (Net Desk)
    short: Desk Net
    icon: "💻"
    color: "#f472b6"
    power_entity: sensor.studio_socket_power
    energy_entity: sensor.studio_socket_energy
    subtract_power_entities:
      - sensor.3d_printer_power
    subtract_energy_entities:
      - sensor.3d_printer_total_energy
  - id: printer
    name: 3D Printer
    short: 3D Printer
    icon: "🖨️"
    color: "#00bcd4"
    power_entity: sensor.3d_printer_power
    energy_entity: sensor.3d_printer_total_energy
  - id: server
    name: Server Rack
    short: Server
    icon: "🖧"
    color: "#bd9dff"
    power_entity: sensor.server_socket_power
    energy_entity: sensor.server_socket_energy
  - id: tv
    name: Living Room TV
    short: TV
    icon: "📺"
    color: "#ffd363"
    power_entity: sensor.tv_socket_power
    energy_entity: sensor.tv_socket_energy
  - id: other
    name: Other (Untracked)
    short: Other
    icon: "🔌"
    color: "#94a3b8"
    power_entity: sensor.main_grid_power
    energy_entity: sensor.main_grid_total_energy
    subtract_power_entities:
      - sensor.studio_socket_power
      - sensor.server_socket_power
      - sensor.tv_socket_power
    subtract_energy_entities:
      - sensor.studio_socket_energy
      - sensor.server_socket_energy
      - sensor.tv_socket_energy
grid_options:
  columns: 12
  rows: auto
```

### Options

| Name | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `title` | `string` | `"Energy Consumption · Heatmap"` | Card header title. |
| `default_days` | `number` | `14` | Initial number of days displayed on the Y-axis (`3`–`180`). |
| `default_source` | `string` | `"grid"` | Initial meter `id` selected from `sources`. |
| `default_metric` | `string` | `"energy"` | `"energy"` (Wh / average W per hour) or `"peak"` (max W per hour). |
| `palette` | `string` | `"thermal"` | `"thermal"` (multi-stop thermal gradient) or `"source"` (meter color gradient). |
| `compact` | `boolean` | `false` | Start the card in compact layout mode. |
| `refresh_interval` | `number` | `120` | Minimum interval in seconds between automatic statistics refreshes. |
| `sources` | `list` | *(Stub sources)* | List of meter source objects (`id`, `name`, `short`, `icon`, `color`, `power_entity`, `energy_entity`, `subtract_power_entities`, `subtract_energy_entities`). |
