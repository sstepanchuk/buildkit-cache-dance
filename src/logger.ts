import {
    debug as coreDebug,
    error as coreError,
    info as coreInfo,
    notice as coreNotice,
    warning as coreWarning,
    isDebug as coreIsDebug,
    startGroup as coreStartGroup,
    endGroup as coreEndGroup,
    group as coreGroup,
} from "@actions/core/lib/core.js";
import { AsyncLocalStorage } from "async_hooks";

let verboseEnabled = false;

// Async context for group prefixes
const groupContext = new AsyncLocalStorage<string>();

function callCore(fn: () => void, fallback: () => void) {
    try {
        fn();
    } catch (error) {
        fallback();
    }
}

const isActionsRuntime = process.env.GITHUB_ACTIONS === "true";

function formatMessageForConsole(message: string): string {
    const groupName = groupContext.getStore();
    return groupName ? `[${groupName}] ${message}` : message;
}

export function configureLogger(options: { verbose: boolean }) {
    verboseEnabled = options.verbose;
    if (verboseEnabled) {
        logVerbose("Verbose logging enabled");
    } else {
        logDebug("Verbose logging disabled");
    }
}

export function logInfo(message: string) {
    callCore(
        () => coreInfo(message),
        () => console.log(formatMessageForConsole(message))
    );
}

export function logNotice(message: string) {
    callCore(
        () => coreNotice(message),
        () => console.log(formatMessageForConsole(message))
    );
}

export function logWarning(message: string) {
    callCore(
        () => coreWarning(message),
        () => console.warn(formatMessageForConsole(message))
    );
}

export function logError(message: string | Error) {
    const text = message instanceof Error ? message.message : message;
    callCore(
        () => coreError(text),
        () => console.error(formatMessageForConsole(text))
    );
}

export function logDebug(message: string) {
    callCore(
        () => coreDebug(message),
        () => console.debug(formatMessageForConsole(message))
    );
}

export function logVerbose(message: string) {
    if (!verboseEnabled) {
        return;
    }

    const verboseMessage = `[verbose] ${message}`;

    if (isActionsRuntime) {
        callCore(
            () => coreDebug(verboseMessage),
            () => console.debug(formatMessageForConsole(verboseMessage))
        );
        if (!coreIsDebug()) {
            callCore(
                () => coreInfo(verboseMessage),
                () => console.log(formatMessageForConsole(verboseMessage))
            );
        }
    } else {
        console.debug(formatMessageForConsole(verboseMessage));
    }
}

async function createNativeGroup<T>(
    name: string,
    fn: () => Promise<T>
): Promise<T> {
  return groupContext.run(name, fn);
}

export async function logGroup<T>(
    name: string,
    fn: () => Promise<T>
): Promise<T> {
    if (isActionsRuntime) {
        try {
            // In Actions environment, use core.group without context (Actions handles grouping)
            return await coreGroup(name, fn);
        } catch (error) {
            // Fallback to manual wrapper if core.group fails
            return await createNativeGroup(name, fn);
        }
    } else {
        // Non-Actions environment - use native wrapper with context
        return await createNativeGroup(name, fn);
    }
}

export function isVerboseEnabled() {
    return verboseEnabled;
}
