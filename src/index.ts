import { promises as fs } from "fs";
import os from "os";
import { injectCaches } from "./inject-cache.js";
import { extractCaches } from "./extract-cache.js";
import { help, parseOpts } from "./opts.js";
import { configureLogger, logError, logInfo, logVerbose } from "./logger.js";

async function main(args: string[]) {
  const opts = parseOpts(args);

  configureLogger({ verbose: opts.verbose });

  if (opts.help) {
    logInfo("Displaying help information...");
    return help();
  }

  if (opts.extract) {
    // Run the post step
    logInfo("Starting cache extraction workflow...");
    await extractCaches(opts);
  } else {
    // Otherwise, this is the main step
    if (process.env.GITHUB_STATE !== undefined) {
      await fs.appendFile(process.env.GITHUB_STATE, `POST=true${os.EOL}`);
    }
    logInfo("Starting cache injection workflow...");
    await injectCaches(opts);
  }
}

main(process.argv)
    .catch(err => {
        logError(err instanceof Error ? err : String(err));
        if (err instanceof Error && err.stack) {
            logVerbose(err.stack);
        }
        process.exit(1);
    });
