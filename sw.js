var CACHE = 'crefacil-v1';

var ASSETS = [
    './',
    'index.html',
    'styles.css',
    'app.js',
    'manifest.json',
    'logo.jpeg',
    'icon-192.png',
    'icon-512.png'
];

self.addEventListener('install', function (event) {
    event.waitUntil(
        caches.open(CACHE)
            .then(function (cache) { return cache.addAll(ASSETS); })
            .then(function () { return self.skipWaiting(); })
    );
});

self.addEventListener('activate', function (event) {
    event.waitUntil(
        caches.keys()
            .then(function (keys) {
                return Promise.all(keys.filter(function (key) { return key !== CACHE; }).map(function (key) {
                    return caches.delete(key);
                }));
            })
            .then(function () { return self.clients.claim(); })
    );
});

self.addEventListener('fetch', function (event) {
    var req = event.request;
    if (req.method !== 'GET') return;

    var url;
    try { url = new URL(req.url); } catch (e) { return; }
    if (url.origin !== self.location.origin) return;

    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req).catch(function () { return caches.match('index.html'); })
        );
        return;
    }

    event.respondWith(
        caches.match(req).then(function (cached) {
            var network = fetch(req).then(function (res) {
                if (res && res.ok) {
                    var copy = res.clone();
                    caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
                }
                return res;
            }).catch(function () { return cached; });
            return cached || network;
        })
    );
});
