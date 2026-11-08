"use client";

import { useEffect, useRef, useState } from "react";

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
type FireStatus = { alarm: boolean; latched_alarm: boolean; notification_active: boolean; confidence: number; positives: number; window_size: number };
const CHART_WINDOW_MS = 10 * 60_000;
const SENSOR_POLL_MS = 10_000;
const FIRE_ALERT_STORAGE_KEY = "sensor-campus-fire-alert";

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
  const [servoAngle, setServoAngle] = useState(90);
  const [servoPending, setServoPending] = useState(false);
  const [servoError, setServoError] = useState<string | null>(null);
  const [fireAlert, setFireAlert] = useState<FireStatus | null>(null);
  const [fireAckPending, setFireAckPending] = useState(false);
  const cameraObjectUrl = useRef<string | null>(null);
  const fireStatusSocket = useRef<WebSocket | null>(null);
  const fireAckPendingRef = useRef(false);
  const closeFireAfterSilence = useRef(false);
  const fireConfirmationSent = useRef(false);
  const fireAlertDismissed = useRef(false);
  const cameraOnline = devices.some((device) =>
    device.online && /cam|kamera/i.test(`${device.name} ${device.hostname}`));
  const cameraActive = cameraOnline && stationRunning !== false;

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
    try {
      const saved = window.localStorage.getItem(FIRE_ALERT_STORAGE_KEY);
      if (saved) setFireAlert(JSON.parse(saved) as FireStatus);
    } catch {
      window.localStorage.removeItem(FIRE_ALERT_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    async function connectFireStatus() {
      try {
        const response = await fetch("/api/camera/fire/session", { cache: "no-store" });
        const session = await response.json() as { url?: string };
        if (!response.ok || !session.url || disposed) throw new Error("Feuerstatus nicht erreichbar");
        socket = new WebSocket(session.url);
        fireStatusSocket.current = socket;
        socket.onmessage = (event) => {
          if (disposed || typeof event.data !== "string") return;
          const status = JSON.parse(event.data) as FireStatus;
          if (status.notification_active === false) {
            fireAlertDismissed.current = true;
            window.localStorage.removeItem(FIRE_ALERT_STORAGE_KEY);
            setFireAlert(null);
            if (fireAckPendingRef.current) {
              fireAckPendingRef.current = false;
              closeFireAfterSilence.current = false;
              fireConfirmationSent.current = false;
              setFireAckPending(false);
            }
          } else if (status.notification_active === true) {
            window.localStorage.setItem(FIRE_ALERT_STORAGE_KEY, JSON.stringify(status));
            setFireAlert(status);
            if (fireAckPendingRef.current && !status.latched_alarm) {
              if (closeFireAfterSilence.current && !fireConfirmationSent.current) {
                fireConfirmationSent.current = true;
                socket?.send("confirm");
              } else if (!closeFireAfterSilence.current) {
                fireAckPendingRef.current = false;
                setFireAckPending(false);
              }
            }
          }
        };
        socket.onerror = () => socket?.close();
        socket.onclose = () => {
          if (fireStatusSocket.current === socket) fireStatusSocket.current = null;
          fireAckPendingRef.current = false;
          closeFireAfterSilence.current = false;
          fireConfirmationSent.current = false;
          setFireAckPending(false);
          if (!disposed) reconnectTimer = window.setTimeout(connectFireStatus, 2000);
        };
      } catch {
        if (!disposed) reconnectTimer = window.setTimeout(connectFireStatus, 2000);
      }
    }
    connectFireStatus();
    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
      fireStatusSocket.current = null;
    };
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
    if (!cameraActive) {
      if (cameraObjectUrl.current) URL.revokeObjectURL(cameraObjectUrl.current);
      cameraObjectUrl.current = null;
      setCameraFrameUrl(null);
      setCameraError(true);
      return;
    }
    let disposed = false;
    let nextFrameTimer: number | null = null;

    const loadFrame = async () => {
      try {
        const response = await fetch(`/api/camera?t=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) throw new Error("Kein Kamerabild");
        const nextUrl = URL.createObjectURL(await response.blob());
        if (disposed) {
          URL.revokeObjectURL(nextUrl);
          return;
        }
        const previousUrl = cameraObjectUrl.current;
        cameraObjectUrl.current = nextUrl;
        setCameraFrameUrl(nextUrl);
        setCameraError(false);
        if (previousUrl) URL.revokeObjectURL(previousUrl);
      } catch {
        if (!disposed) setCameraError(true);
      } finally {
        if (!disposed) nextFrameTimer = window.setTimeout(loadFrame, 750);
      }
    };

    setCameraError(false);
    loadFrame();
    return () => {
      disposed = true;
      if (nextFrameTimer !== null) window.clearTimeout(nextFrameTimer);
      if (cameraObjectUrl.current) URL.revokeObjectURL(cameraObjectUrl.current);
      cameraObjectUrl.current = null;
    };
  }, [cameraActive]);

  const formatNumber = (value: number) => value.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const lastReadingDate = lastReading ? new Date(lastReading) : null;
  const lastReadingText = !lastReadingDate || Number.isNaN(lastReadingDate.getTime())
    ? "--:--:--"
    : lastReadingDate.toLocaleTimeString("de-DE");
  const lastReadingDateText = !lastReadingDate || Number.isNaN(lastReadingDate.getTime())
    ? "--.--.----"
    : lastReadingDate.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" });
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

  async function controlPi(enabled: boolean): Promise<boolean> {
    if (stationRunning !== true || pendingAlarm !== null) return false;
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
      return true;
    } catch (error) {
      setControlError(error instanceof Error ? error.message : "Schaltbefehl fehlgeschlagen");
      return false;
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

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.assign("/login");
    }
  }

  function captureCameraImage() {
    if (!cameraFrameUrl) return;
    const timestamp = new Date().toISOString().replaceAll(":", "-").replace("T", "_").slice(0, 19);
    const link = document.createElement("a");
    link.href = cameraFrameUrl;
    link.download = `sensor-campus_${timestamp}.jpg`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function silenceFireAlarm(closeAfter: boolean) {
    if (fireAckPendingRef.current) return;
    if (fireAlert?.latched_alarm === false) {
      if (closeAfter) {
        fireAckPendingRef.current = true;
        closeFireAfterSilence.current = true;
        setFireAckPending(true);
        const socket = fireStatusSocket.current;
        fireConfirmationSent.current = socket?.readyState === WebSocket.OPEN;
        if (fireConfirmationSent.current) socket?.send("confirm");
      }
      return;
    }
    fireAckPendingRef.current = true;
    closeFireAfterSilence.current = closeAfter;
    fireConfirmationSent.current = false;
    setFireAckPending(true);
    const confirmed = await controlPi(false);
    if (!confirmed) {
      fireAckPendingRef.current = false;
      closeFireAfterSilence.current = false;
      fireConfirmationSent.current = false;
      setFireAckPending(false);
    }
  }

  async function controlServo(angle: number) {
    if (!cameraActive || servoPending) return;
    setServoPending(true);
    setServoError(null);
    try {
      const response = await fetch("/api/camera/servo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ angle }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Servobefehl fehlgeschlagen");
      setServoAngle(result.angle);
    } catch (error) {
      setServoError(error instanceof Error ? error.message : "Servobefehl fehlgeschlagen");
    } finally {
      setServoPending(false);
    }
  }

  return (
    <main>
      {fireAlert && (
        <div className="fire-alert-backdrop" role="presentation">
          <section className="fire-alert" role="alertdialog" aria-modal="true" aria-labelledby="fire-alert-title" aria-describedby="fire-alert-description">
            <div className="fire-alert-icon" aria-hidden="true">🔥</div>
            <p>KI-FEUERERKENNUNG</p>
            <h2 id="fire-alert-title">Feuer erkannt!</h2>
            <span id="fire-alert-description">
              Die Kamera-KI hat Feuer in {fireAlert.positives} von {fireAlert.window_size} Prüfungen erkannt.
              Bitte Livebild kontrollieren und bei Gefahr sofort reagieren.
            </span>
            <div className="fire-alert-actions">
              <button className="fire-silence" type="button" disabled={fireAckPending || !fireAlert.latched_alarm} onClick={() => silenceFireAlarm(false)}>
                {fireAlert.latched_alarm ? "Buzzer AUS" : "Buzzer ist aus"}
              </button>
              <button type="button" autoFocus disabled={fireAckPending} onClick={() => silenceFireAlarm(true)}>
                {fireAckPending ? "Wird bestätigt …" : "Alarm bestätigen"}
              </button>
            </div>
          </section>
        </div>
      )}
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
              <small>{lastReadingDateText} · Letzte Messung</small>
            </div>
          </div>
          <button className="logout-button" type="button" onClick={logout} title="Abmelden" aria-label="Abmelden">
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M10 5H5v14h5M14 8l4 4-4 4M8 12h10" />
            </svg>
            <b>Abmelden</b>
          </button>
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
        <section className={`camera-panel ${cameraActive ? "online" : "offline"}`} id="camera-view" aria-label="Node 2 Livebild">
          <header>
            <span><i /> Node 2 · {cameraActive ? "Live" : "Offline"}</span>
            <button
              className="camera-capture"
              type="button"
              disabled={!cameraFrameUrl || cameraError}
              onClick={captureCameraImage}
              title="Aktuelles Bild speichern"
              aria-label="Aktuelles Kamerabild speichern"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M4 8h3l1.5-2h7L17 8h3v11H4z" />
                <circle cx="12" cy="13" r="3.5" />
              </svg>
              <b>Bild</b>
            </button>
          </header>
          <div className="camera-stage">
            {cameraFrameUrl && !cameraError ? (
              <img
                src={cameraFrameUrl}
                alt="Livebild von Node 2"
                decoding="sync"
                onLoad={() => setCameraError(false)}
                onError={() => setCameraError(true)}
              />
            ) : (
              <>
                <span className="camera-placeholder" aria-hidden="true">▣</span>
                <strong>Livebild nicht verfügbar</strong>
                <small>{stationRunning === false ? "Kontrollstation gestoppt" : cameraOnline ? "Verbindung wird aufgebaut …" : "Kamera offline"}</small>
              </>
            )}
          </div>
          <div className="camera-servo" aria-label="Kamera ausrichten">
            <button
              type="button"
              disabled={!cameraActive || servoPending || servoAngle <= 0}
              onClick={() => controlServo(0)}
            >
              −180°
            </button>
            <button
              type="button"
              disabled={!cameraActive || servoPending || servoAngle <= 0}
              onClick={() => controlServo(Math.max(0, servoAngle - 20))}
            >
              −20°
            </button>
            <button
              type="button"
              disabled={!cameraActive || servoPending}
              className={servoAngle === 90 ? "active" : ""}
              onClick={() => controlServo(90)}
            >
              MITTE
            </button>
            <button
              type="button"
              disabled={!cameraActive || servoPending || servoAngle >= 180}
              onClick={() => controlServo(Math.min(180, servoAngle + 20))}
            >
              +20°
            </button>
            <button
              type="button"
              disabled={!cameraActive || servoPending || servoAngle >= 180}
              onClick={() => controlServo(180)}
            >
              +180°
            </button>
            <small>{servoError ?? (servoPending ? "Kamera wird bewegt …" : `${servoAngle}°`)}</small>
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
        .fire-alert-backdrop { position: fixed; inset: 0; z-index: 1000; padding: 20px; display: grid; place-items: center; background: rgba(25, 8, 8, .72); backdrop-filter: blur(4px); }
        .fire-alert { width: min(440px, 100%); padding: 28px; border: 3px solid #ff5a4f; border-radius: 18px; color: #fff; background: #981f1f; box-shadow: 0 24px 70px rgba(0,0,0,.45); text-align: center; }
        .fire-alert-icon { font-size: 52px; line-height: 1; }
        .fire-alert p { margin: 16px 0 7px; color: #ffd1cd; font: 800 11px monospace; letter-spacing: 1.6px; }
        .fire-alert h2 { margin: 0; font: 800 30px Manrope,sans-serif; }
        .fire-alert span { display: block; margin: 14px 0 22px; color: #ffe9e7; font-size: 14px; line-height: 1.55; }
        .fire-alert-actions { display: grid; grid-template-columns: 1fr 1.35fr; gap: 10px; }
        .fire-alert button { width: 100%; min-height: 46px; border: 0; border-radius: 9px; color: #801717; background: #fff; font-weight: 800; }
        .fire-alert button.fire-silence { color: #fff; background: #621010; border: 1px solid #e47770; }
        .fire-alert button:disabled { opacity: .58; cursor: not-allowed; }
        .fire-alert button:focus-visible { outline: 4px solid #ffd45c; outline-offset: 3px; }
        @media (max-width: 480px) { .fire-alert-actions { grid-template-columns: 1fr; } }
        .sensor-card.alarm { background: #ffd9d9; border: 2px solid #dc2626; box-shadow: 0 4px 20px rgba(190, 34, 34, .24); }
        .sensor-card.alarm .sensor-icon { color: #fff; background: #d93636; }
        .sensor-card.alarm .sensor-heading, .sensor-card.alarm .reading { color: #b42323; }
        .sensor-card.alarm .meter { background: #f2caca; }
        .sensor-card.alarm .meter span { background: #d93636; }
        .control-deck { width: min(760px, calc(100% - 32px)); margin: 18px auto 32px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
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
        .camera-servo { padding: 9px 12px 10px; display: grid; grid-template-columns: repeat(5, 1fr); gap: 7px; background: #18232d; border-top: 1px solid #34434e; }
        .camera-servo button { min-height: 34px; border: 1px solid #526574; border-radius: 6px; color: #dce7ed; background: #293943; font: 800 10px monospace; letter-spacing: .5px; }
        .camera-servo button:hover:not(:disabled) { border-color: #62c99a; background: #315044; }
        .camera-servo button.active { color: #fff; border-color: #31c278; background: #216846; box-shadow: 0 0 0 2px rgba(49,194,120,.12); }
        .camera-servo button:disabled { opacity: .4; cursor: not-allowed; }
        .camera-servo small { grid-column: 1 / -1; color: #91a2ad; text-align: center; font: 9px monospace; }
        .button-symbol { width: 27px; height: 27px; border: 2px solid rgba(255,255,255,.75); display: grid; place-items: center; font-size: 15px; border-radius: 2px; }
        @media (max-width: 650px) { .control-deck { width: calc(100% - 24px); grid-template-columns: 1fr; gap: 12px; margin: 14px auto 20px; }.control-deck :global(.station-control), .industrial-control { min-height: 76px; padding: 10px 12px; align-items: center; flex-direction: row; gap: 8px; }.control-status { min-width: 108px; padding: 0; }.control-status span { margin-bottom: 4px; font-size: 8px; }.control-status strong { font-size: 10px; }.control-buttons { margin-left: auto; grid-template-columns: repeat(2, 58px); gap: 6px; }.industrial-button { min-height: 32px; padding: 0 6px; }.button-symbol { display: none; } }
      `}</style>
    </main>
  );
}
