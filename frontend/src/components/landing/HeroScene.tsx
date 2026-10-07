import { useEffect, useRef } from 'react';
import * as THREE from 'three';

/**
 * The landing hero's ambient motion — the only moving part on the public face.
 *
 * A slow drift of slate particles with one faint tilted ring echoing the crest's
 * roundel, drawn in the brand colour so it reads as atmosphere rather than as an
 * effect. It is deliberately `aria-hidden` and `pointer-events: none`: the hero
 * says everything in words, and the scene must never sit between a reader and
 * the copy.
 *
 * Cost discipline, because the audience is on school-grade connections:
 *
 *  - One canvas, one draw call for the particles, one for the ring. No post
 *    processing, no per-frame allocation — positions are mutated in place.
 *  - Pixel ratio capped at 2; a retina phone renders at most 4× the CSS pixels.
 *  - The loop stops entirely when the hero scrolls out of view or the tab is
 *    hidden, and `prefers-reduced-motion` renders a single static frame with no
 *    listeners at all.
 *  - A machine without WebGL does not get an error — it gets the parchment
 *    background, exactly as the page looked before the scene existed.
 *
 * Everything is disposed on unmount (geometry, material, renderer, canvas,
 * observers, listeners) so React's StrictMode double-mount in development does
 * not leak a WebGL context.
 */
export function HeroScene({ className }: { className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: false,
        powerPreference: 'low-power',
      });
    } catch {
      // No WebGL (remote desktop, locked-down browser): keep the designed page.
      return undefined;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 30);
    camera.position.set(0, 0, 6);

    /* ---------------------------------------------------------------- */
    /* Particles — one buffer, positions mutated in place                */
    /* ---------------------------------------------------------------- */
    const COUNT = 260;
    const positions = new Float32Array(COUNT * 3);
    const originX = new Float32Array(COUNT);
    const originY = new Float32Array(COUNT);
    const phase = new Float32Array(COUNT);
    const speed = new Float32Array(COUNT);

    for (let i = 0; i < COUNT; i += 1) {
      const x = (Math.random() - 0.5) * 15;
      const y = (Math.random() - 0.5) * 9;
      const z = (Math.random() - 0.5) * 5 - 1;
      originX[i] = x;
      originY[i] = y;
      phase[i] = Math.random() * Math.PI * 2;
      speed[i] = 0.12 + Math.random() * 0.3;
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
    }

    const particleGeometry = new THREE.BufferGeometry();
    particleGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const particleMaterial = new THREE.PointsMaterial({
      color: 0x43616f,
      size: 0.05,
      transparent: true,
      opacity: 0.34,
      sizeAttenuation: true,
      depthWrite: false,
    });

    const particles = new THREE.Points(particleGeometry, particleMaterial);
    scene.add(particles);

    /* ---------------------------------------------------------------- */
    /* The roundel — the crest's ring, tilted like a seal on paper       */
    /* ---------------------------------------------------------------- */
    const ringGeometry = new THREE.RingGeometry(2.3, 2.37, 96);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x43616f,
      transparent: true,
      opacity: 0.1,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.position.set(1.4, 0.1, -1.4);
    ring.rotation.x = 0.5;
    scene.add(ring);

    /* ---------------------------------------------------------------- */
    /* Sizing                                                            */
    /* ---------------------------------------------------------------- */
    const resize = () => {
      const width = host.clientWidth || 1;
      const height = host.clientHeight || 1;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);

    /* ---------------------------------------------------------------- */
    /* Loop — runs only while the hero is on screen and the tab is live  */
    /* ---------------------------------------------------------------- */
    let raf = 0;
    let lastTime = 0;
    let onScreen = true;
    let pointerX = 0;
    let pointerY = 0;
    let targetX = 0;
    let targetY = 0;

    const renderFrame = (timeMs: number) => {
      const t = timeMs / 1000;
      const dt = lastTime ? Math.min((timeMs - lastTime) / 1000, 0.1) : 0;
      lastTime = timeMs;

      for (let i = 0; i < COUNT; i += 1) {
        const drift = speed[i]!;
        const wobble = phase[i]!;
        positions[i * 3] = originX[i]! + Math.sin(t * drift * 0.7 + wobble) * 0.18;
        positions[i * 3 + 1] = originY[i]! + Math.sin(t * drift + wobble) * 0.3;
      }
      particleGeometry.attributes.position!.needsUpdate = true;

      ring.rotation.z += dt * 0.08;

      // Ease the camera toward the pointer for a whisper of parallax.
      pointerX += (targetX - pointerX) * 0.03;
      pointerY += (targetY - pointerY) * 0.03;
      camera.position.x = pointerX;
      camera.position.y = pointerY;
      camera.lookAt(0, 0, 0);

      renderer.render(scene, camera);
    };

    const start = () => {
      if (raf || reducedMotion) return;
      lastTime = 0;
      const loop = (timeMs: number) => {
        raf = window.requestAnimationFrame(loop);
        renderFrame(timeMs);
      };
      raf = window.requestAnimationFrame(loop);
    };

    const stop = () => {
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
    };

    const evaluateRunState = () => {
      if (onScreen && !document.hidden) start();
      else stop();
    };

    const onPointerMove = (event: PointerEvent) => {
      targetX = (event.clientX / window.innerWidth - 0.5) * 0.35;
      targetY = -(event.clientY / window.innerHeight - 0.5) * 0.2;
    };

    const visibilityObserver = new IntersectionObserver(
      (entries) => {
        onScreen = entries[0]?.isIntersecting ?? true;
        evaluateRunState();
      },
      { threshold: 0 },
    );
    visibilityObserver.observe(host);
    document.addEventListener('visibilitychange', evaluateRunState);

    if (reducedMotion) {
      // One composed frame, no loop, no listeners: motion is the thing the
      // preference asks to remove, but the composition need not disappear.
      renderFrame(0);
    } else {
      window.addEventListener('pointermove', onPointerMove, { passive: true });
      evaluateRunState();
    }

    return () => {
      stop();
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      document.removeEventListener('visibilitychange', evaluateRunState);
      window.removeEventListener('pointermove', onPointerMove);

      particleGeometry.dispose();
      particleMaterial.dispose();
      ringGeometry.dispose();
      ringMaterial.dispose();
      renderer.dispose();
      host.replaceChildren();
    };
  }, []);

  return <div ref={hostRef} className={className} aria-hidden="true" />;
}

export default HeroScene;
