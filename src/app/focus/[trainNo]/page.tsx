'use client';

import { Suspense, useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as turf from '@turf/turf';

interface Station { name: string; lat: number; lng: number; corridor_dist_m: number }
interface TrainStop { station: string; arrival: string | null; departure: string | null }
interface TrainRun {
  train_no: string; name: string; type: string; color: string;
  service_path_id: string; stops: TrainStop[];
}
interface CorridorData {
  corridor: {
    geometry: { type: string; coordinates: number[][] };
    stations: Station[];
  };
  train_runs: TrainRun[];
}

/* ---- 사다리꼴 속도 프로파일 ---- */
interface SegProfile {
  accelDist: number; cruiseDist: number; decelDist: number;
  accelTime: number; cruiseTime: number; decelTime: number;
  v: number; a: number; totalDist: number; totalTime: number;
}

function computeProfile(D: number, T: number, maxV: number, accel: number): SegProfile {
  let lo = 1, hi = maxV;
  for (let iter = 0; iter < 50; iter++) {
    const v = (lo + hi) / 2;
    const accelTime = v / accel;
    const accelDist = v * v / (2 * accel);
    const cruiseDist = D - 2 * accelDist;
    if (cruiseDist < 0) { hi = v; continue; }
    const cruiseTime = cruiseDist / v;
    if (2 * accelTime + cruiseTime > T) hi = v; else lo = v;
  }
  let v = (lo + hi) / 2;
  if (v > maxV) v = maxV;
  let accelTime = v / accel;
  let accelDist = v * v / (2 * accel);
  let cruiseDist = D - 2 * accelDist;
  if (cruiseDist < 0) {
    v = Math.sqrt(accel * D);
    if (v > maxV) v = maxV;
    accelTime = v / accel;
    accelDist = v * v / (2 * accel);
    return { accelDist, cruiseDist: 0, decelDist: accelDist, accelTime, cruiseTime: 0, decelTime: accelTime, v, a: accel, totalDist: D, totalTime: 2 * accelTime };
  }
  const cruiseTime = cruiseDist / v;
  const decelTime = v / accel;
  return { accelDist, cruiseDist, decelDist: accelDist, accelTime, cruiseTime, decelTime, v, a: accel, totalDist: D, totalTime: 2 * accelTime + cruiseTime };
}

function posAtTime(profile: SegProfile, elapsed: number): number {
  if (elapsed <= 0) return 0;
  if (elapsed >= profile.totalTime) return profile.totalDist;
  const { accelDist, cruiseDist, decelDist, accelTime, cruiseTime, decelTime, v, a } = profile;
  if (elapsed < accelTime) return 0.5 * a * elapsed * elapsed;
  const t1 = elapsed - accelTime;
  if (t1 < cruiseTime) return accelDist + v * t1;
  const t2 = t1 - cruiseTime;
  return accelDist + cruiseDist + v * t2 - 0.5 * a * t2 * t2;
}

/* ---- 포커스 화면 본체 ---- */
function FocusContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const trainNo = params.trainNo as string;
  const fromName = searchParams.get('from') || '서울';
  const toName = searchParams.get('to') || '부산';

  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const animRef = useRef<number>(0);
  const playingRef = useRef(false);
  const speedRef = useRef(5);

  const [data, setData] = useState<CorridorData | null>(null);
  const [train, setTrain] = useState<TrainRun | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(5);
  const [progress, setProgress] = useState(0);
  const [currentStation, setCurrentStation] = useState(fromName);
  const [nextStation, setNextStation] = useState('');
  const [arrivalTime, setArrivalTime] = useState('');
  const [elapsedSec, setElapsedSec] = useState(0);
  const [totalSec, setTotalSec] = useState(0);
  const [ready, setReady] = useState(false);

  // 데이터 로드
  useEffect(() => {
    fetch('/data/gyeongbu-corridor.json').then(r => r.json()).then((d: CorridorData) => {
      setData(d);
      const t = d.train_runs.find(r => r.train_no === trainNo);
      if (t) setTrain(t);
    });
  }, [trainNo]);

  const fromIdx = data && train ? train.stops.findIndex(s => s.station === fromName) : -1;
  const toIdx = data && train ? train.stops.findIndex(s => s.station === toName) : -1;

  // 총 소요시간
  useEffect(() => {
    if (!train || fromIdx < 0 || toIdx < 0) return;
    const dep = train.stops[fromIdx].departure;
    const arr = train.stops[toIdx].arrival;
    if (!dep || !arr) return;
    const [h1, m1] = dep.split(':').map(Number);
    const [h2, m2] = arr.split(':').map(Number);
    setTotalSec((h2 * 60 + m2 - h1 * 60 - m1));
    setArrivalTime(arr);
  }, [train, fromIdx, toIdx]);

  // MapLibre 초기화
  useEffect(() => {
    if (!data || !mapContainer.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
      center: [128.0, 36.3],
      zoom: 7,
      attributionControl: false,
    });

    map.on('load', () => {
      const coords = data.corridor.geometry.coordinates as [number, number][];

      // 전체 corridor 라인
      map.addSource('corridor', {
        type: 'geojson',
        data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }
      });
      map.addLayer({
        id: 'corridor-line',
        type: 'line', source: 'corridor',
        paint: { 'line-color': '#93c5fd', 'line-width': 3 }
      });

      // 역 마커
      data.corridor.stations.forEach(s => {
        const el = document.createElement('div');
        el.className = 'w-2 h-2 rounded-full bg-gray-400 border border-white';
        el.style.width = '8px';
        el.style.height = '8px';
        el.style.borderRadius = '50%';
        el.style.backgroundColor = '#9ca3af';
        el.style.border = '2px solid white';
        el.style.cursor = 'pointer';
        new maplibregl.Marker({ element: el })
          .setLngLat([s.lng, s.lat])
          .addTo(map);
      });

      // 열차 마커 생성
      const markerDiv = document.createElement('div');
      markerDiv.className = 'train-marker';
      markerDiv.style.width = '18px';
      markerDiv.style.height = '18px';
      markerDiv.style.borderRadius = '50%';
      markerDiv.style.backgroundColor = '#4f46e5';
      markerDiv.style.border = '3px solid white';
      markerDiv.style.boxShadow = '0 0 12px rgba(79,70,229,0.6)';
      markerDiv.style.transition = 'none';

      const marker = new maplibregl.Marker({ element: markerDiv })
        .setLngLat([coords[0][0], coords[0][1]])
        .addTo(map);
      markerRef.current = marker;

      // 첫 역으로 카메라 이동
      const firstStation = data?.corridor.stations[0];
      if (firstStation) {
        map.flyTo({ center: [firstStation.lng, firstStation.lat], zoom: 9, duration: 1000 });
      }

      mapRef.current = map;
      setReady(true);
    });

    return () => { map.remove(); mapRef.current = null; markerRef.current = null; setReady(false); };
  }, [data]);

  // 애니메이션 루프
  const animateRef = useRef<{ startTime: number; segments: any[]; totalSimTime: number } | null>(null);

  const startAnimation = useCallback(() => {
    if (!data || !train || fromIdx < 0 || toIdx < 0 || totalSec <= 0) return;

    const coords = data.corridor.geometry.coordinates as [number, number][];
    const line = turf.lineString(coords);

    // 구간별 profile 계산
    const segments: { fromDist: number; toDist: number; profile: SegProfile }[] = [];

    for (let i = fromIdx; i < toIdx; i++) {
      const stop = train.stops[i];
      const nextStop = train.stops[i + 1];
      if (!stop.departure || !nextStop.arrival) continue;

      const dep = stop.departure.split(':').map(Number);
      const arr = nextStop.arrival.split(':').map(Number);
      const segTimeSec = (arr[0] * 60 + arr[1] - dep[0] * 60 - dep[1]);
      if (segTimeSec <= 0) continue;

      const fromS = data.corridor.stations.find(s => s.name === stop.station);
      const toS = data.corridor.stations.find(s => s.name === nextStop.station);
      if (!fromS || !toS) continue;

      const segDist = toS.corridor_dist_m - fromS.corridor_dist_m;
      if (segDist <= 0) continue;

      const maxV = train.type === 'KTX' ? 85 : 40;
      const accel = train.type === 'KTX' ? 0.3 : 0.4;
      const profile = computeProfile(segDist, segTimeSec, maxV, accel);

      segments.push({ fromDist: fromS.corridor_dist_m, toDist: toS.corridor_dist_m, profile });
    }

    if (segments.length === 0) return;

    const totalSimTime = segments.reduce((s, seg) => s + seg.profile.totalTime, 0);
    const startTime = performance.now();

    animateRef.current = { startTime, segments, totalSimTime };
    playingRef.current = true;

    const marker = markerRef.current;
    if (!marker) return;

    function animateFrame() {
      if (!playingRef.current) return;
      const now = performance.now();
      const realElapsed = (now - startTime) / 1000; // seconds real time
      const simElapsed = realElapsed * speedRef.current; // seconds sim time

      if (simElapsed >= totalSimTime) {
        // 도착
        const lastSeg = segments[segments.length - 1];
        const endPt = turf.along(line, lastSeg.toDist, { units: 'meters' });
        marker.setLngLat(endPt.geometry.coordinates as [number, number]);
        setProgress(1);
        setCurrentStation(toName);
        setNextStation('');
        setElapsedSec(totalSec);
        setPlaying(false);
        playingRef.current = false;
        return;
      }

      // 현재 구간
      let segElapsed = simElapsed;
      let segIdx = 0;
      for (let i = 0; i < segments.length; i++) {
        if (simElapsed <= segments[i].profile.totalTime) { segIdx = i; break; }
        segElapsed -= segments[i].profile.totalTime;
      }
      if (segIdx >= segments.length) segIdx = segments.length - 1;

      const seg = segments[segIdx];
      const distAlong = seg.fromDist + posAtTime(seg.profile, Math.max(0, Math.min(segElapsed, seg.profile.totalTime)));
      const pt = turf.along(line, distAlong, { units: 'meters' });

      // 마커 이동
      marker.setLngLat(pt.geometry.coordinates as [number, number]);

      // 지도 따라가기
      mapRef.current?.panTo(pt.geometry.coordinates as [number, number], { duration: 200, animate: true });

      // 진행률
      setProgress(Math.min(1, simElapsed / totalSimTime));
      setElapsedSec(Math.min(totalSec, simElapsed));

      // 현재역/다음역
      let curIdx = fromIdx;
      let el = 0;
      for (let i = 0; i < segments.length; i++) {
        if (el + segments[i].profile.totalTime >= simElapsed) { curIdx = fromIdx + i; break; }
        el += segments[i].profile.totalTime;
      }
      if (curIdx < train!.stops.length) {
        setCurrentStation(train!.stops[curIdx].station);
        const ns = curIdx + 1 < train!.stops.length ? train!.stops[curIdx + 1].station : '';
        setNextStation(ns);
      }

      animRef.current = requestAnimationFrame(animateFrame);
    }

    animRef.current = requestAnimationFrame(animateFrame);
  }, [data, train, fromIdx, toIdx, fromName, toName, totalSec]);

  const togglePlay = useCallback(() => {
    if (playing) {
      playingRef.current = false;
      setPlaying(false);
      if (animRef.current) cancelAnimationFrame(animRef.current);
    } else {
      setPlaying(true);
    }
  }, [playing]);

  const reset = useCallback(() => {
    playingRef.current = false;
    if (animRef.current) cancelAnimationFrame(animRef.current);
    setPlaying(false);
    setProgress(0);
    setElapsedSec(0);
    setCurrentStation(fromName);
    setNextStation('');

    if (markerRef.current && data) {
      const coords = data.corridor.geometry.coordinates as [number, number][];
      markerRef.current.setLngLat([coords[0][0], coords[0][1]]);
      const st = data.corridor.stations[0];
      if (st) mapRef.current?.flyTo({ center: [st.lng, st.lat], zoom: 9, duration: 800 });
    }
  }, [fromName, data]);

  // playing=true면 애니메이션 시작
  useEffect(() => {
    if (playing && ready) {
      // 약간 지연했다가 시작 (지도가 준비될 시간)
      const t = setTimeout(() => startAnimation(), 200);
      return () => clearTimeout(t);
    }
  }, [playing, ready, startAnimation]);

  // speed ref 동기화
  useEffect(() => { speedRef.current = speed; }, [speed]);

  const formatTime = (sec: number) => {
    if (sec <= 0) return '0분';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}분 ${s}초`;
  };

  if (!data || !train) return (
    <div className="w-full h-screen flex items-center justify-center bg-gray-50">
      <div className="text-gray-400 text-sm">로딩 중...</div>
    </div>
  );

  return (
    <div className="w-full h-screen relative bg-gray-900 overflow-hidden">
      <div ref={mapContainer} className="w-full h-full" />

      {/* 진행 카드 */}
      <div className="absolute top-4 left-4 right-4 md:left-4 md:right-auto md:w-80 bg-white/95 backdrop-blur-sm rounded-xl shadow-lg p-4 z-10">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: train.color }}>
              {train.type}
            </span>
            <span className="text-sm font-semibold">{train.name}</span>
          </div>
          <span className="text-xs text-gray-500">{fromName} → {toName}</span>
        </div>

        <div className="w-full h-1.5 bg-gray-200 rounded-full overflow-hidden mb-3">
          <div className="h-full bg-blue-500 rounded-full transition-all duration-300" style={{ width: `${progress * 100}%` }} />
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-xs text-gray-500">현재역</div>
            <div className="font-semibold text-gray-900">{currentStation}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500">다음역</div>
            <div className="font-semibold text-blue-600">{nextStation || '도착'}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500">경과</div>
            <div className="font-semibold text-gray-900">{formatTime(elapsedSec)}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500">도착예정</div>
            <div className="font-semibold text-gray-900">{arrivalTime || '-'}</div>
          </div>
        </div>

        <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100">
          <div className="flex items-center gap-2">
            <button onClick={reset} className="px-2.5 py-1.5 text-xs bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">⟲</button>
            <button onClick={togglePlay} className="px-4 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors">
              {playing ? '⏸ 일시정지' : '▶ 재생'}
            </button>
          </div>
          <div className="flex items-center gap-1">
            {[1, 2, 5, 10].map(s => (
              <button key={s} onClick={() => setSpeed(s)}
                className={`px-2 py-1 text-xs rounded-lg transition-colors ${speed === s ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                {s}×
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 모바일 역 리스트 */}
      <div className="absolute bottom-4 left-4 right-4 md:hidden bg-white/95 backdrop-blur-sm rounded-xl shadow-lg p-3 z-10 max-h-32 overflow-y-auto">
        <div className="text-xs text-gray-500 mb-1">경로</div>
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {train.stops.slice(fromIdx, toIdx + 1).map((s, i) => (
            <div key={s.station} className={`flex-shrink-0 text-center px-2 py-1 rounded-lg text-xs
              ${i / (toIdx - fromIdx) <= progress ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
              {s.station}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---- Suspense Wrapper ---- */
export default function FocusPage() {
  return (
    <Suspense fallback={<div className="w-full h-screen flex items-center justify-center bg-gray-50"><div className="text-gray-400 text-sm">로딩 중...</div></div>}>
      <FocusContent />
    </Suspense>
  );
}
