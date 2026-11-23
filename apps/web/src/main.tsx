import React from "react";
import { createRoot } from "react-dom/client";
function Shell() {
  return (
    <main>
      <h1>Synapse</h1>
      <p>Learning workspace</p>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Shell />
  </React.StrictMode>,
);
