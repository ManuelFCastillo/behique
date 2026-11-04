import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const AUTH_PREFIX = 'MediaBrowser Client="seed", Device="seed", DeviceId="seed", Version="1"';

function authHeader(token) {
  if (token) return `${AUTH_PREFIX}, Token="${token}"`;
  return AUTH_PREFIX;
}

export function client({ baseUrl, fetch, token }) {
  const base = String(baseUrl).replace(/\/+$/, '');
  async function request(method, path, body) {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: authHeader(token),
    };
    const init = { method, headers };
    if (method === 'POST') {
      if (body === undefined) {
        init.body = '';
      } else {
        init.body = JSON.stringify(body);
      }
    }
    const res = await fetch(base + path, init);
    const status = res.status;
    let json = null;
    try {
      if (res && typeof res.text === 'function') {
        const text = await res.text();
        if (text === '' || text == null) {
          json = null;
        } else {
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
        }
      } else if (res && typeof res.json === 'function') {
        try {
          json = await res.json();
        } catch {
          json = null;
        }
      }
    } catch {
      json = null;
    }
    return { status, json };
  }
  return {
    get(path) {
      return request('GET', path);
    },
    post(path, body) {
      return request('POST', path, body);
    },
  };
}

const TYPE_OPTIONS = {
  movies: ['Movie'],
  tvshows: ['Series', 'Season', 'Episode'],
};

export function libraryOptions(kind, path) {
  const types = TYPE_OPTIONS[kind] || [];
  return {
    PathInfos: [{ Path: path }],
    EnableRealtimeMonitor: false,
    EnablePhotos: false,
    EnableChapterImageExtraction: false,
    ExtractChapterImagesDuringLibraryScan: false,
    EnableTrickplayImageExtraction: false,
    EnableLUFSScan: false,
    MetadataSavers: [],
    LocalMetadataReaderOrder: ['Nfo'],
    TypeOptions: types.map((Type) => ({ Type, MetadataFetchers: [], ImageFetchers: [] })),
  };
}

export async function waitReady({ baseUrl, fetch, sleep, timeoutMs = 180000, everyMs = 1000 }) {
  const api = client({ baseUrl, fetch });
  let elapsed = 0;
  for (;;) {
    let ready = false;
    try {
      const res = await api.get('/Startup/Configuration');
      if (res.status === 200) ready = true;
    } catch {
      ready = false;
    }
    if (ready) return;
    if (elapsed >= timeoutMs) {
      throw new Error('timed out waiting for Jellyfin server to be ready');
    }
    await sleep(everyMs);
    elapsed += everyMs;
  }
}

function check(status, expected, step) {
  const ok = Array.isArray(expected) ? expected.includes(status) : status === expected;
  if (!ok) {
    throw new Error(`${step} failed with status ${status}`);
  }
}

export async function finishWizard(api, { user, password }) {
  let res = await api.post('/Startup/Configuration', {
    ServerName: 'Open Movie Night', UICulture: 'en-US',
    MetadataCountryCode: 'US',
    PreferredMetadataLanguage: 'en',
  });
  check(res.status, 204, 'POST /Startup/Configuration');

  res = await api.get('/Startup/User');
  check(res.status, 200, 'GET /Startup/User');

  res = await api.post('/Startup/User', { Name: user, Password: password });
  check(res.status, 204, 'POST /Startup/User');

  res = await api.post('/Startup/RemoteAccess', {
    EnableRemoteAccess: false,
    EnableAutomaticPortMapping: false,
  });
  check(res.status, 204, 'POST /Startup/RemoteAccess');

  res = await api.post('/Startup/Complete');
  check(res.status, 204, 'POST /Startup/Complete');
}

export async function login(api, { user, password }) {
  const res = await api.post('/Users/AuthenticateByName', { Username: user, Pw: password });
  check(res.status, 200, 'POST /Users/AuthenticateByName');
  const token = res.json.AccessToken;
  const userId = res.json.User.Id;
  const policy = res.json.User.Policy;
  return { token, userId, policy };
}

export async function addLibraries(api, libraries) {
  for (const lib of libraries) {
    const qs = `name=${encodeURIComponent(lib.name)}&collectionType=${encodeURIComponent(lib.kind)}&refreshLibrary=false`;
    const res = await api.post(`/Library/VirtualFolders?${qs}`, {
      LibraryOptions: libraryOptions(lib.kind, lib.path),
    });
    check(res.status, 204, `POST /Library/VirtualFolders ${lib.name}`);
  }
}

function countsMatch(counts, expected) {
  return (
    counts.MovieCount === expected.MovieCount &&
    counts.SeriesCount === expected.SeriesCount &&
    counts.EpisodeCount === expected.EpisodeCount
  );
}

export async function scanUntil(api, expected, { sleep, timeoutMs = 300000, everyMs = 2000, steadyPolls = 3 }) {
  await api.post('/Library/Refresh');
  let steady = 0;
  let last = null;
  let elapsed = 0;
  for (;;) {
    const res = await api.get('/Items/Counts');
    last = res.json;
    if (last && countsMatch(last, expected)) {
      steady += 1;
    } else {
      steady = 0;
    }
    if (steady >= steadyPolls) return last;
    if (elapsed >= timeoutMs) {
      throw new Error(
        `timed out waiting for scan: expected ${JSON.stringify(expected)} but last counts were ${JSON.stringify(last)}`
      );
    }
    await sleep(everyMs);
    elapsed += everyMs;
  }
}

export async function silenceTasks(api) {
  const res = await api.get('/ScheduledTasks');
  check(res.status, 200, 'GET /ScheduledTasks');
  const tasks = res.json || [];
  let changed = 0;
  for (const task of tasks) {
    const r = await api.post(`/ScheduledTasks/${task.Id}/Triggers`, []);
    check(r.status, 204, `POST /ScheduledTasks/${task.Id}/Triggers`);
    changed += 1;
  }
  return changed;
}

export async function hideUser(api, { userId, policy }) {
  const res = await api.post(`/Users/${userId}/Policy`, { ...policy, IsHidden: true });
  check(res.status, 204, `POST /Users/${userId}/Policy`);
  const pub = await api.get('/Users/Public');
  check(pub.status, 200, 'GET /Users/Public');
  const list = pub.json || [];
  if (Array.isArray(list) ? list.length > 0 : list) {
    throw new Error(`GET /Users/Public still lists ${JSON.stringify(list)} after hiding user`);
  }
}

function wizardCompletedFlag(info) {
  if (!info || typeof info !== 'object') return false;
  if ('startupWizardCompleted' in info) return Boolean(info.startupWizardCompleted);
  if ('StartupWizardCompleted' in info) return Boolean(info.StartupWizardCompleted);
  return false;
}

export async function bootstrap({ baseUrl, fetch, sleep, user, password, libraries, expected, log = () => {} }) {
  log('waiting for server to be ready');
  await waitReady({ baseUrl, fetch, sleep });
  const api = client({ baseUrl, fetch });
  const info = await api.get('/System/Info/Public');
  if (wizardCompletedFlag(info.json)) {
    throw new Error('server has already completed the startup wizard; expected a fresh server');
  }
  log('finishing startup wizard');
  await finishWizard(api, { user, password });
  log('logging in');
  const { token, userId, policy } = await login(api, { user, password });
  const authed = client({ baseUrl, fetch, token });
  log('adding libraries');
  await addLibraries(authed, libraries);
  log('scanning library');
  const counts = await scanUntil(authed, expected, { sleep });
  log('silencing scheduled tasks');
  const tasks = await silenceTasks(authed);
  log('hiding user');
  await hideUser(authed, { userId, policy });
  log('done');
  return { counts, tasks };
}

async function runCli() {
  const [baseUrl, configFile] = process.argv.slice(2);
  if (!baseUrl || !configFile) {
    console.error('usage: node bootstrap.mjs <baseUrl> <configJsonFile>');
    process.exit(1);
  }
  try {
    const raw = fs.readFileSync(configFile, 'utf8');
    const cfg = JSON.parse(raw);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const result = await bootstrap({
      baseUrl,
      fetch: globalThis.fetch,
      sleep,
      user: cfg.user,
      password: cfg.password,
      libraries: cfg.libraries,
      expected: cfg.expected,
      log: (...args) => console.log(...args),
    });
    console.log(JSON.stringify(result));
  } catch (err) {
    console.error(err && err.message ? err.message : String(err));
    process.exit(1);
  }
}

let isDirect = false;
try {
  if (process.argv[1]) {
    isDirect = import.meta.url === pathToFileURL(process.argv[1]).href;
  }
} catch {
  isDirect = false;
}
if (isDirect) {
  await runCli();
}
