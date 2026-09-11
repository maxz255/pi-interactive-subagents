/**
 * Terminal multiplexer surface layer for tmux and zellij.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: create/split a pane, type a command into it, read its screen, close
 * it, and poll for exit. Keeping the mux calls isolated here means index.ts
 * stays testable without a multiplexer running.
 *
 * Panes are identified by tmux pane ids (e.g. `%12`) or zellij pane ids
 * prefixed with `pane:` (e.g. `pane:7`).
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

// ── Availability ──

export type MuxBackend = "tmux" | "zellij";

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * True when running inside tmux with the tmux binary on PATH.
 * `TMUX` is set by tmux in every process it spawns (shell or pane).
 */
export function isTmuxAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

export function isZellijAvailable(): boolean {
  return !!(process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME) && hasCommand("zellij");
}

function muxPreference(): MuxBackend | null {
  const preference = (process.env.PI_SUBAGENT_MUX ?? "").trim().toLowerCase();
  return preference === "tmux" || preference === "zellij" ? preference : null;
}

export function getMuxBackend(): MuxBackend | null {
  const preference = muxPreference();
  if (preference === "tmux") return isTmuxAvailable() ? "tmux" : null;
  if (preference === "zellij") return isZellijAvailable() ? "zellij" : null;

  if (isTmuxAvailable()) return "tmux";
  if (isZellijAvailable()) return "zellij";
  return null;
}

export function isMuxAvailable(): boolean {
  return getMuxBackend() !== null;
}

export function muxSetupHint(): string {
  const preference = muxPreference();
  if (preference === "tmux") return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
  if (preference === "zellij") {
    return "Start pi inside zellij (`zellij --session pi`, then run `pi`).";
  }
  return "Start pi inside tmux (`tmux new -A -s pi 'pi'`) or zellij (`zellij --session pi`, then run `pi`).";
}

function requireMuxBackend(): MuxBackend {
  const backend = getMuxBackend();
  if (!backend) throw new Error(`No supported terminal multiplexer found. ${muxSetupHint()}`);
  return backend;
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function tailLines(text: string, lines: number): string {
  const split = text.split("\n");
  return split.length <= lines ? text : split.slice(-lines).join("\n");
}

function zellijPaneId(surface: string): string {
  return surface.startsWith("pane:") ? surface.slice("pane:".length) : surface;
}

function zellijEnv(surface?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (surface) env.ZELLIJ_PANE_ID = zellijPaneId(surface);
  return env;
}

const ZELLIJ_PANE_SCOPED_ACTIONS = new Set([
  "close-pane",
  "dump-screen",
  "rename-pane",
  "move-pane",
  "write",
  "write-chars",
  "send-keys",
]);

function zellijActionArgs(args: string[], surface?: string): string[] {
  if (!surface) return ["action", ...args];
  const action = args[0];
  if (!ZELLIJ_PANE_SCOPED_ACTIONS.has(action)) return ["action", ...args];
  if (args.includes("--pane-id") || args.includes("-p")) return ["action", ...args];
  return ["action", action, "--pane-id", zellijPaneId(surface), ...args.slice(1)];
}

function zellijActionSync(args: string[], surface?: string): string {
  return execFileSync("zellij", zellijActionArgs(args, surface), {
    encoding: "utf8",
    env: zellijEnv(surface),
  });
}

export const __muxTest__ = { zellijActionArgs };

// ── Pane layout ──

/**
 * tmux layout applied to the subagent window to keep panes evenly sized.
 * Switchable: "even-horizontal" (equal columns, matches Ctrl+b Alt+1),
 * "main-vertical" (big main pane + tiled column), "tiled" (grid).
 */
const SUBAGENT_TMUX_LAYOUT = "even-horizontal";

let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-balance subagent panes so repeated splits don't leave them lopsided.
 * tmux halves the target pane on every split and dumps freed space onto a
 * neighbor on close, so without this panes drift to wildly uneven widths.
 * Applies SUBAGENT_TMUX_LAYOUT to the parent pi window. Debounced so a burst
 * of parallel spawns or staggered exits collapses into a single layout call,
 * and non-fatal: a cosmetic resize must never break spawning or watching.
 */
function rebalanceSurfaces(hintPane?: string): void {
  // Prefer the parent pi pane (stable; survives a closing subagent pane).
  const target = process.env.TMUX_PANE ?? hintPane;
  if (!target) return;
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    try {
      // -t <pane> resolves to that pane's window; does not change focus.
      execFileSync("tmux", ["select-layout", "-t", target, SUBAGENT_TMUX_LAYOUT], {
        encoding: "utf8",
      });
    } catch {
      // Pane/window may be gone; balancing is best-effort.
    }
  }, 120);
}

// ── Zellij placement ──

const ZELLIJ_MIN_TERMINAL_WIDTH = 5;
const ZELLIJ_MIN_TERMINAL_HEIGHT = 5;
const ZELLIJ_CURSOR_HEIGHT_WIDTH_RATIO = 4;
const DEFAULT_ZELLIJ_SUBAGENT_MIN_COLUMNS = 50;
const DEFAULT_ZELLIJ_SUBAGENT_MIN_ROWS = 10;

export interface ZellijPaneSnapshot {
  id: number;
  is_plugin?: boolean;
  is_floating?: boolean;
  is_selectable?: boolean;
  exited?: boolean;
  pane_rows?: number;
  pane_columns?: number;
  tab_id?: number;
  is_focused?: boolean;
}

export type ZellijSplitDirection = "down" | "right";

export type ZellijPlacementPlan =
  | {
      mode: "split";
      anchorPaneId: number;
      targetPaneId: number;
      tabId: number;
      splitDirection: ZellijSplitDirection;
    }
  | { mode: "stack"; anchorPaneId: number; targetPaneId: number; tabId: number };

function paneArea(pane: ZellijPaneSnapshot): number {
  return (pane.pane_rows ?? 0) * (pane.pane_columns ?? 0);
}

function isUsableZellijTiledPane(pane: ZellijPaneSnapshot): boolean {
  return (
    !pane.is_plugin &&
    !pane.is_floating &&
    pane.is_selectable !== false &&
    !pane.exited &&
    typeof pane.pane_rows === "number" &&
    typeof pane.pane_columns === "number"
  );
}

export function predictZellijSplitDirection(pane: ZellijPaneSnapshot): ZellijSplitDirection | null {
  const columns = pane.pane_columns ?? 0;
  const rows = pane.pane_rows ?? 0;
  if (columns < ZELLIJ_MIN_TERMINAL_WIDTH || rows < ZELLIJ_MIN_TERMINAL_HEIGHT) return null;

  if (
    rows * ZELLIJ_CURSOR_HEIGHT_WIDTH_RATIO > columns &&
    rows > ZELLIJ_MIN_TERMINAL_HEIGHT * 2
  ) {
    return "down";
  }
  if (columns > ZELLIJ_MIN_TERMINAL_WIDTH * 2) return "right";
  return null;
}

export function canSplitZellijPane(
  pane: ZellijPaneSnapshot,
  minColumns = ZELLIJ_MIN_TERMINAL_WIDTH,
  minRows = ZELLIJ_MIN_TERMINAL_HEIGHT,
): boolean {
  const columns = pane.pane_columns ?? 0;
  const rows = pane.pane_rows ?? 0;
  const direction = predictZellijSplitDirection(pane);
  if (!direction) return false;
  if (direction === "down") return columns >= minColumns && Math.floor(rows / 2) >= minRows;
  return rows >= minRows && Math.floor(columns / 2) >= minColumns;
}

function zellijTabPanesForParent(
  panes: ZellijPaneSnapshot[],
  parentPaneId: number,
): { parentPane: ZellijPaneSnapshot; tabPanes: ZellijPaneSnapshot[] } | null {
  const parentPane = panes.find((pane) => !pane.is_plugin && pane.id === parentPaneId);
  if (!parentPane || typeof parentPane.tab_id !== "number") return null;
  const tabPanes = panes
    .filter((pane) => pane.tab_id === parentPane.tab_id)
    .filter(isUsableZellijTiledPane);
  return { parentPane, tabPanes };
}

export function selectZellijStackPlacement(
  panes: ZellijPaneSnapshot[],
  parentPaneId: number,
): ZellijPlacementPlan | null {
  const tabInfo = zellijTabPanesForParent(panes, parentPaneId);
  if (!tabInfo) return null;
  const stackTarget = tabInfo.tabPanes
    .filter((pane) => pane.id !== parentPaneId)
    .sort((a, b) => paneArea(b) - paneArea(a))[0];
  if (!stackTarget) return null;
  return {
    mode: "stack",
    anchorPaneId: stackTarget.id,
    targetPaneId: stackTarget.id,
    tabId: tabInfo.parentPane.tab_id!,
  };
}

export function selectZellijPlacement(
  panes: ZellijPaneSnapshot[],
  parentPaneId: number,
  minColumns = DEFAULT_ZELLIJ_SUBAGENT_MIN_COLUMNS,
  minRows = DEFAULT_ZELLIJ_SUBAGENT_MIN_ROWS,
): ZellijPlacementPlan | null {
  const tabInfo = zellijTabPanesForParent(panes, parentPaneId);
  if (!tabInfo) return null;

  const splitCandidates = tabInfo.tabPanes
    .map((pane) => ({ pane, splitDirection: predictZellijSplitDirection(pane) }))
    .filter(
      (candidate): candidate is { pane: ZellijPaneSnapshot; splitDirection: ZellijSplitDirection } =>
        candidate.splitDirection !== null && canSplitZellijPane(candidate.pane),
    );
  const safeCandidates = splitCandidates.filter((candidate) =>
    canSplitZellijPane(candidate.pane, minColumns, minRows),
  );

  // Zellij's tab-scoped new-pane chooses the concrete pane, so every possible
  // candidate must be large enough before we allow another tiled split.
  if (splitCandidates.length > 0 && safeCandidates.length === splitCandidates.length) {
    const target = safeCandidates.sort((a, b) => paneArea(b.pane) - paneArea(a.pane))[0];
    return {
      mode: "split",
      anchorPaneId: target.pane.id,
      targetPaneId: target.pane.id,
      tabId: tabInfo.parentPane.tab_id!,
      splitDirection: target.splitDirection,
    };
  }
  return selectZellijStackPlacement(panes, parentPaneId);
}

function parseZellijPaneSurface(rawId: string, context: string): string {
  const match = rawId.match(/(\d+)/);
  if (!match) throw new Error(`Unexpected zellij pane id from ${context}: ${rawId || "(empty)"}`);
  return `pane:${match[1]}`;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function readZellijPanes(): ZellijPaneSnapshot[] {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const output = zellijActionSync(["list-panes", "--json", "--geometry", "--state", "--tab"]);
      const parsed = JSON.parse(output);
      if (!Array.isArray(parsed)) throw new Error("Unexpected zellij list-panes output");
      return parsed as ZellijPaneSnapshot[];
    } catch (error) {
      lastError = error;
      if (attempt < 2) sleepSync(50);
    }
  }
  throw lastError;
}

function createZellijTiledPane(name: string, tabId: number): string {
  const output = zellijActionSync([
    "new-pane",
    "--tab-id",
    String(tabId),
    "--name",
    name,
    "--cwd",
    process.cwd(),
  ]);
  return parseZellijPaneSurface(output.trim(), "new-pane");
}

function createZellijStackedPane(name: string, anchorSurface: string): string {
  const output = zellijActionSync(
    ["new-pane", "--stacked", "--near-current-pane", "--name", name, "--cwd", process.cwd()],
    anchorSurface,
  );
  return parseZellijPaneSurface(output.trim(), "new-pane --stacked");
}

function createZellijTab(name: string): string {
  const rawTabId = zellijActionSync(["new-tab", "--name", name, "--cwd", process.cwd()]).trim();
  const tabId = Number(rawTabId);
  if (!Number.isInteger(tabId)) {
    throw new Error(`Unexpected zellij tab id from new-tab: ${rawTabId || "(empty)"}`);
  }
  try {
    const pane = readZellijPanes().find(
      (candidate) =>
        candidate.tab_id === tabId &&
        isUsableZellijTiledPane(candidate) &&
        typeof candidate.id === "number",
    );
    if (!pane) throw new Error(`Could not find initial pane for zellij tab ${tabId}`);
    const surface = `pane:${pane.id}`;
    try {
      zellijActionSync(["rename-pane", name], surface);
    } catch {}
    return surface;
  } catch (error) {
    try {
      zellijActionSync(["close-tab", "--tab-id", String(tabId)]);
    } catch {}
    throw error;
  }
}

function envPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function zellijSurfaceLockPath(): string {
  const session = (process.env.ZELLIJ_SESSION_NAME ?? process.env.ZELLIJ ?? "default").replace(
    /[^A-Za-z0-9_.-]/g,
    "_",
  );
  return join(tmpdir(), `pi-zellij-surface-${session}.lock`);
}

function withZellijSurfaceLock<T>(callback: () => T): T {
  const lockPath = zellijSurfaceLockPath();
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "owner"), `${process.pid}\n`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30_000) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() > deadline) throw new Error(`Timed out waiting for zellij surface lock: ${lockPath}`);
      sleepSync(50);
    }
  }
  try {
    return callback();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function createZellijSurface(name: string): string {
  return withZellijSurfaceLock(() => {
    const parentPaneId = Number(process.env.ZELLIJ_PANE_ID);
    const plan = Number.isInteger(parentPaneId)
      ? selectZellijPlacement(
          readZellijPanes(),
          parentPaneId,
          envPositiveInteger("PI_SUBAGENT_ZELLIJ_MIN_COLUMNS", DEFAULT_ZELLIJ_SUBAGENT_MIN_COLUMNS),
          envPositiveInteger("PI_SUBAGENT_ZELLIJ_MIN_ROWS", DEFAULT_ZELLIJ_SUBAGENT_MIN_ROWS),
        )
      : null;
    if (plan?.mode === "split") return createZellijTiledPane(name, plan.tabId);
    if (plan?.mode === "stack") return createZellijStackedPane(name, `pane:${plan.targetPaneId}`);
    return createZellijTab(name);
  });
}

// ── Surface primitives ──

/** Create a new pane for a subagent. */
export function createSurface(name: string): string {
  const backend = requireMuxBackend();
  if (backend === "zellij") return createZellijSurface(name);
  return createSurfaceSplit(name, "right", process.env.TMUX_PANE);
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  const backend = requireMuxBackend();

  if (backend === "tmux") {
    const args = ["split-window", "-d"];
    if (direction === "left" || direction === "right") args.push("-h");
    else args.push("-v");
    if (direction === "left" || direction === "up") args.push("-b");
    if (fromSurface) args.push("-t", fromSurface);
    args.push("-P", "-F", "#{pane_id}");

    const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
    if (!pane.startsWith("%")) throw new Error(`Unexpected tmux split-window output: ${pane}`);
    rebalanceSurfaces(pane);
    return pane;
  }

  const zellijDirection = direction === "left" || direction === "right" ? "right" : "down";
  const args = [
    "new-pane",
    "--direction",
    zellijDirection,
    "--name",
    name,
    "--cwd",
    process.cwd(),
  ];
  let rawId: string;
  try {
    rawId = zellijActionSync(args, fromSurface).trim();
  } catch {
    if (!fromSurface) throw new Error("Failed to create zellij pane");
    rawId = zellijActionSync(args).trim();
  }
  const surface = parseZellijPaneSurface(rawId, "new-pane");
  if (direction === "left" || direction === "up") {
    try {
      zellijActionSync(["move-pane", direction], surface);
    } catch {}
  }
  try {
    zellijActionSync(["rename-pane", name], surface);
  } catch {}
  return surface;
}

/**
 * Send a command string to a pane and execute it.
 * Typed literally (`-l`) so special characters are not interpreted as keys,
 * then submitted with Enter.
 */
export function sendCommand(surface: string, command: string): void {
  const backend = requireMuxBackend();
  if (backend === "tmux") {
    execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
    execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
    return;
  }
  zellijActionSync(["write-chars", command], surface);
  zellijActionSync(["write", "13"], surface);
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  const backend = requireMuxBackend();
  if (backend === "tmux") {
    return execFileSync(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      { encoding: "utf8" },
    );
  }
  const raw = execFileSync(
    "zellij",
    ["action", "dump-screen", "--pane-id", zellijPaneId(surface)],
    { encoding: "utf8" },
  );
  return tailLines(raw, lines);
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  const backend = requireMuxBackend();
  if (backend === "tmux") {
    const { stdout } = await execFileAsync(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      { encoding: "utf8" },
    );
    return stdout;
  }
  const { stdout } = await execFileAsync(
    "zellij",
    ["action", "dump-screen", "--pane-id", zellijPaneId(surface)],
    { encoding: "utf8" },
  );
  return tailLines(stdout, lines);
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  const backend = requireMuxBackend();
  if (backend === "tmux") {
    execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
    rebalanceSurfaces();
    return;
  }
  zellijActionSync(["close-pane"], surface);
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
