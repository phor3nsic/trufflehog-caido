import { spawn } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import type { DefineAPI, SDK } from "caido:plugin";
import type { Request, Response } from "caido:utils";

let trufflehogPath = "/opt/homebrew/bin/trufflehog";
let onlyVerified = true;
const tmpdir = "/tmp/caido-responses";
const scanIntervalMs = 11_000;
const responseCacheTtlMs = 10 * 60 * 1000;
const responseCacheMax = 2_000;

let scanTimer: ReturnType<typeof setInterval> | null = null;
let scanInProgress = false;

type ResponseContext = {
  request: Request;
  response: Response;
  timestamp: number;
};

const responseCache = new Map<string, ResponseContext>();

const setBinaryPath = (sdk: SDK, path: string) => {
  trufflehogPath = path;
  sdk.console.log(`[TruffleHog] Binary path set to: ${path}`);
};

const setOnlyVerified = (sdk: SDK, value: boolean) => {
  onlyVerified = value;
  sdk.console.log(`[TruffleHog] only-verified set to: ${value}`);
};

export type API = DefineAPI<{
  setBinaryPath: typeof setBinaryPath;
  setOnlyVerified: typeof setOnlyVerified;
}>;

type URLLike = {
  hostname: string;
  port: string;
  pathname: string;
  search: string;
};

const parseUrl = (urlString: string): URLLike => {
  const urlCtor = (globalThis as { URL?: new (input: string) => URLLike }).URL;
  if (!urlCtor) {
    throw new Error("URL constructor not available");
  }
  return new urlCtor(urlString);
};

const sanitizeSegment = (value: string): string => {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized.length > 0 ? sanitized : "unknown";
};

const buildResponsePath = (urlString: string, responseId: string): string => {
  const responseKey = sanitizeSegment(responseId);
  try {
    const url = parseUrl(urlString);
    const host = url.port
      ? `${url.hostname}_${url.port}`
      : url.hostname;
    const segments = url.pathname
      .split("/")
      .filter(Boolean)
      .map(sanitizeSegment);
    const baseName = segments.pop() ?? "index";
    const query = url.search.slice(1);
    const safeQuery = query
      ? sanitizeSegment(query).slice(0, 120)
      : "";
    const fileName = `${baseName}${
      safeQuery ? `__q-${safeQuery}` : ""
    }__${responseKey}.txt`;
    return path.join(tmpdir, sanitizeSegment(host), ...segments, fileName);
  } catch {
    const fallback = sanitizeSegment(urlString).slice(0, 120);
    return path.join(
      tmpdir,
      "unknown",
      `${fallback}__${responseKey}.txt`
    );
  }
};

const rememberResponse = (request: Request, response: Response): void => {
  const responseId = response.getId();
  const responseKey = sanitizeSegment(responseId);
  const context: ResponseContext = {
    request,
    response,
    timestamp: Date.now(),
  };
  responseCache.set(responseId, context);
  responseCache.set(responseKey, context);
};

const pruneResponseCache = (): void => {
  const cutoff = Date.now() - responseCacheTtlMs;
  for (const [key, value] of responseCache.entries()) {
    if (value.timestamp < cutoff) {
      responseCache.delete(key);
    }
  }
  while (responseCache.size > responseCacheMax) {
    const oldestKey = responseCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    responseCache.delete(oldestKey);
  }
};

const writeResponseToDisk = async (
  request: Request,
  response: Response
): Promise<void> => {
  const raw = response.getRaw().toText();
  const filePath = buildResponsePath(request.getUrl(), response.getId());
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, raw);
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

const extractResponseIdFromFile = (filePathValue: string): string | null => {
  const base = path.basename(filePathValue);
  const marker = base.lastIndexOf("__");
  if (marker === -1) return null;
  const tail = base.slice(marker + 2);
  if (!tail.endsWith(".txt")) return null;
  return tail.slice(0, -4);
};

const redactValue = (value: string): string => {
  if (value.length <= 8) return "*****";
  return `${value.slice(0, 8)}*****`;
};

const buildEvidence = (result: TrufflehogResult): Record<string, unknown> => {
  const raw = result.RawV2 && result.Raw && result.RawV2.includes(result.Raw)
    ? result.RawV2
    : result.Raw ?? result.RawV2 ?? "";
  const redacted = result.Redacted ?? (raw ? redactValue(raw) : "");
  return {
    detector: result.DetectorName ?? "unknown",
    verified: result.Verified ?? false,
    redacted,
    rawLength: raw.length,
    decoder: result.DecoderName ?? "",
    extraData: result.ExtraData ?? null,
  };
};

const createFindingFromResult = async (
  sdk: SDK<API>,
  result: TrufflehogResult,
  rawJson?: string
): Promise<void> => {
  const filePathValue = result.SourceMetadata?.Data?.Filesystem?.file;
  if (!filePathValue) return;
  const responseId = extractResponseIdFromFile(filePathValue);
  if (!responseId) return;
  const context = responseCache.get(responseId);
  if (!context) return;

  const detector = result.DetectorName ?? "unknown";
  const line = result.SourceMetadata?.Data?.Filesystem?.line ?? 0;
  const verified = result.Verified === true;
  const descriptionLines = [
    "TruffleHog detected a potential secret in a passive HTTP response.",
    `Detector: ${detector}`,
    `Verified: ${verified ? "true" : "false"}`,
    `File: ${path.basename(filePathValue)}`,
    `Line: ${line}`,
  ];

  const evidence = buildEvidence(result);
  descriptionLines.push(`Evidence: ${JSON.stringify(evidence)}`);
  descriptionLines.push("Raw finding:");
  descriptionLines.push("```json");
  descriptionLines.push(rawJson ?? JSON.stringify(result, null, 2));
  descriptionLines.push("```");

  const dedupeKey = `${responseId}-${detector}-${line}`;
  await sdk.findings.create({
    title: `TruffleHog: ${detector}`,
    description: descriptionLines.join("\n"),
    reporter: "TruffleHog",
    dedupeKey,
    request: context.request,
  });
};

const runTrufflehogScan = (sdk: SDK<API>): void => {
  if (scanInProgress) {
    return;
  }

  scanInProgress = true;
  sdk.console.log("[TruffleHog] started scan by trufflehog");

  let stdoutBuffer = "";
  let stderrBuffer = "";

  const logTrufflehogLine = (line: string) => {
    if (line.length === 0) return;
    try {
      const payload = JSON.parse(line) as { level?: string; msg?: string };
      const level = (payload.level ?? "").toLowerCase();
      const message = payload.msg ?? line;
      if (level.includes("error")) {
        sdk.console.error(`[TruffleHog] ${message}`);
      } else {
        sdk.console.log(`[TruffleHog] ${message}`);
      }
    } catch {
      sdk.console.log(`[TruffleHog] ${line}`);
    }
  };

  const args = ["filesystem", tmpdir, "--json"];
  if (onlyVerified) {
    args.push("--only-verified");
  }

  const proc = spawn(trufflehogPath, args, {
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout?.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const json = JSON.parse(trimmed) as TrufflehogResult;
        void createFindingFromResult(sdk, json, trimmed);
      } catch {
        sdk.console.error("[TruffleHog] failed to parse result JSON");
      }
    }
  });

  proc.stderr?.on("data", (chunk) => {
    stderrBuffer += chunk.toString();
    const lines = stderrBuffer.split("\n");
    stderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      logTrufflehogLine(line.trim());
    }
  });

  proc.on("error", (err) => {
    sdk.console.error(`[TruffleHog] erro to start: ${err.message}`);
    scanInProgress = false;
  });

  proc.on("close", (code) => {
    if (stdoutBuffer.trim().length > 0) {
      const trimmed = stdoutBuffer.trim();
      try {
        const json = JSON.parse(trimmed) as TrufflehogResult;
        void createFindingFromResult(sdk, json, trimmed);
      } catch {
        sdk.console.error("[TruffleHog] failed to parse result JSON");
      }
    }
    if (stderrBuffer.trim().length > 0) {
      logTrufflehogLine(stderrBuffer.trim());
    }
    if (code !== 0) {
      sdk.console.error(`[TruffleHog] end with code ${code}`);
    }
    scanInProgress = false;
  });
};

export function init(sdk: SDK<API>) {
  sdk.api.register("setBinaryPath", setBinaryPath);
  sdk.api.register("setOnlyVerified", setOnlyVerified);

  fs.mkdir(tmpdir, { recursive: true })
    .catch((err) => sdk.console.error(`[TruffleHog] tmpdir erro: ${err}`));

  if (!scanTimer) {
    scanTimer = setInterval(() => runTrufflehogScan(sdk), scanIntervalMs);
  }

  sdk.events.onInterceptResponse(
    async (ctx: SDK<API>, request: Request, response: Response) => {
      try {
        rememberResponse(request, response);
        pruneResponseCache();
        await writeResponseToDisk(request, response);
      } catch (err) {
        ctx.console.error(`[TruffleHog] error to save response: ${err}`);
      }
    }
  );
}
