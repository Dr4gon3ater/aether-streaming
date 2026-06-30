/**
 * API client to communicate with the Xtream Codes server.
 * Handles CORS proxying, fetching metadata, categories, and streams.
 */
class XtreamAPI {
  constructor() {
    this.serverUrl = '';
    this.username = '';
    this.password = '';
    this.corsProxy = 'https://corsproxy.io/?'; // Default CORS proxy
  }

  /**
   * Configures credentials and CORS proxy.
   */
  configure(serverUrl, username, password, corsProxy = 'https://corsproxy.io/?') {
    // Trim trailing slash from server URL
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.username = username;
    this.password = password;
    this.corsProxy = corsProxy;
  }

  /**
   * Helper to format request URL with credentials.
   */
  buildUrl(action = null, extraParams = {}) {
    let baseUrl = `${this.serverUrl}/player_api.php?username=${encodeURIComponent(this.username)}&password=${encodeURIComponent(this.password)}`;
    if (action) {
      baseUrl += `&action=${action}`;
    }
    for (const [key, val] of Object.entries(extraParams)) {
      baseUrl += `&${key}=${encodeURIComponent(val)}`;
    }
    
    // Apply CORS Proxy if chosen
    if (this.corsProxy && this.corsProxy !== 'direct') {
      return `${this.corsProxy}${encodeURIComponent(baseUrl)}`;
    }
    return baseUrl;
  }

  /**
   * Login/Authenticate against the Xtream server.
   */
  async login() {
    const url = this.buildUrl();
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

      let data;
      try {
        data = await response.json();
      } catch (parseErr) {
        return { success: false, error: 'Server hat keine gültige Antwort gesendet (kein JSON). Prüfe die Server-URL.' };
      }

      // Xtream servers may return auth as integer 1 or string "1"
      const authOk =
        (data.user_info && (data.user_info.auth == 1)) ||
        (data.auth == 1);

      if (authOk) {
        // Save user info to current profile's DB for expiry badge
        if (window.db && window.db.db) {
          await window.db.saveSetting('userInfo', data.user_info || {});
        }
        return {
          success: true,
          userInfo: data.user_info,
          serverInfo: data.server_info
        };
      } else {
        const reason = data.user_info ? 'Ungültige Zugangsdaten' : 'Unbekannte Serverantwort';
        return { success: false, error: reason };
      }
    } catch (err) {
      console.error('[API] Login error:', err);
      return { success: false, error: 'Verbindung fehlgeschlagen: ' + err.message };
    }
  }

  /**
   * Fetch Live TV Categories.
   */
  async fetchLiveCategories() {
    const url = this.buildUrl('get_live_categories');
    const response = await fetch(url);
    return response.json();
  }

  /**
   * Fetch Live TV Streams.
   */
  async fetchLiveStreams() {
    const url = this.buildUrl('get_live_streams');
    const response = await fetch(url);
    return response.json();
  }

  /**
   * Fetch Movie Categories.
   */
  async fetchMovieCategories() {
    const url = this.buildUrl('get_vod_categories');
    const response = await fetch(url);
    return response.json();
  }

  /**
   * Fetch Movie Streams.
   */
  async fetchMovieStreams() {
    const url = this.buildUrl('get_vod_streams');
    const response = await fetch(url);
    return response.json();
  }

  /**
   * Fetch Series Categories.
   */
  async fetchSeriesCategories() {
    const url = this.buildUrl('get_series_categories');
    const response = await fetch(url);
    return response.json();
  }

  /**
   * Fetch Series Streams.
   */
  async fetchSeriesStreams() {
    const url = this.buildUrl('get_series');
    const response = await fetch(url);
    return response.json();
  }

  /**
   * Fetch Movie Detail Info (IMDb, Plot, Cast, etc.).
   */
  async fetchMovieInfo(vodId) {
    const url = this.buildUrl('get_vod_info', { vod_id: vodId });
    const response = await fetch(url);
    return response.json();
  }

  /**
   * Fetch Series Detail Info (Seasons & Episodes).
   */
  async fetchSeriesInfo(seriesId) {
    const url = this.buildUrl('get_series_info', { series_id: seriesId });
    const response = await fetch(url);
    return response.json();
  }

  /**
   * Fetch Live TV EPG (Electronic Program Guide) for a specific stream
   */
  async fetchLiveEPG(streamId, limit = 10) {
    const url = this.buildUrl('get_short_epg', { stream_id: streamId, limit });
    const response = await fetch(url);
    return response.json();
  }

  /**
   * Formats a direct stream URL.
   * type: 'live' | 'movie' | 'series'
   * extension: 'ts' | 'm3u8' | 'mp4' | 'mkv' etc.
   */
  getStreamUrl(streamId, type = 'live', extension = 'mp4', skipCors = false) {
    let typePath = 'live';
    if (type === 'movie')  typePath = 'movie';
    if (type === 'series') typePath = 'series';

    // Live streams should use .m3u8 for HLS.js to work. VOD uses their native container (e.g. .mp4, .mkv)
    const ext = type === 'live' ? 'm3u8' : extension;
    const directUrl = `${this.serverUrl}/${typePath}/${this.username}/${this.password}/${streamId}.${ext}`;

    if (!skipCors && this.corsProxy && this.corsProxy !== 'direct') {
      return `${this.corsProxy}${encodeURIComponent(directUrl)}`;
    }

    return directUrl;
  }

  /**
   * Syncs all IPTV data and stores it in IndexedDB.
   * callback progress(message, percentage)
   */
  async syncPlaylist(progressCallback = () => {}) {
    try {
      progressCallback('Verbindung prüfen...', 5);
      const loginCheck = await this.login();
      if (!loginCheck.success) {
        throw new Error(loginCheck.error);
      }

      // Save user details
      await window.db.saveSetting('userInfo', loginCheck.userInfo);
      await window.db.saveSetting('serverInfo', loginCheck.serverInfo);

      return new Promise((resolve) => {
        const worker = new Worker('js/worker.js');
        worker.onmessage = (e) => {
          if (e.data.type === 'progress') {
            progressCallback(e.data.message, e.data.percent);
          } else if (e.data.type === 'sync_done') {
            worker.terminate();
            resolve({ success: true, lastSync: e.data.lastSync });
          } else if (e.data.type === 'error') {
            worker.terminate();
            progressCallback(`Fehler: ${e.data.message}`, -1);
            resolve({ success: false, error: e.data.message });
          }
        };

        worker.postMessage({
          cmd: 'SYNC',
          profileId: window.db.activeProfileId,
          serverUrl: this.serverUrl,
          username: this.username,
          password: this.password,
          corsProxy: this.corsProxy
        });
      });
    } catch (err) {
      console.error('Sync failed:', err);
      progressCallback(`Fehler: ${err.message}`, -1);
      return { success: false, error: err.message };
    }
  }
}

// Export a single instance
window.api = new XtreamAPI();
