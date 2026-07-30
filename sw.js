// Service worker for Fuzzy Protein.
//
// The whole app is one HTML file, so there is no asset graph to invalidate and
// no need for Workbox. Strategy is network-first for every same-origin GET:
// online you always run the newest index.html, offline you get the last copy
// that loaded. API calls go to other origins and are never touched.
//
// "Offline", though, is not the only way a network fails to answer: a captive
// portal or a connection that has dropped without saying so leaves the request
// hanging until the OS gives up on it, and a plain network-first would hold the
// app on a blank screen for all of it. So the network gets a few seconds to
// beat the copy we already have and, past that, we open with the copy. It is
// still network-first in every case where the network answers at all — the only
// launch it changes is one that would otherwise have been a long stare.

var CACHE = "protein-shell-v2";
var NET_MS = 5000;  // how long a fresher copy is worth waiting for
var SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // One bad URL must not fail the whole install.
      return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin) return;

  var net = fetch(req).then(function (res) {
    if (res && res.ok) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
    }
    return res;
  });
  // The fetch runs to completion into the cache even when the race below stops
  // waiting on it, so a slow launch still leaves the next one up to date.
  e.waitUntil(net.catch(function () {}));

  e.respondWith(
    caches.match(req).then(function (hit) {
      if (!hit) {
        // Nothing to fall back to, so there is nothing to race: the network is
        // the only answer, however long it takes.
        return net.catch(function () {
          // Deep link or a query string we never cached — fall back to the shell.
          if (req.mode === "navigate") return caches.match("./index.html");
          return Response.error();
        });
      }
      return Promise.race([
        net.catch(function () { return hit; }),
        new Promise(function (resolve) { setTimeout(function () { resolve(hit); }, NET_MS); })
      ]);
    })
  );
});
