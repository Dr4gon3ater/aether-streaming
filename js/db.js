/**
 * IPTVNetflixDB - IndexedDB wrapper for caching and data storage.
 * Supports multiple profiles by isolating databases.
 */
class IPTVNetflixDB {
  constructor() {
    this.masterDbName = 'IPTVNetflixMasterDB';
    this.dbVersion = 2;
    this.masterDb = null;
    this.db = null; // Active profile DB
    this.activeProfileId = null;
  }

  /**
   * Initializes the Master database (stores profiles list and active profile ID).
   */
  async initMaster() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.masterDbName, this.dbVersion);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        // Global settings store (holds profiles, activeProfileId, etc.)
        if (!db.objectStoreNames.contains('global_settings')) {
          db.createObjectStore('global_settings');
        }
      };

      request.onsuccess = (event) => {
        this.masterDb = event.target.result;
        resolve(this);
      };

      request.onerror = (event) => {
        console.error('Master IndexedDB opening error:', event.target.error);
        reject(event.target.error);
      };

      request.onblocked = (event) => {
        console.warn('Master IndexedDB is blocked. Please close other instances.');
        alert('Die Hauptdatenbank wird blockiert. Bitte starte die App komplett neu (z.B. über den Task-Manager beenden).');
        reject(new Error('Master Database upgrade blocked'));
      };
    });
  }

  /**
   * Initializes a specific profile database.
   */
  async initProfile(profileId) {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    
    this.activeProfileId = String(profileId);
    const dbName = `IPTVNetflixDB_Profile_${profileId}`;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, this.dbVersion);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Settings store (key-value)
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings');
        }

        // Playback progress store
        if (!db.objectStoreNames.contains('progress')) {
          db.createObjectStore('progress', { keyPath: 'id' });
        }

        // Live Categories
        if (!db.objectStoreNames.contains('live_categories')) {
          db.createObjectStore('live_categories', { keyPath: 'category_id' });
        }

        // Movie Categories
        if (!db.objectStoreNames.contains('movie_categories')) {
          db.createObjectStore('movie_categories', { keyPath: 'category_id' });
        }

        // Series Categories
        if (!db.objectStoreNames.contains('series_categories')) {
          db.createObjectStore('series_categories', { keyPath: 'category_id' });
        }

        // Live Streams
        if (!db.objectStoreNames.contains('live_streams')) {
          const store = db.createObjectStore('live_streams', { keyPath: 'stream_id' });
          store.createIndex('category_id', 'category_id', { unique: false });
        }

        // Movies VOD
        if (!db.objectStoreNames.contains('movies')) {
          const store = db.createObjectStore('movies', { keyPath: 'stream_id' });
          store.createIndex('category_id', 'category_id', { unique: false });
          store.createIndex('added', 'added', { unique: false });
        }

        // Series VOD
        if (!db.objectStoreNames.contains('series')) {
          const store = db.createObjectStore('series', { keyPath: 'series_id' });
          store.createIndex('category_id', 'category_id', { unique: false });
          store.createIndex('last_modified', 'last_modified', { unique: false });
        }

        // Downloads Tracking
        if (!db.objectStoreNames.contains('downloads')) {
          const store = db.createObjectStore('downloads', { keyPath: 'id' });
          store.createIndex('status', 'status', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve(this);
      };

      request.onerror = (event) => {
        console.error(`Profile IndexedDB opening error (${dbName}):`, event.target.error);
        reject(event.target.error);
      };

      request.onblocked = (event) => {
        console.warn(`Profile IndexedDB is blocked. Please close other tabs/windows.`);
        alert("Die Datenbank wird blockiert. Bitte starte die App komplett neu (Schließen und wieder öffnen).");
        reject(new Error("Database upgrade blocked"));
      };
    });
  }

  // --- Master DB Helpers ---

  getGlobalSetting(key) {
    return new Promise((resolve, reject) => {
      const transaction = this.masterDb.transaction(['global_settings'], 'readonly');
      const store = transaction.objectStore('global_settings');
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  saveGlobalSetting(key, value) {
    return new Promise((resolve, reject) => {
      const transaction = this.masterDb.transaction(['global_settings'], 'readwrite');
      const store = transaction.objectStore('global_settings');
      const request = store.put(value, key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getProfiles() {
    return (await this.getGlobalSetting('profiles')) || [];
  }

  async saveProfiles(profiles) {
    if (window.cloudSync) window.cloudSync.pushProfiles(profiles);
    return this.saveGlobalSetting('profiles', profiles);
  }

  async getActiveProfileId() {
    return await this.getGlobalSetting('activeProfileId');
  }

  async setActiveProfileId(profileId) {
    return this.saveGlobalSetting('activeProfileId', profileId);
  }

  deleteProfileDB(profileId) {
    return new Promise((resolve) => {
      const dbName = `IPTVNetflixDB_Profile_${profileId}`;
      const req = indexedDB.deleteDatabase(dbName);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    });
  }

  // --- Active Profile DB Helpers (Generic operations) ---

  get(storeName, key) {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error('Kein Profil geladen'));
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(key);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  put(storeName, value, key) {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error('Kein Profil geladen'));
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = key ? store.put(value, key) : store.put(value);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  delete(storeName, key) {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error('Kein Profil geladen'));
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.delete(key);

      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  }

  getAll(storeName) {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error('Kein Profil geladen'));
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  bulkPut(storeName, items, clearFirst = false) {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error('Kein Profil geladen'));
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);

      if (clearFirst) {
        store.clear();
      }

      items.forEach(item => {
        store.put(item);
      });

      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  clearStore(storeName) {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error('Kein Profil geladen'));
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.clear();

      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  }

  getByIndex(storeName, indexName, value) {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error('Kein Profil geladen'));
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const index = store.index(indexName);
      const request = index.getAll(value);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // --- Profile DB Specific Helpers ---

  saveProgress(id, type, title, subtitle, position, duration, cover, extra = {}) {
    const percentage = duration > 0 ? (position / duration) * 100 : 0;
    const progressItem = {
      id: String(id),
      type, // 'movie' or 'series'
      title,
      subtitle, // e.g. "S1:E3 - Episode Name"
      position,
      duration,
      percentage,
      cover,
      lastWatched: Date.now(),
      ...extra
    };
    if (window.cloudSync) window.cloudSync.pushProgress(this.activeProfileId, progressItem);
    return this.put('progress', progressItem);
  }

  addFavoriteSeries(series) {
    if (window.cloudSync) window.cloudSync.pushFavorite(this.activeProfileId, 'series', series);
    return this.put('series', { ...series, _is_favorite: true });
  }

  getProgress(id) {
    return this.get('progress', String(id));
  }

  getAllProgress() {
    return this.getAll('progress').then(items => {
      if (!items) return [];
      // Sort by last watched descending
      return items.sort((a, b) => b.lastWatched - a.lastWatched);
    });
  }

  deleteProgress(id) {
    return this.delete('progress', String(id));
  }

  addFavoriteMovie(movie) {
    if (window.cloudSync) window.cloudSync.pushFavorite(this.activeProfileId, 'movie', movie);
    return this.put('movies', { ...movie, _is_favorite: true });
  }

  async saveSetting(key, value) {
    const res = await this.put('settings', value, key);
    if (window.cloudSync && !window.cloudSync.isPulling && this.activeProfileId) {
      const all = await this.getAllSettings();
      window.cloudSync.pushSettings(this.activeProfileId, all);
    }
    return res;
  }

  getSetting(key) {
    return this.get('settings', key);
  }

  async getAllSettings() {
    return {
      serverUrl: await this.getSetting('serverUrl'),
      username: await this.getSetting('username'),
      password: await this.getSetting('password'),
      corsProxy: await this.getSetting('corsProxy')
    };
  }

  // --- Intro Length Management ---

  async saveIntroLength(seriesId, lengthSecs) {
    const lengths = await this.getSetting('intro_lengths') || {};
    lengths[seriesId] = lengthSecs;
    return this.saveSetting('intro_lengths', lengths);
  }

  async getIntroLength(seriesId) {
    const lengths = await this.getSetting('intro_lengths') || {};
    return lengths[seriesId] || 85;
  }

  // --- Downloads Management ---

  async saveDownload(downloadItem) {
    // downloadItem should have: id (stream_id), title, subtitle, cover, type, status, progress, filePath, size
    return this.put('downloads', downloadItem);
  }

  async getDownload(streamId) {
    return this.get('downloads', streamId);
  }

  addFavoriteLive(stream) {
    if (window.cloudSync) window.cloudSync.pushFavorite(this.activeProfileId, 'live', stream);
    return this.put('live_streams', { ...stream, _is_favorite: true });
  }

  async getAllDownloads() {
    return this.getAll('downloads');
  }

  async deleteDownload(streamId) {
    return this.delete('downloads', streamId);
  }
}

// Export a single instance
window.db = new IPTVNetflixDB();
