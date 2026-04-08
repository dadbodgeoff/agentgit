import fs from "node:fs";
import path from "node:path";

function candidateNames(command) {
  if (process.platform !== "win32") {
    return [command];
  }

  const pathext = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (path.extname(command).length > 0) {
    return [command];
  }
  return pathext.map((extension) => `${command}${extension.toLowerCase()}`);
}

export function resolveCommandPath(command, envPath = process.env.PATH ?? "") {
  if (path.isAbsolute(command)) {
    return fs.realpathSync(command);
  }

  for (const directory of envPath.split(path.delimiter)) {
    if (!directory) {
      continue;
    }

    for (const candidateName of candidateNames(command)) {
      const candidatePath = path.join(directory, candidateName);
      try {
        fs.accessSync(candidatePath, fs.constants.X_OK);
        return fs.realpathSync(candidatePath);
      } catch {
        // Keep scanning the PATH until a usable executable is found.
      }
    }
  }

  throw new Error(`Unable to resolve executable from PATH: ${command}`);
}
