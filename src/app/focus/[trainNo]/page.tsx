'use client';

import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as turf from '@turf/turf';

export default function FocusPage() {
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const pathParts = typeof window !== 'undefined' ? window.location.pathname.split('/') : [];
  const trainNo = pathParts[pathParts.length - 1] || 'KTX001';
  const fromName = params.get('from') || '서울';
  const toName = params.get('to') || '부산';

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const playingRef = useRef(false);
  const speedRef = useRef(1);
  const progressRef = useRef(0);
  const animRef = useRef(0);
  const [data, setData] = useState<any>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentSt, setCurrentSt] = useState(fromName);
  const [nextSt, setNextSt] = useState('');
  const [arrivalTime, setArrivalTime] = useState('');
  const [elapsedSec, setElapsedSec] = useState(0);
  const [totalSec, setTotalSec] = useState(0);
  const [speedDisp, setSpeedDisp] = useState(1);
  const [curSpeed, setCurSpeed] = useState(0);
  const [error, setError] = useState('');

  // 데이터 로드
  useEffect(() => {
    fetch('/data/gyeongbu-corridor.json').then(r => r.json()).then(d => {
      const train = d.train_runs.find((t: any) => t.train_no === trainNo);
      if (!train) { setError('열차 없음'); return; }
      setData({ ...d, train });
      const dep = train.stops.find((s: any) => s.station === fromName);
      const arr = train.stops.find((s: any) => s.station === toName);
      if (dep?.departure && arr?.arrival) {
        const [h1, m1] = dep.departure.split(':').map(Number);
        const [h2, m2] = arr.arrival.split(':').map(Number);
        setTotalSec((h2 * 60 + m2) - (h1 * 60 + m1));
        setArrivalTime(arr.arrival);
      }
    }).catch((e: any) => setError('데이터 로드 실패'));
  }, [trainNo, fromName, toName]);

  // Map 초기화
  useEffect(() => {
    if (!data || !containerRef.current || mapRef.current) return;
    try {
      const coords = data.corridor.geometry.coordinates;
      const map = new maplibregl.Map({
        container: containerRef.current,
        style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
        center: [128.0, 36.3], zoom: 8, attributionControl: false,
      });
      map.addControl(new maplibregl.FullscreenControl({ container: document.body }), 'top-right');
      map.on('load', () => {
        map.addSource('corridor', {
          type: 'geojson',
          data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }
        });
        map.addLayer({ id: 'corridor-line', type: 'line', source: 'corridor', paint: { 'line-color': '#93c5fd', 'line-width': 3 } });

        data.corridor.stations.forEach((s: any) => {
          const el = document.createElement('div');
          el.style.cssText = `width:${s.name===fromName||s.name===toName?'12':'6'}px;height:${s.name===fromName||s.name===toName?'12':'6'}px;border-radius:50%;background:${s.name===fromName||s.name===toName?'#3b82f6':'#9ca3af'};border:2px solid white`;
          new maplibregl.Marker({ element: el }).setLngLat([s.lng, s.lat]).addTo(map);
        });

        const md = document.createElement('div');
        md.style.cssText = 'width:22px;height:22px;border-radius:50%;background:#4f46e5;border:3px solid white;box-shadow:0 0 15px rgba(79,70,229,0.7)';
        const marker = new maplibregl.Marker({ element: md }).setLngLat([coords[0][0], coords[0][1]]).addTo(map);
        markerRef.current = marker;
        mapRef.current = map;
        map.flyTo({ center: [coords[10][0], coords[10][1]], zoom: 10, duration: 800 });
        setReady(true);
      });
    } catch (e: any) { setError('지도 초기화 실패'); }
    return () => { mapRef.current?.remove(); mapRef.current = null; markerRef.current = null; };
  }, [data, fromName, toName]);

  // progress 기반 애니메이션 (단순하고 안정적)
  useEffect(() => {
    if (!playing || !data || !markerRef.current || !mapRef.current || totalSec <= 0) return;

    const { corridor, train } = data;
    const coords = corridor.geometry.coordinates;
    const line = turf.lineString(coords);
    const stations = corridor.stations;
    const fromIdx = train.stops.findIndex((s: any) => s.station === fromName);
    const toIdx = train.stops.findIndex((s: any) => s.station === toName);
    if (fromIdx < 0 || toIdx < 0) return;

    // 구간 데이터 미리 계산
    const segs: { fromDist: number; toDist: number; segTime: number }[] = [];
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
      segs.push({ fromDist: fs.corridor_dist_m, toDist: ts.corridor_dist_m, segTime });
    }
    if (segs.length === 0) return;

    // 가감속 프로파일 (속도 표시용)
    function calcSpeed(seg: any, t: number): number {
      const D = seg.toDist - seg.fromDist;
      const T = seg.segTime;
      if (T <= 0) return 0;
      const a = 0.5; // m/s²
      let v = Math.min(85, a * T / 2);
      let aTime = v / a;
      let aDist = v * v / (2 * a);
      if (2 * aDist >= D) {
        v = Math.sqrt(a * D);
        aTime = v / a;
      }
      if (t <= 0) return 0;
      if (t >= T) return 0;
      if (t < aTime) return a * t * 3.6;
      if (t < T - aTime) return v * 3.6;
      const dt = t - (T - aTime);
      return Math.max(0, (v - a * dt)) * 3.6;
    }

    playingRef.current = true;
    const startTime = performance.now();

    function animate() {
      if (!playingRef.current || !markerRef.current || !mapRef.current) return;

      const realSec = (performance.now() - startTime) / 1000;
      const simSec = realSec * speedRef.current;
      const p = Math.min(1, simSec / totalSec);
      progressRef.current = p;

      if (p >= 1) {
        const endPt = turf.along(line, segs[segs.length - 1].toDist, { units: 'meters' });
        markerRef.current.setLngLat(endPt.geometry.coordinates as [number, number]);
        setProgress(1); setCurrentSt(toName); setNextSt(''); setElapsedSec(totalSec); setCurSpeed(0);
        setPlaying(false); playingRef.current = false;
        return;
      }

      // progress로 현재 위치 계산
      const totalDist = segs[segs.length - 1].toDist - segs[0].fromDist;
      const targetDist = segs[0].fromDist + totalDist * p;

      // targetDist가 속한 segment 찾기
      let segIdx = 0;
      let segStartDist = segs[0].fromDist;
      for (let i = 0; i < segs.length; i++) {
        if (targetDist <= segs[i].toDist) { segIdx = i; segStartDist = segs[i].fromDist; break; }
      }

      // segment 내 progress
      const seg = segs[segIdx];
      const segTotalDist = seg.toDist - seg.fromDist;
      const segP = segTotalDist > 0 ? (targetDist - segStartDist) / segTotalDist : 0;
      const segT = seg.segTime * segP;

      // 좌표
      const pt = turf.along(line, Math.min(targetDist, segs[segs.length - 1].toDist), { units: 'meters' });
      markerRef.current.setLngLat(pt.geometry.coordinates as [number, number]);
      mapRef.current.panTo(pt.geometry.coordinates as [number, number], { duration: 200, animate: true });

      // UI 업데이트
      setProgress(p);
      setElapsedSec(Math.round(simSec));

      const curIdx = fromIdx + segIdx;
      if (curIdx < train.stops.length) {
        setCurrentSt(train.stops[curIdx].station);
        setNextSt(curIdx + 1 < train.stops.length ? train.stops[curIdx + 1].station : '');
      }

      // 속도 (구간 내 위치 기준)
      setCurSpeed(Math.round(calcSpeed(seg, segT)));

      animRef.current = requestAnimationFrame(animate);
    }

    animRef.current = requestAnimationFrame(animate);
    return () => { playingRef.current = false; cancelAnimationFrame(animRef.current); };
  }, [playing, data, totalSec, fromName, toName]);

  const handleReset = () => {
    playingRef.current = false; setPlaying(false); cancelAnimationFrame(animRef.current);
    setProgress(0); setElapsedSec(0); setCurrentSt(fromName); setNextSt(''); setCurSpeed(0);
    if (markerRef.current && data) {
      const c = data.corridor.geometry.coordinates;
      markerRef.current.setLngLat([c[0][0], c[0][1]]);
    }
  };

  if (error) return <div style={{width:'100%',height:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'white'}}><div style={{color:'red'}}>{error}</div></div>;

  return (
    <div style={{width:'100%',height:'100vh',position:'relative',overflow:'hidden',background:'#111827'}}>
      <div ref={containerRef} style={{position:'absolute',inset:0}} />

      {!data && (
        <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',background:'#f9fafb',zIndex:10000}}>
          <div style={{color:'#9ca3af'}}>로딩 중...</div>
        </div>
      )}

      {data && (
        <div style={{position:'absolute',inset:0,zIndex:10000,pointerEvents:'none'}}>
          <div style={{position:'absolute',bottom:0,left:0,right:0,pointerEvents:'auto'}}>
            <div style={{background:'white',borderTopLeftRadius:16,borderTopRightRadius:16,boxShadow:'0 25px 50px rgba(0,0,0,0.25)',padding:'16px 16px 24px',borderTop:'4px solid #3b82f6'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <span style={{fontSize:12,fontWeight:700,padding:'2px 8px',borderRadius:999,color:'white',background:data.train.color}}>{data.train.type}</span>
                  <span style={{fontSize:14,fontWeight:600}}>{data.train.name}</span>
                </div>
                <span style={{fontSize:12,color:'#6b7280'}}>{fromName} → {toName}</span>
              </div>
              <div style={{width:'100%',height:8,background:'#e5e7eb',borderRadius:999,overflow:'hidden',marginBottom:12}}>
                <div style={{height:'100%',background:'#3b82f6',borderRadius:999,transition:'width 100ms',width:`${progress*100}%`}} />
              </div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:4,textAlign:'center',marginBottom:12}}>
                <div><div style={{fontSize:10,color:'#6b7280'}}>현재역</div><div style={{fontSize:13,fontWeight:700,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{currentSt}</div></div>
                <div><div style={{fontSize:10,color:'#6b7280'}}>다음역</div><div style={{fontSize:13,fontWeight:700,color:'#2563eb',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{nextSt||'도착'}</div></div>
                <div><div style={{fontSize:10,color:'#6b7280'}}>경과</div><div style={{fontSize:13,fontWeight:700}}>{elapsedSec>0?Math.floor(elapsedSec/60)+'분':''}</div></div>
                <div><div style={{fontSize:10,color:'#6b7280'}}>속도</div><div style={{fontSize:13,fontWeight:700,color:'#059669'}}>{curSpeed}km/h</div></div>
                <div><div style={{fontSize:10,color:'#6b7280'}}>도착</div><div style={{fontSize:13,fontWeight:700}}>{arrivalTime||'-'}</div></div>
              </div>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div style={{display:'flex',gap:8}}>
                  <button onClick={handleReset} style={{padding:'8px 12px',fontSize:14,background:'#f3f4f6',border:'none',borderRadius:12,fontWeight:500,cursor:'pointer'}}>⟲</button>
                  <button onClick={()=>setPlaying(p=>!p)} style={{padding:'12px 32px',fontSize:16,fontWeight:700,color:'white',background:'#2563eb',border:'none',borderRadius:12,boxShadow:'0 10px 15px -3px rgba(37,99,235,0.2)',cursor:'pointer'}}>
                    {playing ? '⏸ 정지' : '▶ 재생'}
                  </button>
                </div>
                <div style={{display:'flex',gap:4}}>
                  {[1,2,5,10].map(s => (
                    <button key={s} onClick={()=>{setSpeedDisp(s);speedRef.current=s}}
                      style={{padding:'6px 12px',fontSize:12,fontWeight:700,border:'none',borderRadius:8,cursor:'pointer',background:speedDisp===s?'#2563eb':'#f3f4f6',color:speedDisp===s?'white':'#4b5563'}}>{s}×</button>
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
