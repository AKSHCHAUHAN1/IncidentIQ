import { useRef, useMemo, useEffect } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

const globalMouse = new THREE.Vector2(-999, -999);

const Particles = () => {
  const pointsRef = useRef();
  const { camera } = useThree();
  
  const isScattered = useRef(false);
  const timeoutRef = useRef(null);
  
  useEffect(() => {
    const handleMouseMove = (e) => {
      globalMouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      globalMouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    };
    
    const handleClick = (e) => {
      // ✨ THE FIX: Added all our specific 3D card classes to the ignore list
      if (e.target.closest('button, a, input, select, textarea, [role="button"], nav, .replica-3d-card, .metal-container-static, .premium-border-wrapper, .tech-border')) {
        return;
      }
      
      const clickMouse = new THREE.Vector2(
        (e.clientX / window.innerWidth) * 2 - 1,
        -(e.clientY / window.innerHeight) * 2 + 1
      );

      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(clickMouse, camera);

      const globeBoundary = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 4.5);

      if (raycaster.ray.intersectsSphere(globeBoundary)) {
        isScattered.current = true;
        
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        
        timeoutRef.current = setTimeout(() => {
          isScattered.current = false;
        }, 2500);
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('click', handleClick);
    
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('click', handleClick);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [camera]); 

  const count = 8000; 
  
  const [positions, initialPositions, scatterPositions, particleSpeeds] = useMemo(() => {
    const pos = new Float32Array(count * 3);
    const init = new Float32Array(count * 3);
    const scatter = new Float32Array(count * 3);
    const speeds = new Float32Array(count);
    
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * 2 * Math.PI;
      const phi = Math.acos((Math.random() * 2) - 1);
      const radius = 4.5;
      
      const x = radius * Math.sin(phi) * Math.cos(theta);
      const y = radius * Math.sin(phi) * Math.sin(theta);
      const z = radius * Math.cos(phi);
      
      pos.set([x, y, z], i * 3);
      init.set([x, y, z], i * 3);
      
      scatter.set([
        (Math.random() - 0.5) * 40, 
        (Math.random() - 0.5) * 30, 
        (Math.random() - 0.5) * 15  
      ], i * 3);
      
      speeds[i] = 0.02 + Math.random() * 0.04; 
    }
    return [pos, init, scatter, speeds];
  }, []);

  useFrame((state) => {
    if (!pointsRef.current) return;
    
    const time = state.clock.getElapsedTime();
    const angle = time * 0.05;
    pointsRef.current.rotation.y = angle;

    const vector = new THREE.Vector3(globalMouse.x, globalMouse.y, 0.5);
    vector.unproject(camera);
    const dir = vector.sub(camera.position).normalize();
    const distance = -camera.position.z / dir.z;
    const mousePos = camera.position.clone().add(dir.multiplyScalar(distance));

    const positionsArray = pointsRef.current.geometry.attributes.position.array;

    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    for (let i = 0; i < count; i++) {
      const ix = i * 3;
      
      const ox = initialPositions[ix];
      const oy = initialPositions[ix + 1];
      const oz = initialPositions[ix + 2];
      
      const sx = scatterPositions[ix];
      const sy = scatterPositions[ix + 1];
      const sz = scatterPositions[ix + 2];

      const globeWorldX = ox * cos + oz * sin;
      const globeWorldY = oy;
      const globeWorldZ = -ox * sin + oz * cos;
      
      let targetWorldX = isScattered.current ? sx : globeWorldX;
      let targetWorldY = isScattered.current ? sy : globeWorldY;
      let targetWorldZ = isScattered.current ? sz : globeWorldZ;

      const dx = targetWorldX - mousePos.x;
      const dy = targetWorldY - mousePos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      const interactionRadius = 2.0;

      if (dist < interactionRadius) {
        const force = (interactionRadius - dist) / interactionRadius;
        targetWorldX += dx * force * 0.8;
        targetWorldY += dy * force * 0.8;
      }

      if (!isScattered.current) {
         targetWorldY += Math.sin(time + ox) * 0.1;
      }

      const targetLocalX = targetWorldX * cos - targetWorldZ * sin;
      const targetLocalY = targetWorldY;
      const targetLocalZ = targetWorldX * sin + targetWorldZ * cos;

      const speed = particleSpeeds[i];
      positionsArray[ix] += (targetLocalX - positionsArray[ix]) * speed;
      positionsArray[ix + 1] += (targetLocalY - positionsArray[ix + 1]) * speed;
      positionsArray[ix + 2] += (targetLocalZ - positionsArray[ix + 2]) * speed;
    }
    
    pointsRef.current.geometry.attributes.position.needsUpdate = true;
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={count} array={positions} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial size={0.02} color="#818cf8" transparent opacity={0.8} blending={THREE.AdditiveBlending} />
    </points>
  );
};

export default function ParticleGlobe() {
  return (
    <div className="fixed inset-0 z-0 pointer-events-none mix-blend-screen opacity-50">
      <Canvas camera={{ position: [0, 0, 8] }}>
        <Particles />
      </Canvas>
    </div>
  );
}