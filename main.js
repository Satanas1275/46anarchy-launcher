const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'templates', 'index.html'));
  mainWindow.setMenu(null);
}

function isGameInstalled() {
  return fs.existsSync(path.join(__dirname, 'paladium', 'versions', '1.7.10', '1.7.10.jar'));
}

ipcMain.handle('get-game-status', () => {
  return { installed: isGameInstalled() };
});

ipcMain.handle('install-game', async () => {
  const launcherPath = path.join(__dirname, 'launcher.js');
  const proc = spawn('node', [launcherPath, '--download'], {
    stdio: 'inherit',
    cwd: __dirname,
  });

  return new Promise((resolve) => {
    proc.on('exit', (code) => {
      resolve({ success: code === 0, error: code !== 0 ? 'Install failed' : undefined });
    });
  });
});

const settingsPath = () => path.join(__dirname, 'templates', 'settings.json');

ipcMain.handle('get-settings', () => {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
  } catch {
    return { memMin: '1024', memMax: '2048', players: [] };
  }
});

ipcMain.handle('save-settings', (_, data) => {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(data, null, 4), 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('launch-game', async () => {
  const settingsPath = path.join(__dirname, 'templates', 'settings.json');
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    return { error: 'settings.json not found' };
  }

  const activePlayer = settings.players?.find(p => p.active);
  if (!activePlayer?.pseudo) {
    return { error: 'No active player configured' };
  }

  const launcherPath = path.join(__dirname, 'launcher.js');
  const args = [
    launcherPath,
    '--launch',
    '--username', activePlayer.pseudo,
    '--uuid', activePlayer.uuid || '',
    '--token', activePlayer.token || '',
    '--max-ram', (settings.memMax || '2048') + 'M',
    '--min-ram', (settings.memMin || '1024') + 'M',
  ];

  const proc = spawn('node', args, {
    cwd: __dirname,
  });

  proc.stdout.on('data', (data) => {
    const output = data.toString();
    process.stdout.write(output);
    if (output.includes('FontRenderer') && output.includes('loaded')) {
      mainWindow?.webContents.send('game-status', 'playing');
    }
  });

  proc.stderr.on('data', (data) => {
    process.stderr.write(data);
  });

  proc.on('close', () => {
    mainWindow?.webContents.send('game-status', 'offline');
  });

  return { pid: proc.pid };
});

const MC_CLIENT_ID = '13f589e1-e2fc-443e-a68a-63b0092b8eeb';

function httpsPost(url, data, formUrlencoded = false) {
  return new Promise((resolve, reject) => {
    let body;
    let contentType;
    if (formUrlencoded) {
      body = Object.entries(data).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      contentType = 'application/x-www-form-urlencoded';
    } else {
      body = JSON.stringify(data);
      contentType = 'application/json';
    }
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, res => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        console.log('HTTP', res.statusCode, url, body.substring(0, 500));
        try { resolve(JSON.parse(body)); }
        catch { resolve(body); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(url, token) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: token ? { Authorization: 'Bearer ' + token } : {}
    };
    https.get(url, options, res => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve(Buffer.concat(chunks).toString()); }
      });
    }).on('error', reject);
  });
}

async function exchangeCode(code, redirectUri) {
  const tokenRes = await httpsPost(
    'https://login.live.com/oauth20_token.srf',
    {
      client_id: MC_CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    },
    true
  );

  console.log('Token response:', JSON.stringify(tokenRes));
  if (!tokenRes.access_token) throw new Error('No access token: ' + JSON.stringify(tokenRes));

  const msToken = tokenRes.access_token;

  const xblRes = await httpsPost('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 'd=' + msToken },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  });
  console.log('XBL response:', JSON.stringify(xblRes));
  const xblToken = xblRes.Token;

  const xstsRes = await httpsPost('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  });
  console.log('XSTS response:', JSON.stringify(xstsRes));
  const xstsToken = xstsRes.Token;
  const userHash = xstsRes.DisplayClaims?.xui?.[0]?.uhs;
  if (!userHash) throw new Error('No user hash in XSTS response: ' + JSON.stringify(xstsRes));

  const mcRes = await httpsPost('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${userHash};${xstsToken}`,
  });
  const mcToken = mcRes.access_token;

  const profile = await httpsGet('https://api.minecraftservices.com/minecraft/profile', mcToken);
  if (!profile.id || !profile.name) throw new Error('No Minecraft profile found');

  return { uuid: profile.id, pseudo: profile.name, token: mcToken, refreshToken: tokenRes.refresh_token };
}

async function microsoftAuth() {
  return new Promise((resolve, reject) => {
    let codeReceived = false;
    const redirectUri = 'https://login.live.com/oauth20_desktop.srf';
    const authUrl = 'https://login.live.com/oauth20_authorize.srf?client_id=13f589e1-e2fc-443e-a68a-63b0092b8eeb&response_type=code&redirect_uri=https%3A%2F%2Flogin.live.com%2Foauth20_desktop.srf&scope=XboxLive.signin%20offline_access&cobrandid=8058f65d-ce06-4c30-9559-473c9275a65d&prompt=select_account';

    const authWindow = new BrowserWindow({
      width: 500,
      height: 700,
      webPreferences: { nodeIntegration: false }
    });

    authWindow.loadURL(authUrl);

    authWindow.webContents.on('did-navigate', (_, url) => {
      console.log('Navigated to:', url);
      const parsed = new URL(url);
      const code = parsed.searchParams.get('code');
      console.log('URL:', url, 'Code:', code);
      if (code && !codeReceived) {
        codeReceived = true;
        authWindow.close();
        exchangeCode(code, redirectUri).then(resolve).catch(reject);
      }
    });

    authWindow.on('closed', () => {
      if (!codeReceived) {
        reject(new Error('Auth window closed'));
      }
    });
  });
}

ipcMain.handle('auth-login', async () => {
  try {
    const account = await microsoftAuth();
    const settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
    if (!settings.players) settings.players = [];

    const existing = settings.players.find(p => p.uuid === account.uuid);
    if (existing) {
      existing.pseudo = account.pseudo;
      existing.token = account.token;
      existing.refreshToken = account.refreshToken;
      existing.active = true;
      settings.players.forEach(p => { if (p !== existing) p.active = false; });
    } else {
      settings.players.forEach(p => p.active = false);
      settings.players.push({ pseudo: account.pseudo, token: account.token, refreshToken: account.refreshToken, uuid: account.uuid, active: true });
    }

    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 4), 'utf-8');
    return { success: true, account };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('auth-logout', async (_, uuid) => {
  const settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
  if (!settings.players) return { success: true };
  const player = settings.players.find(p => p.uuid === uuid);
  if (player) {
    player.token = '';
    player.active = false;
  }
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 4), 'utf-8');
  return { success: true };
});

ipcMain.handle('auth-remove', async (_, uuid) => {
  const settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
  if (!settings.players) return { success: true };
  settings.players = settings.players.filter(p => p.uuid !== uuid);
  if (settings.players.length > 0 && !settings.players.some(p => p.active)) {
    settings.players[0].active = true;
  }
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 4), 'utf-8');
  return { success: true };
});

ipcMain.handle('auth-set-active', async (_, uuid) => {
  const settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
  if (!settings.players) return { success: true };
  settings.players.forEach(p => p.active = p.uuid === uuid);
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 4), 'utf-8');
  return { success: true, pseudo: settings.players.find(p => p.uuid === uuid)?.pseudo };
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
