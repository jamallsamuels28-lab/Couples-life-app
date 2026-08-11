// ============================================================
// Camera barcode scanning
// ============================================================
//
// CLAUDE.md used to list this as deliberately not built, on the grounds that
// Safari ships no BarcodeDetector and manual entry was therefore the path on
// half the phones involved. That reasoning was sound and is now out of date:
// the detector can be polyfilled in WebAssembly, so the camera works on iOS
// too. The deliberate omission was the API, not the feature.
//
// Two things are load-bearing and easy to get wrong:
//
//   1. The polyfill is only fetched when the browser has no native detector.
//      Chrome on Android pays nothing for iOS's gap.
//
//   2. getUserMedia is called before the polyfill is awaited. Safari only
//      grants camera access inside a user gesture, and an `await import()`
//      first spends the gesture on the network — the permission prompt then
//      never appears and the button looks broken.
//
// This module is pure browser plumbing: no database, no DOM beyond the <video>
// element it is handed.
// ============================================================

/** Retail barcodes only. Offering QR here would just decode posters. */
export const SCAN_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'];

// Major-pinned like @supabase/supabase-js in index.html, so decoder fixes
// arrive without a code change. The wasm binary is fetched by this module in
// turn, which is why scanning needs a connection the first time.
const POLYFILL_URL = 'https://cdn.jsdelivr.net/npm/barcode-detector@3/pure/+esm';

// How often to run the decoder. Every animation frame would run a wasm decode
// 60 times a second and cook the phone for no gain — a barcode held in front
// of a camera is not going anywhere in 100ms.
const DECODE_INTERVAL_MS = 100;

let detectorModulePromise = null;

/**
 * Whether camera scanning is worth offering at all.
 *
 * Deliberately does not test for BarcodeDetector: its absence is what the
 * polyfill exists to cover. What cannot be worked around is the absence of a
 * camera API, or an insecure origin — getUserMedia is unavailable outside a
 * secure context, which on this app means anything other than the GitHub Pages
 * origin or localhost.
 */
export function isCameraAvailable() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (!navigator.mediaDevices?.getUserMedia) return false;
  return window.isSecureContext !== false;
}

/**
 * A BarcodeDetector, native where the browser has one and polyfilled where it
 * does not. The module promise is cached so the wasm is fetched once per load.
 *
 * @param {string[]} [formats]
 * @returns {Promise<{detect: (source: any) => Promise<Array<{rawValue: string}>>}>}
 */
export async function loadDetector(formats = SCAN_FORMATS) {
  if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
    return new window.BarcodeDetector({ formats });
  }

  if (!detectorModulePromise) {
    detectorModulePromise = import(/* @vite-ignore */ POLYFILL_URL).catch((error) => {
      // Do not cache a failure — a scan attempted back on a connection should
      // be able to try again rather than inherit one bad load for the session.
      detectorModulePromise = null;
      throw error;
    });
  }

  const module = await detectorModulePromise;
  return new module.BarcodeDetector({ formats });
}

/** Turns a getUserMedia rejection into something worth showing a person. */
function cameraErrorMessage(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission was refused. Allow it in your browser settings, or type the number instead.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera found on this device. Type the number instead.';
    case 'NotReadableError':
      return 'The camera is already in use by another app.';
    default:
      return 'Could not start the camera. Type the number instead.';
  }
}

/**
 * Drives one <video> element as a barcode scanner.
 *
 * @param {Object} options
 * @param {HTMLVideoElement} options.video
 * @param {(code: string) => void} options.onResult  called once, then scanning stops
 * @param {(message: string) => void} [options.onStatus]
 * @returns {{start: () => Promise<boolean>, stop: () => void, isRunning: () => boolean}}
 */
export function createBarcodeScanner({ video, onResult, onStatus = () => {} }) {
  let stream = null;
  let running = false;
  let timer = null;

  function stop() {
    running = false;
    clearTimeout(timer);
    timer = null;

    // Stopping every track is what actually releases the camera. Clearing
    // srcObject alone leaves the indicator light on, which reads as the app
    // watching you after you thought you had closed it.
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    if (video) {
      video.srcObject = null;
      video.hidden = true;
    }
  }

  async function start() {
    if (running) return true;

    let detector;
    try {
      // Issued before the polyfill is awaited — see the note at the top.
      const streamPromise = navigator.mediaDevices.getUserMedia({
        // `ideal` rather than `exact`: a laptop with only a front camera should
        // still scan, badly, rather than throw OverconstrainedError.
        video: { facingMode: { ideal: 'environment' } },
      });
      const detectorPromise = loadDetector();

      try {
        stream = await streamPromise;
      } catch (error) {
        onStatus(cameraErrorMessage(error));
        return false;
      }

      try {
        detector = await detectorPromise;
      } catch {
        stop();
        onStatus('Could not load the barcode reader. Check your connection, or type the number instead.');
        return false;
      }
    } catch {
      onStatus('Could not start the camera. Type the number instead.');
      return false;
    }

    video.srcObject = stream;
    // Unhidden before play(): iOS refuses to play a display:none video, and
    // `hidden` is display:none.
    video.hidden = false;
    video.setAttribute('playsinline', '');
    video.muted = true;

    try {
      await video.play();
    } catch {
      // Autoplay can reject even with a gesture; the frames still arrive.
    }

    running = true;
    onStatus('Point the camera at the barcode.');

    const tick = async () => {
      if (!running) return;
      try {
        const codes = await detector.detect(video);
        const value = codes?.[0]?.rawValue;
        if (value) {
          stop();
          onResult(String(value));
          return;
        }
      } catch {
        // A frame that fails to decode is the normal case, not an error.
      }
      if (running) timer = setTimeout(tick, DECODE_INTERVAL_MS);
    };

    timer = setTimeout(tick, DECODE_INTERVAL_MS);
    return true;
  }

  return { start, stop, isRunning: () => running };
}
