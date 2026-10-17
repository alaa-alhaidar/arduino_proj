"use client";

import { useEffect, useState } from "react";

type IconName = "thermometer" | "drop" | "gauge" | "wind";
type Measurements = {
  temperature_c: number;
  pressure_hpa: number;
  humidity_pct: number;
  gas_resistance_ohm: number;
};

type HistoryPoint = Measurements & { receivedAt: number; sampleId: string };

function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  const paths: Record<IconName, React.ReactNode> = {
    thermometer: <><path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0Z"/><path d="M12 12V6"/></>,
    drop: <path d="M12 2.8S6 9.3 6 14a6 6 0 0 0 12 0c0-4.7-6-11.2-6-11.2Z"/>,
    gauge: <><path d="M4 14a8 8 0 1 1 16 0"/><path d="m12 14 4-4"/><path d="M5 18h14"/></>,
    wind: <><path d="M3 8h11a2 2 0 1 0-2-2"/><path d="M3 12h16a2 2 0 1 1-2 2"/><path d="M3 16h8"/></>,
  };
  return <svg {...common}>{paths[name]}</svg>;
}

function Sparkline({ values, tone, label, unit }: { values: number[]; tone: string; label: string; unit: string }) {
  const width = 240;
  const height = 76;
  const left = 48;
  const right = 4;
  const top = 7;
  const bottom = 19;
  if (values.length < 2) {
    return <div className="sparkline empty">Verlauf wird aufgebaut …</div>;
  }
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = maximum - minimum || 1;
  const axisNumber = (value: number) => value.toLocaleString("de-DE", {
    maximumFractionDigits: unit === "hPa" || unit === "kΩ" ? 1 : 1,
  });
  const points = values.map((value, index) => {
    const x = left + index * ((width - left - right) / (values.length - 1));
    const y = height - bottom - ((value - minimum) / range) * (height - top - bottom);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const area = `${left},${height - bottom} ${points} ${width - right},${height - bottom}`;
  return (
    <svg className={`sparkline ${tone}`} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}: Verlauf der letzten ${values.length} Messungen`}>
      <line className="chart-axis" x1={left} y1={top} x2={left} y2={height - bottom} />
      <line className="chart-axis" x1={left} y1={height - bottom} x2={width - right} y2={height - bottom} />
      <polygon points={area} />
      <polyline points={points} />
      <text className="axis-value" x={left - 5} y={top + 3} textAnchor="end">{axisNumber(maximum)} {unit}</text>
      <text className="axis-value" x={left - 5} y={height - bottom + 3} textAnchor="end">{axisNumber(minimum)} {unit}</text>
      <text className="axis-time" x={left} y={height - 4}>älter</text>
      <text className="axis-time" x={width - right} y={height - 4} textAnchor="end">jetzt</text>
    </svg>
  );
}

export default function Dashboard() {
  const [measurements, setMeasurements] = useState<Measurements | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [alarmOn, setAlarmOn] = useState(false);
  const [pending, setPending] = useState(false);
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
        setHistory((current) => current.at(-1)?.sampleId === sampleId
          ? current
          : [...current, { ...data.measurements, receivedAt, sampleId }].slice(-30));
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
        setStationRunning(data.running === true);
        setStationError(null);
      } catch (error) {
        setStationRunning(null);
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
  const sensors = [
    { icon: "thermometer" as const, tone: "orange", label: "Temperatur", value: measurements ? formatNumber(measurements.temperature_c) : "—", unit: "°C", values: history.map((point) => point.temperature_c), alarm: measurements ? measurements.temperature_c >= 41 && measurements.temperature_c <= 45 : false },
    { icon: "drop" as const, tone: "blue", label: "Luftfeuchtigkeit", value: measurements ? formatNumber(measurements.humidity_pct) : "—", unit: "%", values: history.map((point) => point.humidity_pct), alarm: false },
    { icon: "gauge" as const, tone: "violet", label: "Luftdruck", value: measurements ? formatNumber(measurements.pressure_hpa) : "—", unit: "hPa", values: history.map((point) => point.pressure_hpa), alarm: false },
    { icon: "wind" as const, tone: "green", label: "Luftqualität", value: measurements ? formatNumber(measurements.gas_resistance_ohm / 1000) : "—", unit: "kΩ", values: history.map((point) => point.gas_resistance_ohm / 1000), alarm: false },
  ];

  async function controlPi(enabled: boolean) {
    setPending(true);
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
    } catch (error) {
      setControlError(error instanceof Error ? error.message : "Schaltbefehl fehlgeschlagen");
    } finally {
      setPending(false);
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
      setStationRunning(data.running === true);
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
        {sensors.map((sensor) => <article className={`sensor-card ${sensor.alarm ? "alarm" : ""}`} key={sensor.label}>
          <div className={`sensor-icon ${sensor.tone}`}><Icon name={sensor.icon}/></div>
          <div className="sensor-heading"><span>{sensor.label}</span><i>{measurements ? "Live" : "Offline"}</i></div>
          <div className="reading">{sensor.value}<small>{sensor.unit}</small></div>
          <Sparkline values={sensor.values} tone={sensor.tone} label={sensor.label} unit={sensor.unit} />
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
      <section className={`industrial-control ${alarmOn ? "active" : ""}`} aria-label="Alarmsteuerung">
        <div className="control-status">
          <span>ALARMANLAGE</span>
          <strong><i />{pending ? "SCHALTET …" : controlError ? "STÖRUNG" : alarmOn ? "ALARM AKTIV" : "BEREIT"}</strong>
          {controlError && <small>{controlError}</small>}
        </div>
        <div className="control-buttons">
          <button className="industrial-button stop" type="button" disabled={pending} onClick={() => controlPi(false)}>
            <span className="button-symbol">■</span>
            <span>ALARM<br/>AUSSCHALTEN</span>
          </button>
          <button className="industrial-button alarm-trigger" type="button" disabled={pending} onClick={() => controlPi(true)}>
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
