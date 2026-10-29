"use client";

import { useEffect, useState } from "react";

type Measurements = {
  temperature_c: number;
  pressure_hpa: number;
  humidity_pct: number;
  gas_resistance_ohm: number;
};

type HistoryPoint = Measurements & { receivedAt: number; sampleId: string };
type Range = { min: number; max: number };
type Ranges = Record<keyof Measurements, Range>;
type ChartPoint = { value: number; receivedAt: number };
type IoTDevice = { ip: string; name: string; hostname: string; online: boolean; lastChecked: string };
const CHART_WINDOW_MS = 10 * 60_000;
const SENSOR_POLL_MS = 10_000;

function Sparkline({ data, tone, label, unit, limits }: { data: ChartPoint[]; tone: string; label: string; unit: string; limits?: Range }) {
  const width = 240;
  const height = 88;
  const left = 52;
  const right = 4;
  const top = 7;
  const bottom = 19;
  if (data.length < 2) {
    return <div className="sparkline empty">Verlauf wird aufgebaut …</div>;
  }
  const values = data.map((point) => point.value);
  const lowerLimit = limits?.min ?? Math.min(...values);
  const upperLimit = limits?.max ?? Math.max(...values);
  const rawMinimum = Math.min(...values, lowerLimit);
  const rawMaximum = Math.max(...values, upperLimit);
  const scalePadding = Math.max((upperLimit - lowerLimit) * 0.3, (rawMaximum - rawMinimum) * 0.08, 0.01);
  const minimum = rawMinimum - scalePadding;
  const maximum = rawMaximum + scalePadding;
  const range = maximum - minimum || 1;
  const axisNumber = (value: number) => value.toLocaleString("de-DE", {
    maximumFractionDigits: unit === "hPa" || unit === "kΩ" ? 1 : 1,
  });
  const yPosition = (value: number) => height - bottom
    - ((value - minimum) / range) * (height - top - bottom);
  const points = data.map((point, index) => {
    const x = left + index * ((width - left - right) / (data.length - 1));
    const y = yPosition(point.value);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const area = `${left},${height - bottom} ${points} ${width - right},${height - bottom}`;
  const upperY = yPosition(upperLimit);
  const lowerY = yPosition(lowerLimit);
  return (
    <svg className={`sparkline ${tone}`} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}: Verlauf mit dem auf dem Pi eingestellten Bereich`}>
      {limits && <>
        <rect className="tolerance-band" x={left} y={upperY} width={width - left - right} height={Math.max(1, lowerY - upperY)} />
        <line className="tolerance-limit" x1={left} y1={upperY} x2={width - right} y2={upperY} />
        <line className="tolerance-limit" x1={left} y1={lowerY} x2={width - right} y2={lowerY} />
      </>}
      <line className="chart-axis" x1={left} y1={top} x2={left} y2={height - bottom} />
      <line className="chart-axis" x1={left} y1={height - bottom} x2={width - right} y2={height - bottom} />
      <polygon points={area} />
      <polyline points={points} />
      {limits && <>
        <text className="tolerance-text" x={width - right - 3} y={(upperY + lowerY) / 2 + 3} textAnchor="end">Pi-Bereich</text>
        <text className="tolerance-value" x={left - 5} y={upperY + 3} textAnchor="end">{axisNumber(upperLimit)}</text>
        <text className="tolerance-value" x={left - 5} y={lowerY + 3} textAnchor="end">{axisNumber(lowerLimit)}</text>
      </>}
      <text className="axis-value" x={left - 5} y={top + 3} textAnchor="end">{axisNumber(maximum)} {unit}</text>
      <text className="axis-value" x={left - 5} y={height - bottom + 3} textAnchor="end">{axisNumber(minimum)} {unit}</text>
      <text className="axis-time" x={left} y={height - 4}>−10 min</text>
      <text className="axis-time" x={width - right} y={height - 4} textAnchor="end">jetzt</text>
    </svg>
  );
}

export default function Dashboard() {
  const [measurements, setMeasurements] = useState<Measurements | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [ranges, setRanges] = useState<Ranges | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [alarmOn, setAlarmOn] = useState(false);
  const [automaticAlarm, setAutomaticAlarm] = useState(false);
  const [alarmAcknowledged, setAlarmAcknowledged] = useState(false);
  const [pendingAlarm, setPendingAlarm] = useState<"on" | "off" | null>(null);
  const [connection, setConnection] = useState<"ready" | "ok" | "error">("ready");
  const [controlError, setControlError] = useState<string | null>(null);
  const [lastReading, setLastReading] = useState<string | null>(null);
  const [stationRunning, setStationRunning] = useState<boolean | null>(null);
  const [stationPending, setStationPending] = useState(false);
  const [stationError, setStationError] = useState<string | null>(null);
  const [devices, setDevices] = useState<IoTDevice[]>([]);
  const [devicesError, setDevicesError] = useState(false);
  const [cameraFrameUrl, setCameraFrameUrl] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState(false);
  const cameraOnline = devices.some((device) =>
    device.online && /cam|kamera/i.test(`${device.name} ${device.hostname}`));

  useEffect(() => {
    navigator.serviceWorker?.register("/sw.js").catch(() => undefined);
    async function loadSensors() {
      try {
        const response = await fetch("/api/sensors", { cache: "no-store" });
        if (!response.ok) throw new Error("No data");
        const data = await response.json();
        setMeasurements(data.measurements);
        const fetchedAt = Date.now();
        const timestamp = data.sent_at || new Date(fetchedAt).toISOString();
        const parsedTimestamp = Date.parse(timestamp);
        const receivedAt = Number.isNaN(parsedTimestamp) ? fetchedAt : parsedTimestamp;
        const sampleId = `${data.boot_id ?? "sensor"}:${data.sequence ?? timestamp}`;
        setLastReading(timestamp);
        setHistory((current) => {
          if (current.at(-1)?.sampleId === sampleId) return current;
          const recent = current.filter((point) => receivedAt - point.receivedAt <= CHART_WINDOW_MS);
          return [...recent, { ...data.measurements, receivedAt, sampleId }];
        });
        if (data.alarm_control) {
          if (data.alarm_control.ranges) setRanges(data.alarm_control.ranges);
          setAlarmOn(data.alarm_control.alarm_active === true);
          setAutomaticAlarm(data.alarm_control.automatic_alarm === true);
          setAlarmAcknowledged(data.alarm_control.automatic_alarm_acknowledged === true);
        }
        setConnection("ok");
      } catch {
        setMeasurements(null);
        setHistory([]);
        setRanges(null);
        setLastReading(null);
        setConnection("error");
      }
    }
    loadSensors();
    const timer = window.setInterval(loadSensors, SENSOR_POLL_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    async function loadDevices() {
      try {
        const response = await fetch(`/api/devices?t=${Date.now()}`, { cache: "no-store" });
        const data = await response.json();
        if (!response.ok || !Array.isArray(data.devices)) throw new Error("No devices");
        setDevices(data.devices);
        setDevicesError(false);
      } catch {
        setDevicesError(true);
      }
    }
    loadDevices();
    const timer = window.setInterval(loadDevices, 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (stationPending) return;

    async function loadStationStatus() {
      try {
        const response = await fetch(`/api/pi-control?t=${Date.now()}`, { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Status nicht verfügbar");
        const running = data.running === true;
        setStationRunning(running);
        if (data.alarm_control) {
          if (data.alarm_control.ranges) setRanges(data.alarm_control.ranges);
          setAlarmOn(data.alarm_control.alarm_active === true);
          setAutomaticAlarm(data.alarm_control.automatic_alarm === true);
          setAlarmAcknowledged(data.alarm_control.automatic_alarm_acknowledged === true);
        }
        if (!running) {
          setMeasurements(null);
          setHistory([]);
          setRanges(null);
          setLastReading(null);
          setAlarmOn(false);
          setAutomaticAlarm(false);
          setAlarmAcknowledged(false);
          setConnection("error");
          setControlError(null);
        }
        setStationError(null);
      } catch (error) {
        setStationRunning(null);
        setAlarmOn(false);
        setStationError(error instanceof Error ? error.message : "Status nicht verfügbar");
      }
    }
    loadStationStatus();
    const timer = window.setInterval(loadStationStatus, 2000);
    return () => window.clearInterval(timer);
  }, [stationPending]);

  useEffect(() => {
    if (!cameraOnline) {
      setCameraFrameUrl(null);
      setCameraError(true);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    let hasFrame = false;

    const loadNextFrame = () => {
      const nextFrame = new Image();
      nextFrame.onload = () => {
        if (cancelled) return;
        hasFrame = true;
        setCameraFrameUrl(nextFrame.src);
        setCameraError(false);
        timer = window.setTimeout(loadNextFrame, 1000);
      };
      nextFrame.onerror = () => {
        if (cancelled) return;
        if (!hasFrame) setCameraError(true);
        timer = window.setTimeout(loadNextFrame, 1500);
      };
      nextFrame.src = `/api/camera?t=${Date.now()}`;
    };
    loadNextFrame();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [cameraOnline]);

  const formatNumber = (value: number) => value.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const lastReadingDate = lastReading ? new Date(lastReading) : null;
  const lastReadingText = !lastReadingDate || Number.isNaN(lastReadingDate.getTime())
    ? "--:--:--"
    : lastReadingDate.toLocaleTimeString("de-DE");
  const liveDate = new Date(now);
  const liveDateText = liveDate.toLocaleDateString("de-DE", {
    weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Berlin",
  });
  const liveTimeText = liveDate.toLocaleTimeString("de-DE", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Europe/Berlin",
  });
  const chartNow = history.at(-1)?.receivedAt ?? now;
  const visibleHistory = history.filter((point) => chartNow - point.receivedAt <= CHART_WINDOW_MS);
  const outsideRange = (value: number | undefined, limits: Range | undefined) =>
    value !== undefined && limits !== undefined
    && (value < limits.min || value > limits.max);
  const sensors = [
    { tone: "orange", label: "Temperatur", value: measurements ? formatNumber(measurements.temperature_c) : "—", unit: "°C", data: visibleHistory.map((point) => ({ value: point.temperature_c, receivedAt: point.receivedAt })), limits: ranges?.temperature_c, alarm: outsideRange(measurements?.temperature_c, ranges?.temperature_c) },
    { tone: "blue", label: "Luftfeuchtigkeit", value: measurements ? formatNumber(measurements.humidity_pct) : "—", unit: "%", data: visibleHistory.map((point) => ({ value: point.humidity_pct, receivedAt: point.receivedAt })), limits: ranges?.humidity_pct, alarm: outsideRange(measurements?.humidity_pct, ranges?.humidity_pct) },
    { tone: "violet", label: "Luftdruck", value: measurements ? formatNumber(measurements.pressure_hpa) : "—", unit: "hPa", data: visibleHistory.map((point) => ({ value: point.pressure_hpa, receivedAt: point.receivedAt })), limits: ranges?.pressure_hpa, alarm: outsideRange(measurements?.pressure_hpa, ranges?.pressure_hpa) },
    { tone: "green", label: "Luftqualität", value: measurements ? formatNumber(measurements.gas_resistance_ohm / 1000) : "—", unit: "kΩ", data: visibleHistory.map((point) => ({ value: point.gas_resistance_ohm / 1000, receivedAt: point.receivedAt })), limits: ranges?.gas_resistance_ohm ? { min: ranges.gas_resistance_ohm.min / 1000, max: ranges.gas_resistance_ohm.max / 1000 } : undefined, alarm: outsideRange(measurements?.gas_resistance_ohm, ranges?.gas_resistance_ohm) },
  ];

  async function controlPi(enabled: boolean) {
    if (stationRunning !== true || pendingAlarm !== null) return;
    setPendingAlarm(enabled ? "on" : "off");
    setControlError(null);
    try {
      const response = await fetch("/api/pi-output", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Schaltbefehl fehlgeschlagen");
      setAlarmOn(enabled);
      setAlarmAcknowledged(!enabled && automaticAlarm);
    } catch (error) {
      setControlError(error instanceof Error ? error.message : "Schaltbefehl fehlgeschlagen");
    } finally {
      setPendingAlarm(null);
    }
  }

  async function controlStation(action: "start" | "stop") {
    setStationPending(true);
    setStationError(null);
    try {
      const response = await fetch("/api/pi-control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Aktion fehlgeschlagen");
      const running = data.running === true;
      setStationRunning(running);
      if (!running) {
        setMeasurements(null);
        setHistory([]);
        setRanges(null);
        setLastReading(null);
        setAlarmOn(false);
        setAutomaticAlarm(false);
        setAlarmAcknowledged(false);
        setConnection("error");
        setControlError(null);
      }
    } catch (error) {
      setStationError(error instanceof Error ? error.message : "Aktion fehlgeschlagen");
    } finally {
      setStationPending(false);
    }
  }

  return (
    <main>
      <header className="topbar">
        <div className="brand"><div className="brandmark"><span /><span /><span /></div><strong>Sensor Campus</strong></div>
        <div className="top-actions">
          <time className="live-clock" dateTime={liveDate.toISOString()}>
            <span>{liveDateText}</span>
            <strong>{liveTimeText}</strong>
          </time>
          <div className="connection-info">
            <div
              className={`live status-dot ${connection !== "ok" ? "offline" : ""}`}
              role="status"
              aria-label={connection === "ok" ? "Sensordaten online" : connection === "error" ? "Sensordaten offline" : "Verbindung wird aufgebaut"}
              title={connection === "ok" ? "Sensordaten online" : connection === "error" ? "Sensordaten offline" : "Verbindung wird aufgebaut"}
            ><i /></div>
            <div className="last-measurement">
              <time dateTime={lastReading ?? undefined} title={lastReadingDate ? lastReadingDate.toLocaleString("de-DE") : undefined}>{lastReadingText}</time>
              <small>Letzte Messung</small>
            </div>
          </div>
        </div>
      </header>
      <nav className="device-nav" aria-label="Vernetzte IoT-Geräte">
        <div className="device-nav-heading">
          <span>VERNETZTE IOT-GERÄTE</span>
          <small>{devices.length} Geräte</small>
        </div>
        <div className="device-buttons">
          {devices.map((device, index) => {
            const camera = /cam|kamera/i.test(`${device.name} ${device.hostname}`);
            const deviceType = camera ? "Kamera" : "Temp Sensor";
            return (
            <div className="device-button" key={device.ip}>
              <span className={`device-status ${device.online ? "online" : "offline"}`} aria-label={device.online ? "Online" : "Offline"} />
              <span className="device-copy">
                <strong>Node {index + 1}</strong>
                <span>{deviceType}</span>
                <small>{device.ip}</small>
              </span>
              {camera && <span className="camera-glyph" aria-hidden="true">▣</span>}
            </div>
          )})}
          {!devices.length && <span className="device-empty">{devicesError ? "Pi 5 nicht erreichbar" : "Geräte werden geladen …"}</span>}
        </div>
      </nav>
      <div className="monitoring-workspace camera-active">
        <section className={`camera-panel ${cameraOnline ? "online" : "offline"}`} id="camera-view" aria-label="Node 2 Livebild">
          <header><span><i /> Node 2 · {cameraOnline ? "Live" : "Offline"}</span></header>
          <div className="camera-stage">
            {cameraFrameUrl && !cameraError ? (
              <img
                src={cameraFrameUrl}
                alt="Livebild von Node 2"
                decoding="async"
                onLoad={() => setCameraError(false)}
                onError={() => setCameraError(true)}
              />
            ) : (
              <>
                <span className="camera-placeholder" aria-hidden="true">▣</span>
                <strong>Livebild nicht verfügbar</strong>
                <small>{cameraOnline ? "Verbindung wird aufgebaut …" : "Kamera offline"}</small>
              </>
            )}
          </div>
        </section>
        <section className="sensor-grid" id="nano-sensors" aria-label="Sensorwerte des Nano">
          {sensors.map((sensor) => <article className={`sensor-card ${sensor.alarm ? "alarm" : ""}`} key={sensor.label}>
            <div className="sensor-heading"><span>{sensor.label}</span><i>{measurements ? "Live" : "Offline"}</i></div>
            <div className="reading">{sensor.value}<small>{sensor.unit}</small></div>
            <Sparkline data={sensor.data} tone={sensor.tone} label={sensor.label} unit={sensor.unit} limits={sensor.limits} />
          </article>)}
        </section>
      </div>
      <div className="control-deck">
      <section className="station-control" aria-label="Pi-5-Kontrollstation">
        <div>
          <span>KONTROLLSTATION PI 5</span>
          <strong className={stationRunning ? "online" : "offline"}>
            {stationPending ? "WIRD GESCHALTET …" : stationRunning === true ? "LÄUFT" : stationRunning === false ? "GESTOPPT" : "NICHT ERREICHBAR"}
          </strong>
          {stationError && <small>{stationError}</small>}
        </div>
        <div className="station-buttons">
          <button type="button" disabled={stationPending || stationRunning !== false} onClick={() => controlStation("start")}>START</button>
          <button type="button" disabled={stationPending || stationRunning !== true} onClick={() => controlStation("stop")}>STOP</button>
        </div>
      </section>
      <section className={`industrial-control ${stationRunning !== true ? "offline" : alarmOn ? "active" : ""}`} aria-label="Alarmsteuerung">
        <div className="control-status">
          <span>ALARMANLAGE</span>
          <strong><i />{stationPending
            ? "PI WIRD GESCHALTET …"
            : stationRunning === false
              ? "AUS"
              : stationRunning === null
                ? "NICHT ERREICHBAR"
                : pendingAlarm
                  ? "SCHALTET …"
                  : controlError
                    ? "STÖRUNG"
                    : alarmOn
                      ? "ALARM AKTIV"
                      : automaticAlarm && alarmAcknowledged
                        ? "ALARM QUITTIERT"
                        : "BEREIT"}</strong>
          {controlError && <small>{controlError}</small>}
        </div>
        <div className="control-buttons">
          <button className="industrial-button stop" type="button" disabled={pendingAlarm === "off" || stationRunning !== true} aria-disabled={pendingAlarm !== null || stationRunning !== true} onClick={() => controlPi(false)}>
            <span>AUS</span>
          </button>
          <button className="industrial-button alarm-trigger" type="button" disabled={pendingAlarm === "on" || stationRunning !== true} aria-disabled={pendingAlarm !== null || stationRunning !== true} onClick={() => controlPi(true)}>
            <span>ALARM</span>
          </button>
        </div>
      </section>
      </div>
      <style jsx>{`
        .live.offline { color: #7d8794; background: #edf0f3; }
        .live.offline i { background: #9aa3ad; box-shadow: none; }
        .sensor-card.alarm { background: #ffd9d9; border: 2px solid #dc2626; box-shadow: 0 4px 20px rgba(190, 34, 34, .24); }
        .sensor-card.alarm .sensor-icon { color: #fff; background: #d93636; }
        .sensor-card.alarm .sensor-heading, .sensor-card.alarm .reading { color: #b42323; }
        .sensor-card.alarm .meter { background: #f2caca; }
        .sensor-card.alarm .meter span { background: #d93636; }
        .control-deck { width: min(760px, calc(100% - 32px)); margin: 0 auto 32px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
        .control-deck :global(.station-control) { width: auto; max-width: none; min-height: 92px; margin: 0; padding: 14px; border-radius: 12px; box-shadow: 0 5px 18px rgba(19,35,52,.08); }
        .industrial-control { min-width: 0; margin: 0; padding: 14px; background: #fff; border: 1px solid #cbd5df; border-radius: 12px; box-shadow: 0 5px 18px rgba(19,35,52,.08); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .control-status { min-width: 0; padding: 0; background: transparent; border: 0; color: #253342; }
        .control-status span { display: block; color: #96a5aa; font: 700 10px monospace; letter-spacing: 1.2px; margin-bottom: 7px; }
        .control-status strong { display: flex; align-items: center; gap: 7px; font: 700 12px monospace; letter-spacing: .5px; }
        .control-status i { width: 8px; height: 8px; border-radius: 50%; background: #31c278; box-shadow: 0 0 7px #31c278; }
        .control-status small { display: block; max-width: 270px; margin-top: 8px; color: #ff9b96; font: 10px/1.35 monospace; }
        .industrial-control.active .control-status i { background: #ff3b30; box-shadow: 0 0 9px #ff3b30; }
        .industrial-control.active .control-status strong { color: #c92f2f; }
        .industrial-control.offline .control-status i { background: #7f8b91; box-shadow: none; }
        .industrial-control.offline .control-status strong { color: #aeb9bd; }
        .control-buttons { display: grid; grid-template-columns: repeat(2, 62px); gap: 6px; }
        .industrial-button { min-height: 38px; padding: 0 10px; border-radius: 4px; border: 1px solid; color: #fff; display: flex; align-items: center; justify-content: center; font: 800 9px/1 Arial,sans-serif; letter-spacing: .6px; box-shadow: inset 0 1px rgba(255,255,255,.22), inset 0 -2px rgba(0,0,0,.18), 0 2px 0 #697178; }
        .industrial-button:active:not(:disabled) { transform: translateY(2px); box-shadow: inset 0 2px rgba(0,0,0,.18), 0 1px 0 #697178; }
        .industrial-button:disabled { opacity: .42; cursor: not-allowed; }
        .industrial-button.stop { background: #287b49; border-color: #175832; }
        .industrial-button.alarm-trigger { background: #c92f2f; border-color: #8e1d1d; }
        .button-symbol { width: 27px; height: 27px; border: 2px solid rgba(255,255,255,.75); display: grid; place-items: center; font-size: 15px; border-radius: 2px; }
        @media (max-width: 650px) { .control-deck { width: calc(100% - 24px); grid-template-columns: 1fr; gap: 8px; margin-bottom: 20px; }.control-deck :global(.station-control), .industrial-control { min-height: 76px; padding: 10px 12px; align-items: center; flex-direction: row; gap: 8px; }.control-status { min-width: 108px; padding: 0; }.control-status span { margin-bottom: 4px; font-size: 8px; }.control-status strong { font-size: 10px; }.control-buttons { margin-left: auto; grid-template-columns: repeat(2, 58px); gap: 6px; }.industrial-button { min-height: 32px; padding: 0 6px; }.button-symbol { display: none; } }
      `}</style>
    </main>
  );
}
