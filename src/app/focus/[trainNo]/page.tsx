'use client';

import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as turf from '@turf/turf';

function computeProfile(D: number, T: number, maxV: number, a: number) {
  if (T <= 0) return { accelDist: 0, cruiseDist: 0, decelDist: 0, accelTime: 0, cruiseTime: 0, decelTime: 0, v: 0, a, totalDist: D, totalTime: 0 };
  const v = Math.min(maxV, a * T / 2);
  const aTime = v / a;
  const aDist = v * v / (2 * a);
  if (2 * aDist >= D) {
    const v2 = Math.sqrt(a * D);
    const aTime2 = v2 / a;
    return { accelDist: D / 2, cruiseDist: 0, decelDist: D / 2, accelTime: aTime2, cruiseTime: 0, decelTime: aTime2, v: v2, a, totalDist: D, totalTime: 2 * aTime2 };
  }
  const cruiseDist = D - 2 * aDist;
  const cruiseTime = cruiseDist / v;
  return { accelDist: aDist, cruiseDist, decelDist: aDist, accelTime: aTime, cruiseTime, decelTime: aTime, v, a, totalDist: D, totalTime: 2 * aTime + cruiseTime };
}

function posAtTime(p: any, elapsed: number) {
  if (elapsed <= 0) return 0;
  if (elapsed >= p.totalTime) return p.totalDist;
  if (elapsed < p.accelTime) return Math.min(0.5 * p.a * elapsed * elapsed, p.totalDist);
  const t1 = elapsed - p.accelTime;
  if (t1 < p.cruiseTime) return Math.min(p.accelDist + p.v * t1, p.totalDist);
  const t2 = t1 - p.cruiseTime;
  return Math.min(Math.max(p.accelDist + p.cruiseDist + p.v * t2 - 0.5 * p.a * t2 * t2, 0), p.totalDist);
}

function speedKmh(p: any, elapsed: number) {
  if (elapsed <= 0 || elapsed >= p.totalTime - 0.5) return 0;
  if (elapsed < p.accelTime) return p.a * elapsed * 3.6;
  const t1 = elapsed - p.accelTime;
  if (t1 < p.cruiseTime) return p.v * 3.6;
  const t2 = t1 - p.cruiseTime;
  return Math.max(0, (p.v - p.a * t2)) * 3.6;
}

export default function FocusPage() {
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const pp = typeof window !== 'undefined' ? window.location.pathname.split('/') : [];
  const trainNo = pp[pp.length - 1] || 'KTX001';
  const fromName = params.get('from') || '서울';
  const toName = params.get('to') || '부산';

  const mc = useRef<HTMLDivElement>(null);
  const mapR = useRef<maplibregl.Map | null>(null);
  const markR = useRef<maplibregl.Marker | null>(null);
  const playingR = useRef(false);
  const speedR = useRef(1);
  const animR = useRef(0);
  const startTR = useRef(0);
  const dataR = useRef<any>(null); // ref로 데이터 유지
  const segsR = useRef<any[]>([]);
  const totalSimR = useRef(0);
  const totalEndR = useRef(0);
  const totalSecR = useRef(0);
  const lineR = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [curSt, setCurSt] = useState(fromName);
  const [nextSt, setNextSt] = useState('');
  const [arrT, setArrT] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [speedD, setSpeedD] = useState(1);
  const [curSpd, setCurSpd] = useState(0);
  const [err, setErr] = useState('');
  const [trainColor, setTrainColor] = useState('#4f46e5');
  const [trainType, setTrainType] = useState('');

  // 1. 데이터 로드 + 지도 초기화 (한 번만)
  useEffect(() => {
    fetch('/data/gyeongbu-corridor.json').then(r => r.json()).then(d => {
      const t = d.train_runs.find((x: any) => x.train_no === trainNo);
      if (!t) { setErr('no train'); return; }
      const full = { ...d, train: t };
      dataR.current = full;
      setTrainColor(t.color);
      setTrainType(t.type);
      const dep = t.stops.find((s: any) => s.station === fromName);
      const arr = t.stops.find((s: any) => s.station === toName);
      if (dep?.departure && arr?.arrival) {
        const [h1, m1] = dep.departure.split(':').map(Number);
        const [h2, m2] = arr.arrival.split(':').map(Number);
        totalSecR.current = (h2 * 60 + m2 - h1 * 60 - m1);
        setArrT(arr.arrival);
      }
      // 지도 초기화
      if (!mc.current) return;
      const coords = full.corridor.geometry.coordinates;
      const map = new maplibregl.Map({
        container: mc.current,
        style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
        center: [128.0, 36.3], zoom: 8, attributionControl: false,
      });
      map.addControl(new maplibregl.FullscreenControl({ container: document.body }), 'top-right');
      map.on('load', () => {
        map.addSource('c', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} } });
        map.addLayer({ id: 'cl', type: 'line', source: 'c', paint: { 'line-color': '#93c5fd', 'line-width': 3 } });
        full.corridor.stations.forEach((s: any) => {
          const el = document.createElement('div');
          el.style.cssText = `width:${s.name===fromName||s.name===toName?'12':'6'}px;height:${s.name===fromName||s.name===toName?'12':'6'}px;border-radius:50%;background:${s.name===fromName||s.name===toName?'#3b82f6':'#9ca3af'};border:2px solid white`;
          new maplibregl.Marker({ element: el }).setLngLat([s.lng, s.lat]).addTo(map);
        });
        const md = document.createElement('div');
        md.style.cssText = 'width:22px;height:22px;border-radius:50%;background:#4f46e5;border:3px solid white;box-shadow:0 0 15px rgba(79,70,229,0.7)';
        const mk = new maplibregl.Marker({ element: md }).setLngLat([coords[0][0], coords[0][1]]).addTo(map);
        markR.current = mk; mapR.current = map;
        map.flyTo({ center: [coords[10][0], coords[10][1]], zoom: 10, duration: 800 });
        // 프로파일 미리 계산
        const line = turf.lineString(coords);
        lineR.current = line;
        const stations = full.corridor.stations;
        const fromIdx = t.stops.findIndex((s: any) => s.station === fromName);
        const toIdx = t.stops.findIndex((s: any) => s.station === toName);
        const maxV = t.type === 'KTX' ? 85 : 42;
        const a = t.type === 'KTX' ? 0.5 : 0.194;
        const segs: any[] = [];
        for (let i = fromIdx; i < toIdx; i++) {
          const s = t.stops[i], ns = t.stops[i + 1];
          if (!s.departure || !ns.arrival) continue;
          const [h1, m1] = s.departure.split(':').map(Number);
          const [h2, m2] = ns.arrival.split(':').map(Number);
          const T = (h2 * 60 + m2 - h1 * 60 - m1);
          if (T <= 0) continue;
          const fs = stations.find((x: any) => x.name === s.station);
          const ts = stations.find((x: any) => x.name === ns.station);
          if (!fs || !ts) continue;
          segs.push({ fromDist: fs.corridor_dist_m, toDist: ts.corridor_dist_m, profile: computeProfile(ts.corridor_dist_m - fs.corridor_dist_m, T, maxV, a) });
        }
        segsR.current = segs;
        totalSimR.current = segs.reduce((s: number, seg: any) => s + seg.profile.totalTime, 0);
        totalEndR.current = segs.length > 0 ? segs[segs.length - 1].toDist : 0;
        setReady(true);
      });
    }).catch(() => setErr('load fail'));
    return () => { mapR.current?.remove(); mapR.current = null; markR.current = null; };
  }, [trainNo, fromName, toName]);

  // 2. 애니메이션 useEffect (playing만 의존)
  useEffect(() => {
    if (!playing || !markR.current || !mapR.current || segsR.current.length === 0 || totalSecR.current <= 0) return;

    startTR.current = performance.now();
    playingR.current = true;

    function anim() {
      if (!playingR.current || !markR.current || !mapR.current) return;
      const simElapsed = (performance.now() - startTR.current) / 1000 * speedR.current;

      if (simElapsed >= totalSimR.current) {
        const pt = turf.along(lineR.current, totalEndR.current, { units: 'meters' });
        markR.current.setLngLat(pt.geometry.coordinates as [number, number]);
        setProgress(1); setCurSt(toName); setNextSt(''); setElapsed(Math.round(totalSecR.current)); setCurSpd(0);
        setPlaying(false); playingR.current = false;
        return;
      }

      let segElapsed = simElapsed;
      let segIdx = 0;
      const segs = segsR.current;
      for (let i = 0; i < segs.length; i++) {
        if (simElapsed <= segs[i].profile.totalTime) { segIdx = i; break; }
        segElapsed -= segs[i].profile.totalTime;
      }
      if (segIdx >= segs.length) segIdx = segs.length - 1;

      const seg = segs[segIdx];
      const dist = seg.fromDist + posAtTime(seg.profile, Math.max(0, segElapsed));
      const pt = turf.along(lineR.current, Math.min(dist, totalEndR.current), { units: 'meters' });
      markR.current.setLngLat(pt.geometry.coordinates as [number, number]);
      mapR.current.panTo(pt.geometry.coordinates as [number, number], { duration: 200, animate: true });

      setProgress(Math.min(1, simElapsed / totalSimR.current));
      setElapsed(Math.round(Math.min(totalSecR.current, simElapsed)));
      setCurSpd(Math.round(speedKmh(seg.profile, Math.max(0, segElapsed))));
      setCurSt(dataR.current.train.stops[(dataR.current.train.stops.findIndex((s: any) => s.station === fromName) + segIdx)].station);
      setNextSt(segIdx + 1 < segs.length ? dataR.current.train.stops[(dataR.current.train.stops.findIndex((s: any) => s.station === fromName) + segIdx + 1)].station : '');

      animR.current = requestAnimationFrame(anim);
    }

    animR.current = requestAnimationFrame(anim);
    return () => { playingR.current = false; cancelAnimationFrame(animR.current); };
  }, [playing, toName]);

  const reset = () => {
    playingR.current = false; setPlaying(false); cancelAnimationFrame(animR.current);
    setProgress(0); setElapsed(0); setCurSt(fromName); setNextSt(''); setCurSpd(0);
    if (markR.current && dataR.current) {
      const c = dataR.current.corridor.geometry.coordinates;
      markR.current.setLngLat([c[0][0], c[0][1]]);
    }
  };

  if (err) return <div style={{width:'100%',height:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'white'}}><div style={{color:'red'}}>{err}</div></div>;

  return (
    <div style={{width:'100%',height:'100vh',position:'relative',overflow:'hidden',background:'#111827'}}>
      <div ref={mc} style={{position:'absolute',inset:0}} />
      {!ready && <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',background:'#f9fafb',zIndex:10000}}><div style={{color:'#9ca3af'}}>로딩 중...</div></div>}
      {ready && (
        <div style={{position:'absolute',inset:0,zIndex:10000,pointerEvents:'none'}}>
          <div style={{position:'absolute',bottom:0,left:0,right:0,pointerEvents:'auto'}}>
            <div style={{background:'white',borderTopLeftRadius:16,borderTopRightRadius:16,boxShadow:'0 25px 50px rgba(0,0,0,0.25)',padding:'16px 16px 24px',borderTop:'4px solid #3b82f6'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <span style={{fontSize:12,fontWeight:700,padding:'2px 8px',borderRadius:999,color:'white',background:trainColor}}>{trainType}</span>
                  <span style={{fontSize:14,fontWeight:600}}>{trainNo}</span>
                </div>
                <span style={{fontSize:12,color:'#6b7280'}}>{fromName} → {toName}</span>
              </div>
              <div style={{width:'100%',height:8,background:'#e5e7eb',borderRadius:999,overflow:'hidden',marginBottom:12}}>
                <div style={{height:'100%',background:'#3b82f6',borderRadius:999,transition:'width 100ms',width:`${progress*100}%`}} />
              </div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:4,textAlign:'center',marginBottom:12}}>
                <div><div style={{fontSize:10,color:'#6b7280'}}>현재역</div><div style={{fontSize:13,fontWeight:700,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{curSt}</div></div>
                <div><div style={{fontSize:10,color:'#6b7280'}}>다음역</div><div style={{fontSize:13,fontWeight:700,color:'#2563eb',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{nextSt||'도착'}</div></div>
                <div><div style={{fontSize:10,color:'#6b7280'}}>경과</div><div style={{fontSize:13,fontWeight:700}}>{elapsed>0?Math.floor(elapsed/60)+'분':''}</div></div>
                <div><div style={{fontSize:10,color:'#6b7280'}}>속도</div><div style={{fontSize:13,fontWeight:700,color:'#059669'}}>{curSpd}km/h</div></div>
                <div><div style={{fontSize:10,color:'#6b7280'}}>도착</div><div style={{fontSize:13,fontWeight:700}}>{arrT||'-'}</div></div>
              </div>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div style={{display:'flex',gap:8}}>
                  <button onClick={reset} style={{padding:'8px 12px',fontSize:14,background:'#f3f4f6',border:'none',borderRadius:12,fontWeight:500,cursor:'pointer'}}>⟲</button>
                  <button onClick={()=>setPlaying(p=>!p)} style={{padding:'12px 32px',fontSize:16,fontWeight:700,color:'white',background:'#2563eb',border:'none',borderRadius:12,boxShadow:'0 10px 15px -3px rgba(37,99,235,0.2)',cursor:'pointer'}}>
                    {playing ? '⏸ 정지' : '▶ 재생'}
                  </button>
                </div>
                <div style={{display:'flex',gap:4}}>
                  {[1,2,5,10].map(s => (
                    <button key={s} onClick={()=>{setSpeedD(s);speedR.current=s}}
                      style={{padding:'6px 12px',fontSize:12,fontWeight:700,border:'none',borderRadius:8,cursor:'pointer',background:speedD===s?'#2563eb':'#f3f4f6',color:speedD===s?'white':'#4b5563'}}>{s}×</button>
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
