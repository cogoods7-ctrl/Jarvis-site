// ── Crash guard ──
process.on('uncaughtException', err => {
  if (['EIO','EPIPE','ERR_STREAM_DESTROYED'].includes(err.code)) return;
  try {
    require('fs').appendFileSync(
      require('path').join(require('os').homedir(), 'jarvis-error.log'),
      `${new Date().toISOString()} ${err.stack||err}\n`
    );
  } catch(e) {}
});
process.on('unhandledRejection', ()=>{});
process.stdout.on('error', ()=>{});
process.stderr.on('error', ()=>{});

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path  = require('path');
const os    = require('os');
const fs    = require('fs');
const https = require('https');
const { exec, spawn } = require('child_process');
const readline = require('readline');

const IS_WIN = process.platform === 'win32';
const LOG = path.join(os.homedir(), 'jarvis.log');
function log(m) {
  try { fs.appendFileSync(LOG, `[${new Date().toLocaleTimeString()}] ${m}\n`); } catch(e) {}
}

if (!app.requestSingleInstanceLock()) { app.exit(0); }
app.on('window-all-closed', e => {
  if (orbWin && !orbWin.isDestroyed()) e.preventDefault();
});

// ── State ──
let orbWin        = null;
let visionWin     = null;
let listenerProc  = null;
let listenerReady = false;
let isAwake       = false;
let awakeTimer    = null;
let isSpeaking    = false;
let speakProc     = null;
let speakTimer    = null;
let lastSpeakEnd  = 0;
let userName      = 'Sir';
let isQuitting    = false;
let visionOpen    = false;

// ── Settings ──
const SPATH = path.join(app.getPath('userData'), 'jarvis-settings.json');
function loadS()  { try { return JSON.parse(fs.readFileSync(SPATH, 'utf8')); } catch { return {}; } }
function saveS(d) { try { fs.writeFileSync(SPATH, JSON.stringify(d, null, 2)); } catch(e) {} }
function initS()  { userName = loadS().userName || 'Sir'; }

// ─────────────────────────────────────────────
//  TTS — Windows uses PowerShell SAPI
// ─────────────────────────────────────────────
function speak(text, onDone) {
  if (speakTimer)  { clearTimeout(speakTimer); speakTimer = null; }
  if (speakProc)   { try { speakProc.kill('SIGKILL'); } catch(e) {} speakProc = null; }
  isSpeaking = true;
  setState('speaking');
  log(`SPEAK: ${text}`);

  // Escape single quotes for PowerShell
  const safe = text.replace(/'/g, "''");
  speakProc = spawn('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 1; $s.Speak('${safe}')`
  ], { stdio: 'ignore', windowsHide: true });

  let done = false;
  function finish() {
    if (done) return; done = true;
    if (speakTimer) { clearTimeout(speakTimer); speakTimer = null; }
    isSpeaking = false; speakProc = null;
    lastSpeakEnd = Date.now();
    setState(isAwake ? 'awake' : 'standby');
    if (onDone) onDone();
  }
  speakProc.on('close', finish);
  speakProc.on('exit',  finish);
  speakProc.on('error', finish);
  speakTimer = setTimeout(finish, Math.min(text.split(' ').length * 900 + 4000, 28000));
}

// ─────────────────────────────────────────────
//  RUN POWERSHELL COMMAND
// ─────────────────────────────────────────────
function runPS(cmd, cb) {
  exec(`powershell -NoProfile -NonInteractive -Command "${cmd.replace(/"/g, '\\"')}"`,
    { timeout: 10000, windowsHide: true },
    (err, out) => {
      if (cb) cb(err, (out || '').trim());
    }
  );
}

// ─────────────────────────────────────────────
//  LISTENER stdin
// ─────────────────────────────────────────────
function tellListener(msg) {
  if (!listenerProc || !listenerReady) return;
  try { listenerProc.stdin.write(msg + '\n'); } catch(e) {}
}

// ─────────────────────────────────────────────
//  WAKE / SLEEP
// ─────────────────────────────────────────────
function setState(s) { try { orbWin?.webContents.send('set-state', s); } catch(e) {} }

let wakeDebounce = false;
function wake() {
  if (isAwake || wakeDebounce) return;
  wakeDebounce = true;
  setTimeout(() => { wakeDebounce = false; }, 4000);
  isAwake = true;
  setState('awake');
  log('AWAKE');
  tellListener('AWAKE');
  getBat(bat => {
    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    speak(`Hello ${userName}. The time is ${t}. Battery at ${bat}. I am ready.`);
    resetAwakeTimer();
  });
}

function sleep(goodbye = true) {
  isAwake = false;
  clearTimeout(awakeTimer);
  setState('standby');
  tellListener('SLEEP');
  log('SLEEP');
  if (goodbye) speak(`Standing by. Goodbye, ${userName}.`);
}

function resetAwakeTimer() {
  clearTimeout(awakeTimer);
  awakeTimer = setTimeout(() => sleep(false), 5 * 60 * 1000);
}

// ─────────────────────────────────────────────
//  BATTERY — Windows wmic
// ─────────────────────────────────────────────
function getBat(cb) {
  exec('wmic path win32_battery get EstimatedChargeRemaining /value',
    { windowsHide: true },
    (err, out) => {
      if (err || !out.trim()) return cb('unknown');
      const m = out.match(/EstimatedChargeRemaining=(\d+)/);
      cb(m ? m[1] + '%' : 'unknown');
    }
  );
}

// ─────────────────────────────────────────────
//  OPEN APP — Windows start command
// ─────────────────────────────────────────────
function openApp(name) {
  // Try start "" "AppName" first, then search common paths
  exec(`start "" "${name.replace(/"/g, '')}"`, { windowsHide: true }, err => {
    if (err) {
      // Fallback: PowerShell Start-Process
      runPS(`Start-Process '${name.replace(/'/g, '')}'`, err2 => {
        if (err2) speak(`I couldn't find ${name}, ${userName}.`);
      });
    }
  });
}

function quitApp(name) {
  exec(`taskkill /F /IM "${name.replace(/"/g,'')}.exe"`, { windowsHide: true }, err => {
    if (err) {
      runPS(`Stop-Process -Name '${name.replace(/'/g,'')}' -Force`, () => {});
    }
  });
}

function openURL(url) {
  exec(`start "" "${url.replace(/"/g, '')}"`);
}

function openInBrowser(url, browserName) {
  const browsers = {
    'chrome':  'chrome',
    'firefox': 'firefox',
    'edge':    'msedge',
    'brave':   'brave',
  };
  const exe = browsers[browserName.toLowerCase()];
  if (exe) exec(`start ${exe} "${url}"`, { windowsHide: true });
  else openURL(url);
}

function openTab(q, search = false) {
  const url = search || !q.match(/\.(com|net|org|io|co|app|dev)\b/i)
    ? `https://www.google.com/search?q=${encodeURIComponent(q)}`
    : (q.startsWith('http') ? q : `https://${q}`);
  openURL(url);
}

// ─────────────────────────────────────────────
//  MEDIA — Windows media keys via PowerShell
// ─────────────────────────────────────────────
let mediaCooldown = false;

// Virtual key codes for media keys
const MEDIA_KEYS = {
  play:  0xB3,  // VK_MEDIA_PLAY_PAUSE
  next:  0xB0,  // VK_MEDIA_NEXT_TRACK
  prev:  0xB1,  // VK_MEDIA_PREV_TRACK
  stop:  0xB2,  // VK_MEDIA_STOP
  vUp:   0xAF,  // VK_VOLUME_UP
  vDown: 0xAE,  // VK_VOLUME_DOWN
  mute:  0xAD,  // VK_VOLUME_MUTE
};

function mediaControl(action) {
  if (mediaCooldown) return;
  mediaCooldown = true;
  setTimeout(() => { mediaCooldown = false; }, 2000);

  const vk = MEDIA_KEYS[action];
  if (vk) {
    // Simulate media key press via PowerShell
    const ps = `
$wsh = New-Object -ComObject WScript.Shell
$wsh.SendKeys([char]${vk})`;
    // Use the more reliable keybd_event approach
    const psCmd = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class MediaKey {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
}
"@
[MediaKey]::keybd_event(${vk}, 0, 0, 0)
[MediaKey]::keybd_event(${vk}, 0, 2, 0)`;
    runPS(psCmd, err => {
      if (err) log(`Media ${action} err: ${err.message}`);
    });
  }
}

// ─────────────────────────────────────────────
//  DND — Windows Focus Assist via registry
// ─────────────────────────────────────────────
function setDND(enable, cb) {
  // 0 = off, 1 = priority only, 2 = alarms only
  const val = enable ? '1' : '0';
  const cmd = `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CloudStore\\Store\\DefaultAccount\\Current\\default$windows.data.notifications.quiethourssettings\\windows.data.notifications.quiethourssettings' -Name 'Data' -Type Binary -Value ([byte[]](0x02,0x00,0x00,0x00)) -Force`;
  // Simpler approach: toggle via registry value
  runPS(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings" /v "NOC_GLOBAL_SETTING_ALLOW_TOASTS_ABOVE_LOCK" /t REG_DWORD /d ${enable ? 0 : 1} /f`, (err) => {
    if (cb) cb(err);
    log(`DND ${enable ? 'on' : 'off'}: ${err ? err.message : 'ok'}`);
  });
}

// ─────────────────────────────────────────────
//  LOCK SCREEN — Windows
// ─────────────────────────────────────────────
function lockScreen() {
  exec('rundll32.exe user32.dll,LockWorkStation', { windowsHide: true });
}

// ─────────────────────────────────────────────
//  BRIGHTNESS — Windows WMI
// ─────────────────────────────────────────────
function adjustBrightness(dir) {
  runPS(`
$brightness = (Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness).CurrentBrightness
$new = [Math]::Min(100, [Math]::Max(0, $brightness ${dir === 'up' ? '+' : '-'} 15))
Invoke-CimMethod -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -MethodName WmiSetBrightness -Arguments @{Timeout=1; Brightness=$new}`,
    (err) => { if (err) log('Brightness err: '+err.message); }
  );
}

// ─────────────────────────────────────────────
//  SCREENSHOT — Windows
// ─────────────────────────────────────────────
function screenshot() {
  const d = path.join(os.homedir(), 'Desktop', `jarvis-${Date.now()}.png`);
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$bmp.Save('${d.replace(/\\/g, '\\\\')}')`;
  runPS(ps, err => speak(err ? `Screenshot failed, ${userName}.` : `Screenshot saved to Desktop, ${userName}.`));
}

// ─────────────────────────────────────────────
//  TRANSLATION
// ─────────────────────────────────────────────
const LANG_CODES = {
  'spanish':'es','french':'fr','german':'de','italian':'it',
  'portuguese':'pt','japanese':'ja','korean':'ko','chinese':'zh',
  'arabic':'ar','hindi':'hi','russian':'ru','dutch':'nl',
  'swedish':'sv','polish':'pl','turkish':'tr','greek':'el',
  'hebrew':'he','thai':'th','vietnamese':'vi','indonesian':'id',
  'latin':'la','ukrainian':'uk','czech':'cs','romanian':'ro',
};

function httpsGet(url, cb) {
  https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => cb(null, d));
  }).on('error', e => cb(e, null));
}

function translate(phrase, toLang, cb) {
  const code    = LANG_CODES[toLang.toLowerCase()] || toLang.slice(0, 2).toLowerCase();
  const encoded = encodeURIComponent(phrase);
  const url1    = `https://api.mymemory.translated.net/get?q=${encoded}&langpair=en|${code}&de=jarvis@local.com`;
  httpsGet(url1, (err, body) => {
    if (!err && body) {
      try {
        const j = JSON.parse(body);
        if (j.responseStatus === 200 && j.responseData?.translatedText) {
          const r = j.responseData.translatedText;
          if (!r.includes('PLEASE SELECT') && !r.includes('INVALID') && r !== phrase) return cb(null, r);
        }
      } catch(e) {}
    }
    httpsGet(`https://lingva.ml/api/v1/en/${code}/${encoded}`, (err2, body2) => {
      if (!err2 && body2) {
        try {
          const j2 = JSON.parse(body2);
          if (j2.translation && j2.translation !== phrase) return cb(null, j2.translation);
        } catch(e) {}
      }
      cb(new Error('failed'), null);
    });
  });
}

// ─────────────────────────────────────────────
//  DEFINE
// ─────────────────────────────────────────────
function define(word, cb) {
  const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.trim().toLowerCase())}`;
  https.get(url, res => {
    let d = ''; res.on('data', c => d += c);
    res.on('end', () => {
      try {
        const j = JSON.parse(d);
        if (Array.isArray(j) && j[0]?.meanings?.[0]?.definitions?.[0]) {
          const m = j[0].meanings[0];
          cb(null, `${word}: ${m.partOfSpeech ? m.partOfSpeech+'. ' : ''}${m.definitions[0].definition}`);
        } else cb(null, null);
      } catch(e) { cb(e, null); }
    });
  }).on('error', e => cb(e, null));
}

// ─────────────────────────────────────────────
//  CALCULATE
// ─────────────────────────────────────────────
function calculate(raw) {
  let expr = raw.toLowerCase()
    .replace(/\bplus\b/g,'+').replace(/\bminus\b/g,'-')
    .replace(/\btimes\b|\bmultiplied by\b/g,'*')
    .replace(/\bdivided by\b|\bover\b/g,'/')
    .replace(/\bto the power of\b|\braised to\b/g,'**')
    .replace(/\bsquared\b/g,'**2').replace(/\bcubed\b/g,'**3')
    .replace(/\bpercent of\b/g,'/100*').replace(/\bpercent\b/g,'/100')
    .replace(/\bpi\b/g,'3.14159265358979')
    .replace(/[^0-9+\-*/.() **]/g,'').trim();
  if (!expr) return null;
  try {
    const r = Function(`"use strict"; return (${expr})`)();
    return typeof r === 'number' && isFinite(r) ? parseFloat(r.toFixed(10)).toString() : null;
  } catch(e) { return null; }
}

// ─────────────────────────────────────────────
//  TYPE TEXT — Windows SendKeys
// ─────────────────────────────────────────────
function typeText(text) {
  const safe = text.replace(/'/g, "''");
  runPS(`$wsh = New-Object -ComObject WScript.Shell; $wsh.SendKeys('${safe}')`, err => {
    if (err) log('Type err: '+err.message);
  });
}

// ─────────────────────────────────────────────
//  NOW PLAYING — Windows Media Player / Spotify
// ─────────────────────────────────────────────
function nowPlaying(cb) {
  // Check Spotify window title which shows "Artist - Song"
  runPS(`(Get-Process spotify -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowTitle -ne 'Spotify'}).MainWindowTitle`, (err, out) => {
    if (!err && out && out.trim() && out.trim() !== 'Spotify') {
      return cb(null, out.trim(), 'Spotify');
    }
    cb(new Error('none'), null, '');
  });
}

// ─────────────────────────────────────────────
//  WEATHER
// ─────────────────────────────────────────────
function getWeather(cb) {
  https.get('https://wttr.in/?format=%C+%t&m', { headers: { 'User-Agent': 'curl/7.0' } }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => cb(null, d.trim()));
  }).on('error', e => cb(e, null));
}

// ─────────────────────────────────────────────
//  CREATE NOTE — Windows Notepad workaround
//  (saves to Desktop as .txt)
// ─────────────────────────────────────────────
function createNote(content) {
  const d = path.join(os.homedir(), 'Desktop', `jarvis-note-${Date.now()}.txt`);
  fs.writeFileSync(d, content, 'utf8');
  exec(`start notepad "${d}"`, { windowsHide: true });
}

// ─────────────────────────────────────────────
//  SELF DESTRUCT
// ─────────────────────────────────────────────
function selfDestruct() {
  isQuitting = true;
  speak(`Initiating self destruct sequence. 5.`);
  setTimeout(() => speak(`4.`), 1800);
  setTimeout(() => speak(`3.`), 3400);
  setTimeout(() => speak(`2.`), 4900);
  setTimeout(() => speak(`1.`), 6400);
  setTimeout(() => {
    speak(`Goodbye, ${userName}.`, () => {
      try { orbWin?.webContents.send('self-destruct'); } catch(e) {}
      if (listenerProc) { try { listenerProc.kill('SIGKILL'); } catch(e) {} }
      if (visionWin && !visionWin.isDestroyed()) { try { visionWin.destroy(); } catch(e) {} }
      setTimeout(() => app.exit(0), 1200);
    });
  }, 7800);
}

// ─────────────────────────────────────────────
//  APP / WEB MAPS
// ─────────────────────────────────────────────
const APPS = {
  'chrome':'Google Chrome','google chrome':'Google Chrome',
  'firefox':'Firefox','edge':'Microsoft Edge','brave':'Brave',
  'notepad':'Notepad','notes':'Notepad','calculator':'Calculator',
  'explorer':'explorer','file explorer':'explorer','finder':'explorer',
  'spotify':'Spotify','discord':'Discord','slack':'Slack',
  'zoom':'Zoom','teams':'Microsoft Teams','microsoft teams':'Microsoft Teams',
  'word':'WINWORD','excel':'EXCEL','powerpoint':'POWERPNT',
  'outlook':'OUTLOOK','onenote':'ONENOTE',
  'vscode':'Code','vs code':'Code','visual studio code':'Code','cursor':'Cursor',
  'paint':'mspaint','snipping tool':'SnippingTool',
  'task manager':'Taskmgr','settings':'ms-settings:',
  'control panel':'control','cmd':'cmd','powershell':'powershell',
  'notion':'Notion','figma':'Figma','obsidian':'Obsidian',
  'steam':'Steam','epic games':'EpicGamesLauncher',
  'whatsapp':'WhatsApp','telegram':'Telegram',
  'vlc':'vlc','itunes':'iTunes',
};

const WEB = {
  'youtube':'https://www.youtube.com','netflix':'https://www.netflix.com',
  'gmail':'https://mail.google.com','google':'https://www.google.com',
  'twitter':'https://www.twitter.com','instagram':'https://www.instagram.com',
  'reddit':'https://www.reddit.com','github':'https://www.github.com',
  'amazon':'https://www.amazon.com','hulu':'https://www.hulu.com',
  'disney plus':'https://www.disneyplus.com','disney':'https://www.disneyplus.com',
  'twitch':'https://www.twitch.tv','chatgpt':'https://chat.openai.com',
  'claude ai':'https://claude.ai',
};

function resolveApp(raw) {
  const c = raw.toLowerCase().replace(/\b(the|my|app|application|please)\b/g,'').replace(/\s+/g,' ').trim();
  if (APPS[c]) return APPS[c];
  for (const [k,v] of Object.entries(APPS)) { if (c.includes(k)||k.includes(c)) return v; }
  return c.split(' ').filter(w=>!['the','my','app','a','an'].includes(w)).map(w=>w[0].toUpperCase()+w.slice(1)).join(' ');
}

function has(cmd, kws) { return kws.some(k => cmd.includes(k)); }

function parseDur(t) {
  const s=t.toLowerCase(); let tot=0;
  const h=s.match(/(\d+|an?)\s*hour/),m=s.match(/(\d+|an?)\s*min/),sc=s.match(/(\d+)\s*sec/);
  const n=x=>!x?0:(x==='a'||x==='an'?1:parseInt(x)||0);
  if(h) tot+=n(h[1])*3600; if(m) tot+=n(m[1])*60; if(sc) tot+=n(sc[1]);
  return tot;
}

function humanDur(s) {
  if(s>=3600){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60);return m?`${h} hour${h>1?'s':''} and ${m} minute${m>1?'s':''}` :`${h} hour${h>1?'s':''}`;}
  if(s>=60){const m=Math.floor(s/60),sc=s%60;return sc?`${m} minute${m>1?'s':''} and ${sc} second${sc>1?'s':''}` :`${m} minute${m>1?'s':''}`;}
  return `${s} second${s!==1?'s':''}`;
}

// ─────────────────────────────────────────────
//  COMMAND HANDLER
// ─────────────────────────────────────────────
function handle(rawText) {
  const raw = rawText.trim();
  const cmd = raw.toLowerCase();
  log(`CMD: "${cmd}"`);

  // Vision
  if (has(cmd,['what do you see','open camera','open vision','activate vision'])) {
    if (!visionOpen) { openVision(); speak(`Opening vision, ${userName}.`); setTimeout(()=>{ try{visionWin?.webContents.send('analyze-now');}catch(e){} },2500); }
    else { speak(`Analyzing, ${userName}.`); try{visionWin?.webContents.send('analyze-now');}catch(e){} }
    return true;
  }
  if (has(cmd,['close camera','close vision','stop camera','hide camera'])) {
    closeVision(); speak(`Vision closed, ${userName}.`); return true;
  }

  // Self destruct
  if (has(cmd,['self destruct','initiate self destruct','activate self destruct'])) {
    selfDestruct(); return true;
  }

  // Quit app — before open so "close X" works
  const quitM = cmd.match(/^(?:quit|close|kill|exit|shut down|force quit|end)\s+(.+)/);
  if (quitM) {
    const appRaw = quitM[1].replace(/[.!?]$/,'').trim();
    if (['camera','vision','the camera'].includes(appRaw)) { closeVision(); speak(`Vision closed, ${userName}.`); return true; }
    const appName = resolveApp(appRaw);
    speak(`Closing ${appName}, ${userName}.`);
    setTimeout(() => quitApp(appName), 500);
    return true;
  }

  // Sleep
  if (has(cmd,['sleep mode','go to sleep','go to standby','standby mode','sleep jarvis','goodbye','good night','that\'s all'])) {
    sleep(true); return true;
  }

  // Lock screen
  if (has(cmd,['lock my screen','lock screen','lock the screen','lock computer','lock pc'])) {
    speak(`Locking your screen, ${userName}.`); setTimeout(lockScreen, 800); return true;
  }

  // Brightness
  if (has(cmd,['brightness up','brighter','increase brightness','turn up brightness'])) {
    speak(`Increasing brightness, ${userName}.`); adjustBrightness('up'); return true;
  }
  if (has(cmd,['brightness down','dimmer','decrease brightness','turn down brightness','lower brightness'])) {
    speak(`Decreasing brightness, ${userName}.`); adjustBrightness('down'); return true;
  }

  // Translate
  const transM = cmd.match(/translate (.+?) (?:to|into) (\w+)/) ||
                 cmd.match(/how (?:do you say|to say) (.+?) in (\w+)/);
  if (transM && LANG_CODES[transM[2].toLowerCase()]) {
    const phrase=transM[1].trim(), lang=transM[2].trim();
    speak(`Translating to ${lang}, ${userName}.`);
    translate(phrase, lang, (err, r) => speak(err||!r?`Translation failed, ${userName}.`:`${phrase} in ${lang} is: ${r}, ${userName}.`));
    return true;
  }

  // Define
  const defM = cmd.match(/^define (.+)/) || cmd.match(/what does (.+?) mean/) || cmd.match(/what is the definition of (.+)/);
  if (defM) {
    const word=defM[1].replace(/[.!?]$/,'').trim();
    speak(`Looking up ${word}, ${userName}.`);
    define(word, (err,r) => speak(err||!r?`Couldn't find a definition, ${userName}.`:`${r}, ${userName}.`));
    return true;
  }

  // Calculate
  const calcM = cmd.match(/^(?:calculate|compute|what is|what's|how much is|solve) (.+)/);
  if (calcM) {
    const expr=calcM[1].replace(/[.!?]$/,'').trim(), r=calculate(expr);
    speak(r!==null?`${expr} equals ${r}, ${userName}.`:`I couldn't calculate that, ${userName}.`);
    return true;
  }

  // Type
  const typeM = cmd.match(/(?:^|\s)type\s+(.+)/);
  if (typeM) {
    const text=typeM[1].replace(/[.!?]$/,'').trim();
    speak(`Typing now, ${userName}.`); setTimeout(()=>typeText(text),1200); return true;
  }

  // Open in specific browser
  const browserM = cmd.match(/open (.+?) in (chrome|firefox|edge|brave)/);
  if (browserM) {
    const dest=browserM[1].trim(), browser=browserM[2].trim();
    speak(`Opening ${dest} in ${browser}, ${userName}.`);
    const wk=Object.keys(WEB).find(k=>dest.includes(k));
    const url=wk?WEB[wk]:(dest.match(/^https?:\/\//)?dest:`https://${dest}`);
    setTimeout(()=>openInBrowser(url,browser),600); return true;
  }

  // Media
  if (has(cmd,['play music','play spotify','resume music','start music','start playing','resume playback'])) {
    speak(`Playing, ${userName}.`); setTimeout(()=>mediaControl('play'),400); return true;
  }
  if (has(cmd,['pause music','stop music','stop the music','pause the music','pause playback'])) {
    speak(`Pausing, ${userName}.`); setTimeout(()=>mediaControl('play'),400); return true;
  }
  if (has(cmd,['next song','next track','skip song','skip track','skip this'])) {
    speak(`Next track, ${userName}.`); setTimeout(()=>mediaControl('next'),400); return true;
  }
  if (has(cmd,['previous song','previous track','last song','go back','last track'])) {
    speak(`Going back, ${userName}.`); setTimeout(()=>mediaControl('prev'),400); return true;
  }
  if (has(cmd,['volume up','louder','turn it up','increase volume'])) {
    speak(`Louder, ${userName}.`); setTimeout(()=>mediaControl('vUp'),400); return true;
  }
  if (has(cmd,['volume down','quieter','turn it down','lower the volume'])) {
    speak(`Quieter, ${userName}.`); setTimeout(()=>mediaControl('vDown'),400); return true;
  }
  if (cmd.includes('unmute')) { speak(`Unmuted, ${userName}.`); setTimeout(()=>mediaControl('unmute'),400); return true; }
  if (cmd.includes('mute'))   { speak(`Muted, ${userName}.`);   setTimeout(()=>mediaControl('mute'),400);   return true; }

  // DND
  if (has(cmd,['do not disturb','don\'t disturb','dnd','enable focus','turn on focus'])) {
    speak(`Enabling Do Not Disturb, ${userName}.`); setDND(true, ()=>{}); return true;
  }
  if (has(cmd,['turn off do not disturb','disable focus','turn off focus','disable dnd'])) {
    speak(`Disabling Do Not Disturb, ${userName}.`); setDND(false, ()=>{}); return true;
  }

  // Site search
  const sm=cmd.match(/(?:search|look up|find)\s+(.+?)\s+on\s+(.+)/);
  if (sm) {
    const [,q,site]=sm;
    const smap={'youtube':'https://www.youtube.com/results?search_query=','google':'https://www.google.com/search?q=','reddit':'https://www.reddit.com/search/?q=','amazon':'https://www.amazon.com/s?k=','github':'https://github.com/search?q='};
    const sk=Object.keys(smap).find(k=>site.includes(k));
    const base=sk?smap[sk]:`https://www.google.com/search?q=${encodeURIComponent(site+' ')}`;
    speak(`Searching ${site} for ${q}, ${userName}.`); setTimeout(()=>openURL(base+encodeURIComponent(q)),600); return true;
  }

  // Google search
  const gm=cmd.match(/(?:^|\s)(?:search|google|look up|search for|find)\s+(.+)/);
  if (gm) {
    const q=gm[1].replace(/[.!?]$/,'').trim();
    speak(`Searching for ${q}, ${userName}.`); setTimeout(()=>openTab(q,true),600); return true;
  }

  // Open tab
  const tm=cmd.match(/^(?:open a tab|open tab|new tab|go to|navigate to)\s+(.+)/);
  if (tm) {
    const dest=tm[1].replace(/[.!?]$/,'').trim();
    const wk=Object.keys(WEB).find(k=>dest.includes(k));
    if (wk) { speak(`Opening ${wk}, ${userName}.`); setTimeout(()=>openURL(WEB[wk]),600); return true; }
    speak(`Opening ${dest}, ${userName}.`); setTimeout(()=>openTab(dest),600); return true;
  }

  // Open app
  const openT=['open ','launch ','start ','pull up ','bring up '];
  if (openT.some(t=>cmd.startsWith(t))) {
    let r2=cmd; for(const t of openT) r2=r2.replace(t,'');
    r2=r2.replace(/[.!?]$/,'').trim();
    const wk=Object.keys(WEB).find(k=>r2.includes(k));
    if (wk) { speak(`Opening ${wk}, ${userName}.`); setTimeout(()=>openURL(WEB[wk]),600); return true; }
    const appName=resolveApp(r2);
    speak(`Ok ${userName}, opening ${appName}.`); setTimeout(()=>openApp(appName),600); return true;
  }

  // Who are you
  if (has(cmd,['who are you','what are you','introduce yourself'])) {
    speak(`I am J.A.R.V.I.S. — Just A Rather Very Intelligent System. Your personal AI assistant, ${userName}.`); return true;
  }

  // Now playing
  if (has(cmd,['what song','what\'s playing','now playing','current song'])) {
    nowPlaying((err,t,src)=>{
      if(err||!t)          speak(`No music detected, ${userName}.`);
      else if(t==='paused') speak(`Music is paused, ${userName}.`);
      else                  speak(`Playing ${t} on ${src}, ${userName}.`);
    }); return true;
  }

  // Weather
  if (has(cmd,['weather','temperature','how hot','how cold'])) {
    speak(`Checking weather, ${userName}.`);
    getWeather((err,d)=>speak(err||!d?`Couldn't get weather, ${userName}.`:`Current weather: ${d}, ${userName}.`));
    return true;
  }

  // Date/Time
  if (has(cmd,['what day','what\'s today','today\'s date','the date'])) {
    const n=new Date();
    speak(`Today is ${n.toLocaleDateString([],{weekday:'long'})}, ${n.toLocaleDateString([],{month:'long',day:'numeric',year:'numeric'})}, ${userName}.`);
    return true;
  }
  if (has(cmd,['what time','time is it','what\'s the time','the time'])) {
    speak(`The time is ${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}, ${userName}.`); return true;
  }

  // Screenshot
  if (has(cmd,['screenshot','take a screenshot','capture screen'])) {
    speak(`Taking a screenshot, ${userName}.`); setTimeout(screenshot,800); return true;
  }

  // Create note
  if (has(cmd,['create a note','make a note','note that','take a note','write a note'])) {
    const content=raw.replace(/create a note|make a note|note that|take a note|write a note/gi,'').replace(/^\s*(that|about|to)\s*/i,'').replace(/[.!?]$/,'').trim();
    if(content){ createNote(content); speak(`Note created, ${userName}.`); }
    else speak(`What should the note say, ${userName}?`);
    return true;
  }

  // Remind me
  if (has(cmd,['remind me','set a reminder','set reminder'])) {
    const dur=parseDur(cmd);
    if(dur>0){
      const what=raw.replace(/remind me (to |about |that )?/i,'').replace(/set a? reminder (to |about |that )?/i,'').replace(/in \d+\s*(hour|min\w*|sec\w*)s?/i,'').replace(/in an? \w+/i,'').replace(/[.!?]$/,'').trim()||'that';
      speak(`Reminder set for ${humanDur(dur)}, ${userName}.`);
      setTimeout(()=>speak(`${userName}, reminder: ${what}.`),dur*1000);
    } else speak(`Try: remind me to call mom in 20 minutes, ${userName}.`);
    return true;
  }

  // Timer
  if (has(cmd,['set a timer','set timer','start a timer','timer for'])) {
    const dur=parseDur(cmd);
    if(dur>0){ speak(`Timer set for ${humanDur(dur)}, ${userName}.`); setTimeout(()=>speak(`${userName}, timer's up.`),dur*1000); }
    else speak(`How long, ${userName}?`);
    return true;
  }

  // Battery
  if (has(cmd,['battery','power level','how much charge'])) { getBat(b=>speak(`Battery at ${b}, ${userName}.`)); return true; }

  // Status
  if (has(cmd,['status report','system status','how are you','all systems'])) {
    getBat(b=>{ const t=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); speak(`All systems online. Time: ${t}. Battery: ${b}, ${userName}.`); });
    return true;
  }

  // Name change
  if (cmd.includes('call me ')) {
    const n=cmd.split('call me ')[1].replace(/[.!?]$/,'').trim();
    if(n){ userName=n; saveS({...loadS(),userName:n}); speak(`Of course, ${n}.`); return true; }
  }

  // Thanks
  if (['thank','thanks','cheers','appreciate','good job','nice one','well done','awesome','perfect'].some(w=>cmd.includes(w))) {
    const r=[`Always at your service, ${userName}.`,`My pleasure, ${userName}.`,`Anytime, ${userName}.`,`That's what I'm here for, ${userName}.`];
    speak(r[Math.floor(Math.random()*r.length)]); return true;
  }

  log(`No match: "${cmd}"`);
  return false;
}

// ─────────────────────────────────────────────
//  VISION WINDOW
// ─────────────────────────────────────────────
function closeVision() {
  visionOpen = false;
  if (!visionWin || visionWin.isDestroyed()) return;
  try { visionWin.webContents.send('stop-camera'); } catch(e) {}
  const w = visionWin; visionWin = null;
  setTimeout(() => { try { if(!w.isDestroyed()) w.hide(); } catch(e) {} }, 300);
}

function openVision() {
  if (visionWin && !visionWin.isDestroyed()) { visionWin.show(); visionOpen=true; return; }
  const ob = orbWin.getBounds();
  visionWin = new BrowserWindow({
    width:280, height:340, x:ob.x-30, y:ob.y+ob.height+8,
    frame:false, transparent:true, alwaysOnTop:true,
    resizable:false, skipTaskbar:true, hasShadow:false,
    webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false},
  });
  visionWin.webContents.session.setPermissionRequestHandler((_,p,cb)=>cb(['media','camera','video'].includes(p)));
  visionWin.webContents.session.setPermissionCheckHandler((_,p)=>['media','camera','video'].includes(p));
  visionWin.loadFile(path.join(__dirname,'vision.html'));
  visionWin.setAlwaysOnTop(true,'floating');
  visionWin.on('closed',()=>{ visionWin=null; visionOpen=false; });
  visionOpen=true;
}

// ─────────────────────────────────────────────
//  LISTENER
// ─────────────────────────────────────────────
function startListener() {
  const script = path.join(__dirname, 'listener.py');
  exec('python -c "import speech_recognition,pyaudio"', { windowsHide:true }, err => {
    if (err) {
      speak(`Installing speech engine. Please wait.`);
      exec('pip install SpeechRecognition pyaudio', { timeout:120000, windowsHide:true }, e2 => {
        if (e2) speak(`Install failed. Run pip install SpeechRecognition pyaudio in command prompt.`);
        else spawnListener(script);
      });
    } else { spawnListener(script); }
  });
}

function spawnListener(script) {
  if (isQuitting) return;
  log('Spawning listener...');
  try {
    listenerProc = spawn('python', ['-u', script], {
      stdio: ['pipe','pipe','pipe'], windowsHide: true,
    });
  } catch(e) { log('Spawn error: '+e.message); return; }

  listenerReady = false;
  const rl = readline.createInterface({ input: listenerProc.stdout });
  rl.on('line', line => {
    line = line.trim(); if (!line) return;
    log(`PY> ${line}`);
    if (line==='READY') { listenerReady=true; tellListener(isAwake?'AWAKE':'SLEEP'); }
    else if (line==='WAKE') { if(!isAwake) wake(); }
    else if (line.startsWith('CMD:')) {
      if (!isAwake) return;
      if (isSpeaking) return;
      if (Date.now()-lastSpeakEnd<1500) { log('CMD blocked: cooldown'); return; }
      if (handle(line.slice(4).trim())) resetAwakeTimer();
    }
  });

  listenerProc.stderr.on('data', d => {
    const m=d.toString().trim();
    if(m&&!/WARNING|UserWarning|FutureWarning/.test(m)) log(`PY: ${m}`);
  });
  listenerProc.on('exit', code => {
    listenerReady=false; log(`Listener exited (${code}). Restart in 3s...`);
    listenerProc=null; if(!isQuitting) setTimeout(()=>spawnListener(script),3000);
  });
  listenerProc.on('error', e => log('Listener error: '+e.message));
}

// ─────────────────────────────────────────────
//  ORB WINDOW
// ─────────────────────────────────────────────
function createOrb() {
  const { x, y } = screen.getPrimaryDisplay().bounds;
  orbWin = new BrowserWindow({
    width:120, height:120, x:x+20, y:y+20,
    frame:false, transparent:true, alwaysOnTop:true,
    resizable:false, skipTaskbar:true, hasShadow:false,
    webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false},
  });
  orbWin.setAlwaysOnTop(true, 'screen-saver');
  orbWin.loadFile(path.join(__dirname, 'orb.html'));
  orbWin.on('close', e => { if(!isQuitting) e.preventDefault(); });
  orbWin.webContents.session.setPermissionRequestHandler((_,p,cb)=>cb(['media','microphone','audioCapture','camera'].includes(p)));
}

// ─────────────────────────────────────────────
//  IPC
// ─────────────────────────────────────────────
ipcMain.on('orb-clicked', ()=>{ if(isAwake) sleep(true); else wake(); });
ipcMain.on('vision-result', (_,text)=>{ if(isAwake&&!isSpeaking) speak(text); });

// ─────────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────────
app.whenReady().then(async () => {
  initS();
  log('=== JARVIS BOOT (WINDOWS) ===');
  createOrb();
  orbWin.webContents.once('did-finish-load', () => {
    setState('standby');
    setTimeout(() => {
      speak(`J.A.R.V.I.S. standing by, ${userName}.`);
      setTimeout(startListener, 3000);
    }, 800);
  });
  log('Boot complete.');
});
