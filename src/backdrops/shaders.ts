const VERTEX = `#version 300 es
in vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const ORBITAL = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
out vec4 fragColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;

  vec3 color = vec3(0.012, 0.02, 0.018);
  color += vec3(0.02, 0.05, 0.04) * (1.0 - length(p) * 0.55);

  float stars = 0.0;
  for (float i = 1.0; i <= 3.0; i += 1.0) {
    vec2 grid = floor(uv * (40.0 + i * 28.0));
    vec2 cell = fract(uv * (40.0 + i * 28.0));
    float n = hash(grid + i);
    float twinkle = 0.55 + 0.45 * sin(uTime * (1.2 + n) + n * 20.0);
    stars += step(0.965, n) * smoothstep(0.18, 0.0, length(cell - 0.5)) * twinkle / i;
  }
  color += vec3(0.72, 0.9, 0.82) * stars;

  vec2 planetC = vec2(0.08, -0.62);
  float planet = length(p - planetC);
  float surface = smoothstep(0.72, 0.68, planet);
  vec3 planetCol = mix(vec3(0.02, 0.07, 0.06), vec3(0.08, 0.22, 0.18), surface);
  planetCol += vec3(0.12, 0.35, 0.28) * smoothstep(0.4, 0.0, planet) * 0.35;
  float terminator = smoothstep(-0.2, 0.45, (p.x - planetC.x) * 0.8 + 0.1);
  planetCol *= mix(0.25, 1.0, terminator);
  color = mix(color, planetCol, surface);
  float atmos = smoothstep(0.86, 0.7, planet) * (1.0 - surface);
  color += vec3(0.18, 0.55, 0.42) * atmos * 0.55;

  float ring = abs(length((p - planetC) * vec2(1.0, 2.6)) - 0.92);
  float ringMask = smoothstep(0.04, 0.0, ring) * (1.0 - surface);
  color += vec3(0.55, 0.9, 0.78) * ringMask * (0.18 + 0.08 * sin(uTime * 0.4));

  vec2 station = p - vec2(0.42, 0.12);
  float hull = smoothstep(0.012, 0.0, abs(station.y) - 0.018) * smoothstep(0.16, 0.0, abs(station.x));
  float mast = smoothstep(0.006, 0.0, abs(station.x + 0.02) - 0.004) * smoothstep(0.11, 0.0, abs(station.y - 0.05));
  float spoke = smoothstep(0.005, 0.0, abs(length(station) - 0.07));
  float lights = 0.0;
  lights += 0.6 + 0.4 * sin(uTime * 2.1 + floor(station.x * 40.0));
  color += vec3(0.55, 0.95, 0.8) * (hull + mast * 0.8 + spoke * 0.35) * 0.85;
  color += vec3(0.9, 1.0, 0.92) * hull * lights * 0.15;

  color *= 0.35 + 0.65 * smoothstep(1.2, 0.15, length(p));
  fragColor = vec4(color, 1.0);
}
`;

const NEON = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
out vec4 fragColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(269.5, 183.3))) * 43758.5453);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;

  vec3 sky = mix(vec3(0.05, 0.02, 0.08), vec3(0.01, 0.01, 0.03), uv.y);
  sky += vec3(0.25, 0.05, 0.18) * smoothstep(0.55, 0.0, abs(uv.x - 0.5)) * (1.0 - uv.y) * 0.45;
  vec3 color = sky;

  float horizon = 0.28;
  float city = 0.0;
  float windows = 0.0;
  float cols = 18.0;
  float col = floor(uv.x * cols);
  float h = 0.18 + hash(vec2(col, 2.4)) * 0.42;
  float building = step(uv.y, horizon + h) * step(fract(uv.x * cols), 0.78);
  city = max(city, building);

  vec2 win = vec2(uv.x * 42.0, uv.y * 28.0);
  float on = step(0.62, hash(floor(win) + 9.0));
  float pulse = 0.75 + 0.25 * sin(uTime * 0.7 + hash(floor(win)) * 30.0);
  windows = on * pulse * building * step(horizon + 0.02, uv.y);

  color = mix(color, vec3(0.04, 0.03, 0.07), city);
  color += vec3(0.95, 0.35, 0.72) * windows * 0.55;
  color += vec3(0.2, 0.85, 0.95) * windows * step(0.5, hash(floor(win) + 3.1)) * 0.25;

  float street = smoothstep(horizon + 0.02, horizon - 0.04, uv.y);
  color = mix(color, vec3(0.03, 0.02, 0.05), street * 0.9);
  float glow = exp(-abs(uv.y - horizon) * 18.0);
  color += vec3(0.7, 0.18, 0.45) * glow * 0.35;
  color += vec3(0.1, 0.55, 0.7) * glow * 0.2;

  float rain = 0.0;
  vec2 rainUv = vec2(uv.x * 70.0, uv.y * 18.0 - uTime * 1.6);
  rain = smoothstep(0.07, 0.0, abs(fract(rainUv.x) - 0.5)) * step(0.82, hash(floor(rainUv)));
  color += vec3(0.45, 0.7, 0.85) * rain * 0.12;

  float scan = 0.96 + 0.04 * sin(gl_FragCoord.y * 1.5 + uTime * 0.2);
  color *= scan;
  color *= 0.4 + 0.6 * smoothstep(1.15, 0.2, length(p * vec2(0.7, 1.0)));
  fragColor = vec4(color, 1.0);
}
`;

export const BACKDROP_SHADERS = {
  "orbital-station": ORBITAL,
  "neon-city": NEON,
} as const;

export const BACKDROP_VERTEX_SHADER = VERTEX;
