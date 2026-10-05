import {
  BACKDROP_SHADERS,
  BACKDROP_VERTEX_SHADER,
} from "@/backdrops/shaders";
import type { SceneBackdropId } from "@/worlds/types";

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Could not create shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) ?? "Shader compile failed";
    gl.deleteShader(shader);
    throw new Error(info);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, fragmentSource: string) {
  const vertex = compile(gl, gl.VERTEX_SHADER, BACKDROP_VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) {
    throw new Error("Could not create program");
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program) ?? "Program link failed";
    gl.deleteProgram(program);
    throw new Error(info);
  }
  return program;
}

export function createBackdropRenderer(
  canvas: HTMLCanvasElement,
  backdrop: SceneBackdropId,
  onFirstFrame?: () => void,
) {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    powerPreference: "low-power",
  });
  if (!gl) {
    throw new Error("WebGL2 is not available");
  }

  const program = createProgram(gl, BACKDROP_SHADERS[backdrop]);
  const buffer = gl.createBuffer();
  const positionLoc = gl.getAttribLocation(program, "aPos");
  const resolutionLoc = gl.getUniformLocation(program, "uResolution");
  const timeLoc = gl.getUniformLocation(program, "uTime");

  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  );
  gl.useProgram(program);
  gl.enableVertexAttribArray(positionLoc);
  gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

  let frame = 0;
  let running = true;
  let announced = false;
  const startedAt = performance.now();

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  };

  const draw = (now: number) => {
    if (!running) {
      return;
    }
    resize();
    gl.uniform2f(resolutionLoc, canvas.width, canvas.height);
    gl.uniform1f(timeLoc, (now - startedAt) / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!announced) {
      announced = true;
      onFirstFrame?.();
    }
    frame = window.requestAnimationFrame(draw);
  };

  frame = window.requestAnimationFrame(draw);

  return () => {
    running = false;
    window.cancelAnimationFrame(frame);
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
  };
}
