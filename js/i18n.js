const translations = {
  de: {
    // Sidebar
    navHome: "Home",
    navExplore: "Entdecken",
    navMovies: "Filme",
    navSeries: "Serien",
    navLive: "Live TV",
    navEpg: "EPG (Programm)",
    navDownloads: "Downloads",
    navSettings: "Einstellungen",
    
    // Headers
    top10Movies: "Top 10 Filme Heute",
    top10Series: "Top 10 Serien Heute",
    continueWatching: "Zuletzt geguckt",
    popularMovies: "Beliebte Filme",
    popularSeries: "Beliebte Serien",
    movieCats: "Film-Kategorien",
    seriesCats: "Serien-Kategorien",
    liveCats: "Live TV Kategorien",
    
    // Search
    searchPlaceholder: "Titel, Personen, Genres",
    noResults: "Keine Ergebnisse für",
    
    // Settings
    settingsTitle: "Einstellungen",
    settingsLang: "Sprache / Language",
    settingsTheme: "Akzentfarbe",
    settingsAutoLogin: "Automatisch anmelden",
    settingsAutoLoginDesc: "Startet die App direkt mit dem zuletzt verwendeten Profil.",
    settingsAntiBinge: "\"Schaust du noch?\"-Abfrage",
    settingsAntiBingeDesc: "Stoppt die automatische Wiedergabe nach 3 Folgen in Folge.",
    settingsDiscord: "Discord Status aktivieren",
    settingsDiscordDesc: "Zeigt in Discord an, was du gerade schaust.",
    settingsDedup: "Duplikate zusammenfassen",
    settingsDedupDesc: "Erkennt Filme in unterschiedlichen Auflösungen/Sprachen als einen Film.",
    settingsCoverBtn: "Fehlende Cover & Infos suchen (TMDB)",
    settingsCoverDesc: "Sucht im Hintergrund nach hochauflösenden Covern für Filme/Serien.",
    settingsSave: "Speichern",
    settingsLogout: "Vom Account abmelden",
    
    loginSubtitle: "Geben Sie Ihre IPTV-Verbindungsdaten ein, um das Profil zu erstellen.",
    profileNameLabel: "Name des Profils (z.B. IPTV 1, Wohnzimmer, etc.)",
    serverUrlLabel: "Xtream Server URL",
    usernameLabel: "Benutzername",
    passwordLabel: "Passwort",
    proxyLabel: "CORS Proxy Verbindung",
    proxyDirect: "Direkt (Empfohlen in Electron, da CORS deaktiviert ist)",
    proxyTip: "Da WebSecurity in der App deaktiviert ist, kannst du direkt verbinden!",
    createProfile: "Profil erstellen",
    
    // Auth & Profile
    loginTitle: "Einloggen",
    profileTitle: "Wer schaut gerade?",
    manageProfiles: "Profile verwalten",
    done: "Fertig",
    
    // Media
    play: "Abspielen",
    playLive: "Live Einschalten",
    epgGuide: "Programmzeitschrift",
    download: "Herunterladen",
    removeList: "Von Liste entfernen",
    addList: "Zur Liste hinzufügen",
    episodes: "Folgen",
    season: "Staffel",
    
    // Sync
    syncTitle: "Erste Synchronisierung",
    syncDesc: "Deine IPTV-Kanäle, VOD Filme und Serien werden heruntergeladen und im Browser-Datenbank gespeichert. Dies kann je nach Umfang einige Sekunden dauern...",
    syncCheck: "Verbindung prüfen...",
    
    // Misc
    loading: "Wird geladen...",
    errorSync: "Fehler bei der Synchronisierung",
    retry: "Erneut versuchen",
    back: "Zurück"
  },
  en: {
    // Sidebar
    navHome: "Home",
    navExplore: "Explore",
    navMovies: "Movies",
    navSeries: "TV Shows",
    navLive: "Live TV",
    navEpg: "EPG (Guide)",
    navDownloads: "Downloads",
    navSettings: "Settings",
    
    // Headers
    top10Movies: "Top 10 Movies Today",
    top10Series: "Top 10 TV Shows Today",
    continueWatching: "Continue Watching",
    popularMovies: "Popular Movies",
    popularSeries: "Popular Series",
    movieCats: "Movie Categories",
    seriesCats: "TV Show Categories",
    liveCats: "Live TV Categories",
    
    // Search
    searchPlaceholder: "Titles, people, genres",
    noResults: "No results for",
    
    // Settings
    settingsTitle: "Settings",
    settingsLang: "Language / Sprache",
    settingsTheme: "Accent Color",
    settingsAutoLogin: "Auto Login",
    settingsAutoLoginDesc: "Starts the app directly with the last used profile.",
    settingsAntiBinge: "\"Are you still watching?\"",
    settingsAntiBingeDesc: "Stops autoplay after 3 consecutive episodes.",
    settingsDiscord: "Enable Discord Rich Presence",
    settingsDiscordDesc: "Shows what you are watching on your Discord profile.",
    settingsDedup: "Group Duplicates",
    settingsDedupDesc: "Recognizes movies in different resolutions/languages as a single movie.",
    settingsCoverBtn: "Find Missing Covers (TMDB)",
    settingsCoverDesc: "Searches in the background for high-res covers for movies/shows.",
    settingsSave: "Save",
    settingsLogout: "Sign Out",
    
    loginSubtitle: "Enter your IPTV connection details to create a profile.",
    profileNameLabel: "Profile Name (e.g., IPTV 1, Living Room, etc.)",
    serverUrlLabel: "Xtream Server URL",
    usernameLabel: "Username",
    passwordLabel: "Password",
    proxyLabel: "CORS Proxy Connection",
    proxyDirect: "Direct (Recommended in Electron, since CORS is disabled)",
    proxyTip: "Since WebSecurity is disabled, you can connect directly!",
    createProfile: "Create Profile",
    
    // Auth & Profile
    loginTitle: "Sign In",
    profileTitle: "Who's watching?",
    manageProfiles: "Manage Profiles",
    done: "Done",
    
    // Media
    play: "Play",
    playLive: "Watch Live",
    epgGuide: "TV Guide",
    download: "Download",
    removeList: "Remove from My List",
    addList: "Add to My List",
    episodes: "Episodes",
    season: "Season",
    
    // Sync
    syncTitle: "Initial Synchronization",
    syncDesc: "Your IPTV channels, VOD movies, and series are being downloaded and saved to the browser database. This may take a few seconds...",
    syncCheck: "Checking connection...",
    
    // Misc
    loading: "Loading...",
    errorSync: "Sync Error",
    retry: "Try Again",
    back: "Back"
  }
};

class I18n {
  constructor() {
    this.currentLang = localStorage.getItem('appLang') || 'de';
  }

  setLang(lang) {
    if (translations[lang]) {
      this.currentLang = lang;
      localStorage.setItem('appLang', lang);
      this.updateDOM();
    }
  }

  t(key) {
    return translations[this.currentLang][key] || translations['de'][key] || key;
  }

  updateDOM() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const translated = this.t(key);
      if (el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'password' || el.type === 'url')) {
        el.placeholder = translated;
      } else {
        const icon = el.querySelector('i');
        if (icon) {
          el.innerHTML = '';
          el.appendChild(icon);
          el.appendChild(document.createTextNode(' ' + translated));
        } else {
          el.textContent = translated;
        }
      }
    });
  }
}

window.i18n = new I18n();
