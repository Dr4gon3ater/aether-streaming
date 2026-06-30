const CACHE_NAME = 'aether-cache-v4';
const urlsToCache = [
  '/',
  '/index.html',
  '/css/style.css',
  '/css/player.css',
  '/js/main.js',
  '/js/api.js',
  '/js/app.js',
  '/js/ui.js',
  '/js/player.js',
  '/assets/logo.jpg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(urlsToCache);
      })
      .catch(err => console.warn('PWA Cache Setup failed:', err))
  );
});

self.addEventListener('fetch', event => {
  // We only want to intercept internal requests, not Xtream API calls
  if (event.request.url.includes('player_api.php') || event.request.url.includes('.ts') || event.request.url.includes('.m3u8')) {
    return;
  }
  
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Cache hit - return response
        if (response) {
          return response;
        }
        return fetch(event.request).catch(() => {
          // Fallback if offline
        });
      })
  );
});
