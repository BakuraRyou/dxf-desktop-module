# Modellpakete für die Kombination Nester + RL4CO

**Hier sind keine Gewichte, keine trainierten DXF-Modelle und keine fertigen
Nester-/RL4CO-Inferenzadapter enthalten.** Die Kombination ist ohne diese Dateien
nicht einsatzbereit. Die Bibliothek RL4CO allein und die öffentlichen Nester-
Checkpoints erfüllen den hier beschriebenen Vertrag nicht automatisch.
Insbesondere ist die veröffentlichte kleine Nester-Konfiguration kein Nachweis
für das Optimieren von 105 Teilen bei fester Stoffbreite.

Das lokale DXF-Modul enthält den Prozessadapter und die geometrische
Zusammenführung: Beide Programme müssen tatsächlich Modellinferenz ausführen.
RL4CO liefert Reihenfolgen, Nester vollständige Anordnungen. Anschließend prüft
der bestehende Packer die erlaubten Rotationen, Teilevollständigkeit, Stoffbreite
und exakte Überschneidungen. Gültige Anordnungen konkurrieren mit der Standard-
packung und den Kandidaten aus Extreme Bounding ausschließlich um kürzere Länge.
Fehlt ein Modell oder liefert es ungültige Ergebnisse, wird die Kombination
abgebrochen. Es gibt keinen als KI ausgegebenen Heuristik-Fallback.

## Paketaufbau

Ein vertrauenswürdiges Modellpaket installiert `models.json` und die beiden
Inferenzadapter samt Gewichten unter diesem Ordner. `models.example.json` zeigt
das Schema; dessen Dateinamen und Teilegrenzen sind **Beispiele**, keine
vorhandenen oder zugesicherten Modelle. `maxPieces` muss der tatsächlich
validierten Modellgrenze entsprechen. Das Buildskript kopiert diesen Ordner in
das installierbare Modul. Gewichte und Adapter daher vor dem Modulbuild ablegen.

Jeder Eintrag deklariert `task: fixed-width-strip-v1` und
`supportsRotationRestrictions: true`. Die Adapter müssen hierfür angepasst und
getestet sein. Eine allgemeine Bounding-Box-Belegungsmetrik genügt nicht als
Trainingsziel für feste Stoffbreite. Lizenzen der Gewichte, Daten und nativen
Abhängigkeiten müssen vor einer Weitergabe geklärt werden.

Seit Version 1.3.0 kann der Modulbuild die vollständige Laufzeit mitliefern:
`runtime: bundled` startet das mit `executable` angegebene Programm, optional mit
`entry` als Argument. Eine eigenständige ausführbare Inferenzanwendung muss ihre
Bibliotheken ebenfalls enthalten. Alternativ verwendet `runtime: python` einen
über `interpreter` mitgelieferten Interpreter samt seinen Bibliotheken und
`entry`; `runtime: node` verwendet die Node-Laufzeit der Desktop-App.
Alle angegebenen Pfade sind relativ zu diesem Modellordner. Native Pakete müssen
`platform` und `architecture` deklarieren und auf dem passenden System gebaut
werden. Das Beispiel verwendet Linux x64.

Der Produktionsbuild mit `--with-models` prüft beide Programme aus dem kopierten
Paket und lehnt Python ohne gebündelten Interpreter ab. Nur für die Entwicklung
unterstützt der Prozessadapter weiterhin Python aus `ANIMATUS_DXF_PYTHON` bzw.
dem Systempfad. Nutzer eines vollständigen Modulpakets brauchen weder Python
noch Gewichte separat zu installieren. Der Browser übergibt niemals Programme
oder Pfade. Absolute Pfade, Symlinks und fehlende Checkpoints werden beim
Paketieren abgewiesen. Eine erfolgreiche Statusprüfung bestätigt die Ladbarkeit,
nicht die Qualität der trainierten Modelle.

## Ein-/Ausgabe des Adapters

Eine JSON-Nachricht auf stdin, eine JSON-Antwort auf stdout; Diagnoseausgaben nur
auf stderr. Jeder Prozess endet nach seiner Antwort. Modellaufbau und
Checkpoint-Laden gehören zur Antwortzeit. Die Paketprüfung sendet:

```json
{"schemaVersion":1,"model":"nester","checkpoint":"/resolved/checkpoint.pt","action":"status"}
```

Nur wenn Checkpoint und Laufzeit wirklich geladen werden können, antworten mit:

```json
{"schemaVersion":1,"model":"nester","trained":true,"ready":true}
```

Vorhersage: `action: predict`, zusätzlich `input` mit `blocks`, `fabricWidth`,
`rotationStep`, optional `targetLengthMm` und `timeBudgetMs`. Konturkoordinaten
sind Millimeter. `block.rotationStepOverride` und `block.manualAngleOverride`
haben Vorrang vor dem globalen Rotationsschritt. Die `blocks` entsprechen exakt
den vorbereiteten Kollisions- und Zeichenkonturen des Packers.

RL4CO-Antwort, hier für zwei Schnittteile:

```json
{"schemaVersion":1,"model":"rl4co","trained":true,"orders":[[1,0],[0,1]]}
```

Nester-Antwort:

```json
{"schemaVersion":1,"model":"nester","trained":true,"layouts":[[
  {"blockIndex":0,"x":0,"y":0,"angle":0},
  {"blockIndex":1,"x":100,"y":0,"angle":180}
]]}
```

`x/y` sind die linke untere Ecke der gedrehten Kollisionsbounds, **keine** absolute
Translation der ursprünglichen DXF-Punkte. Jede Reihenfolge und Anordnung enthält
alle Blockindizes genau einmal. Grenzen: 128 Reihenfolgen, 32 Anordnungen, 4 MiB
Antwort. Nester muss mindestens eine vollständige Anordnung liefern, RL4CO
mindestens eine Reihenfolge. Die Programme werden nacheinander aufgerufen;
jeweils höchstens ein Viertel des Suchbudgets, maximal 30 Sekunden. Die
verbleibende Zeit geht an die geometrische Suche. Abbruch beendet die eigenen
Modellprozesse.

Die automatisierten Modulprüfungen verwenden ausdrücklich **Protokoll-Fixtures
ohne neuronales Netz**. Sie prüfen Anbindung und Validierung; sie belegen keine
Qualität oder Einsatzbereitschaft eines realen Nester-/RL4CO-Modells.
