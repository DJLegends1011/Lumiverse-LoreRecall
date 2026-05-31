declare const spindle: import("lumiverse-spindle-types").SpindleAPI;

// Client for the Obsidian "Local REST API" community plugin, reached through the
// Lumiverse host CORS proxy (spindle.cors, gated by the "cors_proxy" permission).
//
// The plugin exposes:
//   GET /                         -> server status (authenticated => includes vault info)
//   GET /vault/                   -> { files: string[] } for the vault root (dirs end with "/")
//   GET /vault/{dir}/             -> { files: string[] } for a subdirectory
//   GET /vault/{path}.md          -> note JSON when Accept: application/vnd.olrapi.note+json
//                                    => { path, tags, frontmatter, stat, content }
//
// spindle.cors() is typed `Promise<unknown>`, so every response is run through
// interpretCorsResponse() which copes with both "raw body string" and
// "{ status, body|data|json|text }" shapes.

export interface ObsidianConfig {
  baseUrl: string;
  apiKey: string;
  /** Optional vault subfolder to scope a walk to (no leading/trailing slashes). */
  subfolder: string;
}

export interface ObsidianNote {
  path: string;
  content: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
}

export interface ObsidianConnectionInfo {
  ok: boolean;
  authenticated: boolean;
  service: string;
  versions: string;
}

interface CorsResult {
  status: number;
  text: string;
  json: unknown;
}

export class ObsidianRequestError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ObsidianRequestError";
    this.status = status;
  }
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

/** Encode a vault-relative path for use in a URL while keeping the "/" separators. */
function encodeVaultPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Normalize the `unknown` returned by spindle.cors() into { status, text, json }.
 * Handles a raw string body, or an object carrying the body under one of several
 * common keys plus an optional numeric status. Falls back to treating the whole
 * object as the parsed JSON payload when no recognizable body field is present.
 */
export function interpretCorsResponse(raw: unknown): CorsResult {
  if (typeof raw === "string") {
    return { status: 200, text: raw, json: tryParseJson(raw) };
  }

  const record = asRecord(raw);
  if (!record) {
    // Arrays / numbers / booleans: treat as an already-parsed JSON payload.
    return { status: 200, text: JSON.stringify(raw ?? null), json: raw };
  }

  const status = typeof record.status === "number" ? record.status : 200;
  const bodyCandidate =
    record.body !== undefined
      ? record.body
      : record.data !== undefined
        ? record.data
        : record.text !== undefined
          ? record.text
          : record.content !== undefined
            ? record.content
            : undefined;

  if (typeof bodyCandidate === "string") {
    return { status, text: bodyCandidate, json: tryParseJson(bodyCandidate) };
  }
  if (bodyCandidate !== undefined) {
    return { status, text: JSON.stringify(bodyCandidate), json: bodyCandidate };
  }

  // No body field — assume the object itself is the decoded payload. Strip a
  // leading numeric "status" so callers reading the payload don't trip over it.
  const { status: _ignored, ...rest } = record;
  return { status, text: JSON.stringify(rest), json: rest };
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function describeErr(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Low-level transport. Prefers a direct fetch() because the Lumiverse CORS proxy
 * rejects loopback / private IPs (an SSRF guard) and Obsidian's Local REST API
 * only listens on 127.0.0.1. Falls back to spindle.cors() only when fetch is
 * unavailable or blocked (e.g. the macOS OS-sandbox).
 */
async function httpRequest(
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: string },
): Promise<CorsResult> {
  let fetchError: unknown = null;
  if (typeof fetch === "function") {
    try {
      const response = await fetch(url, { method: init.method ?? "GET", headers: init.headers, body: init.body });
      const text = await response.text();
      return { status: response.status, text, json: tryParseJson(text) };
    } catch (error) {
      // fetch is present but the request failed — could be the service being down
      // or the process being network-sandboxed. Try the host proxy as a last resort.
      fetchError = error;
    }
  }

  try {
    const raw = await spindle.cors(url, { method: init.method ?? "GET", headers: init.headers, body: init.body });
    return interpretCorsResponse(raw);
  } catch (corsError) {
    const detail = fetchError
      ? `direct connection failed (${describeErr(fetchError)}); the host CORS proxy also refused it (${describeErr(corsError)})`
      : describeErr(corsError);
    throw new ObsidianRequestError(
      `Could not reach Obsidian at ${url}: ${detail}. Make sure Obsidian is running on this machine with the ` +
        `"Local REST API" plugin enabled and that the base URL/port are correct (default http://127.0.0.1:27123).`,
      0,
    );
  }
}

async function request(
  cfg: ObsidianConfig,
  path: string,
  init?: { method?: string; accept?: string; body?: string },
): Promise<CorsResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiKey}`,
  };
  if (init?.accept) headers.Accept = init.accept;
  if (init?.body) headers["Content-Type"] = "application/json";

  const result = await httpRequest(joinUrl(cfg.baseUrl, path), { method: init?.method, headers, body: init?.body });
  if (result.status >= 400) {
    const hint = result.status === 401 ? " (check the Local REST API key)" : "";
    throw new ObsidianRequestError(`Obsidian request to ${path} failed with status ${result.status}${hint}.`, result.status);
  }
  return result;
}

export async function testConnection(cfg: ObsidianConfig): Promise<ObsidianConnectionInfo> {
  const url = joinUrl(cfg.baseUrl, "/");
  const result = await httpRequest(url, { method: "GET", headers: { Authorization: `Bearer ${cfg.apiKey}` } });
  spindle.log.info(`Lore Recall Obsidian ping status=${result.status}: ${truncateForLog(result.text)}`);

  if (result.status >= 400 && result.status !== 401) {
    throw new ObsidianRequestError(`Obsidian responded with status ${result.status}.`, result.status);
  }
  const payload = asRecord(result.json) ?? {};
  const authenticated = payload.authenticated === true;
  return {
    ok: true,
    authenticated,
    service: typeof payload.service === "string" ? payload.service : "Obsidian Local REST API",
    versions:
      payload.versions && typeof payload.versions === "object"
        ? JSON.stringify(payload.versions)
        : typeof payload.versions === "string"
          ? payload.versions
          : "",
  };
}

function readFileList(json: unknown): string[] {
  const record = asRecord(json);
  const files = record?.files;
  if (!Array.isArray(files)) return [];
  return files.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Recursively walk the vault (optionally scoped to cfg.subfolder) and return the
 * list of Markdown note paths, relative to the vault root.
 */
export async function walkVault(cfg: ObsidianConfig): Promise<string[]> {
  const root = cfg.subfolder ? `${cfg.subfolder.replace(/^\/+|\/+$/g, "")}/` : "";
  const notes: string[] = [];
  const seen = new Set<string>();

  async function walk(dir: string): Promise<void> {
    if (seen.has(dir)) return;
    seen.add(dir);
    const listPath = `/vault/${encodeVaultPath(dir)}`;
    const result = await request(cfg, listPath);
    for (const entry of readFileList(result.json)) {
      const full = `${dir}${entry}`;
      if (entry.endsWith("/")) {
        await walk(full);
      } else if (entry.toLowerCase().endsWith(".md")) {
        notes.push(full);
      }
    }
  }

  await walk(root);
  return notes;
}

export async function getNote(cfg: ObsidianConfig, path: string): Promise<ObsidianNote> {
  const result = await request(cfg, `/vault/${encodeVaultPath(path)}`, {
    accept: "application/vnd.olrapi.note+json",
  });
  const record = asRecord(result.json) ?? {};
  const tags = Array.isArray(record.tags) ? record.tags.filter((t): t is string => typeof t === "string") : [];
  return {
    path: typeof record.path === "string" ? record.path : path,
    content: stripFrontmatter(typeof record.content === "string" ? record.content : ""),
    tags,
    frontmatter: asRecord(record.frontmatter) ?? {},
  };
}

/**
 * Remove a leading YAML frontmatter block (a `---` … `---`/`...` fence at the very
 * start of the file). Tags and aliases are parsed from the API's structured
 * `frontmatter`/`tags` fields, so the entry body should be just the markdown.
 * Returns the original content unchanged if no well-formed frontmatter is present.
 */
export function stripFrontmatter(content: string): string {
  const text = content.replace(/^﻿/, "");
  const match = text.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  if (!match) return content;
  return text.slice(match[0].length).replace(/^[ \t\r\n]+/, "");
}

/**
 * Extract the link targets from `[[wikilinks]]`. Handles `[[Target]]`,
 * `[[Target|alias]]`, `[[Target#heading]]`, and `[[folder/Target]]`, returning
 * the bare note name (last path segment, heading/alias stripped).
 */
export function parseWikilinks(content: string): string[] {
  const targets: string[] = [];
  const seen = new Set<string>();
  const pattern = /\[\[([^\]]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const inner = match[1];
    if (!inner) continue;
    const beforeAlias = inner.split("|")[0] ?? "";
    const beforeHeading = beforeAlias.split("#")[0] ?? "";
    const segments = beforeHeading.split("/");
    const name = (segments[segments.length - 1] ?? "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(name);
  }
  return targets;
}

/**
 * Whether a note's tag set qualifies it as lore. The lore tag is a gate: an
 * empty filter matches nothing (a note must carry the tag to sync). A leading
 * "#" is ignored; nested child tags (e.g. "lore/character") match the parent
 * filter ("lore"). Case-insensitive. Exposed for reuse/testing.
 */
export function tagsMatchLoreFilter(tags: string[], loreTag: string): boolean {
  const target = loreTag.trim().replace(/^#/, "").toLowerCase();
  if (!target) return false;
  return tags.some((raw) => {
    const tag = raw.trim().replace(/^#/, "").toLowerCase();
    return tag === target || tag.startsWith(`${target}/`);
  });
}

function truncateForLog(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}
