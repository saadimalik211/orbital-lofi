import type { ParticleKind, WorldEffects } from "@/worlds/types";

type Star = {
  x: number;
  y: number;
  r: number;
  phase: number;
  twinkle: number;
};

type Drop = {
  x: number;
  y: number;
  length: number;
  speed: number;
  drift: number;
};

type Speck = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  a: number;
};

function count(intensity: number, min: number, extra: number) {
  return Math.max(0, Math.round(min + extra * Math.min(1, Math.max(0, intensity))));
}

export function createEffectsRenderer(
  canvas: HTMLCanvasElement,
  effects: WorldEffects,
  reducedMotion: boolean,
) {
  const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
  if (!ctx) {
    return () => {};
  }

  const rain = effects.rain?.intensity ?? 0;
  const stars = effects.stars?.intensity ?? 0;
  const particles = effects.particles;
  const particleIntensity = particles?.intensity ?? 0;
  const particleType: ParticleKind = particles?.type ?? "atmosphere";

  const needsLoop = !reducedMotion && (rain > 0 || stars > 0 || particleIntensity > 0);
  const needsDraw = rain > 0 || stars > 0 || particleIntensity > 0;
  if (!needsDraw) {
    return () => {};
  }

  let width = 0;
  let height = 0;
  let running = true;
  let frame = 0;
  const starList: Star[] = [];
  const drops: Drop[] = [];
  const specks: Speck[] = [];

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const nextWidth = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const nextHeight = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width === nextWidth && canvas.height === nextHeight) {
      return;
    }
    canvas.width = nextWidth;
    canvas.height = nextHeight;
    width = nextWidth;
    height = nextHeight;
    seed(dpr);
  };

  const seed = (dpr: number) => {
    starList.length = 0;
    drops.length = 0;
    specks.length = 0;

    if (stars > 0) {
      const n = count(stars, 28, 48);
      for (let i = 0; i < n; i += 1) {
        starList.push({
          x: Math.random() * width,
          y: Math.random() * height * 0.72,
          r: (Math.random() * 1.1 + 0.35) * dpr,
          phase: Math.random() * Math.PI * 2,
          twinkle: 0.4 + Math.random() * 0.8,
        });
      }
    }

    if (rain > 0) {
      const n = count(rain, 36, 70);
      for (let i = 0; i < n; i += 1) {
        drops.push({
          x: Math.random() * width,
          y: Math.random() * height,
          length: (9 + Math.random() * 14) * dpr,
          speed: (4.2 + Math.random() * 3.4) * dpr,
          drift: (1.4 + Math.random() * 0.8) * dpr,
        });
      }
    }

    if (particleIntensity > 0) {
      const n = count(particleIntensity, 18, 36);
      for (let i = 0; i < n; i += 1) {
        const dust = particleType === "dust";
        const snow = particleType === "snow";
        specks.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (dust ? 0.18 : snow ? 0.08 : 0.05) * (0.4 + Math.random()) * dpr,
          vy: (dust ? 0.04 : snow ? 0.22 : 0.03) * (0.5 + Math.random()) * dpr,
          r: ((snow ? 1.4 : dust ? 0.8 : 1.1) + Math.random()) * dpr,
          a: 0.08 + Math.random() * 0.14,
        });
      }
    }
  };

  const drawStars = (now: number) => {
    for (const star of starList) {
      const twinkle = reducedMotion
        ? 0.55
        : 0.28 + 0.72 * (0.5 + 0.5 * Math.sin(now * 0.0014 * star.twinkle + star.phase));
      ctx.fillStyle = `rgba(220, 236, 255, ${0.22 * stars + twinkle * 0.45 * stars})`;
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  const drawRain = () => {
    ctx.strokeStyle = `rgba(186, 214, 228, ${0.12 + rain * 0.22})`;
    ctx.lineWidth = Math.max(1, canvas.width / 900);
    ctx.beginPath();
    for (const drop of drops) {
      ctx.moveTo(drop.x, drop.y);
      ctx.lineTo(drop.x - drop.drift * 0.85, drop.y + drop.length);
      if (!reducedMotion) {
        drop.x -= drop.drift;
        drop.y += drop.speed;
        if (drop.y > height + drop.length) {
          drop.y = -drop.length;
          drop.x = Math.random() * width;
        }
        if (drop.x < -drop.length) {
          drop.x = width + drop.drift;
        }
      }
    }
    ctx.stroke();
  };

  const drawParticles = () => {
    const tint =
      particleType === "dust"
        ? "196, 168, 122"
        : particleType === "snow"
          ? "226, 236, 242"
          : "186, 210, 214";
    for (const speck of specks) {
      ctx.fillStyle = `rgba(${tint}, ${speck.a * particleIntensity})`;
      ctx.beginPath();
      ctx.arc(speck.x, speck.y, speck.r, 0, Math.PI * 2);
      ctx.fill();
      if (!reducedMotion) {
        speck.x += speck.vx;
        speck.y += speck.vy;
        if (speck.x > width) {
          speck.x = 0;
        }
        if (speck.y > height) {
          speck.y = 0;
        }
        if (speck.x < 0) {
          speck.x = width;
        }
        if (speck.y < 0) {
          speck.y = height;
        }
      }
    }
  };

  const draw = (now: number) => {
    if (!running) {
      return;
    }
    resize();
    ctx.clearRect(0, 0, width, height);
    if (stars > 0) {
      drawStars(now);
    }
    if (particleIntensity > 0) {
      drawParticles();
    }
    if (rain > 0) {
      drawRain();
    }
    if (needsLoop) {
      frame = window.requestAnimationFrame(draw);
    }
  };

  const onResize = () => {
    if (!running) {
      return;
    }
    if (needsLoop) {
      return;
    }
    draw(performance.now());
  };

  resize();
  frame = window.requestAnimationFrame(draw);
  window.addEventListener("resize", onResize);

  return () => {
    running = false;
    window.cancelAnimationFrame(frame);
    window.removeEventListener("resize", onResize);
  };
}
