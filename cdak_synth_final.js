// cdak FINAL (quite & orange, September 2010) — software synth
//
// Transliterated from the x86/x87 synth thread (0x420648) of
// cdak_final_1024x768.exe.  The final is a different synth from the party
// version: 31 additive automation segments evaluated every 32 samples, 32
// voices built from 6 "oscStep" units (phase accumulator + pulse/cosine shape
// + tanh Pade approximant), Catmull-Rom interpolated LCG noise, a 24-tap
// modulated delay with band-pass feedback, and a 252 s runtime.
//
// Output: 44100 Hz stereo 16-bit.  It also produces the 16 floats that the
// pixel shaders receive as constants c1..c4: h = (level, t, 0, 0),
// m = camera rotation (4), q = camera position + fov (4), c4 = 0.
//
// createSynthFinal() is self-contained (see cdak_synth.js for why).

export function createSynthFinal() {
  const f = Math.fround;

  // ---- constants (the final's float constants have 16-bit mantissas)
  const LAC      = 1.953125;               // noise lacunarity
  const INV_SR   = f(2.2649765014648438e-05);
  const TWO_PI_T = 6.28125;
  const C_13359  = 1.3359375;
  const C_0250   = f(0.0250244140625);
  const C_00150  = f(0.00150299072265625);
  const C_0835   = f(0.08349609375);       // ~1/12
  const C_01904  = f(0.01904296875);
  const EPS      = f(1.0028870095490916e-18);
  const C_2754   = f(0.275390625);
  const C_09609  = f(0.9609375);
  const C_1_24   = f(0.041748046875);
  const C_00995  = f(0.00994873046875);    // ~440/44100
  const C_00235  = f(0.002349853515625);
  const C_03589  = f(0.035888671875);

  // ---- tables (from .data)
  // automation segments: [A index, t0, t1, a, b, exponent]; A[idx] += a + (b-a)*pow(smoothstep(t0,t1,t), e)
  const SEG = [
    [5,17,24,0.5,f(0.1),2],[5,25,37,0,f(0.9),3],[5,70,110,0,f(-0.666),1],[5,120,240,0,1,1],
    [14,30,40,4.25,6,1],[14,100,120,0,-5.5,3],[14,120,150,0,10,1],
    [0,0,29,0,-14,1],[0,7,33,0,31,24],[0,31,36,0,4,f(0.55)],[0,0,210,0,119,1],[0,200,210,0,-6,1],
    [12,10,33,0,1,9],[13,0,80,1,0.5,5],
    [10,19,27,f(12.566370964050293),705600,18],[11,24,35,f(50.26548385620117),352800,18],
    [1,35,75,0,1,f(1.9)],[6,56,75,1,1.5,4],
    [3,0,35,16,12,4],[3,40,59,0,f(-11.9),1],[3,59,87,0,2,f(1.55)],[3,87,105,0,-2,1],[3,100,220,0,f(4.7),1],
    [9,100,220,0,4,1],[6,208,246,0,-1.5,3],[7,60,90,0,f(0.4),2],[7,110,220,0,-0.25,f(0.333)],
    [8,18,24,0,f(0.384),5],[8,25,38,0,f(-0.224),10],[8,70,83,0,f(0.16),10],[10,130,160,0,-264600,1]];
  // camera parameters (m.xyzw, q.xyzw): [c0, c1, noise offset D]
  const CTL = [[f(0.666),f(1.909859299659729),0x20],[0.75,f(1.909859299659729),0x18],[f(0.333),f(2.8647890090942383),0x40],
               [0,0,0],[1,f(0.2),0x22],[1,1,0x13],[1,0.25,0x1e],[f(1.6180340051651),1,0x3a]];
  // per-voice noise-modulated parameters: [A, B, C, D, E, F octaves]; N = A + (B-A)*noise(C*X0, ...)
  const VP = [[0,1,1,0x28,0xa8,4],[f(0.666),1,1,0x20,0xa8,4],[f(0.9999899864196777),f(1.0000100135803223),2,0x18,0x80,4],
              [132300,22050,1,0x10,0xa2,4],[1984500,44100,1,0x60,0xa2,4],[0,f(0.3),1,0x25,0x94,4],
              [0,1,1,0x1d,0x96,6],[0,128,4,0x30,0x90,6],[-0.5,0.5,1,0x63,0x80,6]];
  // note delta pattern (0x421220), positions 0..179 used (wraps 180 -> 68)
  const PATTERN = new Int8Array([
    -12,12,0,0,-12,12,0,0,-12,12,0,0,-12,12,0,0,-12,12,0,0,-12,12,0,0,-12,12,7,5,-12,12,10,7,-10,12,2,-2,
    -12,12,7,5,-12,12,8,-8,-12,12,5,-5,-10,12,3,-3,-12,12,10,-10,2,-2,7,5,2,-2,7,5,12,12,12,12,6,8,4,4,
    8,4,4,4,4,8,4,4,8,4,4,4,12,7,5,12,7,5,7,5,3,4,5,12,3,4,5,12,-7,4,3,5,4,3,5,12,4,3,7,5,5,4,3,12,
    10,3,4,13,4,3,4,13,4,3,4,13,2,5,5,13,6,4,3,14,3,4,3,14,3,4,3,14,3,4,3,14,10,4,3,14,3,4,3,14,3,4,3,14,
    3,4,3,14,10,4,3,14,3,4,3,14,3,4,3,14,3,4,3,14]);

  function rint(x) {                       // x87 FISTP, round half to even
    const fl = Math.floor(x), d = x - fl;
    if (d < 0.5) return fl;
    if (d > 0.5) return fl + 1;
    return (fl % 2 === 0) ? fl : fl + 1;
  }

  // ---- noise table: 65536 floats in [0,1) (main thread, 0x420257)
  const NOISE = new Float32Array(65536);
  let seed = 0xfffffedd | 0;
  for (let k = 0; k < 65536; k++) {
    seed = (seed + 0x27d4eb2d) | 0;
    seed = ((seed >>> 2) | (seed << 30)) | 0;
    seed = (seed ^ 0xffff0000) | 0;
    NOISE[k] = (seed >>> 0) * 2 ** -32;
  }

  // ---- voices: 32 records of 48 floats (0xc0 bytes) at 0x431f10
  //   6 oscillators of 5 words {phase, inc, w, out, wrapped(int)} at 0,5,10,15,20,25
  //   30: counter (int), 31: level scale, 32..40: N[0..8]
  const VS = 48;
  const VB = new ArrayBuffer(32 * VS * 4);
  const V = new Float32Array(VB), VI = new Int32Array(VB);
  for (let i = 0; i < 32; i++) { V[i * VS + 0] = 1; V[i * VS + 2] = 0.5; V[i * VS + 5 + 2] = 0.5; }

  // ---- globals
  const A = new Float32Array(32);          // automation values (0x433840)
  const P = new Float32Array(16);          // shader constants being built (0x433800)
  const SNAP = new Float32Array(16);       // snapshot handed to the renderer (0x4337c0)
  const TAP = new Float32Array(25);        // delay tap LFO phases (0x433760 + 4k)
  const DL = new Float32Array(131072);     // delay line (0x4338c0)
  let W = 0;                               // delay write index (0x433710)
  let stepCounter = 0, patPos = 0, note = 0;   // 16-bit (0x433714, 0x433718, 0x43371c)
  let lp1 = 0, lp2 = 0;                    // 0x433720, 0x433724
  let G2c = 0, L = 0, R = 0;               // 0x43372c, 0x433730, 0x433734
  let nSamp = 0;                           // 0x4b38c0
  let t = 0;                               // 0x431f0c
  const dbg = {};
  const self_ = { onNoteOn: null };

  // 0x4203dc: clamp in place (NaN passes)
  function clamp(v, lo, hi) { if (v < lo) v = lo; else if (v > hi) v = hi; return v; }

  // 0x420436: smoothstep(0,1,x) of a float32 argument
  function S01(x) { x = clamp(f(x), 0, 1); return ((3 - (x + x)) * x) * x; }

  // 0x42050b: multi-octave Catmull-Rom noise.  x float32, F octaves,
  // centered subtracts .5, D/E per-parameter table offset and octave gain.
  function fractal2(x, F, centered, D, E) {
    if (F === 0) return 0;
    const fD = (D << 8) & 0xffff, off = centered ? 0.5 : 0;
    let amp = 1, sum = 0;
    for (let j = 0; j < F; j++) {
      amp = f((E * amp) * 0.00390625);
      const s = fD + x;
      const n = Math.floor(s);
      const N2 = NOISE[(n + 2) & 0xffff], N1 = NOISE[(n + 1) & 0xffff],
            N0 = NOISE[n & 0xffff], Nm1 = NOISE[(n - 1) & 0xffff];
      const fr = s - n;
      const A_ = f(Nm1 * 0.5), B_ = f(N2 * 0.5);
      const T3 = (((1.5 * N0 - A_) - 1.5 * N1) + B_) * fr;
      const c2 = (((Nm1 - 2.5 * N0) + 2 * N1)) - B_;
      const Y = T3 + c2;
      const c1 = 0.5 * N1 - A_;
      const val = ((fr * c1) + (Y * (fr * fr))) + N0;
      sum = f(((val - off) * amp) + sum);
      x = f(x * LAC);
    }
    return sum;
  }

  // 0x42046c: advance oscillator at V[p..p+4] and return its shaped output
  //   inc = clamp(inc,0,.5); phase += inc (wrap at 1, flag); v = w - (1-w)cos(2pi(phase+a1));
  //   out = tanhPade(v*a2*1.3359375)
  function oscStep2(p, a1, a2) {
    const inc = clamp(V[p + 1], 0, 0.5);
    V[p + 1] = inc;
    const ph = inc + V[p];
    V[p] = ph;
    VI[p + 4] = (ph >= 1) ? 1 : 0;
    if (ph >= 1) { do { V[p] = f(V[p] - 1); } while (V[p] >= 1); }
    const L_ = f(1 - V[p + 2]);
    const arg = f((V[p] + a1) * TWO_PI_T);
    let x = V[p + 2] - Math.cos(arg) * L_;
    V[p + 3] = x;
    x = (x * a2) * C_13359;
    const sq = x * x;
    const r = (x * (sq + 27)) / (9 * sq + 27);
    V[p + 3] = r;
    return r;
  }

  // 0x420409: note wrapping helper (16-bit arithmetic)
  function wrapNote(dx, step) {
    dx = (dx << 16) >> 16;
    if (dx > 0) { while (note >= dx) note = ((note - step) << 16) >> 16; }
    else { const lim = -dx; while (note < lim) note = ((note + step) << 16) >> 16; }
  }

  const out = { l: 0, r: 0 };
  function sample() {
    const ctl = (nSamp & 0x1f) === 0;
    t = f(nSamp * INV_SR);
    if (ctl) {
      // ---- automation (every 32 samples)
      A.fill(0);
      for (let k = 0; k < SEG.length; k++) {
        const s = SEG[k];
        const uf = f(S01(f((t - s[1]) / (s[2] - s[1]))));
        const p = (uf === 0) ? 0 : f(Math.pow(uf, s[5]));
        A[s[0]] = (A[s[0]] + p * (s[4] - s[3])) + s[3];
      }
      for (let i = 0; i < 8; i++) {
        const scale = (i < 4) ? A[5] : (i === 7 ? 1 : A[14]);
        const c = CTL[i];
        const x = f((c[0] * t) * C_0250);
        const n = fractal2(x, 4, i !== 7 ? 1 : 0, c[2], 0xa6);
        P[4 + i] = (n * c[1]) * scale;
      }
      P[10] = A[0] + P[10];
    }
    P[0] = (G2c * C_03589) + (((A[3] + A[6]) - 1) * C_00150);
    P[1] = t;
    SNAP.set(P);
    G2c = 0; L = 0; R = 0;

    for (let i = 1; i <= 32; i++) {
      const b = (i - 1) * VS, N = b + 32;
      const vi = f(i * 0.03125);
      const X0 = f(vi * 100 + t * 0.5);
      const E1 = f(S01(f(0.5 + V[b])));
      const o0 = oscStep2(b, 0, V[N + 1]);
      G2c = f(G2c + o0);
      const L18 = f(((V[b + 31] * o0) * o0) * o0);
      const o2 = f(oscStep2(b + 10, 0, f(E1 * V[N + 5])));
      const o1 = oscStep2(b + 5, 0, f(V[N + 6] * E1));
      oscStep2(b + 20, o2, f(o1 * (A[3] + A[6]) + A[1]));
      const o5 = f(oscStep2(b + 25, f(V[b + 23] + o2), L18));
      const o3 = oscStep2(b + 15, o2, f(A[7] * L18));
      const S_ = ((o3 + o5) * A[6]) * 3776;
      const pan = V[N + 8] * A[13] + 0.5;
      L = f(pan * S_ + L);
      R = f((1 - pan) * S_ + R);

      if (VI[b + 4] !== 0) {
        // ---- note on: advance the shared sequencer, pick pitch
        VI[b + 30] = 0;
        V[b] = 0;
        let hi = 0;
        if (98 > t) patPos &= 3; else hi = 1;
        let delta;
        if ((stepCounter & 1) === 0) { delta = PATTERN[patPos]; patPos = (patPos + 1) & 0xffff; } else delta = 12;
        note = ((note + delta) << 16) >> 16;
        const M = ((((rint(A[9]) + 2) & 0xffff) * 12) & 0xffff);
        wrapNote(M, M);
        let dx = 0;
        if (stepCounter === 0) dx = 24; else if (stepCounter > 1) dx = (-30 * hi) & 0xffff;
        wrapNote(dx, 12);
        if (patPos >= 180) patPos = (patPos - 112) & 0xffff;
        stepCounter = (stepCounter + 1) & 7;
        if (self_.onNoteOn) self_.onNoteOn(nSamp, i - 1, note, patPos, stepCounter);
        const rp = V[N + 7] * A[12];
        const e_ = f((((note - rp) * A[1] + rp) - 48) * C_0835);
        const freq = f(Math.pow(2, e_));
        const inc5d = freq * C_00995;
        V[b + 26] = inc5d;
        V[b + 31] = S01(f((C_00235 / inc5d) * 0.75 + 0.5));
      }
      // ---- per-voice parameter update (every 32 samples, and right after note on)
      const cnt = VI[b + 30];
      VI[b + 30] = cnt + 1;
      if ((cnt & 0x1f) === 0) {
        for (let k = 0; k < 9; k++) {
          const q = VP[k];
          const n = fractal2(f(q[2] * X0), q[5], 0, q[3], q[4]);
          V[N + k] = (q[1] - q[0]) * n + q[0];
        }
        const Lp = (A[11] - A[10]) * V[N] + A[10];
        V[b + 1] = 1 / Lp;                                   // envelope rate
        V[b + 11] = 1 / V[N + 3];                            // slow osc rate
        V[b + 6] = 1 / V[N + 4];
        const inc4 = f((((vi + vi) + (1 - (vi + vi)) * A[1]) * V[b + 26]) * V[N + 2]);
        V[b + 21] = inc4;
        const n2 = fractal2(f((t - 96) * vi), 8, 0, 0x90, 0x90);
        V[b + 16] = ((4 - rint(n2 * -9)) * 2) * inc4;         // modulator: integer ratio
      }
    }

    // ---- stereo taps, 24-tap modulated delay, band-pass feedback
    const mask = 0x1ffff;
    const mix = ((L + R) * A[8]) + EPS;
    const Ln = f((L - DL[(W - 0x8090) & mask]) + DL[(W - 0x54b4) & mask]);
    const Rn = f(R + (DL[(W - 0x84b4) & mask] - DL[(W - 0x5090) & mask]));
    L = Ln; R = Rn;
    let acc = 0;
    for (let k = 1; k <= 24; k++) {
      const u = k * C_1_24;
      // quirk of the original: TAP[24] is stored at 0x4337c0 = SNAP[0] (h.x)
      let ph = INV_SR * u + (k === 24 ? SNAP[0] : TAP[k]);
      if (!(ph < 1)) ph = ph - 1;
      if (k === 24) SNAP[0] = ph; else TAP[k] = ph;
      let tri = ph;
      if (!(0.5 > ph)) tri = 1 - ph;
      const Dd = (((1 - u * u) * 41728) + NOISE[k] * 4096) + tri * 352;   // fmul st(2) is u*u here
      const idx = (W - rint(Dd) - 0x800) & mask;
      acc = acc + u * DL[idx];
    }
    const M2 = mix + acc * C_2754;
    const v1 = lp1 + (M2 - lp1) * C_09609; lp1 = f(v1);
    const v2 = lp2 + (v1 - lp2) * C_01904; lp2 = f(v2);
    DL[W] = v1 - v2;
    W = (W + 1) & mask;
    nSamp++;
    let l = rint(L), r = rint(R);
    out.l = l > 32767 ? 32767 : (l < -32767 ? -32767 : l);
    out.r = r > 32767 ? 32767 : (r < -32767 ? -32767 : r);
    dbg.acc = acc; dbg.mix = mix;
  }

  // render n frames; h (Float32Array, 16 floats per entry) recorded every hEvery frames
  function render(n, left, right, h, hEvery, hOffset) {
    const isInt = left instanceof Int16Array;
    let j = (hOffset || 0) * 16;
    for (let i = 0; i < n; i++) {
      sample();
      if (isInt) { left[i] = out.l; right[i] = out.r; }
      else { left[i] = out.l * (1 / 32768); right[i] = out.r * (1 / 32768); }
      if (h && (i % hEvery) === 0) { h.set(SNAP, j); j += 16; }
    }
  }

  self_.render = render;
  self_.HSIZE = 16;
  Object.defineProperty(self_, 'samplePos', { get: () => nSamp });
  Object.defineProperty(self_, 'h', { get: () => Float32Array.from(SNAP) });
  self_._state = () => ({ nSamp, t, V, VI, A, P, SNAP, TAP, DL, W, stepCounter, patPos, note, lp1, lp2, G2c, L, R,
                          acc: dbg.acc, mix: dbg.mix });
  return self_;
}

export const SAMPLE_RATE = 44100;
export const FINAL_LENGTH = 252;
