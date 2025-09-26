import spawnPlease from 'spawn-please'
import cp, { type ChildProcess } from 'child_process';
import { logError, logVerbose } from './logger.js';

export async function run(command: string, args: string[]) {
    const commandString = formatCommand(command, args);
    logVerbose(`Executing command: ${commandString}`);
    try {
        const result = await spawnPlease(command, args);
        logVerbose(`Command succeeded: ${commandString}`);
        return result;
    } catch (error) {
        logError(`Error running command: ${commandString}`);
        if (error instanceof Error && error.stack) {
            logVerbose(error.stack);
        }
        throw error;
    }
}

export async function runPiped([command1, args1]: [string, string[]], [command2, args2]: [string, string[]]) {
    const commandString = `${formatCommand(command1, args1)} | ${formatCommand(command2, args2)}`;
    logVerbose(`Executing piped command: ${commandString}`);
    const cp1 = cp.spawn(command1, args1, { stdio: ['inherit', 'pipe', 'inherit'] });
    const cp2 = cp.spawn(command2, args2, { stdio: ['pipe', 'inherit', 'inherit'] });

    cp1.stdout.pipe(cp2.stdin);

    await Promise.all([
        assertSuccess(cp1, formatCommand(command1, args1)),
        assertSuccess(cp2, formatCommand(command2, args2)),
    ]);

    logVerbose(`Piped command succeeded: ${commandString}`);
}

export async function runWithInput(command: string, args: string[], input: string) {
    const commandString = formatCommand(command, args);
    logVerbose(`Executing command with stdin: ${commandString}`);
    const child = cp.spawn(command, args, { stdio: ['pipe', 'inherit', 'inherit'] });

    child.stdin.on('error', (error) => {
        logError(`Failed to write to stdin for ${commandString}: ${error}`);
    });

    child.stdin.write(input);
    child.stdin.end();

    try {
        await assertSuccess(child, commandString);
        logVerbose(`Command with stdin succeeded: ${commandString}`);
    } catch (error) {
        if (error instanceof Error && error.stack) {
            logVerbose(error.stack);
        }
        throw error;
    }
}

function assertSuccess(cp: ChildProcess, command: string) {
    return new Promise<void>((resolve, reject) => {
        cp.on('error', (error) => {
            logError(`Process error: ${command}`);
            if (error instanceof Error && error.stack) {
                logVerbose(error.stack);
            }
            reject(error);
        });
        cp.on('close', (code) => {
            if (code !== 0) {
                const error = new Error(`process exited with code ${code}`);
                logError(`${command} failed: ${error.message}`);
                reject(error);
            }
            logVerbose(`Process exited successfully: ${command}`);
            resolve();
        });
    });
}

function formatCommand(command: string, args: string[]) {
    return [command, ...args].join(' ').trim();
}
