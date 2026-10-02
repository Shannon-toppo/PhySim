// Entry point of the stand-alone monitor window (media/monitors.html), opened
// when `physim.monitors.openInNewWindow` is on. The host sends the screen
// messages here instead of to the main panel while this window is open; the
// rendering is the same mcScreen.js the panel uses.

import { applyScreenConfig, applyScreenFrame } from "./mcScreen.js";
import { requestScreens } from "./monitorMessaging.js";

window.addEventListener("message", e => {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === "screenConfig") applyScreenConfig(Array.isArray(msg.screens) ? msg.screens : []);
  else if (msg.type === "screenFrame") applyScreenFrame(Array.isArray(msg.commands) ? msg.commands : []);
});

// Opened mid-session: paint what is already running instead of waiting for
// the next screen config.
requestScreens();
