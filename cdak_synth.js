// cdak (quite & orange, Chaos Constructions 2010) — software synth
//
// Transliterated from the x86/x87 synth thread (0x4205d7) of cdak_1024x768.exe
// (audio by brothomstates, code by ized).  Every float32 store of the original
// is reproduced with Math.fround, so the output matches the original (run with
// the Windows default x87 precision, 53 bit) essentially bit for bit.
//
// Audio: 44100 Hz, stereo, 16-bit.  The synth also produces the four visual
// parameters "h" used by the pixel shaders:
//   h.x = average voice level, h.y = time (s), h.z / h.w = slow accumulators.
//
// createSynth() is deliberately self-contained (no outer closure references)
// so that it can be serialized with Function.prototype.toString() into a
// Blob-URL Web Worker (this makes the intro work from file:// as well).

(function (root) {
'use strict';

function createSynth() {
  const f = Math.fround;

  // ---- float32 constants, exact values from the data segment (0x420e1c..)
  const TWO_PI     = f(6.2831854820251465);   // 0x40c90fdb
  const F1618      = f(1.6180000305175781);   // noise lacunarity (golden ratio)
  const F307       = f(307.6659851074219);    // noise coordinate step per call
  const F0833      = f(0.0833333358168602);   // 1/12
  const F0626894   = f(0.06268937885761261);  // 2*pi*440/44100 (A4 = note 43)
  const F0343643   = f(0.034364260733127594); // 1/29.1
  const F00666667  = f(0.006666666828095913); // 1/150
  const F00555556  = f(0.0055555556900799274);// 1/180
  const F0333333   = f(0.03333333507180214);  // 1/30
  const F00454545  = f(0.04545454680919647);  // 1/22
  const F0025      = f(0.02500000037252903);  // 1/40
  const F005       = f(0.05000000074505806);  // 1/20
  const F001836    = f(0.018360000103712082);
  const F000425    = f(0.0042500002309679985);
  const F000036375 = f(0.00036375000490806997);
  const F1e5       = f(9.999999747378752e-06);
  const F376991    = f(3.769911289215088);    // 1.2*pi
  const F125664    = f(1.2566370964050293);   // 0.4*pi
  const F0002      = f(0.0020000000949949026);
  const F0001      = f(9.999999747378752e-05);
  const F352799    = f(352799.0);
  const F793700    = f(793700.0);
  const F22050     = f(22050.0);
  const F32765     = f(32765.0);
  const F1_4       = f(1.399999976158142);
  const F1_5       = f(1.5);
  const F37        = f(37.0);
  const F0875      = f(0.875);
  const F0125      = f(0.125);
  const F072       = f(0.7200000286102295);
  const F008       = f(0.08000000566244125);
  const F09        = f(0.8999999761581421);
  const F0003      = f(0.003000000026077032);
  const F028       = f(0.2800000011920929);
  const F05        = f(0.5);
  const F025       = f(0.25);
  const F100       = f(100.0);
  const F10        = f(10.0);
  const INV44100   = 2.2675736961451248e-05;  // double (0x420ff0)
  const T_29_1     = 1283310.016822815;       // double, in samples (~29.1 s)
  const T_150      = 6615000.0;               // double, in samples (150 s)

  // 52-step note-delta pattern (0x420f70)
  const PATTERN = new Int8Array([
    0x0c,0xf4,0xf4,0x18,0xf4,0xf4,0x0c,0x0c,0xf4,0x04,0x03,0x05,0x0c,0x05,0x07,0xf4,
    0xf4,0xfc,0x04,0x07,0x05,0x07,0x07,0x05,0xed,0xfe,0xfd,0x05,0xf9,0xf1,0x0f,0xf1,
    0x0c,0xf4,0x0f,0x04,0x03,0x05,0x07,0x05,0x05,0xf4,0x07,0x05,0x05,0x07,0xfb,0x0c,
    0xe8,0x05,0x10,0xf9].map(b => (b << 24) >> 24));

  // x87 FISTP: round to nearest, ties to even
  function rint(x) {
    const fl = Math.floor(x), d = x - fl;
    if (d < 0.5) return fl;
    if (d > 0.5) return fl + 1;
    return (fl % 2 === 0) ? fl : fl + 1;
  }

  // voice record layout (19 floats = 0x4c bytes, 16 voices at 0x43fae8)
  const LEVEL = 0, ACTIVE = 1, PHASE = 2, INC = 3, CC = 4,
        O0P = 5, O0I = 6, F18 = 7, O1P = 8, O1I = 9,          /* 10 unused */
        O2P = 11, O2I = 12, X30 = 13, O3P = 14, O3I = 15,     /* 16 unused */
        OUT = 17, PREV = 18, VSTRIDE = 19;

  // ---- noise table: 65536 floats in [0,1) from an LCG (main thread, 0x420264)
  const NOISE = new Float32Array(65536);
  let seed = 0x0f82d387;
  for (let k = 0; k < 65536; k++) {
    seed = (Math.imul(seed, 0x15a4e353) ^ 0x7fffffff) | 0;
    NOISE[k] = (seed >>> 0) * 2 ** -32;
  }

  // ---- state (bss is zero at start; M lives in .data and starts at 24)
  const V  = new Float32Array(16 * VSTRIDE);
  const DL = new Float32Array(65536);        // delay line (0x43ffc0)
  let W = 0;                                 // delay write index, 16 bit (0x43ffbc)
  let G_t = 0, G_hz = 0, G_hw = 0;           // h.y, h.z, h.w  (0x43ffa8..)
  let G_c4 = 0, G_d0 = 0, G_d4 = 0;          // 0x47ffc4, 0x47ffd0, 0x47ffd4
  let lp1 = 0, lp2 = 0;                      // one-pole filters (0x47ffc8, 0x47ffcc)
  let stepCounter = 0, patPos = 0, note = 0, M = 24;
  let samplePos = 0;                         // double (0x47ffe8)
  let X = 0;                                 // per-voice noise coordinate ([ebp-4])
  let lastAvg = 0;                           // last average level (double)
  const dbg = { dry: 0, acc: 0 };
  const self_ = { onNoteOn: null };          // optional debug callback

  // 0x420534: linear interpolation in the noise table
  function noiseLerp(x) {                    // x is a float32 value
    const n = Math.floor(x);
    const N0 = NOISE[n & 0xffff], N1 = NOISE[(n + 1) & 0xffff];
    return N0 + (x - n) * (N1 - N0);
  }

  // 0x42056c: 11-octave fractal noise at X (lacunarity phi), advances X
  function fractalNoise(k) {
    const amp0 = f(4 / k);
    let amp = amp0, sum = 0, xx = X;
    for (let j = 0; j < 11; j++) {
      sum = f(noiseLerp(xx) * amp + sum);
      amp = f(amp0 * amp);
      xx = f(xx * F1618);
    }
    X = f(X + F307);
    return sum;
  }

  // 0x4204cd: smoothstep(0,1,x) of a float32 argument
  function S01(x) {
    if (x < 0) x = 0; else if (x > 1) x = 1;
    const x2 = x * x, x3 = x2 * x;
    return 3 * x2 - (x3 + x3);
  }

  // 0x42044f: soft clip  b*(smoothstep01(a/b+.5)-.5)
  function powish(a, b) { return (S01(f(a / b + 0.5)) - 0.5) * b; }

  // 0x420500: pow via fyl2x/f2xm1/fscale, result rounded to float32, pow(0,e)=0
  function powf(base, e) {
    if (base === 0 || base !== base) return 0;
    if (base < 0) return NaN;
    return f(Math.pow(base, e));
  }

  // 0x4204a0: note number -> phase increment in rad/sample (A4 = 43)
  function note2freq(x) { return powf(2, f((x - 43) * F0833)) * F0626894; }

  // 0x420412: reduce into (..., 2pi)
  function wrap2pi(v) { while (v >= TWO_PI) v = f(v - TWO_PI); return v; }

  // 0x4203e1: advance an oscillator {phase, inc}
  function oscStep(p) {
    V[p + 1] = wrap2pi(V[p + 1]);
    V[p] = f(V[p] + V[p + 1]);
    V[p] = wrap2pi(V[p]);
  }

  // 0x4203f8: average of the 16 voice levels (-> h.x)
  function avgLevel() {
    let s = 0;
    for (let i = 0; i < 16; i++) s += V[i * VSTRIDE + LEVEL];
    return s * 0.0625;
  }

  // ---- one sample frame (0x420640 .. 0x420d97); results in out.l / out.r
  const out = { l: 0, r: 0 };
  function sample() {
    const t = samplePos * INV44100;
    G_t = f(t);
    const Sd = S01(f(t * F0343643));                         // ramps 0..1 over 29.1 s
    G_c4 = f(Sd);
    const L_c = powf(f(Sd), 4);                              // [ebp-0xc]
    G_c4 = powf(G_c4, 64);
    G_c4 = f(G_c4 - powf(f(S01(f((G_t - 90) * F00666667))), F1_4));
    let mix = 0;                                             // [ebp-8]
    const L_24 = powf(f(S01(f((G_t - 200) * F0025))), F37);  // [ebp-0x24]
    const avg = avgLevel();
    lastAvg = avg;
    const L_18 = f(G_c4 * F0001);                            // [ebp-0x18]
    G_hw = f(L_18 * avg + G_hw);
    G_hz = f(powf(f(avg), 3) * L_18 + G_hz);
    for (let i = 0; i < 16; i++) V[i * VSTRIDE + PREV] = V[i * VSTRIDE + OUT];
    const L_30 = f(powf(f(S01(f((G_t - 60) * F00555556))), F1_5) * TWO_PI + F025);
    const Q = S01(f((G_t - 240) * F005));
    const nvoices = rint((1 - Q) * 16);                      // 16 voices, fading out 240..260 s

    if (nvoices > 0) {
      const L_10 = f(L_c * F352799 + 1);                     // [ebp-0x10]  min note length
      const L_20 = f(L_24 * F10);                            // [ebp-0x20]
      const L_3c = f(1 + L_20);                              // [ebp-0x3c]
      let xoff = 0;                                          // [ebp-0x18]
      for (let i = 0; i < nvoices; i++) {
        const b = i * VSTRIDE;
        X = f(G_t * F0333333 + xoff + L_20);                 // [ebp-4]
        let L_2c = f(G_c4 * F793700 + F100);                 // [ebp-0x2c]  max note length
        const N12 = fractalNoise(12);
        if (V[b + ACTIVE] === 0) {
          // ---- note on: new random length, advance the shared sequencer
          V[b + ACTIVE] = 1;
          V[b + INC] = f(TWO_PI / (N12 * (L_2c - L_10) + L_10));
          V[b + PHASE] = 0;
          if (samplePos > T_29_1) {
            stepCounter = (stepCounter + 1) | 0;
            if ((stepCounter & 0x1f) === 0) M += (M >= 84) ? -36 : 12;
          }
          const cl = stepCounter & 0xff;
          if ((cl & 0x3f) === 0 && samplePos > T_150) note++;
          if (cl & 1) { note += PATTERN[patPos]; patPos++; } else note += 12;
          while (note >= M) note -= M;
          if (patPos >= 52) patPos %= 52;
          if (self_.onNoteOn) self_.onNoteOn(samplePos, i, note, patPos, M, stepCounter, V[b + INC]);
          const L_14 = f(note2freq(f(noiseLerp(f(X * 1024)) * 128 - 32)));   // random pitch
          const Fn = note2freq(note);                                          // pattern pitch
          V[b + O1I] = f((Fn - L_14) * L_c + L_14);
        }
        const N6 = fractalNoise(6);
        V[b + O3I] = f(((N6 * L_3c) * F0002 + 1) * V[b + O1I]);   // detuned modulator
        const ph = V[b + INC] + V[b + PHASE];
        V[b + PHASE] = ph;
        if (!(ph < TWO_PI)) V[b + ACTIVE] = 0;                     // envelope done -> retrigger next sample
        V[b + INC] = f(V[b + INC] + L_24);
        oscStep(b + O0P); oscStep(b + O1P); oscStep(b + O2P); oscStep(b + O3P);
        const N5a = fractalNoise(5);
        V[b + CC] = f(N5a * F001836 + F000425);                    // amplitude
        const N16a = fractalNoise(16);
        V[b + O0I] = f(N16a * F000036375 + F1e5);                  // LFO rate
        const N16b = fractalNoise(16);
        V[b + F18] = f(N16b * F376991 + F125664);                  // LFO depth (voice 0's is used by all)
        const N5b = fractalNoise(5);
        V[b + O2I] = f(TWO_PI / ((L_2c - L_10) * (N5b + N5b) + L_10));
        const sinterm = Math.sin(V[b + O0P]) * V[F18];
        const im1 = ((i - 1) & 15) * VSTRIDE, ip1 = ((i + 1) & 15) * VSTRIDE;
        const L_28 = f(sinterm + (((V[im1 + PREV] + V[ip1 + PREV]) * L_30) * F025 + V[b + PREV] * F05));
        const N7 = fractalNoise(7);
        L_2c = f(N7 * TWO_PI + L_30 + F0125);
        V[b + X30] = L_2c;
        let L_34 = f(0.5 - Math.cos(V[O2P]) * 0.5);                // voice 0's slow osc
        const a1 = f((Math.sin(f(V[b + O3P] + L_28)) * L_34) * L_2c);
        L_34 = f(powish(a1, 5));
        const env = 0.5 - Math.cos(V[b + PHASE]) * 0.5;            // Hann envelope
        const lvl = f(((V[b + CC] * env) * env) * env);
        V[b + LEVEL] = lvl;
        const a2 = f(Math.sin(f((V[b + O1P] + L_34) + L_28)) * lvl);
        const pw = powish(a2, 2);
        xoff += 14057;
        V[b + OUT] = pw;
        mix = f(pw + mix);
      }
    }

    // ---- mix, 22-tap modulated feedback delay, band-pass, stereo taps
    const sc = powish(mix, 5);
    G_d0 = f((L_c * F0875 + F0125) * sc);
    const dry = f(((sc * (G_c4 + 1)) * F05) * (L_c * F072 + F008));   // [ebp-0x3c]
    let acc = 0;                                                       // [ebp-8]
    for (let k = 1; k <= 22; k++) {
      const u = f(k * F00454545);
      const r0 = rint(u * samplePos);
      const r = Math.abs((r0 & 0x1ffff) - 0x10000);                    // slow triangle modulation
      const d = (r + r) * 0.00390625 + (u * u) * F22050;
      const idx = (W - rint(d) - 15053) & 0xffff;
      acc = f(DL[idx] * u + acc);
    }
    const d1 = DL[(W - 2152) & 0xffff] - DL[(W - 13380) & 0xffff];
    G_d4 = f(d1 + G_d0);                                               // left
    const d2 = DL[(W - 14440) & 0xffff] - DL[(W - 1092) & 0xffff];
    const Wold = W;
    W = (W + 1) & 0xffff;
    G_d0 = f(G_d0 + d2);                                               // right
    const v2 = lp2 + (acc - lp2) * F09;
    lp2 = f(v2);
    const w1 = lp1 + (v2 - lp1) * F0003;
    lp1 = f(w1);
    DL[Wold] = (v2 - w1) * F028 + dry;
    if (G_d4 < -1) G_d4 = -1; else if (G_d4 > 1) G_d4 = 1;
    if (G_d0 < -1) G_d0 = -1; else if (G_d0 > 1) G_d0 = 1;
    samplePos += 1;
    out.l = rint(G_d4 * F32765);
    out.r = rint(G_d0 * F32765);
    dbg.dry = dry; dbg.acc = acc;
  }

  // Render n frames into left/right (Int16Array, or Float32Array scaled to
  // [-1,1]).  If h (Float32Array) is given, (h.x,h.y,h.z,h.w) is recorded
  // every hEvery frames starting at element index hOffset*4.
  function render(n, left, right, h, hEvery, hOffset) {
    const isInt = left instanceof Int16Array;
    let j = (hOffset || 0) * 4;
    for (let i = 0; i < n; i++) {
      sample();
      if (isInt) { left[i] = out.l; right[i] = out.r; }
      else { left[i] = out.l * (1 / 32768); right[i] = out.r * (1 / 32768); }
      if (h && (i % hEvery) === 0) {
        h[j] = f(lastAvg); h[j + 1] = G_t; h[j + 2] = G_hz; h[j + 3] = G_hw; j += 4;
      }
    }
  }

  self_.render = render;
  Object.defineProperty(self_, 'samplePos', { get: () => samplePos });
  Object.defineProperty(self_, 'h', { get: () => [f(lastAvg), G_t, G_hz, G_hw] });
  // debug: snapshot of the internal state (mirrors the original's memory)
  self_._state = () => ({ samplePos, V, DL, W, G_t, G_hz, G_hw, G_c4, G_d0, G_d4, lp1, lp2,
                          stepCounter, patPos, note, M, dry: dbg.dry, acc: dbg.acc });
  return self_;
}

const api = { createSynth, SAMPLE_RATE: 44100 };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.CDAK = Object.assign(root.CDAK || {}, api);

})(typeof self !== 'undefined' ? self : this);
