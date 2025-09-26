import { promises as fs } from "fs";
import path from 'path';
import { CacheOptions, Opts, getCacheMap, getMountArgsString, getTargetPath, getUID, getGID, getBuilder } from './opts.js';
import { run } from './run.js';
import { endLogGroup, logInfo, logNotice, logVerbose, logWarning, startLogGroup } from './logger.js';

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

async function injectCache(cacheSource: string, cacheOptions: CacheOptions, scratchDir: string, containerImage: string, builder: string) {
    const jobId = createJobId(cacheSource);
    const jobScratchDir = path.join(scratchDir, jobId);
    const dancefilePath = path.join(jobScratchDir, 'Dancefile.inject');
    const imageTag = `dance:inject-${jobId}`;

    startLogGroup(`Inject cache for ${cacheSource}`);

    logInfo(`Preparing cache injection for source '${cacheSource}' using builder '${builder}'.`);

    await fs.rm(jobScratchDir, { recursive: true, force: true });
    await fs.mkdir(jobScratchDir, { recursive: true });

    // Prepare Cache Source Directory
    await fs.mkdir(cacheSource, { recursive: true });
    logVerbose(`Working directory prepared at '${cacheSource}'.`);

    // Prepare Timestamp for Layer Cache Busting
    const date = new Date().toISOString();
    await fs.writeFile(path.join(cacheSource, 'buildstamp'), date);
    logVerbose(`Build timestamp written for cache busting: ${date}.`);

    const targetPath = getTargetPath(cacheOptions);
    const mountArgs = getMountArgsString(cacheOptions);

    // If UID OR GID are set, then add chown to restore files ownership.
    let ownershipCommand = "";
    const uid = getUID(cacheOptions);
    const gid = getGID(cacheOptions);
    if (uid !== "" || gid !== "") {
        ownershipCommand = `&& chown -R ${uid}:${gid} ${targetPath}`
    }

    // Prepare Dancefile to Access Caches
    const dancefileContent = `
FROM ${containerImage}
COPY buildstamp buildstamp
RUN --mount=${mountArgs} \
    --mount=type=bind,source=.,target=/var/dance-cache \
    cp -p -R /var/dance-cache/. ${targetPath} ${ownershipCommand} || true
`;
    await fs.writeFile(dancefilePath, dancefileContent);
    logVerbose(`Dancefile for injection written to '${dancefilePath}':\n${dancefileContent}`);

    // Inject Data into Docker Cache
    logInfo(`Running docker buildx to inject cache for '${cacheSource}'.`);
    await run('docker', ['buildx', 'build', '--builder', builder ,'-f', dancefilePath, '--tag', imageTag, cacheSource]);

    // Clean Directories
    try {
        await fs.rm(cacheSource, { recursive: true, force: true });
    } catch (err) {
        // Ignore Cleaning Errors
        logNotice(`Error while cleaning cache source directory at '${cacheSource}': ${err}. Ignoring...`);
    }

    await fs.rm(jobScratchDir, { recursive: true, force: true });

    logInfo(`Cache injection completed for source '${cacheSource}'.`);
    endLogGroup();
}


export async function injectCaches(opts: Opts) {
    const cacheMap = await getCacheMap(opts);
    const scratchDir = opts['scratch-dir'];
    const containerImage = opts['utility-image'];

    const builder = getBuilder(opts);
    logInfo(`Injecting ${Object.keys(cacheMap).length} cache mount(s) using image '${containerImage}'.`);
    // Inject Caches for each source-target pair
    const tasks = Object.entries(cacheMap).map(([cacheSource, cacheOptions]) =>
        injectCache(cacheSource, cacheOptions, scratchDir, containerImage, builder)
            .catch(error => {
                logWarning(`Cache injection failed for '${cacheSource}': ${error}`);
                throw error;
            })
    );

    await Promise.all(tasks);
}
