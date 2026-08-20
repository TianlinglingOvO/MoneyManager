(function () {
  try {
    document.documentElement.dataset.theme = "warm-paper";
    document.documentElement.dataset.density = "comfortable";
    document.documentElement.dataset.background = "paper";
    document.documentElement.style.setProperty("--accent", "#B85C3B");
    var value = JSON.parse(localStorage.getItem("money-manager.appearance.v1") || "null");
    if (!value) return;
    if (["warm-paper", "porcelain", "sage-ledger", "ink-night"].indexOf(value.preset) >= 0) {
      document.documentElement.dataset.theme = value.preset;
    }
    if (["comfortable", "compact"].indexOf(value.density) >= 0) {
      document.documentElement.dataset.density = value.density;
    }
    if (["plain", "paper", "linen", "mist"].indexOf(value.backgroundPreset) >= 0) {
      document.documentElement.dataset.background = value.backgroundPreset;
    }
    if (/^#[0-9a-fA-F]{6}$/.test(value.accent || "")) {
      document.documentElement.style.setProperty("--accent", value.accent);
      var red = parseInt(value.accent.slice(1, 3), 16);
      var green = parseInt(value.accent.slice(3, 5), 16);
      var blue = parseInt(value.accent.slice(5, 7), 16);
      var brightness = (red * 299 + green * 587 + blue * 114) / 1000;
      document.documentElement.style.setProperty("--on-accent", brightness > 150 ? "#000000" : "#FFFFFF");
    }
  } catch (_) {
    // A broken preference cache must never prevent the app from opening.
  }
}());
