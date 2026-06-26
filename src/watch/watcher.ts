import chokidar from "chokidar";
import { isAbsolute, relative, win32 } from "node:path";
import { createIgnoreMatcher, normalizeSyncPath } from "../sync/ignore.js";
import type { WatchAdapter, WatchChangeEvent } from "./types.js";

const WATCH_EVENTS = new Set(["add", "change", "unlink"]);

export function createWatchIgnoredPredicate(input: {
  projectRoot: string;
  userIgnorePatterns?: readonly string[];
}): (path: string) => boolean {
  const matcher = createIgnoreMatcher(input.userIgnorePatterns);

  return (path) => {
    const relativePath = toProjectRelativePath(input.projectRoot, path);
    return matcher.isIgnored(relativePath);
  };
}

export function createChokidarWatchAdapter(): WatchAdapter {
  return {
    watch(input) {
      const watcher = chokidar.watch(input.projectRoot, {
        cwd: input.projectRoot,
        ignoreInitial: true,
        persistent: true,
        awaitWriteFinish: {
          stabilityThreshold: 200,
          pollInterval: 100,
        },
        ignored: (path) => input.ignored(String(path)),
      });

      watcher.on("all", (eventName, path) => {
        if (!WATCH_EVENTS.has(eventName)) return;
        const event: WatchChangeEvent = {
          event: eventName as WatchChangeEvent["event"],
          path: normalizeSyncPath(String(path)),
        };
        if (!input.ignored(event.path)) {
          input.onChange(event);
        }
      });
      watcher.on("error", input.onError);

      return {
        close: () => watcher.close(),
      };
    },
  };
}

function toProjectRelativePath(projectRoot: string, path: string): string {
  const normalizedInput = normalizeSyncPath(path);
  const inputIsAbsolute = isAbsolute(path);
  const inputIsWindowsAbsolute = win32.isAbsolute(path);

  if (!inputIsAbsolute && !inputIsWindowsAbsolute) {
    return normalizedInput;
  }

  const relativePath =
    inputIsWindowsAbsolute || win32.isAbsolute(projectRoot)
      ? win32.relative(projectRoot, path)
      : relative(projectRoot, path);
  if (relativePath === "") {
    return "";
  }
  return normalizeSyncPath(relativePath);
}
