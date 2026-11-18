// Applied before the page draws, so a saved theme never flashes the other one.
(function () {
  try {
    var saved = localStorage.getItem('defi-tool:dashboard:theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
  } catch (e) { /* storage blocked: follow the system theme */ }
})();
