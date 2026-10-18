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
const CHART_WINDOW_MS = 60_000;

function Sparkline({ data, tone, label, unit, limits, now }: { data: ChartPoint[]; tone: string; label: string; unit: string; limits?: Range; now: number }) {
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
  const points = data.map((point) => {
    const age = Math.min(CHART_WINDOW_MS, Math.max(0, now - point.receivedAt));
    const x = left + (1 - age / CHART_WINDOW_MS) * (width - left - right);
    const y = yPosition(point.value);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const firstX = left + (1 - Math.min(CHART_WINDOW_MS, Math.max(0, now - data[0].receivedAt)) / CHART_WINDOW_MS) * (width - left - right);
  const lastX = left + (1 - Math.min(CHART_WINDOW_MS, Math.max(0, now - data.at(-1)!.receivedAt)) / CHART_WINDOW_MS) * (width - left - right);
  const area = `${firstX.toFixed(1)},${height - bottom} ${points} ${lastX.toFixed(1)},${height - bottom}`;
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
      <text className="axis-time" x={left} y={height - 4}>−1 min</text>
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

  useEffect(() => {
    navigator.serviceWorker?.register("/sw.js").catch(() => undefined);
    async function loadSensors() {
      try {
        const response = await fetch("/api/sensors", { cache: "no-store" });
        if (!response.ok) throw new Error("No data");
        const data = await response.json();
        setMeasurements(data.measurements);
        const receivedAt = Date.now();
        const timestamp = data.sent_at || new Date(receivedAt).toISOString();
        const sampleId = `${data.boot_id ?? "sensor"}:${data.sequence ?? timestamp}`;
        setLastReading(timestamp);
        setHistory((current) => {
          const recent = current.filter((point) => receivedAt - point.receivedAt <= CHART_WINDOW_MS);
          return recent.at(-1)?.sampleId === sampleId
            ? recent
            : [...recent, { ...data.measurements, receivedAt, sampleId }];
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
        setConnection("error");
      }
    }
    loadSensors();
    const timer = window.setInterval(loadSensors, 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    async function loadStationStatus() {
      try {
        const response = await fetch("/api/pi-control", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Status nicht verfügbar");
        const running = data.running === true;
        setStationRunning(running);
        if (!running) {
          setAlarmOn(false);
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
    const timer = window.setInterval(loadStationStatus, 15000);
    return () => window.clearInterval(timer);
  }, []);

  const formatNumber = (value: number) => value.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const lastReadingDate = lastReading ? new Date(lastReading) : null;
  const lastReadingAge = lastReadingDate && !Number.isNaN(lastReadingDate.getTime())
    ? Math.max(0, Math.floor((now - lastReadingDate.getTime()) / 1000))
    : null;
  const lastReadingText = lastReadingAge === null
    ? "Noch keine Messung"
    : lastReadingAge < 60
      ? `Letzte Messung ${lastReadingDate?.toLocaleTimeString("de-DE")} · vor ${lastReadingAge} s`
      : `Letzte Messung ${lastReadingDate?.toLocaleTimeString("de-DE")} · vor ${Math.floor(lastReadingAge / 60)} min`;
  const visibleHistory = history.filter((point) => now - point.receivedAt <= CHART_WINDOW_MS);
  const sensors = [
    { tone: "orange", label: "Temperatur", value: measurements ? formatNumber(measurements.temperature_c) : "—", unit: "°C", data: visibleHistory.map((point) => ({ value: point.temperature_c, receivedAt: point.receivedAt })), limits: ranges?.temperature_c },
    { tone: "blue", label: "Luftfeuchtigkeit", value: measurements ? formatNumber(measurements.humidity_pct) : "—", unit: "%", data: visibleHistory.map((point) => ({ value: point.humidity_pct, receivedAt: point.receivedAt })), limits: ranges?.humidity_pct },
    { tone: "violet", label: "Luftdruck", value: measurements ? formatNumber(measurements.pressure_hpa) : "—", unit: "hPa", data: visibleHistory.map((point) => ({ value: point.pressure_hpa, receivedAt: point.receivedAt })), limits: ranges?.pressure_hpa },
    { tone: "green", label: "Luftqualität", value: measurements ? formatNumber(measurements.gas_resistance_ohm / 1000) : "—", unit: "kΩ", data: visibleHistory.map((point) => ({ value: point.gas_resistance_ohm / 1000, receivedAt: point.receivedAt })), limits: ranges?.gas_resistance_ohm ? { min: ranges.gas_resistance_ohm.min / 1000, max: ranges.gas_resistance_ohm.max / 1000 } : undefined },
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
        setAlarmOn(false);
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
          <div className="connection-info">
            <div className={`live ${connection !== "ok" ? "offline" : ""}`}><i /> {connection === "ok" ? "Nano über Pi 5" : connection === "error" ? "Keine Sensordaten" : "Verbindung …"}</div>
            <time dateTime={lastReading ?? undefined} title={lastReadingDate ? lastReadingDate.toLocaleString("de-DE") : undefined}>{lastReadingText}</time>
          </div>
        </div>
      </header>
      <section className="sensor-grid" aria-label="Sensorwerte">
        {sensors.map((sensor) => <article className="sensor-card" key={sensor.label}>
          <div className="sensor-heading"><span>{sensor.label}</span><i>{measurements ? "Live" : "Offline"}</i></div>
          <div className="reading">{sensor.value}<small>{sensor.unit}</small></div>
          <Sparkline data={sensor.data} tone={sensor.tone} label={sensor.label} unit={sensor.unit} limits={sensor.limits} now={now} />
        </article>)}
      </section>
      <section className="station-control" aria-label="Pi-5-Kontrollstation">
        <div>
          <span>KONTROLLSTATION PI 5</span>
          <strong className={stationRunning ? "online" : "offline"}>
            {stationPending ? "WIRD GESCHALTET …" : stationRunning === true ? "LÄUFT" : stationRunning === false ? "GESTOPPT" : "NICHT ERREICHBAR"}
          </strong>
          {stationError && <small>{stationError}</small>}
        </div>
        <div className="station-buttons">
          <button type="button" disabled={stationPending || stationRunning === true} onClick={() => controlStation("start")}>PI 5 STARTEN</button>
          <button type="button" disabled={stationPending || stationRunning === false} onClick={() => controlStation("stop")}>PI 5 STOPPEN</button>
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
            <span className="button-symbol">■</span>
            <span>ALARM<br/>AUSSCHALTEN</span>
          </button>
          <button className="industrial-button alarm-trigger" type="button" disabled={pendingAlarm === "on" || stationRunning !== true} aria-disabled={pendingAlarm !== null || stationRunning !== true} onClick={() => controlPi(true)}>
            <span className="button-symbol">!</span>
            <span>ALARM<br/>AUSLÖSEN</span>
          </button>
        </div>
      </section>
      <style jsx>{`
        .live.offline { color: #7d8794; background: #edf0f3; }
        .live.offline i { background: #9aa3ad; box-shadow: none; }
        .sensor-card.alarm { background: #fff0f0; border-color: #e34848; box-shadow: 0 4px 18px rgba(190, 34, 34, .14); }
        .sensor-card.alarm .sensor-icon { color: #fff; background: #d93636; }
        .sensor-card.alarm .sensor-heading, .sensor-card.alarm .reading { color: #b42323; }
        .sensor-card.alarm .meter { background: #f2caca; }
        .sensor-card.alarm .meter span { background: #d93636; }
        .industrial-control { max-width: 1124px; margin: 0 auto 42px; padding: 12px 14px; background: #d8dde2; border: 2px solid #aeb6bf; border-radius: 4px; box-shadow: inset 0 1px #fff, 0 3px 8px rgba(19,35,52,.12); display: flex; align-items: center; justify-content: space-between; gap: 16px; }
        .control-status { min-width: 170px; padding: 9px 12px; background: #202a30; border: 2px inset #7d878d; color: #dce7e9; }
        .control-status span { display: block; color: #96a5aa; font: 700 10px monospace; letter-spacing: 1.2px; margin-bottom: 7px; }
        .control-status strong { display: flex; align-items: center; gap: 8px; font: 700 14px monospace; letter-spacing: .7px; }
        .control-status i { width: 10px; height: 10px; border-radius: 50%; background: #31c278; box-shadow: 0 0 8px #31c278; }
        .control-status small { display: block; max-width: 270px; margin-top: 8px; color: #ff9b96; font: 10px/1.35 monospace; }
        .industrial-control.active .control-status i { background: #ff3b30; box-shadow: 0 0 9px #ff3b30; }
        .industrial-control.active .control-status strong { color: #ff7770; }
        .industrial-control.offline .control-status i { background: #7f8b91; box-shadow: none; }
        .industrial-control.offline .control-status strong { color: #aeb9bd; }
        .control-buttons { display: grid; grid-template-columns: repeat(2, 138px); gap: 10px; }
        .industrial-button { min-height: 58px; border-radius: 3px; border: 2px solid; color: #fff; display: flex; align-items: center; justify-content: center; gap: 9px; font: 800 10px/1.3 Arial,sans-serif; letter-spacing: .6px; text-align: left; box-shadow: inset 0 2px rgba(255,255,255,.22), inset 0 -3px rgba(0,0,0,.2), 0 3px 0 #697178; }
        .industrial-button:active:not(:disabled) { transform: translateY(2px); box-shadow: inset 0 2px rgba(0,0,0,.18), 0 1px 0 #697178; }
        .industrial-button:disabled { opacity: .42; cursor: not-allowed; }
        .industrial-button.stop { background: #287b49; border-color: #175832; }
        .industrial-button.alarm-trigger { background: #c92f2f; border-color: #8e1d1d; }
        .button-symbol { width: 27px; height: 27px; border: 2px solid rgba(255,255,255,.75); display: grid; place-items: center; font-size: 15px; border-radius: 2px; }
        @media (max-width: 650px) { .industrial-control { margin: 0 16px 24px; align-items: stretch; flex-direction: column; }.control-status { min-width: 0; }.control-buttons { grid-template-columns: 1fr 1fr; }.industrial-button { min-height: 54px; }.button-symbol { display: none; } }
      `}</style>
    </main>
  );
}
