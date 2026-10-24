<img src="admin/samsung.svg" alt="Samsung TV logo" width="180">

# iobroker.samsungtv

Modern Samsung TV adapter with automatic discovery and multi-device management in one instance (multiple TVs supported in the same instance).

This is an independent community adapter for televisions manufactured by [Samsung Electronics](https://www.samsung.com/).

German documentation is available at `doc/de/README.md`.

## Features

- Automatic discovery via SSDP/UPnP and optional mDNS
- Multiple TVs in one instance: `samsungtv.0.<tvname>.*`
- Multiple adapter instances for separating TVs by location or responsibility
- Tizen WebSocket API (8001/8002) + pairing/token
- H/J series PIN pairing (best effort)
- Wake-on-LAN (optional)
- Absolute volume and mute over UPnP RenderingControl
- Stable device matching via ID/UUID/MAC, also across renames
- No token output in logs or UI (tokens are stored encrypted)

## Configuration

The adapter uses ioBroker's native JSONConfig and Device Manager components. They automatically follow the active admin theme and adapt to desktop and mobile layouts.

The **Configuration** tab contains:

- **Auto scan** and **Auto scan interval** for periodic discovery
- **Poll interval** for power, volume, and mute updates
- **Discovery timeout**
- **Enable SSDP** / **Enable mDNS** discovery sources
- **Enable Wake-on-LAN**
- **mDNS services** in expert mode (comma-separated, best effort)

### Add devices

1. Open the **TV management** tab.
2. Start **Scan** or use **Manual add** as a fallback.
3. Add a discovered TV and choose its readable object-tree name.
4. The setup assistant continues: it pairs the TV, sends a test key (the TV shows its info banner) and asks for the order of the source menu. Every step can be skipped; **Pair**, **Send a test key** and **Inputs** are also actions of each TV.

Device Manager actions are applied and persisted immediately. The regular ioBroker save button applies settings from the **Configuration** tab.

### Pairing

- **Tizen**: when you click **Pair**, the TV shows a prompt (usually **Allow/Cancel**, no PIN). Confirm it on the TV.
- **H/J series**: click **Pair** → TV shows PIN → enter PIN in the native dialog.
- **Tizen, token already known**: click **Set token** and paste the token instead of confirming the prompt on the TV. The adapter verifies the token with the TV before storing it encrypted.

The dynamic device registry is stored in ioBroker's persistent instance data directory so Device Manager actions cannot be overwritten by an already open settings form. Tokens/identities in that registry are encrypted with the ioBroker system secret and the file is written with owner-only permissions. Existing `native.devices` and encrypted `native.tokens` values are imported automatically on the first start.

Multiple adapter instances are supported. Every instance has its own configuration, object namespace, device registry, pairing secrets, timers, and network listeners. Do not add the same TV to more than one instance because concurrent polling and commands can interfere with each other. Legacy configuration from `samsung.0` is imported only by `samsungtv.0`.

If **no prompt** appears during pairing:

- TV: **Device Connection Manager** → enable **Access Notification**.
- TV: check **Device List** and remove old entries.
- Make sure ioBroker and the TV are on the **same subnet**.

## Object model

Per TV:

- `samsungtv.0.<tvname>.info.*`
    - `id`, `ip`, `mac`, `model`, `uuid`, `api`, `lastSeen`, `paired`, `online`, `unreach` (the inverse of `online`)
    - `tokenAuthSupport`
- `samsungtv.0.<tvname>.state.*`
    - `power`, `volume`, `muted`, `app` (Tizen: the app in the foreground, e.g. `YOUTUBE`), `artwork` (The Frame: the shown artwork, e.g. `MY_F0003`)
- `samsungtv.0.<tvname>.control.*`
    - `power`, `wol`, `key`, `home`, `volumeUp`, `volumeDown`, `mute`, `channelUp`, `channelDown`, `launchApp`, `closeApp`, `youtube`, `source`
    - `volume`, `muted`
    - `artMode` (only The Frame)
- `samsungtv.0.<tvname>.scenes.*`: one button per scene of the **Scenes** tab

The `control` channel follows the device type `tv` of the ioBroker type-detector: `control.power` (`switch.power`)
and `control.key` (`media.key`) are required, `launchApp` (`media.app`), `source` (`media.input`), `artMode`
(`switch.mode.art`), `volume`, `muted` and the volume buttons are optional. `key`, `launchApp` and `source` list
their fixed values in `common.states`, so visualizations and the devices adapter can show them as buttons.
`state.volume` is found as the actual volume (`VOLUME_ACTUAL`) and `info.unreach` as `UNREACH`. `state.muted` has
the role `indicator`: as `media.mute` the type-detector would take this read-only mirror as the mute switch.

### Control (short)

- `control.key`: a key of the type-detector list (`HOME`, `UP`, `SELECT`, `BACK`, `NUMBER_1`, ...), any Samsung
  key code (e.g. `KEY_POWER`, `KEY_VOLUP`) or a short form (see below)
- `control.launchApp`: an app of the type-detector list (`YOUTUBE`, `NETFLIX`, `DISNEY_PLUS`, ...) or an app ID
  of the TV. Apps are started over the REST API of the TV, the websocket is the fallback. The adapter asks the TV
  once which known apps are installed and lists only those in `common.states`; the **Remote control** tab can ask
  again.
- `control.source`: an input (`TV`, `HDMI1`, `HDMI2`, ...) or a key code (`KEY_SOURCE`, `KEY_HDMI`). See
  [Inputs](#inputs).
- `control.power`: `true` switches on, `false` off. Tizen TVs are woken with Wake-on-LAN first (if enabled and
  the MAC address is known), also while they still answer in standby, repeated every 10 s for up to 60 s while the
  TV stays unreachable (a TV that is still shutting down misses it). The packet goes to the address of the TV and to
  all broadcast addresses: The Frame in deep standby over WLAN ignored broadcasts but woke up on its address; `KEY_POWER` follows only if the TV answers but
  is not on after 10 s. The Frame wakes up in Art Mode; switching it on means TV, so the adapter leaves Art Mode once it is on.
  Switching off holds `KEY_POWER` for 3 s, because a short press may only switch to Art Mode.
- `control.artMode`: `false` shows TV again: Art Mode off leaves the TV in the art selection, so the adapter then
  opens the source menu, which starts on the last input, and confirms it.
- `control.volume`: absolute volume from 0 to 100
- `control.muted`: mute on or off, as opposed to `control.mute`, which toggles

While a TV is off, only `control.power` and `control.wol` are executed. Every other command - keys, apps, inputs,
volume, Art Mode, scenes without `ON` - is ignored with an info in the log, and its state is set back. Before
ignoring a command the adapter asks the TV once more, in case it was just switched on with its own remote control.
The remote control tab disables all keys but power while the TV is off.

- `control.artMode`: Art Mode of The Frame on or off, read on every poll.

### Inputs

Older TVs switch the input with direct keys (`KEY_HDMI1`, ...). Newer ones (e.g. The Frame 2022) ignore them and
switch only over the source menu. For those, enter the order of that menu once with the **Inputs** action of the
TV: press SOURCE on the remote control and write down the entries to the right of SmartThings, e.g.
`TV, HDMI2, USB`. Only connected inputs are shown there, so update the order when you connect a device.

### Open connection

While a paired Tizen TV is on, the adapter keeps its remote channel (and the art channel of The Frame) open. Keys go
out without a new connection, and the TV reports Art Mode, a new picture, standby, off and power cuts at once
instead of at the next poll. Without a token the adapter never connects on its own, as the TV would ask to allow
it; if the TV refuses the token, it waits for a new pairing.

### YouTube

`control.youtube` plays a video (`jNQXAC9IVRw`), a playlist (`PL…`), the uploads of a channel (`UC…`) or a YouTube URL
in the YouTube app of a Tizen TV, and also takes `play`, `pause`, `next` and `previous`. It uses the YouTube Lounge API
("Link with TV"), so these commands go over Google's servers - the TV accepts no other way. The adapter reads the
screen of the YouTube app locally over DIAL (and starts the app for that if needed); the lounge token is kept in
memory only. The command is sent once the app is open (it is started, waiting up to 30 s), so a scene
`ON, YOUTUBE:UC…` works right after switching on. Handles (`@name`) cannot be resolved without the YouTube Data API.

### Scenes

The **Scenes** tab holds named sequences, e.g. `HOME, YOUTUBE, WAIT 3000, OK` to open YouTube and confirm the
account selection. A step is a key (`HOME`, `OK`, `1`, `KEY_...`), an app (`YOUTUBE`), an input (`HDMI2`) or a
pause (`WAIT 2000`), `CLOSE YOUTUBE`, a held key (`HOLD POWER 3000`) or `YOUTUBE:<video, playlist, channel or URL>`; the pause between two steps is configurable. A scene runs only while the TV is on,
unless it begins with `ON`, which switches the TV on and waits for it, e.g. `ON, YOUTUBE`. In the settings the
steps are picked from a list (switching on, keys, the apps and inputs of the TV, pauses) or typed as text. A scene belongs to one TV or to all of them and
is started with its button `samsungtv.0.<tvname>.scenes.<name>` or from the **Remote control** tab.

### Remote control tab

The **Remote control** tab of the settings shows a remote control for each added TV, with power, Art Mode,
inputs, apps and scenes, so you see right away whether a TV answers. It needs the running instance.

### Volume

`control.volume` and `control.muted` use the TV's UPnP RenderingControl service, so they
set an exact level instead of stepping. Three things about that service are worth knowing:

- It only answers while the TV is on, and it starts answering several seconds after the TV
  first reports itself as on. The port can accept a TCP connection without the service
  behind it responding, so reachability is decided by an actual `GetVolume` call.
- UPnP defines `upnp:401` as `Invalid Action` and `upnp:402` as `Invalid Args`. Some Samsung
  TVs also return `upnp:401` when network or hospitality-mode restrictions block control,
  so the adapter reports those restrictions as possible causes rather than a certainty.

### Key codes (control.key)

`control.key` accepts either **Samsung key codes** (`KEY_*`) or **friendly short forms**:

- Navigation: `up`, `down`, `left`, `right`, `enter`, `back`
- System: `home`, `source`, `menu`, `info`, `guide`, `exit`
- Volume/channel: `volup`, `voldown`, `mute`, `chup`, `chdown`
- Media: `play`, `pause`, `stop`, `rewind`, `ff`, `record`
- Colors: `red`, `green`, `yellow`, `blue`
- Numbers: `0` to `9`

Direct key codes also work:

- Examples: `KEY_UP`, `KEY_DOWN`, `KEY_ENTER`, `KEY_RETURN`, `KEY_HOME`, `KEY_SOURCE`

Note: not every TV supports every key. Some keys only work when a menu/focus is active.

## Notes

- Discovery is best effort. SSDP is primary, mDNS is optional.
- Older devices are detected where possible (HJ/Legacy); feature set may vary.
- For H/J/JU devices, HJ is preferred when available. Tizen remote is attempted otherwise and switches to HJ automatically if the TV reports "unrecognized method".
- If legacy objects exist, warnings are logged.
- Adapter is renamed to `samsungtv` to avoid conflicts with the old `samsung` adapter.

## Changelog

### **WORK IN PROGRESS**

- Add a **Set token** Device Manager action that verifies a known Tizen token before storing it.
- Poll every 2 s for up to 30 s after a power command until the TV reports the new state.
- Add absolute volume and mute (`control.volume`, `control.muted`) over UPnP RenderingControl.
- Fall back to the well-known RenderingControl endpoint when SSDP returns nothing.
- (ioBroker-Bot) Adapter requires admin >= 7.8.23 now.
- (@GermanBluefox) Migrate the adapter to TypeScript; the compiled code is built into `build/`. No functional changes.
- (@GermanBluefox) The `control` channel follows the type-detector device type `tv`, with fixed values for keys, apps and inputs.
- (@GermanBluefox) Start apps over the REST API and offer only the apps installed on the TV.
- (@GermanBluefox) Switch inputs over the source menu on TVs that ignore the direct input keys.
- (@GermanBluefox) Add Art Mode for The Frame (`control.artMode`).
- (@GermanBluefox) Add scenes: sequences of keys, apps, inputs and pauses with a button per scene.
- (@GermanBluefox) Add a setup assistant after adding a TV and a remote control tab in the settings.
- (@GermanBluefox) Control power, volume, mute, input, app and Art Mode from the Device Manager card; large cards.
- (@GermanBluefox) Switch Tizen TVs on with Wake-on-LAN first; switch The Frame off instead of to Art Mode.
- (@GermanBluefox) Send Wake-on-LAN to the broadcast address of every network interface, not only to 255.255.255.255, and log it.
- (@GermanBluefox) The Frame: switching on and Art Mode off show TV with the last input; add `control.home`; token TVs use port 8002 first.
- (@GermanBluefox) Keep the remote and art channels of a Tizen TV open while it is on: faster keys, Art Mode, artwork, off and power cuts are seen at once.
- (@GermanBluefox) Play YouTube videos, playlists and channels with `control.youtube` and the scene step `YOUTUBE:`, see [YouTube](#youtube) (with `@iobroker/youtube-lounge`).
- (@GermanBluefox) `state.app`, `state.artwork`, `control.closeApp`, scene steps `CLOSE` and `HOLD`; a TV is offline only after 3 unanswered polls.
- (@GermanBluefox) Add `info.unreach`; `state.muted` gets the role `indicator`, `state.volume` a range, so the type-detector finds the right states.

### 0.0.28

- Replace the custom React configuration page with native ioBroker JSONConfig and Device Manager components.
- Add responsive discovery, manual-add, details, pairing, rename, and remove workflows.
- Move the dynamic registry to persistent instance data with system-secret encryption and automatic migration.
- Remove obsolete custom admin message handlers and frontend dependencies.

### 0.0.27

- Fix TCP reachability checks and prevent overlapping polling/discovery cycles.
- Add bounded timer settings and cross-platform ping/ARP handling.
- Align generated objects and state roles with the current ioBroker catalogue.
- Complete metadata translations and singleton/compact-mode support.

### 0.0.26

- Replace the legacy configuration page with a responsive React admin UI.
- Add complete ioBroker admin translations and automatic light/dark theme support.
- Add typed configuration foundations and migration tests.
- Store Tizen tokens and H/J pairing identities reliably through ioBroker `encryptedNative` handling.
- Migrate pairing data written by older adapter versions without exposing secrets.

Older changes are documented in [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

[Older changelogs can be found there](CHANGELOG_OLD.md)

## How to test (short)

1. Install the adapter and create an instance.
2. Open **TV management** and start **Scan**.
3. Add a TV and set a name (e.g. `tv-livingroom`).
4. Verify object tree `samsungtv.0.tv-livingroom.*`.
5. Run **Pair** and confirm on the TV.
6. Test `control.*` objects (e.g. `control.mute`).
7. Rename the TV in Device Manager: the object tree should migrate cleanly.

## License

[MIT License](LICENSE)

Copyright (c) 2026 softwarecrash <dev/null@softwarecrash.de>
