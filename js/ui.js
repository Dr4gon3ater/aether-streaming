/**
 * Renders Netflix-style pages, lists, grids, modal dialogues, search and EPG elements.
 */
class NetflixUI {
  constructor() {
    this.activeTab = 'home';
    this.currentCategory = 'all';
    this.searchQuery = '';
    this.sortOrder = 'added_desc';
    this.livePageSize = 100;
    this.mediaPageSize = 150;
    this.favorites = { live: [], movie: [], series: [] };
    this.enrichmentFailedCache = new Set();
    this.dedupCache = { movies: null, series: null };
  }

  async init() {
    this.setupUpdater();
    // Check debug mode
    const debugMode = await window.db.getSetting('debugMode');
    if (debugMode && window.electronAPI && window.electronAPI.openDevTools) {
      window.electronAPI.openDevTools();
    }

    // Load initial data
    this.favorites = await window.db.getSetting('favorites') || { live: [], movie: [], series: [] };
    this.downloadsCache = {}; // memory cache for UI updates
    await this.loadProgress();
    
    // Initialize Download Manager listeners
    this.initDownloads();

    // Bind player episode skip events
    if (window.player) {
      window.player.onNextEpisode = (data) => this.handleEpisodeSkip(data, 1);
      window.player.onPrevEpisode = (data) => this.handleEpisodeSkip(data, -1);
    }

    // Load favorites from settings - merge with defaults to ensure all keys exist
    const favs = await window.db.getSetting('favorites');
    if (favs && typeof favs === 'object') {
      this.favorites = {
        live:   Array.isArray(favs.live)   ? favs.live   : [],
        movie:  Array.isArray(favs.movie)  ? favs.movie  : [],
        series: Array.isArray(favs.series) ? favs.series : []
      };
    }
    // Load deduplication settings BEFORE triggering any background tasks
    // that might try to cache the deduplicated media list.
    await this.loadDeduplicationSettings();
    
    // Start background task to fetch missing TMDB covers
    this.startCoverEnrichment();
    

    
    // Auto-Updater Event Listener
    if (window.electronAPI && window.electronAPI.onUpdaterEvent) {
      window.electronAPI.onUpdaterEvent(({ event, data }) => {
        const updateBtn = document.getElementById('settings-update-btn');
        switch (event) {
          case 'checking':
            if(updateBtn) updateBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Suche...';
            break;
          case 'available':
            if(updateBtn) {
              updateBtn.innerHTML = '<i class="fas fa-download"></i> Update herunterladen';
              updateBtn.disabled = false;
              // Remove old listeners and add download listener
              const newBtn = updateBtn.cloneNode(true);
              updateBtn.parentNode.replaceChild(newBtn, updateBtn);
              newBtn.addEventListener('click', () => {
                newBtn.disabled = true;
                newBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Lade herunter...';
                window.electronAPI.downloadUpdate();
              });
            }
            this.showToast('Ein neues Update ist verfügbar!');
            break;
          case 'not-available':
            if(updateBtn) {
              updateBtn.innerHTML = '<i class="fas fa-check"></i> Du bist auf dem neuesten Stand';
              updateBtn.disabled = false;
              setTimeout(() => {
                updateBtn.innerHTML = '<i class="fas fa-download"></i> Nach Updates suchen';
              }, 3000);
            }
            this.showToast('Die App ist aktuell.');
            break;
          case 'progress':
            if(updateBtn && data && data.percent) {
              updateBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Lade herunter... ${Math.round(data.percent)}%`;
            }
            break;
          case 'downloaded':
            if(updateBtn) {
              updateBtn.innerHTML = '<i class="fas fa-rocket"></i> Update installieren & Neustarten';
              updateBtn.disabled = false;
              updateBtn.classList.remove('btn-primary');
              updateBtn.style.backgroundColor = '#43b581';
              const installBtn = updateBtn.cloneNode(true);
              updateBtn.parentNode.replaceChild(installBtn, updateBtn);
              installBtn.addEventListener('click', () => {
                window.electronAPI.installUpdate();
              });
            }
            this.showToast('Update heruntergeladen! Bereit zur Installation.', 5000);
            break;
          case 'error':
            if(updateBtn) {
              updateBtn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Fehler';
              updateBtn.disabled = false;
              setTimeout(() => {
                updateBtn.innerHTML = '<i class="fas fa-download"></i> Nach Updates suchen';
              }, 3000);
            }
            this.showToast('Update-Fehler: ' + (data || 'Unbekannt'));
            break;
        }
      });
    }
    
    this.setupEventListeners();
  }

  setupUpdater() {
    if (!window.electronAPI) return;
    const updateUi = document.getElementById('update-notification');
    const updateMsg = document.getElementById('update-message');
    const btnAction = document.getElementById('btn-update-action');
    const btnDismiss = document.getElementById('btn-update-dismiss');
    if (!updateUi) return;

    btnDismiss.addEventListener('click', () => updateUi.classList.add('hidden'));

    setTimeout(() => {
      window.electronAPI.checkForUpdates();
    }, 5000);

    window.electronAPI.onUpdaterEvent((data) => {
      console.log('Updater Event:', data.event, data.data);
      if (data.event === 'available') {
        updateMsg.innerText = `Version ${data.data.version} ist verfügbar! Möchtest du sie jetzt herunterladen?`;
        btnAction.innerHTML = 'Herunterladen';
        btnAction.disabled = false;
        btnAction.onclick = () => {
          btnAction.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Lade...';
          btnAction.disabled = true;
          window.electronAPI.downloadUpdate();
        };
        updateUi.classList.remove('hidden');
      } else if (data.event === 'progress') {
        const pct = Math.floor(data.data.percent || 0);
        btnAction.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Lade... ${pct}%`;
      } else if (data.event === 'downloaded') {
        updateMsg.innerText = `Update erfolgreich heruntergeladen. App jetzt neu starten?`;
        btnAction.innerHTML = 'Neu starten & Installieren';
        btnAction.disabled = false;
        btnAction.onclick = () => {
          window.electronAPI.installUpdate();
        };
        updateUi.classList.remove('hidden');
      }
    });
  }

  async setupEventListeners() {
    // Listen for progress updates to refresh home screen rows dynamically
    window.addEventListener('playback-progress-updated', async () => {
      await this.loadProgress();
      if (this.activeTab === 'home') {
        this.renderContinueWatching();
      } else if (this.activeTab === 'explore' || this.activeTab === 'movies' || this.activeTab === 'series') {
        this.refreshCurrentView();
      }
    });

    window.addEventListener('player-closed', () => {
      if (this.activeTab === 'home') {
        this.renderHomePage();
      }
    });

    // Auto load-more for infinite scrolling
    const mainContent = document.getElementById('main-content');
    if (mainContent) {
      mainContent.addEventListener('scroll', () => {
        if (mainContent.scrollTop + mainContent.clientHeight >= mainContent.scrollHeight - 600) {
          const loadBtn = document.querySelector('.load-more-btn');
          if (loadBtn) loadBtn.click();
        }
      });
    }

    // Modal backdrop click to close
    document.querySelectorAll('.detail-modal').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.classList.add('hidden');
        }
      });
    });

    // Global Search Overlay Logic
    let searchTimeout = null;
    const globalSearchInput = document.getElementById('global-search-input');
    const searchOverlay = document.getElementById('global-search-overlay');
    
    if (globalSearchInput && searchOverlay) {
      globalSearchInput.addEventListener('input', (e) => {
        const query = e.target.value.trim().toLowerCase();
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
          if (query.length > 0) {
            this.renderSearchResults(query);
          } else {
            searchOverlay.classList.add('hidden');
          }
        }, 300);
      });

      // Close on background click
      searchOverlay.addEventListener('click', (e) => {
        if (e.target === searchOverlay || e.target.classList.contains('search-overlay-content')) {
          searchOverlay.classList.add('hidden');
        }
      });

      // Close on Escape
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !searchOverlay.classList.contains('hidden')) {
          searchOverlay.classList.add('hidden');
        }
      });
    }
  }

  // =========================================================================
  //  DOWNLOADS
  // =========================================================================

  async initDownloads() {
    if (!window.electronAPI || !window.electronAPI.onDownloadProgress) return;
    
    // Load initial cache from DB safely
    try {
      const dls = await window.db.getAllDownloads();
      if (dls) {
        dls.forEach(dl => {
          this.downloadsCache[dl.id] = dl;
        });
      }
    } catch(err) {
      console.warn('Could not load downloads from DB (maybe upgrading?):', err);
    }

    window.electronAPI.onDownloadProgress((data) => {
      const { streamId, percent, currentTime, totalDurationSecs } = data;
      if (this.downloadsCache[streamId]) {
        this.downloadsCache[streamId].progress = percent;
        this.downloadsCache[streamId].status = 'downloading';
        window.db.saveDownload(this.downloadsCache[streamId]);
        this.updateDownloadUI(streamId);
      }
    });

    window.electronAPI.onDownloadComplete((data) => {
      const { streamId, filePath, success } = data;
      if (this.downloadsCache[streamId]) {
        if (success) {
          this.downloadsCache[streamId].progress = 100;
          this.downloadsCache[streamId].status = 'completed';
          this.downloadsCache[streamId].filePath = filePath;
        } else {
          this.downloadsCache[streamId].status = 'error';
        }
        window.db.saveDownload(this.downloadsCache[streamId]);
        this.updateDownloadUI(streamId);
      }
    });
  }

  updateDownloadUI(streamId) {
    // Update progress bars globally if they exist in the DOM
    const bars = document.querySelectorAll(`.dl-progress-bar[data-stream-id="${streamId}"]`);
    const statusTexts = document.querySelectorAll(`.dl-status-text[data-stream-id="${streamId}"]`);
    const dl = this.downloadsCache[streamId];
    
    if (dl && bars.length > 0) {
      bars.forEach(bar => {
        bar.style.width = `${dl.progress}%`;
      });
      statusTexts.forEach(txt => {
        if (dl.status === 'downloading') {
          txt.textContent = `Wird heruntergeladen... ${Math.round(dl.progress)}%`;
        } else if (dl.status === 'completed') {
          txt.textContent = `Fertig.`;
        } else if (dl.status === 'error') {
          txt.textContent = `Fehler beim Download.`;
        }
      });
    }
    
    // Also refresh the specific modal download button if it's currently open
    const modalBtn = document.getElementById('modal-download-btn');
    const modal = document.getElementById('netflix-detail-modal');
    if (modalBtn && modal && !modal.classList.contains('hidden')) {
      const modalId = modal.dataset.currentId;
      if (String(modalId) === String(streamId)) {
         this._renderModalDownloadButton(streamId, dl);
      }
    }
  }

  _renderModalDownloadButton(streamId, dl) {
    const btn = document.getElementById('modal-download-btn');
    if (!btn) return;
    
    if (!dl) {
      btn.innerHTML = `<i class="fas fa-download"></i>`;
      btn.className = 'btn-fav-round';
      btn.onclick = () => this.startDownload(streamId);
    } else if (dl.status === 'downloading') {
      btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${Math.round(dl.progress)}%`;
      btn.className = 'btn-fav-round active';
      btn.onclick = () => this.cancelDownload(streamId);
    } else if (dl.status === 'completed') {
      btn.innerHTML = `<i class="fas fa-check"></i>`;
      btn.className = 'btn-fav-round active';
      btn.onclick = () => this.cancelDownload(streamId); // allow delete
    } else if (dl.status === 'error') {
      btn.innerHTML = `<i class="fas fa-exclamation-triangle"></i>`;
      btn.className = 'btn-fav-round';
      btn.onclick = () => this.startDownload(streamId);
    }
  }

  async startDownload(streamId, customTitle = null, customCover = null, isEpisode = false) {
    const modal = document.getElementById('netflix-detail-modal');
    let type = modal.dataset.currentType; // 'movie' or 'series'
    if (isEpisode) type = 'series'; // treat as series for API URL
    
    // Let's get the streamUrl
    let streamUrl = window.api.getStreamUrl(streamId, type);
    let title = customTitle || (document.querySelector('.modal-title') ? document.querySelector('.modal-title').textContent : 'Download');
    let subtitle = '';
    let cover = customCover || ''; 
    
    if (!customCover) {
      const hero = document.querySelector('.modal-hero');
      if (hero) {
        const bg = hero.style.backgroundImage;
        const match = bg.match(/url\(['"]?(.*?)['"]?\)/);
        if (match) cover = match[1];
      }
    }
    
    // We need totalDuration. If we don't have it, we can't show percentage easily.
    // But FFmpeg proxy might give us duration. 
    // We'll let FFprobe get duration.
    let totalDurationSecs = 0;
    try {
      const info = await window.electronAPI.getStreamInfo(streamUrl);
      if (info && info.format && info.format.duration) {
        totalDurationSecs = parseFloat(info.format.duration);
      }
    } catch(e){}

    const dlItem = {
      id: String(streamId),
      type: type,
      title: title,
      subtitle: subtitle,
      cover: cover,
      progress: 0,
      status: 'downloading',
      filePath: null
    };

    this.downloadsCache[dlItem.id] = dlItem;
    await window.db.saveDownload(dlItem);
    this._renderModalDownloadButton(dlItem.id, dlItem);

    const customDir = await window.db.getSetting('downloadDir') || '';

    const result = await window.electronAPI.startDownload({
      streamId: dlItem.id,
      streamUrl,
      title,
      totalDurationSecs,
      customDir
    });

    if (!result.success) {
      dlItem.status = 'error';
      await window.db.saveDownload(dlItem);
      this._renderModalDownloadButton(dlItem.id, dlItem);
      alert('Download konnte nicht gestartet werden: ' + result.error);
    }
  }

  async cancelDownload(streamId) {
    if (confirm('Möchtest du diesen Download wirklich löschen?')) {
      await window.electronAPI.cancelDownload(streamId);
      await window.db.deleteDownload(streamId);
      delete this.downloadsCache[streamId];
      this._renderModalDownloadButton(streamId, null);
      if (this.activeTab === 'downloads') {
        this.renderDownloadsPage();
      }
    }
  }

  // =========================================================================
  //  FAVORITES
  // =========================================================================

  /**
   * Toggle a favorite entry. Updates DOM instantly, then persists to DB.
   * @param {string|number} id   - stream_id / series_id
   * @param {string}        type - 'live' | 'movie' | 'series'
   * @param {HTMLElement}   [originBtn] - the button that was clicked (for instant feedback)
   */
  async toggleFavorite(id, type, originBtn = null) {
    // Ensure the type array exists
    if (!Array.isArray(this.favorites[type])) this.favorites[type] = [];

    const list  = this.favorites[type];
    const strId = String(id);
    const idx   = list.indexOf(strId);
    const nowAdded = idx === -1;   // true  = adding,  false = removing

    if (nowAdded) {
      list.push(strId);
    } else {
      list.splice(idx, 1);
    }

    // ---- 1. Instant visual update on ALL matching buttons (before DB write) ----
    this._updateFavButtons(id, type, nowAdded);

    // ---- 2. Persist to DB ----
    try {
      await window.db.saveSetting('favorites', this.favorites);
    } catch (err) {
      // Roll back in-memory change on failure
      console.error('[Favorites] Save failed:', err);
      if (nowAdded) {
        list.splice(list.indexOf(strId), 1);
      } else {
        list.push(strId);
      }
      this._updateFavButtons(id, type, !nowAdded); // revert buttons
      this.showToast('\u274c Favorit konnte nicht gespeichert werden');
      return;
    }

    this.showToast(nowAdded ? '\u2665 Zu Favoriten hinzugefügt' : 'Aus Favoriten entfernt');
    
    // ---- 3. Background Cloud Sync ----
    if (window.cloudSync && window.cloudSync.user && window.cloudSync.activeProfileId) {
      if (!nowAdded) {
        window.cloudSync.removeFavorite(window.cloudSync.activeProfileId, strId);
      } else {
        // We need the full media object to push to cloud
        setTimeout(async () => {
          let itemData = null;
          const numId = parseInt(id) || id;
          if (type === 'movie') itemData = await window.db.get('movies', numId);
          else if (type === 'series') itemData = await window.db.get('series', numId);
          else if (type === 'live') itemData = await window.db.get('live_streams', numId);
          
          if (itemData) {
            window.cloudSync.pushFavorite(window.cloudSync.activeProfileId, type, itemData);
          }
        }, 100);
      }
    }
  }

  /**
   * Updates ALL fav-button elements for a given id+type in the current DOM.
   */
  _updateFavButtons(id, type, isActive) {
    const strId = String(id);

    // Live TV channel cards
    document.querySelectorAll(`.live-channel-card[data-id="${strId}"] .channel-fav-btn`)
      .forEach(btn => {
        btn.classList.toggle('active', isActive);
        btn.style.color = isActive ? 'var(--color-primary)' : '';
      });

    // Movie / Series cards — update fav button AND persistent badge
    document.querySelectorAll(`.netflix-card[data-id="${strId}"][data-type="${type}"]`)
      .forEach(card => {
        const favBtn   = card.querySelector('.btn-fav-card');
        const favBadge = card.querySelector('.fav-badge');

        if (favBtn) {
          favBtn.classList.toggle('active', isActive);
          favBtn.title = isActive ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen';
        }
        if (favBadge) {
          favBadge.style.display = isActive ? '' : 'none';
        }
      });

    // Remove card entirely from Favorites/Home tab if un-favorited
    if (!isActive) {
      const sel = type === 'live' ? `.live-channel-card[data-id="${strId}"]` : `.netflix-card[data-id="${strId}"][data-type="${type}"]`;
      
      // Check Favorites Page sections
      ['fav-live-grid', 'fav-movies-grid', 'fav-series-grid'].forEach(gridId => {
        const grid = document.getElementById(gridId);
        if (grid) {
          const card = grid.querySelector(sel);
          if (card) {
            card.remove();
            if (grid.children.length === 0 && grid.parentElement.classList.contains('fav-section')) {
              grid.parentElement.style.display = 'none';
            }
          }
        }
      });
      
      // Check Home Page favorites row
      const favRow = document.getElementById('row-favorites');
      if (favRow) {
        const card = favRow.querySelector(sel);
        if (card) {
          card.remove();
          const scrollContainer = favRow.querySelector('.carousel-scroll');
          if (scrollContainer && scrollContainer.children.length === 0) {
            favRow.style.display = 'none';
          }
        }
      }
    }

    // Detail modal fav button (only if it belongs to this item)
    const modalBtn = document.getElementById('modal-fav-btn');
    const modal    = document.getElementById('netflix-detail-modal');
    if (modalBtn && modal && !modal.classList.contains('hidden')) {
      const modalId   = modal.dataset.currentId;
      const modalType = modal.dataset.currentType;
      if (String(modalId) === strId && modalType === type) {
        modalBtn.classList.toggle('active', isActive);
      }
    }
  }

  isFavorite(id, type) {
    const list = this.favorites[type];
    return Array.isArray(list) && list.includes(String(id));
  }

  showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'app-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('show');
      setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 500);
      }, 2500);
    }, 100);
  }

  /**
   * Refreshes current active view.
   */
  refreshCurrentView() {
    switch (this.activeTab) {
      case 'home':
        this.renderHomePage();
        break;
      case 'live':
        this.renderLiveTVPage();
        break;
      case 'movies':
        this.renderMoviesPage();
        break;
      case 'series':
        this.renderSeriesPage();
        break;
      case 'favorites':
        this.renderFavoritesPage();
        break;
      case 'explore':
        this.renderExplorePage();
        break;
      case 'downloads':
        this.renderDownloadsPage();
        break;
      case 'settings':
        this.renderSettingsPage();
        break;
    }
  }

  async renderDownloadsPage() {
    const content = document.getElementById('main-content');
    content.innerHTML = `
      <div class="page-header">
        <h1>Meine Downloads</h1>
      </div>
      <div id="downloads-grid" class="media-grid"></div>
    `;

    const grid = document.getElementById('downloads-grid');
    const dls = await window.db.getAllDownloads();

    if (!dls || dls.length === 0) {
      grid.innerHTML = '<div style="color:var(--color-text-muted); padding: 20px;">Keine Downloads vorhanden.</div>';
      return;
    }

    grid.innerHTML = dls.map(dl => {
      const isCompleted = dl.status === 'completed';
      const isError = dl.status === 'error';
      let statusText = 'Wird heruntergeladen...';
      if (isCompleted) statusText = 'Fertig';
      if (isError) statusText = 'Fehler beim Download';
      
      const cover = dl.cover || 'assets/logo.jpg'; // We didn't save cover yet, but we will.
      
      return `
        <div class="media-card" style="position: relative;">
          <img src="${cover}" alt="${dl.title}" onerror="this.src='https://placehold.co/300x450/141414/ffffff?text=Video'">
          <div class="media-info">
            <h3 class="media-title">${dl.title}</h3>
            <div class="dl-status-text" data-stream-id="${dl.id}" style="font-size: 12px; margin-top: 5px; color: #aaa;">${statusText} ${!isCompleted && !isError ? Math.round(dl.progress) + '%' : ''}</div>
            <div class="epg-progress-bg" style="margin-top: 10px; height: 4px;">
              <div class="epg-progress-fill dl-progress-bar" data-stream-id="${dl.id}" style="width: ${dl.progress}%; background: ${isError ? 'red' : 'var(--color-primary)'};"></div>
            </div>
          </div>
          ${isCompleted ? `<div class="card-play-overlay"><i class="fas fa-play"></i></div>` : ''}
          <button class="btn-fav-round" style="position: absolute; top: 10px; right: 10px; z-index: 10; background: rgba(0,0,0,0.7); color: white;" onclick="window.ui.cancelDownload('${dl.id}')"><i class="fas fa-trash"></i></button>
        </div>
      `;
    }).join('');

    // Play offline files
    const cards = grid.querySelectorAll('.media-card');
    cards.forEach((card, index) => {
      const dl = dls[index];
      if (dl.status === 'completed' && dl.filePath) {
        card.addEventListener('click', (e) => {
           if (e.target.closest('button')) return; // ignore delete button click
           window.player.play({
             id: dl.id,
             type: 'local',
             title: dl.title,
             subtitle: 'Offline verfügbar',
             filePath: dl.filePath,
             cover: dl.cover
           });
        });
      }
    });
  }

  /**
   * Switches visual tabs and loads target pages.
   */
  switchTab(tabId) {
    this.activeTab = tabId;
    this.currentCategory = 'all';
    this.searchQuery = '';
    
    // Update active nav style
    const navItems = document.querySelectorAll('.sidebar-nav-item');
    navItems.forEach(item => {
      item.classList.toggle('active', item.dataset.tab === tabId);
    });

    // Show/hide global topbar
    const globalTopbar = document.querySelector('.global-topbar');
    if (globalTopbar) {
      if (tabId === 'home' || tabId === 'search') {
        globalTopbar.style.display = 'flex';
      } else {
        globalTopbar.style.display = 'none';
      }
    }

    // Clear main scroll & reset view containers
    const content = document.getElementById('main-content');
    content.scrollTop = 0;
    
    this.refreshCurrentView();
  }

  /**
   * --- 1. HOME PAGE ---
   */
  async renderHomePage() {
    const content = document.getElementById('main-content');
    content.innerHTML = `
      <div id="hero-section" class="hero-banner"></div>
      <div id="home-rows" class="home-rows-container"></div>
    `;

    // Render Hero Banner
    this.renderHeroBanner();

    // Render Carousels
    const rowsContainer = document.getElementById('home-rows');

    // Top 10 Feature Row
    const top10Wrapper = document.createElement('div');
    top10Wrapper.id = 'top10-wrapper';
    rowsContainer.appendChild(top10Wrapper);
    this.renderTop10Row();

    // Row 1: Continue Watching (Zuletzt geguckt)
    const cwRow = document.createElement('div');
    cwRow.id = 'row-continue-watching';
    cwRow.className = 'netflix-row';
    rowsContainer.appendChild(cwRow);
    this.renderContinueWatching();

    // Row 1.5: Meine Liste
    const favRow = document.createElement('div');
    favRow.id = 'row-favorites';
    favRow.className = 'netflix-row';
    rowsContainer.appendChild(favRow);
    this.renderFavoritesRow();

    // Row: Recommended Movies
    const recMoviesRow = document.createElement('div');
    recMoviesRow.id = 'row-recommended-movies';
    recMoviesRow.className = 'netflix-row';
    rowsContainer.appendChild(recMoviesRow);
    this.renderRecommendations('movie', recMoviesRow);

    // Row: Recommended Series
    const recSeriesRow = document.createElement('div');
    recSeriesRow.id = 'row-recommended-series';
    recSeriesRow.className = 'netflix-row';
    rowsContainer.appendChild(recSeriesRow);
    this.renderRecommendations('series', recSeriesRow);

    // Row 2: Recently Added Movies & Series (Zuletzt hinzugefügt)
    const addedRow = document.createElement('div');
    addedRow.id = 'row-recently-added';
    addedRow.className = 'netflix-row';
    rowsContainer.appendChild(addedRow);
    this.renderRecentlyAdded();

    // Row 3: Popular Movies
    const popMoviesRow = document.createElement('div');
    popMoviesRow.id = 'row-popular-movies';
    popMoviesRow.className = 'netflix-row';
    rowsContainer.appendChild(popMoviesRow);
    this.renderPopularMovies();

    // Row 4: Popular Series
    const popSeriesRow = document.createElement('div');
    popSeriesRow.id = 'row-popular-series';
    popSeriesRow.className = 'netflix-row';
    rowsContainer.appendChild(popSeriesRow);
    this.renderPopularSeries();
  }

  async renderHeroBanner() {
    const hero = document.getElementById('hero-section');
    hero.innerHTML = '<div class="hero-skeleton"></div>';

    // Pick a featured movie or series from Cached DB
    const movies = await this.getDeduplicatedMedia('movies');
    if (!movies || movies.length === 0) {
      hero.style.display = 'none';
      return;
    }

    // Filter movies with good images & higher ratings if possible
    const candidates = movies.filter(m => m.stream_icon && m.stream_icon.startsWith('http') && m.rating);
    const featured = candidates.length > 0 
      ? candidates[Math.floor(Math.random() * Math.min(candidates.length, 30))] 
      : movies[Math.floor(Math.random() * movies.length)];

    if (!featured) return;

    // Load full details for hero metadata
    let plot = 'Spannende Unterhaltung erwartet dich. Klicke auf Abspielen oder Info für mehr Details.';
    let rating = featured.rating || 'N/A';
    let director = '';
    let genres = featured.category_id || '';

    try {
      const details = await window.api.fetchMovieInfo(featured.stream_id);
      if (details && details.info) {
        plot = details.info.plot || plot;
        rating = details.info.rating || rating;
        director = details.info.director || director;
        genres = details.info.genre || genres;
      }
    } catch (e) {
      console.warn('Hero metadata fetch failed, using stream fallback.');
    }

    // Truncate plot
    const maxPlotLength = 160;
    const truncatedPlot = plot.length > maxPlotLength ? plot.substring(0, maxPlotLength) + '...' : plot;

    hero.style.backgroundImage = `linear-gradient(to top, var(--color-bg) 0%, rgba(20, 20, 20, 0.2) 50%, transparent 100%), url('${this.getCacheUrl(featured.stream_icon)}')`;
    hero.style.backgroundSize = 'cover';
    hero.style.backgroundPosition = 'center top';
    hero.innerHTML = `
      <div class="hero-content">
        <h1 class="hero-title">${featured.name}</h1>
        <div class="hero-metadata">
          <span class="imdb-rating"><i class="fab fa-imdb"></i> ${rating}</span>
          ${featured.releaseDate ? `<span class="hero-year">${featured.releaseDate.substring(0, 4)}</span>` : ''}
          ${genres ? `<span class="hero-genres">${genres}</span>` : ''}
        </div>
        <p class="hero-plot">${truncatedPlot}</p>
        <div class="hero-buttons" style="display:flex;gap:12px;align-items:center;margin-top:20px;position:relative;z-index:2;">
          <button class="btn-play" id="hero-play-btn" style="flex-shrink:0;">
            <i class="fas fa-play"></i> Abspielen
          </button>
          <button class="btn-info" id="hero-info-btn" style="flex-shrink:0;">
            <i class="fas fa-circle-info"></i> Weitere Infos
          </button>
        </div>
      </div>
    `;

    document.getElementById('hero-play-btn').addEventListener('click', () => {
      window.player.play({
        id: featured.stream_id,
        type: 'movie',
        title: featured.name,
        subtitle: 'Film',
        cover: featured.stream_icon
      });
    });

    document.getElementById('hero-info-btn').addEventListener('click', () => {
      this.openDetailModal(featured.stream_id, 'movie');
    });
  }

  async renderContinueWatching() {
    const row = document.getElementById('row-continue-watching');
    if (!row) return;

    const progressList = await window.db.getAllProgress();
    if (!progressList || progressList.length === 0) {
      row.style.display = 'none';
      return;
    }

    row.style.display = 'block';
    row.innerHTML = `
      <h2 class="row-header">${window.i18n.t('continueWatching')}</h2>
      <div class="carousel-container">
        <button class="carousel-arrow left"><i class="fas fa-chevron-left"></i></button>
        <div class="carousel-scroll">
          ${progressList.map(item => {
            let remainingText = '';
            if (item.duration && item.position) {
              const remainingSecs = Math.max(0, item.duration - item.position);
              const remainingMins = Math.ceil(remainingSecs / 60);
              if (remainingMins > 0) {
                remainingText = `<div style="font-size: 11px; color: #999; margin-top: 6px; font-weight: 500;">Noch ${remainingMins} Min.</div>`;
              }
            }
            return `
            <div class="cw-card" data-id="${item.id}" data-type="${item.type}">
              <button class="cw-delete-btn" data-id="${item.id}" title="Aus Verlauf entfernen"><i class="fas fa-times"></i></button>
              <div class="cw-card-img-wrapper">
                <img src="${item.cover || 'assets/logo.jpg'}" alt="${item.title}" onerror="this.src='https://placehold.co/300x450/141414/e50914?text=Stream'">
                <div class="cw-card-hover-overlay">
                  <button class="cw-play-overlay-btn"><i class="fas fa-play"></i></button>
                </div>
              </div>
              <div class="cw-card-info">
                <div class="cw-card-title">${item.title}</div>
                ${item.subtitle ? `<div class="cw-card-subtitle">${item.subtitle}</div>` : ''}
                <div class="cw-progress-bar">
                  <div class="cw-progress-fill" style="width: ${item.percentage}%"></div>
                </div>
                ${remainingText}
              </div>
            </div>
            `;
          }).join('')}
        </div>
        <button class="carousel-arrow right"><i class="fas fa-chevron-right"></i></button>
      </div>
    `;

    // Hook up scroll buttons
    this.initCarouselScrolling(row);

    // Event listeners
    row.querySelectorAll('.cw-card').forEach(card => {
      const id = card.dataset.id;
      const type = card.dataset.type;
      
      card.querySelector('.cw-card-img-wrapper').addEventListener('click', async () => {
        const item = await window.db.getProgress(id);
        if (item) {
          window.player.play({
            id: item.id,
            type: item.type,
            title: item.title,
            subtitle: item.subtitle,
            cover: item.cover,
            isSeries: item.isSeries,
            seriesId: item.seriesId,
            season: item.season,
            episode: item.episode
          });
        }
      });

      const deleteBtn = card.querySelector('.cw-delete-btn');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', async (e) => {
          e.stopPropagation(); // Prevent playing
          await window.db.deleteProgress(id);
          this.renderContinueWatching(); // Refresh the row
        });
      }
    });
  }

  async renderFavoritesRow() {
    const row = document.getElementById('row-favorites');
    if (!row) return;

    const allLive = await window.db.getAll('live_streams');
    const allMovies = await this.getDeduplicatedMedia('movies');
    const allSeries = await this.getDeduplicatedMedia('series');

    const favLive = allLive.filter(c => this.isFavorite(c.stream_id, 'live'));
    const favMovies = allMovies.filter(m => this.isFavorite(m.stream_id, 'movie'));
    const favSeries = allSeries.filter(s => this.isFavorite(s.series_id, 'series'));

    const allFavs = [];
    favLive.forEach(i => allFavs.push({ ...i, type: 'live', id: i.stream_id, cover: i.stream_icon }));
    favMovies.forEach(i => allFavs.push({ ...i, type: 'movie', id: i.stream_id, cover: i.stream_icon }));
    favSeries.forEach(i => allFavs.push({ ...i, type: 'series', id: i.series_id, cover: i.cover }));

    if (allFavs.length === 0) {
      row.style.display = 'none';
      return;
    }

    row.style.display = 'block';
    row.innerHTML = `
      <h2 class="row-header">Meine Liste</h2>
      <div class="carousel-container">
        <button class="carousel-arrow left"><i class="fas fa-chevron-left"></i></button>
        <div class="carousel-scroll">
          ${allFavs.map(item => this.createCardHTML(item)).join('')}
        </div>
        <button class="carousel-arrow right"><i class="fas fa-chevron-right"></i></button>
      </div>
    `;

    this.initCarouselScrolling(row);
    this.hookCardEvents(row);
  }

  async renderRecommendations(type, row) {
    if (!row) return;

    try {
      // 1. Get all items of this type from DB
      const dbType = type === 'movie' ? 'movies' : 'series';
      const allItems = await this.getDeduplicatedMedia(dbType);
      if (!allItems || allItems.length === 0) {
        row.style.display = 'none';
        return;
      }

      // 2. Find watched items & favorite items
      const watched = await window.db.getAllProgress() || [];
      const watchedOfType = watched.filter(w => w.type === type);
      const watchedIds = new Set(watchedOfType.map(w => String(w.id)));
      
      const favsOfType = this.favorites[type] || [];
      const favIds = new Set(favsOfType.map(String));

      // 3. Count categories
      const categoryCounts = {};
      let topCategoryId = null;
      const idKey = type === 'movie' ? 'stream_id' : 'series_id';

      watchedOfType.forEach(w => {
        const item = allItems.find(i => String(i[idKey]) === String(w.id));
        if (item && item.category_id) {
          categoryCounts[item.category_id] = (categoryCounts[item.category_id] || 0) + 2; 
        }
      });

      favsOfType.forEach(fId => {
        const item = allItems.find(i => String(i[idKey]) === String(fId));
        if (item && item.category_id) {
          categoryCounts[item.category_id] = (categoryCounts[item.category_id] || 0) + 1;
        }
      });

      let maxCount = 0;
      for (const catId in categoryCounts) {
        if (categoryCounts[catId] > maxCount) {
          maxCount = categoryCounts[catId];
          topCategoryId = catId;
        }
      }

      if (!topCategoryId) {
        row.style.display = 'none';
        return;
      }

      // 4. Find source title
      let sourceTitle = null;
      for (const w of watchedOfType) {
        const item = allItems.find(i => String(i[idKey]) === String(w.id));
        if (item && String(item.category_id) === String(topCategoryId)) {
          sourceTitle = item.name;
          break; 
        }
      }
      
      if (!sourceTitle) {
        for (const fId of favsOfType) {
          const item = allItems.find(i => String(i[idKey]) === String(fId));
          if (item && String(item.category_id) === String(topCategoryId)) {
            sourceTitle = item.name;
            break;
          }
        }
      }

      if (!sourceTitle) {
        const cats = await window.db.getAll(type === 'movie' ? 'movie_categories' : 'series_categories') || [];
        const cat = cats.find(c => String(c.category_id) === String(topCategoryId));
        if (cat) sourceTitle = cat.category_name;
      }

      if (!sourceTitle) {
        row.style.display = 'none';
        return;
      }

      // 5. Filter recommendations
      const recommendations = allItems.filter(item => {
        if (String(item.category_id) !== String(topCategoryId)) return false;
        if (watchedIds.has(String(item[idKey]))) return false;
        return true;
      });

      if (recommendations.length === 0) {
        row.style.display = 'none';
        return;
      }

      recommendations.sort((a, b) => {
        const rA = parseFloat(a.rating) || 0;
        const rB = parseFloat(b.rating) || 0;
        return rB - rA;
      });

      const topRecs = recommendations.slice(0, 15);

      // 6. Render
      row.style.display = 'block';
      row.innerHTML = `
        <h2 class="row-header">Weil du "${sourceTitle}" geschaut hast...</h2>
        <div class="carousel-container">
          <button class="carousel-arrow left"><i class="fas fa-chevron-left"></i></button>
          <div class="carousel-scroll">
            ${topRecs.map(item => this.createCardHTML({ 
              ...item, 
              type, 
              id: item[idKey], 
              name: item.name, 
              cover: item.stream_icon || item.cover 
            })).join('')}
          </div>
          <button class="carousel-arrow right"><i class="fas fa-chevron-right"></i></button>
        </div>
      `;

      this.initCarouselScrolling(row);
      this.hookCardEvents(row);

    } catch (e) {
      console.error('Error rendering recommendations:', e);
      row.style.display = 'none';
    }
  }

  async renderRecentlyAdded() {
    const row = document.getElementById('row-recently-added');
    if (!row) return;

    // Get last added movies & series
    const movies = await this.getDeduplicatedMedia('movies');
    const series = await this.getDeduplicatedMedia('series');

    // Combine both and sort by added timestamp
    let list = [
      ...movies.map(m => ({ ...m, type: 'movie', time: m.added || 0, id: m.stream_id, name: m.name, cover: m.stream_icon })),
      ...series.map(s => ({ ...s, type: 'series', time: s.last_modified || 0, id: s.series_id, name: s.name, cover: s.cover }))
    ];

    // Deduplicate ACROSS movies and series (in case the provider put a movie in both categories)
    if (this.dedupConfig && this.dedupConfig.enabled) {
      const uniqueList = [];
      const seenTitles = new Set();
      for (const item of list) {
        const clean = this.cleanTitleForTMDB(item.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (clean && !seenTitles.has(clean)) {
          seenTitles.add(clean);
          uniqueList.push(item);
        }
      }
      list = uniqueList;
    }

    // Sort descending
    list.sort((a, b) => b.time - a.time);
    
    // Take top 15
    const recent = list.slice(0, 15);

    if (recent.length === 0) {
      row.style.display = 'none';
      return;
    }

    row.style.display = 'block';
    row.innerHTML = `
      <h2 class="row-header">Zuletzt hinzugefügt</h2>
      <div class="carousel-container">
        <button class="carousel-arrow left"><i class="fas fa-chevron-left"></i></button>
        <div class="carousel-scroll">
          ${recent.map(item => this.createCardHTML(item)).join('')}
        </div>
        <button class="carousel-arrow right"><i class="fas fa-chevron-right"></i></button>
      </div>
    `;

    this.initCarouselScrolling(row);
    this.hookCardEvents(row);
  }

  async renderPopularMovies() {
    const row = document.getElementById('row-popular-movies');
    if (!row) return;

    const movies = await this.getDeduplicatedMedia('movies');
    if (!movies || movies.length === 0) {
      row.style.display = 'none';
      return;
    }

    // Sort by rating desc
    const popular = movies
      .filter(m => m.rating)
      .sort((a, b) => parseFloat(b.rating) - parseFloat(a.rating))
      .slice(0, 15);

    const displayList = popular.length > 0 ? popular : movies.slice(0, 15);

    row.style.display = 'block';
    row.innerHTML = `
      <h2 class="row-header">${window.i18n.t('popularMovies')}</h2>
      <div class="carousel-container">
        <button class="carousel-arrow left"><i class="fas fa-chevron-left"></i></button>
        <div class="carousel-scroll">
          ${displayList.map(item => this.createCardHTML({ ...item, type: 'movie', id: item.stream_id, name: item.name, cover: item.stream_icon })).join('')}
        </div>
        <button class="carousel-arrow right"><i class="fas fa-chevron-right"></i></button>
      </div>
    `;

    this.initCarouselScrolling(row);
    this.hookCardEvents(row);
  }

  async renderPopularSeries() {
    const row = document.getElementById('row-popular-series');
    if (!row) return;

    const series = await this.getDeduplicatedMedia('series');
    if (!series || series.length === 0) {
      row.style.display = 'none';
      return;
    }

    const popular = series
      .filter(s => s.rating)
      .sort((a, b) => parseFloat(b.rating) - parseFloat(a.rating))
      .slice(0, 15);

    const displayList = popular.length > 0 ? popular : series.slice(0, 15);

    row.style.display = 'block';
    row.innerHTML = `
      <h2 class="row-header">${window.i18n.t('popularSeries')}</h2>
      <div class="carousel-container">
        <button class="carousel-arrow left"><i class="fas fa-chevron-left"></i></button>
        <div class="carousel-scroll">
          ${displayList.map(item => this.createCardHTML({ ...item, type: 'series', id: item.series_id, name: item.name, cover: item.cover })).join('')}
        </div>
        <button class="carousel-arrow right"><i class="fas fa-chevron-right"></i></button>
      </div>
    `;

    this.initCarouselScrolling(row);
    this.hookCardEvents(row);
  }

  async handleEpisodeSkip(currentPlayData, direction) {
    if (!currentPlayData.isSeries || !currentPlayData.seriesId) return;
    
    try {
      this.showToast(direction > 0 ? 'Lade nächste Folge...' : 'Lade vorherige Folge...');
      const data = await window.api.fetchSeriesInfo(currentPlayData.seriesId);
      if (!data || !data.episodes) return;
      
      let allEpisodes = [];
      const seasonKeys = Object.keys(data.episodes).sort((a, b) => parseInt(a) - parseInt(b));
      for (const s of seasonKeys) {
        const eps = data.episodes[s] || [];
        eps.sort((a, b) => parseInt(a.episode_num) - parseInt(b.episode_num));
        eps.forEach(ep => {
          allEpisodes.push({ ...ep, seasonNum: s });
        });
      }
      
      const currentIndex = allEpisodes.findIndex(e => String(e.id) === String(currentPlayData.id));
      if (currentIndex === -1) return;
      
      const nextIndex = currentIndex + direction;
      if (nextIndex >= 0 && nextIndex < allEpisodes.length) {
        const nextEp = allEpisodes[nextIndex];
        window.player.play({
          id: nextEp.id,
          type: 'series',
          title: currentPlayData.title,
          subtitle: `Staffel ${nextEp.seasonNum} • Folge ${nextEp.episode_num} - ${nextEp.title || ''}`,
          cover: currentPlayData.cover,
          isSeries: true,
          seriesId: currentPlayData.seriesId,
          season: nextEp.seasonNum,
          episode: nextEp.episode_num
        });
      } else {
        this.showToast(direction > 0 ? 'Letzte Folge erreicht!' : 'Erste Folge erreicht!');
      }
    } catch (e) {
      console.error(e);
      this.showToast('Fehler beim Laden der Folgen!');
    }
  }

  /**
   * --- 2. LIVE TV PAGE ---
   */
  async renderLiveTVPage() {
    const content = document.getElementById('main-content');

    content.innerHTML = `
      <div class="live-page-wrapper">
        <div class="page-header" style="margin-bottom:0;">
          <h1>Live TV</h1>
          <div class="search-bar">
            <i class="fas fa-search"></i>
            <input type="text" id="live-search" placeholder="Sender suchen..." value="${this.searchQuery}">
          </div>
        </div>
        <!-- Horizontal scrollable category chips -->
        <div class="live-cat-bar" id="live-cat-bar">
          <div class="live-cat-loading"><i class="fas fa-spinner fa-spin"></i></div>
        </div>
        <!-- Channel grid -->
        <div class="live-grid-wrapper">
          <div class="live-grid" id="live-channels-grid">
            <div class="grid-skeleton"></div>
          </div>
        </div>
      </div>
    `;

    const [categories, channels] = await Promise.all([
      window.db.getAll('live_categories'),
      window.db.getAll('live_streams')
    ]);

    this._allLiveChannels = channels;

    this.renderLiveCatBar(categories, channels);
    this.renderLiveChannelsGrid(channels);

    document.getElementById('live-search').addEventListener('input', (e) => {
      this.searchQuery = e.target.value.toLowerCase();
      this.renderLiveChannelsGrid(this._allLiveChannels);
    });

    const mainContent = document.getElementById('main-content');
    // IntersectionObserver takes care of the infinite scroll now, so we remove the manual scroll listener.
  }

  renderLiveCatBar(categories, channels) {
    const bar = document.getElementById('live-cat-bar');
    if (!bar) return;

    const chips = [
      { id: 'all', label: 'Alle Kanäle' },
      { id: 'fav', label: '♥ Favoriten' },
      ...categories.map(c => ({ id: String(c.category_id), label: c.category_name }))
    ];

    bar.innerHTML = chips.map(chip => `
      <button class="live-cat-chip ${this.currentCategory === chip.id ? 'active' : ''}"
              data-cat="${chip.id}">
        ${chip.label}
      </button>
    `).join('');

    bar.querySelectorAll('.live-cat-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        bar.querySelectorAll('.live-cat-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        this.currentCategory = chip.dataset.cat;
        this.renderLiveChannelsGrid(this._allLiveChannels);
        // Scroll chip into view
        chip.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      });
    });

    // Add horizontal scroll via mouse wheel
    bar.addEventListener('wheel', (e) => {
      if (e.deltaY !== 0) {
        e.preventDefault();
        bar.scrollLeft += e.deltaY;
      }
    });
  }

  renderLiveChannelsGrid(channels, startFrom = 0) {
    const grid = document.getElementById('live-channels-grid');
    if (!grid) return;

    let filtered = channels;
    if (this.currentCategory === 'fav') {
      filtered = channels.filter(c => this.isFavorite(c.stream_id, 'live'));
    } else if (this.currentCategory !== 'all') {
      filtered = channels.filter(c => String(c.category_id) === this.currentCategory);
    }
    if (this.searchQuery) {
      filtered = filtered.filter(c => this.fuzzyMatch(this.searchQuery, c.name || ''));
    }

    if (filtered.length === 0) {
      grid.innerHTML = `
        <div class="no-results">
          <i class="fas fa-tv"></i>
          <p>Keine Sender gefunden.</p>
        </div>`;
      return;
    }

    const page    = filtered.slice(startFrom, startFrom + this.livePageSize);
    const hasMore = filtered.length > startFrom + this.livePageSize;

    const html = page.map(ch => {
      const initials = (ch.name || '?').replace(/[^A-Z0-9]/gi, '').substring(0, 3).toUpperCase() || '?';
      const isFav    = this.isFavorite(ch.stream_id, 'live');
      return `
        <div class="live-channel-card" data-id="${ch.stream_id}">
          <div class="channel-logo-wrapper">
            <img src="${ch.stream_icon || ''}" alt=""
              loading="lazy"
              onerror="this.onerror=null;this.style.display='none';this.nextElementSibling.style.display='flex'">
            <div class="channel-logo-fallback" style="display:none">${initials}</div>
          </div>
          <div class="channel-details">
            <div class="channel-name" title="${ch.name}">${ch.name}</div>
            <div class="channel-epg">
              <span class="epg-badge">LIVE</span>
              <span class="epg-title">Lade...</span>
            </div>
            <div class="channel-epg-progress" style="display:none; height: 3px; background: rgba(255,255,255,0.1); margin-top: 6px; border-radius: 2px; overflow: hidden;">
              <div class="channel-epg-bar" style="height: 100%; background: var(--color-primary); width: 0%; transition: width 0.3s ease;"></div>
            </div>
          </div>
          <button class="channel-fav-btn ${isFav ? 'active' : ''}" title="${isFav ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen'}">
            <i class="fas fa-heart"></i>
          </button>
        </div>`;
    }).join('');

    if (startFrom === 0) {
      grid.innerHTML = html;
    } else {
      grid.querySelector('.load-more-btn')?.remove();
      grid.insertAdjacentHTML('beforeend', html);
    }

    if (hasMore) {
      let observerTarget = document.getElementById('infinite-scroll-target');
      if (!observerTarget) {
        observerTarget = document.createElement('div');
        observerTarget.id = 'infinite-scroll-target';
        observerTarget.style.padding = '40px';
        observerTarget.style.textAlign = 'center';
        observerTarget.style.color = '#888';
        observerTarget.style.width = '100%';
        observerTarget.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Lade weitere Sender...';
        grid.parentElement.appendChild(observerTarget);
      }
      
      const observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
          observer.disconnect();
          observerTarget.remove();
          this.renderLiveChannelsGrid(channels, startFrom + this.livePageSize);
        }
      }, { rootMargin: '400px' }); // Load 400px before reaching the bottom
      observer.observe(observerTarget);
    }

    // Events only on new (unannotated) cards
    grid.querySelectorAll('.live-channel-card:not([data-evts])').forEach(card => {
      card.setAttribute('data-evts', '1');
      const id = card.dataset.id;
      const ch = channels.find(c => String(c.stream_id) === id);
      if (!ch) return;

      card.addEventListener('click', (e) => {
        if (e.target.closest('.channel-fav-btn')) return;
        this.showLiveEPGModal(ch);
      });

      card.querySelector('.channel-fav-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleFavorite(ch.stream_id, 'live');
      });
    });

    this.observeEPGCards(grid);
  }

  observeEPGCards(container) {
    if (!this.epgObserver) {
      this.epgObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const card = entry.target;
            const id = card.dataset.id;
            if (!card.dataset.epgLoaded) {
              card.dataset.epgLoaded = '1';
              this.loadShortEPGForCard(id, card);
            }
          }
        });
      }, { rootMargin: '100px' });
    }

    container.querySelectorAll('.live-channel-card:not([data-epg-loaded])').forEach(card => {
      this.epgObserver.observe(card);
    });
  }

  async loadShortEPGForCard(streamId, card) {
    try {
      const epgData = await window.api.fetchLiveEPG(streamId, 1);
      const listings = epgData.epg_listings || [];
      const titleEl = card.querySelector('.epg-title') || card.querySelector('.channel-epg');
      const progressContainer = card.querySelector('.channel-epg-progress');
      const progressBar = card.querySelector('.channel-epg-bar');

      if (listings.length > 0) {
        let nowItem = null;
        const nowServer = Date.now();
        for (const item of listings) {
          const start = new Date(item.start).getTime();
          const end = new Date(item.end).getTime();
          if (nowServer >= start && nowServer <= end) {
            nowItem = item;
            break;
          }
        }
        
        if (nowItem && titleEl) {
          const rawTitle = (nowItem.title || '');
          const decodedTitle = btoa(rawTitle) === rawTitle ? rawTitle : decodeURIComponent(escape(atob(rawTitle))).replace(/\+/g, ' ');
          
          if (card.querySelector('.epg-title')) {
             titleEl.innerText = decodedTitle || 'Jetzt einschalten';
          } else {
             titleEl.innerText = decodedTitle || 'Jetzt einschalten';
          }

          if (progressContainer && progressBar) {
            const start = new Date(nowItem.start).getTime();
            const end = new Date(nowItem.end).getTime();
            const total = end - start;
            const current = nowServer - start;
            let percent = (current / total) * 100;
            if (percent < 0) percent = 0;
            if (percent > 100) percent = 100;

            progressContainer.style.display = 'block';
            progressBar.style.width = percent + '%';
          }
        } else {
           if (titleEl) titleEl.innerText = 'Keine EPG Daten';
        }
      } else {
         if (titleEl) titleEl.innerText = 'Keine EPG Daten';
      }
    } catch (e) {
       console.error("EPG fetch error for card", streamId, e);
       const titleEl = card.querySelector('.epg-title') || card.querySelector('.channel-epg');
       if (titleEl) titleEl.innerText = 'Keine EPG Daten';
    }
  }


  /**
   * Shows the EPG Modal for a given live channel.
   */
  async showLiveEPGModal(ch) {
    const modal = document.getElementById('live-epg-modal');
    const hero = document.getElementById('live-epg-hero');
    const title = document.getElementById('live-epg-title');
    const playBtn = document.getElementById('live-epg-play-btn');
    const timeline = document.getElementById('live-epg-timeline');

    // Reset and show modal
    modal.classList.remove('hidden');
    title.textContent = ch.name;
    hero.innerHTML = ch.stream_icon ? `<img src="${ch.stream_icon}" alt="Logo" style="height: 100px; object-fit: contain; border-radius: 8px;">` : '';
    timeline.innerHTML = '<div style="text-align:center; padding: 20px;"><i class="fas fa-spinner fa-spin"></i> Lade Programmzeitschrift...</div>';

    // Play Button action
    playBtn.onclick = () => {
      modal.classList.add('hidden');
      window.player.play({ id: ch.stream_id, type: 'live', title: ch.name, subtitle: 'Live TV', cover: ch.stream_icon });
    };

    try {
      const epgData = await window.api.fetchLiveEPG(ch.stream_id, 10);
      const listings = epgData.epg_listings || [];

      if (listings.length === 0) {
        timeline.innerHTML = '<div style="text-align:center; padding: 20px; color: var(--color-text-muted);">Keine EPG-Daten für diesen Sender verfügbar.</div>';
        return;
      }

      const nowMs = Date.now();
      
      timeline.innerHTML = listings.map(item => {
        const startTs = parseInt(item.start_timestamp) * 1000;
        const endTs = parseInt(item.stop_timestamp) * 1000;
        const isNow = startTs <= nowMs && endTs >= nowMs;

        let timeStr = "";
        if (!isNaN(startTs) && !isNaN(endTs)) {
          const startDate = new Date(startTs);
          const endDate = new Date(endTs);
          const sTime = `${startDate.getHours().toString().padStart(2,'0')}:${startDate.getMinutes().toString().padStart(2,'0')}`;
          const eTime = `${endDate.getHours().toString().padStart(2,'0')}:${endDate.getMinutes().toString().padStart(2,'0')}`;
          timeStr = `${sTime} - ${eTime}`;
        }

        // Decode title/desc which are base64 encoded in XTream Codes EPG
        let titleText = item.title;
        let descText = item.description;
        try { titleText = decodeURIComponent(escape(atob(item.title))); } catch(e){}
        try { descText = decodeURIComponent(escape(atob(item.description))); } catch(e){}

        let progressHTML = '';
        if (isNow) {
          const totalDuration = endTs - startTs;
          const elapsed = nowMs - startTs;
          const percent = Math.min(100, Math.max(0, (elapsed / totalDuration) * 100));
          progressHTML = `
            <div class="epg-progress-bg">
              <div class="epg-progress-fill" style="width: ${percent}%;"></div>
            </div>
          `;
        }

        return `
          <div class="epg-item ${isNow ? 'now-playing' : ''}">
            <div class="epg-time">
              ${isNow ? 'JETZT<br>' : ''}${timeStr}
            </div>
            <div class="epg-details">
              <div class="epg-show-title">${titleText}</div>
              <div class="epg-show-desc">${descText}</div>
              ${progressHTML}
            </div>
          </div>
        `;
      }).join('');

    } catch (e) {
      console.error(e);
      timeline.innerHTML = '<div style="text-align:center; padding: 20px; color: #e50914;">Fehler beim Laden der EPG-Daten.</div>';
    }
  }

  /**
   * --- 3. MOVIES & SERIES GRID PAGES ---
   */
  async renderMoviesPage() {
    this.renderMediaGridPage('movies', 'Filme', 'movies', 'movie_categories');
  }

  async renderSeriesPage() {
    this.renderMediaGridPage('series', 'Serien', 'series', 'series_categories');
  }

  async renderMediaGridPage(typeKey, title, dbStore, dbCatStore) {
    const content = document.getElementById('main-content');
    content.innerHTML = `
      <div class="page-header">
        <h1>${title}</h1>
        <div class="header-filters">
          <select id="media-category-select" class="styled-select">
            <option value="all">Alle Kategorien</option>
            <option value="fav">Favoriten</option>
          </select>
          <select id="media-sort-select" class="styled-select" title="Sortierung">
            <option value="added_desc"   ${this.sortOrder==='added_desc'   ?'selected':''}>&#8595; Neueste zuerst</option>
            <option value="added_asc"    ${this.sortOrder==='added_asc'    ?'selected':''}>&#8593; Älteste zuerst</option>
            <option value="name_asc"     ${this.sortOrder==='name_asc'     ?'selected':''}>A–Z Name</option>
            <option value="name_desc"    ${this.sortOrder==='name_desc'    ?'selected':''}>Z–A Name</option>
            <option value="rating_desc"  ${this.sortOrder==='rating_desc'  ?'selected':''}>&#11088; Höchste Bewertung</option>
          </select>
          <div class="search-bar">
            <i class="fas fa-search"></i>
            <input type="text" id="media-search" placeholder="${title} suchen..." value="${this.searchQuery}">
          </div>
        </div>
      </div>
      <div class="media-grid-container">
        <div class="media-grid" id="media-items-grid">
          <div class="grid-skeleton"></div>
        </div>
      </div>
    `;

    const categories = await window.db.getAll(dbCatStore);
    const catSelect  = document.getElementById('media-category-select');

    // Fill categories dropdown
    categories.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat.category_id;
      opt.textContent = cat.category_name;
      if (this.currentCategory === String(cat.category_id)) opt.selected = true;
      catSelect.appendChild(opt);
    });

    const items = await this.getDeduplicatedMedia(dbStore);
    this.renderMediaItemsGrid(items, typeKey);

    // Category filter
    catSelect.addEventListener('change', (e) => {
      this.currentCategory = e.target.value;
      this.renderMediaItemsGrid(items, typeKey);
    });

    // Sort order
    document.getElementById('media-sort-select').addEventListener('change', (e) => {
      this.sortOrder = e.target.value;
      this.renderMediaItemsGrid(items, typeKey);
    });

    // Search
    document.getElementById('media-search').addEventListener('input', (e) => {
      this.searchQuery = e.target.value.toLowerCase();
      this.renderMediaItemsGrid(items, typeKey);
    });
  }

  renderMediaItemsGrid(items, typeKey, startFrom = 0) {
    const grid = document.getElementById('media-items-grid');
    if (!grid) return;

    const isMovie = typeKey === 'movies';
    const getId   = item => isMovie ? item.stream_id : item.series_id;

    // 1. Filter by category
    let filtered = items;
    if (this.currentCategory === 'fav') {
      filtered = items.filter(m => this.isFavorite(getId(m), isMovie ? 'movie' : 'series'));
    } else if (this.currentCategory !== 'all') {
      filtered = items.filter(m => String(m.category_id) === this.currentCategory);
    }

    // 2. Filter by search
    if (this.searchQuery) {
      filtered = filtered.filter(m => this.fuzzyMatch(this.searchQuery, m.name || ''));
    }

    // 3. Sort
    const sorted = [...filtered];
    switch (this.sortOrder) {
      case 'added_asc':
        sorted.sort((a, b) => (Number(a.added || a.last_modified || 0)) - (Number(b.added || b.last_modified || 0)));
        break;
      case 'name_asc':
        sorted.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'de'));
        break;
      case 'name_desc':
        sorted.sort((a, b) => (b.name || '').localeCompare(a.name || '', 'de'));
        break;
      case 'rating_desc':
        sorted.sort((a, b) => parseFloat(b.rating || 0) - parseFloat(a.rating || 0));
        break;
      case 'added_desc':
      default:
        sorted.sort((a, b) => (Number(b.added || b.last_modified || 0)) - (Number(a.added || a.last_modified || 0)));
        break;
    }

    if (sorted.length === 0) {
      grid.innerHTML = `
        <div class="no-results">
          <i class="fas fa-video-slash"></i>
          <p>Keine Einträge gefunden.</p>
        </div>
      `;
      return;
    }

    // 4. Paginate for performance
    const page    = sorted.slice(startFrom, startFrom + this.mediaPageSize);
    const hasMore = sorted.length > startFrom + this.mediaPageSize;

    const cardsHtml = page.map(item => {
      return this.createCardHTML({
        id:     getId(item),
        name:   item.name,
        cover:  isMovie ? item.stream_icon : item.cover,
        type:   isMovie ? 'movie' : 'series',
        rating: item.rating,
        added:  item.added || item.last_modified
      });
    }).join('');

    if (startFrom === 0) {
      grid.innerHTML = cardsHtml;
    } else {
      const oldBtn = grid.querySelector('.load-more-btn');
      if (oldBtn) oldBtn.remove();
      grid.insertAdjacentHTML('beforeend', cardsHtml);
    }

    // "Load more" button
    if (hasMore) {
      const remaining = sorted.length - startFrom - this.mediaPageSize;
      const loadMoreBtn = document.createElement('button');
      loadMoreBtn.className = 'load-more-btn';
      loadMoreBtn.innerHTML = `<i class="fas fa-chevron-down"></i> Mehr laden (${remaining} weitere)`;
      loadMoreBtn.addEventListener('click', () => {
        this.renderMediaItemsGrid(items, typeKey, startFrom + this.mediaPageSize);
      });
      grid.appendChild(loadMoreBtn);
    }

    // Hook events only on new cards
    this.hookCardEvents(grid);
  }

  /**
   * --- 4. FAVORITES PAGE ---
   */
  async renderFavoritesPage() {
    const content = document.getElementById('main-content');
    content.innerHTML = `
      <div class="page-header">
        <h1>Meine Favoriten</h1>
      </div>
      <div class="favorites-sections">
        <div class="fav-section" id="fav-live-section">
          <h2><i class="fas fa-tv text-red"></i> Live TV</h2>
          <div class="fav-grid live-grid" id="fav-live-grid"></div>
        </div>
        <div class="fav-section" id="fav-movies-section">
          <h2><i class="fas fa-film text-red"></i> Filme</h2>
          <div class="fav-grid media-grid" id="fav-movies-grid"></div>
        </div>
        <div class="fav-section" id="fav-series-section">
          <h2><i class="fas fa-video text-red"></i> Serien</h2>
          <div class="fav-grid media-grid" id="fav-series-grid"></div>
        </div>
      </div>
    `;

    const allLive = await window.db.getAll('live_streams');
    const allMovies = await this.getDeduplicatedMedia('movies');
    const allSeries = await this.getDeduplicatedMedia('series');

    const favLive = allLive.filter(c => this.isFavorite(c.stream_id, 'live'));
    const favMovies = allMovies.filter(m => this.isFavorite(m.stream_id, 'movie'));
    const favSeries = allSeries.filter(s => this.isFavorite(s.series_id, 'series'));

    // 1. Live TV grid
    const liveGrid = document.getElementById('fav-live-grid');
    if (favLive.length === 0) {
      document.getElementById('fav-live-section').style.display = 'none';
    } else {
      liveGrid.innerHTML = favLive.map(ch => `
        <div class="live-channel-card" data-id="${ch.stream_id}">
          <div class="channel-logo-wrapper">
            <img src="${ch.stream_icon || 'img/tv-placeholder.png'}" alt="${ch.name}" onerror="this.src='https://placehold.co/150x150/141414/ffffff?text=${ch.name.substring(0, 3)}'">
          </div>
          <div class="channel-details">
            <div class="channel-name">${ch.name}</div>
            <div class="channel-epg" style="margin-top: 4px; font-size: 0.75rem; color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Lade...</div>
            <div class="channel-epg-progress" style="display:none; height: 3px; background: rgba(255,255,255,0.1); margin-top: 6px; border-radius: 2px; overflow: hidden;">
              <div class="channel-epg-bar" style="height: 100%; background: var(--color-primary); width: 0%; transition: width 0.3s ease;"></div>
            </div>
          </div>
          <button class="channel-fav-btn active">
            <i class="fas fa-heart"></i>
          </button>
        </div>
      `).join('');
      
      // Events for fav live
      liveGrid.querySelectorAll('.live-channel-card').forEach(card => {
        const id = card.dataset.id;
        const ch = favLive.find(c => String(c.stream_id) === id);
        card.addEventListener('click', (e) => {
          if (e.target.closest('.channel-fav-btn')) return;
          this.showLiveEPGModal(ch);
        });
        card.querySelector('.channel-fav-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleFavorite(ch.stream_id, 'live');
        });
      });
      this.observeEPGCards(liveGrid);
    }

    // 2. Movies
    const moviesGrid = document.getElementById('fav-movies-grid');
    if (favMovies.length === 0) {
      document.getElementById('fav-movies-section').style.display = 'none';
    } else {
      moviesGrid.innerHTML = favMovies.map(item => this.createCardHTML({
        id: item.stream_id,
        name: item.name,
        cover: item.stream_icon,
        type: 'movie',
        rating: item.rating
      })).join('');
      this.hookCardEvents(moviesGrid);
    }

    // 3. Series
    const seriesGrid = document.getElementById('fav-series-grid');
    if (favSeries.length === 0) {
      document.getElementById('fav-series-section').style.display = 'none';
    } else {
      seriesGrid.innerHTML = favSeries.map(item => this.createCardHTML({
        id: item.series_id,
        name: item.name,
        cover: item.cover,
        type: 'series',
        rating: item.rating
      })).join('');
      this.hookCardEvents(seriesGrid);
    }

    if (favLive.length === 0 && favMovies.length === 0 && favSeries.length === 0) {
      content.innerHTML = `
        <div class="page-header">
          <h1>Meine Favoriten</h1>
        </div>
        <div class="no-results">
          <i class="fas fa-heart-broken"></i>
          <p>Du hast noch keine Favoriten hinzugefügt.</p>
        </div>
      `;
    }
  }

  async loadProgress() {
    this.savedProgressMap = {};
    const progressList = await window.db.getAll('progress');
    progressList.forEach(p => this.savedProgressMap[p.id] = p);
  }

  getCacheUrl(url) {
    if (!url || !url.startsWith('http')) return url || 'assets/logo.jpg';
    return 'aether-img://cache?url=' + encodeURIComponent(url);
  }

  createCardHTML(item) {
    const isFav = this.isFavorite(item.id, item.type);
    const imgSrc = this.getCacheUrl(item.cover);
    
    let progressHtml = '';
    if (this.savedProgressMap && this.savedProgressMap[item.id]) {
      const progress = this.savedProgressMap[item.id].percentage;
      if (progress > 2 && progress < 98) {
        progressHtml = `<div class="card-progress"><div class="card-progress-bar" style="width: ${progress}%"></div></div>`;
      }
    }

    return `
      <div class="netflix-card" data-id="${item.id}" data-type="${item.type}" data-name="${(item.name || '').replace(/"/g, '&quot;')}">
        <div class="card-img-wrapper">
          <img src="${imgSrc}" alt="${item.name}" loading="lazy"
            onerror="this.src='https://placehold.co/300x450/141414/e50914?text=${encodeURIComponent((item.name||'').substring(0,6))}'">
          <div class="card-trailer-overlay" style="display:none;"></div>
          ${isFav ? '<div class="fav-badge"><i class="fas fa-heart"></i></div>' : '<div class="fav-badge" style="display:none"><i class="fas fa-heart"></i></div>'}
          ${progressHtml}
          <div class="card-action-overlay">
            <button class="card-btn btn-play-card" title="Abspielen"><i class="fas fa-play"></i></button>
            <button class="card-btn btn-fav-card ${isFav ? 'active' : ''}" title="${isFav ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen'}"><i class="fas fa-heart"></i></button>
            <button class="card-btn btn-info-card" title="Details"><i class="fas fa-chevron-down"></i></button>
          </div>
        </div>
        <div class="card-short-info">
          <div class="card-title">${item.name}</div>
          <div class="card-meta">
            ${item.rating ? `<span class="rating-badge"><i class="fas fa-star text-gold"></i> ${parseFloat(item.rating).toFixed(1)}</span>` : ''}
            <span class="type-badge">${item.type === 'movie' ? 'Film' : 'Serie'}</span>
          </div>
        </div>
      </div>
    `;
  }

  hookCardEvents(container) {
    // Initialize trailer cache if not exists
    if (!this._trailerCache) this._trailerCache = {};

    container.querySelectorAll('.netflix-card').forEach(card => {
      const id = card.dataset.id;
      const type = card.dataset.type;
      const name = card.dataset.name || '';

      // Click card triggers open info modal
      card.addEventListener('click', (e) => {
        if (e.target.closest('.card-btn')) return; // handled separately
        this.openDetailModal(id, type);
      });

      // --- Trailer-on-Hover (YouTube IFrame Player API) ---
      let hoverTimer = null;
      let activeYTPlayer = null;

      card.addEventListener('mouseenter', () => {
        hoverTimer = setTimeout(async () => {
          const trailerOverlay = card.querySelector('.card-trailer-overlay');
          if (!trailerOverlay) return;

          // Check cache first
          const cacheKey = `${type}_${id}`;
          let trailerKeys = this._trailerCache[cacheKey];

          if (trailerKeys === undefined) {
            // Not searched yet - show loading indicator
            trailerOverlay.style.display = 'flex';
            trailerOverlay.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:rgba(0,0,0,0.7);"><i class="fas fa-spinner fa-spin" style="font-size:24px;color:var(--color-primary);"></i></div>';

            // Use cleanTitleForTMDB to strip IPTV junk
            const cleanName = this.cleanTitleForTMDB(name);
            trailerKeys = await this.fetchTMDBTrailerKeys(cleanName, type);
            this._trailerCache[cacheKey] = trailerKeys && trailerKeys.length > 0 ? trailerKeys : null;
          }

          if (trailerKeys && trailerKeys.length > 0 && card.matches(':hover')) {
            // Get proxy port for YouTube embed proxy
            const proxyPort = window.electronAPI ? await window.electronAPI.getProxyPort() : 0;
            
            const tryTrailer = (keyIndex) => {
              if (keyIndex >= trailerKeys.length || !card.matches(':hover')) {
                trailerOverlay.style.display = 'none';
                trailerOverlay.innerHTML = '';
                
                const actionOverlay = card.querySelector('.card-action-overlay');
                if (actionOverlay) {
                  actionOverlay.style.background = '';
                  const otherBtns = actionOverlay.querySelectorAll('.card-btn:not(.trailer-mute-btn)');
                  otherBtns.forEach(btn => btn.style.display = '');
                }
                const muteBtn = card.querySelector('.trailer-mute-btn');
                if (muteBtn) muteBtn.style.display = 'none';

                return;
              }
              const key = trailerKeys[keyIndex];

              trailerOverlay.style.display = 'flex';
              // Load via local proxy server which has http:// origin (avoids YouTube Error 153)
              const embedUrl = proxyPort 
                ? `http://127.0.0.1:${proxyPort}/youtube?v=${key}`
                : `https://www.youtube-nocookie.com/embed/${key}?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0&showinfo=0&loop=1&playlist=${key}`;

              trailerOverlay.innerHTML = `<iframe 
                src="${embedUrl}" 
                frameborder="0" allow="autoplay; encrypted-media" 
                style="width:100%;height:100%;position:absolute;top:0;left:0;pointer-events:none;border-radius:inherit;opacity:0;transition:opacity 0.3s ease;"
              ></iframe>`;

              const actionOverlay = card.querySelector('.card-action-overlay');
              if (actionOverlay) {
                // Do NOT hide buttons or background yet! We wait for the video to actually start playing.

                // Add mute button directly to the action overlay so it's always clickable
                let muteBtn = card.querySelector('.trailer-mute-btn');
                if (!muteBtn) {
                  muteBtn = document.createElement('button');
                  muteBtn.className = 'trailer-mute-btn card-btn';
                  muteBtn.innerHTML = '<i class="fas fa-volume-mute"></i>';
                  muteBtn.style.cssText = 'position:absolute;bottom:8px;left:8px;background:rgba(0,0,0,0.7);width:32px;height:32px;border-radius:50%;font-size:14px;color:#fff;display:flex;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,0.3);cursor:pointer;transition:all 0.2s;pointer-events:auto;z-index:10;';
                  actionOverlay.appendChild(muteBtn);

                  let isMuted = true;
                  muteBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const iframe = trailerOverlay.querySelector('iframe');
                    if (!iframe) return;
                    isMuted = !isMuted;
                    iframe.contentWindow.postMessage(JSON.stringify({ aetherMute: isMuted }), '*');
                    muteBtn.querySelector('i').className = isMuted ? 'fas fa-volume-mute' : 'fas fa-volume-up';
                    muteBtn.style.borderColor = isMuted ? 'rgba(255,255,255,0.3)' : 'var(--color-primary)';
                    muteBtn.style.color = isMuted ? '#fff' : 'var(--color-primary)';
                  });
                } else {
                  muteBtn.style.display = 'flex';
                }
              }

              // Listen for error forwarded from proxy page
              // Remove previous listener if exists to prevent duplicates
              if (card._trailerErrorHandler) {
                window.removeEventListener('message', card._trailerErrorHandler);
              }

              const messageHandler = (event) => {
                try {
                  if (typeof event.data === 'string') {
                    const data = JSON.parse(event.data);
                    if (data.aetherTrailerError) {
                      window.removeEventListener('message', messageHandler);
                      card._trailerErrorHandler = null;
                      console.log(`[Trailer] Key ${key} blocked (code ${data.code}), trying next...`);
                      tryTrailer(keyIndex + 1);
                    } else if (data.aetherTrailerPlaying) {
                      // Video started playing! Now we reveal the trailer and hide the buttons
                      const iframe = trailerOverlay.querySelector('iframe');
                      if (iframe) iframe.style.opacity = '1';
                      
                      const aOverlay = card.querySelector('.card-action-overlay');
                      if (aOverlay) {
                        aOverlay.style.background = 'transparent';
                        const otherBtns = aOverlay.querySelectorAll('.card-btn:not(.trailer-mute-btn)');
                        otherBtns.forEach(btn => btn.style.display = 'none');
                        const mBtn = aOverlay.querySelector('.trailer-mute-btn');
                        if (mBtn) mBtn.style.display = 'flex';
                      }
                    }
                  }
                } catch(e) {}
              };
              card._trailerErrorHandler = messageHandler;
              window.addEventListener('message', messageHandler);

              // Cleanup listener after 15s (if trailer is stuck loading for 15s, just give up and move to next)
              setTimeout(() => {
                if (card._trailerErrorHandler === messageHandler) {
                   window.removeEventListener('message', messageHandler);
                   card._trailerErrorHandler = null;
                   tryTrailer(keyIndex + 1);
                }
              }, 15000);
            };

            tryTrailer(0);
          } else if (!trailerKeys || trailerKeys.length === 0) {
            trailerOverlay.style.display = 'none';
            trailerOverlay.innerHTML = '';
          }
        }, 1500);
      });

      card.addEventListener('mouseleave', () => {
        if (hoverTimer) {
          clearTimeout(hoverTimer);
          hoverTimer = null;
        }

        if (card._trailerErrorHandler) {
          window.removeEventListener('message', card._trailerErrorHandler);
          card._trailerErrorHandler = null;
        }
        
        // Restore overlay background, hide mute button, and show other buttons
        const actionOverlay = card.querySelector('.card-action-overlay');
        if (actionOverlay) {
          actionOverlay.style.background = '';
          const otherBtns = actionOverlay.querySelectorAll('.card-btn:not(.trailer-mute-btn)');
          otherBtns.forEach(btn => btn.style.display = '');
        }
        const muteBtn = card.querySelector('.trailer-mute-btn');
        if (muteBtn) muteBtn.style.display = 'none';

        const trailerOverlay = card.querySelector('.card-trailer-overlay');
        if (trailerOverlay) {
          const iframe = trailerOverlay.querySelector('iframe');
          if (iframe && iframe.contentWindow) {
            try { iframe.contentWindow.postMessage(JSON.stringify({ aetherDestroy: true }), '*'); } catch(e) {}
          }
          setTimeout(() => {
            trailerOverlay.style.display = 'none';
            trailerOverlay.innerHTML = '';
          }, 50);
        }
      });

      // Overlay controls
      card.querySelector('.btn-play-card').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (type === 'movie') {
          window.player.play({
            id,
            type,
            title: card.querySelector('.card-title').textContent,
            subtitle: 'Film',
            cover: card.querySelector('img').src
          });
        } else {
          // For series, query first episode
          this.openDetailModal(id, type);
        }
      });

      card.querySelector('.btn-fav-card').addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleFavorite(id, type);
      });

      card.querySelector('.btn-info-card').addEventListener('click', (e) => {
        e.stopPropagation();
        this.openDetailModal(id, type);
      });
    });
  }

  initCarouselScrolling(rowElement) {
    const scrollContainer = rowElement.querySelector('.carousel-scroll');
    const leftArrow = rowElement.querySelector('.carousel-arrow.left');
    const rightArrow = rowElement.querySelector('.carousel-arrow.right');

    if (!scrollContainer || !leftArrow || !rightArrow) return;

    leftArrow.addEventListener('click', () => {
      scrollContainer.scrollBy({ left: -600, behavior: 'smooth' });
    });

    rightArrow.addEventListener('click', () => {
      scrollContainer.scrollBy({ left: 600, behavior: 'smooth' });
    });

    // --- Mouse/Touch Drag-to-Scroll Logic ---
    let isDown = false;
    let startX;
    let scrollLeft;

    const startDrag = (e) => {
      isDown = true;
      scrollContainer.style.cursor = 'grabbing';
      startX = (e.pageX || e.touches?.[0].pageX) - scrollContainer.offsetLeft;
      scrollLeft = scrollContainer.scrollLeft;
    };

    const stopDrag = () => {
      isDown = false;
      scrollContainer.style.cursor = '';
      Array.from(scrollContainer.children).forEach(c => c.style.pointerEvents = '');
    };

    const doDrag = (e) => {
      if (!isDown) return;
      // Prevent default to stop text selection / image dragging
      e.preventDefault();
      const x = (e.pageX || e.touches?.[0].pageX) - scrollContainer.offsetLeft;
      const walk = (x - startX) * 2; // scroll speed multiplier
      
      // If we actually dragged a bit, disable child clicks
      if (Math.abs(walk) > 10) {
        Array.from(scrollContainer.children).forEach(c => c.style.pointerEvents = 'none');
      }
      scrollContainer.scrollLeft = scrollLeft - walk;
    };

    scrollContainer.addEventListener('mousedown', startDrag);
    scrollContainer.addEventListener('mouseleave', stopDrag);
    scrollContainer.addEventListener('mouseup', stopDrag);
    scrollContainer.addEventListener('mousemove', doDrag);
    
    // Touch support (often natively handled by overflow-x: auto, but this ensures consistency)
    scrollContainer.addEventListener('touchstart', startDrag, { passive: true });
    scrollContainer.addEventListener('touchend', stopDrag);
    scrollContainer.addEventListener('touchcancel', stopDrag);
    scrollContainer.addEventListener('touchmove', doDrag, { passive: false });

    // Check visibility of arrows
    const checkArrows = () => {
      leftArrow.style.opacity = scrollContainer.scrollLeft > 5 ? '1' : '0';
      const hasMoreScroll = scrollContainer.scrollWidth - scrollContainer.scrollLeft > scrollContainer.clientWidth + 5;
      rightArrow.style.opacity = hasMoreScroll ? '1' : '0';
    };

    scrollContainer.addEventListener('scroll', checkArrows);
    window.addEventListener('resize', checkArrows);
    setTimeout(checkArrows, 500); // Wait for images load
  }

  cleanTitleForTMDB(title) {
    if (!title) return '';
    let clean = title;
    
    // 1. Remove blocks like |DE| or | FHD |
    clean = clean.replace(/\|.*?\|/g, ' ');

    // 2. Remove common IPTV tags
    const junkRegex = /\b(4K|FHD|UHD|HD|1080p|1080|720p|720|2160p|2160|SD|DE|GER|GERMAN|EN|ENG|ENGLISH|TR|IT|FR|PL|RU|ESP|ES|NL|PT|ARABIC|Multi|x264|x265|h264|h265|HEVC|VOD|HDR|SDR|IMDB|DTS|DD5\.1|5\.1|7\.1|Atmos|AAC|AC3|Remux|Bluray|WEB|WEBDL|3D|Extended|Directors Cut|Uncut|mkv|mp4|avi)\b/gi;
    clean = clean.replace(junkRegex, ' ');

    // 3. Remove content in brackets or parentheses (often years or release groups)
    clean = clean.replace(/\[.*?\]/g, ' ').replace(/\(.*?\)/g, ' ');

    // 4. Safely remove years (19xx or 20xx) if it doesn't leave the title empty
    const yearMatch = clean.match(/\b(19|20)\d{2}\b/g);
    if (yearMatch) {
      for (const y of yearMatch) {
        const withoutYear = clean.replace(y, '').trim();
        if (withoutYear.replace(/[^a-zA-Z]/g, '').length > 0) { // Still has letters
          clean = withoutYear;
        }
      }
    }

    // 5. Remove standalone TV season/episode markers if any leaked into movies
    clean = clean.replace(/\bS\d{2}E\d{2}\b/i, ' ');

    // 6. Clean up multiple spaces and trim
    return clean.replace(/\s+/g, ' ').trim();
  }
  /**
   * Background Task: Find missing covers using TMDB and update DB & DOM
   */
  async startCoverEnrichment() {
    try {
      const movies = await this.getDeduplicatedMedia('movies') || [];
      const series = await this.getDeduplicatedMedia('series') || [];
      
      const missingMovies = movies.filter(m => !m.stream_icon || m.stream_icon.trim() === '');
      const missingSeries = series.filter(s => !s.cover || s.cover.trim() === '');
      
      const queue = [
        ...missingMovies.map(m => ({ item: m, type: 'movie' })),
        ...missingSeries.map(s => ({ item: s, type: 'series' }))
      ];

      if (queue.length === 0) return;
      console.log(`[Cover Enrichment] Started for ${queue.length} items...`);

      for (const entry of queue) {
        const { item, type } = entry;
        const title = item.name || '';
        const id = type === 'movie' ? item.stream_id : item.series_id;
        
        if (!title || this.enrichmentFailedCache.has(id)) continue;

        try {
          const tmdbData = await this.fetchTMDBInfo(title, type);
          if (tmdbData) {
            const newCover = tmdbData.poster_path ? 'https://image.tmdb.org/t/p/w500' + tmdbData.poster_path : null;
            
            // Update Database with cover and TMDB ID for perfect deduplication
            if (type === 'movie') {
              if (newCover) item.stream_icon = newCover;
              item.tmdb_id = tmdbData.id;
              await window.db.put('movies', item);
            } else {
              if (newCover) item.cover = newCover;
              item.tmdb_id = tmdbData.id;
              await window.db.put('series', item);
            }
            
            // Update DOM if visible and we found a cover
            if (newCover) {
              const cards = document.querySelectorAll(`.netflix-card[data-id="${id}"]`);
              cards.forEach(card => {
                const img = card.querySelector('.card-img-wrapper img');
                if (img) img.src = newCover;
              });
            }
            console.log(`[Cover Enrichment] Found cover for: ${title}`);
          } else {
            this.enrichmentFailedCache.add(id);
          }
        } catch (err) {
          console.error(`[Cover Enrichment] Error fetching ${title}:`, err);
        }
        
        // Wait 300ms to respect TMDB rate limits (approx 3 req/sec)
        await new Promise(r => setTimeout(r, 300));
      }
      
      console.log(`[Cover Enrichment] Finished processing.`);
    } catch (e) {
      console.error('[Cover Enrichment] Fatal error:', e);
    }
  }

  async fetchTMDBInfo(title, type, year = null) {
    try {
      const apiKey = '627cd656ff20a065b19134ace6a0ab51'; // Hardcoded as requested
      if (!apiKey || apiKey.trim() === '') return null;

      const tmdbType = type === 'movie' ? 'movie' : 'tv';
      let cleanTitle = this.cleanTitleForTMDB(title);
      if (!cleanTitle) cleanTitle = title;

      let yearQuery = year && year !== 'N/A' ? `&year=${year}` : '';
      if (tmdbType === 'tv') {
        yearQuery = year && year !== 'N/A' ? `&first_air_date_year=${year}` : '';
      }

      const executeSearch = async (queryTitle) => {
        const url = `https://api.themoviedb.org/3/search/${tmdbType}?api_key=${apiKey}&language=de-DE&query=${encodeURIComponent(queryTitle)}${yearQuery}&page=1`;
        const response = await fetch(url);
        if (!response.ok) return null;
        const data = await response.json();
        if (data.results && data.results.length > 0) {
          // Use fuzzy matching to find the best result in the list!
          let bestMatch = data.results[0]; // fallback
          for (const match of data.results) {
             const matchTitle = match.title || match.name || '';
             if (this.fuzzyMatch(cleanTitle, matchTitle) || this.fuzzyMatch(matchTitle, cleanTitle)) {
                bestMatch = match;
                break;
             }
          }
          const match = bestMatch;
          return {
            id: match.id,
            plot: match.overview,
            rating: match.vote_average ? match.vote_average.toFixed(1) : null,
            poster: match.poster_path ? `https://image.tmdb.org/t/p/w500${match.poster_path}` : null,
            backdrop: match.backdrop_path ? `https://image.tmdb.org/t/p/original${match.backdrop_path}` : null,
            releaseYear: match.release_date ? match.release_date.substring(0, 4) : (match.first_air_date ? match.first_air_date.substring(0, 4) : null)
          };
        }
        return null;
      };

      // Stage 1: Exact search with cleaned title
      let result = await executeSearch(cleanTitle);

      // Stage 2: Fallback to just the first 2-3 words
      if (!result) {
        const words = cleanTitle.split(' ');
        if (words.length > 2) {
          const shortTitle = words.slice(0, 2).join(' ');
          result = await executeSearch(shortTitle);
        } else if (words.length === 2 && words[1].length > 4) {
          const shortTitle = words[0];
          result = await executeSearch(shortTitle);
        }
      }

      return result;
    } catch (e) {
      console.error('TMDB Fetch Error:', e);
      return null;
    }
  }

  async fetchTMDBTrailer(title, type, year = null) {
    // Returns a single key (for backward compat with detail modal)
    const keys = await this.fetchTMDBTrailerKeys(title, type, year);
    return keys && keys.length > 0 ? keys[0] : null;
  }

  async fetchTMDBTrailerKeys(title, type, year = null) {
    try {
      const apiKey = '627cd656ff20a065b19134ace6a0ab51';
      if (!apiKey || apiKey.trim() === '') return [];

      const tmdbType = type === 'movie' ? 'movie' : 'tv';
      
      // Use the robust fetchTMDBInfo which has fuzzy matching and proper fallbacks
      const info = await this.fetchTMDBInfo(title, type, year);
      if (!info || !info.id) return [];
      
      const id = info.id;
      
      if (id) {
        const collectKeys = (videos) => {
          const ytVideos = videos.filter(v => v.site === 'YouTube');
          // Prioritize Trailers over Teasers, then Clips
          ytVideos.sort((a, b) => {
            const priority = { 'Trailer': 0, 'Teaser': 1, 'Clip': 2, 'Featurette': 3 };
            return (priority[a.type] ?? 4) - (priority[b.type] ?? 4);
          });
          return ytVideos.map(v => v.key);
        };

        // Fetch German videos
        const videoUrl = `https://api.themoviedb.org/3/${tmdbType}/${id}/videos?api_key=${apiKey}&language=de-DE`;
        const videoRes = await fetch(videoUrl);
        let allKeys = [];
        if (videoRes.ok) {
          const videoData = await videoRes.json();
          allKeys = collectKeys(videoData.results);
        }

        // Also fetch English as fallback
        const enUrl = `https://api.themoviedb.org/3/${tmdbType}/${id}/videos?api_key=${apiKey}&language=en-US`;
        const enRes = await fetch(enUrl);
        if (enRes.ok) {
          const enData = await enRes.json();
          const enKeys = collectKeys(enData.results);
          // Add English keys that aren't already in the list
          enKeys.forEach(k => { if (!allKeys.includes(k)) allKeys.push(k); });
        }

        return allKeys;
      }
    } catch (e) {
      console.error('TMDB Trailer Fetch Error:', e);
    }
    return [];
  }

  async fetchTMDBNextMovieInCollection(title, year = null) {
    try {
      const apiKey = '627cd656ff20a065b19134ace6a0ab51';
      if (!apiKey || apiKey.trim() === '') return null;

      let cleanTitle = title.split('|')[0].replace(/\(\d{4}\)/g, '').replace(/\[.*?\]/g, '').split('-')[0].trim();
      let yearQuery = year && year !== 'N/A' ? `&year=${year}` : '';

      // 1. Find Movie ID
      const searchUrl = `https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&language=de-DE&query=${encodeURIComponent(cleanTitle)}${yearQuery}&page=1`;
      const searchRes = await fetch(searchUrl);
      if (!searchRes.ok) return null;
      const searchData = await searchRes.json();
      if (!searchData.results || searchData.results.length === 0) return null;
      
      const movieId = searchData.results[0].id;

      // 2. Get Movie Details (to find belongs_to_collection)
      const detailUrl = `https://api.themoviedb.org/3/movie/${movieId}?api_key=${apiKey}&language=de-DE`;
      const detailRes = await fetch(detailUrl);
      if (!detailRes.ok) return null;
      const detailData = await detailRes.json();
      
      if (!detailData.belongs_to_collection) return null;
      
      const collectionId = detailData.belongs_to_collection.id;
      
      // 3. Fetch Collection Parts
      const collectionUrl = `https://api.themoviedb.org/3/collection/${collectionId}?api_key=${apiKey}&language=de-DE`;
      const collectionRes = await fetch(collectionUrl);
      if (!collectionRes.ok) return null;
      const collectionData = await collectionRes.json();
      
      if (!collectionData.parts || collectionData.parts.length === 0) return null;
      
      // Sort parts chronologically by release_date
      const parts = collectionData.parts.sort((a, b) => {
         if (!a.release_date) return 1;
         if (!b.release_date) return -1;
         return new Date(a.release_date) - new Date(b.release_date);
      });
      
      // Find current movie index
      const currentIndex = parts.findIndex(p => p.id === movieId);
      if (currentIndex !== -1 && currentIndex < parts.length - 1) {
        const nextMovie = parts[currentIndex + 1];
        return {
          title: nextMovie.title || nextMovie.original_title,
          releaseYear: nextMovie.release_date ? nextMovie.release_date.substring(0, 4) : null,
          cover: nextMovie.poster_path ? `https://image.tmdb.org/t/p/w500${nextMovie.poster_path}` : null,
          tmdbId: nextMovie.id
        };
      }
    } catch (e) {
      console.error('TMDB Next Movie Fetch Error:', e);
    }
    return null;
  }

  async findMovieInLibrary(searchTitle) {
    try {
       const movies = await this.getDeduplicatedMedia('movies');
       if (!movies || movies.length === 0) return null;
       
       const normalize = (t) => t.toLowerCase().replace(/[^a-z0-9äöüß ]/g, '').replace(/\s+/g, ' ').trim();
       const cleanSearch = normalize(searchTitle);
       if (!cleanSearch) return null;
       
       // Exact match first
       let match = movies.find(m => normalize(m.name) === cleanSearch);
       if (match) return match;
       
       // Contains match (full string)
       match = movies.find(m => {
           const normName = normalize(m.name);
           // Only allow normName.includes(cleanSearch). The reverse causes false positives if normName is a short word like '2'
           return normName.includes(cleanSearch);
       });
       if (match) return match;

       // Word-based subset match (e.g. TMDB: "John Wick: Kapitel 2" vs DB: "John Wick 2")
       const searchWords = cleanSearch.split(' ');
       const ignoreWords = ['kapitel', 'chapter', 'teil', 'part', 'vol', 'volume', 'the', 'der', 'die', 'das', 'und', 'and'];
       const coreSearchWords = searchWords.filter(w => !ignoreWords.includes(w) && w.length > 0);

       match = movies.find(m => {
           const dbWords = normalize(m.name).split(' ').filter(w => !ignoreWords.includes(w) && w.length > 0);
           if (dbWords.length === 0 || coreSearchWords.length === 0) return false;
           
           const intersection = coreSearchWords.filter(x => dbWords.includes(x)).length;
           const union = new Set([...coreSearchWords, ...dbWords]).size;
           const similarity = intersection / union;
           
           // Require at least 70% word similarity (Jaccard index)
           // "John Wick 2" vs "John Wick 2" -> 1.0 (Match)
           // "John Wick 3 Parabellum" vs "John Wick 3" -> 0.75 (Match)
           // "John Wick 2" vs "John 2" -> 0.66 (No Match - prevents Greek movie bug)
           return similarity >= 0.7;
       });

       return match || null;
    } catch (e) {
       console.error('Error finding movie in library:', e);
       return null;
    }
  }

  /**
   * --- 5. DETAILED INFORMATION MODAL ---
   */
  async openDetailModal(id, type) {
    const modal = document.getElementById('netflix-detail-modal');
    const inner = document.getElementById('modal-inner-content');
    const bg = document.getElementById('modal-dynamic-bg');

    if (bg) {
      bg.style.opacity = '0';
      bg.style.backgroundImage = 'none';
    }

    // Tag modal with current item so _updateFavButtons can target it correctly
    modal.dataset.currentId   = String(id);
    modal.dataset.currentType = type;

    modal.classList.add('loading');
    modal.classList.remove('hidden');

    inner.innerHTML = `
      <div class="modal-loading-spinner">
        <div class="spinner"></div>
        <p>Lade Details...</p>
      </div>
    `;

    try {
      if (type === 'movie') {
        const data = await window.api.fetchMovieInfo(id);
        const movie = data.movie_data || {};
        const info = data.info || {};

        // Merge attributes
        let title = movie.name || info.name || 'Unbekannter Titel';
        const cover = movie.stream_icon || info.movie_image || 'assets/logo.jpg';
        let rating = info.rating || 'N/A';
        let releaseYear = info.releasedate ? info.releasedate.substring(0, 4) : (info.releaseDate ? info.releaseDate.substring(0, 4) : 'N/A');
        const duration = info.duration_secs ? Math.round(info.duration_secs / 60) + ' Min.' : (info.duration ? info.duration : 'N/A');
        let plot = info.plot || 'Keine Beschreibung vorhanden.';
        const cast = info.cast || 'N/A';
        const director = info.director || 'N/A';
        const genre = info.genre || 'N/A';

        // Fetch from TMDB if plot is missing
        if (!plot || plot === 'Keine Beschreibung vorhanden.' || plot.trim() === '') {
          const tmdbData = await this.fetchTMDBInfo(title, 'movie', releaseYear);
          if (tmdbData) {
             if (tmdbData.plot && tmdbData.plot !== '') plot = tmdbData.plot + ' (via TMDB)';
             if (tmdbData.rating && rating === 'N/A') rating = tmdbData.rating;
             if (tmdbData.releaseYear && releaseYear === 'N/A') releaseYear = tmdbData.releaseYear;
          }
        }
        const isFav = this.isFavorite(id, 'movie');

        if (bg) {
          bg.style.backgroundImage = `url('${this.getCacheUrl(cover)}')`;
          bg.style.opacity = '1';
        }

        // Check if there is saved playback progress
        const savedProgress = await window.db.getProgress(id);
        const progressButtonText = savedProgress ? 'Weiterspielen' : 'Abspielen';
        const progressText = savedProgress ? `Gesehen bis ${window.player.formatTime(savedProgress.position)} (${Math.round(savedProgress.percentage)}%)` : '';

        inner.innerHTML = `
          <div class="modal-hero" style="background-image: linear-gradient(to top, var(--color-bg) 0%, rgba(20, 20, 20, 0.4) 60%, rgba(20, 20, 20, 0.8) 100%), url('${this.getCacheUrl(cover)}')">
            <button class="modal-close-btn" onclick="document.getElementById('netflix-detail-modal').classList.add('hidden')">
              <i class="fas fa-times"></i>
            </button>
            <div class="modal-hero-content">
              <h2 class="modal-title">${title}</h2>
              <div class="modal-hero-buttons" style="display: flex; align-items: center; flex-wrap: wrap; gap: 10px;">
                <button class="btn-play" id="modal-play-btn"><i class="fas fa-play"></i> ${progressButtonText}</button>
                <button class="btn-fav-round ${isFav ? 'active' : ''}" id="modal-fav-btn"><i class="fas fa-heart"></i></button>
                <button class="btn-fav-round" id="modal-tmdb-btn" title="Auf TMDB manuell suchen" style="background: rgba(1, 180, 228, 0.2); color: #01b4e4; border: 1px solid #01b4e4;"><i class="fas fa-search"></i></button>
                <button class="btn-fav-round" id="modal-trailer-btn" title="Trailer ansehen" style="background: rgba(229, 9, 20, 0.2); color: #e50914; border: 1px solid #e50914;"><i class="fab fa-youtube"></i></button>
                <button class="btn-fav-round" id="modal-download-btn" title="Herunterladen" style="background: rgba(255, 255, 255, 0.2); color: #fff; border: 1px solid #fff;"><i class="fas fa-download"></i></button>
                <div id="tmdb-search-container" style="display:none; align-items:center; gap:5px;">
                  <input type="text" id="tmdb-search-input" value="${title.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').split('-')[0].trim()}" style="background: rgba(0,0,0,0.7); color: #fff; border: 1px solid #01b4e4; border-radius: 4px; padding: 8px 10px; width: 200px;">
                  <button id="modal-tmdb-submit" style="background: #01b4e4; color: white; border: none; padding: 8px 12px; border-radius: 4px; cursor: pointer; font-weight: bold;">Los</button>
                </div>
              </div>
              ${progressText ? `<div class="modal-progress-label"><i class="fas fa-history"></i> ${progressText}</div>` : ''}
            </div>
          </div>
          <div class="modal-body">
            <div class="modal-grid-details">
              <div class="modal-left-pane">
                <div class="modal-meta-row">
                  <span class="imdb-rating"><i class="fab fa-imdb text-gold"></i> ${rating}</span>
                  <span class="modal-year">${releaseYear}</span>
                  <span class="modal-duration">${duration}</span>
                  <span class="badge-hd">HD</span>
                </div>
                <p class="modal-plot">${plot}</p>
              </div>
              <div class="modal-right-pane">
                <div class="meta-item"><span>Besetzung:</span> ${cast}</div>
                <div class="meta-item"><span>Regisseur:</span> ${director}</div>
                <div class="meta-item"><span>Genre:</span> ${genre}</div>
              </div>
            </div>
          </div>
        `;

        modal.classList.remove('loading');

        // Render Download button state
        this._renderModalDownloadButton(id, this.downloadsCache[id]);

        // Handlers
        document.getElementById('modal-play-btn').addEventListener('click', () => {
          modal.classList.add('hidden');
          window.player.play({
            id,
            type: 'movie',
            title,
            subtitle: 'Film',
            cover
          });
        });

        document.getElementById('modal-fav-btn').addEventListener('click', (e) => {
          this.toggleFavorite(id, 'movie');
        });

        document.getElementById('modal-tmdb-btn')?.addEventListener('click', () => {
          document.getElementById('tmdb-search-container').style.display = 'flex';
        });

        document.getElementById('modal-tmdb-submit')?.addEventListener('click', async () => {
          const customTitle = document.getElementById('tmdb-search-input').value.trim();
          if (customTitle) {
            document.getElementById('modal-tmdb-submit').innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
            const tmdbData = await this.fetchTMDBInfo(customTitle, 'movie');
            document.getElementById('modal-tmdb-submit').innerHTML = 'Los';
            if (tmdbData && tmdbData.plot) {
              title = customTitle; // Update the title for trailer search
              document.querySelector('.modal-plot').innerHTML = tmdbData.plot + ' <span style="color:#01b4e4;font-size:12px;">(TMDB)</span>';
              if (tmdbData.rating) document.querySelector('.imdb-rating').innerHTML = `<i class="fab fa-imdb text-gold"></i> ${tmdbData.rating}`;
              if (tmdbData.releaseYear) {
                releaseYear = tmdbData.releaseYear;
                document.querySelector('.modal-year').innerHTML = tmdbData.releaseYear;
              }
              document.getElementById('tmdb-search-container').style.display = 'none';
            } else {
              alert("Leider nichts gefunden. Bitte versuche den Titel noch weiter zu vereinfachen.");
            }
          }
        });

        document.getElementById('modal-trailer-btn')?.addEventListener('click', async () => {
          const btn = document.getElementById('modal-trailer-btn');
          btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
          const trailerKey = await this.fetchTMDBTrailer(title, 'movie', releaseYear);
          btn.innerHTML = '<i class="fab fa-youtube"></i>';
          
          if (trailerKey) {
            const trailerContainer = document.getElementById('trailer-video-container');
            trailerContainer.innerHTML = `<iframe width="100%" height="100%" style="position:absolute;top:0;left:0;" src="https://www.youtube-nocookie.com/embed/${trailerKey}?controls=1&rel=0" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
            document.getElementById('trailer-modal').classList.remove('hidden');
            const extBtn = document.getElementById('trailer-external-btn');
            if (extBtn) {
              extBtn.onclick = () => {
                if (window.electronAPI && window.electronAPI.openExternal) {
                  window.electronAPI.openExternal(`https://www.youtube.com/watch?v=${trailerKey}`);
                }
              };
            }
          } else {
            alert("Leider konnte kein Trailer gefunden werden.");
          }
        });

      } else {
        // Series Detail view
        const data = await window.api.fetchSeriesInfo(id);
        const info = data.info || {};
        const seasons = data.seasons || {};
        const episodes = data.episodes || {};

        let title = info.name || 'Unbekannte Serie';
        const cover = info.cover || 'assets/logo.jpg';
        let rating = info.rating || 'N/A';
        let releaseYear = info.releaseDate ? info.releaseDate.substring(0, 4) : 'N/A';
        let plot = info.plot || 'Keine Beschreibung vorhanden.';
        const cast = info.cast || 'N/A';
        const director = info.director || 'N/A';
        const genre = info.genre || 'N/A';
        
        let tmdbSeriesId = null;

        // Fetch from TMDB if plot is missing
        if (!plot || plot === 'Keine Beschreibung vorhanden.' || plot.trim() === '') {
          const tmdbData = await this.fetchTMDBInfo(title, 'series', releaseYear);
          if (tmdbData) {
             tmdbSeriesId = tmdbData.id;
             if (tmdbData.plot && tmdbData.plot !== '') plot = tmdbData.plot + ' (via TMDB)';
             if (tmdbData.rating && rating === 'N/A') rating = tmdbData.rating;
             if (tmdbData.releaseYear && releaseYear === 'N/A') releaseYear = tmdbData.releaseYear;
          }
        }
        const isFav = this.isFavorite(id, 'series');

        if (bg) {
          bg.style.backgroundImage = `url('${this.getCacheUrl(cover)}')`;
          bg.style.opacity = '1';
        }

        // Collect available seasons
        const seasonKeys = Object.keys(episodes).sort((a, b) => parseInt(a) - parseInt(b));
        
        inner.innerHTML = `
          <div class="modal-hero" style="background-image: linear-gradient(to top, var(--color-bg) 0%, rgba(20, 20, 20, 0.4) 60%, rgba(20, 20, 20, 0.8) 100%), url('${this.getCacheUrl(cover)}')">
            <button class="modal-close-btn" onclick="document.getElementById('netflix-detail-modal').classList.add('hidden')">
              <i class="fas fa-times"></i>
            </button>
            <div class="modal-hero-content">
              <h2 class="modal-title">${title}</h2>
              <div class="modal-hero-buttons" style="display: flex; align-items: center; flex-wrap: wrap; gap: 10px;">
                <button class="btn-play" id="series-start-play-btn"><i class="fas fa-play"></i> Erste Folge abspielen</button>
                <button class="btn-fav-round ${isFav ? 'active' : ''}" id="modal-fav-btn"><i class="fas fa-heart"></i></button>
                <button class="btn-fav-round" id="modal-tmdb-btn" title="Auf TMDB manuell suchen" style="background: rgba(1, 180, 228, 0.2); color: #01b4e4; border: 1px solid #01b4e4;"><i class="fas fa-search"></i></button>
                <div id="tmdb-search-container" style="display:none; align-items:center; gap:5px;">
                  <input type="text" id="tmdb-search-input" value="${title.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').split('-')[0].trim()}" style="background: rgba(0,0,0,0.7); color: #fff; border: 1px solid #01b4e4; border-radius: 4px; padding: 8px 10px; width: 200px;">
                  <button id="modal-tmdb-submit" style="background: #01b4e4; color: white; border: none; padding: 8px 12px; border-radius: 4px; cursor: pointer; font-weight: bold;">Los</button>
                </div>
              </div>
            </div>
          </div>
          <div class="modal-body">
            <div class="modal-grid-details">
              <div class="modal-left-pane">
                <div class="modal-meta-row">
                  <span class="imdb-rating"><i class="fab fa-imdb text-gold"></i> ${rating}</span>
                  <span class="modal-year">${releaseYear}</span>
                  <span class="badge-hd">HD</span>
                </div>
                <p class="modal-plot">${plot}</p>
              </div>
              <div class="modal-right-pane">
                <div class="meta-item"><span>Besetzung:</span> ${cast}</div>
                <div class="meta-item"><span>Regisseur:</span> ${director}</div>
                <div class="meta-item"><span>Genre:</span> ${genre}</div>
              </div>
            </div>
            
            <div class="episodes-section">
              <div class="episodes-header">
                <h3>Episoden</h3>
                <div style="display:flex; align-items:center; gap:10px;">
                  <select id="season-selector" class="styled-select">
                    ${seasonKeys.map(s => `<option value="${s}">Staffel ${s}</option>`).join('')}
                  </select>
                  <button id="btn-download-season" title="Ganze Staffel herunterladen" style="background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.3); color:#fff; padding:6px 12px; border-radius:4px; cursor:pointer; font-size:13px; white-space:nowrap; display:flex; align-items:center; gap:6px;">
                    <i class="fas fa-download"></i> Staffel laden
                  </button>
                </div>
              </div>
              <div class="episodes-list" id="modal-episodes-list"></div>
            </div>
          </div>
        `;

        modal.classList.remove('loading');

        const seasonSelect = document.getElementById('season-selector');
        
        const renderEpisodes = async (seasonNum) => {
          const list = document.getElementById('modal-episodes-list');
          list.innerHTML = '<div class="spinner-small"></div>';
          
          const epList = episodes[seasonNum] || [];
          
          // Sort episodes by episode_num
          epList.sort((a, b) => parseInt(a.episode_num) - parseInt(b.episode_num));

          // Fetch TMDB season data if we have a TMDB Series ID
          let tmdbSeasonEpisodes = [];
          if (tmdbSeriesId) {
            try {
              const apiKey = '627cd656ff20a065b19134ace6a0ab51';
              const res = await fetch(`https://api.themoviedb.org/3/tv/${tmdbSeriesId}/season/${seasonNum}?api_key=${apiKey}&language=de-DE`);
              if (res.ok) {
                const data = await res.json();
                if (data.episodes) tmdbSeasonEpisodes = data.episodes;
              }
            } catch (e) {
              console.error('TMDB Season Fetch Error:', e);
            }
          }

          // Fetch watch progress for all episodes in this season
          const formattedEpisodes = await Promise.all(epList.map(async ep => {
            const progress = await window.db.getProgress(ep.id);
            
            // Enhance episode with TMDB data if missing
            let enhancedPlot = ep.info && ep.info.plot ? ep.info.plot : '';
            let enhancedImg = ep.info && ep.info.movie_image ? ep.info.movie_image : cover;
            
            if (!enhancedPlot || enhancedPlot === 'Keine Beschreibung verfügbar.') {
              const tmdbEp = tmdbSeasonEpisodes.find(t => t.episode_number == ep.episode_num);
              if (tmdbEp && tmdbEp.overview) {
                enhancedPlot = tmdbEp.overview + ' <span style="color:#01b4e4;font-size:12px;">(TMDB)</span>';
                if (tmdbEp.still_path) {
                  enhancedImg = `https://image.tmdb.org/t/p/w500${tmdbEp.still_path}`;
                }
              }
            }

            return { ...ep, progress, enhancedPlot, enhancedImg };
          }));

          list.innerHTML = formattedEpisodes.map(ep => {
            const hasProgress = ep.progress && ep.progress.position > 10;
            const progressPercentage = hasProgress ? ep.progress.percentage : 0;
            const epTitle = ep.title ? ep.title.trim() : `Episode ${ep.episode_num}`;
            const epPlot = ep.enhancedPlot || 'Keine Beschreibung verfügbar.';
            const epDuration = ep.info && ep.info.duration ? ep.info.duration : (ep.info && ep.info.duration_secs ? Math.round(ep.info.duration_secs/60) + ' Min.' : '');
            const epImg = ep.enhancedImg;
            
            const dl = window.ui.downloadsCache[ep.id];
            let dlIcon = '<i class="fas fa-download"></i>';
            let dlColor = 'white';
            if (dl) {
              if (dl.status === 'downloading') {
                dlIcon = '<i class="fas fa-spinner fa-spin"></i>';
                dlColor = '#01b4e4';
              } else if (dl.status === 'completed') {
                dlIcon = '<i class="fas fa-check"></i>';
                dlColor = '#4caf50';
              } else if (dl.status === 'error') {
                dlIcon = '<i class="fas fa-exclamation-triangle"></i>';
                dlColor = '#e50914';
              }
            }

            return `
              <div class="episode-row" data-stream-id="${ep.id}">
                <div class="ep-num">${ep.episode_num}</div>
                <div class="ep-img-wrapper">
                  <img src="${epImg}" alt="${epTitle}" onerror="this.src='https://placehold.co/300x170/141414/ffffff?text=Episode+${ep.episode_num}'">
                  <div class="ep-play-overlay"><i class="fas fa-play"></i></div>
                </div>
                <div class="ep-details">
                  <div class="ep-title-row">
                    <span class="ep-title">${epTitle}</span>
                    <div style="display:flex; align-items:center; gap: 10px;">
                      <button class="ep-download-btn" data-stream-id="${ep.id}" data-ep-title="${title} - S${seasonNum}E${ep.episode_num}" data-ep-cover="${epImg}" style="background:transparent; border:none; color:${dlColor}; cursor:pointer; font-size: 16px;" title="Herunterladen">${dlIcon}</button>
                      <span class="ep-duration">${epDuration}</span>
                    </div>
                  </div>
                  <p class="ep-plot">${epPlot}</p>
                  ${hasProgress ? `
                    <div class="ep-progress-bar">
                      <div class="ep-progress-fill" style="width: ${progressPercentage}%"></div>
                    </div>
                  ` : ''}
                </div>
              </div>
            `;
          }).join('');

          // Episode click listeners
          list.querySelectorAll('.episode-row').forEach(row => {
            const streamId = row.dataset.streamId;
            const epObj = epList.find(e => String(e.id) === streamId);
            
            // Download button listener
            const dlBtn = row.querySelector('.ep-download-btn');
            if (dlBtn) {
              dlBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const epTitle = dlBtn.dataset.epTitle;
                const epCover = dlBtn.dataset.epCover;
                const existingDl = window.ui.downloadsCache[streamId];
                if (existingDl && (existingDl.status === 'downloading' || existingDl.status === 'completed')) {
                  window.ui.cancelDownload(streamId);
                } else {
                  window.ui.startDownload(streamId, epTitle, epCover, true);
                  dlBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
                  dlBtn.style.color = '#01b4e4';
                }
              });
            }

            row.addEventListener('click', () => {
              modal.classList.add('hidden');
              window.player.play({
                id: epObj.id,
                type: 'series',
                title: title,
                subtitle: `Staffel ${seasonNum} • Folge ${epObj.episode_num} - ${epObj.title || ''}`,
                cover: cover,
                isSeries: true,
                seriesId: id,
                season: seasonNum,
                episode: epObj.episode_num,
                seasonsData: episodes,
                seriesTitle: title,
                seriesCover: cover
              });
            });
          });
        };

        // Render first season on start
        if (seasonKeys.length > 0) {
          renderEpisodes(seasonKeys[0]);
        }

        // Season select listener
        seasonSelect.addEventListener('change', (e) => {
          renderEpisodes(e.target.value);
        });

        // Download entire season button
        document.getElementById('btn-download-season').addEventListener('click', async () => {
          const selectedSeason = seasonSelect.value;
          const epList = episodes[selectedSeason];
          if (!epList || epList.length === 0) return;
          
          const sorted = [...epList].sort((a, b) => parseInt(a.episode_num) - parseInt(b.episode_num));
          const confirmed = confirm(`Möchtest du alle ${sorted.length} Folgen von Staffel ${selectedSeason} herunterladen?`);
          if (!confirmed) return;
          
          const btn = document.getElementById('btn-download-season');
          btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Wird gestartet...';
          btn.style.pointerEvents = 'none';
          
          for (const ep of sorted) {
            const epTitle = `${title} - S${selectedSeason}E${ep.episode_num}`;
            const epImg = (ep.info && ep.info.movie_image) || cover;
            const existingDl = this.downloadsCache[String(ep.id)];
            if (existingDl && (existingDl.status === 'downloading' || existingDl.status === 'completed')) {
              continue; // skip already downloading/completed
            }
            await this.startDownload(ep.id, epTitle, epImg, true);
            // Small delay between starts to not overwhelm ffmpeg
            await new Promise(r => setTimeout(r, 500));
          }
          
          btn.innerHTML = '<i class="fas fa-check"></i> Gestartet!';
          btn.style.color = '#4caf50';
          setTimeout(() => {
            btn.innerHTML = '<i class="fas fa-download"></i> Staffel laden';
            btn.style.color = '#fff';
            btn.style.pointerEvents = '';
          }, 3000);
          
          // Refresh episode list to show download icons
          renderEpisodes(selectedSeason);
        });

        // Series start play btn (plays S1 E1)
        document.getElementById('series-start-play-btn').addEventListener('click', () => {
          if (seasonKeys.length > 0 && episodes[seasonKeys[0]].length > 0) {
            const ep = episodes[seasonKeys[0]].sort((a,b)=>parseInt(a.episode_num)-parseInt(b.episode_num))[0];
            modal.classList.add('hidden');
            window.player.play({
              id: ep.id,
              type: 'series',
              title: title,
              subtitle: `Staffel ${seasonKeys[0]} • Folge ${ep.episode_num} - ${ep.title || ''}`,
              cover: cover,
              isSeries: true,
              seriesId: id,
              season: seasonKeys[0],
              episode: ep.episode_num,
              seasonsData: episodes,
              seriesTitle: title,
              seriesCover: cover
            });
          }
        });

        document.getElementById('modal-fav-btn').addEventListener('click', (e) => {
          this.toggleFavorite(id, 'series');
        });

        document.getElementById('modal-tmdb-btn')?.addEventListener('click', () => {
          document.getElementById('tmdb-search-container').style.display = 'flex';
        });

        document.getElementById('modal-tmdb-submit')?.addEventListener('click', async () => {
          const customTitle = document.getElementById('tmdb-search-input').value.trim();
          if (customTitle) {
            document.getElementById('modal-tmdb-submit').innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
            const tmdbData = await this.fetchTMDBInfo(customTitle, 'series');
            document.getElementById('modal-tmdb-submit').innerHTML = 'Los';
            if (tmdbData && tmdbData.plot) {
              title = customTitle; // Update the title for trailer search
              document.querySelector('.modal-plot').innerHTML = tmdbData.plot + ' <span style="color:#01b4e4;font-size:12px;">(TMDB)</span>';
              if (tmdbData.rating) document.querySelector('.imdb-rating').innerHTML = `<i class="fab fa-imdb text-gold"></i> ${tmdbData.rating}`;
              if (tmdbData.releaseYear) {
                releaseYear = tmdbData.releaseYear;
                document.querySelector('.modal-year').innerHTML = tmdbData.releaseYear;
              }
              document.getElementById('tmdb-search-container').style.display = 'none';
            } else {
              alert("Leider nichts gefunden. Bitte versuche den Titel noch weiter zu vereinfachen.");
            }
          }
        });
        document.getElementById('modal-trailer-btn')?.addEventListener('click', async () => {
          const btn = document.getElementById('modal-trailer-btn');
          btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
          const trailerKey = await this.fetchTMDBTrailer(title, 'series', releaseYear);
          btn.innerHTML = '<i class="fab fa-youtube"></i>';
          
          if (trailerKey) {
            const trailerContainer = document.getElementById('trailer-video-container');
            trailerContainer.innerHTML = `<iframe width="100%" height="100%" style="position:absolute;top:0;left:0;" src="https://www.youtube-nocookie.com/embed/${trailerKey}?controls=1&rel=0" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
            document.getElementById('trailer-modal').classList.remove('hidden');
            const extBtn = document.getElementById('trailer-external-btn');
            if (extBtn) {
              extBtn.onclick = () => {
                if (window.electronAPI && window.electronAPI.openExternal) {
                  window.electronAPI.openExternal(`https://www.youtube.com/watch?v=${trailerKey}`);
                }
              };
            }
          } else {
            alert("Leider konnte kein Trailer gefunden werden.");
          }
        });
      }
    } catch (err) {
      console.error('Failed to load detail modal:', err);
      inner.innerHTML = `
        <div class="modal-error">
          <i class="fas fa-exclamation-triangle"></i>
          <h3>Ladefehler</h3>
          <p>Die Details konnten vom IPTV-Server nicht geladen werden. Bitte versuche es erneut.</p>
          <button onclick="document.getElementById('netflix-detail-modal').classList.add('hidden')">Schließen</button>
        </div>
      `;
    }
  }

  /**
   * --- 6. SETTINGS PAGE ---
   */
  async renderSettingsPage(activeTabId = 'tab-account') {
    const content = document.getElementById('main-content');
    
    // Fetch settings and subscription metadata
    const serverUrl = await window.db.getSetting('serverUrl') || '';
    const username = await window.db.getSetting('username') || '';
    const password = await window.db.getSetting('password') || '';
    const corsProxy = await window.db.getSetting('corsProxy') || 'https://corsproxy.io/?';
    const updateInterval = await window.db.getSetting('updateInterval') || '24';
    const lastSync = await window.db.getSetting('lastSync') || null;
    const userInfo = await window.db.getSetting('userInfo') || null;
    const serverInfo = await window.db.getSetting('serverInfo') || null;
    const tmdbApiKey = await window.db.getSetting('tmdbApiKey') || '';
    const appTheme = await window.db.getSetting('appTheme') || '#e50914';
    const autoLogin = localStorage.getItem('autoLoginEnabled') !== 'false';
    const dedupEnabled = (await window.db.getSetting('dedupEnabled')) ?? true;
    const dedupLangs = await window.db.getSetting('dedupLangs') || 'DE, EN';
    const dedup4k = (await window.db.getSetting('dedup4k')) ?? true;
    const dedupAudio = (await window.db.getSetting('dedupAudio')) ?? true;
    const statsCodec = (await window.db.getSetting('statsCodec')) ?? true;
    const statsFps = (await window.db.getSetting('statsFps')) ?? true;
    const statsBitrate = (await window.db.getSetting('statsBitrate')) ?? true;
    const statsHdr = (await window.db.getSetting('statsHdr')) ?? true;
    const statsPing = (await window.db.getSetting('statsPing')) ?? true;
    const discordEnabled = (await window.db.getSetting('discordEnabled')) ?? false;
    const debugMode = (await window.db.getSetting('debugMode')) ?? false;

    let expiryString = 'Unbegrenzt';
    let subStatus = 'Aktiv';
    let subStatusClass = 'status-active';

    if (userInfo && userInfo.exp_date) {
      const expDateVal = userInfo.exp_date;
      if (expDateVal && expDateVal !== '0' && expDateVal !== 'null' && expDateVal !== 'Unlimited') {
        const expDate = new Date(parseInt(expDateVal) * 1000);
        expiryString = expDate.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
        
        if (expDate.getTime() < Date.now()) {
          subStatus = 'Abgelaufen';
          subStatusClass = 'status-expired';
        }
      }
    }

    const lastSyncString = lastSync 
      ? new Date(lastSync).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) 
      : 'Nie';

    content.innerHTML = `
      <div class="settings-container">
        <h1>Einstellungen</h1>
        
        <!-- Account Info Row -->
        <div class="settings-card account-summary-card">
          <h2><i class="fas fa-user-circle"></i> Abonnement & Status</h2>
          <div class="account-details-grid">
            <div class="acc-detail-item">
              <span class="detail-label">Benutzername:</span>
              <span class="detail-value">${username || 'Nicht eingeloggt'}</span>
            </div>
            <div class="acc-detail-item">
              <span class="detail-label">Status:</span>
              <span class="detail-value ${subStatusClass}">${subStatus}</span>
            </div>
            <div class="acc-detail-item">
              <span class="detail-label">Ablaufdatum:</span>
              <span class="detail-value text-red font-bold">${expiryString}</span>
            </div>
            <div class="acc-detail-item">
              <span class="detail-label">Server-Version:</span>
              <span class="detail-value">${(serverInfo && serverInfo.version) || 'N/A'}</span>
            </div>
          </div>
        </div>

        <div class="settings-tabs">
          <button class="settings-tab-btn ${activeTabId === 'tab-account' ? 'active' : ''}" data-tab="tab-account"><i class="fas fa-user-circle"></i> Konto & Server</button>
          <button class="settings-tab-btn ${activeTabId === 'tab-general' ? 'active' : ''}" data-tab="tab-general"><i class="fas fa-sliders-h"></i> Allgemein</button>
          <button class="settings-tab-btn ${activeTabId === 'tab-cloud' ? 'active' : ''}" data-tab="tab-cloud"><i class="fas fa-cloud"></i> Cloud Sync</button>
          <button class="settings-tab-btn ${activeTabId === 'tab-advanced' ? 'active' : ''}" data-tab="tab-advanced"><i class="fas fa-tools"></i> Erweitert</button>
        </div>

        <form id="settings-form" class="settings-form">
          <!-- TAB: KONTO & SERVER -->
          <div id="tab-account" class="settings-tab-content settings-card" style="display: ${activeTabId === 'tab-account' ? 'block' : 'none'};">
            <h2><i class="fas fa-server"></i> Server-Verbindung</h2>
            <div class="form-group">
              <label for="settings-server">Server URL</label>
              <input type="url" id="settings-server" value="${serverUrl}" required placeholder="http://beispiel.com:8080">
            </div>
            <div class="form-group">
              <label for="settings-user">Benutzername</label>
              <input type="text" id="settings-user" value="${username}" required>
            </div>
            <div class="form-group">
              <label for="settings-pass">Passwort</label>
              <input type="password" id="settings-pass" value="${password}" required>
            </div>
          </div>

          <!-- TAB: CLOUD SYNC -->
          <div id="tab-cloud" class="settings-tab-content settings-card" style="display: ${activeTabId === 'tab-cloud' ? 'block' : 'none'};">
            <h2><i class="fas fa-cloud"></i> Cloud Synchronisation</h2>
            <div style="margin-top: 15px; background: rgba(255,255,255,0.05); padding: 20px; border-radius: 8px;">
              ${window.cloudSync && window.cloudSync.isLoggedIn() ? `
                <p style="color: #4CAF50; font-weight: bold;"><i class="fas fa-check-circle"></i> Verbunden</p>
                <p>Eingeloggt als: <strong>${window.cloudSync.user.email}</strong></p>
                <p style="font-size: 13px; color: var(--color-text-muted); margin-bottom: 20px;">Deine Profile, Favoriten und Watch-History werden automatisch mit der Cloud synchronisiert.</p>
                <div style="display: flex; flex-direction: column; gap: 10px;">
                  <button type="button" id="btn-cloud-force-push" class="btn-primary" style="width: 100%;"><i class="fas fa-upload"></i> Lokale Daten in die Cloud erzwingen</button>
                  <button type="button" id="btn-cloud-logout" class="btn-secondary" style="width: 100%; background: rgba(255,75,75,0.1); color: #ff4b4b; border-color: rgba(255,75,75,0.3);"><i class="fas fa-sign-out-alt"></i> Ausloggen & Lokal fortfahren</button>
                </div>
              ` : `
                <p style="color: var(--color-text-muted);"><i class="fas fa-exclamation-triangle"></i> Nicht verbunden</p>
                <p style="font-size: 13px; color: var(--color-text-muted); margin-bottom: 20px;">Du nutzt die App derzeit nur lokal. Logge dich ein, um Cloud Sync zu aktivieren.</p>
                <button type="button" id="btn-cloud-relogin" class="btn-primary">Jetzt einloggen</button>
              `}
            </div>
          </div>

          <!-- TAB: ALLGEMEIN -->
          <div id="tab-general" class="settings-tab-content settings-card" style="display: ${activeTabId === 'tab-general' ? 'block' : 'none'};">
            <h2><i class="fas fa-paint-brush"></i> Personalisierung</h2>
            <div class="form-group" style="margin-top: 20px;">
              <label for="settings-lang" data-i18n="settingsLang">Sprache / Language</label>
              <select id="settings-lang" class="styled-select w-100">
                <option value="de" ${window.i18n.currentLang === 'de' ? 'selected' : ''}>Deutsch</option>
                <option value="en" ${window.i18n.currentLang === 'en' ? 'selected' : ''}>English</option>
              </select>
            </div>
            
            <div class="form-group" style="margin-top: 20px;">
              <label for="settings-theme" data-i18n="settingsTheme">Akzentfarbe</label>
              <select id="settings-theme" class="styled-select w-100">
                <option value="#e50914" ${appTheme === '#e50914' ? 'selected' : ''}>Netflix Red</option>
                <option value="#00A8E1" ${appTheme === '#00A8E1' ? 'selected' : ''}>Prime Blue</option>
                <option value="#5800D6" ${appTheme === '#5800D6' ? 'selected' : ''}>Max Purple</option>
                <option value="#1ce783" ${appTheme === '#1ce783' ? 'selected' : ''}>Hulu Green</option>
                <option value="#ffb400" ${appTheme === '#ffb400' ? 'selected' : ''}>Gold</option>
              </select>
            </div>
            
            <div class="form-group" style="margin-top: 20px;">
              <label>Download-Ordner</label>
              <div style="display:flex; gap: 10px; align-items:center;">
                <input type="text" id="settings-download-dir" value="${await window.db.getSetting('downloadDir') || ''}" readonly placeholder="Standard-Ordner (Downloads)" style="flex:1;">
                <button type="button" id="btn-select-dir" style="background:#333; color:white; border:1px solid #555; padding:8px 12px; border-radius:4px; cursor:pointer;"><i class="fas fa-folder-open"></i> Ändern</button>
              </div>
            </div>

            <h2 style="margin-top: 30px;"><i class="fas fa-sync-alt"></i> Playlist & Aktualisierung</h2>
            <div class="sync-status-box">
              <div class="sync-time">
                <span>Letzter Sync:</span>
                <strong>${lastSyncString}</strong>
              </div>
              
              <div class="form-group mt-3">
                <label for="settings-interval">Automatisches Update-Intervall</label>
                <select id="settings-interval" class="styled-select w-100">
                  <option value="manual" ${updateInterval === 'manual' ? 'selected' : ''}>Manuell</option>
                  <option value="6" ${updateInterval === '6' ? 'selected' : ''}>Alle 6 Stunden</option>
                  <option value="12" ${updateInterval === '12' ? 'selected' : ''}>Alle 12 Stunden</option>
                  <option value="24" ${updateInterval === '24' ? 'selected' : ''}>Alle 24 Stunden (Empfohlen)</option>
                  <option value="168" ${updateInterval === '168' ? 'selected' : ''}>Wöchentlich</option>
                </select>
                <p class="form-tip">Das Update wird im Hintergrund ausgeführt, wenn die App geöffnet ist und die Zeit abgelaufen ist.</p>
              </div>

              <!-- Sync Progress Container -->
              <div id="settings-sync-progress" class="sync-progress-container hidden">
                <div class="sync-progress-bar">
                  <div id="settings-sync-fill" class="sync-progress-fill" style="width: 0%"></div>
                </div>
                <div id="settings-sync-status" class="sync-progress-status">Synchronisiere...</div>
              </div>

              <button type="button" id="settings-sync-btn" class="btn-sync-now mb-2">
                <i class="fas fa-rotate"></i> Jetzt Synchronisieren
              </button>
              <button type="button" id="settings-cover-btn" class="btn-sync-now" style="background: #2b2b2b;">
                <i class="fas fa-search"></i> <span data-i18n="settingsCoverBtn">Fehlende Cover & Infos suchen (TMDB)</span>
              </button>
            </div>
            
            <div class="setting-row-flex mt-4" style="background: rgba(255,255,255,0.05); padding: 15px; border-radius: 8px;">
              <div>
                <label for="settings-anti-binge" style="font-weight:bold;"><i class="fas fa-bed"></i> <span data-i18n="settingsAntiBinge">"Schaust du noch?"-Abfrage</span></label>
                <p style="font-size: 12px; color: #aaa; margin: 5px 0 0 0;">Stoppt die automatische Wiedergabe nach 3 Folgen in Folge, falls du eingeschlafen bist.</p>
              </div>
              <label class="ios-switch">
                <input type="checkbox" id="settings-anti-binge" ${(await window.db.getSetting('antiBinge') ?? true) ? 'checked' : ''}>
                <span class="slider"></span>
              </label>
            </div>
            
            <div class="setting-row-flex mt-4" style="background: rgba(255,255,255,0.05); padding: 15px; border-radius: 8px;">
              <div>
                <label for="settings-autologin" style="font-weight:bold;"><i class="fas fa-sign-in-alt"></i> <span data-i18n="settingsAutoLogin">Automatisch anmelden</span></label>
                <p style="font-size: 12px; color: #aaa; margin: 5px 0 0 0;">Startet die App direkt mit dem zuletzt verwendeten Profil.</p>
              </div>
              <label class="ios-switch">
                <input type="checkbox" id="settings-autologin" ${autoLogin ? 'checked' : ''}>
                <span class="slider"></span>
              </label>
            </div>

            <div class="settings-card mt-4" style="background: rgba(255,255,255,0.05); padding: 15px; border-radius: 8px;">
              <h3 style="margin-top:0; font-size: 1.2rem;"><i class="fas fa-filter"></i> <span data-i18n="settingsDedup">Duplikate zusammenfassen</span></h3>
              <p style="font-size: 12px; color: #aaa; margin-bottom: 15px;">Fasst Filme und Serien zusammen, die mehrfach (z.B. in 4K, 1080p, DE, EN) in der Liste auftauchen und zeigt nur die beste Version an.</p>
              
              <div class="setting-row-flex mb-3">
                <label for="settings-dedup-enabled" style="font-weight:bold;">Duplikate ausblenden</label>
                <label class="ios-switch">
                  <input type="checkbox" id="settings-dedup-enabled" ${dedupEnabled ? 'checked' : ''}>
                  <span class="slider"></span>
                </label>
              </div>
              
              <div class="form-group">
                <label for="settings-dedup-langs">Bevorzugte Sprachen</label>
                <input type="text" id="settings-dedup-langs" value="${dedupLangs}" placeholder="z.B. DE, GER, EN">
                <p class="form-tip">Kommagetrennte Kürzel, die im Titel gesucht werden.</p>
              </div>
              
              <div class="setting-row-flex mb-2">
                <label for="settings-dedup-4k">Höchste Auflösung (4K/UHD) bevorzugen</label>
                <label class="ios-switch">
                  <input type="checkbox" id="settings-dedup-4k" ${dedup4k ? 'checked' : ''}>
                  <span class="slider"></span>
                </label>
              </div>
              
              <div class="setting-row-flex mb-2">
                <label for="settings-dedup-audio">Besten Ton (5.1/7.1/Atmos) bevorzugen</label>
                <label class="ios-switch">
                  <input type="checkbox" id="settings-dedup-audio" ${dedupAudio ? 'checked' : ''}>
                  <span class="slider"></span>
                </label>
              </div>
            </div>

            <div class="settings-card mt-4" style="background: rgba(255,255,255,0.05); padding: 15px; border-radius: 8px;">
              <h3 style="margin-top:0; font-size: 1.2rem;"><i class="fas fa-desktop"></i> Player Anzeige (Technik-Stats)</h3>
              <p style="font-size: 12px; color: #aaa; margin-bottom: 15px;">Wähle, welche technischen Informationen im Player oben links angezeigt werden sollen.</p>
              
              <div class="setting-row-flex mb-2">
                <label for="settings-stats-codec">Video-Encoder (z.B. H.264, HEVC)</label>
                <label class="ios-switch">
                  <input type="checkbox" id="settings-stats-codec" ${statsCodec ? 'checked' : ''}>
                  <span class="slider"></span>
                </label>
              </div>
              <div class="setting-row-flex mb-2">
                <label for="settings-stats-fps">Framerate (fps)</label>
                <label class="ios-switch">
                  <input type="checkbox" id="settings-stats-fps" ${statsFps ? 'checked' : ''}>
                  <span class="slider"></span>
                </label>
              </div>
              <div class="setting-row-flex mb-2">
                <label for="settings-stats-bitrate">Bitrate (Mbit/s)</label>
                <label class="ios-switch">
                  <input type="checkbox" id="settings-stats-bitrate" ${statsBitrate ? 'checked' : ''}>
                  <span class="slider"></span>
                </label>
              </div>
              <div class="setting-row-flex mb-2">
                <label for="settings-stats-hdr">HDR Erkennung</label>
                <label class="ios-switch">
                  <input type="checkbox" id="settings-stats-hdr" ${statsHdr ? 'checked' : ''}>
                  <span class="slider"></span>
                </label>
              </div>
              <div class="setting-row-flex mb-2">
                <label for="settings-stats-ping">Server-Latenz (Ping)</label>
                <label class="ios-switch">
                  <input type="checkbox" id="settings-stats-ping" ${statsPing ? 'checked' : ''}>
                  <span class="slider"></span>
                </label>
              </div>
            </div>

            <div class="app-reset-box mt-4">
              <h3>App zurücksetzen</h3>
              <p>Dadurch werden alle gecachten Playlists, Anmeldedaten und Lesezeichen gelöscht.</p>
              <button type="button" id="settings-reset-btn" class="btn-danger w-100"><i class="fas fa-trash-alt"></i> Alle Daten löschen</button>
            </div>

            <div class="app-reset-box mt-4" style="border-color: var(--color-primary);">
              <h3><i class="fas fa-sync-alt"></i> App Updates <span id="app-version-display" style="font-size: 0.6em; color: #888; margin-left: 10px;"></span></h3>
              <p>Überprüfe, ob eine neue Version von Aether Streaming verfügbar ist.</p>
              <button type="button" id="settings-update-btn" class="btn-primary w-100" style="margin-top: 10px;">
                <i class="fas fa-download"></i> Nach Updates suchen
              </button>
            </div>
          </div>

          <!-- TAB: ERWEITERT -->
          <div id="tab-advanced" class="settings-tab-content settings-card" style="display: ${activeTabId === 'tab-advanced' ? 'block' : 'none'};">
            <h2><i class="fas fa-cogs"></i> Erweitert</h2>
            <div class="form-group">
              <label for="settings-proxy">CORS Proxy</label>
              <select id="settings-proxy" class="styled-select w-100">
                <option value="https://corsproxy.io/?" ${corsProxy === 'https://corsproxy.io/?' ? 'selected' : ''}>corsproxy.io (Empfohlen, schnell & einfach)</option>
                <option value="https://api.allorigins.win/raw?url=" ${corsProxy === 'https://api.allorigins.win/raw?url=' ? 'selected' : ''}>allorigins.win (Backup Proxy)</option>
                <option value="direct" ${corsProxy === 'direct' ? 'selected' : ''}>Direkte Verbindung (CORS muss am Server erlaubt sein)</option>
              </select>
              <p class="form-tip">Wenn Kanäle/Details nicht laden, wähle einen anderen CORS-Proxy.</p>
            </div>
            
            <div class="setting-row-flex">
              <label for="settings-discord-enabled" style="color: white; font-weight:bold;"><i class="fab fa-discord" style="color: #5865F2;"></i> Discord Status aktivieren</label>
              <label class="ios-switch">
                <input type="checkbox" id="settings-discord-enabled" ${discordEnabled ? 'checked' : ''}>
                <span class="slider"></span>
              </label>
            </div>
            
            <div class="setting-row-flex">
              <label for="settings-debug">Debug Mode (Entwicklerkonsole anzeigen)</label>
              <label class="ios-switch">
                <input type="checkbox" id="settings-debug" ${debugMode ? 'checked' : ''}>
                <span class="slider"></span>
              </label>
            </div>
          </div>
          
          <button type="submit" class="btn-save-settings" style="margin-top: 15px;">
            <i class="fas fa-save"></i> Einstellungen Speichern
          </button>
        </form>
      </div>
    `;

    // Load App Version
    if (window.electronAPI && window.electronAPI.getVersion) {
      window.electronAPI.getVersion().then(version => {
        const vDisplay = document.getElementById('app-version-display');
        if (vDisplay) vDisplay.textContent = 'v' + version;
      });
    }

    // Auto-Updater Logic
    const updateBtn = document.getElementById('settings-update-btn');
    if (updateBtn && window.electronAPI && window.electronAPI.checkForUpdates) {
      updateBtn.addEventListener('click', () => {
        updateBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Suche nach Updates...';
        updateBtn.disabled = true;
        window.electronAPI.checkForUpdates().catch(err => {
          console.error("Update Error:", err);
          updateBtn.innerHTML = '<i class="fas fa-download"></i> Nach Updates suchen';
          updateBtn.disabled = false;
        });
      });
    }

    // Connect Settings Form Submission
    document.getElementById('settings-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const server = document.getElementById('settings-server').value.trim();
      const user = document.getElementById('settings-user').value.trim();
      const pass = document.getElementById('settings-pass').value.trim();
      const proxy = document.getElementById('settings-proxy').value;
      const themeColor = document.getElementById('settings-theme').value;
      const debugMode = document.getElementById('settings-debug').checked;
      const downloadDir = document.getElementById('settings-download-dir').value;
      const discordEnabled = document.getElementById('settings-discord-enabled').checked;
      const antiBinge = document.getElementById('settings-anti-binge').checked;
      const autologin = document.getElementById('settings-autologin').checked;
      const dedupEnabled = document.getElementById('settings-dedup-enabled').checked;
      const dedupLangs = document.getElementById('settings-dedup-langs').value;
      const dedup4k = document.getElementById('settings-dedup-4k').checked;
      const dedupAudio = document.getElementById('settings-dedup-audio').checked;
      const statsCodec = document.getElementById('settings-stats-codec').checked;
      const statsFps = document.getElementById('settings-stats-fps').checked;
      const statsBitrate = document.getElementById('settings-stats-bitrate').checked;
      const statsHdr = document.getElementById('settings-stats-hdr').checked;
      const statsPing = document.getElementById('settings-stats-ping').checked;

      localStorage.setItem('autoLoginEnabled', autologin);

      await window.db.saveSetting('serverUrl', server);
      await window.db.saveSetting('username', user);
      await window.db.saveSetting('password', pass);
      await window.db.saveSetting('corsProxy', proxy);
      await window.db.saveSetting('appTheme', themeColor);
      await window.db.saveSetting('debugMode', debugMode);
      await window.db.saveSetting('downloadDir', downloadDir);
      await window.db.saveSetting('discordEnabled', discordEnabled);
      await window.db.saveSetting('antiBinge', antiBinge);
      await window.db.saveSetting('dedupEnabled', dedupEnabled);
      await window.db.saveSetting('dedupLangs', dedupLangs);
      await window.db.saveSetting('dedup4k', dedup4k);
      await window.db.saveSetting('dedupAudio', dedupAudio);
      await window.db.saveSetting('statsCodec', statsCodec);
      await window.db.saveSetting('statsFps', statsFps);
      await window.db.saveSetting('statsBitrate', statsBitrate);
      await window.db.saveSetting('statsHdr', statsHdr);
      await window.db.saveSetting('statsPing', statsPing);

      // Reload deduplication settings into memory so they take effect immediately
      await this.loadDeduplicationSettings();

      // Clear the deduplication cache so it recomputes with new settings
      this.dedupCache = { movies: null, series: null };

      // Update CSS variables
      document.documentElement.style.setProperty('--color-primary', themeColor);
      if (themeColor === '#e50914') {
        document.documentElement.style.setProperty('--color-primary-hover', '#f40612');
      } else {
        document.documentElement.style.setProperty('--color-primary-hover', themeColor); // fallback
      }

      if (debugMode && window.electronAPI && window.electronAPI.openDevTools) {
        window.electronAPI.openDevTools();
      } else if (!debugMode && window.electronAPI && window.electronAPI.closeDevTools) {
        window.electronAPI.closeDevTools();
      }
      
      // Configure API client immediately
      window.api.configure(server, user, pass, proxy);

      this.showToast('Verbindungsdaten gespeichert!');
      const currentTabBtn = document.querySelector('.settings-tab-btn.active');
      const currentTab = currentTabBtn ? currentTabBtn.dataset.tab : 'tab-account';
      this.renderSettingsPage(currentTab); // refresh view and stay on tab
      
      // Update expiry badge in sidebar
      window.dispatchEvent(new CustomEvent('settings-saved'));
    });

    // Cloud Button Listeners
    const btnLogout = document.getElementById('btn-cloud-logout');
    if (btnLogout) {
      btnLogout.addEventListener('click', async () => {
        if(confirm('Möchtest du dich wirklich ausloggen? Cloud Sync wird pausiert.')) {
          await window.cloudSync.logout();
          this.renderSettingsPage('tab-cloud');
        }
      });
    }

    const btnForcePush = document.getElementById('btn-cloud-force-push');
    if (btnForcePush) {
      btnForcePush.addEventListener('click', async () => {
        if(confirm('Möchtest du wirklich alle lokalen Profile, Favoriten und Verläufe in die Cloud hochladen?')) {
          btnForcePush.disabled = true;
          await window.cloudSync.pushAllLocalDataToCloud(window.db, (pct) => {
            btnForcePush.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Lädt hoch... ${pct}`;
          });
          btnForcePush.innerHTML = '<i class="fas fa-check"></i> Erfolgreich hochgeladen!';
          setTimeout(() => { this.renderSettingsPage('tab-cloud'); }, 2000);
        }
      });
    }

    const btnRelogin = document.getElementById('btn-cloud-relogin');
    if (btnRelogin) {
      btnRelogin.addEventListener('click', () => {
        localStorage.removeItem('skipCloudSync');
        window.location.reload(); // Reload app to show login screen
      });
    }

    // Tab Switching Logic
    const tabBtns = document.querySelectorAll('.settings-tab-btn');
    const tabContents = document.querySelectorAll('.settings-tab-content');
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        tabContents.forEach(c => c.style.display = 'none');
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).style.display = 'block';
      });
    });

    // Select Directory button
    document.getElementById('btn-select-dir').addEventListener('click', async () => {
      if (window.electronAPI && window.electronAPI.selectDirectory) {
        const path = await window.electronAPI.selectDirectory();
        if (path) {
          document.getElementById('settings-download-dir').value = path;
        }
      } else {
        alert('Nicht verfügbar in dieser Umgebung.');
      }
    });

    // Connect Sync Interval Selector
    document.getElementById('settings-interval').addEventListener('change', async (e) => {
      const val = e.target.value;
      await window.db.saveSetting('updateInterval', val);
      this.showToast('Update-Intervall aktualisiert!');
    });

    // Connect Sync Button
    const syncBtn = document.getElementById('settings-sync-btn');
    const syncProgress = document.getElementById('settings-sync-progress');
    const syncFill = document.getElementById('settings-sync-fill');
    const syncStatus = document.getElementById('settings-sync-status');

    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      syncProgress.classList.remove('hidden');
      
      const success = await window.api.syncPlaylist((message, pct) => {
        syncStatus.textContent = message;
        if (pct >= 0) {
          syncFill.style.width = `${pct}%`;
        } else {
          syncFill.classList.add('error');
        }
      });

      syncBtn.disabled = false;
      if (success.success) {
        this.showToast('Synchronisierung erfolgreich!');
        await this.loadPlaylists(); // update local vars
        if (this.activeTab === 'home') {
          window.dispatchEvent(new CustomEvent('playlist-synced'));
        }
        // Run cover enrichment automatically after sync
        this.startCoverEnrichment();
      } else {
        alert(`Synchronisierungsfehler: ${success.error || 'Verbindung fehlgeschlagen'}`);
      }
    });

    const coverBtn = document.getElementById('settings-cover-btn');
    if (coverBtn) {
      coverBtn.addEventListener('click', () => {
        coverBtn.disabled = true;
        const originalText = coverBtn.innerHTML;
        coverBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Suche läuft (im Hintergrund)...';
        this.showToast('Cover-Suche im Hintergrund gestartet...');
        this.startCoverEnrichment().finally(() => {
          coverBtn.disabled = false;
          coverBtn.innerHTML = originalText;
          this.showToast('Cover-Suche abgeschlossen!');
          if (this.activeTab === 'home') this.renderHomePage();
        });
      });
    }

    // Reset button
    document.getElementById('settings-lang').addEventListener('change', (e) => {
      window.i18n.setLang(e.target.value);
    });

    document.getElementById('settings-reset-btn').addEventListener('click', async () => {
      if (confirm('Bist du sicher, dass du alle Daten und Caches löschen möchtest? Dies loggt dich ebenfalls aus.')) {
        await window.db.clearStore('settings');
        await window.db.clearStore('progress');
        await window.db.clearStore('live_categories');
        await window.db.clearStore('movie_categories');
        await window.db.clearStore('series_categories');
        await window.db.clearStore('live_streams');
        await window.db.clearStore('movies');
        await window.db.clearStore('series');
        
        this.showToast('Alle Daten gelöscht. App wird neu geladen...');
        setTimeout(() => {
          window.location.reload();
        }, 1500);
      }
    });
  }

  async renderSearchResults(query) {
    const overlay = document.getElementById('global-search-overlay');
    if (!overlay) return;
    
    overlay.classList.remove('hidden');

    const liveSec = document.getElementById('search-results-live');
    const moviesSec = document.getElementById('search-results-movies');
    const seriesSec = document.getElementById('search-results-series');
    const noResults = document.getElementById('search-no-results');

    const gridLive = document.getElementById('search-grid-live');
    const gridMovies = document.getElementById('search-grid-movies');
    const gridSeries = document.getElementById('search-grid-series');

    // Reset view
    gridLive.innerHTML = ''; gridMovies.innerHTML = ''; gridSeries.innerHTML = '';
    liveSec.style.display = 'none'; moviesSec.style.display = 'none'; seriesSec.style.display = 'none';
    noResults.classList.add('hidden');

    const q = query.toLowerCase();

    // The user wants ALL versions to show up in search, so we use window.db.getAll instead of getDeduplicatedMedia
    const [allMovies, allSeries, allLive] = await Promise.all([
      window.db.getAll('movies'),
      window.db.getAll('series'),
      window.db.getAll('live_streams')
    ]);

    const movies = (allMovies || []).filter(m => this.fuzzyMatch(q, m.name || ''));
    const series = (allSeries || []).filter(s => this.fuzzyMatch(q, s.name || ''));
    const live = (allLive || []).filter(c => this.fuzzyMatch(q, c.name || ''));

    let foundSomething = false;

    if (live.length > 0) {
      foundSomething = true;
      liveSec.style.display = 'block';
      const liveSubset = live.slice(0, 30);
      
      gridLive.innerHTML = liveSubset.map(ch => {
        const initials = (ch.name || '?').replace(/[^A-Z0-9]/gi, '').substring(0, 3).toUpperCase() || '?';
        const isFav = this.isFavorite(ch.stream_id, 'live');
        return `
          <div class="live-channel-card search-live-card" data-id="${ch.stream_id}" style="width:100%;">
            <div class="channel-logo-wrapper">
              <img src="${ch.stream_icon || ''}" alt="" loading="lazy" onerror="this.onerror=null;this.style.display='none';this.nextElementSibling.style.display='flex'">
              <div class="channel-logo-fallback" style="display:none">${initials}</div>
            </div>
            <div class="channel-details">
              <div class="channel-name" title="${ch.name}">${ch.name}</div>
              <div class="channel-epg" style="margin-top: 4px; font-size: 0.75rem; color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Lade...</div>
              <div class="channel-epg-progress" style="display:none; height: 3px; background: rgba(255,255,255,0.1); margin-top: 6px; border-radius: 2px; overflow: hidden;">
                <div class="channel-epg-bar" style="height: 100%; background: var(--color-primary); width: 0%; transition: width 0.3s ease;"></div>
              </div>
            </div>
            <button class="channel-fav-btn ${isFav ? 'active' : ''}" title="Favorit">
              <i class="fas fa-heart"></i>
            </button>
          </div>`;
      }).join('');

      gridLive.querySelectorAll('.search-live-card').forEach(card => {
        const id = card.dataset.id;
        const ch = liveSubset.find(c => String(c.stream_id) === id);
        card.addEventListener('click', (e) => {
          if (e.target.closest('.channel-fav-btn')) return;
          this.showLiveEPGModal(ch);
        });
        card.querySelector('.channel-fav-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleFavorite(ch.stream_id, 'live');
        });
      });
    }

    if (movies.length > 0) {
      foundSomething = true;
      moviesSec.style.display = 'block';
      const displayList = movies.slice(0, 30).map(m => ({...m, type: 'movie', id: m.stream_id, cover: m.stream_icon}));
      gridMovies.innerHTML = displayList.map(item => this.createCardHTML(item)).join('');
      this.hookCardEvents(gridMovies);
    }

    if (series.length > 0) {
      foundSomething = true;
      seriesSec.style.display = 'block';
      const displayList = series.slice(0, 30).map(s => ({...s, type: 'series', id: s.series_id}));
      gridSeries.innerHTML = displayList.map(item => this.createCardHTML(item)).join('');
      this.hookCardEvents(gridSeries);
    }

    if (liveSubset.length > 0) {
      this.observeEPGCards(gridLive);
    }

    if (!foundSomething) {
      noResults.classList.remove('hidden');
    }
  }

  async renderExplorePage() {
    this.activeTab = 'explore';
    const content = document.getElementById('main-content');
    
    content.innerHTML = `
      <div class="page-header" style="padding: 40px 40px 20px 40px; margin-bottom: 0;">
        <h1 style="font-size: 2.5rem; font-weight: 800; text-shadow: 2px 2px 4px rgba(0,0,0,0.5); margin: 0;"><i class="fas fa-compass" style="color: var(--color-primary);"></i> Entdecken</h1>
      </div>
      <div class="explore-filters">
        <select id="explore-type">
          <option value="all">Alle (Filme & Serien)</option>
          <option value="movie">Nur Filme</option>
          <option value="series">Nur Serien</option>
        </select>
        <select id="explore-sort">
          <option value="date-desc">Kürzlich hinzugefügt</option>
          <option value="rating-desc">Beste Bewertung</option>
          <option value="name-asc">A-Z</option>
          <option value="name-desc">Z-A</option>
        </select>
      </div>
      <div id="explore-results-container" class="explore-grid">
        <div class="modal-loading-spinner" style="grid-column: 1 / -1; margin-top: 50px;">
          <div class="spinner"></div>
          <p>Lade Medien...</p>
        </div>
      </div>
    `;

    const typeSelect = document.getElementById('explore-type');
    const sortSelect = document.getElementById('explore-sort');

    const updateResults = async () => {
      const container = document.getElementById('explore-results-container');
      container.innerHTML = '<div class="modal-loading-spinner" style="grid-column: 1 / -1; margin-top: 50px;"><div class="spinner"></div></div>';
      
      const typeFilter = typeSelect.value;
      const sortFilter = sortSelect.value;
      
      let items = [];
      if (typeFilter === 'movie' || typeFilter === 'all') {
        const movies = await this.getDeduplicatedMedia('movies') || [];
        items = items.concat(movies.map(m => ({
          ...m,
          type: 'movie',
          id: m.stream_id,
          cover: m.stream_icon
        })));
      }
      if (typeFilter === 'series' || typeFilter === 'all') {
        const series = await this.getDeduplicatedMedia('series') || [];
        items = items.concat(series.map(s => ({
          ...s,
          type: 'series',
          id: s.series_id,
          cover: s.cover
        })));
      }
      if (typeFilter === 'all' && this.dedupConfig && this.dedupConfig.enabled) {
        const uniqueItems = [];
        const seenTitles = new Set();
        for (const item of items) {
          const clean = this.cleanTitleForTMDB(item.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          if (clean && !seenTitles.has(clean)) {
            seenTitles.add(clean);
            uniqueItems.push(item);
          }
        }
        items = uniqueItems;
      }
      
      // Sorting
      items.sort((a, b) => {
        if (sortFilter === 'name-asc') return (a.name || '').localeCompare(b.name || '');
        if (sortFilter === 'name-desc') return (b.name || '').localeCompare(a.name || '');
        if (sortFilter === 'rating-desc') {
          const ratingA = parseFloat(a.rating) || 0;
          const ratingB = parseFloat(b.rating) || 0;
          return ratingB - ratingA;
        }
        if (sortFilter === 'date-desc') {
          const dateA = parseInt(a.added || a.last_modified) || 0;
          const dateB = parseInt(b.added || b.last_modified) || 0;
          return dateB - dateA;
        }
        return 0;
      });
      
      if (items.length === 0) {
        container.innerHTML = '<div style="grid-column: 1 / -1; color: #888; text-align: center; margin-top: 50px; font-size: 1.2rem;">Keine Medien gefunden.</div>';
        return;
      }
      
      this._exploreItems = items;
      this._exploreStart = 0;
      this.renderExploreBatch();
    };

    this.renderExploreBatch = () => {
      const container = document.getElementById('explore-results-container');
      if (!container) return;
      
      const items = this._exploreItems || [];
      const startFrom = this._exploreStart || 0;
      const pageSize = 50;
      
      const page = items.slice(startFrom, startFrom + pageSize);
      const hasMore = items.length > startFrom + pageSize;
      
      const cardsHtml = page.map(item => this.createCardHTML(item)).join('');
      
      if (startFrom === 0) {
        container.innerHTML = cardsHtml;
      } else {
        const oldBtn = container.querySelector('.load-more-btn');
        if (oldBtn) oldBtn.remove();
        container.insertAdjacentHTML('beforeend', cardsHtml);
      }
      
      if (hasMore) {
        const loadMoreBtn = document.createElement('button');
        loadMoreBtn.className = 'load-more-btn';
        loadMoreBtn.innerHTML = `<i class="fas fa-chevron-down"></i> Mehr laden`;
        loadMoreBtn.addEventListener('click', () => {
          this._exploreStart += pageSize;
          this.renderExploreBatch();
        });
        container.appendChild(loadMoreBtn);
      }
      
      this.hookCardEvents(container);
    };

    typeSelect.addEventListener('change', updateResults);
    sortSelect.addEventListener('change', updateResults);

    // Initial load
    updateResults();
  }

  async fetchTop10Trending(type = 'movie') {
    try {
      const apiKey = '627cd656ff20a065b19134ace6a0ab51';
      const url = `https://api.themoviedb.org/3/trending/${type}/day?api_key=${apiKey}&language=de-DE`;
      const response = await fetch(url);
      if (!response.ok) return [];
      const data = await response.json();
      return data.results || [];
    } catch(e) {
      console.error(`Failed to fetch Top 10 ${type}`, e);
      return [];
    }
  }

  async renderTop10Row() {
    const wrapper = document.getElementById('top10-wrapper');
    if (!wrapper) return;

    // Fetch trending from TMDB
    const trendingMovies = await this.fetchTop10Trending('movie');
    const trendingSeries = await this.fetchTop10Trending('tv');

    // Fetch local items to cross-reference
    const allMovies = await this.getDeduplicatedMedia('movies') || [];
    const allSeries = await this.getDeduplicatedMedia('series') || [];
    
    const top10Movies = [];
    const top10Series = [];
    
    // Find up to 10 trending movies
    for (const tmdbMovie of trendingMovies) {
      if (top10Movies.length >= 10) break;
      const tmdbTitle = tmdbMovie.title || tmdbMovie.name;
      if (!tmdbTitle) continue;
      const match = allMovies.find(m => {
        const cleanLocal = this.cleanTitleForTMDB(m.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const cleanTmdb = tmdbTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
        return cleanLocal === cleanTmdb || (cleanLocal.length > 4 && cleanTmdb.includes(cleanLocal)) || (cleanTmdb.length > 4 && cleanLocal.includes(cleanTmdb));
      });
      if (match) {
        top10Movies.push({ ...match, type: 'movie', id: match.stream_id, cover: match.stream_icon });
      }
    }

    // Find up to 10 trending series
    for (const tmdbShow of trendingSeries) {
      if (top10Series.length >= 10) break;
      const tmdbTitle = tmdbShow.title || tmdbShow.name;
      if (!tmdbTitle) continue;
      const match = allSeries.find(s => {
        const cleanLocal = this.cleanTitleForTMDB(s.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const cleanTmdb = tmdbTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
        return cleanLocal === cleanTmdb || (cleanLocal.length > 4 && cleanTmdb.includes(cleanLocal)) || (cleanTmdb.length > 4 && cleanLocal.includes(cleanTmdb));
      });
      if (match) {
        top10Series.push({ ...match, type: 'series', id: match.series_id, cover: match.cover });
      }
    }

    let html = '';

    if (top10Movies.length > 0) {
      html += `
        <div class="netflix-row" style="margin-bottom: 20px;">
          <h2 class="row-header">${window.i18n.t('top10Movies')}</h2>
          <div class="carousel-container">
            <button class="carousel-arrow left"><i class="fas fa-chevron-left"></i></button>
            <div class="carousel-scroll top10-row">
              ${top10Movies.map((item, index) => `
                <div class="top10-item">
                  <div class="top10-number">${index + 1}</div>
                  ${this.createCardHTML(item)}
                </div>
              `).join('')}
            </div>
            <button class="carousel-arrow right"><i class="fas fa-chevron-right"></i></button>
          </div>
        </div>
      `;
    }

    if (top10Series.length > 0) {
      html += `
        <div class="netflix-row" style="margin-bottom: 40px;">
          <h2 class="row-header">${window.i18n.t('top10Series')}</h2>
          <div class="carousel-container">
            <button class="carousel-arrow left"><i class="fas fa-chevron-left"></i></button>
            <div class="carousel-scroll top10-row">
              ${top10Series.map((item, index) => `
                <div class="top10-item">
                  <div class="top10-number">${index + 1}</div>
                  ${this.createCardHTML(item)}
                </div>
              `).join('')}
            </div>
            <button class="carousel-arrow right"><i class="fas fa-chevron-right"></i></button>
          </div>
        </div>
      `;
    }

    if (html !== '') {
      wrapper.innerHTML = html;
      wrapper.querySelectorAll('.netflix-row').forEach(row => {
        this.initCarouselScrolling(row);
        this.hookCardEvents(row);
      });
    }
  }

  fuzzyMatch(search, text) {
    if (!search) return true;
    if (!text) return false;
    search = search.toLowerCase();
    text = text.toLowerCase();
    
    // Direct match (fastest)
    if (text.includes(search)) return true;
    
    // Greedy subsequence match (e.g. "spdrmn" matches "Spider-Man")
    let searchIdx = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === search[searchIdx]) {
        searchIdx++;
      }
      if (searchIdx === search.length) {
        return true;
      }
    }
    return false;
  }

  // --- Deduplication Logic ---

  async loadDeduplicationSettings() {
    this.dedupConfig = {
      enabled: (await window.db.getSetting('dedupEnabled')) ?? true,
      langs: (await window.db.getSetting('dedupLangs') || 'DE, EN').toLowerCase().split(',').map(s => s.trim()).filter(Boolean),
      prefer4k: (await window.db.getSetting('dedup4k')) ?? true,
      preferAudio: (await window.db.getSetting('dedupAudio')) ?? true
    };
  }

  async getDeduplicatedMedia(type) {
    if (!this.dedupCache) this.dedupCache = { movies: null, series: null };
    
    if (this.dedupCache[type]) {
      return this.dedupCache[type];
    }

    const items = await window.db.getAll(type) || [];
    
    if (!this.dedupConfig || !this.dedupConfig.enabled) {
      this.dedupCache[type] = items;
      return items;
    }

    const groups = new Map();

    for (const item of items) {
      const originalTitle = item.name || '';
      let cleanTitle = this.cleanTitleForTMDB(originalTitle).toLowerCase().replace(/[^a-z0-9]/g, '');
      
      if (!cleanTitle && !item.tmdb_id) continue;

      const groupKey = item.tmdb_id ? `tmdb_${item.tmdb_id}` : cleanTitle;

      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey).push(item);
    }

    const deduplicated = [];

    for (const [cleanTitle, duplicates] of groups.entries()) {
      if (duplicates.length === 1) {
        deduplicated.push(duplicates[0]);
        continue;
      }

      let bestItem = duplicates[0];
      let bestScore = -1;

      for (const item of duplicates) {
        let score = 0;
        const titleLower = (item.name || '').toLowerCase();

        for (let i = 0; i < this.dedupConfig.langs.length; i++) {
          const lang = this.dedupConfig.langs[i];
          if (titleLower.includes(`[${lang}]`) || titleLower.includes(`(${lang})`) || titleLower.includes(lang === 'de' ? 'ger' : lang)) {
            score += Math.max(20 - i, 10);
            break;
          }
        }

        if (this.dedupConfig.prefer4k && (titleLower.includes('4k') || titleLower.includes('uhd') || titleLower.includes('2160p'))) {
          score += 15;
        } else if (titleLower.includes('1080p') || titleLower.includes('fhd')) {
          score += 5;
        } else if (titleLower.includes('720p') || titleLower.includes('hd')) {
          score += 2;
        }

        if (this.dedupConfig.preferAudio) {
          if (titleLower.includes('atmos') || titleLower.includes('7.1')) {
            score += 10;
          } else if (titleLower.includes('5.1')) {
            score += 8;
          }
        }

        if (score > bestScore) {
          bestScore = score;
          bestItem = item;
        }
      }

      deduplicated.push(bestItem);
    }

    this.dedupCache[type] = deduplicated;
    return deduplicated;
  }
}

window.ui = new NetflixUI();
