(function () {
  try {
    var root = document.documentElement;
    var prefersDark = function () {
      return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
    };
    root.dataset.theme = "warm-paper";
    root.dataset.background = "paper";
    root.style.setProperty("--accent", "#B85C3B");
    var value = JSON.parse(localStorage.getItem("money-manager.appearance.v1") || "null");
    if (!value) return;
    if (value.preset === "ink-night" || (value.preset === "auto" && prefersDark())) {
      root.dataset.theme = "ink-night";
    }
    if (["plain", "paper", "linen", "mist"].indexOf(value.backgroundPreset) >= 0) {
      root.dataset.background = value.backgroundPreset;
    }
    if (/^#[0-9a-fA-F]{6}$/.test(value.accent || "")) {
      root.style.setProperty("--accent", value.accent);
      var red = parseInt(value.accent.slice(1, 3), 16);
      var green = parseInt(value.accent.slice(3, 5), 16);
      var blue = parseInt(value.accent.slice(5, 7), 16);
      var brightness = (red * 299 + green * 587 + blue * 114) / 1000;
      root.style.setProperty("--on-accent", brightness > 150 ? "#000000" : "#FFFFFF");
    }
  } catch (_) {
    // A broken preference cache must never prevent the app from opening.
  }
}());
