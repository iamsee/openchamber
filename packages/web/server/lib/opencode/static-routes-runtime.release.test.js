import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStaticRoutesRuntime } from './static-routes-runtime.js';

const buildRuntime = () => createStaticRoutesRuntime({
  fs,
  path,
  process,
  __dirname: import.meta.dirname,
  express,
  resolveProjectDirectory: () => '/project',
  buildOpenCodeUrl: () => 'http://upstream',
  getOpenCodeAuthHeaders: () => ({}),
  readSettingsFromDiskMigrated: async () => ({}),
  normalizePwaAppName: (value) => value,
  normalizePwaOrientation: (value) => value,
});

describe('release artifact routes', () => {
  let releaseDir;

  beforeEach(() => {
    releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-release-'));
    process.env.OPENCHAMBER_RELEASE_DIR = releaseDir;
  });

  afterEach(() => {
    delete process.env.OPENCHAMBER_RELEASE_DIR;
    fs.rmSync(releaseDir, { recursive: true, force: true });
  });

  it('lists artifacts with size and modification time on /release/', async () => {
    fs.writeFileSync(path.join(releaseDir, 'OpenChamber-2.0.1-android.apk'), 'x'.repeat(2048));
    const app = express();
    buildRuntime().registerReleaseRoutes(app);

    const response = await request(app).get('/release/');

    expect(response.status).toBe(200);
    expect(response.type).toBe('text/html');
    expect(response.text).toContain('OpenChamber-2.0.1-android.apk');
    expect(response.text).toContain('2.0 kB');
    expect(response.text).toContain('UTC');
  });

  it('serves artifact downloads and 404s for missing files instead of the SPA', async () => {
    fs.writeFileSync(path.join(releaseDir, 'OpenChamber-2.0.1-win-x64.exe'), 'installer');
    const app = express();
    buildRuntime().registerReleaseRoutes(app);
    // A fallback that would otherwise swallow unmatched paths.
    app.use((_req, res) => {
      res.status(200).send('spa');
    });

    const download = await request(app).get('/release/OpenChamber-2.0.1-win-x64.exe');
    expect(download.status).toBe(200);
    expect(download.text).toBe('installer');

    const missing = await request(app).get('/release/missing.apk');
    expect(missing.status).toBe(404);
    expect(missing.text).toBe('Release artifact not found');
  });

  it('hides dotfiles and directories from the listing', async () => {
    fs.writeFileSync(path.join(releaseDir, '.hidden'), 'secret');
    fs.mkdirSync(path.join(releaseDir, 'subdir'));
    const app = express();
    buildRuntime().registerReleaseRoutes(app);

    const response = await request(app).get('/release/');

    expect(response.status).toBe(200);
    expect(response.text).toContain('No release artifacts published yet.');
    expect(response.text).not.toContain('.hidden');
    expect(response.text).not.toContain('subdir');
  });

  it('mounts nothing when OPENCHAMBER_RELEASE_DIR is not configured', async () => {
    delete process.env.OPENCHAMBER_RELEASE_DIR;
    const app = express();
    buildRuntime().registerReleaseRoutes(app);

    const response = await request(app).get('/release/');

    expect(response.status).toBe(404);
  });

  it('mounts nothing when the configured directory does not exist', async () => {
    process.env.OPENCHAMBER_RELEASE_DIR = path.join(releaseDir, 'missing');
    const app = express();
    buildRuntime().registerReleaseRoutes(app);

    const response = await request(app).get('/release/');

    expect(response.status).toBe(404);
  });
});
