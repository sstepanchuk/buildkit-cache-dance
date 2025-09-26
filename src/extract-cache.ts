import { promises as fs } from 'fs';
import path from 'path';
import { CacheOptions, Opts, getCacheMap, getMountArgsString, getTargetPath, getBuilder } from './opts.js';
import { run, runWithInput } from './run.js';
import { endLogGroup, logError, logInfo, logVerbose, logWarning, startLogGroup } from './logger.js';

function createJobId(cacheSource: string): string {
    const slug = cacheSource
        .replace(/^[\\/]+/, '')
        .replace(/[\\/]+/g, '-')
        .replace(/[^a-zA-Z0-9_.-]/g, '-')
        .toLowerCase()
        .slice(-40);
    const unique = Math.random().toString(36).slice(2, 10);
    return `${slug || 'cache'}-${unique}`;
}

async function extractCache(cacheSource: string, cacheOptions: CacheOptions, scratchDir: string, containerImage: string, builder: string) {
    const jobId = createJobId(cacheSource);
    const jobScratchDir = path.join(scratchDir, jobId);
    const jobOutputDir = path.join(jobScratchDir, 'output');

    startLogGroup(`Extract cache from ${cacheSource}`);
    logInfo(`Preparing cache extraction for source '${cacheSource}' using builder '${builder}'.`);

    // Prepare Timestamp for Layer Cache Busting
    const date = new Date().toISOString();

    await fs.rm(jobScratchDir, { recursive: true, force: true });
    await fs.mkdir(jobScratchDir, { recursive: true });
    const buildstampPath = path.join(jobScratchDir, 'buildstamp');
    await fs.writeFile(buildstampPath, date);
    logVerbose(`Scratch directory initialized at '${jobScratchDir}' with buildstamp ${date}.`);

    // Prepare Dancefile to Access Caches
    const targetPath = getTargetPath(cacheOptions);
    const mountArgs = getMountArgsString(cacheOptions);

    const dancefileContent = `
FROM ${containerImage} AS dance-extract
COPY buildstamp buildstamp
RUN --mount=${mountArgs} \
    mkdir -p /var/dance-cache/ \
    && cp -p -R ${targetPath}/. /var/dance-cache/ || true
FROM scratch
COPY --from=dance-extract /var/dance-cache /cache
`;
    logVerbose(`Dancefile for extraction generated:\n${dancefileContent}`);

    await fs.rm(jobOutputDir, { recursive: true, force: true });
    await fs.mkdir(jobOutputDir, { recursive: true });
    logVerbose(`Output directory prepared at '${jobOutputDir}'.`);
    await runWithInput('docker', [
        'buildx',
        'build',
        '--builder', builder,
        '-f', '-',
        '--output', `type=local,dest=${jobOutputDir}`,
        jobScratchDir,
    ], dancefileContent);

    // Move Cache into Its Place
    const cacheStagePath = path.join(jobOutputDir, 'cache');
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
        await fs.rename(cacheStagePath, cacheSource);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            await fs.mkdir(cacheSource, { recursive: true });
            logVerbose(`Cache extraction produced no files for '${cacheSource}'. Directory created.`);
        } else {
            logError(`Failed to move extracted cache from '${cacheStagePath}' to '${cacheSource}': ${error}`);
            throw error;
        }
    }
    await fs.rm(jobScratchDir, { recursive: true, force: true });
    logInfo(`Cache extraction completed for source '${cacheSource}'.`);
    endLogGroup();
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
