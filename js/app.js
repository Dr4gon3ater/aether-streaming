/**
 * App.js - Coordinates application lifecycle, profile management,
 * login dialogs, background sync scheduling, and navigation routing.
 */

// Override console to send logs to the main process logger
if (window.electronAPI && window.electronAPI.log) {
  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);

  const safeArgs = (args) => {
    return args.map(a => {
      if (a instanceof Error) return a.toString() + ' ' + a.stack;
      if (typeof a === 'object') {
        try { return JSON.stringify(a); } catch (e) { return '[Unserializable Object]'; }
      }
      return String(a);
    });
  };

  console.log = (...args) => {
    try { window.electronAPI.log('info', ...safeArgs(args)); } catch (e) {}
    try { originalLog(...args); } catch (e) {}
  };
  console.warn = (...args) => {
    try { window.electronAPI.log('warn', ...safeArgs(args)); } catch (e) {}
    try { originalWarn(...args); } catch (e) {}
  };
  console.error = (...args) => {
    try { window.electronAPI.log('error', ...safeArgs(args)); } catch (e) {}
    try { originalError(...args); } catch (e) {}
  };
  
  // IMMEDIATE TEST LOG
  console.log('APP.JS LOADED - LOGGER WORKS!');
}

const AVATAR_COLORS = ['avatar-red', 'avatar-blue', 'avatar-green', 'avatar-yellow', 'avatar-purple'];

class IPTVNetflixApp {
  constructor() {
    this.isSyncing = false;
    this.isManagingProfiles = false;
    this.activeProfile = null;
  }

  // =========================================================================
  //  BOOT
  // =========================================================================

  async start() {
    try {
      // 1. Init Master Database (profiles list)
      await window.db.initMaster();
    } catch (err) {
      console.error("Master DB Init Failed:", err);
      alert("Kritischer Fehler: Hauptdatenbank konnte nicht geladen werden. " + err.message);
      // Fallback: Show login overlay so they aren't stuck on an empty screen
      this.showLoginOverlay(true);
      return;
    }

    // --- Cloud Sync Check ---
    if (window.cloudSync) {
      await window.cloudSync.waitForAuth();
      if (!window.cloudSync.isLoggedIn() && localStorage.getItem('skipCloudSync') !== 'true') {
        this.showCloudLoginOverlay();
        return; // Stop here until they login or skip
      } else if (window.cloudSync.isLoggedIn()) {
        // Pull latest profiles & progress before showing them
        await window.cloudSync.pullAllData(window.db);
      }
    }

    this.resumeStart();
  }

  async resumeStart() {
    let profiles = [];
    try {
      profiles = await window.db.getProfiles() || [];
    
    // RECOVERY LOGIC: If profiles array is empty, try to recover from existing IndexedDBs
    if (profiles.length === 0 && indexedDB.databases) {
      console.log("No profiles found. Attempting recovery...");
      try {
        const dbs = await indexedDB.databases();
        const recoveredProfiles = [];
        for (const dbInfo of dbs) {
          if (dbInfo.name && dbInfo.name.startsWith('IPTVNetflixDB_Profile_')) {
            const pid = dbInfo.name.replace('IPTVNetflixDB_Profile_', '');
            recoveredProfiles.push({
              id: pid,
              name: `Profil ${pid}`,
              server: '',
              user: '',
              pass: '',
              proxy: 'direct'
            });
          }
        }
        
        if (recoveredProfiles.length > 0) {
          await window.db.saveProfiles(recoveredProfiles);
          profiles = recoveredProfiles;
          alert("Es wurden alte Profile wiederhergestellt! Bitte wähle dein Profil aus und gib in den Einstellungen (Zahnrad) deine Login-Daten neu ein.");
        }
      } catch (err) {
        console.warn("Recovery failed:", err);
      }
    }
    } catch (err) {
      console.error("Error fetching profiles:", err);
      // Fallback
      profiles = [];
    }

    try {
      if (profiles.length === 0) {
        // No profiles yet → show add-profile form directly (no empty grid)
        this.showLoginOverlay(true);
      } else {
        const autoLoginEnabled = localStorage.getItem('autoLoginEnabled') !== 'false';
        const lastProfileId = localStorage.getItem('lastProfileId');

        if (autoLoginEnabled && lastProfileId) {
          const profileToLoad = profiles.find(p => String(p.id) === String(lastProfileId));
          if (profileToLoad) {
            this.selectProfile(profileToLoad);
            return; // skip showing the overlay
          }
        }
        
        // Show Netflix-style profile picker
        this.showProfileOverlay(profiles);
      }
    } catch(err) {
      console.error("Error rendering profiles:", err);
      this.showLoginOverlay(true);
    }
    
    // Global keyboard shortcuts
    this.setupKeyboardEvents();
  }

  // =========================================================================
  //  PROFILE SCREEN
  // =========================================================================

  showCloudLoginOverlay() {
    const cloudOverlay = document.getElementById('cloud-login-overlay');
    cloudOverlay.classList.remove('hidden');

    document.getElementById('btn-cloud-skip').onclick = (e) => {
      e.preventDefault();
      localStorage.setItem('skipCloudSync', 'true');
      cloudOverlay.classList.add('hidden');
      this.resumeStart();
    };

    document.getElementById('btn-cloud-login').onclick = async () => {
      const email = document.getElementById('cloud-email').value;
      const pass = document.getElementById('cloud-password').value;
      const err = document.getElementById('cloud-login-error');
      if (!email || !pass) { err.textContent = 'Bitte ausfüllen.'; err.style.display = 'block'; return; }
      
      const btn = document.getElementById('btn-cloud-login');
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
      const res = await window.cloudSync.login(email, pass);
      if (res.success) {
        err.style.display = 'none';
        await window.cloudSync.pullAllData(window.db);
        cloudOverlay.classList.add('hidden');
        this.resumeStart();
      } else {
        err.textContent = res.error;
        err.style.display = 'block';
        btn.innerHTML = 'Einloggen';
      }
    };

    document.getElementById('btn-cloud-register').onclick = async () => {
      const email = document.getElementById('cloud-email').value;
      const pass = document.getElementById('cloud-password').value;
      const err = document.getElementById('cloud-login-error');
      if (!email || !pass) { err.textContent = 'Bitte ausfüllen.'; err.style.display = 'block'; return; }
      
      const btn = document.getElementById('btn-cloud-register');
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
      const res = await window.cloudSync.register(email, pass);
      if (res.success) {
        err.style.display = 'none';
        cloudOverlay.classList.add('hidden');
        this.resumeStart();
      } else {
        err.textContent = res.error;
        err.style.display = 'block';
        btn.innerHTML = 'Neu registrieren';
      }
    };
  }

  showProfileOverlay(profiles) {
    const overlay  = document.getElementById('profile-overlay');
    const grid     = document.getElementById('profiles-grid');
    const manageBtn = document.getElementById('manage-profiles-btn');

    overlay.classList.remove('hidden');
    this.isManagingProfiles = false;
    manageBtn.textContent  = 'Profile verwalten';
    manageBtn.classList.remove('active');

    grid.innerHTML = '';

    // Render existing profiles
    profiles.forEach(profile => {
      const card = this.buildProfileCard(profile);
      grid.appendChild(card);
    });

    // "Add Profile" card (only up to 8 profiles)
    if (profiles.length < 8) {
      const addCard = document.createElement('div');
      addCard.className = 'profile-card';
      addCard.id = 'add-profile-card';
      addCard.innerHTML = `
        <div class="profile-avatar-wrapper">
          <div class="profile-avatar avatar-add">
            <i class="fas fa-plus"></i>
          </div>
        </div>
        <div class="profile-name">Profil hinzufügen</div>
      `;
      addCard.addEventListener('click', () => {
        alert("Add Profile Card clicked!");
        this.showLoginOverlay(false);
      });
      grid.appendChild(addCard);
    }

    // "Manage Profiles" button
    // Remove previous listeners if any (by cloning)
    const newManageBtn = manageBtn.cloneNode(true);
    manageBtn.parentNode.replaceChild(newManageBtn, manageBtn);
    
    newManageBtn.addEventListener('click', (e) => {
      console.log("Manage button clicked!");
      this.toggleManageMode(profiles);
    });
  }

  buildProfileCard(profile) {
    const card = document.createElement('div');
    card.className = 'profile-card';
    card.dataset.profileId = profile.id;

    const initial = (profile.name || '?').charAt(0).toUpperCase();
    const colorClass = AVATAR_COLORS[profile.colorIndex % AVATAR_COLORS.length];

    card.innerHTML = `
      <div class="profile-avatar-wrapper">
        <div class="profile-avatar ${colorClass}">${initial}</div>
      </div>
      <div class="profile-name">${profile.name}</div>
    `;

    card.addEventListener('click', () => {
      if (this.isManagingProfiles) return;
      this.selectProfile(profile);
    });
    return card;
  }

  toggleManageMode(profiles) {
    const grid      = document.getElementById('profiles-grid');
    const manageBtn = document.getElementById('manage-profiles-btn');

    this.isManagingProfiles = !this.isManagingProfiles;
    // DEBUG ALERT
    alert("Profile verwalten Modus: " + this.isManagingProfiles);

    if (this.isManagingProfiles) {
      manageBtn.textContent = 'Fertig';
      manageBtn.classList.add('active');

      // Add delete overlays to every existing profile card
      grid.querySelectorAll('.profile-card:not(#add-profile-card)').forEach(card => {
        const profileId = card.dataset.profileId;
        const profile   = profiles.find(p => String(p.id) === profileId);
        if (!profile) return;

        // Don't add twice
        if (card.querySelector('.profile-delete-overlay')) return;

        const overlay = document.createElement('div');
        overlay.className = 'profile-delete-overlay';
        overlay.innerHTML = `
          <button class="profile-delete-btn" title="Profil löschen">
            <i class="fas fa-trash"></i>
          </button>
        `;
        overlay.querySelector('.profile-delete-btn').addEventListener('click', async (e) => {
          e.stopPropagation();
          if (confirm(`Profil "${profile.name}" wirklich löschen? Alle Daten (Fortschritt, Favoriten, Cache) werden entfernt.`)) {
            await this.deleteProfile(profileId);
          }
        });

        card.querySelector('.profile-avatar-wrapper').appendChild(overlay);

        // Disable click-to-select while managing
        card.onclick = null;
      });

    } else {
      // Exit manage mode - re-render cleanly
      this.showProfileOverlay(profiles);
    }
  }

  async deleteProfile(profileId) {
    let profiles = await window.db.getProfiles();
    profiles = profiles.filter(p => String(p.id) !== String(profileId));
    await window.db.saveProfiles(profiles);

    // Delete the profile's IndexedDB
    await window.db.deleteProfileDB(profileId);

    // Re-render
    this.showProfileOverlay(profiles);

    if (profiles.length === 0) {
      this.showLoginOverlay(true);
    }
  }

  // =========================================================================
  //  PROFILE SELECTION → LOAD APP
  // =========================================================================

  async selectProfile(profile) {
    this.activeProfile = profile;
    
    // Save as last used profile
    localStorage.setItem('lastProfileId', profile.id);

    // Hide profile overlay
    document.getElementById('profile-overlay').classList.add('hidden');

    try {
      // Init the profile's own IndexedDB
      await window.db.initProfile(profile.id);

      // Init UI & player (only once)
      if (!window._uiInitialized) {
        if (!window.ui) throw new Error("window.ui is undefined! (Syntax error in ui.js)");
        if (!window.player) throw new Error("window.player is undefined! (Syntax error in player.js)");
        await window.ui.init();
        window.player.init();
        this.setupNavEvents();
        window._uiInitialized = true;
      }
      
      // Update sidebar profile name
      document.getElementById('sidebar-profile-indicator').textContent = profile.name;
    } catch(e) {
      console.error("Crash during selectProfile:", e);
      alert("Fehler beim Laden des Profils: " + (e.message || e));
      // Fallback: show profiles again
      document.getElementById('profile-overlay').classList.remove('hidden');
    }

    // Load API credentials from this profile's DB
    const serverUrl  = await window.db.getSetting('serverUrl');
    const username   = await window.db.getSetting('username');
    const password   = await window.db.getSetting('password');
    const corsProxy  = await window.db.getSetting('corsProxy') || 'direct';
    const appTheme   = await window.db.getSetting('appTheme') || '#e50914';

    document.documentElement.style.setProperty('--color-primary', appTheme);

    if (serverUrl && username && password) {
      window.api.configure(serverUrl, username, password, corsProxy);
      this.updateSidebarProfileBadge();
      this.updateSidebarSubscriptionBadge();

      // Check if data already cached
      const movies = await window.db.getAll('movies');
      const live = await window.db.getAll('live_streams');
      if ((!movies || movies.length === 0) && (!live || live.length === 0)) {
        this.showInitialSyncOverlay();
      } else {
        window.ui.switchTab('home');
        // Check if we need to sync in background based on settings
        this.checkBackgroundSync();
      }
    } else {
      // Profile exists but has no credentials yet → show login form
      this.showLoginOverlay(false);
    }
  }

  // =========================================================================
  //  LOGIN / ADD PROFILE
  // =========================================================================

  showLoginOverlay(hideBackButton = true) {
    const overlay = document.getElementById('login-overlay');
    const backBtn = document.getElementById('login-back-btn');

    overlay.classList.remove('hidden');

    // Reset form
    document.getElementById('login-form').reset();
    document.getElementById('login-error').classList.add('hidden');
    document.getElementById('login-submit-btn').disabled  = false;
    document.getElementById('login-submit-btn').innerHTML = 'Profil erstellen';

    if (hideBackButton || !this.activeProfile) {
      backBtn.classList.add('hidden');
    } else {
      backBtn.classList.remove('hidden');
      backBtn.onclick = () => {
        overlay.classList.add('hidden');
        window.db.getProfiles().then(p => this.showProfileOverlay(p));
      };
    }

    // Attach submit handler (remove any previous to avoid duplicates)
    const form = document.getElementById('login-form');
    form.onsubmit = (e) => this.handleLoginSubmit(e);
  }

  async handleLoginSubmit(e) {
    e.preventDefault();

    const btn     = document.getElementById('login-submit-btn');
    const errText = document.getElementById('login-error');

    // Gather values BEFORE any async work (so they're not lost)
    const profileName = (document.getElementById('login-profile-name').value || '').trim() || 'IPTV';
    const server      = (document.getElementById('login-server').value || '').trim();
    const user        = (document.getElementById('login-user').value || '').trim();
    const pass        = (document.getElementById('login-pass').value || '').trim();
    const proxy       = document.getElementById('login-proxy').value;

    // Basic validation
    if (!server || !user || !pass) {
      errText.textContent = 'Bitte alle Felder ausfüllen (Server-URL, Benutzername, Passwort).';
      errText.classList.remove('hidden');
      return;
    }

    btn.disabled  = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verbinde...';
    errText.classList.add('hidden');

    try {
      window.api.configure(server, user, pass, proxy);

      const loginResult = await window.api.login();
      console.log('[Login] Result:', loginResult);

      if (loginResult.success) {
        // Build profile object
        let profiles = await window.db.getProfiles();
        let profile;

        if (this.activeProfile) {
          profile = this.activeProfile;
          profile.name = profileName;
          // Update in list
          const idx = profiles.findIndex(p => String(p.id) === String(profile.id));
          if (idx !== -1) profiles[idx] = profile;
        } else {
          profile = {
            id:         Date.now(),
            name:       profileName,
            colorIndex: profiles.length % AVATAR_COLORS.length
          };
          profiles.push(profile);
        }

        await window.db.saveProfiles(profiles);
        await window.db.setActiveProfileId(profile.id);

        // Init profile DB and save credentials
        await window.db.initProfile(profile.id);
        await window.db.saveSetting('serverUrl', server);
        await window.db.saveSetting('username',  user);
        await window.db.saveSetting('password',  pass);
        await window.db.saveSetting('corsProxy', proxy);

        this.activeProfile = profile;

        if (!window._uiInitialized) {
          await window.ui.init();
          window.player.init();
          this.setupNavEvents();
          window._uiInitialized = true;
        }

        this.updateSidebarProfileBadge();
        this.updateSidebarSubscriptionBadge();
        
        // Only force sync if DB is empty, otherwise let checkBackgroundSync handle it
        const movies = await window.db.getAll('movies');
        const live = await window.db.getAll('live_streams');
        if ((!movies || movies.length === 0) && (!live || live.length === 0)) {
          this.showInitialSyncOverlay();
        } else {
          document.getElementById('login-overlay').classList.add('hidden');
          window.ui.switchTab('home');
          this.checkBackgroundSync();
        }

      } else {
        errText.textContent = loginResult.error || 'Zugangsdaten ungültig oder Server nicht erreichbar.';
        errText.classList.remove('hidden');
        btn.disabled  = false;
        btn.innerHTML = 'Profil erstellen';
      }

    } catch (err) {
      console.error('[Login] Unerwarteter Fehler:', err);
      errText.textContent = 'Unerwarteter Fehler: ' + (err.message || String(err));
      errText.classList.remove('hidden');
      btn.disabled  = false;
      btn.innerHTML = 'Profil erstellen';
    }
  }

  // =========================================================================
  //  SIDEBAR EVENTS (set up once)
  // =========================================================================

  setupNavEvents() {
    document.querySelectorAll('.sidebar-nav-item').forEach(item => {
      item.addEventListener('click', () => {
        window.ui.switchTab(item.dataset.tab);
      });
    });

    // Profile switcher click in sidebar
    const profileIndicator = document.getElementById('sidebar-profile-indicator');
    if (profileIndicator) {
      profileIndicator.addEventListener('click', async () => {
        // Stop player if running
        if (!document.getElementById('netflix-player-container').classList.contains('hidden')) {
          window.player.stop();
        }
        // Close any modals
        document.getElementById('netflix-detail-modal').classList.add('hidden');

        // Show profile screen again
        const profiles = await window.db.getProfiles();
        this.showProfileOverlay(profiles);
      });
    }

    window.addEventListener('settings-saved',   () => { this.updateSidebarSubscriptionBadge(); this.updateSidebarProfileBadge(); });
    window.addEventListener('playlist-synced',  () => this.updateSidebarSubscriptionBadge());
  }

  setupKeyboardEvents() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const modal  = document.getElementById('netflix-detail-modal');
        const player = document.getElementById('netflix-player-container');
        if (modal  && !modal.classList.contains('hidden'))  { modal.classList.add('hidden'); return; }
        if (player && !player.classList.contains('hidden')) { window.player.stop(); return; }
      }
      if (e.key === ' ' && e.target === document.body) {
        const player = document.getElementById('netflix-player-container');
        if (player && !player.classList.contains('hidden')) {
          e.preventDefault();
          const video = document.getElementById('netflix-video');
          video.paused ? video.play() : video.pause();
        }
      }
    });
  }

  // =========================================================================
  //  SIDEBAR BADGES
  // =========================================================================

  updateSidebarProfileBadge() {
    const el = document.getElementById('sidebar-profile-indicator');
    if (!el || !this.activeProfile) return;

    const initial    = (this.activeProfile.name || '?').charAt(0).toUpperCase();
    const colorClass = AVATAR_COLORS[this.activeProfile.colorIndex % AVATAR_COLORS.length];

    el.innerHTML = `
      <div class="sidebar-profile-avatar ${colorClass}">${initial}</div>
      <span>${this.activeProfile.name}</span>
      <i class="fas fa-chevron-down" style="margin-left:auto;font-size:0.7rem;color:#888;"></i>
    `;
  }

  async updateSidebarSubscriptionBadge() {
    const badge    = document.getElementById('sidebar-expiry-badge');
    const userInfo = await window.db.getSetting('userInfo');
    if (!badge) return;

    if (!userInfo) { badge.style.display = 'none'; return; }

    badge.style.display = 'block';
    let expiryText = 'Abo: Unbegrenzt';
    let isExpired  = false;

    if (userInfo.exp_date) {
      const expVal = userInfo.exp_date;
      if (expVal && expVal !== '0' && expVal !== 'null' && expVal !== 'Unlimited') {
        const expDate  = new Date(parseInt(expVal) * 1000);
        const diffDays = Math.ceil((expDate.getTime() - Date.now()) / 86400000);
        const formatted = expDate.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });

        if (diffDays <= 0)      { expiryText = 'Abo: Abgelaufen'; isExpired = true; }
        else if (diffDays <= 7) { expiryText = `Abo läuft ab: ${formatted} (${diffDays} Tage)`; }
        else                    { expiryText = `Ablauf: ${formatted}`; }
      }
    }

    badge.className = 'sidebar-expiry-badge' + (isExpired ? ' expired' : '');
    badge.innerHTML = `<i class="fas fa-key"></i> <span>${expiryText}</span>`;
  }

  // =========================================================================
  //  FIRST-SYNC OVERLAY
  // =========================================================================

  showInitialSyncOverlay() {
    const overlay = document.getElementById('sync-overlay');
    const fill    = document.getElementById('sync-fill');
    const status  = document.getElementById('sync-status');

    fill.style.width = '0%';
    fill.classList.remove('error');
    status.innerHTML = 'Verbindung prüfen...';
    overlay.classList.remove('hidden');

    window.api.syncPlaylist((message, pct) => {
      status.textContent = message;
      if (pct >= 0) { fill.style.width = `${pct}%`; }
      else          { fill.classList.add('error'); }
    }).then(result => {
      if (result.success) {
        status.textContent = 'Fertig! App lädt...';
        setTimeout(() => {
          overlay.classList.add('hidden');
          window.ui.switchTab('home');
          this.checkBackgroundSync();
        }, 1200);
      } else {
        status.innerHTML = `
          <span style="color:var(--color-primary);">Fehler bei der Synchronisierung</span><br>
          <small>${result.error || 'Netzwerkfehler'}</small>
          <div style="margin-top:20px;">
            <button onclick="window.app.showInitialSyncOverlay()" class="btn-sync-retry">
              <i class="fas fa-rotate"></i> Erneut versuchen
            </button>
            <button onclick="window.db.getProfiles().then(p=>window.app.showProfileOverlay(p))" class="btn-sync-back">
              <i class="fas fa-arrow-left"></i> Zurück
            </button>
          </div>`;
        overlay.classList.remove('hidden');
      }
    });
  }

  // =========================================================================
  //  BACKGROUND AUTO-SYNC
  // =========================================================================

  async checkBackgroundSync() {
    if (this.isSyncing) return;
    const intervalVal = await window.db.getSetting('updateInterval') || '24';
    if (intervalVal === 'manual') return;
    const lastSync    = await window.db.getSetting('lastSync');
    if (!lastSync) return;
    const elapsed = (Date.now() - lastSync) / 3600000; // hours
    if (elapsed >= parseInt(intervalVal)) this.triggerBackgroundSync();
  }

  async triggerBackgroundSync() {
    this.isSyncing = true;
    const logoArea    = document.querySelector('.sidebar-logo');
    const spinner     = Object.assign(document.createElement('div'), { className: 'sidebar-sync-spinner', title: 'Playlist wird aktualisiert...' });
    spinner.innerHTML = '<i class="fas fa-arrows-spin fa-spin" style="color:var(--color-primary);"></i>';
    logoArea.appendChild(spinner);

    const result = await window.api.syncPlaylist();
    spinner.remove();
    this.isSyncing = false;

    if (result.success) {
      window.ui.showToast('Playlist aktualisiert');
      window.ui.refreshCurrentView();
    }
  }
}

// =========================================================================
//  BOOT
// =========================================================================
window.app = new IPTVNetflixApp();
window.addEventListener('DOMContentLoaded', () => window.app.start());
