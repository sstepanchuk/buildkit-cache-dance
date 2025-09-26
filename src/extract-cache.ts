import { promises as fs } from 'fs';
import path from 'path';
import { CacheOptions, Opts, getCacheMap, getMountArgsString, getTargetPath, getBuilder } from './opts.js';
import { run, runPiped } from './run.js';

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
    const dancefilePath = path.join(jobScratchDir, 'Dancefile.extract');
    const imageTag = `dance:extract-${jobId}`;
    const containerName = `cache-container-${jobId}`;

    // Prepare Timestamp for Layer Cache Busting
    const date = new Date().toISOString();

    await fs.rm(jobScratchDir, { recursive: true, force: true });
    await fs.mkdir(jobScratchDir, { recursive: true });
    await fs.writeFile(path.join(jobScratchDir, 'buildstamp'), date);

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
    await fs.writeFile(dancefilePath, dancefileContent);
    console.log(dancefileContent);

    // Extract Data into Docker Image
    await run('docker', ['buildx', 'build', '--builder', builder, '-f', dancefilePath, '--tag', imageTag, '--load', jobScratchDir]);

    // Create Extraction Image
    try {
        await run('docker', ['rm', '-f', containerName]);
    } catch (error) {
        // Ignore error if container does not exist
    }
    await run('docker', ['create', '-ti', '--name', containerName, imageTag]);

    // Unpack Docker Image into Scratch
    await runPiped(
        ['docker', ['cp', '-L', `${containerName}:/var/dance-cache`, '-']],
        ['tar', ['-H', 'posix', '-x', '-C', jobScratchDir]]
    );

    // Move Cache into Its Place
    await run('sudo', ['rm', '-rf', cacheSource]);
    await fs.rename(path.join(jobScratchDir, 'dance-cache'), cacheSource);

    try {
        await run('docker', ['rm', '-f', containerName]);
    } catch (error) {
        // Ignore error if container removal fails
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
