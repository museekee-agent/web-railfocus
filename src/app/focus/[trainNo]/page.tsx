'use client';

import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as turf from '@turf/turf';

function computeProfile(D: number, T: number, maxV: number, accel: number) {
  let lo = 1, hi = maxV;
  for (let iter = 0; iter < 50; iter++) {
    const v = (lo + hi) / 2;
    const aTime = v / accel, aDist = v * v / (2 * accel), cDist = D - 2 * aDist;
    if (cDist < 0) { hi = v; continue; }
    if (2 * aTime + cDist / v > T) hi = v; else lo = v;
  }
  let v = (lo + hi) / 2;
  if (v > maxV) v = maxV;
  let aTime = v / accel, aDist = v * v / (2 * accel), cDist = D - 2 * aDist;
  if (cDist < 0) {
    v = Math.sqrt(accel * D);
    if (v > maxV) v = maxV;
    aTime = v / accel; aDist = v * v / (2 * accel);
    return { accelDist: aDist, cruiseDist: 0, decelDist: aDist, accelTime: aTime, cruiseTime: 0, decelTime: aTime, v, a: accel, totalDist: D, totalTime: 2 * aTime };
  }
  return { accelDist: aDist, cruiseDist: cDist, decelDist: aDist, accelTime: aTime, cruiseTime: cDist / v, decelTime: aTime, v, a: accel, totalDist: D, totalTime: 2 * aTime + cDist / v };
}

function posAtTime(p: any, elapsed: number) {
  if (elapsed <= 0) return 0;
  if (elapsed >= p.totalTime) return p.totalDist;
  if (elapsed < p.accelTime) return 0.5 * p.a * elapsed * elapsed;
  const t1 = elapsed - p.accelTime;
  if (t1 < p.cruiseTime) return p.accelDist + p.v * t1;
  const t2 = t1 - p.cruiseTime;
  return p.accelDist + p.cruiseDist + p.v * t2 - 0.5 * p.a * t2 * t2;
}

function speedKmhAtTime(p: any, elapsed: number): number {
  if (elapsed <= 0 || elapsed >= p.totalTime) return 0;
  if (elapsed < p.accelTime) return p.a * elapsed * 3.6;
  const t1 = elapsed - p.accelTime;
  if (t1 < p.cruiseTime) return p.v * 3.6;
  const t2 = t1 - p.cruiseTime;
  return Math.max(0, (p.v - p.a * t2)) * 3.6;
}

export default function FocusPage() {
  const params = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const pathParts = typeof window !== 'undefined' ? window.location.pathname.split('/') : [];
  const trainNo = pathParts[pathParts.length - 1] || 'KTX001';
  const fromName = params.get('from') || '서울';
  const toName = params.get('to') || '부산';

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const playingRef = useRef(false);
  const speedRef = useRef(1);
  const animRef = useRef(0);
  const [trainData, setTrainData] = useState<any>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentSt, setCurrentSt] = useState(fromName);
  const [nextSt, setNextSt] = useState('');
  const [arrivalTime, setArrivalTime] = useState('');
  const [elapsedSec, setElapsedSec] = useState(0);
  const [totalSec, setTotalSec] = useState(0);
  const [speedDisplay, setSpeedDisplay] = useState(1);
  const [error, setError] = useState('');
  const [currentSpeed, setCurrentSpeed] = useState(0);

  useEffect(() => {
    fetch('/data/gyeongbu-corridor.json')
      .then(r => r.json())
      .then(d => {
        const train = d.train_runs.find((t: any) => t.train_no === trainNo);
        if (!train) { setError('열차를 찾을 수 없음'); return; }
        setTrainData({ ...d, train });
        const dep = train.stops.find((s: any) => s.station === fromName);
        const arr = train.stops.find((s: any) => s.station === toName);
        if (dep?.departure && arr?.arrival) {
          const [h1, m1] = dep.departure.split(':').map(Number);
          const [h2, m2] = arr.arrival.split(':').map(Number);
          setTotalSec((h2 * 60 + m2) - (h1 * 60 + m1));
          setArrivalTime(arr.arrival);
        }
      })
      .catch((e: any) => setError('데이터 로드 실패: ' + e.message));
  }, [trainNo, fromName, toName]);

  useEffect(() => {
    if (!trainData || !containerRef.current || mapRef.current) return;
    try {
      const { corridor, train } = trainData;
      const coords = corridor.geometry.coordinates;
      const isEndpoint = (s: string) => s === fromName || s === toName;

      const map = new maplibregl.Map({
        container: containerRef.current,
        style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
        center: [128.0, 36.3],
        zoom: 7,
        attributionControl: false,
      });

      map.on('load', () => {
        map.addSource('corridor', {
          type: 'geojson',
          data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }
        });
        map.addLayer({
          id: 'corridor-line', type: 'line', source: 'corridor',
          paint: { 'line-color': '#93c5fd', 'line-width': 3 }
        });

        corridor.stations.forEach((s: any) => {
          const el = document.createElement('div');
          el.style.width = isEndpoint(s.name) ? '12px' : '6px';
          el.style.height = isEndpoint(s.name) ? '12px' : '6px';
          el.style.borderRadius = '50%';
          el.style.backgroundColor = isEndpoint(s.name) ? '#3b82f6' : '#9ca3af';
          el.style.border = '2px solid white';
          new maplibregl.Marker({ element: el }).setLngLat([s.lng, s.lat]).addTo(map);
        });

        const md = document.createElement('div');
        md.style.width = '22px';
        md.style.height = '22px';
        md.style.borderRadius = '50%';
        md.style.backgroundColor = train.color || '#4f46e5';
        md.style.border = '3px solid white';
        md.style.boxShadow = '0 0 15px rgba(79,70,229,0.7)';
        const marker = new maplibregl.Marker({ element: md })
          .setLngLat([coords[0][0], coords[0][1]])
          .addTo(map);
        markerRef.current = marker;
        mapRef.current = map;
        map.flyTo({ center: [coords[10][0], coords[10][1]], zoom: 9, duration: 800 });
      });
    } catch (e: any) { setError('지도 초기화 실패: ' + e.message); }
    return () => { mapRef.current?.remove(); mapRef.current = null; markerRef.current = null; };
  }, [trainData, fromName, toName]);

  useEffect(() => {
    if (!playing || !trainData || !markerRef.current) return;
    try {
      const { corridor, train } = trainData;
      const coords = corridor.geometry.coordinates;
      const line = turf.lineString(coords);
      const stations = corridor.stations;
      const fromIdx = train.stops.findIndex((s: any) => s.station === fromName);
      const toIdx = train.stops.findIndex((s: any) => s.station === toName);
      if (fromIdx < 0 || toIdx < 0) return;

      const segs: { fromDist: number; profile: any }[] = [];
      for (let i = fromIdx; i < toIdx; i++) {
        const s = train.stops[i], ns = train.stops[i + 1];
        if (!s.departure || !ns.arrival) continue;
        const [h1, m1] = s.departure.split(':').map(Number);
        const [h2, m2] = ns.arrival.split(':').map(Number);
        const segTime = (h2 * 60 + m2 - h1 * 60 - m1);
        if (segTime <= 0) continue;
        const fs = stations.find((x: any) => x.name === s.station);
        const ts = stations.find((x: any) => x.name === ns.station);
        if (!fs || !ts) continue;
        const segDist = ts.corridor_dist_m - fs.corridor_dist_m;
        if (segDist <= 0) continue;
        const maxV = train.type === 'KTX' ? 85 : 40;
        const accel = train.type === 'KTX' ? 0.3 : 0.4;
        segs.push({ fromDist: fs.corridor_dist_m, profile: computeProfile(segDist, segTime, maxV, accel) });
      }
      if (segs.length === 0) return;

      const totalSimTime = segs.reduce((s: number, seg: any) => s + seg.profile.totalTime, 0);
      const startTime = performance.now();
      playingRef.current = true;

      function animate() {
        if (!playingRef.current || !markerRef.current) return;
        const simElapsed = (performance.now() - startTime) / 1000 * speedRef.current;

        if (simElapsed >= totalSimTime) {
          const lastSeg = segs[segs.length - 1];
          const endPt = turf.along(line, lastSeg.fromDist + lastSeg.profile.totalDist, { units: 'meters' });
          markerRef.current.setLngLat(endPt.geometry.coordinates as [number, number]);
          setProgress(1); setCurrentSt(toName); setNextSt('');
          setElapsedSec(totalSec); setPlaying(false); playingRef.current = false;
          return;
        }

        let segElapsed = simElapsed;
        let curSeg = segs[0];
        for (const seg of segs) {
          if (simElapsed <= seg.profile.totalTime) { curSeg = seg; break; }
          segElapsed -= seg.profile.totalTime;
        }

        const dist = curSeg.fromDist + posAtTime(curSeg.profile, Math.max(0, Math.min(segElapsed, curSeg.profile.totalTime)));
        const pt = turf.along(line, dist, { units: 'meters' });
        markerRef.current.setLngLat(pt.geometry.coordinates as [number, number]);
        mapRef.current?.panTo(pt.geometry.coordinates as [number, number], { duration: 200, animate: true });

        const spd = speedKmhAtTime(curSeg.profile, Math.max(0, Math.min(segElapsed, curSeg.profile.totalTime)));
        setCurrentSpeed(Math.round(spd));

        setProgress(Math.min(1, simElapsed / totalSimTime));
        setElapsedSec(Math.min(totalSec, simElapsed));

        let curIdx = fromIdx, el = 0;
        for (let i = 0; i < segs.length; i++) {
          if (el + segs[i].profile.totalTime >= simElapsed) { curIdx = fromIdx + i; break; }
          el += segs[i].profile.totalTime;
        }
        if (curIdx < train.stops.length) {
          setCurrentSt(train.stops[curIdx].station);
          setNextSt(curIdx + 1 < train.stops.length ? train.stops[curIdx + 1].station : '');
        }
        animRef.current = requestAnimationFrame(animate);
      }
      animRef.current = requestAnimationFrame(animate);
    } catch (e: any) { setError('애니메이션 오류: ' + e.message); }
    return () => { playingRef.current = false; cancelAnimationFrame(animRef.current); };
  }, [playing, trainData, fromName, toName, totalSec]);

  const handleReset = () => {
    playingRef.current = false; setPlaying(false); cancelAnimationFrame(animRef.current);
    setProgress(0); setElapsedSec(0); setCurrentSt(fromName); setNextSt(''); setCurrentSpeed(0);
    if (markerRef.current && trainData) {
      const c = trainData.corridor.geometry.coordinates;
      markerRef.current.setLngLat([c[0][0], c[0][1]]);
    }
  };

  if (error) return <div className="w-full h-screen flex items-center justify-center bg-white"><div className="text-red-500">{error}</div></div>;

  return (
    <div style={{width:'100%',height:'100vh',position:'relative',overflow:'hidden',background:'#111827'}}>
      <div ref={containerRef} style={{position:'absolute',inset:0}} />

      {!trainData && (
        <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',background:'#f9fafb',zIndex:10000}}>
          <div style={{color:'#9ca3af',fontSize:'14px'}}>로딩 중...</div>
        </div>
      )}

      {trainData && (
        <div style={{position:'absolute',inset:0,zIndex:10000,pointerEvents:'none'}}>
          <div style={{position:'absolute',bottom:0,left:0,right:0,pointerEvents:'auto'}}>
            <div style={{background:'white',borderTopLeftRadius:'16px',borderTopRightRadius:'16px',boxShadow:'0 25px 50px rgba(0,0,0,0.25)',padding:'16px 16px 24px',borderTop:'4px solid #3b82f6'}}>

              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'8px'}}>
                <div style={{display:'flex',gap:'8px',alignItems:'center'}}>
                  <span style={{fontSize:'12px',fontWeight:'700',padding:'2px 8px',borderRadius:'999px',color:'white',background:trainData.train.color}}>{trainData.train.type}</span>
                  <span style={{fontSize:'14px',fontWeight:'600'}}>{trainData.train.name}</span>
                </div>
                <span style={{fontSize:'12px',color:'#6b7280'}}>{fromName} → {toName}</span>
              </div>

              <div style={{width:'100%',height:'8px',background:'#e5e7eb',borderRadius:'999px',overflow:'hidden',marginBottom:'12px'}}>
                <div style={{height:'100%',background:'#3b82f6',borderRadius:'999px',transition:'width 300ms',width:`${progress*100}%`}} />
              </div>

              <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:'4px',textAlign:'center',marginBottom:'12px'}}>
                <div><div style={{fontSize:'10px',color:'#6b7280'}}>현재역</div><div style={{fontSize:'13px',fontWeight:'700',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{currentSt}</div></div>
                <div><div style={{fontSize:'10px',color:'#6b7280'}}>다음역</div><div style={{fontSize:'13px',fontWeight:'700',color:'#2563eb',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{nextSt||'도착'}</div></div>
                <div><div style={{fontSize:'10px',color:'#6b7280'}}>경과</div><div style={{fontSize:'13px',fontWeight:'700'}}>{elapsedSec>0?Math.floor(elapsedSec/60)+'분':''}</div></div>
                <div><div style={{fontSize:'10px',color:'#6b7280'}}>속도</div><div style={{fontSize:'13px',fontWeight:'700',color:'#059669'}}>{currentSpeed}km/h</div></div>
                <div><div style={{fontSize:'10px',color:'#6b7280'}}>도착</div><div style={{fontSize:'13px',fontWeight:'700'}}>{arrivalTime||'-'}</div></div>
              </div>

              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div style={{display:'flex',gap:'8px',alignItems:'center'}}>
                  <button onClick={handleReset} style={{padding:'8px 12px',fontSize:'14px',background:'#f3f4f6',border:'none',borderRadius:'12px',fontWeight:'500',cursor:'pointer'}}>⟲</button>
                  <button onClick={() => setPlaying(p=>!p)} style={{padding:'12px 32px',fontSize:'16px',fontWeight:'700',color:'white',background:'#2563eb',border:'none',borderRadius:'12px',boxShadow:'0 10px 15px -3px rgba(37,99,235,0.2)',cursor:'pointer'}}>
                    {playing ? '⏸ 정지' : '▶ 재생'}
                  </button>
                </div>
                <div style={{display:'flex',gap:'4px'}}>
                  {[1,2,5,10].map(s => (
                    <button key={s} onClick={()=>{setSpeedDisplay(s);speedRef.current=s}}
                      style={{padding:'6px 12px',fontSize:'12px',fontWeight:'700',border:'none',borderRadius:'8px',cursor:'pointer',
                        background: speedDisplay===s ? '#2563eb' : '#f3f4f6', color: speedDisplay===s ? 'white' : '#4b5563'}}>{s}×</button>
                  ))}
                </div>
              </div>

            </div>
          </div>
        </div>
      )}
    </div>
  );
}
