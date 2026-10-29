"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import styles from "./login.module.css";

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: form.get("username"), password: form.get("password") }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Anmeldung fehlgeschlagen.");
      router.replace("/");
      router.refresh();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Anmeldung fehlgeschlagen.");
      setPending(false);
    }
  }

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="login-title">
        <div className={styles.brand}>
          <div className={styles.brandmark} aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <strong>Sensor Campus</strong>
        </div>

        <div className={styles.heading}>
          <p>KONTROLLSTATION</p>
          <h1 id="login-title">Anmelden</h1>
          <span>Zugang zum IoT-Dashboard</span>
        </div>

        <form className={styles.form} onSubmit={handleSubmit}>
          <label>
            Benutzername
            <input name="username" type="text" autoComplete="username" placeholder="Benutzername" required autoFocus />
          </label>
          <label>
            Passwort
            <input name="password" type="password" autoComplete="current-password" placeholder="Passwort" required />
          </label>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <button type="submit" disabled={pending}>{pending ? "WIRD ANGEMELDET …" : "ANMELDEN"}</button>
        </form>

        <small className={styles.note}>Geschützter Zugang zur Kontrollstation</small>
      </section>
    </main>
  );
}
