Genau an diesem Log kann man sehr gut zeigen, wie SSH-Verschlüsselung in deinem Projekt funktioniert.

Der Befehl ist:

```bash
ssh -v -N -L 1883:127.0.0.1:1883 alaa@192.168.178.128
```

Die Teile bedeuten:

- `ssh` = baut eine sichere SSH-Verbindung auf.
- `-v` = verbose, zeigt die technischen Details der Verbindung. Deshalb siehst du Schlüssel, Algorithmen und Tunnelinformationen.
- `-N` = keine Shell auf dem Raspberry Pi öffnen. Die Verbindung wird nur für den Tunnel benutzt.
- `-L 1883:127.0.0.1:1883` = lokales Port-Forwarding. Port 1883 auf deinem Mac wird durch SSH zu Port 1883 auf dem Pi weitergeleitet.
- `alaa@192.168.178.128` = Verbindung zum Benutzer `alaa` auf deinem Raspberry Pi.

Damit entsteht:

```text
mac_fake_sensor.py
       |
       | MQTT an 127.0.0.1:1883
       v
Mac Port 1883
       |
       | SSH-Tunnel
       | verschlüsselt
       v
Raspberry Pi
127.0.0.1:1883
       |
       v
MQTT-Broker
```

### 1. Verbindungsaufbau

Im Log steht:

```text
Connecting to 192.168.178.128 ... port 22.
Connection established.
```

SSH benutzt standardmäßig Port 22.

Der Mac hat also zunächst eine TCP-Verbindung zum SSH-Server des Raspberry Pi aufgebaut.

---

### 2. Schlüsselaustausch

Sehr interessant ist diese Zeile:

```text
kex: algorithm: mlkem768x25519-sha256
```

`kex` bedeutet Key Exchange.

Hier wird zwischen Mac und Raspberry Pi ein gemeinsames Geheimnis ausgehandelt.

Das Verfahren:

```text
mlkem768x25519-sha256
```

ist ein modernes hybrides Schlüsselaustauschverfahren.

Es kombiniert grob gesagt:

```text
ML-KEM
+
X25519
```

Der Zweck ist:

```text
Mac                         Raspberry Pi
 |                               |
 |----- Schlüsselaustausch ----->|
 |<---- Schlüsselaustausch ------|
 |                               |
 +---- gemeinsames Geheimnis ----+
```

Aus diesem gemeinsamen Geheimnis werden anschließend die Sitzungsschlüssel erzeugt.

Das ist der Teil, bei dem asymmetrische Kryptographie beziehungsweise Public-Key-Verfahren eine wichtige Rolle spielen.

---

### 3. Raspberry Pi authentifizieren

Danach steht:

```text
Server host key: ssh-ed25519
```

und:

```text
Host '192.168.178.128' is known and matches the ED25519 host key.
```

Das ist sehr wichtig.

Der Raspberry Pi besitzt einen eigenen privaten Host-Schlüssel.

Der Mac kennt den dazugehörigen öffentlichen Schlüssel aus:

```text
~/.ssh/known_hosts
```

SSH prüft damit:

```text
Ist das wirklich mein Raspberry Pi?
```

Also:

```text
Pi
Private Key
   |
   | digitale Signatur
   v
Mac
Public Key
   |
   v
Signatur prüfen
```

Das ist ein Beispiel für die Nutzung von asymmetrischer Kryptographie zur Authentifizierung.

Darum erscheint auch:

```text
ssh-ed25519
```

---

### 4. Danach symmetrische Verschlüsselung

Jetzt kommt die wichtige Zeile:

```text
server->client cipher: chacha20-poly1305@openssh.com
client->server cipher: chacha20-poly1305@openssh.com
```

Hier siehst du, womit die eigentlichen Daten verschlüsselt werden.

SSH verwendet:

```text
ChaCha20-Poly1305
```

Das ist symmetrische Kryptographie.

Also:

```text
Asymmetrisch / Public-Key
        ↓
Schlüsselaustausch + Authentifizierung
        ↓
gemeinsamer Sitzungsschlüssel
        ↓
ChaCha20-Poly1305
        ↓
symmetrisch verschlüsselter Datenverkehr
```

Warum macht SSH das so?

Weil asymmetrische Verfahren für große Datenmengen vergleichsweise teuer sind.

Symmetrische Verschlüsselung ist dagegen sehr schnell.

Deshalb verwenden praktisch solche Protokolle ein hybrides Konzept:

```text
Asymmetrisch
→ sichere Verbindung aufbauen

Symmetrisch
→ eigentliche Daten übertragen
```

Das entspricht sehr gut dem Prinzip, das du auch bei TLS für dein Projekt beschreiben kannst.

---

### 5. Was bedeutet `MAC: <implicit>`?

Du hast:

```text
cipher: chacha20-poly1305@openssh.com MAC: <implicit>
```

Poly1305 sorgt zusätzlich dafür, dass Veränderungen an den Daten erkannt werden.

Also nicht nur:

```text
Vertraulichkeit
```

sondern auch:

```text
Integrität
```

Wenn jemand unterwegs ein verschlüsseltes Paket verändert, erkennt SSH das.

ChaCha20-Poly1305 ist ein sogenanntes AEAD-Verfahren:

```text
Verschlüsselung
+
Integrität / Authentizität der Nachricht
```

---

### 6. Deine Anmeldung am Raspberry Pi

Danach versucht SSH, dich als Benutzer `alaa` anzumelden.

Es steht:

```text
Offering public key:
/Users/alaa/.ssh/id_rsa
```

Dein Mac hat also deinen RSA-Schlüssel angeboten.

Danach kommt aber:

```text
Authentications that can continue: publickey,password
```

Das bedeutet:

**Der Raspberry Pi hat deinen RSA-Schlüssel nicht akzeptiert.**

Deshalb geht SSH weiter zu:

```text
Next authentication method: password
```

und schließlich:

```text
Authenticated ... using "password".
```

Aktuell authentifizierst du dich also noch mit:

```text
Benutzername + Passwort
```

und nicht mit deinem RSA-Key.

Wichtig: Auch dein eingegebenes Passwort läuft bereits **innerhalb der verschlüsselten SSH-Verbindung**. Es wird nicht offen durchs Netzwerk geschickt.

---

### 7. Danach wird der MQTT-Tunnel aufgebaut

Jetzt kommt für dein Projekt der wichtigste Teil:

```text
Local connections to LOCALHOST:1883 forwarded to remote address 127.0.0.1:1883
```

Das heißt:

```text
Mac:
127.0.0.1:1883
       |
       | SSH
       v
Pi:
127.0.0.1:1883
```

Dein Python-Code macht:

```python
client.connect("127.0.0.1", 1883, 60)
```

Python denkt also:

```text
Ich verbinde mich mit einem MQTT-Broker auf meinem Mac.
```

Tatsächlich nimmt SSH diese Verbindung:

```text
127.0.0.1:1883
```

und transportiert sie verschlüsselt zum Pi.

Dort verbindet SSH sie mit:

```text
127.0.0.1:1883
```

also deinem MQTT-Broker.

---

### 8. Ist MQTT jetzt verschlüsselt?

Das ist ein wichtiger Unterschied.

Du verwendest:

```text
MQTT Port 1883
```

Port 1883 ist normalerweise MQTT **ohne TLS**.

Aber:

```text
MQTT
   ↓
SSH-Tunnel
   ↓
verschlüsselte Übertragung
```

Zwischen Mac und Raspberry Pi ist dein MQTT-Datenverkehr deshalb trotzdem verschlüsselt.

Genauer:

```text
mac_fake_sensor
     |
     | MQTT unverschlüsselt
     | nur lokal auf dem Mac
     v
SSH
     |
     | verschlüsselt mit ChaCha20-Poly1305
     v
Raspberry Pi SSH
     |
     | MQTT lokal
     v
Mosquitto Broker
```

Wenn du Wireshark auf der Netzwerkverbindung zwischen Mac und Pi verwendest, solltest du deine JSON-Sensordaten nicht im Klartext sehen.

Du würdest hauptsächlich SSH-Daten sehen:

```text
TCP Port 22
verschlüsselte Payload
```

Das ist ein sehr guter Demonstrationsfall für dein Rechnernetze-Projekt.

---

### 9. Diese Zeilen zeigen deinen Sensorverkehr

Später erscheint mehrfach:

```text
Connection to port 1883 forwarding to 127.0.0.1 port 1883 requested.
```

Das bedeutet:

Eine Anwendung auf deinem Mac hat Port 1883 benutzt.

Sehr wahrscheinlich dein:

```text
mac_fake_sensor.py
```

SSH hat dafür einen neuen Tunnelkanal geöffnet:

```text
channel 2: new direct-tcpip
```

Also tatsächlich:

```text
Python
   ↓
Mac:1883
   ↓
SSH Channel
   ↓
Pi:1883
   ↓
MQTT
```

Damit sieht man im Debug-Log sogar, dass dein Port-Forwarding wirklich benutzt wurde.

---

### 10. Warum ist es am Ende abgebrochen?

Am Ende:

```text
Read from remote host 192.168.178.128: Connection reset by peer
client_loop: send disconnect: Broken pipe
```

Das bedeutet:

Die SSH-Verbindung zum Raspberry Pi wurde plötzlich unterbrochen.

`Connection reset by peer` heißt ungefähr:

```text
Die andere Seite bzw. die Netzwerkverbindung
hat die TCP-Verbindung beendet.
```

Das kann beispielsweise durch WLAN-Unterbrechung, Neustart des Pi, SSH-Dienst-Neustart oder einen kurzen Netzwerkverlust passieren.

Dadurch ist auch dein Tunnel weg:

```text
SSH weg
→ Tunnel weg
→ Mac Port 1883 nicht mehr mit Pi verbunden
→ MQTT-Verbindung bricht ab
```

Und genau so ein Ausfall ist für dein Projekt sogar interessant, weil du daran später die **Offline-Erkennung** demonstrieren kannst.

### Für deine Projektdokumentation

Du kannst den Sicherheitsmechanismus sehr gut so darstellen:

```text
1. TCP-Verbindung zum Raspberry Pi
            ↓
2. SSH-Schlüsselaustausch
   mlkem768x25519-sha256
            ↓
3. Server-Authentifizierung
   ED25519 Host Key / Signatur
            ↓
4. Sitzungsschlüssel werden erzeugt
            ↓
5. Symmetrische Verschlüsselung
   ChaCha20-Poly1305
            ↓
6. MQTT wird durch SSH-Tunnel transportiert
            ↓
7. Sensordaten sind auf dem Übertragungsweg geschützt
```

Damit hast du in deinem realen Aufbau bereits ein sehr schönes Beispiel für **asymmetrische Kryptographie zur Authentifizierung und zum sicheren Schlüsselaustausch sowie symmetrische Kryptographie für die eigentliche Datenübertragung**.