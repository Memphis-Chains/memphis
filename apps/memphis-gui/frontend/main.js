// Memphis desktop — Phase G-minimal MVP frontend (vanilla JS).
//
// Wires the page to the single Tauri command exposed by `lib.rs`
// (`memphis_get_snapshot`). Phase G-mid will introduce a real
// framework (React + shadcn/ui) and a router for the 7 screens.

const { invoke } = window.__TAURI__.core;

const $ = (sel) => document.querySelector(sel);

async function refresh() {
  const snap = await invoke("memphis_get_snapshot");
  $("#phase").textContent = `phase: ${snap.phase}`;
  $("#renderer").textContent = `renderer: ${snap.renderer}`;
  $("#snapshot").textContent = JSON.stringify(snap, null, 2);
}

$("#refresh").addEventListener("click", () => {
  refresh().catch((err) => {
    $("#snapshot").textContent = `error: ${String(err)}`;
  });
});

refresh().catch((err) => {
  $("#snapshot").textContent = `error: ${String(err)}`;
});
