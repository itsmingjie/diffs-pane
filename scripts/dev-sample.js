#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sampleRoot = path.resolve(
  process.env.DIFFS_PANE_SAMPLE_ROOT ?? path.join(projectRoot, '.tmp', 'sample-repo'),
);
const ownerMarker = `${sampleRoot}.diffs-pane-owned`;
const fixtureRoot = path.join(projectRoot, 'scripts', 'sample-fixture');
const cli = path.join(projectRoot, 'bin', 'dp.js');
const owner = 'dev-sample';

function runDp(args, options = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    ...options,
  });
}

function runGit(args) {
  execFileSync('git', ['-C', sampleRoot, ...args], { stdio: 'ignore' });
}

function stopSample() {
  try {
    runDp(['stop', '--root', sampleRoot, '--owner', owner], { stdio: 'ignore' });
  } catch {
    // The daemon or sample session may not be running.
  }
}

async function removeOwnedSample() {
  if (!existsSync(sampleRoot)) {
    await rm(ownerMarker, { force: true });
    return;
  }
  if (!existsSync(ownerMarker)) {
    throw new Error(
      `Refusing to replace ${sampleRoot}: it was not created by scripts/dev-sample.js`,
    );
  }
  await rm(sampleRoot, { recursive: true, force: true });
  await rm(ownerMarker, { force: true });
}

async function copyFixture(name) {
  const source = path.join(fixtureRoot, name);
  await cp(path.join(source, 'README.md'), path.join(sampleRoot, 'README.md'));
  await cp(path.join(source, 'src'), path.join(sampleRoot, 'src'), { recursive: true });
}

async function createSample() {
  await mkdir(sampleRoot, { recursive: true });
  await writeFile(ownerMarker, 'Owned by diffs-pane dev:sample.\n');
  await copyFixture('before');

  runGit(['init', '-q', '--initial-branch', 'main']);
  runGit(['config', 'user.name', 'diffs-pane sample']);
  runGit(['config', 'user.email', 'sample@diffs-pane.local']);
  runGit(['add', 'README.md', 'src']);
  runGit(['commit', '-q', '-m', 'Initial sample']);
  runGit(['checkout', '-q', '-b', 'feature/display-discounts']);

  await rm(path.join(sampleRoot, 'README.md'));
  await rm(path.join(sampleRoot, 'src'), { recursive: true });
  await copyFixture('after');
}

if (process.argv.includes('--stop')) {
  stopSample();
  await removeOwnedSample();
  process.stdout.write(`Stopped and removed sample repository: ${sampleRoot}\n`);
} else {
  stopSample();
  await removeOwnedSample();
  await createSample();
  const url = runDp(['watch', '--root', sampleRoot, '--base', 'main', '--owner', owner]).trim();

  process.stdout.write(`\nSample repository: ${sampleRoot}\n`);
  process.stdout.write(`Viewer: ${url}\n\n`);
  process.stdout.write('Edit files in the sample repository to test live updates.\n');
  process.stdout.write('Run `pnpm run dev:sample` again to rebuild and reset it.\n');
  process.stdout.write('Run `pnpm run dev:sample:stop` when finished.\n');
}
