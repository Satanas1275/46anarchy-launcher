const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const http = require('http');
const https = require('https');

const CONFIG = {
  paladiumJsonUrl: 'https://cdn.paladium-pvp.fr/games/paladiumv2/paladium.json',
  fsPatchesUrl: 'https://46anarchy.vercel.app/cdn/fs-patches.jar',
  standardForgeUrl: 'https://maven.minecraftforge.net/net/minecraftforge/forge/1.7.10-10.13.4.1614-1.7.10/forge-1.7.10-10.13.4.1614-1.7.10-universal.jar',
  outputDir: path.resolve('./paladium'),
  maxJobs: 10,
  assetsBaseUrl: 'https://resources.download.minecraft.net',
};

function migrateOutputDir() {
  const oldDir = path.resolve('./palamod');
  const newDir = CONFIG.outputDir;
  if (oldDir === newDir) return;
  if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
    log(`Migrating ${oldDir} -> ${newDir}...`);
    fs.renameSync(oldDir, newDir);
  }
}

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${msg}`);
}

function sha1File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'Palamod-Launcher/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpGet(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const mod = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(outputPath);
    mod.get(url, { headers: { 'User-Agent': 'Palamod-Launcher/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(outputPath);
        downloadFile(res.headers.location, outputPath).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(outputPath);
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(outputPath);
      });
    }).on('error', err => {
      file.close();
      try { fs.unlinkSync(outputPath); } catch (_) {}
      reject(err);
    });
  });
}

async function downloadWithRetry(url, outputPath, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await downloadFile(url, outputPath);
      return;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function fetchJson(url) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const buf = await httpGet(url);
      return JSON.parse(buf.toString());
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}

async function runConcurrent(items, fn) {
  let idx = 0;
  const total = items.length;

  async function next() {
    while (idx < total) {
      const i = idx++;
      await fn(items[i], i + 1, total);
    }
  }

  const workers = Array.from({ length: Math.min(CONFIG.maxJobs, total) }, () => next());
  await Promise.all(workers);
}

async function downloadCdnFiles(files, modelDestMap) {
  const outputDir = CONFIG.outputDir;
  const total = files.length;

  log(`Downloading ${total} files from CDN (max ${CONFIG.maxJobs} parallel)...`);

  await runConcurrent(files, async (fileEntry, id, total) => {
    const { name, url, path: filePath, sha1, size, model } = fileEntry;
    const dest = modelDestMap[model];
    const fixedPath = filePath.endsWith('.pala') ? filePath.slice(0, -5) + '.jar' : filePath;
    const fullPath = path.join(outputDir, dest, fixedPath);

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    if (fs.existsSync(fullPath)) {
      const stat = fs.statSync(fullPath);
      if (size && stat.size === size) {
        log(`[${id}/${total}] SKIP ${name} (size match)`);
        return;
      }
      try {
        const actualSha1 = await sha1File(fullPath);
        if (actualSha1 === sha1) {
          log(`[${id}/${total}] SKIP ${name} (sha1 OK)`);
          return;
        }
      } catch (_) {}
      log(`[${id}/${total}] UPDATE ${name}`);
    } else {
      log(`[${id}/${total}] QUEUE ${name}`);
    }

    try {
      await downloadWithRetry(url, fullPath);
      const actualSha1 = await sha1File(fullPath);
      if (actualSha1 === sha1) {
        log(`[${id}/${total}] DONE ${name}`);
      } else {
        log(`[${id}/${total}] ERROR ${name} (sha1 mismatch)`);
      }
    } catch (err) {
      log(`[${id}/${total}] FAILED ${name}: ${err.message}`);
    }
  });

  log('All CDN downloads completed.');
}

async function downloadAssets(assetIndexUrl) {
  const outputDir = CONFIG.outputDir;

  log(`Downloading asset index from ${assetIndexUrl}...`);
  const assetIndex = await fetchJson(assetIndexUrl);
  const assetsIndexesDir = path.join(outputDir, 'assets', 'indexes');
  fs.mkdirSync(assetsIndexesDir, { recursive: true });
  fs.writeFileSync(path.join(assetsIndexesDir, '1.7.10.json'), JSON.stringify(assetIndex));
  const objects = assetIndex.objects || {};
  const entries = Object.entries(objects);
  log(`Need to download ${entries.length} assets...`);

  await runConcurrent(entries, async ([name, info], id, total) => {
    const hash = info.hash;
    const assetPath = path.join(outputDir, 'assets', 'objects', hash.slice(0, 2), hash);
    const assetUrl = `${CONFIG.assetsBaseUrl}/${hash.slice(0, 2)}/${hash}`;

    if (fs.existsSync(assetPath)) {
      try {
        const actual = await sha1File(assetPath);
        if (actual === hash) {
          log(`[${id}/${total}] SKIP asset ${name}`);
          return;
        }
      } catch (_) {}
    }

    try {
      fs.mkdirSync(path.dirname(assetPath), { recursive: true });
      await downloadWithRetry(assetUrl, assetPath);
      log(`[${id}/${total}] DONE asset ${name}`);
    } catch (err) {
      log(`[${id}/${total}] FAILED asset ${name}: ${err.message}`);
    }
  });

  log('Assets download completed.');
}

function copyLibrariesToMods() {
  const libDir = path.join(CONFIG.outputDir, 'libraries');
  const modsDir = path.join(CONFIG.outputDir, 'mods');

  if (!fs.existsSync(libDir)) {
    log('libraries folder not found, skipping copy');
    return;
  }

  log('Copying libraries content to mods...');
  fs.mkdirSync(modsDir, { recursive: true });

  for (const entry of fs.readdirSync(libDir)) {
    const srcPath = path.join(libDir, entry);
    if (fs.statSync(srcPath).isDirectory()) continue;
    if (!entry.endsWith('.jar')) continue;
    const destPath = path.join(modsDir, entry);
    if (!fs.existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
  log('Libraries copied to mods.');
}

function renameModsToPala() {
  const modsDir = path.join(CONFIG.outputDir, 'mods');
  if (!fs.existsSync(modsDir)) return;
  const exclude = ['fs-patches.jar'];
  let count = 0;
  for (const entry of fs.readdirSync(modsDir)) {
    if (!entry.endsWith('.jar')) continue;
    if (exclude.includes(entry)) continue;
    const oldPath = path.join(modsDir, entry);
    const newPath = path.join(modsDir, entry.slice(0, -4) + '.pala');
    if (!fs.existsSync(newPath)) {
      fs.renameSync(oldPath, newPath);
      count++;
    }
  }
  log(`Renamed ${count} .jar files to .pala for PalaForge discovery.`);
}

async function downloadFsPatches() {
  const modsDir = path.join(CONFIG.outputDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  const outputPath = path.join(modsDir, 'fs-patches.jar');
  const oldPalaPath = path.join(modsDir, 'fs-patches.pala');

  // Remove old .pala if it exists from previous runs
  if (fs.existsSync(oldPalaPath)) {
    fs.unlinkSync(oldPalaPath);
    log('Removed old fs-patches.pala (must be .jar for resource loading).');
  }

  log('Downloading fs-patches.jar...');
  try {
    await downloadWithRetry(CONFIG.fsPatchesUrl, outputPath);
    log('fs-patches.jar downloaded successfully.');
  } catch (err) {
    log(`FAILED to download fs-patches.jar: ${err.message}`);
    return;
  }

  // Add 'classes' field to mcmod.info so PalaForge discovers the mod and registers its resource domain
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-patch-'));
    fs.writeFileSync(path.join(tmpDir, 'mcmod.info'), JSON.stringify([{
      modid: 'fspatches',
      name: '46Patches',
      description: 'A bunch of patches to make the Paladium Modpack compatible with non-paladium launchers',
      version: 'UNKNOWN-e83ed06-dirty',
      mcversion: '1.7.10',
      url: 'https://codeberg.org/FRAnarchyDev/FS-patches',
      authorList: ['LaCollecteuse'],
      credits: 'The Forge and FML guys, Paladium-pvp.fr for the modpack',
      dependencies: ['palamod'],
      classes: ['dev/anarchy/fspatches/Fspatches.class'],
    }]));
    execSync(`jar uf "${outputPath}" -C "${tmpDir}" mcmod.info`, { stdio: 'pipe' });
    fs.rmSync(tmpDir, { recursive: true });
    log('Patched mcmod.info in fs-patches.jar (added classes field for PalaForge).');
  } catch (patchErr) {
    log(`WARNING: Could not patch mcmod.info: ${patchErr.message}`);
  }
}

async function downloadStandardForge() {
  const forgeDir = path.join(CONFIG.outputDir, 'libraries', 'net', 'minecraftforge', 'forge', '1.7.10-10.13.4.1614-1.7.10');
  const forgeJar = path.join(forgeDir, 'forge-1.7.10-10.13.4.1614-1.7.10-universal.jar');
  if (fs.existsSync(forgeJar)) {
    log('Standard Forge already present, skipping.');
    return;
  }
  log('Downloading standard Forge (required for mod resource loading)...');
  try {
    await downloadWithRetry(CONFIG.standardForgeUrl, forgeJar);
    log('Standard Forge downloaded.');
  } catch (err) {
    log(`FAILED to download standard Forge: ${err.message}`);
  }
}

async function downloadLwjglLinux() {
  const outputDir = CONFIG.outputDir;

  const lwjglFiles = [
    {
      url: 'https://libraries.minecraft.net/org/lwjgl/lwjgl/lwjgl-platform/2.9.4-nightly-20150209/lwjgl-platform-2.9.4-nightly-20150209-natives-linux.jar',
      dest: 'libraries/natives/org/lwjgl/lwjgl/lwjgl-platform/2.9.4-nightly-20150209/lwjgl-platform-2.9.4-nightly-20150209-natives-linux.jar'
    },
    {
      url: 'https://libraries.minecraft.net/net/java/jinput/jinput-platform/2.0.5/jinput-platform-2.0.5-natives-linux.jar',
      dest: 'libraries/natives/net/java/jinput/jinput-platform/2.0.5/jinput-platform-2.0.5-natives-linux.jar'
    },
    {
      url: 'https://libraries.minecraft.net/org/lwjgl/lwjgl/lwjgl/2.9.4-nightly-20150209/lwjgl-2.9.4-nightly-20150209.jar',
      dest: 'libraries/org/lwjgl/lwjgl/lwjgl/2.9.4-nightly-20150209/lwjgl-2.9.4-nightly-20150209.jar'
    },
    {
      url: 'https://libraries.minecraft.net/org/lwjgl/lwjgl/lwjgl_util/2.9.4-nightly-20150209/lwjgl_util-2.9.4-nightly-20150209.jar',
      dest: 'libraries/org/lwjgl/lwjgl/lwjgl_util/2.9.4-nightly-20150209/lwjgl_util-2.9.4-nightly-20150209.jar'
    },
  ];

  log('Downloading LWJGL 2.9.4 Linux natives...');
  for (const f of lwjglFiles) {
    const fullPath = path.join(outputDir, f.dest);
    if (fs.existsSync(fullPath)) {
      log(`SKIP ${path.basename(f.dest)}`);
      continue;
    }
    try {
      await downloadWithRetry(f.url, fullPath);
      log(`DONE ${path.basename(f.dest)}`);
    } catch (err) {
      log(`FAILED ${path.basename(f.dest)}: ${err.message}`);
    }
  }
}

function extractNatives(outputDir) {
  const nativesDir = path.join(outputDir, 'natives');
  if (fs.existsSync(nativesDir)) {
    fs.rmSync(nativesDir, { recursive: true });
  }
  fs.mkdirSync(nativesDir, { recursive: true });

  // Vérifie si unzip est disponible
  try {
    execSync('unzip -v', { stdio: 'ignore' });
  } catch (_) {
    log('WARNING: unzip not found, skipping native extraction. Install it with: sudo pacman -S unzip');
    return;
  }

  const libDir = path.join(outputDir, 'libraries');

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.includes('natives-linux') && entry.endsWith('.jar')) {
        log(`Extracting natives from ${entry}...`);
        try {
          execSync(`unzip -o "${full}" "*.so" -d "${nativesDir}"`, { stdio: 'ignore' });
        } catch (_) {
          // unzip retourne exit code 11 si aucun .so trouvé, on ignore
        }
      }
    }
  }

  walk(libDir);
  log(`Natives extracted to ${nativesDir}`);

  // Log ce qui a été extrait
  if (fs.existsSync(nativesDir)) {
    const extracted = fs.readdirSync(nativesDir);
    if (extracted.length > 0) {
      log(`Found natives: ${extracted.join(', ')}`);
    } else {
      log('WARNING: No .so files were extracted from natives jars!');
    }
  }
}

function findJava8() {
  const javaPaths = [
    'java',
    '/usr/lib/jvm/java-8-openjdk/bin/java',
    '/usr/lib/jvm/jre-8-openjdk/bin/java',
    '/usr/lib/jvm/java-8-openjdk/jre/bin/java',
  ];
  for (const jp of javaPaths) {
    try {
      const out = execSync(`${jp} -version 2>&1`, { encoding: 'utf8' });
      const match = out.match(/(?:openjdk|java) version "(?:1\.)?(\d+)\./);
      if (match) {
        const ver = parseInt(match[1]);
        if (ver === 8) return jp;
      }
    } catch (_) {}
  }
  return null;
}

function buildClasspath(outputDir) {
  const entries = [];

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.jar') || entry.endsWith('.pala')) {
        if (entry.includes('lwjgl') && entry.includes('2.9.1')) continue;
        if (entry.includes('natives')) continue;
        if (entry.includes('palaforge')) continue; // Exclude PalaForge, use standard Forge
        entries.push(full);
      }
    }
  }

  const libDir = path.join(outputDir, 'libraries');
  const versionsDir = path.join(outputDir, 'versions');
  walk(libDir);
  walk(versionsDir);
  // mods/ excluded: Forge auto-discovers mods from this directory

  // Add standard Forge (required for proper mod/resource loading)
  const forgeDir = path.join(outputDir, 'libraries', 'net', 'minecraftforge', 'forge', '1.7.10-10.13.4.1614-1.7.10');
  const forgeJar = path.join(forgeDir, 'forge-1.7.10-10.13.4.1614-1.7.10-universal.jar');
  if (fs.existsSync(forgeJar)) {
    entries.push(forgeJar);
  } else {
    log('WARNING: Standard Forge not found, run --download to fetch it.');
  }

  return entries;
}

function resolveArg(str, vars) {
  return str.replace(/\$\{([^}]+)\}/g, (_, key) => {
    const parts = key.split('.');
    let val = vars;
    for (const p of parts) {
      if (val && typeof val === 'object' && p in val) {
        val = val[p];
      } else {
        log(`WARNING: unknown variable \${${key}}`);
        return '';
      }
    }
    return String(val);
  });
}

function resolveArgs(template, vars) {
  return template.map(arg => resolveArg(arg, vars));
}

function launchGame(javaBin, json, opts) {
  const outputDir = CONFIG.outputDir;
  const nativesDir = path.join(outputDir, 'natives');
  const assetsDir = path.join(outputDir, 'assets');

  const classpath = buildClasspath(outputDir);
  classpath.push(path.join(outputDir, 'versions', '1.7.10', '1.7.10.jar'));

  const vars = {
    username: opts.username || 'Player',
    version: json.name || 'Paladium',
    gameDir: outputDir,
    assetsDir: assetsDir,
    assetIndex: '1.7.10',
    uuid: opts.uuid || crypto.randomUUID(),
    accessToken: opts.accessToken || crypto.randomBytes(16).toString('hex'),
    userProperties: '{}',
    userType: 'mojang',
    game_directory: outputDir,
    options: {
      library: { path: nativesDir },
      memory: { max: opts.maxRam || '2G', min: opts.minRam || '512M' },
    },
  };

  const jvmArgs = resolveArgs(json.arguments.jvm, vars);
  const gameArgs = resolveArgs(json.arguments.game, vars);

  const cpSeparator = process.platform === 'win32' ? ';' : ':';
  const cp = classpath.join(cpSeparator);

  const cmd = [javaBin, ...jvmArgs, '-cp', cp, json.main, ...gameArgs];
  const cmdStr = cmd.map(a => a.includes(' ') ? `"${a}"` : a).join(' ');
  log(`Launching: ${cmdStr.substring(0, 500)}...`);

  const proc = spawn(cmd[0], cmd.slice(1), {
    stdio: 'inherit',
    cwd: outputDir,
  });

  proc.on('exit', code => {
    log(`Minecraft exited with code ${code}`);
    process.exit(code);
  });

  proc.on('error', err => {
    log(`Failed to launch Minecraft: ${err.message}`);
    process.exit(1);
  });
}

async function cmdDownload() {
  log('=== Palamod Downloader ===');
  migrateOutputDir();
  log(`Output directory: ${CONFIG.outputDir}`);

  fs.mkdirSync(CONFIG.outputDir, { recursive: true });

  log('Fetching paladium.json...');
  const json = await fetchJson(CONFIG.paladiumJsonUrl);

  const isMac = process.platform === 'darwin';
  const modelDestMap = {};
  for (const m of json.models) {
    modelDestMap[m.name] = m.dest;
  }

  const filteredFiles = json.files.filter(f => {
    const fo = f.os || [];
    const mo = (json.models.find(m => m.name === f.model) || {}).os || [];
    if (fo.includes('MACOS') || mo.includes('MACOS')) return isMac;
    return true;
  });

  log(`Total files in CDN: ${json.files.length}`);
  log(`Files for this OS: ${filteredFiles.length}`);

  await downloadCdnFiles(filteredFiles, modelDestMap);
  await downloadStandardForge();
  await downloadLwjglLinux();
  await downloadAssets(json.assetIndex);
  await downloadFsPatches();

  log('');
  log('=== Download complete! ===');
  log(`Palamod files are in: ${CONFIG.outputDir}`);
}

function loadSettings() {
  const settingsPath = path.join(__dirname, 'templates', 'settings.json');
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    return null;
  }
}

async function cmdLaunch() {
  log('=== Palamod Launcher ===');
  migrateOutputDir();

  const settings = loadSettings();
  const activePlayer = settings?.players?.find(p => p.active);

  const opts = {
    username: activePlayer?.pseudo || 'Player',
    maxRam: settings?.memMax ? settings.memMax + 'M' : '2G',
    minRam: settings?.memMin ? settings.memMin + 'M' : '512M',
    uuid: activePlayer?.uuid || '',
    accessToken: activePlayer?.token || '',
  };

  const args = process.argv.slice(3);
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--username': opts.username = args[++i] || 'Player'; break;
      case '--max-ram': opts.maxRam = args[++i] || '2G'; break;
      case '--min-ram': opts.minRam = args[++i] || '512M'; break;
      case '--uuid': opts.uuid = args[++i] || ''; break;
      case '--token': opts.accessToken = args[++i] || ''; break;
    }
  }

  log(`Username: ${opts.username}`);
  log(`RAM: ${opts.minRam} - ${opts.maxRam}`);

  const javaBin = findJava8();
  if (!javaBin) {
    log('ERROR: Java 8 not found. Install jre8-openjdk first.');
    log('  Arch Linux:  sudo pacman -S jre8-openjdk');
    log('  Debian/Ubuntu: sudo apt install openjdk-8-jre');
    process.exit(1);
  }
  log(`Using Java: ${javaBin}`);

  const outputDir = CONFIG.outputDir;
  if (!fs.existsSync(path.join(outputDir, 'versions', '1.7.10', '1.7.10.jar'))) {
    log('ERROR: Game files not found. Run with --download first.');
    process.exit(1);
  }

  // Extraction des natives avant chaque lancement
  extractNatives(outputDir);

  log('Fetching paladium.json for launch config...');
  const json = await fetchJson(CONFIG.paladiumJsonUrl);

  launchGame(javaBin, json, opts);
}

async function main() {
  const mode = process.argv[2];

  if (mode === '--download') {
    await cmdDownload();
  } else if (mode === '--launch') {
    await cmdLaunch();
  } else {
    console.log('Palamod Launcher');
    console.log('');
    console.log('Usage:');
    console.log('  node launcher.js --download              Download all game files');
    console.log('  node launcher.js --launch [options]      Launch the game');
    console.log('');
    console.log('Launch options:');
    console.log('  --username <name>    Minecraft username (default: Player)');
    console.log('  --max-ram <size>     Max RAM (default: 2G)');
    console.log('  --min-ram <size>     Min RAM (default: 512M)');
    console.log('  --uuid <uuid>        Player UUID');
    console.log('  --token <token>      Access token');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});