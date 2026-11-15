// Paste into the plug's web UI → Scripts → Create script, then Start it and
// enable "Run on startup". Works on Shelly Plus / Gen2 / Gen3 plugs.
// It watches the power draw and calls the Worker when the toaster starts/stops.

let BASE = "https://toast.benjaminbenben.com/hook/";
let TOKEN = "CHANGE-ME"; // same value as `wrangler secret put TOKEN`
let ON_WATTS = 300;      // toasters pull ~800–1500W
let OFF_WATTS = 50;      // hysteresis so it doesn't flap

let toasting = false;

function send(what) {
  Shelly.call("HTTP.GET", { url: BASE + what + "?token=" + TOKEN, timeout: 10 },
    function (res, err) { if (err) print("toast hook failed:", err); });
}

Shelly.addStatusHandler(function (e) {
  if (e.component !== "switch:0" || typeof e.delta.apower === "undefined") return;
  let w = e.delta.apower;
  if (!toasting && w > ON_WATTS) { toasting = true; send("on"); }
  else if (toasting && w < OFF_WATTS) { toasting = false; send("off"); }
});
