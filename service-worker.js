// Casa Wawa OS — Service Worker auto-destructor
// Este SW se desinstala a sí mismo y limpia todos los cachés
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.matchAll({ includeUncontrolled: true }))
      .then(clients => {
        clients.forEach(c => c.postMessage({ type: 'SW_CLEARED' }));
        return self.registration.unregister();
      })
  );
});
// No interceptar ninguna petición — dejar pasar todo a la red
self.addEventListener('fetch', () => {});
