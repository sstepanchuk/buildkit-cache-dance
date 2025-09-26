import { debug as coreDebug, error as coreError, info as coreInfo, notice as coreNotice, warning as coreWarning, isDebug as coreIsDebug, startGroup as coreStartGroup, endGroup as coreEndGroup } from '@actions/core/lib/core.js';

let verboseEnabled = false;

function callCore(fn: () => void, fallback: () => void) {
  try {
    fn();
  } catch (error) {
    fallback();
  }
}

const isActionsRuntime = process.env.GITHUB_ACTIONS === 'true';

export function configureLogger(options: { verbose: boolean }) {
  verboseEnabled = options.verbose;
  if (verboseEnabled) {
    logVerbose('Verbose logging enabled');
  } else {
    logDebug('Verbose logging disabled');
  }
}

export function logInfo(message: string) {
  callCore(() => coreInfo(message), () => console.log(message));
}

export function logNotice(message: string) {
  callCore(() => coreNotice(message), () => console.log(message));
}

export function logWarning(message: string) {
  callCore(() => coreWarning(message), () => console.warn(message));
}

export function logError(message: string | Error) {
  const text = message instanceof Error ? message.message : message;
  callCore(() => coreError(text), () => console.error(text));
}

export function logDebug(message: string) {
  callCore(() => coreDebug(message), () => console.debug(message));
}

export function logVerbose(message: string) {
  if (!verboseEnabled) {
    return;
  }

  const formatted = `[verbose] ${message}`;

  if (isActionsRuntime) {
    callCore(() => coreDebug(formatted), () => console.debug(formatted));
    if (!coreIsDebug()) {
      callCore(() => coreInfo(formatted), () => console.log(formatted));
    }
  } else {
    console.debug(formatted);
  }
}

export function startLogGroup(title: string) {
  callCore(() => coreStartGroup(title), () => logInfo(title));
}

export function endLogGroup() {
  callCore(() => coreEndGroup(), () => undefined);
}

export function isVerboseEnabled() {
  return verboseEnabled;
}
