import { promises as fs } from 'fs';
import path from 'path';
import { CacheOptions, Opts, getCacheMap, getMountArgsString, getTargetPath, getBuilder } from './opts.js';
import { run, runWithInput, runPiped } from './run.js';
import { logError, logInfo, logVerbose, logWarning } from './logger.js';

async function extractCache(cacheSource: string, cacheOptions: CacheOptions, scratchDir: string, containerImage: string, builder: string) {
    logInfo(`Preparing cache extraction for source '${cacheSource}' using builder '${builder}'.`);

    // Prepare Timestamp for Layer Cache Busting
    const date = new Date().toISOString();

    await fs.mkdir(scratchDir, { recursive: true });
    await fs.writeFile(path.join(scratchDir, 'buildstamp'), date);

    // Prepare Dancefile to Access Caches
    const targetPath = getTargetPath(cacheOptions);
    const mountArgs = getMountArgsString(cacheOptions);

    const dancefileContent = `
FROM ${containerImage}
COPY buildstamp buildstamp
RUN --mount=${mountArgs} \
    mkdir -p /var/dance-cache/ \
    && cp -p -R ${targetPath}/. /var/dance-cache/ || true
`;
    logVerbose(`Dancefile for extraction generated:\n${dancefileContent}`);

    // Extract Data into Docker Image
    await runWithInput('docker', ['buildx', 'build', '--builder', builder, '-f', '-', '--tag', 'dance:extract', '--load', scratchDir], dancefileContent);

    // Create Extraction Container
    try {
        await run('docker', ['rm', '-f', 'cache-container']);
    } catch (error) {
        // Ignore error if container does not exist
    }
    await run('docker', ['create', '-ti', '--name', 'cache-container', 'dance:extract']);

    // Unpack Docker Image into Scratch
    await runPiped(
        ['docker', ['cp', '-L', 'cache-container:/var/dance-cache', '-']],
        ['tar', ['-H', 'posix', '-x', '-C', scratchDir]]
    );

    // Move Cache into Its Place
    await fs.mkdir(path.dirname(cacheSource), { recursive: true });
    try {
        await run('sudo', ['rm', '-rf', cacheSource]);
    } catch (error) {
        logWarning(`Failed to clean existing cache directory '${cacheSource}' with sudo. Attempting fallback without sudo.`);
        try {
            await fs.rm(cacheSource, { recursive: true, force: true });
        } catch (cleanupError) {
            logError(`Unable to remove existing cache directory '${cacheSource}': ${cleanupError}`);
            throw cleanupError;
        }
    }
    try {
        await fs.rename(path.join(scratchDir, 'dance-cache'), cacheSource);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            await fs.mkdir(cacheSource, { recursive: true });
            logVerbose(`Cache extraction produced no files for '${cacheSource}'. Directory created.`);
        } else {
            logError(`Failed to move extracted cache from '${path.join(scratchDir, 'dance-cache')}' to '${cacheSource}': ${error}`);
            throw error;
        }
    }
    
    logInfo(`Cache extraction completed for source '${cacheSource}'.`);
}

export async function extractCaches(opts: Opts) {
    if (opts["skip-extraction"]) {
        logInfo("skip-extraction is set. Skipping extraction step...");
        return;
    }

    const cacheMap = await getCacheMap(opts);
    const scratchDir = opts['scratch-dir'];
    const containerImage = opts['utility-image'];
    const builder = getBuilder(opts);

    // Extract Caches for each source-target pair
    logInfo(`Extracting ${Object.keys(cacheMap).length} cache mount(s) using image '${containerImage}'.`);

    await Promise.all(Object.entries(cacheMap).map(([cacheSource, cacheOptions]) =>
        extractCache(cacheSource, cacheOptions, scratchDir, containerImage, builder)
            .catch(error => {
                logError(`Cache extraction failed for '${cacheSource}': ${error}`);
                throw error;
            })
    ));
}
