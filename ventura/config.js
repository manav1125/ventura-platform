// ventura/config.js
// Frontend runtime configuration.
// This file is served as a static asset and loaded before any JS runs.
// Edit API_URL to point to your Render API service.

window.VENTURA_CONFIG = {
  API_URL: "https://ventura-api.onrender.com",
  WS_URL:  null   // auto-derived: wss://ventura-api.onrender.com/ws
};
