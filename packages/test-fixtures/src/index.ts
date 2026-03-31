import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TempDirTracker {
  make(prefix?: string): string;
  cleanup(): void;
  activeRoots(): readonly string[];
}

export function createTempDirTracker(defaultPrefix = "agentgit-fixture-"): TempDirTracker {
  const roots: string[] = [];

  return {
    make(prefix = defaultPrefix): string {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      roots.push(root);
      return root;
    },

    cleanup(): void {
      while (roots.length > 0) {
        const root = roots.pop();
        if (!root) {
          continue;
        }
        fs.rmSync(root, { recursive: true, force: true });
      }
    },

    activeRoots(): readonly string[] {
      return [...roots];
    },
  };
}
