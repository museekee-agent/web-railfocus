'use client';

import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as turf from '@turf/turf';

function haversine(lon1: number, lat1: number, lon2: number, lat2: number) {
  const R = 6371000;
  const dlon = (lon2 - lon1) * Math.PI / 180;
  const dlat = (lat2 - lat1) * Math.PI / 180;
  const a = Math.sin(dlat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dlon/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

export default function FocusPage() {
  // URL에서 파라미터 직접 추출 (Next.js 16 호환)
  const params = new URLSearchParams(
    typeof window !== 'undefined' ? window.location.search : ''
  );
  const pathParts = typeof window !== 'undefined' ? window.location.pathname.split('/') : [];
  const trainNo = pathParts[pathParts.length - 1] || 'KTX001';
  const fromName = params.get('from') || '서울';
  const toName = params.get('to') || '부산';

  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const playingRef = useRef(false);
  const speedRef = useRef(5);
  const animRef = useRef(0);
  const [ready, setReady] = useState(false);
  const [trainData, setTrainData] = useState<any>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentSt, setCurrentSt] = useState(fromName);
  const [nextSt, setNextSt] = useState('');
  const [arrivalTime, setArrivalTime] = useState('');
  const [elapsedSec, setElapsedSec] = useState(0);
  const [totalSec, setTotalSec] = useState(0);
  const [speedDisplay, setSpeedDisplay] = useState(5);

  // 데이터 로드
  useEffect(() => {
    fetch('/data/gyeongbu-corridor.json')
      .then(r => r.json())
      .then(d => {
        const train = d.train_runs.find((t: any) => t.train_no === trainNo);
        setTrainData({ ...d, train });
        
        if (train) {
          const dep = train.stops.find((s: any) => s.station === fromName);
          const arr = train.stops.find((s: any) => s.station === toName);
          if (dep?.departure && arr?.arrival) {
            const [h1, m1] = dep.departure.split(':').map(Number);
            const [h2, m2] = arr.arrival.split(':').map(Number);
            setTotalSec((h2 * 60 + m2) - (h1 * 60 + m1));
            setArrivalTime(arr.arrival);
          }
        }
      });
  }, [trainNo, fromName, toName]);

  // Map 초기화
  useEffect(() => {
    if (!trainData || !containerRef.current || mapRef.current) return;

    const is = (s: string) => fromName === s || toName === s;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
      center: [128.0, 36.3],
      zoom: 7,
      attributionControl: false,
    });

    map.on('load', () => {
      const coords = trainData.corridor.geometry.coordinates;

      map.addSource('corridor', {
        type: 'geojson',
        data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }
      });
      map.addLayer({
        id: 'corridor-line', type: 'line', source: 'corridor',
        paint: { 'line-color': '#93c5fd', 'line-width': 3 }
      });

      // 역 마커
      trainData.corridor.stations.forEach((s: any) => {
        const el = document.createElement('div');
        el.style.width = is(s.name) ? '10px' : '6px';
        el.style.height = is(s.name) ? '10px' : '6px';
        el.style.borderRadius = '50%';
        el.style.backgroundColor = is(s.name) ? '#3b82f6' : '#9ca3af';
        el.style.border = '2px solid white';
        new maplibregl.Marker({ element: el }).setLngLat([s.lng, s.lat]).addTo(map);
      });

      // 열차 마커
      const md = document.createElement('div');
      md.style.width = '20px';
      md.style.height = '20px';
      md.style.borderRadius = '50%';
      md.style.backgroundColor = trainData.train.color || '#4f46e5';
      md.style.border = '3px solid white';
      md.style.boxShadow = '0 0 15px rgba(79,70,229,0.7)';
      const marker = new maplibregl.Marker({ element: md })
        .setLngLat([coords[0][0], coords[0][1]])
        .addTo(map);
      markerRef.current = marker;

      map.flyTo({ center: [coords[10][0], coords[10][1]], zoom: 9, duration: 1000 });
      mapRef.current = map;
      setReady(true);
    });

    return () => { map.remove(); mapRef.current = null; markerRef.current = null; };
  }, [trainData, fromName, toName]);

  // 애니메이션
  useEffect(() => {
    if (!playing || !trainData || !markerRef.current || !mapRef.current) return;

    const { corridor, train } = trainData;
    const coords = corridor.geometry.coordinates;
    const line = turf.lineString(coords);
    const stations = corridor.stations;
    
    const fromIdx = train.stops.findIndex((s: any) => s.station === fromName);
    const toIdx = train.stops.findIndex((s: any) => s.station === toName);
    if (fromIdx < 0 || toIdx < 0) return;

    // 구간 프로파일 계산
    const segs: { fromDist: number; profile: any }[] = [];
    for (let i = fromIdx; i < toIdx; i++) {
      const s = train.stops[i];
      const ns = train.stops[i + 1];
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
      if (!playingRef.current || !markerRef.current || !mapRef.current) return;
      const simElapsed = (performance.now() - startTime) / 1000 * speedRef.current;

      if (simElapsed >= totalSimTime) {
        const endPt = turf.along(line, segs[segs.length - 1].fromDist + segs[segs.length - 1].profile.totalDist, { units: 'meters' });
        markerRef.current.setLngLat(endPt.geometry.coordinates as [number, number]);
        setProgress(1);
        setCurrentSt(toName);
        setNextSt('');
        setElapsedSec(totalSec);
        setPlaying(false);
        playingRef.current = false;
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
      mapRef.current.panTo(pt.geometry.coordinates as [number, number], { duration: 200, animate: true });

      setProgress(Math.min(1, simElapsed / totalSimTime));
      setElapsedSec(Math.min(totalSec, simElapsed));

      let curIdx = fromIdx;
      let el = 0;
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
    return () => { playingRef.current = false; cancelAnimationFrame(animRef.current); };
  }, [playing, trainData, fromName, toName, totalSec]);

  return (
    <div className="w-full h-screen relative bg-gray-900 overflow-hidden">
      <div ref={containerRef} className="w-full h-full" />

      {/* 하단 고정 컨트롤 */}
      <div className="absolute bottom-0 left-0 right-0 z-[9999] bg-white rounded-t-2xl shadow-2xl p-4 pb-6 border-t-4 border-blue-500">
        {/* 헤더 */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            {trainData?.train && (
              <span className="text-xs font-bold px-2 py-0.5 rounded-full text-white"
                style={{ backgroundColor: trainData.train.color }}>{trainData.train.type}</span>
            )}
            <span className="text-sm font-semibold">{trainData?.train?.name || trainNo}</span>
          </div>
          <span className="text-xs text-gray-500">{fromName} → {toName}</span>
        </div>

        {/* 진행 바 */}
        <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden mb-3">
          <div className="h-full bg-blue-500 rounded-full transition-all duration-300" style={{ width: `${progress * 100}%` }} />
        </div>

        {/* 4열 정보 */}
        <div className="grid grid-cols-4 gap-2 text-center mb-3">
          <div><div className="text-[10px] text-gray-500">현재역</div><div className="text-sm font-bold truncate">{currentSt}</div></div>
          <div><div className="text-[10px] text-gray-500">다음역</div><div className="text-sm font-bold text-blue-600 truncate">{nextSt || '도착'}</div></div>
          <div><div className="text-[10px] text-gray-500">경과</div><div className="text-sm font-bold">{elapsedSec > 0 ? `${Math.floor(elapsedSec/60)}분 ${Math.floor(elapsedSec%60)}초` : '0분'}</div></div>
          <div><div className="text-[10px] text-gray-500">도착</div><div className="text-sm font-bold">{arrivalTime || '-'}</div></div>
        </div>

        {/* 버튼 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button onClick={() => {
              playingRef.current = false; setPlaying(false); cancelAnimationFrame(animRef.current);
              setProgress(0); setElapsedSec(0); setCurrentSt(fromName); setNextSt('');
              if (markerRef.current && trainData) {
                const c = trainData.corridor.geometry.coordinates;
                markerRef.current.setLngLat([c[0][0], c[0][1]]);
              }
            }}
              className="px-3 py-2 text-sm bg-gray-100 rounded-xl font-medium">⟲</button>
            <button onClick={() => setPlaying(p => !p)}
              className="px-8 py-3 text-base font-bold text-white bg-blue-600 rounded-xl shadow-lg shadow-blue-200 active:scale-95 transition-all">
              {playing ? '⏸ 정지' : '▶ 재생'}
            </button>
          </div>
          <div className="flex gap-1">
            {[1, 2, 5, 10].map(s => (
              <button key={s} onClick={() => { setSpeedDisplay(s); speedRef.current = s; }}
                className={`px-3 py-1.5 text-xs font-bold rounded-lg ${speedDisplay === s ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'}`}>{s}×</button>
            ))}
          </div>
        </div>
      </div>

      {/* 로딩 */}
      {!trainData && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-50 z-[9998]">
          <div className="text-gray-400 text-sm">로딩 중...</div>
        </div>
      )}
    </div>
  );
}

/* 속도 프로파일 */
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
