// cdak (quite & orange, Chaos Constructions 2010, 4k intro) — browser port
//
// Renderer + audio streaming for both releases:
//   party  (the compo version, default) #party
//   final  (September 2010)             #final
//
// Both originals render one big triangle with two ps_3_0 pixel shaders:
// p0 raymarches the scene into an A16B16G16R16F texture and p1 post-processes
// it (edge detection, tone curve) into the back buffer.  The GLSL below is a
// direct HLSL -> GLSL ES 3.00 translation of the shader source found in the
// binaries.  The synths (cdak_synth.js / cdak_synth_final.js) run in a Web
// Worker slightly ahead of playback and also produce the per-frame shader
// constants (level, time, camera...).

(function () {
'use strict';

const SR = 44100;
const CHUNK = SR;              // 1 s of audio per worker message
const HEVERY = 128;            // record the shader constants every 128 samples
const PREBUFFER = 3;           // seconds of audio to buffer before starting

// ------------------------------------------------------------------ shaders
const VERT = `#version 300 es
void main(){
  // one triangle covering the screen (the originals draw (0,0)-(4096,0)-(0,4096))
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Shared declarations and HLSL helpers.  Notes on semantics:
//  * HLSL pow() on D3D9 compiles to the `pow` instruction which uses |x|,
//    so pw() takes abs() of the base (matters for negative occlusion values).
//  * HLSL smoothstep() allows edge0 > edge1; GLSL calls that undefined, so
//    ss() is spelled out.
//  * vp is the D3D9 VPOS: integer pixel coordinates, y down.  Texture reads
//    flip v because GL textures are stored bottom-up.
const COMMON = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform vec2 j;          // c0: resolution
uniform vec4 h;          // c1: (level, time, ., .)
uniform vec4 m;          // c2 (final): camera rotation
uniform vec4 q;          // c3 (final): camera position, fov
uniform sampler2D s;
out vec4 fragColor;
#define t h.y
float ss(float a,float b,float x){float u=clamp((x-a)/(b-a),0.,1.);return u*u*(3.-2.*u);}
float sat(float x){return clamp(x,0.,1.);}
vec3 sat3(vec3 x){return clamp(x,0.,1.);}
vec4 sat4(vec4 x){return clamp(x,0.,1.);}
float pw(float x,float y){return pow(abs(x),y);}
vec3 pw(vec3 x,float y){return pow(abs(x),vec3(y));}
vec3 pw(vec3 x,vec3 y){return pow(abs(x),y);}
vec4 tex(vec2 uv){return texture(s,vec2(uv.x,1.-uv.y));}
vec2 vpos(){return vec2(floor(gl_FragCoord.x),(j.y-1.)-floor(gl_FragCoord.y));}
`;

// ======================================================= party version shaders
// (compiled by the original with the macro t -> h.y)
const PARTY_COMMON = COMMON + `
mat3 r(vec3 g){
  g*=6.283;
  float a=cos(g.x),b=sin(g.x),c=cos(g.y),d=sin(g.y),e=cos(g.z),f=sin(g.z);
  return mat3(c*e+b*d*f,-a*f,b*c*f-d*e, c*f-b*d*e,a*e,-d*f-b*c*e, a*d,b,a*c);
}
mat3 w(){
  return r(vec3(0,0,ss(-7.,30.,t))+ss(170.,300.,t)*vec3(1,2,3)
           +sin(vec3(5,6,7)*(h.z*100.+t*.002))*.08*(2.-sin((h.z*2222.-h.w))));
}
`;

// p0: raymarcher.  float4 p0(float2 vp:vpos):color0
const PARTY_FRAG0 = PARTY_COMMON + `
float f1(vec3 p){
  vec3 g=(fract(r(sin(p.z*.07)*vec3(0,0,.3)*ss(150.,60.,p.z))*(p+sin(p.yzx*.1)/3.)/6.)-.5)*6.;
  float d1=2.4*ss(20.,70.,t)-abs(p.x)-1.,
        d2=max(abs(g.x),max(abs(g.y),abs(g.z)))-2.3,
        d3=length(p-vec3(0,0,84))-18.;
  d1=mix(d1,min(max(d1,-.7-d2),max(d2-.3,abs(d1-.9)-1.3)),sat(p.z*.03-.5+sin(p.z*.1)*.1));
  d1=max(max(d1,25.-p.z),p.z-116.);
  d1=min(min(max(d1,min(11.-abs(d3),max(-p.z+84.,abs(length(p.xy)-1.3+sin(p.z*.9)/5.)-.2))),
             max(d1+.5,abs(d3-4.)-.5))-.3*ss(60.,110.,t),
         max(111.-p.z,min(7.-length(p.xy)/2.-sin(p.z*.3+sin(p.z*2.)/25.+t/5.)*6.,
                          max(-p.x+(p.z-105.)*.1,abs(p.y)-1.8))));
  g=r(pw(ss(36.,4.,t)*vec3(1,2,3),2.)*step(-p.z,-15.))*(p-vec3(0,0,44));
  if(t<44.)d1=mix(d1,max(abs(g.x),max(abs(g.y),abs(g.z)))-4.-15.*ss(27.,36.,t),ss(44.,30.,t));
  d1=min(d1,.8*max(p.z-14.,abs(length(p.xy)-1.5-sin(floor(p.z))/5.)-1.));
  return d1;
}
float f2(vec3 p){
  p.z-=138.;
  float ln=pw(1./length(p+3.*sin(t*vec3(5.1,7.6,1)*.023)),2.)
          +pw(1./length(p+3.*sin(t*vec3(4.5,2.7,2)*.033)),2.)
          +pw(1./length(p+3.*sin(t*vec3(6.3,3.7,4)*.031)),2.)
          +pw(1./length(p+3.*sin(t*vec3(7.5,6.3,5)*.023)),2.),
        d1=1./sqrt(ln)-1.;
  d1=min(mix(d1-.7,min(abs(d1+.3)-.3,abs(d1-.7)*2.-.3),ss(150.,230.,t-p.y/9.)),
         abs(d1-5.)-1.+4.2*ss(210.,150.,t+p.y/5.))+2.*ss(230.,270.,t+p.y);
  return d1;
}
vec3 k(){
  return w()*vec3(0,.1,-.1-2.*ss(170.,190.,t))+vec3(0,0,ss(-.07,1.,t*.005)*140.);
}
float f(vec3 p){
  p+=.01;
  float d1=95.-length(p-k()),d2=f2(p);
  if(t<280.)d1=min(d1,f1(p))+14.*ss(140.,230.,t);
  if(t>130.)d1=min(d1,d2);
  d1*=.3;p*=.3;
  for(float i=0.;i<4.;i++){
    vec3 q=1.+i*i*.18*(1.+4.*(1.+.3*sin(t*.001))*sin(vec3(5.7,6.4,7.3)*i*1.145+.3*sin(h.w*.015)*(3.+i))),
         g=(fract(p*q)-.5)/q;
    d1=min(d1+.03,max(d1,max(abs(g.x),max(abs(g.y),abs(g.z)))-.148));
  }
  return d1/.28;
}
vec3 nn(vec3 p){
  vec2 e=vec2(4e-3,0);
  return -normalize(vec3(f(p+e.xyy),f(p+e.yxy),f(p+e.yyx)));
}
float u(vec3 p,vec3 y){
  float o=.8,g=f(p),d;
  for(float i=0.;i<1.;i+=.25){
    d=i*.15+.025;
    o-=float(g<.01)*(d-f(p-y*d))*2.*(2.-i*1.8);
  }
  return o;
}
void main(){
  vec2 vp=vpos();
  vec3 p=k(),a=p,
       y=w()*normalize(vec3(2.*sin((vp-.5-j/2.)/j.y),cos(length((vp-.5-j/2.)/j.y/2.)*2.*sqrt(2.))));
  float g=0.,df=f(p)+.002;
  for(float i=0.;i<90.&&abs(df)>.00032;i++){
    g+=ss(.5,.07,df)*.01*(1.-g);
    p+=y*(df+.000001*length(p-a));
    df=f(p);
  }
  vec3 n=nn(p);
  float d=length(p-a),o=u(p,n),
        z=2.*pw(.5+dot(n,normalize(normalize(sin(p.yzx/5.+h.w+vec3(.14,.47,.33)*t))))/2.,.5);
  // HLSL: float z *= float3(...)  -> implicit truncation keeps the .x component
  vec3 zz=z*(1.+.8/pw(d+.5,.6)*sin(floor(p*1.6+sin(floor(p.yzx*3.))*3.)+sin(floor(p.zxy*1.7)))
             +.7*sin(t*.08+4.*length(sin(floor(p*3.+t*.1+sin(floor(p.yzx*133.))*.24/d*sin(t*.3+floor(p.zxy*.15)))+sin(floor(p.yzx*7.))))
                     +step(length(fract(p.xy*7.)-.5)+.6*sin(length(sin(t*vec2(.5,.7)+floor(p.xy*7.)))),.5))
                 *sin(floor(p.z)*3.+floor(p.x+sin(floor(p.yzx*15.)))));
  z=zz.x;
  z+=pw(.45+.45*sin(o*38.+t),19.);
  fragColor=vec4(z,g,o,d);
}`;

// p1: post-process.  float4 p1(float2 vp:vpos):color0
const PARTY_FRAG1 = PARTY_COMMON + `
vec3 q3(vec2 x){
  vec4 c=tex(x);
  float d=3./pw(c.w,.15);
  return vec3(sat(c.x/d)*d);
}
void main(){
  vec2 vp=vpos();
  vec2 x=(vp+.5)/j;
  vec4 tx=tex(x);
  vec3 c=vec3(tx.x),b=tx.yzw;
  vec2 w=4e-4/j*j.x/pw(b.z+.03,.5)*(pw(b.y,2.)+.1);
  vec3 e=vec3(1,-1,0),
    m11=q3(x+w*e.yy),m12=q3(x+w*e.zy),m13=q3(x+w*e.xy),
    m21=q3(x+w*e.yz),                 m23=q3(x+w*e.xz),
    m31=q3(x+w*e.yx),m32=q3(x+w*e.zx),m33=q3(x+w*e.xx),
    v=m13+2.*m23+m33-(m11+2.*m21+m31),
    z=m11+2.*m12+m13-(m31+2.*m32+m33);
  c=mix((sat3(pw(sqrt(v*v*vec3(.5,.01,1)+z*z*vec3(.02,1,1)),.5)*.4/pw(b.z,.3))*sqrt(h.x*50.+1.)
          +b.x*b.x*12./pw(b.z+.5,.6))*pw(b.y,1.1)*1.04,
        vec3(h.x*70.+h.x*ss(50.,10.,t)*2.),
        sat(b.z/110.-.1+h.x*3.));
  c=pw(c+sat3(1.-c)*b.x,1.8*vec3(1.8,1.2,1.1)-1.+9./t+.1/(pw(vec3(h.x*20.),vec3(3,4,3))+.05))*2.;
  fragColor=vec4(c,c.z);
}`;

// ======================================================= final version shaders
const FINAL_COMMON = COMMON + `
vec3 r(vec3 p,vec3 z){
  vec3 x=cos(z*6.),y=sin(z*6.);
  return mat3(x.y*x.z+y.x*y.y*y.z,-x.x*y.z,y.x*x.y*y.z-y.y*x.z,
              x.y*y.z-y.x*y.y*x.z,x.x*x.z,-y.y*y.z-y.x*x.y*x.z,
              x.x*y.y,y.x,x.x*x.y)*p;
}
`;

// p0: raymarcher.  float4 p0(float2 x:vpos):color0
const FINAL_FRAG0 = FINAL_COMMON + `
float f(vec3 p){
  vec3 z=(fract(r(p+sin(p.yzx/5.)/3.,cos(p.z*.06)/3.*vec3(0,0,1)*ss(150.,60.,p.z))/6.)-.5)*6.,
       w=r(p-vec3(0,0,133),vec3(h.y*.0111));
  float a=2.5*ss(25.,37.,h.y)-abs(p.x)-1.,
        b=max(abs(z.x),max(abs(z.y),abs(z.z)))-2.3,
        c=length(p-vec3(0,0,84))-18.;
  a=mix(a,min(max(a,-.7-b),max(b-.3,abs(a-.9)-1.3)),sat(p.z*.03-.5+sin(p.z*.1)*.1));
  a=max(max(a,25.-p.z),p.z-111.);
  a=min(min(max(a,min(max(11.-abs(c),-12.-c),max(-p.z+84.,abs(length(p.xy)-1.7+sin(p.z*.7-h.y*.3)*.8)-.2))),
            max(a+.5,abs(c-4.)-.5))-.3*ss(60.,111.,h.y),
        max(111.-p.z,min(7.-length(p.xy)/2.-sin(p.z*.3+sin(p.z*2.)/25.+h.y/5.)*6.,
                         max(-abs(p.x)+(p.z-111.)*.1+.2,abs(p.y)-1.))));
  a=min(a,abs(dot(abs(p-vec3(0,0,84)),vec3(.5))-2.8)-.25);
  a=min(a,.8*max(p.z-18.,abs(length(p.xy)-3.-sin(floor(p.z))/3.)-1.))+40.*ss(150.,333.,h.y);
  float i=1./sqrt(pw(1./length(w+4.5*sin(h.y*vec3(.5,.7,.6)/7.)),2.)
                 +pw(1./length(w+4.5*sin(h.y*vec3(.9,.6,.7)/4.)),2.)
                 +pw(1./length(w+4.5*sin(h.y*vec3(.5,.3,.7)/5.)),2.)
                 +pw(1./length(w+4.5*sin(h.y*vec3(.9,.5,.3)/13.)),2.));
  a=min(a,min(i-2.,abs(i-6.)/2.-.28));
  // for(i=0;i<3;i++,z=...,z=...,a=...);  the increment part runs with i = 1,2,3
  for(i=0.;i<3.;){
    i++;
    z=(1.+i*i/5.*(1.+4.*sin(vec3(6.5,7.3,8.3)*i)))*.3;
    z=(fract(p*z-h.y*.007)-.5)/z;
    a=min(a+.14,max(a,max(abs(z.x),max(abs(z.y),abs(z.z)))-.7));
  }
  return a;
}
void main(){
  vec2 x=vpos();
  x=(x-j/2.)/j.y;
  float i=1.8-.7*q.w,z=0.,w=1.,d,a=0.;
  vec3 p=q.xyz,
       y=r(r(normalize(vec3(2.*sin(x*i),cos(length(x*i)*1.4))),vec3(0,1,0)*m.xyz),vec3(1,0,1)*m.xyz),
       e=vec3(4e-3,0,0);
  for(i=0.;i<111.;i++){
    a=f(p);
    if(!(abs(a)>.00032))break;
    z+=ss(.5,0.,a)*.01*(1.-z);
    p+=y*a;
  }
  vec3 n=normalize(vec3(f(p-e.xyy),f(p-e.yxy),f(p-e.yyx)));
  // for(i=0;i<3;i++,d=i*.05+.025,w-=...);  the increment part runs with i = 1,2,3
  for(i=0.;i<3.;){
    i++;
    d=i*.05+.025;
    w-=float(a<.001)*(d-f(p-n*d))*3./sqrt(length(p-q.xyz));
  }
  d=length(p-q.xyz)+.2;
  // HLSL: float i = float * float3  -> implicit truncation keeps .x
  vec3 ii=pw(dot(1.+r(n,h.y/3.+sin(floor(p.yzx*1.3)/2.+floor(p/2.)/3.)+m.xyz+w*2.),vec3(.3)),2.)
          *(1.+sin(floor(p*1.6+sin(floor(p.yzx*3.))*3.)+sin(floor(p.zxy*1.7)))
            +.7*sin(h.y*.08+4.*length(sin(floor(p*3.+h.y/9.+sin(floor(p.yzx*133.))/4./d*sin(h.y/3.+floor(p.zxy*.15)))+sin(floor(p.yzx*7.))))
                    +step(length(fract(p.xy*7.)-.5)+.6*sin(length(sin(h.y*vec2(.5,.7)+floor(p.xy*7.)))),.5))
                *sin(floor(p.z)*3.+floor(p.x+sin(floor(p.yzx*15.)))));
  i=ii.x;
  fragColor=vec4(i,z,w,d);
}`;

// p1: post-process.  float4 p1(float2 x:vpos):color0
const FINAL_FRAG1 = FINAL_COMMON + `
void main(){
  vec2 x=(vpos()+.5)/j;
  vec4 c=mix(tex(x),vec4(1),pw(ss(208.,254.,h.y),3.));
  vec4 e=vec4(1e-3/c.w,-1e-3/c.w*1.3,0,0);
  // HLSL: x+e -> x+e.xy ; x+e.x -> x+e.xx (scalar broadcast)
  vec3 E=sat3(sqrt(abs(tex(x+e.xy).x+tex(x+e.xz).x+tex(x+e.xx).x-tex(x+e.yy).x-tex(x+e.yz).x-tex(x+e.yx).x)*vec3(.6,.3,1)
                  +abs(tex(x+e.yy).x+tex(x+e.zy).x+tex(x+e.xy).x-tex(x+e.yx).x-tex(x+e.zx).x-tex(x+e.xx).x)*vec3(.3,1,1)))*.5+c.y;
  E=E*c.z*c.z;
  vec3 base=mix(E,vec3(1),sat(c.w/19.*(.1+pw(h.x,2.)+3.*sqrt(ss(24.,22.,h.y))-c.y/sqrt(c.w))))+c.y*h.x*2./c.w;
  vec3 o=2.*pw(base,vec3(12,9,8)/(.5+c.y)/14.+vec3(.7,.6,.5)/(pw(h.x,3.)+.2));
  fragColor=vec4(o,o.z);
}`;

const VERSIONS = {
  party: { name: 'party', frag0: PARTY_FRAG0, frag1: PARTY_FRAG1, synth: 'createSynth', hsize: 4,
           seconds: 301, end: 300, table: 'CDAK_H_TABLE', preview: 22 },   // original runs until ESC; music is silent by ~290 s
  final: { name: 'final', frag0: FINAL_FRAG0, frag1: FINAL_FRAG1, synth: 'createSynthFinal', hsize: 16,
           seconds: 253, end: 252, table: 'CDAK_H_TABLE_FINAL', preview: 30 },
};

// shader constants for a given time from the optional precomputed tables (h_table*.js)
function constantsAt(ver, tm) {
  const c = new Float32Array(16); c[1] = tm;
  const tbl = window[ver.table];
  if (tbl) {
    const i = Math.min(tbl.length / ver.hsize - 1, Math.round(tm * 10));
    for (let n = 0; n < ver.hsize; n++) c[n] = tbl[i * ver.hsize + n];
    c[1] = tm;
  }
  return c;
}

// ------------------------------------------------------------------ renderer
function createRenderer(canvas, ver) {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false,
                                           stencil: false, preserveDrawingBuffer: false });
  if (!gl) throw new Error('WebGL2 is required');

  // render target: A16B16G16R16F, linear filtering, wrap addressing (D3D9 defaults)
  let internalFormat = gl.RGBA16F, type = gl.HALF_FLOAT, fmtName = 'RGBA16F';
  if (!gl.getExtension('EXT_color_buffer_float')) {
    if (gl.getExtension('EXT_color_buffer_half_float')) { /* 16F renderable */ }
    else { internalFormat = gl.RGBA8; type = gl.UNSIGNED_BYTE; fmtName = 'RGBA8 (fallback)'; }
  }

  function compile(typ, src) {
    const sh = gl.createShader(typ);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
      throw new Error('shader compile error:\n' + gl.getShaderInfoLog(sh));
    return sh;
  }
  function program(fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error('program link error:\n' + gl.getProgramInfoLog(p));
    return { p, j: gl.getUniformLocation(p, 'j'), h: gl.getUniformLocation(p, 'h'),
             m: gl.getUniformLocation(p, 'm'), q: gl.getUniformLocation(p, 'q'),
             s: gl.getUniformLocation(p, 's') };
  }
  const P0 = program(ver.frag0), P1 = program(ver.frag1);

  const tex = gl.createTexture(), fbo = gl.createFramebuffer();
  let W = 0, H = 0;
  function resize(w, h) {
    if (w === W && h === H) return;
    W = w; H = h; canvas.width = W; canvas.height = H;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, W, H, 0, gl.RGBA, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer incomplete: ' + st);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  function setUniforms(P, c) {
    gl.uniform2f(P.j, W, H);
    gl.uniform4f(P.h, c[0], c[1], c[2], c[3]);
    if (P.m) gl.uniform4f(P.m, c[4] || 0, c[5] || 0, c[6] || 0, c[7] || 0);
    if (P.q) gl.uniform4f(P.q, c[8] || 0, c[9] || 0, c[10] || 0, c[11] || 0);
  }
  // c = shader constants: [level, time, ., ., (final:) m.xyzw, q.xyzw]
  function render(c) {
    gl.viewport(0, 0, W, H);
    // pass 0: raymarch into the float texture
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.useProgram(P0.p); setUniforms(P0, c);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // pass 1: post-process into the back buffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(P1.p); setUniforms(P1, c);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(P1.s, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function clear() { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
  // debug: read back the pass-0 float buffer (RGBA32 floats, bottom-up rows)
  function readback() {
    const buf = new Float32Array(W * H * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return buf;
  }
  return { gl, resize, render, clear, readback, fmtName, version: ver.name, get size() { return [W, H]; } };
}

// ------------------------------------------------------------------ audio
// Streams the synth from a worker into AudioBufferSourceNodes and supports
// seeking: the generated chunks are kept (16-bit), and the playhead can be
// moved anywhere that has been generated; jumping ahead of the synth waits
// for it (the synth is sequential, there is no random access).
function createAudio(ver, onReady) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
  const HS = ver.hsize, CH = CHUNK / SR;          // seconds per chunk
  const chunks = [];                              // {L, R: Int16Array, H: Float32Array} per chunk
  const sources = new Set();
  let generated = 0, done = false, started = false;
  let pos0 = 0, head = null;                      // position pos0 (s) started playing at ctx time head; null = paused/waiting

  const workerSrc = `
    const createSynth = ${CDAK[ver.synth].toString()};
    const syn = createSynth();
    const CHUNK = ${CHUNK}, HEVERY = ${HEVERY}, TOTAL = ${ver.seconds}, HS = ${HS};
    let idx = 0;
    function gen() {
      if (idx >= TOTAL) { postMessage({ done: true }); return; }
      const L = new Int16Array(CHUNK), R = new Int16Array(CHUNK);
      const H = new Float32Array(Math.ceil(CHUNK / HEVERY) * HS);
      syn.render(CHUNK, L, R, H, HEVERY, 0);
      postMessage({ idx, L, R, H }, [L.buffer, R.buffer, H.buffer]);
      idx++;
      setTimeout(gen, 0);
    }
    gen();`;
  const worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })));

  function toBuffer(c) {
    const buf = ctx.createBuffer(2, CHUNK, SR);
    const l = buf.getChannelData(0), r = buf.getChannelData(1);
    for (let i = 0; i < CHUNK; i++) { l[i] = c.L[i] * (1 / 32768); r[i] = c.R[i] * (1 / 32768); }
    return buf;
  }
  function stopSources() { for (const s of sources) { try { s.stop(); } catch (e) { /* already ended */ } } sources.clear(); }
  function scheduleChunk(idx) {                   // play chunk idx aligned to the current playhead
    const when = head + (idx * CH - pos0), now = ctx.currentTime;
    let offset = 0;
    if (when < now) { offset = now - when; if (offset >= CH) return; }
    const src = ctx.createBufferSource();
    src.buffer = toBuffer(chunks[idx]); src.connect(ctx.destination);
    src.onended = () => sources.delete(src);
    sources.add(src);
    src.start(Math.max(when, now), offset);
  }
  function needed() { return Math.min(ver.seconds, Math.floor(pos0 / CH) + (started ? 1 : PREBUFFER)); }
  function play() {                               // (re)start playback at pos0 with what is generated so far
    stopSources();
    head = ctx.currentTime + 0.05;
    for (let i = Math.floor(pos0 / CH); i < generated; i++) scheduleChunk(i);
    if (!started) { started = true; onReady(); }
  }
  worker.onmessage = (e) => {
    if (e.data.done) { done = true; return; }
    const { idx, L, R, H } = e.data;
    chunks[idx] = { L, R, H }; generated = idx + 1;
    if (head !== null) scheduleChunk(idx);
    else if (generated >= needed()) play();
  };

  function time() { return head === null ? pos0 : pos0 + Math.max(0, ctx.currentTime - head); }
  function seek(p) {                              // absolute position in seconds
    p = Math.max(0, Math.min(p, ver.seconds - 0.01));
    stopSources(); pos0 = p; head = null;
    if (generated >= needed()) play();
    return p;
  }
  let paused = false;
  function pause() { if (!paused) { paused = true; ctx.suspend(); } }
  function resume() { if (paused) { paused = false; ctx.resume(); } }
  function available(tm) { return !!chunks[Math.floor(tm * SR / CHUNK)]; }
  const cOut = new Float32Array(16);
  function constants(tm) {
    const smp = Math.floor(tm * SR);
    const c = Math.floor(smp / CHUNK), k = Math.floor((smp - c * CHUNK) / HEVERY);
    const ch = chunks[c];
    if (ch) { for (let n = 0; n < HS; n++) cOut[n] = ch.H[k * HS + n]; }
    else { cOut[1] = tm; }   // past the end of the soundtrack: keep the last values
    return cOut;
  }
  return { ctx, time, seek, constants, worker, needed, pause, resume, available,
           get generated() { return generated; }, get done() { return done; },
           get playing() { return head !== null; }, get paused() { return paused; },
           stop() { stopSources(); worker.terminate(); ctx.close(); } };
}

// ------------------------------------------------------------------ main
function param(name, def) {
  const v = new URLSearchParams(location.search).get(name);
  return v === null ? def : v;
}

// opts.version overrides; otherwise #party / #final, then party.
// opts.renderer: reuse a renderer (e.g. the launcher's preview) if it is for the same version.
// opts.onStart: called when playback actually begins (after the soundtrack is pre-buffered).
// opts.onEnd: called when the intro ends by itself (final: 252 s, party: 300 s).
function start(canvas, status, opts) {
  opts = opts || {};
  const hash = (location.hash || '').replace('#', '');
  const want = opts.version || hash;
  const vname = VERSIONS[want] ? want : 'party';
  const ver = VERSIONS[vname];
  const R = (opts.renderer && opts.renderer.version === vname) ? opts.renderer : createRenderer(canvas, ver);
  const dpr = parseFloat(param('dpr', '1'));
  const fixedW = parseInt(param('w', '0')), fixedH = parseInt(param('h', '0'));
  function fit() {
    if (fixedW && fixedH) { R.resize(fixedW, fixedH); return; }
    R.resize(Math.max(1, Math.floor(innerWidth * dpr)), Math.max(1, Math.floor(innerHeight * dpr)));
  }
  fit(); addEventListener('resize', fit);
  status(`${vname} · render target: ${R.fmtName}`);

  const seek = param('t', null);   // debug: render a fixed time without audio
  if (seek !== null) {
    const c = constantsAt(ver, parseFloat(seek));
    R.render(c); status('');
    return { stop() {}, renderer: R, constants: c, version: vname };
  }

  let running = true, lastStatus = null, lastRendered = -1;
  const A = createAudio(ver, () => { if (opts.onStart) opts.onStart(); });
  const setStatus = (s) => { if (s !== lastStatus) { lastStatus = s; status(s); } };
  function frame() {
    if (!running) return;
    const tm = A.time();
    if (A.paused) {
      if (tm !== lastRendered && A.available(tm)) { R.render(A.constants(tm)); lastRendered = tm; }
      setStatus('paused');
    } else if (A.playing && A.ctx.state === 'running') {
      if (tm >= ver.end) {            // final: exits at 252 s (ExitProcess); party: soundtrack over at 300 s
        running = false; R.clear(); A.stop(); status('');
        if (opts.onEnd) opts.onEnd();
        return;
      }
      R.render(A.constants(tm)); lastRendered = tm;
      setStatus('');
    } else {
      const need = A.needed();
      setStatus(`synthesizing soundtrack… ${Math.min(A.generated, need)}/${need} s`);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return {
    stop() { running = false; A.stop(); },
    time() { return A.time(); },
    seek(dt) { return A.seek(A.time() + dt); },      // relative, in seconds
    pause() { if (A.paused) A.resume(); else A.pause(); return A.paused; },   // toggle
    get paused() { return A.paused; },
    audio: A, renderer: R, version: vname,
  };
}

window.CDAK = Object.assign(window.CDAK || {}, { start, createRenderer, createAudio, constantsAt, VERSIONS });
})();
