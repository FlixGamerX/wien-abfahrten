# Live-Abfahrten

Lokaler Öffi-Monitor mit drei Bereichen im Seitenmenü: Abfahrtstafel, Verbindungssuche sowie Linien und Stationen. Die Abfahrtstafel kombiniert Live-Daten der Wiener Linien mit ÖBB-Planabfahrten auf S-Bahn- und REX-Linien. Die Verbindungssuche nutzt das Routing der Wiener Linien und des VOR und kann dadurch Wiener U-Bahn, ÖBB-S-Bahn und Regionalzüge in einer Fahrt kombinieren.

## Starten

Voraussetzung: Node.js 18 oder neuer.

```powershell
cd "C:\Users\Felix Seifert\Documents\Codex\2026-10-20\he\outputs\live-abfahrten"
node server.js
```

Danach die im Terminal ausgegebene Adresse im Browser öffnen. Wenn Port 4173 bereits belegt ist, wechselt der Server automatisch zum nächsten freien Port. Der Server leitet die Abfragen an die offizielle Wiener-Linien-Echtzeitschnittstelle weiter und aktualisiert eine Station frühestens alle 15 Sekunden.

## Auf dem eigenen Handy verwenden

### Schnell im selben WLAN

1. PC und Handy müssen im selben WLAN sein.
2. Starte den Server in PowerShell aus diesem Ordner mit:

   ```powershell
   $env:PORT='4177'; $env:HOST='0.0.0.0'; node server.js
   ```

3. Ermittle am PC mit `ipconfig` die IPv4-Adresse des WLAN-Adapters (zum Beispiel `192.168.1.24`). Falls Windows nach einer Firewallfreigabe fragt, erlaube Node.js nur in privaten Netzwerken.
4. Öffne am Handy `http://PC-IP:PORT`, zum Beispiel `http://192.168.1.24:4177`. Wenn der Port belegt ist, nennt das Terminal den nächsten Port.
5. Android: Browser-Menü → **Zum Startbildschirm hinzufügen**. iPhone: Safari → **Teilen** → **Zum Home-Bildschirm**.

Der PC und der Server müssen dabei eingeschaltet bleiben; die Adresse ist nur im Heimnetz erreichbar. `127.0.0.1` ist die Adresse des jeweiligen Geräts und funktioniert auf dem Handy nicht für deinen PC.

### Als installierbare Web-App mit eigener HTTPS-Adresse

Die Seite enthält ein Web-App-Manifest, Symbol und einen Service Worker. Für die vollständige Installation als Web-App und den Offline-Fallback braucht der Browser eine HTTPS-Adresse (oder `localhost`). Dafür muss der Node-Server samt `rail-network.json` auf einem von dir gewählten HTTPS-Host laufen. Die Live-Schnittstellen benötigen weiterhin Internet; Offline werden keine Abfahrten aktualisiert. Die aktuelle lokale URL ist nicht öffentlich und kann außerhalb deines Heimnetzes nicht verwendet werden.

### Dauerhaft online mit eigener URL

Die enthaltene `render.yaml` ist für einen kostenlosen Render-Webdienst vorbereitet. Dazu muss dieser Ordner in ein GitHub-Repository hochgeladen und in Render verbunden werden. Die kostenlose Instanz schläft nach 15 Minuten ohne Zugriffe und benötigt beim nächsten Aufruf ungefähr eine Minute zum Aufwachen. Die feste `onrender.com`-Adresse bleibt gleich. Beim Anlegen fragt Render nach `APP_USER` und `APP_PASSWORD`; diese schützen die persönliche Seite mit einer Browser-Anmeldung. Render stellt eine HTTPS-URL und automatisch verwaltete TLS-Zertifikate bereit. Eine eigene Domain ist optional.

Vorgehen: Repository bei GitHub erstellen, diesen Projektordner dorthin pushen, in Render **New → Blueprint** wählen, das Repository verbinden und `render.yaml` auswählen. Benutzername und Passwort eintragen, den Free-Plan wählen und den Dienst erstellen. Danach die Render-HTTPS-Adresse im Handy öffnen und zum Startbildschirm hinzufügen. Bei kostenloser Nutzung kann Render den Dienst bei längerer Inaktivität schlafen legen; die Adresse bleibt erreichbar, der erste Aufruf danach ist langsamer.

Wiener-Linien-Abfahrten werden alle fünf Sekunden abgefragt. Wenn die Schnittstelle Plan- und Echtzeitangaben liefert, zeigt die Tafel die Verspätungsminuten. Die Abfahrtstafel für S-Bahn und REX verwendet Planzeiten aus dem beiliegenden ÖBB-GTFS-Fahrplan; aktuelle ÖBB-Verspätungsdaten sind darin nicht enthalten. Die Verbindungssuche fragt die Routing-Schnittstelle der Wiener Linien / des VOR für die gewählte Strecke, das Datum und die Uhrzeit ab.

Abfahrten lassen sich anklicken, um die folgenden Haltestellen zu sehen. Bei ÖBB-S-Bahn und REX stammt die Folge aus GTFS; bei U-Bahn-Linien wird sie aus dem Routing abgerufen.

Die Stationsliste stammt aus dem offenen Wiener-Linien-Haltepunkte-Katalog. Quelle: [Wiener Linien Open Data](https://www.wienerlinien.at/ogd_realtime/doku/ogd/wienerlinien_ogd_Beschreibung.pdf). Echtzeitdaten: [Wiener Linien Realtime](https://www.wienerlinien.at/ogd_realtime/doku/ogd/wienerlinien-echtzeitdaten-dokumentation.pdf). Routing: [Wiener Linien EFA XML-Schnittstelle](https://data.wien.gv.at/pdf/wiener-linien-routing.pdf).

`rail-network.json` enthält 43 beschriftete S-Bahn- und REX-Linien (90 GTFS-Routenvarianten) mit 910 Stationen, Fahrtverläufen, Kalendern und Ausnahmen. Die Daten stammen aus dem bereitgestellten ÖBB-GTFS-Fahrplan 2026 und gelten bis 12. Dezember 2026. Sie enthalten keine aktuellen Verspätungen oder Zugausfälle. Quelle und Namensnennung: ÖBB-Personenverkehr AG, Lizenz CC BY 4.0.
