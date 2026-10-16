import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PolyRasterBackend } from "../frontend/components/dxf-editor-v2/editor/types.ts";
import {
  decodeRasterPackingOutput,
  encodeRasterPackingInput,
} from "../frontend/lib/raster-packing-codec.ts";

let activeProcess: ChildProcessWithoutNullStreams | null = null;

const executableCandidates = () => {
  const executableName = process.platform === "win32" ? "dxf-raster-packer.exe" : "dxf-raster-packer";
  const besideWorker = fileURLToPath(
    new URL(`./${executableName}`, import.meta.url),
  );
  const developmentBuild = fileURLToPath(
    new URL(`./${executableName}`, import.meta.url),
  );
  const unpackedBesideWorker = besideWorker.replace(
    /app\.asar([\\/])/i,
    "app.asar.unpacked$1",
  );
  const candidates = [
    process.env.DXF_RUST_PACKER_PATH,
    unpackedBesideWorker,
    besideWorker,
    developmentBuild,
  ].filter(Boolean) as string[];
  const resourcesPath = (
    process as NodeJS.Process & { resourcesPath?: string }
  ).resourcesPath;
  if (resourcesPath) {
    candidates.push(
      path.join(
        resourcesPath,
        "app.asar.unpacked",
        "dist",
        executableName,
      ),
    );
  }
  return Array.from(new Set(candidates));
};

const resolveExecutable = () =>
  executableCandidates().find((candidate) => existsSync(candidate)) || "";

export const cancelRustRasterPacking = () => {
  if (!activeProcess) return;
  activeProcess.kill();
  activeProcess = null;
};

export const rustNativeRasterBackend: PolyRasterBackend = async (input) => {
  const executable = resolveExecutable();
  if (!executable) {
    throw new Error("Rust packing executable is missing");
  }
  const payload = encodeRasterPackingInput(input);
  const startedAt = performance.now();

  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    activeProcess = child;
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (activeProcess === child) activeProcess = null;
      if (code !== 0) {
        reject(
          new Error(
            Buffer.concat(errors).toString("utf8").trim() ||
              `Rust packing process exited with code ${code}`,
          ),
        );
        return;
      }
      try {
        const bytes = Buffer.concat(output);
        resolve(
          decodeRasterPackingOutput(
            new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
            "rust-native",
            performance.now() - startedAt,
          ),
        );
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.on("error", reject);
    child.stdin.end(payload);
  });
};
