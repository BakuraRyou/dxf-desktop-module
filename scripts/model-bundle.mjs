import fs from 'node:fs';
import path from 'node:path';
import providers from '../src/model-providers.cjs';

/** Producer-side validation: users receive one complete module, not installers. */
export async function bundleModels({ source, output, required = false }) {
  const manifest = path.join(source, 'models.json');
  if (!fs.existsSync(manifest)) {
    if (required) throw new Error('Der Modell-Build benötigt models.json, echte Gewichte und gebündelte Inferenzlaufzeiten. Es wurden keine Modelle erzeugt.');
    return { included: false };
  }
  const root = fs.realpathSync(source);
  const config = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (config.schemaVersion !== 1 || !Array.isArray(config.models) || config.models.length !== 2
    || !['nester', 'rl4co'].every(id => config.models.some(model => model.id === id))) {
    throw new Error('Das Modellpaket muss Nester und RL4CO enthalten.');
  }
  const native = config.models.some(model => model.runtime !== 'node');
  if ((native && (!config.platform || !config.architecture))
    || (config.platform && config.platform !== process.platform)
    || (config.architecture && config.architecture !== process.arch)) {
    throw new Error('Gebündelte Modelllaufzeiten müssen zum Betriebssystem und Prozessor dieses Builds passen.');
  }
  if (config.models.some(model => !['node', 'python', 'bundled'].includes(model.runtime)
    || (model.runtime === 'python' && !model.interpreter))) {
    throw new Error('Das Modellpaket darf kein vom Nutzer installiertes Python voraussetzen. Bündele den Interpreter oder eine eigenständige Inferenzdatei.');
  }
  function verifyTree(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Das Modellpaket darf keine symbolischen Links enthalten.');
      if (entry.isDirectory()) verifyTree(filename);
      else if (!entry.isFile()) throw new Error('Nicht unterstützte Modellpaket-Datei.');
    }
  }
  verifyTree(root);
  const destination = path.join(output, 'models');
  fs.cpSync(root, destination, { recursive: true, errorOnExist: true, force: false });
  const status = await providers.inspectModels(output);
  await providers.waitForExit();
  if (!status.ready) throw new Error('Die mitgelieferten Modelle lassen sich aus dem Paket nicht laden. Prüfe Gewichte, Adapter und Laufzeiten.');
  return { included: true, platform: config.platform, architecture: config.architecture,
    models: status.models.map(model => ({ id: model.id, maxPieces: model.maxPieces })) };
}
