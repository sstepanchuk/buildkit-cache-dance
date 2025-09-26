import { promises as fs } from 'fs';
import path from 'path';
import { CacheOptions, Opts, getCacheMap, getMountArgsString, getTargetPath, getBuilder } from './opts.js';
import { run } from './run.js';

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
    const dancefilePath = path.join(jobScratchDir, 'Dancefile.extract');

    // Prepare Timestamp for Layer Cache Busting
    const date = new Date().toISOString();

    await fs.rm(jobScratchDir, { recursive: true, force: true });
    await fs.mkdir(jobScratchDir, { recursive: true });
    await fs.writeFile(path.join(jobScratchDir, 'buildstamp'), date);

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
    await fs.writeFile(dancefilePath, dancefileContent);
    console.log(dancefileContent);

    await fs.rm(jobOutputDir, { recursive: true, force: true });
    await fs.mkdir(jobOutputDir, { recursive: true });
    await run('docker', [
        'buildx',
        'build',
        '--builder', builder,
        '-f', dancefilePath,
        '--output', `type=local,dest=${jobOutputDir}`,
        jobScratchDir,
    ]);

    // Move Cache into Its Place
    const cacheStagePath = path.join(jobOutputDir, 'cache');
    await fs.mkdir(path.dirname(cacheSource), { recursive: true });
    await run('sudo', ['rm', '-rf', cacheSource]);
    try {
        await fs.rename(cacheStagePath, cacheSource);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            await fs.mkdir(cacheSource, { recursive: true });
        } else {
            throw error;
        }
    }
    await fs.rm(jobScratchDir, { recursive: true, force: true });
}

export async function extractCaches(opts: Opts) {
    if (opts["skip-extraction"]) {
        console.log("skip-extraction is set. Skipping extraction step...");
        return;
    }

    const cacheMap = await getCacheMap(opts);
    const scratchDir = opts['scratch-dir'];
    const containerImage = opts['utility-image'];
    const builder = getBuilder(opts);

    // Extract Caches for each source-target pair
    await Promise.all(Object.entries(cacheMap).map(([cacheSource, cacheOptions]) =>
        extractCache(cacheSource, cacheOptions, scratchDir, containerImage, builder)
    ));
}
