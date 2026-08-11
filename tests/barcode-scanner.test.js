/**
 * @vitest-environment jsdom
 *
 * Camera barcode scanning.
 *
 * The behaviours pinned here are the ones with consequences outside the app:
 * releasing the camera (an indicator light left on reads as the app watching
 * you), and asking for the camera before awaiting the polyfill (Safari only
 * grants access inside a user gesture, and spending it on a network round trip
 * means the permission prompt never appears).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { isCameraAvailable, loadDetector, createBarcodeScanner, SCAN_FORMATS } =
  await import('../js/barcode-scanner.js');

/** A MediaStream stand-in that records whether its tracks were stopped. */
function fakeStream() {
  const tracks = [
    { kind: 'video', stop: vi.fn() },
    { kind: 'audio', stop: vi.fn() },
  ];
  return { getTracks: () => tracks, tracks };
}

function fakeVideo() {
  const video = document.createElement('video');
  video.play = vi.fn(() => Promise.resolve());
  return video;
}

function stubCamera(stream = fakeStream()) {
  const getUserMedia = vi.fn(() => Promise.resolve(stream));
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
  });
  return { stream, getUserMedia };
}

function stubDetector(sequence) {
  // Each detect() call returns the next entry; the last repeats.
  let i = 0;
  const detect = vi.fn(async () => {
    const value = sequence[Math.min(i, sequence.length - 1)];
    i += 1;
    return value;
  });
  class FakeDetector {
    constructor(options) { FakeDetector.lastOptions = options; }
    detect = detect;
  }
  window.BarcodeDetector = FakeDetector;
  return { detect, FakeDetector };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  delete window.BarcodeDetector;
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
});

describe('isCameraAvailable', () => {
  it('is false with no camera API', () => {
    expect(isCameraAvailable()).toBe(false);
  });

  it('is true when getUserMedia exists in a secure context', () => {
    stubCamera();
    expect(isCameraAvailable()).toBe(true);
  });

  it('does not depend on BarcodeDetector, which Safari lacks', () => {
    // The whole reason the button never appeared on an iPhone.
    stubCamera();
    expect('BarcodeDetector' in window).toBe(false);
    expect(isCameraAvailable()).toBe(true);
  });
});

describe('loadDetector', () => {
  it('uses the native detector when the browser has one', async () => {
    const { FakeDetector } = stubDetector([[]]);
    const detector = await loadDetector();
    expect(detector).toBeInstanceOf(FakeDetector);
  });

  it('asks only for retail barcode formats', async () => {
    const { FakeDetector } = stubDetector([[]]);
    await loadDetector();
    // Scanning QR here would just decode posters and packaging URLs.
    expect(FakeDetector.lastOptions.formats).toEqual(SCAN_FORMATS);
    expect(FakeDetector.lastOptions.formats).toContain('ean_13');
  });
});

describe('createBarcodeScanner', () => {
  it('requests the camera before awaiting the detector', async () => {
    // Safari grants camera access only inside a user gesture. Awaiting the
    // polyfill import first spends that gesture on the network, and the
    // permission prompt then never appears.
    const order = [];
    const stream = fakeStream();
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn(() => { order.push('getUserMedia'); return Promise.resolve(stream); }),
      },
      configurable: true,
    });

    let resolveDetector;
    class SlowDetector {
      constructor() { order.push('detector'); }
      detect = async () => [];
    }
    Object.defineProperty(window, 'BarcodeDetector', {
      value: SlowDetector, configurable: true, writable: true,
    });

    const scanner = createBarcodeScanner({ video: fakeVideo(), onResult: () => {} });
    await scanner.start();
    scanner.stop();

    expect(order[0]).toBe('getUserMedia');
    void resolveDetector;
  });

  it('reports a refused permission in words rather than failing silently', async () => {
    const error = new Error('denied');
    error.name = 'NotAllowedError';
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn(() => Promise.reject(error)) },
      configurable: true,
    });
    stubDetector([[]]);

    const messages = [];
    const scanner = createBarcodeScanner({
      video: fakeVideo(), onResult: () => {}, onStatus: (m) => messages.push(m),
    });

    expect(await scanner.start()).toBe(false);
    expect(scanner.isRunning()).toBe(false);
    expect(messages.join(' ')).toMatch(/permission/i);
  });

  it('explains a missing camera differently from a refused one', async () => {
    const error = new Error('none');
    error.name = 'NotFoundError';
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn(() => Promise.reject(error)) },
      configurable: true,
    });
    stubDetector([[]]);

    const messages = [];
    const scanner = createBarcodeScanner({
      video: fakeVideo(), onResult: () => {}, onStatus: (m) => messages.push(m),
    });
    await scanner.start();
    expect(messages.join(' ')).toMatch(/No camera found/i);
  });

  it('stops every track when stopped, so the camera light goes out', async () => {
    const { stream } = stubCamera();
    stubDetector([[]]);

    const video = fakeVideo();
    const scanner = createBarcodeScanner({ video, onResult: () => {} });
    await scanner.start();
    expect(scanner.isRunning()).toBe(true);

    scanner.stop();

    // Clearing srcObject alone leaves the camera running.
    for (const track of stream.tracks) expect(track.stop).toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
    expect(scanner.isRunning()).toBe(false);
  });

  it('releases the camera as soon as a code is found', async () => {
    const { stream } = stubCamera();
    stubDetector([[{ rawValue: '5000112637922' }]]);

    const found = [];
    const scanner = createBarcodeScanner({
      video: fakeVideo(), onResult: (code) => found.push(code),
    });
    await scanner.start();

    await vi.waitFor(() => expect(found).toEqual(['5000112637922']));
    for (const track of stream.tracks) expect(track.stop).toHaveBeenCalled();
    expect(scanner.isRunning()).toBe(false);
  });

  it('keeps scanning through frames that do not decode', async () => {
    stubCamera();
    // Two empty frames, then a hit — the normal case, not an error path.
    const { detect } = stubDetector([[], [], [{ rawValue: '5010029000047' }]]);

    const found = [];
    const scanner = createBarcodeScanner({
      video: fakeVideo(), onResult: (code) => found.push(code),
    });
    await scanner.start();

    await vi.waitFor(() => expect(found).toEqual(['5010029000047']));
    expect(detect.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('survives a detector that throws on a frame', async () => {
    stubCamera();
    let calls = 0;
    class ThrowingDetector {
      detect = async () => {
        calls += 1;
        if (calls < 3) throw new Error('bad frame');
        return [{ rawValue: '5000112637922' }];
      };
    }
    window.BarcodeDetector = ThrowingDetector;

    const found = [];
    const scanner = createBarcodeScanner({
      video: fakeVideo(), onResult: (code) => found.push(code),
    });
    await scanner.start();

    await vi.waitFor(() => expect(found).toEqual(['5000112637922']));
  });

  it('reports a code only once', async () => {
    stubCamera();
    stubDetector([[{ rawValue: '5000112637922' }]]);

    const found = [];
    const scanner = createBarcodeScanner({
      video: fakeVideo(), onResult: (code) => found.push(code),
    });
    await scanner.start();

    await vi.waitFor(() => expect(found).toHaveLength(1));
    // Give the loop every chance to fire again if it were still running.
    await new Promise((r) => setTimeout(r, 350));
    expect(found).toHaveLength(1);
  });

  it('is safe to stop when it never started', () => {
    const scanner = createBarcodeScanner({ video: fakeVideo(), onResult: () => {} });
    expect(() => scanner.stop()).not.toThrow();
  });

  it('unhides the video before playing it', async () => {
    // iOS refuses to play a display:none video, and `hidden` is display:none.
    stubCamera();
    stubDetector([[]]);

    const video = fakeVideo();
    video.hidden = true;
    let hiddenAtPlay = null;
    video.play = vi.fn(() => { hiddenAtPlay = video.hidden; return Promise.resolve(); });

    const scanner = createBarcodeScanner({ video, onResult: () => {} });
    await scanner.start();
    scanner.stop();

    expect(hiddenAtPlay).toBe(false);
  });
});
