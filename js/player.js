/**
 * Custom Video Player Wrapper using Hls.js.
 * Handles custom UI controls, audio track selection, subtitle selection, and watch progress syncing.
 */
class NetflixPlayer {
  constructor() {
    this.playerContainer = null;
    this.video = null;
    this.hls = null;
    this.currentStream = null; // { id, type, title, subtitle, cover, isSeries, seriesId }
    this.saveProgressInterval = null;
    this.controlsTimeout = null;
  }

  /**
   * Initializes the player DOM references and global events.
   */
  init() {
    this.playerContainer = document.getElementById('netflix-player-container');
    this.video = document.getElementById('netflix-video');
    
    if (!this.playerContainer || !this.video) return;

    this.setupControls();
  }

  /**
   * Hooks up standard and custom control elements.
   */
  setupControls() {
    const playBtn = document.getElementById('player-play-btn');
    const skipBackBtn = document.getElementById('player-skip-back');
    const skipFwdBtn = document.getElementById('player-skip-fwd');
    const volumeBtn = document.getElementById('player-volume-btn');
    const volumeSlider = document.getElementById('player-volume-slider');
    const progressBar = document.getElementById('player-progress-bar');
    const progressFill = document.getElementById('player-progress-fill');
    const currentTimeText = document.getElementById('player-time-current');
    const totalTimeText = document.getElementById('player-time-total');
    const speedBtn = document.getElementById('player-speed-btn');
    const audioBtn = document.getElementById('player-audio-btn');
    const subtitleBtn = document.getElementById('player-subtitle-btn');
    const fullscreenBtn = document.getElementById('player-fullscreen-btn');
    const pipBtn = document.getElementById('player-pip-btn');
    const vlcBtn = document.getElementById('player-vlc-btn');
    const backBtn = document.getElementById('player-back-btn');
    
    // Toggle play/pause
    const togglePlay = () => {
      if (this.video.paused) {
        this.video.play().catch(e => console.warn('Wiedergabefehler:', e));
      } else {
        this.video.pause();
      }
    };
    
    this.video.addEventListener('click', togglePlay);
    playBtn.addEventListener('click', togglePlay);

    this.video.addEventListener('play', () => {
      playBtn.innerHTML = '<i class="fas fa-pause"></i>';
      this.playerContainer.classList.remove('paused');
      this.updateDiscordPresence(false);
    });

    this.video.addEventListener('pause', () => {
      playBtn.innerHTML = '<i class="fas fa-play"></i>';
      this.playerContainer.classList.add('paused');
      this.updateDiscordPresence(true);
    });
    
    this.video.addEventListener('seeked', () => {
      if (!this.video.paused) {
        this.updateDiscordPresence(false);
      }
    });

    // Seek Skip buttons
    skipBackBtn.addEventListener('click', () => {
      this.video.currentTime = Math.max(0, this.video.currentTime - 10);
    });
    skipFwdBtn.addEventListener('click', () => {
      this.video.currentTime = Math.min(this.video.duration || 0, this.video.currentTime + 10);
    });

    // Initialize volume from localStorage
    const savedVol  = parseFloat(localStorage.getItem('player-volume') || '1.0');
    const savedMuted = localStorage.getItem('player-muted') === 'true';

    // Sanity-check: if volume is 0 and no explicit mute by user, reset to 1
    const effectiveVol = (savedVol <= 0 && !savedMuted) ? 1.0 : Math.max(savedVol, 0);

    this.video.volume = effectiveVol;
    this.video.muted  = savedMuted;
    volumeSlider.value = effectiveVol;

    // Persist sane defaults
    localStorage.setItem('player-volume', String(effectiveVol));
    if (!savedMuted) localStorage.removeItem('player-muted'); // remove stale 'false' string

    this.updateVolumeIcon(effectiveVol, savedMuted);

    // Electron audio autoplay unlock: on first interaction, ensure audio isn't blocked
    const unlockAudio = () => {
      if (this.video) {
        this.video.muted = localStorage.getItem('player-muted') === 'true';
        const v = parseFloat(localStorage.getItem('player-volume') || '1.0');
        this.video.volume = v > 0 ? v : 1.0;
      }
      document.removeEventListener('click', unlockAudio, true);
    };
    document.addEventListener('click', unlockAudio, true);
    // Volume controls
    volumeSlider.addEventListener('input', (e) => {
      const vol = parseFloat(e.target.value);
      this.video.volume = vol;
      this.video.muted = vol === 0;
      this.updateVolumeIcon(vol, this.video.muted);
      localStorage.setItem('player-volume', vol);
      localStorage.setItem('player-muted', this.video.muted);
    });

    volumeBtn.addEventListener('click', () => {
      this.video.muted = !this.video.muted;
      this.updateVolumeIcon(this.video.volume, this.video.muted);
      localStorage.setItem('player-muted', this.video.muted);
    });

    // Progress bar updates
    this.video.addEventListener('timeupdate', () => {
      const realTime = (this.isProxyActive ? this.proxyTimeOffset : 0) + this.video.currentTime;
      let realDuration = this.originalDuration || this.video.duration;

      // Prevent latching onto small chunk durations from proxy (e.g., 6 seconds)
      if (this.isProxyActive && this.video.duration < 60 && !this.originalDuration) {
        realDuration = 0; // Force it to wait for ffprobe duration
      }

      if (this.currentStream && this.currentStream.type === 'live') {
        progressFill.style.width = '100%';
        currentTimeText.textContent = '•';
        currentTimeText.style.color = '#e50914';
        totalTimeText.textContent = 'Live';
      } else if (realDuration && realDuration !== Infinity && realDuration > 0) {
        if (!this.originalDuration && realDuration > 60) {
          this.originalDuration = realDuration;
        }
        const pct = (realTime / realDuration) * 100;
        progressFill.style.width = `${pct}%`;
        progressBar.value = pct;
        currentTimeText.textContent = this.formatTime(realTime);
        currentTimeText.style.color = '';
        totalTimeText.textContent = this.formatTime(realDuration);
      } else {
        // Fallback
        progressFill.style.width = '100%';
        currentTimeText.textContent = this.formatTime(realTime);
        currentTimeText.style.color = '';
        totalTimeText.textContent = 'Live';
      }
            // Autoplay Next Episode Logic
      if (this.currentStream && this.nextEpisodeData && realDuration > 0 && (this.currentStream.isSeries || this.nextEpisodeData.isMovieSequel)) {
        const timeRemaining = realDuration - realTime;
        const overlay = document.getElementById('player-autoplay-overlay');
        const countdownSpan = document.getElementById('player-autoplay-countdown');
        const titleSpan = document.getElementById('player-autoplay-title');
        
        if (timeRemaining <= 15 && timeRemaining > 0) {
          overlay.classList.remove('hidden');
          countdownSpan.textContent = Math.ceil(timeRemaining);
          
          if (this.nextEpisodeData.isMovieSequel) {
            document.querySelector('#player-autoplay-overlay h3').textContent = 'Nächster Teil in';
            titleSpan.textContent = this.nextEpisodeData.title;
          } else {
            document.querySelector('#player-autoplay-overlay h3').textContent = 'Nächste Folge in';
            titleSpan.textContent = `S${this.nextEpisodeData.seasonNum}:E${this.nextEpisodeData.episode_num} - ${this.nextEpisodeData.title || ''}`;
          }
          
          if (!this.autoplayBtnListenerAdded) {
            document.getElementById('player-autoplay-overlay').addEventListener('click', () => {
              this.playNextEpisodeFromAutoplay();
            });
            this.autoplayBtnListenerAdded = true;
          }
        } else {
          overlay.classList.add('hidden');
        }
        
        if (timeRemaining <= 0.5 && !this.autoplayTriggered) {
          this.autoplayTriggered = true;
          this.playNextEpisodeFromAutoplay();
        }
      }

      this.updateStreamStats();
    });

    this.video.addEventListener('ended', () => {
      if (this.currentStream && this.nextEpisodeData && !this.autoplayTriggered && (this.currentStream.isSeries || this.nextEpisodeData.isMovieSequel)) {
        this.autoplayTriggered = true;
        this.playNextEpisodeFromAutoplay();
      } else {
        this.stop();
      }
    });

    // Clicking / scrubbing progress bar
    const scrub = (e) => {
      const realDuration = this.originalDuration || this.video.duration;
      if (!realDuration || realDuration === Infinity) return;
      
      const rect = progressBar.getBoundingClientRect();
      const pos = (e.clientX - rect.left) / rect.width;
      const targetTime = pos * realDuration;

      if (this.isProxyActive && this.proxyPort) {
        this.proxyTimeOffset = targetTime;
        this.playerContainer.classList.add('loading');
        const streamUrl = window.api.getStreamUrl(this.currentStream.id, this.currentStream.type);
        this.video.src = `http://127.0.0.1:${this.proxyPort}/proxy?url=${encodeURIComponent(streamUrl)}&start=${targetTime}`;
        this.video.load();
        this.video.play().catch(e => console.warn(e));
      } else {
        this.video.currentTime = targetTime;
      }
    };
    progressBar.addEventListener('click', scrub);

    // Speed options
    const speeds = [1, 1.25, 1.5, 2];
    let speedIndex = 0;
    speedBtn.addEventListener('click', () => {
      speedIndex = (speedIndex + 1) % speeds.length;
      const speed = speeds[speedIndex];
      this.video.playbackRate = speed;
      speedBtn.innerHTML = `<i class="fas fa-gauge-simple-high"></i> ${speed}x`;
    });

    // Centralized seek method
    const seekTo = (targetTime) => {
      if (this.isProxyActive && this.proxyPort) {
        this.proxyTimeOffset = targetTime;
        this.playerContainer.classList.add('loading');
        const streamUrl = window.api.getStreamUrl(this.currentStream.id, this.currentStream.type);
        this.video.src = `http://127.0.0.1:${this.proxyPort}/proxy?url=${encodeURIComponent(streamUrl)}&start=${targetTime}`;
        this.video.load();
        this.video.play().catch(e => console.warn(e));
      } else {
        this.video.currentTime = targetTime;
      }
      this.showControlsTemporarily();
    };

    // Skip/Episode Controls
    document.getElementById('player-skip-back').addEventListener('click', () => {
      const realTime = this.isProxyActive ? (this.proxyTimeOffset + this.video.currentTime) : this.video.currentTime;
      seekTo(Math.max(0, realTime - 10));
    });

    document.getElementById('player-skip-fwd').addEventListener('click', () => {
      const realTime = this.isProxyActive ? (this.proxyTimeOffset + this.video.currentTime) : this.video.currentTime;
      const realDuration = this.originalDuration || this.video.duration;
      seekTo(Math.min(realDuration || Infinity, realTime + 10));
    });

    document.getElementById('player-next-ep').addEventListener('click', () => {
      if (this.onNextEpisode && this.currentStream && this.currentStream.isSeries) {
        this.onNextEpisode(this.currentStream);
      }
    });

    document.getElementById('player-prev-ep').addEventListener('click', () => {
      if (this.onPrevEpisode && this.currentStream && this.currentStream.isSeries) {
        this.onPrevEpisode(this.currentStream);
      }
    });

    this.playNextEpisodeFromAutoplay = async () => {
      if (!this.nextEpisodeData || !this.currentStream) return;
      document.getElementById('player-autoplay-overlay').classList.add('hidden');
      
      const antiBingeEnabled = (await window.db.getSetting('antiBinge')) ?? true;
      
      const playNext = () => {
        this.episodesPlayedInRow++;
        
        if (this.nextEpisodeData.isMovieSequel) {
          this.play({
            id: this.nextEpisodeData.id,
            type: 'movie',
            title: this.nextEpisodeData.title,
            subtitle: 'Film',
            cover: this.nextEpisodeData.cover
          }, true);
        } else {
          this.play({
            id: this.nextEpisodeData.id,
            type: 'series',
            title: this.currentStream.seriesTitle,
            subtitle: `Staffel ${this.nextEpisodeData.seasonNum} • Folge ${this.nextEpisodeData.episode_num} - ${this.nextEpisodeData.title || ''}`,
            cover: this.currentStream.seriesCover,
            isSeries: true,
            seriesId: this.currentStream.seriesId,
            season: this.nextEpisodeData.seasonNum,
            episode: this.nextEpisodeData.episode_num,
            seasonsData: this.currentStream.seasonsData,
            seriesTitle: this.currentStream.seriesTitle,
            seriesCover: this.currentStream.seriesCover
          }, true); // Pass true to indicate autoplay
        }
      };

      if (antiBingeEnabled && this.episodesPlayedInRow >= 3) {
        // Show Anti-Binge Overlay
        const overlay = document.getElementById('player-anti-binge-overlay');
        overlay.style.display = 'flex';
        
        // Clean up previous stream so it doesn't run in background while waiting
        if (this.hls) { this.hls.destroy(); this.hls = null; }
        this.video.pause();
        this.video.removeAttribute('src');
        this.video.load();
        
        const continueBtn = document.getElementById('anti-binge-continue-btn');
        const closeBtn = document.getElementById('anti-binge-close-btn');
        
        continueBtn.onclick = () => {
          overlay.style.display = 'none';
          this.episodesPlayedInRow = 0; // Reset counter
          playNext();
        };
        
        closeBtn.onclick = () => {
          overlay.style.display = 'none';
          this.stop();
        };
      } else {
        playNext();
      }
    };

    // Skip Intro Logic
    this.currentIntroLength = 85;
    document.getElementById('player-skip-intro-btn').addEventListener('click', () => {
      const realTime = this.isProxyActive ? (this.proxyTimeOffset + this.video.currentTime) : this.video.currentTime;
      const realDuration = this.originalDuration || this.video.duration;
      seekTo(Math.min(realDuration || Infinity, realTime + this.currentIntroLength));
    });

    document.getElementById('player-skip-intro-settings-btn').addEventListener('click', async () => {
      if (!this.currentStream || !this.currentStream.seriesId) return;
      const input = prompt(`Wie viele Sekunden ist das Intro für "${this.currentStream.title}" lang?`, this.currentIntroLength);
      if (input !== null) {
        const parsed = parseInt(input, 10);
        if (!isNaN(parsed) && parsed > 0) {
          this.currentIntroLength = parsed;
          if (window.db && window.db.saveIntroLength) {
            await window.db.saveIntroLength(this.currentStream.seriesId, parsed);
          }
        }
      }
    });

    // Audio & Subtitle menu event handlers
    audioBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleDropdown('player-audio-menu');
    });

    subtitleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleDropdown('player-subtitle-menu');
    });

    // Close dropdowns on outside clicks
    document.addEventListener('click', () => {
      document.getElementById('player-audio-menu').classList.remove('show');
      document.getElementById('player-subtitle-menu').classList.remove('show');
    });

    // Fullscreen toggle
    fullscreenBtn.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        this.playerContainer.requestFullscreen().catch(err => {
          console.error(`Error requesting fullscreen: ${err.message}`);
        });
      } else {
        document.exitFullscreen();
      }
    });

    // Picture-in-Picture (Custom In-App Mini-Player)
    pipBtn.addEventListener('click', async () => {
      if (document.fullscreenElement) {
        await document.exitFullscreen().catch(err => {});
      }
      this.playerContainer.classList.add('player-pip-mode');
    });

    // PiP Overlay Controls
    const pipCloseBtn = document.getElementById('player-pip-close-btn');
    const pipMaxBtn = document.getElementById('player-pip-maximize-btn');
    
    if (pipCloseBtn) {
      pipCloseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.stop();
      });
    }

    if (pipMaxBtn) {
      pipMaxBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.playerContainer.classList.remove('player-pip-mode');
      });
    }

    // VLC / External Player Link
    if (vlcBtn) {
      vlcBtn.addEventListener('click', () => {
        this.copyStreamUrl();
      });
    }

    // Exit Player
    backBtn.addEventListener('click', () => {
      this.stop();
    });

    // Fade UI controls on idle
    this.playerContainer.addEventListener('mousemove', () => this.showControlsTemporarily());
    this.playerContainer.addEventListener('touchstart', () => this.showControlsTemporarily());

    // Keyboard Shortcuts
    document.addEventListener('keydown', (e) => {
      // Only process shortcuts if the player is active
      if (!this.playerContainer || this.playerContainer.classList.contains('hidden')) return;
      // Do not process shortcuts if user is typing in an input field (e.g. search)
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;

      switch(e.key.toLowerCase()) {
        case ' ':
          e.preventDefault();
          this.togglePlay();
          break;
        case 'arrowright': {
          e.preventDefault();
          const rTime = this.isProxyActive ? (this.proxyTimeOffset + this.video.currentTime) : this.video.currentTime;
          const rDur = this.originalDuration || this.video.duration;
          seekTo(Math.min(rDur || Infinity, rTime + 10));
          this.showControlsTemporarily();
          break;
        }
        case 'arrowleft': {
          e.preventDefault();
          const rTime = this.isProxyActive ? (this.proxyTimeOffset + this.video.currentTime) : this.video.currentTime;
          seekTo(Math.max(0, rTime - 10));
          this.showControlsTemporarily();
          break;
        }
        case 'arrowup':
          e.preventDefault();
          this.video.volume = Math.min(1, this.video.volume + 0.1);
          this.updateVolumeIcon(this.video.volume, this.video.muted);
          if (document.getElementById('player-volume-slider')) {
            document.getElementById('player-volume-slider').value = this.video.volume;
          }
          this.showControlsTemporarily();
          break;
        case 'arrowdown':
          e.preventDefault();
          this.video.volume = Math.max(0, this.video.volume - 0.1);
          this.updateVolumeIcon(this.video.volume, this.video.muted);
          if (document.getElementById('player-volume-slider')) {
            document.getElementById('player-volume-slider').value = this.video.volume;
          }
          this.showControlsTemporarily();
          break;
        case 'f':
          e.preventDefault();
          if (!document.fullscreenElement) {
            this.playerContainer.requestFullscreen().catch(err => {});
          } else {
            document.exitFullscreen().catch(err => {});
          }
          break;
        case 'm':
          e.preventDefault();
          this.video.muted = !this.video.muted;
          this.updateVolumeIcon(this.video.volume, this.video.muted);
          this.showControlsTemporarily();
          break;
        case 's':
          e.preventDefault();
          const skipBtn = document.getElementById('player-skip-intro-btn');
          if (skipBtn && skipBtn.style.display !== 'none') {
            skipBtn.click();
          }
          break;
        case 'n':
          e.preventDefault();
          const nextBtn = document.getElementById('player-next-ep');
          if (nextBtn && nextBtn.style.display !== 'none') {
            nextBtn.click();
          }
          break;
      }
    });
  }

  updateVolumeIcon(vol, muted) {
    const volumeBtn = document.getElementById('player-volume-btn');
    if (muted || vol === 0) {
      volumeBtn.innerHTML = '<i class="fas fa-volume-mute"></i>';
    } else if (vol < 0.5) {
      volumeBtn.innerHTML = '<i class="fas fa-volume-low"></i>';
    } else {
      volumeBtn.innerHTML = '<i class="fas fa-volume-high"></i>';
    }
  }

  toggleDropdown(id) {
    const menus = ['player-audio-menu', 'player-subtitle-menu'];
    menus.forEach(menuId => {
      const menu = document.getElementById(menuId);
      if (menuId === id) {
        menu.classList.toggle('show');
      } else {
        menu.classList.remove('show');
      }
    });
  }

  showControlsTemporarily() {
    this.playerContainer.classList.remove('hide-controls');
    clearTimeout(this.controlsTimeout);
    this.controlsTimeout = setTimeout(() => {
      if (!this.video.paused) {
        this.playerContainer.classList.add('hide-controls');
      }
    }, 3500);
  }

  /**
   * Formats seconds into HH:MM:SS
   */
  formatTime(seconds) {
    if (isNaN(seconds) || seconds === Infinity) return '00:00';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const pad = (n) => String(n).padStart(2, '0');
    if (hrs > 0) {
      return `${hrs}:${pad(mins)}:${pad(secs)}`;
    }
    return `${pad(mins)}:${pad(secs)}`;
  }

  updateDiscordPresence(isPaused) {
    try {
      if (window.electronAPI && window.electronAPI.setDiscordActivity) {
        if (!this.currentStream) return;
        const details = this.currentStream.title || 'IPTV Stream';
        const state = isPaused ? 'Pausiert' : 'Schaut gerade';
        window.electronAPI.setDiscordActivity({
          clientId: '1319080277873131650', // Replace with their actual client ID if different
          details: details,
          state: state
        });
      }
    } catch(e) {
      console.error('Discord RPC Error:', e);
    }
  }

  /**
   * Starts playing a stream.
   * stream: { id, type, title, subtitle, cover, isSeries, seriesId, season, episode }
   */
  async play(stream, isAutoplay = false) {
    if (!this.statsConfig) {
      this.statsConfig = {
        codec: (await window.db.getSetting('statsCodec')) ?? true,
        fps: (await window.db.getSetting('statsFps')) ?? true,
        bitrate: (await window.db.getSetting('statsBitrate')) ?? true,
        hdr: (await window.db.getSetting('statsHdr')) ?? true,
        ping: (await window.db.getSetting('statsPing')) ?? true
      };
    }
    
    // --- Connection Limit Check (Xtream API) ---
    try {
      if (window.api && typeof window.api.login === 'function') {
        const loginRes = await window.api.login();
        if (loginRes.success && loginRes.userInfo) {
          const max = parseInt(loginRes.userInfo.max_connections) || 0;
          const active = parseInt(loginRes.userInfo.active_cons) || 0;
          
          if (max > 0 && active >= max) {
            // Show error overlay in player instead of just toast
            if (window.ui) {
              window.ui.showToast(`Verbindungs-Limit erreicht! (${active}/${max} Streams aktiv). Bitte beende einen anderen Stream, um nicht gebannt zu werden.`, true);
              const playerContainer = document.getElementById('netflix-player-container');
              if (playerContainer && !playerContainer.classList.contains('hidden')) {
                // If player is already open, show a big error message in the center
                const titleEl = document.getElementById('netflix-player-title');
                if (titleEl) titleEl.innerHTML = `<span style="color:red">STREAM LIMIT ERREICHT (${active}/${max})</span>`;
                this.stop(); // Stop anything that might be playing
              } else {
                // If player is not open yet, just alert and abort opening
                alert(`Fehler: Dein Abo erlaubt nur ${max} gleichzeitige Streams, aber es sind aktuell ${active} aktiv. Bitte beende einen anderen Stream.`);
              }
            }
            return; // ABORT PLAYBACK
          }
        }
      }
    } catch (e) {
      console.warn('Could not check connection limits', e);
    }
    
    if (!isAutoplay) {
      this.episodesPlayedInRow = 0;
    }
    // --- FORCE CLEANUP OF PREVIOUS STREAM ---
    if (this.saveProgressInterval) {
      clearInterval(this.saveProgressInterval);
      this.saveProgressInterval = null;
    }
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this.video.pause();
    this.video.removeAttribute('src'); // Force drop old connection immediately
    this.video.load();
    // ----------------------------------------

    this.currentStream = stream;
    this.proxyTimeOffset = 0;
    this.isProxyActive = false;
    this.playerContainer.classList.remove('hidden');
    this.playerContainer.classList.add('loading');
    
    // Discord Rich Presence Update
    this.updateDiscordPresence(false);
    this.showControlsTemporarily();

    // ALWAYS force audio on at stream start
    const volToUse = Math.max(parseFloat(localStorage.getItem('player-volume') || '1.0'), 0.1);
    this.video.volume = volToUse;
    this.video.muted  = false;
    document.getElementById('player-volume-slider').value = volToUse;
    this.updateVolumeIcon(volToUse, false);
    console.log('[Player] Starting stream, volume:', volToUse, 'muted: false');

    // Set title overlays
    document.getElementById('player-title').textContent = stream.title || 'IPTV Stream';
    document.getElementById('player-subtitle').textContent = stream.subtitle || '';

    // Show/hide episode buttons & Skip Intro overlay
    const nextBtn = document.getElementById('player-next-ep');
    const prevBtn = document.getElementById('player-prev-ep');
    const skipIntroContainer = document.getElementById('player-skip-intro-container');
    this.playerContainer.classList.remove('hidden');
    this.video.style.display = 'block';
    
    // Determine next episode
    this.nextEpisodeData = null;
    this.autoplayTriggered = false;
    document.getElementById('player-autoplay-overlay').classList.add('hidden');

    const determineNextEp = (seasonsData) => {
      const currentSeasonStr = String(stream.season);
      const currentEpStr = String(stream.episode);
      let foundCurrent = false;
      const seasonKeys = Object.keys(seasonsData).sort((a,b)=>parseInt(a)-parseInt(b));
      
      for (const s of seasonKeys) {
         const epList = seasonsData[s].sort((a,b)=>parseInt(a.episode_num)-parseInt(b.episode_num));
         for (const ep of epList) {
           if (foundCurrent) {
             this.nextEpisodeData = { ...ep, seasonNum: s };
             break;
           }
           if (s === currentSeasonStr && String(ep.episode_num) === currentEpStr) {
             foundCurrent = true;
           }
         }
         if (this.nextEpisodeData) break;
      }
    };

    if (stream.isSeries) {
      if (stream.seasonsData) {
        determineNextEp(stream.seasonsData);
      } else {
        // Fetch it async if missing
        window.api.fetchSeriesInfo(stream.seriesId).then(data => {
          if (data && data.episodes) {
            stream.seasonsData = data.episodes; // Cache it for consecutive autoplay
            determineNextEp(data.episodes);
          }
        }).catch(e => console.error("Failed to fetch next episode data for autoplay", e));
      }
    } else if (stream.type === 'movie' && window.ui) {
      window.ui.fetchTMDBNextMovieInCollection(stream.title).then(nextMovie => {
         if (nextMovie) {
            window.ui.findMovieInLibrary(nextMovie.title).then(localMatch => {
               if (localMatch) {
                 this.nextEpisodeData = {
                   id: localMatch.stream_id || localMatch.id,
                   title: localMatch.name || nextMovie.title,
                   cover: localMatch.stream_icon || nextMovie.cover,
                   isMovieSequel: true
                 };
               }
            });
         }
      }).catch(e => console.error("Failed to fetch next movie sequel", e));
    }

    if (stream.isSeries) {
      nextBtn.style.display = 'inline-block';
      prevBtn.style.display = 'inline-block';
      skipIntroContainer.style.display = 'flex';
      
      // Load saved intro length
      if (window.db && window.db.getIntroLength) {
        window.db.getIntroLength(stream.seriesId).then(len => {
          this.currentIntroLength = len || 85;
        }).catch(() => { this.currentIntroLength = 85; });
      }

      // Hide after 15 minutes
      this.skipIntroTimeout = setTimeout(() => {
        skipIntroContainer.style.display = 'none';
      }, 900000);
    } else {
      nextBtn.style.display = 'none';
      prevBtn.style.display = 'none';
      skipIntroContainer.style.display = 'none';
    }

    // Clear dropdowns
    document.getElementById('player-audio-menu').innerHTML = '';
    document.getElementById('player-subtitle-menu').innerHTML = '';

    let streamUrl = '';
    let directStreamUrl = '';
    if (stream.type === 'local' && stream.filePath) {
      streamUrl = 'file://' + stream.filePath.replace(/\\/g, '/');
      directStreamUrl = streamUrl;
    } else {
      streamUrl = window.api.getStreamUrl(stream.id, stream.type);
      directStreamUrl = window.api.getStreamUrl(stream.id, stream.type, 'mp4', true);
    }
    
    try {
      if (window.electronAPI && window.electronAPI.log) {
        window.electronAPI.log('info', '--- STARTING PLAYBACK ---');
        window.electronAPI.log('info', 'Type:', stream.type, 'Stream ID:', stream.id, 'Stream URL:', streamUrl, 'Direct URL:', directStreamUrl, 'CORS Proxy Setting:', window.api.corsProxy);
      }
    } catch(e) {}
    
    // Check if progress already exists
    const saved = await window.db.getProgress(stream.id);
    let startPosition = 0;
    if (saved && saved.position > 10 && (saved.duration - saved.position > 15)) {
      startPosition = saved.position;
    }

    // --- FFmpeg Proxy Setup for VOD ---
    if (stream.type !== 'live' && stream.type !== 'local' && window.electronAPI) {
      const hasFfmpeg = await window.electronAPI.checkFfmpeg();
      const proxyPort = await window.electronAPI.getProxyPort();
      
      if (hasFfmpeg && proxyPort > 0 && stream.type !== 'live') {
        this.proxyPort = proxyPort;
        if (saved && saved.duration) this.originalDuration = saved.duration;
        
        const originalUrl = directStreamUrl; // Node.js backend doesn't need CORS proxy
        streamUrl = `http://127.0.0.1:${proxyPort}/proxy?url=${encodeURIComponent(originalUrl)}&start=${startPosition}`;
        this.proxyTimeOffset = startPosition;
        this.isProxyActive = true;
        startPosition = 0; // The proxy starts the stream at the offset, so HTML5 video starts at 0

        // Fetch tracks in background with a delay to prevent connection limiting on the IPTV server
        setTimeout(() => {
          if (this.currentStream && this.currentStream.id === stream.id && window.electronAPI) {
            window.electronAPI.getStreamInfo(originalUrl).then(info => {
              this.populateProxyTracks(info, originalUrl);
            });
          }
        }, 2000);

      } else {
        console.warn('[Player] FFmpeg proxy disabled or unavailable. Falling back to native.');
      }
    }
    // -----------------------------------

    const isHlsUrl = stream.type === 'live' || streamUrl.includes('.m3u8') || streamUrl.includes('.ts');

    if (Hls.isSupported() && isHlsUrl && stream.type !== 'local') {
      if (this.hls) this.hls.destroy();

      this.hls = new Hls({
        maxMaxBufferLength: 30,
        enableWorker: true,
        lowLatencyMode: stream.type === 'live',
        liveSyncDurationCount: 3, // Force starting closer to live edge (less buffering)
        // Prefer AAC audio tracks over AC3 when multiple are available
        audioPreference: { audioCodec: 'mp4a' },
        startPosition: startPosition > 0 ? startPosition : -1
      });

      this.hls.loadSource(streamUrl);
      this.hls.attachMedia(this.video);

      this.hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
        this.playerContainer.classList.remove('loading');

        // Force audio on - last chance before play()
        const vol = Math.max(parseFloat(localStorage.getItem('player-volume') || '1.0'), 0.1);
        this.video.volume = vol;
        this.video.muted  = false;
        console.log('[Player] MANIFEST_PARSED: volume=', this.video.volume, 'muted=', this.video.muted,
          '| audioTracks:', this.hls.audioTracks?.length, '| subtitleTracks:', this.hls.subtitleTracks?.length);

        // Populate audio/subtitle tracks that may already be available
        if (this.hls.audioTracks && this.hls.audioTracks.length > 1) {
          this.populateAudioTracks(this.hls.audioTracks);
        }
        if (this.hls.subtitleTracks && this.hls.subtitleTracks.length > 0) {
          this.populateSubtitleTracks(this.hls.subtitleTracks);
        }

        if (startPosition > 0 && stream.type !== 'live') {
          const doSeek = () => {
            if (this.isProxyActive) {
              this.video.currentTime = startPosition;
            }
            this.showResumeToast(startPosition);
          };
          if (this.video.readyState >= 1) {
            doSeek();
          } else {
            this.video.addEventListener('loadedmetadata', doSeek, { once: true });
          }
        }

        this.video.play().catch(e => {
          console.warn('HLS Autoplay blocked:', e);
          this.playerContainer.classList.add('paused');
          document.getElementById('player-play-btn').innerHTML = '<i class="fas fa-play"></i>';
        });
      });

      this.hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (event, data) => {
        this.populateAudioTracks(data.audioTracks);
      });

      this.hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (event, data) => {
        this.populateSubtitleTracks(data.subtitleTracks);
      });

      let retryCount = 0;
      this.hls.on(Hls.Events.ERROR, (event, data) => {
        try {
          if (window.electronAPI && window.electronAPI.log) {
            window.electronAPI.log('error', '[HLS Error]', data.type, data.details, data.fatal);
          }
        } catch(e) {}

        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              if (data.response && data.response.code === 404) {
                console.error('[Player] 404 Not Found. Stopping playback.');
                this.handlePlaybackError();
                return;
              }
              if (retryCount >= 3) {
                console.error('[Player] Max retries reached.');
                this.handlePlaybackError();
                return;
              }
              retryCount++;
              console.error(`[Player] Fatal network error, retrying (${retryCount}/3)...`);
              this.hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.error('[Player] Fatal media error, recovering...');
              this.hls.recoverMediaError();
              break;
            default:
              this.handlePlaybackError();
              break;
          }
        }
      });

    } else {
      // HLS.js not supported — true native fallback (Safari etc.)
      this.video.onerror = null; // clear old handler first
      this.video.oncanplay = null;
      this.video.src = streamUrl;
      this.video.load();

      this.video.oncanplay = () => {
        this.playerContainer.classList.remove('loading');
        const savedVol = localStorage.getItem('player-volume');
        if (savedVol !== null) this.video.volume = parseFloat(savedVol);
        this.video.muted = false;
        
        // Only seek if we are NOT using the proxy (proxy handles seek natively)
        if (startPosition > 0 && !this.isProxyActive) {
          this.video.currentTime = startPosition;
          this.showResumeToast(startPosition);
        } else if (this.isProxyActive && this.proxyTimeOffset > 0) {
          // If proxy is active, the video starts at 0, but we want to show a toast anyway
          this.showResumeToast(this.proxyTimeOffset);
        }

        this.video.play().catch(e => console.warn('Native Autoplay failed:', e));
        this.populateNativeTracks();
      };

      this.video.onerror = () => { this.handlePlaybackError(); };
    }

    // Set up watch progress saving loop
    if (stream.type !== 'live') {
      this.saveProgressInterval = setInterval(() => {
        this.saveCurrentProgress();
      }, 5000); // Save every 5 seconds
    }
  }

  showResumeToast(seconds) {
    // Remove any existing toast first
    this.playerContainer.querySelector('.player-toast')?.remove();

    const toast = document.createElement('div');
    toast.className = 'player-toast';
    toast.innerHTML = `
      <span>Wiedergabe fortgesetzt bei ${this.formatTime(seconds)}</span>
      <button id="player-restart-btn">Von vorne starten</button>
    `;
    this.playerContainer.appendChild(toast);

    // Bind button directly — no inline onclick to avoid recursion risk
    toast.querySelector('#player-restart-btn').addEventListener('click', () => {
      if (this.isProxyActive && this.proxyPort) {
        this.proxyTimeOffset = 0;
        this.playerContainer.classList.add('loading');
        const streamUrl = window.api.getStreamUrl(this.currentStream.id, this.currentStream.type);
        this.video.src = `http://127.0.0.1:${this.proxyPort}/proxy?url=${encodeURIComponent(streamUrl)}&start=0`;
        this.video.load();
        this.video.play().catch(e => console.warn(e));
      } else {
        this.video.currentTime = 0;
      }
      toast.remove();
    });

    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 1000);
    }, 6000);
  }

  restartPlayback() {
    this.video.currentTime = 0;
    this.playerContainer.querySelector('.player-toast')?.remove();
  }

  populateAudioTracks(tracks) {
    const menu = document.getElementById('player-audio-menu');
    menu.innerHTML = '';

    if (!tracks || tracks.length <= 1) {
      document.getElementById('player-audio-btn').style.display = 'none';
      return;
    }
    
    document.getElementById('player-audio-btn').style.display = 'inline-block';

    tracks.forEach((track, index) => {
      const item = document.createElement('div');
      item.className = 'menu-item' + (index === this.hls.audioTrack ? ' active' : '');
      item.textContent = track.name || `Tonspur ${index + 1}`;
      item.addEventListener('click', () => {
        this.hls.audioTrack = index;
        Array.from(menu.children).forEach((c, idx) => c.classList.toggle('active', idx === index));
      });
      menu.appendChild(item);
    });
  }

  populateSubtitleTracks(tracks) {
    const menu = document.getElementById('player-subtitle-menu');
    menu.innerHTML = '';

    if (!tracks || tracks.length === 0) {
      document.getElementById('player-subtitle-btn').style.display = 'none';
      return;
    }

    document.getElementById('player-subtitle-btn').style.display = 'inline-block';

    // "Aus" (Off) Option
    const offItem = document.createElement('div');
    offItem.className = 'menu-item' + (this.hls.subtitleTrack === -1 ? ' active' : '');
    offItem.textContent = 'Deaktiviert';
    offItem.addEventListener('click', () => {
      this.hls.subtitleTrack = -1;
      Array.from(menu.children).forEach(c => c.classList.remove('active'));
      offItem.classList.add('active');
    });
    menu.appendChild(offItem);

    tracks.forEach((track, index) => {
      const item = document.createElement('div');
      item.className = 'menu-item' + (index === this.hls.subtitleTrack ? ' active' : '');
      item.textContent = track.name || track.lang || `Untertitel ${index + 1}`;
      item.addEventListener('click', () => {
        this.hls.subtitleTrack = index;
        Array.from(menu.children).forEach(c => c.classList.remove('active'));
        item.classList.add('active');
      });
      menu.appendChild(item);
    });
  }

  populateNativeTracks() {
    const menu = document.getElementById('player-subtitle-menu');
    menu.innerHTML = '';
    
    const textTracks = this.video.textTracks;
    if (!textTracks || textTracks.length === 0) {
      document.getElementById('player-subtitle-btn').style.display = 'none';
      return;
    }
    
    document.getElementById('player-subtitle-btn').style.display = 'inline-block';

    const offItem = document.createElement('div');
    offItem.className = 'menu-item active';
    offItem.textContent = 'Deaktiviert';
    offItem.addEventListener('click', () => {
      for (let i = 0; i < textTracks.length; i++) {
        textTracks[i].mode = 'disabled';
      }
      Array.from(menu.children).forEach(c => c.classList.remove('active'));
      offItem.classList.add('active');
    });
    menu.appendChild(offItem);

    for (let i = 0; i < textTracks.length; i++) {
      const track = textTracks[i];
      const item = document.createElement('div');
      item.className = 'menu-item';
      item.textContent = track.label || track.language || `Untertitel ${i + 1}`;
      item.addEventListener('click', () => {
        for (let j = 0; j < textTracks.length; j++) {
          textTracks[j].mode = j === i ? 'showing' : 'disabled';
        }
        Array.from(menu.children).forEach(c => c.classList.remove('active'));
        item.classList.add('active');
      });
      menu.appendChild(item);
    }
  }

  /**
   * Handles stream playback crashes/decoder issues
   */
  handlePlaybackError() {
    if (!this.currentStream) return; // guard against stale error handlers
    this.playerContainer.classList.remove('loading');
    this.playerContainer.classList.add('error');
    const errorText = document.getElementById('player-error-text');
    if (!errorText) return;
    errorText.innerHTML = `
      <h3>Fehler bei der Wiedergabe</h3>
      <p>Dieser Stream konnte nicht dekodiert werden. Möglicherweise nutzt er AC3/Dolby-Audio oder H.265-Video, das in Electron nicht direkt unterstützt wird.</p>
      <div class="player-error-options">
        <a href="${window.api.getStreamUrl(this.currentStream.id, this.currentStream.type)}" target="_blank" class="error-btn-primary">
          <i class="fas fa-external-link-alt"></i> Im Browser-Tab öffnen
        </a>
        <button onclick="window.player.copyStreamUrl()" class="error-btn-secondary">
          <i class="fas fa-copy"></i> Link für VLC/MPV kopieren
        </button>
      </div>
    `;
  }

  copyStreamUrl() {
    const url = window.api.getStreamUrl(this.currentStream.id, this.currentStream.type);
    navigator.clipboard.writeText(url).then(() => {
      alert('Stream-Link in die Zwischenablage kopiert! Du kannst diesen Link jetzt z.B. in VLC oder MPV öffnen.');
    }).catch(err => {
      console.error('Kopieren fehlgeschlagen:', err);
    });
  }

  /**
   * Saves progress of current film/episode to IndexedDB.
   */
  async saveCurrentProgress() {
    if (!this.currentStream || this.currentStream.type === 'live' || !this.video.duration) return;

    const pos = (this.isProxyActive ? this.proxyTimeOffset : 0) + this.video.currentTime;
    const dur = this.originalDuration || this.video.duration;
    
    // Ignore near start (first 10 seconds) or near end (last 15 seconds) to clean up Continue Watching rows
    if (pos < 10) {
      await window.db.deleteProgress(this.currentStream.id);
      return;
    }

    if (dur - pos < 15) {
      await window.db.deleteProgress(this.currentStream.id);
      // Trigger Series episode completion logic if applicable
      return;
    }

    // Save extra data like series info
    const extra = {};
    if (this.currentStream.isSeries) {
      extra.isSeries = true;
      extra.seriesId = this.currentStream.seriesId;
      extra.season = this.currentStream.season;
      extra.episode = this.currentStream.episode;
    }

    await window.db.saveProgress(
      this.currentStream.id,
      this.currentStream.type,
      this.currentStream.title,
      this.currentStream.subtitle,
      pos,
      dur,
      this.currentStream.cover,
      extra
    );

    // Dispatch update event to refresh "Continue Watching" UI row in the background
    window.dispatchEvent(new CustomEvent('playback-progress-updated'));
  }

  /**
   * Stops playback and hides player.
   */
  stop() {
    if (this.saveProgressInterval) {
      clearInterval(this.saveProgressInterval);
      this.saveProgressInterval = null;
    }

    // Save final progress
    this.saveCurrentProgress();

    // Clear Discord Rich Presence
    if (window.electronAPI && window.electronAPI.setDiscordActivity) {
      window.electronAPI.setDiscordActivity({ details: null }); // clear
    }

    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }

    // Clear event handlers BEFORE changing src to prevent stale onerror callbacks
    this.video.onerror   = null;
    this.video.oncanplay = null;

    this.video.pause();
    this.video.src = '';
    this.video.load(); // fully unload
    this.currentStream = null;
    this.isProxyActive = false;
    this.proxyTimeOffset = 0;
    this.originalDuration = null;
    this.nextEpisodeData = null;
    
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(err => {});
    }
    
    this.playerContainer.classList.add('hidden');
    this.playerContainer.classList.remove('player-pip-mode', 'error', 'paused', 'loading');
    
    document.getElementById('player-autoplay-overlay').classList.add('hidden');
    
    // Notify UI to refresh Continue Watching
    window.dispatchEvent(new CustomEvent('player-closed'));
  }

  populateProxyTracks(info, originalUrl) {
    if (!info) return;
    
    if (info.format && info.format.bit_rate) {
      const br = parseInt(info.format.bit_rate);
      if (br > 0) {
        this.currentBitrate = (br / 1000000).toFixed(1) + ' Mbit/s';
      }
    }

    if (info.format && info.format.duration) {
      const parsedDuration = parseFloat(info.format.duration);
      if (!isNaN(parsedDuration) && parsedDuration > 0) {
        this.originalDuration = parsedDuration;
      }
    }

    // Ping check to server
    try {
      const start = performance.now();
      const origin = new URL(originalUrl).origin;
      fetch(origin, { method: 'HEAD', mode: 'no-cors', cache: 'no-store' }).then(() => {
        this.currentLatency = Math.round(performance.now() - start);
        this.updateStreamStats();
      }).catch(() => {});
    } catch(e) {}

    if (!info.streams) return;

    const videoStreams = info.streams.filter(s => s.codec_type === 'video');
    const audioStreams = info.streams.filter(s => s.codec_type === 'audio');
    const subStreams = info.streams.filter(s => s.codec_type === 'subtitle');
    
    if (videoStreams.length > 0) {
      const vTrack = videoStreams[0];
      
      // Video Codec
      let vCodec = (vTrack.codec_name || '').toUpperCase();
      if (vCodec === 'HEVC') vCodec = 'HEVC / H.265';
      else if (vCodec === 'H264') vCodec = 'H.264 / AVC';
      
      this.currentVideoCodec = vCodec;
      
      // FPS
      if (vTrack.r_frame_rate) {
        const parts = vTrack.r_frame_rate.split('/');
        if (parts.length === 2 && parseInt(parts[1]) > 0) {
          const fps = (parseInt(parts[0]) / parseInt(parts[1])).toFixed(2);
          this.currentVideoFPS = fps.replace('.00', '') + ' fps';
        }
      }

      // HDR
      const color = (vTrack.color_space || '') + ' ' + (vTrack.color_transfer || '') + ' ' + (vTrack.color_primaries || '');
      if (color.includes('bt2020') || color.includes('smpte2084') || color.includes('arib-std-b67')) {
        this.currentHDR = 'HDR';
      }
    }

    // Populate Audio
    const audioMenu = document.getElementById('player-audio-menu');
    audioMenu.innerHTML = '';
    
    if (audioStreams.length > 1) {
      document.getElementById('player-audio-btn').style.display = 'inline-block';
      audioStreams.forEach((track, i) => {
        const item = document.createElement('div');
        item.className = 'menu-item';
        
        const isDefault = i === 0; // Assuming first track is default mapped by ffmpeg
        if (this.selectedAudioTrack === track.index || (isDefault && !this.selectedAudioTrack)) {
          item.className += ' active';
          let formatName = (track.codec_name || 'Audio').toUpperCase();
          if (formatName === 'AC3' || formatName === 'EAC3') formatName = 'Dolby Digital';
          else if (formatName === 'TRUEHD') formatName = 'Dolby TrueHD Atmos';
          else if (formatName === 'DTS' || formatName === 'DTS-HD MA') formatName = 'DTS-HD';
          else if (formatName === 'FLAC') formatName = 'FLAC Lossless';
          const channels = track.channels >= 8 ? '7.1' : (track.channels >= 6 ? '5.1' : (track.channels === 2 ? '2.0' : ''));
          this.currentAudioFormat = `${formatName} ${channels}`.trim();
        }
        
        const lang = (track.tags && track.tags.language) ? track.tags.language.toUpperCase() : `Audio ${i + 1}`;
        item.textContent = track.tags?.title || lang;
        
        item.addEventListener('click', () => {
          this.selectedAudioTrack = track.index;
          Array.from(audioMenu.children).forEach(c => c.classList.remove('active'));
          item.classList.add('active');

          // Reload proxy stream with new audio track
          const realTime = (this.isProxyActive ? this.proxyTimeOffset : 0) + this.video.currentTime;
          this.proxyTimeOffset = realTime;
          this.playerContainer.classList.add('loading');
          this.video.src = `http://127.0.0.1:${this.proxyPort}/proxy?url=${encodeURIComponent(originalUrl)}&start=${realTime}&audio=${track.index}`;
          this.video.load();
          this.video.play().catch(e => console.warn(e));
        });
        audioMenu.appendChild(item);
      });
    } else {
      document.getElementById('player-audio-btn').style.display = 'none';
    }

    // Populate Subtitles
    const subMenu = document.getElementById('player-subtitle-menu');
    subMenu.innerHTML = '';

    if (subStreams.length > 0) {
      document.getElementById('player-subtitle-btn').style.display = 'inline-block';
      
      const offItem = document.createElement('div');
      offItem.className = 'menu-item active';
      offItem.textContent = 'Deaktiviert';
      offItem.addEventListener('click', () => {
        Array.from(this.video.textTracks).forEach(t => t.mode = 'disabled');
        Array.from(subMenu.children).forEach(c => c.classList.remove('active'));
        offItem.classList.add('active');
      });
      subMenu.appendChild(offItem);

      // Remove existing custom tracks
      Array.from(this.video.querySelectorAll('track')).forEach(t => t.remove());

      subStreams.forEach((track, i) => {
        // Create VTT track element
        const lang = (track.tags && track.tags.language) ? track.tags.language.toUpperCase() : `Untertitel ${i + 1}`;
        const trackEl = document.createElement('track');
        trackEl.kind = 'subtitles';
        trackEl.label = track.tags?.title || lang;
        trackEl.srclang = (track.tags && track.tags.language) || 'en';
        trackEl.src = `http://127.0.0.1:${this.proxyPort}/subtitle?url=${encodeURIComponent(originalUrl)}&index=${track.index}`;
        this.video.appendChild(trackEl);

        const item = document.createElement('div');
        item.className = 'menu-item';
        item.textContent = trackEl.label;
        
        item.addEventListener('click', () => {
          // Enable this track, disable others
          const textTracks = this.video.textTracks;
          for (let j = 0; j < textTracks.length; j++) {
            textTracks[j].mode = textTracks[j].label === trackEl.label ? 'showing' : 'disabled';
          }
          Array.from(subMenu.children).forEach(c => c.classList.remove('active'));
          item.classList.add('active');
        });
        subMenu.appendChild(item);
      });
    } else {
      document.getElementById('player-subtitle-btn').style.display = 'none';
    }
  }

  updateStreamStats() {
    const statsEl = document.getElementById('player-stream-stats');
    if (!statsEl) return;
    
    // Default to SD if video height is unknown
    let resText = 'SD';
    const h = this.video.videoHeight;
    if (h >= 2160) resText = '4K UHD';
    else if (h >= 1080) resText = '1080p HD';
    else if (h >= 720) resText = '720p HD';
    else if (h > 0) resText = 'SD';
    else resText = 'Laden...';

    const audioText = this.currentAudioFormat || 'Stereo';
    let html = `<span class="stat-badge">${resText}</span> <span class="stat-badge">${audioText}</span>`;
    const conf = this.statsConfig || { codec: true, fps: true, bitrate: true, hdr: true, ping: true };

    if (this.currentHDR && conf.hdr) {
      html += ` <span class="stat-badge" style="background: linear-gradient(135deg, #e50914, #ff8a00); color: white; border: none;">${this.currentHDR}</span>`;
    }
    if (this.currentVideoCodec && conf.codec) {
      html += ` <span class="stat-badge">${this.currentVideoCodec}</span>`;
    }
    if (this.currentVideoFPS && conf.fps) {
      html += ` <span class="stat-badge" style="opacity: 0.8; font-size: 0.9em;">${this.currentVideoFPS}</span>`;
    }
    if (this.currentBitrate && conf.bitrate) {
      html += ` <span class="stat-badge" style="opacity: 0.8; font-size: 0.9em;"><i class="fas fa-signal" style="margin-right: 4px;"></i>${this.currentBitrate}</span>`;
    }
    if (this.currentLatency && conf.ping) {
      const color = this.currentLatency < 100 ? '#4caf50' : (this.currentLatency < 300 ? '#ff9800' : '#f44336');
      html += ` <span class="stat-badge" style="opacity: 0.8; font-size: 0.9em;"><i class="fas fa-circle" style="color: ${color}; font-size: 8px; vertical-align: middle; margin-right: 5px;"></i>${this.currentLatency} ms</span>`;
    }
    
    statsEl.innerHTML = html;
  }
}

// Export a single instance
window.player = new NetflixPlayer();
