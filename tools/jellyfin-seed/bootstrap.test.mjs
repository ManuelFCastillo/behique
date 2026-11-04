import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  client,
  libraryOptions,
  waitReady,
  finishWizard,
  login,
  addLibraries,
  scanUntil,
  silenceTasks,
  hideUser,
  bootstrap,
} from './bootstrap.mjs';

function jsonResponse(status, body) {
  const text = body === undefined || body === null || body === '' ? '' : JSON.stringify(body);
  return {
    status,
    text: async () => text,
  };
}

function makeServer(opts = {}) {
  const calls = [];
  const state = {
    startupCalls: 0,
    startupUserGetCalled: false,
    wizardDone: false,
    token: 'tok-1',
    userId: 'user-1',
    policy: { IsAdministrator: true },
    hidden: false,
    tasks: opts.tasks ?? [
      { Id: 't1', Name: 'Task one', Triggers: null },
      { Id: 't2', Name: 'Task two' },
    ],
    publicUsers: opts.publicUsers,
    countsSeq: opts.countsSeq ?? [
      { MovieCount: 0, SeriesCount: 0, EpisodeCount: 0 },
      { MovieCount: 1, SeriesCount: 1, EpisodeCount: 2 },
      { MovieCount: 1, SeriesCount: 1, EpisodeCount: 2 },
      { MovieCount: 1, SeriesCount: 1, EpisodeCount: 2 },
      { MovieCount: 1, SeriesCount: 1, EpisodeCount: 2 },
    ],
    countsIndex: 0,
    refreshCalls: 0,
    failOn: opts.failOn ?? null,
    infoCasing: opts.infoCasing ?? 'camel',
    wizardComplete: opts.wizardComplete ?? false,
    startup503s: opts.startup503s ?? 2,
    rejectStartupTimes: opts.rejectStartupTimes ?? 0,
  };
  async function fakeFetch(url, init = {}) {
    const method = (init.method || 'GET').toUpperCase();
    const u = new URL(url, 'http://x');
    const path = u.pathname + u.search;
    const pathname = u.pathname;
    calls.push({ method, path, pathname, search: u.search, headers: init.headers || {}, body: init.body });
    const fail = state.failOn;
    if (fail && fail.method === method && (fail.path === path || fail.path === pathname)) {
      return jsonResponse(fail.status, fail.body);
    }
    if (pathname === '/Startup/Configuration' && method === 'GET') {
      if (state.rejectStartupTimes > 0) {
        state.rejectStartupTimes -= 1;
        throw new Error('connection refused');
      }
      state.startupCalls += 1;
      if (state.startupCalls <= state.startup503s) return jsonResponse(503, '');
      return jsonResponse(200, {});
    }
    if (pathname === '/System/Info/Public' && method === 'GET') {
      const val = state.wizardComplete;
      const body = state.infoCasing === 'pascal' ? { StartupWizardCompleted: val } : { startupWizardCompleted: val };
      return jsonResponse(200, body);
    }
    if (pathname === '/Startup/Configuration' && method === 'POST') return jsonResponse(204, '');
    if (pathname === '/Startup/User' && method === 'GET') {
      state.startupUserGetCalled = true;
      return jsonResponse(200, {});
    }
    if (pathname === '/Startup/User' && method === 'POST') {
      if (!state.startupUserGetCalled) return jsonResponse(400, { error: 'get first' });
      return jsonResponse(204, '');
    }
    if (pathname === '/Startup/RemoteAccess' && method === 'POST') return jsonResponse(204, '');
    if (pathname === '/Startup/Complete' && method === 'POST') {
      state.wizardDone = true;
      return jsonResponse(204, '');
    }
    if (pathname === '/Users/AuthenticateByName' && method === 'POST') {
      return jsonResponse(200, { User: { Id: state.userId, Policy: state.policy }, AccessToken: state.token });
    }
    if (pathname === '/Library/VirtualFolders' && method === 'POST') {
      const auth = (init.headers && init.headers.Authorization) || '';
      assert.ok(auth.includes(`Token="${state.token}"`), 'missing token');
      return jsonResponse(204, '');
    }
    if (pathname === '/Library/Refresh' && method === 'POST') {
      state.refreshCalls += 1;
      state.countsIndex = 0;
      return jsonResponse(204, '');
    }
    if (pathname === '/Items/Counts' && method === 'GET') {
      const seq = state.countsSeq;
      const idx = Math.min(state.countsIndex, seq.length - 1);
      state.countsIndex += 1;
      return jsonResponse(200, seq[idx]);
    }
    if (pathname === '/ScheduledTasks' && method === 'GET') {
      return jsonResponse(200, state.tasks);
    }
    if (pathname.startsWith('/ScheduledTasks/') && pathname.endsWith('/Triggers') && method === 'POST') {
      const auth = (init.headers && init.headers.Authorization) || '';
      assert.ok(auth.includes(`Token="${state.token}"`), 'missing token on triggers');
      return jsonResponse(204, '');
    }
    if (pathname === `/Users/${state.userId}/Policy` && method === 'POST') {
      state.hidden = true;
      return jsonResponse(204, '');
    }
    if (pathname === '/Users/Public' && method === 'GET') {
      if (state.publicUsers !== undefined) return jsonResponse(200, state.publicUsers);
      return jsonResponse(200, state.hidden ? [] : [{ Name: 'seed' }]);
    }
    return jsonResponse(404, { error: 'unknown ' + method + ' ' + path });
  }
  return { calls, state, fakeFetch };
}

const noSleep = async () => {};
const immediateSleepLog = () => {
  const calls = [];
  const sleep = async (ms) => {
    calls.push(ms);
  };
  return { calls, sleep };
};

describe('libraryOptions', () => {
  it('movies kind', () => {
    const o = libraryOptions('movies', '/media/movies');
    assert.deepEqual(o.PathInfos, [{ Path: '/media/movies' }]);
    assert.equal(o.EnableRealtimeMonitor, false);
    assert.equal(o.EnablePhotos, false);
    assert.equal(o.EnableChapterImageExtraction, false);
    assert.equal(o.ExtractChapterImagesDuringLibraryScan, false);
    assert.equal(o.EnableTrickplayImageExtraction, false);
    assert.equal(o.EnableLUFSScan, false);
    assert.deepEqual(o.MetadataSavers, []);
    assert.deepEqual(o.LocalMetadataReaderOrder, ['Nfo']);
    assert.deepEqual(o.TypeOptions, [{ Type: 'Movie', MetadataFetchers: [], ImageFetchers: [] }]);
  });
  it('tvshows kind', () => {
    const o = libraryOptions('tvshows', '/media/tv');
    assert.deepEqual(
      o.TypeOptions,
      ['Series', 'Season', 'Episode'].map((Type) => ({ Type, MetadataFetchers: [], ImageFetchers: [] }))
    );
  });
});

describe('happy path and order', () => {
  it('full bootstrap in order', async () => {
    const { calls, fakeFetch } = makeServer();
    const logs = [];
    const libraries = [
      { name: 'Movies', kind: 'movies', path: '/media/movies' },
      { name: 'Shows', kind: 'tvshows', path: '/media/tv' },
    ];
    const expected = { MovieCount: 1, SeriesCount: 1, EpisodeCount: 2 };
    const result = await bootstrap({
      baseUrl: 'http://srv:8096',
      fetch: fakeFetch,
      sleep: noSleep,
      user: 'admin',
      password: 'pw',
      libraries,
      expected,
      log: (m) => logs.push(m),
    });
    assert.deepEqual(result.counts, expected);
    assert.equal(result.tasks, 2);
    assert.ok(logs.length >= 7);
    const seq = calls.map((c) => `${c.method} ${c.pathname}`);
    const order = [
      'GET /Startup/Configuration',
      'GET /System/Info/Public',
      'POST /Startup/Configuration',
      'GET /Startup/User',
      'POST /Startup/User',
      'POST /Startup/RemoteAccess',
      'POST /Startup/Complete',
      'POST /Users/AuthenticateByName',
      'POST /Library/VirtualFolders',
      'POST /Library/VirtualFolders',
      'POST /Library/Refresh',
      'GET /Items/Counts',
      'GET /ScheduledTasks',
      'POST /ScheduledTasks/t1/Triggers',
      'POST /ScheduledTasks/t2/Triggers',
    ];
    let idx = 0;
    for (const want of order) {
      const found = seq.indexOf(want, idx);
      assert.ok(found >= 0, `missing ${want} in ${seq.join(',')}`);
      idx = found + 1;
    }
    const authHeader = calls.find((c) => c.pathname === '/Library/VirtualFolders').headers.Authorization;
    assert.ok(authHeader.includes('Token="tok-1"'));
    assert.ok(authHeader.includes('MediaBrowser Client="seed"'));
    assert.equal(calls.find((c) => c.method === 'GET' && c.pathname === '/ScheduledTasks').headers.Authorization.includes('Token="tok-1"'), true);
    const libCall = calls.find((c) => c.pathname === '/Library/VirtualFolders');
    assert.ok(libCall.path.includes('refreshLibrary=false'));
    assert.ok(libCall.search.includes('collectionType='));
  });

  it('reads PascalCase wizard flag', async () => {
    const { fakeFetch } = makeServer({ infoCasing: 'pascal', wizardComplete: false });
    const logs = [];
    const r = await bootstrap({
      baseUrl: 'http://srv',
      fetch: fakeFetch,
      sleep: noSleep,
      user: 'a',
      password: 'b',
      libraries: [],
      expected: { MovieCount: 1, SeriesCount: 1, EpisodeCount: 2 },
      log: (m) => logs.push(m),
    });
    assert.deepEqual(r.counts, { MovieCount: 1, SeriesCount: 1, EpisodeCount: 2 });
  });

  it('already finished server throws', async () => {
    const { fakeFetch } = makeServer({ wizardComplete: true });
    await assert.rejects(
      () =>
        bootstrap({
          baseUrl: 'http://srv',
          fetch: fakeFetch,
          sleep: noSleep,
          user: 'a',
          password: 'b',
          libraries: [],
          expected: { MovieCount: 0, SeriesCount: 0, EpisodeCount: 0 },
        }),
      /already completed|fresh/i
    );
  });
  it('already finished pascal casing throws', async () => {
    const { fakeFetch } = makeServer({ wizardComplete: true, infoCasing: 'pascal' });
    await assert.rejects(
      () =>
        bootstrap({
          baseUrl: 'http://srv',
          fetch: fakeFetch,
          sleep: noSleep,
          user: 'a',
          password: 'b',
          libraries: [],
          expected: { MovieCount: 0, SeriesCount: 0, EpisodeCount: 0 },
        }),
      /already completed|fresh/i
    );
  });
});

describe('wrong statuses name step', () => {
  it('each wizard step names itself', async () => {
    const steps = [
      { method: 'POST', path: '/Startup/Configuration' },
      { method: 'GET', path: '/Startup/User' },
      { method: 'POST', path: '/Startup/User' },
      { method: 'POST', path: '/Startup/RemoteAccess' },
      { method: 'POST', path: '/Startup/Complete' },
    ];
    for (const s of steps) {
      const { fakeFetch } = makeServer({ failOn: { method: s.method, path: s.path, status: 500 } });
      const api = client({ baseUrl: 'http://srv', fetch: fakeFetch });
      await assert.rejects(() => finishWizard(api, { user: 'u', password: 'p' }), (err) => {
        assert.ok(String(err.message).includes(s.path), `error ${err.message} missing ${s.path}`);
        assert.ok(String(err.message).includes('500'));
        return true;
      });
    }
  });
});

describe('scanUntil', () => {
  it('waits for steady counts', async () => {
    const { fakeFetch, state } = makeServer({
      countsSeq: [
        { MovieCount: 0, SeriesCount: 0, EpisodeCount: 0 },
        { MovieCount: 1, SeriesCount: 1, EpisodeCount: 2 },
        { MovieCount: 1, SeriesCount: 1, EpisodeCount: 2 },
        { MovieCount: 1, SeriesCount: 1, EpisodeCount: 2 },
      ],
    });
    const api = client({ baseUrl: 'http://srv', fetch: fakeFetch, token: state.token });
    const sleeps = [];
    const counts = await scanUntil(api, { MovieCount: 1, SeriesCount: 1, EpisodeCount: 2 }, {
      sleep: async (ms) => sleeps.push(ms),
      everyMs: 2000,
      steadyPolls: 3,
    });
    assert.deepEqual(counts, { MovieCount: 1, SeriesCount: 1, EpisodeCount: 2 });
    assert.equal(state.refreshCalls, 1);
    assert.ok(sleeps.length >= 3);
  });
  it('overshoot throws showing expected and last', async () => {
    const { fakeFetch, state } = makeServer({
      countsSeq: [
        { MovieCount: 5, SeriesCount: 5, EpisodeCount: 5 },
        { MovieCount: 5, SeriesCount: 5, EpisodeCount: 5 },
        { MovieCount: 5, SeriesCount: 5, EpisodeCount: 5 },
      ],
    });
    const api = client({ baseUrl: 'http://srv', fetch: fakeFetch, token: state.token });
    const expected = { MovieCount: 1, SeriesCount: 1, EpisodeCount: 2 };
    await assert.rejects(
      () => scanUntil(api, expected, { sleep: noSleep, timeoutMs: 50, everyMs: 10, steadyPolls: 2 }),
      (err) => {
        assert.ok(String(err.message).includes(JSON.stringify(expected)) || String(err.message).includes('1'));
        assert.ok(String(err.message).includes('5'));
        return true;
      }
    );
  });
  it('timeout uses injected sleep with no real waiting', async () => {
    const { fakeFetch, state } = makeServer({
      countsSeq: [{ MovieCount: 0, SeriesCount: 0, EpisodeCount: 0 }],
    });
    const api = client({ baseUrl: 'http://srv', fetch: fakeFetch, token: state.token });
    const { calls, sleep } = immediateSleepLog();
    const start = Date.now();
    await assert.rejects(() =>
      scanUntil(api, { MovieCount: 9, SeriesCount: 9, EpisodeCount: 9 }, { sleep, timeoutMs: 30, everyMs: 10, steadyPolls: 2 })
    );
    const took = Date.now() - start;
    assert.ok(calls.length >= 3, `expected fake sleeps, got ${calls.length}`);
    assert.ok(took < 1000, `took too long: ${took}`);
  });
});

describe('waitReady', () => {
  it('503 twice then ready, and rejection counts as not ready', async () => {
    const { fakeFetch } = makeServer({ startup503s: 2, rejectStartupTimes: 1 });
    const sleeps = [];
    await waitReady({ baseUrl: 'http://srv', fetch: fakeFetch, sleep: async (ms) => sleeps.push(ms), timeoutMs: 5000, everyMs: 5 });
    assert.ok(sleeps.length >= 2);
  });
  it('timeout throws in plain words', async () => {
    const failing = async () => {
      throw new Error('down');
    };
    await assert.rejects(() => waitReady({ baseUrl: 'http://srv', fetch: failing, sleep: noSleep, timeoutMs: 20, everyMs: 10 }), /timed out|waiting|ready/i);
  });
});

describe('silenceTasks and hideUser', () => {
  it('calls every task even when Triggers null', async () => {
    const { fakeFetch } = makeServer();
    const api = client({ baseUrl: 'http://srv', fetch: fakeFetch, token: 'tok-1' });
    const n = await silenceTasks(api);
    assert.equal(n, 2);
  });
  it('hideUser fails if still public', async () => {
    const { fakeFetch } = makeServer({ publicUsers: [{ Name: 'admin' }] });
    const api = client({ baseUrl: 'http://srv', fetch: fakeFetch, token: 'tok-1' });
    await assert.rejects(() => hideUser(api, { userId: 'user-1', policy: { IsAdministrator: true } }), /Public/i);
  });
  it('client sends auth headers and empty post body', async () => {
    let seen = null;
    const f = async (url, init) => {
      seen = { url, init };
      return jsonResponse(200, {});
    };
    const api = client({ baseUrl: 'http://srv/', fetch: f });
    await api.post('/A');
    assert.equal(seen.init.body, '');
    assert.equal(seen.init.headers['Content-Type'], 'application/json');
    assert.ok(seen.init.headers.Authorization.includes('MediaBrowser'));
    const api2 = client({ baseUrl: 'http://srv', fetch: f, token: 'abc' });
    await api2.get('/B');
    assert.ok(seen.init.headers.Authorization.includes('Token="abc"'));
  });
  it('GET /Startup/User required before POST', async () => {
    const { fakeFetch } = makeServer();
    const api = client({ baseUrl: 'http://srv', fetch: fakeFetch });
    const r = await api.post('/Startup/User', { Name: 'x', Password: 'y' });
    assert.equal(r.status, 400);
  });
  it('login returns token userId policy', async () => {
    const { fakeFetch } = makeServer();
    const api = client({ baseUrl: 'http://srv', fetch: fakeFetch });
    const out = await login(api, { user: 'u', password: 'p' });
    assert.equal(out.token, 'tok-1');
    assert.equal(out.userId, 'user-1');
    assert.deepEqual(out.policy, { IsAdministrator: true });
  });
});
