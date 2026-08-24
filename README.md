# cdak (webgl port)

A JavaScript / WebGL2 / WebAudio port of **cdak** by quite & orange
(4k intro, Chaos Constructions 2010 — shader: unc, audio: brothomstates,
code: ized), reconstructed by disassembling the 4 KB executables.

Two releases exist and both are ported:

* **party** (`cdak_1024x768.exe`, the compo version) — the default.
* **final** (`cdak_final_*.exe`, 19 Sep 2010) — the well known bright
  blue/white version, 252 s; different synth, different scene/tone mapping.
  `#final`.

Files:

| file | what |
|---|---|
| `index.html` | launcher (version picker over a live frame of the intro) · `space` pauses · `←` / `→` skip 5 s (jumping ahead of what the synth has generated waits for it) · `f` fullscreen · `esc` stops and returns to it |
| `cdak.js` | the pixel shaders of both versions (HLSL → GLSL ES 3.00), WebGL2 two-pass renderer, worker-based audio streaming |
| `cdak_synth_final.js` | the final's software synth, transliterated from the x87 code; bit-exact with the original |
| `cdak_synth.js` | the party version's synth; bit-exact with the original |
| `h_table_final.js`, `h_table.js` | optional: precomputed shader constants every 0.1 s, used for the launcher's background frame and `?t=` debugging; imported on demand, only for the selected version |

Version: the dropdown on the start screen, or `#final` / `#party` in the URL.  Other URL parameters: `?w=1024&h=768` fixed render size
(letterboxed), `?dpr=2` render at device pixels, `?t=120` render one frame at
that time without audio.  The sources are ES modules, so the page has to be
served over http(s) — `python3 -m http.server` in this directory, then
<http://localhost:8000/> — rather than opened from `file://`.  Needs WebGL2 with
`EXT_color_buffer_float` (falls back to an 8-bit render target otherwise).

## How the originals work

The executables are packed with Crinkler 1.2.  The PE header doubles as the
decompressor stub and as the table of import *hashes* (Crinkler 1.x stores
each import's name hash in the dwords of the header; header fields that are
forced by the PE format become unused IAT slots).  The stub decompresses
~8 KB of code+data to `0x420000` and returns into an import loader that walks
the PEB for kernel32 and resolves everything by `rol 6 / xor` name hash:

* kernel32: `CreateThread ExitProcess LoadLibraryA Sleep` (+`lstrlenA` party,
  `SuspendThread ResumeThread` final)
* user32: `CreateWindowExA GetAsyncKeyState` (+`SetFocus ShowWindow` party, `ShowCursor` final)
* d3d9: `Direct3DCreate9` — d3dx9_37: `D3DXCompileShader`
* winmm: `waveOutOpen waveOutPrepareHeader waveOutWrite waveOutGetPosition`

Main thread: `CreateWindowExA("edit", WS_POPUP|WS_VISIBLE, 1024×768)`,
`Direct3DCreate9(32)`, full-screen `CreateDevice` (X8R8G8B8, vsync), compiles
one HLSL source twice with `D3DXCompileShader(..., "p0"/"p1", "ps_3_0")`,
creates an `A16B16G16R16F` 1024×768 render-target texture (linear filtering,
wrap), `SetFVF(D3DFVF_XYZRHW)`, fills a 65536-entry noise table with an LCG,
opens a 44.1 kHz 16-bit stereo `waveOut` with one looping buffer (party: 4
chunks of 2000 frames; final: 8 chunks of 1024 frames) and starts the synth
thread.  Per frame: shader constants (`c0` = resolution, `c1` = `h` =
(level, t, ..); final adds `c2` = `m` camera rotation, `c3` = `q` camera
position/fov, copied from the synth thread while it is suspended), pass 0
draws one big XYZRHW triangle with `p0` into the float texture, pass 1 draws
it with `p1` into the back buffer, `Present`, `GetAsyncKeyState(VK_ESCAPE)`.
The final exits by itself at t = 252 s; the party version runs until ESC (the port returns to the launcher at 300 s, when its soundtrack has died out).

Synth thread: polls `waveOutGetPosition` and refills the chunk that just
finished playing.

* *party*: 16 voices, each a Hann-windowed note whose length is random
  (11-octave fractal noise over the LCG table, lacunarity φ); when a voice's
  envelope wraps it re-triggers and advances a *shared* sequencer (52-step
  delta pattern, modulus 24→36→…→84→48→…, pitch lerped from random to the
  pattern over the first 29 s).  4 oscillators per voice with phase
  modulation, self- and cross-voice feedback, soft clipping; a 22-tap delay
  network with slow triangle modulation and band-pass feedback; voices fade
  out at 240–260 s.
* *final*: 31 additive automation segments (`A[i] += a + (b-a)·smoothstep(t0,t1,t)^e`)
  evaluated every 32 samples drive everything (note lengths, pitch-lerp,
  levels, delay feed, camera scale); 32 voices built from 6 "oscStep" units
  (phase accumulator with wrap flag, pulse/cosine shape, tanh Padé
  approximant `x(27+x²)/(27+9x²)`), Catmull-Rom interpolated noise for the
  per-voice parameters (updated every 32 samples), a 180-step delta pattern
  limited to its first 4 entries until 98 s, FM with an integer modulator
  ratio, a 24-tap modulated delay with band-pass feedback.  The camera
  (`m`,`q`) is 8 noise-driven values scaled by automation.

## Port notes

* The synths mirror the x87 code instruction for instruction: every
  `fstp dword` is a `Math.fround`, every `fistp` rounds half-to-even, the
  exact float32 constants are used (the final's constants have 16-bit
  mantissas — e.g. 2π = 6.28125, 1/44100 = 2.2649765e-05 — so its clock runs
  0.1 % slow, as in the original).  Validated against a Unicorn emulation of
  the original thread (x87 control word 0x027F as on Windows): per-sample
  state identical for the first 3000–6000 samples, note-on events identical
  (144k events), and the 16-bit PCM identical sample for sample for every
  second compared (party: 47 s, final: 33 s at the time of writing; the
  background emulations are slow).
* Shader translation: HLSL `mul(v, M)` → GLSL `M * v` (same constructor
  order); D3D9 `pow` uses `|x|`; HLSL `smoothstep` with reversed edges is
  spelled out; D3D9 `VPOS` is an integer pixel coordinate with y down; HLSL
  implicit truncations (`float z *= float3`, `x + e` with `float2 + float4`,
  `x + e.x` scalar broadcast) and the `for(;;i++,a=...,b=...)` loops whose
  increment expressions run with i = 1,2,3 are reproduced literally — see the
  comments in `cdak.js`.
* The original reads the synth's *current* position for `t`, which runs a
  few tens of ms ahead of what is audible; the port uses the audio clock.
* One quirk kept on purpose: in the final the 24th delay tap's LFO phase
  lives at the address of the `h.x` shader constant, so the level the shader
  sees is the tap phase (level + 2.3e-5).

This port was made with Claude Fable 5.
