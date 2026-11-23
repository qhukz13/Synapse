// Load synchronously before styles so a saved palette is painted immediately.
try {
  if (localStorage.getItem("synapse.theme") === "light") {
    document.documentElement.dataset.theme = "light";
  }
} catch {
  // Restricted storage still supports the default dark theme.
}
