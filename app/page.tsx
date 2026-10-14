"use client";

import { useEffect, useMemo, useState } from "react";

type IconName = "thermometer" | "drop" | "gauge" | "wind";

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

export default function Dashboard() {
  const [tick, setTick] = useState(0);
  const [alarmOn, setAlarmOn] = useState(false);
  const [pending, setPending] = useState(false);
  const [connection, setConnection] = useState<"ready" | "ok" | "error">("ready");

  useEffect(() => {
    navigator.serviceWorker?.register("/sw.js").catch(() => undefined);
    const timer = window.setInterval(() => setTick((value) => value + 1), 5000);
    return () => window.clearInterval(timer);
  }, []);

  const sensors = useMemo(() => {
    const phase = tick / 12;
    return [
      { icon: "thermometer" as const, tone: "orange", label: "Temperatur", value: (23 + 2 * Math.sin(phase)).toFixed(1), unit: "°C", progress: 58 },
      { icon: "drop" as const, tone: "blue", label: "Luftfeuchtigkeit", value: (48 + 5 * Math.cos(phase)).toFixed(0), unit: "%", progress: 49 },
      { icon: "gauge" as const, tone: "violet", label: "Luftdruck", value: (1013 + 3 * Math.sin(phase / 3)).toFixed(0), unit: "hPa", progress: 68 },
      { icon: "wind" as const, tone: "green", label: "Luftqualität", value: Math.round(120 + 10 * Math.sin(phase / 2)).toString(), unit: "kΩ", progress: 82 },
    ];
  }, [tick]);

  async function controlPi() {
    const nextState = !alarmOn;
    setPending(true);
    try {
      const response = await fetch("/api/pi-output", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: nextState }),
      });
      if (!response.ok) throw new Error("MQTT command failed");
      setAlarmOn(nextState);
      setConnection("ok");
    } catch {
      setConnection("error");
    } finally {
      setPending(false);
    }
  }

  return (
    <main>
      <header className="topbar">
        <div className="brand"><div className="brandmark"><span /><span /><span /></div><strong>Sensor Campus</strong></div>
        <div className="top-actions">
          <div className={`live ${connection === "error" ? "offline" : ""}`}><i /> {connection === "error" ? "Pi nicht erreichbar" : "Pi 5"}</div>
          <button className={`sensor-button ${alarmOn ? "on" : ""}`} type="button" disabled={pending} onClick={controlPi}>
            {pending ? "Wird gesendet …" : alarmOn ? "LED + Buzzer ausschalten" : "LED + Buzzer einschalten"}
          </button>
        </div>
      </header>
      <section className="sensor-grid" aria-label="Sensorwerte">
        {sensors.map((sensor) => <article className="sensor-card" key={sensor.label}>
          <div className={`sensor-icon ${sensor.tone}`}><Icon name={sensor.icon}/></div>
          <div className="sensor-heading"><span>{sensor.label}</span><i>Live</i></div>
          <div className="reading">{sensor.value}<small>{sensor.unit}</small></div>
          <div className="meter"><span style={{ width: `${sensor.progress}%` }} /></div>
        </article>)}
      </section>
      <style jsx>{`
        .live.offline { color: #7d8794; background: #edf0f3; }
        .live.offline i { background: #9aa3ad; box-shadow: none; }
        .sensor-button { border: 0; border-radius: 9px; padding: 9px 13px; background: #123b6d; color: #fff; font-size: 11px; font-weight: 700; }
        .sensor-button.on { background: #b83232; color: #fff; }
        .sensor-button:disabled { opacity: .6; cursor: wait; }
        @media (max-width: 540px) { .sensor-button { padding: 8px 10px; } }
      `}</style>
    </main>
  );
}
