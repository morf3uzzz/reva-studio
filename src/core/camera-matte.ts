/** A renderer-owned GPU compositor converts the mask's red channel into alpha. */
export class CameraMatte {
  private canvas: OffscreenCanvas | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private textures: WebGLTexture[] = [];
  private lastFrame = "";
  private source: HTMLVideoElement | null = null;
  private mask: HTMLVideoElement | null = null;

  private initialize() {
    const canvas = new OffscreenCanvas(1, 1);
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error("Camera background removal requires WebGL 2.");
    const shader = (type: number, source: string) => {
      const item = gl.createShader(type)!;
      gl.shaderSource(item, source); gl.compileShader(item);
      if (!gl.getShaderParameter(item, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(item); gl.deleteShader(item);
        throw new Error(`Camera matte shader: ${message}`);
      }
      return item;
    };
    const vertex = shader(gl.VERTEX_SHADER, `#version 300 es
      out vec2 uv;
      void main() {
        vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
        uv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
      }`);
    const fragment = shader(gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;
      uniform sampler2D cameraRGB;
      uniform sampler2D cameraMask;
      uniform vec2 insetUV;
      uniform float softness;
      in vec2 uv;
      out vec4 color;
      void main() {
        float a = texture(cameraMask, uv).r;
        for (int y=-1; y<=1; y++) for (int x=-1; x<=1; x++)
          a = min(a, texture(cameraMask, uv + vec2(x,y) * insetUV).r);
        float halfWidth = max(0.001, softness * 0.5);
        a = smoothstep(0.5 - halfWidth, 0.5 + halfWidth, a);
        color = vec4(texture(cameraRGB, uv).rgb * a, a);
      }`);
    const program = gl.createProgram()!;
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Camera matte program: ${gl.getProgramInfoLog(program)}`);
    gl.useProgram(program);
    this.textures = [0, 1].map(unit => {
      const texture = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return texture;
    });
    gl.uniform1i(gl.getUniformLocation(program, "cameraRGB"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "cameraMask"), 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    this.canvas = canvas; this.gl = gl; this.program = program;
  }

  frame(camera: HTMLVideoElement, mask: HTMLVideoElement, softness: number, inset: number): OffscreenCanvas {
    if (!this.gl) this.initialize();
    const gl = this.gl!, canvas = this.canvas!, program = this.program!;
    if (gl.isContextLost()) throw new Error("Camera matte graphics context was lost.");
    const width = camera.videoWidth, height = camera.videoHeight;
    if (!(width > 0 && height > 0)) throw new Error("Camera frame is not ready.");
    const key = `${camera.currentTime}/${mask.currentTime}/${width}/${height}/${softness}/${inset}`;
    if (this.source === camera && this.mask === mask && this.lastFrame === key) return canvas;
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    gl.viewport(0, 0, width, height); gl.useProgram(program);
    for (const [index, video] of [camera, mask].entries()) {
      gl.activeTexture(gl.TEXTURE0 + index); gl.bindTexture(gl.TEXTURE_2D, this.textures[index]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    }
    gl.uniform2f(gl.getUniformLocation(program, "insetUV"), inset / width, inset / height);
    gl.uniform1f(gl.getUniformLocation(program, "softness"), softness);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.source = camera; this.mask = mask; this.lastFrame = key;
    return canvas;
  }

  dispose() {
    if (this.gl) {
      for (const texture of this.textures) this.gl.deleteTexture(texture);
      if (this.program) this.gl.deleteProgram(this.program);
      this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    this.gl = null; this.canvas = null; this.program = null; this.textures = []; this.lastFrame = "";
    this.source = null; this.mask = null;
  }
}
