import { promises as fs } from 'fs';
import path from 'path';
import { CacheOptions, Opts, getCacheMap, getMountArgsString, getTargetPath, getBuilder } from './opts.js';
import { run, runWithInput, runPiped } from './run.js';
import { logError, logGroup, logInfo, logVerbose, logWarning } from './logger.js';

async function extractCachesBatch(cacheMap: Record<string, CacheOptions>, scratchDir: string, containerImage: string, builder: string) {
    return await logGroup(`Extract all caches in batch`, async () => {
        const imageTag = `dance:extract-batch`;
        const containerName = `cache-container-batch`;

        logInfo(`Preparing batch cache extraction for ${Object.keys(cacheMap).length} cache(s) using builder '${builder}'.`);

        // Prepare Timestamp for Layer Cache Busting
        const date = new Date().toISOString();

        await fs.rm(scratchDir, { recursive: true, force: true });
        await fs.mkdir(scratchDir, { recursive: true });
        await fs.writeFile(path.join(scratchDir, 'buildstamp'), date);

        // Prepare Dancefile to Access All Caches
        const cacheEntries = Object.entries(cacheMap);
        const mountArgs = cacheEntries.map(([_, cacheOptions]) => getMountArgsString(cacheOptions)).join(' ');
        
        // Create RUN commands to copy each cache to a numbered subdirectory
        const copyCommands = cacheEntries.map(([cacheSource, cacheOptions], index) => {
            const targetPath = getTargetPath(cacheOptions);
            const cacheId = `cache-${index}`;
            return `mkdir -p "/var/dance-cache/${cacheId}/" && cp -p -R ${targetPath}/. "/var/dance-cache/${cacheId}/" || true`;
        }).join(' && ');

        const dancefileContent = `
FROM ${containerImage}
COPY buildstamp buildstamp
RUN --mount=${mountArgs} \
    ${copyCommands}
`;
        logVerbose(`Dancefile for batch extraction generated:\n${dancefileContent}`);

        // Extract Data into Docker Image
        await runWithInput('docker', ['buildx', 'build', '--builder', builder, '-f', '-', '--tag', imageTag, '--load', scratchDir], dancefileContent);

        // Create Extraction Container
        try {
            await run('docker', ['rm', '-f', containerName]);
        } catch (error) {
            // Ignore error if container does not exist
        }
        await run('docker', ['create', '-ti', '--name', containerName, imageTag]);

        // Extract all caches in one operation
        await runPiped(
            ['docker', ['cp', '-L', `${containerName}:/var/dance-cache`, '-']],
            ['tar', ['-H', 'posix', '-x', '-C', scratchDir]]
        );

        // Move each cache from scratch to its target location
        for (const [cacheSource, _] of cacheEntries) {
            const index = cacheEntries.findIndex(([source, _]) => source === cacheSource);
            const cacheId = `cache-${index}`;
            const sourcePath = path.join(scratchDir, 'dance-cache', cacheId);

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
                await fs.rename(sourcePath, cacheSource);
                logInfo(`Cache extraction completed for source '${cacheSource}'.`);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    await fs.mkdir(cacheSource, { recursive: true });
                    logVerbose(`Cache extraction produced no files for '${cacheSource}'. Directory created.`);
                } else {
                    logError(`Failed to move extracted cache from '${sourcePath}' to '${cacheSource}': ${error}`);
                    throw error;
                }
            }
        }

        // Clean up container and scratch directory
        try {
            await run('docker', ['rm', '-f', containerName]);
        } catch (error) {
            // Ignore cleanup errors
            logVerbose(`Failed to clean up container '${containerName}': ${error}`);
        }

        try {
            await fs.rm(scratchDir, { recursive: true, force: true });
        } catch (error) {
            // Ignore cleanup errors
            logVerbose(`Failed to clean up scratch directory '${scratchDir}': ${error}`);
        }
        
        logInfo(`Batch cache extraction completed for ${Object.keys(cacheMap).length} cache(s).`);
    });
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

    // Extract all caches in a single batch operation
    logInfo(`Extracting ${Object.keys(cacheMap).length} cache mount(s) using image '${containerImage}'.`);

    if (Object.keys(cacheMap).length === 0) {
        logInfo("No caches to extract.");
        return;
    }

    await extractCachesBatch(cacheMap, scratchDir, containerImage, builder);
}
