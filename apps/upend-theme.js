// Shared theme helper for upend apps.
// Include early in <head>. Reads ?upend_theme= from URL for initial load,
// then listens for postMessage from the parent dashboard for live changes.
(function () {
  function applyTheme(dark) {
    document.documentElement.classList.toggle('light', !dark);
  }

  // initial: read from URL param (set by dashboard's appUrl())
  var params = new URLSearchParams(location.search);
  var urlTheme = params.get('upend_theme');
  var dark = urlTheme ? urlTheme !== 'light' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(dark);

  // live: listen for theme changes from parent frame
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'upend_theme') applyTheme(e.data.darkMode);
  });
})();
