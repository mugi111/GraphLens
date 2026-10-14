import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, rename, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pluginInstallPrefix } from './package-paths.js';

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const IDENTIFIER = '(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)';
const EXACT_VERSION = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-${IDENTIFIER}(?:\\.${IDENTIFIER})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
const OUTPUT_LIMIT = 64 * 1024;
const INSTALL_TIMEOUT_MS = 120_000;

export type StagedPackage = { packageName: string; version: string; prefix: string };

/** Installs an exact public registry package without invoking shell commands or lifecycle scripts. */
export async function stageNpmPackage(pluginStorePath: string, pluginId: string, packageName: string, version: string): Promise<StagedPackage> {
  pluginInstallPrefix(pluginStorePath, pluginId);
  if (!PACKAGE_NAME.test(packageName) || packageName.includes('..')) throw new Error('Plugin package name is invalid.');
  if (!EXACT_VERSION.test(version)) throw new Error('Plugin version must be an exact semantic version.');
  await mkdir(resolve(pluginStorePath), { recursive: true });
  const stagingRoot = await mkdtemp(join(resolve(pluginStorePath), '.staging-'));
  const stagedPrefix = pluginInstallPrefix(stagingRoot, pluginId);
  try {
    await runNpm(['install', '--prefix', stagedPrefix, '--save-exact', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', `${packageName}@${version}`]);
    const finalPrefix = pluginInstallPrefix(pluginStorePath, pluginId);
    const finalRoot = join(resolve(pluginStorePath), pluginId);
    try {
      await stat(finalRoot);
      throw new Error(`Plugin '${pluginId}' already has a package directory.`);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await rename(stagedPrefix, finalRoot);
    return { packageName, version, prefix: finalPrefix };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

function runNpm(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('npm', args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let outputBytes = 0;
    let output = '';
    let settled = false;
    const append = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes <= OUTPUT_LIMIT) output += chunk.toString('utf8');
      else if (!settled) { settled = true; stopChild(child); reject(new Error('npm output exceeded the 64 KiB limit.')); }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`Unable to start npm: ${error.message}`)); } });
    const timer = setTimeout(() => {
      if (!settled) { settled = true; stopChild(child); reject(new Error('npm installation timed out after 120 seconds.')); }
    }, INSTALL_TIMEOUT_MS);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) resolvePromise();
      else reject(new Error(`npm installation failed with exit code ${code ?? 'unknown'}: ${output.slice(-4000)}`));
    });
  });
}

function stopChild(child: ReturnType<typeof spawn>) {
  child.kill('SIGTERM');
  const forceKill = setTimeout(() => child.kill('SIGKILL'), 2000);
  forceKill.unref();
}
