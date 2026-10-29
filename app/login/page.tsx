import styles from "./login.module.css";

export default function LoginPage() {
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

        <form className={styles.form}>
          <label>
            Benutzername
            <input type="text" autoComplete="username" placeholder="Benutzername" />
          </label>
          <label>
            Passwort
            <input type="password" autoComplete="current-password" placeholder="Passwort" />
          </label>
          <button type="button">ANMELDEN</button>
        </form>

        <small className={styles.note}>Sichere Anmeldung wird als Nächstes eingerichtet.</small>
      </section>
    </main>
  );
}
