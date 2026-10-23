import { CAMERA_LOOKS, type CameraProcessingSettings } from "./camera-effects.ts";

export interface FrameProcessingSettings extends Partial<CameraProcessingSettings> { deband?: number }

/** One graphics pipeline per compositor. It processes camera pixels before crop/mirror/matte. */
export class FrameProcessor {
  private canvas: OffscreenCanvas | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private texture: WebGLTexture | null = null;
  private lutTexture: WebGLTexture | null = null;
  private lut: CameraProcessingSettings["lut"] = null;
  private lastSource: CanvasImageSource | null = null;
  private lastSettings: FrameProcessingSettings | null = null;
  private lastFrame = "";
  private scaledSource: OffscreenCanvas | null = null;
  private maximumDimension = 0;

  private initialize() {
    const canvas = new OffscreenCanvas(1, 1);
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("Local frame processing requires WebGL 2.");
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { const message = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw new Error(`Camera processing shader: ${message}`); }
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, `#version 300 es
      out vec2 uv;
      void main() { vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2); uv=p; gl_Position=vec4(p*2.-1.,0.,1.); }`);
    const fragment = compile(gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;
      precision highp sampler3D;
      uniform sampler2D source;
      uniform sampler3D lut;
      uniform vec2 pixel;
      uniform vec3 domainMin;
      uniform vec3 domainMax;
      uniform float lutSize;
      uniform float intensity;
      uniform float sharpen;
      uniform float grain;
      uniform float frameSeed;
      uniform float deband;
      uniform int look;
      uniform bool hasLUT;
      in vec2 uv;
      out vec4 color;
      vec4 sampleDebanded(vec2 coordinate) {
        vec4 original=texture(source,coordinate);
        if(deband<=0.) return original;
        vec3 average=original.rgb;
        float weight=1.;
        // Blend only similar neighbouring colors, preserving high-contrast text
        // and edges. Multi-distance taps cross quantization plateaus.
        float threshold=(1.+deband*10.)/255.;
        for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++) {
          if(x==0 && y==0) continue;
          for(int distance=2;distance<=6;distance+=2) {
            vec4 tap=texture(source,coordinate+vec2(x,y)*pixel*float(distance));
            vec3 difference=abs(tap.rgb-original.rgb);
            if(max(max(difference.r,difference.g),difference.b)<threshold && abs(tap.a-original.a)<.01) { average+=tap.rgb; weight+=1.; }
          }
        }
        return vec4(mix(original.rgb,average/weight,deband),original.a);
      }
      void main() {
        vec4 original=sampleDebanded(uv);
        // A real four-neighbour unsharp kernel. Preserve transparency independently.
        vec3 neighbours=texture(source,uv+vec2(pixel.x,0)).rgb+texture(source,uv-vec2(pixel.x,0)).rgb
          +texture(source,uv+vec2(0,pixel.y)).rgb+texture(source,uv-vec2(0,pixel.y)).rgb;
        vec3 rgb=clamp(original.rgb+sharpen*(original.rgb-neighbours*.25)*2.,0.,1.);
        vec3 ungraded=rgb;
        if (look==1) rgb=pow(rgb,vec3(.96,1.,1.06))*vec3(1.035,1.,.965);
        if (look==2) rgb=pow(rgb,vec3(1.04,1.,.96))*vec3(.97,1.,1.035);
        if (look==3) rgb=vec3(dot(rgb,vec3(.2126,.7152,.0722)));
        if (look==4) { rgb=clamp((rgb-.5)*1.12+.5,0.,1.); rgb=mix(rgb,vec3(dot(rgb,vec3(.2126,.7152,.0722))),.12); rgb+=vec3(-.015,.004,.018)*(1.-rgb); }
        if (look==5) { rgb=clamp((rgb-.5)*1.08+.52,0.,1.); rgb=mix(vec3(dot(rgb,vec3(.2126,.7152,.0722))),rgb,1.05); }
        if (look==6) { rgb=rgb*.94+vec3(.025,.018,.012); rgb=rgb*rgb*(3.-2.*rgb); }
        if (look==7) { rgb=pow(rgb,vec3(.9,.94,1.))*vec3(1.02,1.01,.96); rgb=rgb*.9+.045; }
        if (look==8) { rgb=pow(rgb,vec3(.95,1.02,1.08))*vec3(1.06,.99,.91); rgb=mix(vec3(dot(rgb,vec3(.2126,.7152,.0722))),rgb,.88); }
        if (look==9) { rgb=clamp((rgb-.5)*1.15+.45,0.,1.); rgb=mix(vec3(dot(rgb,vec3(.2126,.7152,.0722))),rgb,.7); }
        if (look==10) { rgb=clamp((rgb-.5)*1.2+.5,0.,1.); rgb=mix(vec3(dot(rgb,vec3(.2126,.7152,.0722))),rgb,1.32); rgb+=vec3(.015,-.01,.025); }
        if (look==11) { rgb=clamp((rgb-.5)*1.3+.5,0.,1.); rgb=mix(vec3(dot(rgb,vec3(.2126,.7152,.0722))),rgb,1.15); }
        if (look==12) { rgb=rgb*.82+.09; rgb=mix(vec3(dot(rgb,vec3(.2126,.7152,.0722))),rgb,.78); }
        if (hasLUT) {
          vec3 coordinate=clamp((rgb-domainMin)/(domainMax-domainMin),0.,1.);
          coordinate=(coordinate*(lutSize-1.)+.5)/lutSize;
          rgb=texture(lut,coordinate).rgb;
        }
        rgb=mix(ungraded,rgb,intensity);
        float noise=fract(sin(dot(floor(gl_FragCoord.xy),vec2(12.9898,78.233))+frameSeed*37.719)*43758.5453)-.5;
        rgb=clamp(rgb+noise*(grain*.12+deband/255.),0.,1.);
        color=vec4(rgb,original.a);
      }`);
    const program = gl.createProgram()!;
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Camera processing program: ${gl.getProgramInfoLog(program)}`);
    gl.useProgram(program);
    const texture = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
    for (const name of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, name, gl.LINEAR);
    for (const name of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, name, gl.CLAMP_TO_EDGE);
    const lutTexture = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, lutTexture);
    for (const name of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, name, gl.LINEAR);
    for (const name of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, name, gl.CLAMP_TO_EDGE);
    // Complete sampler even when no user LUT is active.
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, 1, 1, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array([0, 0, 0, 1]));
    gl.uniform1i(gl.getUniformLocation(program, "source"), 0); gl.uniform1i(gl.getUniformLocation(program, "lut"), 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
    this.maximumDimension = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number, viewport[0], viewport[1]);
    this.canvas = canvas; this.gl = gl; this.program = program; this.texture = texture; this.lutTexture = lutTexture;
  }

  frame(source: CanvasImageSource, width: number, height: number, settings: FrameProcessingSettings, sourceSeconds: number): CanvasImageSource {
    if ((settings.gradingEnabled === false || ((!settings.look || settings.look === "none") && !settings.lut)) && !settings.sharpen && !settings.grain && !settings.deband) return source;
    if (!this.gl) this.initialize();
    const gl = this.gl!, program = this.program!, canvas = this.canvas!;
    if (gl.isContextLost()) throw new Error("Camera processing graphics context was lost.");
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new RangeError("Frame processing requires finite positive source dimensions.");
    // Input texture, output and optional downsampling surface are each capped
    // at 16M RGBA8 pixels. Decoder/driver-owned memory is separate.
    const sourceScale = Math.min(1, this.maximumDimension / width, this.maximumDimension / height, Math.sqrt(16_777_216 / (width * height)));
    const input = source;
    if (sourceScale < 1) {
      width = Math.max(1, Math.floor(width * sourceScale)); height = Math.max(1, Math.floor(height * sourceScale));
    }
    const media = input as { currentTime?: number; getVideoPlaybackQuality?: () => { totalVideoFrames: number } };
    // A canvas may change in place (notably person mattes); identity plus time
    // does not prove its pixels unchanged. Only decoded video has a frame stamp.
    const stamp = typeof media.currentTime === "number" && typeof media.getVideoPlaybackQuality === "function" ? `${media.currentTime}/${media.getVideoPlaybackQuality().totalVideoFrames}` : null;
    const frameKey = `${width}/${height}/${sourceSeconds}/${stamp}`;
    if (stamp !== null && this.lastSource === input && this.lastSettings === settings && this.lastFrame === frameKey) return canvas;
    if (sourceScale < 1) {
      const scaled = this.scaledSource ??= new OffscreenCanvas(width, height);
      if (scaled.width !== width || scaled.height !== height) { scaled.width = width; scaled.height = height; }
      const drawing = scaled.getContext("2d")!; drawing.clearRect(0, 0, width, height); drawing.drawImage(source, 0, 0, width, height);
      source = scaled;
    }
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    gl.viewport(0, 0, width, height); gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
    if (this.lut !== settings.lut && settings.lut) {
      const lut = settings.lut, values = new Float32Array(lut.size ** 3 * 4);
      for (let index = 0; index < lut.size ** 3; index++) { values[index * 4] = lut.data[index * 3]; values[index * 4 + 1] = lut.data[index * 3 + 1]; values[index * 4 + 2] = lut.data[index * 3 + 2]; values[index * 4 + 3] = 1; }
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, this.lutTexture);
      // Float LUT values retain values outside [0,1] until the final output clamp.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, lut.size, lut.size, lut.size, 0, gl.RGBA, gl.FLOAT, values);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      this.lut = lut;
    }
    if (!settings.lut) this.lut = null;
    const uniform = (name: string) => gl.getUniformLocation(program, name);
    gl.uniform2f(uniform("pixel"), 1 / width, 1 / height);
    gl.uniform1i(uniform("look"), settings.gradingEnabled === false ? 0 : Math.max(0, CAMERA_LOOKS.indexOf(settings.look ?? "none")));
    gl.uniform1f(uniform("sharpen"), settings.sharpen ?? 0); gl.uniform1f(uniform("grain"), settings.grain ?? 0);
    gl.uniform1f(uniform("deband"), settings.deband ?? 0);
    gl.uniform1f(uniform("frameSeed"), Math.floor(sourceSeconds * 60));
    gl.uniform1i(uniform("hasLUT"), settings.lut && settings.gradingEnabled !== false ? 1 : 0);
    gl.uniform1f(uniform("intensity"), settings.lutIntensity ?? 1);
    gl.uniform1f(uniform("lutSize"), settings.lut?.size ?? 1);
    gl.uniform3fv(uniform("domainMin"), settings.lut?.domainMin ?? [0, 0, 0]); gl.uniform3fv(uniform("domainMax"), settings.lut?.domainMax ?? [1, 1, 1]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.lastSource = input; this.lastSettings = settings; this.lastFrame = frameKey;
    return canvas;
  }

  dispose(): void {
    if (this.gl) { this.gl.deleteTexture(this.texture); this.gl.deleteTexture(this.lutTexture); this.gl.deleteProgram(this.program); this.gl.getExtension("WEBGL_lose_context")?.loseContext(); }
    this.gl = null; this.canvas = null; this.program = null; this.texture = null; this.lutTexture = null; this.lut = null;
    this.lastSource = null; this.lastSettings = null; this.lastFrame = "";
    this.scaledSource = null;
    this.maximumDimension = 0;
  }
}
