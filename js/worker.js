// Web Worker for Background Sync & Heavy Search/Sorting
// This worker has no access to the DOM, window, or document.

let db = null;
const dbVersion = 2;

function openDB(profileId) {
  return new Promise((resolve, reject) => {
    const dbName = `IPTVNetflixDB_Profile_${profileId}`;
    const request = indexedDB.open(dbName, dbVersion);

    request.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };

    request.onerror = (e) => {
      reject(e.target.error);
    };
  });
}

function bulkPut(storeName, data, clearFirst = false) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);

    if (clearFirst) {
      store.clear();
    }

    data.forEach(item => store.put(item));

    transaction.oncomplete = () => resolve();
    transaction.onerror = (e) => reject(e.target.error);
  });
}

function saveSetting(key, value) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('settings', 'readwrite');
    const store = transaction.objectStore('settings');
    const request = store.put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = (e) => reject(e.target.error);
  });
}

async function handleSync(data) {
  const { profileId, serverUrl, username, password, corsProxy } = data;
  
  const buildUrl = (action, params = {}) => {
    const query = new URLSearchParams({ username, password, action, ...params }).toString();
    const directUrl = `${serverUrl}/player_api.php?${query}`;
    if (corsProxy && corsProxy !== 'direct') {
      return `${corsProxy}${encodeURIComponent(directUrl)}`;
    }
    return directUrl;
  };

  const fetchJson = async (action, params = {}) => {
    const res = await fetch(buildUrl(action, params));
    return res.json();
  };

  try {
    await openDB(profileId);
    
    // 1. Live Categories & Streams
    postMessage({ type: 'progress', message: 'Lade Live-TV Kategorien...', percent: 15 });
    const liveCats = await fetchJson('get_live_categories');
    await bulkPut('live_categories', liveCats, true);

    postMessage({ type: 'progress', message: 'Lade Live-TV Kanäle...', percent: 30 });
    const liveStreams = await fetchJson('get_live_streams');
    await bulkPut('live_streams', liveStreams, true);

    // 2. Movie Categories & Streams
    postMessage({ type: 'progress', message: 'Lade Film-Kategorien...', percent: 45 });
    const movieCats = await fetchJson('get_vod_categories');
    await bulkPut('movie_categories', movieCats, true);

    postMessage({ type: 'progress', message: 'Lade VOD Filme...', percent: 65 });
    const movies = await fetchJson('get_vod_streams');
    const moviesProcessed = movies.map(m => ({
      ...m,
      added: m.added ? parseInt(m.added) : 0
    }));
    await bulkPut('movies', moviesProcessed, true);

    // 3. Series Categories & Streams
    postMessage({ type: 'progress', message: 'Lade Serien-Kategorien...', percent: 80 });
    const seriesCats = await fetchJson('get_series_categories');
    await bulkPut('series_categories', seriesCats, true);

    postMessage({ type: 'progress', message: 'Lade Serien...', percent: 95 });
    const series = await fetchJson('get_series');
    const seriesProcessed = series.map(s => ({
      ...s,
      last_modified: s.last_modified ? parseInt(s.last_modified) : 0
    }));
    await bulkPut('series', seriesProcessed, true);

    const now = Date.now();
    await saveSetting('lastSync', now);
    
    postMessage({ type: 'progress', message: 'Synchronisierung abgeschlossen!', percent: 100 });
    postMessage({ type: 'sync_done', lastSync: now });
  } catch (err) {
    postMessage({ type: 'error', message: err.message });
  }
}

self.onmessage = async (e) => {
  if (e.data.cmd === 'SYNC') {
    await handleSync(e.data);
  }
};
