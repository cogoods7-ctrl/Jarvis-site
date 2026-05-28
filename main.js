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

const { app, BrowserWindow, ipcMain, systemPreferences, screen } = require('electron');
const path  = require('path');
const os    = require('os');
const fs    = require('fs');
const https = require('https');
const { exec, spawn } = require('child_process');
const readline = require('readline');

const LOG = path.join(os.homedir(), 'jarvis.log');
function log(m) {
  try { fs.appendFileSync(LOG, `[${new Date().toLocaleTimeString()}] ${m}\n`); } catch(e) {}
}

if (!app.requestSingleInstanceLock()) { app.exit(0); }
// Only prevent quit when orb is still open — vision window should close freely
app.on('window-all-closed', e => {
  // If orb is still alive, keep app running
  if (orbWin && !orbWin.isDestroyed()) {
    e.preventDefault();
  }
});
app.dock?.hide();

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
//  TTS
// ─────────────────────────────────────────────
function speak(text, onDone) {
  if (speakTimer)  { clearTimeout(speakTimer); speakTimer = null; }
  if (speakProc)   { try { speakProc.kill('SIGKILL'); } catch(e) {} speakProc = null; }
  isSpeaking = true;
  setState('speaking');
  log(`SPEAK: ${text}`);
  speakProc = spawn('say', ['-v', 'Daniel', '-r', '195', text], { stdio: 'ignore' });
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
//  RUN APPLESCRIPT
//  Writes to a temp .scpt file and runs via /usr/bin/osascript directly.
//  This is the key fix — calling /usr/bin/osascript as a subprocess of
//  Terminal/bash means macOS checks Terminal's Accessibility permission,
//  which the user has already granted. Electron itself never needs it.
// ─────────────────────────────────────────────
function runAS(script, cb) {
  const tmp = path.join(os.tmpdir(), `jv_${Date.now()}_${Math.random().toString(36).slice(2)}.scpt`);
  try { fs.writeFileSync(tmp, script); } catch(e) { if(cb) cb(e, ''); return; }
  exec(`/usr/bin/osascript "${tmp}"`, { timeout: 10000 }, (err, out, stderr) => {
    try { fs.unlinkSync(tmp); } catch(e) {}
    if (err) log(`AS err: ${stderr || err.message}`);
    if (cb) cb(err, (out || '').trim());
  });
}

// ─────────────────────────────────────────────
//  MEDIA — direct Spotify/Music AppleScript
//  NO Accessibility permission needed for these
// ─────────────────────────────────────────────
let mediaCooldown = false;

function mediaControl(action) {
  if (mediaCooldown) return;
  mediaCooldown = true;
  setTimeout(() => { mediaCooldown = false; }, 2000);

  if (action === 'vUp' || action === 'vDown') {
    runAS(`output volume of (get volume settings)`, (err, out) => {
      const cur  = parseInt(out) || 50;
      const next = action === 'vUp' ? Math.min(cur + 15, 100) : Math.max(cur - 15, 0);
      runAS(`set volume output volume ${next}`);
    });
    return;
  }
  if (action === 'mute')   { runAS(`set volume with output muted`);   return; }
  if (action === 'unmute') { runAS(`set volume without output muted`); return; }

  // For play/pause/next/prev: talk directly to Spotify or Music
  // No Accessibility needed — these are normal app-control AppleScript calls
  const script = `
set spotifyUp to false
set musicUp to false
try
  if application "Spotify" is running then set spotifyUp to true
end try
try
  if application "Music" is running then set musicUp to true
end try

if spotifyUp then
  tell application "Spotify"
    ${action === 'play'  ? 'play'           : ''}
    ${action === 'pause' ? 'pause'          : ''}
    ${action === 'next'  ? 'next track'     : ''}
    ${action === 'prev'  ? 'previous track' : ''}
  end tell
else if musicUp then
  tell application "Music"
    ${action === 'play'  ? 'play'       : ''}
    ${action === 'pause' ? 'pause'      : ''}
    ${action === 'next'  ? 'next track' : ''}
    ${action === 'prev'  ? 'back track' : ''}
  end tell
else
  -- Nothing running, open Spotify and play
  tell application "Spotify" to activate
end if`;

  runAS(script, err => { if(err) log(`Media ${action} err: ${err.message}`); });
}

// ─────────────────────────────────────────────
//  DND — defaults write method
//  Works on Monterey WITHOUT Accessibility permission
// ─────────────────────────────────────────────
function setDND(enable, cb) {
  // Method 1: defaults write — no Accessibility needed, works on Monterey
  const val = enable ? '1' : '0';
  // Find the ByHost plist and write directly
  const cmd = [
    `defaults -currentHost write com.apple.notificationcenterui doNotDisturb -boolean ${enable}`,
    `defaults -currentHost write com.apple.notificationcenterui doNotDisturbDate -date "$(date)"`,
    `killall NotificationCenter 2>/dev/null`,
    `sleep 0.3`,
    `open -a NotificationCenter 2>/dev/null || true`
  ].join(' && ');

  exec(cmd, { timeout: 8000 }, (err) => {
    if (!err) {
      log(`DND set to ${enable}`);
      if (cb) cb(null);
      return;
    }
    log(`DND defaults failed: ${err.message} — trying Focus shortcut`);

    // Method 2: Focus keyboard shortcut via System Events
    // This DOES need Accessibility but is the fallback
    const focusScript = `
tell application "System Events"
  keystroke "d" using {command down, option down}
end tell`;
    runAS(focusScript, err2 => {
      if (err2) {
        log(`DND focus shortcut failed: ${err2.message}`);
        speak(`Do Not Disturb couldn't be toggled. You may need to set a Focus keyboard shortcut in System Preferences, ${userName}.`);
      }
      if (cb) cb(err2);
    });
  });
}

// ─────────────────────────────────────────────
//  LOCK SCREEN
// ─────────────────────────────────────────────
function lockScreen() {
  // PMset sleep is most reliable — no Accessibility needed
  exec(`/System/Library/CoreServices/Menu\\ Extras/User.menu/Contents/Resources/CGSession -suspend`, err => {
    if (err) {
      // Fallback: keystroke
      runAS(`tell application "System Events" to keystroke "q" using {command down, control down}`);
    }
  });
}

// ─────────────────────────────────────────────
//  BRIGHTNESS
//  Uses 'brightness' CLI (brew install brightness) or key codes
// ─────────────────────────────────────────────
function adjustBrightness(dir) {
  // Try brightness CLI first (no Accessibility needed)
  exec(`which brightness 2>/dev/null`, (err, out) => {
    if (!err && out.trim()) {
      exec(`brightness -l 2>/dev/null | grep -Eo '[0-9]+\\.?[0-9]*' | head -1`, (e, cur) => {
        const current = parseFloat(cur) || 0.5;
        const next    = dir === 'up'
          ? Math.min(current + 0.15, 1.0).toFixed(2)
          : Math.max(current - 0.15, 0.0).toFixed(2);
        exec(`brightness ${next}`);
      });
    } else {
      // Fallback: AppleScript key codes (needs Accessibility)
      // F2 = brightness up (key code 144), F1 = brightness down (key code 145)
      const kc = dir === 'up' ? 144 : 145;
      runAS(`tell application "System Events" to key code ${kc}`, (e) => {
        if (e) {
          speak(`For brightness control, install the brightness tool by running: brew install brightness in Terminal, ${userName}.`);
        }
      });
    }
  });
}

// ─────────────────────────────────────────────
//  TRANSLATION — MyMemory API (free, no key)
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
//  TRANSLATION — tries 3 free APIs in order
// ─────────────────────────────────────────────
const LANG_CODES = {
  'spanish':'es','french':'fr','german':'de','italian':'it',
  'portuguese':'pt','japanese':'ja','korean':'ko','chinese':'zh',
  'arabic':'ar','hindi':'hi','russian':'ru','dutch':'nl',
  'swedish':'sv','polish':'pl','turkish':'tr','greek':'el',
  'hebrew':'he','thai':'th','vietnamese':'vi','indonesian':'id',
  'latin':'la','ukrainian':'uk','czech':'cs','romanian':'ro',
  'danish':'da','finnish':'fi','norwegian':'no','hungarian':'hu',
};

function httpsGet(url, cb) {
  https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => cb(null, d));
  }).on('error', e => cb(e, null));
}

function translate(phrase, toLang, cb) {
  const code = LANG_CODES[toLang.toLowerCase()] || toLang.slice(0, 2).toLowerCase();

  // API 1: MyMemory (most reliable free translation, no key needed)
  const encoded = encodeURIComponent(phrase);
  const url1 = `https://api.mymemory.translated.net/get?q=${encoded}&langpair=en|${code}&de=jarvis@local.com`;

  httpsGet(url1, (err, body) => {
    if (!err && body) {
      try {
        const j = JSON.parse(body);
        // MyMemory returns responseStatus 200 on success
        if (j.responseStatus === 200 && j.responseData?.translatedText) {
          const result = j.responseData.translatedText;
          // Check it's not an error message
          if (!result.includes('PLEASE SELECT') && !result.includes('INVALID') && result !== phrase) {
            return cb(null, result);
          }
        }
        // Try matches array as backup
        if (j.matches && j.matches.length > 0) {
          const best = j.matches.find(m => m.translation && m.quality > 70);
          if (best) return cb(null, best.translation);
        }
      } catch(e) {}
    }

    // API 2: Lingva (open source Google Translate frontend)
    const url2 = `https://lingva.ml/api/v1/en/${code}/${encoded}`;
    httpsGet(url2, (err2, body2) => {
      if (!err2 && body2) {
        try {
          const j2 = JSON.parse(body2);
          if (j2.translation && j2.translation !== phrase) {
            return cb(null, j2.translation);
          }
        } catch(e) {}
      }

      // API 3: LibreTranslate public instance
      const postData = JSON.stringify({ q: phrase, source: 'en', target: code, format: 'text' });
      const options = {
        hostname: 'libretranslate.com',
        path: '/translate',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
      };
      const req = https.request(options, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const j3 = JSON.parse(d);
            if (j3.translatedText && j3.translatedText !== phrase) return cb(null, j3.translatedText);
          } catch(e) {}
          cb(new Error('all_apis_failed'), null);
        });
      });
      req.on('error', e => cb(e, null));
      req.write(postData);
      req.end();
    });
  });
}

// ─────────────────────────────────────────────
//  DEFINE — Free Dictionary API (no key)
// ─────────────────────────────────────────────
function define(word, cb) {
  const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.trim().toLowerCase())}`;
  https.get(url, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      try {
        const j = JSON.parse(d);
        if (Array.isArray(j) && j[0]?.meanings?.[0]?.definitions?.[0]) {
          const m   = j[0].meanings[0];
          const def = m.definitions[0].definition;
          const pos = m.partOfSpeech ? `${m.partOfSpeech}. ` : '';
          cb(null, `${word}: ${pos}${def}`);
        } else {
          cb(null, null);
        }
      } catch(e) { cb(e, null); }
    });
  }).on('error', e => cb(e, null));
}

// ─────────────────────────────────────────────
//  CALCULATE — safe spoken math
// ─────────────────────────────────────────────
function calculate(raw) {
  let expr = raw.toLowerCase()
    .replace(/\bplus\b/g,       '+')
    .replace(/\bminus\b/g,      '-')
    .replace(/\btimes\b|\bmultiplied by\b/g, '*')
    .replace(/\bdivided by\b|\bover\b/g, '/')
    .replace(/\bto the power of\b|\braised to\b/g, '**')
    .replace(/\bsquared\b/g,    '**2')
    .replace(/\bcubed\b/g,      '**3')
    .replace(/\bpercent of\b/g, '/100*')
    .replace(/\bpercent\b/g,    '/100')
    .replace(/\bpi\b/g,         '3.14159265358979')
    .replace(/[^0-9+\-*/.() **]/g, '')
    .trim();
  if (!expr) return null;
  try {
    const result = Function(`"use strict"; return (${expr})`)();
    if (typeof result === 'number' && isFinite(result)) {
      const r = parseFloat(result.toFixed(10));
      return r.toString();
    }
    return null;
  } catch(e) { return null; }
}

// ─────────────────────────────────────────────
//  TYPE TEXT — via AppleScript keystroke
// ─────────────────────────────────────────────
function typeText(text) {
  // Escape backslashes and quotes for AppleScript
  const safe = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  runAS(`tell application "System Events" to keystroke "${safe}"`, err => {
    if (err) log(`Type error: ${err.message}`);
  });
}

// ─────────────────────────────────────────────
//  OPEN IN SPECIFIC BROWSER
// ─────────────────────────────────────────────
function openInBrowser(url, browserName) {
  const browserApps = {
    'safari':  'Safari',
    'chrome':  'Google Chrome',
    'firefox': 'Firefox',
    'arc':     'Arc',
    'brave':   'Brave Browser',
  };
  const appName = browserApps[browserName.toLowerCase()] || 'Safari';
  exec(`open -a "${appName}" "${url.replace(/"/g, '\\"')}"`, err => {
    if (err) log(`Open in browser err: ${err.message}`);
  });
}

// ─────────────────────────────────────────────
//  QUIT APP
// ─────────────────────────────────────────────
function quitApp(name) {
  runAS(`tell application "${name.replace(/"/g,'\\"')}" to quit`, err => {
    if (err) log(`Quit ${name} err: ${err.message}`);
  });
}

// ─────────────────────────────────────────────
//  SELF DESTRUCT
// ─────────────────────────────────────────────
function selfDestruct() {
  isQuitting = true;

  // Count down spoken
  speak(`Initiating self destruct sequence. 5.`);
  setTimeout(() => speak(`4.`), 1800);
  setTimeout(() => speak(`3.`), 3400);
  setTimeout(() => speak(`2.`), 4900);
  setTimeout(() => speak(`1.`), 6400);
  setTimeout(() => {
    speak(`Goodbye, ${userName}.`, () => {
      // Trigger explosion animation in orb window
      try { orbWin?.webContents.send('self-destruct'); } catch(e) {}
      // Kill listener
      if (listenerProc) { try { listenerProc.kill('SIGKILL'); } catch(e) {} }
      if (visionWin && !visionWin.isDestroyed()) { try { visionWin.close(); } catch(e) {} }
      // Wait for explosion animation (1.2s) then quit
      setTimeout(() => app.exit(0), 1200);
    });
  }, 7800);
}
function nowPlaying(cb) {
  const script = `
set spotifyUp to false
set musicUp to false
try
  if application "Spotify" is running then set spotifyUp to true
end try
try
  if application "Music" is running then set musicUp to true
end try
if spotifyUp then
  tell application "Spotify"
    if player state is playing then
      return "Spotify|" & name of current track & " by " & artist of current track
    else
      return "Spotify|paused"
    end if
  end tell
else if musicUp then
  tell application "Music"
    if player state is playing then
      return "Music|" & name of current track & " by " & artist of current track
    else
      return "Music|paused"
    end if
  end tell
else
  return "none|none"
end if`;
  runAS(script, (err, out) => {
    if (err || !out) return cb(new Error('none'), null, '');
    const parts = out.split('|');
    const src   = parts[0];
    const track = parts.slice(1).join('|');
    if (track === 'paused') return cb(null, 'paused', src);
    if (track === 'none')   return cb(new Error('none'), null, '');
    cb(null, track, src);
  });
}

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
function getBat(cb) {
  exec("pmset -g batt | grep -Eo '[0-9]+%' | head -1", (err, o) => cb(!err && o.trim() ? o.trim() : 'unknown'));
}

function getWeather(cb) {
  https.get('https://wttr.in/?format=%C+%t&m', { headers: { 'User-Agent': 'curl/7.0' } }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => cb(null, d.trim()));
  }).on('error', e => cb(e, null));
}

function createNote(content) {
  const safe = content.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  runAS(`tell application "Notes"\nactivate\ntry\ntell account "iCloud"\nmake new note with properties {body:"${safe}"}\nend tell\non error\nmake new note with properties {body:"${safe}"}\nend try\nend tell`);
}

function screenshot() {
  const d = path.join(os.homedir(), 'Desktop', `jarvis-${Date.now()}.png`);
  exec(`screencapture -x "${d}"`, err => speak(err ? `Screenshot failed, ${userName}.` : `Screenshot saved, ${userName}.`));
}

function openURL(url)  { exec(`open "${url.replace(/"/g, '\\"')}"`); }
function openApp(name) {
  exec(`open -a "${name.replace(/"/g, '\\"')}"`, err => {
    if (err) speak(`I couldn't find ${name}, ${userName}.`);
  });
}

function openTab(q, search = false) {
  const url = search || !q.match(/\.(com|net|org|io|co|app|dev)\b/i)
    ? `https://www.google.com/search?q=${encodeURIComponent(q)}`
    : (q.startsWith('http') ? q : `https://${q}`);
  openURL(url);
}

function has(cmd, kws) { return kws.some(k => cmd.includes(k)); }

function parseDur(t) {
  const s = t.toLowerCase(); let tot = 0;
  const h = s.match(/(\d+|an?)\s*hour/), m = s.match(/(\d+|an?)\s*min/), sc = s.match(/(\d+)\s*sec/);
  const n = x => !x ? 0 : (x === 'a' || x === 'an' ? 1 : parseInt(x) || 0);
  if (h) tot += n(h[1]) * 3600; if (m) tot += n(m[1]) * 60; if (sc) tot += n(sc[1]);
  return tot;
}

function humanDur(s) {
  if (s >= 3600) { const h = Math.floor(s/3600), m = Math.floor((s%3600)/60); return m ? `${h} hour${h>1?'s':''} and ${m} minute${m>1?'s':''}` : `${h} hour${h>1?'s':''}`; }
  if (s >= 60)   { const m = Math.floor(s/60), sc = s%60; return sc ? `${m} minute${m>1?'s':''} and ${sc} second${sc>1?'s':''}` : `${m} minute${m>1?'s':''}`; }
  return `${s} second${s !== 1 ? 's' : ''}`;
}

// ─────────────────────────────────────────────
//  APP / WEB MAPS
// ─────────────────────────────────────────────
const APPS = {
  'safari':'Safari','chrome':'Google Chrome','google chrome':'Google Chrome',
  'firefox':'Firefox','arc':'Arc','brave':'Brave Browser',
  'notes':'Notes','messages':'Messages','imessage':'Messages',
  'mail':'Mail','facetime':'FaceTime','photos':'Photos',
  'music':'Music','apple music':'Music','spotify':'Spotify',
  'calendar':'Calendar','reminders':'Reminders','maps':'Maps',
  'calculator':'Calculator','terminal':'Terminal','iterm':'iTerm',
  'iterm2':'iTerm2','finder':'Finder','xcode':'Xcode',
  'preview':'Preview','quicktime':'QuickTime Player',
  'textedit':'TextEdit','app store':'App Store',
  'system preferences':'System Preferences','system settings':'System Preferences',
  'activity monitor':'Activity Monitor','pages':'Pages',
  'numbers':'Numbers','keynote':'Keynote',
  'vs code':'Visual Studio Code','vscode':'Visual Studio Code',
  'visual studio code':'Visual Studio Code','cursor':'Cursor',
  'slack':'Slack','discord':'Discord','zoom':'Zoom',
  'teams':'Microsoft Teams','whatsapp':'WhatsApp','telegram':'Telegram',
  'word':'Microsoft Word','excel':'Microsoft Excel','powerpoint':'Microsoft PowerPoint',
  'figma':'Figma','notion':'Notion','obsidian':'Obsidian',
  'raycast':'Raycast','claude':'Claude','bear':'Bear','things':'Things 3',
};

const WEB = {
  'youtube':'https://www.youtube.com','netflix':'https://www.netflix.com',
  'gmail':'https://mail.google.com','google':'https://www.google.com',
  'twitter':'https://www.twitter.com','instagram':'https://www.instagram.com',
  'reddit':'https://www.reddit.com','github':'https://www.github.com',
  'amazon':'https://www.amazon.com','hulu':'https://www.hulu.com',
  'disney plus':'https://www.disneyplus.com','disney':'https://www.disneyplus.com',
  'apple tv':'https://tv.apple.com','twitch':'https://www.twitch.tv',
  'chatgpt':'https://chat.openai.com','claude ai':'https://claude.ai',
};

function resolveApp(raw) {
  const c = raw.toLowerCase().replace(/\b(the|my|app|application|please)\b/g, '').replace(/\s+/g, ' ').trim();
  if (APPS[c]) return APPS[c];
  for (const [k, v] of Object.entries(APPS)) { if (c.includes(k) || k.includes(c)) return v; }
  return c.split(' ').filter(w => !['the','my','app','a','an'].includes(w)).map(w => w[0].toUpperCase()+w.slice(1)).join(' ');
}

// ─────────────────────────────────────────────
//  WAKE / SLEEP / ORB STATE
// ─────────────────────────────────────────────
function setState(s) { try { orbWin?.webContents.send('set-state', s); } catch(e) {} }
function tellListener(msg) {
  if (!listenerProc || !listenerReady) return;
  try { listenerProc.stdin.write(msg + '\n'); } catch(e) {}
}

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
    const t = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
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
//  COMMAND HANDLER
// ─────────────────────────────────────────────
function handle(rawText) {
  const raw = rawText.trim();
  const cmd = raw.toLowerCase();
  log(`CMD: "${cmd}"`);

  // ── Self destruct ──
  if (has(cmd, ['self destruct','initiate self destruct','activate self destruct','self-destruct'])) {
    selfDestruct(); return true;
  }

  // ── Vision open/close — MUST come before quit app ──
  if (has(cmd, ['what do you see','what can you see','open camera','open vision','activate vision','use vision','show camera'])) {
    if (!visionOpen) {
      openVision();
      speak(`Opening vision, ${userName}.`);
      setTimeout(() => { try { visionWin?.webContents.send('analyze-now'); } catch(e) {} }, 2500);
    } else {
      speak(`Analyzing, ${userName}.`);
      try { visionWin?.webContents.send('analyze-now'); } catch(e) {}
    }
    return true;
  }
  if (has(cmd, ['close camera','close vision','stop camera','hide camera','shut camera','turn off camera','shut vision','close the camera','hide vision'])) {
    closeVision(); speak(`Vision closed, ${userName}.`); return true;
  }

  // ── Quit app — excluded camera/vision so they don't get caught here ──
  const quitM = cmd.match(/^(?:quit|close|kill|exit|shut down|force quit)\s+(.+)/);
  if (quitM) {
    const appRaw = quitM[1].replace(/[.!?]$/, '').trim();
    // Don't let quit-app catch vision/camera commands
    if (['camera','vision','the camera','the vision'].includes(appRaw)) {
      closeVision(); speak(`Vision closed, ${userName}.`); return true;
    }
    const appName = resolveApp(appRaw);
    speak(`Closing ${appName}, ${userName}.`);
    setTimeout(() => quitApp(appName), 500);
    return true;
  }

  // ── Sleep ──
  if (has(cmd, ['sleep mode','go to sleep','go to standby','standby mode','sleep jarvis','enter standby','goodbye','good night','that\'s all'])) {
    sleep(true); return true;
  }

  // ── Lock Screen ──
  if (has(cmd, ['lock my screen','lock screen','lock the screen','lock computer','lock mac'])) {
    speak(`Locking your screen, ${userName}.`);
    setTimeout(lockScreen, 1000);
    return true;
  }

  // ── Brightness ──
  if (has(cmd, ['brightness up','brighter','increase brightness','turn up brightness'])) {
    speak(`Increasing brightness, ${userName}.`);
    adjustBrightness('up');
    return true;
  }
  if (has(cmd, ['brightness down','dimmer','decrease brightness','turn down brightness','lower brightness'])) {
    speak(`Decreasing brightness, ${userName}.`);
    adjustBrightness('down');
    return true;
  }

  // ── Translate ──
  // Catches: "translate hello to Spanish", "translate hello into French",
  // "how do you say thank you in French", "say good morning in German"
  const transM = cmd.match(/translate (.+?) (?:to|into) (\w+)/) ||
                 cmd.match(/how (?:do you say|to say) (.+?) in (\w+)/) ||
                 cmd.match(/(?:say|what is) (.+?) in (\w+)/);
  if (transM && LANG_CODES[transM[2].toLowerCase()]) {
    const phrase = transM[1].trim();
    const lang   = transM[2].trim();
    speak(`Translating to ${lang}, ${userName}.`);
    translate(phrase, lang, (err, result) => {
      if (err || !result) speak(`Translation failed. Please check your internet connection, ${userName}.`);
      else speak(`${phrase} in ${lang} is: ${result}, ${userName}.`);
    });
    return true;
  }

  // ── Define ──
  const defM = cmd.match(/^define (.+)/) ||
               cmd.match(/what does (.+?) mean/) ||
               cmd.match(/what is the definition of (.+)/);
  if (defM) {
    const word = defM[1].replace(/[.!?]$/, '').trim();
    speak(`Looking up ${word}, ${userName}.`);
    define(word, (err, result) => {
      speak(err || !result
        ? `Couldn't find a definition for ${word}, ${userName}.`
        : `${result}, ${userName}.`
      );
    });
    return true;
  }

  // ── Calculate ──
  const calcM = cmd.match(/^(?:calculate|compute|what is|what's|how much is|solve) (.+)/);
  if (calcM) {
    const expr   = calcM[1].replace(/[.!?]$/, '').trim();
    const result = calculate(expr);
    speak(result !== null
      ? `${expr} equals ${result}, ${userName}.`
      : `I couldn't calculate that, ${userName}. Try saying: calculate 15 times 7.`
    );
    return true;
  }

  // ── Type text — catches full phrase even if Google SR adds filler ──
  const typeM = cmd.match(/(?:^|\s)type\s+(.+)/);
  if (typeM) {
    const text = typeM[1].replace(/[.!?]$/, '').trim();
    speak(`Typing now, ${userName}.`);
    setTimeout(() => typeText(text), 1200);
    return true;
  }

  // ── Open in specific browser ──
  const browserM = cmd.match(/open (.+?) in (safari|chrome|firefox|arc|brave)/);
  if (browserM) {
    const dest    = browserM[1].trim();
    const browser = browserM[2].trim();
    speak(`Opening ${dest} in ${browser}, ${userName}.`);
    const wk  = Object.keys(WEB).find(k => dest.includes(k));
    const url = wk ? WEB[wk] : (dest.match(/^https?:\/\//) ? dest : `https://${dest}`);
    setTimeout(() => openInBrowser(url, browser), 600);
    return true;
  }

  // ── Media — must come before open so "play spotify" doesn't open app ──
  if (has(cmd, ['play music','play spotify','play apple music','resume music','start music','start playing','resume playback'])) {
    speak(`Playing, ${userName}.`); setTimeout(() => mediaControl('play'), 400); return true;
  }
  if (has(cmd, ['pause music','stop music','stop the music','pause the music','pause playback','stop playing'])) {
    speak(`Pausing, ${userName}.`); setTimeout(() => mediaControl('pause'), 400); return true;
  }
  if (has(cmd, ['next song','next track','skip song','skip track','skip this','next one'])) {
    speak(`Next track, ${userName}.`); setTimeout(() => mediaControl('next'), 400); return true;
  }
  if (has(cmd, ['previous song','previous track','last song','go back','last track'])) {
    speak(`Going back, ${userName}.`); setTimeout(() => mediaControl('prev'), 400); return true;
  }
  if (has(cmd, ['volume up','louder','turn it up','increase volume'])) {
    speak(`Louder, ${userName}.`); setTimeout(() => mediaControl('vUp'), 400); return true;
  }
  if (has(cmd, ['volume down','quieter','turn it down','lower the volume','decrease volume'])) {
    speak(`Quieter, ${userName}.`); setTimeout(() => mediaControl('vDown'), 400); return true;
  }
  if (cmd.includes('unmute')) { speak(`Unmuted, ${userName}.`); setTimeout(() => mediaControl('unmute'), 400); return true; }
  if (cmd.includes('mute'))   { speak(`Muted, ${userName}.`);   setTimeout(() => mediaControl('mute'), 400);   return true; }

  // ── DND ──
  if (has(cmd, ['do not disturb','don\'t disturb','dnd','enable focus','turn on focus','turn on do not disturb'])) {
    speak(`Enabling Do Not Disturb, ${userName}.`);
    setDND(true, err => { if (err) log('DND on: '+err.message); });
    return true;
  }
  if (has(cmd, ['turn off do not disturb','disable do not disturb','disable focus','turn off focus','disable dnd'])) {
    speak(`Disabling Do Not Disturb, ${userName}.`);
    setDND(false, err => { if (err) log('DND off: '+err.message); });
    return true;
  }

  // ── Search on specific site ──
  const sm = cmd.match(/(?:search|look up|find)\s+(.+?)\s+on\s+(.+)/);
  if (sm) {
    const [, q, site] = sm;
    const smap = { 'youtube':'https://www.youtube.com/results?search_query=', 'google':'https://www.google.com/search?q=', 'reddit':'https://www.reddit.com/search/?q=', 'amazon':'https://www.amazon.com/s?k=', 'github':'https://github.com/search?q=', 'spotify':'https://open.spotify.com/search/' };
    const sk   = Object.keys(smap).find(k => site.includes(k));
    const base = sk ? smap[sk] : `https://www.google.com/search?q=${encodeURIComponent(site+' ')}`;
    speak(`Searching ${site} for ${q}, ${userName}.`);
    setTimeout(() => openURL(base + encodeURIComponent(q)), 600);
    return true;
  }

  // ── Google search — catches "search for X" anywhere in phrase ──
  const gm = cmd.match(/(?:^|\s)(?:search|google|look up|search for|find)\s+(.+)/);
  if (gm) {
    const q = gm[1].replace(/[.!?]$/, '').trim();
    speak(`Searching for ${q}, ${userName}.`);
    setTimeout(() => openTab(q, true), 600);
    return true;
  }

  // ── Open tab ──
  const tm = cmd.match(/^(?:open a tab|open tab|new tab|go to|navigate to)\s+(.+)/);
  if (tm) {
    const dest = tm[1].replace(/[.!?]$/, '').trim();
    const wk   = Object.keys(WEB).find(k => dest.includes(k));
    if (wk) { speak(`Opening ${wk}, ${userName}.`); setTimeout(() => openURL(WEB[wk]), 600); return true; }
    speak(`Opening ${dest}, ${userName}.`); setTimeout(() => openTab(dest), 600); return true;
  }

  // ── Open app ──
  const openT = ['open ','launch ','start ','pull up ','bring up '];
  if (openT.some(t => cmd.startsWith(t))) {
    let r2 = cmd;
    for (const t of openT) r2 = r2.replace(t, '');
    r2 = r2.replace(/[.!?]$/, '').trim();
    const wk = Object.keys(WEB).find(k => r2.includes(k));
    if (wk) { speak(`Opening ${wk}, ${userName}.`); setTimeout(() => openURL(WEB[wk]), 600); return true; }
    const appName = resolveApp(r2);
    speak(`Ok ${userName}, opening ${appName}.`);
    setTimeout(() => openApp(appName), 600);
    return true;
  }

  // ── Who are you ──
  if (has(cmd, ['who are you','what are you','introduce yourself'])) {
    speak(`I am J.A.R.V.I.S. — Just A Rather Very Intelligent System. Your personal AI assistant, ${userName}.`);
    return true;
  }

  // ── Now playing ──
  if (has(cmd, ['what song','what\'s playing','what is playing','now playing','current song'])) {
    nowPlaying((err, t, src) => {
      if (err || !t)           speak(`No music detected, ${userName}.`);
      else if (t === 'paused') speak(`Music is paused, ${userName}.`);
      else                     speak(`Playing ${t} on ${src}, ${userName}.`);
    });
    return true;
  }

  // ── Weather ──
  if (has(cmd, ['weather','temperature','how hot','how cold','outside like'])) {
    speak(`Checking weather, ${userName}.`);
    getWeather((err, d) => speak(err || !d ? `Couldn't get weather, ${userName}.` : `Current weather: ${d}, ${userName}.`));
    return true;
  }

  // ── Date ──
  if (has(cmd, ['what day','what\'s today','today\'s date','the date','what date'])) {
    const n = new Date();
    speak(`Today is ${n.toLocaleDateString([], {weekday:'long'})}, ${n.toLocaleDateString([], {month:'long',day:'numeric',year:'numeric'})}, ${userName}.`);
    return true;
  }

  // ── Time ──
  if (has(cmd, ['what time','time is it','what\'s the time','the time'])) {
    speak(`The time is ${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}, ${userName}.`);
    return true;
  }

  // ── Screenshot ──
  if (has(cmd, ['screenshot','take a screenshot','capture screen'])) {
    speak(`Taking a screenshot, ${userName}.`); setTimeout(screenshot, 800); return true;
  }

  // ── Create note ──
  if (has(cmd, ['create a note','make a note','note that','take a note','write a note'])) {
    const content = raw.replace(/create a note|make a note|note that|take a note|write a note/gi, '').replace(/^\s*(that|about|to)\s*/i, '').replace(/[.!?]$/, '').trim();
    if (content) { createNote(content); speak(`Note created, ${userName}.`); }
    else speak(`What should the note say, ${userName}?`);
    return true;
  }

  // ── Remind me ──
  if (has(cmd, ['remind me','set a reminder','set reminder'])) {
    const dur = parseDur(cmd);
    if (dur > 0) {
      const what = raw.replace(/remind me (to |about |that )?/i,'').replace(/set a? reminder (to |about |that )?/i,'').replace(/in \d+\s*(hour|min\w*|sec\w*)s?/i,'').replace(/in an? \w+/i,'').replace(/[.!?]$/,'').trim() || 'that';
      speak(`Reminder set for ${humanDur(dur)}, ${userName}.`);
      setTimeout(() => speak(`${userName}, reminder: ${what}.`), dur * 1000);
    } else {
      speak(`Try: remind me to call mom in 20 minutes, ${userName}.`);
    }
    return true;
  }

  // ── Timer ──
  if (has(cmd, ['set a timer','set timer','start a timer','timer for'])) {
    const dur = parseDur(cmd);
    if (dur > 0) {
      speak(`Timer set for ${humanDur(dur)}, ${userName}.`);
      setTimeout(() => speak(`${userName}, timer's up.`), dur * 1000);
    } else speak(`How long, ${userName}? Try: timer for 10 minutes.`);
    return true;
  }

  // ── Battery ──
  if (has(cmd, ['battery','power level','how much charge'])) {
    getBat(b => speak(`Battery at ${b}, ${userName}.`)); return true;
  }

  // ── Status ──
  if (has(cmd, ['status report','system status','how are you','all systems'])) {
    getBat(b => {
      const t = new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
      speak(`All systems online. Time: ${t}. Battery: ${b}, ${userName}.`);
    });
    return true;
  }

  // ── Name change ──
  if (cmd.includes('call me ')) {
    const n = cmd.split('call me ')[1].replace(/[.!?]$/, '').trim();
    if (n) { userName = n; saveS({...loadS(), userName: n}); speak(`Of course, ${n}.`); return true; }
  }

  // ── Thanks ──
  if (['thank','thanks','cheers','appreciate','good job','nice one','well done','awesome','perfect'].some(w => cmd.includes(w))) {
    const r = [`Always at your service, ${userName}.`,`My pleasure, ${userName}.`,`Anytime, ${userName}.`,`That's what I'm here for, ${userName}.`];
    speak(r[Math.floor(Math.random() * r.length)]); return true;
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
  try { visionWin.hide(); } catch(e) { log('vision hide err: '+e.message); }
}

function openVision() {
  // If window exists, just show it again
  if (visionWin && !visionWin.isDestroyed()) {
    visionWin.show();
    visionOpen = true;
    try { visionWin.webContents.send('analyze-now'); } catch(e) {}
    return;
  }
  const ob = orbWin.getBounds();
  visionWin = new BrowserWindow({
    width:280, height:340,
    x: ob.x - 30, y: ob.y + ob.height + 8,
    frame:false, transparent:true,
    alwaysOnTop:true, show:true,
    resizable:false, skipTaskbar:true, hasShadow:false,
    webPreferences: { nodeIntegration:true, contextIsolation:false, backgroundThrottling:false },
  });
  visionWin.webContents.session.setPermissionRequestHandler((_, p, cb) => cb(['media','camera','video'].includes(p)));
  visionWin.webContents.session.setPermissionCheckHandler((_, p) => ['media','camera','video'].includes(p));
  visionWin.loadFile(path.join(__dirname, 'vision.html'));
  visionWin.setAlwaysOnTop(true, 'floating');
  visionWin.on('closed', () => { visionWin = null; visionOpen = false; });
  visionOpen = true;
}

// ─────────────────────────────────────────────
//  LISTENER
// ─────────────────────────────────────────────
function startListener() {
  const script = path.join(__dirname, 'listener.py');
  exec('python3 -c "import speech_recognition,pyaudio"', err => {
    if (err) {
      speak(`Installing speech engine. Please wait.`);
      exec('pip3 install SpeechRecognition pyaudio --quiet --break-system-packages', { timeout:120000 }, e2 => {
        if (e2) speak(`Install failed. Run pip3 install SpeechRecognition pyaudio in terminal.`);
        else spawnListener(script);
      });
    } else {
      spawnListener(script);
    }
  });
}

function spawnListener(script) {
  if (isQuitting) return;
  log('Spawning listener...');
  try {
    listenerProc = spawn('python3', ['-u', script], { stdio: ['pipe','pipe','pipe'] });
  } catch(e) { log('Spawn error: '+e.message); return; }

  listenerReady = false;

  const rl = readline.createInterface({ input: listenerProc.stdout });
  rl.on('line', line => {
    line = line.trim(); if (!line) return;
    log(`PY> ${line}`);

    if (line === 'READY') {
      listenerReady = true;
      tellListener(isAwake ? 'AWAKE' : 'SLEEP');

    } else if (line === 'WAKE') {
      if (!isAwake) wake();

    } else if (line.startsWith('CMD:')) {
      if (!isAwake) return;
      if (isSpeaking) return;
      if (Date.now() - lastSpeakEnd < 1500) { log('CMD blocked: cooldown'); return; }
      if (handle(line.slice(4).trim())) resetAwakeTimer();

    } else if (line.startsWith('HEARD:')) {
      log(`Heard: ${line.slice(6)}`);
    } else if (line.startsWith('ERR:')) {
      log('Listener: ' + line.slice(4));
    }
  });

  listenerProc.stderr.on('data', d => {
    const m = d.toString().trim();
    if (m && !/WARNING|UserWarning|FutureWarning|DeprecationWarning|alsa/.test(m)) log(`PY: ${m}`);
  });

  listenerProc.on('exit', code => {
    listenerReady = false;
    log(`Listener exited (${code}). Restart in 3s...`);
    listenerProc = null;
    if (!isQuitting) setTimeout(() => spawnListener(script), 3000);
  });

  listenerProc.on('error', e => log('Listener error: ' + e.message));
}

// ─────────────────────────────────────────────
//  ORB WINDOW
// ─────────────────────────────────────────────
function createOrb() {
  const { x, y } = screen.getPrimaryDisplay().bounds;
  orbWin = new BrowserWindow({
    width:120, height:120, x: x+20, y: y+20,
    frame:false, transparent:true, alwaysOnTop:true,
    resizable:false, skipTaskbar:true, hasShadow:false,
    webPreferences: { nodeIntegration:true, contextIsolation:false, backgroundThrottling:false },
  });
  orbWin.setAlwaysOnTop(true, 'screen-saver');
  orbWin.loadFile(path.join(__dirname, 'orb.html'));
  // Only prevent ORB from closing — not all windows
  orbWin.on('close', e => {
    if (!isQuitting) e.preventDefault();
  });
  orbWin.webContents.session.setPermissionRequestHandler((_, p, cb) => cb(['media','microphone','audioCapture','camera'].includes(p)));
}

// ─────────────────────────────────────────────
//  IPC
// ─────────────────────────────────────────────
ipcMain.on('orb-clicked', () => { if (isAwake) sleep(true); else wake(); });
ipcMain.on('vision-result', (_, text) => { if (isAwake && !isSpeaking) speak(text); });

// ─────────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────────
app.whenReady().then(async () => {
  initS();
  log('=== JARVIS BOOT ===');

  if (process.platform === 'darwin') {
    try {
      if (systemPreferences.getMediaAccessStatus('microphone') !== 'granted')
        await systemPreferences.askForMediaAccess('microphone');
    } catch(e) { log('Mic: '+e.message); }
  }

  createOrb();

  orbWin.webContents.once('did-finish-load', () => {
    setState('standby');
    setTimeout(() => {
      speak(`J.A.R.V.I.S. standing by, ${userName}.`);
      // Start listener independently — NOT in onDone, NOT chained to speak
      setTimeout(startListener, 3000);
    }, 800);
  });

  log('Boot complete.');
});
