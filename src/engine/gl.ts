/**
 * WebGL2 instanced sprite batcher.
 *
 * Nothing about a sprite breaks the batch. A run spans up to `TEX_SLOTS`
 * textures at once — each instance carries the texture unit it samples from —
 * and both blend modes at once, because additive is expressed in the shader
 * rather than as pipeline state. So a whole pass is normally a single draw
 * call, and only running out of texture slots or instance capacity ends one.
 *
 * That matters here because the draw order is fixed by depth (backdrop, props,
 * ground, props, blocks, hero, foliage), alternates between the painted
 * layers, the packed art atlas and the procedural atlas several times per
 * frame, and toggles additive on for every glow and spark. Binding one texture
 * per batch and switching blend state cost 15-17 draw calls for six textures.
 *
 * Instance data is written into a single interleaved Float32Array and uploaded
 * with one bufferSubData per flush.
 *
 * Per-instance layout (17 floats / 68 bytes):
 *   0..3   a_xform   : x, y, halfW, halfH        (world units, pre-rotation half-extents)
 *   4..7   a_rot     : cos, sin, pivotX, pivotY  (pivot in [-1..1] local quad space)
 *   8..11  a_uv      : u0, v0, u1, v1
 *   12..15 a_color   : r, g, b, a                (premultiplied at shade time)
 *   16     a_mode    : texture slot 0..7, plus bit 3 for additive
 */

export const enum Blend {
  Normal = 0,
  Additive = 1,
}

const FLOATS_PER_INSTANCE = 17;
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;

/**
 * Textures a single batch can sample from.
 *
 * Eight covers the whole game (four painted layers, the packed art atlas and
 * the procedural atlas) with room to spare, and WebGL2 guarantees at least
 * sixteen fragment texture units, so the slot count never has to be negotiated
 * with the driver. The selector in the fragment shader is a three-deep binary
 * split rather than a linear chain, so it costs three comparisons, not eight —
 * this game is fill-rate bound and the selector runs per fragment.
 */
const TEX_SLOTS = 8;

/**
 * Slack, in world units, on the frustum-rejection test.
 *
 * Zero, and exact. The projection maps the cull rect onto the viewport
 * boundary for boundary, so a quad whose bounding box only touches the rect
 * covers no pixel centre and can be dropped; the box is an AABB and therefore
 * already conservative for a rotated sprite. A pixel of world space is worth
 * ~1e-4 units of float error here, four orders below one device pixel.
 */
const CULL_PAD = 0;

const VERT = `#version 300 es
precision highp float;

layout(location=0) in vec2 a_corner;   // unit quad corner, -1..1
layout(location=1) in vec4 a_xform;    // x, y, halfW, halfH
layout(location=2) in vec4 a_rot;      // cos, sin, pivotX, pivotY
layout(location=3) in vec4 a_uv;       // u0, v0, u1, v1
layout(location=4) in vec4 a_color;
layout(location=5) in float a_mode;    // texture slot | 8 when additive

uniform mat4 u_proj;

out vec2 v_uv;
out vec4 v_color;
flat out int v_mode;

void main() {
  v_mode = int(a_mode);
  vec2 local = (a_corner - a_rot.zw) * a_xform.zw;
  vec2 rotated = vec2(
    local.x * a_rot.x - local.y * a_rot.y,
    local.x * a_rot.y + local.y * a_rot.x
  );
  gl_Position = u_proj * vec4(a_xform.xy + rotated, 0.0, 1.0);

  vec2 t = a_corner * 0.5 + 0.5;
  v_uv = mix(a_uv.xy, a_uv.zw, t);
  v_color = a_color;
}`;

const FRAG = `#version 300 es
precision mediump float;

in vec2 v_uv;
in vec4 v_color;
flat in int v_mode;

uniform sampler2D u_tex[8];
uniform vec2 u_grade;

out vec4 fragColor;

void main() {
  // Texture select. Constant indices only (GLSL ES 3.00 forbids a dynamic
  // index into a sampler array), split binary so the deepest path is three
  // comparisons.
  int slot = v_mode & 7;
  vec4 texel;
  if (slot < 4) {
    if (slot < 2) {
      if (slot < 1) texel = texture(u_tex[0], v_uv);
      else texel = texture(u_tex[1], v_uv);
    } else {
      if (slot < 3) texel = texture(u_tex[2], v_uv);
      else texel = texture(u_tex[3], v_uv);
    }
  } else {
    if (slot < 6) {
      if (slot < 5) texel = texture(u_tex[4], v_uv);
      else texel = texture(u_tex[5], v_uv);
    } else {
      if (slot < 7) texel = texture(u_tex[6], v_uv);
      else texel = texture(u_tex[7], v_uv);
    }
  }
  vec4 c = texel * v_color;
  if (c.a < 0.0025) discard;

  // Global grade, applied per fragment before compositing.
  //
  // Eleven parallax planes, each tiled across the frame, still composite over
  // one another several deep in places, and that accumulation can drive the
  // frame hotter and more saturated than the source paintings. It cannot be
  // dialled out layer by layer without changing the depth relationships the
  // layers exist for.
  //
  // So it is corrected once, here, at the end: u_grade.x scales exposure and
  // u_grade.y pulls saturation back toward luma. Both default to 1.0, which is
  // an exact no-op, and are tunable live via window.__grade(exposure, sat).
  vec3 g = c.rgb * u_grade.x;
  float luma = dot(g, vec3(0.2126, 0.7152, 0.0722));
  g = mix(vec3(luma), g, u_grade.y);

  // Anti-banding dither, half a code deep.
  //
  // The sky is one 8-bit gradient stretched over the whole viewport, so its
  // steps land as horizontal stripes several pixels apart. That used to be
  // hidden by drawing the entire sky three times — the base plus two offset
  // copies at 5.5% alpha — which averaged the staircase away at the price of
  // 1.3 screens of extra fill every frame, on the single largest quad in the
  // game. Interleaved-gradient noise does the same job in four ALU ops on
  // fragments that were being shaded anyway: two fracts and a dot, no texture
  // fetch, no extra geometry. Amplitude is one quantisation step peak to peak,
  // which is exactly enough to break a contour and far too little to see.
  float dither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  g = clamp(g + (dither - 0.5) * (1.0 / 255.0), 0.0, 1.0);

  // Additive without a second blend mode.
  //
  // Output is premultiplied and the pipeline blends ONE / ONE_MINUS_SRC_ALPHA,
  // so a fragment that emits zero alpha leaves the destination untouched and
  // simply adds its colour: dst' = rgb*a + dst*(1-0). That is exactly what
  // ONE / ONE destination-blending did, arithmetic for arithmetic, on a
  // colour buffer with no alpha channel to care about. Doing it per fragment
  // instead of per blend state is what lets a whole pass be one draw call:
  // glow, sparks and the hero's rim light no longer chop the frame into runs.
  float outA = (v_mode & 8) != 0 ? 0.0 : c.a;
  fragColor = vec4(g * c.a, outA); // premultiplied output
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}`);
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`program link failed: ${log}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return p;
}

export interface Frame {
  /** Atlas texture this frame lives on. */
  tex: WebGLTexture;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Untrimmed source size in art units. */
  w: number;
  h: number;
  /** Normalised pivot, 0..1 within the frame (0.5,0.5 = centre). */
  px: number;
  py: number;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;

  /** Virtual design resolution. World units are independent of pixel size. */
  viewW = 1280;
  viewH = 720;
  /** Device pixels per world unit after fit. */
  scale = 1;
  /** Letterbox offsets in CSS pixels. */
  offsetX = 0;
  offsetY = 0;
  dpr = 1;

  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private instanceVBO: WebGLBuffer;
  private uProj: WebGLUniformLocation;
  private uGrade: WebGLUniformLocation;

  /**
   * Global output grade: [exposure, saturation]. 1,1 is an exact no-op.
   * Tunable live through `window.__grade(e, s)` so it can be dialled against
   * the real frame instead of guessed at.
   */
  grade: [number, number] = [1, 1];

  /**
   * Diagnostic: draw every sprite at its own colour, unmodified.
   *
   * Forces the per-sprite colour multiply to white so no tint, fade or
   * atmospheric grade can touch the artwork. Subsystems additionally skip
   * their overlay passes when this is on. Toggled live via window.__raw().
   */
  rawMode = false;

  /**
   * Textures raw mode is allowed to touch: the generated paintings.
   *
   * Raw mode must not be a blanket "ignore all colour". Glyphs, UI and
   * particles are baked WHITE and get their colour entirely at draw time —
   * a letter is four near-black outline copies behind a white fill, so
   * forcing that stack to white turns every letter into a ghosted double.
   * Only the painted art is meant to render untinted.
   */
  rawTextures = new Set<WebGLTexture>();

  private data: Float32Array;
  private count = 0;
  private capacity: number;

  /** Textures bound to units 0..slotCount-1 for the batch being built. */
  private slots: (WebGLTexture | null)[] = new Array(TEX_SLOTS).fill(null);
  private slotCount = 0;
  /** Slot the previous sprite used — almost always the right answer again. */
  private lastSlot = 0;
  /** Instance mode bit for the current blend: 0 normal, 8 additive. */
  private curBlend = 0;
  private proj = new Float32Array(16);

  /** Draw calls issued during the last frame — surfaced to the perf HUD. */
  drawCalls = 0;
  spritesDrawn = 0;
  /** Sprites rejected by the frustum test during the last frame. */
  spritesCulled = 0;

  constructor(canvas: HTMLCanvasElement, capacity = 16384) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
      desynchronized: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 is required');
    this.gl = gl;

    this.capacity = capacity;
    this.data = new Float32Array(capacity * FLOATS_PER_INSTANCE);

    this.prog = link(gl, compile(gl, gl.VERTEX_SHADER, VERT), compile(gl, gl.FRAGMENT_SHADER, FRAG));
    this.uProj = gl.getUniformLocation(this.prog, 'u_proj')!;
    this.uGrade = gl.getUniformLocation(this.prog, 'u_grade')!;

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    // Static unit quad as a triangle strip.
    const quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);

    this.instanceVBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVBO);
    gl.bufferData(gl.ARRAY_BUFFER, capacity * BYTES_PER_INSTANCE, gl.DYNAMIC_DRAW);
    for (let i = 0; i < 4; i++) {
      const loc = 1 + i;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, BYTES_PER_INSTANCE, i * 16);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 1, gl.FLOAT, false, BYTES_PER_INSTANCE, 64);
    gl.vertexAttribDivisor(5, 1);

    gl.bindVertexArray(null);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.prog);
    const units = new Int32Array(TEX_SLOTS);
    for (let i = 0; i < TEX_SLOTS; i++) units[i] = i;
    gl.uniform1iv(gl.getUniformLocation(this.prog, 'u_tex'), units);
  }

  /**
   * World-space rectangle actually visible on screen.
   *
   * On a 16:9 display this is exactly the design resolution. On a tall phone
   * it is WIDER in the vertical sense — `viewTop` goes negative — because the
   * view extends upward rather than letterboxing. Anything that anchors to a
   * screen edge (the HUD, the sky) must use these, not the design constants.
   */
  viewTop = 0;
  /** Highest y a HUD element should anchor to. See resize(). */
  safeTop = 0;
  viewBottom = 720;
  viewLeft = 0;
  viewRight = 1280;

  /**
   * The same rectangle after the current pass's camera, which is what sprites
   * are actually tested against. Recomputed by `begin()`; the world pass has a
   * shaken, zoomable camera and the HUD pass does not, so the two passes cull
   * against different rects.
   */
  private cullL = 0;
  private cullR = 0;
  private cullT = 0;
  private cullB = 0;

  /** Rendered band in device pixels. Equals the canvas unless portrait-capped. */
  private vpY = 0;
  private vpH = 0;
  private vpTopCss = 0;

  /**
   * Maximum extra world height, as a multiple of the design height, that a
   * tall screen is allowed to reveal. Past this the view letterboxes instead,
   * so an extreme aspect ratio cannot expose an absurd empty sky.
   */
  maxVerticalExtend = 2.6;

  /** Same budget for revealing extra world width on an ultra-wide screen. */
  maxHorizontalExtend = 1.6;

  /**
   * Fit the virtual resolution into the container and clamp
   * device-pixel-ratio so high-DPI phones do not pay 3x fill cost.
   *
   * A 16:9 game letterboxed into a 9:19.5 portrait phone becomes a thin strip
   * using a quarter of the screen. So on screens taller than the design
   * aspect, we fit by WIDTH and anchor the world to the BOTTOM — the ground
   * and word bar stay pinned to the bottom edge and the extra height becomes
   * additional sky, which is exactly what a side-scroller wants.
   */
  resize(cssW: number, cssH: number, maxDpr = 2): void {
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    this.dpr = dpr;
    const pw = Math.max(1, Math.round(cssW * dpr));
    const ph = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }

    // Never letterbox. A letterboxed 16:9 stage on a 2:1 monitor or a 9:19.5
    // phone leaves dead bars that read as broken overlays, and it wastes the
    // screen. Instead the stage always fills: whichever axis has room to spare
    // simply reveals more world along that axis.
    //
    //   wider than design  -> fit by HEIGHT, reveal more world left and right
    //   taller than design -> fit by WIDTH, reveal more sky, world pinned to
    //                         the bottom so the ground and word bar stay put
    //
    // Extension is capped on each axis; past the cap it centres rather than
    // exposing an absurd amount of empty world.
    const fitWidth = pw / this.viewW;
    const fitHeight = ph / this.viewH;
    const revealedH = ph / fitWidth; // world height if we fit by width
    const revealedW = pw / fitHeight; // world width if we fit by height

    let vpY = 0;
    let vpH = ph;

    let s: number;
    if (revealedH > this.viewH) {
      // Taller than the design aspect. Always fit by WIDTH — narrowing the
      // visible world would hide letter blocks before the player can read
      // them, which is unacceptable in a horizontal scroller. The extra height
      // becomes sky, and the world is pinned to the bottom so the ground and
      // the word bar stay where the player's thumb expects them.
      s = fitWidth;
      this.offsetX = 0;
      this.offsetY = ph - this.viewH * s;

      // ...but only up to a point. On a 9:19.5 phone fitting by width reveals
      // ~2770 world units of height, which strands the HUD two-thirds of the
      // way down the screen with nothing above it but empty sky. Past the
      // budget we letterbox instead: the scale still fits the width (so no
      // gameplay is ever cropped), and rendering is restricted to a band of
      // exactly `maxVerticalExtend` view-heights, centred vertically.
      const maxReveal = this.viewH * this.maxVerticalExtend;
      if (revealedH > maxReveal) {
        const bandH = Math.round(maxReveal * s);
        // Biased below centre: on a phone the word bar and the jump control live at
        // the bottom of the band, and they should sit in comfortable thumb reach
        // rather than halfway up the screen.
        const bandTop = Math.round((ph - bandH) * 0.68);
        this.offsetY = bandTop + bandH - this.viewH * s;
        // GL's y axis is bottom-up; the canvas offset is top-down.
        vpY = ph - (bandTop + bandH);
        vpH = bandH;
      }
    } else {
      // Wider than the design aspect: fit by height and reveal more world
      // left and right, up to the budget, then centre.
      s = revealedW <= this.viewW * this.maxHorizontalExtend ? fitHeight : fitWidth;
      this.offsetX = (pw - this.viewW * s) * 0.5;
      this.offsetY = (ph - this.viewH * s) * 0.5;
    }

    this.scale = s;
    this.viewLeft = -this.offsetX / s;
    this.viewRight = this.viewLeft + pw / s;
    // The view rect describes the RENDERED band, which is the whole canvas
    // unless the portrait cap kicked in above. `bandTop` is the band's top
    // edge in top-down canvas pixels.
    const bandTop = ph - (vpY + vpH);
    this.viewTop = (bandTop - this.offsetY) / s;
    this.viewBottom = this.viewTop + vpH / s;
    // On an extreme portrait aspect `viewTop` can sit hundreds of units above
    // the playfield. HUD elements anchor to this instead, so status never
    // drifts to the far top of an empty sky.
    // Anchor HUD near the TOP of whatever is actually revealed, not to a fixed
    // offset. The canopy band is anchored to viewTop and fills that space, so
    // the header sits over art rather than adrift in empty sky — which is what
    // lets the vertical cap be generous without stranding the HUD mid-screen.
    this.safeTop = Math.min(0, this.viewTop + (this.viewBottom - this.viewTop) * 0.05);
    this.vpY = vpY;
    this.vpH = vpH;
    this.vpTopCss = bandTop;
    this.gl.viewport(0, vpY, pw, vpH);
  }

  /** Convert a CSS-pixel pointer position into world coordinates. */
  screenToWorld(clientX: number, clientY: number, out: { x: number; y: number }): void {
    const r = this.canvas.getBoundingClientRect();
    const px = (clientX - r.left) * this.dpr;
    const py = (clientY - r.top) * this.dpr;
    out.x = (px - this.offsetX) / this.scale;
    out.y = (py - this.offsetY) / this.scale;
  }

  /** Convert world coordinates back into CSS-pixel page coordinates. */
  worldToScreen(x: number, y: number, out: { x: number; y: number }): void {
    const r = this.canvas.getBoundingClientRect();
    out.x = r.left + (x * this.scale + this.offsetX) / this.dpr;
    out.y = r.top + (y * this.scale + this.offsetY) / this.dpr;
  }

  begin(camX = 0, camY = 0, camZoom = 1): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.useProgram(this.prog);

    // Orthographic projection into the letterboxed viewport, y-down.
    // Clip space maps to the VIEWPORT, which is a sub-band of the canvas when
    // the portrait cap is active — so the projection is built against the band,
    // and the world offset is measured from the band's top edge, not the
    // canvas's.
    const pw = this.canvas.width;
    const ph = this.vpH || this.canvas.height;
    const offY = this.offsetY - this.vpTopCss;
    const sx = (2 * this.scale * camZoom) / pw;
    const sy = (-2 * this.scale * camZoom) / ph;
    const tx = (2 * this.offsetX) / pw - 1 + sx * -camX;
    const ty = 1 - (2 * offY) / ph + sy * -camY;

    const p = this.proj;
    p[0] = sx; p[1] = 0;  p[2] = 0; p[3] = 0;
    p[4] = 0;  p[5] = sy; p[6] = 0; p[7] = 0;
    p[8] = 0;  p[9] = 0;  p[10] = 1; p[11] = 0;
    p[12] = tx; p[13] = ty; p[14] = 0; p[15] = 1;
    gl.uniformMatrix4fv(this.uProj, false, p);
    gl.uniform2f(this.uGrade, this.grade[0], this.grade[1]);

    // World rect this projection actually maps onto the viewport. Inverting
    // the matrix above at its two clip-space corners gives exactly the view
    // rect scaled by the zoom and slid by the camera, which is what `draw`
    // rejects sprites against.
    const iz = 1 / camZoom;
    this.cullL = camX + this.viewLeft * iz - CULL_PAD;
    this.cullR = camX + this.viewRight * iz + CULL_PAD;
    this.cullT = camY + this.viewTop * iz - CULL_PAD;
    this.cullB = camY + this.viewBottom * iz + CULL_PAD;

    this.count = 0;
    this.slotCount = 0;
    this.lastSlot = 0;
    this.curBlend = 0;
  }

  /**
   * Zero the per-frame counters.
   *
   * Deliberately NOT done in `begin()`: a frame calls `begin()` once for the
   * world pass and again for the HUD pass, so resetting there meant the stats
   * only ever described the last pass — the whole world was invisible to the
   * perf HUD. The frame owner calls this once, before the first pass.
   */
  resetStats(): void {
    this.drawCalls = 0;
    this.spritesDrawn = 0;
    this.spritesCulled = 0;
  }

  /**
   * Select the blend mode for subsequent sprites.
   *
   * No longer a pipeline state change, and so no longer a batch break: the
   * mode rides along on each instance and the fragment shader implements it
   * (see FRAG). Callers can toggle as freely as they like.
   */
  setBlend(mode: Blend): void {
    this.curBlend = mode === Blend.Additive ? 8 : 0;
  }

  /**
   * Queue a sprite. `rot` is radians. Colour components are 0..1 and multiply
   * the texel; alpha drives both tint and coverage.
   *
   * Sprites whose bounding box misses the view are rejected here rather than
   * uploaded and rasterised. The scrolling rows and tiled layers all keep a
   * margin of off-screen pieces alive so nothing pops at the edges, so a
   * frame submits a couple of dozen quads that cannot produce a fragment; the
   * test below costs a handful of multiplies and no allocation.
   */
  draw(
    f: Frame,
    x: number,
    y: number,
    scaleX = 1,
    scaleY = scaleX,
    rot = 0,
    r = 1,
    g = 1,
    b = 1,
    a = 1,
  ): void {
    if (a <= 0.0025) return;

    const hw = f.w * 0.5 * scaleX;
    const hh = f.h * 0.5 * scaleY;
    // The quad's corners are (corner - pivot) * half-extent, so the pivot
    // offsets the box's centre; a mirrored sprite has a negative half-extent.
    const ox = (0.5 - f.px) * 2 * hw;
    const oy = (0.5 - f.py) * 2 * hh;
    let ex = hw < 0 ? -hw : hw;
    let ey = hh < 0 ? -hh : hh;
    let cx: number;
    let cy: number;
    let rc = 1;
    let rs = 0;
    if (rot === 0) {
      cx = x + ox;
      cy = y + oy;
    } else {
      rc = Math.cos(rot);
      rs = Math.sin(rot);
      cx = x + ox * rc - oy * rs;
      cy = y + ox * rs + oy * rc;
      const ac = rc < 0 ? -rc : rc;
      const as = rs < 0 ? -rs : rs;
      const w = ac * ex + as * ey;
      ey = as * ex + ac * ey;
      ex = w;
    }
    if (
      cx + ex < this.cullL ||
      cx - ex > this.cullR ||
      cy + ey < this.cullT ||
      cy - ey > this.cullB
    ) {
      this.spritesCulled++;
      return;
    }

    if (this.rawMode && this.rawTextures.has(f.tex)) {
      r = 1;
      g = 1;
      b = 1;
    }
    if (this.count >= this.capacity) this.flush();

    // Texture slot. Runs of sprites share a texture, so the previous slot is
    // nearly always a hit and the linear scan almost never runs.
    let slot = this.lastSlot;
    if (slot >= this.slotCount || this.slots[slot] !== f.tex) {
      slot = -1;
      for (let i = 0; i < this.slotCount; i++) {
        if (this.slots[i] === f.tex) {
          slot = i;
          break;
        }
      }
      if (slot < 0) {
        if (this.slotCount === TEX_SLOTS) this.flush();
        slot = this.slotCount++;
        this.slots[slot] = f.tex;
      }
      this.lastSlot = slot;
    }

    const d = this.data;
    let o = this.count * FLOATS_PER_INSTANCE;

    d[o++] = x;
    d[o++] = y;
    d[o++] = hw;
    d[o++] = hh;

    d[o++] = rc;
    d[o++] = rs;
    // Pivot expressed in -1..1 quad space.
    d[o++] = f.px * 2 - 1;
    d[o++] = f.py * 2 - 1;

    d[o++] = f.u0;
    d[o++] = f.v0;
    d[o++] = f.u1;
    d[o++] = f.v1;

    d[o++] = r;
    d[o++] = g;
    d[o++] = b;
    d[o++] = a;

    d[o++] = slot | this.curBlend;

    this.count++;
  }

  flush(): void {
    if (this.count === 0) {
      this.slotCount = 0;
      this.lastSlot = 0;
      return;
    }
    const gl = this.gl;
    for (let i = 0; i < this.slotCount; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.slots[i]);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVBO);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.data,
      0,
      this.count * FLOATS_PER_INSTANCE,
    );
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    this.drawCalls++;
    this.spritesDrawn += this.count;
    this.count = 0;
    this.slotCount = 0;
    this.lastSlot = 0;
  }

  end(): void {
    this.flush();
    this.gl.bindVertexArray(null);
  }

  clear(r: number, g: number, b: number): void {
    const gl = this.gl;
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
}
