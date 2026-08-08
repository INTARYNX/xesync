# MIT App Inventor 2 — Blocks

> Conversion textuelle des blocs visuels de l'application AI2.
> Les noms de variables, méthodes, UUIDs et chaînes JSON sont conservés tels quels.

## Aperçu fonctionnel

L'application :
1. charge une page Web dans un `WebViewer` (depuis les assets Android) avec un `?id=` aléatoire,
2. authentifie l'utilisateur via un `token` stocké dans `TinyDB` (auto-login),
3. communique avec la page Web via `WebViewString` + `RunJavaScript("handleAppResponse(...)")`,
4. scanne les périphériques Bluetooth LE, filtre ceux nommés `XEBEX` (ou dont le nom est contenu dans `XEBEX`),
5. se connecte au périphérique choisi, lit une caractéristique GATT spécifique, décode le payload et renvoie les données à la page Web,
6. persiste les `workouts` (entraînements) localement dans `TinyDB` et les « upload » à la page Web.

---

## 1. Variables globales (initialisation)

```
initialize global url             := "file:///android_asset/app.html?id=" + random integer from 1000000000 to 9999999999
initialize global XebexDevices    := create empty list
initialize global intentionalDisconnect := false
initialize global Devices         := create empty list
initialize global BleMac          := ""
initialize global serviceUuid     := "00001826-0000-1000-8000-00805f9b34fb"
initialize global characteristicUuid := "00002ad1-0000-1000-8000-00805f9b34fb"
initialize global processedData   := ""
initialize global newData         := ""
initialize global previousData    := ""
initialize global FilteredList    := create empty list
initialize global FoundDevices    := create empty list
initialize global varToken        := ""
```

> **Note** : `serviceUuid = 0x1826` (FITNESS MACHINE service), `characteristicUuid = 0x2AD1` (Fitness Machine Feature).

---

## 2. `when Screen1.Initialize`

```
do:
  - WebViewerMain.HomeUrl       := get global url
  - TaifunTools1.KeepScreenOn
  - Barstool1.SetBarsColors(
        statusBarColor     = black,
        navigationBarColor = black
    )
  - Barstool1.SetNavigationBarVisibility(show = false)
  - BluetoothStream.ConnectionTimeout := 1000
  - BluetoothScan.ConnectionTimeout   := 3000
```

---

## 3. `when ClockInit.Timer`

```
do:
  - WebViewExtra1.SetWebviewer(webViewer = WebViewerMain)
  - WebViewExtra1.ZoomControls(enabled = false)
  - ClockInit.TimerEnabled := false
```

---

## 4. `when WebViewerMain.PageLoaded (url)`

```
do:
  if (TinyDB1.GetValue(tag = "token", valueIfTagNotThere = "") ≠ "") then:
    # Debug — affiche le payload autoLogin
    - Notifier1.ShowAlert(notice = join(
        "{",
        join("", TinyDB1.GetValue(tag="token", valueIfTagNotThere=""))
      ))

    # Envoie le token à la page Web
    - WebViewerMain.WebViewString := join(
        "",
        join(
          "{",
          join(
            "{""action"":""autoLogin"",""token"":""",
            TinyDB1.GetValue(tag="token", valueIfTagNotThere="")
          ),
          "}"
        )
      )
    - WebViewerMain.RunJavaScript(js = "handleAppResponse(AppInventor.getWebViewString())")
```

---

## 5. `when WebViewerMain.WebViewStringChange (value)`

C'est le **handler principal** : la page Web notifie l'app en écrivant dans `WebViewString` un JSON `{ "action": "...", ... }`.

```
do:
  initialize local json := {}
  set json := call Web1.JsonTextDecodeWithDictionaries(jsonText = get value)

  # Debug
  call Notifier1.ShowAlert(notice = get json)

  # ─────────────────────────────────────────────
  # Action : loginResult
  # ─────────────────────────────────────────────
  if (lookup in pairs key="action" in json, notFound="not found" = "loginResult") then:
    if (lookup key="success" in json, notFound=false = true) then:
      set global varToken := lookup key="token" in json, notFound="not found"
      call TinyDB1.StoreValue(
        tag = "token",
        valueToStore = get global varToken
      )

      # Re-uploade tous les workouts déjà stockés
      initialize local tags := call TinyDB1.GetTags
      for each tag in list get tags:
        if (starts at text(get tag, 1) = piece "workout_") then:
          set WebViewerMain.WebViewString := join(
            join(join(join(join(join(join(
              "{",
              "{""action"":""uploadWorkout"",""token"":""",
              get global varToken
            ), """",""workout"":"""), get tag), """,""data"":"),
              call TinyDB1.GetValue(tag=get tag, valueIfTagNotThere="")),
              "}"),
            "}"
          )
          call WebViewerMain.RunJavaScript(js = "handleAppResponse(AppInventor.getWebViewString())")
    else:
      # Échec de login → efface le token stocké
      call TinyDB1.StoreValue(tag = "token", valueToStore = "")

  # ─────────────────────────────────────────────
  # Action : scan
  # ─────────────────────────────────────────────
  else if (lookup key="action" in json = "scan") then:
    call startScanning

  # ─────────────────────────────────────────────
  # Action : connect (deviceId fourni)
  # ─────────────────────────────────────────────
  else if (lookup key="action" in json = "connect") then:
    set global BleMac := lookup key="deviceId" in json, notFound="not found"
    call BluetoothStream.ConnectWithAddress(address = get global BleMac)

  # ─────────────────────────────────────────────
  # Action : disconnect
  # ─────────────────────────────────────────────
  else if (lookup key="action" in json = "disconnect") then:
    set global intentionalDisconnect := true
    call BluetoothStream.Disconnect

  # ─────────────────────────────────────────────
  # Action : reconnect
  # ─────────────────────────────────────────────
  else if (lookup key="action" in json = "reconnect") then:
    call BluetoothStream.ConnectWithAddress(address = get global BleMac)

  # ─────────────────────────────────────────────
  # Action : exit
  # ─────────────────────────────────────────────
  else if (lookup key="action" in json = "exit") then:
    close application

  # ─────────────────────────────────────────────
  # Action : stopScan
  # ─────────────────────────────────────────────
  else if (lookup key="action" in json = "stopScan") then:
    call BluetoothScan.StopScanning

  # ─────────────────────────────────────────────
  # Action : uploadAck
  #   → la page Web confirme la réception d'un workout
  # ─────────────────────────────────────────────
  else if (lookup key="action" in json = "uploadAck") then:
    call TinyDB1.ClearTag(
      tag = lookup key="workout" in json, notFound="not found"
    )
    set WebViewerMain.WebViewString := join(
      join(
        join("", "{""action"":""tagCleared"",""workout"":"""),
        lookup key="workout" in json, notFound="not found"
      ),
      "}"
    )

  # ─────────────────────────────────────────────
  # Action : saveData (workout complet)
  #   → persiste localement + ack à la page
  # ─────────────────────────────────────────────
  else if (lookup key="action" in json = "saveData") then:
    call TinyDB1.StoreValue(
      tag = join("", "workout_", lookup key="data" in json, notFound="not found"),
      valueToStore = lookup key="data" in json, notFound="not found"
    )
    set WebViewerMain.WebViewString := "{""action"":""saveAck""}"

  # Toujours
  call WebViewerMain.RunJavaScript(js = "handleAppResponse(AppInventor.getWebViewString())")
```

---

## 6. Procédure `startScanning`

```
to startScanning:
  do:
    - set global FoundDevices  := create empty list
    - set global FilteredList  := create empty list
    - set global XebexDevices  := create empty list
    - call BluetoothScan.StartScanning
```

---

## 7. Procédure `CheckDevice`

```
to CheckDevice:
  do:
    initialize local device := select list item (list = global Devices, index = 1)

    # Retire le premier device de la liste à explorer
    remove list item (list = global Devices, index = 1)

    initialize local macAndName := get device
    initialize local devName    := segment(
        text  = get macAndName,
        start = 19,
        length = length(get macAndName) - 18
    )

    # Debug
    call Notifier1.ShowAlert(notice = get devName)

    # Filtre : nom contient "XEBEX"
    if (contains text(get devName, piece = "XEBEX")) then:
      # Debug
      call Notifier1.ShowAlert(notice = join("found: ", get devName))

      # Si pas déjà connu dans FilteredList
      if (NOT is in list?(
            thing = segment(get macAndName, start=1, length=17),
            list  = get global FilteredList
          )) then:
        call BluetoothScan.ConnectWithAddress(
          address = segment(get macAndName, start=1, length=17)
        )
        set global BleMac := segment(get macAndName, start=1, length=17)
        add items to list (list = global FilteredList, item = segment(get macAndName, start=1, length=17))
        add items to list (list = global FoundDevices, item = get macAndName)
```

> **Hypothèse sur le format `macAndName`** : `XX:XX:XX:XX:XX:XX|Name` (18 chars pour l'adresse MAC + séparateur `|`), donc `devName = substring(19, len-18)`.

---

## 8. `when BluetoothScan.DeviceFound`

```
do:
  - set global Devices := split text(BluetoothScan.DeviceList, at = ",")
  - call CheckDevice
```

---

## 9. `when BluetoothScan.ConnectionFailed (reason)`

```
do:
  if (length of list(get global Devices) ≠ 0) then:
    call CheckDevice
```

---

## 10. `when BluetoothScan.Connected`

```
do:
  initialize local characteristicsUuids := list from csv row text(
      call BluetoothScan.SupportedCharacteristics
  )

  if (contains text(get characteristicsUuids, piece = "00002ad1-0000-1000-8000-00805f9b34fb")) then:
    if (NOT is in list?(thing = get global BleMac, list = get global FilteredList)) then:
      add items to list (list = get global FilteredList, item = get global BleMac)

    # Construit le payload JSON pour la page Web
    initialize local jsonDevices := ""
    for each mac in list get global FoundDevices:
      do:
        if (is in list?(
              thing = segment(get mac, start=1, length=17),
              list  = get global FilteredList
            )) then:
          if (get jsonDevices ≠ "") then:
            set jsonDevices := join(get jsonDevices, ",")

          set jsonDevices := join(
            join(
              get jsonDevices,
              join("""id"":", join(trim(get mac), "}"))
            )
          )
        # (note : le bloc semble tronqué visuellement — un '}' semble fermé en double ;
        #  à vérifier dans l'éditeur AI2)

    set WebViewerMain.WebViewString := join(
      join(join(join(join(join(
        "",
        "{""action"":""scanResult"",""devices"":[",
        get jsonDevices
      ), "]"), "}"),
        "}")
    )
    call WebViewerMain.RunJavaScript(js = "handleAppResponse(AppInventor.getWebViewString())")
```

> ⚠️ La construction du JSON pour `scanResult` est **fragile** dans les blocs : il manque visiblement un
> crochet fermant `]` ou une accolade `}` autour de l'objet `{id:...}`. Voir la note d'attention plus bas.

---

## 11. `when BluetoothStream.Connected`

```
do:
  - BluetoothStream.AutoReconnect := false
  - call BluetoothStream.Register (UUIDs: serviceUuid + characteristicUuid)
  - set WebViewerMain.WebViewString := "{""action"":""connectResult"",""success"":true}"
  - call WebViewerMain.RunJavaScript(js = "handleAppResponse(AppInventor.getWebViewString())")
```

---

## 12. `when BluetoothStream.Disconnected`

```
do:
  - BluetoothStream.AutoReconnect := false
  - call BluetoothStream.DisconnectWithAddress(address = get global BleMac)
  - call BluetoothScan.DisconnectWithAddress (address = get global BleMac)

  if (get global intentionalDisconnect = true) then:
    set global intentionalDisconnect := false
  else:
    set WebViewerMain.WebViewString := "{""action"":""disconnected""}"
    call WebViewerMain.RunJavaScript(js = "handleAppResponse(AppInventor.getWebViewString())")
```

---

## 13. `when BluetoothStream.ConnectionFailed (reason)`

```
do:
  - set WebViewerMain.WebViewString := "{""action"":""disconnected""}"
  - call WebViewerMain.RunJavaScript(js = "handleAppResponse(AppInventor.getWebViewString())")
```

---

## 14. `when BluetoothStream.BytesReceived (serviceUuid, characteristicUuid, byteValues)`

```
do:
  if (BluetoothStream.IsDeviceConnected) then:
    set global newData := get byteValues

    # Anti-doublon : ne traite que si les données ont changé
    if (get global newData ≠ get global previousData) then:
      set global previousData := get global newData

      # Extrait les octets utiles (du 3ᵉ au dernier - 1)
      set global processedData := segment(
          text  = get global newData,
          start = 2,
          length = length(get global newData) - 2
      )

      # Envoie à la page Web
      set WebViewerMain.WebViewString := join(
        join(join(join(join(join(
          "",
          "{""action"":""ftmsData"",""data"":""",
          get global processedData
        ), """),
          "}"
        )
      )
      call WebViewerMain.RunJavaScript(js = "handleAppResponse(AppInventor.getWebViewString())")
```

---

## Notes / points à vérifier

| # | Point | Détail |
|---|-------|--------|
| 1 | UUID service / char | `0x1826` / `0x2AD1` → profil **Fitness Machine** (FTMS). Le format de trame attendu côté JS dépend de la spec FTMS. |
| 2 | JSON `scanResult` (bloc 10) | La concaténation manuelle de JSON est très sensible. Un validateur JSON côté JS est **indispensable**. |
| 3 | `devName` (procédure `CheckDevice`) | L'extraction `start=19, length=len-18` suppose le format `AA:BB:CC:DD:EE:FF\|NAME`. À confirmer. |
| 4 | Token | Le `varToken` global n'est initialisé qu'à la réponse `loginResult`. Ne pas l'utiliser avant. |
| 5 | `intentionalDisconnect` | Permet de distinguer une déconnexion volontaire (`true`) d'une perte de signal (`false` → notifier la WebView). |
| 6 | Anti-doublon BLE | Le bloc 14 ignore les paquets identiques au précédent. C'est utile mais peut masquer des mises à jour si la trame revient identique après reconnexion — `previousData` est global et jamais réinitialisé. |

---

## Composants utilisés

| Composant | Rôle |
|-----------|------|
| `Screen1` | Conteneur principal |
| `WebViewerMain` | Affiche la page Web et expose `WebViewString` (canal de communication bidirectionnel) |
| `WebViewExtra1` | Helper (probablement la lib `KIO4_WebViewExtra`) pour binder au `WebViewer` et désactiver le zoom |
| `BluetoothScan` (extension) | Scan BLE (`StartScanning`, `StopScanning`, `DeviceFound`, `DeviceList`) |
| `BluetoothStream` (extension) | Connexion / GATT (`ConnectWithAddress`, `Register`, `BytesReceived`, etc.) |
| `TinyDB1` | Persistance locale du token et des `workouts` |
| `Notifier1` | Alertes de debug (à retirer en prod) |
| `Web1` | Décodage JSON (`JsonTextDecodeWithDictionaries`) |
| `TaifunTools1` | `KeepScreenOn` |
| `Barstool1` | Style status / navigation bar |
| `ClockInit` | Init post-création (probablement configuré à `TimerAlwaysFires=true`, `TimerInterval=0`) |

---

*Généré depuis 14 captures (`blocks(3).png` → `blocks(16).png`).*
