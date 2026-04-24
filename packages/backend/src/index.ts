import { spawn } from "child_process";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import type { DefineAPI, SDK } from "caido:plugin";
import type { Request, Response } from "caido:utils";

type Settings = {
  binaryPath: string;
  onlyVerified: boolean;
};

type ResponseContext = {
  request: Request;
  timestamp: number;
};

type Stats = {
  binaryOk: boolean;
  binaryVersion: string;
  binaryError: string;
  lastScanAt: number | undefined;
  lastScanFiles: number;
  totalFindings: number;
  pendingFiles: number;
  scanning: boolean;
  settings: Settings;
};

type VerifyResult = {
  ok: boolean;
  version: string;
  error: string;
};

type TrufflehogResult = {
  DetectorName?: string;
  DetectorDescription?: string;
  DecoderName?: string;
  Verified?: boolean;
  Raw?: string;
  RawV2?: string;
  Redacted?: string;
  ExtraData?: unknown;
  SourceMetadata?: {
    Data?: {
      Filesystem?: {
        file?: string;
        line?: number;
      };
    };
  };
};

const DEFAULTS: Settings = {
  binaryPath: "trufflehog",
  onlyVerified: true,
};

const SCAN_INTERVAL_MS = 11_000;
const RESPONSE_CACHE_TTL_MS = 15 * 60 * 1000;
const RESPONSE_CACHE_MAX = 5_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const BINARY_TIMEOUT_MS = 10_000;

const rootDir = path.join(os.tmpdir(), "trufflehog-caido");
const pendingDir = path.join(rootDir, "pending");
const settingsFile = path.join(
  os.homedir(),
  ".config",
  "trufflehog-caido",
  "settings.json",
);

const settings: Settings = { ...DEFAULTS };
const responseCache = new Map<string, ResponseContext>();

let scanTimer: ReturnType<typeof setInterval> | undefined;
let scanInProgress = false;
let binaryOk = false;
let binaryVersion = "";
let binaryError = "";
let lastScanAt: number | undefined;
let lastScanFiles = 0;
let totalFindings = 0;

const sanitizeId = (value: string): string => {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "unknown";
};

const redactValue = (value: string): string => {
  if (value.length <= 8) return "*****";
  return `${value.slice(0, 8)}*****`;
};

const extractResponseIdFromFile = (filePath: string): string | undefined => {
  const base = path.basename(filePath);
  const match = /__([a-zA-Z0-9._-]+)\.txt$/.exec(base);
  if (match && match[1] !== undefined && match[1].length > 0) {
    return match[1];
  }
  return undefined;
};

const loadSettings = async (sdk: SDK<API>): Promise<void> => {
  try {
    const raw = await fs.readFile(settingsFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<Settings>;
    if (typeof parsed.binaryPath === "string" && parsed.binaryPath.trim()) {
      settings.binaryPath = parsed.binaryPath.trim();
    }
    if (typeof parsed.onlyVerified === "boolean") {
      settings.onlyVerified = parsed.onlyVerified;
    }
    sdk.console.log(`[TruffleHog] settings loaded from ${settingsFile}`);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT") {
      sdk.console.error(`[TruffleHog] failed to load settings: ${String(err)}`);
    }
  }
};

const persistSettings = async (sdk: SDK<API>): Promise<void> => {
  try {
    await fs.mkdir(path.dirname(settingsFile), { recursive: true });
    await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2));
  } catch (err) {
    sdk.console.error(`[TruffleHog] failed to save settings: ${String(err)}`);
  }
};

const runBinary = (
  binaryPath: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> => {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(binaryPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(err as Error);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`binary timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
};

const verifyBinaryInternal = async (sdk: SDK<API>): Promise<VerifyResult> => {
  try {
    const result = await runBinary(
      settings.binaryPath,
      ["--version"],
      BINARY_TIMEOUT_MS,
    );
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    const firstLine = combined.split("\n")[0]?.trim() ?? "";
    const match =
      /trufflehog\s+([\w.\-+]+)/i.exec(combined) ??
      /(\d+\.\d+\.\d+[\w.\-+]*)/.exec(combined);
    const version =
      match && match[1] !== undefined && match[1].length > 0
        ? match[1]
        : firstLine;
    if (result.code === 0 || version.length > 0) {
      binaryOk = true;
      binaryVersion = version;
      binaryError = "";
      sdk.console.log(`[TruffleHog] binary verified: ${version}`);
      return { ok: true, version, error: "" };
    }
    binaryOk = false;
    binaryVersion = "";
    binaryError = combined || `exit code ${result.code}`;
    return { ok: false, version: "", error: binaryError };
  } catch (err) {
    binaryOk = false;
    binaryVersion = "";
    binaryError = String(err);
    return { ok: false, version: "", error: binaryError };
  }
};

const setBinaryPath = async (
  sdk: SDK<API>,
  binaryPath: string,
): Promise<VerifyResult> => {
  const trimmed = binaryPath.trim();
  if (!trimmed) {
    binaryOk = false;
    binaryError = "empty path";
    return { ok: false, version: "", error: "empty path" };
  }
  settings.binaryPath = trimmed;
  await persistSettings(sdk);
  return verifyBinaryInternal(sdk);
};

const setOnlyVerified = async (
  sdk: SDK<API>,
  value: boolean,
): Promise<void> => {
  settings.onlyVerified = value;
  await persistSettings(sdk);
  sdk.console.log(`[TruffleHog] only-verified set to: ${value}`);
};

const getSettings = (_sdk: SDK<API>): Settings => ({ ...settings });

const getStats = async (_sdk: SDK<API>): Promise<Stats> => {
  let pendingFiles = 0;
  try {
    const entries = await fs.readdir(pendingDir);
    pendingFiles = entries.length;
  } catch {
    /* dir may not exist yet */
  }
  return {
    binaryOk,
    binaryVersion,
    binaryError,
    lastScanAt,
    lastScanFiles,
    totalFindings,
    pendingFiles,
    scanning: scanInProgress,
    settings: { ...settings },
  };
};

const verifyBinary = async (sdk: SDK<API>): Promise<VerifyResult> =>
  verifyBinaryInternal(sdk);

export type API = DefineAPI<{
  setBinaryPath: typeof setBinaryPath;
  setOnlyVerified: typeof setOnlyVerified;
  getSettings: typeof getSettings;
  getStats: typeof getStats;
  verifyBinary: typeof verifyBinary;
}>;

const rememberResponse = (request: Request, response: Response): void => {
  const responseId = sanitizeId(response.getId());
  responseCache.set(responseId, {
    request,
    timestamp: Date.now(),
  });
};

const pruneCache = (): void => {
  const cutoff = Date.now() - RESPONSE_CACHE_TTL_MS;
  for (const [key, value] of responseCache.entries()) {
    if (value.timestamp < cutoff) {
      responseCache.delete(key);
    }
  }
  while (responseCache.size > RESPONSE_CACHE_MAX) {
    const first = responseCache.keys().next().value as string | undefined;
    if (first === undefined) break;
    responseCache.delete(first);
  }
};

const writeResponseToDisk = async (
  request: Request,
  response: Response,
): Promise<void> => {
  const responseId = sanitizeId(response.getId());
  const fileName = `${Date.now()}__${responseId}.txt`;
  const filePath = path.join(pendingDir, fileName);
  let raw = response.getRaw().toText();
  if (raw.length > MAX_RESPONSE_BYTES) {
    raw = raw.slice(0, MAX_RESPONSE_BYTES);
  }
  await fs.mkdir(pendingDir, { recursive: true });
  await fs.writeFile(filePath, raw);
  rememberResponse(request, response);
};

const buildDescription = (
  result: TrufflehogResult,
  rawJson: string,
  redacted: string,
): string => {
  const detector = result.DetectorName ?? "unknown";
  const line = result.SourceMetadata?.Data?.Filesystem?.line ?? 0;
  const verified = result.Verified === true;
  return [
    "TruffleHog detected a potential secret in a passive HTTP response.",
    "",
    `- Detector: ${detector}`,
    `- Verified: ${verified}`,
    `- Decoder: ${result.DecoderName ?? ""}`,
    `- Redacted: ${redacted}`,
    `- Line: ${line}`,
    "",
    "Raw finding:",
    "```json",
    rawJson,
    "```",
  ].join("\n");
};

const createFindingFromResult = async (
  sdk: SDK<API>,
  result: TrufflehogResult,
  rawJson: string,
): Promise<void> => {
  const filePathValue = result.SourceMetadata?.Data?.Filesystem?.file;
  if (filePathValue === undefined || filePathValue.length === 0) return;
  const responseId = extractResponseIdFromFile(filePathValue);
  if (responseId === undefined) return;
  const context = responseCache.get(responseId);
  if (context === undefined) return;

  const detector = result.DetectorName ?? "unknown";
  const line = result.SourceMetadata?.Data?.Filesystem?.line ?? 0;
  const verified = result.Verified === true;
  const raw = result.RawV2 ?? result.Raw ?? "";
  const redacted = result.Redacted ?? (raw ? redactValue(raw) : "");
  const description = buildDescription(result, rawJson, redacted);
  const dedupeKey = `${responseId}-${detector}-${line}-${redacted}`;

  try {
    await sdk.findings.create({
      title: `TruffleHog: ${detector}${verified ? " (verified)" : ""}`,
      description,
      reporter: "TruffleHog",
      dedupeKey,
      request: context.request,
    });
    totalFindings += 1;
  } catch (err) {
    sdk.console.error(`[TruffleHog] finding create failed: ${String(err)}`);
  }
};

const runTrufflehogScan = async (sdk: SDK<API>): Promise<void> => {
  if (scanInProgress) return;
  if (!binaryOk) return;

  let snapshot: string[] = [];
  try {
    const entries = await fs.readdir(pendingDir);
    snapshot = entries.slice();
  } catch {
    return;
  }
  if (snapshot.length === 0) return;

  scanInProgress = true;

  const fileCount = snapshot.length;
  sdk.console.log(`[TruffleHog] scanning ${fileCount} file(s)`);

  const args = ["filesystem", pendingDir, "--json", "--no-update"];
  if (settings.onlyVerified) {
    args.push("--only-verified");
  }

  const cleanupSnapshot = async () => {
    await Promise.all(
      snapshot.map((name) =>
        fs.rm(path.join(pendingDir, name), { force: true }).catch(() => {
          /* ignore */
        }),
      ),
    );
  };

  let proc;
  try {
    proc = spawn(settings.binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    sdk.console.error(`[TruffleHog] failed to spawn binary: ${String(err)}`);
    await cleanupSnapshot();
    scanInProgress = false;
    return;
  }

  let stdoutBuf = "";
  let stderrBuf = "";

  const processStdoutLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const json = JSON.parse(trimmed) as TrufflehogResult;
      void createFindingFromResult(sdk, json, trimmed);
    } catch {
      /* non-JSON stdout line: ignore */
    }
  };

  const processStderrLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const payload = JSON.parse(trimmed) as {
        level?: string;
        msg?: string;
      };
      const level = (payload.level ?? "").toLowerCase();
      const msg = payload.msg ?? trimmed;
      if (level === "error" || level === "fatal") {
        sdk.console.error(`[TruffleHog] ${msg}`);
      }
    } catch {
      /* drop non-JSON stderr noise */
    }
  };

  proc.stdout?.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() ?? "";
    for (const line of lines) processStdoutLine(line);
  });

  proc.stderr?.on("data", (chunk) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split("\n");
    stderrBuf = lines.pop() ?? "";
    for (const line of lines) processStderrLine(line);
  });

  proc.on("error", async (err) => {
    sdk.console.error(`[TruffleHog] scan start failed: ${err.message}`);
    await cleanupSnapshot();
    scanInProgress = false;
  });

  proc.on("close", async (code) => {
    if (stdoutBuf.trim()) processStdoutLine(stdoutBuf);
    if (stderrBuf.trim()) processStderrLine(stderrBuf);
    if (code !== 0 && code !== null) {
      sdk.console.error(`[TruffleHog] scan ended with code ${code}`);
    }
    await cleanupSnapshot();
    lastScanAt = Date.now();
    lastScanFiles = fileCount;
    scanInProgress = false;
    pruneCache();
  });
};

export function init(sdk: SDK<API>) {
  sdk.api.register("setBinaryPath", setBinaryPath);
  sdk.api.register("setOnlyVerified", setOnlyVerified);
  sdk.api.register("getSettings", getSettings);
  sdk.api.register("getStats", getStats);
  sdk.api.register("verifyBinary", verifyBinary);

  void (async () => {
    await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {
      /* ignore */
    });
    await fs.mkdir(pendingDir, { recursive: true }).catch((err) => {
      sdk.console.error(`[TruffleHog] mkdir pending failed: ${err}`);
    });
    await loadSettings(sdk);
    await verifyBinaryInternal(sdk);
  })();

  if (!scanTimer) {
    scanTimer = setInterval(() => {
      void runTrufflehogScan(sdk);
    }, SCAN_INTERVAL_MS);
  }

  sdk.events.onInterceptResponse(
    async (ctx: SDK<API>, request: Request, response: Response) => {
      try {
        await writeResponseToDisk(request, response);
      } catch (err) {
        ctx.console.error(`[TruffleHog] error saving response: ${err}`);
      }
    },
  );
}
