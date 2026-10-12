/**
 * The small script behind the audio card on an SOS tracking page. It is served
 * from the API's own origin (the page's Content-Security-Policy allows scripts
 * from 'self' only) and does two things:
 *
 *  - "Listen live": polls the chunk list, fetches each new chunk as a WAV,
 *    decodes it with Web Audio and schedules it right after the previous one,
 *    starting a few seconds behind the live edge.
 *  - Keeps the page fresh (location, status) by reloading it every 20 s, but
 *    never while someone is listening.
 *
 * Plain ES5 so old phone browsers run it. No user input is ever written into
 * the page as HTML.
 */
export const SOS_AUDIO_SCRIPT = `(function () {
  "use strict";
  var root = document.getElementById("sos-audio");
  if (!root) return;
  var base = root.getAttribute("data-base");
  var liveButton = document.getElementById("sos-live");
  var note = document.getElementById("sos-live-note");
  var player = document.getElementById("sos-player");
  var AudioCtx = window.AudioContext || window.webkitAudioContext;
  var ctx = null;
  var running = false;
  var timer = null;
  var after = -1;
  var nextTime = 0;

  function setNote(text) {
    if (note) note.textContent = text;
  }

  function getJson(path) {
    return fetch(base + path, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("http " + r.status);
      return r.json();
    });
  }

  function decode(buffer) {
    return new Promise(function (resolve, reject) {
      ctx.decodeAudioData(buffer, resolve, reject);
    });
  }

  function playChunk(seq) {
    return fetch(base + "/chunks/" + seq, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("http " + r.status);
        return r.arrayBuffer();
      })
      .then(decode)
      .then(function (audio) {
        var source = ctx.createBufferSource();
        source.buffer = audio;
        source.connect(ctx.destination);
        var at = Math.max(nextTime, ctx.currentTime + 0.15);
        source.start(at);
        nextTime = at + audio.duration;
        after = seq;
      });
  }

  function poll() {
    if (!running) return;
    var query = after < 0 ? "?tail=2" : "?after=" + after;
    getJson("/chunks" + query)
      .then(function (body) {
        var chunks = body.data.chunks;
        var chain = Promise.resolve();
        chunks.forEach(function (chunk) {
          chain = chain.then(function () {
            return running ? playChunk(chunk.seq) : null;
          });
        });
        return chain.then(function () {
          if (body.data.state === "RECORDING") setNote("Listening live");
          else setNote("The phone is not sending audio right now. Waiting…");
        });
      })
      .catch(function () {
        setNote("Connection problem. Trying again…");
      })
      .then(function () {
        if (running) timer = setTimeout(poll, 2000);
      });
  }

  function stop() {
    running = false;
    clearTimeout(timer);
    if (ctx) {
      try { ctx.close(); } catch (e) { /* already closed */ }
      ctx = null;
    }
    if (liveButton) liveButton.textContent = "Listen live";
    setNote("");
  }

  function start() {
    if (!AudioCtx) {
      setNote("This browser cannot play live audio. Use the recording below.");
      return;
    }
    if (player) player.pause();
    ctx = new AudioCtx();
    if (ctx.resume) ctx.resume();
    after = -1;
    nextTime = 0;
    running = true;
    liveButton.textContent = "Stop listening";
    setNote("Connecting…");
    poll();
  }

  if (liveButton) {
    liveButton.addEventListener("click", function () {
      if (running) stop();
      else start();
    });
  }
  if (player) {
    player.addEventListener("play", function () {
      if (running) stop();
    });
  }

  setInterval(function () {
    var listening = running || (player && !player.paused);
    if (!listening && !document.hidden) window.location.reload();
  }, 20000);
})();
`;
