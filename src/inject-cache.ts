import { promises as fs } from "fs";
import path from 'path';
import { CacheOptions, Opts, getCacheMap, getMountArgsString, getTargetPath, getUID, getGID, getBuilder } from './opts.js';
import { run } from './run.js';
import { notice } from '@actions/core/lib/core.js';

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

    await fs.rm(jobScratchDir, { recursive: true, force: true });
    await fs.mkdir(jobScratchDir, { recursive: true });

    // Prepare Cache Source Directory
    await fs.mkdir(cacheSource, { recursive: true });

    // Prepare Timestamp for Layer Cache Busting
    const date = new Date().toISOString();
    await fs.writeFile(path.join(cacheSource, 'buildstamp'), date);

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
    console.log(dancefileContent);

    // Inject Data into Docker Cache
    await run('docker', ['buildx', 'build', '--builder', builder ,'-f', dancefilePath, '--tag', imageTag, cacheSource]);

    // Clean Directories
    try {
        await fs.rm(cacheSource, { recursive: true, force: true });
    } catch (err) {
        // Ignore Cleaning Errors
        notice(`Error while cleaning cache source directory: ${err}. Ignoring...`);
    }

    await fs.rm(jobScratchDir, { recursive: true, force: true });
}


export async function injectCaches(opts: Opts) {
    const cacheMap = await getCacheMap(opts);
    const scratchDir = opts['scratch-dir'];
    const containerImage = opts['utility-image'];

    const builder = getBuilder(opts);
    // Inject Caches for each source-target pair
    await Promise.all(Object.entries(cacheMap).map(([cacheSource, cacheOptions]) =>
        injectCache(cacheSource, cacheOptions, scratchDir, containerImage, builder)
    ));
}
