# Automatisches Training für DXF-Reihenfolgen

Dieser Prototyp trainiert ein kleines neuronales Netz auf der CPU. Es bewertet
geometrische Merkmale der Teile und schlägt Reihenfolgen vor. REINFORCE bewertet
die Vorschläge anhand der tatsächlich berechneten Stofflänge. Das ist ein eigener
Animatus-Ansatz, keine Implementierung oder trainierte Version von RL4CO/Nester.
Python, CUDA und separate Modellinstallationen werden dafür nicht benötigt.
Die Entwicklungsabhängigkeiten des DXF Editors V2 müssen installiert sein.

## Starten

Im Workspace-Verzeichnis:

```bash
npm --prefix packages/dxf-desktop-module run train -- --data=/absoluter/pfad/dxf-dateien --gap=0 --output=/absoluter/pfad/trainingslauf
```

Der Befehl sucht rekursiv nach `.dxf`-Dateien, prüft sie und trainiert automatisch
zehn Epochen mit vier Packversuchen pro Trainingsauftrag und Epoche. Jeder
Packversuch enthält alle ausgewählten Teile. Vorgaben: **1400 mm Stoffbreite,
0°/180° Rotation, keine Spiegelung, 0 mm Mindestabstand**. Die Außenkanten dürfen
sich berühren; Überschneidungen werden exakt geprüft. `--gap` ist ausdrücklich
anzugeben und beschreibt den gesamten Abstand zwischen zwei Schnittteilen.
Intern erhält jede Kontur den halben Abstand. Namensbasierte Drehhinweise werden
im Training durch die festgelegten 0°/180° ersetzt. Zusätzliche Fadenlaufregeln
werden von diesem Trainingsprototyp noch nicht aus DXF-Dateien übernommen.

DXF-Koordinaten müssen Millimeter sein. Explizite andere `$INSUNITS` werden
abgewiesen, bei fehlender oder unbestimmter Einheit wird Millimeter angenommen
und diese Annahme im Datensatz vermerkt. Die Vorbereitung nutzt dieselben
Konturfunktionen wie Editor V2. Jeder erzeugte Drawable-Block zählt einmal;
standardmäßig werden **alle Größen** als ein Auftrag verwendet. Das ist kein
Import von Stücklisten, INSERT-Mengen oder Materialgruppen. Optional beschränkt
`--sizes=40,42` die Größen für den gesamten Lauf.

Zum Prüfen der Dateien ohne Training:

```bash
npm --prefix packages/dxf-desktop-module run train -- --data=./__mock --gap=0 --output=./dxf-training --prepare-only
```

Anschließend mit denselben Regeln und `--resume` das Training starten oder nach
einem Abbruch fortsetzen:

```bash
npm --prefix packages/dxf-desktop-module run train -- --data=./__mock --gap=0 --output=./dxf-training --resume
```

Ein exklusiver Lock verhindert gleichzeitige Läufe im selben Ausgabeordner.
Strg+C beendet den eigenen Berechnungsprozess. Nach jedem vollständigen
Trainingsauftrag werden die Gewichte atomar gespeichert; ein angefangener
Auftrag wird nach dem Fortsetzen erneut bearbeitet. Ein Rechnerabsturz kann
eine `.training.lock` hinterlassen; diese erst nach Prüfung auf laufende
Trainingsprozesse manuell entfernen. Änderungen an Dateien oder Trainingsregeln
erfordern einen neuen Ausgabeordner. Mit `--epochs=20 --resume` kann ein fertiger
Lauf mit identischen Regeln weitertrainiert werden.

## Datensatz und Bewertung

Identische Dateiinhalte werden dedupliziert. Rund 20 % der angenommenen Dateien
werden vor dem Training für die Bewertung reserviert und erhalten keine
Gewichtsupdates. Mindestens zwei unterschiedliche gültige Aufträge sind nötig.
Ähnliche Schnitte mit anderen Namen oder geringfügig veränderter Geometrie
erkennt diese Deduplizierung nicht: Für belastbare Ergebnisse müssen verschiedene
Schnittfamilien vertreten sein. Für die endgültige Qualitätsprüfung einen
zusätzlichen, unangetasteten Datensatz zurückhalten. Die interne Bewertung wird
zur Checkpoint-Auswahl verwendet und ist daher kein unabhängiger Abschlusstest.

Defekte bzw. auffällige Konturen und nicht passende Teile werden in `dataset.json`
als abgelehnt aufgeführt. Die Eingabedateien werden nicht verändert und Konturen
nicht automatisch repariert. Nach Korrektur einen neuen Lauf vorbereiten.
Ein Fehler oder Zeitlimit während Training/Bewertung beendet den Lauf, statt
betroffene Aufträge unbemerkt aus der Bewertung zu entfernen.

Der Bericht vergleicht pro Bewertungsdatei fünf Modellvorschläge mit fünf festen
Heuristiken unter denselben Raster- und Verdichtungseinstellungen. Dies ist
**noch kein Vergleich gegen die komplette adaptive Extreme-Suche bei gleichem
Zeitbudget**. Ein schlechterer Wert ist möglich und wird unverändert berichtet.
Ein trainierter Checkpoint allein belegt keine Verbesserung. Die Verdichtung ist
zeitbegrenzt, weshalb trotz fester Zufallsseeds kleine Laufzeitunterschiede
abweichende Bewertungen ergeben können.

## Ergebnisse

- `dataset.json`: angenommene und abgelehnte Dateien, Duplikate, Aufteilung, Regeln.
- `prepared/`: vorbereitete Konturen und Merkmale für jeden angenommenen Auftrag.
- `latest.json`: fortsetzbarer Trainingsstand, Epoche und nächster Auftrag.
- `best-model.json`: trainierte Gewichte mit dem bisher kürzesten Gesamtergebnis
  auf der internen Bewertung, inklusive Vergleichswerten.
- `report.json`: Bewertungen abgeschlossener Epochen.

## Optional im Desktop-Modul ausprobieren

```bash
npm --prefix packages/dxf-desktop-module run build -- --order-model=/absoluter/pfad/trainingslauf/best-model.json
```

Das Paket enthält die Gewichte und die Inferenzfunktion. Nach Installation
verwendet **die adaptive Extreme-Suche in V2** fünf Modellvorschläge zusätzlich zu
ihrer bisherigen Suche. Das gilt bei passender Stoffbreite, 180°-Rotationsschritt
und höchstens so vielen Teilen wie im vorbereiteten Datensatz. Jede Anordnung
wird weiterhin geometrisch geprüft und konkurriert mit der vorhandenen
Standardpackung. Die trainierte Reihenfolge ändert keine Packregeln. Die
Nester-/RL4CO-Auswahl bleibt davon getrennt und wird dadurch nicht freigeschaltet.
Das Modell ist ausdrücklich experimentell; der Build aktiviert es nur mit
`--order-model`. Ohne diese Option bleibt das Paket ohne Reihenfolgemodell.

Installation ohne Marktplatz testen:

```bash
npm --prefix Animatus-Desktop run module:dxf:install -- --order-model=/absoluter/pfad/trainingslauf/best-model.json
```

## Weitere Optionen und Laufzeit

`--help` zeigt alle Optionen. `--width`, `--grid` (2–20 mm), `--samples` (2–32),
`--seed`, `--learning-rate`, `--compaction-ms` und `--timeout-seconds` erlauben
kontrollierte Versuche. Das Zeitlimit gilt pro Vorbereitungs-, Trainings- oder
Bewertungsauftrag, standardmäßig 120 Sekunden. Größere Aufträge können ein höheres
Limit brauchen. 500 Dateien mit zehn Epochen und vier Stichproben ergeben bei
80/20-Aufteilung ungefähr 16.000 Trainingspackungen plus 10.000
Bewertungspackungen. Die Laufzeit hängt deshalb stark von Teilezahl, Konturen,
Raster und Rechner ab. Es läuft jeweils nur ein Berechnungsprozess.
