# Nachinstallierbare DXF-Berechnung

Das Modul `dxf-packing` ergänzt die Animatus Desktop App zur Laufzeit. V2 und V3
verwenden es für „Packen“, „Optimieren“ und die Platzierungswarteschlange.
Es liefert Fortschritt, Vorschauen, Versuchsergebnisse und Rückfragen zur
Suchverteilung. Abbruch, Tabwechsel zu einer anderen Seite und Schließen eines
Tabs beenden dessen laufende Berechnungen. Ein Wechsel zum anderen Tab allein
lässt die Berechnung weiterlaufen.

## Kontur-Nesting für möglichst wenig Stoff (V2, ab 1.5.0)

Das Hauptziel ist eine möglichst kurze **gültige** Anordnung bei fester
Stoffbreite und unveränderter Teilemenge. Für dieses Ziel verwendet Extreme
Bounding jetzt den spezialisierten geometrischen Solver
[Sparrow 0.3.0](https://github.com/JeroenGar/sparrow/tree/v0.3.0) mit jagua-rs 1.0.0.
Er verändert Positionen und erlaubte Drehungen gemeinsam und verkürzt den Streifen
durch Exploration und anschließende Kompression. Dafür sind keine Gewichte,
Trainingsdaten, Python-Installation oder Cloud-Verbindung erforderlich.

Die bisherige Suche prüft hauptsächlich andere Reihenfolgen auf einem Raster;
ihre Nachverdichtung prüft nur rechteckbezogene Kontaktpositionen. Ein gelerntes
Reihenfolgemodell allein beseitigt diese Einschränkung nicht. Sparrow ergänzt
deshalb die Platzierungsgeometrie selbst. Das optionale CPU-Training bleibt als
Forschungsprototyp erhalten; siehe [training/README.md](training/README.md).

In der Desktop-App **Bounding-Einstellungen → Extreme Bounding – Konturen
optimieren** wählen und über **Packen** starten. Der Modus benötigt das neue
Modulpaket. Die neue Operation `pack-nesting-v2` lässt den Installer ein älteres
Paket erkennen. Real Bounding und Standard bleiben unverändert; V3 erhält keinen
neuen Modus. Ohne native Engine bleibt die bestehende Raster-Suche verfügbar.

Der Ablauf behält zuerst eine gültige Standardpackung. Etwa 80 % des verbleibenden
Suchbudgets gehen an die native Suche, der Rest an die bisherige Suche und
Nachverdichtung. Nur vollständige Anordnungen mit erlaubten Drehungen,
passender Breite und unabhängig geprüften Originalkonturen dürfen das bisher
beste Ergebnis ersetzen. Die Live-Vorschau endet mit genau diesem Ergebnis.
Beim Abbruch wird nur der eigene Solver-Prozess beendet und vor der Bestätigung
des Abbruchs abgewartet. Ein defekter Solver verwirft die letzte gültige Packung
nicht. Explizit begrenzte Versuchszahlen, deaktivierte exakte Prüfung und Aufträge
mit nicht vorbereiteten Konturabständen verwenden weiterhin die Raster-Suche.

Vorbereitete Konturabstände sind bereits in der Geometrie enthalten. Der native
Solver verwendet zusätzlich 0,02 mm numerischen Sicherheitsabstand. Ein gepolsterter
rechteckiger Startzustand vermeidet ungültige Kontakte durch f32-Rundung.
Kann ein Teil deshalb nicht starten, etwa bei exakt voller Stoffbreite, bleibt
die bestehende Suche zuständig. Mehrere überlappende Außenkonturen werden
vereinigt. Nicht zusammenhängende Konturen werden konservativ durch ihre konvexe
Hülle eingeschlossen; kein Material wird weggelassen. Innere Löcher werden nicht
zum Einlegen weiterer Teile freigegeben. Die Rückübersetzung prüft Koordinaten,
Teilevollständigkeit, erlaubte Winkel und fehlende Spiegelung erneut.

### Weiteroptimieren und parallele Suche (ab 1.6.0)

In **Bounding-Einstellungen → Extreme Bounding – Konturen optimieren** können
maximal ein, zwei oder drei unabhängige Suchläufe gleichzeitig gewählt werden.
Voreinstellung sind zwei; auf Rechnern mit wenigen verfügbaren CPU-Kernen wird
die Anzahl zusätzlich begrenzt. Jeder Lauf verwendet einen anderen Zufallsstart,
alle teilen sich dieselbe Frist. Die Ergebnisse werden gemeinsam verglichen:
Nur eine vollständig geprüfte, kürzere Anordnung ersetzt das bisherige Ergebnis.
Mehr Suchläufe erhöhen die CPU-Last und garantieren keine Verbesserung bei jedem
Auftrag. Ein Suchlauf ist die sparsamere Einstellung.
Direkt an der Auswahl warnt der Editor vor höherer Prozessor- und
Arbeitsspeicherauslastung und empfiehlt für große Dateien oder wenig freien
Arbeitsspeicher **1 – sparsam**. Die CPU-Begrenzung ist keine RAM-Garantie;
der tatsächliche Speicherbedarf hängt von den Konturen und der Teilemenge ab.

**Weiter optimieren** startet eine neue Suche mit der aktuellen Anordnung. Diese
bleibt als geprüfte Ausgangslösung erhalten; die Stofflänge darf dadurch nicht
zunehmen. Passt die Anordnung nicht mehr zu den aktuellen Konturen, der
Teileauswahl, Stoffbreite oder erlaubten Drehungen, muss zuerst **Packen**
ausgeführt werden. Änderungen an Textfeldern starten weiterhin keine Suche.
Die Prüfung berücksichtigt die tatsächlichen Konturpunkte, damit auch
Außenlinienkorrekturen mit unveränderten Namen und Abmessungen erkannt werden.

Der native Solver übernimmt die Startlösung, wenn sie auch seine konservative
Geometrieprüfung einschließlich numerischem Abstand besteht. Andernfalls
startet er mit einer sicheren Rechteckanordnung; die übergebene bessere Lösung
bleibt trotzdem erhalten. Ein unerwartet beendeter Rechenworker kann seine
nativen Suchprozesse nicht weiterrechnen lassen: Ein eigener Watchdog beendet
sie bei ausbleibenden Lebenszeichen nach ungefähr drei Sekunden. Ein regulärer
Abbruch wartet weiterhin auf das Ende aller eigenen Suchprozesse.

Die neue Operation `pack-continue-v2` fordert beim Weiteroptimieren ein passendes
Modul an. Das native Paket und die V2-Editor-Komponente müssen aktualisiert werden.
Der portable Build bietet die vorhandene Suche ohne native Parallelität an.

### Vergleich mit den vorhandenen DXF-Dateien

1400 mm Stoffbreite, 0°/180°, keine Spiegelung, angeforderter Abstand 0 mm,
3-mm-Raster für die bisherige Suche, jeweils **30 Sekunden Suchbudget**:

| Datei | Teile | Bisher (mm) | Kontur-Nesting (mm) | Weniger Stoff |
| --- | ---: | ---: | ---: | ---: |
| EliHO | 105 | 14.102,0 | 13.399,0 | 4,99 % |
| HitJA | 116 | 12.381,8 | 12.090,2 | 2,36 % |
| NelaBL | 10 | 1.219,6 | 1.170,3 | 4,04 % |
| EuraKL | 16 | 1.575,8 | 1.502,8 | 4,63 % |
| PeratBL | 42 | 13.382,9 | 12.940,9 | 3,30 % |
| NoliLS | 42 | 10.101,4 | 9.272,2 | 8,21 % |

[Messwerte und Grenzen](benchmarks/nesting-2026-10-15.json): sechs angenommene
Beispiele, drei Dateien wegen auffälliger Außenlinien ausgeschlossen. Gleiches
Zeitbudget und feste Seeds entfernen keine Unterschiede durch Rechnerlast und
laufzeitbegrenzte Durchläufe. Vorversuche mit zehn Sekunden waren auf zwei großen
Aufträgen geringfügig schlechter; die UI beginnt bei 30 Sekunden. Das ist keine
Garantie auf Verbesserung für jeden Auftrag und kein Beweis eines globalen Optimums.

Den Vergleich ohne Server oder Änderung einer laufenden App wiederholen:

```bash
npm --prefix packages/dxf-desktop-module run benchmark:nesting -- --data=./__mock --seconds=30
```

Für jeden Auftrag werden isolierte Kopien desselben Moduls verwendet; die
Vergleichskopie enthält kein natives Solverprogramm und kein gelerntes Modell.
`--only=EliHO` beschränkt den Vergleich. Der Bericht enthält Stofflängen,
Laufzeiten und die Anzahl angenommener nativer Verbesserungen.

Explorativer Vergleich von 1.5.0 und 1.6.0 (gleiche Bedingungen wie oben,
je 30 Sekunden; Fortsetzung mit weiteren 30 Sekunden):

| Datei | 1.5, ein Suchprozess (mm) | 1.6, zwei Suchprozesse (mm) | Nach Weiteroptimieren (mm) |
| --- | ---: | ---: | ---: |
| NelaBL, 10 Teile | 1.170,17 | 1.170,15 | 1.170,15 |
| EliHO, 105 Teile | 13.465,18 | 13.479,64 | 13.245,74 |
| EuraKL, 16 Teile | 1.503,63 | 1.500,97 | 1.500,57 |

[Messwerte und Einschränkungen](benchmarks/continuation-1.6-2026-10-15.json).
Beim 105-Teile-Auftrag sparte die Fortsetzung weitere **233,90 mm (1,74 %)**.
Der erste parallele Lauf war dort geringfügig schlechter als 1.5. Ein nahezu
ausoptimiertes Beispiel wie Nela profitierte nicht mehr von der Fortsetzung.
Beim Eura-Fortsetzungslauf übernahmen beide nativen Suchprozesse die vorhandene
Startlösung. Diese kleine Stichprobe begründet keine allgemeine Qualitätsgarantie.

Versionen und Weiteroptimieren lassen sich ebenfalls vergleichen. Der
Baseline-Ordner muss ein zuvor gebautes, vollständiges Modulpaket enthalten:

```bash
npm --prefix packages/dxf-desktop-module run benchmark:nesting -- --data=./__mock --seconds=30 --workers=2 --baseline-module=/pfad/zum/modul-1.5 --continue-seconds=30
```

Dabei steht beiden Versionen dieselbe Laufzeit zur Verfügung; mehrere
Suchprozesse verbrauchen mehr CPU-Zeit. Der zusätzliche Fortsetzungslauf hat ein
eigenes Zeitbudget. Der Bericht enthält auch, ob der native Solver die
Startanordnung übernehmen konnte. Die Messung verändert keine installierten
Module und benötigt keinen Entwicklungsserver.

### Paket bauen

Der normale Build liefert die ausführbare Engine und ihre Lizenzdateien mit.
Er baut für das Betriebssystem und die Architektur des Buildrechners; andere
Plattformen benötigen jeweils einen eigenen Build. Rust >= 1.90 wird nur beim
Hersteller benötigt, sofern kein passender Buildcache vorhanden ist. `CARGO` kann
auf die Cargo-Datei zeigen. Die Abhängigkeiten sind in `native/sparrow/Cargo.lock`
festgelegt; die Herkunft des unveränderten Upstreamcodes steht in
`native/sparrow/SOURCE.md`. Lizenztexte und die unmodifizierten MPL-Quelldateien
werden unter `dist/licenses/nesting` mitgeliefert. `--portable` baut das bisherige
plattformunabhängige Raster-Paket ohne `pack-nesting-v2`.

```bash
npm --prefix packages/dxf-desktop-module run build
npm --prefix Animatus-Desktop run module:dxf:install
```

Nutzer installieren das fertige Modul in einem Schritt. Die Installation ist
weiterhin ohne Marktplatz und ohne Neustart des Modulregisters möglich.
Das Rechenmodul ersetzt keine serverseitig geladene Editor-Oberfläche. In älteren
V2-Oberflächen heißt derselbe Modus noch „Extreme Bounding – adaptive Suche“;
auch dessen `pack-extreme-v2` verwendet nach Modulinstallation die native Engine.
Die neue Beschriftung benötigt die aktualisierte Editor-Komponente. Änderungen
am Desktop-IPC selbst benötigen einen manuellen Neustart der Desktop-App.
Erwartete Abbrüche werden dort als `stopped` übertragen, damit Navigation und
geschlossene Einstellungsfenster keinen Berechnungsfehler im IPC auslösen.

## Berechnungsort in der Vorschau (V2, ab 1.7.1)

Die Bounding-Vorschau zeigt **Desktop-App** oder **Web / Browser** und das
aktuelle Rechenverfahren. Die native Kontursuche wird erst gemeldet, wenn der
Solver tatsächlich gestartet ist. Beim Übergang zur nativen Rastersuche,
WebAssembly-Rastersuche oder JavaScript wird die Anzeige aktualisiert. Auch die
Nachverdichtung läuft in JavaScript. Desktop-Ausführung allein bedeutet deshalb
nicht, dass jeder Rechenschritt nativ erfolgt.

Der Berechnungsort wird bereits vor dem ersten fertigen Durchlauf angezeigt.
Bei älteren Modulen bleibt die Ortsangabe verfügbar; für die genaue
Verfahrensanzeige müssen das Modul 1.7.1, der V2-Browserworker und die
Editor-Komponente aktualisiert werden. Es wird weder allein aus dem Vorhandensein
der Desktop-Brücke noch allein aus einer angeforderten Suchphase auf einen
laufenden nativen Solver geschlossen.

## Freie Suchdauer (V2, ab 1.7.0)

Die Suchdauer wird als freie Zahl in **Sekunden** eingegeben, zwischen 1 und
86.400 Sekunden (24 Stunden), z. B. 45, 90, 900 oder 3600. Bruchteile einer Sekunde
sind möglich. Speichern und erneutes Laden eines Layouts erhalten den gewählten
Wert. Die Zeit ist ein Suchbudget; erreichte Längenziele oder eine ausgeschöpfte
Suche können den Lauf früher beenden. Eine bereits laufende Suche übernimmt
keine nachträglichen Änderungen der Dauer.

Für Dauern über fünf Minuten fordert der Editor die Moduloperation
`pack-configured-v2` an. Sie unterstützt auch Weiteroptimieren und die optionale
Modellkombination. Modul, Browserworker und Editor-Komponente sind aktualisiert.
Die Desktop-App räumt langen V2-Suchen die gewünschte Dauer plus eine Minute für
Vorbereitung und Abschluss ein. Andere Modulaufträge behalten ihr bisheriges
Zeitlimit. **Die Desktop-App muss für diese Änderung manuell neu gestartet
werden.** Bereits laufende Server werden nicht neu gestartet.

## Bounding-Einstellungen (Editor V2, ab Modul 1.2.0)

„Bounding-Einstellungen …“ bündelt Modus, Suchdauer bzw. Durchläufe,
Rastergenauigkeit, Stoffbreite, erlaubte Rotationsschritte und eine optionale
maximale Stofflänge in einem Fenster. Gültige Eingaben der Stoffbreite werden
sofort mit der Seitenleiste synchronisiert; beim Abbrechen wird die ursprüngliche
Breite wiederhergestellt. Die übrigen Änderungen werden erst durch „Einstellungen
übernehmen“ angewendet. Real-/Extreme-Berechnungen starten anschließend über
„Packen“; Konturkorrekturen lösen weiterhin gezielt eine neue Packung aus.
Die zusätzlichen Einstellungen werden in Layout-JSONs gespeichert.
Die im Dialog übernommenen Bounding-Einstellungen werden außerdem lokal im
Browserprofil gespeichert und beim nächsten Öffnen des V2-Editors verwendet.
Das umfasst Modus, Suchdauer, parallele Suchläufe, Raster, Durchläufe,
Stoffbreite, Rotation und Längenziel einschließlich Abbruch am Ziel. Direkte
Änderungen von Breite, Rotation und Durchläufen in der Seitenleiste werden
mitgespeichert. Abgebrochene Dialogentwürfe ändern die gespeicherten Vorgaben
nicht. Explizite Einstellungen geladener Layouts bzw. Queue-Snapshots haben
Vorrang und überschreiben die Browser-Vorgaben nicht automatisch. Ein
wiederhergestellter Real-/Extreme-Modus startet keine aufwendige Suche beim
Dateiöffnen; dafür bleibt **Packen** zuständig. Ungültige gespeicherte Werte
werden ignoriert. Ein gesperrter Browserspeicher verhindert die Bedienung nicht.


Die maximale Stofflänge ist ein **Optimierungsziel**, keine Zusicherung und kein
Grund, gültige längere Ergebnisse zu verwerfen. Optional endet die Suche bereits,
wenn eine vollständige kollisionsfreie Anordnung die Vorgabe **unterschreitet**.
Bei unerreichbarer Vorgabe bleibt das kürzeste gefundene Ergebnis sichtbar; der
Editor zeigt, dass das Ziel noch nicht unterschritten ist. Die zum Auffüllen
verwendete Länge ist davon getrennt und heißt „Auffüllen bis“.

Als experimentelle Auswahl gibt es „Nester + RL4CO“. Der lokale
Prozessadapter führt beide installierten Inferenzprogramme aus: RL4CO liefert
Reihenfolgen, Nester vollständige Anordnungen. Die geprüften Vorschläge fließen
in dieselbe Suche und Bestenauswahl ein. Erlaubte Rotationen, Vollständigkeit,
Stoffbreite und exakte Kollisionen werden unabhängig vom Modell geprüft.

**Die Forschungsmodelle sind noch nicht als lauffähige Modellpakete integriert.**
Es werden keine Gewichte und keine fertig trainierten DXF-Modelle ausgeliefert.
Insbesondere liegt kein für diesen Packer trainiertes RL4CO-Modell vor. Die
Kombinationsauswahl bleibt gesperrt, solange die passenden, lauffähigen
Modellpakete fehlen oder deren Teilegrenze nicht ausreicht. Extreme Bounding
bleibt nutzbar. Der Paket- und Inferenzvertrag sowie die noch fehlenden Adapter
sind in [models/README.md](models/README.md) dokumentiert. Protokolltests mit
Testprogrammen belegen keine reale Modellqualität oder Einsatzbereitschaft.

`models-status-v2` prüft die Pakete ohne Installationsdialog. `pack-hybrid-v2`
fordert beide Modelle an; es gibt keinen stillen heuristischen Ersatz.
`pack-target-v2` verhindert, dass ältere Module das neue Längenziel ignorieren.

## Modelle gemeinsam mit dem Modul ausliefern (ab 1.3.0)

Für ein vorbereitetes Verzeichnis mit echten Gewichten, angepassten Adaptern,
Laufzeitbibliotheken und `models.json`:

```bash
npm --prefix packages/dxf-desktop-module run build -- --with-models --models=/absoluter/pfad/modellpaket
```

Der Build prüft beide mitkopierten Modellprogramme, bevor er `dist` ersetzt.
Fehlen die Artefakte oder eine mitgelieferte Laufzeit, schlägt er fehl; das letzte
fertige Paket bleibt erhalten. Native Pakete gelten nur für das angegebene
Betriebssystem und die Architektur. Nutzer installieren anschließend das gesamte
Modul in einem Schritt. Eine separate Modell- oder Python-Installation entfällt.
Der normale Build ohne Modellartefakte enthält weiterhin nur die geometrische
Suche und die vorbereiteten Modellschnittstellen. Ein eigenes experimentelles
Reihenfolgemodell kann separat mit `--order-model` mitgeliefert werden; siehe
[Trainingsanleitung](training/README.md).

Zum lokalen Installationstest kann derselbe Modellpfad an
`npm --prefix Animatus-Desktop run module:dxf:install -- --with-models --models=/absoluter/pfad/modellpaket`
übergeben werden. Diese Befehle erzeugen keine trainierten Gewichte.
Der Desktop-Marktplatz unterstützt jetzt gestreamte Modellpakete bis insgesamt
4 GiB. Nach Aktualisierung dieses Desktop-Installers muss die bestehende App
manuell neu gestartet werden.

Zusätzliche Prüfungen:

```bash
npm --prefix packages/dxf-editor-v2 run test:bounding-settings
```

## Extreme Bounding (Editor V2, ab Modul 1.1.0)

Im Editor unter „Packmodus“ → „Extreme Bounding“ wählen, die Suchdauer
(30 Sekunden, 2 oder 5 Minuten) einstellen und „Packen“ drücken. Normale
Feldänderungen starten keine Suche. Konturkorrekturen starten wie bei Real
Bounding anschließend eine neue Berechnung. Gespeicherte Layouts merken sich
Modus und Suchdauer; alte Layouts bleiben kompatibel.

Die Zielfunktion ist die benötigte Stofflänge bei festgelegter Stoffbreite und
unveränderter Teilemenge. Die Suche beginnt mit einer validierten Standardpackung,
prüft mehrere geometrisch sortierte Startreihenfolgen und verändert danach
Reihenfolgen aus einem Pool guter Ergebnisse (Vertauschen, Einfügen, Umkehren,
gelegentliche Neustarts). Bereits untersuchte Reihenfolgen werden übersprungen.
Rastervarianten werden einmal erstellt und wiederverwendet. Die erste
Polygonanordnung erhält die normale Verdichtung; weitere Kandidaten eine kurze
Verdichtung, damit mehr Reihenfolgen in das Budget passen. Zum Schluss wird das
beste Ergebnis bei verbleibender Zeit nochmals exakt verdichtet.

Konturen, erlaubte Rotationen und manuelle Rotationsvorgaben bleiben erhalten.
Nur vollständige, exakt auf Kollisionen geprüfte Kandidaten konkurrieren um das
Endergebnis. Es gibt keine Garantie auf ein globales Optimum. Die Suchdauer
schließt die Vorbereitung ein; ein bereits laufender Rasterdurchlauf wird noch
beendet und kann das Budget überschreiten. „Stop“ beendet den Worker und behält
im Editor das beste bereits vollständig übergebene Ergebnis. Die Ergebnisliste
speichert die 25 kürzesten Kandidaten, damit lange Suchen den Editor nicht mit
Geometriekopien füllen.

Die Operation `pack-extreme-v2` bleibt für bestehende Aufrufer verfügbar. Ab 1.5.0
fordert der aktualisierte V2-Editor `pack-nesting-v2` an. Ohne verfügbare lokale
Moduloperation führt der Browser-Worker die bisherige Raster- und
Reihenfolgensuche aus. V3 bekommt durch dieses Feature keinen neuen Packmodus.

Das Standardpaket enthält keine trainierten Gewichte. Seit 1.4.0 kann optional
ein eigenes Reihenfolgemodell trainiert und mitgeliefert werden; anschließend
nutzt es dieselbe geometrische Suche zur Prüfung und Verbesserung. Ein Forschungsbeispiel
für gelernte kombinatorische Heuristiken ist
[Neural Combinatorial Optimization with Reinforcement Learning](https://arxiv.org/abs/1611.09940).
Ein solches Modell ersetzt weder die geometrische Prüfung noch den Vergleich
an unabhängigen DXF-Dateien. Eine weitere Alternative wäre eine kontinuierliche
Platzierungssuche mit No-Fit-Polygonen; sie wäre ein eigener Geometriealgorithmus.

Lokale Prüfungen ohne Serverstart:

```bash
npm --prefix packages/dxf-editor-v2 run test:extreme-bounding
npm --prefix packages/dxf-editor-v2 run test:continuous-nesting
npm --prefix Animatus-Desktop run test:module:dxf
```

Die kleinen Regressionen prüfen Reihenfolgevielfalt, Erhalt aller Teile,
Kollisionen, das Behalten des besten Ergebnisses, Deadline und Abbruch. Die
Installationsprüfung führt zusätzlich die echte Operation im Desktop-Modul aus.
Die Beispielverbesserungen sind Regressionsergebnisse, keine allgemeine
Qualitätszusage für beliebige Schnitte.

Die App benötigt einmal die neue Desktop-Version mit `modules.streaming === 1`.
Danach erfordert das Hinzufügen des Moduls weder einen App-Neustart noch ein
Neuladen des Editors. Auch die aktualisierten Editor-Komponenten müssen einmal
über den gewohnten Build/Upload-Weg bereitgestellt werden. Diese Befehle führen
keinen Upload aus.

## Installation in der App testen, ohne Marktplatz

Aus dem Workspace-Verzeichnis:

```bash
cd Animatus-Desktop
npm run module:dxf:install
```

Der Befehl baut das Paket und öffnet die Installationsfrage in der laufenden
App. Falls keine App läuft, öffnet er Electron. Er startet keinen Webserver.
Nach Bestätigung kann ein bereits geöffneter, aktualisierter DXF Editor das
Modul beim nächsten Berechnungsauftrag verwenden. Bei einer anderen bereits installierten Version bietet die App nach
Bestätigung eine Aktualisierung an. Laufende Berechnungen dieses Moduls
müssen vorher beendet sein.

Alternativ `npm run module:dxf:build` ausführen und in der App unter
„Module & KI“ → „Modul hinzufügen“ den Ordner
`packages/dxf-desktop-module/dist` auswählen.

## Automatischer Installationstest

```bash
cd Animatus-Desktop
npm run test:module:dxf
```

Der Test baut ein echtes, eigenständiges Paket und installiert es in ein
isoliertes temporäres Verzeichnis. Er nutzt den regulären Paketierer,
Katalogresolver und Installer einschließlich SHA-256-Prüfungen. Die
Downloadantworten stammen aus lokalen Dateien; es wird kein Netzwerk-Listener
geöffnet und keine laufende App verändert. Anschließend werden V2/V3-Aufträge,
Fortschrittsmeldungen, verteilte Suchaufträge, Eigentümerprüfung, Abbruch,
Renderer-Anbindung und Browser-Fallback geprüft. Quelldateien des
Installationspakets werden vor der Berechnung entfernt, um die Unabhängigkeit
der installierten Kopie zu prüfen.

## Rechenkern und Zielsysteme

Der Standard-Build enthält den vorhandenen Rust/WASM-Rechenkern und führt ihn
lokal in einem Node-Worker der Desktop App aus. Damit ist das Paket ohne
zusätzliche Programme auf Windows, macOS und Linux installierbar. Es benötigt
weder einen lokalen HTTP-Dienst noch einen API-Schlüssel. Die Oberfläche wird
weiterhin vom System geladen; das Modul allein macht den Editor nicht offline.
Die eigenständige lokale KI-Platzierung von V3 bleibt ein separater Modus.

Für den nativen Rust-Prozess statt WASM:

```bash
cd Animatus-Desktop
npm run module:dxf:install -- --native
# oder nur bauen:
npm run module:dxf:build -- --native
```

Dieser Build benötigt Cargo auf dem Build-Rechner und enthält eine Binärdatei
für dessen Betriebssystem und Architektur. Der Installer prüft diese
Kompatibilität. Nutzer benötigen weder Rust noch Node auf ihrem Rechner.
Bei vorhandenem nativem Rechenkern verwendet das Modul ihn automatisch;
ansonsten Rust/WASM. Das berechnete Backend wird in der Warteschlange gemeldet.
Der DXF-Algorithmus behält seine vorhandenen JavaScript-Fallbacks bei.

Der Build verwendet die installierten Vite-/TypeScript-Abhängigkeiten der
DXF-Editor-Pakete. Im Modul sind danach alle JavaScript-/WASM-Abhängigkeiten
enthalten. Maximal zwei Desktop-Aufträge laufen gleichzeitig, mit 512 MB
JS-Heap pro Worker und zehn Minuten Gesamtlaufzeit. Bei Abbruch erhält das
Modul zuerst Gelegenheit, seinen nativen Prozess zu beenden; nach spätestens
500 ms wird sein Worker beendet. Native/WASM-Speicher fällt nicht vollständig
unter das JS-Heap-Limit.

## Veröffentlichung ohne eigenen Marktplatz

Ein HTTPS-Dateispeicher und ein kleiner JSON-Katalog reichen aus:

```bash
cd Animatus-Desktop
npm run module:package -- ../packages/dxf-desktop-module/dist https://example.org/modules/dxf/1.0.0/ ../packages/dxf-desktop-module/.temp/release
```

Die Dateien aus `.temp/release/files/` an die angegebene HTTPS-Adresse legen.
Den Inhalt von `catalog-entry.json` in die Liste `modules` eines Katalogs
aufnehmen. Der Systemkatalog liegt unter
`/.well-known/animatus/modules.json`; alternativ lässt sich der globale
HTTPS-Katalog in der App konfigurieren. Native Varianten benötigen eigene
Veröffentlichungsordner und passende Katalogeinträge je Zielsystem.

Beim ersten benötigten Modul fragt die App nach der Installation. Ablehnung,
fehlender Katalog oder Installationsfehler verwenden die bisherige
Browserberechnung. Nach einem Laufzeitfehler oder Abbruch wird ein Auftrag
nicht automatisch erneut im Browser gestartet. Lokale Module führen
vertrauenswürdigen Code mit den Rechten der Desktop App aus; der Worker ist
keine Betriebssystem-Sandbox.

## Korrektur für V2 Real Bounding (1.0.1)

Die Koordinaten der abschließenden Verdichtung werden nach der Rundung erneut
auf die Stoffkante begrenzt. Damit bleibt eine gültige Anordnung erhalten,
statt wegen einer geringfügigen Überschreitung mit „Keine Platzierung gefunden“
zu enden.

Mit der aktualisierten Desktop-App `npm run module:dxf:install` ausführen und
den Wechsel auf 1.0.1 bestätigen. Die vorherige Modulversion wird erst nach
Prüfung der neuen Dateien ersetzt. Während einer Berechnung desselben Moduls
ist die Aktualisierung gesperrt. V3 ist durch diese Geometriekorrektur nicht
verändert. Der normale Komponenten-/Worker-Build enthält dieselbe V2-Korrektur
für die Browserberechnung; beim Bereitstellen auch den Worker
`pack3-v3.worker.js` übernehmen.

## Build und Deployment im Modul-Package

Direkt im Package `dxf-desktop-module`:

| Betriebssystem | Nur bauen | Bauen und veröffentlichen |
| --- | --- | --- |
| macOS | `pnpm run build:mac` | `pnpm run deploy:mac` |
| Windows | `pnpm run build:win` | `pnpm run deploy:win` |
| Linux | `pnpm run build:linux` | `pnpm run deploy:linux` |

`pnpm run deploy` baut nativ für das aktuelle Betriebssystem und veröffentlicht
anschließend den frischen Build. Ein fehlgeschlagener Build stoppt vor dem Upload.
Native Builds laufen auf dem Zielbetriebssystem. Sie benötigen Node >=22.12,
Rust >=1.90, die Projektabhängigkeiten und die jeweiligen nativen Buildwerkzeuge;
auf dem Mac zusätzlich Xcode Command Line Tools. Andere Plattformvarianten bleiben
im Marktplatz erhalten. Dateien und veröffentlichte Prüfsummen werden kontrolliert.

Nur einen bereits vorbereiteten Stand veröffentlichen, ohne erneut zu bauen:

```sh
pnpm run publish
# Oder ein vorbereitetes Paket von einem anderen Rechner:
pnpm run publish -- --release=/pfad/zum/paketordner
```

Der Paketordner enthält `catalog-entry.json` und `files/`. Die Mac-Architektur wird
anhand der nativen Dateien geprüft. `deploy --release=…` wird abgewiesen, damit ein
Deploy nicht unbemerkt den Build überspringt.

Das Package ist eigenständig: Ein Checkout oder eine Kopie nur dieses Ordners
reicht aus. Es greift beim Build, Training, Testen und Paketieren nicht auf
Animatus-Desktop, dxf-editor-v2/v3 oder einen Modules-Checkout zu.

```sh
npm ci
npm run build:portable # V2/V3 mit dem mitgelieferten WASM-Kern, ohne Rust
npm test
# Vollständiges natives Paket auf dem jeweiligen Zielsystem:
npm run build:mac     # alternativ build:win oder build:linux
```

Node >=22.12 und die aus package-lock.json installierten npm-Pakete werden benötigt.
Für native Pakete kommen Rust >=1.90 sowie Compiler/Linker des Zielsystems hinzu.
Endnutzer benötigen diese Build-Werkzeuge nicht. Cargo lädt gegebenenfalls die in
Cargo.lock festgelegten Registry-Abhängigkeiten; „eigenständig“ bedeutet keinen
benachbarten Projekt-Checkout, nicht einen Build ohne Registry-Zugriff.

Die benötigten Editor-Quellen sind unter `vendor/` enthalten, die Modul-Protokoll-
und Paketierungswerkzeuge unter `sdk/`. `vendor/sources.json` hält die Prüfsummen
fest. Änderungen an diesen Quellen werden ausdrücklich in diesem Package geprüft
und mit einer neuen Package-Version veröffentlicht; benachbarte Editor-Änderungen
verändern einen Modulbuild nicht automatisch. Die Modulversion stammt aus package.json.

Für Deployment `.env.deploy.example` nach `.env.deploy` kopieren und ausfüllen.
Deployment liest lokal `.env.deploy` oder die mit `ANIMATUS_MARKETPLACE_ENV`
angegebene Datei. Benötigt werden MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD,
MYSQL_DATABASE=k229934_marketplace und GOOGLE_CLOUD_BUCKET_NAME=anim-marktplatz.
Google-Zugangsdaten kommen aus GOOGLE_APPLICATION_CREDENTIALS, einer lokalen
gcloud.json oder den üblichen Application Default Credentials. Für die Website-
Aktivierung sind zusätzlich WEBSITE_SALT und NEXTAUTH_SECRET nötig. Diese Dateien
sind ausgeschlossen und werden nicht in das Modulpaket übernommen. Es wurden keine
Zugangsdaten kopiert. Der Build selbst benötigt keine Deployment-Zugangsdaten.

`release:mac` bleibt als kombinierter Mac-Befehl erhalten. `--help` zeigt die
Optionen ohne Build oder Upload.
