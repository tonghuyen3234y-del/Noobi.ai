import { useEffect, useRef } from 'react';

const ENABLED_QUERY = '(min-width: 800px) and (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)';
const MAX_PARTICLES = 160;
const COLORS = ['#fff1ff', '#e6ceff', '#b784ff', '#f3bfff'];
const DIGITS = ['0', '1', '01', '10', '7', '9'];
const STAR_FADE_MS = 1300;
// Coordinates of stars in the original artwork, before the centered cover crop.
const STARS = [
  [0.075, 0.024], [0.229, 0.045], [0.278, 0.135], [0.343, 0.072],
  [0.427, 0.098], [0.612, 0.036], [0.731, 0.064], [0.977, 0.043],
  [0.662, 0.153], [0.731, 0.153], [0.609, 0.204], [0.702, 0.238],
  [0.733, 0.220], [0.453, 0.274], [0.477, 0.241], [0.505, 0.272],
  [0.613, 0.293], [0.675, 0.312], [0.350, 0.328], [0.388, 0.314],
  [0.359, 0.394], [0.402, 0.403], [0.439, 0.387], [0.475, 0.419],
  [0.502, 0.386], [0.524, 0.374], [0.612, 0.406], [0.664, 0.460],
  [0.470, 0.535],
] as const;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
  size: number;
  kind: number;
  color: string;
  digit: string;
}

/** Decorative, demand-driven canvas. Pointer updates never trigger React renders. */
export function HomePixelAtmosphere() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    const context = canvas?.getContext('2d');
    if (!canvas || !host || !context) return;
    const media = window.matchMedia(ENABLED_QUERY);
    let disposeAnimation: (() => void) | undefined;

    function syncPreference() {
      disposeAnimation?.();
      disposeAnimation = undefined;
      if (media.matches) disposeAnimation = animate(canvas!, host!, context!);
    }

    syncPreference();
    media.addEventListener('change', syncPreference);
    return () => {
      media.removeEventListener('change', syncPreference);
      disposeAnimation?.();
    };
  }, []);

  return <canvas ref={canvasRef} className="home-pixel-atmosphere" aria-hidden="true" />;
}

function animate(canvas: HTMLCanvasElement, host: HTMLElement, ctx: CanvasRenderingContext2D) {
  let bounds = host.getBoundingClientRect();
  let width = bounds.width;
  let height = bounds.height;
  let frame = 0;
  let previousTime = 0;
  let lastEmission = 0;
  let lastMovement = -Infinity;
  let pointer: { x: number; y: number } | null = null;
  let emitted: { x: number; y: number } | null = null;
  const particles: Particle[] = [];
  // Cache a tiny glow texture instead of applying full-canvas blur/shadows.
  const glow = document.createElement('canvas');
  glow.width = glow.height = 32;
  const glowContext = glow.getContext('2d');
  if (glowContext) {
    const gradient = glowContext.createRadialGradient(16, 16, 0, 16, 16, 16);
    gradient.addColorStop(0, 'rgba(252, 235, 255, 1)');
    gradient.addColorStop(0.25, 'rgba(190, 128, 255, 0.65)');
    gradient.addColorStop(1, 'rgba(168, 122, 255, 0)');
    glowContext.fillStyle = gradient;
    glowContext.fillRect(0, 0, 32, 32);
  }

  function clear() {
    cancelAnimationFrame(frame);
    frame = 0;
    previousTime = 0;
    pointer = emitted = null;
    particles.length = 0;
    ctx.clearRect(0, 0, width, height);
  }

  function resize() {
    clear();
    bounds = host.getBoundingClientRect();
    width = bounds.width;
    height = bounds.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function emit(now: number) {
    if (!pointer || now - lastMovement > 90 || now - lastEmission < 16) return;
    const from = emitted ?? pointer;
    const distance = Math.hypot(pointer.x - from.x, pointer.y - from.y);
    if (emitted && distance < 3) return;
    const count = Math.min(8, Math.max(3, Math.ceil(distance / 8)));
    for (let index = 0; index < count && particles.length < MAX_PARTICLES; index += 1) {
      const t = (index + 1) / count;
      particles.push({
        x: from.x + (pointer.x - from.x) * t + (Math.random() - 0.5) * 32,
        y: from.y + (pointer.y - from.y) * t + (Math.random() - 0.5) * 32,
        vx: (Math.random() - 0.5) * 30,
        vy: -10 - Math.random() * 24,
        born: now,
        life: 680 + Math.random() * 400,
        size: 2 + Math.floor(Math.random() * 3),
        // Every burst includes a number, a glow, and a solid pixel.
        kind: index % 3,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        digit: DIGITS[Math.floor(Math.random() * DIGITS.length)],
      });
    }
    emitted = { ...pointer };
    lastEmission = now;
  }

  function draw(now: number) {
    frame = 0;
    const dt = Math.min((now - (previousTime || now)) / 1000, 0.04);
    previousTime = now;
    ctx.clearRect(0, 0, width, height);
    emit(now);
    ctx.font = 'bold 12px monospace';
    for (let index = particles.length - 1; index >= 0; index -= 1) {
      const particle = particles[index];
      const age = (now - particle.born) / particle.life;
      if (age >= 1) {
        particles.splice(index, 1);
        continue;
      }
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      ctx.globalAlpha = 0.95 * Math.min(age / 0.06, 1) * (1 - age) ** 1.25;
      ctx.fillStyle = particle.color;
      const x = Math.round(particle.x);
      const y = Math.round(particle.y);
      if (particle.kind === 0) {
        // A fine violet outline keeps digits readable against the bright clouds.
        ctx.strokeStyle = '#7650ac';
        ctx.lineWidth = 1.5;
        ctx.strokeText(particle.digit, x, y);
        ctx.fillText(particle.digit, x, y);
      } else if (particle.kind === 1) {
        const size = 24 + particle.size * 5;
        ctx.drawImage(glow, x - size / 2, y - size / 2, size, size);
      } else {
        ctx.fillRect(x, y, particle.size, particle.size);
      }
    }

    const recency = Math.max(0, 1 - (now - lastMovement) / STAR_FADE_MS);
    if (pointer && recency > 0) {
      ctx.globalAlpha = recency * 0.32;
      ctx.drawImage(glow, pointer.x - 40, pointer.y - 40, 80, 80);
      // Mirror background-size: cover so highlights stay attached after resize.
      const scale = Math.max(width / 1672, height / 941);
      const offsetX = (width - 1672 * scale) / 2;
      const offsetY = (height - 941 * scale) / 2;
      for (let index = 0; index < STARS.length; index += 1) {
        const star = STARS[index];
        const x = star[0] * 1672 * scale + offsetX;
        const y = star[1] * 941 * scale + offsetY;
        const dx = pointer.x - x;
        const dy = pointer.y - y;
        const proximity = Math.max(0, 1 - Math.hypot(dx, dy) / 240);
        if (proximity === 0) continue;
        const strength = proximity * recency;
        const px = Math.round(x + dx * 0.065 * strength);
        const py = Math.round(y + dy * 0.065 * strength);
        ctx.globalAlpha = strength * (0.62 + 0.33 * Math.sin(now / 190 + index));
        ctx.drawImage(glow, px - 23, py - 23, 46, 46);
        ctx.fillStyle = '#fff2ff';
        const ray = 4 + Math.round(strength * 2);
        ctx.fillRect(px - 1, py - ray, 2, ray * 2);
        ctx.fillRect(px - ray, py - 1, ray * 2, 2);
      }
    }
    ctx.globalAlpha = 1;
    if (particles.length > 0 || (pointer && recency > 0)) frame = requestAnimationFrame(draw);
    else previousTime = 0;
  }

  function onPointerMove(event: PointerEvent) {
    if (event.pointerType !== 'mouse' || document.hidden) return;
    pointer = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    lastMovement = performance.now();
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function onPointerLeave() {
    pointer = emitted = null;
  }

  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  host.addEventListener('pointermove', onPointerMove, { passive: true });
  host.addEventListener('pointerleave', onPointerLeave);
  window.addEventListener('blur', clear);
  document.addEventListener('visibilitychange', clear);

  return () => {
    observer.disconnect();
    host.removeEventListener('pointermove', onPointerMove);
    host.removeEventListener('pointerleave', onPointerLeave);
    window.removeEventListener('blur', clear);
    document.removeEventListener('visibilitychange', clear);
    clear();
    canvas.width = canvas.height = 0;
  };
}
