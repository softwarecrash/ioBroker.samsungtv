<img src="../../admin/samsung.svg" alt="Samsung-TV-Logo" width="180">

# iobroker.samsungtv

Moderner Samsung-TV-Adapter mit automatischer Discovery und Multi-Device-Management in einer einzigen Instanz.

Dies ist ein unabhängiger Community-Adapter für Fernseher von [Samsung Electronics](https://www.samsung.com/).

## Features
- Automatische Discovery via SSDP/UPnP und optional mDNS
- Mehrere TVs in einer Instanz: `samsungtv.0.<tvname>.*`
- Tizen WebSocket API (8001/8002) + Pairing/Token
- H/J-Serie PIN-Pairing (best effort)
- Wake-on-LAN (optional)
- Absolute Lautstärke und Mute über UPnP RenderingControl
- Stabiler Geräteabgleich via ID/UUID/MAC, auch bei Namensänderungen
- Keine Token-Ausgabe in Logs oder UI (Token verschlüsselt gespeichert)

## Konfiguration
Der Adapter verwendet die nativen ioBroker-Komponenten JSONConfig und Device Manager. Dadurch werden das aktive Admin-Theme sowie Desktop- und Mobilansichten automatisch unterstützt.

Der Tab **Konfiguration** enthält:
- **Automatischer Scan** und **Auto-Scan-Intervall** für die periodische Suche
- **Abfrageintervall** für Power-, Lautstärke- und Mute-Status
- **Discovery-Timeout**
- **SSDP aktivieren** / **mDNS aktivieren** als Discovery-Quellen
- **Wake-on-LAN aktivieren**
- **mDNS-Dienste** im Expertenmodus (Komma-getrennt, best effort)

### Geräte hinzufügen
1. Den Tab **TV-Verwaltung** öffnen.
2. **Netzwerk scannen** starten oder ersatzweise **Manuell hinzufügen** verwenden.
3. Einen gefundenen TV hinzufügen und einen lesbaren Namen für den Objektbaum vergeben.

Aktionen im Device Manager werden sofort angewendet und gespeichert. Der normale ioBroker-Speichern-Button übernimmt Einstellungen aus dem Tab **Konfiguration**.

### Pairing
- **Tizen**: Bei **Pairing starten** erscheint ein Hinweis am TV (meist **Zulassen/Abbrechen**, kein PIN). Am TV bestätigen.
- **H/J-Serie**: **Pairing starten** klicken → TV zeigt PIN → PIN im nativen Dialog eingeben.

Die dynamische Geräte-Registry liegt im persistenten ioBroker-Instanzdatenverzeichnis. Dadurch können Device-Manager-Aktionen nicht von einem bereits geöffneten Einstellungsformular überschrieben werden. Token/Identitäten werden dort mit dem ioBroker-Systemschlüssel verschlüsselt und die Datei erhält ausschließlich Besitzerrechte. Vorhandene Werte aus `native.devices` und dem verschlüsselten `native.tokens` werden beim ersten Start automatisch importiert.

Falls beim Pairing **kein Hinweis** erscheint:
- TV: **Geräte-Verbindungsmanager / Device Connection Manager** → **Zugriffsbenachrichtigung** aktivieren.
- TV: **Geräteliste** prüfen und alte Einträge entfernen.
- ioBroker und TV im **gleichen Subnetz** betreiben.

## Objektmodell
Pro TV:
- `samsungtv.0.<tvname>.info.*`
  - `id`, `ip`, `mac`, `model`, `uuid`, `api`, `lastSeen`, `paired`, `online`
  - `tokenAuthSupport`
- `samsungtv.0.<tvname>.state.*`
  - `power`, `volume`, `muted`
- `samsungtv.0.<tvname>.control.*`
  - `power`, `wol`, `key`, `volumeUp`, `volumeDown`, `mute`, `channelUp`, `channelDown`, `launchApp`, `source`
  - `volume`, `muted`

### Steuerung (Kurz)
- `control.key`: beliebiger Remote-Key (z.B. `KEY_POWER`, `KEY_VOLUP`)
- `control.launchApp`: App-ID (Tizen) aus der TV-App-Liste
- `control.source`: Quelle als Key (`KEY_HDMI`, `KEY_SOURCE`) oder Kurzform (`HDMI`)
- `control.volume`: absolute Lautstärke von 0 bis 100
- `control.muted`: Mute ein oder aus, im Gegensatz zu `control.mute`, das umschaltet

### Lautstärke
`control.volume` und `control.muted` nutzen den UPnP-RenderingControl-Dienst des TVs und
setzen damit einen exakten Wert, statt schrittweise zu regeln. Drei Eigenschaften dieses
Dienstes sind wichtig:

- Er antwortet nur, solange der TV eingeschaltet ist, und beginnt einige Sekunden nachdem
  der TV sich als eingeschaltet meldet. Der Port kann eine TCP-Verbindung annehmen, ohne
  dass der Dienst antwortet; maßgeblich ist daher ein echter `GetVolume`-Aufruf.
- UPnP definiert `upnp:401` als `Invalid Action` und `upnp:402` als `Invalid Args`. Einige
  Samsung-TVs liefern `upnp:401` auch bei Netzwerk- oder Hotelmodus-Einschränkungen. Der
  Adapter nennt diese Einschränkungen daher nur als mögliche und nicht als sichere Ursache.

### Key-Codes (control.key)
`control.key` akzeptiert entweder **Samsung Key-Codes** (`KEY_*`) oder **freundliche Kurzformen**:
- Navigation: `up`, `down`, `left`, `right`, `enter`, `back`
- System: `home`, `source`, `menu`, `info`, `guide`, `exit`
- Lautstärke/Kanal: `volup`, `voldown`, `mute`, `chup`, `chdown`
- Media: `play`, `pause`, `stop`, `rewind`, `ff`, `record`
- Farben: `red`, `green`, `yellow`, `blue`
- Ziffern: `0` bis `9`

Direkte Key-Codes funktionieren ebenfalls:
- Beispiele: `KEY_UP`, `KEY_DOWN`, `KEY_ENTER`, `KEY_RETURN`, `KEY_HOME`, `KEY_SOURCE`

Hinweis: Nicht jeder TV unterstützt jeden Key. Manche Keys wirken nur, wenn ein Menü/Fokus aktiv ist.

## Hinweise
- Discovery ist best effort. SSDP ist primär, mDNS optional.
- Ältere Geräte werden nach Möglichkeit erkannt (HJ/Legacy), Feature-Umfang kann variieren.
- Bei H/J/JU-Geräten wird HJ bevorzugt, wenn verfügbar. Tizen-Remote wird ansonsten versucht und bei „unrecognized method“ automatisch auf HJ umgestellt.
- Falls Legacy-Objekte existieren, werden Warnungen im Log ausgegeben.
- Adapter wurde auf `samsungtv` umbenannt, um Konflikte mit dem alten `samsung`-Adapter zu vermeiden.

## Changelog
Siehe `io-package.json` (`common.news`) oder die GitHub-Releases für Details.

## How to test (Kurz)
1. Adapter installieren und Instanz anlegen.
2. **TV-Verwaltung** öffnen und **Netzwerk scannen** starten.
3. TV hinzufügen und Namen (z.B. `tv-wohnzimmer`) setzen.
4. Prüfen, ob Objektbaum `samsungtv.0.tv-wohnzimmer.*` erscheint.
5. **Pair** ausführen und am TV bestätigen.
6. In den Objekten `control.*` testen (z.B. `control.mute`).
7. TV im Device Manager umbenennen: Der Objektbaum soll sauber migriert werden.

## Lizenz
MIT
